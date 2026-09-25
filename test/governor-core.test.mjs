// Story 7-2 -- the pure Governor core's own `node --test` suite. Covers
// every scenario in spec-7-2-governor-core.md's frozen I/O & Edge-Case
// Matrix. No Cloudflare runtime, no `wrangler dev` -- just
// functions/lib/governor-core.js over a fresh in-memory `node:sqlite`
// database per test, with a fully injected clock (see `makeClock` below).
// This is exactly the "fully testable outside any Durable Object" claim
// the story's Intent makes; this file is the proof.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createGovernorCore, EXPIRY_MS, PRUNE_AGE_MS, PLATFORM_ROW_CEILING, getDailyImageCounts } from "../functions/lib/governor-core.js";
import { createSqliteAdapter } from "./lib/sqlite-adapter.mjs";

// A controllable clock: `now()` reads the current injected instant,
// `set`/`advance` move it. Every test that cares about time uses this
// instead of the real wall clock -- no test in this file ever sleeps.
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

function freshCore(startMs = Date.UTC(2026, 0, 1, 12, 0, 0)) {
  const adapter = createSqliteAdapter();
  const clock = makeClock(startMs);
  const core = createGovernorCore({ sql: adapter, now: clock.now });
  return { core, adapter, clock };
}

// --------------------------------------------------------------- reserve()

test("reserve() grants under ceiling, writes one reserved row stamped with both days", () => {
  const { core, clock } = freshCore(Date.UTC(2026, 0, 1, 12, 0, 0));
  const result = core.reserve("free", "device-1", { ceiling: 40 });
  assert.equal(result.ok, true);
  assert.equal(typeof result.id, "string");
  assert.ok(result.id.length > 0);

  const row = core.getReservation(result.id);
  assert.equal(row.state, "reserved");
  assert.equal(row.budget_day, "2026-01-01");
  assert.equal(row.allowance_day, "2026-01-01"); // UTC noon is also Bucharest afternoon, same date
  assert.equal(row.reserved_at, clock.now());
  assert.equal(row.settled_at, null);
});

test("reserve() denies once spent-count === ceiling, writes zero rows, arms no alarm", () => {
  const { core, adapter } = freshCore();
  const r1 = core.reserve("free", "k1", { ceiling: 1 });
  assert.equal(r1.ok, true);

  const before = adapter.exec("SELECT COUNT(*) AS n FROM reservations").rows[0].n;
  const denied = core.reserve("free", "k2", { ceiling: 1 });
  assert.deepEqual(denied, { ok: false, denied: "resting" });

  const after = adapter.exec("SELECT COUNT(*) AS n FROM reservations").rows[0].n;
  assert.equal(after, before, "a denied reserve must write zero rows");
});

test("reserve() fails closed (denied resting) on a missing/invalid ceiling rather than granting or throwing", () => {
  const { core } = freshCore();
  assert.deepEqual(core.reserve("free", "k1", {}), { ok: false, denied: "resting" });
  assert.deepEqual(core.reserve("free", "k1", { ceiling: "40" }), { ok: false, denied: "resting" });
  assert.deepEqual(core.reserve("free", "k1", { ceiling: -1 }), { ok: false, denied: "resting" });
  assert.deepEqual(core.reserve("free", "k1", null), { ok: false, denied: "resting" });
});

test("500 concurrent reserve() calls at ceiling:40 grant no more than 41 -- and, with a truly await-free critical section, exactly 40", async () => {
  const { core } = freshCore();
  const CONCURRENCY = 500;
  const CEILING = 40;

  // Each call is wrapped in its own microtask (Promise.resolve().then(...))
  // to simulate "500 concurrent callers" the way the spec's Design Notes
  // describe -- but core.reserve() itself contains no `await`, so each of
  // these microtasks still runs its entire count-check-then-insert body to
  // completion before the next one starts. That is the whole point: this
  // is what proves reserve() has no suspension point for a race to use.
  const calls = Array.from({ length: CONCURRENCY }, (_, i) => Promise.resolve().then(() => core.reserve("free", `key-${i}`, { ceiling: CEILING })));
  const results = await Promise.all(calls);

  const granted = results.filter((r) => r.ok).length;
  const denied = results.filter((r) => !r.ok).length;
  assert.equal(granted + denied, CONCURRENCY);
  assert.ok(granted <= CEILING + 1, `granted (${granted}) must be <= ceiling+1 (${CEILING + 1}) -- epics.md's own literal tolerance`);
  // Design Notes: "build it so it doesn't [suspend], and the test should in
  // practice see exactly 40." Assert the tight bound too, not just <= 41.
  assert.equal(granted, CEILING, "an await-free reserve() should grant exactly the ceiling, not merely <= ceiling+1");

  const grantedIds = new Set(results.filter((r) => r.ok).map((r) => r.id));
  assert.equal(grantedIds.size, granted, "every granted reservation id must be unique");
});

// ---------------------------------------------------------------- commit()

test("commit() transitions reserved -> committed, and is idempotent by id", () => {
  const { core } = freshCore();
  const { id } = core.reserve("free", "k1", { ceiling: 10 });

  const first = core.commit(id);
  assert.deepEqual(first, { ok: true, id, state: "committed" });

  const second = core.commit(id);
  assert.equal(second.ok, true);
  assert.equal(second.state, "committed");
  assert.equal(second.idempotent, true);

  const row = core.getReservation(id);
  assert.equal(row.state, "committed");
});

test("commit() on an unknown id returns an error result, never throws, creates no row", () => {
  const { core, adapter } = freshCore();
  const before = adapter.exec("SELECT COUNT(*) AS n FROM reservations").rows[0].n;
  assert.doesNotThrow(() => {
    const result = core.commit("not-a-real-id");
    assert.equal(result.ok, false);
    assert.equal(result.error, "not_found");
  });
  const after = adapter.exec("SELECT COUNT(*) AS n FROM reservations").rows[0].n;
  assert.equal(after, before);
});

// --------------------------------------------------------------- release()

test("release(id, {neverCalled:true}) sets never_called=1 and stops counting toward the ceiling", () => {
  const { core } = freshCore();
  const r1 = core.reserve("free", "k1", { ceiling: 2 });
  const r2 = core.reserve("free", "k2", { ceiling: 2 });
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  // Ceiling is now full (2/2) -- a third reserve is denied.
  assert.equal(core.reserve("free", "k3", { ceiling: 2 }).ok, false);

  const released = core.release(r1.id, { neverCalled: true });
  assert.deepEqual(released, { ok: true, id: r1.id, state: "released", neverCalled: true, providerFailed: false, allowanceRefunded: false });
  assert.equal(core.getReservation(r1.id).never_called, 1);

  // r1's slot is now free -- a new reserve succeeds again under the same ceiling.
  const r4 = core.reserve("free", "k4", { ceiling: 2 });
  assert.equal(r4.ok, true, "neverCalled release must free a ceiling slot");
});

test("release(id, {}) (plain) and release(id, {providerFailed:true}) both still count toward the ceiling -- only neverCalled exempts", () => {
  const { core } = freshCore();
  const r1 = core.reserve("free", "k1", { ceiling: 2 });
  const r2 = core.reserve("free", "k2", { ceiling: 2 });

  core.release(r1.id, {}); // plain release
  core.release(r2.id, { providerFailed: true }); // providerFailed, no neverCalled

  // Ceiling should still read as full: neither release freed a slot.
  const denied = core.reserve("free", "k3", { ceiling: 2 });
  assert.equal(denied.ok, false, "plain and providerFailed releases must both still count as spent");
});

test("release() on an unknown id returns an error result, never throws", () => {
  const { core } = freshCore();
  const result = core.release("not-a-real-id", {});
  assert.equal(result.ok, false);
  assert.equal(result.error, "not_found");
});

// Story 7-2 review findings: commit()/release() must degrade gracefully
// (return {ok:false, error:"not_found"}), never throw, for any id that
// isn't a well-formed string -- undefined, null, a number, an object, an
// array. This matters concretely because a denied reserve()'s result has
// no `id` field at all: a caller that does `commit(reserveResult.id)`
// without first checking `.ok` passes `undefined` straight through.
test("commit()/release() degrade gracefully (not_found, never throw) for a malformed id", () => {
  const { core } = freshCore();
  const badIds = [undefined, null, 42, {}, [], true, ""];
  for (const badId of badIds) {
    assert.doesNotThrow(() => {
      const commitResult = core.commit(badId);
      assert.equal(commitResult.ok, false, `commit(${JSON.stringify(badId)}) must report ok:false`);
      assert.equal(commitResult.error, "not_found");
    }, `commit(${JSON.stringify(badId)}) must not throw`);
    assert.doesNotThrow(() => {
      const releaseResult = core.release(badId, {});
      assert.equal(releaseResult.ok, false, `release(${JSON.stringify(badId)}) must report ok:false`);
      assert.equal(releaseResult.error, "not_found");
    }, `release(${JSON.stringify(badId)}) must not throw`);
  }
});

