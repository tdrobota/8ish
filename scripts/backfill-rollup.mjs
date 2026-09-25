// Story 8-4 -- recreates missing `rollup:<date>` KV entries for a date
// range, while the source data is still within Analytics Engine's 3-month
// retention window. Reuses functions/lib/rollup.js's buildRollup() once
// per date -- never a second, parallel implementation of the query/shaping
// logic worker.js's scheduled() handler already owns.
//
//   node scripts/backfill-rollup.mjs <from YYYY-MM-DD> <to YYYY-MM-DD>
//
// --- Why this script cannot do anything real in THIS session -----------
//
// Same posture as scripts/abuse-check.mjs's own `--post-deploy` mode (see
// that file's header): this script is CODE-COMPLETE, and its own logic
// (date-range iteration, per-day error isolation) is fully unit-testable
// under plain Node with mocks (see test/backfill-rollup.test.mjs) -- but it
// is only genuinely RUNNABLE for real once the owner has done two things
// this build cannot do:
//
//   1. Created a real `ANALYTICS_READ_TOKEN` + knows the real
//      `CF_ACCOUNT_ID` (docs/runbook.md §1.10) -- exactly like every other
//      source-failure case in this story, buildRollup() degrades to `null`
//      (skip, logged) when these are absent, which they genuinely are in
//      this session (no live Cloudflare account exists here).
//
//   2. A REAL path from a standalone Node process to the live Governor
//      Durable Object's getDailyImageCounts(date) RPC method. This one is
//      more fundamental than a missing credential: Cloudflare Durable
//      Objects have NO public REST API for invoking a method from outside
//      the Workers runtime -- confirmed directly against Cloudflare's own
//      docs (developers.cloudflare.com/durable-objects/best-practices/
//      create-durable-object-stubs-and-send-requests/: "Workers communicate
//      with a Durable Object using remote-procedure call" -- a Worker-to-
//      Worker mechanism, not an account-level HTTP API the way KV/D1/R2/
//      Analytics Engine each have). Unlike (1), this is not something the
//      owner can fix by creating a token -- it needs either a small
//      Worker-side admin route exposing the Governor RPC over HTTP (a new
//      piece of Governor-adjacent surface, deliberately NOT built by this
//      story -- see the Spec Change Log) or a genuinely different backfill
//      mechanism entirely. Recorded in
//      _bmad-output/implementation-artifacts/deferred-work.md.
//
// Because of (2), `governorNotReachableStub()` below always makes
// buildRollup() return `null` for every date when this script is actually
// run today -- honestly, not silently: each day is logged as "skipped" and
// the real reason (a thrown, descriptive error) is what buildRollup's own
// ROLLUP_BUILD_FAILED_EVENT log line carries. This script still writes
// nothing malformed/partial for any day, exactly like every other source
// failure this story defines -- it just means, in this repo's CURRENT
// state, every backfill run skips every day until (2) is resolved by a
// follow-up story.
//
// --- The KV write mechanism (Spec Change Log) ---------------------------
//
// This is a standalone script, not a live Worker -- there is no
// `env.STATE_KV` binding to call `.put()` on. `wrangler kv` is forbidden in
// this build session (the hard "never run wrangler" constraint), so the one
// remaining real option -- per the frozen spec's own Code Map note -- is
// the Cloudflare REST API's own KV-value write endpoint directly:
//   PUT https://api.cloudflare.com/client/v4/accounts/<account_id>/storage/kv/namespaces/<namespace_id>/values/<key_name>
//   Authorization: Bearer <token>, Content-Type: multipart/form-data, a
//   `value` field holding the JSON string.
// (Confirmed directly against Cloudflare's API reference for this
// endpoint, same verification technique this repo's other config/API
// additions use.) This needs its OWN write-scoped token
// (`CF_KV_WRITE_TOKEN` below) -- deliberately a different env var from
// `ANALYTICS_READ_TOKEN`, which is read-only (docs/runbook.md §1.10) and
// must never be asked to also perform a write. Both `CF_KV_WRITE_TOKEN`
// and `CF_ACCOUNT_ID` are genuinely absent in this session -- never
// invented here.

import { pathToFileURL } from "node:url";
import { buildRollup } from "../functions/lib/rollup.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// wrangler.jsonc's own committed STATE_KV namespace id -- not a secret (it
// is already plaintext in that file), just the KV namespace this script's
// writes must target. Kept as a literal here rather than re-parsed out of
// wrangler.jsonc (a JSONC file, so parsing it back out would need a
// comment-stripping step this script has no other reason to carry) --
// if that namespace id is ever rotated, this constant must be updated by
// hand alongside it.
const STATE_KV_NAMESPACE_ID = "54b762d32d854a9bba9604472c4dc93e";

export function isValidDateString(s) {
  if (typeof s !== "string" || !DATE_RE.test(s)) return false;
  const ms = Date.parse(`${s}T00:00:00Z`);
  if (Number.isNaN(ms)) return false;
  // Round-trips back to the same string -- rejects a calendar-invalid date
  // like "2026-02-30" that Date.parse would otherwise silently roll
  // forward into March.
  return new Date(ms).toISOString().slice(0, 10) === s;
}

