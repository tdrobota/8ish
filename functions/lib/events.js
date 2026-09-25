// The one writer of server-side funnel counters to Analytics Engine (Story
// 8-1, AD-19). writeEvent(env, ctx, event, source) is the sole caller of
// env.FUNNEL.writeDataPoint() anywhere in this repo -- every handler that
// already knows a countable fact (a request reached /api/config, a checkout
// started, a Stripe event resolved to a real purchase/cancellation, an
// image request settled) calls this instead of touching env.FUNNEL itself,
// so the payload shape and the "never blocks/fails the caller" guarantee
// live in exactly one place.
//
// env.FUNNEL is an Analytics Engine binding that only exists on a real
// deploy (added to wrangler.jsonc this same story) -- it is absent in every
// test/dev context today. Whenever env.FUNNEL or its writeDataPoint method
// isn't a usable function, writeEvent no-ops silently and synchronously:
// exactly what the inline `env.FUNNEL?.writeDataPoint?.()` call this
// replaces (Epic 6, stripe-webhook.js) already did.
//
// Fire-and-forget by construction: writeDataPoint is never awaited inline
// in the caller's own request-handling flow. The call (including a
// SYNCHRONOUS throw from writeDataPoint itself, not just an async
// rejection) is wrapped in a promise chain with its own `.catch()`, logging
// a fixed event code on any failure -- so the returned/handed-off promise
// always resolves and is safe to leave unobserved. That safe promise is
// handed to ctx.waitUntil() when ctx/ctx.waitUntil is available (letting
// the write finish in the background after the response has already been
// sent); when it isn't (a test harness, or some future caller with no
// ctx), the promise still runs on its own -- either way, a slow or
// throwing env.FUNNEL can never delay or fail the caller's own response.
//
// Payload shape is fixed and identifier-free by construction -- callers
// pass only an event name and an optional source string, never an id,
// email, token, IP, or subscription id (see scripts/check-config.mjs's
// grep-based repo-wide proof that no call site anywhere ever does).
export function writeEvent(env, ctx, event, source) {
  const writeDataPoint = env && env.FUNNEL && env.FUNNEL.writeDataPoint;
  if (typeof writeDataPoint !== "function") return;

  const payload = {
    blobs: [event, source || ""],
    doubles: [1],
    indexes: [event],
  };

  // Promise.resolve().then(...) defers the actual writeDataPoint call into
  // the promise chain, so even a SYNCHRONOUS throw from it is caught by the
  // .catch() below rather than escaping this function's own call stack.
  const safeWrite = Promise.resolve()
    .then(() => writeDataPoint.call(env.FUNNEL, payload))
    .catch(() => {
      console.error("event_write_failed");
    });

  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(safeWrite);
  }
}

// Story 8.5 (spec-8-5-governor-reports-state.md): a private helper carrying
// EXACTLY writeEvent's own fire-and-forget/never-throws contract (the same
// Promise.resolve().then().catch() wrapping a possibly-synchronously-
// throwing writeDataPoint call, handed to ctx.waitUntil when available) --
// duplicated here, not extracted out of writeEvent's own body, because this
// story's Boundaries forbid touching writeEvent's existing code at all, even
// to refactor it losslessly. Only writeGovGauge below uses this; writeEvent
// itself is untouched, byte-for-byte, from Story 8-1.
function safeFunnelWrite(env, ctx, payload) {
  const writeDataPoint = env && env.FUNNEL && env.FUNNEL.writeDataPoint;
  if (typeof writeDataPoint !== "function") return;

  const safeWrite = Promise.resolve()
    .then(() => writeDataPoint.call(env.FUNNEL, payload))
    .catch(() => {
      console.error("event_write_failed");
    });

  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(safeWrite);
  }
}

// Story 8.5: the Spend Governor's own gauge data point -- carries the REAL
// current totals (`{total, free, sub, ceiling}`) as numbers, which does not
// fit writeEvent's own deliberately fixed `doubles:[1]` per-call-counter
// shape (Story 8-1's frozen "Always" clause -- see that story's Design
// Notes for why this needs its own narrow, purpose-built writer instead of
// reusing writeEvent). Same fire-and-forget/never-throws contract as
// writeEvent (via safeFunnelWrite above): a missing/broken env.FUNNEL, or a
// synchronous or asynchronous throw from writeDataPoint itself, never
// propagates to the caller.
export function writeGovGauge(env, ctx, { total, free, sub, ceiling } = {}) {
  safeFunnelWrite(env, ctx, {
    blobs: ["gov_gauge"],
    doubles: [total, free, sub, ceiling],
    indexes: ["gov_gauge"],
  });
}

// Story 8.5: the ONE place `ceiling_80`/`ceiling_reached`/`killswitch_seen`
// originate (frozen Intent -- "so a future push channel is one function to
// change"). Deliberately NOT named `notify` -- governor-core.js already
// exports an unrelated `notify(budgetDay)` (Story 7-8's platform-quota
// console.error, a different signature, a different concern, not touched by
// this story); reusing that name here would confuse the two. Today this is
// exactly what the frozen Design Notes describe: "a thin wrapper around
// writeEvent(env, ctx, event, '')" -- writeEvent's own fire-and-forget/
// never-throws contract already covers this call fully, so notifyAlert
// itself needs no extra safety net of its own. `ALERT_EVENTS` is a small,
// local allowlist (the same "structurally gated before a bare identifier
// reaches writeEvent" pattern functions/api/events.js's own ALLOWED_EVENTS
// already established) -- an unrecognized event name is silently dropped
// rather than ever reaching writeEvent with an arbitrary string, so this
// function's own future push-channel rewrite can rely on `event` always
// being one of exactly these three.
const ALERT_EVENTS = new Set(["ceiling_80", "ceiling_reached", "killswitch_seen"]);
export function notifyAlert(env, ctx, event) {
  if (!ALERT_EVENTS.has(event)) return;
  writeEvent(env, ctx, event, "");
}
