// Story 8-6 -- scripts/readout.mjs's own logic, tested under plain Node with
// mocks (this file never invokes the real CLI entry point -- readout.mjs's
// own `isMainModule` guard keeps that from running on import, same pattern
// test/backfill-rollup.test.mjs uses). Covers the frozen I/O & Edge-Case
// Matrix in _bmad-output/implementation-artifacts/spec-8-6-owner-readout.md.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildGovGaugeTodaySql,
  shapeGovGaugeRow,
  fetchGovGaugeToday,
  formatGovGaugeSection,
  buildFailureRateSql,
  computeFailureRate,
  fetchFailureRateWindow,
  formatFailureRateSection,
  rollupWindowDates,
  getKvValue,
  fetchRollupDays,
  sourceVisitTotal,
  formatRollupSection,
  computeSmMetrics,
  formatSmSection,
  buildReadoutReport,
  renderReadoutReport,
  parseArgs,
} from "../scripts/readout.mjs";

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
    async text() {
      return JSON.stringify(body);
    },
  };
}

const NOW_MS = Date.UTC(2026, 8, 25, 12, 0, 0); // 2026-09-25T12:00:00Z

// --------------------------------------------------------- section 1: gauge

test("buildGovGaugeTodaySql: filters to blob1='gov_gauge', bounds exactly one UTC day, orders newest-first, limit 1", () => {
  const sql = buildGovGaugeTodaySql("2026-09-25");
  assert.match(sql, /blob1 = 'gov_gauge'/);
  assert.match(sql, /timestamp >= '2026-09-25 00:00:00'/);
  assert.match(sql, /timestamp < '2026-09-26 00:00:00'/);
  assert.match(sql, /ORDER BY timestamp DESC/);
  assert.match(sql, /LIMIT 1/);
});

test("shapeGovGaugeRow: shapes the first row's four numeric fields, or null on no rows / malformed row", () => {
  assert.deepEqual(shapeGovGaugeRow([{ total: 12, free: 8, sub: 4, ceiling: 100 }]), { total: 12, free: 8, sub: 4, ceiling: 100 });
  assert.equal(shapeGovGaugeRow([]), null, "no row today -- never a fabricated 0%");
  assert.equal(shapeGovGaugeRow(null), null);
  assert.equal(shapeGovGaugeRow([{ total: "not-a-number", free: 1, sub: 1, ceiling: 10 }]), null);
});

test("fetchGovGaugeToday: happy path returns the shaped gauge", async () => {
  const fetchFn = makeFetch((url, init) => {
    assert.match(url, /analytics_engine\/sql$/);
    assert.equal(init.method, "POST");
    assert.equal(init.headers.Authorization, "Bearer read-tok");
    return jsonResponse(200, { data: [{ total: 5, free: 3, sub: 2, ceiling: 40 }] });
  });
  const result = await fetchGovGaugeToday({ fetchFn, accountId: "acct1", readToken: "read-tok", nowMs: NOW_MS });
  assert.deepEqual(result, { status: "ok", gauge: { total: 5, free: 3, sub: 2, ceiling: 40 } });
});

test("fetchGovGaugeToday: no row today -> ok with gauge null, never a crash or a fabricated 0%", async () => {
  const fetchFn = makeFetch(() => jsonResponse(200, { data: [] }));
  const result = await fetchGovGaugeToday({ fetchFn, accountId: "a", readToken: "t", nowMs: NOW_MS });
  assert.deepEqual(result, { status: "ok", gauge: null });
});

