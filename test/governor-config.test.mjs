// Story 7-4 -- tests for functions/lib/governor-config.js: the
// `AI_ENABLED`-first / cache / KV-read chain and the pure
// `validateGovernorConfig` validator underneath it. Follows
// test/governor-do.test.mjs's own style: a `makeClock` helper for an
// injectable, steppable clock, and a hand-rolled mock (`env.STATE_KV` here,
// analogous to that file's mock `storage`) that records every call so tests
// can assert zero-KV-calls / cache-hit behavior precisely, the same
// technique that file already uses for its `storage.calls` spy.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  validateGovernorConfig,
  loadGovernorConfig,
  loadGovernorLimits,
  CACHE_TTL_MS,
  _resetGovernorConfigCacheForTests,
} from "../functions/lib/governor-config.js";

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

// A valid config, matching config/governor.json's own shape exactly.
function validRaw(overrides = {}) {
  return {
    ceiling: 80,
    reserveShare: 0.5,
    freeSlices: 6,
    minGapSec: 30,
    freeGlobalGapSec: 20,
    freeDaily: 1,
    subscriberDaily: 10,
    mintPerHour: 20,
    aiEnabled: true,
    ...overrides,
  };
}

// mode:
//   "value" -> get() resolves to `payload` (a plain value, e.g. a config
//              object or null)
//   "throw" -> get() rejects with `payload` (an Error), simulating a real
//              KV outage
function makeMockStateKv(mode, payload) {
  const calls = [];
  return {
    calls,
    async get(key, opts) {
      calls.push({ key, opts });
      if (mode === "throw") throw payload;
      return payload;
    },
  };
}

function makeEnv({ aiEnabled, kvMode = "value", kvPayload = null } = {}) {
  return {
    AI_ENABLED: aiEnabled,
    STATE_KV: makeMockStateKv(kvMode, kvPayload),
  };
}

// -------------------------------------------------------------------------
// validateGovernorConfig -- the pure core. Every field's boundary, tested
// directly, independent of any env/KV/clock plumbing.
// -------------------------------------------------------------------------

test("validateGovernorConfig: a fully valid config (config/governor.json's own shape) succeeds and returns exactly its fields", () => {
  const result = validateGovernorConfig(validRaw());
  assert.equal(result.ok, true);
  assert.deepEqual(result.cfg, validRaw());
});

test("validateGovernorConfig: config/governor.json itself parses and validates", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const path = fileURLToPath(new URL("../config/governor.json", import.meta.url));
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const result = validateGovernorConfig(raw);
  assert.equal(result.ok, true, "config/governor.json must pass its own validator");
  assert.equal(raw.ceiling, 80);
  assert.equal(raw.reserveShare, 0.5);
  assert.equal(raw.freeSlices, 6);
  assert.equal(raw.minGapSec, 30);
  assert.equal(raw.freeGlobalGapSec, 20);
  assert.equal(raw.freeDaily, 1);
  assert.equal(raw.subscriberDaily, 10);
  assert.equal(raw.mintPerHour, 20);
  assert.equal(raw.aiEnabled, true);
});

test("validateGovernorConfig: null/undefined/non-object/array raw all fail closed", () => {
  assert.equal(validateGovernorConfig(null).ok, false);
  assert.equal(validateGovernorConfig(undefined).ok, false);
  assert.equal(validateGovernorConfig("nope").ok, false);
  assert.equal(validateGovernorConfig(42).ok, false);
  assert.equal(validateGovernorConfig(true).ok, false);
  assert.equal(validateGovernorConfig([]).ok, false);
  assert.equal(validateGovernorConfig({}).ok, false);
});

