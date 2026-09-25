// Config — Cloudflare Function for GET /api/config
//
// Exposes this Worker's plan settings as env vars instead of hardcoding them
// in client JS — see wrangler.jsonc's top-level `vars` (the single deployed
// Worker, 8ish-plus, planMode "free"). monetize.js fetches this once on
// load; when planMode is "unlimited" it never shows the free counter, Parent
// Gate, or paywall at all. The retired 8ishqa Worker has its own last-
// deployed copy of this file, which still answers "unlimited" from its own
// last-deployed vars, entirely independent of this repo's wrangler.jsonc.
//
// Story 6-3: `turnstileSiteKey` lets the client know whether Turnstile is
// configured at all, without hardcoding a site key into public/ (a site key
// isn't secret the way TURNSTILE_SECRET is, but it still shouldn't be
// committed — it's set as a Worker var once Story 5-1's real-device spike
// resolves and the widget is created, see docs/runbook.md §1.3). `null`
// (today's reality: the var doesn't exist yet) is exactly what tells
// monetize.js's getHumanToken() to fail closed with "Restore is
// unavailable" rather than fabricate or skip the human check.
//
// Story 6-5: `pricing.monthly`/`pricing.yearly` no longer come from a
// hand-set PRICE_MONTHLY_RON/PRICE_YEARLY_RON var — they are read from the
// real Stripe Price (`unit_amount`, via lib/stripe.js, the one file allowed
// to call the Stripe API) named by STRIPE_PRICE_MONTHLY/STRIPE_PRICE_YEARLY
// (the same env vars checkout.js already uses to create the Checkout
// Session), so the paywall can never silently drift from what Stripe
// actually charges. Cached in STATE_KV as `price:<Stripe Price id>` for
// ~a day (86400s, Design Notes) so a normal request never calls Stripe —
// only a cache miss (first request after a deploy, or a day later) does.
// `readPrice` below is the one place that reads/writes a KV entry under the
// `price:` prefix, mirroring the single-writer discipline lib/subStatus.js
// already established for its own KV key prefix, just inline here rather
// than in its own lib file (this story's Code Map only calls for touching
// this file).
//
// Fails closed, per field: a cache miss with STRIPE_SECRET_KEY unset, a
// missing/unset Price id, a Stripe error, an unreachable Stripe, a
// malformed Stripe response (no numeric unit_amount), or a KV read/write
// hiccup all resolve that one field to `null` — never a stale/fabricated
// price, and never a thrown error that would take the whole endpoint down.
// `null` is sent explicitly (not omitted), so monetize.js's validateConfig()
// can accept it as "confirmed unavailable" and disable buying for that plan,
// the same way `turnstileSiteKey: null` already distinguishes "not
// configured" from a real value.

import { get, StripeError } from "../lib/stripe.js";
import { writeEvent } from "../lib/events.js";

const PRICE_KV_PREFIX = "price:";
const PRICE_CACHE_TTL_SECONDS = 86400; // ~a day (Design Notes; not configurable beyond this without sign-off)

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Stripe's unit_amount is an integer in the currency's smallest subunit (RON
// has 2, "bani") -- formats it as a decimal string, dropping ".00" for a
// whole-currency amount (matches the pre-6.5 hand-set vars' own style, e.g.
// "99" rather than "99.00") while keeping real cents for anything else
// (e.g. "14.99"). Integer division/mod avoids floating-point drift.
function formatUnitAmount(unitAmount) {
  const whole = Math.trunc(unitAmount / 100);
  const cents = Math.abs(unitAmount % 100);
  return cents === 0 ? String(whole) : `${whole}.${String(cents).padStart(2, "0")}`;
}

function kvKey(priceId) {
  return `${PRICE_KV_PREFIX}${priceId}`;
}

// Resolves one Stripe Price id to a display string, or null if it can't be
// resolved right now -- never throws. KV-first (a plain STATE_KV.get, no
// Stripe call on a hit), falling back to a live Stripe lookup on a miss,
// corrupt entry, or KV read failure; a successful live lookup is cached for
// PRICE_CACHE_TTL_SECONDS before returning.
async function readPrice(env, priceId) {
  if (typeof priceId !== "string" || !priceId) return null;
  const key = kvKey(priceId);

  let raw = null;
  try {
    raw = await env.STATE_KV.get(key);
  } catch {
    console.error("config_price_kv_read_failed");
    raw = null; // a cache-read hiccup must not block a legitimate lookup -- fall through
  }

  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed.unit_amount === "number" && Number.isFinite(parsed.unit_amount)) {
        return formatUnitAmount(parsed.unit_amount);
      }
    } catch {
      // corrupt entry -- fall through to a live lookup
    }
  }

  if (!env.STRIPE_SECRET_KEY) return null;

  let price;
  try {
    price = await get(env, `prices/${encodeURIComponent(priceId)}`);
  } catch (error) {
    if (error instanceof StripeError) {
      console.error("config_price_stripe_error", error.status);
    } else {
      console.error("config_price_stripe_unreachable");
    }
    return null;
  }

  if (!price || typeof price.unit_amount !== "number" || !Number.isFinite(price.unit_amount)) {
    console.error("config_price_malformed");
    return null;
  }

  try {
    await env.STATE_KV.put(key, JSON.stringify({ unit_amount: price.unit_amount }), { expirationTtl: PRICE_CACHE_TTL_SECONDS });
  } catch {
    console.error("config_price_kv_write_failed");
    // The freshly-fetched price is still good for this one response even if
    // caching it failed -- only the next request pays for another Stripe call.
  }

  return formatUnitAmount(price.unit_amount);
}

export async function onRequestGet({ env, ctx }) {
  // Story 8-1 (AD-19): every request that reaches this handler counts as an
  // "app_open" -- fire-and-forget, never awaited, cannot delay or fail this
  // response (see lib/events.js).
  writeEvent(env, ctx, "app_open", "");

  const [monthly, yearly] = await Promise.all([readPrice(env, env.STRIPE_PRICE_MONTHLY), readPrice(env, env.STRIPE_PRICE_YEARLY)]);

  return jsonResponse(200, {
    planMode: env.PLAN_MODE === "free" ? "free" : "unlimited",
    freeDailyLimit: Number(env.FREE_DAILY_LIMIT) || 10,
    features: {
      friendMode: env.FEATURE_FRIEND_MODE === "true",
      familyMode: env.FEATURE_FAMILY_MODE === "true",
    },
    pricing: {
      monthly,
      yearly,
      currency: env.PRICE_CURRENCY || "RON",
    },
    turnstileSiteKey: typeof env.TURNSTILE_SITE_KEY === "string" && env.TURNSTILE_SITE_KEY ? env.TURNSTILE_SITE_KEY : null,
  });
}