// Story 7-2 review finding: `release(id, null)` (a realistic call shape --
// e.g. `release(id, failed ? {providerFailed:true} : null)`) must degrade
// to a plain release (as if `{}` had been passed), not throw on
// `null.neverCalled`.
test("release(id, null) behaves like release(id, {}) -- a plain release, never throws", () => {
  const { core } = freshCore();
  const { id } = core.reserve("free", "k1", { ceiling: 5 });
  assert.doesNotThrow(() => {
    const result = core.release(id, null);
    assert.equal(result.ok, true);
    assert.equal(result.state, "released");
    assert.equal(result.neverCalled, false);
    assert.equal(result.providerFailed, false);
  });
});

// Story 7-2 review finding (Verification Gap): the "even if a caller
// mistakenly calls release twice on the same id" idempotency claim in this
// file's own header comment was previously only exercised via a DIFFERENT
// id (the refund-uniqueness test below) or via a state reached through
// sweep()/commit(), never via two real release() calls on the SAME id.
// This proves that path directly, for the providerFailed+refund case
// specifically -- the one where double-counting would be most consequential.
test("calling release(id, {providerFailed:true}) a second time on the SAME id is a no-op -- no double refund", () => {
  const { core } = freshCore();
  const key = "device-same-id";
  const r1 = core.reserve("free", key, { ceiling: 10 });
  const allowanceDay = core.getReservation(r1.id).allowance_day;

  const first = core.release(r1.id, { providerFailed: true });
  assert.equal(first.allowanceRefunded, true);
  assert.equal(core.effectiveAllowanceUsage(key, allowanceDay), 0);

  const second = core.release(r1.id, { providerFailed: true });
  assert.equal(second.ok, true);
  assert.equal(second.idempotent, true);
  assert.equal(second.state, "released");
  // Usage must not go negative or otherwise change from a second call on
  // an already-released id.
  assert.equal(core.effectiveAllowanceUsage(key, allowanceDay), 0);
});

test("commit()/release() on an already-expired row are idempotent no-ops -- do not un-expire or double-count", () => {
  const { core, clock } = freshCore(0);
  const r1 = core.reserve("free", "k1", { ceiling: 1 });
  clock.advance(EXPIRY_MS); // exactly 60s later
  const expired = core.sweepExpired(clock.now());
  assert.deepEqual(expired, [r1.id]);
  assert.equal(core.getReservation(r1.id).state, "expired");

  const commitResult = core.commit(r1.id);
  assert.equal(commitResult.ok, true);
  assert.equal(commitResult.state, "expired");
  assert.equal(commitResult.idempotent, true);
  assert.equal(core.getReservation(r1.id).state, "expired", "commit() must not un-expire the row");

  const releaseResult = core.release(r1.id, { providerFailed: true });
  assert.equal(releaseResult.ok, true);
  assert.equal(releaseResult.state, "expired");
  assert.equal(releaseResult.idempotent, true);
  assert.equal(core.getReservation(r1.id).state, "expired", "release() must not un-expire the row, or retroactively set provider_failed");

  // And the expired row must only ever count once toward the ceiling,
  // regardless of how many extra commit()/release() calls land on it.
  const r2 = core.reserve("free", "k2", { ceiling: 1 });
  assert.equal(r2.ok, false, "the expired row must still be the sole thing counted against ceiling:1");
});

test("commit() on an already-committed-then-released-attempt does not transition away from committed", () => {
  const { core } = freshCore();
  const { id } = core.reserve("free", "k1", { ceiling: 5 });
  core.commit(id);
  const releaseAfterCommit = core.release(id, { neverCalled: true });
  assert.equal(releaseAfterCommit.ok, true);
  assert.equal(releaseAfterCommit.state, "committed");
  assert.equal(releaseAfterCommit.idempotent, true);
  assert.equal(core.getReservation(id).state, "committed", "release() must never move a committed row to released");
});

// --------------------------------------------- providerFailed allowance refund

test("release(id, {providerFailed:true}) refunds the key's allowance-day usage by 1, once", () => {
  const { core } = freshCore();
  const key = "device-abc";
  const r1 = core.reserve("free", key, { ceiling: 10 });
  const allowanceDay = core.getReservation(r1.id).allowance_day;

  assert.equal(core.effectiveAllowanceUsage(key, allowanceDay), 1, "a reserved row counts as usage before any release");

  const released = core.release(r1.id, { providerFailed: true });
  assert.equal(released.allowanceRefunded, true);
  assert.equal(core.getReservation(r1.id).allowance_refunded, 1);

  // Still counts toward the ceiling (spent), but the key's own allowance
  // usage is refunded back to 0 -- these are two independent counters.
  assert.equal(core.effectiveAllowanceUsage(key, allowanceDay), 0);
});

test("a second providerFailed release for the same (key, allowance_day) does NOT grant a second refund", () => {
  const { core } = freshCore();
  const key = "device-abc";
  const r1 = core.reserve("free", key, { ceiling: 10 });
  const r2 = core.reserve("free", key, { ceiling: 10 });
  const allowanceDay = core.getReservation(r1.id).allowance_day;

  const first = core.release(r1.id, { providerFailed: true });
  assert.equal(first.allowanceRefunded, true);

  const second = core.release(r2.id, { providerFailed: true });
  assert.equal(second.allowanceRefunded, false, "the second providerFailed release for the same key/day must not grant a second refund");
  assert.equal(core.getReservation(r2.id).allowance_refunded, 0);

  // Both r1 and r2 count as spent (released, not neverCalled) = 2; minus
  // exactly one refund = 1, clamped at 0 if it ever went further.
  assert.equal(core.effectiveAllowanceUsage(key, allowanceDay), 1);
});

test("effectiveAllowanceUsage excludes neverCalled rows entirely (they never counted as usage)", () => {
  const { core } = freshCore();
  const key = "device-xyz";
  const r1 = core.reserve("free", key, { ceiling: 10 });
  const allowanceDay = core.getReservation(r1.id).allowance_day;
  core.release(r1.id, { neverCalled: true });
  assert.equal(core.effectiveAllowanceUsage(key, allowanceDay), 0);
});

// Story 7-2 review finding (found independently by all three review
// lenses): `release(id, {neverCalled:true, providerFailed:true})` -- both
// flags together, a malformed/inconsistent call no real caller should make
// but nothing type-level prevents -- must NOT grant an allowance refund.
// A neverCalled row already never counted as usage (see the test above);
// letting it ALSO burn the one-refund-per-key-per-allowance-day slot would
// silently steal that refund from a later, genuinely-failed reservation on
// the same key/day, and this exact scenario is also the only way
// `effectiveAllowanceUsage`'s `Math.max(0, spentCount - refunded)` clamp
// could ever see a negative raw value -- so this test doubles as the
// missing "clamp actually fires" proof (Verification Gap review finding).
test("release(id, {neverCalled:true, providerFailed:true}) together does NOT grant a refund, and does not corrupt other usage", () => {
  const { core } = freshCore();
  const key = "device-both-flags";

  // Three ordinary, fully-committed reservations -- real usage of 3.
  for (let i = 0; i < 3; i++) {
    const r = core.reserve("free", key, { ceiling: 10 });
    core.commit(r.id);
  }
  const allowanceDay = core.getReservation(core.reserve("free", key, { ceiling: 10 }).id).allowance_day;
  assert.equal(core.effectiveAllowanceUsage(key, allowanceDay), 4, "sanity: 3 committed + 1 fresh reserved = 4");

  // A 5th reservation, released with BOTH flags together.
  const r5 = core.reserve("free", key, { ceiling: 10 });
  const releaseResult = core.release(r5.id, { neverCalled: true, providerFailed: true });
  assert.equal(releaseResult.allowanceRefunded, false, "neverCalled must suppress the providerFailed refund");
  assert.equal(core.getReservation(r5.id).allowance_refunded, 0);

  // Usage must be exactly what it was before this release -- r5 never
  // counted (neverCalled), and nothing else was refunded away.
  assert.equal(core.effectiveAllowanceUsage(key, allowanceDay), 4, "the neverCalled+providerFailed release must not change usage at all");

  // And the refund slot is still available for a REAL providerFailed
  // release afterward.
  const r6 = core.reserve("free", key, { ceiling: 10 });
  const realFailure = core.release(r6.id, { providerFailed: true });
  assert.equal(realFailure.allowanceRefunded, true, "a genuine providerFailed release must still get the refund slot the malformed combo did not consume");
});