test("validateGovernorConfig: ceiling -- missing, wrong type, negative, non-finite all fail; 0 is valid", () => {
  assert.equal(validateGovernorConfig(validRaw({ ceiling: undefined })).ok, false, "missing");
  assert.equal(validateGovernorConfig(validRaw({ ceiling: "80" })).ok, false, "string");
  assert.equal(validateGovernorConfig(validRaw({ ceiling: -1 })).ok, false, "negative");
  assert.equal(validateGovernorConfig(validRaw({ ceiling: NaN })).ok, false, "NaN");
  assert.equal(validateGovernorConfig(validRaw({ ceiling: Infinity })).ok, false, "Infinity");
  assert.equal(validateGovernorConfig(validRaw({ ceiling: null })).ok, false, "null");
  assert.equal(validateGovernorConfig(validRaw({ ceiling: 0 })).ok, true, "0 is a valid ceiling");
});

test("validateGovernorConfig: reserveShare -- must be a finite number in [0,1]; 0 and 1 are valid boundaries", () => {
  assert.equal(validateGovernorConfig(validRaw({ reserveShare: -0.01 })).ok, false, "just below 0");
  assert.equal(validateGovernorConfig(validRaw({ reserveShare: 1.01 })).ok, false, "just above 1");
  assert.equal(validateGovernorConfig(validRaw({ reserveShare: 1.5 })).ok, false, "well above 1");
  assert.equal(validateGovernorConfig(validRaw({ reserveShare: "0.5" })).ok, false, "string");
  assert.equal(validateGovernorConfig(validRaw({ reserveShare: NaN })).ok, false, "NaN");
  assert.equal(validateGovernorConfig(validRaw({ reserveShare: undefined })).ok, false, "missing");
  assert.equal(validateGovernorConfig(validRaw({ reserveShare: 0 })).ok, true, "0 is valid");
  assert.equal(validateGovernorConfig(validRaw({ reserveShare: 1 })).ok, true, "1 is valid");
});

test("validateGovernorConfig: freeSlices -- must be a positive integer; 0, negative, fractional, missing all fail", () => {
  assert.equal(validateGovernorConfig(validRaw({ freeSlices: 0 })).ok, false, "zero");
  assert.equal(validateGovernorConfig(validRaw({ freeSlices: -3 })).ok, false, "negative");
  assert.equal(validateGovernorConfig(validRaw({ freeSlices: 2.5 })).ok, false, "fractional -- the exact spec-7-3 overshoot scenario");
  assert.equal(validateGovernorConfig(validRaw({ freeSlices: "6" })).ok, false, "string");
  assert.equal(validateGovernorConfig(validRaw({ freeSlices: undefined })).ok, false, "missing");
  assert.equal(validateGovernorConfig(validRaw({ freeSlices: NaN })).ok, false, "NaN");
  assert.equal(validateGovernorConfig(validRaw({ freeSlices: 1 })).ok, true, "1 is the minimum valid slice count");
});

test("validateGovernorConfig: each of minGapSec/freeGlobalGapSec/freeDaily/subscriberDaily/mintPerHour must be a finite number >= 0", () => {
  const fields = ["minGapSec", "freeGlobalGapSec", "freeDaily", "subscriberDaily", "mintPerHour"];
  for (const field of fields) {
    assert.equal(validateGovernorConfig(validRaw({ [field]: undefined })).ok, false, `${field} missing`);
    assert.equal(validateGovernorConfig(validRaw({ [field]: "10" })).ok, false, `${field} a string`);
    assert.equal(validateGovernorConfig(validRaw({ [field]: -1 })).ok, false, `${field} negative`);
    assert.equal(validateGovernorConfig(validRaw({ [field]: NaN })).ok, false, `${field} NaN`);
    assert.equal(validateGovernorConfig(validRaw({ [field]: Infinity })).ok, false, `${field} Infinity`);
    assert.equal(validateGovernorConfig(validRaw({ [field]: null })).ok, false, `${field} null`);
    assert.equal(validateGovernorConfig(validRaw({ [field]: 0 })).ok, true, `${field} 0 is valid`);
  }
});

