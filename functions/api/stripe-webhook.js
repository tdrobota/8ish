// Stripe Webhook — Cloudflare Function for POST /api/webhooks/stripe
//
// Closes the gap the rest of this app has always documented as a deliberate
// v1 cut: without this, a cancellation only took effect once every 24h, when
// monetize.js's periodic recheck happened to call entitlement.js's live
// Stripe lookup. This endpoint lets Stripe push subscription status changes
// to us the moment they happen; entitlement.js reads the cache this writes
// before falling back to its own live lookup (still the safety net for a
// webhook that never arrived — Stripe retries for 3 days, not forever).
//
// Story 6-1: this no longer trusts the event payload's status or its
// arrival order. Every `customer.subscription.*` / `checkout.session.completed`
// event re-fetches the subscription fresh from Stripe (via lib/stripe.js)
// and writes it through lib/subStatus.js, which enforces the asOf-ordering
// guard -- a stale retry of an old event can no longer resurrect a
// subscription a newer event already cancelled. A failed subStatus write
// (a genuine KV failure, not a rejected-as-stale write) makes this endpoint
// answer 5xx so Stripe retries the event; a rejected-as-stale write is
// expected, normal behavior and still acks 200.
//
// Manual signature verification (no Stripe SDK, matching this app's
// raw-fetch-only pattern everywhere else) per Stripe's documented algorithm:
// https://docs.stripe.com/webhooks.md?verify=verify-manually#verify-signature

import { get, StripeError } from "../lib/stripe.js";
import { isActiveStatus, write } from "../lib/subStatus.js";
import { readCappedBody } from "../lib/http-body.js";
import { writeEvent } from "../lib/events.js";

const SIGNATURE_TOLERANCE_SECONDS = 300; // Stripe's own library default

// Story 8-1 (AD-19): the `evt:<Stripe event id>` dedupe marker's TTL -- long
// enough to outlast Stripe's own retry window (Stripe retries a failing
// webhook for up to 3 days, same fact this file's own header comment
// already cites), so a retried delivery of an event this endpoint already
// counted can never be double-counted, while the marker still eventually
// expires rather than growing STATE_KV forever.
const EVT_DEDUPE_TTL_SECONDS = 3 * 86400;

// Story 7-8: a real Stripe event payload (especially checkout.session.
// completed) can run larger than every other endpoint's small JSON body --
// 64KB (spec-7-8 Design Notes).
const MAX_BODY_BYTES = 64 * 1024;

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Parses "t=...,v1=...,v0=..." into { t, v1: [...] } — v1 can appear more
// than once during a secret-rotation window (accept if any match); v0 is a
// legacy/test-only scheme and deliberately ignored (prevents downgrade
// attacks, per Stripe's own guidance).
function parseSignatureHeader(header) {
  const t = [];
  const v1 = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") t.push(value);
    else if (key === "v1") v1.push(value);
  }
  return { timestamp: t[0], signatures: v1 };
}

function timingSafeEqualHex(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function hmacSha256Hex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Returns true only if the header is well-formed, at least one v1 signature
// matches the computed HMAC, and the timestamp is within tolerance (replay
// protection — never skip this, a tolerance of 0 disables it entirely).
async function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!sigHeader) return false;
  const { timestamp, signatures } = parseSignatureHeader(sigHeader);
  if (!timestamp || signatures.length === 0) return false;

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - Number(timestamp)) > SIGNATURE_TOLERANCE_SECONDS) return false;

  const expected = await hmacSha256Hex(secret, `${timestamp}.${rawBody}`);
  return signatures.some((sig) => timingSafeEqualHex(sig, expected));
}

