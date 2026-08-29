// Checkout — Cloudflare Function for POST /api/checkout
//
// Creates a Stripe Checkout Session for the 8ish+ subscription and returns
// its redirect URL. Talks to Stripe's REST API directly via fetch (no SDK —
// Workers don't need one for this) using env.STRIPE_SECRET_KEY.
//
// Only meaningful on the monetized deployment: STRIPE_SECRET_KEY must never
// be set on the kid's own (unlimited) deploy. If it's missing, this fails
// closed with a 500 rather than doing anything with real money.

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

  const priceId = body && body.plan === "yearly" ? env.STRIPE_PRICE_YEARLY : env.STRIPE_PRICE_MONTHLY;
  if (!priceId) {
    return jsonResponse(500, { error: { code: "not_configured" } });
  }

  const origin = new URL(request.url).origin;
  const params = new URLSearchParams({
    mode: "subscription",
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": "1",
    success_url: `${origin}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/?checkout=cancelled`,
    allow_promotion_codes: "true",
  });

  let response;
  try {
    response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });
  } catch (e) {
    return jsonResponse(502, { error: { code: "stripe_unreachable" } });
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    console.error("Stripe checkout session create failed:", response.status, text);
    return jsonResponse(502, { error: { code: "stripe_error" } });
  }

  const session = await response.json();
  return jsonResponse(200, { url: session.url });
}