// Story 7-3 review finding (found independently by two lenses): release()'s
// own refund-uniqueness check was NOT scoped to kind IN ('free','sub'),
// unlike effectiveAllowanceUsage()'s equivalent queries. A restore/mint
// reservation sharing a key+allowance_day with a free/sub one could
// consume (or be mistaken for already consuming) that key's one refund
// slot, silently denying a genuinely-failed free reservation its earned
// refund. Unreachable today given the real key-spaces in use, but this
// proves the fix directly by forcing a same-key collision.
test("a providerFailed release on a restore/mint reservation never blocks a LATER free/sub reservation's own refund on a shared key", () => {
  const { core } = freshCore();
  const key = "shared-key-collision";

  // A restore reservation on this exact key, released with providerFailed
  // -- before the fix, this unscoped-query path could have set
  // allowance_refunded=1 on this row and then been mistaken, by a LATER
  // free/sub release's own uniqueness check, for "this key/day already
  // used its refund."
  const restoreR = core.reserve("restore", key, { minGapSec: 0 });
  const allowanceDay = core.getReservation(restoreR.id).allowance_day;
  core.release(restoreR.id, { providerFailed: true });

  // A genuine free reservation on the SAME key, later released with a real
  // providerFailed -- must still get its own refund; the restore row must
  // be invisible to this check regardless of its own flag.
  const freeR = core.reserve("free", key, { ceiling: 10 });
  assert.equal(core.getReservation(freeR.id).allowance_day, allowanceDay, "sanity: same allowance day");
  const freeRelease = core.release(freeR.id, { providerFailed: true });
  assert.equal(freeRelease.allowanceRefunded, true, "the free reservation's own providerFailed refund must not be blocked by an unrelated restore reservation sharing its key");
});

// ------------------------------------------------------------- two clocks

test("a reservation made at 23:59:50 UTC and committed at 00:00:05 UTC the next day stays in its original UTC budget day", () => {
  const t0 = Date.UTC(2026, 0, 1, 23, 59, 50); // 2026-01-01T23:59:50Z
  const t1 = Date.UTC(2026, 0, 2, 0, 0, 5); // 2026-01-02T00:00:05Z
  const { core, clock } = freshCore(t0);

  const { id } = core.reserve("free", "k1", { ceiling: 1 });
  assert.equal(core.getReservation(id).budget_day, "2026-01-01");

  clock.set(t1);
  core.commit(id);
  assert.equal(core.getReservation(id).budget_day, "2026-01-01", "commit() must never recompute budget_day from today's clock");
  assert.equal(core.getReservation(id).state, "committed");

  // And the NEW UTC day's ceiling is entirely independent: a fresh
  // reserve() at t1 is granted even though the ceiling is already "full"
  // for 2026-01-01 (ceiling:1, already 1 committed that day).
  const r2 = core.reserve("free", "k2", { ceiling: 1 });
  assert.equal(r2.ok, true, "budget days must not leak spend across the UTC boundary");
  assert.equal(core.getReservation(r2.id).budget_day, "2026-01-02");
});

// Independent reference formatter -- deliberately re-constructed here
// rather than imported from governor-core.js, so this test would actually
// fail if that module's implementation ever drifted to a naive UTC+2/+3
// offset calculation instead of a real Intl/tz-database lookup.
const REFERENCE_BUCHAREST_FORMATTER = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Bucharest" });
function referenceAllowanceDay(ms) {
  return REFERENCE_BUCHAREST_FORMATTER.format(new Date(ms));
}

test("DST spring-forward (Europe/Bucharest, 2026-03-29 01:00 UTC): allowance_day stays a well-formed single date through the transition", () => {
  const { core, clock } = freshCore();
  const TRANSITION = Date.UTC(2026, 2, 29, 1, 0, 0); // confirmed via direct Intl offset scan, not hardcoded from memory
  const instants = [TRANSITION - 1000, TRANSITION, TRANSITION + 1000];
  for (const t of instants) {
    clock.set(t);
    const r = core.reserve("free", `spring-${t}`, { ceiling: 1000 });
    const row = core.getReservation(r.id);
    assert.match(row.allowance_day, /^\d{4}-\d{2}-\d{2}$/, `allowance_day must be a well-formed date at ${new Date(t).toISOString()}`);
    assert.equal(row.allowance_day, referenceAllowanceDay(t));
  }
});

test("DST fall-back (Europe/Bucharest, 2026-10-25 01:00 UTC): allowance_day stays a well-formed single date through the transition", () => {
  const { core, clock } = freshCore();
  const TRANSITION = Date.UTC(2026, 9, 25, 1, 0, 0); // confirmed via direct Intl offset scan, not hardcoded from memory
  const instants = [TRANSITION - 1000, TRANSITION, TRANSITION + 1000];
  for (const t of instants) {
    clock.set(t);
    const r = core.reserve("free", `fall-${t}`, { ceiling: 1000 });
    const row = core.getReservation(r.id);
    assert.match(row.allowance_day, /^\d{4}-\d{2}-\d{2}$/, `allowance_day must be a well-formed date at ${new Date(t).toISOString()}`);
    assert.equal(row.allowance_day, referenceAllowanceDay(t));
  }
});

test("DST spring-forward: the local Bucharest calendar date still advances exactly once across the short (23h) local day", () => {
  const { core, clock } = freshCore();
  // Local midnight boundaries around 2026-03-29 (the short day), confirmed
  // via the same direct Intl offset scan as the transition instant above:
  // GMT+2 immediately before the transition, GMT+3 immediately after.
  const justBeforeMar29 = Date.UTC(2026, 2, 28, 21, 59, 59); // 23:59:59 local (GMT+2) on Mar 28
  const startOfMar29 = Date.UTC(2026, 2, 28, 22, 0, 0); // 00:00:00 local (GMT+2) on Mar 29
  const justBeforeMar30 = Date.UTC(2026, 2, 29, 20, 59, 59); // 23:59:59 local (GMT+3) on Mar 29
  const startOfMar30 = Date.UTC(2026, 2, 29, 21, 0, 0); // 00:00:00 local (GMT+3) on Mar 30

  const dayOf = (ms) => referenceAllowanceDay(ms);
  assert.equal(dayOf(justBeforeMar29), "2026-03-28");
  assert.equal(dayOf(startOfMar29), "2026-03-29");
  assert.equal(dayOf(justBeforeMar30), "2026-03-29");
  assert.equal(dayOf(startOfMar30), "2026-03-30");

  for (const t of [justBeforeMar29, startOfMar29, justBeforeMar30, startOfMar30]) {
    clock.set(t);
    const r = core.reserve("free", `boundary-${t}`, { ceiling: 1000 });
    assert.equal(core.getReservation(r.id).allowance_day, dayOf(t));
  }
});

test("DST fall-back: the local Bucharest calendar date still advances exactly once across the long (25h) local day", () => {
  const { core, clock } = freshCore();
  const justBeforeOct25 = Date.UTC(2026, 9, 24, 20, 59, 59); // 23:59:59 local (GMT+3) on Oct 24
  const startOfOct25 = Date.UTC(2026, 9, 24, 21, 0, 0); // 00:00:00 local (GMT+3) on Oct 25
  const justBeforeOct26 = Date.UTC(2026, 9, 25, 21, 59, 59); // 23:59:59 local (GMT+2) on Oct 25
  const startOfOct26 = Date.UTC(2026, 9, 25, 22, 0, 0); // 00:00:00 local (GMT+2) on Oct 26

  const dayOf = (ms) => referenceAllowanceDay(ms);
  assert.equal(dayOf(justBeforeOct25), "2026-10-24");
  assert.equal(dayOf(startOfOct25), "2026-10-25");
  assert.equal(dayOf(justBeforeOct26), "2026-10-25");
  assert.equal(dayOf(startOfOct26), "2026-10-26");

  for (const t of [justBeforeOct25, startOfOct25, justBeforeOct26, startOfOct26]) {
    clock.set(t);
    const r = core.reserve("free", `boundary-${t}`, { ceiling: 1000 });
    assert.equal(core.getReservation(r.id).allowance_day, dayOf(t));
  }
});

// ----------------------------------------------------------- sweep/alarm

