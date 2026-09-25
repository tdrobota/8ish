// Story 7-9 ("The abuse checks pass") -- a standalone, re-runnable proof
// that the 9 abuse/cost-safety scenarios epics.md's own Story 7.9 lists
// hold under the REAL, unmodified production request path -- not a
// reimplementation, not a mock of transform.js's own logic.
//
//   node scripts/abuse-check.mjs                        -- local mode (this file's own 9 scenarios)
//   node scripts/abuse-check.mjs --post-deploy <url>     -- post-deploy mode (see bottom of this file; NEVER invoked by this story itself)
//
// --- Harness architecture (spec-7-9-abuse-checks.md's own Design Notes) ---
//
// This script `import`s the REAL `functions/api/transform.js` directly
// (`import { onRequestPost } from "../functions/api/transform.js"`) and
// calls it exactly as `worker.js` would: `onRequestPost({request, env,
// ctx})`. That file, and everything it in turn imports (`credential.js`,
// `device-token.js`, `turnstile.js`, `governor-config.js`, `http-body.js`,
// `request-throttle.js`, `public/prompts.js`), is a plain ESM module with
// zero `cloudflare:workers`-specific imports -- confirmed by hand before
// writing this script, and re-confirmed live by this script's own first
// successful `import`. The ONLY things NOT real anywhere below: the
// `Governor` Durable Object *class* wrapper itself (`functions/governor.js`,
// a ~30-line pass-through that imports `DurableObject` from
// `cloudflare:workers` and therefore cannot run under plain Node), the real
// Cloudflare edge/WAF/DO-runtime infrastructure, and the real Workers AI
// binding. `env.GOVERNOR` here is instead wired straight to
// `functions/lib/governor-do.js`'s real `createGovernorHandlers({sql, now,
// storage})` -- ALSO zero Cloudflare-specific imports -- over a real
// `node:sqlite`-backed adapter (reused as-is from `test/lib/sqlite-adapter.mjs`,
// the exact technique `test/governor-do.test.mjs`/`test/governor-core.test.mjs`
// already use), wrapped in the one-line DO-stub shape transform.js's own
// `env.GOVERNOR.get(env.GOVERNOR.idFromName("global")).reserve(...)` call
// expects. None of the 9 local-mode scenarios' actual pass/fail logic
// depends on any of the three not-real things behaving differently than
// their real counterparts would.
//
// `env.AI_STUB` is a plain controllable function (the `typeof env.AI_STUB
// === "function"` test seam transform.js's own `runModelAndSettle` already
// checks for -- production `env` never sets this). `env.STATE_KV`/
// `env.AI_ENABLED`/`env.ENTITLEMENT_SECRET`/`env.TURNSTILE_SECRET`/
// `env.ORIGIN` are plain mocks matching `scripts/check-config.mjs`'s own
// established shapes for these EXACT fields (`makeTransformEnv`/
// `makeGovernorStub`/`makeStateKv`/`makeFreeDeviceEnv` in that file) --
// read before writing this script, not re-derived from scratch, so this
// script's scenarios reflect the same real contract that file already
// proved works. `ctx.waitUntil` is a real array-collecting mock, letting
// Scenario 2 assert the settle promise was registered and await it
// directly, proving the row's final state without a real Worker runtime's
// own lifecycle extension.
//
// The Governor DO stub's `reserve`/`commit`/`release` are wrapped in a thin
// call-counting proxy (`makeGovernor` below) around the real
// `createGovernorHandlers` result -- purely for observability (several
// scenarios below need to assert "zero calls reached the Governor"), never
// changing what the real handlers do. This one extra layer over the frozen
// Design Notes' own literal `{get: () => handlers, idFromName: () =>
// "global"}` shape is a judgment call, recorded in this story's Spec Change
// Log.
//
// `functions/lib/request-throttle.js` and `functions/lib/governor-config.js`
// each keep real MODULE-LEVEL state (an in-isolate deny-cache/pre-limit map,
// and a 30s config cache, respectively) -- exactly as they do in a real
// Worker isolate. Because this script does one real `import` per module
// (not a fresh `vm` context per scenario, unlike `check-config.mjs`'s own
// technique), that state persists across every scenario in this process.
// Each scenario therefore starts by calling both modules' own test-only
// reset exports (`_resetRequestThrottleForTests`/
// `_resetGovernorConfigCacheForTests`) so scenarios never leak pre-limit/
// deny-cache/config-cache state into one another -- every scenario below
// still gets its own fresh, real `node:sqlite`-backed Governor regardless
// (a fresh adapter per scenario), so this reset is only about the two
// SEPARATE pieces of real module-level state transform.js's own imports
// carry that a fresh Governor instance doesn't touch.

import { onRequestPost } from "../functions/api/transform.js";
import { createGovernorHandlers } from "../functions/lib/governor-do.js";
import * as credential from "../functions/lib/credential.js";
import * as deviceToken from "../functions/lib/device-token.js";
import { _resetGovernorConfigCacheForTests } from "../functions/lib/governor-config.js";
import { _resetRequestThrottleForTests } from "../functions/lib/request-throttle.js";
import { createSqliteAdapter } from "../test/lib/sqlite-adapter.mjs";

