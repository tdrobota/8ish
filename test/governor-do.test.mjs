// Story 7-2 -- tests for functions/lib/governor-do.js, the Durable
// Object wiring layer. This file never imports functions/governor.js
// itself (the real `class Governor extends DurableObject`) because that
// file imports `DurableObject` from the `cloudflare:workers` builtin
// module, which only exists inside the Workers runtime -- attempting to
// import it under plain `node --test` would fail to resolve, and the spec
// explicitly says not to run `wrangler dev` to get a real DO to test
// against. Instead this exercises `createGovernorHandlers` directly: the
// same alarm try/catch/reschedule logic `functions/governor.js`'s `alarm()`
// method delegates to, driven here with a mock `storage` object (matching
// the real `ctx.storage` alarm API's shape: async getAlarm/setAlarm/
// deleteAlarm) and the same real, `node:sqlite`-backed adapter the core
// suite uses. See governor-do.js's own header comment for the fuller
// rationale for this split.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createGovernorHandlers, ALARM_RETRY_DELAY_MS } from "../functions/lib/governor-do.js";
import { EXPIRY_MS, PRUNE_AGE_MS } from "../functions/lib/governor-core.js";
import { createSqliteAdapter } from "./lib/sqlite-adapter.mjs";

function makeClock(startMs) {
  let value = startMs;
  return {
    now: () => value,
    set(ms) {
      value = ms;
    },
    advance(ms) {
      value += ms;
    },
  };
}

// A faithful mock of the three Durable Object alarm methods this layer
// actually calls. Records every call so tests can assert on what was
// (or wasn't) scheduled, and can be told to throw on the next call to
// simulate a genuinely failing storage layer.
function makeMockStorage() {
  let alarm = null;
  const calls = [];
  let throwOnSetAlarm = false;

  return {
    calls,
    getCurrentAlarm: () => alarm,
    failNextSetAlarm() {
      throwOnSetAlarm = true;
    },
    async getAlarm() {
      calls.push({ op: "getAlarm" });
      return alarm;
    },
    async setAlarm(ms) {
      calls.push({ op: "setAlarm", ms });
      if (throwOnSetAlarm) {
        throwOnSetAlarm = false;
        throw new Error("simulated setAlarm failure");
      }
      alarm = ms;
    },
    async deleteAlarm() {
      calls.push({ op: "deleteAlarm" });
      alarm = null;
    },
  };
}

function freshHandlers(startMs = 1_700_000_000_000) {
  const adapter = createSqliteAdapter();
  const clock = makeClock(startMs);
  const storage = makeMockStorage();
  const handlers = createGovernorHandlers({ sql: adapter, now: clock.now, storage });
  return { handlers, adapter, clock, storage };
}

test("reserve() that is granted arms the alarm no later than the new reservation's own expiry", async () => {
  const { handlers, clock, storage } = freshHandlers(1_000_000);
  const result = await handlers.reserve("free", "k1", { ceiling: 10 });
  assert.equal(result.ok, true);
  assert.equal(storage.getCurrentAlarm(), clock.now() + EXPIRY_MS);
});

test("reserve() that is denied touches the alarm not at all", async () => {
  const { handlers, storage } = freshHandlers();
  await handlers.reserve("free", "k1", { ceiling: 0 }); // ceiling already "full" at 0
  const denied = await handlers.reserve("free", "k2", { ceiling: 0 });
  assert.equal(denied.ok, false);

  const callsForDenied = storage.calls.length;
  const denied2 = await handlers.reserve("free", "k3", { ceiling: 0 });
  assert.equal(denied2.ok, false);
  assert.equal(storage.calls.length, callsForDenied, "a denied reserve must not call getAlarm/setAlarm/deleteAlarm at all");
});

test("reserve() never moves an already-armed EARLIER alarm later", async () => {
  const { handlers, clock, storage } = freshHandlers(1_000_000);
  const first = await handlers.reserve("free", "k1", { ceiling: 10 }); // arms at t+EXPIRY_MS
  assert.equal(storage.getCurrentAlarm(), clock.now() + EXPIRY_MS);

  clock.advance(1000); // a later reservation, whose own expiry is LATER than the first's
  await handlers.reserve("free", "k2", { ceiling: 10 });
  assert.equal(storage.getCurrentAlarm(), 1_000_000 + EXPIRY_MS, "the earlier-armed alarm (for k1's own expiry) must not be pushed later by k2's later reservation");
});