test("fetchGovGaugeToday: missing credentials, network failure, non-2xx, and malformed body all degrade to 'unavailable', never throw", async () => {
  const neverCalled = makeFetch(() => {
    throw new Error("must never be called");
  });
  assert.deepEqual(await fetchGovGaugeToday({ fetchFn: neverCalled, accountId: undefined, readToken: "t", nowMs: NOW_MS }), { status: "unavailable" });
  assert.deepEqual(await fetchGovGaugeToday({ fetchFn: neverCalled, accountId: "a", readToken: "", nowMs: NOW_MS }), { status: "unavailable" });

  const throwingFetch = async () => {
    throw new Error("network down");
  };
  assert.deepEqual(await fetchGovGaugeToday({ fetchFn: throwingFetch, accountId: "a", readToken: "t", nowMs: NOW_MS }), { status: "unavailable" });

  const badStatusFetch = makeFetch(() => jsonResponse(500, { error: "boom" }));
  assert.deepEqual(await fetchGovGaugeToday({ fetchFn: badStatusFetch, accountId: "a", readToken: "t", nowMs: NOW_MS }), { status: "unavailable" });

  const badJsonFetch = makeFetch(() => ({
    ok: true,
    status: 200,
    async json() {
      throw new Error("not json");
    },
  }));
  assert.deepEqual(await fetchGovGaugeToday({ fetchFn: badJsonFetch, accountId: "a", readToken: "t", nowMs: NOW_MS }), { status: "unavailable" });
});

test("formatGovGaugeSection: prints the percent on a real gauge, 'no data yet today' when absent, 'unavailable' when the source failed", () => {
  assert.match(formatGovGaugeSection({ status: "ok", gauge: { total: 20, free: 12, sub: 8, ceiling: 40 } }), /20\/40 = 50\.0%/);
  assert.match(formatGovGaugeSection({ status: "ok", gauge: null }), /no data yet today/);
  assert.match(formatGovGaugeSection({ status: "unavailable" }), /unavailable/);
});

// ------------------------------------------------- section 2: failure rate

test("buildFailureRateSql: filters to image_created/image_failed, bounds a since-timestamp, groups by event", () => {
  const sql = buildFailureRateSql(Date.UTC(2026, 8, 25, 11, 45, 0));
  assert.match(sql, /blob1 IN \('image_created', 'image_failed'\)/);
  assert.match(sql, /timestamp >= '2026-09-25 11:45:00'/);
  assert.match(sql, /GROUP BY blob1/);
});

test("computeFailureRate: ratio and the 20%-over-5-attempts flag, both conditions required", () => {
  // 0 attempts -> ratio null, never flagged
  assert.deepEqual(computeFailureRate({}), { created: 0, failed: 0, total: 0, ratio: null, flagged: false });

  // high ratio but under 5 attempts -> never flagged
  const under5 = computeFailureRate({ image_created: 1, image_failed: 3 }); // 75% but total=4
  assert.equal(under5.flagged, false, "must not flag below the 5-attempt floor even at a high ratio");
  assert.equal(under5.ratio, 0.75);

  // exactly 5 attempts, exactly 20% -> not > 20%, not flagged
  const exactly20 = computeFailureRate({ image_created: 4, image_failed: 1 }); // 20% of 5
  assert.equal(exactly20.flagged, false, "exactly 20% must not flag -- the AC says OVER 20%");

  // >20% AND >=5 attempts -> flagged
  const flagged = computeFailureRate({ image_created: 3, image_failed: 2 }); // 40% of 5
  assert.equal(flagged.flagged, true);

  // >20% but only 5 counts as the floor exactly -- confirm >=5 boundary with a bigger sample
  const bigSample = computeFailureRate({ image_created: 70, image_failed: 30 }); // 30%
  assert.equal(bigSample.flagged, true);
});

test("fetchFailureRateWindow: reuses shapeFunnelRows for counts, then computeFailureRate", async () => {
  const fetchFn = makeFetch(() => jsonResponse(200, { data: [{ event: "image_created", n: 8 }, { event: "image_failed", n: 2 }] }));
  const result = await fetchFailureRateWindow({ fetchFn, accountId: "a", readToken: "t", nowMs: NOW_MS });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.rate, { created: 8, failed: 2, total: 10, ratio: 0.2, flagged: false });
});

