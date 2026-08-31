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

// Per-email cooldown, reusing COOLDOWN_KV like every other AI/cost-control
// endpoint in this app. The code's entropy (~50 bits) already makes brute
// force infeasible on its own; this is defense in depth against a caller
// hammering one specific email, not the primary defense.
const COOLDOWN_MS = 5000;

export async function onRequestPost({ request, env }) {
  if (!env.STRIPE_SECRET_KEY) {
    return jsonResponse(500, { error: { code: "not_configured" } });
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse(400, { error: { code: "bad_request" } });
  }

  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const code = typeof body?.code === "string" ? normalizeCode(body.code) : "";
  if (!email || !code) {
    return jsonResponse(400, { error: { code: "bad_request" } });
  }

  const cooldownKey = `restoreAttempt:${email}`;
  let last;
  try {
    last = await env.COOLDOWN_KV.get(cooldownKey);
  } catch (e) {
    console.error("Restore cooldown KV read failed:", e);
    return jsonResponse(502, { error: { code: "provider_error", message: "cooldown check failed" } });
  }
  if (last) {
    const parsed = Number(last);
    if (Number.isFinite(parsed) && Date.now() - parsed < COOLDOWN_MS) {
      return jsonResponse(429, { error: { code: "cooldown" } });
    }
  }
  try {
    await env.COOLDOWN_KV.put(cooldownKey, String(Date.now()), { expirationTtl: 60 });
  } catch (e) {
    console.error("Restore cooldown KV write failed:", e);
  }

  async function stripeGet(path) {
    const res = await fetch(`https://api.stripe.com/v1/${path}`, {
      headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
    });
    if (!res.ok) throw new Error("stripe_error");
    return res.json();
  }

  let customers;
  try {
    customers = await stripeGet(`customers?email=${encodeURIComponent(email)}&limit=10`);
  } catch (e) {
    return jsonResponse(502, { error: { code: "stripe_error" } });
  }

  const codeHash = await hashCode(code);

  for (const customer of customers.data || []) {
    const storedHash = customer.metadata && customer.metadata.restore_code_hash;
    if (!storedHash || storedHash !== codeHash) continue; // wrong code for this customer, or none issued yet

    let subs;
    try {
      subs = await stripeGet(`subscriptions?customer=${encodeURIComponent(customer.id)}&status=all&limit=10`);
    } catch (e) {
      continue;
    }
    const active = (subs.data || []).find((s) => s.status === "active" || s.status === "trialing");
    if (active) {
      const item = active.items && active.items.data[0];
      return jsonResponse(200, {
        active: true,
        subscriptionId: active.id,
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
