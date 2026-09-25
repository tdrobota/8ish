// Governor config loading + validation (Story 7-4, AD-14/AD-20).
//
// This module is the ONLY place Story 7.5's future caller will ask "what are
// today's Governor limits, and is Image spend even allowed right now?" It
// owns the three-layer Kill Switch design the frozen spec's Design Notes
// describe:
//
//   1. `env.AI_ENABLED` -- the Worker var, the emergency Kill Switch. Checked
//      FIRST, before any KV I/O, so disabling it costs zero calls and takes
//      effect the moment a new isolate picks up the changed var (Cloudflare's
//      own "acts within seconds" characterization -- this file cannot make
//      that faster, only avoid adding its own latency on top).
//   2. A small in-isolate cache (`{value, cachedAt}`, module-level), checked
//      against an injected `now()` so tests never wait on a real clock.
//   3. `env.STATE_KV.get("cfg:governor", {type:"json", cacheTtl:30})` --
//      Cloudflare's own edge cache for that read, plus the in-isolate cache
//      layer on top of it (belt-and-suspenders, per the Design Notes: neither
//      alone is guaranteed to be exactly 30s in practice, but both bound it
//      to roughly that order).
//
// `validateGovernorConfig` is a pure function -- no I/O, no `env`, no clock
// -- so it can be (and is) unit-tested directly and thoroughly, independent
// of everything above. `loadGovernorConfig` is the only async/impure piece.
//
// Both functions return the SAME shape on failure -- `{ ok: false }` -- so a
// future caller (Story 7.5) can check `.ok` uniformly regardless of which of
// the three layers actually failed: an unreadable KV value, an invalid/
// partial config, `AI_ENABLED` disabled, or a thrown KV read. Fail closed,
// always (frozen Intent: "any invalid, partial, or unreadable state answers
// 'resting,' never a silent grant").
//
// Per the frozen "Always" section, validation is all-or-nothing: every field
// must be present and correctly typed, or the whole object is rejected --
// never a partially-valid config with some fields silently defaulted. This
// is the guarantee Story 7-3's own fairness checks (governor-core.js's
// `readFairnessLimit`) explicitly assumed but do not themselves enforce --
// see that file's header comment and spec-7-3's Spec Change Log for the gap
// this closes.

// Matches config/governor.json's own field list exactly -- the committed
// default config is expected to satisfy this same validator (frozen I/O
// matrix's last row).
const REQUIRED_NUMBER_FIELDS_GTE_ZERO = ["minGapSec", "freeGlobalGapSec", "freeDaily", "subscriberDaily", "mintPerHour"];

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