test("fetchFailureRateWindow: missing credentials / unreachable -> 'unavailable', never throws", async () => {
  const neverCalled = makeFetch(() => {
    throw new Error("must never be called");
  });
  assert.deepEqual(await fetchFailureRateWindow({ fetchFn: neverCalled, accountId: "", readToken: "t", nowMs: NOW_MS }), { status: "unavailable" });

  const throwingFetch = async () => {
    throw new Error("down");
  };
  assert.deepEqual(await fetchFailureRateWindow({ fetchFn: throwingFetch, accountId: "a", readToken: "t", nowMs: NOW_MS }), { status: "unavailable" });
});

test("formatFailureRateSection: no attempts, not-enough-data, and the FLAGGED marker each print distinctly", () => {
  assert.match(formatFailureRateSection({ status: "ok", rate: computeFailureRate({}) }), /no attempts/);
  assert.match(formatFailureRateSection({ status: "ok", rate: computeFailureRate({ image_created: 1, image_failed: 3 }) }), /not enough data to flag/);
  const flaggedLine = formatFailureRateSection({ status: "ok", rate: computeFailureRate({ image_created: 3, image_failed: 2 }) });
  assert.match(flaggedLine, /FLAGGED/);
  assert.match(formatFailureRateSection({ status: "unavailable" }), /unavailable/);
});

// --------------------------------------------------- section 3: rollup table

test("rollupWindowDates: 30 consecutive UTC dates, oldest first, ending at 'yesterday' relative to now", () => {
  const dates = rollupWindowDates(NOW_MS, 30);
  assert.equal(dates.length, 30);
  assert.equal(dates[dates.length - 1], "2026-09-24", "the last entry must be 'yesterday' -- today's own day isn't rolled up yet");
  assert.equal(dates[0], "2026-08-26", "the first entry must be exactly 30 days before that");
  // strictly increasing, one calendar day apart
  for (let i = 1; i < dates.length; i++) {
    const prev = Date.parse(`${dates[i - 1]}T00:00:00Z`);
    const cur = Date.parse(`${dates[i]}T00:00:00Z`);
    assert.equal(cur - prev, 24 * 60 * 60 * 1000);
  }
});

test("getKvValue: found (200 + parsed JSON), missing (404), and error (network throw / non-2xx-non-404 / bad JSON) are distinct", async () => {
  const foundFetch = makeFetch((url, init) => {
    assert.match(url, /storage\/kv\/namespaces\/ns1\/values\/rollup%3A2026-09-24/);
    assert.equal(init.method, "GET");
    assert.equal(init.headers.Authorization, "Bearer kv-tok");
    return { ok: true, status: 200, async text() { return JSON.stringify({ date: "2026-09-24" }); } };
  });
  assert.deepEqual(await getKvValue({ fetchFn: foundFetch, accountId: "acct1", readToken: "kv-tok", namespaceId: "ns1", key: "rollup:2026-09-24" }), {
    status: "found",
    value: { date: "2026-09-24" },
  });

  const missingFetch = makeFetch(() => ({ ok: false, status: 404, async text() { return "not found"; } }));
  assert.deepEqual(await getKvValue({ fetchFn: missingFetch, accountId: "a", readToken: "t", namespaceId: "n", key: "k" }), { status: "missing" });

  const serverErrorFetch = makeFetch(() => ({ ok: false, status: 500, async text() { return "boom"; } }));
  assert.deepEqual(await getKvValue({ fetchFn: serverErrorFetch, accountId: "a", readToken: "t", namespaceId: "n", key: "k" }), { status: "error" });

  const throwingFetch = async () => {
    throw new Error("network down");
  };
  assert.deepEqual(await getKvValue({ fetchFn: throwingFetch, accountId: "a", readToken: "t", namespaceId: "n", key: "k" }), { status: "error" });

  const badJsonFetch = makeFetch(() => ({ ok: true, status: 200, async text() { return "not json"; } }));
  assert.deepEqual(await getKvValue({ fetchFn: badJsonFetch, accountId: "a", readToken: "t", namespaceId: "n", key: "k" }), { status: "error" });

  assert.deepEqual(await getKvValue({ fetchFn: throwingFetch, accountId: "", readToken: "t", namespaceId: "n", key: "k" }), { status: "error" });
});

