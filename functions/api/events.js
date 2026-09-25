// Client-only events, without identifiers — Cloudflare Function for
// POST /api/e (Story 8-2, atop Story 8-1's server-side writeEvent() helper,
// functions/lib/events.js).
//
// Two funnel moments only the CLIENT can observe (a child hitting the
// daily Image limit, a parent opening the paywall) have no server-side
// call site to hook a writeEvent() into -- this is the one client-facing
// entry point into the funnel counters Story 8.1 built. Every response is
// 204 with an empty body, whichever internal branch produced it (accepted,
// allowlist-rejected, malformed JSON, oversized body, or rate-limited) --
// a probe from the outside can't distinguish any of them and learns
// nothing about the allowlist's contents or the rate cap's threshold
// (spec-8-2's Design Notes: "the endpoint must be constant-shape from the
// outside no matter which branch it takes internally"). GET (or any other
// method) is routed to 405 by worker.js, the same convention every other
// endpoint in this app already uses -- that is the one intentional
// difference, decided at the routing layer, never part of the allowlist
// probe surface itself.
//
// No cookie, header, or body field carrying any identifier is ever read
// here -- the request body is inspected for exactly one field, `event`,
// a plain string checked only against the fixed two-name allowlist below.
// No server-authoritative event name (e.g. app_open, checkout_started,
// purchase_completed/cancelled, image_created/refused/failed -- every name
// Story 8.1 already writes from server-only call sites) is ever accepted
// from a client-supplied body, and no event name beyond the two
// allowlisted here is ever added. This file never imports anything from
// functions/lib/governor-*.js or functions/governor.js -- it is
// intentionally an ungoverned, best-effort counter, not a spend path.
//
// Rate cap: a single global-per-isolate rolling counter -- NOT
// lib/request-throttle.js's per-key checkPreLimit/checkDenyCache (a
// different shape for a different purpose, see that file's own header and
// spec-8-2's Design Notes: "a burst against the ENDPOINT, from anyone",
// not a burst against one caller). Checked FIRST, before the body is even
// read, so it counts literally every request that reaches this endpoint
// this isolate this minute -- accepted or not -- and a flood past the cap
// costs the flooder nothing extra (no body read, no parse, no write) once
// this isolate's 30-per-minute budget for this rolling window is spent.
import { readCappedBody } from "../lib/http-body.js";
import { writeEvent } from "../lib/events.js";

// Every legitimate body here is a tiny {event:"limit_reached"} or
// {event:"paywall_viewed"} object -- 256 bytes is generous headroom while
// keeping this endpoint an unattractive place to smuggle anything larger.
const MAX_BODY_BYTES = 256;

// The ONLY two event names this endpoint will ever write -- see the file
// header. Never extend this Set with a server-authoritative name or
// anything else; that is Story 8.1's job (functions/lib/events.js's own
// callers), not this client-facing endpoint's.
const ALLOWED_EVENTS = new Set(["limit_reached", "paywall_viewed"]);

const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_PER_WINDOW = 30;

// Module-scope, isolate-lifetime state -- mirrors lib/request-throttle.js's
// own fixed-window shape (see that file's header comment) but as a SINGLE
// global counter, not a per-key Map: this cap protects the endpoint itself
// from a flood by anyone (or many anyones), not any one caller from a
// burst. A new window starts the moment `now` has moved RATE_WINDOW_MS past
// the current window's own start, at which point the counter resets to 1
// for this call -- identical semantics to request-throttle.js's own
// checkPreLimit(), just without the per-key Map wrapper.
let rateWindowStart = 0;
let rateWindowCount = 0;

// Returns true (this request may proceed) or false (this isolate's 30/min
// budget for the current rolling window is already spent). Counts THIS
// call either way -- called once per request, before any other work.
function withinGlobalRate(now = Date.now()) {
  if (now - rateWindowStart >= RATE_WINDOW_MS) {
    rateWindowStart = now;
    rateWindowCount = 0;
  }
  rateWindowCount += 1;
  return rateWindowCount <= RATE_LIMIT_PER_WINDOW;
}

// Test-only reset -- a real Worker isolate never needs to clear this
// itself; a fresh isolate simply starts at 0, same convention as
// lib/request-throttle.js's own _resetRequestThrottleForTests().
export function _resetEventsRateForTests() {
  rateWindowStart = 0;
  rateWindowCount = 0;
}

function noContent() {
  return new Response(null, { status: 204 });
}

export async function onRequestPost({ request, env, ctx }) {
  // 1. Rate check, before any body read -- the cheapest possible fail-fast,
  // and the literal reading of the frozen spec's own I/O matrix row: the
  // 31st request within one rolling minute, same isolate, still answers
  // 204, with nothing written past the 30th accepted write in that window.
  if (!withinGlobalRate()) {
    return noContent();
  }

  // 2. Byte-count cap, read from the real bytes (lib/http-body.js, shared
  // with every other POST endpoint in this app).
  const capped = await readCappedBody(request, MAX_BODY_BYTES);
  if (!capped.ok) {
    return noContent();
  }

  // 3. Malformed JSON -- nothing written, still 204.
  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(capped.bytes));
  } catch {
    return noContent();
  }

  // 4. Allowlist check -- `event` can only ever be one of the two literal
  // strings in ALLOWED_EVENTS by the time it reaches writeEvent() below;
  // anything else (a server-authoritative name, or literally anything
  // else) is dropped right here, still 204.
  const event = body && typeof body.event === "string" ? body.event : "";
  if (!ALLOWED_EVENTS.has(event)) {
    return noContent();
  }

  // 5. Write, via the shared Story 8.1 helper -- source "" (this endpoint
  // has no server-side "source" of its own to report; matches every other
  // caller's own convention of an empty-string source when none applies).
  writeEvent(env, ctx, event, "");
  return noContent();
}