test("sweepExpired() expires a 60s-untouched reserved row and leaves a younger one alone; sweep() re-arms for the next-soonest expiry", () => {
  const t0 = 1_000_000_000_000;
  const { core, clock } = freshCore(t0);

  const r1 = core.reserve("free", "k1", { ceiling: 10 }); // reserved at t0
  clock.advance(10_000);
  const r2 = core.reserve("free", "k2", { ceiling: 10 }); // reserved at t0+10s

  clock.set(t0 + EXPIRY_MS); // exactly 60s after r1, 50s after r2
  const result = core.sweep(clock.now());

  assert.deepEqual(result.expiredIds, [r1.id]);
  assert.equal(core.getReservation(r1.id).state, "expired");
  assert.equal(core.getReservation(r2.id).state, "reserved", "a reservation younger than 60s must not be expired yet");
  assert.equal(result.nextAlarmAt, t0 + 10_000 + EXPIRY_MS, "next alarm must be armed for r2's own expiry, the next-soonest one");
});

test("sweep() falls back to the 2-day prune horizon when nothing is currently reserved", () => {
  const t0 = 2_000_000_000_000;
  const { core, clock } = freshCore(t0);
  const r1 = core.reserve("free", "k1", { ceiling: 10 });
  core.commit(r1.id); // settled -- no longer 'reserved', so no expiry is pending

  clock.set(t0 + 1000);
  const result = core.sweep(clock.now());
  assert.deepEqual(result.expiredIds, []);
  assert.equal(result.nextAlarmAt, t0 + PRUNE_AGE_MS, "with nothing reserved, the alarm should re-arm for the row's own 2-day prune horizon");
});

test("sweep() returns null nextAlarmAt when the table holds no rows at all", () => {
  const { core, clock } = freshCore();
  const result = core.sweep(clock.now());
  assert.deepEqual(result, { expiredIds: [], prunedCount: 0, nextAlarmAt: null });
});

test("pruneOld() deletes rows older than 2 days and leaves newer rows alone", () => {
  const t0 = 3_000_000_000_000;
  const { core, clock } = freshCore(t0);
  const oldOne = core.reserve("free", "old", { ceiling: 10 });
  clock.advance(60_000);
  const newerOne = core.reserve("free", "newer", { ceiling: 10 });

  // Well under 2 days old yet -- nothing pruned.
  clock.set(t0 + 60_000 + 60_000);
  assert.equal(core.pruneOld(clock.now()), 0);
  assert.ok(core.getReservation(oldOne.id));
  assert.ok(core.getReservation(newerOne.id));

  // Just past 2 days old for the old row (reserved at t0); the newer row
  // (reserved 60s later) is still just under 2 days old at this instant --
  // this is the case that actually distinguishes "prune by each row's own
  // age" from "prune everything once anything crosses 2 days".
  clock.set(t0 + PRUNE_AGE_MS + 1000);
  const deleted = core.pruneOld(clock.now());
  assert.equal(deleted, 1);
  assert.equal(core.getReservation(oldOne.id), null);
  assert.ok(core.getReservation(newerOne.id), "a row not yet 2 days old must survive the same prune pass");

  // And eventually the newer one ages out too.
  clock.advance(60_000);
  assert.equal(core.pruneOld(clock.now()), 1);
  assert.equal(core.getReservation(newerOne.id), null);
});

// --------------------------------------------------------------- schema

// --------------------------------------------------------- Story 7-3 fairness
//
// Every test below is scoped from spec-7-3-free-vs-subscriber-fairness.md's
// frozen I/O & Edge-Case Matrix and Design Notes. Each isolated-rule test
// sets up cfg/clock so every OTHER rule's own condition is already
// satisfied (a generous ceiling, a freeDaily/subscriberDaily/freeGlobalGapSec
// value the scenario clears via clock advancement, etc.) so only the rule
// under test can possibly deny -- per the story's own instructions.

test("reserve('free', ...) denies wait via minGapSec when the same key reserves again too soon, writes zero rows, then succeeds once the gap elapses", () => {
  const { core, clock, adapter } = freshCore(Date.UTC(2026, 0, 1, 12, 0, 0));
  const cfg = { ceiling: 1000, reserveShare: 0.9, freeSlices: 1, minGapSec: 30, freeGlobalGapSec: 1, freeDaily: 1000 };
  const r1 = core.reserve("free", "device-1", cfg);
  assert.equal(r1.ok, true);

  clock.advance(3000); // past freeGlobalGapSec(1s), well under minGapSec(30s) -- isolates this check
  const before = adapter.exec("SELECT COUNT(*) AS n FROM reservations").rows[0].n;
  const denied = core.reserve("free", "device-1", cfg);
  assert.equal(denied.ok, false);
  assert.equal(denied.denied, "wait");
  assert.equal(denied.retryAfterSeconds, 27);
  const after = adapter.exec("SELECT COUNT(*) AS n FROM reservations").rows[0].n;
  assert.equal(after, before, "a denied reserve() must write zero rows");

  clock.advance(27_000); // now 30s total since r1
  const granted = core.reserve("free", "device-1", cfg);
  assert.equal(granted.ok, true, "once minGapSec has elapsed, the same key may reserve again");
});

// Story 7-3 review finding (Verification Gap): minGapSec was previously
// only ever exercised at 30 -- proving the denial boundary actually tracks
// cfg.minGapSec, not a hardcoded 30, at a different value (90).
test("minGapSec's threshold tracks cfg, not a hardcoded value -- proven at 90s instead of 30s", () => {
  const { core, clock } = freshCore(Date.UTC(2026, 0, 1, 12, 0, 0));
  const cfg = { ceiling: 1000, reserveShare: 0.9, freeSlices: 1, minGapSec: 90, freeGlobalGapSec: 1, freeDaily: 1000 };
  const r1 = core.reserve("free", "device-1", cfg);
  assert.equal(r1.ok, true);

  clock.advance(60_000); // past the OLD 30s threshold, still under the configured 90s
  const stillDenied = core.reserve("free", "device-1", cfg);
  assert.equal(stillDenied.ok, false);
  assert.equal(stillDenied.denied, "wait");
  assert.equal(stillDenied.retryAfterSeconds, 30);

  clock.advance(30_000); // now 90s total
  const granted = core.reserve("free", "device-1", cfg);
  assert.equal(granted.ok, true, "the threshold must be 90s (from cfg), not a hardcoded 30s");
});

test("reserve('sub', ...) denies wait via minGapSec when the same subscription key reserves again too soon", () => {
  const { core, clock } = freshCore();
  const cfg = { ceiling: 1000, minGapSec: 30, subscriberDaily: 1000 };
  const r1 = core.reserve("sub", "sub-abc", cfg);
  assert.equal(r1.ok, true);

  clock.advance(5000);
  const denied = core.reserve("sub", "sub-abc", cfg);
  assert.equal(denied.ok, false);
  assert.equal(denied.denied, "wait");
  assert.equal(denied.retryAfterSeconds, 25);
});

test("reserve('restore', ...) is gated only by minGapSec -- ceiling/daily-allowance/free-share never apply even when they'd otherwise deny everything", () => {
  const { core, clock, adapter } = freshCore();
  const cfg = { minGapSec: 30, ceiling: 0, freeDaily: 0, subscriberDaily: 0, reserveShare: 0.5, freeSlices: 6 };
  const r1 = core.reserve("restore", "device-1", cfg);
  assert.equal(r1.ok, true, "restore must be granted even though ceiling is already 0 (fully 'spent')");

  const before = adapter.exec("SELECT COUNT(*) AS n FROM reservations").rows[0].n;
  const denied = core.reserve("restore", "device-1", cfg);
  assert.equal(denied.ok, false);
  assert.equal(denied.denied, "wait");
  const after = adapter.exec("SELECT COUNT(*) AS n FROM reservations").rows[0].n;
  assert.equal(after, before, "a denied reserve() must write zero rows");

  clock.advance(30_000);
  const r2 = core.reserve("restore", "device-1", cfg);
  assert.equal(r2.ok, true, "once the gap has elapsed, restore is granted again -- still ignoring ceiling:0");
});

