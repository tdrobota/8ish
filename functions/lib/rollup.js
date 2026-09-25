// Daily rollups that outlive Analytics Engine's 3-month retention (Story
// 8-4). Follows functions/lib/events.js's own "pure, dependency-injected,
// testable under plain Node" house style: buildRollup() takes EVERYTHING
// it needs as parameters (an injected fetch function, the account id, the
// read token, a Governor stub, the target date) -- no direct `env`/global
// `fetch` reference anywhere in this file, so it runs unmodified under
// `node --test` with mocks, exactly like the Governor core itself.
//
// buildRollup({ fetchFn, accountId, readToken, governorStub, date }):
//   Two INDEPENDENT reads (the frozen spec's own Design Notes: the funnel
//   query and the Governor RPC are structurally different data sources
//   today -- no gov_gauge event exists before Story 8.5 -- so this never
//   conflates them into one query, only merges their two results):
//     1. One POST to the Analytics Engine SQL REST API for the `funnel`
//        dataset, grouped by event (blob1) and source (blob2).
//     2. One RPC call to the Governor DO's own getDailyImageCounts(date)
//        (functions/lib/governor-core.js's new additive export, reached
//        via functions/lib/governor-do.js + functions/governor.js).
//   Returns `{ date, tz: "UTC", counts, sources, gov }` on success, or
//   `null` on ANY failure from either source -- logging ONE fixed event
//   code (ROLLUP_BUILD_FAILED_EVENT) first. Never throws: every await in
//   this file is wrapped so a network error, a non-2xx/malformed SQL API
//   response, a thrown/rejected Governor RPC, or a malformed Governor
//   result all degrade the exact same way. This also covers the "missing
//   ANALYTICS_READ_TOKEN/CF_ACCOUNT_ID" case (I/O matrix) without a
//   separate branch: fetchFunnelRows() below treats a missing accountId/
//   readToken as "can't even attempt the read", the same outcome as an
//   unreachable API.

