// Restore — Cloudflare Function for POST /api/restore
//
// Recovers entitlement on a device that lost it (private browsing, cleared
// storage, a second device) using the payer's email PLUS the one-time
// restore code shown once at purchase time (see checkout-confirm.js).
// Requiring both closes an authorization bypass an email-only version of
// this endpoint had: anyone who merely knew a customer's email could steal
// their subscription with a single request. The code itself is never stored
// in plaintext server-side — only its SHA-256 hash lives in the Stripe
// customer's metadata, set once by checkout-confirm.js.
//
// Trust model: proof of "you have the code the family wrote down at
// purchase time" plus "you know the email used to subscribe" — not a real
// account system, but the code has ~50 bits of entropy, so guessing another
// customer's is infeasible even without needing an email-sending service
// (which would require the paid Workers plan).
//
// Story 6-3: a human check (lib/turnstile.js, action "restore") now gates
// every other bit of work — verified first, before the request body is even
// inspected for email/code, so a missing or invalid token costs zero
// KV/Stripe calls. This replaces the old per-email cooldown key (a KV entry
// keyed by email, checked and rewritten on every attempt) entirely: that
// cooldown only slowed repeated guesses against ONE email address, not an
// attacker rotating through many, and this file writes nothing to any KV
// namespace at all — attempt spacing is the Spend Governor's job (Story 7-8,
// below), not a bespoke cooldown key. A success mints a real Entitlement
// Credential (lib/credential.js) instead of returning a bare
// subscriptionId, matching Story 6.2's shape everywhere else in this app.
// And the email lookup tries both the exact typed casing and the lowercased
// form — Stripe's `customers?email=` filter is case-sensitive, so a stored
// email with capital letters could otherwise never be found by the
// lowercased-only query this file used before.
//
// Story 7-8 (spec-7-8-quota-defenses.md, AD-23): the deferred "eventually
// the Governor, Epic 7" promise Story 6-3's own header comment above made is
// implemented here. Real Governor-backed attempt spacing (`kind:"restore"`,
// `key: sha256(the caller's own lowercased email)`) is layered in AFTER the
// Turnstile check passes (a missing/invalid token still costs zero Governor
// calls, same as before) and BEFORE the Stripe lookup -- a granted
// reservation is committed immediately (AD-14: `restore` settles right
// away, there is no async provider call to wait for the way transform.js's
// Image request has). Two cheap layers sit in front of the real Governor
// call (lib/request-throttle.js, shared with transform.js): a stateless
// per-key pre-limit (a burst that hasn't even earned a real denial yet is
// capped before the Governor is ever asked), and a per-isolate deny cache
// (a REAL `wait` denial the Governor just returned is remembered for 60s,
// so a repeat for the same key doesn't cost a second Governor call). A
// byte-capped body read (lib/http-body.js, 8KB -- generous for this
// endpoint's small {email, code, turnstile} body) is the very first thing
// this function does, ahead of even the config-sanity check below: it is a
// cheap, stateless check that should reject a clearly-oversized body
// fastest, and does not change "Turnstile gates everything else real" for
// any body actually under the cap.

import * as credential from "../lib/credential.js";
import { get, StripeError } from "../lib/stripe.js";
import * as turnstile from "../lib/turnstile.js";
import { readCappedBody } from "../lib/http-body.js";
import { loadGovernorLimits } from "../lib/governor-config.js";
import { checkPreLimit, checkDenyCache, recordDenial, PRE_LIMIT_RETRY_AFTER } from "../lib/request-throttle.js";

const HUMAN_CHECK_ACTION = "restore";

// Every request body this endpoint legitimately receives is a tiny
// {email, code, turnstile} object -- 8KB is generous headroom (Design
// Notes: "8KB (generous for any JSON body these endpoints legitimately
// receive today)").
const MAX_BODY_BYTES = 8 * 1024;

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function normalizeCode(raw) {
  return raw.toUpperCase().replace(/[^0-9A-Z]/g, "");
}

