// Checkout — Cloudflare Function for POST /api/checkout
//
// Creates a Stripe Checkout Session for the 8ish+ subscription and returns
// its redirect URL. Talks to Stripe's REST API through lib/stripe.js (the
// one file allowed to call the Stripe API directly) using env.STRIPE_SECRET_KEY.
//
// Only meaningful on the monetized deployment: STRIPE_SECRET_KEY must never
// be set on the kid's own (unlimited) deploy. If it's missing, this fails
// closed with a 500 rather than doing anything with real money.
//
// Story 6-4: a human check (lib/turnstile.js, action "checkout") gates every
// Stripe call and all of the real work below it — verified right after the
// body is parsed, before the requested plan/price is even looked at, so a
// missing or invalid token costs zero Stripe calls (AD-23, "no state before
// proof"; same ordering restore.js already established in Story 6-3). It
// does not gate literally the first line of the function: the
// STRIPE_SECRET_KEY check above is a config sanity check with no I/O of its
// own, and runs first — the same ordering (config check, then
// human-check/auth, then real work) checkout-confirm.js/entitlement.js/
// restore.js already use. The Session itself now also records the Waiver:
// `billing_mode[type]=classic`, `consent_collection[terms_of_service]=required`,
// and a `custom_text[terms_of_service_acceptance][message]` built from the
// caller's language and public/legal.js's WAIVER_CONSENT — never a
// duplicated inline string, so the exact wording a parent agrees to here
// can never drift from what the paywall (Story 6.5) or terms.html
// (Story 6.7) show. `payment_method_collection: if_required` lets a
// 0-total complimentary session (Story 9.1) skip collecting a card.
//
// `lang` travels in the request body as the caller's already-known
// I18N.lang ("ro"/"en") — no new server-side language detection — and
// falls back to "ro" (the app's own default) for anything else, matching
// public/monetize.js's own sender (Code Map: "Language source").
//
// WAIVER_CONSENT's link target is the literal token `{TERMS_URL}`, not a
// real URL (see legal.js's own header comment) — substituted here for
// `env.ORIGIN + legal.TERMS_PATH` immediately before the message is sent to
// Stripe. env.ORIGIN, not the request's own URL, is what success_url/
// cancel_url are built from too: it is the same trusted var
// lib/turnstile.js already requires (and independently validates the
// hostname of) for the human check above to ever pass at all, so by the
// time this line runs, a request that got this far already implies
// env.ORIGIN was configured — the shape check below is defense-in-depth
// against that upstream guarantee ever changing, not a reachable path
// today. Never the request's own URL: unlike a redirect target, this value
// also ends up inside legally-binding consent text, and trusting whatever
// Host a request happened to arrive with for that is a strictly worse
// default than the one var already gating every check above it.

import { post, StripeError } from "../lib/stripe.js";
import * as turnstile from "../lib/turnstile.js";
import { readCappedBody } from "../lib/http-body.js";
import { writeEvent } from "../lib/events.js";
import legal from "../../public/legal.js";

const HUMAN_CHECK_ACTION = "checkout";

// Story 7-8: every request body this endpoint legitimately receives is a
// tiny {plan, lang, turnstile} object -- 8KB is generous headroom (spec-7-8
// Design Notes).
const MAX_BODY_BYTES = 8 * 1024;