// Pure, no I/O. Takes whatever value came out of KV (already JSON-parsed by
// `env.STATE_KV.get(key, {type:"json"})`, or `null`/malformed/anything else
// a real KV outage or a hand-edited value could produce) and returns
// `{ok:true, cfg}` only when EVERY field below is present and correctly
// typed. Any single missing or wrong-typed field rejects the ENTIRE object
// -- this function never returns a partially-populated `cfg`.
export function validateGovernorConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false };
  }

  const { ceiling, reserveShare, freeSlices, aiEnabled } = raw;

  // `ceiling`: finite number >= 0 (matches governor-core.js's own long-
  // standing fail-closed `checkCeiling` semantics for this field).
  if (!isFiniteNumber(ceiling) || ceiling < 0) {
    return { ok: false };
  }

  // `reserveShare`: finite number in [0, 1]. governor-core.js's own
  // `freeShareCap` clamps this defensively too (belt-and-suspenders against
  // a stray unvalidated caller), but this validator is what should catch a
  // misconfigured value before it ever reaches that code path in practice.
  if (!isFiniteNumber(reserveShare) || reserveShare < 0 || reserveShare > 1) {
    return { ok: false };
  }

  // `freeSlices`: a positive integer (a fractional or zero/negative slice
  // count is exactly the misconfiguration spec-7-3's own review flagged as
  // able to silently overshoot the free share -- see governor-core.js's
  // `freeShareCap` comment). This validator rejects it outright rather than
  // relying solely on that file's own defensive flooring/clamping.
  if (!isFiniteNumber(freeSlices) || !Number.isInteger(freeSlices) || freeSlices <= 0) {
    return { ok: false };
  }

  // The five remaining numeric limits: each a finite number >= 0. Missing or
  // wrong-typed rejects the whole config (unlike governor-core.js's own
  // `readFairnessLimit`, which treats an absent NEW-limit field as
  // "unconfigured, skip this check" for backward compatibility with Story
  // 7-2's original test suite -- see that file's comment. This validator
  // has no such backward-compatibility constraint: Story 7.4's whole job is
  // to guarantee a COMPLETE object reaches the caller, so every field here
  // is mandatory.
  for (const field of REQUIRED_NUMBER_FIELDS_GTE_ZERO) {
    const value = raw[field];
    if (!isFiniteNumber(value) || value < 0) {
      return { ok: false };
    }
  }

  // `aiEnabled`: strictly a boolean -- a truthy/falsy STRING (`"true"`,
  // `"false"`, `""`) must not pass. This is a config-object field (a routine
  // limit source of truth in KV), deliberately distinct from the Worker var
  // `AI_ENABLED` (a literal string, checked in `loadGovernorConfig` below,
  // never through this validator) -- the two are separate kill-switch layers
  // with separate types on purpose, not a naming accident.
  if (typeof aiEnabled !== "boolean") {
    return { ok: false };
  }

  return {
    ok: true,
    cfg: {
      ceiling,
      reserveShare,
      freeSlices,
      minGapSec: raw.minGapSec,
      freeGlobalGapSec: raw.freeGlobalGapSec,
      freeDaily: raw.freeDaily,
      subscriberDaily: raw.subscriberDaily,
      mintPerHour: raw.mintPerHour,
      aiEnabled,
    },
  };
}

// The cache TTL, matching both KV's own `cacheTtl:30` option and the frozen
// Intent's "The cache is capped at 30 seconds, matching the KV propagation
// delay the owner's `wrangler kv key put --remote` command is documented to
// have." Exported so tests can reference it instead of repeating the literal.
export const CACHE_TTL_MS = 30 * 1000;

// Module-level, in-isolate cache: `{value, cachedAt}` or `null` before the
// first load. `value` is whatever `loadGovernorConfig` last returned --
// either shape, `{ok:true, cfg}` or `{ok:false}` (see that function's own
// comment on why a fail-closed KV outcome is cached too, not just a
// success). `cachedAt` is in the same `now()` units the caller injects
// (real code: `Date.now()`; tests: an injected fixed/stepped clock), which
// is what lets tests fast-forward past the 30s window without a real sleep.
let cache = null;

// Pure, in-process cache reset for tests only -- this module's real callers
// (a live Worker isolate) never need to reset the cache themselves; a fresh
// isolate simply starts with `cache === null`. Exported so
// test/governor-config.test.mjs can isolate one test's cache state from the
// next without relying on picking sufficiently-separated `now()` values per
// test (fragile) or restarting the Node process per test (slow). See this
// story's report for why this export exists even though the frozen spec's
// Code Map only names `validateGovernorConfig`/`loadGovernorConfig`.
export function _resetGovernorConfigCacheForTests() {
  cache = null;
}

