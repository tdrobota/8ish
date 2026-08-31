// Checkout Confirm — Cloudflare Function for GET /api/checkout/confirm
//
// After Stripe Checkout redirects back to success_url with a session_id,
// the client calls this once to find out whether the subscription is
// actually active and to get its id for future entitlement checks (see
// entitlement.js). No webhook is used for V1 — this "confirm on return"
// call is the only server-verified moment a purchase is granted; renewals
// and cancellations are picked up later by entitlement.js's periodic
// recheck (see monetize.js), not pushed live. That's a deliberate scope cut
// for the first version, not an oversight — a real webhook needs signature
// verification we haven't built or been able to test against live Stripe
// events yet.
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
  const res = await fetch(`https://api.stripe.com/v1/customers/${encodeURIComponent(customer.id)}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  if (!res.ok) {
    console.error("Failed to store restore_code_hash:", res.status, await res.text().catch(() => ""));
    return null; // entitlement itself still succeeds below even if this failed
  }
  return code;
}

export async function onRequestGet({ request, env }) {
  if (!env.STRIPE_SECRET_KEY) {
    return jsonResponse(500, { error: { code: "not_configured" } });
  }

  const sessionId = new URL(request.url).searchParams.get("session_id");
  if (!sessionId) {
    return jsonResponse(400, { error: { code: "bad_request" } });
  }

  let response;
  try {
    response = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=subscription&expand[]=customer`,
      { headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } }
    );
  } catch (e) {
    return jsonResponse(502, { error: { code: "stripe_unreachable" } });
  }

  if (!response.ok) {
    return jsonResponse(502, { error: { code: "stripe_error" } });
  }

  const session = await response.json();
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
    } catch (e) {
      console.error("ensureRestoreCode failed:", e);
      // Entitlement must not fail just because issuing a restore code did —
      // the subscription is still genuinely active either way.
    }
  }

  return jsonResponse(200, {
    active: !!active,
    subscriptionId: subscription ? subscription.id : null,
    plan: item ? item.price.id : null,
    // Stripe API 2025-03-31 ("Basil") moved current_period_end off the
    // subscription object onto each subscription item.
    currentPeriodEnd: item ? item.current_period_end : null,
    restoreCode,
  });
}