test("fetchRollupDays: tolerates missing (404) days as simply absent, keeps the real ones found, in date order", async () => {
  const dates = ["2026-09-01", "2026-09-02", "2026-09-03"];
  const fetchFn = makeFetch((url) => {
    if (url.includes("2026-09-02")) return { ok: false, status: 404, async text() { return ""; } };
    return { ok: true, status: 200, async text() { return JSON.stringify({ date: url.includes("2026-09-01") ? "2026-09-01" : "2026-09-03", counts: {}, sources: {} }); } };
  });
  const result = await fetchRollupDays({ fetchFn, accountId: "a", readToken: "t", namespaceId: "n", dates });
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.days.map((d) => d.date),
    ["2026-09-01", "2026-09-03"]
  );
});

test("fetchRollupDays: fewer than 30 (even zero) real days is 'ok' with a short array -- a young service is not an error", async () => {
  const dates = ["2026-09-01", "2026-09-02"];
  const allMissingFetch = makeFetch(() => ({ ok: false, status: 404, async text() { return ""; } }));
  const result = await fetchRollupDays({ fetchFn: allMissingFetch, accountId: "a", readToken: "t", namespaceId: "n", dates });
  assert.deepEqual(result, { ok: true, days: [] });
});

test("fetchRollupDays: missing credentials never attempts any GET, and reports 'unavailable'", async () => {
  const neverCalled = makeFetch(() => {
    throw new Error("must never be called");
  });
  const result = await fetchRollupDays({ fetchFn: neverCalled, accountId: "", readToken: "t", namespaceId: "n", dates: ["2026-09-01"] });
  assert.deepEqual(result, { ok: false, reason: "missing-credentials", days: [] });
  assert.equal(neverCalled.calls.length, 0);
});

test("fetchRollupDays: every single GET actually erroring (a real outage) degrades the WHOLE table to 'unavailable', not a false '0 real days'", async () => {
  const dates = ["2026-09-01", "2026-09-02"];
  const throwingFetch = async () => {
    throw new Error("network down");
  };
  const result = await fetchRollupDays({ fetchFn: throwingFetch, accountId: "a", readToken: "t", namespaceId: "n", dates });
  assert.deepEqual(result, { ok: false, reason: "unreachable", days: [] });
});

test("sourceVisitTotal: sums every source's count for one rollup day; tolerates a missing/malformed sources field as 0", () => {
  assert.equal(sourceVisitTotal({ sources: { yt: 4, ig: 6 } }), 10);
  assert.equal(sourceVisitTotal({ sources: {} }), 0);
  assert.equal(sourceVisitTotal({}), 0);
  assert.equal(sourceVisitTotal(null), 0);
  assert.equal(sourceVisitTotal({ sources: { yt: "not-a-number" } }), 0);
});

test("formatRollupSection: unavailable, no-days-yet, and a real table with the right day count all print distinctly", () => {
  assert.match(formatRollupSection({ ok: false, reason: "unreachable" }), /unavailable/);
  assert.match(formatRollupSection({ ok: true, days: [] }), /no rollup:<date> entries found yet/);
  const table = formatRollupSection({
    ok: true,
    days: [{ date: "2026-09-24", rollup: { counts: { image_created: 5, image_failed: 1, app_open: 20, purchase_completed: 1 }, sources: { yt: 3 } } }],
  });
  assert.match(table, /1 real day\(s\) found/);
  assert.match(table, /2026-09-24/);
});

// ------------------------------------------------------ section 4: SM-1/SM-2

const DAYS_UNDER_1000_VISITS = [
  { date: "2026-09-01", rollup: { sources: { yt: 100 }, counts: { app_open: 500, purchase_completed: 3 } } },
  { date: "2026-09-02", rollup: { sources: { yt: 200 }, counts: { app_open: 500, purchase_completed: 2 } } },
];