test("validateGovernorConfig: aiEnabled must be strictly boolean -- truthy/falsy strings are rejected, not coerced", () => {
  assert.equal(validateGovernorConfig(validRaw({ aiEnabled: "true" })).ok, false, "the string \"true\"");
  assert.equal(validateGovernorConfig(validRaw({ aiEnabled: "false" })).ok, false, "the string \"false\"");
  assert.equal(validateGovernorConfig(validRaw({ aiEnabled: 1 })).ok, false, "the number 1");
  assert.equal(validateGovernorConfig(validRaw({ aiEnabled: 0 })).ok, false, "the number 0");
  assert.equal(validateGovernorConfig(validRaw({ aiEnabled: undefined })).ok, false, "missing entirely");
  assert.equal(validateGovernorConfig(validRaw({ aiEnabled: null })).ok, false, "null");
  assert.equal(validateGovernorConfig(validRaw({ aiEnabled: false })).ok, true, "a real boolean false is valid");
  assert.equal(validateGovernorConfig(validRaw({ aiEnabled: true })).ok, true, "a real boolean true is valid");
});

test("validateGovernorConfig: a config missing even one field is rejected as a whole, not partially accepted", () => {
  const raw = validRaw();
  delete raw.mintPerHour;
  const result = validateGovernorConfig(raw);
  assert.equal(result.ok, false);
  assert.equal(result.cfg, undefined, "no partial cfg must ever be returned on failure");
});

test("validateGovernorConfig: a string ceiling rejects the whole object, not just that field (I/O matrix row)", () => {
  const result = validateGovernorConfig(validRaw({ ceiling: "80" }));
  assert.equal(result.ok, false);
  assert.equal(result.cfg, undefined);
});

test("validateGovernorConfig: aiEnabled missing from an otherwise-valid config fails closed (I/O matrix row)", () => {
  const raw = validRaw();
  delete raw.aiEnabled;
  assert.equal(validateGovernorConfig(raw).ok, false);
});

// -------------------------------------------------------------------------
// loadGovernorConfig -- AI_ENABLED-first, then cache, then KV.
// -------------------------------------------------------------------------

test("loadGovernorConfig: AI_ENABLED unset -> fail-closed, zero KV calls", async () => {
  _resetGovernorConfigCacheForTests();
  const env = makeEnv({ aiEnabled: undefined, kvPayload: validRaw() });
  const result = await loadGovernorConfig(env, { now: makeClock(1_000_000).now });
  assert.equal(result.ok, false);
  assert.equal(env.STATE_KV.calls.length, 0, "AI_ENABLED must be checked before any KV call");
});

test("loadGovernorConfig: AI_ENABLED wrong-value (typo/falsey-but-not-unset) -> fail-closed, zero KV calls", async () => {
  _resetGovernorConfigCacheForTests();
  for (const badValue of ["false", "TRUE", "1", "", "yes", true, 1, null]) {
    const env = makeEnv({ aiEnabled: badValue, kvPayload: validRaw() });
    const result = await loadGovernorConfig(env, { now: makeClock(2_000_000).now });
    assert.equal(result.ok, false, `AI_ENABLED=${JSON.stringify(badValue)} must fail closed`);
    assert.equal(env.STATE_KV.calls.length, 0, `AI_ENABLED=${JSON.stringify(badValue)} must make zero KV calls`);
  }
});

test("loadGovernorConfig: AI_ENABLED==='true' + valid cfg:governor -> success; a second call within 30s is served from cache (zero further KV calls)", async () => {
  _resetGovernorConfigCacheForTests();
  const clock = makeClock(3_000_000);
  const env = makeEnv({ aiEnabled: "true", kvPayload: validRaw() });

  const first = await loadGovernorConfig(env, { now: clock.now });
  assert.equal(first.ok, true);
  assert.deepEqual(first.cfg, validRaw());
  assert.equal(env.STATE_KV.calls.length, 1);
  assert.deepEqual(env.STATE_KV.calls[0], { key: "cfg:governor", opts: { type: "json", cacheTtl: 30 } });

  clock.advance(10_000); // well under the 30s window
  const second = await loadGovernorConfig(env, { now: clock.now });
  assert.equal(second.ok, true);
  assert.deepEqual(second.cfg, validRaw());
  assert.equal(env.STATE_KV.calls.length, 1, "a call within the cache window must not touch KV again");
});

