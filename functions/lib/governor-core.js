// Spend Governor -- the pure accounting core (Story 7-2, AD-14/AD-22).
//
// This module owns EVERY accounting rule for the Governor Durable Object:
// the reserve/commit/release state machine, the global daily ceiling count,
// the two independent clocks (allowance day / budget day), idempotency by
// reservation id, the providerFailed per-key-per-allowance-day refund, and
// the expiry/cleanup sweep. It has ZERO Cloudflare-specific imports --
// no `cloudflare:workers`, no `ctx`, no `env` -- so it runs unmodified
// under `node --test` against `node:sqlite`'s `DatabaseSync` as well as
// inside the real `Governor` Durable Object against `ctx.storage.sql`. The
// DO wrapper (`functions/lib/governor-do.js` + `functions/governor.js`)
// is the only place that knows anything about a live Durable Object; this
// file never does.
//
// createGovernorCore({ sql, now }):
//   - `sql` is a synchronous adapter: `{ exec(query, ...bindings) -> { rows,
//     changes } }`. `rows` is an array of plain column->value objects;
//     `changes` is the number of rows written by an INSERT/UPDATE/DELETE
//     (unused by this module today, exposed for symmetry / future callers).
//     Both the real DO SQLite API (`ctx.storage.sql.exec(...).toArray()` +
//     `.rowsWritten`) and `node:sqlite`'s `DatabaseSync` (`.prepare(...).all()`
//     / `.run()`) adapt to this shape in a few lines -- see the DO wrapper
//     and the test suite's own adapter, respectively. This module never
//     branches on which backend it's talking to.
//   - `now` is `() => <ms epoch>`. Real code passes `() => Date.now()`;
//     tests inject fixed/stepped instants -- this is the seam that makes
//     the DST/UTC-boundary/60s-expiry scenarios testable without ever
//     waiting on a real clock.
//
// Returns `{ reserve, commit, release, sweepExpired, pruneOld, sweep,
// effectiveAllowanceUsage, getReservation, getDailyOps }`. `reserve`/
// `commit`/`release` are each ONE
// synchronous critical section: no `await`, no suspension point, between
// reading the current count and writing the new row (or the state
// transition). That is the entire concurrency-safety argument -- see the
// spec's Design Notes on the 500-at-ceiling-40 test for why this matters
// and how it's proven.
//
// Scope note (Story 7-2 + Story 7-3): 7-2 shipped ONLY the global ceiling.
// Story 7-3 extends `reserve()` in place with kind-aware fairness rules --
// per-key minimum gaps, a global gap between free grants, per-key daily
// allowances, a free-usage time-sliced share of the ceiling, and an hourly
// mint-rate limit -- all still reading every limit from the `cfg` argument,
// never a literal constant in this file. `commit()`, `release()`, the
// sweep/prune/alarm machinery, the two clocks, and the reservation id
// scheme are all UNCHANGED from Story 7-2; only `reserve()` (plus the
// ceiling/allowance predicate's kind-scoping described below) changed. KV
// config loading, `AI_ENABLED`, and the WAF Kill Switch remain Story 7.4's
// job -- this file still never reads KV, fetches, or awaits non-storage I/O.

const SCHEMA_VERSION = 1;

// A `reserved` row untouched this long is treated as abandoned by the
// alarm sweep (spec I/O matrix: "a `reserved` row untouched for 60
// seconds" expires).
export const EXPIRY_MS = 60 * 1000;

// Rows (any state) older than this are deleted outright by the sweep --
// independent of whether they ever expired/committed/released normally.
export const PRUNE_AGE_MS = 2 * 24 * 60 * 60 * 1000; // 2 days

// Story 7-8 (spec-7-8-quota-defenses.md, AD-23): 60% of the free plan's
// 100,000 Durable-Object rows-written/day ceiling (epic-7-context.md's own
// "Free-plan quota table" line: "Durable Objects 100,000 requests + 100,000
// rows written/day"). Once `daily_ops`'s own running count for today's
// budget day reaches this, `reserve("free", ...)` starts denying `resting`
// -- a self-throttle that trips well before the real platform quota would,
// so free-tier traffic is the first thing to stop, not the Governor itself
// (or subscribers) going dark. `sub`/`restore`/`mint` are never gated by
// this -- see `reserve()`'s own free-branch check below.
export const PLATFORM_ROW_CEILING = 60000;

// Per Design Notes: "compute 'how much is spent against the ceiling for
// budget_day X' via an aggregate query ... not a separately-maintained
// counter that could drift from the rows." See the Spec Change Log entry
// in spec-7-2-governor-core.md for why this literal predicate uses
// `never_called` (matching the frozen Intent's own accounting rule) rather
// than the `provider_failed` predicate the Design Notes' own illustrative
// SQL snippet used -- the frozen "Always" section is unambiguous that a
// providerFailed release (without neverCalled) counts as spent, and this
// query implements exactly that.
//
// Story 7-3: every query that uses this predicate is now ALSO scoped to
// `kind IN ('free', 'sub')` at the call site (see `countSpentForBudgetDay`
// and `effectiveAllowanceUsage` below) -- `restore` and `mint` reservations
// must never count toward the image-spend ceiling or any per-key daily
// allowance, even once `committed` (spec-7-3's frozen "Always" section,
// and Design Notes on why this reaches back into 7-2's own predicate
// rather than being purely additive). This constant itself is unchanged;
// only its callers now add the kind filter alongside it.
const SPENT_PREDICATE = `(
    state IN ('reserved', 'committed', 'expired')
    OR (state = 'released' AND (never_called IS NULL OR never_called = 0))
  )`;

