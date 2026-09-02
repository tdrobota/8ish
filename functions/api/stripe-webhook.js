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
// Manual signature verification (no Stripe SDK, matching this app's
// raw-fetch-only pattern everywhere else) per Stripe's documented algorithm:
// https://docs.stripe.com/webhooks.md?verify=verify-manually#verify-signature

const SIGNATURE_TOLERANCE_SECONDS = 300; // Stripe's own library default

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

function subStatusKey(subscriptionId) {
  return `subStatus:${subscriptionId}`;
}

async function handleSubscriptionEvent(env, subscription) {
  const active = subscription.status === "active" || subscription.status === "trialing";
  const item = subscription.items && subscription.items.data[0];
  await env.COOLDOWN_KV.put(
    subStatusKey(subscription.id),
    JSON.stringify({
      active,
      // Stripe API 2025-03-31 ("Basil") moved current_period_end off the
      // subscription object onto each subscription item — same handling as
      // entitlement.js/restore.js.
      currentPeriodEnd: item ? item.current_period_end : null,
      updatedAt: Date.now(),
    })
  );
}

export async function onRequestPost({ request, env }) {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    return jsonResponse(500, { error: { code: "not_configured" } });
  }

  // Raw body required for signature verification — parsing then
  // re-serializing (even losslessly) can change byte-for-byte formatting
  // and break the signature check, per Stripe's own warning.
  const rawBody = await request.text();
  const sigHeader = request.headers.get("stripe-signature");

  let verified;
  try {
    verified = await verifyStripeSignature(rawBody, sigHeader, env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    console.error("Webhook signature verification error:", e);
    verified = false;
  }
  if (!verified) {
    return jsonResponse(400, { error: { code: "invalid_signature" } });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (e) {
    return jsonResponse(400, { error: { code: "bad_request" } });
  }

  try {
    if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
      await handleSubscriptionEvent(env, event.data.object);
    }
    // Any other event type: acknowledge without action — Stripe requires
    // ack'ing even unhandled types, otherwise it keeps retrying.
  } catch (e) {
    console.error("Webhook processing error:", e);
    // Still ack — a KV hiccup here shouldn't make Stripe retry forever; the
    // live-lookup fallback in entitlement.js covers a missed cache update.
  }

  return jsonResponse(200, { received: true });
}