// Story 8-1 (AD-19): checks/sets the `evt:<Stripe event id>` KV marker
// before a `purchase_completed`/`cancelled` funnel write, so a Stripe retry
// of an event this endpoint already counted never counts it twice. Never
// throws -- a KV hiccup on the marker itself (read or write) is logged and
// treated as best-effort, exactly like writeEvent's own fail-open-for-
// analytics-only philosophy, so it can never block or fail the webhook's
// own real subStatus write. An event with no usable id (not expected from a
// genuine, signature-verified Stripe payload, but defensive anyway) skips
// dedupe entirely rather than risk keying every id-less event off the same
// KV entry -- the write still happens, just unguarded.
async function writeDedupedFunnelEvent(env, ctx, eventId, eventName) {
  if (typeof eventId !== "string" || !eventId) {
    writeEvent(env, ctx, eventName, "");
    return;
  }

  const dedupeKey = `evt:${eventId}`;
  let alreadyCounted = false;
  try {
    alreadyCounted = Boolean(await env.STATE_KV.get(dedupeKey));
  } catch {
    console.error("webhook_dedupe_kv_read_failed");
    alreadyCounted = false; // a read hiccup must not block a legitimate count
  }
  if (alreadyCounted) return;

  writeEvent(env, ctx, eventName, "");

  try {
    await env.STATE_KV.put(dedupeKey, "1", { expirationTtl: EVT_DEDUPE_TTL_SECONDS });
  } catch {
    console.error("webhook_dedupe_kv_write_failed");
    // Best-effort marker only -- a write failure here just means a later
    // retry of this same event could recount it; it must never propagate
    // and turn this analytics-only step into a 5xx / Stripe retry.
  }
}

// Re-fetches `subscriptionId` fresh from Stripe (never trusting the event
// payload) and writes its status through subStatus.write, source "webhook".
// A subscription that has vanished entirely (404) is written inactive, same
// as any other inactive status (with currentPeriodEnd null -- there is no
// subscription item left to read one from).
async function refreshSubscription(env, ctx, eventId, subscriptionId, asOf) {
  let active;
  let currentPeriodEnd = null;
  try {
    const subscription = await get(env, `subscriptions/${encodeURIComponent(subscriptionId)}`);
    active = isActiveStatus(subscription.status);
    // Stripe API 2025-03-31 ("Basil") moved current_period_end off the
    // subscription object onto each subscription item.
    const item = subscription.items && subscription.items.data[0];
    currentPeriodEnd = item ? item.current_period_end : null;
  } catch (error) {
    if (error instanceof StripeError && error.status === 404) {
      active = false;
    } else {
      throw error;
    }
  }
  // The return value (applied vs. rejected-as-stale) is not itself an
  // error -- a rejection just means a newer status is already recorded.
  const applied = await write(env, subscriptionId, { active, asOf, source: "webhook", currentPeriodEnd });

  // Story 8-1 (AD-19): a "cancelled" funnel count only when this write
  // actually applied (not rejected as stale) AND the live status this fetch
  // just re-confirmed is genuinely inactive -- never on a merely-requested
  // cancellation (cancel_at_period_end=true still reports an "active"/
  // "trialing" Stripe status until the period actually ends, so `active`
  // stays true and this branch simply doesn't run for that event).
  // Best-effort and analytics-only, wrapped so a failure here can never turn
  // into a 5xx / Stripe retry -- the real subStatus write just above has
  // already succeeded by the time this runs.
  if (applied && !active) {
    try {
      await writeDedupedFunnelEvent(env, ctx, eventId, "cancelled");
    } catch {
      console.error("webhook_funnel_write_failed");
    }
  }
}

// `checkout.session.completed`: re-fetches the session's subscription (by
// id, never trusting a status embedded in the event) through the same
// refreshSubscription path every other subscription event uses, then makes
// a best-effort, deduped `purchase_completed` funnel write through the
// shared writeEvent() helper (Story 8-1, AD-19 -- replaces the old inline,
// optional-chained Analytics Engine write from Epic 6, same trigger condition:
// only when amount_total is a positive number, so the family's
// complimentary $0 subscription never counts as a sale). Wrapped in its own
// try/catch so a failure here can never turn into a 5xx / Stripe retry --
// unlike a subStatus write failure, this is not something Stripe retrying
// would fix.
async function handleCheckoutSessionCompleted(env, ctx, eventId, session, asOf) {
  const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription && session.subscription.id;
  if (subscriptionId) {
    await refreshSubscription(env, ctx, eventId, subscriptionId, asOf);
  } else {
    // Not expected -- this app only ever creates subscription-mode Checkout
    // Sessions -- but worth seeing if it ever happens rather than silently
    // doing nothing. Still acks 200 below: there is nothing to retry here.
    console.error("webhook_checkout_session_no_subscription");
  }

  try {
    if (typeof session.amount_total === "number" && session.amount_total > 0) {
      await writeDedupedFunnelEvent(env, ctx, eventId, "purchase_completed");
    }
  } catch {
    console.error("webhook_funnel_write_failed");
  }
}