test("reserve('free', ...) denies wait via freeGlobalGapSec when a DIFFERENT key grants too soon after another key's free grant", () => {
  const { core, clock, adapter } = freshCore();
  const cfg = { ceiling: 1000, reserveShare: 0.9, freeSlices: 1, minGapSec: 30, freeGlobalGapSec: 20, freeDaily: 1000 };
  const r1 = core.reserve("free", "device-A", cfg);
  assert.equal(r1.ok, true);

  // device-B has never reserved before, so its OWN minGapSec is trivially
  // satisfied (no prior row for that key) -- only freeGlobalGapSec, which
  // looks at the most recent free grant from ANY key, can deny this call.
  clock.advance(5000);
  const before = adapter.exec("SELECT COUNT(*) AS n FROM reservations").rows[0].n;
  const denied = core.reserve("free", "device-B", cfg);
  assert.equal(denied.ok, false);
  assert.equal(denied.denied, "wait");
  assert.equal(denied.retryAfterSeconds, 15);
  const after = adapter.exec("SELECT COUNT(*) AS n FROM reservations").rows[0].n;
  assert.equal(after, before, "a denied reserve() must write zero rows");

  clock.advance(15_000); // now 20s since device-A's grant
  const granted = core.reserve("free", "device-B", cfg);
  assert.equal(granted.ok, true);
});

// Story 7-3 review finding (Verification Gap): freeGlobalGapSec was
// previously only ever exercised at 20 -- proven here at 50 instead.
test("freeGlobalGapSec's threshold tracks cfg, not a hardcoded value -- proven at 50s instead of 20s", () => {
  const { core, clock } = freshCore();
  const cfg = { ceiling: 1000, reserveShare: 0.9, freeSlices: 1, minGapSec: 30, freeGlobalGapSec: 50, freeDaily: 1000 };
  const r1 = core.reserve("free", "device-A", cfg);
  assert.equal(r1.ok, true);

  clock.advance(30_000); // past the OLD 20s threshold, still under the configured 50s
  const stillDenied = core.reserve("free", "device-B", cfg);
  assert.equal(stillDenied.ok, false);
  assert.equal(stillDenied.denied, "wait");
  assert.equal(stillDenied.retryAfterSeconds, 20);

  clock.advance(20_000); // now 50s total
  const granted = core.reserve("free", "device-B", cfg);
  assert.equal(granted.ok, true, "the threshold must be 50s (from cfg), not a hardcoded 20s");
});

test("reserve('free', ...) denies daily_limit once this key's freeDaily allowance is reached (minGapSec/freeGlobalGapSec already satisfied)", () => {
  const { core, clock, adapter } = freshCore();
  const cfg = { ceiling: 1000, reserveShare: 0.9, freeSlices: 1, minGapSec: 5, freeGlobalGapSec: 5, freeDaily: 1 };
  const r1 = core.reserve("free", "device-1", cfg);
  assert.equal(r1.ok, true);

  clock.advance(60_000); // comfortably clears both minGapSec and freeGlobalGapSec
  const before = adapter.exec("SELECT COUNT(*) AS n FROM reservations").rows[0].n;
  const denied = core.reserve("free", "device-1", cfg);
  assert.equal(denied.ok, false);
  assert.equal(denied.denied, "daily_limit");
  const after = adapter.exec("SELECT COUNT(*) AS n FROM reservations").rows[0].n;
  assert.equal(after, before, "a denied reserve() must write zero rows");
});

// Story 7-3 review finding (Verification Gap): freeDaily was previously
// only ever exercised at 1 -- proven here at 3, confirming the THIRD
// reservation (not the first or second) is what gets denied.
test("freeDaily's threshold tracks cfg, not a hardcoded value -- proven at 3 instead of 1", () => {
  const { core, clock } = freshCore();
  const cfg = { ceiling: 1000, reserveShare: 0.9, freeSlices: 1, minGapSec: 5, freeGlobalGapSec: 5, freeDaily: 3 };
  const key = "device-daily-3";
  for (let i = 0; i < 3; i++) {
    clock.advance(60_000);
    const r = core.reserve("free", key, cfg);
    assert.equal(r.ok, true, `reservation ${i + 1} of 3 must be granted under freeDaily:3`);
  }
  clock.advance(60_000);
  const denied = core.reserve("free", key, cfg);
  assert.equal(denied.ok, false);
  assert.equal(denied.denied, "daily_limit", "the 4th reservation, not the 2nd, must be what's denied when freeDaily is 3");
});

test("reserve('sub', ...) denies daily_limit once this key's subscriberDaily allowance is reached (minGapSec already satisfied)", () => {
  const { core, clock, adapter } = freshCore();
  const cfg = { ceiling: 1000, minGapSec: 5, subscriberDaily: 1 };
  const r1 = core.reserve("sub", "sub-xyz", cfg);
  assert.equal(r1.ok, true);

  clock.advance(60_000);
  const before = adapter.exec("SELECT COUNT(*) AS n FROM reservations").rows[0].n;
  const denied = core.reserve("sub", "sub-xyz", cfg);
  assert.equal(denied.ok, false);
  assert.equal(denied.denied, "daily_limit");
  const after = adapter.exec("SELECT COUNT(*) AS n FROM reservations").rows[0].n;
  assert.equal(after, before, "a denied reserve() must write zero rows");
});

// Story 7-3 review finding (Verification Gap): subscriberDaily was
// previously only ever exercised at 1 -- proven here at 4.
test("subscriberDaily's threshold tracks cfg, not a hardcoded value -- proven at 4 instead of 1", () => {
  const { core, clock } = freshCore();
  const cfg = { ceiling: 1000, minGapSec: 5, subscriberDaily: 4 };
  const key = "sub-daily-4";
  for (let i = 0; i < 4; i++) {
    clock.advance(60_000);
    const r = core.reserve("sub", key, cfg);
    assert.equal(r.ok, true, `reservation ${i + 1} of 4 must be granted under subscriberDaily:4`);
  }
  clock.advance(60_000);
  const denied = core.reserve("sub", key, cfg);
  assert.equal(denied.ok, false);
  assert.equal(denied.denied, "daily_limit", "the 5th reservation must be what's denied when subscriberDaily is 4");
});

test("the free-share time-slice cap denies resting once the CURRENT slice's cumulative cap is reached, and the cap grows (carries forward) later in the day", () => {
  const t0 = Date.UTC(2026, 0, 1, 0, 0, 0); // exact start of the UTC day
  const { core, clock, adapter } = freshCore(t0);
  // ceiling:120, reserveShare:0.5 -> freeShare:60; freeSlices:6 -> 4h
  // slices, sliceLengthMs = 14_400_000. At t0 (slice 0): cap = floor(60*1/6) = 10.
  const cfg = { ceiling: 120, reserveShare: 0.5, freeSlices: 6 };

  for (let i = 0; i < 10; i++) {
    const r = core.reserve("free", `burst-${i}`, cfg);
    assert.equal(r.ok, true, `burst-${i} should be granted under slice 0's cap of 10`);
  }
  const before = adapter.exec("SELECT COUNT(*) AS n FROM reservations").rows[0].n;
  const denied = core.reserve("free", "burst-10", cfg);
  assert.equal(denied.ok, false);
  assert.equal(denied.denied, "resting", "slice 0's cumulative cap (10) is reached even though the full-day free share (60) is not exhausted");
  const after = adapter.exec("SELECT COUNT(*) AS n FROM reservations").rows[0].n;
  assert.equal(after, before, "a denied reserve() must write zero rows");

  // Advance to the START of slice 5 (the final slice), still the same UTC
  // calendar day: 5 * 14_400_000 = 72_000_000ms (20h) into the day. The
  // cumulative cap is now floor(60*6/6) = 60 -- fully carried forward, not
  // reset -- so free usage can grow well past slice 0's own cap of 10.
  clock.set(t0 + 5 * 14_400_000);
  for (let i = 0; i < 50; i++) {
    const r = core.reserve("free", `later-${i}`, cfg);
    assert.equal(r.ok, true, `later-${i} should be granted -- the cumulative cap has grown to 60`);
  }
  const deniedAtFullShare = core.reserve("free", "later-50", cfg);
  assert.equal(deniedAtFullShare.ok, false);
  assert.equal(deniedAtFullShare.denied, "resting", "usage (60) has now reached the full free share (60)");
});

// Story 7-3 review finding (Edge Case Hunter, confirmed by Blind Hunter):
// a non-integer freeSlices previously let the cumulative cap exceed
// freeShare -- e.g. freeSlices:2.5 let the late-day cap reach 60 against
// an intended freeShare of 50, a real ~20% overshoot with no error.
// freeShareCap now floors freeSlices to an integer slice count and clamps
// currentSlice to slices-1; this proves the cap never exceeds freeShare
// for a fractional freeSlices value, at the latest instant of the day
// (where the overshoot was largest).
test("a non-integer freeSlices never lets the cumulative cap exceed freeShare, even at the very end of the day", () => {
  const t0 = Date.UTC(2026, 0, 1, 0, 0, 0);
  const { core, clock } = freshCore(t0);
  // ceiling:100, reserveShare:0.5 -> freeShare:50; freeSlices:2.5 (floors
  // to 2 slices of 12h each).
  const cfg = { ceiling: 100, reserveShare: 0.5, freeSlices: 2.5 };

  clock.set(t0 + 24 * 60 * 60 * 1000 - 1); // the very last millisecond of the UTC day
  for (let i = 0; i < 50; i++) {
    assert.equal(core.reserve("free", `late-${i}`, cfg).ok, true, `late-${i} should be granted under freeShare (50)`);
  }
  const denied = core.reserve("free", "late-50", cfg);
  assert.equal(denied.ok, false);
  assert.equal(denied.denied, "resting", "the cap must never exceed freeShare (50), even with a fractional freeSlices");
});