const ENTITLEMENT_SECRET = "abuse_check_entitlement_secret_0123456789";
const ORIGIN = "https://8ish.app";
const VALID_PROMPT_ID = "p001"; // public/prompts.js's real first entry (EN: "Draw a monster that only eats broccoli!")

// A full, valid governor.json-shaped config -- every field
// `validateGovernorConfig` (functions/lib/governor-config.js) requires,
// generous enough not to interfere unless a scenario deliberately tightens
// one field.
const BASE_GOVERNOR_CFG = {
  ceiling: 1000,
  reserveShare: 0.5,
  freeSlices: 6,
  minGapSec: 0,
  freeGlobalGapSec: 0,
  freeDaily: 1000,
  subscriberDaily: 1000,
  mintPerHour: 1000,
  aiEnabled: true,
};

// --- small local harness helpers -------------------------------------------

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

// The three Durable Object alarm methods createGovernorHandlers requires --
// a faithful mock of ctx.storage's own alarm API shape, matching
// test/governor-do.test.mjs's own makeMockStorage().
function makeMockStorage() {
  let alarm = null;
  return {
    async getAlarm() {
      return alarm;
    },
    async setAlarm(ms) {
      alarm = ms;
    },
    async deleteAlarm() {
      alarm = null;
    },
  };
}

// Builds a fresh, real Governor: a real node:sqlite-backed adapter, wired
// into the REAL createGovernorHandlers factory from functions/lib/governor-do.js
// (no reimplementation of any accounting logic), wrapped in a thin
// call-counting proxy (see this file's header comment) and the
// {get, idFromName} DO-stub shape transform.js's own
// env.GOVERNOR.get(env.GOVERNOR.idFromName("global")) call expects.
function makeGovernor({ startMs, clock } = {}) {
  const adapter = createSqliteAdapter();
  const theClock = clock || makeClock(startMs != null ? startMs : Date.now());
  const storage = makeMockStorage();
  const handlers = createGovernorHandlers({ sql: adapter, now: theClock.now, storage });

  const reserveCalls = [];
  const commitCalls = [];
  const releaseCalls = [];
  const stub = {
    reserve: async (kind, key, cfg) => {
      reserveCalls.push({ kind, key, cfg });
      return handlers.reserve(kind, key, cfg);
    },
    commit: async (id) => {
      commitCalls.push(id);
      return handlers.commit(id);
    },
    release: async (id, opts) => {
      releaseCalls.push({ id, opts });
      return handlers.release(id, opts);
    },
  };
  const GOVERNOR = { get: () => stub, idFromName: (name) => name };

  return { adapter, clock: theClock, storage, handlers, GOVERNOR, reserveCalls, commitCalls, releaseCalls };
}

function countReservationRows(adapter) {
  return adapter.exec("SELECT COUNT(*) AS n FROM reservations").rows[0].n;
}

// Builds a full mocked `env` for transform.js, matching
// scripts/check-config.mjs's own makeTransformEnv()/makeFreeDeviceEnv()
// field shapes exactly: a real ENTITLEMENT_SECRET, AI_ENABLED (a literal
// string, not a boolean -- the real Worker var contract), STATE_KV.get()
// answering the given (possibly malformed, for Scenario 8) cfg:governor
// value directly (as if KV's own `{type:"json"}` option had already parsed
// it), the GOVERNOR DO binding, and either env.AI_STUB (a plain controllable
// function) or nothing (env.AI is deliberately never set anywhere in this
// script -- a real env.AI.run() call must never be reachable from local
// mode, per this story's hard constraints).
function makeEnv({ secret = ENTITLEMENT_SECRET, aiEnabled = "true", governorCfgRaw, GOVERNOR, aiStub, turnstileSecret, origin } = {}) {
  const aiCalls = [];
  const env = {
    ENTITLEMENT_SECRET: secret,
    AI_ENABLED: aiEnabled,
    STATE_KV: { get: async () => governorCfgRaw },
  };
  if (GOVERNOR) env.GOVERNOR = GOVERNOR;
  if (aiStub) {
    env.AI_STUB = (...args) => {
      aiCalls.push(args);
      return aiStub(...args);
    };
  }
  if (turnstileSecret) env.TURNSTILE_SECRET = turnstileSecret;
  if (origin) env.ORIGIN = origin;
  return { env, aiCalls };
}

// ctx.waitUntil(): a real array-collecting mock -- records every promise
// handed to it without ever awaiting it itself, exactly matching
// check-config.mjs's own makeCtx(). Scenario 2 depends on this directly: it
// proves the settle call was REGISTERED (not skipped), then awaits it
// itself to simulate the real Workers runtime's own lifecycle extension.
function makeCtx() {
  const waitUntilCalls = [];
  return { ctx: { waitUntil: (p) => waitUntilCalls.push(p) }, waitUntilCalls };
}

function aiStubResolving(image = "abuse_check_stub_image_b64") {
  return async () => ({ image });
}

// Temporarily replaces the global fetch (turnstile.js's own siteverify call
// has no injection seam -- it calls the global `fetch` directly, same as a
// real deployment would) so a scenario can drive a controlled Turnstile
// response WITHOUT ever making a real network call to Cloudflare's
// siteverify endpoint. Always paired with a try/finally restore.
function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = original;
  };
}

