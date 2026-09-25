// Checkout Confirm — Cloudflare Function for POST /api/checkout/confirm
//
// After Stripe Checkout redirects back to success_url with a session_id,
// the client calls this once to find out whether the subscription is
// actually active and to mint an Entitlement Credential for future
// entitlement checks (see entitlement.js and lib/credential.js). Renewals
// and cancellations are picked up later by stripe-webhook.js (near-real-
// time) and entitlement.js's periodic recheck as a safety net.
//
// Story 6-2: this moved from GET ?session_id= to POST {sessionId} — no
// identifier may ever travel in a query string (logs, referrers). sessionId
// is regex-validated before any Stripe call is made at all; separately, the
// session's own age (<=30 min, known only once Stripe answers) is checked
// before any credential is minted — a stale/replayed session_id (e.g. dug
// out of browser history from before the query-string strip landed) mints
// nothing. The response no longer returns a bare subscriptionId at all; the
// subscription id now lives only inside the signed credential.
//
// These state-changing POST endpoints don't carry an anti-CSRF token — see
// entitlement.js's own header comment for why (this one relies on the same
// application/json content-type + no-foreign-origin-CORS reasoning; it has
// no ambient/cookie auth to forge in the first place, only a request body a
// cross-site form cannot shape into valid JSON without triggering a CORS
// preflight this app never approves for a foreign origin).
//
// Also issues a one-time restore code on first confirmation for a given
// Stripe customer: only a SHA-256 hash of it is ever persisted (as Stripe
// customer metadata — no extra storage needed). The plaintext is returned to
// the client exactly once, right here, and never stored anywhere
// server-side after this response. See restore.js for how it's verified
// later. This deliberately avoids an email-based one-time-code flow, which
// would have required Cloudflare's Email Sending product (Workers Paid plan,
// $5/mo) — the trade-off is the family has to save the code themselves, same
// as any password-reset recovery code.

import * as credential from "../lib/credential.js";
import { get, post, StripeError } from "../lib/stripe.js";

// A Stripe Checkout Session id, live or test mode, followed by 20-64
// base62-ish characters — checked before ANY Stripe call, per AD-23 ("no
// state before proof" extends here to "no provider call before proof of a
// well-formed id either"). The upper bound is generous (real Stripe session
// ids are well under it) and exists only to stop an arbitrarily long string
// from ever reaching the Stripe API call, not to encode a precise real-world
// length.
const SESSION_ID_RE = /^cs_(live|test)_[A-Za-z0-9]{20,64}$/;

// A session older than this was not just confirmed by a fresh Checkout
// redirect — could be a stale/replayed id — so no credential is minted for
// it. This gates the credential only, never `active` or the restore code:
// a parent whose checkout genuinely took over 30 minutes (a slow 3-D Secure
// step, a distracted tab) still gets an accurate "you're subscribed" answer
// and, crucially, still gets their one-time restore code — withholding
// that too would strand them with no self-serve way back in and a real
// risk of paying a second time by mistake. Only the bearer credential
// itself is replay-sensitive enough to withhold.
const MAX_SESSION_AGE_MS = 30 * 60 * 1000;

const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // no I, L, O, U — avoids visual ambiguity

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// 10 chars from a 32-symbol alphabet = 50 bits of entropy (~1.1 * 10^15
// combinations) — 256 % 32 === 0, so `byte % 32` is uniform, no modulo bias.
function generateRestoreCode() {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let code = "";
  for (let i = 0; i < bytes.length; i++) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return code.slice(0, 5) + "-" + code.slice(5);
}

async function hashCode(normalizedCode) {
  const data = new TextEncoder().encode(normalizedCode);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Idempotent: if this customer already has a restore_code_hash, leaves it
// alone and returns null — a repeat call (e.g. a page reload on the success
// URL before the query string strip lands) must not silently rotate a code
// the family may have already written down. Only returns the plaintext code
// on the call that actually generates it.
async function ensureRestoreCode(env, customer) {
  if (customer.metadata && customer.metadata.restore_code_hash) return null;

  const code = generateRestoreCode();
  const hash = await hashCode(code.replace(/-/g, ""));

  const params = new URLSearchParams({ "metadata[restore_code_hash]": hash });
  try {
    await post(env, `customers/${encodeURIComponent(customer.id)}`, params);
  } catch (error) {
    if (error instanceof StripeError) {
      console.error("restore_code_store_failed", error.status);
      return null; // entitlement itself still succeeds below even if this failed
    }
    throw error; // network failure -- propagate so the caller logs restore_code_ensure_failed
  }
  return code;
}

export async function onRequestPost({ request, env }) {
  if (!env.STRIPE_SECRET_KEY || !env.ENTITLEMENT_SECRET) {
    return jsonResponse(500, { error: { code: "not_configured" } });
  }

  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return jsonResponse(400, { error: { code: "bad_request" } });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: { code: "bad_request" } });
  }

  const sessionId = typeof body?.sessionId === "string" ? body.sessionId : "";
  if (!SESSION_ID_RE.test(sessionId)) {
    return jsonResponse(400, { error: { code: "bad_request" } });
  }

  let session;
  try {
    session = await get(env, `checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=subscription&expand[]=customer`);
  } catch (error) {
    if (error instanceof StripeError) {
      return jsonResponse(502, { error: { code: "stripe_error" } });
    }
    return jsonResponse(502, { error: { code: "stripe_unreachable" } });
  }

  // A session's own `created` (Stripe-issued, seconds since epoch) is what
  // decides freshness — never our own arrival time, which a slow/retried
  // client request could skew. A session missing `created` entirely (never
  // expected from Stripe) fails closed as "too old" rather than being
  // treated as fresh.
  const fresh = typeof session.created === "number" && Date.now() - session.created * 1000 <= MAX_SESSION_AGE_MS;

  const subscription = session.subscription;
  const active =
    session.payment_status === "paid" &&
    subscription &&
    (subscription.status === "active" || subscription.status === "trialing");

  const item = subscription && subscription.items && subscription.items.data[0];

  let restoreCode = null;
  if (active && session.customer && typeof session.customer === "object") {
    try {
      restoreCode = await ensureRestoreCode(env, session.customer);
    } catch {
      console.error("restore_code_ensure_failed");
      // Entitlement must not fail just because issuing a restore code did —
      // the subscription is still genuinely active either way.
    }
  }

  return jsonResponse(200, {
    active: !!active,
    // Minted only when active AND fresh — a stale session_id (even a
    // genuinely active one) mints no credential, matching entitlement.js's
    // own "credential only on active" rule plus the freshness precondition.
    credential: active && fresh ? await credential.mint(env, subscription.id) : null,
    plan: item ? item.price.id : null,
    // Stripe API 2025-03-31 ("Basil") moved current_period_end off the
    // subscription object onto each subscription item.
    currentPeriodEnd: item ? item.current_period_end : null,
    restoreCode,
  });
}
