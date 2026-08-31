// Restore — Cloudflare Function for POST /api/restore
//
// Recovers entitlement on a device that lost it (private browsing, cleared
// storage, a second device) using the payer's email instead of an account
// system — Stripe Checkout already collects it, so this asks Stripe "does
// this email have an active subscription?" and, if so, returns the same
// {active, subscriptionId, plan} shape checkout-confirm.js returns, which
// monetize.js already knows how to turn into a local entitlement.
//
// Trust model matches the rest of this app: this is not proof of purchase,
// just "an active subscription exists under this email" — good enough for
// an honest family, not hardened against someone guessing another
// customer's email.

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

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

  const email = typeof body?.email === "string" ? body.email.trim() : "";
  if (!email) {
    return jsonResponse(400, { error: { code: "bad_request" } });
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

  for (const customer of customers.data || []) {
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

  return jsonResponse(200, { active: false });
}
