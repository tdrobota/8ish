// Config — Cloudflare Function for GET /api/config
//
// Exposes the values that differ between this codebase's two deployments
// (the kid's always-unlimited link vs. the monetized public link) as env
// vars instead of hardcoding them in client JS — see wrangler.jsonc's
// `vars` per environment. monetize.js fetches this once on load; when
// planMode is "unlimited" (the kid's deploy) it never shows the free
// counter, Parent Gate, or paywall at all.

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function onRequestGet({ env }) {
  return jsonResponse(200, {
    planMode: env.PLAN_MODE === "free" ? "free" : "unlimited",
    freeDailyLimit: Number(env.FREE_DAILY_LIMIT) || 10,
    freeAiLimit: Number(env.FREE_AI_LIMIT) || 1,
    features: {
      friendMode: env.FEATURE_FRIEND_MODE === "true",
      familyMode: env.FEATURE_FAMILY_MODE === "true",
    },
    pricing: {
      monthly: env.PRICE_MONTHLY_RON || "19.99",
      yearly: env.PRICE_YEARLY_RON || "149",
      currency: env.PRICE_CURRENCY || "RON",
    },
  });
}