async function hashCode(normalized) {
  const data = new TextEncoder().encode(normalized);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Story 7-8: the Governor key -- sha256 of the caller's own RAW (already
// trim()-med by the caller below), lowercased email, never whichever of the
// two Stripe lookup forms below actually matches a customer (Design Notes:
// "this must key on the email the CALLER supplied, so an attacker can't
// dodge spacing by varying casing between attempts for the same real
// address"). A separate function from hashCode() above on purpose -- that
// one hashes the normalized restore CODE for a Stripe metadata comparison,
// a completely different value with a completely different purpose; keeping
// them distinct avoids any risk of the two ever being conflated.
async function sha256Hex(input) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Story 7-8: maps a Governor denial (or a pre-limit/deny-cache stand-in
// carrying the same {denied, retryAfterSeconds} shape) to its HTTP
// response -- mirrors transform.js's own denialBody/denialResponse pattern
// exactly, so the two Governor-backed endpoints in this app answer
// identically-shaped denials. governor-core.js's `restore`-kind branch only
// ever checks minGapSec, so `wait` is the only denial this file can
// actually observe from a real reserve() call -- the `daily_limit`/
// `rate_limited` branches below are unreachable today but kept for the same
// defense-in-depth reasoning transform.js's own comment gives: never assume
// a denial code this function doesn't recognize, fail closed to resting
// instead.
function denialBody(reservation) {
  const denied = reservation && reservation.denied;
  if (denied === "wait" || denied === "daily_limit" || denied === "rate_limited") {
    const body = { error: { code: denied } };
    if (typeof reservation.retryAfterSeconds === "number") {
      body.error.retryAfterSeconds = reservation.retryAfterSeconds;
    }
    return { status: 429, body };
  }
  return { status: 503, body: { error: { code: "resting" } } };
}

function denialResponse(reservation) {
  const { status, body } = denialBody(reservation);
  return jsonResponse(status, body);
}

// The exact typed casing, then the lowercased form (skipping a redundant
// second call when they're already identical) — AD-15's adopted rule for
// Stripe's case-sensitive `customers?email=` filter (see the file header).
// Results from both queries are merged and deduped by customer id, so it
// never matters which form a given customer's stored email actually
// matches — the caller below just gets one candidate list to check the
// restore code against.
//
// Each form's Stripe call is tried independently: a transient failure on
// one form must not abort a lookup the OTHER form's identical query might
// still satisfy. An error is only propagated to the caller once every form
// has failed — the last one seen, so the caller's existing
// `instanceof StripeError` branching still applies to whatever actually
// went wrong.
async function findCustomersByEmail(env, typedEmail) {
  const lower = typedEmail.toLowerCase();
  const forms = typedEmail === lower ? [typedEmail] : [typedEmail, lower];

  const seen = new Set();
  const customers = [];
  let anySucceeded = false;
  let lastError = null;

  for (const email of forms) {
    let result;
    try {
      result = await get(env, `customers?email=${encodeURIComponent(email)}&limit=10`);
      anySucceeded = true;
    } catch (error) {
      lastError = error;
      continue;
    }
    // Stripe is expected to always answer `data` as an array, but a
    // response that somehow doesn't (or omits it) must be treated as "no
    // customers", not crash the request.
    const data = Array.isArray(result && result.data) ? result.data : [];
    for (const cust of data) {
      if (!seen.has(cust.id)) {
        seen.add(cust.id);
        customers.push(cust);
      }
    }
  }

  if (!anySucceeded && lastError) throw lastError;
  return customers;
}

export async function onRequestPost({ request, env }) {
  // Story 7-8: actual byte-count cap, read from the real bytes -- the very
  // first thing this function does, ahead of even the config-sanity check
  // below. A body under the cap is completely unaffected by this addition:
  // every check after this point (config, Turnstile, Governor, Stripe) runs
  // exactly as it did before this story.
  const capped = await readCappedBody(request, MAX_BODY_BYTES);
  if (!capped.ok) {
    return jsonResponse(400, { error: { code: "bad_request" } });
  }

  if (!env.STRIPE_SECRET_KEY || !env.ENTITLEMENT_SECRET) {
    return jsonResponse(500, { error: { code: "not_configured" } });
  }

  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(capped.bytes));
  } catch {
    return jsonResponse(400, { error: { code: "bad_request" } });
  }

  // The human check gates everything else, before the rest of the body is
  // even inspected (AD-23, "no state before proof"; Code Map: "verify
  // before any other work") — a missing, wrong, replayed, or unconfigured
  // token all fail identically here, and no KV/Stripe/Governor call happens
  // below this point unless it passes.
  const turnstileToken = typeof body?.turnstile === "string" ? body.turnstile : "";
  const humanOk = await turnstile.verify(env, turnstileToken, HUMAN_CHECK_ACTION);
  if (!humanOk) {
    return jsonResponse(403, { error: { code: "human_check_failed" } });
  }

  const email = typeof body?.email === "string" ? body.email.trim() : "";
  const code = typeof body?.code === "string" ? normalizeCode(body.code) : "";
  if (!email || !code) {
    return jsonResponse(400, { error: { code: "bad_request" } });
  }

  // Story 7-8: real Governor-backed attempt spacing (kind "restore"),
  // gated behind the Turnstile check above -- see the file header. Keyed by
  // the caller's own raw (trimmed), lowercased email, computed BEFORE
  // findCustomersByEmail's two-form Stripe lookup below.
  const restoreKey = await sha256Hex(email.toLowerCase());

  // 1. A stateless, cheap first line of defense -- denied before the deny
  // cache or the Governor are ever consulted.
  if (!checkPreLimit(restoreKey)) {
    return denialResponse({ denied: "wait", retryAfterSeconds: PRE_LIMIT_RETRY_AFTER });
  }

  // 2. A remembered REAL wait/daily_limit denial for this key within the
  // last 60s -- answered from memory, zero Governor calls.
  const cachedDenial = checkDenyCache(restoreKey);
  if (cachedDenial) {
    return denialResponse({ denied: cachedDenial.code, retryAfterSeconds: cachedDenial.retryAfterSeconds });
  }

  // 3. The real Governor. `loadGovernorLimits` (not `loadGovernorConfig`)
  // deliberately -- restore's attempt spacing needs the routine Governor
  // limits (minGapSec) but is NOT Image spend, so it must not be gated by
  // `AI_ENABLED` (Story 7-4's Image-specific Kill Switch): flipping that off
  // during an incident must never also silently block a family recovering
  // their subscription, an unrelated resource. Still fails closed (zero
  // further calls) on an unreadable/invalid `cfg:governor` value.
  const configResult = await loadGovernorLimits(env);
  if (!configResult.ok) {
    return jsonResponse(503, { error: { code: "resting" } });
  }

  const governorStub = env.GOVERNOR.get(env.GOVERNOR.idFromName("global"));
  const reservation = await governorStub.reserve("restore", restoreKey, configResult.cfg);
  if (!reservation.ok) {
    // Remember a REAL wait/daily_limit denial so a repeat within 60s is
    // answered by the deny cache above without a second Governor call.
    // governor-core.js's `restore` branch only ever produces `wait`, but
    // this stays symmetric with transform.js's own recordDenial call sites.
    if (reservation.denied === "wait" || reservation.denied === "daily_limit") {
      recordDenial(restoreKey, { code: reservation.denied, retryAfterSeconds: reservation.retryAfterSeconds });
    }
    return denialResponse(reservation);
  }
  // Granted -- settle immediately (AD-14: `restore` has no async provider
  // call the way transform.js's Image request does, so there is no reason
  // to defer this the way that file defers its own commit via waitUntil()).
  await governorStub.commit(reservation.id);

  let customers;
  try {
    customers = await findCustomersByEmail(env, email);
  } catch (error) {
    if (error instanceof StripeError) {
      console.error("restore_stripe_error", error.status);
      return jsonResponse(502, { error: { code: "stripe_error" } });
    }
    return jsonResponse(502, { error: { code: "stripe_unreachable" } });
  }

  const codeHash = await hashCode(code);

  for (const cust of customers) {
    const storedHash = cust.metadata && cust.metadata.restore_code_hash;
    if (!storedHash || storedHash !== codeHash) continue; // wrong code for this customer, or none issued yet

    let subs;
    try {
      subs = await get(env, `subscriptions?customer=${encodeURIComponent(cust.id)}&status=all&limit=10`);
    } catch {
      continue;
    }
    const active = (subs.data || []).find((s) => s.status === "active" || s.status === "trialing");
    if (active) {
      const item = active.items && active.items.data[0];
      // credential.mint() can only realistically fail here if
      // ENTITLEMENT_SECRET vanished between the top-of-function check and
      // now -- practically never, but the client must still get the
      // documented {error:{code}} envelope, never an unstructured 500 (the
      // one Stripe/credential call in this file that wasn't already
      // converted to that shape on failure).
      let minted;
      try {
        minted = await credential.mint(env, active.id);
      } catch {
        return jsonResponse(502, { error: { code: "credential_error" } });
      }
      return jsonResponse(200, {
        active: true,
        credential: minted,
        plan: item ? item.price.id : null,
        // Stripe API 2025-03-31 ("Basil") moved current_period_end off the
        // subscription object onto each subscription item.
        currentPeriodEnd: item ? item.current_period_end : null,
      });
    }
  }

  // Generic failure either way — wrong email, wrong code, or no active
  // subscription all look identical to the caller.
  return jsonResponse(200, { active: false });
}
