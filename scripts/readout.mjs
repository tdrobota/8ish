// Story 8-6 -- one owner-facing report, read-only, run by hand:
//
//   node scripts/readout.mjs
//   node scripts/readout.mjs --views 50000
//
// Prints four sections: (1) today's Images against the Spend Ceiling, read
// from the most recent `gov_gauge` Analytics Engine data point written
// today (Story 8.5, functions/lib/events.js's writeGovGauge) via the
// Analytics Engine SQL API -- no Durable Object access needed, sidestepping
// Story 8.4's documented DO-unreachability gap entirely; (2) the last 15
// minutes' image_failed / (image_created + image_failed) rate, flagged only
// when it's > 20% AND there were >= 5 total attempts; (3) the last 30
// `rollup:<date>` KV entries (Story 8.4) as a table, read one GET per date
// via the Cloudflare KV REST API, the same mechanism
// scripts/backfill-rollup.mjs already established (its own PUT-side); (4)
// with `--views <n>`, SM-1/SM-2 (PRD "Success Metrics") computed from those
// same rollup days.
//
// House style match: every section is built from a small, pure,
// dependency-injected function (a fetch layer returning a plain result
// object, and a separate compute/format layer with no I/O at all), so the
// report-shaping/math can be proven under plain `node --test` with mocks --
// see test/readout.test.mjs -- exactly like functions/lib/rollup.js and
// scripts/backfill-rollup.mjs before it. This script performs ZERO writes
// anywhere (no KV, no Analytics Engine) -- every fetchFn call below is
// either a SQL-API POST (a read query, per Cloudflare's Analytics Engine
// SQL API) or a KV REST GET; nothing in this file ever issues a PUT/POST
// that mutates state.
//
// Every section degrades independently: a missing credential, an
// unreachable API, or missing data prints a clear "unavailable"/"no data"
// line for THAT section only, never throws, and the script always exits 0
// (a read-only reporting tool for a human, not a CI gate -- see this
// story's frozen spec, Boundaries).
//
// Reuses functions/lib/rollup.js's own exports directly rather than a
// second implementation: `shapeFunnelRows` (section 2's rows have the same
// `{event, n}` shape buildFunnelSql's do, just from a different,
// time-windowed query -- see buildFailureRateSql below) and
// `yesterdayUtcDate` (section 3's 30-day window is built by repeatedly
// calling it at different offsets, reusing its already-tested UTC
// calendar-rollover behavior instead of re-deriving date arithmetic here).
// rollup.js's own `buildFunnelSql`/`buildRollup` aren't reused directly --
// this script's two SQL queries (today's single most-recent `gov_gauge`
// row; a 15-minute rolling window filtered to two event names) are
// structurally different shapes from the daily per-event/per-source
// funnel query those build, so they get their own small builders below
// (buildGovGaugeTodaySql, buildFailureRateSql) rather than bending
// buildFunnelSql to fit -- see this story's Spec Change Log.

import { pathToFileURL } from "node:url";
import { shapeFunnelRows, yesterdayUtcDate } from "../functions/lib/rollup.js";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const FIFTEEN_MIN_MS = 15 * 60 * 1000;
const ROLLUP_DAYS = 30;

const FAILURE_RATE_FLAG_THRESHOLD = 0.2; // > 20%
const FAILURE_RATE_MIN_ATTEMPTS = 5; // AND >= 5 attempts -- both required (frozen matrix)

// PRD §7 (prd.md) SM-1/SM-2, read literally -- see this story's Spec Change
// Log for the exact quoted wording this was checked against.
const SM1_TARGET = 0.01; // SM-1: view-to-visit rate, target >= 1%
const SM2_TARGET = 0.006; // SM-2: visit-to-paid rate, target >= 0.6%
const SM2_STOP_SIGNAL = 0.003; // SM-2: below 0.3% is a stop signal
const SM2_MIN_VISITS = 1000; // SM-2: inconclusive if fewer than 1,000 (Source Link) visits

// wrangler.jsonc's own committed STATE_KV namespace id -- the identical
// value scripts/backfill-rollup.mjs already hardcodes (see that file's own
// header for why it's a literal here rather than parsed out of a JSONC
// file). Not imported from there because backfill-rollup.mjs doesn't
// export it (it's that script's own private constant) -- re-declaring a
// short, already-public (non-secret) id is simpler and safer than reaching
// into another standalone script's internals for it.
const STATE_KV_NAMESPACE_ID = "54b762d32d854a9bba9604472c4dc93e";

function analyticsEngineSqlUrl(accountId) {
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`;
}

function kvValueUrl(accountId, namespaceId, key) {
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`;
}

