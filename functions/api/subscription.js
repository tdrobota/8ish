// Subscription — Cloudflare Function for POST /api/subscription
//
// Story 6-6: the in-app Cancel/Resume path Story 6.7 needs before it can
// remove Story 3.5's interim Terms sentence that routed every cancellation
// through the owner's inbox. Body: `{ action: "cancel" | "resume" }`.
//
// Auth pattern mirrors entitlement.js's ordering EXACTLY (AD-23, "no state
// before proof"): the `Authorization: Bearer <credential>` token is verified
// via lib/credential.js's verify() FIRST — zero Stripe/KV calls before that.
// The subscription id used for the Stripe call comes ONLY from the verified
// credential's own payload, never from any request body field a caller
// could set directly (a body-supplied subscription id would let a valid
// credential for one subscription cancel/resume a DIFFERENT one). Unlike
// entitlement.js, a missing/invalid credential here answers
// `{error:{code:"unauthorized"}}` (not "invalid_credential") — the exact
// code this story's own I/O matrix documents.
//
// `action` is validated only AFTER the credential — an unrecognized action
// with a perfectly valid credential still costs zero Stripe calls, answering
// 400 `bad_request` (I/O matrix: "an unrecognized action").
//
// The two Stripe params this sends: cancel -> `cancel_at_period_end=true`,
// `proration_behavior=none` (no refund/charge adjustment — a family that
// cancels keeps what they already paid for, through the end of the current
// period); resume -> `cancel_at_period_end=false` alone (clears the
// scheduled cancellation, no proration implications either way).
//
// On a successful Stripe update, this also writes through
// lib/subStatus.js's write() — same `active`/`currentPeriodEnd` derivation
// stripe-webhook.js's own refreshSubscription() uses (isActiveStatus(),
// items.data[0].current_period_end under Stripe API 2025-03-31 "Basil") —
// so entitlement.js's cache doesn't serve a stale answer until the
// `customer.subscription.updated` webhook this same Stripe call triggers
// eventually arrives. Source "subscription_api", distinct from "webhook"
// and "live", purely for observability — subStatus.write()'s asOf-ordering
// guard treats every source identically. Best-effort: a KV write failure
// here is logged but never turns this response into an error — the Stripe
// call above is the actual source of truth for what the response reports,
// and the webhook (or entitlement.js's own live-lookup fallback on a cache
// miss) still catches up shortly either way.
//
// `cancelAtPeriodEnd` in the response is never the raw
// `cancel_at_period_end` boolean alone — it is
// `cancel_at_period_end === true || cancel_at != null`. A classic-mode
// subscription (this app's own billing_mode, see checkout.js) can carry a
// scheduled cancellation via either field depending on how it was set, and
// trusting only one would under-report a cancellation Stripe itself already
// considers scheduled (I/O matrix: "cancelAtPeriodEnd derivation").
//
// Same no-anti-CSRF-token reasoning as entitlement.js's own header comment:
// no cookie or other ambient credential a forged cross-site request could
// ride on, and the required `application/json` content-type forces a CORS
// preflight this app never approves for a foreign origin.

import * as credential from "../lib/credential.js";
import { post, StripeError } from "../lib/stripe.js";
import { isActiveStatus, write } from "../lib/subStatus.js";
import { readCappedBody } from "../lib/http-body.js";

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const BEARER_RE = /^Bearer\s+(\S+)$/i;

// Story 7-8: every request body this endpoint legitimately receives is a
// tiny {action} object -- 8KB is generous headroom (spec-7-8 Design Notes).
const MAX_BODY_BYTES = 8 * 1024;

// Identical to entitlement.js's own extractBearerToken — see that file for
// why one Headers.get() call already covers any casing a caller sends.
function extractBearerToken(request) {
  const header = request.headers.get("authorization");
  if (typeof header !== "string") return null;
  const match = BEARER_RE.exec(header.trim());
  return match ? match[1] : null;
}

// `subscription.cancel_at_period_end === true || subscription.cancel_at !=
// null` — see the file header for why neither field alone is trusted.
function deriveCancelAtPeriodEnd(subscription) {
  return subscription.cancel_at_period_end === true || subscription.cancel_at != null;
}

export async function onRequestPost({ request, env }) {
  // Story 7-8: actual byte-count cap, read from the real bytes -- the very
  // first thing this function does, before even the content-type check
  // below (AD-23, "no state before proof" -- before any credential/Stripe
  // call). This is the ONLY body read this file ever does -- the capped
  // bytes are parsed directly further below, in place of the old separate
  // `request.json()` call, rather than a `request.clone()` + a second read:
  // a real body stream can only safely be torn (`.tee()`, what `.clone()`
  // does under the hood) and cancelled on ONE branch if the other branch is
  // also drained -- verified by hand against Node's own fetch
  // implementation, `reader.cancel()` on a cloned-and-abandoned branch
  // hangs the request forever instead of ever resolving. A single capped
  // read sidesteps that hazard entirely (and matches restore.js's/
  // transform.js's own pattern).
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
    // ever reaching the action-validation or Stripe call below.
    payload = await credential.verify(env, token);
  } catch (error) {
    if (error instanceof credential.NotConfiguredError) {
      return jsonResponse(500, { error: { code: "not_configured" } });
    }
    throw error;
  }

  if (!payload) {
    return jsonResponse(401, { error: { code: "unauthorized" } });
  }

  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(capped.bytes));
  } catch {
    return jsonResponse(400, { error: { code: "bad_request" } });
  }

  const action = body && body.action;
  if (action !== "cancel" && action !== "resume") {
    return jsonResponse(400, { error: { code: "bad_request" } });
  }

  const params =
    action === "cancel"
      ? { cancel_at_period_end: "true", proration_behavior: "none" }
      : { cancel_at_period_end: "false" };

  let subscription;
  try {
    // The subscription id comes only from the verified credential's own
    // payload — never from a header, query string, or body field a caller
    // could set directly.
    subscription = await post(env, `subscriptions/${encodeURIComponent(payload.sub)}`, params);
  } catch (error) {
    if (error instanceof StripeError) {
      console.error("subscription_stripe_error", error.status);
      return jsonResponse(502, { error: { code: "stripe_error" } });
    }
    console.error("subscription_stripe_unreachable");
    return jsonResponse(502, { error: { code: "stripe_unreachable" } });
  }

  // Same active/currentPeriodEnd derivation stripe-webhook.js's own
  // refreshSubscription() uses — see the file header.
  const active = isActiveStatus(subscription.status);
  const item = subscription.items && subscription.items.data[0];
  const currentPeriodEnd = item ? item.current_period_end : null;
  const cancelAtPeriodEnd = deriveCancelAtPeriodEnd(subscription);

  try {
    await write(env, payload.sub, { active, asOf: Date.now(), source: "subscription_api", currentPeriodEnd });
  } catch {
    // Best-effort cache write-through — see the file header. This response
    // already reports the fresh Stripe truth regardless of whether the
    // cache accepted it.
    console.error("subscription_substatus_write_failed");
  }

  return jsonResponse(200, { active, cancelAtPeriodEnd, currentPeriodEnd });
}
