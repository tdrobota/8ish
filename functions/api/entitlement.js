// Entitlement — Cloudflare Function for POST /api/entitlement
//
// Re-checks a previously-confirmed subscription's status. monetize.js calls
// this roughly once a minute per device (see ENTITLEMENT_RECHECK_MS) —
// cheap because this reads a KV cache first, kept fresh in near-real-time by
// stripe-webhook.js whenever Stripe notifies us of a status change. Only on
// a cache miss (e.g. a webhook that was never received — Stripe retries for
// 3 days, not forever — or a cache entry old enough to have expired, see
// lib/subStatus.js's 6h TTL) does this fall back to a live Stripe lookup,
// same as before the webhook existed. That live result is NOT written back
// into the KV cache — only stripe-webhook.js does that (see lib/subStatus.js
// for why) — but repeat lookups within 60s are deduped by subStatus.js's
// own in-isolate lookup cache, so a burst of checks still calls Stripe at
// most once.
//
// Story 6-1: the cache read and live-lookup fallback now live entirely in
// lib/subStatus.js (the one file allowed to touch the `subStatus` KV
// namespace) and the live Stripe call goes through lib/stripe.js (the one
// file allowed to call the Stripe API) instead of a direct fetch.
//
// Story 6-2: this moved from GET ?subscription_id= (an unsigned id anyone
// could hand-edit or replay) to POST with `Authorization: Bearer
// <credential>`. The credential's signature and expiry are verified FIRST —
// zero KV/Stripe I/O before that (AD-23, "no state before proof") — and the
// subscription id used for the status lookup comes ONLY from the verified
// credential's payload, never from any request parameter. On an active
// answer, a fresh credential is minted and returned unconditionally (not
// only when the client asks for one), extending the 7-day window on every
// successful recheck so a subscriber who opens the app regularly never sees
// it expire.
//
// Two distinct "not configured" failure modes exist and both fail closed to
// the same not_configured response: ENTITLEMENT_SECRET missing (checked by
// credential.verify()/mint() — no credential could ever be valid without
// it) and STRIPE_SECRET_KEY missing (checked by subStatus.read()'s live-
// lookup fallback only once a live Stripe call is actually about to
// happen — a KV cache hit must still answer even if that secret is unset).
// The refresh-credential mint() call after a successful active read is
// wrapped too, for the same reason — any failure there still needs the
// documented {error:{code}} envelope, never an unstructured 500.
//
// No anti-CSRF token on this state-changing POST: there is no cookie or
// other ambient credential a forged cross-site request could ride on —
// this endpoint's whole authorization is an explicit Bearer credential the
// caller must already possess and attach itself, and neither a cross-site
// <form> submission nor a plain cross-origin fetch() can set an
// Authorization header. The content-type check below is a second,
// independent layer on top of that: requiring application/json (a
// "non-simple" content type under the Fetch/CORS spec) forces a CORS
// preflight for any cross-origin caller, and this app returns no
// Access-Control-Allow-Origin for a foreign origin, so that preflight — and
// therefore the real request — never succeeds cross-site either.

import * as credential from "../lib/credential.js";
import { StripeError } from "../lib/stripe.js";
import { NotConfiguredError as StripeNotConfiguredError, read } from "../lib/subStatus.js";
import { readCappedBody } from "../lib/http-body.js";

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const BEARER_RE = /^Bearer\s+(\S+)$/i;

// Story 7-8: this endpoint reads no request body at all today (only the
// Authorization header and content-type), but a body cap is still applied
// -- 8KB, generous headroom (spec-7-8 Design Notes) -- as defense-in-depth
// against an unbounded request body being sent here at all.
const MAX_BODY_BYTES = 8 * 1024;

function extractBearerToken(request) {
  // Headers.get() is already case-insensitive by spec, so one lookup covers
  // "authorization", "Authorization", or any other casing a caller sends.
  const header = request.headers.get("authorization");
  if (typeof header !== "string") return null;
  const match = BEARER_RE.exec(header.trim());
  return match ? match[1] : null;
}

export async function onRequestPost({ request, env }) {
  // Story 7-8: actual byte-count cap, read from the real bytes -- the very
  // first thing this function does, before even the content-type check
  // below (AD-23, "no state before proof" -- before any credential/Stripe
  // call).
  const capped = await readCappedBody(request, MAX_BODY_BYTES);
  if (!capped.ok) {
    return jsonResponse(400, { error: { code: "bad_request" } });
  }

  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return jsonResponse(400, { error: { code: "bad_request" } });
  }

  const token = extractBearerToken(request);

  let payload;
  try {
    // Signature + expiry + type-prefix verification only — no I/O. A
    // missing/tampered/expired/wrong-type token returns null here without
    // ever reaching the KV/Stripe lookup below.
    payload = await credential.verify(env, token);
  } catch (error) {
    if (error instanceof credential.NotConfiguredError) {
      return jsonResponse(500, { error: { code: "not_configured" } });
    }
    throw error;
  }

  if (!payload) {
    return jsonResponse(401, { error: { code: "invalid_credential" } });
  }

  let result;
  try {
    // The subscription id comes only from the verified credential's own
    // payload — never from a header, query string, or body field a caller
    // could set directly.
    result = await read(env, payload.sub);
  } catch (error) {
    if (error instanceof StripeNotConfiguredError) {
      return jsonResponse(500, { error: { code: "not_configured" } });
    }
    if (error instanceof StripeError) {
      console.error("entitlement_stripe_error", error.status);
      return jsonResponse(502, { error: { code: "stripe_error" } });
    }
    console.error("entitlement_lookup_failed");
    return jsonResponse(502, { error: { code: "stripe_unreachable" } });
  }

  const body = { active: result.active, currentPeriodEnd: result.currentPeriodEnd ?? null };
  if (result.active) {
    try {
      // Unconditional on active, not on client request — see file header.
      body.credential = await credential.mint(env, payload.sub);
    } catch {
      // mint() can only fail this way if ENTITLEMENT_SECRET vanished
      // between the verify() call above and here — practically never, but
      // the client must still get the documented {error:{code}} shape, not
      // an unstructured 500.
      return jsonResponse(500, { error: { code: "not_configured" } });
    }
  }
  return jsonResponse(200, body);
}