// Story 7-3 review finding (Edge Case Hunter): an unclamped reserveShare
// above 1 would let freeShare exceed the ceiling itself, letting free
// traffic alone consume the whole ceiling and leave zero headroom for
// subscribers -- freeShareCap now clamps reserveShare to [0, 1].
test("a reserveShare above 1 is clamped -- free usage still cannot exceed the ceiling itself, leaving headroom for subscribers", () => {
  const { core } = freshCore(Date.UTC(2026, 0, 1, 0, 0, 0));
  // ceiling:10, reserveShare:1.5 (clamped to 1) -> freeShare capped at 10,
  // not 15.
  const cfg = { ceiling: 10, reserveShare: 1.5, freeSlices: 1 };
  for (let i = 0; i < 10; i++) {
    assert.equal(core.reserve("free", `over-${i}`, cfg).ok, true, `over-${i} should be granted under the clamped share (10)`);
  }
  const denied = core.reserve("free", "over-10", cfg);
  assert.equal(denied.ok, false);
  assert.equal(denied.denied, "resting", "an unclamped reserveShare:1.5 must not let free usage exceed the ceiling (10)");
});

test("epics.md matrix: ceiling:80 reserveShare:0.5, free usage at 40 -> free denied resting; a fresh sub key still succeeds, up to 80 total", () => {
  const { core } = freshCore(Date.UTC(2026, 0, 1, 0, 0, 0));
  const freeCfg = { ceiling: 80, reserveShare: 0.5, freeSlices: 1 }; // single slice -> cap = freeShare = 40 immediately
  for (let i = 0; i < 40; i++) {
    const r = core.reserve("free", `free-${i}`, freeCfg);
    assert.equal(r.ok, true, `free reservation ${i} should be granted under the 40-share`);
  }
  const deniedFree = core.reserve("free", "free-40", freeCfg);
  assert.equal(deniedFree.ok, false);
  assert.equal(deniedFree.denied, "resting");

  // Subscribers draw on the WHOLE ceiling -- unaffected by the free-share
  // slice cap -- up to the shared 80-wide ceiling (free + sub combined).
  const subCfg = { ceiling: 80, subscriberDaily: 1000 };
  for (let i = 0; i < 40; i++) {
    const r = core.reserve("sub", `sub-${i}`, subCfg);
    assert.equal(r.ok, true, `sub reservation ${i} should be granted -- up to 80 total`);
  }
  const deniedAtCeiling = core.reserve("sub", "sub-40", subCfg);
  assert.equal(deniedAtCeiling.ok, false);
  assert.equal(deniedAtCeiling.denied, "resting", "the shared ceiling (80) is now reached across free+sub combined");
});

test("reserve('sub', ...) is never gated by reserveShare/freeSlices/freeGlobalGapSec, even when those would already deny a free reservation", () => {
  const { core } = freshCore(Date.UTC(2026, 0, 1, 0, 0, 0));
  const cfg = { ceiling: 1000, reserveShare: 0.001, freeSlices: 1, freeGlobalGapSec: 3600, subscriberDaily: 1000 };
  // The tiny free share (floor(1000*0.001) = 1) is exhausted after one
  // grant -- confirmed here via the free-kind path itself (a second free
  // call, from a different key, is denied via freeGlobalGapSec first per
  // the documented precedence -- proven separately above -- but would
  // eventually hit the exhausted slice cap regardless; either way "free"
  // has no room left).
  const freeR = core.reserve("free", "device-1", cfg);
  assert.equal(freeR.ok, true);
  const freeDenied = core.reserve("free", "device-2", cfg);
  assert.equal(freeDenied.ok, false, "free has no room left under this cfg, whichever free-only rule reports it first");

  // Subs reserve back-to-back from distinct keys, unaffected by
  // freeGlobalGapSec (a free-only rule) or the free-share slice cap.
  const r1 = core.reserve("sub", "sub-A", cfg);
  const r2 = core.reserve("sub", "sub-B", cfg);
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true, "sub reservations are never gated by freeGlobalGapSec or the free-share slice cap");
});

test("reserve('mint', ...) under mintPerHour is granted and ignores ceiling/freeSlices/minGapSec/daily allowance entirely, using one fixed literal key", () => {
  const { core } = freshCore();
  const cfg = { mintPerHour: 5, ceiling: 0, minGapSec: 3600, freeDaily: 0, subscriberDaily: 0, reserveShare: 0.5, freeSlices: 6 };
  const r1 = core.reserve("mint", "whatever-the-caller-passes", cfg);
  assert.equal(r1.ok, true, "mint must be granted even though ceiling is 0 and minGapSec is huge");
  const r2 = core.reserve("mint", "ignored-again", cfg);
  assert.equal(r2.ok, true, "mint has no per-key minGapSec of its own");
  assert.equal(core.getReservation(r1.id).key, "mint", "every mint reservation shares one fixed literal key");
  assert.equal(core.getReservation(r2.id).key, "mint");
});

test("reserve('mint', ...) denies rate_limited past mintPerHour in the trailing hour, writes zero rows for the denied attempt, and recovers after the window rolls forward", () => {
  const { core, adapter, clock } = freshCore();
  const cfg = { mintPerHour: 3 };
  for (let i = 0; i < 3; i++) {
    assert.equal(core.reserve("mint", "x", cfg).ok, true);
  }
  const before = adapter.exec("SELECT COUNT(*) AS n FROM reservations").rows[0].n;
  const denied = core.reserve("mint", "x", cfg);
  assert.equal(denied.ok, false);
  assert.equal(denied.denied, "rate_limited");
  const after = adapter.exec("SELECT COUNT(*) AS n FROM reservations").rows[0].n;
  assert.equal(after, before, "a denied mint reserve() must write zero rows");

  clock.advance(60 * 60 * 1000 + 1000); // past the trailing-hour window
  assert.equal(core.reserve("mint", "x", cfg).ok, true, "minting is available again once the trailing hour rolls forward");
});

// Story 7-3 review finding (Verification Gap): mintPerHour was previously
// only ever exercised at 3 -- proven here at 7.
test("mintPerHour's threshold tracks cfg, not a hardcoded value -- proven at 7 instead of 3", () => {
  const { core } = freshCore();
  const cfg = { mintPerHour: 7 };
  for (let i = 0; i < 7; i++) {
    assert.equal(core.reserve("mint", "x", cfg).ok, true, `mint ${i + 1} of 7 must be granted under mintPerHour:7`);
  }
  const denied = core.reserve("mint", "x", cfg);
  assert.equal(denied.ok, false);
  assert.equal(denied.denied, "rate_limited", "the 8th mint, not the 4th, must be what's denied when mintPerHour is 7");
});

test("restore/mint reservations, even once committed, never count toward the image-spend ceiling or a key's own daily allowance", () => {
  const { core } = freshCore();
  // Story 7-3 review finding (Verification Gap): ceiling must have real
  // HEADROOM above the free-only spent count, not be already fully
  // exhausted by it -- otherwise the final sub-reservation assertion below
  // is denied either way (whether restore/mint incorrectly count or not),
  // and the test can't actually distinguish a correctly-scoped ceiling
  // predicate from a regressed, unscoped one. ceiling:4, 2 free grants ->
  // spent=2, headroom=2 remaining for a correctly-scoped core.
  const ceilingCfg = { ceiling: 4 };
  const f1 = core.reserve("free", "k1", ceilingCfg);
  const f2 = core.reserve("free", "k2", ceilingCfg);
  assert.equal(f1.ok, true);
  assert.equal(f2.ok, true);

  // A restore reservation sharing k1's OWN key, and a mint reservation --
  // both committed. If countSpentForBudgetDay's kind-scoping ever
  // regressed, these two commits alone would push spent from 2 to 4,
  // exhausting the ceiling with no room left for the sub-reservation below.
  const restoreR = core.reserve("restore", "k1", { minGapSec: 0 });
  const mintR = core.reserve("mint", "whatever", { mintPerHour: 100 });
  assert.equal(restoreR.ok, true);
  assert.equal(mintR.ok, true);
  core.commit(restoreR.id);
  core.commit(mintR.id);

  // A correctly-scoped core still has headroom (spent=2 < ceiling=4): this
  // sub reservation must SUCCEED. A regression that let restore/mint count
  // toward the ceiling would push spent to 4 and deny it -- so this
  // assertion genuinely discriminates between the two behaviors, unlike a
  // ceiling that was already fully exhausted before restore/mint existed.
  assert.equal(
    core.reserve("sub", "sub-1", { ceiling: 4, subscriberDaily: 10 }).ok,
    true,
    "restore/mint rows must never count toward the ceiling, even once committed -- there must still be headroom for a sub reservation"
  );

  // And the restore reservation sharing k1's key must not inflate k1's own
  // freeDaily allowance usage.
  const allowanceDay = core.getReservation(f1.id).allowance_day;
  assert.equal(
    core.effectiveAllowanceUsage("k1", allowanceDay),
    1,
    "k1's allowance usage must reflect only its free reservation, not the restore reservation sharing the same key"
  );
});