// Story 7-2 review finding (Blind Hunter): unlike alarm()'s own carefully
// guarded sweep, `reserve()`'s alarm-arming call had NO try/catch --
// `core.reserve()` had already durably written and counted the row before
// this point, so a storage hiccup arming the alarm must never turn that
// real, already-spent grant into what looks like a failed reserve() call.
test("reserve() still reports the real (successful) grant even when arming its own alarm fails", async () => {
  const { handlers, storage } = freshHandlers(2_000_000);
  storage.failNextSetAlarm();

  const originalConsoleError = console.error;
  const loggedCalls = [];
  console.error = (...args) => loggedCalls.push(args);
  let result;
  try {
    result = await handlers.reserve("free", "k1", { ceiling: 10 });
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(result.ok, true, "the grant itself must still be reported truthfully -- the row was already written before the alarm-arm attempt");
  assert.equal(typeof result.id, "string");
  assert.ok(
    loggedCalls.some((args) => args[0] === "governor_reserve_alarm_arm_failed"),
    "the alarm-arm failure must be logged, not silently swallowed"
  );

  // And the reservation really is there, spent, even though its alarm
  // coverage is degraded -- a subsequent reserve() call (which arms its
  // own, later alarm) still sees it counted.
  const denied = await handlers.reserve("free", "k2", { ceiling: 1 });
  assert.equal(denied.ok, false, "the first reservation must still count toward the ceiling despite the alarm-arm failure");
});

test("commit() and release() delegate to the core and are idempotent through the wrapper", async () => {
  const { handlers } = freshHandlers();
  const { id } = await handlers.reserve("free", "k1", { ceiling: 10 });
  const c1 = await handlers.commit(id);
  assert.equal(c1.state, "committed");
  const c2 = await handlers.commit(id);
  assert.equal(c2.idempotent, true);

  const { id: id2 } = await handlers.reserve("free", "k2", { ceiling: 10 });
  const r1 = await handlers.release(id2, { neverCalled: true });
  assert.equal(r1.state, "released");
  const r2 = await handlers.release(id2, { neverCalled: true });
  assert.equal(r2.idempotent, true);
});

test("alarm() sweeps an expired reservation and re-arms for the next-soonest thing pending", async () => {
  const { handlers, clock, storage } = freshHandlers(5_000_000);
  await handlers.reserve("free", "k1", { ceiling: 10 });

  clock.advance(EXPIRY_MS); // now 60s later -- the reservation above is expired
  await handlers.alarm();

  // Nothing else reserved -- alarm() should fall back to the 2-day prune horizon.
  assert.equal(storage.getCurrentAlarm(), 5_000_000 + PRUNE_AGE_MS);
});

test("alarm() deletes the alarm entirely when the sweep finds nothing pending at all", async () => {
  const { handlers, storage } = freshHandlers();
  // No reservations ever made -- sweep has nothing to do and nothing to
  // re-arm for.
  await handlers.alarm();
  assert.equal(storage.getCurrentAlarm(), null);
  assert.ok(storage.calls.some((c) => c.op === "deleteAlarm"));
});

// Wraps a real (working) sql adapter so schema creation at
// `createGovernorHandlers()` time succeeds normally, but calls made AFTER
// `setBroken(true)` throw -- simulating a storage layer that fails mid-sweep
// rather than one that was never usable at all (a strictly harder,
// more realistic case for "does alarm() reschedule despite a throw").
function makeSometimesBrokenAdapter(realAdapter) {
  let broken = false;
  return {
    setBroken(value) {
      broken = value;
    },
    exec(...args) {
      if (broken) throw new Error("simulated sql failure");
      return realAdapter.exec(...args);
    },
  };
}

test("alarm() catches a throwing sweep, logs, and still reschedules via the retry delay -- never silently stops sweeping", async () => {
  const clock = makeClock(9_000_000);
  const storage = makeMockStorage();
  const sometimesBroken = makeSometimesBrokenAdapter(createSqliteAdapter());
  const handlers = createGovernorHandlers({ sql: sometimesBroken, now: clock.now, storage });

  sometimesBroken.setBroken(true);

  const originalConsoleError = console.error;
  const loggedCalls = [];
  console.error = (...args) => loggedCalls.push(args);
  try {
    await assert.doesNotReject(() => handlers.alarm(), "alarm() must never let a sweep failure escape as an uncaught rejection");
  } finally {
    console.error = originalConsoleError;
  }

  assert.ok(
    loggedCalls.some((args) => args[0] === "governor_alarm_sweep_failed"),
    "the sweep failure must be logged"
  );
  assert.equal(storage.getCurrentAlarm(), clock.now() + ALARM_RETRY_DELAY_MS, "alarm() must reschedule itself even though the sweep threw");
});

test("alarm() logs (but does not throw) when even the reschedule-after-error setAlarm call itself fails", async () => {
  const clock = makeClock(9_000_000);
  const storage = makeMockStorage();
  const sometimesBroken = makeSometimesBrokenAdapter(createSqliteAdapter());
  const handlers = createGovernorHandlers({ sql: sometimesBroken, now: clock.now, storage });

  sometimesBroken.setBroken(true);
  storage.failNextSetAlarm();

  const originalConsoleError = console.error;
  const loggedCalls = [];
  console.error = (...args) => loggedCalls.push(args);
  try {
    await assert.doesNotReject(() => handlers.alarm());
  } finally {
    console.error = originalConsoleError;
  }

  assert.ok(loggedCalls.some((args) => args[0] === "governor_alarm_sweep_failed"));
  assert.ok(loggedCalls.some((args) => args[0] === "governor_alarm_reschedule_failed"));
});

// -------------------------------------- Story 8-4: getDailyImageCounts()

test("getDailyImageCounts() delegates straight to the core, with no alarm/storage interaction at all", async () => {
  const { handlers, storage } = freshHandlers(Date.UTC(2026, 0, 1, 12, 0, 0));
  const budgetDay = "2026-01-01";
  const { id } = await handlers.reserve("free", "k1", { ceiling: 1000 });
  storage.calls.length = 0; // reset -- only interested in what getDailyImageCounts itself does

  const before = await handlers.getDailyImageCounts(budgetDay);
  assert.deepEqual(before, { free: 1, sub: 0, imagesTotal: 1 });
  assert.equal(storage.calls.length, 0, "a pure read must never touch getAlarm/setAlarm/deleteAlarm");

  await handlers.commit(id);
  const after = await handlers.getDailyImageCounts(budgetDay);
  assert.deepEqual(after, { free: 1, sub: 0, imagesTotal: 1 }, "committing (not adding) an existing reservation must not change the count");
});

test("createGovernorHandlers requires a storage object with getAlarm/setAlarm", () => {
  const adapter = createSqliteAdapter();
  assert.throws(() => createGovernorHandlers({ sql: adapter, now: () => 0, storage: {} }));
  assert.throws(() => createGovernorHandlers({ sql: adapter, now: () => 0, storage: null }));
});