// --- real PNG bytes, hand-built the same byte-exact way
// scripts/check-config.mjs's own buildPngBytes()/pngBase64() do (read
// before writing this script) -- 8-byte signature + a real 13-byte IHDR
// chunk (length, ASCII type, width/height as big-endian uint32s), matching
// transform.js's own isValidPng() byte layout exactly.
function uint32BE(n) {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IHDR_TYPE = [0x49, 0x48, 0x44, 0x52]; // ASCII "IHDR"
function buildPngBytes({ width = 4, height = 4 } = {}) {
  return Uint8Array.from([...PNG_SIGNATURE, ...uint32BE(13), ...IHDR_TYPE, ...uint32BE(width), ...uint32BE(height), 1, 2, 3, 4]);
}
function pngBase64(opts) {
  return Buffer.from(buildPngBytes(opts)).toString("base64");
}
const VALID_PNG_B64 = pngBase64();

function validSketchBody(extra = {}) {
  return { sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID, ...extra };
}

function transformRequest(bodyObjOrString, { token, deviceToken: deviceTok, xAppToken, contentType = "application/json" } = {}) {
  const bodyText = typeof bodyObjOrString === "string" ? bodyObjOrString : JSON.stringify(bodyObjOrString);
  const headers = { "content-type": contentType };
  if (token) headers["authorization"] = `Bearer ${token}`;
  if (deviceTok) headers["x-device-token"] = deviceTok;
  if (xAppToken) headers["x-app-token"] = xAppToken;
  return new Request("https://8ish.app/api/transform", { method: "POST", headers, body: bodyText });
}

// Builds a token the exact way credential.js's own mint() does, but under a
// caller-chosen type prefix/payload -- used ONLY to construct malicious/
// edge-case test INPUT (a validly-signed but EXPIRED credential; wrong-type
// tokens are built via the real device-token.js mint() instead). This is
// the exact same technique scripts/check-config.mjs's own `mintAs()` helper
// already uses (read before writing this script) -- it never reimplements
// or bypasses credential.js's own verify() logic, which is exercised for
// real against this crafted input in Scenario 5 below.
async function craftToken(prefix, secret, payload) {
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signedInput = prefix + payloadB64;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedInput));
  return `${signedInput}.${Buffer.from(new Uint8Array(sig)).toString("base64url")}`;
}

// --- the 9 local-mode scenarios (epics.md's own Story 7.9 numbering/wording) -

// 1. Concurrency at the ceiling never exceeds it by more than 1.
async function scenario1() {
  const CONCURRENCY = 500;
  const CEILING = 40;
  const gov = makeGovernor({ startMs: Date.UTC(2026, 0, 1, 12, 0, 0) });
  const cfg = { ...BASE_GOVERNOR_CFG, ceiling: CEILING };
  const { env } = makeEnv({ governorCfgRaw: cfg, GOVERNOR: gov.GOVERNOR, aiStub: aiStubResolving() });
  const { ctx } = makeCtx();

  // 500 DISTINCT subscriber credentials (distinct Governor keys), mirroring
  // test/governor-core.test.mjs's own 500-concurrent test's `key-${i}`
  // pattern -- each key used exactly once, so request-throttle.js's own
  // 5-attempts/10s-per-key pre-limit (an unrelated, additive Story 7-8
  // layer) can never interfere with what this scenario is actually proving.
  const creds = await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => credential.mint(env, `sub-conc-${i}`)));

  const results = await Promise.all(creds.map((token) => onRequestPost({ request: transformRequest(validSketchBody(), { token }), env, ctx })));
  const statuses = results.map((r) => r.status);
  const granted = statuses.filter((s) => s === 200).length;
  const denied = statuses.filter((s) => s === 503).length;
  const other = statuses.filter((s) => s !== 200 && s !== 503);

  if (other.length) throw new Error(`expected every response to be 200 (granted) or 503 (resting/denied); saw unexpected statuses: ${other.join(",")}`);
  if (granted + denied !== CONCURRENCY) throw new Error(`granted(${granted}) + denied(${denied}) !== ${CONCURRENCY}`);
  if (granted > CEILING + 1) throw new Error(`granted (${granted}) exceeded ceiling+1 (${CEILING + 1}) -- epics.md's own literal tolerance`);

  return `${CONCURRENCY} concurrent requests, ceiling=${CEILING}: granted=${granted}, denied=${denied} (granted <= ceiling+1 holds${granted === CEILING ? "; granted === ceiling exactly" : ""})`;
}

