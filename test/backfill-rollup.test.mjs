// Story 8-4 -- scripts/backfill-rollup.mjs's own logic, tested under plain
// Node with mocks (this file never invokes the real CLI entry point --
// backfill-rollup.mjs's own `isMainModule` guard keeps that from running
// on import, same pattern scripts/run-checks.mjs uses for its own
// fileURLToPath(import.meta.url) self-identification). Covers the frozen
// I/O matrix's own "runs once per date... skipping (and reporting) any
// date whose sources fail rather than aborting the whole range."

import assert from "node:assert/strict";
import { test } from "node:test";
import { isValidDateString, dateRangeInclusive, runBackfill, putKvValue } from "../scripts/backfill-rollup.mjs";

// --------------------------------------------------------------- date parsing

test("isValidDateString: accepts well-formed calendar dates, rejects malformed/impossible ones", () => {
  assert.equal(isValidDateString("2026-09-24"), true);
  assert.equal(isValidDateString("2028-02-29"), true, "a real leap day must be accepted");
  assert.equal(isValidDateString("2026-02-30"), false, "not a real calendar date");
  assert.equal(isValidDateString("2026-9-24"), false, "must be zero-padded");
  assert.equal(isValidDateString("09/24/2026"), false);
  assert.equal(isValidDateString(""), false);
  assert.equal(isValidDateString(undefined), false);
  assert.equal(isValidDateString(20260924), false);
});

test("dateRangeInclusive: returns every UTC calendar date from <from> to <to>, inclusive", () => {
  assert.deepEqual(dateRangeInclusive("2026-09-01", "2026-09-05"), ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05"]);
  assert.deepEqual(dateRangeInclusive("2026-09-01", "2026-09-01"), ["2026-09-01"], "a single-day range must return exactly that one date");
});

test("dateRangeInclusive: rolls a month/year boundary correctly", () => {
  assert.deepEqual(dateRangeInclusive("2026-01-30", "2026-02-02"), ["2026-01-30", "2026-01-31", "2026-02-01", "2026-02-02"]);
  assert.deepEqual(dateRangeInclusive("2026-12-30", "2027-01-01"), ["2026-12-30", "2026-12-31", "2027-01-01"]);
});

test("dateRangeInclusive: throws (never returns a partial/garbled range) for an invalid date or an inverted range", () => {
  assert.throws(() => dateRangeInclusive("not-a-date", "2026-09-05"));
  assert.throws(() => dateRangeInclusive("2026-09-05", "not-a-date"));
  assert.throws(() => dateRangeInclusive("2026-09-05", "2026-09-01"), /must not be after/);
});

// ------------------------------------------------------------------ runBackfill

test("runBackfill: builds then writes each date in order; a date whose build returns null is skipped, not written, and does not stop the range", async () => {
  const dates = ["2026-09-01", "2026-09-02", "2026-09-03"];
  const built = [];
  const written = [];
  const buildRollupForDate = async (date) => {
    built.push(date);
    if (date === "2026-09-02") return null; // a source failed for this one day
    return { date, tz: "UTC", counts: {}, sources: {}, gov: { free: 0, sub: 0, imagesTotal: 0 } };
  };
  const writeRollup = async (date, rollup) => {
    written.push({ date, rollup });
  };

  const summary = await runBackfill({ dates, buildRollupForDate, writeRollup });

  assert.deepEqual(built, dates, "every date must be attempted, in order, regardless of an earlier one's outcome");
  assert.deepEqual(
    written.map((w) => w.date),
    ["2026-09-01", "2026-09-03"]
  );
  assert.deepEqual(summary, { written: ["2026-09-01", "2026-09-03"], skipped: ["2026-09-02"], failed: [] });
});

test("runBackfill: a date whose WRITE throws is reported as failed, isolated from the rest of the range (per-day error isolation)", async () => {
  const dates = ["2026-09-01", "2026-09-02", "2026-09-03"];
  const buildRollupForDate = async (date) => ({ date, tz: "UTC", counts: {}, sources: {}, gov: { free: 0, sub: 0, imagesTotal: 0 } });
  const written = [];
  const writeRollup = async (date) => {
    if (date === "2026-09-02") throw new Error("simulated KV write failure");
    written.push(date);
  };

  const summary = await runBackfill({ dates, buildRollupForDate, writeRollup });

  assert.deepEqual(summary, { written: ["2026-09-01", "2026-09-03"], skipped: [], failed: ["2026-09-02"] });
  assert.deepEqual(written, ["2026-09-01", "2026-09-03"], "the day after the failing one must still be attempted and written");
});

test("runBackfill: a BUILD that unexpectedly throws (rather than returning null) is also isolated as a failure, not an aborted range", async () => {
  const dates = ["2026-09-01", "2026-09-02"];
  const buildRollupForDate = async (date) => {
    if (date === "2026-09-01") throw new Error("simulated unexpected throw");
    return { date, tz: "UTC", counts: {}, sources: {}, gov: { free: 0, sub: 0, imagesTotal: 0 } };
  };
  const written = [];
  const writeRollup = async (date) => {
    written.push(date);
  };

  const summary = await runBackfill({ dates, buildRollupForDate, writeRollup });
  assert.deepEqual(summary, { written: ["2026-09-02"], skipped: [], failed: ["2026-09-01"] });
});

test("runBackfill: an empty date list is a no-op, returning an all-empty summary", async () => {
  const summary = await runBackfill({
    dates: [],
    buildRollupForDate: async () => {
      throw new Error("must never be called");
    },
    writeRollup: async () => {
      throw new Error("must never be called");
    },
  });
  assert.deepEqual(summary, { written: [], skipped: [], failed: [] });
});

// ------------------------------------------------------------------- putKvValue

function makeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  fn.calls = calls;
  return fn;
}

test("putKvValue: PUTs to the documented KV REST endpoint with a Bearer token and a multipart 'value' field", async () => {
  const fetchFn = makeFetch((url, init) => {
    assert.equal(url, "https://api.cloudflare.com/client/v4/accounts/acct1/storage/kv/namespaces/ns1/values/rollup%3A2026-09-24");
    assert.equal(init.method, "PUT");
    assert.equal(init.headers.Authorization, "Bearer kv-write-token");
    assert.ok(init.body instanceof FormData, "the body must be multipart/form-data (a FormData), not raw JSON");
    return { ok: true, status: 200, async text() { return "{}"; } };
  });

  await putKvValue({ fetchFn, accountId: "acct1", writeToken: "kv-write-token", namespaceId: "ns1", key: "rollup:2026-09-24", value: "{\"a\":1}" });
  assert.equal(fetchFn.calls.length, 1);
});

test("putKvValue: throws on a non-2xx response, and on missing accountId/writeToken/namespaceId", async () => {
  const failFetch = makeFetch(() => ({ ok: false, status: 403, async text() { return "forbidden"; } }));
  await assert.rejects(() => putKvValue({ fetchFn: failFetch, accountId: "a", writeToken: "t", namespaceId: "n", key: "k", value: "v" }));

  const neverCalledFetch = makeFetch(() => {
    throw new Error("must never be called");
  });
  await assert.rejects(() => putKvValue({ fetchFn: neverCalledFetch, accountId: "", writeToken: "t", namespaceId: "n", key: "k", value: "v" }));
  await assert.rejects(() => putKvValue({ fetchFn: neverCalledFetch, accountId: "a", writeToken: "", namespaceId: "n", key: "k", value: "v" }));
  await assert.rejects(() => putKvValue({ fetchFn: neverCalledFetch, accountId: "a", writeToken: "t", namespaceId: "", key: "k", value: "v" }));
});