const DAYS_OVER_1000_VISITS = [
  { date: "2026-09-01", rollup: { sources: { yt: 600 }, counts: { app_open: 5000, purchase_completed: 30 } } },
  { date: "2026-09-02", rollup: { sources: { yt: 500 }, counts: { app_open: 5000, purchase_completed: 20 } } },
];

test("computeSmMetrics: SM-1 sums source totals over views; SM-2 sums purchases over app_opens; inconclusive gate is the VISIT sum, not app_opens", () => {
  const under = computeSmMetrics(DAYS_UNDER_1000_VISITS, 50000);
  assert.equal(under.totalSourceVisits, 300);
  assert.equal(under.sm1, 300 / 50000);
  assert.equal(under.sm2Inconclusive, true, "300 visits < 1000 -- inconclusive regardless of the raw purchases/app_opens ratio");
  assert.equal(under.totalAppOpens, 1000);
  assert.equal(under.totalPurchases, 5);
  assert.equal(under.sm2Raw, 5 / 1000, "the raw ratio is still computed even when the gate marks it inconclusive for display");

  const over = computeSmMetrics(DAYS_OVER_1000_VISITS, 50000);
  assert.equal(over.totalSourceVisits, 1100);
  assert.equal(over.sm2Inconclusive, false);
  assert.equal(over.sm2Raw, 50 / 10000);
});

test("computeSmMetrics: an empty day list yields all-zero sums, sm1/sm2Raw null-safe (views>0 -> sm1=0, no app_opens -> sm2Raw null)", () => {
  const m = computeSmMetrics([], 50000);
  assert.deepEqual(m, { dayCount: 0, totalSourceVisits: 0, totalAppOpens: 0, totalPurchases: 0, sm1: 0, sm2Raw: null, sm2Inconclusive: true });
});

test("formatSmSection: prints inconclusive under 1,000 visits regardless of the raw ratio, and a real percentage at/above it", () => {
  const inconclusive = formatSmSection({ status: "ok", metrics: computeSmMetrics(DAYS_UNDER_1000_VISITS, 50000) }, 50000);
  assert.match(inconclusive, /inconclusive/);
  assert.doesNotMatch(inconclusive, /STOP SIGNAL|meets target|below target/, "inconclusive must win over any raw-ratio status label");

  const conclusive = formatSmSection({ status: "ok", metrics: computeSmMetrics(DAYS_OVER_1000_VISITS, 50000) }, 50000);
  assert.match(conclusive, /%/);
  assert.doesNotMatch(conclusive, /inconclusive/);

  assert.match(formatSmSection({ status: "unavailable", reason: "unreachable" }, 50000), /unavailable/);
});

test("formatSmSection: SM-2 status labels -- meets target (>=0.6%), below target, and STOP SIGNAL (<0.3%)", () => {
  const meets = computeSmMetrics([{ date: "d", rollup: { sources: { yt: 2000 }, counts: { app_open: 1000, purchase_completed: 10 } } }], 999999); // 1% = meets 0.6%
  assert.match(formatSmSection({ status: "ok", metrics: meets }, 999999), /meets target/);

  const below = computeSmMetrics([{ date: "d", rollup: { sources: { yt: 2000 }, counts: { app_open: 1000, purchase_completed: 4 } } }], 999999); // 0.4%
  assert.match(formatSmSection({ status: "ok", metrics: below }, 999999), /below target/);

  const stop = computeSmMetrics([{ date: "d", rollup: { sources: { yt: 2000 }, counts: { app_open: 1000, purchase_completed: 1 } } }], 999999); // 0.1%
  assert.match(formatSmSection({ status: "ok", metrics: stop }, 999999), /STOP SIGNAL/);
});

// ------------------------------------------------------------- orchestrator