// Today's UTC calendar date, "YYYY-MM-DD" -- functions/lib/rollup.js's own
// UTC_DAY_FORMATTER technique (a real Intl calendar lookup, not naive
// offset math), just for `now` instead of `now - 1 day` (that file's
// exported yesterdayUtcDate already covers the "minus a day" case section 3
// below reuses).
const UTC_DAY_FORMATTER = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" });
function todayUtcDate(nowMs) {
  return UTC_DAY_FORMATTER.format(new Date(nowMs));
}

// The next UTC calendar date after `date` -- identical technique to
// rollup.js's own (private, unexported) nextUtcDateString.
function nextUtcDateString(date) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function formatSqlTimestamp(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

// --------------------------------------------------------- section 1: gauge

// Today's single most-recent gov_gauge row, per Story 8.5's writeGovGauge
// payload shape ({blobs:["gov_gauge"], doubles:[total,free,sub,ceiling],
// indexes:["gov_gauge"]}) -- doubles[0..3] map to double1..double4 in the
// SQL API's own column-numbering convention (matching buildFunnelSql's own
// double1 usage one for one).
export function buildGovGaugeTodaySql(date) {
  const nextDate = nextUtcDateString(date);
  return `SELECT double1 AS total, double2 AS free, double3 AS sub, double4 AS ceiling, timestamp FROM funnel WHERE blob1 = 'gov_gauge' AND timestamp >= '${date} 00:00:00' AND timestamp < '${nextDate} 00:00:00' ORDER BY timestamp DESC LIMIT 1`;
}

// The SQL API's row shape -> {total,free,sub,ceiling} or null (no row today,
// or a malformed one -- either way, "no data yet today", never a fabricated
// 0%).
export function shapeGovGaugeRow(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const row = rows[0];
  const total = Number(row && row.total);
  const free = Number(row && row.free);
  const sub = Number(row && row.sub);
  const ceiling = Number(row && row.ceiling);
  if (![total, free, sub, ceiling].every(Number.isFinite)) return null;
  return { total, free, sub, ceiling };
}

// Never throws; returns {status:"unavailable"} for a missing credential, an
// unreachable API, or a malformed response, or {status:"ok", gauge} where
// gauge may itself be null (no gov_gauge row exists yet today).
export async function fetchGovGaugeToday({ fetchFn, accountId, readToken, nowMs }) {
  if (!accountId || !readToken) return { status: "unavailable" };
  let response;
  try {
    response = await fetchFn(analyticsEngineSqlUrl(accountId), {
      method: "POST",
      headers: { Authorization: `Bearer ${readToken}` },
      body: buildGovGaugeTodaySql(todayUtcDate(nowMs)),
    });
  } catch {
    return { status: "unavailable" };
  }
  if (!response || response.ok !== true) return { status: "unavailable" };
  let body;
  try {
    body = await response.json();
  } catch {
    return { status: "unavailable" };
  }
  if (!body || !Array.isArray(body.data)) return { status: "unavailable" };
  return { status: "ok", gauge: shapeGovGaugeRow(body.data) };
}

export function formatGovGaugeSection(result) {
  if (result.status === "unavailable") {
    return "1) Today's Images vs. ceiling: unavailable (missing/unreachable Analytics Engine credentials)";
  }
  if (!result.gauge) {
    return "1) Today's Images vs. ceiling: no data yet today";
  }
  const { total, free, sub, ceiling } = result.gauge;
  if (!(ceiling > 0)) {
    return `1) Today's Images vs. ceiling: total=${total} free=${free} sub=${sub} ceiling=${ceiling} (ceiling is 0 -- percent unavailable)`;
  }
  const pct = (total / ceiling) * 100;
  return `1) Today's Images vs. ceiling: ${total}/${ceiling} = ${pct.toFixed(1)}% (free=${free}, sub=${sub})`;
}

// ------------------------------------------------- section 2: failure rate

// A 15-minute rolling window, filtered to exactly the two event names this
// ratio needs -- SUM(_sample_interval * double1) AS n / GROUP BY blob1
// matches buildFunnelSql's own reconstruction-from-sampling technique, just
// without blob2 (no per-source breakdown needed here).
export function buildFailureRateSql(sinceMs) {
  const since = formatSqlTimestamp(sinceMs);
  return `SELECT blob1 AS event, SUM(_sample_interval * double1) AS n FROM funnel WHERE blob1 IN ('image_created', 'image_failed') AND timestamp >= '${since}' GROUP BY blob1`;
}

// {created, failed, total, ratio, flagged} -- ratio is null when total is 0
// (nothing to divide); flagged requires BOTH ratio > 20% AND total >= 5
// (the frozen matrix's own "both conditions required").
export function computeFailureRate(counts) {
  const created = Number(counts && counts.image_created) || 0;
  const failed = Number(counts && counts.image_failed) || 0;
  const total = created + failed;
  const ratio = total > 0 ? failed / total : null;
  const flagged = ratio !== null && ratio > FAILURE_RATE_FLAG_THRESHOLD && total >= FAILURE_RATE_MIN_ATTEMPTS;
  return { created, failed, total, ratio, flagged };
}

export async function fetchFailureRateWindow({ fetchFn, accountId, readToken, nowMs }) {
  if (!accountId || !readToken) return { status: "unavailable" };
  let response;
  try {
    response = await fetchFn(analyticsEngineSqlUrl(accountId), {
      method: "POST",
      headers: { Authorization: `Bearer ${readToken}` },
      body: buildFailureRateSql(nowMs - FIFTEEN_MIN_MS),
    });
  } catch {
    return { status: "unavailable" };
  }
  if (!response || response.ok !== true) return { status: "unavailable" };
  let body;
  try {
    body = await response.json();
  } catch {
    return { status: "unavailable" };
  }
  if (!body || !Array.isArray(body.data)) return { status: "unavailable" };
  const { counts } = shapeFunnelRows(body.data);
  return { status: "ok", rate: computeFailureRate(counts) };
}

export function formatFailureRateSection(result) {
  if (result.status === "unavailable") {
    return "2) Last 15 min image failure rate: unavailable (missing/unreachable Analytics Engine credentials)";
  }
  const { created, failed, total, ratio, flagged } = result.rate;
  if (total === 0) {
    return "2) Last 15 min image failure rate: no attempts";
  }
  const pctStr = `${(ratio * 100).toFixed(1)}%`;
  const base = `2) Last 15 min image failure rate: ${failed}/${total} = ${pctStr} (created=${created}, failed=${failed})`;
  if (total < FAILURE_RATE_MIN_ATTEMPTS) {
    return `${base} -- not enough data to flag (< ${FAILURE_RATE_MIN_ATTEMPTS} attempts)`;
  }
  return flagged ? `${base} -- FLAGGED (> 20% over >= ${FAILURE_RATE_MIN_ATTEMPTS} attempts)` : base;
}

// --------------------------------------------------- section 3: rollup table

// The last ROLLUP_DAYS calendar dates a rollup could exist for, oldest
// first, ending at "yesterday" (the most recent UTC day the nightly Cron
// Trigger could have rolled up -- today's own day isn't over yet). Built by
// calling rollup.js's own tested yesterdayUtcDate at 30 different offsets
// rather than re-deriving "N days ago, formatted" arithmetic here.
export function rollupWindowDates(nowMs, days = ROLLUP_DAYS) {
  const dates = [];
  for (let k = days - 1; k >= 0; k--) {
    dates.push(yesterdayUtcDate(nowMs - k * ONE_DAY_MS));
  }
  return dates;
}

// One KV REST GET for a single key -- the GET-side of the exact mechanism
// scripts/backfill-rollup.mjs's putKvValue already established (same URL
// shape, same Bearer auth). Never throws: {status:"found", value} (parsed
// JSON), {status:"missing"} (a real 404 -- no rollup exists yet for this
// date, expected and normal), or {status:"error"} (network failure,
// non-2xx/non-404, or malformed JSON -- something actually went wrong).
export async function getKvValue({ fetchFn, accountId, readToken, namespaceId, key }) {
  if (!accountId || !readToken || !namespaceId) return { status: "error" };
  let response;
  try {
    response = await fetchFn(kvValueUrl(accountId, namespaceId, key), {
      method: "GET",
      headers: { Authorization: `Bearer ${readToken}` },
    });
  } catch {
    return { status: "error" };
  }
  if (!response) return { status: "error" };
  if (response.status === 404) return { status: "missing" };
  if (response.ok !== true) return { status: "error" };
  let text;
  try {
    text = await response.text();
  } catch {
    return { status: "error" };
  }
  try {
    return { status: "found", value: JSON.parse(text) };
  } catch {
    return { status: "error" };
  }
}

// {ok:true, days:[{date, rollup}, ...]} (real rollups found, in date order
// -- a date with no rollup yet, or a malformed one, is simply absent, never
// padded/fabricated) or {ok:false, reason} when the whole mechanism is
// unusable: missing credentials (never even attempted), or every single
// date's GET came back a real error (a total outage, not "the service is
// young and has few rollups yet" -- that case is ok:true with a short
// `days` array, per the frozen matrix's own "prints however many real days
// exist" row).
export async function fetchRollupDays({ fetchFn, accountId, readToken, namespaceId = STATE_KV_NAMESPACE_ID, dates }) {
  if (!accountId || !readToken) return { ok: false, reason: "missing-credentials", days: [] };
  const results = [];
  for (const date of dates) {
    // Sequential, not Promise.all: this is a human-run, occasional report,
    // not a hot path -- 30 sequential GETs keep this script's own request
    // pattern simple and trivially rate-limit-safe, at the cost of a few
    // seconds of wall time nobody is waiting on synchronously.
    const result = await getKvValue({ fetchFn, accountId, readToken, namespaceId, key: `rollup:${date}` });
    results.push({ date, ...result });
  }
  const found = results.filter((r) => r.status === "found");
  const allErrored = dates.length > 0 && results.every((r) => r.status === "error");
  if (found.length === 0 && allErrored) {
    return { ok: false, reason: "unreachable", days: [] };
  }
  return { ok: true, days: found.map((r) => ({ date: r.date, rollup: r.value })) };
}

function numOrZero(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function pad(v, width) {
  return String(v).padStart(width, " ");
}

export function sourceVisitTotal(rollup) {
  const sources = rollup && rollup.sources;
  if (!sources || typeof sources !== "object") return 0;
  return Object.values(sources).reduce((sum, n) => sum + numOrZero(n), 0);
}

export function formatRollupSection(result) {
  if (!result.ok) {
    return `3) Last ${ROLLUP_DAYS}-day rollup: unavailable (${result.reason})`;
  }
  if (result.days.length === 0) {
    return `3) Last ${ROLLUP_DAYS}-day rollup: no rollup:<date> entries found yet`;
  }
  const header = `   ${pad("date", 10)}  ${pad("created", 7)}  ${pad("failed", 6)}  ${pad("refused", 7)}  ${pad("app_open", 8)}  ${pad("purchase", 8)}  ${pad("src_visits", 10)}`;
  const rows = result.days.map(({ date, rollup }) => {
    const c = (rollup && rollup.counts) || {};
    return `   ${pad(date, 10)}  ${pad(numOrZero(c.image_created), 7)}  ${pad(numOrZero(c.image_failed), 6)}  ${pad(numOrZero(c.image_refused), 7)}  ${pad(numOrZero(c.app_open), 8)}  ${pad(numOrZero(c.purchase_completed), 8)}  ${pad(sourceVisitTotal(rollup), 10)}`;
  });
  return [`3) Last ${ROLLUP_DAYS}-day rollup (${result.days.length} real day(s) found):`, header, ...rows].join("\n");
}

// ------------------------------------------------------ section 4: SM-1/SM-2

// SM-1 = (sum of every available day's Source Link visit total) / views.
// SM-2 = (sum of purchase_completed) / (sum of app_open), across the SAME
// available days -- but the inconclusive gate (< 1,000 visits) is checked
// against the SAME Source Link visit sum SM-1 uses, per the PRD's own
// literal wording ("Inconclusive if fewer than 1,000 visits"), not against
// app-open or purchase counts.
export function computeSmMetrics(days, views) {
  const totalSourceVisits = days.reduce((sum, d) => sum + sourceVisitTotal(d.rollup), 0);
  const totalAppOpens = days.reduce((sum, d) => sum + numOrZero(d.rollup && d.rollup.counts && d.rollup.counts.app_open), 0);
  const totalPurchases = days.reduce((sum, d) => sum + numOrZero(d.rollup && d.rollup.counts && d.rollup.counts.purchase_completed), 0);

  const sm1 = views > 0 ? totalSourceVisits / views : null;
  const sm2Raw = totalAppOpens > 0 ? totalPurchases / totalAppOpens : null;
  const sm2Inconclusive = totalSourceVisits < SM2_MIN_VISITS;

  return { dayCount: days.length, totalSourceVisits, totalAppOpens, totalPurchases, sm1, sm2Raw, sm2Inconclusive };
}

export function formatSmSection(smReport, views) {
  if (smReport.status === "unavailable") {
    return `4) SM-1/SM-2 (--views ${views}): unavailable (${smReport.reason})`;
  }
  const m = smReport.metrics;
  const lines = [`4) SM-1/SM-2 (--views ${views}, across ${m.dayCount} rollup day(s)):`];
  if (m.dayCount === 0) {
    lines.push("   no rollup data available");
    return lines.join("\n");
  }
  lines.push(
    m.sm1 === null
      ? "   SM-1 (view-to-visit): n/a"
      : `   SM-1 (view-to-visit): ${(m.sm1 * 100).toFixed(2)}% -- target >= ${SM1_TARGET * 100}% (${m.totalSourceVisits} source visits / ${views} views)`
  );
  if (m.sm2Inconclusive) {
    lines.push(`   SM-2 (visit-to-paid): inconclusive -- fewer than ${SM2_MIN_VISITS} Source Link visits (${m.totalSourceVisits})`);
  } else if (m.sm2Raw === null) {
    lines.push("   SM-2 (visit-to-paid): n/a (no app opens in this window)");
  } else {
    const pct = m.sm2Raw * 100;
    const status = pct >= SM2_TARGET * 100 ? "meets target" : pct < SM2_STOP_SIGNAL * 100 ? "STOP SIGNAL" : "below target";
    lines.push(
      `   SM-2 (visit-to-paid): ${pct.toFixed(2)}% -- target >= ${SM2_TARGET * 100}%, stop signal < ${SM2_STOP_SIGNAL * 100}% (${status}) (${m.totalPurchases} purchases / ${m.totalAppOpens} app opens)`
    );
  }
  return lines.join("\n");
}

// ------------------------------------------------------------- orchestrator

// Builds the whole report as plain data (no printing) -- every section's
// own I/O is independent, so one section's failure never affects another's.
export async function buildReadoutReport({ fetchFn, accountId, analyticsReadToken, kvReadToken, kvNamespaceId = STATE_KV_NAMESPACE_ID, nowMs = Date.now(), views = null }) {
  const gauge = await fetchGovGaugeToday({ fetchFn, accountId, readToken: analyticsReadToken, nowMs });
  const failure = await fetchFailureRateWindow({ fetchFn, accountId, readToken: analyticsReadToken, nowMs });
  const dates = rollupWindowDates(nowMs);
  const rollup = await fetchRollupDays({ fetchFn, accountId, readToken: kvReadToken, namespaceId: kvNamespaceId, dates });

  let sm = null;
  if (views !== null) {
    sm = rollup.ok ? { status: "ok", metrics: computeSmMetrics(rollup.days, views) } : { status: "unavailable", reason: rollup.reason };
  }

  return { gauge, failure, rollup, sm, views };
}

export function renderReadoutReport(report) {
  const sections = [formatGovGaugeSection(report.gauge), formatFailureRateSection(report.failure), formatRollupSection(report.rollup)];
  if (report.sm !== null) {
    sections.push(formatSmSection(report.sm, report.views));
  }
  return sections.join("\n\n");
}

// --------------------------------------------------------------------- CLI

// Parses `--views <n>` (optional). An invalid value (missing, non-numeric,
// <= 0) is treated the same as "not given" -- section 4 is simply omitted,
// with one warning line explaining why, rather than failing the whole run
// (this is a reporting tool for a human, never a CI gate -- see the frozen
// spec's own "Always" clause).
export function parseArgs(argv) {
  let views = null;
  let warning = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--views") {
      const raw = argv[i + 1];
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) {
        views = n;
      } else {
        warning = `--views ignored: expected a positive number, got ${JSON.stringify(raw)}`;
      }
      i++;
    }
  }
  return { views, warning };
}