test("precedence: when minGapSec AND freeDaily would both deny the same free reservation, minGapSec (checked first) wins", () => {
  const { core, clock } = freshCore();
  const cfg = { ceiling: 1000, reserveShare: 0.9, freeSlices: 1, minGapSec: 30, freeGlobalGapSec: 1, freeDaily: 1 };
  const r1 = core.reserve("free", "device-1", cfg);
  assert.equal(r1.ok, true);

  // 5s later: freeGlobalGapSec(1s) is satisfied, minGapSec(30s) is NOT --
  // and freeDaily(1) is already exhausted by r1 too. Both minGapSec and
  // freeDaily would independently deny this call.
  clock.advance(5000);
  const denied = core.reserve("free", "device-1", cfg);
  assert.equal(denied.ok, false);
  assert.equal(denied.denied, "wait", "minGapSec is checked before freeDaily in the free-kind precedence order");
});

test("precedence: when freeDaily AND the overall ceiling would both deny the same free reservation, freeDaily (checked first) wins", () => {
  const { core, clock } = freshCore();
  // No reserveShare/freeSlices set -- the free-share slice check is skipped
  // (unconfigured), isolating this precedence test to freeDaily vs. ceiling.
  const cfg = { ceiling: 1, minGapSec: 5, freeGlobalGapSec: 5, freeDaily: 1 };
  const r1 = core.reserve("free", "device-1", cfg);
  assert.equal(r1.ok, true); // this single grant already fills both freeDaily(1) and ceiling(1)

  clock.advance(60_000); // clears minGapSec/freeGlobalGapSec
  const denied = core.reserve("free", "device-1", cfg);
  assert.equal(denied.ok, false);
  assert.equal(denied.denied, "daily_limit", "freeDaily is checked before the overall ceiling in the free-kind precedence order");
});

test("reserve() with an unrecognized kind fails closed (denied resting), writes zero rows", () => {
  const { core, adapter } = freshCore();
  const before = adapter.exec("SELECT COUNT(*) AS n FROM reservations").rows[0].n;
  const denied = core.reserve("bogus-kind", "device-1", { ceiling: 1000 });
  assert.deepEqual(denied, { ok: false, denied: "resting" });
  const after = adapter.exec("SELECT COUNT(*) AS n FROM reservations").rows[0].n;
  assert.equal(after, before);
});

// --------------------------------------------- Story 7-8: platform-quota self-throttle
//
// Directly manipulates `daily_ops`'s own row via the raw adapter (the same
// technique other tests in this file use to seed scenarios efficiently,
// e.g. the free-share-slice-cap tests above seed via real reserve() calls
// because THEIR cap is small and configurable; PLATFORM_ROW_CEILING (60000)
// is a fixed, non-configurable module constant, so driving it up via 60000
// real reserve()/commit() calls would make this suite slow for no added
// coverage -- seeding the row directly proves the exact same `reserve()`
// read-path (checkPlatformQuota reads `daily_ops` read-only) without paying
// that cost). `core.getDailyOps(budgetDay)` is the exported direct-read
// helper this story added specifically so tests can do this.

function seedDailyOps(adapter, budgetDay, count, notified = 0) {
  adapter.exec(`INSERT INTO daily_ops (budget_day, count, notified) VALUES (?, ?, ?)`, budgetDay, count, notified);
}

test("reserve('free', ...) denies resting once daily_ops's count reaches PLATFORM_ROW_CEILING, even though ceiling/freeDaily/etc are all still wide open", () => {
  const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
  const { core, adapter } = freshCore(t0);
  const budgetDay = "2026-01-01";
  seedDailyOps(adapter, budgetDay, PLATFORM_ROW_CEILING);

  const cfg = { ceiling: 1_000_000, reserveShare: 1, freeSlices: 1, minGapSec: 0, freeGlobalGapSec: 0, freeDaily: 1_000_000 };
  const before = adapter.exec("SELECT COUNT(*) AS n FROM reservations").rows[0].n;
  const denied = core.reserve("free", "quota-key-1", cfg);
  assert.deepEqual(denied, { ok: false, denied: "resting" });
  const after = adapter.exec("SELECT COUNT(*) AS n FROM reservations").rows[0].n;
  assert.equal(after, before, "a platform-quota denial must write zero rows, same as any other denial");
});

test("reserve('sub', ...) still grants at the SAME moment a 'free' reservation is denied by the platform-quota self-throttle -- subscribers are never gated by it", () => {
  const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
  const { core, adapter } = freshCore(t0);
  const budgetDay = "2026-01-01";
  seedDailyOps(adapter, budgetDay, PLATFORM_ROW_CEILING);

  const cfg = { ceiling: 1_000_000, reserveShare: 1, freeSlices: 1, minGapSec: 0, freeGlobalGapSec: 0, freeDaily: 1_000_000, subscriberDaily: 1_000_000 };
  const freeDenied = core.reserve("free", "quota-free-key", cfg);
  assert.equal(freeDenied.ok, false);
  assert.equal(freeDenied.denied, "resting");

  const subGranted = core.reserve("sub", "quota-sub-key", cfg);
  assert.equal(subGranted.ok, true, "a sub reservation must still grant even once the platform-quota self-throttle has tripped free traffic");
});

test("reserve('restore'/'mint', ...) are never gated by the platform-quota self-throttle either", () => {
  const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
  const { core, adapter } = freshCore(t0);
  const budgetDay = "2026-01-01";
  seedDailyOps(adapter, budgetDay, PLATFORM_ROW_CEILING * 2); // well past the ceiling

  assert.equal(core.reserve("restore", "quota-restore-key", { minGapSec: 0 }).ok, true);
  assert.equal(core.reserve("mint", "mint", { mintPerHour: 1000 }).ok, true);
});

test("notify()'s fixed event code fires exactly once at the crossing, not on every subsequent grant past the threshold", () => {
  const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
  const { core, adapter } = freshCore(t0);
  const budgetDay = "2026-01-01";
  // One row short of the ceiling -- the NEXT grant's own bumpDailyOpsAndNotify
  // call crosses it for the first time.
  seedDailyOps(adapter, budgetDay, PLATFORM_ROW_CEILING - 1);

  const cfg = { ceiling: 1_000_000, subscriberDaily: 1_000_000, minGapSec: 0 };

  const originalConsoleError = console.error;
  const loggedCalls = [];
  console.error = (...args) => loggedCalls.push(args);
  try {
    // `sub` is used here (never gated by checkPlatformQuota itself) purely
    // to drive daily_ops's own count up via ordinary grants -- notify() is
    // wired into bumpDailyOpsAndNotify(), called on EVERY kind's grant, not
    // just `free`'s.
    const first = core.reserve("sub", "notify-key-1", cfg); // crosses the ceiling: count -1 -> count
    assert.equal(first.ok, true);
    const second = core.reserve("sub", "notify-key-2", cfg); // stays past the ceiling: count -> count+1
    assert.equal(second.ok, true);
    const third = core.reserve("sub", "notify-key-3", cfg); // further past: count+1 -> count+2
    assert.equal(third.ok, true);
  } finally {
    console.error = originalConsoleError;
  }

  const notifyCalls = loggedCalls.filter((args) => args[0] === "governor_platform_quota_60pct");
  assert.equal(notifyCalls.length, 1, "notify() must fire exactly once for this budget day's crossing, not on every subsequent grant past the threshold");
  assert.deepEqual(notifyCalls[0], ["governor_platform_quota_60pct", budgetDay]);

  const row = core.getDailyOps(budgetDay);
  assert.equal(row.count, PLATFORM_ROW_CEILING + 2);
  assert.equal(row.notified, 1);
});