const UTC_DAY_FORMATTER = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" });
const BUCHAREST_DAY_FORMATTER = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Bucharest" });

// `en-CA` formats as `YYYY-MM-DD` -- a well-formed single calendar date in
// the target zone, computed by `Intl.DateTimeFormat`'s own tz-database
// lookup, never a naive UTC+2/+3 offset arithmetic that would get DST
// transitions wrong (spec's explicit "Never a naive UTC+2/+3 offset
// calculation" instruction).
function utcDateString(nowMs) {
  return UTC_DAY_FORMATTER.format(new Date(nowMs));
}
function bucharestDateString(nowMs) {
  return BUCHAREST_DAY_FORMATTER.format(new Date(nowMs));
}

// Idempotent -- safe to call on every `createGovernorCore(...)` (i.e. on
// every fresh Durable Object instantiation), not just the very first one
// ever. `schema_version` exists purely so a later story can detect/migrate
// an older on-disk shape; this story never bumps it past 1.
function ensureSchema(sql) {
  sql.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`);
  const { rows } = sql.exec(`SELECT version FROM schema_version LIMIT 1`);
  if (rows.length === 0) {
    sql.exec(`INSERT INTO schema_version (version) VALUES (?)`, SCHEMA_VERSION);
  }

  sql.exec(`
    CREATE TABLE IF NOT EXISTS reservations (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      key TEXT NOT NULL,
      state TEXT NOT NULL,
      never_called INTEGER NOT NULL DEFAULT 0,
      provider_failed INTEGER NOT NULL DEFAULT 0,
      allowance_refunded INTEGER NOT NULL DEFAULT 0,
      budget_day TEXT NOT NULL,
      allowance_day TEXT NOT NULL,
      reserved_at INTEGER NOT NULL,
      settled_at INTEGER
    )
  `);
  // Three access patterns this module actually runs: the per-budget-day
  // ceiling count, the per-key/allowance-day usage+refund lookups, and the
  // sweep's own state+reserved_at scans.
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_reservations_budget_day ON reservations(budget_day, state)`);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_reservations_key_day ON reservations(key, allowance_day)`);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_reservations_state_reserved_at ON reservations(state, reserved_at)`);

  // Story 7-8: a lightweight running counter approximating "rows written to
  // this Durable Object today" (AD-23's own platform-quota self-throttle) --
  // one row per UTC budget day, bumped by 1 (or by a small batch delta for
  // sweepExpired/pruneOld) inside the SAME synchronous critical section as
  // every real row write this module makes (a reserve grant, commit,
  // release, or a sweep-touched row) -- see bumpDailyOpsAndNotify() below.
  // This is a defensible APPROXIMATION, not exact Cloudflare billing/quota
  // accounting: every operation this file performs writes at least one
  // `reservations` row already, so counting "1 per touched row" tracks that
  // real write 1:1; it does not additionally count the schema/index
  // bootstrap writes above, or this very table's own row updates, as
  // separate "rows written" -- close enough for a self-throttle that only
  // needs to trip meaningfully before the real 100,000/day ceiling, not
  // account for every last row Cloudflare's own billing counts.
  // `notified` records whether notify() has already fired for this budget
  // day's crossing of PLATFORM_ROW_CEILING, so continued grants past the
  // threshold on the same day log the crossing exactly once, not on every
  // subsequent row.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS daily_ops (
      budget_day TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0,
      notified INTEGER NOT NULL DEFAULT 0
    )
  `);
}

// Story 7-3: scoped to `kind IN ('free', 'sub')` -- `restore`/`mint`
// reservations never count toward the global ceiling (see SPENT_PREDICATE's
// own comment above).
function countSpentForBudgetDay(sql, budgetDay) {
  const { rows } = sql.exec(
    `SELECT COUNT(*) AS n FROM reservations WHERE budget_day = ? AND kind IN ('free', 'sub') AND ${SPENT_PREDICATE}`,
    budgetDay
  );
  return rows[0].n;
}

// Story 7-3: the aggregate count of `kind='free'` spend-counting rows for
// the WHOLE budget day (every key, not just one) -- the denominator the
// free-share time-slice cap compares against (see `freeShareCap` and
// `checkFreeShareSlice` below).
function freeUsageForBudgetDay(sql, budgetDay) {
  const { rows } = sql.exec(
    `SELECT COUNT(*) AS n FROM reservations WHERE budget_day = ? AND kind = 'free' AND ${SPENT_PREDICATE}`,
    budgetDay
  );
  return rows[0].n;
}

// Story 7-3: `minGapSec`'s "most recent reservation for this key" lookup.
// State-agnostic (any state at all, not filtered by SPENT_PREDICATE) --
// per the spec's Design Notes, a denied `reserve()` never wrote a row in
// the first place, so there's nothing for a denial to leave behind; every
// row that exists here was, by construction, a real grant.
function mostRecentReservedAt(sql, key) {
  const { rows } = sql.exec(`SELECT MAX(reserved_at) AS t FROM reservations WHERE key = ?`, key);
  return rows[0] && rows[0].t != null ? rows[0].t : null;
}

// Story 7-3: `freeGlobalGapSec`'s "most recent free-kind grant, any key"
// lookup -- same state-agnostic reasoning as `mostRecentReservedAt`.
function mostRecentFreeGrantAt(sql) {
  const { rows } = sql.exec(`SELECT MAX(reserved_at) AS t FROM reservations WHERE kind = 'free'`);
  return rows[0] && rows[0].t != null ? rows[0].t : null;
}

// Story 7-3: `mintPerHour`'s trailing-hour count. The one-hour window is
// inherent to "mintPerHour"'s own definition (like EXPIRY_MS/PRUNE_AGE_MS,
// a fixed reservation-lifecycle-shaped constant, not a tunable limit sourced
// from cfg) -- only the numeric cap itself comes from `cfg.mintPerHour`.
const MINT_WINDOW_MS = 60 * 60 * 1000;
function mintCountTrailingHour(sql, nowMs) {
  const cutoff = nowMs - MINT_WINDOW_MS;
  const { rows } = sql.exec(`SELECT COUNT(*) AS n FROM reservations WHERE kind = 'mint' AND reserved_at > ?`, cutoff);
  return rows[0].n;
}

// Story 7-3: the free-usage time-slice cap, precisely per the spec's Design
// Notes -- `freeShare = ceiling * reserveShare`; the UTC day split into
// `freeSlices` equal slices; `currentSlice` 0-indexed; the cap is
// CUMULATIVE (`Math.floor(freeShare * (currentSlice + 1) / freeSlices)`),
// growing through the day and reaching exactly `freeShare` at the start of
// the final slice -- never a per-slice-reset bucket. `nowMs % MS_PER_DAY`
// is used directly for "ms into the UTC day" rather than constructing a
// `Date` and subtracting midnight -- valid because the epoch itself starts
// at a UTC day boundary and every UTC day is exactly 86,400,000ms (no leap
// seconds in this arithmetic), so this is exact, not an approximation.
//
// `freeSlices` is treated as an integer SLICE COUNT (floored) and
// `reserveShare` is clamped to `[0, 1]` -- both Story 7-3 review findings.
// `freeSlices` is conceptually a count of equal time buckets: a fractional
// value (e.g. `2.5`) let `currentSlice` range up to `ceil(freeSlices) - 1`
// while the formula divided by the un-floored `freeSlices`, so
// `(currentSlice + 1) / freeSlices` could exceed 1 and the cap could
// overshoot `freeShare` by a material margin (confirmed by direct
// execution: `freeSlices:2.5` let the late-day cap reach 60 against an
// intended `freeShare` of 50 -- a 20% overshoot of the configured free
// share, silently, with no error). Flooring first (and clamping
// `currentSlice` to `slices - 1` as a second line of defense against any
// residual floating-point edge at the last instant of the day) restores
// the invariant "the cap never exceeds `freeShare`" unconditionally.
// `reserveShare` has no natural upper bound enforced elsewhere -- an
// unclamped `reserveShare > 1` (a plausible config typo, e.g. `150` meant
// as a percentage, or `1.5` meant as `0.5`) would let `freeShare` exceed
// the ceiling itself, silently defeating this whole story's purpose (the
// hard hard `checkCeiling` step still bounds total spend, but free traffic
// alone could then consume the entire ceiling, leaving zero headroom for
// subscribers -- exactly the fairness failure this story exists to
// prevent). Clamping here is cheap, unconditionally correct, and doesn't
// depend on Story 7.4's own config validation ever landing.
const MS_PER_DAY = 24 * 60 * 60 * 1000;
function freeShareCap(nowMs, ceiling, reserveShare, freeSlices) {
  const share = Math.min(1, Math.max(0, reserveShare));
  const freeShare = ceiling * share;
  const slices = Math.max(1, Math.floor(freeSlices));
  const msIntoUtcDay = ((nowMs % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY;
  const sliceLengthMs = MS_PER_DAY / slices;
  const currentSlice = Math.min(slices - 1, Math.floor(msIntoUtcDay / sliceLengthMs));
  return Math.floor((freeShare * (currentSlice + 1)) / slices);
}

// Story 7-3: reads a `cfg` field as a fairness limit, returning `null`
// (meaning "not configured -- skip this check, unrestricted") for anything
// that isn't a finite number >= 0. This is a DELIBERATE asymmetry from
// `cfg.ceiling`'s own long-standing fail-closed behavior below (missing/
// invalid ceiling denies) -- see the Spec Change Log entry in
// spec-7-3-free-vs-subscriber-fairness.md for why: Story 7-2's entire
// existing test suite calls `reserve("free", key, { ceiling: N })` with
// NONE of these new fields ever set, and that suite's outcomes must stay
// unmodified. An absent new-limit field is therefore treated as "this
// particular knob isn't configured yet," not "config is broken" -- it does
// not restrict the call, exactly like the field never existing before this
// story. `cfg.ceiling` itself is untouched from Story 7-2 and keeps its own
// original fail-closed semantics unconditionally.
function readFairnessLimit(cfg, field) {
  const v = cfg && typeof cfg[field] === "number" ? cfg[field] : NaN;
  return Number.isFinite(v) && v >= 0 ? v : null;
}

// Story 7-3, `free`/`sub`/`restore` step 1: deny `wait` (with
// `retryAfterSeconds`) if this key's own most recent reservation (any
// state) was less than `minGapSec` ago.
function checkMinGap(sql, nowMs, key, cfg) {
  const minGapSec = readFairnessLimit(cfg, "minGapSec");
  if (minGapSec === null) return null;
  const lastAt = mostRecentReservedAt(sql, key);
  if (lastAt == null) return null;
  const gapMs = minGapSec * 1000;
  const elapsed = nowMs - lastAt;
  if (elapsed < gapMs) {
    return { ok: false, denied: "wait", retryAfterSeconds: Math.ceil((gapMs - elapsed) / 1000) };
  }
  return null;
}

// Story 7-3, `free` step 2: deny `wait` if ANY key's most recent `free`
// grant was less than `freeGlobalGapSec` ago -- a cross-device throttle on
// top of `minGapSec`'s per-key one.
function checkFreeGlobalGap(sql, nowMs, cfg) {
  const gapSec = readFairnessLimit(cfg, "freeGlobalGapSec");
  if (gapSec === null) return null;
  const lastAt = mostRecentFreeGrantAt(sql);
  if (lastAt == null) return null;
  const gapMs = gapSec * 1000;
  const elapsed = nowMs - lastAt;
  if (elapsed < gapMs) {
    return { ok: false, denied: "wait", retryAfterSeconds: Math.ceil((gapMs - elapsed) / 1000) };
  }
  return null;
}

// Story 7-3, `free` step 3 / `sub` step 2: deny `daily_limit` once this
// key's `effectiveAllowanceUsage` for today's allowance day reaches
// `cfg[field]` (`freeDaily` for `free`, `subscriberDaily` for `sub`).
function checkDailyAllowance(sql, key, allowanceDay, cfg, field) {
  const limit = readFairnessLimit(cfg, field);
  if (limit === null) return null;
  const usage = effectiveAllowanceUsage(sql, key, allowanceDay);
  if (usage >= limit) {
    return { ok: false, denied: "daily_limit" };
  }
  return null;
}

// Story 7-3, `free` step 4: deny `resting` once today's aggregate `free`
// usage reaches the free-share time-slice cap (`freeShareCap` above).
// Requires `ceiling`, `reserveShare`, AND `freeSlices` all to be usable
// numbers -- if any is missing/invalid, this check is skipped entirely
// (same "absent = unconfigured, not broken" policy as `readFairnessLimit`)
// and the overall ceiling check (step 5) remains the only free-tier gate,
// which is itself still fail-closed on a missing/invalid ceiling.
function checkFreeShareSlice(sql, nowMs, budgetDay, cfg) {
  const ceiling = readFairnessLimit(cfg, "ceiling");
  const reserveShare = readFairnessLimit(cfg, "reserveShare");
  const freeSlices = readFairnessLimit(cfg, "freeSlices");
  if (ceiling === null || reserveShare === null || freeSlices === null || freeSlices <= 0) {
    return null;
  }
  const cap = freeShareCap(nowMs, ceiling, reserveShare, freeSlices);
  const usage = freeUsageForBudgetDay(sql, budgetDay);
  if (usage >= cap) {
    return { ok: false, denied: "resting" };
  }
  return null;
}

// Story 7-2's original ceiling check, unchanged in its own logic (still
// fail-closed on a missing/non-numeric/negative `cfg.ceiling` -- AD-14:
// "a failure anywhere in cost control must silently deny, never silently
// allow, spend"). Story 7-3 only relocates it into this shared helper so
// both the `free` (step 5, defense-in-depth) and `sub` (step 3) branches
// can call it, and its own `countSpentForBudgetDay` query is now scoped to
// `kind IN ('free', 'sub')` (see that function's comment).
function checkCeiling(sql, budgetDay, cfg) {
  const ceiling = cfg && typeof cfg.ceiling === "number" ? cfg.ceiling : NaN;
  if (!Number.isFinite(ceiling) || ceiling < 0) {
    return { ok: false, denied: "resting" };
  }
  const spent = countSpentForBudgetDay(sql, budgetDay);
  if (spent >= ceiling) {
    return { ok: false, denied: "resting" };
  }
  return null;
}

// Story 7-3, `mint`'s only check: deny `rate_limited` once the trailing-hour
// `kind='mint'` count reaches `cfg.mintPerHour`.
function checkMintRateLimit(sql, nowMs, cfg) {
  const mintPerHour = readFairnessLimit(cfg, "mintPerHour");
  if (mintPerHour === null) return null;
  const count = mintCountTrailingHour(sql, nowMs);
  if (count >= mintPerHour) {
    return { ok: false, denied: "rate_limited" };
  }
  return null;
}

// Story 7-8: reads today's `daily_ops` row for `budgetDay`, or `{count: 0,
// notified: 0}` if this budget day has never been touched yet. Exported (and
// wired into createGovernorCore's returned object below) as a
// getReservation()-style direct-read helper for tests -- see that function's
// own comment for the parallel.
export function getDailyOps(sql, budgetDay) {
  const { rows } = sql.exec(`SELECT count, notified FROM daily_ops WHERE budget_day = ?`, budgetDay);
  return rows[0] || { count: 0, notified: 0 };
}

// The Story 7-8 placeholder Epic 8's real Analytics Engine wiring will
// eventually replace the body of -- today this just logs one fixed event
// code, exactly as the frozen Design Notes specify
// (`console.error("governor_platform_quota_60pct", budgetDay)`), so the
// crossing is at least visible in `wrangler tail`/the dashboard's own
// console output until that story lands.
export function notify(budgetDay) {
  console.error("governor_platform_quota_60pct", budgetDay);
}

// Story 7-8: bumps `daily_ops`'s row for `budgetDay` by `delta` (a plain
// UPSERT -- insert `delta` as the starting count if this budget day has no
// row yet, otherwise add `delta` to the existing count) and, the FIRST time
// this crosses PLATFORM_ROW_CEILING for this budget day (tracked by the
// row's own `notified` flag, so a DO restart never re-fires a notification
// that already happened, and every subsequent grant that budget day is a
// no-op here), calls notify(). A no-op (delta <= 0) never touches the table
// at all -- sweepExpired()/pruneOld() call this only when they actually
// touched at least one row. Every statement here is a plain synchronous
// `sql.exec` call, so this introduces no `await`/suspension point into
// whichever of reserve()/commit()/release() calls it -- the same zero-await
// guarantee Story 7-2's own header comment describes.
function bumpDailyOpsAndNotify(sql, budgetDay, delta) {
  if (!(delta > 0)) return;
  sql.exec(
    `INSERT INTO daily_ops (budget_day, count, notified) VALUES (?, ?, 0)
       ON CONFLICT(budget_day) DO UPDATE SET count = count + excluded.count`,
    budgetDay,
    delta
  );
  const row = getDailyOps(sql, budgetDay);
  if (row.count >= PLATFORM_ROW_CEILING && !row.notified) {
    sql.exec(`UPDATE daily_ops SET notified = 1 WHERE budget_day = ?`, budgetDay);
    notify(budgetDay);
  }
}

// Story 7-8, `free` step 6 (after the existing ceiling check, defense-in-
// depth style, same position as checkCeiling occupies for `sub`): deny
// `resting` once today's `daily_ops` count has already reached
// PLATFORM_ROW_CEILING -- checked READ-ONLY here (never incremented by this
// function itself; only a granted reserve's own bumpDailyOpsAndNotify call,
// below, ever increments it). `sub`/`restore`/`mint` never call this.
function checkPlatformQuota(sql, budgetDay) {
  const row = getDailyOps(sql, budgetDay);
  if (row.count >= PLATFORM_ROW_CEILING) {
    return { ok: false, denied: "resting" };
  }
  return null;
}

// `reserve` is the one function whose atomicity the entire story exists to
// prove: decide (via the kind-appropriate chain of checks below) and --
// with NO await, no suspension point, anywhere in that decision -- either
// deny (zero rows written) or insert exactly one new `reserved` row. In the
// real Durable Object this makes concurrent `reserve` calls safe: the
// isolate runs this function to completion before another invocation's JS
// can run at all (see the spec's Design Notes on the 500-concurrent-at-
// ceiling-40 test). Every check function above is itself a plain
// synchronous `sql.exec` call or two -- no new suspension point is
// introduced by Story 7-3's kind-branching.
//
// `cfg` is whatever object the caller passes in. Story 7-2 only read
// `cfg.ceiling`; Story 7-3 adds `reserveShare`, `freeSlices`, `minGapSec`,
// `freeGlobalGapSec`, `freeDaily`, `subscriberDaily`, and `mintPerHour`,
// each read fresh from `cfg` inside the check functions above -- nothing
// here is a hard-coded literal. `cfg.ceiling` keeps its original Story 7-2
// fail-closed behavior; the new limits are each skipped (unrestricted) when
// absent/invalid rather than fail-closed -- see `readFairnessLimit`'s own
// comment for why, and the Spec Change Log for the full reasoning.
//
// Per-kind order (spec-7-3's Design Notes, "Ask First" precedence, built
// as proposed):
//   `free`:    minGapSec -> freeGlobalGapSec -> freeDaily -> free-share
//              slice cap -> ceiling (defense-in-depth).
//   `sub`:     minGapSec -> subscriberDaily -> ceiling. Never gated by
//              reserveShare/freeSlices/freeGlobalGapSec.
//   `restore`: minGapSec only. No ceiling, no daily allowance, no
//              free-share check at all.
//   `mint`:    mintPerHour (trailing-hour count) only. Excluded from the
//              ceiling and every other check. All `mint` reservations share
//              one fixed literal key ("mint") regardless of what the caller
//              passes -- there is no real per-device key yet at mint time
//              (spec's Design Notes) -- so the key-space stays well-formed
//              without every mint call site needing to know this
//              convention.
export function reserve(sql, now, kind, key, cfg) {
  const safeCfg = cfg && typeof cfg === "object" ? cfg : {};
  const normalizedKind = typeof kind === "string" ? kind : "";

  let effectiveKey;
  if (normalizedKind === "mint") {
    effectiveKey = "mint";
  } else {
    if (typeof key !== "string" || !key) {
      return { ok: false, denied: "resting" };
    }
    effectiveKey = key;
  }

  const nowMs = now();
  const budgetDay = utcDateString(nowMs);
  const allowanceDay = bucharestDateString(nowMs);

  let denial;
  if (normalizedKind === "free") {
    denial =
      checkMinGap(sql, nowMs, effectiveKey, safeCfg) ||
      checkFreeGlobalGap(sql, nowMs, safeCfg) ||
      checkDailyAllowance(sql, effectiveKey, allowanceDay, safeCfg, "freeDaily") ||
      checkFreeShareSlice(sql, nowMs, budgetDay, safeCfg) ||
      checkCeiling(sql, budgetDay, safeCfg) ||
      checkPlatformQuota(sql, budgetDay);
  } else if (normalizedKind === "sub") {
    denial =
      checkMinGap(sql, nowMs, effectiveKey, safeCfg) ||
      checkDailyAllowance(sql, effectiveKey, allowanceDay, safeCfg, "subscriberDaily") ||
      checkCeiling(sql, budgetDay, safeCfg);
  } else if (normalizedKind === "restore") {
    denial = checkMinGap(sql, nowMs, effectiveKey, safeCfg);
  } else if (normalizedKind === "mint") {
    denial = checkMintRateLimit(sql, nowMs, safeCfg);
  } else {
    // An unrecognized kind: fail closed rather than silently accepting an
    // uncontrolled kind value into the ledger. Not exercised by any real
    // caller today (the only four kinds the rest of this epic ever passes
    // are free/sub/restore/mint) and not part of the frozen I/O matrix --
    // a defensive default consistent with this file's overall fail-closed
    // discipline, called out explicitly in this story's report.
    denial = { ok: false, denied: "resting" };
  }

  if (denial) {
    return denial;
  }

  const id = crypto.randomUUID();
  sql.exec(
    `INSERT INTO reservations
       (id, kind, key, state, never_called, provider_failed, allowance_refunded, budget_day, allowance_day, reserved_at, settled_at)
     VALUES (?, ?, ?, 'reserved', 0, 0, 0, ?, ?, ?, NULL)`,
    id,
    normalizedKind,
    effectiveKey,
    budgetDay,
    allowanceDay,
    nowMs
  );

  // Story 7-8: one real row was just written above -- count it toward
  // today's rows-written estimate, in the same synchronous critical section.
  bumpDailyOpsAndNotify(sql, budgetDay, 1);

  return { ok: true, id, budgetDay, allowanceDay, reservedAt: nowMs, alarmAt: nowMs + EXPIRY_MS };
}

function getReservation(sql, id) {
  const { rows } = sql.exec(`SELECT * FROM reservations WHERE id = ?`, id);
  return rows[0] || null;
}

// Idempotent by id: a second `commit` on an already-`committed` row is a
// no-op (still committed, no throw). A `commit` on a row already settled
// some OTHER way (`released`/`expired`) is also a no-op in the
// "already-settled" sense -- it must never un-expire/un-release a row or
// double-count it toward the ceiling, so it simply reports the row's
// actual current state instead of transitioning anything.
export function commit(sql, now, id) {
  // Same id-type guard as `release()` -- see that function's comment for
  // why (Story 7-2 review finding).
  if (typeof id !== "string" || !id) {
    return { ok: false, error: "not_found" };
  }
  const row = getReservation(sql, id);
  if (!row) {
    return { ok: false, error: "not_found" };
  }
  if (row.state !== "reserved") {
    return { ok: true, id, state: row.state, idempotent: true };
  }

  const nowMs = now();
  sql.exec(`UPDATE reservations SET state = 'committed', settled_at = ? WHERE id = ? AND state = 'reserved'`, nowMs, id);
  // Story 7-8: a real row transition just happened above -- count it toward
  // today's rows-written estimate (today's budget day, from `nowMs` itself,
  // not the reservation's own possibly-earlier-UTC-day `budget_day`).
  bumpDailyOpsAndNotify(sql, utcDateString(nowMs), 1);
  return { ok: true, id, state: "committed" };
}

// Idempotent by id, same "already-settled is a no-op" rule as `commit`.
// Only a transition OUT of `reserved` sets flags/refunds -- a row that's
// already `committed`/`released`/`expired` never has its flags revisited,
// which is what makes "a second providerFailed release for the same
// (key, allowance_day) does not grant a second refund" true even if a
// caller mistakenly calls `release` twice on the same id: the second call
// hits the `row.state !== "reserved"` branch and changes nothing.
//
// `opts.neverCalled` is the ONLY thing that exempts a release from the
// global ceiling count (frozen Intent, "Always" section) -- `providerFailed`
// alone still counts as spent for the ceiling; it only affects the
// separate per-key allowance-day refund below.
//
// `id` is type-checked before any query -- an id that isn't a non-empty
// string (undefined, null, a number, an object/array) returns the same
// `{ok:false, error:"not_found"}` an unknown-but-well-typed id gets, rather
// than reaching the SQL adapter and throwing a bind-parameter TypeError
// uncaught (Story 7-2 review finding: a caller that does
// `commit(reserveResult.id)` without first checking `.ok` passes `undefined`
// straight through, since a denied reserve()'s result has no `id` field at
// all -- this must degrade gracefully, not crash the request).
//
// `opts` is defensively normalized to `{}` for anything that isn't a plain
// object -- the default parameter `opts = {}` only covers `undefined`, so
// `release(id, null)` (a realistic call shape, e.g. `release(id, failed ?
// {providerFailed:true} : null)`) would otherwise throw on `null.neverCalled`
// before `getReservation` even runs (Story 7-2 review finding).
export function release(sql, now, id, opts = {}) {
  if (typeof id !== "string" || !id) {
    return { ok: false, error: "not_found" };
  }
  const safeOpts = opts && typeof opts === "object" ? opts : {};
  const neverCalled = !!safeOpts.neverCalled;
  const providerFailed = !!safeOpts.providerFailed;

  const row = getReservation(sql, id);
  if (!row) {
    return { ok: false, error: "not_found" };
  }
  if (row.state !== "reserved") {
    return { ok: true, id, state: row.state, idempotent: true };
  }

  const nowMs = now();

  // At most one `allowance_refunded = 1` row per (key, allowance_day) --
  // checked and decided inside this same synchronous critical section, so
  // two concurrent providerFailed releases for the same key/day can't both
  // see "no refund yet" and both grant one.
  //
  // `&& !neverCalled`: a row released with BOTH flags set together is a
  // malformed/inconsistent call (semantically, "the provider was never
  // called" and "the provider failed" are mutually exclusive -- Story 7-5's
  // real caller never sends both), but nothing enforces that at the type
  // level, so this function must still behave sensibly if it happens. A
  // `neverCalled` row is already fully excluded from `SPENT_PREDICATE` --
  // it never counted as usage in the first place -- so it must not ALSO be
  // allowed to consume the key's one-refund-per-allowance-day slot; doing
  // so would silently steal that slot from a later, genuinely-failed
  // reservation on the same key/day (Story 7-2 review finding, confirmed by
  // direct execution: 3 ordinary commits showed usage=3, and a
  // {neverCalled:true, providerFailed:true} release on a 4th reservation
  // incorrectly dropped it to 2 before this guard was added).
  // Story 7-3 review finding (found independently by two lenses): this
  // query MUST be scoped to `kind IN ('free','sub')`, matching
  // `effectiveAllowanceUsage`'s own scoping just below -- without it, a
  // `restore`/`mint` reservation that happens to share a `key`/
  // `allowance_day` with a `free`/`sub` one could consume (or be
  // mistaken for already consuming) that key's one-refund-per-day slot,
  // silently denying a genuinely-failed free/sub reservation its earned
  // refund. Unreachable today given the real key-spaces in use (`mint`'s
  // forced literal key, a real device-token/subscription-id format), but
  // nothing enforces that a future story's choice of `restore` key can
  // never collide -- scoping this now closes the whole class regardless
  // of what key Story 7.8 ends up choosing.
  let allowanceRefunded = false;
  if (providerFailed && !neverCalled) {
    const { rows: existingRefund } = sql.exec(
      `SELECT 1 FROM reservations WHERE key = ? AND allowance_day = ? AND kind IN ('free', 'sub') AND allowance_refunded = 1 LIMIT 1`,
      row.key,
      row.allowance_day
    );
    allowanceRefunded = existingRefund.length === 0;
  }

  sql.exec(
    `UPDATE reservations
        SET state = 'released', never_called = ?, provider_failed = ?, allowance_refunded = ?, settled_at = ?
      WHERE id = ? AND state = 'reserved'`,
    neverCalled ? 1 : 0,
    providerFailed ? 1 : 0,
    allowanceRefunded ? 1 : 0,
    nowMs,
    id
  );

  // Story 7-8: same reasoning as commit()'s own comment above -- count
  // today's real row transition, keyed by today's own budget day.
  bumpDailyOpsAndNotify(sql, utcDateString(nowMs), 1);

  return { ok: true, id, state: "released", neverCalled, providerFailed, allowanceRefunded };
}

// Expires every `reserved` row whose `reserved_at` is at least EXPIRY_MS in
// the past (relative to the injected `nowMs`, never a "today" read of the
// clock). Returns the array of expired ids. The `AND state = 'reserved'`
// guard on the UPDATE makes this safe to call more than once for the same
// sweep pass without double-transitioning anything.
export function sweepExpired(sql, nowMs) {
  const cutoff = nowMs - EXPIRY_MS;
  const { rows } = sql.exec(`SELECT id FROM reservations WHERE state = 'reserved' AND reserved_at <= ?`, cutoff);
  for (const { id } of rows) {
    sql.exec(`UPDATE reservations SET state = 'expired', settled_at = ? WHERE id = ? AND state = 'reserved'`, nowMs, id);
  }
  // Story 7-8: each expired row is a real row transition -- count the whole
  // batch (today's budget day, from `nowMs`) in one bump, a no-op when
  // nothing expired this sweep.
  bumpDailyOpsAndNotify(sql, utcDateString(nowMs), rows.length);
  return rows.map((r) => r.id);
}

// Deletes every row (any state) whose `reserved_at` is more than
// PRUNE_AGE_MS in the past. Returns the number of rows deleted.
export function pruneOld(sql, nowMs) {
  const cutoff = nowMs - PRUNE_AGE_MS;
  const { rows } = sql.exec(`SELECT id FROM reservations WHERE reserved_at <= ?`, cutoff);
  if (rows.length === 0) return 0;
  sql.exec(`DELETE FROM reservations WHERE reserved_at <= ?`, cutoff);
  // Story 7-8: each pruned row is a real row deletion -- count the whole
  // batch (today's budget day, from `nowMs`) in one bump.
  bumpDailyOpsAndNotify(sql, utcDateString(nowMs), rows.length);
  return rows.length;
}

// The earliest instant the alarm should next fire: the soonest pending
// `reserved` row's own expiry, or -- if nothing is currently `reserved` --
// the soonest instant any remaining row (whatever its state) becomes
// eligible for the 2-day prune, i.e. "the next 2-day cleanup horizon" the
// spec's I/O matrix describes. `null` only when the table holds no rows at
// all (a brand new Governor that has never taken a reservation) -- the DO
// wrapper's `alarm()` treats that as "nothing to re-arm for" and leaves the
// alarm unset until the next `reserve()` arms it again.
function computeNextAlarmAt(sql) {
  const { rows: reservedRows } = sql.exec(`SELECT MIN(reserved_at) AS t FROM reservations WHERE state = 'reserved'`);
  const minReservedAt = reservedRows[0] && reservedRows[0].t;
  const nextExpiry = minReservedAt != null ? minReservedAt + EXPIRY_MS : null;

  const { rows: anyRows } = sql.exec(`SELECT MIN(reserved_at) AS t FROM reservations`);
  const minAnyReservedAt = anyRows[0] && anyRows[0].t;
  const nextPruneHorizon = minAnyReservedAt != null ? minAnyReservedAt + PRUNE_AGE_MS : null;

  const candidates = [nextExpiry, nextPruneHorizon].filter((t) => t != null);
  if (candidates.length === 0) return null;
  return Math.min(...candidates);
}

// The one function the alarm handler calls: expires timed-out reservations,
// prunes 2-day-old rows, and reports when it should next be re-armed. Never
// throws for ordinary conditions (an empty table, nothing expired) -- a
// thrown error here means a genuine adapter/storage failure, which is the
// DO wrapper's job to catch and still reschedule from (see
// functions/lib/governor-do.js).
export function sweep(sql, nowMs) {
  const expiredIds = sweepExpired(sql, nowMs);
  const prunedCount = pruneOld(sql, nowMs);
  const nextAlarmAt = computeNextAlarmAt(sql);
  return { expiredIds, prunedCount, nextAlarmAt };
}

// "Effective usage for this key this allowance day" (Design Notes): the
// count of spent-counting rows for (key, allowance_day), minus 1 if any row
// for that key/day carries the refund, clamped at 0. Story 7-2 built this
// helper but never called it from `reserve()`; Story 7-3's `free`/`sub`
// daily-allowance checks (`checkDailyAllowance` above) are its first real
// caller. Both queries below are scoped to `kind IN ('free', 'sub')`
// (Story 7-3) -- a `restore` or `mint` reservation sharing the same `key`
// string (plausible: a device id used for both a free Image reservation and
// a restore-attempt reservation) must never inflate, or ever be able to
// exhaust, that key's own freeDaily/subscriberDaily allowance.
export function effectiveAllowanceUsage(sql, key, allowanceDay) {
  const { rows: spentRows } = sql.exec(
    `SELECT COUNT(*) AS n FROM reservations WHERE key = ? AND allowance_day = ? AND kind IN ('free', 'sub') AND ${SPENT_PREDICATE}`,
    key,
    allowanceDay
  );
  const spentCount = spentRows[0].n;

  const { rows: refundRows } = sql.exec(
    `SELECT COUNT(*) AS n FROM reservations WHERE key = ? AND allowance_day = ? AND kind IN ('free', 'sub') AND allowance_refunded = 1`,
    key,
    allowanceDay
  );
  const refunded = refundRows[0].n > 0 ? 1 : 0;

  return Math.max(0, spentCount - refunded);
}

// Story 8-4: ONE new additive, read-only export -- the daily image-SPEND
// counts by kind, for the given UTC `budgetDay`, reusing SPENT_PREDICATE
// completely UNCHANGED (the exact same "what counts as spent" rule
// countSpentForBudgetDay/effectiveAllowanceUsage already use -- see that
// constant's own comment). This is the one place the free/sub kind split
// already exists in this app (functions/lib/rollup.js's own header
// explains why the daily rollup reads it from here rather than inventing a
// second, parallel accounting rule). Never called by reserve()/commit()/
// release()/sweep -- a pure read, added alongside those functions, not
// into them.
//
// SQL GROUP BY only returns rows for kinds that actually have at least one
// spend-counting row for this budget day -- a kind with zero rows simply
// never appears, so both `free` and `sub` are defaulted to 0 here before
// the query's rows (if any) overwrite them, rather than leaving either key
// undefined when that kind happened to have no spend that day.
export function getDailyImageCounts(sql, budgetDay) {
  const { rows } = sql.exec(
    `SELECT kind, COUNT(*) AS n FROM reservations WHERE budget_day = ? AND kind IN ('free', 'sub') AND ${SPENT_PREDICATE} GROUP BY kind`,
    budgetDay
  );
  const counts = { free: 0, sub: 0 };
  for (const row of rows) {
    if (row.kind === "free" || row.kind === "sub") {
      counts[row.kind] = row.n;
    }
  }
  return { free: counts.free, sub: counts.sub, imagesTotal: counts.free + counts.sub };
}

export function createGovernorCore({ sql, now }) {
  if (!sql || typeof sql.exec !== "function") {
    throw new Error("createGovernorCore: sql.exec is required");
  }
  if (typeof now !== "function") {
    throw new Error("createGovernorCore: now is required");
  }

  ensureSchema(sql);

  return {
    reserve: (kind, key, cfg) => reserve(sql, now, kind, key, cfg),
    commit: (id) => commit(sql, now, id),
    release: (id, opts) => release(sql, now, id, opts),
    sweepExpired: (atMs) => sweepExpired(sql, atMs != null ? atMs : now()),
    pruneOld: (atMs) => pruneOld(sql, atMs != null ? atMs : now()),
    sweep: (atMs) => sweep(sql, atMs != null ? atMs : now()),
    effectiveAllowanceUsage: (key, allowanceDay) => effectiveAllowanceUsage(sql, key, allowanceDay),
    // Exposed for tests/diagnostics that need to read a row's own stored
    // days/state directly rather than inferring them indirectly.
    getReservation: (id) => getReservation(sql, id),
    // Story 7-8: same "direct-read helper" reasoning as getReservation()
    // above -- lets a test read (or, via the raw `sql`/`adapter` a test
    // already has direct access to, seed) daily_ops's own count/notified
    // state for a given budget day without driving PLATFORM_ROW_CEILING
    // worth of real reserve() calls just to set up a scenario.
    getDailyOps: (budgetDay) => getDailyOps(sql, budgetDay),
    // Story 8-4: same "direct-read helper" shape as getDailyOps above --
    // see getDailyImageCounts()'s own comment for what it reads and why.
    getDailyImageCounts: (budgetDay) => getDailyImageCounts(sql, budgetDay),
  };
}
