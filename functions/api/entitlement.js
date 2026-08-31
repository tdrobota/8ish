// Entitlement — Cloudflare Function for GET /api/entitlement
//
// Re-checks a previously-confirmed subscription's live status on Stripe.
// monetize.js calls this at most once a day per device (see
// ENTITLEMENT_RECHECK_MS) to catch cancellations/payment failures without
// needing a webhook — see checkout-confirm.js for why webhooks were cut
// from V1. That means a cancellation can take up to ~24h to actually lock
// the app back down; acceptable for a first version, worth hardening later
// if it turns out to matter.

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function onRequestGet({ request, env }) {
  if (!env.STRIPE_SECRET_KEY) {
    return jsonResponse(500, { error: { code: "not_configured" } });
  }

  const subscriptionId = new URL(request.url).searchParams.get("subscription_id");
  if (!subscriptionId) {
    return jsonResponse(400, { error: { code: "bad_request" } });
  }

  let response;
  try {
    response = await fetch(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, {
      headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
    });
  } catch (e) {
    return jsonResponse(502, { error: { code: "stripe_unreachable" } });
  }

  if (response.status === 404) {
    return jsonResponse(200, { active: false });
  }
  if (!response.ok) {
    return jsonResponse(502, { error: { code: "stripe_error" } });
  }

  const subscription = await response.json();
  const active = subscription.status === "active" || subscription.status === "trialing";
  const item = subscription.items && subscription.items.data[0];
  // Stripe API 2025-03-31 ("Basil") moved current_period_end off the
  // subscription object onto each subscription item.
  return jsonResponse(200, { active, currentPeriodEnd: item ? item.current_period_end : null });
}