test("getDailyOps() reads {count:0, notified:0} for a budget day that has never been touched, and reflects real grants/commits/releases for one that has", () => {
  const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
  const { core, clock } = freshCore(t0);
  const budgetDay = "2026-01-01";

  assert.deepEqual(core.getDailyOps(budgetDay), { count: 0, notified: 0 });

  const cfg = { ceiling: 1000, subscriberDaily: 1000, minGapSec: 0 };
  const { id } = core.reserve("sub", "ops-key-1", cfg); // +1
  assert.equal(core.getDailyOps(budgetDay).count, 1);

  core.commit(id); // +1
  assert.equal(core.getDailyOps(budgetDay).count, 2);

  const { id: id2 } = core.reserve("sub", "ops-key-2", cfg); // +1
  core.release(id2, { neverCalled: true }); // +1
  assert.equal(core.getDailyOps(budgetDay).count, 4);

  // A denied reserve() must never bump daily_ops -- it writes zero rows.
  clock.advance(0);
  const denied = core.reserve("sub", "ops-key-1", { ...cfg, minGapSec: 3600 }); // still within the gap from ops-key-1's own earlier grant
  assert.equal(denied.ok, false);
  assert.equal(core.getDailyOps(budgetDay).count, 4, "a denied reserve() must not change daily_ops's own count");
});

test("500 concurrent reserve() calls (the existing zero-await proof) still grants exactly the ceiling with checkPlatformQuota added to the same call chain -- confirms the platform-quota read introduces no suspension point", async () => {
  const { core } = freshCore();
  const CONCURRENCY = 500;
  const CEILING = 40;
  const calls = Array.from({ length: CONCURRENCY }, (_, i) => Promise.resolve().then(() => core.reserve("free", `pq-key-${i}`, { ceiling: CEILING })));
  const results = await Promise.all(calls);
  const granted = results.filter((r) => r.ok).length;
  assert.equal(granted, CEILING, "checkPlatformQuota (a plain synchronous read added to the same reserve() call chain) must not change this pre-existing await-free guarantee");
});

test("schema_version table exists after first access to a fresh Governor core, and is idempotent across repeated construction", () => {
  const adapter = createSqliteAdapter();
  const clock = makeClock(0);

  createGovernorCore({ sql: adapter, now: clock.now });
  const rows1 = adapter.exec("SELECT version FROM schema_version").rows;
  assert.equal(rows1.length, 1);
  assert.equal(rows1[0].version, 1);

  // A second construction against the SAME underlying storage (simulating
  // a Durable Object instance being evicted and recreated) must not error
  // or duplicate the schema_version row.
  createGovernorCore({ sql: adapter, now: clock.now });
  const rows2 = adapter.exec("SELECT version FROM schema_version").rows;
  assert.equal(rows2.length, 1);
  assert.equal(rows2[0].version, 1);
});

// ------------------------------------------- Story 8-4: getDailyImageCounts()
//
// spec-8-4-daily-rollups.md's own Code Map: `{free, sub, imagesTotal}` for
// a UTC budget day, reusing SPENT_PREDICATE unchanged -- exercised both via
// `core.getDailyImageCounts` (the createGovernorCore-wired shape) and via
// the exported `getDailyImageCounts(sql, budgetDay)` function directly
// (the shape functions/lib/governor-do.js's handler calls), matching
// getDailyOps' own dual-exposure pattern just above.

test("getDailyImageCounts() reads {free:0, sub:0, imagesTotal:0} for a budget day with no rows at all", () => {
  const { core } = freshCore();
  assert.deepEqual(core.getDailyImageCounts("2026-01-01"), { free: 0, sub: 0, imagesTotal: 0 });
});

test("getDailyImageCounts() defaults a kind to 0 when that kind has zero spend-counting rows, even though the OTHER kind has some (SQL GROUP BY only returns rows that exist)", () => {
  const { core } = freshCore(Date.UTC(2026, 0, 1, 12, 0, 0));
  const budgetDay = "2026-01-01";
  core.reserve("free", "device-1", { ceiling: 1000 });
  core.reserve("free", "device-2", { ceiling: 1000 });
  // No 'sub' reservations at all this budget day.
  assert.deepEqual(core.getDailyImageCounts(budgetDay), { free: 2, sub: 0, imagesTotal: 2 });
});

test("getDailyImageCounts() sums free+sub spend-counting rows for the given budget day, ignoring restore/mint and other budget days", () => {
  const { core, clock } = freshCore(Date.UTC(2026, 0, 1, 0, 0, 0));
  const budgetDay = "2026-01-01";

  const f1 = core.reserve("free", "k1", { ceiling: 1000, minGapSec: 0 });
  const f2 = core.reserve("free", "k2", { ceiling: 1000, minGapSec: 0 });
  const s1 = core.reserve("sub", "sub-1", { ceiling: 1000, subscriberDaily: 1000, minGapSec: 0 });
  core.commit(f1.id);
  core.commit(f2.id);
  core.commit(s1.id);

  // A restore and a mint reservation the SAME budget day -- must never
  // count toward imagesTotal (Design Notes: this reuses SPENT_PREDICATE
  // scoped to kind IN ('free','sub'), same as countSpentForBudgetDay).
  const restoreR = core.reserve("restore", "k1", { minGapSec: 0 });
  const mintR = core.reserve("mint", "whatever", { mintPerHour: 100 });
  core.commit(restoreR.id);
  core.commit(mintR.id);

  // A free reservation on the NEXT UTC day must not count toward today's total.
  clock.set(Date.UTC(2026, 0, 2, 0, 0, 0));
  core.reserve("free", "k3", { ceiling: 1000, minGapSec: 0 });

  assert.deepEqual(core.getDailyImageCounts(budgetDay), { free: 2, sub: 1, imagesTotal: 3 });
});

test("getDailyImageCounts() counts `reserved`/`committed`/`expired`, and a plain/providerFailed `released` row -- but NOT a neverCalled release -- exactly matching SPENT_PREDICATE", () => {
  const { core, clock } = freshCore(0);
  const budgetDay = core.reserve("free", "seed", { ceiling: 1000 }).budgetDay; // 1: free, reserved

  core.reserve("free", "k-reserved", { ceiling: 1000 }); // 2: free, reserved

  const committed = core.reserve("free", "k-committed", { ceiling: 1000 }); // 3: free, committed
  core.commit(committed.id);

  const plainReleased = core.reserve("free", "k-released-plain", { ceiling: 1000 }); // 4: free, released (no flags)
  core.release(plainReleased.id, {});

  const providerFailedReleased = core.reserve("sub", "k-released-provider-failed", { ceiling: 1000, subscriberDaily: 1000 }); // sub, released+providerFailed
  core.release(providerFailedReleased.id, { providerFailed: true });

  const neverCalledReleased = core.reserve("free", "k-released-never-called", { ceiling: 1000 }); // free, released+neverCalled -- EXCLUDED
  core.release(neverCalledReleased.id, { neverCalled: true });

  const toExpire = core.reserve("free", "k-expired", { ceiling: 1000 }); // 5: free, expired
  clock.advance(EXPIRY_MS);
  const expiredIds = core.sweepExpired(clock.now());
  assert.ok(expiredIds.includes(toExpire.id));
  // `seed`/`k-reserved` (still `reserved` at t=0) also cross the same 60s
  // expiry threshold here -- that's fine and doesn't change this test's
  // point: `reserved` and `expired` are BOTH inside SPENT_PREDICATE, so
  // either state counts identically toward getDailyImageCounts either way.

  // free spend-counting rows: seed, k-reserved, committed, plainReleased,
  // toExpire (whichever of reserved/expired state each now has) = 5.
  // neverCalledReleased excluded. sub: exactly the one
  // providerFailed-but-not-neverCalled release = 1 (providerFailed alone
  // still counts as spent per SPENT_PREDICATE's own frozen rule).
  assert.deepEqual(core.getDailyImageCounts(budgetDay), { free: 5, sub: 1, imagesTotal: 6 });
});

test("getDailyImageCounts is exposed identically as a standalone export and via createGovernorCore's returned object", () => {
  const { core, adapter } = freshCore(Date.UTC(2026, 0, 1, 0, 0, 0));
  const budgetDay = "2026-01-01";
  core.reserve("free", "k1", { ceiling: 1000 });
  assert.deepEqual(getDailyImageCounts(adapter, budgetDay), core.getDailyImageCounts(budgetDay));
});