export async function onRequestPost({ request, env, ctx }) {
  // Story 7-8: actual byte-count cap, read from the real bytes -- the very
  // first thing this function does, before even the config-sanity check
  // below (AD-23, matching every other endpoint's placement this story).
  // This is the ONLY body read this file ever does -- a byte-capped read
  // (lib/http-body.js) in place of the old plain request-body text read, so an
  // over-cap body is rejected before signature verification or JSON.parse
  // even run, with no second/conflicting body read anywhere in this file.
  const capped = await readCappedBody(request, MAX_BODY_BYTES);
  if (!capped.ok) {
    return jsonResponse(400, { error: { code: "bad_request" } });
  }

  if (!env.STRIPE_WEBHOOK_SECRET || !env.STRIPE_SECRET_KEY) {
    return jsonResponse(500, { error: { code: "not_configured" } });
  }

  // Raw body required for signature verification — parsing then
  // re-serializing (even losslessly) can change byte-for-byte formatting
  // and break the signature check, per Stripe's own warning.
  const rawBody = new TextDecoder().decode(capped.bytes);
  const sigHeader = request.headers.get("stripe-signature");

  let verified;
  try {
    verified = await verifyStripeSignature(rawBody, sigHeader, env.STRIPE_WEBHOOK_SECRET);
  } catch {
    console.error("webhook_signature_verify_failed");
    verified = false;
  }
  if (!verified) {
    return jsonResponse(400, { error: { code: "invalid_signature" } });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return jsonResponse(400, { error: { code: "bad_request" } });
  }

  // Ordering key for subStatus.write's asOf guard: Stripe's own event
  // creation time (seconds since epoch), not when we happen to process it
  // -- two events can be *processed* out of order (retries, queueing,
  // re-fetch latency), but their asOf must still reflect which one actually
  // happened later at Stripe. Falls back to "now" only if the event is
  // somehow missing its own timestamp.
  const asOf = Number.isFinite(Number(event.created)) ? Number(event.created) * 1000 : Date.now();

  // A genuinely malformed event (missing the id/object this handler needs)
  // gets 400, not 5xx -- Stripe retrying the exact same malformed body
  // would never produce a better-formed one, so acking it as a client error
  // (and not attempting any subStatus write) is correct here, unlike a
  // transient re-fetch/write failure below.
  let subscriptionId = null;
  let checkoutSession = null;
  if (
    event.type === "customer.subscription.created" ||
    event.type === "customer.subscription.updated" ||
    event.type === "customer.subscription.deleted"
  ) {
    subscriptionId = event.data && event.data.object && event.data.object.id;
    if (typeof subscriptionId !== "string" || !subscriptionId) {
      return jsonResponse(400, { error: { code: "bad_request" } });
    }
  } else if (event.type === "checkout.session.completed") {
    checkoutSession = event.data && event.data.object;
    if (!checkoutSession) {
      return jsonResponse(400, { error: { code: "bad_request" } });
    }
  }

  try {
    if (subscriptionId) {
      await refreshSubscription(env, ctx, event.id, subscriptionId, asOf);
    } else if (checkoutSession) {
      await handleCheckoutSessionCompleted(env, ctx, event.id, checkoutSession, asOf);
    }
    // Any other event type: acknowledge without action — Stripe requires
    // ack'ing even unhandled types, otherwise it keeps retrying.
  } catch {
    console.error("webhook_processing_failed");
    // A genuine failure to determine/record status (a Stripe re-fetch
    // failure or a subStatus write failure) — 5xx so Stripe retries this
    // event, rather than silently acking an event we couldn't act on.
    return jsonResponse(500, { error: { code: "processing_failed" } });
  }

  return jsonResponse(200, { received: true });
}