// Every UTC calendar date from `fromStr` to `toStr`, inclusive, as
// `YYYY-MM-DD` strings. Throws (never returns a partial/garbled range) on
// an invalid date string or an inverted range.
export function dateRangeInclusive(fromStr, toStr) {
  if (!isValidDateString(fromStr) || !isValidDateString(toStr)) {
    throw new Error(`both dates must be well-formed YYYY-MM-DD -- got "${fromStr}" and "${toStr}"`);
  }
  const fromMs = Date.parse(`${fromStr}T00:00:00Z`);
  const toMs = Date.parse(`${toStr}T00:00:00Z`);
  if (fromMs > toMs) {
    throw new Error(`<from> (${fromStr}) must not be after <to> (${toStr})`);
  }
  const dates = [];
  for (let ms = fromMs; ms <= toMs; ms += ONE_DAY_MS) {
    dates.push(new Date(ms).toISOString().slice(0, 10));
  }
  return dates;
}

// Writes one KV value via the Cloudflare REST API (see this file's own
// header for the endpoint shape and why not `wrangler kv`). Throws on any
// non-2xx/network failure -- the caller (runBackfill) is what isolates a
// single day's failure from the rest of the range, not this function.
export async function putKvValue({ fetchFn, accountId, writeToken, namespaceId, key, value }) {
  if (!accountId || !writeToken || !namespaceId) {
    throw new Error("putKvValue: accountId, writeToken, and namespaceId are all required");
  }
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`;
  const form = new FormData();
  form.set("value", value);
  const response = await fetchFn(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${writeToken}` },
    body: form,
  });
  if (!response || response.ok !== true) {
    let detail = "";
    try {
      detail = await response.text();
    } catch {
      // best-effort only
    }
    throw new Error(`KV write for "${key}" failed: ${response ? response.status : "no response"} ${detail}`.trim());
  }
  return true;
}

// The core, fully-mockable backfill loop: for each date, build the rollup
// then (only if it's non-null) write it -- each date wrapped in its own
// try/catch, so one date's build failure OR write failure never stops the
// rest of the range from being attempted (the frozen I/O matrix's own
// "skipping (and reporting) any date whose sources fail rather than
// aborting the whole range"). `buildRollupForDate` already returns `null`
// (never throws) on a source failure per buildRollup()'s own contract;
// the try/catch here exists for `writeRollup`'s own possible throw (a real
// KV write failure) and as defense-in-depth against anything else
// unexpected.
export async function runBackfill({ dates, buildRollupForDate, writeRollup, log = () => {} }) {
  const summary = { written: [], skipped: [], failed: [] };
  for (const date of dates) {
    try {
      const rollup = await buildRollupForDate(date);
      if (rollup === null) {
        summary.skipped.push(date);
        log(`skip ${date} -- a source failed (see the logged event code above)`);
        continue;
      }
      await writeRollup(date, rollup);
      summary.written.push(date);
      log(`ok   ${date} -- wrote rollup:${date}`);
    } catch (error) {
      summary.failed.push(date);
      log(`FAIL ${date} -- ${error && error.message ? error.message : String(error)}`);
    }
  }
  return summary;
}

// See this file's own header, section (2) -- the real, unfixable-by-this-
// script reason every real run currently skips every day: there is no
// standalone-Node path to a real Governor Durable Object RPC.
function governorNotReachableStub() {
  return {
    async getDailyImageCounts() {
      throw new Error(
        "backfill-rollup: no standalone-Node path to the real Governor Durable Object exists today -- " +
          "Durable Objects have no public REST API (only reachable from inside a Worker via its own " +
          "binding). See this script's own header comment and deferred-work.md's Story 8-4 entry."
      );
    },
  };
}

async function runCli(argv) {
  const [fromArg, toArg] = argv;
  if (!fromArg || !toArg) {
    console.error("usage: node scripts/backfill-rollup.mjs <from YYYY-MM-DD> <to YYYY-MM-DD>");
    process.exitCode = 2;
    return;
  }

  let dates;
  try {
    dates = dateRangeInclusive(fromArg, toArg);
  } catch (error) {
    console.error(`backfill-rollup: ${error.message}`);
    process.exitCode = 2;
    return;
  }

  // Genuinely absent in this session -- never invented (hard constraint).
  const accountId = process.env.CF_ACCOUNT_ID;
  const readToken = process.env.ANALYTICS_READ_TOKEN;
  const kvWriteToken = process.env.CF_KV_WRITE_TOKEN;

  const buildRollupForDate = (date) =>
    buildRollup({ fetchFn: fetch, accountId, readToken, governorStub: governorNotReachableStub(), date });

  const writeRollup = (date, rollup) =>
    putKvValue({
      fetchFn: fetch,
      accountId,
      writeToken: kvWriteToken,
      namespaceId: STATE_KV_NAMESPACE_ID,
      key: `rollup:${date}`,
      value: JSON.stringify(rollup),
    });

  console.log(`backfill-rollup: ${dates.length} day(s), ${dates[0]} through ${dates[dates.length - 1]}`);
  const summary = await runBackfill({ dates, buildRollupForDate, writeRollup, log: (line) => console.log(line) });

  console.log(
    `\n${summary.written.length} written, ${summary.skipped.length} skipped (a source failed), ${summary.failed.length} failed (write error) -- of ${dates.length} day(s) total`
  );
  process.exitCode = summary.failed.length > 0 ? 1 : 0;
}

// Only run the real CLI when this file is the actual entry point (`node
// scripts/backfill-rollup.mjs ...`) -- never when it's merely imported for
// its exported functions (test/backfill-rollup.test.mjs does exactly
// that), following run-checks.mjs's own fileURLToPath(import.meta.url)
// self-identification pattern.
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