// A bare scheme+host, nothing else — exactly the shape env.ORIGIN is
// documented to hold (lib/turnstile.js's own originHost() parses it the
// same way via `new URL(env.ORIGIN)`). No trailing slash, path, query, or
// fragment: those would land inside success_url/cancel_url and the Terms
// link verbatim.
const ORIGIN_RE = /^https:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d+)?$/i;

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export async function onRequestPost({ request, env, ctx }) {
  // Story 7-8: actual byte-count cap, read from the real bytes -- the very
  // first thing this function does, before even the config-sanity check
  // below (AD-23 defense-in-depth, matching restore.js's own placement).
  // This is the ONLY body read this file ever does -- the capped bytes are
  // parsed directly below, in place of the old separate `request.json()`
  // call, rather than a `request.clone()` + a second read: a real body
  // stream can only safely be torn (`.tee()`, what `.clone()` does under
  // the hood) and cancelled on ONE branch if the other branch is also
  // drained -- verified by hand against Node's own fetch implementation,
  // `reader.cancel()` on a cloned-and-abandoned branch hangs the request
  // forever instead of ever resolving. A single capped read sidesteps that
  // hazard entirely (and matches restore.js's/transform.js's own pattern).
  const capped = await readCappedBody(request, MAX_BODY_BYTES);
  if (!capped.ok) {
    return jsonResponse(400, { error: { code: "bad_request" } });
  }

  if (!env.STRIPE_SECRET_KEY) {
    return jsonResponse(500, { error: { code: "not_configured" } });
  }

  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(capped.bytes));
  } catch {
    return jsonResponse(400, { error: { code: "bad_request" } });
  }

  // The human check gates every Stripe call and all of the real work below
  // (AD-23, "no state before proof") — a missing, wrong, or unconfigured
  // token all fail identically here, and no Stripe call happens below this
  // point unless it passes.
  const turnstileToken = typeof body?.turnstile === "string" ? body.turnstile : "";
  const humanOk = await turnstile.verify(env, turnstileToken, HUMAN_CHECK_ACTION);
  if (!humanOk) {
    return jsonResponse(403, { error: { code: "human_check_failed" } });
  }

  // Story 8-1 (AD-19): once the human check passes, before the real Stripe
  // call below -- fire-and-forget, never awaited, cannot delay or fail this
  // response (see lib/events.js).
  writeEvent(env, ctx, "checkout_started", "");

  // Defense-in-depth, not reachable in practice today (see the file header
  // comment): turnstile.verify() above already fails closed when
  // env.ORIGIN is missing or unparsable, deriving its own expected
  // hostname from the very same var. This stays anyway, in case that
  // upstream guarantee ever changes — a malformed ORIGIN must never reach
  // a URL, or legally-binding consent text, sent to Stripe.
  if (typeof env.ORIGIN !== "string" || !ORIGIN_RE.test(env.ORIGIN)) {
    return jsonResponse(500, { error: { code: "not_configured" } });
  }

  // An unrecognized/missing value falls back to "ro", the app's own default
  // (spec-6-4 Design Notes: "Language source").
  const lang = body && body.lang === "en" ? "en" : "ro";

  const consentTemplate = legal && legal.WAIVER_CONSENT && legal.WAIVER_CONSENT[lang];
  if (typeof consentTemplate !== "string") {
    // A broken import, or a future legal.js edit that drops a language,
    // must fail closed through the same {error:{code}} envelope every
    // other failure path uses here — never let a TypeError from reading
    // undefined[lang] escape uncaught and bypass it.
    return jsonResponse(500, { error: { code: "not_configured" } });
  }
  const consentMessage = consentTemplate.replace("{TERMS_URL}", `${env.ORIGIN}${legal.TERMS_PATH}`);

  const priceId = body && body.plan === "yearly" ? env.STRIPE_PRICE_YEARLY : env.STRIPE_PRICE_MONTHLY;
  if (!priceId) {
    return jsonResponse(500, { error: { code: "not_configured" } });
  }

  const params = new URLSearchParams({
    mode: "subscription",
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": "1",
    success_url: `${env.ORIGIN}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${env.ORIGIN}/?checkout=cancelled`,
    allow_promotion_codes: "true",
    "billing_mode[type]": "classic",
    "consent_collection[terms_of_service]": "required",
    "custom_text[terms_of_service_acceptance][message]": consentMessage,
    locale: lang,
    payment_method_collection: "if_required",
  });

  let session;
  try {
    session = await post(env, "checkout/sessions", params);
  } catch (error) {
    if (error instanceof StripeError) {
      console.error("checkout_session_create_failed", error.status);
      return jsonResponse(502, { error: { code: "stripe_error" } });
    }
    return jsonResponse(502, { error: { code: "stripe_unreachable" } });
  }

  return jsonResponse(200, { url: session.url });
}