test("buildReadoutReport / renderReadoutReport: assembles all four sections end to end with working credentials", async () => {
  const fetchFn = makeFetch((url) => {
    if (url.includes("analytics_engine/sql")) {
      // Both SQL calls share this handler; distinguish by returning data
      // that satisfies either shape (gauge fields undefined in the failure
      // query's own rows, harmless).
      return jsonResponse(200, { data: [{ total: 5, free: 3, sub: 2, ceiling: 50, event: "image_created", n: 10 }] });
    }
    // KV GETs: pretend nothing exists yet (a young service).
    return { ok: false, status: 404, async text() { return ""; } };
  });

  const report = await buildReadoutReport({ fetchFn, accountId: "a", analyticsReadToken: "t", kvReadToken: "kv", nowMs: NOW_MS, views: 1000 });
  assert.equal(report.gauge.status, "ok");
  assert.equal(report.failure.status, "ok");
  assert.equal(report.rollup.ok, true);
  assert.equal(report.rollup.days.length, 0);
  assert.equal(report.sm.status, "ok");

  const text = renderReadoutReport(report);
  assert.match(text, /^1\) Today's Images/);
  assert.match(text, /2\) Last 15 min/);
  assert.match(text, /3\) Last 30-day rollup/);
  assert.match(text, /4\) SM-1\/SM-2/);
});

test("buildReadoutReport: without --views, section 4 is omitted entirely (views stays null)", async () => {
  const fetchFn = makeFetch(() => ({ ok: false, status: 404, async text() { return ""; } }));
  const report = await buildReadoutReport({ fetchFn, accountId: "a", analyticsReadToken: "t", kvReadToken: "kv", nowMs: NOW_MS, views: null });
  assert.equal(report.sm, null);
  const text = renderReadoutReport(report);
  assert.doesNotMatch(text, /SM-1\/SM-2/);
});

test("buildReadoutReport: SM-1/SM-2 degrades to unavailable when the KV rollup read itself is unavailable, since it depends on it", async () => {
  const fetchFn = makeFetch((url) => {
    if (url.includes("analytics_engine/sql")) return jsonResponse(200, { data: [] });
    throw new Error("KV network down");
  });
  const report = await buildReadoutReport({ fetchFn, accountId: "a", analyticsReadToken: "t", kvReadToken: "kv", nowMs: NOW_MS, views: 1000 });
  assert.equal(report.rollup.ok, false);
  assert.equal(report.sm.status, "unavailable");
  assert.match(renderReadoutReport(report), /4\) SM-1\/SM-2.*unavailable/s);
});

test("buildReadoutReport: every section independently degrades when ALL credentials are absent -- never throws, whole report still renders", async () => {
  const neverCalled = makeFetch(() => {
    throw new Error("must never be called");
  });
  const report = await buildReadoutReport({ fetchFn: neverCalled, accountId: undefined, analyticsReadToken: undefined, kvReadToken: undefined, nowMs: NOW_MS, views: 500 });
  assert.equal(report.gauge.status, "unavailable");
  assert.equal(report.failure.status, "unavailable");
  assert.equal(report.rollup.ok, false);
  assert.equal(report.sm.status, "unavailable");
  assert.equal(neverCalled.calls.length, 0, "no credentials -- not even one network call should be attempted");
  const text = renderReadoutReport(report);
  assert.match(text, /unavailable/);
});

// ------------------------------------------------------------------ CLI args

test("parseArgs: reads --views <n> as a positive number; an invalid value is ignored with a warning, not a crash", () => {
  assert.deepEqual(parseArgs(["--views", "50000"]), { views: 50000, warning: null });
  assert.deepEqual(parseArgs([]), { views: null, warning: null });
  assert.equal(parseArgs(["--views", "not-a-number"]).views, null);
  assert.match(parseArgs(["--views", "not-a-number"]).warning, /ignored/);
  assert.equal(parseArgs(["--views", "-5"]).views, null, "a non-positive views count must be rejected, not used to divide by a negative/zero");
  assert.equal(parseArgs(["--views", "0"]).views, null);
});
