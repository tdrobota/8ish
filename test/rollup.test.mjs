// Story 8-4 -- functions/lib/rollup.js's own `node --test` suite. Covers
// the frozen I/O & Edge-Case Matrix in
// _bmad-output/implementation-artifacts/spec-8-4-daily-rollups.md. No
// Cloudflare runtime, no `wrangler dev` -- a fully injected `fetchFn` and
// `governorStub`, following governor-core.test.mjs's own house style
// (a controllable "backend" instead of a controllable clock here).

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRollup, buildFunnelSql, shapeFunnelRows, yesterdayUtcDate, ROLLUP_BUILD_FAILED_EVENT } from "../functions/lib/rollup.js";

// A controllable fetch: `plan` is an array of `(url, init) => Response-like`
// handlers consumed in order (or a single function reused for every call).
function makeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  fn.calls = calls;
  return fn;
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

function makeGovernorStub(result) {
  const calls = [];
  return {
    calls,
    async getDailyImageCounts(budgetDay) {
      calls.push(budgetDay);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

const GOOD_GOV_RESULT = { free: 3, sub: 2, imagesTotal: 5 };

async function captureConsoleErrorAsync(fn) {
  const original = console.error;
  const calls = [];
  console.error = (...args) => calls.push(args);
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return calls;
}

// --------------------------------------------------------------- buildFunnelSql

test("buildFunnelSql: groups by blob1/blob2, sums _sample_interval*double1, and bounds exactly the target UTC day (half-open range)", () => {
  const sql = buildFunnelSql("2026-09-24");
  assert.match(sql, /SELECT blob1 AS event, blob2 AS source, SUM\(_sample_interval \* double1\) AS n FROM funnel/);
  assert.match(sql, /GROUP BY blob1, blob2/);
  assert.match(sql, /timestamp >= '2026-09-24 00:00:00'/);
  assert.match(sql, /timestamp < '2026-09-25 00:00:00'/, "the upper bound must be the NEXT calendar day, half-open");
});

test("buildFunnelSql: rolls a month/year boundary correctly for the next-day bound", () => {
  assert.match(buildFunnelSql("2026-01-31"), /timestamp < '2026-02-01 00:00:00'/);
  assert.match(buildFunnelSql("2026-12-31"), /timestamp < '2027-01-01 00:00:00'/);
});

// --------------------------------------------------------------- shapeFunnelRows

test("shapeFunnelRows: counts[event] sums n across ALL sources (including empty); sources[name] sums n only across non-empty sources", () => {
  const rows = [
    { event: "image_created", source: "", n: 5 },
    { event: "image_created", source: "yt", n: 3 },
    { event: "image_created", source: "ig", n: 2 },
    { event: "image_refused", source: "", n: 1 },
    { event: "source_visit", source: "yt", n: 7 },
  ];
  const { counts, sources } = shapeFunnelRows(rows);
  assert.deepEqual(counts, { image_created: 10, image_refused: 1, source_visit: 7 });
  assert.deepEqual(sources, { yt: 10, ig: 2 });
});

test("shapeFunnelRows: an empty row set shapes to two empty objects", () => {
  assert.deepEqual(shapeFunnelRows([]), { counts: {}, sources: {} });
});

test("shapeFunnelRows: skips a malformed row (missing/non-string event, non-finite n) rather than corrupting the aggregate", () => {
  const rows = [
    { event: "image_created", source: "", n: 4 },
    { event: "", source: "", n: 9 },
    { event: "image_created", source: "yt", n: "not-a-number" },
    { source: "yt", n: 1 }, // no event at all
  ];
  const { counts, sources } = shapeFunnelRows(rows);
  assert.deepEqual(counts, { image_created: 4 });
  assert.deepEqual(sources, {});
});

// --------------------------------------------------------------------- buildRollup

test("buildRollup: happy path returns the exact schema, merging both independent sources", async () => {
  const fetchFn = makeFetch((url, init) => {
    assert.equal(url, "https://api.cloudflare.com/client/v4/accounts/acct123/analytics_engine/sql");
    assert.equal(init.method, "POST");
    assert.equal(init.headers.Authorization, "Bearer read-token-abc");
    assert.match(init.body, /FROM funnel/);
    return jsonResponse(200, {
      meta: [{ name: "event", type: "string" }],
      data: [
        { event: "image_created", source: "", n: 4 },
        { event: "image_created", source: "yt", n: 1 },
      ],
      rows: 2,
    });
  });
  const governorStub = makeGovernorStub(GOOD_GOV_RESULT);

  const result = await buildRollup({ fetchFn, accountId: "acct123", readToken: "read-token-abc", governorStub, date: "2026-09-24" });

  assert.deepEqual(result, {
    date: "2026-09-24",
    tz: "UTC",
    counts: { image_created: 5 },
    sources: { yt: 1 },
    gov: { free: 3, sub: 2, imagesTotal: 5 },
  });
  assert.deepEqual(governorStub.calls, ["2026-09-24"], "the Governor RPC must be called for the SAME date as the funnel query");
});

test("buildRollup: running it twice for the same day is idempotent -- byte-identical content from the same inputs", async () => {
  const makeInputs = () => ({
    fetchFn: makeFetch(() => jsonResponse(200, { data: [{ event: "image_created", source: "", n: 2 }] })),
    accountId: "acct1",
    readToken: "tok1",
    governorStub: makeGovernorStub({ free: 1, sub: 1, imagesTotal: 2 }),
    date: "2026-09-24",
  });
  const first = await buildRollup(makeInputs());
  const second = await buildRollup(makeInputs());
  assert.deepEqual(first, second);
});

test("buildRollup: returns null and logs the fixed event code when the SQL API is unreachable (fetchFn rejects)", async () => {
  const fetchFn = async () => {
    throw new Error("network down");
  };
  const governorStub = makeGovernorStub(GOOD_GOV_RESULT);
  let result;
  const logged = await captureConsoleErrorAsync(async () => {
    result = await buildRollup({ fetchFn, accountId: "a", readToken: "t", governorStub, date: "2026-09-24" });
  });
  assert.equal(result, null);
  assert.ok(logged.some((args) => args[0] === ROLLUP_BUILD_FAILED_EVENT));
});

test("buildRollup: returns null when the SQL API answers non-2xx", async () => {
  const fetchFn = makeFetch(() => jsonResponse(500, { error: "internal" }));
  const governorStub = makeGovernorStub(GOOD_GOV_RESULT);
  const result = await buildRollup({ fetchFn, accountId: "a", readToken: "t", governorStub, date: "2026-09-24" });
  assert.equal(result, null);
});

test("buildRollup: returns null when the SQL API's body is malformed (not JSON, or missing a data array)", async () => {
  const governorStub = makeGovernorStub(GOOD_GOV_RESULT);

  const badJsonFetch = makeFetch(() => ({
    ok: true,
    status: 200,
    async json() {
      throw new Error("not json");
    },
  }));
  assert.equal(await buildRollup({ fetchFn: badJsonFetch, accountId: "a", readToken: "t", governorStub, date: "2026-09-24" }), null);

  const noDataFetch = makeFetch(() => jsonResponse(200, { meta: [], rows: 0 }));
  assert.equal(await buildRollup({ fetchFn: noDataFetch, accountId: "a", readToken: "t", governorStub, date: "2026-09-24" }), null);
});

test("buildRollup: returns null when the Governor RPC throws, even though the SQL side succeeded -- and the SQL side is never wasted/retried, just discarded", async () => {
  const fetchFn = makeFetch(() => jsonResponse(200, { data: [{ event: "image_created", source: "", n: 1 }] }));
  const governorStub = makeGovernorStub(new Error("Durable Object unreachable"));
  const result = await buildRollup({ fetchFn, accountId: "a", readToken: "t", governorStub, date: "2026-09-24" });
  assert.equal(result, null);
});

test("buildRollup: returns null when the Governor stub is missing/malformed, or its result is missing a required numeric field", async () => {
  const fetchFn = makeFetch(() => jsonResponse(200, { data: [] }));

  assert.equal(await buildRollup({ fetchFn, accountId: "a", readToken: "t", governorStub: null, date: "2026-09-24" }), null);
  assert.equal(await buildRollup({ fetchFn, accountId: "a", readToken: "t", governorStub: {}, date: "2026-09-24" }), null);
  assert.equal(
    await buildRollup({ fetchFn, accountId: "a", readToken: "t", governorStub: makeGovernorStub({ free: 1, sub: 2 }), date: "2026-09-24" }),
    null,
    "a Governor result missing imagesTotal must be treated as a failure, not silently coerced to NaN"
  );
});

test("buildRollup: returns null (same as 'unreachable') when accountId/readToken are absent -- covers the real 'not yet configured' state of this session", async () => {
  const fetchFn = makeFetch(() => {
    throw new Error("must never be called when credentials are absent");
  });
  const governorStub = makeGovernorStub(GOOD_GOV_RESULT);

  const resultNoAccount = await buildRollup({ fetchFn, accountId: undefined, readToken: "t", governorStub, date: "2026-09-24" });
  assert.equal(resultNoAccount, null);
  assert.equal(fetchFn.calls.length, 0, "fetchFn must never even be called without a real accountId/readToken");

  const resultNoToken = await buildRollup({ fetchFn, accountId: "a", readToken: "", governorStub, date: "2026-09-24" });
  assert.equal(resultNoToken, null);
  assert.equal(fetchFn.calls.length, 0);
});

test("buildRollup: never throws for any failure combination -- always resolves to null or the real object", async () => {
  const throwingFetch = async () => {
    throw new Error("boom");
  };
  const throwingGov = makeGovernorStub(new Error("boom too"));
  await assert.doesNotReject(() =>
    captureConsoleErrorAsync(() => buildRollup({ fetchFn: throwingFetch, accountId: "a", readToken: "t", governorStub: throwingGov, date: "2026-09-24" }))
  );
});

test("buildRollup: an invalid date argument (not YYYY-MM-DD) fails closed without ever calling either source", async () => {
  const fetchFn = makeFetch(() => {
    throw new Error("must never be called");
  });
  const governorStub = makeGovernorStub(GOOD_GOV_RESULT);
  const result = await buildRollup({ fetchFn, accountId: "a", readToken: "t", governorStub, date: "09/24/2026" });
  assert.equal(result, null);
  assert.equal(fetchFn.calls.length, 0);
  assert.equal(governorStub.calls.length, 0);
});

// ------------------------------------------------------------- yesterdayUtcDate

test("yesterdayUtcDate: returns the correct prior UTC calendar date, including across month/year boundaries", () => {
  assert.equal(yesterdayUtcDate(Date.UTC(2026, 8, 25, 3, 0, 0)), "2026-09-24");
  assert.equal(yesterdayUtcDate(Date.UTC(2026, 0, 1, 3, 0, 0)), "2025-12-31", "must roll back across a year boundary");
  assert.equal(yesterdayUtcDate(Date.UTC(2026, 2, 1, 0, 0, 1)), "2026-02-28", "must roll back across a month boundary");
  assert.equal(yesterdayUtcDate(Date.UTC(2028, 2, 1, 0, 0, 1)), "2028-02-29", "a leap-year February must still resolve correctly");
});