// 2. A request abandoned after the model call still counts as spent.
async function scenario2() {
  const gov = makeGovernor();
  const cfg = { ...BASE_GOVERNOR_CFG, ceiling: 1 };
  const { env } = makeEnv({ governorCfgRaw: cfg, GOVERNOR: gov.GOVERNOR, aiStub: aiStubResolving("abandoned_image_b64") });
  const { ctx, waitUntilCalls } = makeCtx();

  const token = await credential.mint(env, "sub-abandon-1");
  const res = await onRequestPost({ request: transformRequest(validSketchBody(), { token }), env, ctx });
  if (res.status !== 200) throw new Error(`expected the granted request to succeed (200), got ${res.status}`);
  if (waitUntilCalls.length !== 1) throw new Error(`expected exactly one ctx.waitUntil() registration (the settle commit), got ${waitUntilCalls.length}`);

  // Simulate "the client vanished right after the model call": nothing
  // awaited that settle promise inline before the response was built
  // (transform.js's own runModelAndSettle calls ctx.waitUntil(commit(...))
  // and returns immediately) -- await it HERE, directly, standing in for
  // the real Workers runtime's own waitUntil lifecycle extension that keeps
  // the isolate alive to finish it even after the response has gone out.
  const settleResult = await waitUntilCalls[0];
  if (!settleResult || settleResult.ok !== true || settleResult.state !== "committed") {
    throw new Error(`expected the settle promise to resolve to a committed reservation, got ${JSON.stringify(settleResult)}`);
  }

  // The ceiling (1) should now be fully spent -- a SECOND reservation
  // (a different key, so minGapSec never interferes) must be denied,
  // proving the Governor's own state reflects the first request's spend
  // even though nothing forced that settlement to happen inline.
  const token2 = await credential.mint(env, "sub-abandon-2");
  const res2 = await onRequestPost({ request: transformRequest(validSketchBody(), { token: token2 }), env, ctx });
  if (res2.status !== 503) throw new Error(`expected the second reservation at ceiling:1 to be denied (503), got ${res2.status}`);
  const body2 = await res2.json();
  if (body2?.error?.code !== "resting") throw new Error(`expected denied.code "resting", got ${JSON.stringify(body2)}`);

  return `settle promise (registered via ctx.waitUntil, awaited directly here) resolved state="committed"; a subsequent reservation at the same ceiling:1 was denied (${res2.status} ${body2.error.code})`;
}

// 3. A reservation straddling the UTC day boundary is counted in the right
// day (an injected clock, per test/governor-core.test.mjs's own pattern).
async function scenario3() {
  const t0 = Date.UTC(2026, 0, 1, 23, 59, 50); // 2026-01-01T23:59:50Z
  const t1 = Date.UTC(2026, 0, 2, 0, 0, 5); // 2026-01-02T00:00:05Z
  const clock = makeClock(t0);
  const gov = makeGovernor({ clock });
  const cfg = { ...BASE_GOVERNOR_CFG, ceiling: 100 };

  let resolveAi;
  const aiPromise = new Promise((resolve) => {
    resolveAi = resolve;
  });
  const { env } = makeEnv({ governorCfgRaw: cfg, GOVERNOR: gov.GOVERNOR, aiStub: () => aiPromise });
  const { ctx, waitUntilCalls } = makeCtx();

  const token = await credential.mint(env, "sub-boundary");
  const reqPromise = onRequestPost({ request: transformRequest(validSketchBody(), { token }), env, ctx });

  // Poll (deterministic, no fixed microtask-tick budget) until the real
  // Governor reserve() has actually run -- i.e. the reservation row exists,
  // written at clock=t0 -- before advancing the clock. The request is
  // genuinely suspended at this point: it's awaiting our own still-unresolved
  // aiPromise inside runModelAndSettle's raceWithTimeout, which only starts
  // AFTER reserve() has already committed the row.
  for (let i = 0; i < 500 && countReservationRows(gov.adapter) < 1; i++) {
    await new Promise((r) => setImmediate(r));
  }
  if (countReservationRows(gov.adapter) < 1) throw new Error("the reservation was never written -- the request never reached the Governor");

  clock.set(t1); // advance the Governor's OWN clock past midnight UTC
  resolveAi({ image: "boundary_image_b64" }); // only now let the (slow) model call resolve, past midnight
  const res = await reqPromise;
  if (res.status !== 200) throw new Error(`expected the request to succeed, got ${res.status}`);
  if (waitUntilCalls.length !== 1) throw new Error(`expected exactly one settle registration, got ${waitUntilCalls.length}`);
  await waitUntilCalls[0]; // settle for real, with the Governor's clock now at t1

  const { rows } = gov.adapter.exec("SELECT budget_day, reserved_at, settled_at FROM reservations");
  if (rows.length !== 1) throw new Error(`expected exactly one reservation row, found ${rows.length}`);
  const row = rows[0];
  if (row.budget_day !== "2026-01-01") throw new Error(`expected budget_day "2026-01-01" (the day RESERVED on), got "${row.budget_day}"`);
  if (!(row.settled_at >= t1)) throw new Error(`expected settled_at (${row.settled_at}) to be at/after t1 (${t1}) -- settlement should have happened after the clock advanced past midnight`);

  return `reserved at 23:59:50 UTC (2026-01-01), settled at 00:00:05 UTC the next day; stored budget_day="${row.budget_day}" -- the day RESERVED on, not the day settled`;
}