async function runCli(argv) {
  const { views, warning } = parseArgs(argv);
  if (warning) console.error(`readout: ${warning}`);

  const accountId = process.env.CF_ACCOUNT_ID;
  const analyticsReadToken = process.env.ANALYTICS_READ_TOKEN;
  // A separate, read-only-scoped token from CF_KV_WRITE_TOKEN (Workers KV
  // Storage: Read, not Edit) -- this script never writes, so it must never
  // even be handed a write-capable credential. Genuinely absent in this
  // build session, never invented (hard constraint) -- see this story's
  // Spec Change Log for why this is a new env var name.
  const kvReadToken = process.env.CF_KV_READ_TOKEN;

  try {
    const report = await buildReadoutReport({ fetchFn: fetch, accountId, analyticsReadToken, kvReadToken, nowMs: Date.now(), views });
    console.log(`8ish owner readout -- ${new Date().toISOString()}\n`);
    console.log(renderReadoutReport(report));
  } catch (error) {
    // Defense-in-depth only -- every section above already degrades to an
    // "unavailable" result rather than throwing. Still never let anything
    // escape uncaught (this is a read-only report, never a CI gate).
    console.error("readout: unexpected error --", error && error.message ? error.message : String(error));
  }
  // Always exits 0 -- a missing credential or an unreachable API degrades
  // the affected section(s) to "unavailable," it never fails the run (the
  // frozen spec's own "Always" clause).
  process.exitCode = 0;
}

const isMainModule = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isMainModule) {
  await runCli(process.argv.slice(2));
}