export const ROLLUP_BUILD_FAILED_EVENT = "rollup_build_failed";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function analyticsEngineSqlUrl(accountId) {
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`;
}

// The next UTC calendar date after `date` (both `YYYY-MM-DD`). Built from
// a real `Date` (`Date.UTC`-safe: adding exactly one day via
// `setUTCDate` correctly rolls month/year boundaries), never naive string
// arithmetic on the date's own digits.
function nextUtcDateString(date) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// The funnel dataset's own SQL text for one UTC calendar day. Per
// Cloudflare's SQL reference ("Statements" example query:
// `WHERE timestamp > '2026-04-20'`), a literal `'YYYY-MM-DD HH:MM:SS'`
// string compares directly against the dataset's own `timestamp` column --
// no DATE()/timezone cast needed -- so a half-open [date, nextDate) range
// cleanly bounds exactly one UTC calendar day. `SUM(_sample_interval *
// double1)` is epics.md's own literal instruction for reconstructing the
// true unsampled count from Analytics Engine's adaptive sampling; `blob1
// AS event, blob2 AS source` matches functions/lib/events.js's own
// `payload.blobs = [event, source || ""]` write shape one-for-one.
export function buildFunnelSql(date) {
  const nextDate = nextUtcDateString(date);
  return `SELECT blob1 AS event, blob2 AS source, SUM(_sample_interval * double1) AS n FROM funnel WHERE timestamp >= '${date} 00:00:00' AND timestamp < '${nextDate} 00:00:00' GROUP BY blob1, blob2`;
}

// Fetches the raw funnel rows for `date`, or `null` on any failure
// (missing credentials, network error, non-2xx, malformed JSON, a `data`
// field that isn't an array). Never throws.
async function fetchFunnelRows({ fetchFn, accountId, readToken, date }) {
  if (!accountId || !readToken) return null;

  let response;
  try {
    response = await fetchFn(analyticsEngineSqlUrl(accountId), {
      method: "POST",
      headers: { Authorization: `Bearer ${readToken}` },
      body: buildFunnelSql(date),
    });
  } catch {
    return null;
  }
  if (!response || response.ok !== true) return null;

  let body;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  if (!body || !Array.isArray(body.data)) return null;
  return body.data;
}

// `counts[event]` sums `n` across ALL rows for that event name (any
// source, including an empty one); `sources[name]` sums `n` only across
// rows whose `source` is non-empty, keyed by that source name (frozen I/O
// matrix). A row with a non-string/empty `event` or a non-finite `n` is
// skipped defensively -- a malformed row from the API must never corrupt
// the whole aggregate.
export function shapeFunnelRows(rows) {
  const counts = {};
  const sources = {};
  for (const row of rows) {
    const event = row && row.event;
    const source = row && row.source;
    const n = Number(row && row.n);
    if (typeof event !== "string" || !event || !Number.isFinite(n)) continue;
    counts[event] = (counts[event] || 0) + n;
    if (typeof source === "string" && source !== "") {
      sources[source] = (sources[source] || 0) + n;
    }
  }
  return { counts, sources };
}

// Calls the Governor stub's getDailyImageCounts(date), returning
// `{ free, sub, imagesTotal }` verbatim (coerced to finite numbers) or
// `null` on any failure (no usable stub, a throw/rejection, a
// malformed/non-numeric result). Never throws.
async function fetchGovDailyCounts({ governorStub, date }) {
  if (!governorStub || typeof governorStub.getDailyImageCounts !== "function") return null;

  let result;
  try {
    result = await governorStub.getDailyImageCounts(date);
  } catch {
    return null;
  }
  if (!result || typeof result !== "object") return null;

  const free = Number(result.free);
  const sub = Number(result.sub);
  const imagesTotal = Number(result.imagesTotal);
  if (!Number.isFinite(free) || !Number.isFinite(sub) || !Number.isFinite(imagesTotal)) return null;
  return { free, sub, imagesTotal };
}

// The one entry point this module exists to provide. See this file's own
// header for the full contract.
export async function buildRollup({ fetchFn, accountId, readToken, governorStub, date }) {
  try {
    if (typeof fetchFn !== "function" || typeof date !== "string" || !DATE_RE.test(date)) {
      console.error(ROLLUP_BUILD_FAILED_EVENT, date);
      return null;
    }

    const rows = await fetchFunnelRows({ fetchFn, accountId, readToken, date });
    if (rows === null) {
      console.error(ROLLUP_BUILD_FAILED_EVENT, date);
      return null;
    }

    const gov = await fetchGovDailyCounts({ governorStub, date });
    if (gov === null) {
      console.error(ROLLUP_BUILD_FAILED_EVENT, date);
      return null;
    }

    const { counts, sources } = shapeFunnelRows(rows);
    return { date, tz: "UTC", counts, sources, gov };
  } catch {
    // Defense-in-depth: nothing above is expected to throw synchronously
    // (every await is already wrapped), but a source failure must NEVER
    // escape as an uncaught throw regardless -- see the frozen "Always"
    // section.
    console.error(ROLLUP_BUILD_FAILED_EVENT, date);
    return null;
  }
}

// worker.js's scheduled() own "yesterday, UTC" computation, exported here
// (rather than inlined in worker.js) so it gets real `node --test`
// coverage -- worker.js itself can't be imported under plain Node (it
// re-exports the Governor class, which imports `cloudflare:workers`).
// Same Intl/tz-database-formatter technique governor-core.js's own
// utcDateString() uses, for the same reason (a well-formed `YYYY-MM-DD`
// from a real calendar lookup, not naive offset arithmetic) -- UTC itself
// has no DST transitions to get wrong, but subtracting exactly 24h and
// re-formatting is still the simplest correct way to roll a calendar date
// backward across month/year boundaries.
const UTC_DAY_FORMATTER = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" });
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
export function yesterdayUtcDate(nowMs) {
  return UTC_DAY_FORMATTER.format(new Date(nowMs - ONE_DAY_MS));
}