test("loadGovernorConfig: AI_ENABLED==='true', KV throws -> fail-closed", async () => {
  _resetGovernorConfigCacheForTests();
  const env = makeEnv({ aiEnabled: "true", kvMode: "throw", kvPayload: new Error("simulated KV outage") });
  const originalConsoleError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  let result;
  try {
    result = await loadGovernorConfig(env, { now: makeClock(4_000_000).now });
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(result.ok, false);
  assert.ok(logged.some((args) => args[0] === "governor_config_kv_read_failed"), "the KV outage must be logged, not silently swallowed");
});

test("loadGovernorConfig: AI_ENABLED==='true', KV returns null -> fail-closed", async () => {
  _resetGovernorConfigCacheForTests();
  const env = makeEnv({ aiEnabled: "true", kvMode: "value", kvPayload: null });
  const result = await loadGovernorConfig(env, { now: makeClock(5_000_000).now });
  assert.equal(result.ok, false);
});

test("loadGovernorConfig: a config with a string ceiling fails closed -- the whole object rejected (I/O matrix row)", async () => {
  _resetGovernorConfigCacheForTests();
  const env = makeEnv({ aiEnabled: "true", kvPayload: validRaw({ ceiling: "80" }) });
  const result = await loadGovernorConfig(env, { now: makeClock(6_000_000).now });
  assert.equal(result.ok, false);
});

test("loadGovernorConfig: aiEnabled missing from the KV value fails closed (I/O matrix row)", async () => {
  _resetGovernorConfigCacheForTests();
  const raw = validRaw();
  delete raw.aiEnabled;
  const env = makeEnv({ aiEnabled: "true", kvPayload: raw });
  const result = await loadGovernorConfig(env, { now: makeClock(7_000_000).now });
  assert.equal(result.ok, false);
});

test("loadGovernorConfig: a prior fail-closed load is itself cached -- a second call inside the window still makes zero further KV calls", async () => {
  _resetGovernorConfigCacheForTests();
  const clock = makeClock(8_000_000);
  const env = makeEnv({ aiEnabled: "true", kvMode: "value", kvPayload: null });

  const first = await loadGovernorConfig(env, { now: clock.now });
  assert.equal(first.ok, false);
  assert.equal(env.STATE_KV.calls.length, 1);

  clock.advance(29_000); // still inside the 30s window
  const second = await loadGovernorConfig(env, { now: clock.now });
  assert.equal(second.ok, false);
  assert.equal(env.STATE_KV.calls.length, 1, "a cached fail-closed result must not re-hit KV within the window (design choice -- see this story's Spec Change Log)");
});

test("loadGovernorConfig: after the 30s cache window elapses, a now-valid config in KV is picked up (I/O matrix row)", async () => {
  _resetGovernorConfigCacheForTests();
  const clock = makeClock(9_000_000);
  const mockKv = makeMockStateKv("value", null); // invalid at first
  const env = { AI_ENABLED: "true", STATE_KV: mockKv };

  const first = await loadGovernorConfig(env, { now: clock.now });
  assert.equal(first.ok, false);

  // KV now holds a valid config, but we're still inside the cache window.
  mockKv.get = async (key, opts) => {
    mockKv.calls.push({ key, opts });
    return validRaw();
  };
  clock.advance(CACHE_TTL_MS - 1);
  const stillCached = await loadGovernorConfig(env, { now: clock.now });
  assert.equal(stillCached.ok, false, "must still serve the cached fail-closed result just under the 30s boundary");

  clock.advance(2); // now past the 30s window
  const afterWindow = await loadGovernorConfig(env, { now: clock.now });
  assert.equal(afterWindow.ok, true, "once the cache window elapses, the now-valid KV config must be picked up");
  assert.deepEqual(afterWindow.cfg, validRaw());
});

test("loadGovernorConfig: a prior valid load keeps being served even if KV starts failing mid-window -- the cache does not re-validate early (I/O matrix row)", async () => {
  _resetGovernorConfigCacheForTests();
  const clock = makeClock(10_000_000);
  const mockKv = makeMockStateKv("value", validRaw());
  const env = { AI_ENABLED: "true", STATE_KV: mockKv };

  const first = await loadGovernorConfig(env, { now: clock.now });
  assert.equal(first.ok, true);
  assert.equal(mockKv.calls.length, 1);

  // KV now starts failing, but we're still inside the cache window.
  mockKv.get = async () => {
    throw new Error("KV now failing");
  };
  clock.advance(29_000);
  const stillCachedValid = await loadGovernorConfig(env, { now: clock.now });
  assert.equal(stillCachedValid.ok, true, "the cached VALID result must still be served, not re-checked against the now-failing KV");
  assert.deepEqual(stillCachedValid.cfg, validRaw());

  // Only once the window elapses does the (now-failing) KV get consulted
  // again, and only then does the result flip to fail-closed.
  clock.advance(2_000);
  const afterWindow = await loadGovernorConfig(env, { now: clock.now });
  assert.equal(afterWindow.ok, false, "once the cache expires, a genuinely failing KV must fail the next load closed");
});

test("loadGovernorConfig: AI_ENABLED flips to disabled mid-cache-window -- always re-checked fresh, never served from (or blocked by) the KV cache", async () => {
  _resetGovernorConfigCacheForTests();
  const clock = makeClock(11_000_000);
  const env = makeEnv({ aiEnabled: "true", kvPayload: validRaw() });

  const first = await loadGovernorConfig(env, { now: clock.now });
  assert.equal(first.ok, true);

  clock.advance(1_000); // well inside the 30s window
  env.AI_ENABLED = "false"; // the owner flips the emergency Kill Switch
  const second = await loadGovernorConfig(env, { now: clock.now });
  assert.equal(second.ok, false, "AI_ENABLED disabled must fail closed immediately, even with a valid cached config still within its window");
  assert.equal(env.STATE_KV.calls.length, 1, "the AI_ENABLED check must short-circuit before touching KV or the cache at all");
});

test("loadGovernorConfig: missing env or missing/malformed STATE_KV never throws -- fails closed", async () => {
  _resetGovernorConfigCacheForTests();
  assert.equal((await loadGovernorConfig(undefined)).ok, false);
  assert.equal((await loadGovernorConfig(null)).ok, false);
  assert.equal((await loadGovernorConfig({ AI_ENABLED: "true" }, { now: makeClock(12_000_000).now })).ok, false, "AI_ENABLED true but no STATE_KV at all must fail closed, not throw");
});

test("loadGovernorConfig: with no `now` override, the default clock is a real function returning a number", async () => {
  _resetGovernorConfigCacheForTests();
  const env = makeEnv({ aiEnabled: undefined });
  const result = await loadGovernorConfig(env); // exercises the default `now = () => Date.now()`
  assert.equal(result.ok, false);
});

// --- loadGovernorLimits (Story 7-8 review fix) ---------------------------
//
// The routine Governor limits, WITHOUT the AI_ENABLED gate -- for a caller
// (restore.js) whose own work is not Image spend and must not be silently
// blocked by the Image Kill Switch. Shares the exact same cache and
// KV-read/validate path as loadGovernorConfig (verified below by the shared
// AI_ENABLED value cache also being visible to loadGovernorConfig, and vice
// versa) -- only the AI_ENABLED check itself is skipped.

test("loadGovernorLimits: succeeds with a valid cfg:governor even when AI_ENABLED is \"false\" -- the whole point of this export", async () => {
  _resetGovernorConfigCacheForTests();
  const env = makeEnv({ aiEnabled: "false", kvPayload: validRaw() });
  const result = await loadGovernorLimits(env, { now: makeClock(7_000_000).now });
  assert.equal(result.ok, true);
  assert.deepEqual(result.cfg, validRaw());
  assert.equal(env.STATE_KV.calls.length, 1, "unlike loadGovernorConfig, this DOES reach KV regardless of AI_ENABLED");
});

test("loadGovernorLimits: succeeds with AI_ENABLED unset entirely (not even a string) -- still not gated", async () => {
  _resetGovernorConfigCacheForTests();
  const env = makeEnv({ aiEnabled: undefined, kvPayload: validRaw() });
  const result = await loadGovernorLimits(env, { now: makeClock(7_100_000).now });
  assert.equal(result.ok, true);
  assert.deepEqual(result.cfg, validRaw());
});

test("loadGovernorLimits: still fails closed on an invalid/unreadable cfg:governor, independent of AI_ENABLED -- only the AI_ENABLED gate itself is skipped, not fail-closed validation", async () => {
  _resetGovernorConfigCacheForTests();
  const envInvalid = makeEnv({ aiEnabled: "false", kvPayload: validRaw({ ceiling: "80" }) });
  const invalidResult = await loadGovernorLimits(envInvalid, { now: makeClock(7_200_000).now });
  assert.equal(invalidResult.ok, false);

  _resetGovernorConfigCacheForTests();
  const envThrows = makeEnv({ aiEnabled: "false", kvMode: "throw", kvPayload: new Error("simulated KV outage") });
  const throwResult = await loadGovernorLimits(envThrows, { now: makeClock(7_300_000).now });
  assert.equal(throwResult.ok, false);

  _resetGovernorConfigCacheForTests();
  const envMissing = await loadGovernorLimits(undefined, { now: makeClock(7_400_000).now });
  assert.equal(envMissing.ok, false, "a missing env itself must also fail closed, not throw");
});

test("loadGovernorLimits and loadGovernorConfig share the SAME cache -- a value cached by one is visible to the other (one code path, not two independently-drifting copies)", async () => {
  _resetGovernorConfigCacheForTests();
  const clock = makeClock(7_500_000);
  const env = makeEnv({ aiEnabled: "true", kvPayload: validRaw() });

  const viaConfig = await loadGovernorConfig(env, { now: clock.now });
  assert.equal(viaConfig.ok, true);
  assert.equal(env.STATE_KV.calls.length, 1);

  clock.advance(5_000); // well under the 30s cache window
  const viaLimits = await loadGovernorLimits(env, { now: clock.now });
  assert.equal(viaLimits.ok, true);
  assert.deepEqual(viaLimits.cfg, viaConfig.cfg);
  assert.equal(env.STATE_KV.calls.length, 1, "loadGovernorLimits must be served from the SAME cache loadGovernorConfig already populated -- zero additional KV calls");
});

test("loadGovernorLimits and loadGovernorConfig share the SAME cache in the REVERSE order too -- populating it via loadGovernorLimits FIRST (AI_ENABLED unset, since loadGovernorLimits doesn't care) still leaves a value loadGovernorConfig itself is served from, zero additional KV calls, once AI_ENABLED is satisfied", async () => {
  _resetGovernorConfigCacheForTests();
  const clock = makeClock(7_550_000);
  const env = makeEnv({ aiEnabled: undefined, kvPayload: validRaw() });

  const viaLimits = await loadGovernorLimits(env, { now: clock.now });
  assert.equal(viaLimits.ok, true);
  assert.equal(env.STATE_KV.calls.length, 1);

  clock.advance(5_000); // well under the 30s cache window
  env.AI_ENABLED = "true"; // loadGovernorConfig's own gate -- now satisfied
  const viaConfig = await loadGovernorConfig(env, { now: clock.now });
  assert.equal(viaConfig.ok, true);
  assert.deepEqual(viaConfig.cfg, viaLimits.cfg);
  assert.equal(env.STATE_KV.calls.length, 1, "loadGovernorConfig must be served from the SAME cache loadGovernorLimits already populated -- zero additional KV calls");
});

test("loadGovernorLimits: with no `now` override, the default clock is a real function returning a number", async () => {
  _resetGovernorConfigCacheForTests();
  const env = makeEnv({ aiEnabled: "false", kvPayload: validRaw() });
  const result = await loadGovernorLimits(env); // exercises the default `now = () => Date.now()`
  assert.equal(result.ok, true);
});