// 4. A denied request writes nothing.
async function scenario4() {
  const gov = makeGovernor();
  const cfg = { ...BASE_GOVERNOR_CFG, ceiling: 0 }; // already "full" at 0 -- every reserve() denies
  const { env } = makeEnv({ governorCfgRaw: cfg, GOVERNOR: gov.GOVERNOR, aiStub: aiStubResolving() });
  const { ctx } = makeCtx();
  const token = await credential.mint(env, "sub-denied");

  const before = countReservationRows(gov.adapter);
  const res = await onRequestPost({ request: transformRequest(validSketchBody(), { token }), env, ctx });
  const after = countReservationRows(gov.adapter);
  const body = await res.json();

  if (res.status !== 503) throw new Error(`expected a denied request (ceiling:0) to answer 503, got ${res.status}`);
  if (body?.error?.code !== "resting") throw new Error(`expected denied.code "resting", got ${JSON.stringify(body)}`);
  if (after !== before) throw new Error(`a denied request wrote ${after - before} row(s) to the reservations table -- expected zero`);

  return `denied (${res.status} ${body.error.code}); reservations row count unchanged (${before} -> ${after})`;
}

// 5. A forged, expired, or wrong-type token causes zero I/O and 401 or 403.
async function scenario5() {
  const gov = makeGovernor();
  const cfg = { ...BASE_GOVERNOR_CFG };
  const { env, aiCalls } = makeEnv({ governorCfgRaw: cfg, GOVERNOR: gov.GOVERNOR, aiStub: aiStubResolving(), turnstileSecret: "abuse_check_turnstile_secret", origin: ORIGIN });
  const { ctx } = makeCtx();

  const cases = [];

  async function expectZeroIoRejection(label, request, expectedStatus) {
    const beforeReserve = gov.reserveCalls.length;
    const beforeAi = aiCalls.length;
    const res = await onRequestPost({ request, env, ctx });
    const afterReserve = gov.reserveCalls.length;
    const afterAi = aiCalls.length;
    if (res.status !== expectedStatus) throw new Error(`${label}: expected ${expectedStatus}, got ${res.status}`);
    if (afterReserve !== beforeReserve) throw new Error(`${label}: expected zero Governor reserve() calls, got ${afterReserve - beforeReserve}`);
    if (afterAi !== beforeAi) throw new Error(`${label}: expected zero AI calls, got ${afterAi - beforeAi}`);
    cases.push(`${label} -> ${res.status}`);
  }

  // (a) forged: a validly-minted credential, tampered signature.
  const validToken = await credential.mint(env, "sub-tamper");
  const tampered = validToken.slice(0, -1) + (validToken.endsWith("A") ? "B" : "A");
  await expectZeroIoRejection("forged (tampered signature)", transformRequest(validSketchBody(), { token: tampered }), 401);

  // (b) expired: a VALIDLY-SIGNED credential (built the same way
  // credential.js's own mint() would) whose exp is already in the past --
  // proves the real Date.now() > payload.exp check in credential.js's own
  // verify(), not a signature-mismatch shortcut.
  const past = Date.now() - 10_000;
  const expiredToken = await craftToken("c1.", env.ENTITLEMENT_SECRET, { sub: "sub-expired", iat: past - 1000, exp: past, v: 1 });
  await expectZeroIoRejection("expired (validly signed, exp in the past)", transformRequest(validSketchBody(), { token: expiredToken }), 401);

  // (c) wrong-type: a genuine, validly-minted `d1.` device token handed in
  // as the `Authorization` credential -- credential.js's own TOKEN_TYPE
  // check must reject it before any HMAC work, per that file's own header
  // comment (never a string-prefix check a refactor could accidentally
  // drop -- a fact about the cryptography).
  const realDeviceToken = await deviceToken.mint(env);
  await expectZeroIoRejection("wrong-type (a real d1. device token sent as Authorization)", transformRequest(validSketchBody(), { token: realDeviceToken }), 401);

  // (d) free-device path: a genuinely bad Turnstile token -- siteverify
  // itself answers (not unreachable/not_configured), but success:false, a
  // real "invalid" outcome per turnstile.js's own verifyDetailed() reason
  // mapping -> 403 human_check_failed, zero Governor/AI calls (checked
  // FIRST in the free path, before the device token or Governor is ever
  // touched).
  const restoreFetch = stubFetch(async () => ({ ok: true, json: async () => ({ success: false }) }));
  try {
    await expectZeroIoRejection("invalid Turnstile token (free path)", transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID, turnstile: "bad_turnstile_tok" }), 403);
  } finally {
    restoreFetch();
  }

  return cases.join("; ") + " -- zero Governor/AI calls in every case";
}

// 6. An old-shape request gets 400.
async function scenario6() {
  const gov = makeGovernor();
  const cfg = { ...BASE_GOVERNOR_CFG };
  const { env, aiCalls } = makeEnv({ governorCfgRaw: cfg, GOVERNOR: gov.GOVERNOR, aiStub: aiStubResolving() });
  const { ctx } = makeCtx();

  // The literal pre-Story-7.5 body shape ({image, prompt}) plus the old
  // x-app-token header a real installed old client would still send.
  const oldBody = { image: VALID_PNG_B64, prompt: "Draw a funny hat" };
  const req = transformRequest(oldBody, { xAppToken: "old_client_app_token_abc123" });
  const res = await onRequestPost({ request: req, env, ctx });
  const body = await res.json();

  if (res.status !== 400) throw new Error(`expected 400 for the old {image,prompt}+x-app-token shape, got ${res.status}`);
  if (body?.error?.code !== "bad_request") throw new Error(`expected error.code "bad_request", got ${JSON.stringify(body)}`);
  if (gov.reserveCalls.length !== 0) throw new Error(`expected zero Governor calls, got ${gov.reserveCalls.length}`);
  if (aiCalls.length !== 0) throw new Error(`expected zero AI calls, got ${aiCalls.length}`);

  return `old {image,prompt} shape + x-app-token header -> ${res.status} ${body.error.code}, zero Governor/AI calls`;
}

