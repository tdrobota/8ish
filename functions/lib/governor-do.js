// Spend Governor -- the Durable Object wiring layer (Story 7-2).
//
// This is deliberately a SEPARATE file from `functions/governor.js`
// (the actual `class Governor extends DurableObject`) even though the spec's
// own Code Map only names two new files under `functions/` -- see the Spec
// Change Log in spec-7-2-governor-core.md for why: `functions/governor.js`
// necessarily imports `DurableObject` from the `cloudflare:workers` builtin
// module, which does not exist outside the Workers runtime, so nothing that
// imports that file can be exercised by `node --test`. Every piece of
// DO-adjacent logic that CAN be tested in plain Node without a real Durable
// Object -- in particular the alarm handler's try/catch/reschedule-on-error
// behavior the spec asks for -- lives here instead, as a plain factory
// function with no Cloudflare-specific import of its own. `functions/
// governor.js` itself shrinks to the few lines that actually need the real
// `ctx`/`DurableObject` types: wiring `ctx.storage.sql`/`ctx.storage`/
// `Date.now` into `createGovernorHandlers` below and exposing its four
// methods as the class's own.
//
// createGovernorHandlers({ sql, now, storage }):
//   - `sql`: same adapter shape governor-core.js expects.
//   - `now`: `() => <ms epoch>`.
//   - `storage`: duck-typed to the three Durable Object alarm methods this
//     file actually calls -- `getAlarm(): Promise<number|null>`,
//     `setAlarm(ms): Promise<void>`, `deleteAlarm(): Promise<void>`. The
//     real caller passes `ctx.storage`; tests pass a plain mock object with
//     the same three async methods (see test/governor-do.test.mjs) --
//     nothing here imports or type-checks against the real Durable Object
//     storage type, so a mock is a legitimate, fully-representative test
//     double, not a stand-in for something untestable.
//
// Returns `{ reserve, commit, release, alarm }`, each an async function
// matching the shape `functions/governor.js`'s class methods delegate to
// directly.

import { createGovernorCore } from "./governor-core.js";

// If a sweep throws (a genuine storage/adapter failure), how soon to try
// again rather than leaving the Governor permanently unswept. Short enough
// that a transient failure self-heals quickly; long enough not to hammer a
// storage layer that's genuinely having trouble.
export const ALARM_RETRY_DELAY_MS = 30 * 1000;

// Arms `storage`'s alarm no LATER than `whenMs` -- i.e. only moves it
// earlier, or sets it if nothing is currently scheduled. A newly granted
// reservation must never push out an already-pending, earlier expiry
// that some OTHER still-`reserved` row needs; it only ever needs to make
// sure the alarm fires by ITS OWN expiry at the latest.
async function ensureAlarmNoLaterThan(storage, whenMs) {
  const current = await storage.getAlarm();
  if (current === null || current === undefined || current > whenMs) {
    await storage.setAlarm(whenMs);
  }
}

export function createGovernorHandlers({ sql, now, storage }) {
  if (!storage || typeof storage.getAlarm !== "function" || typeof storage.setAlarm !== "function") {
    throw new Error("createGovernorHandlers: storage.getAlarm/setAlarm are required");
  }

  const core = createGovernorCore({ sql, now });

  async function reserve(kind, key, cfg) {
    // The actual accounting decision -- the part concurrency-safety
    // depends on -- runs synchronously, to completion, before this
    // function's first `await`. Everything after this line (arming the
    // alarm) can safely interleave with another concurrent call: by the
    // time it runs, this reservation's row (or lack of one) is already
    // durably decided.
    const result = core.reserve(kind, key, cfg);
    if (result.ok) {
      // `core.reserve()` has ALREADY returned, synchronously, with the row
      // durably written and counted toward the ceiling -- a storage hiccup
      // arming the alarm must never turn that real, already-spent
      // reservation into what looks like a failed reserve() call to the
      // caller (that would be the opposite of fail-closed: the spend
      // silently succeeded but wasn't reported as such, and Story 7.5's
      // handler could plausibly retry, double-spending). Log and return the
      // real (successful) result regardless -- the same "a storage failure
      // must never silently swallow or misreport real state" principle
      // `alarm()`'s own try/catch/reschedule below already applies. The row
      // may be left without full alarm coverage until the next successful
      // reserve()/alarm() call re-arms it, which is an acceptable, logged
      // degradation (Story 7-2 review finding) -- not a silent one.
      try {
        await ensureAlarmNoLaterThan(storage, result.alarmAt);
      } catch (error) {
        console.error("governor_reserve_alarm_arm_failed", error && error.message);
      }
    }
    // A denied reserve writes zero rows and, per the frozen spec, "arms no
    // alarm" -- `ensureAlarmNoLaterThan` above is simply never called for
    // the denied branch, so any already-armed alarm for an unrelated
    // pending reservation is also left untouched, exactly as it should be.
    return result;
  }

  async function commit(id) {
    return core.commit(id);
  }

  async function release(id, opts) {
    return core.release(id, opts);
  }

  // Story 8-4: one new additive, read-only method -- delegates straight to
  // the core's own getDailyImageCounts(), mirroring commit()/release()'s
  // own one-line delegation shape above. No alarm, no state transition, no
  // write of any kind -- a plain read.
  async function getDailyImageCounts(budgetDay) {
    return core.getDailyImageCounts(budgetDay);
  }

  // Sweeps expired reservations + prunes 2-day-old rows, then re-arms
  // itself for the next-soonest thing that needs attention. Never lets a
  // throw (a genuine storage/adapter failure mid-sweep) silently stop
  // future sweeps: whatever went wrong is logged and the alarm is
  // rescheduled anyway via the retry delay, so the Governor self-heals on
  // the next tick instead of going permanently dark.
  async function alarm() {
    try {
      const nowMs = now();
      const { nextAlarmAt } = core.sweep(nowMs);
      if (nextAlarmAt != null) {
        await storage.setAlarm(nextAlarmAt);
      } else if (typeof storage.deleteAlarm === "function") {
        // Nothing pending at all (an empty table) -- leave the alarm
        // unset; the next granted `reserve()` arms it again.
        await storage.deleteAlarm();
      }
    } catch (error) {
      console.error("governor_alarm_sweep_failed", error && error.message);
      try {
        await storage.setAlarm(now() + ALARM_RETRY_DELAY_MS);
      } catch (rescheduleError) {
        // Even the reschedule itself failed (e.g. storage is genuinely
        // down) -- there is nothing further this handler can do; logging
        // is the only remaining action. The next externally-triggered
        // alarm delivery (Durable Object alarms are at-least-once) or the
        // next `reserve()`'s own `ensureAlarmNoLaterThan` call is what
        // eventually recovers scheduling.
        console.error("governor_alarm_reschedule_failed", rescheduleError && rescheduleError.message);
      }
    }
  }

  return { reserve, commit, release, alarm, getDailyImageCounts };
}
