// Entitlement — Cloudflare Function for GET /api/entitlement
//
// Re-checks a previously-confirmed subscription's status. monetize.js calls
// this roughly once a minute per device (see ENTITLEMENT_RECHECK_MS) —
// cheap because this reads a KV cache first, kept fresh in near-real-time by
// stripe-webhook.js whenever Stripe notifies us of a status change. Only on
// a cache miss (e.g. a webhook that was never received — Stripe retries for
// 3 days, not forever) does this fall back to a live Stripe API call, same
// as before the webhook existed; that result is then written into the cache
// so the next check hits the fast path too.

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function subStatusKey(subscriptionId) {
  return `subStatus:${subscriptionId}`;
}

export async function onRequestGet({ request, env }) {
  const subscriptionId = new URL(request.url).searchParams.get("subscription_id");
  if (!subscriptionId) {
    return jsonResponse(400, { error: { code: "bad_request" } });
  }

  try {
    const cached = await env.COOLDOWN_KV.get(subStatusKey(subscriptionId));
    if (cached) {
      const parsed = JSON.parse(cached);
      if (typeof parsed.active === "boolean") {
        return jsonResponse(200, { active: parsed.active, currentPeriodEnd: parsed.currentPeriodEnd ?? null });
      }
    }
  } catch (e) {
    console.error("Entitlement cache read failed:", e);
    // Fall through to the live lookup below — a cache read hiccup must not
    // block a legitimate entitlement check.
  }

  if (!env.STRIPE_SECRET_KEY) {
    return jsonResponse(500, { error: { code: "not_configured" } });
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
  const currentPeriodEnd = item ? item.current_period_end : null;

  try {
    await env.COOLDOWN_KV.put(
      subStatusKey(subscriptionId),
      JSON.stringify({ active, currentPeriodEnd, updatedAt: Date.now() })
    );
  } catch (e) {
    console.error("Entitlement cache write failed:", e);
    // Not fatal — the response below is still correct, just won't benefit
    // the next check's fast path until a future webhook or fallback fixes it.
  }

  return jsonResponse(200, { active, currentPeriodEnd });
}