// 7. A mint flood cannot take more than one slice of the free share.
async function scenario7() {
  const gov = makeGovernor();
  // ceiling:10, reserveShare:0.1, freeSlices:1 -> freeShare = floor(10*0.1) = 1,
  // a single slice for the whole day -- at most ONE free-kind reservation
  // can ever succeed today, regardless of how many devices get minted.
  // mintPerHour:3 -- low enough that a small flood (5 requests) both grants
  // some mints AND denies the excess, without request-throttle.js's own
  // unrelated 5-attempts/10s pre-limit ever becoming the thing that denies
  // an attempt (5 attempts at the shared "mint" throttle key is exactly at,
  // never past, that separate limit).
  const cfg = { ...BASE_GOVERNOR_CFG, ceiling: 10, reserveShare: 0.1, freeSlices: 1, mintPerHour: 3 };
  const { env } = makeEnv({ governorCfgRaw: cfg, GOVERNOR: gov.GOVERNOR, aiStub: aiStubResolving("mint_flood_image_b64"), turnstileSecret: "abuse_check_turnstile_secret", origin: ORIGIN });
  const { ctx } = makeCtx();

  const restoreFetch = stubFetch(async () => ({ ok: true, json: async () => ({ success: true, action: "image", hostname: "8ish.app" }) }));
  const outcomes = [];
  try {
    for (let i = 0; i < 5; i++) {
      const req = transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID, turnstile: `flood_tok_${i}` });
      const res = await onRequestPost({ request: req, env, ctx });
      const body = await res.json();
      outcomes.push({ status: res.status, code: body?.error?.code, hasDevice: typeof body?.device === "string" });
    }
  } finally {
    restoreFetch();
  }

  const succeeded = outcomes.filter((o) => o.status === 200);
  const resting = outcomes.filter((o) => o.code === "resting"); // minted successfully, but the free-share slice cap still denied the image
  const rateLimited = outcomes.filter((o) => o.code === "rate_limited"); // mint itself denied, past mintPerHour

  if (rateLimited.length === 0) throw new Error(`expected at least one mint attempt past mintPerHour(3) to be denied rate_limited -- outcomes: ${JSON.stringify(outcomes)}`);
  for (const r of rateLimited) {
    if (r.hasDevice) throw new Error(`a rate_limited (mint-denied) response must never carry a device token -- got ${JSON.stringify(r)}`);
  }
  if (resting.length === 0) throw new Error(`expected at least one post-mint free reservation to be capped by the free-share slice (resting) even though its own mint succeeded -- outcomes: ${JSON.stringify(outcomes)}`);
  for (const r of resting) {
    if (!r.hasDevice) throw new Error(`a resting (free-share-capped) response after a successful mint must still carry the freshly-minted device token -- got ${JSON.stringify(r)}`);
  }
  if (succeeded.length < 1) throw new Error(`expected at least one full mint+free+model success -- outcomes: ${JSON.stringify(outcomes)}`);

  const mintCalls = gov.reserveCalls.filter((c) => c.kind === "mint").length;
  const freeCalls = gov.reserveCalls.filter((c) => c.kind === "free").length;
  if (mintCalls !== 5) throw new Error(`expected all 5 flood attempts to reach a real Governor mint reserve() call, got ${mintCalls}`);
  if (freeCalls !== succeeded.length + resting.length) {
    throw new Error(`expected exactly the mint-successful attempts (${succeeded.length + resting.length}) to reach a real free reserve() call, got ${freeCalls}`);
  }

  return `5 flood requests (mintPerHour=3, freeShare=1 slot/day): ${succeeded.length} fully succeeded, ${resting.length} minted a real device but were still capped by the free-share slice (resting), ${rateLimited.length} denied rate_limited past mintPerHour -- ${mintCalls} real mint reserve() calls, ${freeCalls} real free reserve() calls`;
}

// 8. Invalid governor config means resting.
async function scenario8() {
  const gov = makeGovernor();
  const badCfg = { ...BASE_GOVERNOR_CFG, ceiling: "80" }; // ceiling as a STRING -- malformed, fails validateGovernorConfig
  const { env } = makeEnv({ governorCfgRaw: badCfg, GOVERNOR: gov.GOVERNOR, aiStub: aiStubResolving() });
  const { ctx } = makeCtx();
  const token = await credential.mint(env, "sub-badcfg");

  const res = await onRequestPost({ request: transformRequest(validSketchBody(), { token }), env, ctx });
  const body = await res.json();

  if (res.status !== 503) throw new Error(`expected 503 for a malformed cfg:governor (ceiling as a string), got ${res.status}`);
  if (body?.error?.code !== "resting") throw new Error(`expected error.code "resting", got ${JSON.stringify(body)}`);
  if (gov.reserveCalls.length !== 0) throw new Error(`expected zero Governor reserve() calls on an invalid config, got ${gov.reserveCalls.length}`);

  return `malformed cfg:governor (ceiling:"80", a string, not a number) -> ${res.status} ${body.error.code}, zero Governor reserve() calls`;
}