// Story 7-8 review finding: `restore.js` needs this file's cached,
// validated `cfg:governor` reader to source `reserve("restore", ...)`'s own
// `cfg` argument (specifically `minGapSec`), but restore's attempt spacing
// has nothing to do with Image spend -- coupling it to `AI_ENABLED` would
// mean flipping the AI Kill Switch off (Story 7.4's own "stop AI spend in
// minutes" emergency lever) also silently breaks a paying family's ability
// to restore their subscription, an unrelated resource. This private helper
// is the cache+KV+validate logic ALONE, with no `AI_ENABLED` gate at all --
// both `loadGovernorConfig` (below, AI_ENABLED-gated, the original Story 7-4
// export, byte-for-byte the same external behavior) and the new
// `loadGovernorLimits` (further below, ungated) call this SAME function, so
// there is exactly one cache and one KV-read/validate code path shared by
// both call shapes -- never two independently-drifting copies.
async function loadCachedConfig(env, nowMs) {
  if (cache && nowMs - cache.cachedAt < CACHE_TTL_MS) {
    return cache.value;
  }

  // A KV outage (env.STATE_KV.get(...) throwing) is treated identically to
  // an invalid/unreadable config: fall through to validateGovernorConfig
  // with `raw = null`, which always fails closed for a non-object input.
  // This never lets a thrown KV error propagate uncaught to the caller.
  let raw = null;
  try {
    raw = await env.STATE_KV.get("cfg:governor", { type: "json", cacheTtl: 30 });
  } catch (error) {
    console.error("governor_config_kv_read_failed", error && error.message);
  }

  const result = validateGovernorConfig(raw);

  // Design judgment call (flagged in this story's Spec Change Log): a
  // fail-closed result is cached for the same 30s as a valid one. Without
  // this, a real KV outage would make EVERY request during the outage pay
  // for its own KV round-trip (and its own failure), hammering KV instead
  // of degrading gracefully -- the same reasoning that justifies caching a
  // successful read in the first place. The 30s ceiling on how long a
  // config can go unrefreshed already bounds how long a real fix (a
  // corrected `cfg:governor` value) takes to be picked up (frozen I/O
  // matrix's own "after the 30s cache window elapses, the next call picks
  // up the now-valid config" row), so caching the failure the same way
  // introduces no new staleness bound beyond what the spec already accepts.
  cache = { value: result, cachedAt: nowMs };
  return result;
}

// The only async/impure function this module originally exported (Story
// 7-4). `env` is a Worker `env` object (or a test mock with the same shape:
// `.AI_ENABLED` a string, `.STATE_KV.get(key, opts)` an async function).
// `now` defaults to `() => Date.now()` for real callers; tests inject a
// controllable clock.
//
// Order (frozen I/O matrix, reproduced here as the actual control flow):
//   (a) `env.AI_ENABLED !== "true"` (covers unset, `"false"`, any typo, a
//       non-string, or `env` itself missing) -> fail closed, ZERO KV calls,
//       every single time -- this check never consults or populates the
//       cache below, by design (see the Spec Change Log entry on why).
//   (b) a cached result under 30s old -> return it, zero further KV calls.
//   (c) otherwise, read `cfg:governor` from KV, validate it, cache the
//       result (success OR fail-closed -- see below), and return it.
//
// This is specifically "is Image spend allowed, and if so under what
// limits" -- callers that only need the routine limits themselves,
// independent of the AI Kill Switch, use `loadGovernorLimits` below instead.
export async function loadGovernorConfig(env, { now = () => Date.now() } = {}) {
  if (!env || env.AI_ENABLED !== "true") {
    return { ok: false };
  }
  return loadCachedConfig(env, now());
}

// Story 7-8: the routine Governor limits (minGapSec, freeDaily, etc.),
// WITHOUT the `AI_ENABLED` gate -- for callers whose own work isn't Image
// spend and must not be silently disabled by the Image Kill Switch (today:
// `restore.js`'s attempt spacing, which only needs `minGapSec`). Shares the
// exact same cache and KV-read/validate path as `loadGovernorConfig` above
// (`loadCachedConfig`) -- the only difference is skipping step (a). Still
// fails closed on an invalid/unreadable `cfg:governor` value, same as
// `loadGovernorConfig` -- only the `AI_ENABLED` check itself is skipped.
export async function loadGovernorLimits(env, { now = () => Date.now() } = {}) {
  if (!env) {
    return { ok: false };
  }
  return loadCachedConfig(env, now());
}
