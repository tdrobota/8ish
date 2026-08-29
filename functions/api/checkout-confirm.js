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

  const sessionId = new URL(request.url).searchParams.get("session_id");
  if (!sessionId) {
    return jsonResponse(400, { error: { code: "bad_request" } });
  }

  let response;
  try {
    response = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=subscription`,
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

  return jsonResponse(200, {
    active: !!active,
    subscriptionId: subscription ? subscription.id : null,
    plan:
      subscription && subscription.items && subscription.items.data[0]
        ? subscription.items.data[0].price.id
        : null,
  });
}