// 9. AI_ENABLED false means resting with no AI call.
async function scenario9() {
  const outcomes = [];
  for (const aiEnabledValue of [undefined, "false"]) {
    const gov = makeGovernor();
    const cfg = { ...BASE_GOVERNOR_CFG };
    const { env, aiCalls } = makeEnv({ governorCfgRaw: cfg, GOVERNOR: gov.GOVERNOR, aiStub: aiStubResolving(), aiEnabled: aiEnabledValue });
    if (aiEnabledValue === undefined) delete env.AI_ENABLED; // makeEnv's own default parameter would otherwise turn `undefined` back into "true"
    const { ctx } = makeCtx();
    const token = await credential.mint(env, `sub-aidisabled-${String(aiEnabledValue)}`);

    const res = await onRequestPost({ request: transformRequest(validSketchBody(), { token }), env, ctx });
    const body = await res.json();

    if (res.status !== 503) throw new Error(`AI_ENABLED=${JSON.stringify(aiEnabledValue)}: expected 503, got ${res.status}`);
    if (body?.error?.code !== "resting") throw new Error(`AI_ENABLED=${JSON.stringify(aiEnabledValue)}: expected error.code "resting", got ${JSON.stringify(body)}`);
    if (aiCalls.length !== 0) throw new Error(`AI_ENABLED=${JSON.stringify(aiEnabledValue)}: expected zero AI calls, got ${aiCalls.length}`);
    if (gov.reserveCalls.length !== 0) throw new Error(`AI_ENABLED=${JSON.stringify(aiEnabledValue)}: expected zero Governor reserve() calls, got ${gov.reserveCalls.length}`);
    outcomes.push(`AI_ENABLED=${JSON.stringify(aiEnabledValue)} -> ${res.status} ${body.error.code}`);
  }
  return outcomes.join("; ") + " -- zero AI calls, zero Governor calls in both cases";
}

// --- local-mode runner -------------------------------------------------

const SCENARIOS = [
  { num: 1, title: "Concurrency at the ceiling never exceeds it by more than 1", fn: scenario1 },
  { num: 2, title: "A request abandoned after the model call still counts as spent", fn: scenario2 },
  { num: 3, title: "A reservation straddling the UTC day boundary is counted in the right day", fn: scenario3 },
  { num: 4, title: "A denied request writes nothing", fn: scenario4 },
  { num: 5, title: "A forged, expired, or wrong-type token causes zero I/O and 401 or 403", fn: scenario5 },
  { num: 6, title: "An old-shape request gets 400", fn: scenario6 },
  { num: 7, title: "A mint flood cannot take more than one slice of the free share", fn: scenario7 },
  { num: 8, title: "Invalid governor config means resting", fn: scenario8 },
  { num: 9, title: "AI_ENABLED false means resting with no AI call", fn: scenario9 },
];

async function runLocalScenarios() {
  console.log("8ish -- Story 7-9 abuse-check (local mode)");
  console.log("=".repeat(72));
  console.log("Exercising the REAL functions/api/transform.js against a REAL,");
  console.log("node:sqlite-backed Governor (functions/lib/governor-do.js /");
  console.log("governor-core.js). Zero real env.AI / Stripe / Turnstile calls.\n");

  let failedCount = 0;
  for (const { num, title, fn } of SCENARIOS) {
    // Fresh module-level state for every scenario -- see this file's header
    // comment for why this is needed even though each scenario also gets
    // its own fresh Governor/adapter.
    _resetRequestThrottleForTests();
    _resetGovernorConfigCacheForTests();
    try {
      const detail = await fn();
      console.log(`✔ ${num}. ${title}\n     ${detail}`);
    } catch (error) {
      failedCount++;
      const message = error && error.stack ? error.stack : String(error);
      console.log(`✘ ${num}. ${title}\n     FAIL: ${message.split("\n").join("\n     ")}`);
    }
  }

  console.log("\n" + "=".repeat(72));
  console.log(failedCount ? `${failedCount} of ${SCENARIOS.length} scenarios failed` : `all ${SCENARIOS.length} scenarios passed`);
  process.exitCode = failedCount ? 1 : 0;
}

// --- post-deploy mode (code-complete; NEVER invoked by this story itself) --
//
// Gated behind an explicit `--post-deploy <url>` CLI flag AND both
// CF_API_TOKEN/CF_ACCOUNT_ID environment variables. Implements the frozen
// Design Notes' own three checks against a REAL deployed URL: (a) a real
// burst above the WAF rate-limit rule (docs/runbook.md §1.1, 6 req/10s/IP)
// gets a 429 from Cloudflare's own edge; (b) the *.workers.dev address for
// this Worker does not answer at all (workers_dev:false in wrangler.jsonc);
// (c) via the Cloudflare API, no OTHER Worker on the account holds the `AI`
// binding. This function is fully implemented and ready to run -- this
// session never calls it (no real deployment exists yet to point it at; see
// this story's report).
async function runPostDeployMode(url) {
  const token = process.env.CF_API_TOKEN;
  const accountId = process.env.CF_ACCOUNT_ID;
  if (!token || !accountId) {
    console.error("--post-deploy requires CF_API_TOKEN and CF_ACCOUNT_ID in the environment (a Cloudflare API token with Workers Scripts:Read, and the account id) -- neither is read from anywhere else (no config file, no wrangler.jsonc secret). Export both and re-run.");
    process.exitCode = 1;
    return;
  }

  console.log(`8ish -- Story 7-9 abuse-check (POST-DEPLOY mode against ${url})`);
  console.log("=".repeat(72));

  const results = [];

  // (a) a real burst above the WAF rate-limit rule -- docs/runbook.md's own
  // documented rule (/api/* excluding /api/e, 6 requests/10s/IP) -- must
  // eventually answer 429 from Cloudflare's own edge, not from this app.
  try {
    const transformUrl = new URL("/api/transform", url).toString();
    const statuses = [];
    for (let i = 0; i < 20; i++) {
      const res = await fetch(transformUrl, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      statuses.push(res.status);
      if (res.status === 429) break;
    }
    if (!statuses.includes(429)) throw new Error(`sent ${statuses.length} requests, never saw a 429 -- statuses: ${statuses.join(",")}`);
    results.push({ ok: true, label: "a real burst above the WAF rate-limit rule gets 429", detail: `statuses seen: ${statuses.join(",")}` });
  } catch (error) {
    results.push({ ok: false, label: "a real burst above the WAF rate-limit rule gets 429", detail: String(error) });
  }

  // (b) the *.workers.dev address for this Worker must not answer at all.
  try {
    // Cloudflare's own <script-name>.<account-subdomain>.workers.dev shape;
    // the exact account subdomain is account-specific (set once in the
    // dashboard), read from there if this is ever run for real -- "8ish" is
    // this Worker's own script name (wrangler.jsonc's own `name`).
    const workersDevUrl = `https://8ish.${accountId}.workers.dev/`;
    let answered = true;
    try {
      await fetch(workersDevUrl, { method: "GET", signal: AbortSignal.timeout(5000) });
    } catch {
      answered = false;
    }
    if (answered) throw new Error(`the workers.dev address answered -- expected no response at all (workers_dev:false in wrangler.jsonc)`);
    results.push({ ok: true, label: "the *.workers.dev address does not answer", detail: workersDevUrl });
  } catch (error) {
    results.push({ ok: false, label: "the *.workers.dev address does not answer", detail: String(error) });
  }

  // (c) via the Cloudflare API: no OTHER Worker on the account holds the AI
  // binding (GET /accounts/:id/workers/scripts, then per-script binding
  // inspection).
  try {
    const listRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const listJson = await listRes.json();
    if (!listRes.ok || !listJson.success) throw new Error(`workers/scripts list failed: ${JSON.stringify(listJson)}`);
    const offenders = [];
    for (const script of listJson.result || []) {
      const bindingsRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${script.id}/bindings`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const bindingsJson = await bindingsRes.json();
      if (!bindingsRes.ok || !bindingsJson.success) throw new Error(`bindings read failed for script "${script.id}": ${JSON.stringify(bindingsJson)}`);
      const hasAiBinding = (bindingsJson.result || []).some((b) => b.type === "ai" || b.name === "AI");
      if (hasAiBinding && script.id !== "8ish") offenders.push(script.id);
    }
    if (offenders.length) throw new Error(`other Worker(s) on this account hold an AI binding: ${offenders.join(", ")}`);
    results.push({ ok: true, label: "no other Worker on the account holds the AI binding", detail: `checked ${(listJson.result || []).length} script(s)` });
  } catch (error) {
    results.push({ ok: false, label: "no other Worker on the account holds the AI binding", detail: String(error) });
  }

  const failedCount = results.filter((r) => !r.ok).length;
  for (const r of results) {
    console.log(`${r.ok ? "✔" : "✘"} ${r.label}\n     ${r.detail}`);
  }
  console.log("\n" + "=".repeat(72));
  console.log(failedCount ? `${failedCount} of ${results.length} post-deploy checks failed` : `all ${results.length} post-deploy checks passed`);
  process.exitCode = failedCount ? 1 : 0;
}

// --- entry point -------------------------------------------------------

function parsePostDeployUrl(argv) {
  const idx = argv.indexOf("--post-deploy");
  if (idx === -1) return null;
  const url = argv[idx + 1];
  if (!url) {
    console.error("--post-deploy requires a URL argument, e.g. --post-deploy https://8ish.app");
    process.exit(1);
  }
  return url;
}

const postDeployUrl = parsePostDeployUrl(process.argv.slice(2));
if (postDeployUrl) {
  await runPostDeployMode(postDeployUrl);
} else {
  await runLocalScenarios();
}
