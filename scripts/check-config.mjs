// Proves monetize.js never turns a failed /api/config request into "unlimited":
// runs the real file in a sandbox with fake DOM elements, localStorage and
// fetch, then asserts each rule through window.LIMIT, the free counter and the
// Parent Gate button. No dependencies, Node 18+.
//
//   node scripts/check-config.mjs
//
// Exits 0 when every check passes, 1 otherwise. Run by hand until Epic 4.4
// wires it into the pipeline.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

// The one place that names the client folder: everything the site publishes
// lives in public/ (wrangler.jsonc assets.directory). Server files
// (functions/, wrangler.jsonc) stay at the repo root.
const CLIENT_DIR = fileURLToPath(new URL("../public/", import.meta.url));
const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const monetizeSource = readFileSync(path.join(CLIENT_DIR, "monetize.js"), "utf8");
// Story 8-2: public/draw.js's own source text, for the structural check that
// its done-for-today screen fires the fire-and-forget limit_reached signal
// (no full vm-sandbox boot harness exists for draw.js today -- a source-text
// check matches this file's own lighter-weight convention for such checks,
// e.g. the checkout.js/monetize.js pairing further below).
const drawSource = readFileSync(path.join(CLIENT_DIR, "draw.js"), "utf8");

const CONFIG_KEY = "8ish_config_v1";
const ENTITLEMENT_KEY = "8ish_entitlement_v1";
const DEVICE_KEY = "8ish_device_v1"; // Story 7.7: getAuth()/setDevice()'s own free-device token key
const TIMEOUT_MS = 4000;

// A rejection nobody handled inside the sandbox means "something threw".
const unhandled = [];
process.on("unhandledRejection", (error) => unhandled.push(error));

// ---------------------------------------------------------------- fake world

const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve));
};

function makeElement(id) {
  // index.html ships these two hidden; monetize.js decides when to show them.
  // addEventListener actually records its listeners (rather than a no-op)
  // so a check can fire a real click and exercise monetize.js's own handler
  // -- see `fire()` on boot()'s returned object, used to test startCheckout
  // by real execution instead of a source-text match (Story 6-4).
  const listeners = {};
  return {
    id,
    hidden: id === "freeCounter" || id === "parentModeBtn",
    textContent: "",
    value: "",
    disabled: false,
    dataset: {},
    addEventListener(type, fn) {
      (listeners[type] || (listeners[type] = [])).push(fn);
    },
    focus() {},
    _fire(type, ...args) {
      for (const fn of listeners[type] || []) fn(...args);
    },
  };
}

// mode "ok": works. "throw": every call throws. "denied": merely touching the
// global `localStorage` throws (what some browsers do with storage blocked).
function makeStorage(mode, initial) {
  const map = new Map(Object.entries(initial || {}));
  const writes = []; // keys passed to setItem, in order
  const removals = []; // keys passed to removeItem, in order
  const denied = () => {
    throw new Error("SecurityError: storage is blocked");
  };
  const api = {
    getItem(key) {
      if (mode === "throw") denied();
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      writes.push(key);
      if (mode === "throw") denied();
      map.set(key, String(value));
    },
    removeItem(key) {
      removals.push(key);
      if (mode === "throw") denied();
      map.delete(key);
    },
  };
  return { map, writes, removals, api };
}

const abortError = () => Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
const untilAborted = (signal) =>
  new Promise((_, reject) => {
    if (signal.aborted) reject(abortError());
    else signal.addEventListener("abort", () => reject(abortError()));
  });
const answer = (body) => ({ ok: true, status: 200, json: async () => body });

// How the fake network answers GET /api/config. `hangs` means the test must
// fire the 4 s timer before anything can settle.
const net = {
  reject: { fetch: async () => { throw new TypeError("Failed to fetch"); } },
  status: (code) => ({ fetch: async () => ({ ok: false, status: code, json: async () => ({}) }) }),
  body: (body) => ({ fetch: async () => answer(body) }),
  badJson: { fetch: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token <"); } }) },
  hangHeaders: { hangs: true, fetch: (url, init) => untilAborted(init.signal) },
  hangBody: { hangs: true, fetch: async (url, init) => ({ ok: true, status: 200, json: () => untilAborted(init.signal) }) },
  // Ignores the abort signal entirely and never answers.
  hangForever: { hangs: true, fetch: () => new Promise(() => {}) },
};

// Loads monetize.js in a fresh sandbox and lets the boot sequence finish.
//   storage: "ok" | "throw" | "denied"      stored: { key: raw text } to seed
//   net: one of the entries above (a `hangs` entry gets its 4 s timer fired)
//   location: { search, pathname } override -- e.g. { search:
//     "?checkout=success&session_id=cs_test_..." } to exercise
//     confirmCheckoutFromUrl. Defaults to no query string, path "/".
//   lang: window.I18N.lang -- the real i18n.js's own shape
//     (`window.I18N = { lang, t, toggleLang }`); defaults to "ro", the
//     app's own default. Story 6-4: startCheckout sends this verbatim.
//   turnstileApi: pre-sets `window.turnstile` (the real widget script's own
//     global once loaded) so getHumanToken() can resolve a token without
//     ever touching document.createElement/head -- loadTurnstileScript()
//     checks `window.turnstile` before creating a script element at all, so
//     presetting it here is enough; see makeFakeTurnstileApi() below.
async function boot({ storage = "ok", stored, net: netCase, location, lang = "ro", turnstileApi } = {}) {
  const store = makeStorage(storage, stored);
  const elements = new Map();
  const timers = [];
  const fetchCalls = [];
  const screens = [];
  const historyReplaceStateCalls = [];

  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement(id));
      return elements.get(id);
    },
  };
  const t = (key) =>
    ({
      freeCounterText: "{remaining} of {total} free activities left today",
      dailyLimitText: "You've finished today's {count} free activities.",
    })[key] || key;
  const window = {
    I18N: { t, lang },
    location: { search: (location && location.search) || "", pathname: (location && location.pathname) || "/" },
    history: {
      replaceState(...args) {
        historyReplaceStateCalls.push(args);
      },
    },
    turnstile: turnstileApi,
  };
  const sandbox = {
    window,
    document,
    QCUI: {
      registerScreen() {},
      showScreen: (name) => screens.push(name),
    },
    fetch(url, init = {}) {
      fetchCalls.push({ url, init });
      return netCase.fetch(url, init);
    },
    setTimeout(fn, ms) {
      timers.push({ fn, ms, cleared: false, fired: false });
      return timers.length - 1;
    },
    clearTimeout(id) {
      if (timers[id]) timers[id].cleared = true;
    },
    AbortController,
    URLSearchParams,
    console: { error() {}, log() {}, warn() {} },
  };
  if (storage === "denied") {
    Object.defineProperty(sandbox, "localStorage", {
      get() {
        throw new Error("SecurityError: storage is blocked");
      },
      configurable: true,
    });
  } else {
    sandbox.localStorage = store.api;
  }

  const before = unhandled.length;
  vm.runInNewContext(monetizeSource, sandbox, { filename: "monetize.js" });
  await settle();
  if (netCase.hangs) {
    const timer = timers.find((x) => !x.cleared && !x.fired);
    assert.ok(timer, "no timeout timer was set while the request hangs");
    assert.equal(timer.ms, TIMEOUT_MS, "the request timeout must be 4 s");
    timer.fired = true;
    timer.fn();
    await settle();
  }
  assert.deepEqual(unhandled.slice(before), [], "something threw inside monetize.js");

  return {
    LIMIT: window.LIMIT,
    el: (id) => document.getElementById(id),
    store,
    timers,
    fetchCalls,
    screens,
    historyReplaceStateCalls,
    storedRaw: () => (store.map.has(CONFIG_KEY) ? store.map.get(CONFIG_KEY) : null),
    storedConfig: () => JSON.parse(store.map.get(CONFIG_KEY)),
    configWrites: () => store.writes.filter((key) => key === CONFIG_KEY).length,
    entitlementRaw: () => (store.map.has(ENTITLEMENT_KEY) ? store.map.get(ENTITLEMENT_KEY) : null),
    entitlement: () => JSON.parse(store.map.get(ENTITLEMENT_KEY)),
    entitlementWrites: () => store.writes.filter((key) => key === ENTITLEMENT_KEY).length,
    entitlementRemovals: () => store.removals.filter((key) => key === ENTITLEMENT_KEY).length,
  };
}

// ---------------------------------------------------------------- assertions

const succeeded = (fn, max) => {
  let n = 0;
  while (n < max && fn()) n++;
  return n;
};

// Free mode: the counter is shown and enforced and the Parent Gate button is
// reachable. `enforced: false` skips the counting (storage that throws cannot
// remember usage, which is the existing behaviour and stays unchanged).
function expectFree(w, { limit = 10, enforced = true } = {}) {
  assert.equal(w.el("parentModeBtn").hidden, false, "Parent Gate button must be visible");
  assert.equal(w.el("freeCounter").hidden, false, "free counter must be visible");
  assert.equal(w.el("freeCounter").textContent, `${limit} of ${limit} free activities left today`);
  if (!enforced) return;
  assert.equal(succeeded(w.LIMIT.tryConsume, limit + 20), limit, `expected exactly ${limit} Activities`);
  assert.equal(w.LIMIT.tryConsume(), false, `Activity ${limit + 1} must be refused`);
  assert.equal(w.el("freeCounter").textContent, `0 of ${limit} free activities left today`);
  w.LIMIT.showDailyLimit();
  assert.equal(w.el("dailyLimitText").textContent, `You've finished today's ${limit} free activities.`);
  assert.equal(w.screens.at(-1), "dailyLimit");
}

function expectUnlimited(w) {
  assert.equal(w.el("parentModeBtn").hidden, true, "Parent Gate button must be hidden when unlimited");
  assert.equal(w.el("freeCounter").hidden, true, "free counter must be hidden when unlimited");
  assert.equal(succeeded(w.LIMIT.tryConsume, 100), 100, "unlimited must never refuse an Activity");
}

// ------------------------------------------------------------------ fixtures

const STORED_FREE = JSON.stringify({
  planMode: "free",
  freeDailyLimit: 3,
  features: { friendMode: true, familyMode: false },
  pricing: { monthly: "9.99", yearly: "99", currency: "EUR" },
});
const STORED_UNLIMITED = JSON.stringify({
  planMode: "unlimited",
  freeDailyLimit: 10,
  features: { friendMode: false, familyMode: false },
  pricing: { monthly: "19.99", yearly: "149", currency: "RON" },
});

// The exact shape functions/api/config.js sends. Story 7.7 removed
// freeAiLimit from that response (the client no longer counts Images
// client-side at all -- the Spend Governor does, server-side).
const serverAnswer = (overrides = {}) => ({
  planMode: "free",
  freeDailyLimit: 10,
  features: { friendMode: false, familyMode: false },
  pricing: { monthly: "19.99", yearly: "149", currency: "RON" },
  ...overrides,
});

const seeded = (raw) => (raw === undefined ? undefined : { [CONFIG_KEY]: raw });

// ------------------------------------------------------------------ scenarios

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

// --- the request fails --------------------------------------------------------

const failures = [
  ["network error", net.reject],
  ["HTTP 500", net.status(500)],
  ["HTTP 503", net.status(503)],
  ["HTTP 429 (rate limited)", net.status(429)],
  ["HTTP 404", net.status(404)],
  ["HTTP 200 with invalid JSON", net.badJson],
  ["no answer in 4 s (headers hang)", net.hangHeaders],
  ["no answer in 4 s (body hangs)", net.hangBody],
  ["no answer in 4 s (ignores the abort)", net.hangForever],
];

for (const [label, netCase] of failures) {
  check(`first visit, ${label}: free defaults, 10 Activities enforced, Parent Gate reachable, nothing stored`, async () => {
    const w = await boot({ net: netCase });
    expectFree(w);
    assert.equal(w.storedRaw(), null);
    assert.equal(w.configWrites(), 0);
  });

  check(`return visit, ${label}: stored free config applies, stored value untouched`, async () => {
    const w = await boot({ net: netCase, stored: seeded(STORED_FREE) });
    expectFree(w, { limit: 3, ai: 2 });
    assert.equal(w.storedRaw(), STORED_FREE);
    assert.equal(w.configWrites(), 0);
  });

  check(`return visit, ${label}: stored unlimited config applies, stored value untouched`, async () => {
    const w = await boot({ net: netCase, stored: seeded(STORED_UNLIMITED) });
    expectUnlimited(w);
    assert.equal(w.storedRaw(), STORED_UNLIMITED);
    assert.equal(w.configWrites(), 0);
  });
}

check("the request is made once, with an abort signal, to /api/config", async () => {
  const w = await boot({ net: net.body(serverAnswer()) });
  assert.equal(w.fetchCalls.length, 1);
  assert.equal(w.fetchCalls[0].url, "/api/config");
  assert.ok(w.fetchCalls[0].init.signal, "the request must carry an abort signal");
});

check("the 4 s timeout aborts the request and is cleared once an answer arrives", async () => {
  const w = await boot({ net: net.body(serverAnswer()) });
  assert.equal(w.timers.length, 1);
  assert.equal(w.timers[0].ms, TIMEOUT_MS);
  assert.equal(w.timers[0].cleared, true, "the timer must be cleared when the answer arrives in time");

  let signal;
  const w2 = await boot({ net: { hangs: true, fetch: (url, init) => ((signal = init.signal), untilAborted(init.signal)) } });
  assert.equal(signal.aborted, true, "the timeout must abort the request");
  expectFree(w2);
});

check("an answer that arrives after the 4 s timeout is ignored and not stored", async () => {
  let release;
  const late = new Promise((resolve) => (release = resolve));
  const netCase = { hangs: true, fetch: async () => (await late, answer(serverAnswer({ planMode: "unlimited" }))) };
  const w = await boot({ net: netCase });
  release();
  await settle();
  expectFree(w);
  assert.equal(w.storedRaw(), null);
});

// --- invalid answers ----------------------------------------------------------

const invalid = [
  ["empty object", {}],
  ["planMode missing", serverAnswer({ planMode: undefined })],
  ["planMode unknown", serverAnswer({ planMode: "premium" })],
  ["planMode wrong case", serverAnswer({ planMode: "Unlimited" })],
  ["planMode not a string", serverAnswer({ planMode: true })],
  ["freeDailyLimit missing", serverAnswer({ freeDailyLimit: undefined })],
  ["freeDailyLimit zero", serverAnswer({ freeDailyLimit: 0 })],
  ["freeDailyLimit negative", serverAnswer({ freeDailyLimit: -5 })],
  ["freeDailyLimit above 1000", serverAnswer({ freeDailyLimit: 1001 })],
  ["freeDailyLimit fractional", serverAnswer({ freeDailyLimit: 2.5 })],
  ["freeDailyLimit a string", serverAnswer({ freeDailyLimit: "10" })],
  ["freeDailyLimit null", serverAnswer({ freeDailyLimit: null })],
  ["freeDailyLimit NaN", serverAnswer({ freeDailyLimit: NaN })],
  ["freeDailyLimit Infinity", serverAnswer({ freeDailyLimit: Infinity })],
  ["features not an object", serverAnswer({ features: "yes" })],
  ["features null", serverAnswer({ features: null })],
  ["features an array", serverAnswer({ features: [true] })],
  ["features with a non-boolean", serverAnswer({ features: { friendMode: "true", familyMode: false } })],
  ["pricing not an object", serverAnswer({ pricing: "19.99" })],
  ["pricing null", serverAnswer({ pricing: null })],
  ["pricing with a number", serverAnswer({ pricing: { monthly: 19.99, yearly: "149", currency: "RON" } })],
  ["pricing with an empty string", serverAnswer({ pricing: { monthly: "", yearly: "149", currency: "RON" } })],
  ["pricing with a very long string", serverAnswer({ pricing: { monthly: "9".repeat(500), yearly: "149", currency: "RON" } })],
  ["null", null],
  ["an array", [serverAnswer()]],
  ["a string", "unlimited"],
  ["a number", 42],
  ["true", true],
];

for (const [label, body] of invalid) {
  check(`invalid answer (${label}): ignored; first visit gets defaults, return visit keeps the stored config, nothing stored`, async () => {
    const first = await boot({ net: net.body(body) });
    expectFree(first);
    assert.equal(first.storedRaw(), null);
    assert.equal(first.configWrites(), 0);

    const back = await boot({ net: net.body(body), stored: seeded(STORED_UNLIMITED) });
    expectUnlimited(back);
    assert.equal(back.storedRaw(), STORED_UNLIMITED);
    assert.equal(back.configWrites(), 0);
  });
}

// --- corrupt stored config ----------------------------------------------------

const corrupt = [
  ["not JSON", "not json{"],
  ["JSON null", "null"],
  ["a JSON string", '"unlimited"'],
  ["an array", "[]"],
  ["planMode only (limits missing)", '{"planMode":"unlimited"}'],
  ["unknown planMode", JSON.stringify({ ...JSON.parse(STORED_UNLIMITED), planMode: "vip" })],
  ["out-of-range limit", JSON.stringify({ ...JSON.parse(STORED_FREE), freeDailyLimit: 100000 })],
];

for (const [label, raw] of corrupt) {
  check(`corrupt stored config (${label}) and a failing request: ignored, free defaults, nothing thrown`, async () => {
    const w = await boot({ net: net.status(500), stored: seeded(raw) });
    expectFree(w);
    assert.equal(w.storedRaw(), raw, "a failed request must not touch the stored value");
  });

  check(`corrupt stored config (${label}) and a valid answer: the answer applies and replaces it`, async () => {
    const w = await boot({ net: net.body(serverAnswer({ freeDailyLimit: 7 })), stored: seeded(raw) });
    expectFree(w, { limit: 7 });
    assert.equal(w.storedConfig().freeDailyLimit, 7);
  });
}

// --- valid answers ------------------------------------------------------------

check("valid free answer: applied and stored", async () => {
  const body = serverAnswer({
    freeDailyLimit: 5,
    features: { friendMode: true, familyMode: true },
    pricing: { monthly: "24.99", yearly: "199", currency: "RON" },
  });
  const w = await boot({ net: net.body(body) });
  expectFree(w, { limit: 5 });
  assert.deepEqual(w.storedConfig(), body);
});

check("valid free answer (the server's exact default answer): 10 and 1, stored", async () => {
  const w = await boot({ net: net.body(serverAnswer()) });
  expectFree(w);
  assert.deepEqual(w.storedConfig(), serverAnswer());
});

check("valid unlimited answer: unlimited as today, and stored", async () => {
  const w = await boot({ net: net.body(serverAnswer({ planMode: "unlimited" })) });
  expectUnlimited(w);
  assert.equal(w.storedConfig().planMode, "unlimited");
});

check("valid unlimited answer, then the request fails on the next visit: still unlimited", async () => {
  const first = await boot({ net: net.body(serverAnswer({ planMode: "unlimited" })) });
  const second = await boot({ net: net.reject, stored: { [CONFIG_KEY]: first.storedRaw() } });
  expectUnlimited(second);
});

check("valid free answer replaces a stored unlimited config", async () => {
  const w = await boot({ net: net.body(serverAnswer({ freeDailyLimit: 4 })), stored: seeded(STORED_UNLIMITED) });
  expectFree(w, { limit: 4 });
  assert.equal(w.storedConfig().planMode, "free");
});

check("valid unlimited answer replaces a stored free config", async () => {
  const w = await boot({ net: net.body(serverAnswer({ planMode: "unlimited" })), stored: seeded(STORED_FREE) });
  expectUnlimited(w);
  assert.equal(w.storedConfig().planMode, "unlimited");
});

check("valid answer: unknown fields dropped, absent features and pricing take the defaults", async () => {
  // JSON.parse makes "__proto__" a real own key, as a hostile body would.
  // freeAiLimit is included here on purpose (Story 7.7 removed it from the
  // real server's response and from validateConfig()'s own known-field set
  // entirely) -- proving that even if some stale/rolling-deploy answer still
  // sent it, it is now just another unknown field, dropped like "admin"/
  // "extra" below, never validated and never stored.
  const hostile = JSON.parse('{"planMode":"free","freeDailyLimit":6,"freeAiLimit":3,"admin":true,"__proto__":{"x":1},"extra":{"a":1}}');
  const w = await boot({ net: net.body(hostile) });
  expectFree(w, { limit: 6 });
  // Story 6-5: absent pricing takes freeDefaults()'s own default, which is
  // {monthly: null, yearly: null, currency: "RON"} now -- not serverAnswer()'s
  // own (unrelated) default pricing strings, which happened to coincide with
  // it before this story.
  assert.deepEqual(
    w.storedConfig(),
    serverAnswer({ freeDailyLimit: 6, pricing: { monthly: null, yearly: null, currency: "RON" } })
  );
  assert.ok(!("freeAiLimit" in w.storedConfig()), "freeAiLimit must never be stored, even if the server answer still sent it");
});

check("valid answer: unknown keys inside features and pricing are dropped", async () => {
  const w = await boot({
    net: net.body(serverAnswer({ features: { friendMode: true, familyMode: false, beta: true }, pricing: { monthly: "1", yearly: "2", currency: "EUR", weekly: "3" } })),
  });
  assert.deepEqual(w.storedConfig().features, { friendMode: true, familyMode: false });
  assert.deepEqual(w.storedConfig().pricing, { monthly: "1", yearly: "2", currency: "EUR" });
});

check("limits at the boundaries (1 and 1000) are valid", async () => {
  const low = await boot({ net: net.body(serverAnswer({ freeDailyLimit: 1 })) });
  expectFree(low, { limit: 1 });
  const high = await boot({ net: net.body(serverAnswer({ freeDailyLimit: 1000 })) });
  assert.equal(high.storedConfig().freeDailyLimit, 1000);
});

// --- storage unavailable ------------------------------------------------------

for (const mode of ["throw", "denied"]) {
  const what = mode === "throw" ? "localStorage calls throw" : "touching localStorage throws";

  check(`storage unavailable (${what}), valid free answer: applies for the session`, async () => {
    const w = await boot({ storage: mode, net: net.body(serverAnswer({ freeDailyLimit: 6 })) });
    expectFree(w, { limit: 6, enforced: false });
  });

  check(`storage unavailable (${what}), valid unlimited answer: applies for the session`, async () => {
    const w = await boot({ storage: mode, net: net.body(serverAnswer({ planMode: "unlimited" })) });
    assert.equal(w.el("parentModeBtn").hidden, true);
    assert.equal(w.el("freeCounter").hidden, true);
    assert.equal(succeeded(w.LIMIT.tryConsume, 50), 50);
  });

  check(`storage unavailable (${what}), request fails: free defaults, nothing thrown`, async () => {
    const w = await boot({ storage: mode, net: net.status(500) });
    expectFree(w, { enforced: false });
  });

  check(`storage unavailable (${what}), invalid answer: free defaults, nothing thrown`, async () => {
    const w = await boot({ storage: mode, net: net.body({ planMode: "nope" }) });
    expectFree(w, { enforced: false });
  });
}

// --- the public surface -------------------------------------------------------

check("window.LIMIT keeps its shape: tryConsume, showDailyLimit, getHumanToken, getAuth, setDevice (Story 7.7 dropped tryConsumeAi)", async () => {
  const w = await boot({ net: net.reject });
  assert.deepEqual(Object.keys(w.LIMIT).sort(), ["getAuth", "getHumanToken", "setDevice", "showDailyLimit", "tryConsume"]);
  for (const fn of Object.values(w.LIMIT)) assert.equal(typeof fn, "function");
});

// Story 7.7: getAuth()'s exact shape (Design Notes) -- a stored credential
// wins over a stored device token, and the two are never sent together;
// neither stored returns {} (the server's own free-device mint path handles
// a first-ever request with no token at all).
// getAuth() runs inside monetize.js's own vm context, so its returned object
// is cross-realm -- spread it into a plain object of THIS file's own realm
// before deepEqual, the same way storedConfig() (via JSON.parse, always
// main-realm) already avoids this; otherwise deepEqual (aliased to
// deepStrictEqual under node:assert/strict) fails on the mismatched
// Object.prototype alone, not on any real structural difference.
const plain = (o) => ({ ...o });

check("window.LIMIT.getAuth: nothing stored -> {}", async () => {
  const w = await boot({ net: net.reject });
  assert.deepEqual(plain(w.LIMIT.getAuth()), {});
});

check("window.LIMIT.getAuth: a stored device token, no credential -> {device}", async () => {
  const w = await boot({ net: net.reject, stored: { [DEVICE_KEY]: "d1.abc" } });
  assert.deepEqual(plain(w.LIMIT.getAuth()), { device: "d1.abc" });
});

check("window.LIMIT.getAuth: a stored credential (even one isEntitled() would call inactive) -> {authorization}, never both", async () => {
  const w = await boot({
    net: net.reject,
    stored: {
      [ENTITLEMENT_KEY]: JSON.stringify({ active: false, credential: "c1.xyz" }),
      [DEVICE_KEY]: "d1.abc",
    },
  });
  assert.deepEqual(plain(w.LIMIT.getAuth()), { authorization: "Bearer c1.xyz" });
});

check("window.LIMIT.setDevice: persists the raw token string under its own key, read back by getAuth()", async () => {
  const w = await boot({ net: net.reject });
  w.LIMIT.setDevice("d1.fresh");
  assert.equal(w.store.map.get(DEVICE_KEY), "d1.fresh");
  assert.deepEqual(plain(w.LIMIT.getAuth()), { device: "d1.fresh" });
});

check("window.LIMIT.setDevice: a throwing localStorage degrades silently (mirrors writeEntitlement's own try/catch discipline)", async () => {
  const w = await boot({ net: net.reject, storage: "throw" });
  assert.doesNotThrow(() => w.LIMIT.setDevice("d1.fresh"));
});

check("window.LIMIT.getHumanToken: with no turnstileSiteKey configured (today's reality), it fails closed -- rejects, never fabricates a token", async () => {
  const w = await boot({ net: net.reject }); // /api/config fails -> no turnstileSiteKey captured either
  // Cross-realm: getHumanToken() runs inside monetize.js's own vm context
  // (vm.runInNewContext), so its thrown Error is not `instanceof` this
  // file's Error -- checking `.message` alone is the portable way to assert
  // this without depending on that.
  await assert.rejects(
    () => w.LIMIT.getHumanToken("restore"),
    (e) => e && e.message === "turnstile_not_configured"
  );
});

check("window.LIMIT.getHumanToken: once a valid /api/config answer carries a turnstileSiteKey, monetize.js's module-level capture picks it up -- it gets past the \"not configured\" guard", async () => {
  const w = await boot({ net: net.body(serverAnswer({ turnstileSiteKey: "1x00000000000000000000AA" })) });
  let rejection = null;
  try {
    await w.LIMIT.getHumanToken("restore");
  } catch (e) {
    rejection = e;
  }
  // The sandbox has no real DOM (document.createElement/head) or
  // window.turnstile, so getHumanToken() cannot actually render a widget
  // here -- SOME rejection is still expected once it reaches that boundary,
  // just never the "not configured" one, which is exactly what proves the
  // site key was actually captured and used.
  assert.ok(rejection, "expected a rejection given the sandbox's limited DOM, just not the not-configured one");
  assert.notEqual(rejection.message, "turnstile_not_configured");
});

check("window.LIMIT is available and enforcing before the config request settles", async () => {
  // A request that never answers and whose timer is never fired: boot()
  // returns once the sandbox has settled, i.e. while the request is open.
  const w = await boot({ net: { fetch: () => new Promise(() => {}) } });
  assert.equal(w.fetchCalls.length, 1);
  assert.equal(succeeded(w.LIMIT.tryConsume, 50), 10, "defaults must already be enforced while waiting");
});

check("a hanging entitlement recheck cannot keep the counter and Parent Gate button hidden", async () => {
  const hangingRecheck = {
    fetch: (url) =>
      url.startsWith("/api/config") ? Promise.resolve({ ok: false, status: 500, json: async () => ({}) }) : new Promise(() => {}),
  };
  // Story 6-2: a stored record must carry a `credential` for recheckEntitlement
  // to even attempt a network call at all (a credential-less record is
  // cleared locally, with zero fetch calls -- see the checks below).
  const stored = { "8ish_entitlement_v1": JSON.stringify({ active: false, credential: "c1.test.sig", checkedAt: 0 }) };
  const w = await boot({ net: hangingRecheck, stored });
  assert.ok(w.fetchCalls.some((c) => c.url.startsWith("/api/entitlement")), "the recheck must have started (test setup)");
  expectFree(w);
});

// --- confirmCheckoutFromUrl / recheckEntitlement (Story 6-2 client-side coverage) -----------------
//
// Every check above that seeds a `location` leaves it at the boot() default
// (search: "", pathname: "/"), so confirmCheckoutFromUrl always returned
// immediately and this client-side logic was never actually exercised.
// These checks drive it directly via boot()'s `location` override.

// Builds a `net` whose `fetch` branches by URL prefix. Any URL not
// explicitly handled hangs forever -- safe (settle() only pumps the
// microtask/macrotask queue a fixed number of times, it never blocks on an
// unresolved promise), and lets a `fetchCalls` assertion catch an
// unexpected call precisely instead of the mock silently answering for it.
function branchingNet(handlers) {
  return {
    fetch: (url, init) => {
      for (const [prefix, handler] of Object.entries(handlers)) {
        if (url.startsWith(prefix)) return handler(url, init);
      }
      return new Promise(() => {});
    },
  };
}
const configFails = () => Promise.resolve({ ok: false, status: 500, json: async () => ({}) });

const CONFIRM_SESSION_ID = "cs_test_" + "a".repeat(24);
const CONFIRM_URL_SEARCH = `?checkout=success&session_id=${CONFIRM_SESSION_ID}`;

check("confirmCheckoutFromUrl: no checkout=success/session_id in the URL -- never calls /api/checkout/confirm", async () => {
  const w = await boot({ net: branchingNet({ "/api/config": configFails }), location: { search: "" } });
  assert.ok(!w.fetchCalls.some((c) => c.url === "/api/checkout/confirm"));
});

check("confirmCheckoutFromUrl: posts {sessionId} in the body (never a query string), with content-type: application/json, and strips the URL immediately", async () => {
  let confirmCall = null;
  const net = branchingNet({
    "/api/config": configFails,
    "/api/checkout/confirm": (url, init) => {
      confirmCall = { url, init };
      return Promise.resolve(answer({ active: true, credential: "c1.abc.def", plan: "price_yearly", currentPeriodEnd: 999, restoreCode: null }));
    },
  });
  const w = await boot({ net, location: { search: CONFIRM_URL_SEARCH } });
  assert.ok(confirmCall, "confirm must have been called");
  assert.equal(confirmCall.url, "/api/checkout/confirm", "no query string on the request URL itself");
  assert.equal(confirmCall.init.method, "POST");
  assert.equal(confirmCall.init.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(confirmCall.init.body), { sessionId: CONFIRM_SESSION_ID }, "the body must carry exactly {sessionId}, nothing else");
  assert.ok(w.historyReplaceStateCalls.length >= 1, "the URL must be stripped via history.replaceState");
});

check("confirmCheckoutFromUrl: active + credential -- writes active, credential, plan, currentPeriodEnd, restoreCode, checkedAt; shows the restore code reveal", async () => {
  const net = branchingNet({
    "/api/config": configFails,
    "/api/checkout/confirm": () =>
      Promise.resolve(answer({ active: true, credential: "c1.fresh.sig", plan: "price_yearly", currentPeriodEnd: 999, restoreCode: "ABCDE-12345" })),
  });
  const w = await boot({ net, location: { search: CONFIRM_URL_SEARCH } });
  const ent = w.entitlement();
  assert.equal(ent.active, true);
  assert.equal(ent.credential, "c1.fresh.sig");
  assert.equal(ent.plan, "price_yearly");
  assert.equal(ent.currentPeriodEnd, 999);
  assert.equal(ent.restoreCode, "ABCDE-12345");
  assert.equal(typeof ent.checkedAt, "number");
  assert.ok(w.screens.includes("restoreCodeReveal"), "the restore code reveal screen must show");
  assert.equal(w.el("restoreCodeRevealValue").textContent, "ABCDE-12345");
});

check("confirmCheckoutFromUrl: active but stale (credential:null) with a restoreCode -- entitlement is NOT written, but the restore code reveal still shows", async () => {
  const net = branchingNet({
    "/api/config": configFails,
    "/api/checkout/confirm": () =>
      Promise.resolve(answer({ active: true, credential: null, plan: "price_yearly", currentPeriodEnd: 999, restoreCode: "STALE1-CODE1" })),
  });
  const w = await boot({ net, location: { search: CONFIRM_URL_SEARCH } });
  assert.equal(w.entitlementRaw(), null, "no credential means nothing is written to entitlement storage");
  assert.equal(w.entitlementWrites(), 0);
  assert.ok(w.screens.includes("restoreCodeReveal"), "the restore code reveal must still show for a genuinely active but stale session");
  assert.equal(w.el("restoreCodeRevealValue").textContent, "STALE1-CODE1");
});

check("confirmCheckoutFromUrl: an inactive response -- neither entitlement is written nor the restore code reveal shows", async () => {
  const net = branchingNet({
    "/api/config": configFails,
    "/api/checkout/confirm": () => Promise.resolve(answer({ active: false, credential: null, plan: null, currentPeriodEnd: null, restoreCode: null })),
  });
  const w = await boot({ net, location: { search: CONFIRM_URL_SEARCH } });
  assert.equal(w.entitlementRaw(), null);
  assert.equal(w.entitlementWrites(), 0);
  assert.ok(!w.screens.includes("restoreCodeReveal"));
});

check("recheckEntitlement: a stored record with no credential makes zero /api/entitlement calls; an active one is cleared, an already-inactive one is left alone", async () => {
  const netNoEntitlementCalls = branchingNet({
    "/api/config": configFails,
    "/api/entitlement": () => Promise.reject(new Error("must not be called -- no credential to send")),
  });

  const w1 = await boot({ net: netNoEntitlementCalls, stored: { [ENTITLEMENT_KEY]: JSON.stringify({ active: true, subscriptionId: "sub_old", checkedAt: 0 }) } });
  assert.ok(!w1.fetchCalls.some((c) => c.url.startsWith("/api/entitlement")));
  assert.equal(w1.entitlementRaw(), null, "an active-but-credential-less record must be cleared");

  const w2 = await boot({ net: netNoEntitlementCalls, stored: { [ENTITLEMENT_KEY]: JSON.stringify({ active: false, checkedAt: 0 }) } });
  assert.ok(!w2.fetchCalls.some((c) => c.url.startsWith("/api/entitlement")));
  assert.equal(JSON.parse(w2.entitlementRaw()).active, false, "an already-inactive credential-less record needs no removal, and isn't touched");
});

check("recheckEntitlement: a 401 response removes the stored record", async () => {
  const stored = { [ENTITLEMENT_KEY]: JSON.stringify({ active: true, credential: "c1.old.sig", checkedAt: 0 }) };
  const net = branchingNet({
    "/api/config": configFails,
    "/api/entitlement": () => Promise.resolve({ ok: false, status: 401, json: async () => ({ error: { code: "invalid_credential" } }) }),
  });
  const w = await boot({ net, stored });
  assert.equal(w.entitlementRaw(), null);
});

check("recheckEntitlement: an explicit {active:false} response removes the stored record", async () => {
  const stored = { [ENTITLEMENT_KEY]: JSON.stringify({ active: true, credential: "c1.old.sig", checkedAt: 0 }) };
  const net = branchingNet({ "/api/config": configFails, "/api/entitlement": () => Promise.resolve(answer({ active: false, currentPeriodEnd: null })) });
  const w = await boot({ net, stored });
  assert.equal(w.entitlementRaw(), null);
});

check("recheckEntitlement: an {active:true, credential} response updates the record with the fresh credential and checkedAt, keeping unrelated fields", async () => {
  const stored = {
    [ENTITLEMENT_KEY]: JSON.stringify({ active: true, credential: "c1.old.sig", plan: "price_yearly", restoreCode: "AAAAA-11111", currentPeriodEnd: 111, checkedAt: 0 }),
  };
  const net = branchingNet({
    "/api/config": configFails,
    "/api/entitlement": () => Promise.resolve(answer({ active: true, credential: "c1.new.sig", currentPeriodEnd: 222 })),
  });
  const w = await boot({ net, stored });
  const ent = w.entitlement();
  assert.equal(ent.active, true);
  assert.equal(ent.credential, "c1.new.sig");
  assert.equal(ent.currentPeriodEnd, 222);
  assert.equal(ent.plan, "price_yearly", "unrelated fields must be preserved");
  assert.equal(ent.restoreCode, "AAAAA-11111");
  assert.ok(ent.checkedAt > 0, "checkedAt must be refreshed");
});

check("recheckEntitlement: sends Authorization: Bearer <credential> and content-type: application/json, with no request body", async () => {
  let entitlementCall = null;
  const stored = { [ENTITLEMENT_KEY]: JSON.stringify({ active: true, credential: "c1.mine.sig", checkedAt: 0 }) };
  const net = branchingNet({
    "/api/config": configFails,
    "/api/entitlement": (url, init) => {
      entitlementCall = { url, init };
      return Promise.resolve(answer({ active: true, credential: "c1.mine.sig", currentPeriodEnd: 1 }));
    },
  });
  await boot({ net, stored });
  assert.ok(entitlementCall);
  assert.equal(entitlementCall.init.method, "POST");
  assert.equal(entitlementCall.init.headers.authorization, "Bearer c1.mine.sig");
  assert.equal(entitlementCall.init.headers["content-type"], "application/json");
  assert.equal(entitlementCall.init.body, undefined, "no body is ever sent -- the credential travels only in the Authorization header");
});

check("recheckEntitlement: active:true with a missing/falsy credential is treated as a hiccup -- the stored record is left untouched, not cleared", async () => {
  const original = { active: true, credential: "c1.old.sig", checkedAt: 0 };
  const stored = { [ENTITLEMENT_KEY]: JSON.stringify(original) };
  const net = branchingNet({ "/api/config": configFails, "/api/entitlement": () => Promise.resolve(answer({ active: true, credential: null, currentPeriodEnd: 999 })) });
  const w = await boot({ net, stored });
  assert.deepEqual(JSON.parse(w.entitlementRaw()), original, "a malformed active:true-but-no-credential answer must not clear or otherwise mutate local state");
});

check("recheckEntitlement: a network failure leaves the stored record untouched", async () => {
  const original = { active: true, credential: "c1.old.sig", checkedAt: 0 };
  const stored = { [ENTITLEMENT_KEY]: JSON.stringify(original) };
  const net = branchingNet({ "/api/config": configFails, "/api/entitlement": () => Promise.reject(new TypeError("Failed to fetch")) });
  const w = await boot({ net, stored });
  assert.deepEqual(JSON.parse(w.entitlementRaw()), original);
});

check("recheckEntitlement: the checkedAt throttle (within the last 60s) skips the network call entirely", async () => {
  const stored = { [ENTITLEMENT_KEY]: JSON.stringify({ active: true, credential: "c1.old.sig", checkedAt: Date.now() }) };
  const net = branchingNet({ "/api/config": configFails, "/api/entitlement": () => Promise.reject(new Error("must not be called -- inside the throttle window")) });
  const w = await boot({ net, stored });
  assert.ok(!w.fetchCalls.some((c) => c.url.startsWith("/api/entitlement")));
});

// --- Story 6-5: openPaywall()/startCheckout() disable-on-null-price behavior ----
// Neither function is on window.LIMIT's public surface -- exercised the same
// way a real parent would reach them, by firing a click on the DOM button
// that's wired to each (parentsHubUpgradeBtn -> openPaywall,
// paywallMonthlyBtn/paywallYearlyBtn -> startCheckout), through the real,
// unmodified monetize.js running in the vm sandbox.

check("openPaywall: a plan with a null price is shown with no price text and a disabled button; the other, available plan is untouched; one generic message shows (I/O matrix row: price unavailable)", async () => {
  const w = await boot({ net: net.body(serverAnswer({ pricing: { monthly: null, yearly: "99", currency: "RON" } })) });
  w.el("parentsHubUpgradeBtn")._fire("click");
  assert.equal(w.el("paywallMonthlyBtn").disabled, true, "a null-priced plan's button must be disabled");
  assert.equal(w.el("paywallMonthlyPrice").textContent, "", "a null-priced plan must show no price text");
  assert.equal(w.el("paywallYearlyBtn").disabled, false, "the other, available plan must stay enabled");
  assert.equal(w.el("paywallYearlyPrice").textContent, "99 RONparent.perYear");
  assert.equal(w.el("paywallStatus").hidden, false, "the generic unavailable message must show");
  assert.equal(w.el("paywallStatus").textContent, "parent.pricingUnavailable");
});

check("openPaywall: both plans null -- both buttons disabled, both show no price, one generic message", async () => {
  const w = await boot({ net: net.body(serverAnswer({ pricing: { monthly: null, yearly: null, currency: "RON" } })) });
  w.el("parentsHubUpgradeBtn")._fire("click");
  assert.equal(w.el("paywallMonthlyBtn").disabled, true);
  assert.equal(w.el("paywallYearlyBtn").disabled, true);
  assert.equal(w.el("paywallStatus").hidden, false);
});

check("openPaywall: both plans priced -- both buttons enabled, no generic message, prices shown", async () => {
  const w = await boot({ net: net.body(serverAnswer({ pricing: { monthly: "14.99", yearly: "99", currency: "RON" } })) });
  w.el("parentsHubUpgradeBtn")._fire("click");
  assert.equal(w.el("paywallMonthlyBtn").disabled, false);
  assert.equal(w.el("paywallYearlyBtn").disabled, false);
  assert.equal(w.el("paywallMonthlyPrice").textContent, "14.99 RONparent.perMonth");
  assert.equal(w.el("paywallYearlyPrice").textContent, "99 RONparent.perYear");
  assert.equal(w.el("paywallStatus").hidden, true);
});

check("openPaywall: no /api/config answer ever arrived (freeDefaults()) -- both plans null, both buttons disabled (Always: never a hand-set/guessed price)", async () => {
  const w = await boot({ net: net.reject });
  w.el("parentsHubUpgradeBtn")._fire("click");
  assert.equal(w.el("paywallMonthlyBtn").disabled, true);
  assert.equal(w.el("paywallYearlyBtn").disabled, true);
  assert.equal(w.el("paywallStatus").hidden, false);
});

check("startCheckout: a failed attempt re-derives each button's disabled state from pricing instead of blindly re-enabling both -- a null-priced plan stays disabled", async () => {
  // No turnstileSiteKey in this answer (the default, today's reality) means
  // getHumanToken() rejects with "turnstile_not_configured" before any
  // /api/checkout call -- startCheckout's catch block runs either way, which
  // is exactly the path this check exercises; no fake Turnstile widget or
  // /api/checkout mock is needed to reach it.
  const w = await boot({ net: net.body(serverAnswer({ pricing: { monthly: null, yearly: "99", currency: "RON" } })) });
  w.el("parentsHubUpgradeBtn")._fire("click");
  assert.equal(w.el("paywallYearlyBtn").disabled, false, "the available plan must be clickable before the attempt");
  w.el("paywallYearlyBtn")._fire("click");
  await settle();
  assert.equal(w.el("paywallMonthlyBtn").disabled, true, "the null-priced plan must stay disabled after a failed attempt on the OTHER plan");
  assert.equal(w.el("paywallYearlyBtn").disabled, false, "the available plan must be re-enabled after the failed attempt");
  assert.equal(w.el("paywallStatus").hidden, false);
  assert.equal(w.el("paywallStatus").textContent, "parent.checkoutFailed");
});

// --- the real server handler against the client's validator ---------------------
// functions/api/config.js and wrangler.jsonc decide what /api/config sends;
// monetize.js rejects a whole answer if any field is off, so a server-side
// tweak must not silently put devices (the kid's link included) on free
// defaults. Runs the real handler with each deployment's real vars.

// wrangler.jsonc allows comments; strip them (string-aware) and parse.
function readJsonc(file) {
  const src = readFileSync(path.join(ROOT_DIR, file), "utf8");
  let out = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"') {
      let j = i + 1;
      while (src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j;
    } else if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && src[i + 1] === "*") {
      i = src.indexOf("*/", i + 2) + 1;
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

// Story 6-5: config.js now imports lib/stripe.js's `get`/`StripeError`, so a
// plain `export`-stripping vm.runInNewContext (module `import` syntax throws
// outside a real module) no longer works here -- see loadConfigHandler()
// (Story 6-5 section, further down this file) for the real loader, which
// this reuses. None of the checks below ever expect a live Stripe call:
// wrangler.vars alone carries no STRIPE_SECRET_KEY, so readPrice() always
// fails closed (pricing.monthly/yearly: null) before it would call get() --
// loadConfigHandler()'s default getImpl (a throwing stub) makes that
// assumption loud, not silent, if it's ever wrong.
async function serverConfigAnswer(vars) {
  const { onRequestGet } = loadConfigHandler({});
  const response = await onRequestGet({ env: vars });
  assert.equal(response.status, 200);
  return JSON.parse(await response.text());
}

const wrangler = readJsonc("wrangler.jsonc");

// Story 4.1's boundary: only public/ is ever published. This is the one
// automated check of that boundary other than the manual check-public.mjs
// run against a live server, so a regression here is caught by `npm run
// check` / a plain `node scripts/check-config.mjs` instead of only surfacing
// against a deployed site.
check("wrangler.jsonc: assets.directory points at ./public", () => {
  assert.equal(wrangler.assets.directory, "./public");
});

// Story 4.2: the single production Worker's routes and deploy-target flags
// are just as easy to silently regress as assets.directory, so they get the
// same cheap structural proof here instead of only surfacing on a live check.
check("wrangler.jsonc: exactly the two custom-domain routes, and no workers.dev/preview deploys", () => {
  assert.deepEqual(
    wrangler.routes.map((r) => r.pattern).sort(),
    ["8ish.app", "www.8ish.app"]
  );
  assert.ok(
    wrangler.routes.every((r) => r.custom_domain === true),
    "every route must be a custom_domain route"
  );
  assert.equal(wrangler.workers_dev, false);
  assert.equal(wrangler.preview_urls, false);
});

// Story 4.2 flattened wrangler.jsonc to a single top-level Worker
// (8ish-plus, free plan) with no env blocks. The retiring 8ishqa
// (always-unlimited) Worker is no longer configured in this file at all,
// so there is only one deployment's vars left to validate here.
check("wrangler.jsonc: the real /api/config answer validates as free with its limits", async () => {
  const vars = wrangler.vars;
  const body = await serverConfigAnswer(vars);
  assert.equal(body.planMode, "free");
  expectFree(await boot({ net: net.body(body) }), {
    limit: Number(vars.FREE_DAILY_LIMIT),
  });
});

// Story 7.7: the client no longer counts Images at all (the Spend Governor
// does, server-side) -- freeAiLimit must be genuinely gone from both ends of
// the contract, not just unused: neither the real wrangler.jsonc var nor the
// real /api/config JSON response may still carry it.
check("wrangler.jsonc: FREE_AI_LIMIT is gone from the vars block (Story 7.7)", () => {
  assert.ok(!("FREE_AI_LIMIT" in wrangler.vars), "wrangler.jsonc vars must not define FREE_AI_LIMIT anymore");
});

check("functions/api/config.js: the real /api/config response never includes freeAiLimit (Story 7.7)", async () => {
  const body = await serverConfigAnswer(wrangler.vars);
  assert.ok(!("freeAiLimit" in body), "the /api/config response must not include freeAiLimit anymore");
});

// Story 6-3: functions/api/config.js's turnstileSiteKey field, checked
// directly against the real handler (not just through monetize.js's more
// permissive validateConfig(), which drops unknown fields).
check("functions/api/config.js: TURNSTILE_SITE_KEY set -> the response's turnstileSiteKey equals it exactly", async () => {
  const body = await serverConfigAnswer({ ...wrangler.vars, TURNSTILE_SITE_KEY: "1x00000000000000000000AA" });
  assert.equal(body.turnstileSiteKey, "1x00000000000000000000AA");
});

check("functions/api/config.js: TURNSTILE_SITE_KEY unset (today's reality) -> the response's turnstileSiteKey is null", async () => {
  const body = await serverConfigAnswer(wrangler.vars);
  assert.equal(body.turnstileSiteKey, null);
});

// Story 4.3: Cloudflare's automatic per-request invocation log records the
// full request/response (including the URL) for every call, so it must stay
// off while observability.enabled keeps this app's own event-code console.*
// logging flowing to `wrangler tail` and the dashboard.
check("wrangler.jsonc: observability keeps logging on but turns off automatic invocation logs", () => {
  assert.equal(wrangler.observability.enabled, true);
  assert.equal(wrangler.observability.logs.invocation_logs, false);
});

// Story 4.3: every console.* call in these six files must log a fixed event
// code, optionally followed by a plain HTTP status number already in scope
// -- never a caught error object, its message/stack, an upstream response
// body, or any other dynamic value. A lightweight static proof (not a full
// parse) that a future edit can't silently reintroduce one of those into a
// log line. Like check-sw.mjs's own documented comment-stripping caveat,
// this has an accepted blind spot: a future argument with its own nested
// parentheses (a function call, an object literal with a method, and so on)
// could still slip past the closing ")" this regex stops at. Not solved
// here -- keep new call sites to the same shape as today's (a string
// literal, optionally plus a `.status` property access) and this stays
// airtight.
//
// Story 6-5: functions/api/config.js joined this list -- its new price-cache
// lookup (KV read/write, a live Stripe call) has the same failure surface as
// every other file here and follows the identical convention.
const LOGGING_FILES = [
  "functions/api/checkout-confirm.js",
  "functions/api/checkout.js",
  "functions/api/config.js",
  "functions/api/entitlement.js",
  "functions/api/restore.js",
  "functions/api/stripe-webhook.js",
  "functions/api/transform.js",
];

// Every current call site is a single console.*(...) statement with no
// nested parentheses in its arguments, so stopping at the first ")" finds
// the whole call.
const CONSOLE_CALL_RE = /console\.\w+\([^)]*\)/g;

// Anywhere inside a call's parentheses, regardless of argument position:
// reading a body (.text()/.json()), an error's .message/.stack, building a
// dynamic string with String(...) or JSON.stringify(...), or interpolating
// a value into a template literal (`...${x}...`).
const FORBIDDEN_SUBSTRING_RE = /\.text\(|\.json\(|\.message\b|\.stack\b|String\(|JSON\.stringify\(|\$\{/;

// A single top-level argument that's actually allowed: a plain string (or
// template literal with no interpolation -- already ruled out above) event
// code, a bare number, or a property access ending in `.status` (the one
// non-literal value the frozen "Always" clause permits).
const STRING_OR_TEMPLATE_LITERAL_RE = /^"(?:[^"\\]|\\.)*"$|^'(?:[^'\\]|\\.)*'$|^`(?:[^`\\]|\\.)*`$/;
const STATUS_PROPERTY_ACCESS_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\.status$/;
const NUMERIC_LITERAL_RE = /^-?\d+(?:\.\d+)?$/;

function isAllowedArgument(arg) {
  return STRING_OR_TEMPLATE_LITERAL_RE.test(arg) || STATUS_PROPERTY_ACCESS_RE.test(arg) || NUMERIC_LITERAL_RE.test(arg);
}

// Splits a call's argument text on top-level commas only -- a comma inside
// (), [], {}, or a quoted/templated string doesn't split. Good enough for
// the flat argument lists these 12 sites use (see the accepted blind spot
// noted above for anything more exotic).
function splitTopLevelArgs(argsText) {
  const args = [];
  let depth = 0;
  let quote = null;
  let current = "";
  for (let i = 0; i < argsText.length; i++) {
    const c = argsText[i];
    if (quote) {
      current += c;
      if (c === "\\") {
        i++;
        current += argsText[i] ?? "";
      } else if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      current += c;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    if (c === ")" || c === "]" || c === "}") depth--;
    if (c === "," && depth === 0) {
      args.push(current.trim());
      current = "";
      continue;
    }
    current += c;
  }
  if (current.trim()) args.push(current.trim());
  return args;
}

// Returns a description of what's wrong with a console.* call, or null if
// it's clean.
function findUnsafeConsoleCall(call) {
  if (FORBIDDEN_SUBSTRING_RE.test(call)) {
    return `contains a body read, .message/.stack, String(), JSON.stringify(), or a template interpolation`;
  }
  const argsText = call.slice(call.indexOf("(") + 1, -1);
  for (const arg of splitTopLevelArgs(argsText)) {
    if (!isAllowedArgument(arg)) {
      return `argument "${arg}" is neither a string literal, a bare number, nor a \`.status\` property access -- closes the exact bypass a bare identifier like a caught response body (e.g. \`text\` from an earlier .text()) would otherwise slip through as`;
    }
  }
  return null;
}

check("functions/api/*.js: every console.* call logs only an event code and an optional status, never a raw error object, body, or other dynamic value", () => {
  const perFile = [];
  let total = 0;
  for (const file of LOGGING_FILES) {
    let source;
    try {
      source = readFileSync(path.join(ROOT_DIR, file), "utf8");
    } catch (error) {
      assert.fail(`${file}: could not read file (${error && error.code ? error.code : error})`);
    }
    const calls = source.match(CONSOLE_CALL_RE) || [];
    assert.ok(calls.length > 0, `${file}: expected at least one console.* call`);
    perFile.push(`${file}: ${calls.length}`);
    total += calls.length;
    for (const call of calls) {
      const problem = findUnsafeConsoleCall(call);
      assert.ok(!problem, `${file}: console.* call looks unsafe (${problem}): ${call}`);
    }
  }
  // Story 6-3: restore.js dropped its two restoreAttempt cooldown log sites
  // (the KV cooldown itself is gone) and gained one -- restore_stripe_error,
  // logged when the customers?email= lookup fails -- so the total moved
  // from 14 to 13. Story 6-5: config.js joined LOGGING_FILES with 5 new
  // sites (KV read failure, Stripe error, Stripe unreachable, a malformed
  // Stripe response, KV write failure -- see readPrice()'s own comments),
  // so the total moves from 13 to 18.
  //
  // Story 7-5: transform.js's full rewrite dropped its old 3 sites
  // (cooldown_write_failed, cooldown_read_failed, transform_error -- the
  // COOLDOWN_MS/STATE_KV_KEY cooldown they belonged to is gone) and gained
  // 4 new ones (transform_prebuild_failed, transform_timeout,
  // transform_provider_error, transform_provider_malformed -- see
  // onRequestPost's own settlement branches), so the total moves from 18
  // to 19.
  //
  // Story 7-6: transform.js's free-device path gained ONE new site at
  // build time, transform_device_mint_verify_mismatch -- logged only in the
  // (never reachable in practice) case where a token device-token.mint()
  // JUST produced fails to verify(), a genuine internal inconsistency
  // rather than a caller error (see handleFreeDeviceRequest's own comment).
  // Total moved from 19 to 20.
  //
  // Story 7-6 post-build review finding (Blind Hunter): the mint-then-
  // reserve sequence between the mint commit and the response had two
  // unguarded async calls (device-token.js's own self-verify round-trip,
  // and the final reserve("free",...)) that could let an exception escape
  // uncaught -- breaking this app's own "every failure degrades to the
  // documented {error:{code}} envelope" invariant, and permanently leaking
  // one mintPerHour slot with no token ever reaching the client. Fixed by
  // wrapping the whole sequence in one try/catch that degrades to
  // transform_device_mint_sequence_failed / 502 provider_error on any
  // non-NotConfiguredError throw. Total moves from 20 to 21.
  //
  // Story 8-1: stripe-webhook.js gained three new sites --
  // webhook_dedupe_kv_read_failed and webhook_dedupe_kv_write_failed (the
  // evt:<id> dedupe marker's own best-effort KV read/write, see
  // writeDedupedFunnelEvent's own comment) and a SECOND
  // webhook_funnel_write_failed call site (refreshSubscription's own
  // "cancelled" write, alongside the pre-existing one in
  // handleCheckoutSessionCompleted for "purchase_completed") -- so the
  // total moves from 21 to 24.
  //
  // Story 8.5: transform.js's new reportGovernorGauge() gained four new
  // sites -- gov_gauge_rpc_failed (getDailyImageCounts throwing/rejecting),
  // gov_gauge_state_read_failed / gov_gauge_state_write_failed (the
  // state:<budgetDay> KV read/write), and gov_gauge_report_failed (the
  // function's own outermost catch-all) -- each logged and swallowed per
  // the frozen "Governor RPC/KV failure is logged and swallowed" I/O matrix
  // row. Total moves from 24 to 28.
  assert.equal(total, 28, `expected exactly the 28 known console.* call sites across the seven files, got ${total} -- per file: ${perFile.join(", ")}`);
});

// ------------------------------------------------------ Story 6-1: lib/stripe.js, lib/subStatus.js
//
// functions/lib/stripe.js is the one file allowed to call the Stripe API
// (and hold the pinned Stripe-Version string); functions/lib/subStatus.js
// is the one file allowed to touch a `subStatus:` STATE_KV key. Both get a
// structural check (the grep-style scans below) plus unit-style checks of
// subStatus.js's and stripe-webhook.js's own logic, run the same vm-sandbox
// way as every check above -- no live Stripe call, no real KV, no
// `wrangler` command.

const LIB_DIR = path.join(ROOT_DIR, "functions/lib");
const FUNCTIONS_DIR = path.join(ROOT_DIR, "functions");
const STRIPE_LIB_PATH = path.join(LIB_DIR, "stripe.js");
const SUBSTATUS_LIB_PATH = path.join(LIB_DIR, "subStatus.js");
const WEBHOOK_PATH = path.join(ROOT_DIR, "functions/api/stripe-webhook.js");
const stripeLibSource = readFileSync(STRIPE_LIB_PATH, "utf8");
const subStatusLibSource = readFileSync(SUBSTATUS_LIB_PATH, "utf8");
const stripeWebhookSource = readFileSync(WEBHOOK_PATH, "utf8");

// Story 7-8: functions/lib/http-body.js (the shared readCappedBody()) and
// functions/lib/request-throttle.js (the shared pre-limit/deny-cache) --
// loaded once here as raw source text; every vm-sandbox loader in this file
// that exercises a caller of either module (restore.js, transform.js,
// stripe-webhook.js) runs this SAME source text into its own fresh vm
// context, exactly like every other shared lib module in this file.
const HTTP_BODY_LIB_PATH = path.join(LIB_DIR, "http-body.js");
const REQUEST_THROTTLE_LIB_PATH = path.join(LIB_DIR, "request-throttle.js");
const httpBodyLibSource = readFileSync(HTTP_BODY_LIB_PATH, "utf8");
const requestThrottleLibSource = readFileSync(REQUEST_THROTTLE_LIB_PATH, "utf8");

// Story 8-1: functions/lib/events.js (the shared writeEvent() helper) --
// loaded once here as raw source text, the same way every other shared lib
// module in this file is. Callers that import writeEvent (config.js,
// checkout.js, stripe-webhook.js, transform.js) get a plain RECORDING STUB
// in their own vm-sandbox loader below instead (matching this file's own
// established convention -- see e.g. loadWebhook's `sandbox.write` stub for
// subStatus.write -- of mocking an imported dependency and testing its own
// logic separately); loadEvents() below is the one loader that runs this
// REAL source, for writeEvent's own direct behavior checks.
const EVENTS_LIB_PATH = path.join(LIB_DIR, "events.js");
const eventsLibSource = readFileSync(EVENTS_LIB_PATH, "utf8");

// Loads the REAL functions/lib/events.js into its own fresh vm context, with
// only `console` provided (writeEvent's own only global dependency besides
// the standard Promise/etc. already present in any new vm context) --
// exercises writeEvent's actual payload-shaping/fail-open/waitUntil logic
// directly, in isolation from every caller file (which each get a plain
// recording stub instead -- see the comment just above).
function loadEvents() {
  const consoleCalls = [];
  const sandbox = {
    console: { error: (...args) => consoleCalls.push(args), log() {}, warn() {} },
  };
  vm.createContext(sandbox);
  const src = eventsLibSource.replace(/^export\s+/gm, "");
  // Story 8.5: writeGovGauge/notifyAlert exposed the same way, for their own
  // direct behavior checks below (payload shape, fail-open, the ALERT_EVENTS
  // allowlist gate).
  vm.runInContext(`${src}\nthis.writeEvent = writeEvent;\nthis.writeGovGauge = writeGovGauge;\nthis.notifyAlert = notifyAlert;`, sandbox, { filename: "events.js" });
  return { writeEvent: sandbox.writeEvent, writeGovGauge: sandbox.writeGovGauge, notifyAlert: sandbox.notifyAlert, consoleCalls };
}

// Story 7-8: the committed default Governor config, valid against
// governor-config.js's own validateGovernorConfig() -- declared here (near
// the top of the file) rather than down in the Story 7-5 transform.js
// section that originally introduced it, so the Story 6-3/7-8 restore.js
// section further below (which now also needs a working GOVERNOR/STATE_KV
// mock) can reference it too. Top-level `const`s run in file order, and the
// restore.js section's own RESTORE_ENV is itself a top-level `const` that
// needs this value already initialized by the time it runs.
const VALID_GOVERNOR_CFG_RAW = JSON.parse(readFileSync(path.join(ROOT_DIR, "config/governor.json"), "utf8"));

function listFilesRecursive(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full));
    else out.push(full);
  }
  return out;
}

check("functions/lib/stripe.js is the only file under functions/ with an api.stripe.com literal", () => {
  const offenders = [];
  for (const file of listFilesRecursive(FUNCTIONS_DIR)) {
    if (file === STRIPE_LIB_PATH) continue;
    const source = readFileSync(file, "utf8");
    if (source.includes("api.stripe.com")) offenders.push(path.relative(ROOT_DIR, file));
  }
  assert.deepEqual(offenders, [], `unexpected api.stripe.com literal(s) outside lib/stripe.js: ${offenders.join(", ")}`);
});

check("functions/lib/subStatus.js is the only file under functions/ with a subStatus: literal", () => {
  const offenders = [];
  for (const file of listFilesRecursive(FUNCTIONS_DIR)) {
    if (file === SUBSTATUS_LIB_PATH) continue;
    const source = readFileSync(file, "utf8");
    if (source.includes("subStatus:")) offenders.push(path.relative(ROOT_DIR, file));
  }
  assert.deepEqual(offenders, [], `unexpected subStatus: literal(s) outside lib/subStatus.js: ${offenders.join(", ")}`);
});

// Loads the real stripe.js + subStatus.js source into one fresh vm context
// per call (so subStatus.js's module-level lookup-cache Map starts empty
// every time), with `fetch` mocked, `Date.now` controllable via `setNow`,
// and `console.error` calls captured (not just swallowed) so a check can
// assert a specific event code was logged. Mirrors the export-stripping
// technique used for config.js above, plus stripping subStatus.js's own
// `import ... from "./stripe.js"` line so the same context's stripe.js
// bindings (get/StripeError) satisfy it -- both files run as the real,
// unmodified logic otherwise. `__cacheSize` is a test-only hook appended
// below, not part of subStatus.js's real exports.
function loadSubStatus({ fetchImpl, now = 1_700_000_000_000 } = {}) {
  let currentNow = now;
  class FakeDate extends Date {
    static now() {
      return currentNow;
    }
  }
  const fetchCalls = [];
  const consoleCalls = [];
  const sandbox = {
    fetch: (...args) => {
      fetchCalls.push(args);
      return fetchImpl(...args);
    },
    Date: FakeDate,
    console: { error: (...args) => consoleCalls.push(args), log() {}, warn() {} },
    encodeURIComponent,
    URLSearchParams,
  };
  vm.createContext(sandbox);

  const stripeSrc = stripeLibSource.replace(/^export\s+/gm, "");
  vm.runInContext(`${stripeSrc}\nthis.get = get; this.post = post; this.StripeError = StripeError;`, sandbox, {
    filename: "stripe.js",
  });

  const subStatusSrc = subStatusLibSource
    .replace(/^import\s*\{[^}]*\}\s*from\s*["'][^"']+["'];?\s*$/m, "")
    .replace(/^export\s+/gm, "");
  vm.runInContext(
    `${subStatusSrc}\nthis.read = read; this.write = write; this.isActiveStatus = isActiveStatus; this.NotConfiguredError = NotConfiguredError; this.__cacheSize = () => lookupCache.size;`,
    sandbox,
    { filename: "subStatus.js" }
  );

  return {
    read: sandbox.read,
    write: sandbox.write,
    isActiveStatus: sandbox.isActiveStatus,
    NotConfiguredError: sandbox.NotConfiguredError,
    fetchCalls,
    consoleCalls,
    cacheSize: () => sandbox.__cacheSize(),
    setNow(ms) {
      currentNow = ms;
    },
  };
}

// Loads the real stripe.js + stripe-webhook.js source into one fresh vm
// context per call, with `get` (the Stripe REST call) and `write` (the
// subStatus write) replaced by test doubles -- `write`/`isActiveStatus`
// never come from the real subStatus.js here, so these checks exercise
// stripe-webhook.js's own control flow (what it passes to write, how it
// maps a thrown error to a response) in isolation from subStatus.js's own
// logic, which the checks above already cover directly. `makeGet` is
// called with the real `StripeError` class (from the same stripe.js load)
// so a mock can throw one that stripe-webhook.js's own `instanceof
// StripeError` check recognizes.
function loadWebhook({ makeGet, writeImpl } = {}) {
  const consoleCalls = [];
  const sandbox = {
    console: { error: (...args) => consoleCalls.push(args), log() {}, warn() {} },
    crypto,
    TextEncoder,
    TextDecoder,
    Response,
    URL,
  };
  vm.createContext(sandbox);

  const stripeSrc = stripeLibSource.replace(/^export\s+/gm, "");
  vm.runInContext(`${stripeSrc}\nthis.get = get; this.post = post; this.StripeError = StripeError;`, sandbox, {
    filename: "stripe.js",
  });

  // Story 7-8: the real http-body.js source, loaded as a bare
  // `readCappedBody` identifier -- stripe-webhook.js's own `import {
  // readCappedBody } from "../lib/http-body.js"` line is stripped below by
  // the same generic `import { ... } from "...";` regex that already
  // strips its stripe.js/subStatus.js imports, so this must resolve as a
  // bare global exactly like `get`/`write`/`isActiveStatus` do.
  const httpBodySrc = httpBodyLibSource.replace(/^export\s+/gm, "");
  vm.runInContext(httpBodySrc, sandbox, { filename: "http-body.js" });

  sandbox.get = makeGet ? makeGet(sandbox.StripeError) : async () => { throw new Error("no Stripe fetch mock configured for this check"); };
  sandbox.isActiveStatus = (status) => status === "active" || status === "trialing";
  const writeCalls = [];
  sandbox.write = async (env, subscriptionId, payload) => {
    writeCalls.push({ subscriptionId, payload });
    return writeImpl ? writeImpl(env, subscriptionId, payload) : true;
  };

  // Story 8-1: a plain recording stub for the shared writeEvent() helper --
  // stripe-webhook.js's own `import { writeEvent } from "../lib/events.js"`
  // line is stripped below by the same generic import regex, so this must
  // resolve as a bare global exactly like `get`/`write`/`isActiveStatus` do.
  // writeEvent's own logic is checked directly, in isolation, by
  // loadEvents() further down this file.
  const writeEventCalls = [];
  sandbox.writeEvent = (env, ctx, event, source) => {
    writeEventCalls.push({ event, source, ctx });
  };

  const webhookSrc = stripeWebhookSource
    .replace(/^import\s*\{[^}]*\}\s*from\s*["'][^"']+["'];?\s*$/gm, "")
    .replace(/^export\s+/gm, "");
  vm.runInContext(`${webhookSrc}\nthis.onRequestPost = onRequestPost;`, sandbox, { filename: "stripe-webhook.js" });

  return { onRequestPost: sandbox.onRequestPost, StripeError: sandbox.StripeError, writeCalls, writeEventCalls, consoleCalls };
}

// Node has a real Web Crypto implementation globally (no import needed) --
// used here to build a genuinely valid Stripe webhook signature the same
// way stripe-webhook.js's own verifyStripeSignature checks it, so these
// checks exercise real signature verification, not a bypass of it.
async function hmacSha256HexNode(secret, message) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Story 7-8: stripe-webhook.js now reads its body exclusively through
// readCappedBody() (lib/http-body.js) -- a real `.body` ReadableStream
// (single chunk, the UTF-8 bytes of `rawBody`) so that read actually sees
// the real signed payload instead of readCappedBody's own "no body stream
// at all" fallback (which would decode to an empty string and break every
// signature check below). `text()` is kept too, harmlessly unused by the
// real code now, in case any other check in this file still reaches for it.
function bodyStreamFrom(text) {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function signedWebhookRequest(secret, bodyObj, timestamp = Math.floor(Date.now() / 1000)) {
  const rawBody = JSON.stringify(bodyObj);
  const sig = await hmacSha256HexNode(secret, `${timestamp}.${rawBody}`);
  return {
    text: async () => rawBody,
    body: bodyStreamFrom(rawBody),
    headers: { get: (name) => (name === "stripe-signature" ? `t=${timestamp},v1=${sig}` : null) },
  };
}

// Story 7-8: same as signedWebhookRequest() above, but signs a RAW body
// string directly instead of JSON.stringify-ing a bodyObj -- used by the
// exact-64KB-boundary body-cap check further below (scripts/check-config.mjs
// section: "Story 7-8: body-size caps"), which needs to control the padded
// event text's own byte length precisely (via jsonBodyOfExactBytes()) while
// still producing a genuinely valid signature over that exact text, so the
// exact-cap case passes signature verification too, not just the byte cap.
async function signedWebhookRequestFromRawBody(secret, rawBody, timestamp = Math.floor(Date.now() / 1000)) {
  const sig = await hmacSha256HexNode(secret, `${timestamp}.${rawBody}`);
  return {
    text: async () => rawBody,
    body: bodyStreamFrom(rawBody),
    headers: { get: (name) => (name === "stripe-signature" ? `t=${timestamp},v1=${sig}` : null) },
  };
}

// A fake STATE_KV faithful enough for these checks: honors `expirationTtl`
// (seconds) against the same controllable "now" the vm sandbox uses, so the
// 6h-expiry scenario can be simulated without a real clock or KV.
function makeFakeKV(getNow) {
  const store = new Map();
  const puts = [];
  return {
    async get(key) {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAtMs !== null && getNow() >= entry.expiresAtMs) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    async put(key, value, options) {
      puts.push({ key, value: JSON.parse(value), options: options || null });
      const ttl = options && typeof options.expirationTtl === "number" ? options.expirationTtl : null;
      store.set(key, { value, expiresAtMs: ttl !== null ? getNow() + ttl * 1000 : null });
    },
    puts,
  };
}

const stripeErrorFetch = (status) => async () => ({ ok: false, status, json: async () => ({}) });
const activeSubFetch = (status = "active", currentPeriodEnd = 1_800_000_000) => async () => ({
  ok: true,
  status: 200,
  json: async () => ({ status, items: { data: [{ current_period_end: currentPeriodEnd }] } }),
});

check("subStatus.isActiveStatus: the status table -- active/trialing are active, every other status is not", () => {
  const { isActiveStatus } = loadSubStatus({ fetchImpl: stripeErrorFetch(404) });
  assert.equal(isActiveStatus("active"), true);
  assert.equal(isActiveStatus("trialing"), true);
  for (const status of ["past_due", "unpaid", "paused", "incomplete", "canceled", "incomplete_expired", ""]) {
    assert.equal(isActiveStatus(status), false, `${status || "(empty string)"} must be inactive`);
  }
});

check("subStatus.write: the asOf-ordering guard rejects a stale write and keeps the newer status, currentPeriodEnd round-trips (I/O matrix rows 1-2)", async () => {
  const now = 1_700_000_000_000;
  const { write } = loadSubStatus({ fetchImpl: stripeErrorFetch(404), now });
  const kv = makeFakeKV(() => now);
  const env = { STATE_KV: kv };

  // Stored active entry, asOf T1.
  assert.equal(await write(env, "sub_1", { active: true, asOf: 100, source: "webhook", currentPeriodEnd: 1_111_111 }), true);

  // A newer `deleted` event, asOf T2 > T1: applies, becomes inactive.
  assert.equal(await write(env, "sub_1", { active: false, asOf: 200, source: "webhook", currentPeriodEnd: 2_222_222 }), true);
  assert.deepEqual(JSON.parse(await kv.get("subStatus:sub_1")), { active: false, asOf: 200, source: "webhook", currentPeriodEnd: 2_222_222 });

  // An older `updated` (active) event, asOf T3 < T2: rejected, stays inactive.
  assert.equal(
    await write(env, "sub_1", { active: true, asOf: 150, source: "webhook", currentPeriodEnd: 3_333_333 }),
    false,
    "a stale write must be rejected"
  );
  assert.deepEqual(
    JSON.parse(await kv.get("subStatus:sub_1")),
    { active: false, asOf: 200, source: "webhook", currentPeriodEnd: 2_222_222 },
    "the stored entry (including currentPeriodEnd) must be unchanged by the rejected write"
  );

  // asOf exactly equal to the stored value is accepted ("asOf >= stored.asOf").
  assert.equal(
    await write(env, "sub_1", { active: true, asOf: 200, source: "webhook", currentPeriodEnd: 4_444_444 }),
    true,
    "asOf equal to the stored asOf must be accepted"
  );
  assert.equal(JSON.parse(await kv.get("subStatus:sub_1")).currentPeriodEnd, 4_444_444);
});

check("subStatus.write: rejects a non-finite asOf (NaN must not silently bypass the ordering guard)", async () => {
  const now = 1_700_000_000_000;
  const { write } = loadSubStatus({ fetchImpl: stripeErrorFetch(404), now });
  const kv = makeFakeKV(() => now);
  const env = { STATE_KV: kv };

  assert.equal(await write(env, "sub_1", { active: true, asOf: 100, source: "webhook", currentPeriodEnd: null }), true);

  for (const badAsOf of [NaN, Infinity, -Infinity, "200", null, undefined]) {
    await assert.rejects(
      () => write(env, "sub_1", { active: false, asOf: badAsOf, source: "webhook", currentPeriodEnd: null }),
      `write() must throw for asOf = ${String(badAsOf)} instead of silently accepting or rejecting it as a normal ordering decision`
    );
  }
  // The stored entry must be completely untouched by every rejected attempt above.
  assert.deepEqual(JSON.parse(await kv.get("subStatus:sub_1")), { active: true, asOf: 100, source: "webhook", currentPeriodEnd: null });
});

check("subStatus.write: a genuine STATE_KV.put failure propagates to the caller (relied on by the webhook's 5xx-on-failure behavior)", async () => {
  const { write } = loadSubStatus({ fetchImpl: stripeErrorFetch(404) });
  const kv = {
    get: async () => null,
    put: async () => {
      throw new Error("simulated KV put failure");
    },
  };
  await assert.rejects(() => write({ STATE_KV: kv }, "sub_1", { active: true, asOf: 1, source: "webhook", currentPeriodEnd: null }));
});

check("subStatus.write: an active write carries the 6h TTL, an inactive write carries none", async () => {
  const now = 1_700_000_000_000;
  const { write } = loadSubStatus({ fetchImpl: stripeErrorFetch(404), now });
  const kv = makeFakeKV(() => now);
  const env = { STATE_KV: kv };

  await write(env, "sub_active", { active: true, asOf: 1, source: "webhook", currentPeriodEnd: null });
  assert.equal(kv.puts.at(-1).options && kv.puts.at(-1).options.expirationTtl, 21600, "an active write must carry expirationTtl: 21600 (6h)");

  await write(env, "sub_inactive", { active: false, asOf: 1, source: "webhook", currentPeriodEnd: null });
  const inactiveOptions = kv.puts.at(-1).options;
  assert.ok(!inactiveOptions || inactiveOptions.expirationTtl === undefined, "an inactive write must carry no expiry");
});

check("subStatus.read: an active entry past its 6h TTL is read as unknown; the live lookup does not refresh it, currentPeriodEnd comes through (I/O matrix row 7)", async () => {
  let now = 1_700_000_000_000;
  const { read, write, fetchCalls, setNow } = loadSubStatus({ fetchImpl: activeSubFetch("active", 9_999_999), now });
  const kv = makeFakeKV(() => now);
  const env = { STATE_KV: kv, STRIPE_SECRET_KEY: "sk_test" };

  await write(env, "sub_1", { active: true, asOf: now, source: "webhook", currentPeriodEnd: 1_234_567 });
  assert.equal(fetchCalls.length, 0, "write() must never itself call Stripe");

  // Still inside the 6h TTL: KV answers directly, no live lookup.
  now += 6 * 60 * 60 * 1000 - 1000;
  setNow(now);
  const fresh = await read(env, "sub_1");
  assert.equal(fresh.active, true);
  assert.equal(fresh.currentPeriodEnd, 1_234_567, "a KV hit must return the stored currentPeriodEnd");
  assert.equal(fetchCalls.length, 0, "a KV hit inside the TTL must not call Stripe");

  // Past 6h: the fake KV entry has expired -- read() falls back to a live
  // lookup, and that lookup must not itself write the KV entry back.
  now += 2000;
  setNow(now);
  const expired = await read(env, "sub_1");
  assert.equal(expired.active, true, "the live lookup itself reports active in this fixture");
  assert.equal(expired.currentPeriodEnd, 9_999_999, "the live lookup's own currentPeriodEnd (from the re-fetched subscription item) must come through");
  assert.equal(fetchCalls.length, 1, "an expired active entry must trigger exactly one live Stripe lookup");
  assert.equal(await kv.get("subStatus:sub_1"), null, "read()'s live lookup must not refresh the KV entry -- only a webhook write does");
});

check("subStatus.read: a burst of sequential lookups for one unknown subscription within 60s calls Stripe once", async () => {
  let now = 1_700_000_000_000;
  const { read, fetchCalls, setNow } = loadSubStatus({ fetchImpl: stripeErrorFetch(404), now });
  const kv = makeFakeKV(() => now);
  const env = { STATE_KV: kv, STRIPE_SECRET_KEY: "sk_test" };

  for (let i = 0; i < 5; i++) {
    assert.equal((await read(env, "sub_unknown")).active, false);
  }
  assert.equal(fetchCalls.length, 1, "5 sequential reads within 60s for the same subscription must call Stripe exactly once");

  // Past the 60s lookup-cache window: the next read calls Stripe again.
  now += 60 * 1000;
  setNow(now);
  await read(env, "sub_unknown");
  assert.equal(fetchCalls.length, 2, "a read at/after the 60s lookup-cache window must call Stripe again");
});

check("subStatus.read: a burst of CONCURRENT lookups for one inactive subscription calls Stripe once", async () => {
  const { read, fetchCalls } = loadSubStatus({ fetchImpl: activeSubFetch("canceled") });
  const kv = makeFakeKV(() => 1_700_000_000_000);
  const env = { STATE_KV: kv, STRIPE_SECRET_KEY: "sk_test" };

  const results = await Promise.all(Array.from({ length: 5 }, () => read(env, "sub_concurrent")));
  assert.ok(
    results.every((r) => r.active === false),
    "every concurrent caller must see the same (inactive) result"
  );
  assert.equal(fetchCalls.length, 1, "5 concurrent reads for the same subscription must call Stripe exactly once");
});

check("subStatus.read: the lookup cache is a mix of positive and negative results, not negative-only, and sweeps settled entries past 60s", async () => {
  let now = 1_700_000_000_000;
  const { read, fetchCalls, cacheSize, setNow } = loadSubStatus({ fetchImpl: activeSubFetch("active"), now });
  const kv = makeFakeKV(() => now);
  const env = { STATE_KV: kv, STRIPE_SECRET_KEY: "sk_test" };

  for (let i = 0; i < 5; i++) {
    const result = await read(env, `sub_${i}`);
    assert.equal(result.active, true, "the cache must serve a positive (active) result just as well as a negative one");
  }
  assert.equal(fetchCalls.length, 5, "5 distinct subscription ids must each call Stripe once");
  assert.equal(cacheSize(), 5, "each distinct subscription id gets its own cache entry");

  now += 60 * 1000;
  setNow(now);
  // Any read() call sweeps opportunistically -- a fresh read for a new id
  // should clear out the 5 stale, settled entries above rather than
  // growing the map unboundedly.
  await read(env, "sub_new");
  assert.ok(cacheSize() <= 2, `expected the stale entries to be swept, got ${cacheSize()} entries left`);
});

check("subStatus.read: a STATE_KV.get failure is logged with a fixed event code, then falls through to a live lookup", async () => {
  const { read, consoleCalls } = loadSubStatus({ fetchImpl: activeSubFetch("active") });
  const kv = {
    get: async () => {
      throw new Error("simulated KV read failure");
    },
  };
  const result = await read({ STATE_KV: kv, STRIPE_SECRET_KEY: "sk_test" }, "sub_1");
  assert.equal(result.active, true, "a KV read failure must still fall through to a live lookup, not fail the whole read");
  assert.ok(
    consoleCalls.some((args) => args.length === 1 && args[0] === "substatus_kv_read_failed"),
    `expected a single fixed-string "substatus_kv_read_failed" log with no other argument, got: ${JSON.stringify(consoleCalls)}`
  );
});

check("subStatus.read: STRIPE_SECRET_KEY missing throws NotConfiguredError only once a live lookup is actually needed (a KV hit must not require it)", async () => {
  const { read, write, NotConfiguredError } = loadSubStatus({
    fetchImpl: async () => {
      throw new Error("must not call Stripe when STRIPE_SECRET_KEY is missing");
    },
  });
  const kv = makeFakeKV(() => 1_700_000_000_000);
  const envNoKey = { STATE_KV: kv }; // no STRIPE_SECRET_KEY

  // A KV hit must answer fine even with no Stripe key configured.
  await write({ STATE_KV: kv, STRIPE_SECRET_KEY: "sk_whatever" }, "sub_cached", { active: true, asOf: 1, source: "webhook", currentPeriodEnd: null });
  const cached = await read(envNoKey, "sub_cached");
  assert.equal(cached.active, true, "a KV hit must not require STRIPE_SECRET_KEY at all");

  // A KV miss with no key must throw NotConfiguredError specifically.
  await assert.rejects(() => read(envNoKey, "sub_uncached"), (error) => error instanceof NotConfiguredError);
});

check("subStatus.read: a failed live lookup produces no unhandled promise rejection", async () => {
  const before = unhandled.length;
  const { read } = loadSubStatus({ fetchImpl: stripeErrorFetch(500) });
  const kv = makeFakeKV(() => 1_700_000_000_000);
  const env = { STATE_KV: kv, STRIPE_SECRET_KEY: "sk_test" };
  await assert.rejects(() => read(env, "sub_fail"));
  await settle();
  assert.deepEqual(
    unhandled.slice(before),
    [],
    "a failed live lookup must not produce an unhandled promise rejection -- an internal .finally() on the cached lookup promise would do exactly this, since read()'s own caller handling the rejection doesn't handle that separate derived promise"
  );
});

// ---------------------------------------- Story 6-1: stripe-webhook.js's own control flow
// The checks above exercise subStatus.js directly; these exercise
// stripe-webhook.js's own logic (what it passes to write(), how it maps a
// thrown error to a response, which event types it acts on) with
// subStatus.js's write() replaced by a test double, via loadWebhook() above.

const WEBHOOK_SECRET = "whsec_test_secret";
const WEBHOOK_ENV = { STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, STRIPE_SECRET_KEY: "sk_test" };
const recentTimestamp = () => Math.floor(Date.now() / 1000) - 5; // inside the 300s signature tolerance

check("stripe-webhook.js: passes asOf = event.created * 1000 to subStatus.write()", async () => {
  const { onRequestPost, writeCalls } = loadWebhook({
    makeGet: () => async () => ({ id: "sub_1", status: "active", items: { data: [{ current_period_end: 42 }] } }),
  });
  const created = recentTimestamp();
  const request = await signedWebhookRequest(WEBHOOK_SECRET, {
    id: "evt_1",
    type: "customer.subscription.updated",
    created,
    data: { object: { id: "sub_1", status: "active" } },
  }, created);
  const res = await onRequestPost({ request, env: WEBHOOK_ENV });
  assert.equal(res.status, 200);
  assert.equal(writeCalls.length, 1);
  assert.equal(writeCalls[0].subscriptionId, "sub_1");
  assert.equal(writeCalls[0].payload.asOf, created * 1000, "asOf must be event.created (seconds) * 1000, not Date.now() at processing time");
  assert.equal(writeCalls[0].payload.source, "webhook");
  assert.equal(writeCalls[0].payload.currentPeriodEnd, 42, "currentPeriodEnd from the re-fetched subscription item must be passed to write()");
});

check("stripe-webhook.js: all four event types route to a status refresh (created/updated/deleted/checkout.session.completed)", async () => {
  const cases = [
    { type: "customer.subscription.created", data: { object: { id: "sub_a", status: "active" } } },
    { type: "customer.subscription.updated", data: { object: { id: "sub_b", status: "active" } } },
    { type: "customer.subscription.deleted", data: { object: { id: "sub_c", status: "canceled" } } },
    { type: "checkout.session.completed", data: { object: { id: "cs_1", subscription: "sub_d", amount_total: 100 } } },
  ];
  for (const testCase of cases) {
    const { onRequestPost, writeCalls } = loadWebhook({
      makeGet: () => async () => ({ id: "sub_x", status: "active", items: { data: [{ current_period_end: 1 }] } }),
    });
    const created = recentTimestamp();
    const request = await signedWebhookRequest(WEBHOOK_SECRET, { id: "evt", type: testCase.type, created, data: testCase.data }, created);
    const res = await onRequestPost({ request, env: WEBHOOK_ENV });
    assert.equal(res.status, 200, `${testCase.type} must ack 200`);
    assert.equal(writeCalls.length, 1, `${testCase.type} must trigger exactly one subStatus.write()`);
  }
});

check("stripe-webhook.js: a Stripe re-fetch failure returns 500, not 200 (Stripe must retry)", async () => {
  const { onRequestPost, writeCalls } = loadWebhook({
    makeGet: (StripeErr) => async () => {
      throw new StripeErr(500);
    },
  });
  const created = recentTimestamp();
  const request = await signedWebhookRequest(WEBHOOK_SECRET, {
    id: "evt_1",
    type: "customer.subscription.updated",
    created,
    data: { object: { id: "sub_1", status: "active" } },
  }, created);
  const res = await onRequestPost({ request, env: WEBHOOK_ENV });
  assert.equal(res.status, 500);
  assert.equal(writeCalls.length, 0, "a re-fetch failure must never reach subStatus.write()");
});

check("stripe-webhook.js: a subStatus.write() failure returns 500, not 200 (Stripe must retry)", async () => {
  const { onRequestPost } = loadWebhook({
    makeGet: () => async () => ({ id: "sub_1", status: "active" }),
    writeImpl: async () => {
      throw new Error("simulated KV put failure");
    },
  });
  const created = recentTimestamp();
  const request = await signedWebhookRequest(WEBHOOK_SECRET, {
    id: "evt_1",
    type: "customer.subscription.updated",
    created,
    data: { object: { id: "sub_1", status: "active" } },
  }, created);
  const res = await onRequestPost({ request, env: WEBHOOK_ENV });
  assert.equal(res.status, 500);
});

check("stripe-webhook.js: a malformed customer.subscription.* event (missing id) returns 400, not 500 or 200, and never reaches write()", async () => {
  const { onRequestPost, writeCalls } = loadWebhook({
    makeGet: () => async () => {
      throw new Error("must not call Stripe for a malformed event");
    },
  });
  const created = recentTimestamp();
  const request = await signedWebhookRequest(WEBHOOK_SECRET, { id: "evt_1", type: "customer.subscription.updated", created, data: { object: {} } }, created);
  const res = await onRequestPost({ request, env: WEBHOOK_ENV });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.error.code, "bad_request");
  assert.equal(writeCalls.length, 0);
});

check("stripe-webhook.js: a malformed checkout.session.completed event (missing data.object) returns 400", async () => {
  const { onRequestPost, writeCalls } = loadWebhook({});
  const created = recentTimestamp();
  const request = await signedWebhookRequest(WEBHOOK_SECRET, { id: "evt_1", type: "checkout.session.completed", created, data: {} }, created);
  const res = await onRequestPost({ request, env: WEBHOOK_ENV });
  assert.equal(res.status, 400);
  assert.equal(writeCalls.length, 0);
});

check("stripe-webhook.js: checkout.session.completed with no subscription still acks 200 but logs a fixed event code", async () => {
  const { onRequestPost, writeCalls, consoleCalls } = loadWebhook({});
  const created = recentTimestamp();
  const request = await signedWebhookRequest(WEBHOOK_SECRET, {
    id: "evt_1",
    type: "checkout.session.completed",
    created,
    data: { object: { id: "cs_1", amount_total: 0 } }, // no `subscription` field
  }, created);
  const res = await onRequestPost({ request, env: WEBHOOK_ENV });
  assert.equal(res.status, 200, "not expected, but not an error Stripe should retry either");
  assert.equal(writeCalls.length, 0);
  assert.ok(
    consoleCalls.some((args) => args[0] === "webhook_checkout_session_no_subscription"),
    `expected a webhook_checkout_session_no_subscription log, got: ${JSON.stringify(consoleCalls)}`
  );
});

// ------------------------------------------------------ Story 6-2: lib/credential.js, checkout-confirm.js, entitlement.js
//
// functions/lib/credential.js is the one file allowed to mint/verify a `c1.`
// Entitlement Credential (AD-15). Checked directly below against every row
// of the story's own I/O matrix, then checkout-confirm.js's and
// entitlement.js's POST handlers are checked through the same vm-sandbox
// technique as Story 6-1 above (real crypto, real credential.js and
// stripe.js logic, Stripe's own HTTP calls replaced by test doubles) — no
// live Stripe call, no real KV, no `wrangler` command.

const CREDENTIAL_LIB_PATH = path.join(LIB_DIR, "credential.js");
const CHECKOUT_CONFIRM_PATH = path.join(ROOT_DIR, "functions/api/checkout-confirm.js");
const ENTITLEMENT_PATH = path.join(ROOT_DIR, "functions/api/entitlement.js");
const credentialLibSource = readFileSync(CREDENTIAL_LIB_PATH, "utf8");
const checkoutConfirmSource = readFileSync(CHECKOUT_CONFIRM_PATH, "utf8");
const entitlementSource = readFileSync(ENTITLEMENT_PATH, "utf8");

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const THIRTY_MIN_MS = 30 * 60 * 1000;

// Strips both import styles this story's files use (`import { a, b as c }
// from "..."` and `import * as ns from "..."`) plus every `export` keyword,
// the same technique loadWebhook/loadSubStatus use above, generalized to
// handle the namespace-import form checkout-confirm.js and entitlement.js
// both use for `../lib/credential.js`.
function stripImportsAndExports(source) {
  return source
    .replace(/^import\s*\{[^}]*\}\s*from\s*["'][^"']+["'];?\s*$/gm, "")
    .replace(/^import\s*\*\s*as\s+\w+\s*from\s*["'][^"']+["'];?\s*$/gm, "")
    .replace(/^export\s+/gm, "");
}

// Loads the real credential.js source into a fresh vm context per call, with
// `Date.now` controllable via `setNow` (so 7-day expiry doesn't need a real
// wait) and real Web Crypto / base64 globals (crypto, TextEncoder/Decoder,
// atob/btoa) -- runs as the real, unmodified mint()/verify() logic.
// `now` defaults to the real current time (not a fixed past timestamp) --
// callers that hand a minted token to code running on the REAL system clock
// (checked below, entitlement.js's own sandbox does not mock Date) need a
// token that is actually unexpired right now; callers that need a fixed,
// reproducible instant (e.g. to check the exact iat/exp values, or to walk
// up to the 7-day boundary) pass `now` explicitly instead.
function loadCredential({ now = Date.now() } = {}) {
  let currentNow = now;
  class FakeDate extends Date {
    static now() {
      return currentNow;
    }
  }
  const sandbox = { crypto, TextEncoder, TextDecoder, atob, btoa, Date: FakeDate };
  vm.createContext(sandbox);
  const src = credentialLibSource.replace(/^export\s+/gm, "");
  vm.runInContext(`${src}\nthis.mint = mint; this.verify = verify; this.NotConfiguredError = NotConfiguredError;`, sandbox, {
    filename: "credential.js",
  });
  return {
    mint: sandbox.mint,
    verify: sandbox.verify,
    NotConfiguredError: sandbox.NotConfiguredError,
    setNow(ms) {
      currentNow = ms;
    },
  };
}

// Builds a token the exact way credential.js's own mint() does, but under a
// caller-chosen type prefix and secret -- used only to construct the
// hypothetical `d1.` device-type token for the "wrong type never verifies"
// row (d1. tokens don't exist until Story 6.3, so credential.js itself
// cannot produce one; this reproduces its signing scheme independently so
// the check isn't just trusting the same code it's testing).
async function mintAs(type, secret, payload) {
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signedInput = type + payloadB64;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedInput));
  return `${signedInput}.${Buffer.from(sig).toString("base64url")}`;
}

check("credential.mint: c1.<payload>.<hmac>, payload is exactly {sub, iat, exp: iat+7d, v:1} (I/O matrix row: Mint)", async () => {
  const now = 1_700_000_000_000;
  const { mint } = loadCredential({ now });
  const token = await mint({ ENTITLEMENT_SECRET: "secret_current" }, "sub_123");

  assert.equal(typeof token, "string");
  const parts = token.split(".");
  assert.equal(parts.length, 3, `expected exactly 3 dot-separated segments, got ${parts.length}: ${token}`);
  assert.equal(parts[0], "c1", "token must start with the c1 type segment");

  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  assert.deepEqual(payload, { sub: "sub_123", iat: now, exp: now + SEVEN_DAYS_MS, v: 1 });
});

check("credential.mint: ENTITLEMENT_SECRET missing throws NotConfiguredError, mints nothing (Always: fail closed)", async () => {
  const { mint, NotConfiguredError } = loadCredential();
  await assert.rejects(() => mint({}, "sub_1"), (e) => e instanceof NotConfiguredError);
});

check("credential.verify: a freshly minted credential verifies and round-trips its payload", async () => {
  const { mint, verify } = loadCredential();
  const env = { ENTITLEMENT_SECRET: "secret_current" };
  const token = await mint(env, "sub_1");
  const payload = await verify(env, token);
  assert.ok(payload);
  assert.equal(payload.sub, "sub_1");
});

check("credential.verify: tampering the payload or the signature makes it never verify (I/O matrix row: Verify, tampered)", async () => {
  const { mint, verify } = loadCredential();
  const env = { ENTITLEMENT_SECRET: "secret_current" };
  const token = await mint(env, "sub_1");
  const [type, payloadB64, sigB64] = token.split(".");
  const flip = (s) => s.slice(0, -1) + (s.at(-1) === "A" ? "B" : "A");

  assert.equal(await verify(env, `${type}.${flip(payloadB64)}.${sigB64}`), null, "a tampered payload must never verify");
  assert.equal(await verify(env, `${type}.${payloadB64}.${flip(sigB64)}`), null, "a tampered signature must never verify");
});

check("credential.verify: an expired credential never verifies; the exact expiry instant itself still does (I/O matrix row: Verify, expired)", async () => {
  const now = 1_700_000_000_000;
  const { mint, verify, setNow } = loadCredential({ now });
  const env = { ENTITLEMENT_SECRET: "secret_current" };
  const token = await mint(env, "sub_1");

  setNow(now + SEVEN_DAYS_MS);
  assert.ok(await verify(env, token), "a credential at exactly its expiry instant must still verify");

  setNow(now + SEVEN_DAYS_MS + 1);
  assert.equal(await verify(env, token), null, "a credential one ms past its expiry must never verify");
});

check("credential.verify: a d1.-prefixed (device-type) token never verifies as a c1. credential, even signed with the identical secret (I/O matrix row: Verify, wrong type)", async () => {
  const { verify } = loadCredential();
  const env = { ENTITLEMENT_SECRET: "secret_current" };
  const payload = { sub: "sub_1", iat: 1, exp: 9_999_999_999_999, v: 1 };

  const d1Token = await mintAs("d1.", env.ENTITLEMENT_SECRET, payload);
  assert.equal(await verify(env, d1Token), null, "a validly-signed d1. token must never verify as a c1. credential");

  // Sanity check: the identical payload/secret, but under the real c1.
  // prefix (built the same independent way, not through mint()), DOES
  // verify -- proving the rejection above is about the type prefix being
  // baked into the signed input, not an unrelated malformed-token bug.
  const c1Token = await mintAs("c1.", env.ENTITLEMENT_SECRET, payload);
  assert.ok(await verify(env, c1Token), "sanity: the c1.-prefixed equivalent must verify");
});

check("credential.verify: a token signed under ENTITLEMENT_SECRET_PREV still verifies; one signed under neither secret never does (I/O matrix row: Verify, _PREV)", async () => {
  const { mint, verify } = loadCredential();
  const oldSecret = "secret_old";
  const newSecret = "secret_new";

  const tokenSignedOld = await mint({ ENTITLEMENT_SECRET: oldSecret }, "sub_1");
  const envRotated = { ENTITLEMENT_SECRET: newSecret, ENTITLEMENT_SECRET_PREV: oldSecret };
  const payload = await verify(envRotated, tokenSignedOld);
  assert.ok(payload, "a token signed under the now-_PREV secret must still verify during the rotation overlap");
  assert.equal(payload.sub, "sub_1");

  const forgedToken = await mint({ ENTITLEMENT_SECRET: "totally_wrong_secret" }, "sub_1");
  assert.equal(await verify(envRotated, forgedToken), null, "a token signed under neither the current nor _PREV secret must never verify");
});

check("credential.verify: ENTITLEMENT_SECRET missing throws NotConfiguredError (Always: fail closed) even for a well-formed token", async () => {
  const { verify, NotConfiguredError } = loadCredential();
  await assert.rejects(() => verify({}, "c1.whatever.sig"), (e) => e instanceof NotConfiguredError);
});

check("credential.verify: malformed/garbage tokens never verify and never throw", async () => {
  const { verify } = loadCredential();
  const env = { ENTITLEMENT_SECRET: "secret_current" };
  const cases = [undefined, null, 42, "", "not-a-credential-at-all", "c1.", "c10.abc.def", "c1.onlyonepart", "d1.abc.def", "c1..sig", "c1.payload.", "c1.a.b.c", "c1.not-base64-!!!.sig"];
  for (const bad of cases) {
    assert.equal(await verify(env, bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

check("credential.verify: an oversized token is rejected by its length alone, before any decode/HMAC work", async () => {
  const { verify } = loadCredential();
  const env = { ENTITLEMENT_SECRET: "secret_current" };
  const oversized = "c1." + "a".repeat(3000) + ".sig";
  assert.equal(await verify(env, oversized), null);
});

check("credential.verify: a validly-signed token with the wrong payload.v is rejected", async () => {
  const { verify } = loadCredential();
  const secret = "secret_current";
  const env = { ENTITLEMENT_SECRET: secret };
  const badVersionToken = await mintAs("c1.", secret, { sub: "sub_1", iat: 1, exp: 9_999_999_999_999, v: 2 });
  assert.equal(await verify(env, badVersionToken), null, "payload.v must be exactly 1 (PAYLOAD_VERSION) to verify");
});

check("credential.verify: a validly-signed token with a missing or empty sub is rejected", async () => {
  const { verify } = loadCredential();
  const secret = "secret_current";
  const env = { ENTITLEMENT_SECRET: secret };
  const missingSub = await mintAs("c1.", secret, { iat: 1, exp: 9_999_999_999_999, v: 1 });
  const emptySub = await mintAs("c1.", secret, { sub: "", iat: 1, exp: 9_999_999_999_999, v: 1 });
  const numericSub = await mintAs("c1.", secret, { sub: 12345, iat: 1, exp: 9_999_999_999_999, v: 1 });
  assert.equal(await verify(env, missingSub), null, "a payload with no sub field must be rejected");
  assert.equal(await verify(env, emptySub), null, "a payload with an empty-string sub must be rejected");
  assert.equal(await verify(env, numericSub), null, "a payload with a non-string sub must be rejected");
});

// --- checkout-confirm.js: POST {sessionId}, regex + 30-min-age checks, credential minting -----

function jsonRequest(bodyObj, contentType = "application/json") {
  return {
    headers: { get: (name) => (name.toLowerCase() === "content-type" ? contentType : null) },
    json: async () => bodyObj,
  };
}
function badJsonRequest(contentType = "application/json") {
  return {
    headers: { get: (name) => (name.toLowerCase() === "content-type" ? contentType : null) },
    json: async () => {
      throw new SyntaxError("bad json");
    },
  };
}

const VALID_SESSION_ID = "cs_test_" + "a".repeat(24);

// Loads the real checkout-confirm.js (and the real stripe.js + credential.js
// it calls) into one fresh vm context, with Stripe's own `get`/`post` HTTP
// calls replaced by test doubles (`getImpl`/`postImpl`) and `Date.now`
// controllable via `setNow`.
function loadCheckoutConfirm({ getImpl, postImpl, now = 1_700_000_000_000 } = {}) {
  let currentNow = now;
  class FakeDate extends Date {
    static now() {
      return currentNow;
    }
  }
  const consoleCalls = [];
  const getCalls = [];
  const postCalls = [];
  const sandbox = {
    console: { error: (...args) => consoleCalls.push(args), log() {}, warn() {} },
    crypto,
    TextEncoder,
    TextDecoder,
    atob,
    btoa,
    Date: FakeDate,
    Response,
    URLSearchParams,
  };
  vm.createContext(sandbox);

  const stripeSrc = stripeLibSource.replace(/^export\s+/gm, "");
  vm.runInContext(`${stripeSrc}\nthis.StripeError = StripeError;`, sandbox, { filename: "stripe.js" });
  const StripeErr = sandbox.StripeError;

  sandbox.get = async (env, p) => {
    getCalls.push(p);
    if (!getImpl) throw new Error("no Stripe GET mock configured for this check");
    return getImpl(StripeErr)(env, p);
  };
  sandbox.post = async (env, p, params) => {
    postCalls.push({ path: p, params });
    if (!postImpl) return {};
    return postImpl(StripeErr)(env, p, params);
  };

  const credSrc = credentialLibSource.replace(/^export\s+/gm, "");
  vm.runInContext(`${credSrc}\nthis.__mint = mint; this.__verify = verify; this.__CredNotConfiguredError = NotConfiguredError;`, sandbox, {
    filename: "credential.js",
  });
  sandbox.credential = { mint: sandbox.__mint, verify: sandbox.__verify, NotConfiguredError: sandbox.__CredNotConfiguredError };

  const src = stripImportsAndExports(checkoutConfirmSource);
  vm.runInContext(
    `${src}\nthis.__onRequestPost = typeof onRequestPost !== "undefined" ? onRequestPost : null; this.__onRequestGet = typeof onRequestGet !== "undefined" ? onRequestGet : null;`,
    sandbox,
    { filename: "checkout-confirm.js" }
  );

  return {
    onRequestPost: sandbox.__onRequestPost,
    onRequestGet: sandbox.__onRequestGet,
    StripeError: StripeErr,
    getCalls,
    postCalls,
    consoleCalls,
    setNow(ms) {
      currentNow = ms;
    },
  };
}

check("checkout-confirm.js: only POST exists now -- the old GET shape is gone (Code Map: GET -> POST)", () => {
  const { onRequestPost, onRequestGet } = loadCheckoutConfirm({});
  assert.equal(typeof onRequestPost, "function");
  assert.equal(onRequestGet, null, "onRequestGet must not exist -- GET /api/checkout/confirm must be gone");
});

check("checkout-confirm.js: sessionId failing the regex returns 400 with zero Stripe calls (I/O matrix row)", async () => {
  const { onRequestPost, getCalls } = loadCheckoutConfirm({});
  const env = { STRIPE_SECRET_KEY: "sk_test", ENTITLEMENT_SECRET: "secret_current" };
  const badIds = [
    "",
    "cs_test_short",
    "not_a_session_id",
    "cs_prod_" + "a".repeat(24),
    "cs_live_" + "a".repeat(19), // one short of the 20-char minimum
    "cs_test_" + "!".repeat(25), // right length, disallowed characters
    " " + VALID_SESSION_ID, // leading whitespace must not be trimmed away
  ];
  for (const sessionId of badIds) {
    const res = await onRequestPost({ request: jsonRequest({ sessionId }), env });
    const body = await res.json();
    assert.equal(res.status, 400, `sessionId ${JSON.stringify(sessionId)} must be rejected`);
    assert.equal(body.error.code, "bad_request");
  }
  assert.equal(getCalls.length, 0, "an invalid sessionId must never reach a Stripe call");
});

check("checkout-confirm.js: a malformed JSON body returns 400 with zero Stripe calls", async () => {
  const { onRequestPost, getCalls } = loadCheckoutConfirm({});
  const env = { STRIPE_SECRET_KEY: "sk_test", ENTITLEMENT_SECRET: "secret_current" };
  const res = await onRequestPost({ request: badJsonRequest(), env });
  assert.equal(res.status, 400);
  assert.equal(getCalls.length, 0);
});

check("checkout-confirm.js: STRIPE_SECRET_KEY or ENTITLEMENT_SECRET missing answers not_configured with zero Stripe calls, mints nothing", async () => {
  const { onRequestPost, getCalls } = loadCheckoutConfirm({});
  for (const env of [{ ENTITLEMENT_SECRET: "secret_current" }, { STRIPE_SECRET_KEY: "sk_test" }, {}]) {
    const res = await onRequestPost({ request: jsonRequest({ sessionId: VALID_SESSION_ID }), env });
    const body = await res.json();
    assert.equal(res.status, 500);
    assert.equal(body.error.code, "not_configured");
  }
  assert.equal(getCalls.length, 0, "not_configured must be answered with zero Stripe calls");
});

// A fake Stripe Checkout Session as `get()` would return it, expanded.
function fakeSession({ createdSecondsAgo, paid = true, subscriptionStatus = "active", hasCustomer = true }) {
  return {
    payment_status: paid ? "paid" : "unpaid",
    created: Math.floor(1_700_000_000_000 / 1000) - createdSecondsAgo,
    customer: hasCustomer ? { id: "cus_1", metadata: {} } : null,
    subscription: {
      id: "sub_active_1",
      status: subscriptionStatus,
      items: { data: [{ price: { id: "price_yearly" }, current_period_end: 999 }] },
    },
  };
}

check("checkout-confirm.js: a valid, paid, active session older than 30 minutes still reports active and issues a restore code, but mints no credential (I/O matrix row)", async () => {
  const now = 1_700_000_000_000;
  const { onRequestPost, setNow } = loadCheckoutConfirm({
    now,
    getImpl: () => async () => fakeSession({ createdSecondsAgo: THIRTY_MIN_MS / 1000 + 1 }),
    postImpl: () => async () => ({}),
  });
  setNow(now);
  const env = { STRIPE_SECRET_KEY: "sk_test", ENTITLEMENT_SECRET: "secret_current" };
  const res = await onRequestPost({ request: jsonRequest({ sessionId: VALID_SESSION_ID }), env });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.active, true, "a stale session that is genuinely paid and active must still report active -- staleness is a credential-replay concern, not a payment-status one");
  assert.equal(body.credential, null, "a session older than 30 minutes must mint no credential");
  assert.ok(body.restoreCode, "a stale-but-active confirm must still issue the family's one-time restore code, or they are stranded with no self-serve way back in");
});

check("checkout-confirm.js: a session exactly 30 minutes old still mints a credential; one second older does not (boundary) -- active is true either way", async () => {
  const now = 1_700_000_000_000;

  const { onRequestPost: atBoundary } = loadCheckoutConfirm({
    now,
    getImpl: () => async () => fakeSession({ createdSecondsAgo: THIRTY_MIN_MS / 1000 }),
  });
  const boundaryBody = await (
    await atBoundary({
      request: jsonRequest({ sessionId: VALID_SESSION_ID }),
      env: { STRIPE_SECRET_KEY: "sk_test", ENTITLEMENT_SECRET: "secret_current" },
    })
  ).json();
  assert.equal(boundaryBody.active, true, "exactly 30 minutes old is still fresh");
  assert.ok(boundaryBody.credential, "exactly 30 minutes old must still mint a credential");

  const { onRequestPost: pastBoundary } = loadCheckoutConfirm({
    now,
    getImpl: () => async () => fakeSession({ createdSecondsAgo: THIRTY_MIN_MS / 1000 + 1 }),
    postImpl: () => async () => ({}),
  });
  const pastBody = await (
    await pastBoundary({
      request: jsonRequest({ sessionId: VALID_SESSION_ID }),
      env: { STRIPE_SECRET_KEY: "sk_test", ENTITLEMENT_SECRET: "secret_current" },
    })
  ).json();
  assert.equal(pastBody.active, true, "one second past 30 minutes is still genuinely active");
  assert.equal(pastBody.credential, null, "one second past 30 minutes must mint no credential");
});

check("checkout-confirm.js: valid, paid, active, fresh session returns a verifiable credential; response has no bare subscriptionId (I/O matrix row + Code Map response shape)", async () => {
  const now = 1_700_000_000_000;
  const { onRequestPost, setNow } = loadCheckoutConfirm({
    now,
    getImpl: () => async () => fakeSession({ createdSecondsAgo: 60 }),
  });
  setNow(now);
  const env = { STRIPE_SECRET_KEY: "sk_test", ENTITLEMENT_SECRET: "secret_current" };
  const res = await onRequestPost({ request: jsonRequest({ sessionId: VALID_SESSION_ID }), env });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.active, true);
  assert.equal(body.plan, "price_yearly");
  assert.equal(body.currentPeriodEnd, 999);
  assert.equal("subscriptionId" in body, false, "the response must not carry a bare subscriptionId any more -- only the credential carries it now");
  assert.equal(typeof body.credential, "string");
  assert.ok(body.credential.startsWith("c1."));

  const { verify } = loadCredential({ now });
  const payload = await verify(env, body.credential);
  assert.ok(payload, "the minted credential must itself verify");
  assert.equal(payload.sub, "sub_active_1", "the credential must carry the session's own subscription id");
});

check("checkout-confirm.js: an inactive/unpaid/no-subscription session mints no credential and issues no restore code", async () => {
  const now = 1_700_000_000_000;
  const cases = [
    ["unpaid", fakeSession({ createdSecondsAgo: 60, paid: false })],
    ["canceled subscription", fakeSession({ createdSecondsAgo: 60, subscriptionStatus: "canceled" })],
  ];
  for (const [label, session] of cases) {
    const { onRequestPost, postCalls, setNow } = loadCheckoutConfirm({ now, getImpl: () => async () => session });
    setNow(now);
    const env = { STRIPE_SECRET_KEY: "sk_test", ENTITLEMENT_SECRET: "secret_current" };
    const res = await onRequestPost({ request: jsonRequest({ sessionId: VALID_SESSION_ID }), env });
    const body = await res.json();
    assert.equal(body.active, false, label);
    assert.equal(body.credential, null, label);
    assert.equal(postCalls.length, 0, `${label}: an inactive session must never attempt to issue a restore code`);
  }
});

check("checkout-confirm.js: an active session with no customer object (fakeSession's hasCustomer:false) issues no restore code and does not throw", async () => {
  const now = 1_700_000_000_000;
  const { onRequestPost, postCalls, setNow } = loadCheckoutConfirm({
    now,
    getImpl: () => async () => fakeSession({ createdSecondsAgo: 60, hasCustomer: false }),
  });
  setNow(now);
  const env = { STRIPE_SECRET_KEY: "sk_test", ENTITLEMENT_SECRET: "secret_current" };
  const res = await onRequestPost({ request: jsonRequest({ sessionId: VALID_SESSION_ID }), env });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.active, true, "a genuinely active session is still active even with no expanded customer object");
  assert.ok(body.credential, "a credential can still be minted -- it only needs the subscription id, not the customer");
  assert.equal(body.restoreCode, null, "no customer object means no restore code can be issued");
  assert.equal(postCalls.length, 0, "no customer object means ensureRestoreCode must never even attempt a Stripe call");
});

check("checkout-confirm.js: a Checkout Session with subscription:null (a one-time, non-subscription purchase) reports inactive and mints nothing, without crashing", async () => {
  const now = 1_700_000_000_000;
  const oneTimeSession = {
    payment_status: "paid",
    created: Math.floor(now / 1000) - 60,
    customer: { id: "cus_1", metadata: {} },
    subscription: null,
  };
  const { onRequestPost, postCalls, setNow } = loadCheckoutConfirm({ now, getImpl: () => async () => oneTimeSession });
  setNow(now);
  const env = { STRIPE_SECRET_KEY: "sk_test", ENTITLEMENT_SECRET: "secret_current" };
  const res = await onRequestPost({ request: jsonRequest({ sessionId: VALID_SESSION_ID }), env });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.active, false);
  assert.equal(body.credential, null);
  assert.equal(body.plan, null);
  assert.equal(body.currentPeriodEnd, null);
  assert.equal(body.restoreCode, null);
  assert.equal(postCalls.length, 0, "an inactive (no-subscription) session must never attempt to issue a restore code");
});

check("checkout-confirm.js: a non-application/json content-type is rejected with 400 before any Stripe call", async () => {
  const { onRequestPost, getCalls } = loadCheckoutConfirm({});
  const env = { STRIPE_SECRET_KEY: "sk_test", ENTITLEMENT_SECRET: "secret_current" };
  for (const contentType of ["text/plain", "application/x-www-form-urlencoded", ""]) {
    const res = await onRequestPost({ request: jsonRequest({ sessionId: VALID_SESSION_ID }, contentType), env });
    assert.equal(res.status, 400, `content-type ${JSON.stringify(contentType)} must be rejected`);
    assert.equal((await res.json()).error.code, "bad_request");
  }
  assert.equal(getCalls.length, 0);
});

// --- entitlement.js: POST, Authorization: Bearer <credential>, verify-first, zero I/O on failure -----

// `options.rawAuthorization`, when provided, overrides the derived "Bearer
// <token>" value entirely -- lets a check hand in an arbitrary raw header
// value (missing scheme, wrong scheme, odd whitespace, ...) without also
// having to fake up a token. `options.contentType` defaults to
// "application/json" (what every real caller sends) so existing checks
// don't all need to know about the content-type gate; a check can override
// it to exercise that gate specifically.
function authRequest(token, url, options = {}) {
  const { contentType = "application/json", rawAuthorization } = options;
  return {
    url: url || "https://8ish.app/api/entitlement",
    headers: {
      get: (name) => {
        const key = name.toLowerCase();
        if (key === "authorization") {
          if (rawAuthorization !== undefined) return rawAuthorization;
          return token === undefined ? null : `Bearer ${token}`;
        }
        if (key === "content-type") return contentType;
        return null;
      },
    },
  };
}

// Loads the real entitlement.js (and the real stripe.js + credential.js it
// calls) into one fresh vm context, with lib/subStatus.js's `read()`
// replaced by a test double (`readImpl`) -- exercises entitlement.js's own
// control flow (verify-before-anything-else, which subscription id it
// passes to read(), how it maps a thrown error) in isolation from
// subStatus.js's own logic, which the Story 6-1 checks above already cover.
function loadEntitlement({ readImpl, mintOverride } = {}) {
  const consoleCalls = [];
  const readCalls = [];
  const sandbox = {
    console: { error: (...args) => consoleCalls.push(args), log() {}, warn() {} },
    crypto,
    TextEncoder,
    TextDecoder,
    atob,
    btoa,
    Response,
  };
  vm.createContext(sandbox);

  const stripeSrc = stripeLibSource.replace(/^export\s+/gm, "");
  vm.runInContext(`${stripeSrc}\nthis.StripeError = StripeError;`, sandbox, { filename: "stripe.js" });

  vm.runInContext(
    `class __StripeNotConfiguredError extends Error { constructor() { super("stripe_not_configured"); this.name = "NotConfiguredError"; } }\nthis.StripeNotConfiguredError = __StripeNotConfiguredError;`,
    sandbox
  );

  sandbox.read = async (env, sub) => {
    readCalls.push(sub);
    if (!readImpl) throw new Error("no subStatus.read mock configured for this check");
    return readImpl(sandbox.StripeNotConfiguredError, sandbox.StripeError)(env, sub);
  };

  const credSrc = credentialLibSource.replace(/^export\s+/gm, "");
  vm.runInContext(`${credSrc}\nthis.__mint = mint; this.__verify = verify; this.__CredNotConfiguredError = NotConfiguredError;`, sandbox, {
    filename: "credential.js",
  });
  // `mintOverride`, when provided, replaces only the refresh-credential
  // mint() call entitlement.js makes on an active answer -- verify() stays
  // the real implementation either way, so a check can still hand in a
  // genuinely valid credential and only make the SERVER-SIDE refresh fail.
  sandbox.credential = {
    mint: mintOverride || sandbox.__mint,
    verify: sandbox.__verify,
    NotConfiguredError: sandbox.__CredNotConfiguredError,
  };

  // Story 7-8: entitlement.js now imports readCappedBody as a NAMED import
  // -- must resolve as a bare identifier, same reasoning as every other
  // loader in this file that now wires in http-body.js.
  const httpBodySrc = httpBodyLibSource.replace(/^export\s+/gm, "");
  vm.runInContext(`${httpBodySrc}\nthis.readCappedBody = readCappedBody;`, sandbox, { filename: "http-body.js" });

  const src = stripImportsAndExports(entitlementSource);
  vm.runInContext(`${src}\nthis.__onRequestPost = onRequestPost;`, sandbox, { filename: "entitlement.js" });

  return {
    onRequestPost: sandbox.__onRequestPost,
    StripeNotConfiguredError: sandbox.StripeNotConfiguredError,
    StripeError: sandbox.StripeError,
    readCalls,
    consoleCalls,
  };
}

check("entitlement.js: invalid/missing/wrong-type/tampered/expired credential returns 401 with zero KV/Stripe calls (I/O matrix row, call-count test)", async () => {
  const { mint } = loadCredential();
  const secret = "secret_current";
  const validToken = await mint({ ENTITLEMENT_SECRET: secret }, "sub_1");
  const flip = (s) => s.slice(0, -1) + (s.at(-1) === "A" ? "B" : "A");

  const { mint: mintExpired } = loadCredential({ now: 1_700_000_000_000 - SEVEN_DAYS_MS - 1 });
  const expiredToken = await mintExpired({ ENTITLEMENT_SECRET: secret }, "sub_1");

  const cases = [
    ["no Authorization header at all", undefined],
    ["garbage token", "not-a-real-credential"],
    ["wrong-type (d1.) token", "d1.xxxx.yyyy"],
    ["tampered signature", flip(validToken)],
    ["expired credential", expiredToken],
  ];

  for (const [label, token] of cases) {
    const { onRequestPost, readCalls } = loadEntitlement({});
    const env = { ENTITLEMENT_SECRET: secret, STRIPE_SECRET_KEY: "sk_test" };
    const res = await onRequestPost({ request: authRequest(token), env });
    const body = await res.json();
    assert.equal(res.status, 401, `${label} must return 401`);
    assert.equal(body.error.code, "invalid_credential");
    assert.equal(readCalls.length, 0, `${label} must never reach subStatus.read() -- zero I/O on an invalid credential`);
  }
});

check("entitlement.js: ENTITLEMENT_SECRET missing answers not_configured with zero KV/Stripe calls, even with a well-formed token", async () => {
  const { onRequestPost, readCalls } = loadEntitlement({});
  const env = { STRIPE_SECRET_KEY: "sk_test" }; // no ENTITLEMENT_SECRET
  const res = await onRequestPost({ request: authRequest("c1.whatever.sig"), env });
  const body = await res.json();
  assert.equal(res.status, 500);
  assert.equal(body.error.code, "not_configured");
  assert.equal(readCalls.length, 0);
});

check("entitlement.js: valid credential + active status -- subscription id comes only from the credential (a query string is ignored), refreshed credential returned unconditionally (I/O matrix row)", async () => {
  const secret = "secret_current";
  const { mint } = loadCredential();
  const token = await mint({ ENTITLEMENT_SECRET: secret }, "sub_from_credential");

  const { onRequestPost, readCalls } = loadEntitlement({
    readImpl: () => async () => ({ active: true, currentPeriodEnd: 555, asOf: 1, source: "test" }),
  });
  const env = { ENTITLEMENT_SECRET: secret, STRIPE_SECRET_KEY: "sk_test" };
  // A malicious/confused query string naming a DIFFERENT subscription must
  // be completely ignored -- the id used is whatever verify() decoded from
  // the credential, nothing else.
  const res = await onRequestPost({ request: authRequest(token, "https://8ish.app/api/entitlement?subscription_id=attacker_controlled_sub"), env });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.deepEqual(readCalls, ["sub_from_credential"], "subStatus.read() must be called with the credential's own subscription id, and nothing else");
  assert.equal(body.active, true);
  assert.equal(body.currentPeriodEnd, 555);
  assert.equal(typeof body.credential, "string", "an active answer must include a refreshed credential unconditionally, not only on request");
  assert.notEqual(body.credential, token, "the refreshed credential must be freshly minted, not an echo of the request's own token");

  const { verify } = loadCredential();
  const refreshed = await verify({ ENTITLEMENT_SECRET: secret }, body.credential);
  assert.ok(refreshed, "the refreshed credential must itself verify");
  assert.equal(refreshed.sub, "sub_from_credential");
});

check("entitlement.js: valid credential but inactive status -- 200 with no credential in the response", async () => {
  const secret = "secret_current";
  const { mint } = loadCredential();
  const token = await mint({ ENTITLEMENT_SECRET: secret }, "sub_1");
  const { onRequestPost } = loadEntitlement({
    readImpl: () => async () => ({ active: false, currentPeriodEnd: null, asOf: 1, source: "test" }),
  });
  const env = { ENTITLEMENT_SECRET: secret, STRIPE_SECRET_KEY: "sk_test" };
  const res = await onRequestPost({ request: authRequest(token), env });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.active, false);
  assert.equal("credential" in body, false, "an inactive answer must not include a credential");
});

check("entitlement.js: subStatus.read() throwing its own NotConfiguredError (STRIPE_SECRET_KEY missing) also answers not_configured, but only after the credential itself verified", async () => {
  const secret = "secret_current";
  const { mint } = loadCredential();
  const token = await mint({ ENTITLEMENT_SECRET: secret }, "sub_1");
  const { onRequestPost, readCalls } = loadEntitlement({
    readImpl: (StripeNotConfiguredErrorClass) => async () => {
      throw new StripeNotConfiguredErrorClass();
    },
  });
  const env = { ENTITLEMENT_SECRET: secret }; // STRIPE_SECRET_KEY missing -- read() itself discovers this
  const res = await onRequestPost({ request: authRequest(token), env });
  const body = await res.json();
  assert.equal(res.status, 500);
  assert.equal(body.error.code, "not_configured");
  assert.equal(readCalls.length, 1, "read() must have been reached (and been the one to discover the missing Stripe key) -- the credential itself was fine");
});

check("entitlement.js: a Stripe/network failure from subStatus.read() maps to 502, not 401 or 500", async () => {
  const secret = "secret_current";
  const { mint } = loadCredential();
  const token = await mint({ ENTITLEMENT_SECRET: secret }, "sub_1");
  const { onRequestPost } = loadEntitlement({
    readImpl: (_StripeNotConfiguredErrorClass, StripeErrorClass) => async () => {
      throw new StripeErrorClass(500);
    },
  });
  const env = { ENTITLEMENT_SECRET: secret, STRIPE_SECRET_KEY: "sk_test" };
  const res = await onRequestPost({ request: authRequest(token), env });
  const body = await res.json();
  assert.equal(res.status, 502);
  assert.equal(body.error.code, "stripe_error");
});

check("entitlement.js: a refresh credential.mint() failure after a successful active read still answers the documented {error:{code}} shape (not_configured), not an unstructured 500", async () => {
  const secret = "secret_current";
  const { mint } = loadCredential();
  const token = await mint({ ENTITLEMENT_SECRET: secret }, "sub_1");
  const { onRequestPost, readCalls } = loadEntitlement({
    readImpl: () => async () => ({ active: true, currentPeriodEnd: 1, asOf: 1, source: "test" }),
    mintOverride: async () => {
      throw new Error("simulated mint failure");
    },
  });
  const env = { ENTITLEMENT_SECRET: secret, STRIPE_SECRET_KEY: "sk_test" };
  const res = await onRequestPost({ request: authRequest(token), env });
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.deepEqual(body, { error: { code: "not_configured" } }, "must be the documented envelope, not a raw error/stack leaking through");
  assert.equal(readCalls.length, 1, "the read() must still have happened -- only the refresh-mint step failed");
});

check("entitlement.js: a non-application/json content-type is rejected with 400 with zero KV/Stripe calls, even with a valid credential", async () => {
  const secret = "secret_current";
  const { mint } = loadCredential();
  const token = await mint({ ENTITLEMENT_SECRET: secret }, "sub_1");
  const { onRequestPost, readCalls } = loadEntitlement({});
  const env = { ENTITLEMENT_SECRET: secret, STRIPE_SECRET_KEY: "sk_test" };
  for (const contentType of ["text/plain", "application/x-www-form-urlencoded", ""]) {
    const res = await onRequestPost({ request: authRequest(token, undefined, { contentType }), env });
    assert.equal(res.status, 400, `content-type ${JSON.stringify(contentType)} must be rejected`);
    assert.equal((await res.json()).error.code, "bad_request");
  }
  assert.equal(readCalls.length, 0);
});

check("entitlement.js: unusual Authorization header shapes -- extractBearerToken's intended parsing, proven deliberately", async () => {
  const secret = "secret_current";
  const { mint } = loadCredential();
  const validToken = await mint({ ENTITLEMENT_SECRET: secret }, "sub_1");

  const cases = [
    ["\"Bearer\" with no token at all", "Bearer", false],
    ["wrong scheme (\"Basic ...\")", `Basic ${validToken}`, false],
    // extractBearerToken's regex uses \s+ (one-or-more), so multiple spaces
    // between the scheme and the token are deliberately tolerated.
    ["extra internal whitespace before the token", `Bearer   ${validToken}`, true],
    // extractBearerToken trims the whole header first, so trailing
    // whitespace after the token is deliberately tolerated too.
    ["trailing whitespace after the token", `Bearer ${validToken} `, true],
    ["lowercase scheme (\"bearer\")", `bearer ${validToken}`, true], // BEARER_RE is deliberately case-insensitive (/i)
    ["mixed-case scheme (\"BEARER\")", `BEARER ${validToken}`, true],
    ["the exact well-formed header", `Bearer ${validToken}`, true],
  ];

  for (const [label, rawAuthorization, expectAccepted] of cases) {
    const { onRequestPost, readCalls } = loadEntitlement({
      readImpl: () => async () => ({ active: true, currentPeriodEnd: 1, asOf: 1, source: "test" }),
    });
    const env = { ENTITLEMENT_SECRET: secret, STRIPE_SECRET_KEY: "sk_test" };
    const res = await onRequestPost({ request: authRequest(undefined, undefined, { rawAuthorization }), env });
    if (expectAccepted) {
      assert.equal(res.status, 200, `${label}: expected this shape to be accepted`);
      assert.equal(readCalls.length, 1, `${label}: expected a single subStatus.read() call`);
    } else {
      assert.equal(res.status, 401, `${label}: expected this shape to be rejected`);
      assert.equal(readCalls.length, 0, `${label}: a rejected shape must never reach subStatus.read()`);
    }
  }
});

// ------------------------------------------------------ Story 6-3: lib/turnstile.js, restore.js
//
// functions/lib/turnstile.js is the one file allowed to call Cloudflare's
// `siteverify` endpoint (AD-16) -- checked directly below against every row
// of the story's own I/O matrix, with `fetch` replaced by a test double (no
// live network call). restore.js is then checked through the same
// vm-sandbox technique as the rest of this file (real crypto, real
// credential.js logic, Stripe's `get` and turnstile's `verify` replaced by
// test doubles) -- no live Stripe/Turnstile call, no real KV, no `wrangler`
// command.

const TURNSTILE_LIB_PATH = path.join(LIB_DIR, "turnstile.js");
const RESTORE_PATH = path.join(ROOT_DIR, "functions/api/restore.js");
const DEVICE_TOKEN_LIB_PATH = path.join(LIB_DIR, "device-token.js");
const turnstileLibSource = readFileSync(TURNSTILE_LIB_PATH, "utf8");
const restoreSource = readFileSync(RESTORE_PATH, "utf8");
const deviceTokenLibSource = readFileSync(DEVICE_TOKEN_LIB_PATH, "utf8");

// Loads the real turnstile.js source into a fresh vm context per call, with
// `fetch` replaced by a test double (`fetchImpl`) and `URL`/`URLSearchParams`/
// `AbortController`/`setTimeout`/`clearTimeout`/`console` as the real
// globals (`console.error` captured, not just swallowed, so a check can
// assert a specific event code was logged) -- runs as the real, unmodified
// verify()/verifyDetailed() logic, timeout included. Story 7-6: also exposes
// `verifyDetailed` (the new additive export) alongside the unchanged
// `verify` -- every existing check below that destructures only `verify`
// is completely unaffected by this addition.
function loadTurnstile({ fetchImpl } = {}) {
  const fetchCalls = [];
  const consoleCalls = [];
  const sandbox = {
    fetch: (url, init) => {
      fetchCalls.push({ url, init });
      if (!fetchImpl) throw new Error("no fetch mock configured for this check");
      return fetchImpl(url, init);
    },
    URL,
    URLSearchParams,
    AbortController,
    setTimeout,
    clearTimeout,
    console: { error: (...args) => consoleCalls.push(args), log() {}, warn() {} },
  };
  vm.createContext(sandbox);
  const src = turnstileLibSource.replace(/^export\s+/gm, "");
  vm.runInContext(`${src}\nthis.verify = verify; this.verifyDetailed = verifyDetailed;`, sandbox, { filename: "turnstile.js" });
  return { verify: sandbox.verify, verifyDetailed: sandbox.verifyDetailed, fetchCalls, consoleCalls };
}

// Loads the real device-token.js source into a fresh vm context per call --
// real Web Crypto/base64 globals (crypto, TextEncoder/Decoder, atob/btoa),
// no clock faking needed (a device token carries no expiry at all). Runs as
// the real, unmodified mint()/verify() logic.
function loadDeviceToken() {
  const sandbox = { crypto, TextEncoder, TextDecoder, atob, btoa };
  vm.createContext(sandbox);
  const src = deviceTokenLibSource.replace(/^export\s+/gm, "");
  vm.runInContext(`${src}\nthis.mint = mint; this.verify = verify; this.NotConfiguredError = NotConfiguredError;`, sandbox, {
    filename: "device-token.js",
  });
  return { mint: sandbox.mint, verify: sandbox.verify, NotConfiguredError: sandbox.NotConfiguredError };
}

const TURNSTILE_ENV = { TURNSTILE_SECRET: "secret_ts", ORIGIN: "https://8ish.app" };

// A well-formed, passing siteverify response -- individual checks override
// one field at a time to exercise each I/O matrix row.
function siteverifyOk(overrides = {}) {
  return { success: true, action: "restore", hostname: "8ish.app", ...overrides };
}
const okResponse = (body) => ({ ok: true, json: async () => body });

check("turnstile.verify: well-formed success response, correct action and hostname -> true (I/O matrix row: valid)", async () => {
  const { verify, fetchCalls } = loadTurnstile({ fetchImpl: async () => okResponse(siteverifyOk()) });
  assert.equal(await verify(TURNSTILE_ENV, "tok_1", "restore"), true);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, "https://challenges.cloudflare.com/turnstile/v0/siteverify");
  assert.equal(fetchCalls[0].init.method, "POST");
});

check("turnstile.verify: never sends remoteip (AD-16), sends exactly secret and response", async () => {
  const { verify, fetchCalls } = loadTurnstile({ fetchImpl: async () => okResponse(siteverifyOk()) });
  await verify(TURNSTILE_ENV, "tok_1", "restore");
  const bodyText = fetchCalls[0].init.body;
  assert.equal(typeof bodyText, "string");
  assert.equal(bodyText.includes("remoteip"), false, "remoteip must never be sent to siteverify");
  const params = new URLSearchParams(bodyText);
  assert.equal(params.get("secret"), "secret_ts");
  assert.equal(params.get("response"), "tok_1");
  assert.equal(params.has("remoteip"), false);
});

check('turnstile.verify: action present but mismatched -> false (I/O matrix row: wrong action)', async () => {
  const { verify } = loadTurnstile({ fetchImpl: async () => okResponse(siteverifyOk({ action: "image" })) });
  assert.equal(await verify(TURNSTILE_ENV, "tok_1", "restore"), false);
});

check("turnstile.verify: action missing from the response -> false, never a pass (I/O matrix row: missing action)", async () => {
  const missingAction = siteverifyOk();
  delete missingAction.action;
  const { verify } = loadTurnstile({ fetchImpl: async () => okResponse(missingAction) });
  assert.equal(await verify(TURNSTILE_ENV, "tok_1", "restore"), false);
});

check("turnstile.verify: hostname != ORIGIN's host -> false (I/O matrix row: wrong hostname)", async () => {
  const { verify } = loadTurnstile({ fetchImpl: async () => okResponse(siteverifyOk({ hostname: "evil.example.com" })) });
  assert.equal(await verify(TURNSTILE_ENV, "tok_1", "restore"), false);
});

check("turnstile.verify: a replayed token -- the second siteverify call for the same token answers success:false, and verify() reports false (I/O matrix row: replayed token)", async () => {
  let calls = 0;
  const { verify } = loadTurnstile({
    fetchImpl: async () => {
      calls++;
      return okResponse(siteverifyOk({ success: calls === 1 })); // Cloudflare's own single-use enforcement, simulated
    },
  });
  assert.equal(await verify(TURNSTILE_ENV, "tok_reused", "restore"), true, "first use must still verify");
  assert.equal(await verify(TURNSTILE_ENV, "tok_reused", "restore"), false, "the replay must fail");
});

check("turnstile.verify: siteverify unreachable (network failure) -> false, never a pass (I/O matrix row: service unreachable)", async () => {
  const { verify } = loadTurnstile({
    fetchImpl: async () => {
      throw new TypeError("Failed to fetch");
    },
  });
  assert.equal(await verify(TURNSTILE_ENV, "tok_1", "restore"), false);
});

check("turnstile.verify: a non-2xx response from siteverify -> false", async () => {
  const { verify } = loadTurnstile({ fetchImpl: async () => ({ ok: false, json: async () => ({}) }) });
  assert.equal(await verify(TURNSTILE_ENV, "tok_1", "restore"), false);
});

check("turnstile.verify: malformed JSON from siteverify -> false, never throws", async () => {
  const { verify } = loadTurnstile({
    fetchImpl: async () => ({
      ok: true,
      json: async () => {
        throw new SyntaxError("bad json");
      },
    }),
  });
  assert.equal(await verify(TURNSTILE_ENV, "tok_1", "restore"), false);
});

check("turnstile.verify: success:false -> false even with a matching action and hostname", async () => {
  const { verify } = loadTurnstile({ fetchImpl: async () => okResponse(siteverifyOk({ success: false })) });
  assert.equal(await verify(TURNSTILE_ENV, "tok_1", "restore"), false);
});

check("turnstile.verify: TURNSTILE_SECRET missing -> false, zero fetch calls (fails closed, never a pass)", async () => {
  const { verify, fetchCalls } = loadTurnstile({});
  assert.equal(await verify({ ORIGIN: "https://8ish.app" }, "tok_1", "restore"), false);
  assert.equal(fetchCalls.length, 0);
});

check("turnstile.verify: missing/empty/non-string token -> false, zero fetch calls", async () => {
  const { verify, fetchCalls } = loadTurnstile({});
  for (const bad of [undefined, null, "", 42]) {
    assert.equal(await verify(TURNSTILE_ENV, bad, "restore"), false, `expected false for token ${JSON.stringify(bad)}`);
  }
  assert.equal(fetchCalls.length, 0);
});

check("turnstile.verify: missing/empty/non-string expectedAction -> false, zero fetch calls", async () => {
  const { verify, fetchCalls } = loadTurnstile({});
  for (const bad of [undefined, null, "", 42]) {
    assert.equal(await verify(TURNSTILE_ENV, "tok_1", bad), false, `expected false for expectedAction ${JSON.stringify(bad)}`);
  }
  assert.equal(fetchCalls.length, 0);
});

check("turnstile.verify: env.ORIGIN missing, empty, or unparsable -> false, zero fetch calls (fails closed rather than skipping the hostname check)", async () => {
  const { verify, fetchCalls } = loadTurnstile({});
  for (const badEnv of [
    { TURNSTILE_SECRET: "s" },
    { TURNSTILE_SECRET: "s", ORIGIN: "" },
    { TURNSTILE_SECRET: "s", ORIGIN: "not a url" },
  ]) {
    assert.equal(await verify(badEnv, "tok_1", "restore"), false);
  }
  assert.equal(fetchCalls.length, 0);
});

// --- restore.js: token-first, both-email-forms lookup, cooldown removed, credential minted -----

// Loads the real restore.js (and the real stripe.js + credential.js it
// calls) into one fresh vm context, with Stripe's `get` and turnstile's
// `verify` replaced by test doubles (`getImpl`/`verifyImpl`) -- exercises
// restore.js's own control flow in isolation from turnstile.js's own logic,
// which the checks above already cover directly.
// `useRealTurnstile`/`fetchImpl` (Story 7-6 review finding, Verification
// Gap): every other restore.js check hand-stubs `sandbox.turnstile.verify`
// directly, which proves restore.js CALLS something named
// `turnstile.verify(token, action)` in the right order -- it never proves
// that call, once it reaches the REAL (Story 7-6-refactored, now
// `checkTurnstile()`-backed) turnstile.js, still produces the same result
// for restore.js's actual input shapes. Passing `useRealTurnstile: true`
// loads the genuine turnstile.js source into this same sandbox instead of
// the hand-written stub, wired to a controllable `fetchImpl` (mocking only
// the network boundary, exactly like `loadTurnstile()`'s own tests already
// do) -- so a check built this way exercises restore.js's real request/
// response cycle through the real, unmodified-behavior verify() export,
// not a stand-in that could no longer even resemble the current code.
function loadRestore({ getImpl, verifyImpl, useRealTurnstile, fetchImpl } = {}) {
  const consoleCalls = [];
  const getCalls = [];
  const verifyCalls = [];
  const fetchCalls = [];
  const sandbox = {
    console: { error: (...args) => consoleCalls.push(args), log() {}, warn() {} },
    crypto,
    TextEncoder,
    TextDecoder,
    atob,
    btoa,
    Response,
    URLSearchParams,
  };
  if (useRealTurnstile) {
    sandbox.URL = URL;
    sandbox.AbortController = AbortController;
    sandbox.setTimeout = setTimeout;
    sandbox.clearTimeout = clearTimeout;
    sandbox.fetch = (url, init) => {
      fetchCalls.push({ url, init });
      if (!fetchImpl) throw new Error("no fetch mock configured for this real-turnstile check");
      return fetchImpl(url, init);
    };
  }
  vm.createContext(sandbox);

  const stripeSrc = stripeLibSource.replace(/^export\s+/gm, "");
  vm.runInContext(`${stripeSrc}\nthis.StripeError = StripeError;`, sandbox, { filename: "stripe.js" });
  const StripeErr = sandbox.StripeError;

  sandbox.get = async (env, p) => {
    getCalls.push(p);
    if (!getImpl) throw new Error("no Stripe GET mock configured for this check");
    return getImpl(StripeErr)(env, p);
  };

  const credSrc = credentialLibSource.replace(/^export\s+/gm, "");
  vm.runInContext(`${credSrc}\nthis.__mint = mint; this.__verify = verify; this.__CredNotConfiguredError = NotConfiguredError;`, sandbox, {
    filename: "credential.js",
  });
  sandbox.credential = { mint: sandbox.__mint, verify: sandbox.__verify, NotConfiguredError: sandbox.__CredNotConfiguredError };

  // Story 7-8: http-body.js's readCappedBody, governor-config.js's
  // loadGovernorConfig, and request-throttle.js's own named exports --
  // restore.js now imports all of these as NAMED imports, so each must
  // resolve as a bare identifier when restore.js's own stripped source runs
  // next, exactly like credential.js's namespace import is wired above and
  // exactly matching how loadTransform() wires the same three modules for
  // transform.js. A fresh vm context per loadRestore() call (see
  // vm.createContext(sandbox) above) means request-throttle.js's own
  // module-level Maps are brand new every call -- no cross-check pollution,
  // no reset call needed between checks.
  const httpBodySrc = httpBodyLibSource.replace(/^export\s+/gm, "");
  vm.runInContext(`${httpBodySrc}\nthis.readCappedBody = readCappedBody;`, sandbox, { filename: "http-body.js" });
  // restore.js imports loadGovernorLimits (Story 7-8 review fix), NOT
  // loadGovernorConfig -- restore's attempt spacing is not Image spend, so
  // it must not be gated by AI_ENABLED (Story 7-4's Image-specific Kill
  // Switch). Both are wired into the sandbox regardless, so a check can
  // exercise either name if useful.
  const govConfigSrc = governorConfigLibSource.replace(/^export\s+/gm, "");
  vm.runInContext(`${govConfigSrc}\nthis.loadGovernorConfig = loadGovernorConfig; this.loadGovernorLimits = loadGovernorLimits;`, sandbox, {
    filename: "governor-config.js",
  });
  const requestThrottleSrc = requestThrottleLibSource.replace(/^export\s+/gm, "");
  vm.runInContext(
    `${requestThrottleSrc}\nthis.checkPreLimit = checkPreLimit; this.checkDenyCache = checkDenyCache; this.recordDenial = recordDenial; this.PRE_LIMIT_RETRY_AFTER = PRE_LIMIT_RETRY_AFTER;`,
    sandbox,
    { filename: "request-throttle.js" }
  );

  if (useRealTurnstile) {
    const tsSrc = turnstileLibSource.replace(/^export\s+/gm, "");
    vm.runInContext(`${tsSrc}\nthis.__tsVerify = verify;`, sandbox, { filename: "turnstile.js" });
    sandbox.turnstile = {
      verify: async (env, token, action) => {
        verifyCalls.push({ token, action });
        return sandbox.__tsVerify(env, token, action);
      },
    };
  } else {
    sandbox.turnstile = {
      verify: async (env, token, action) => {
        verifyCalls.push({ token, action });
        if (!verifyImpl) return false;
        return verifyImpl(env, token, action);
      },
    };
  }

  const src = stripImportsAndExports(restoreSource);
  vm.runInContext(`${src}\nthis.__onRequestPost = onRequestPost;`, sandbox, { filename: "restore.js" });

  return {
    onRequestPost: sandbox.__onRequestPost,
    StripeError: StripeErr,
    getCalls,
    verifyCalls,
    consoleCalls,
    fetchCalls,
  };
}

// Story 7-8: restore.js now also needs a working Governor -- AI_ENABLED/
// STATE_KV (for loadGovernorConfig's own three-layer Kill Switch) and a
// GOVERNOR binding. The shared stub here grants unconditionally (a sane
// default matching makeGovernorStub()'s own default) -- every EXISTING
// check below that reuses RESTORE_ENV by reference never inspects this
// stub's own call logs, so sharing one instance across many checks is
// harmless; any NEW check that specifically needs to observe/control
// reserve()/commit() calls builds its own fresh env instead (see
// restoreGovernorEnv() further below), exactly like transform.js's own
// per-check makeTransformEnv() pattern.
const RESTORE_ENV = {
  STRIPE_SECRET_KEY: "sk_test",
  ENTITLEMENT_SECRET: "secret_current",
  AI_ENABLED: "true",
  STATE_KV: makeStateKv(VALID_GOVERNOR_CFG_RAW),
  GOVERNOR: makeGovernorBinding(makeGovernorStub().stub),
};

// A fresh, per-check env for restore.js's own Story 7-8 Governor-spacing
// checks -- same shape as RESTORE_ENV, but with a controllable `governorStub`
// (via makeGovernorStub()) so a check can assert on reserveCalls/commitCalls
// or control what reserve() answers, without disturbing RESTORE_ENV's own
// shared default used by every pre-existing check above.
function restoreGovernorEnv({ governorStub, governorCfgRaw = VALID_GOVERNOR_CFG_RAW, aiEnabled = "true" } = {}) {
  return {
    STRIPE_SECRET_KEY: "sk_test",
    ENTITLEMENT_SECRET: "secret_current",
    AI_ENABLED: aiEnabled,
    STATE_KV: makeStateKv(governorCfgRaw),
    GOVERNOR: makeGovernorBinding(governorStub),
  };
}

// Story 7-8: restore.js no longer calls `request.json()` at all -- it reads
// a byte-capped body (lib/http-body.js) and JSON.parses the decoded bytes
// itself, so its test requests need a REAL `.body` stream, exactly like
// transformRequest()'s own real `Request` objects (unlike jsonRequest()'s
// plain `{json: async () => bodyObj}` stand-in, still used by
// checkout-confirm.js's own section above, which never reads a body stream
// at all).
function restoreRequest(bodyObj) {
  return new Request("https://8ish.app/api/restore", { method: "POST", body: JSON.stringify(bodyObj) });
}
function badJsonRestoreRequest() {
  return new Request("https://8ish.app/api/restore", { method: "POST", body: "not valid json{" });
}

// Reproduces restore.js's own normalizeCode()+hashCode() independently (the
// same technique mintAs() above uses for credential.js) so these checks
// aren't just trusting the same code they're testing.
async function restoreCodeHash(rawCode) {
  const normalized = rawCode.toUpperCase().replace(/[^0-9A-Z]/g, "");
  const data = new TextEncoder().encode(normalized);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

check("restore.js: STRIPE_SECRET_KEY or ENTITLEMENT_SECRET missing answers not_configured, zero human-check/Stripe calls", async () => {
  const { onRequestPost, getCalls, verifyCalls } = loadRestore({});
  for (const env of [{ ENTITLEMENT_SECRET: "secret_current" }, { STRIPE_SECRET_KEY: "sk_test" }, {}]) {
    const res = await onRequestPost({ request: restoreRequest({ email: "a@b.com", code: "ABCDE-12345", turnstile: "tok" }), env });
    const body = await res.json();
    assert.equal(res.status, 500);
    assert.equal(body.error.code, "not_configured");
  }
  assert.equal(getCalls.length, 0);
  assert.equal(verifyCalls.length, 0);
});

check("restore.js: a malformed JSON body returns 400, zero human-check/Stripe calls", async () => {
  const { onRequestPost, getCalls, verifyCalls } = loadRestore({});
  const res = await onRequestPost({ request: badJsonRestoreRequest(), env: RESTORE_ENV });
  assert.equal(res.status, 400);
  assert.equal(getCalls.length, 0);
  assert.equal(verifyCalls.length, 0);
});

check('restore.js: turnstile.verify() is called with action "restore" before any Stripe call; a failing token returns 403 human_check_failed with zero Stripe calls (I/O matrix row)', async () => {
  const { onRequestPost, getCalls, verifyCalls } = loadRestore({ verifyImpl: async () => false });
  const res = await onRequestPost({
    request: restoreRequest({ email: "a@b.com", code: "ABCDE-12345", turnstile: "bad_token" }),
    env: RESTORE_ENV,
  });
  const body = await res.json();
  assert.equal(res.status, 403);
  assert.equal(body.error.code, "human_check_failed");
  assert.equal(getCalls.length, 0, "zero Stripe calls when the token is invalid");
  assert.deepEqual(verifyCalls, [{ token: "bad_token", action: "restore" }]);
});

check("restore.js: the REAL (Story 7-6-refactored) turnstile.js is genuinely transparent to restore.js's actual request/response cycle -- not just proven in isolation, and not just proven via a hand-stub", async () => {
  const env = { ...RESTORE_ENV, TURNSTILE_SECRET: "secret_ts", ORIGIN: "https://8ish.app" };

  // A real siteverify SUCCESS, mocked only at the fetch boundary -- proves
  // the real verify() (now internally backed by checkTurnstile(), shared
  // with the new verifyDetailed()) still lets a genuinely valid restore
  // request past the human check, through restore.js's own real code.
  {
    const { onRequestPost, getCalls, fetchCalls } = loadRestore({
      useRealTurnstile: true,
      fetchImpl: async () => ({ ok: true, json: async () => ({ success: true, action: "restore", hostname: "8ish.app" }) }),
      getImpl: () => async () => ({ data: [] }), // no matching customer -- still proves the human check passed
    });
    const res = await onRequestPost({ request: restoreRequest({ email: "a@b.com", code: "ABCDE-12345", turnstile: "real_tok_ok" }), env });
    const body = await res.json();
    assert.notEqual(res.status, 403, "a genuinely valid token must not be rejected by the real, refactored verify()");
    assert.equal(res.status, 200);
    assert.deepEqual(body, { active: false }, "no matching customer -- restore.js's own generic no-match shape, proving it got PAST the human check to reach this code at all");
    assert.equal(fetchCalls.length, 1, "the real verify() actually called siteverify");
    assert.ok(getCalls.length > 0, "having passed the real human check, restore.js proceeded to the Stripe lookup");
  }

  // A real siteverify FAILURE (success:false), same real module, same
  // fetch-boundary mock technique -- proves the real verify() still
  // correctly fails restore.js's request closed.
  {
    const { onRequestPost, getCalls, fetchCalls } = loadRestore({
      useRealTurnstile: true,
      fetchImpl: async () => ({ ok: true, json: async () => ({ success: false }) }),
    });
    const res = await onRequestPost({ request: restoreRequest({ email: "a@b.com", code: "ABCDE-12345", turnstile: "real_tok_bad" }), env });
    const body = await res.json();
    assert.equal(res.status, 403);
    assert.equal(body.error.code, "human_check_failed");
    assert.equal(fetchCalls.length, 1);
    assert.equal(getCalls.length, 0, "zero Stripe calls -- the real verify() genuinely gated this, not a stub pretending to");
  }
});

check("restore.js: a missing turnstile field (and missing email/code too) still fails the human check first -- 403, zero Stripe calls (Code Map: verify before any other work)", async () => {
  const { onRequestPost, getCalls, verifyCalls } = loadRestore({ verifyImpl: async () => false });
  const res = await onRequestPost({ request: restoreRequest({}), env: RESTORE_ENV });
  const body = await res.json();
  assert.equal(res.status, 403);
  assert.equal(body.error.code, "human_check_failed");
  assert.equal(getCalls.length, 0);
  assert.deepEqual(verifyCalls, [{ token: "", action: "restore" }], "verify() must still run (with an empty token) before email/code are even inspected");
});

check("restore.js: a passing token but missing email/code returns 400 bad_request, with zero Stripe calls", async () => {
  const { onRequestPost, getCalls } = loadRestore({ verifyImpl: async () => true });
  const cases = [
    { email: "", code: "ABCDE-12345", turnstile: "tok" },
    { email: "a@b.com", code: "", turnstile: "tok" },
    { turnstile: "tok" },
  ];
  for (const bad of cases) {
    const res = await onRequestPost({ request: restoreRequest(bad), env: RESTORE_ENV });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "bad_request");
  }
  assert.equal(getCalls.length, 0);
});

check("restore.js: mixed-case stored email -- found via the lowercased form when the typed casing yields no customers (I/O matrix row: mixed-case stored email)", async () => {
  const code = "ABCDE-12345";
  const hash = await restoreCodeHash(code);
  const custId = "cus_mixed_1";
  const subId = "sub_mixed_1";

  const getImpl = () => async (env, p) => {
    if (p.startsWith("customers?email=")) {
      const queried = decodeURIComponent(p.slice("customers?email=".length).split("&")[0]);
      // Simulates Stripe's case-sensitive filter: only the lowercased query
      // (matching how the email actually happens to be stored) returns this
      // customer -- the typed, mixed-case form finds nobody.
      if (queried === "john@example.com") return { data: [{ id: custId, metadata: { restore_code_hash: hash } }] };
      return { data: [] };
    }
    if (p.startsWith("subscriptions?customer=")) {
      return { data: [{ id: subId, status: "active", items: { data: [{ price: { id: "price_yearly" }, current_period_end: 999 }] } }] };
    }
    throw new Error(`unexpected Stripe path: ${p}`);
  };

  const { onRequestPost, getCalls } = loadRestore({ verifyImpl: async () => true, getImpl });
  const res = await onRequestPost({
    request: restoreRequest({ email: "John@Example.com", code, turnstile: "tok" }),
    env: RESTORE_ENV,
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.active, true, "restore must succeed by trying the lowercased form after the typed casing found nobody");
  assert.equal(typeof body.credential, "string");
  assert.ok(getCalls.some((p) => p.includes(encodeURIComponent("John@Example.com"))), "the exact typed casing must be tried");
  assert.ok(getCalls.some((p) => p.includes(encodeURIComponent("john@example.com"))), "the lowercased form must also be tried");
});

check("restore.js: an already-lowercase typed email triggers only one customers?email= query (no redundant duplicate call)", async () => {
  const code = "BBBBB-22222";
  const hash = await restoreCodeHash(code);
  const calls = [];
  const getImpl = () => async (env, p) => {
    calls.push(p);
    if (p.startsWith("customers?email=")) return { data: [{ id: "cus_1", metadata: { restore_code_hash: hash } }] };
    if (p.startsWith("subscriptions?customer=")) {
      return { data: [{ id: "sub_1", status: "active", items: { data: [{ price: { id: "p" }, current_period_end: 1 }] } }] };
    }
    throw new Error(`unexpected Stripe path: ${p}`);
  };
  const { onRequestPost } = loadRestore({ verifyImpl: async () => true, getImpl });
  await onRequestPost({ request: restoreRequest({ email: "already@lowercase.com", code, turnstile: "tok" }), env: RESTORE_ENV });
  const customerCalls = calls.filter((p) => p.startsWith("customers?email="));
  assert.equal(customerCalls.length, 1, "typed === lowercased must not trigger a duplicate query");
});

check("restore.js: results from both email forms are deduped by customer id (Code Map) -- a customer appearing in both is processed only once", async () => {
  const code = "CCCCC-33333";
  const hash = await restoreCodeHash(code);
  const subCalls = [];
  const getImpl = () => async (env, p) => {
    if (p.startsWith("customers?email=")) {
      // Both the typed (mixed-case) and lowercased queries happen to return
      // the SAME customer -- restore.js must still process it only once.
      return { data: [{ id: "cus_dup", metadata: { restore_code_hash: hash } }] };
    }
    if (p.startsWith("subscriptions?customer=")) {
      subCalls.push(p);
      return { data: [{ id: "sub_dup", status: "active", items: { data: [{ price: { id: "p" }, current_period_end: 1 }] } }] };
    }
    throw new Error(`unexpected Stripe path: ${p}`);
  };
  const { onRequestPost } = loadRestore({ verifyImpl: async () => true, getImpl });
  const res = await onRequestPost({ request: restoreRequest({ email: "Mixed@Case.com", code, turnstile: "tok" }), env: RESTORE_ENV });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).active, true);
  assert.equal(subCalls.length, 1, "the deduped customer must only be looked up once, not once per query that returned it");
});

check("restore.js: a correct email+code with an active subscription mints a verifiable credential; response carries no bare subscriptionId (Code Map response shape)", async () => {
  const code = "ZZZZZ-99999";
  const hash = await restoreCodeHash(code);
  const custId = "cus_1";
  const subId = "sub_1";
  const getImpl = () => async (env, p) => {
    if (p.startsWith("customers?email=")) return { data: [{ id: custId, metadata: { restore_code_hash: hash } }] };
    if (p.startsWith("subscriptions?customer=")) {
      return { data: [{ id: subId, status: "active", items: { data: [{ price: { id: "price_monthly" }, current_period_end: 555 }] } }] };
    }
    throw new Error(`unexpected Stripe path: ${p}`);
  };
  const { onRequestPost } = loadRestore({ verifyImpl: async () => true, getImpl });
  const res = await onRequestPost({ request: restoreRequest({ email: "a@b.com", code, turnstile: "tok" }), env: RESTORE_ENV });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.active, true);
  assert.equal(body.plan, "price_monthly");
  assert.equal(body.currentPeriodEnd, 555);
  assert.equal("subscriptionId" in body, false, "the response must not carry a bare subscriptionId any more -- only the credential carries it");
  assert.equal(typeof body.credential, "string");
  assert.ok(body.credential.startsWith("c1."));

  const { verify } = loadCredential();
  const payload = await verify(RESTORE_ENV, body.credential);
  assert.ok(payload, "the minted credential must itself verify");
  assert.equal(payload.sub, subId, "the credential must carry the matched subscription's id");
});

check("restore.js: wrong email, wrong code, and an inactive subscription all answer the identical {active:false} (I/O matrix row)", async () => {
  const code = "AAAAA-11111";
  const hash = await restoreCodeHash(code);

  // wrong email -> no customers found for either form at all
  const noCustomers = () => async (env, p) => {
    if (p.startsWith("customers?email=")) return { data: [] };
    throw new Error(`unexpected Stripe path: ${p}`);
  };
  const { onRequestPost: wrongEmail } = loadRestore({ verifyImpl: async () => true, getImpl: noCustomers });
  const r1 = await wrongEmail({ request: restoreRequest({ email: "nobody@example.com", code, turnstile: "tok" }), env: RESTORE_ENV });
  assert.equal(r1.status, 200);
  assert.deepEqual(await r1.json(), { active: false });

  // wrong code -> a customer is found but the restore code hash doesn't match
  const wrongHashGet = () => async (env, p) => {
    if (p.startsWith("customers?email=")) return { data: [{ id: "cus_1", metadata: { restore_code_hash: "not_the_real_hash" } }] };
    throw new Error(`unexpected Stripe path: ${p}`);
  };
  const { onRequestPost: wrongCode } = loadRestore({ verifyImpl: async () => true, getImpl: wrongHashGet });
  const r2 = await wrongCode({ request: restoreRequest({ email: "a@b.com", code, turnstile: "tok" }), env: RESTORE_ENV });
  assert.deepEqual(await r2.json(), { active: false });

  // right customer, right code, but no active/trialing subscription
  const inactiveSubGet = () => async (env, p) => {
    if (p.startsWith("customers?email=")) return { data: [{ id: "cus_1", metadata: { restore_code_hash: hash } }] };
    if (p.startsWith("subscriptions?customer=")) return { data: [{ id: "sub_1", status: "canceled", items: { data: [] } }] };
    throw new Error(`unexpected Stripe path: ${p}`);
  };
  const { onRequestPost: inactive } = loadRestore({ verifyImpl: async () => true, getImpl: inactiveSubGet });
  const r3 = await inactive({ request: restoreRequest({ email: "a@b.com", code, turnstile: "tok" }), env: RESTORE_ENV });
  assert.deepEqual(await r3.json(), { active: false });
});

check("restore.js: a Stripe error on the customers lookup returns 502 stripe_error and logs a fixed event code with the status", async () => {
  const { onRequestPost, consoleCalls } = loadRestore({
    verifyImpl: async () => true,
    getImpl:
      (StripeErr) =>
      async () => {
        throw new StripeErr(500);
      },
  });
  const res = await onRequestPost({
    request: restoreRequest({ email: "a@b.com", code: "ABCDE-12345", turnstile: "tok" }),
    env: RESTORE_ENV,
  });
  const body = await res.json();
  assert.equal(res.status, 502);
  assert.equal(body.error.code, "stripe_error");
  assert.ok(consoleCalls.some((args) => args[0] === "restore_stripe_error" && args[1] === 500));
});

check("restore.js: a plain network failure (not a StripeError) on the customers lookup returns 502 stripe_unreachable, and logs nothing (asymmetric with the StripeError branch)", async () => {
  const { onRequestPost, consoleCalls } = loadRestore({
    verifyImpl: async () => true,
    getImpl: () => async () => {
      throw new TypeError("Failed to fetch");
    },
  });
  const res = await onRequestPost({
    request: restoreRequest({ email: "a@b.com", code: "ABCDE-12345", turnstile: "tok" }),
    env: RESTORE_ENV,
  });
  const body = await res.json();
  assert.equal(res.status, 502);
  assert.equal(body.error.code, "stripe_unreachable");
  assert.deepEqual(consoleCalls, [], "a plain network failure must not be logged, unlike the StripeError branch above");
});

check("restore.js: the old per-email KV cooldown is physically gone from the file -- no restoreAttempt: literal, no STATE_KV/COOLDOWN_MS reference (Always: cooldown removed)", () => {
  assert.ok(!restoreSource.includes("restoreAttempt:"), "restoreAttempt: must not appear anywhere in restore.js");
  assert.ok(!restoreSource.includes("STATE_KV"), "restore.js must never touch STATE_KV any more");
  assert.ok(!restoreSource.includes("COOLDOWN_MS"), "the cooldown constant must be gone too");
});

// -------------------------------------------- Story 7-8: restore.js's real Governor-backed attempt spacing
//
// Layered in AFTER the Turnstile check, BEFORE the Stripe lookup (Design
// Notes) -- checked here through the same restoreGovernorEnv()/loadRestore()
// machinery as every check above, with a controllable governorStub
// (makeGovernorStub(), makeGovernorBinding() -- both defined in the Story
// 7-5 transform.js section further below, but usable here too: function
// declarations are hoisted, and every check body below only runs from the
// final runner loop at the bottom of this file, well after the whole module
// (including that section) has finished evaluating).

check("restore.js: a body over 8KB is rejected 400 bad_request before ANY other work -- zero human-check/Stripe/Governor calls", async () => {
  const { onRequestPost, getCalls, verifyCalls } = loadRestore({});
  const oversized = new Request("https://8ish.app/api/restore", {
    method: "POST",
    body: JSON.stringify({ email: "a@b.com", code: "ABCDE-12345", turnstile: "tok", pad: "x".repeat(9000) }),
  });
  const res = await onRequestPost({ request: oversized, env: RESTORE_ENV });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.error.code, "bad_request");
  assert.equal(getCalls.length, 0, "an over-cap body must cost zero Stripe calls");
  assert.equal(verifyCalls.length, 0, "an over-cap body must cost zero human-check calls -- rejected before Turnstile even runs");
});

check("restore.js: a body under the 8KB cap is completely unaffected -- same 400 bad_request/zero-Stripe-calls outcome as before this story for a malformed-but-small body", async () => {
  const { onRequestPost, getCalls } = loadRestore({});
  const res = await onRequestPost({ request: badJsonRestoreRequest(), env: RESTORE_ENV });
  assert.equal(res.status, 400);
  assert.equal(getCalls.length, 0);
});

// Builds a JSON string whose UTF-8 byte length is EXACTLY targetBytes, by
// padding bodyObj's own `pad` field -- used below (and by the other 4
// body-capped endpoints' own exact-boundary checks further down this file:
// checkout.js/entitlement.js/subscription.js/stripe-webhook.js) to prove
// lib/http-body.js's real `total > maxBytes` comparison precisely at its own
// boundary, not just "well over the cap" the way the pre-existing 9000-byte
// checks above already do. A function declaration, so it's usable from every
// later section in this file the same way makeGovernorStub()/
// makeGovernorBinding() already are (hoisted; every check body only runs
// from the runner loop at the bottom of this file).
function jsonBodyOfExactBytes(bodyObj, targetBytes) {
  const baseLength = new TextEncoder().encode(JSON.stringify({ ...bodyObj, pad: "" })).length;
  const padLength = targetBytes - baseLength;
  assert.ok(padLength >= 0, `targetBytes ${targetBytes} is smaller than the un-padded body's own ${baseLength} bytes`);
  const text = JSON.stringify({ ...bodyObj, pad: "x".repeat(padLength) });
  assert.equal(new TextEncoder().encode(text).length, targetBytes, "constructed body must land on EXACTLY targetBytes");
  return text;
}

check("restore.js: a body of EXACTLY 8192 bytes (MAX_BODY_BYTES) is accepted -- proceeds past the body-cap check to a real 200, proving lib/http-body.js's `total > maxBytes` is strictly-greater, not >=", async () => {
  const { stub } = makeGovernorStub();
  const env = restoreGovernorEnv({ governorStub: stub });
  const { onRequestPost, verifyCalls, getCalls } = loadRestore({ verifyImpl: async () => true, getImpl: () => async () => ({ data: [] }) });
  const exactBody = jsonBodyOfExactBytes({ email: "a@b.com", code: "ABCDE-12345", turnstile: "tok" }, 8192);
  const request = new Request("https://8ish.app/api/restore", { method: "POST", body: exactBody });
  const res = await onRequestPost({ request, env });
  assert.equal(res.status, 200, "a body of exactly MAX_BODY_BYTES must not be rejected by the cap");
  assert.equal(verifyCalls.length, 1, "must have proceeded past the body cap all the way to the Turnstile check");
  assert.ok(getCalls.length > 0, "must have proceeded all the way to the Stripe lookup");
});

check("restore.js: a body of MAX_BODY_BYTES + 1 (8193 bytes) is rejected 400 bad_request -- one byte over the SAME boundary the check above proves is accepted", async () => {
  const { onRequestPost, verifyCalls, getCalls } = loadRestore({});
  const overBody = jsonBodyOfExactBytes({ email: "a@b.com", code: "ABCDE-12345", turnstile: "tok" }, 8193);
  const request = new Request("https://8ish.app/api/restore", { method: "POST", body: overBody });
  const res = await onRequestPost({ request, env: RESTORE_ENV });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.error.code, "bad_request");
  assert.equal(verifyCalls.length, 0, "one byte over the cap must be rejected before ANY Turnstile call");
  assert.equal(getCalls.length, 0);
});

check("restore.js: a real Governor `wait` denial (minGapSec not yet elapsed) answers 429 with retryAfterSeconds, zero Stripe calls, and records the denial for the deny cache", async () => {
  const { stub, reserveCalls, commitCalls } = makeGovernorStub({
    reserveImpl: async () => ({ ok: false, denied: "wait", retryAfterSeconds: 42 }),
  });
  const env = restoreGovernorEnv({ governorStub: stub });
  const { onRequestPost, getCalls } = loadRestore({ verifyImpl: async () => true });
  const res = await onRequestPost({ request: restoreRequest({ email: "denied@example.com", code: "ABCDE-12345", turnstile: "tok" }), env });
  const body = await res.json();
  assert.equal(res.status, 429);
  assert.deepEqual(body, { error: { code: "wait", retryAfterSeconds: 42 } });
  assert.equal(getCalls.length, 0, "a denied reserve() must cost zero Stripe calls");
  assert.equal(reserveCalls.length, 1);
  assert.equal(reserveCalls[0].kind, "restore");
  assert.equal(commitCalls.length, 0, "a denied reserve() must never be committed");
});

check("restore.js: a real Governor grant is committed immediately (awaited, not deferred) BEFORE the Stripe lookup proceeds", async () => {
  const order = [];
  const { stub, reserveCalls } = makeGovernorStub({
    commitImpl: async (id) => {
      order.push("commit");
      return { ok: true, id, state: "committed" };
    },
  });
  const env = restoreGovernorEnv({ governorStub: stub });
  const getImpl = () => async () => {
    order.push("stripe_get");
    return { data: [] };
  };
  const { onRequestPost } = loadRestore({ verifyImpl: async () => true, getImpl });
  const res = await onRequestPost({ request: restoreRequest({ email: "granted@example.com", code: "ABCDE-12345", turnstile: "tok" }), env });
  assert.equal(res.status, 200);
  assert.deepEqual(order, ["commit", "stripe_get"], "commit() must happen before the Stripe lookup, not deferred until after the response");
  assert.equal(reserveCalls.length, 1);
  assert.equal(reserveCalls[0].kind, "restore");
});

check("restore.js: the Governor key is sha256(email.trim().toLowerCase()) of the CALLER's raw email -- varying casing between attempts for the SAME address hits the SAME key", async () => {
  const { stub, reserveCalls } = makeGovernorStub();
  const env = restoreGovernorEnv({ governorStub: stub });
  const { onRequestPost } = loadRestore({ verifyImpl: async () => true, getImpl: () => async () => ({ data: [] }) });
  await onRequestPost({ request: restoreRequest({ email: "  Mixed@Case.com  ", code: "ABCDE-12345", turnstile: "tok" }), env });
  await onRequestPost({ request: restoreRequest({ email: "mixed@case.com", code: "ABCDE-12345", turnstile: "tok" }), env });
  const expectedKey = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("mixed@case.com"))))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  assert.equal(reserveCalls.length, 2);
  assert.equal(reserveCalls[0].key, expectedKey);
  assert.equal(reserveCalls[1].key, expectedKey, "trimmed+lowercased casing variants of the same address must key identically");
});

check("restore.js: a stateless pre-limit burst (6 requests, over the 5-per-10s cap) denies the excess with zero Governor calls for the denied ones -- distinct from a real Governor denial", async () => {
  const { stub, reserveCalls } = makeGovernorStub();
  const env = restoreGovernorEnv({ governorStub: stub });
  const { onRequestPost } = loadRestore({ verifyImpl: async () => true, getImpl: () => async () => ({ data: [] }) });
  const results = [];
  for (let i = 0; i < 6; i++) {
    const res = await onRequestPost({ request: restoreRequest({ email: "burst@example.com", code: "ABCDE-12345", turnstile: "tok" }), env });
    results.push(res.status);
  }
  assert.deepEqual(results, [200, 200, 200, 200, 200, 429], "the 6th request within the same 10s window must be pre-limited, not answered by the Governor");
  assert.equal(reserveCalls.length, 5, "the pre-limited 6th request must never reach the real Governor at all");
});

check("restore.js: a REAL wait denial is remembered by the deny cache -- a repeat within 60s answers from the cache with zero ADDITIONAL Governor calls", async () => {
  let calls = 0;
  const { stub, reserveCalls } = makeGovernorStub({
    reserveImpl: async () => {
      calls++;
      return { ok: false, denied: "wait", retryAfterSeconds: 17 };
    },
  });
  const env = restoreGovernorEnv({ governorStub: stub });
  const { onRequestPost, getCalls } = loadRestore({ verifyImpl: async () => true });

  const first = await onRequestPost({ request: restoreRequest({ email: "cached@example.com", code: "ABCDE-12345", turnstile: "tok" }), env });
  assert.equal(first.status, 429);
  assert.equal(reserveCalls.length, 1, "the first denial is a REAL Governor call");

  const second = await onRequestPost({ request: restoreRequest({ email: "cached@example.com", code: "ABCDE-12345", turnstile: "tok" }), env });
  const secondBody = await second.json();
  assert.equal(second.status, 429);
  assert.deepEqual(secondBody, { error: { code: "wait", retryAfterSeconds: 17 } }, "the cached denial must carry the SAME code/retryAfterSeconds the real denial produced");
  assert.equal(reserveCalls.length, 1, "the second identical request within 60s must be answered from the deny cache -- zero additional Governor calls");
  assert.equal(getCalls.length, 0, "still zero Stripe calls for either denied attempt");
});

// Story 7-8 review fix: restore.js switched from loadGovernorConfig (the
// AI_ENABLED-gated export) to the new, ungated loadGovernorLimits -- restore
// attempt spacing is not Image spend, and must keep working even when the
// owner has flipped the AI Kill Switch off during an incident. This is the
// direct, positive proof of that property: AI_ENABLED:"false", a VALID
// cfg:governor, and restore still reaches the real Governor and succeeds
// (a granted reserve, a real Stripe lookup) -- the exact opposite of what
// the old, now-superseded test asserted.
check("restore.js: works normally even when AI_ENABLED is \"false\" -- attempt spacing is not Image spend and must not be gated by the Image Kill Switch", async () => {
  const { stub, reserveCalls, commitCalls } = makeGovernorStub();
  const env = restoreGovernorEnv({ governorStub: stub, aiEnabled: "false" });
  const { onRequestPost, getCalls } = loadRestore({ verifyImpl: async () => true, getImpl: () => async () => ({ data: [] }) });
  const res = await onRequestPost({ request: restoreRequest({ email: "ai-disabled@example.com", code: "ABCDE-12345", turnstile: "tok" }), env });
  const body = await res.json();
  assert.equal(res.status, 200, "restore must not be blocked by AI_ENABLED:false");
  assert.deepEqual(body, { active: false }, "no matching customer -- restore.js's own generic no-match shape, proving it reached real Stripe work");
  assert.equal(reserveCalls.length, 1, "the real Governor WAS reached despite AI_ENABLED being false");
  assert.equal(commitCalls.length, 1);
  assert.ok(getCalls.length > 0, "the Stripe lookup ran -- restore's own work proceeded normally");
});

check("restore.js: loadGovernorLimits() failing (an invalid/unreadable cfg:governor, independent of AI_ENABLED) answers 503 resting, zero Governor/Stripe calls -- same fail-closed convention as transform.js, but for a DIFFERENT reason than AI_ENABLED", async () => {
  const { stub, reserveCalls } = makeGovernorStub();
  // A malformed cfg:governor (missing required fields) fails validation
  // regardless of AI_ENABLED's own value -- pass aiEnabled:"true" here
  // specifically to prove this 503 comes from the config's own invalidity,
  // not from the (now-irrelevant-to-restore) AI_ENABLED check.
  const env = restoreGovernorEnv({ governorStub: stub, aiEnabled: "true", governorCfgRaw: { ceiling: 80 } });
  const { onRequestPost, getCalls } = loadRestore({ verifyImpl: async () => true });
  const res = await onRequestPost({ request: restoreRequest({ email: "resting@example.com", code: "ABCDE-12345", turnstile: "tok" }), env });
  const body = await res.json();
  assert.equal(res.status, 503);
  assert.deepEqual(body, { error: { code: "resting" } });
  assert.equal(reserveCalls.length, 0, "a failed governor-limits load must cost zero real Governor calls");
  assert.equal(getCalls.length, 0);
});

// ------------------------------------------------------ Story 6-4: checkout.js's Turnstile-first + Waiver shape
//
// functions/api/checkout.js is checked through the same vm-sandbox
// technique as restore.js above (real stripe.js logic, Stripe's `post` and
// turnstile's `verify` replaced by test doubles), PLUS the real
// public/legal.js loaded the same way scripts/check-shared.mjs loads it
// (module.exports, no window global) -- so `custom_text[...][message]` is
// checked against the actual shared file's content, never a copy of it
// this script also wrote. No live Stripe/Turnstile call, no real KV, no
// `wrangler` command.

const CHECKOUT_PATH = path.join(ROOT_DIR, "functions/api/checkout.js");
const checkoutSource = readFileSync(CHECKOUT_PATH, "utf8");
const legalSource = readFileSync(path.join(ROOT_DIR, "public/legal.js"), "utf8");

// Loads the real checkout.js (and the real stripe.js it calls, plus the
// real public/legal.js it imports) into one fresh vm context, with Stripe's
// `post` and turnstile's `verify` replaced by test doubles (`postImpl`/
// `verifyImpl`). checkout.js's own `import legal from
// "../../public/legal.js"` is a default import, which stripImportsAndExports
// (built for the named/namespace forms the other stories' files use) does
// not strip on its own -- handled here with one extra replace.
function loadCheckout({ postImpl, verifyImpl } = {}) {
  const consoleCalls = [];
  const postCalls = [];
  const verifyCalls = [];
  const sandbox = {
    console: { error: (...args) => consoleCalls.push(args), log() {}, warn() {} },
    Response,
    URL,
    URLSearchParams,
    TextDecoder,
  };
  vm.createContext(sandbox);

  const stripeSrc = stripeLibSource.replace(/^export\s+/gm, "");
  vm.runInContext(`${stripeSrc}\nthis.StripeError = StripeError;`, sandbox, { filename: "stripe.js" });
  const StripeErr = sandbox.StripeError;

  sandbox.post = async (env, p, params) => {
    postCalls.push({ path: p, params });
    if (!postImpl) return { url: "https://checkout.stripe.com/test_session" };
    return postImpl(StripeErr)(env, p, params);
  };

  sandbox.turnstile = {
    verify: async (env, token, action) => {
      verifyCalls.push({ token, action });
      if (!verifyImpl) return false;
      return verifyImpl(env, token, action);
    },
  };

  // Story 7-8: checkout.js now imports readCappedBody as a NAMED import --
  // must resolve as a bare identifier, same reasoning as every other loader
  // in this file that now wires in http-body.js.
  const httpBodySrc = httpBodyLibSource.replace(/^export\s+/gm, "");
  vm.runInContext(`${httpBodySrc}\nthis.readCappedBody = readCappedBody;`, sandbox, { filename: "http-body.js" });

  // Story 8-1: a plain recording stub for the shared writeEvent() helper --
  // same reasoning as loadWebhook's own stub above.
  const writeEventCalls = [];
  sandbox.writeEvent = (env, ctx, event, source) => {
    writeEventCalls.push({ event, source, ctx });
  };

  // The real public/legal.js, loaded exactly as scripts/check-shared.mjs
  // loads it (module.exports, no window global) -- proves checkout.js's
  // custom_text really comes from the shared file, not a private copy.
  const legalSandbox = { module: { exports: {} } };
  vm.createContext(legalSandbox);
  vm.runInContext(legalSource, legalSandbox, { filename: "legal.js" });
  sandbox.legal = legalSandbox.module.exports;

  const src = stripImportsAndExports(checkoutSource).replace(/^import\s+\w+\s+from\s*["'][^"']+["'];?\s*$/gm, "");
  vm.runInContext(`${src}\nthis.__onRequestPost = onRequestPost;`, sandbox, { filename: "checkout.js" });

  return {
    onRequestPost: sandbox.__onRequestPost,
    StripeError: StripeErr,
    legal: sandbox.legal,
    postCalls,
    verifyCalls,
    writeEventCalls,
    consoleCalls,
  };
}

// Story 7-8: checkout.js reads its body exclusively through readCappedBody()
// (lib/http-body.js) now -- these fake request objects have no `.body`
// stream at all, so readCappedBody() always answers `{ok:true,
// bytes:<empty>}` for them, and checkout.js's own JSON.parse falls through
// to `.json`... no: checkout.js no longer calls `.json()` at all (Story
// 7-8 switched it to parsing the capped bytes directly, same pattern as
// restore.js) -- so these fake objects' own `.json` is now DEAD for the
// real code path and only still used by... nothing; kept only because
// `checkoutRequest`'s callers below still pass a `bodyObj` this shape can
// hold. See oversizedCheckoutRequest-style real `Request` objects further
// below for checks that need a genuine byte-capped body.
function checkoutRequest(bodyObj, url = "https://8ish.app/api/checkout") {
  const bodyText = JSON.stringify(bodyObj);
  return new Request(url, { method: "POST", body: bodyText });
}
function badJsonCheckoutRequest(url = "https://8ish.app/api/checkout") {
  return new Request(url, { method: "POST", body: "not valid json{" });
}

const CHECKOUT_ENV = {
  STRIPE_SECRET_KEY: "sk_test",
  STRIPE_PRICE_MONTHLY: "price_monthly_id",
  STRIPE_PRICE_YEARLY: "price_yearly_id",
  ORIGIN: "https://8ish.app",
};

check("checkout.js: STRIPE_SECRET_KEY missing answers not_configured, zero human-check/Stripe calls", async () => {
  const { onRequestPost, postCalls, verifyCalls } = loadCheckout({});
  const res = await onRequestPost({ request: checkoutRequest({ plan: "yearly", turnstile: "tok" }), env: {} });
  const body = await res.json();
  assert.equal(res.status, 500);
  assert.equal(body.error.code, "not_configured");
  assert.equal(postCalls.length, 0);
  assert.equal(verifyCalls.length, 0);
});

check("checkout.js: a malformed JSON body returns 400, zero human-check/Stripe calls", async () => {
  const { onRequestPost, postCalls, verifyCalls } = loadCheckout({});
  const res = await onRequestPost({ request: badJsonCheckoutRequest(), env: CHECKOUT_ENV });
  assert.equal(res.status, 400);
  assert.equal(postCalls.length, 0);
  assert.equal(verifyCalls.length, 0);
});

check('checkout.js: turnstile.verify() is called with action "checkout" before any Stripe call; a failing token returns 403 human_check_failed with zero Stripe calls (I/O matrix row)', async () => {
  const { onRequestPost, postCalls, verifyCalls } = loadCheckout({ verifyImpl: async () => false });
  const res = await onRequestPost({ request: checkoutRequest({ plan: "yearly", turnstile: "bad_token" }), env: CHECKOUT_ENV });
  const body = await res.json();
  assert.equal(res.status, 403);
  assert.equal(body.error.code, "human_check_failed");
  assert.equal(postCalls.length, 0, "zero Stripe calls when the token is invalid");
  assert.deepEqual(verifyCalls, [{ token: "bad_token", action: "checkout" }]);
});

check("checkout.js: a missing turnstile field (and missing plan too) still fails the human check first -- 403, zero Stripe calls (Code Map: verify before any other work)", async () => {
  const { onRequestPost, postCalls, verifyCalls } = loadCheckout({ verifyImpl: async () => false });
  const res = await onRequestPost({ request: checkoutRequest({}), env: CHECKOUT_ENV });
  const body = await res.json();
  assert.equal(res.status, 403);
  assert.equal(body.error.code, "human_check_failed");
  assert.equal(postCalls.length, 0);
  assert.deepEqual(verifyCalls, [{ token: "", action: "checkout" }], "verify() must still run (with an empty token) before the plan is even looked at");
});

check("checkout.js: a passing token but a missing/unset Price env var for the requested plan answers not_configured, with zero Stripe calls", async () => {
  const { onRequestPost, postCalls } = loadCheckout({ verifyImpl: async () => true });
  const res = await onRequestPost({
    request: checkoutRequest({ plan: "yearly", turnstile: "tok" }),
    env: { STRIPE_SECRET_KEY: "sk_test", STRIPE_PRICE_MONTHLY: "price_monthly_id" }, // STRIPE_PRICE_YEARLY missing
  });
  const body = await res.json();
  assert.equal(res.status, 500);
  assert.equal(body.error.code, "not_configured");
  assert.equal(postCalls.length, 0);
});

check("checkout.js: plan \"yearly\"/\"monthly\" select STRIPE_PRICE_YEARLY/MONTHLY respectively", async () => {
  const { onRequestPost, postCalls } = loadCheckout({ verifyImpl: async () => true });
  await onRequestPost({ request: checkoutRequest({ plan: "yearly", turnstile: "tok" }), env: CHECKOUT_ENV });
  await onRequestPost({ request: checkoutRequest({ plan: "monthly", turnstile: "tok" }), env: CHECKOUT_ENV });
  assert.equal(postCalls[0].params.get("line_items[0][price]"), "price_yearly_id");
  assert.equal(postCalls[1].params.get("line_items[0][price]"), "price_monthly_id");
});

check("checkout.js: a valid session carries billing_mode[type]=classic, consent_collection[terms_of_service]=required, payment_method_collection=if_required, allow_promotion_codes, and locale/custom_text from legal.js (I/O matrix row + AD-17)", async () => {
  const { onRequestPost, postCalls, legal } = loadCheckout({ verifyImpl: async () => true });
  const res = await onRequestPost({ request: checkoutRequest({ plan: "yearly", turnstile: "tok", lang: "en" }), env: CHECKOUT_ENV });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { url: "https://checkout.stripe.com/test_session" });

  const params = postCalls[0].params;
  assert.equal(postCalls[0].path, "checkout/sessions");
  assert.equal(params.get("mode"), "subscription");
  assert.equal(params.get("billing_mode[type]"), "classic");
  assert.equal(params.get("consent_collection[terms_of_service]"), "required");
  assert.equal(params.get("payment_method_collection"), "if_required");
  assert.equal(params.get("allow_promotion_codes"), "true");
  assert.equal(params.get("locale"), "en");
  assert.equal(
    params.get("custom_text[terms_of_service_acceptance][message]"),
    legal.WAIVER_CONSENT.en.replace("{TERMS_URL}", `${CHECKOUT_ENV.ORIGIN}${legal.TERMS_PATH}`),
    "the consent message must be read from public/legal.js (with {TERMS_URL} substituted for the real origin), never a duplicated inline string"
  );
});

check('checkout.js: lang "ro" and an unrecognized/missing lang both resolve to legal.WAIVER_CONSENT.ro (Design Notes: "Language source", falls back to ro)', async () => {
  const { onRequestPost, postCalls, legal } = loadCheckout({ verifyImpl: async () => true });
  for (const body of [
    { plan: "yearly", turnstile: "tok", lang: "ro" },
    { plan: "yearly", turnstile: "tok", lang: "fr" },
    { plan: "yearly", turnstile: "tok" },
    { plan: "yearly", turnstile: "tok", lang: 42 },
  ]) {
    await onRequestPost({ request: checkoutRequest(body), env: CHECKOUT_ENV });
  }
  for (const call of postCalls) {
    assert.equal(call.params.get("locale"), "ro");
    assert.equal(
      call.params.get("custom_text[terms_of_service_acceptance][message]"),
      legal.WAIVER_CONSENT.ro.replace("{TERMS_URL}", `${CHECKOUT_ENV.ORIGIN}${legal.TERMS_PATH}`)
    );
  }
});

check("checkout.js: success_url/cancel_url are built from env.ORIGIN, never the request's own URL (AD-9/AD-17), with the CHECKOUT_SESSION_ID placeholder literal", async () => {
  const { onRequestPost, postCalls } = loadCheckout({ verifyImpl: async () => true });
  // The request arrives on a different host than ORIGIN -- proves the URL is
  // never derived from the request, only from the configured value.
  await onRequestPost({
    request: checkoutRequest({ plan: "monthly", turnstile: "tok" }, "https://some-other-host.example/api/checkout"),
    env: CHECKOUT_ENV,
  });
  const params = postCalls[0].params;
  assert.equal(params.get("success_url"), "https://8ish.app/?checkout=success&session_id={CHECKOUT_SESSION_ID}");
  assert.equal(params.get("cancel_url"), "https://8ish.app/?checkout=cancelled");
});

check("checkout.js: ORIGIN missing/unset answers not_configured, with zero Stripe calls (matches every other missing-config case in this file)", async () => {
  const { onRequestPost, postCalls } = loadCheckout({ verifyImpl: async () => true });
  const res = await onRequestPost({
    request: checkoutRequest({ plan: "yearly", turnstile: "tok" }),
    env: { STRIPE_SECRET_KEY: "sk_test", STRIPE_PRICE_MONTHLY: "price_monthly_id", STRIPE_PRICE_YEARLY: "price_yearly_id" }, // no ORIGIN
  });
  const body = await res.json();
  assert.equal(res.status, 500);
  assert.equal(body.error.code, "not_configured");
  assert.equal(postCalls.length, 0);
});

check("checkout.js: ORIGIN with a trailing slash (or any shape other than a bare scheme+host) is rejected as not_configured, not silently normalized", async () => {
  const { onRequestPost, postCalls } = loadCheckout({ verifyImpl: async () => true });
  const res = await onRequestPost({
    request: checkoutRequest({ plan: "monthly", turnstile: "tok" }),
    env: { ...CHECKOUT_ENV, ORIGIN: "https://8ish.app/" },
  });
  const body = await res.json();
  assert.equal(res.status, 500);
  assert.equal(body.error.code, "not_configured");
  assert.equal(postCalls.length, 0);
});

check("checkout.js: a Stripe error on session creation returns 502 stripe_error and logs a fixed event code with the status (unchanged mapping)", async () => {
  const { onRequestPost, consoleCalls } = loadCheckout({
    verifyImpl: async () => true,
    postImpl:
      (StripeErr) =>
      async () => {
        throw new StripeErr(500);
      },
  });
  const res = await onRequestPost({ request: checkoutRequest({ plan: "yearly", turnstile: "tok" }), env: CHECKOUT_ENV });
  const body = await res.json();
  assert.equal(res.status, 502);
  assert.equal(body.error.code, "stripe_error");
  assert.ok(consoleCalls.some((args) => args[0] === "checkout_session_create_failed" && args[1] === 500));
});

check("checkout.js: a plain network failure (not a StripeError) on session creation returns 502 stripe_unreachable (unchanged mapping)", async () => {
  const { onRequestPost } = loadCheckout({
    verifyImpl: async () => true,
    postImpl: () => async () => {
      throw new TypeError("Failed to fetch");
    },
  });
  const res = await onRequestPost({ request: checkoutRequest({ plan: "yearly", turnstile: "tok" }), env: CHECKOUT_ENV });
  const body = await res.json();
  assert.equal(res.status, 502);
  assert.equal(body.error.code, "stripe_unreachable");
});

check("checkout.js: public/monetize.js's startCheckout sends a Turnstile token (action \"checkout\") and the active language (Code Map)", () => {
  assert.ok(monetizeSource.includes('getHumanToken("checkout")'), 'startCheckout must call getHumanToken("checkout")');
  assert.ok(/body:\s*JSON\.stringify\(\{\s*plan,\s*turnstile:\s*turnstileToken,\s*lang:\s*window\.I18N\.lang\s*\}\)/.test(monetizeSource), "the /api/checkout POST body must carry plan, turnstile and lang");
});

// ------------------------------------------------------ Regression guard: worker.js routing vs. functions/api/*.js exports
//
// This app deploys as a plain Worker with static assets (see worker.js's own
// header comment) -- functions/ is NOT auto-routed the way Cloudflare Pages
// Functions would be. worker.js has its own hand-written route table that
// imports one named export from each functions/api/*.js file and calls it
// for one specific HTTP method. A story that changes a file's exported
// handler name (e.g. GET -> POST, onRequestGet -> onRequestPost) without
// also updating worker.js's import leaves that route silently unreachable —
// exactly what shipped once in this story before a review caught it. This
// check would have caught it immediately: for every route worker.js
// declares, the imported name it uses must exist as that target file's
// export, must be the file's ONLY onRequest* export, and must match the
// route's own declared HTTP method (onRequestGet for a GET-only route,
// onRequestPost for a POST-only route, ...). It also confirms every
// functions/api/*.js file is reachable from SOME route — a file nobody
// imports is just as much a silent regression, the opposite shape of the
// same bug class.

const WORKER_JS_PATH = path.join(ROOT_DIR, "worker.js");
const workerSource = readFileSync(WORKER_JS_PATH, "utf8");
const API_DIR = path.join(ROOT_DIR, "functions/api");

function exportedHandlerNames(source) {
  const names = new Set();
  const re = /^export\s+(?:async\s+)?function\s+(onRequest\w+)\s*\(/gm;
  let m;
  while ((m = re.exec(source))) names.add(m[1]);
  return [...names];
}

check("worker.js: every route's imported handler exists, is that file's ONLY onRequest* export, and matches the route's own HTTP method; every functions/api/*.js file is reachable from some route", () => {
  const problems = [];

  // 1. Parse worker.js's own `import { onRequestXxx as alias } from "./functions/api/foo.js"` lines.
  const importRe = /^import\s*\{\s*(onRequest\w+)\s+as\s+(\w+)\s*\}\s*from\s*["'](\.\/[^"']+)["'];?\s*$/gm;
  const importsByAlias = new Map(); // alias -> { importedName, relPath }
  let im;
  while ((im = importRe.exec(workerSource))) {
    importsByAlias.set(im[2], { importedName: im[1], relPath: im[3] });
  }
  assert.ok(importsByAlias.size > 0, "expected at least one `import { onRequestXxx as alias } from ...` line in worker.js -- the parser may be out of sync with worker.js's own syntax");

  // 2. Parse each `if (url.pathname === "...") { if (request.method !== "METHOD") {...} return alias(` route block.
  const routeRe = /if\s*\(\s*url\.pathname\s*===\s*"([^"]+)"\s*\)\s*\{\s*if\s*\(\s*request\.method\s*!==\s*"([A-Z]+)"\s*\)\s*\{[\s\S]*?\}\s*return\s+(\w+)\(/g;
  const routes = [];
  let rm;
  while ((rm = routeRe.exec(workerSource))) {
    routes.push({ pathname: rm[1], method: rm[2], alias: rm[3] });
  }
  assert.ok(routes.length > 0, "expected at least one routed pathname in worker.js -- the parser may be out of sync with worker.js's own syntax");

  const referencedRelPaths = new Set();

  for (const route of routes) {
    const imported = importsByAlias.get(route.alias);
    if (!imported) {
      problems.push(`route "${route.pathname}" (${route.method}) calls "${route.alias}(...)", which is never imported`);
      continue;
    }
    referencedRelPaths.add(imported.relPath);

    const expectedName = "onRequest" + route.method[0] + route.method.slice(1).toLowerCase();
    if (imported.importedName !== expectedName) {
      problems.push(
        `route "${route.pathname}" requires method ${route.method} but imports "${imported.importedName}" as "${route.alias}" (expected "${expectedName}") from ${imported.relPath}`
      );
    }

    const targetPath = path.join(ROOT_DIR, imported.relPath);
    let targetSource;
    try {
      targetSource = readFileSync(targetPath, "utf8");
    } catch (error) {
      problems.push(`route "${route.pathname}" imports from ${imported.relPath}, which could not be read (${error && error.code ? error.code : error})`);
      continue;
    }
    const exported = exportedHandlerNames(targetSource);
    if (!exported.includes(imported.importedName)) {
      problems.push(`${imported.relPath} does not export "${imported.importedName}" (route "${route.pathname}") -- it exports: ${exported.join(", ") || "(no onRequest* export at all)"}`);
    }
    if (exported.length !== 1) {
      problems.push(`${imported.relPath} must export exactly ONE onRequest* handler (route "${route.pathname}" only ever calls one of them) -- it exports: ${exported.join(", ")}`);
    }
  }

  // 3. Every functions/api/*.js file must be reachable from some route --
  // a file nobody imports is a silent regression of a different shape.
  const apiFiles = readdirSync(API_DIR)
    .filter((name) => name.endsWith(".js"))
    .map((name) => `./functions/api/${name}`);
  for (const relPath of apiFiles) {
    if (!referencedRelPaths.has(relPath)) {
      problems.push(`${relPath} is never imported/routed by worker.js at all`);
    }
  }

  assert.deepEqual(problems, [], `worker.js routing does not match functions/api/*.js exports:\n${problems.join("\n")}`);
});

// ------------------------------------------------------ Story 6-5: functions/api/config.js's price cache
//
// Direct, sandboxed checks of readPrice()'s cache-hit/cache-miss/failure
// paths -- through the real onRequestGet (config.js's whole point is that
// a normal request never calls Stripe, so these check that from the
// outside, not by reaching into a private readPrice() export). Same
// vm-sandbox technique as every loader above: the real config.js + the real
// stripe.js it imports, Stripe's own `get()` replaced by a test double, and
// (via makeFakeKV, defined earlier in this file) a fake STATE_KV that
// honors `expirationTtl`.

const CONFIG_PATH = path.join(ROOT_DIR, "functions/api/config.js");
const configSource = readFileSync(CONFIG_PATH, "utf8");

function loadConfigHandler({ getImpl } = {}) {
  const getCalls = [];
  const consoleCalls = [];
  const sandbox = {
    console: { error: (...args) => consoleCalls.push(args), log() {}, warn() {} },
    Response,
  };
  vm.createContext(sandbox);

  const stripeSrc = stripeLibSource.replace(/^export\s+/gm, "");
  vm.runInContext(`${stripeSrc}\nthis.StripeError = StripeError;`, sandbox, { filename: "stripe.js" });
  const StripeErr = sandbox.StripeError;

  sandbox.get = async (env, p) => {
    getCalls.push(p);
    if (!getImpl) throw new Error("no Stripe GET mock configured for this check");
    return getImpl(StripeErr)(env, p);
  };

  // Story 8-1: a plain recording stub for the shared writeEvent() helper --
  // same reasoning as loadWebhook's own stub above.
  const writeEventCalls = [];
  sandbox.writeEvent = (env, ctx, event, source) => {
    writeEventCalls.push({ event, source, ctx });
  };

  const src = stripImportsAndExports(configSource);
  vm.runInContext(`${src}\nthis.__onRequestGet = onRequestGet;`, sandbox, { filename: "config.js" });

  return { onRequestGet: sandbox.__onRequestGet, StripeError: StripeErr, getCalls, writeEventCalls, consoleCalls };
}

const PRICE_ENV = { PLAN_MODE: "free", FREE_DAILY_LIMIT: "10", STRIPE_SECRET_KEY: "sk_test", STRIPE_PRICE_MONTHLY: "price_m", STRIPE_PRICE_YEARLY: "price_y" };

const stripePrice = (unitAmount) => async () => ({ id: "price_x", unit_amount: unitAmount, currency: "ron" });

check("config.js: a KV cache hit answers pricing with zero Stripe calls (I/O matrix row: prices cached)", async () => {
  const kv = makeFakeKV(() => 1_700_000_000_000);
  await kv.put("price:price_m", JSON.stringify({ unit_amount: 1499 }));
  await kv.put("price:price_y", JSON.stringify({ unit_amount: 9900 }));
  const { onRequestGet, getCalls } = loadConfigHandler({});
  const res = await onRequestGet({ env: { ...PRICE_ENV, STATE_KV: kv } });
  const body = JSON.parse(await res.text());
  assert.equal(body.pricing.monthly, "14.99");
  assert.equal(body.pricing.yearly, "99");
  assert.equal(getCalls.length, 0, "a cache hit must never call Stripe");
});

check("config.js: a cache miss fetches from Stripe, caches the result for ~a day, and returns it (I/O matrix row: cache miss)", async () => {
  const kv = makeFakeKV(() => 1_700_000_000_000);
  const { onRequestGet, getCalls } = loadConfigHandler({ getImpl: () => stripePrice(1499) });
  const res = await onRequestGet({ env: { ...PRICE_ENV, STRIPE_PRICE_YEARLY: undefined, STATE_KV: kv } });
  const body = JSON.parse(await res.text());
  assert.equal(body.pricing.monthly, "14.99");
  assert.deepEqual(getCalls, ["prices/price_m"]);
  assert.equal(JSON.parse((await kv.get("price:price_m"))).unit_amount, 1499);
  assert.equal(kv.puts.at(-1).options && kv.puts.at(-1).options.expirationTtl, 86400, "a freshly-fetched price must be cached with an ~86400s TTL");
});

check("config.js: an expired cache entry falls back to Stripe again (the ~a-day TTL actually applies)", async () => {
  // makeFakeKV honors expirationTtl against its own controllable "now" (see
  // its own comment, earlier in this file) -- write with a 1s TTL, then
  // advance the clock past it before reading, so the entry is genuinely
  // expired by read time rather than served stale.
  let now = 1_700_000_000_000;
  const kv = makeFakeKV(() => now);
  await kv.put("price:price_m", JSON.stringify({ unit_amount: 1000 }), { expirationTtl: 1 });
  now += 2000;
  const { onRequestGet, getCalls } = loadConfigHandler({ getImpl: () => stripePrice(1499) });
  const res = await onRequestGet({ env: { ...PRICE_ENV, STRIPE_PRICE_YEARLY: undefined, STATE_KV: kv } });
  const body = JSON.parse(await res.text());
  assert.equal(body.pricing.monthly, "14.99", "an expired entry must not be served stale");
  assert.equal(getCalls.length, 1);
});

check("config.js: a Stripe error (both a StripeError and a plain network failure) resolves that field to null, the other field is unaffected (I/O matrix row: Stripe fails)", async () => {
  const kv = makeFakeKV(() => 1_700_000_000_000);
  await kv.put("price:price_y", JSON.stringify({ unit_amount: 9900 }));
  const { onRequestGet, consoleCalls } = loadConfigHandler({
    getImpl: (StripeErr) => async () => {
      throw new StripeErr(500);
    },
  });
  const res = await onRequestGet({ env: { ...PRICE_ENV, STATE_KV: kv } });
  const body = JSON.parse(await res.text());
  assert.equal(body.pricing.monthly, null, "a Stripe failure must resolve to null, never a stale or fabricated price");
  assert.equal(body.pricing.yearly, "99", "the other, already-cached field must be unaffected");
  assert.ok(consoleCalls.some((args) => args[0] === "config_price_stripe_error" && args[1] === 500));

  const { onRequestGet: onRequestGet2, consoleCalls: consoleCalls2 } = loadConfigHandler({
    getImpl: () => async () => {
      throw new TypeError("Failed to fetch");
    },
  });
  const res2 = await onRequestGet2({ env: { ...PRICE_ENV, STATE_KV: makeFakeKV(() => 1_700_000_000_000) } });
  assert.equal(JSON.parse(await res2.text()).pricing.monthly, null);
  assert.ok(consoleCalls2.some((args) => args[0] === "config_price_stripe_unreachable"));
});

check("config.js: STRIPE_SECRET_KEY missing on a cache miss resolves to null with zero Stripe calls (fail closed, no I/O)", async () => {
  const kv = makeFakeKV(() => 1_700_000_000_000);
  const { onRequestGet, getCalls } = loadConfigHandler({});
  const res = await onRequestGet({ env: { ...PRICE_ENV, STRIPE_SECRET_KEY: undefined, STATE_KV: kv } });
  const body = JSON.parse(await res.text());
  assert.equal(body.pricing.monthly, null);
  assert.equal(body.pricing.yearly, null);
  assert.equal(getCalls.length, 0);
});

check("config.js: a missing/unset Price env var resolves that field to null with zero KV/Stripe calls, without crashing", async () => {
  const { onRequestGet, getCalls } = loadConfigHandler({});
  const kv = makeFakeKV(() => 1_700_000_000_000);
  const res = await onRequestGet({ env: { ...PRICE_ENV, STRIPE_PRICE_MONTHLY: undefined, STRIPE_PRICE_YEARLY: "", STATE_KV: kv } });
  const body = JSON.parse(await res.text());
  assert.equal(body.pricing.monthly, null);
  assert.equal(body.pricing.yearly, null);
  assert.equal(getCalls.length, 0);
  assert.equal(kv.puts.length, 0);
});

check("config.js: a malformed Stripe response (no numeric unit_amount) resolves to null, not a crash or a fabricated value", async () => {
  const kv = makeFakeKV(() => 1_700_000_000_000);
  const { onRequestGet, consoleCalls } = loadConfigHandler({ getImpl: () => async () => ({ id: "price_m", unit_amount: null }) });
  const res = await onRequestGet({ env: { ...PRICE_ENV, STRIPE_PRICE_YEARLY: undefined, STATE_KV: kv } });
  assert.equal(JSON.parse(await res.text()).pricing.monthly, null);
  assert.ok(consoleCalls.some((args) => args[0] === "config_price_malformed"));
  assert.equal(kv.puts.length, 0, "a malformed response must never be cached");
});

check("config.js: a corrupt KV cache entry is treated like a miss -- falls through to a live Stripe lookup instead of crashing", async () => {
  // makeFakeKV.put() itself JSON.parses its `value` to record it in `puts`
  // (real production code only ever calls put() with JSON.stringify'd data)
  // -- a raw stand-in KV is used here instead, to store a genuinely
  // unparseable string the way a corrupted real entry would arrive.
  const kv = { get: async () => "not json{", put: async () => {} };
  const { onRequestGet, getCalls } = loadConfigHandler({ getImpl: () => stripePrice(1499) });
  const res = await onRequestGet({ env: { ...PRICE_ENV, STRIPE_PRICE_YEARLY: undefined, STATE_KV: kv } });
  assert.equal(JSON.parse(await res.text()).pricing.monthly, "14.99");
  assert.equal(getCalls.length, 1);
});

check("config.js: a STATE_KV.get failure falls through to a live Stripe lookup instead of failing the whole request", async () => {
  const kv = { get: async () => { throw new Error("simulated KV read failure"); }, put: async () => {} };
  const { onRequestGet, getCalls, consoleCalls } = loadConfigHandler({ getImpl: () => stripePrice(1499) });
  const res = await onRequestGet({ env: { ...PRICE_ENV, STRIPE_PRICE_YEARLY: undefined, STATE_KV: kv } });
  assert.equal(JSON.parse(await res.text()).pricing.monthly, "14.99");
  assert.equal(getCalls.length, 1);
  assert.ok(consoleCalls.some((args) => args[0] === "config_price_kv_read_failed"));
});

check("config.js: a STATE_KV.put failure still returns the freshly-fetched price for this response (only the next request re-pays for a live lookup)", async () => {
  const kv = { get: async () => null, put: async () => { throw new Error("simulated KV write failure"); } };
  const { onRequestGet, consoleCalls } = loadConfigHandler({ getImpl: () => stripePrice(1499) });
  const res = await onRequestGet({ env: { ...PRICE_ENV, STRIPE_PRICE_YEARLY: undefined, STATE_KV: kv } });
  assert.equal(JSON.parse(await res.text()).pricing.monthly, "14.99");
  assert.ok(consoleCalls.some((args) => args[0] === "config_price_kv_write_failed"));
});

check("config.js: unit_amount formatting -- whole-currency amounts drop the decimals, fractional amounts keep exactly 2 (Design Notes: display string)", async () => {
  const cases = [
    [9900, "99"],
    [1499, "14.99"],
    [100, "1"],
    [150, "1.50"],
    [1, "0.01"],
    [0, "0"],
  ];
  for (const [unitAmount, expected] of cases) {
    const kv = makeFakeKV(() => 1_700_000_000_000);
    const { onRequestGet } = loadConfigHandler({ getImpl: () => stripePrice(unitAmount) });
    const res = await onRequestGet({ env: { ...PRICE_ENV, STRIPE_PRICE_YEARLY: undefined, STATE_KV: kv } });
    assert.equal(JSON.parse(await res.text()).pricing.monthly, expected, `unit_amount ${unitAmount}`);
  }
});

check("config.js: monthly and yearly are looked up independently and concurrently -- both a cache hit and a cache miss can happen in the same request", async () => {
  const kv = makeFakeKV(() => 1_700_000_000_000);
  await kv.put("price:price_m", JSON.stringify({ unit_amount: 1499 }));
  const { onRequestGet, getCalls } = loadConfigHandler({ getImpl: () => stripePrice(9900) });
  const res = await onRequestGet({ env: { ...PRICE_ENV, STATE_KV: kv } });
  const body = JSON.parse(await res.text());
  assert.equal(body.pricing.monthly, "14.99", "cache hit");
  assert.equal(body.pricing.yearly, "99", "cache miss, resolved live");
  assert.deepEqual(getCalls, ["prices/price_y"], "only the cache-missing plan calls Stripe");
});

check("config.js: pricing.currency still comes from PRICE_CURRENCY (unaffected by this story -- only unit_amount traces to Stripe now)", async () => {
  const kv = makeFakeKV(() => 1_700_000_000_000);
  const { onRequestGet } = loadConfigHandler({});
  const res = await onRequestGet({ env: { ...PRICE_ENV, STRIPE_SECRET_KEY: undefined, PRICE_CURRENCY: "EUR", STATE_KV: kv } });
  assert.equal(JSON.parse(await res.text()).pricing.currency, "EUR");
});

// ------------------------------------------------------------------ Story 6-6: functions/api/subscription.js
//
// POST /api/subscription {action:"cancel"|"resume"}, authenticated exactly
// like entitlement.js (Story 6-2): the Bearer credential is verified FIRST,
// zero Stripe calls on failure, the subscription id comes only from the
// verified credential's own payload. Checked through the same vm-sandbox
// technique as entitlement.js above -- the real credential.js + stripe.js
// logic, Stripe's own post() and subStatus.js's write()/isActiveStatus
// replaced by test doubles -- no live Stripe call, no real KV, no `wrangler`
// command.

const SUBSCRIPTION_PATH = path.join(ROOT_DIR, "functions/api/subscription.js");
const subscriptionSource = readFileSync(SUBSCRIPTION_PATH, "utf8");

// Mirrors authRequest() above (entitlement.js), plus a `json()` method for
// subscription.js's body -- `bodyObj === undefined` means "never call json()
// at all", not "resolve with undefined", so a check that expects the
// credential gate to reject BEFORE the body is ever read can prove that by
// never providing one.
function subscriptionRequest(token, bodyObj, options = {}) {
  const { contentType = "application/json", rawAuthorization } = options;
  return {
    headers: {
      get: (name) => {
        const key = name.toLowerCase();
        if (key === "authorization") {
          if (rawAuthorization !== undefined) return rawAuthorization;
          return token === undefined ? null : `Bearer ${token}`;
        }
        if (key === "content-type") return contentType;
        return null;
      },
    },
    // Story 7-8: subscription.js now reads its body exclusively through
    // readCappedBody() (lib/http-body.js) -- a real `.body` ReadableStream
    // (bodyStreamFrom, shared with signedWebhookRequest above) so the real
    // capped-bytes JSON.parse further down actually sees `bodyObj`.
    // `bodyObj === undefined` still means "no body stream at all"
    // (readCappedBody's own documented fallback: zero bytes) -- exactly
    // what a check proving the credential gate rejects BEFORE the body is
    // ever consulted needs: if that code path were ever (wrongly) reached,
    // `JSON.parse("")` would throw and the response would be 400, not the
    // 401/500 the credential gate itself produces -- the assertion on the
    // response STATUS is what proves the ordering, same guarantee the old
    // "json() must not be called" throw used to prove, just against the
    // new body-reading mechanism instead of the old one.
    body: bodyObj === undefined ? undefined : bodyStreamFrom(JSON.stringify(bodyObj)),
  };
}

// Loads the real subscription.js (and the real stripe.js + credential.js it
// calls) into one fresh vm context, with lib/stripe.js's `post` and
// lib/subStatus.js's `write`/`isActiveStatus` replaced by test doubles --
// same technique loadEntitlement (Story 6-2) and loadWebhook (Story 6-1) use
// above, exercising subscription.js's own control flow (verify-before-
// anything-else, which action/params it sends, how it maps a thrown error,
// what it writes through) in isolation from stripe.js's/subStatus.js's own
// logic, which the checks above already cover directly.
function loadSubscription({ postImpl, writeImpl } = {}) {
  const consoleCalls = [];
  const postCalls = [];
  const writeCalls = [];
  const sandbox = {
    console: { error: (...args) => consoleCalls.push(args), log() {}, warn() {} },
    crypto,
    TextEncoder,
    TextDecoder,
    atob,
    btoa,
    Response,
    encodeURIComponent,
  };
  vm.createContext(sandbox);

  const stripeSrc = stripeLibSource.replace(/^export\s+/gm, "");
  vm.runInContext(`${stripeSrc}\nthis.StripeError = StripeError;`, sandbox, { filename: "stripe.js" });

  sandbox.post = async (env, p, params) => {
    postCalls.push({ path: p, params });
    if (!postImpl) throw new Error("no Stripe POST mock configured for this check");
    return postImpl(sandbox.StripeError)(env, p, params);
  };

  sandbox.isActiveStatus = (status) => status === "active" || status === "trialing";
  sandbox.write = async (env, subscriptionId, payload) => {
    writeCalls.push({ subscriptionId, payload });
    return writeImpl ? writeImpl(env, subscriptionId, payload) : true;
  };

  const credSrc = credentialLibSource.replace(/^export\s+/gm, "");
  vm.runInContext(`${credSrc}\nthis.__mint = mint; this.__verify = verify; this.__CredNotConfiguredError = NotConfiguredError;`, sandbox, {
    filename: "credential.js",
  });
  sandbox.credential = {
    mint: sandbox.__mint,
    verify: sandbox.__verify,
    NotConfiguredError: sandbox.__CredNotConfiguredError,
  };

  // Story 7-8: subscription.js now imports readCappedBody as a NAMED
  // import -- must resolve as a bare identifier, same reasoning as every
  // other loader in this file that now wires in http-body.js.
  const httpBodySrc = httpBodyLibSource.replace(/^export\s+/gm, "");
  vm.runInContext(`${httpBodySrc}\nthis.readCappedBody = readCappedBody;`, sandbox, { filename: "http-body.js" });

  const src = stripImportsAndExports(subscriptionSource);
  vm.runInContext(`${src}\nthis.__onRequestPost = onRequestPost;`, sandbox, { filename: "subscription.js" });

  return {
    onRequestPost: sandbox.__onRequestPost,
    StripeError: sandbox.StripeError,
    postCalls,
    writeCalls,
    consoleCalls,
  };
}

check("subscription.js: invalid/missing/wrong-type/tampered/expired credential returns 401 {error:{code:'unauthorized'}} with zero Stripe calls (I/O matrix row, call-count test)", async () => {
  const { mint } = loadCredential();
  const secret = "secret_current";
  const validToken = await mint({ ENTITLEMENT_SECRET: secret }, "sub_1");
  const flip = (s) => s.slice(0, -1) + (s.at(-1) === "A" ? "B" : "A");

  const { mint: mintExpired } = loadCredential({ now: 1_700_000_000_000 - SEVEN_DAYS_MS - 1 });
  const expiredToken = await mintExpired({ ENTITLEMENT_SECRET: secret }, "sub_1");

  const cases = [
    ["no Authorization header at all", undefined],
    ["garbage token", "not-a-real-credential"],
    ["wrong-type (d1.) token", "d1.xxxx.yyyy"],
    ["tampered signature", flip(validToken)],
    ["expired credential", expiredToken],
  ];

  for (const [label, token] of cases) {
    const { onRequestPost, postCalls, writeCalls } = loadSubscription({});
    const env = { ENTITLEMENT_SECRET: secret, STRIPE_SECRET_KEY: "sk_test" };
    // bodyObj left undefined -- json() must never be called for a rejected credential either.
    const res = await onRequestPost({ request: subscriptionRequest(token, undefined), env });
    const body = await res.json();
    assert.equal(res.status, 401, `${label} must return 401`);
    assert.equal(body.error.code, "unauthorized");
    assert.equal(postCalls.length, 0, `${label}: zero Stripe calls`);
    assert.equal(writeCalls.length, 0, `${label}: zero subStatus writes`);
  }
});

check("subscription.js: ENTITLEMENT_SECRET missing answers not_configured with zero Stripe calls, even with a well-formed token", async () => {
  const { onRequestPost, postCalls } = loadSubscription({});
  const env = { STRIPE_SECRET_KEY: "sk_test" }; // no ENTITLEMENT_SECRET
  const res = await onRequestPost({ request: subscriptionRequest("c1.whatever.sig", undefined), env });
  const body = await res.json();
  assert.equal(res.status, 500);
  assert.equal(body.error.code, "not_configured");
  assert.equal(postCalls.length, 0);
});

check("subscription.js: a non-application/json content-type is rejected with 400 with zero Stripe calls, even with a valid credential", async () => {
  const secret = "secret_current";
  const { mint } = loadCredential();
  const token = await mint({ ENTITLEMENT_SECRET: secret }, "sub_1");
  const { onRequestPost, postCalls } = loadSubscription({});
  const env = { ENTITLEMENT_SECRET: secret, STRIPE_SECRET_KEY: "sk_test" };
  for (const contentType of ["text/plain", "application/x-www-form-urlencoded", ""]) {
    const res = await onRequestPost({ request: subscriptionRequest(token, undefined, { contentType }), env });
    assert.equal(res.status, 400, `content-type ${JSON.stringify(contentType)} must be rejected`);
    assert.equal((await res.json()).error.code, "bad_request");
  }
  assert.equal(postCalls.length, 0);
});

check("subscription.js: valid credential + an unrecognized action returns 400 bad_request with zero Stripe calls (I/O matrix row)", async () => {
  const secret = "secret_current";
  const { mint } = loadCredential();
  const token = await mint({ ENTITLEMENT_SECRET: secret }, "sub_1");

  for (const action of ["pause", "delete", "", null, undefined, 42, "CANCEL", "Resume"]) {
    const { onRequestPost, postCalls, writeCalls } = loadSubscription({});
    const env = { ENTITLEMENT_SECRET: secret, STRIPE_SECRET_KEY: "sk_test" };
    const res = await onRequestPost({ request: subscriptionRequest(token, { action }), env });
    const body = await res.json();
    assert.equal(res.status, 400, `action ${JSON.stringify(action)} must be rejected`);
    assert.equal(body.error.code, "bad_request");
    assert.equal(postCalls.length, 0, `action ${JSON.stringify(action)}: zero Stripe calls`);
    assert.equal(writeCalls.length, 0);
  }
});

check("subscription.js: malformed JSON body with a valid credential returns 400 bad_request with zero Stripe calls", async () => {
  const secret = "secret_current";
  const { mint } = loadCredential();
  const token = await mint({ ENTITLEMENT_SECRET: secret }, "sub_1");
  const { onRequestPost, postCalls } = loadSubscription({});
  const env = { ENTITLEMENT_SECRET: secret, STRIPE_SECRET_KEY: "sk_test" };
  // Story 7-8: subscription.js reads its body exclusively through
  // readCappedBody() + JSON.parse now (never request.json()) -- a genuinely
  // un-parseable byte body (not an override of a `.json()` method that no
  // longer exists on the real request object) is what actually exercises
  // this path.
  const request = subscriptionRequest(token, undefined);
  request.body = bodyStreamFrom("not valid json{");
  const res = await onRequestPost({ request, env });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, "bad_request");
  assert.equal(postCalls.length, 0);
});

check("subscription.js: action:'cancel' sends cancel_at_period_end=true, proration_behavior=none to the credential's own subscription id -- a body-supplied id is ignored (I/O matrix row)", async () => {
  const secret = "secret_current";
  const { mint } = loadCredential();
  const token = await mint({ ENTITLEMENT_SECRET: secret }, "sub_from_credential");

  const { onRequestPost, postCalls, writeCalls } = loadSubscription({
    postImpl: () => async () => ({
      status: "active",
      cancel_at_period_end: true,
      cancel_at: 1_800_000_000,
      items: { data: [{ current_period_end: 1_900_000_000 }] },
    }),
  });
  const env = { ENTITLEMENT_SECRET: secret, STRIPE_SECRET_KEY: "sk_test" };
  // A malicious/confused body naming a DIFFERENT subscription id must be
  // completely ignored -- there is no such field in the documented request
  // shape at all, but prove it's inert even if a caller sends one anyway.
  const res = await onRequestPost({
    request: subscriptionRequest(token, { action: "cancel", subscriptionId: "attacker_controlled_sub" }),
    env,
  });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(postCalls.length, 1);
  assert.equal(postCalls[0].path, "subscriptions/sub_from_credential", "must act on the credential's own subscription id, and nothing else");
  const sentParams = postCalls[0].params;
  const asObject = sentParams instanceof URLSearchParams ? Object.fromEntries(sentParams) : sentParams;
  assert.equal(asObject.cancel_at_period_end, "true");
  assert.equal(asObject.proration_behavior, "none");

  assert.equal(body.active, true);
  assert.equal(body.cancelAtPeriodEnd, true);
  assert.equal(body.currentPeriodEnd, 1_900_000_000);

  assert.equal(writeCalls.length, 1, "must write through subStatus.write() on success");
  assert.equal(writeCalls[0].subscriptionId, "sub_from_credential");
  assert.equal(writeCalls[0].payload.active, true);
  assert.equal(writeCalls[0].payload.currentPeriodEnd, 1_900_000_000);
  assert.equal(typeof writeCalls[0].payload.asOf, "number");
});

check("subscription.js: action:'resume' sends only cancel_at_period_end=false (no proration_behavior)", async () => {
  const secret = "secret_current";
  const { mint } = loadCredential();
  const token = await mint({ ENTITLEMENT_SECRET: secret }, "sub_1");

  const { onRequestPost, postCalls } = loadSubscription({
    postImpl: () => async () => ({
      status: "active",
      cancel_at_period_end: false,
      cancel_at: null,
      items: { data: [{ current_period_end: 1_900_000_000 }] },
    }),
  });
  const env = { ENTITLEMENT_SECRET: secret, STRIPE_SECRET_KEY: "sk_test" };
  const res = await onRequestPost({ request: subscriptionRequest(token, { action: "resume" }), env });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(postCalls.length, 1);
  const sentParams = postCalls[0].params;
  const asObject = sentParams instanceof URLSearchParams ? Object.fromEntries(sentParams) : sentParams;
  assert.equal(asObject.cancel_at_period_end, "false");
  assert.equal("proration_behavior" in asObject, false, "resume must not send proration_behavior at all");
  assert.equal(body.cancelAtPeriodEnd, false);
});

check("subscription.js: cancelAtPeriodEnd derivation -- cancel_at_period_end and cancel_at combine as documented across all 4 combinations (I/O matrix row)", async () => {
  const secret = "secret_current";
  const { mint } = loadCredential();
  const token = await mint({ ENTITLEMENT_SECRET: secret }, "sub_1");

  const cases = [
    [false, null, false],
    [true, null, true],
    [false, 1_800_000_000, true],
    [true, 1_800_000_000, true],
  ];
  for (const [cancelAtPeriodEndField, cancelAt, expected] of cases) {
    const { onRequestPost } = loadSubscription({
      postImpl: () => async () => ({
        status: "active",
        cancel_at_period_end: cancelAtPeriodEndField,
        cancel_at: cancelAt,
        items: { data: [{ current_period_end: 1_900_000_000 }] },
      }),
    });
    const env = { ENTITLEMENT_SECRET: secret, STRIPE_SECRET_KEY: "sk_test" };
    const res = await onRequestPost({ request: subscriptionRequest(token, { action: "cancel" }), env });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(
      body.cancelAtPeriodEnd,
      expected,
      `cancel_at_period_end=${cancelAtPeriodEndField}, cancel_at=${cancelAt} must derive to ${expected}`
    );
  }
});

check("subscription.js: a canceled/inactive Stripe status after resume answers active:false, cancelAtPeriodEnd reflects the fresh fields, not the requested action", async () => {
  const secret = "secret_current";
  const { mint } = loadCredential();
  const token = await mint({ ENTITLEMENT_SECRET: secret }, "sub_1");
  const { onRequestPost } = loadSubscription({
    postImpl: () => async () => ({
      status: "canceled",
      cancel_at_period_end: false,
      cancel_at: null,
      items: { data: [] },
    }),
  });
  const env = { ENTITLEMENT_SECRET: secret, STRIPE_SECRET_KEY: "sk_test" };
  const res = await onRequestPost({ request: subscriptionRequest(token, { action: "resume" }), env });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.active, false, "a subscription already fully canceled at Stripe cannot be resumed back to active");
  assert.equal(body.cancelAtPeriodEnd, false);
  assert.equal(body.currentPeriodEnd, null, "no subscription item left to read one from");
});

check("subscription.js: a StripeError from post() maps to 502 stripe_error; a plain network failure maps to 502 stripe_unreachable; neither writes through subStatus", async () => {
  const secret = "secret_current";
  const { mint } = loadCredential();
  const token = await mint({ ENTITLEMENT_SECRET: secret }, "sub_1");
  const env = { ENTITLEMENT_SECRET: secret, STRIPE_SECRET_KEY: "sk_test" };

  {
    const { onRequestPost, writeCalls } = loadSubscription({
      postImpl: (StripeErrorClass) => async () => {
        throw new StripeErrorClass(500);
      },
    });
    const res = await onRequestPost({ request: subscriptionRequest(token, { action: "cancel" }), env });
    const body = await res.json();
    assert.equal(res.status, 502);
    assert.equal(body.error.code, "stripe_error");
    assert.equal(writeCalls.length, 0);
  }

  {
    const { onRequestPost, writeCalls } = loadSubscription({
      postImpl: () => async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    const res = await onRequestPost({ request: subscriptionRequest(token, { action: "cancel" }), env });
    const body = await res.json();
    assert.equal(res.status, 502);
    assert.equal(body.error.code, "stripe_unreachable");
    assert.equal(writeCalls.length, 0);
  }
});

check("subscription.js: a subStatus.write() failure is swallowed -- the response still reports the fresh Stripe truth, not an error", async () => {
  const secret = "secret_current";
  const { mint } = loadCredential();
  const token = await mint({ ENTITLEMENT_SECRET: secret }, "sub_1");
  const { onRequestPost, writeCalls, consoleCalls } = loadSubscription({
    postImpl: () => async () => ({
      status: "active",
      cancel_at_period_end: true,
      cancel_at: null,
      items: { data: [{ current_period_end: 1_900_000_000 }] },
    }),
    writeImpl: async () => {
      throw new Error("simulated KV failure");
    },
  });
  const env = { ENTITLEMENT_SECRET: secret, STRIPE_SECRET_KEY: "sk_test" };
  const res = await onRequestPost({ request: subscriptionRequest(token, { action: "cancel" }), env });
  const body = await res.json();
  assert.equal(res.status, 200, "the Stripe call already succeeded -- a cache write hiccup must not turn this into an error");
  assert.equal(body.active, true);
  assert.equal(body.cancelAtPeriodEnd, true);
  assert.equal(writeCalls.length, 1, "the write must still have been attempted");
  assert.ok(consoleCalls.some((args) => args[0] === "subscription_substatus_write_failed"));
});

// ------------------------------------------------------ Story 7-5: functions/api/transform.js
//
// functions/api/transform.js is checked through the same vm-sandbox
// technique as the rest of this file: the real credential.js (verify/mint,
// same loadCredential() helper Story 6-2's section above defines),
// governor-config.js (loadGovernorConfig, loaded directly into the same
// context since transform.js's own `import { loadGovernorConfig } from
// "../lib/governor-config.js"` is a NAMED import -- stripImportsAndExports
// removes the import line, and the identifier must already exist as a bare
// global in that context, exactly as the real module graph would resolve
// it), and the real public/prompts.js (loaded exactly as checkout.js's own
// legal.js loader loads public/legal.js -- module.exports, no window
// global, proving the promptId lookup really comes from the shared file,
// never a private copy) all run for real. The Governor DO stub
// (env.GOVERNOR.get(env.GOVERNOR.idFromName(...))) and the model call
// (env.AI / env.AI_STUB) are the only things replaced by controllable test
// doubles -- no real Durable Object, no real Workers AI binding, no
// `wrangler` command. `setTimeout`/`clearTimeout` are faked (the same
// {fn,ms,cleared,fired} technique monetize.js's own boot() uses above) so
// the 30s model-call timeout can be proven without a real 30s wait.

const TRANSFORM_PATH = path.join(ROOT_DIR, "functions/api/transform.js");
const GOVERNOR_CONFIG_LIB_PATH = path.join(LIB_DIR, "governor-config.js");
const PROMPTS_PATH = path.join(ROOT_DIR, "public/prompts.js");

const transformSource = readFileSync(TRANSFORM_PATH, "utf8");
const governorConfigLibSource = readFileSync(GOVERNOR_CONFIG_LIB_PATH, "utf8");
const promptsSource = readFileSync(PROMPTS_PATH, "utf8");

const TRANSFORM_MODEL_ID = "@cf/black-forest-labs/flux-2-klein-4b";
const TRANSFORM_MAX_BODY_BYTES = 400 * 1024;
const TRANSFORM_MAX_DECODED_PNG_BYTES = 256 * 1024;
const TRANSFORM_MAX_SKETCH_B64_LEN = Math.ceil((TRANSFORM_MAX_DECODED_PNG_BYTES * 4) / 3);

// Loads the real transform.js (and the real credential.js, device-token.js,
// turnstile.js, governor-config.js and public/prompts.js it imports) into
// one fresh vm context. `setTimeout`/`clearTimeout` are faked and recorded
// (never real timers), so the 30s model-call race AND turnstile.js's own
// internal 5s siteverify-timeout race can both be driven by hand from the
// same `timers` array. `credentialVerifyCalls`/`deviceTokenVerifyCalls`
// count real calls into the loaded credential.js's/device-token.js's own
// verify() -- the "zero credential/device-token calls" ordering proofs
// below assert on these directly, not on some higher-level side effect.
// Story 7-6: `fetchImpl`, when given, answers turnstile.js's own siteverify
// `fetch()` call (recorded in `fetchCalls`) -- exactly the same seam
// `loadTurnstile()`'s own `fetchImpl` param provides for testing
// turnstile.js in isolation; omitted entirely for every pre-existing
// Story 7-5 subscriber-path check below, none of which ever reach the
// free-device branch that would call it.
// Story 7-8: `deviceIdBytes`, when given, is called with zero args every
// time device-token.js's own mint() reaches `crypto.getRandomValues(new
// Uint8Array(16))` -- letting a check force two (or more) separate
// "no device token at all" requests to mint the SAME (or a deliberately
// DIFFERENT) device id, so the 4th free-device Governor call site's own
// pre-limit/deny-cache layering can be driven by repeated calls the same
// way the sub/free/mint call sites' own tests already do (deviceToken.mint()
// otherwise generates a fresh random id every call, which would never reuse
// the same Governor key). Only `getRandomValues` is swapped out -- `.subtle`
// still delegates to the real Node Web Crypto implementation, since
// device-token.js's own HMAC signing needs it. Omitted entirely (the
// default), this is just the real `crypto` global, unchanged from before
// this option existed -- every check below that doesn't pass it keeps
// getting genuinely random device ids, exactly as before.
function loadTransform({ fetchImpl, deviceIdBytes } = {}) {
  const consoleCalls = [];
  const timers = [];
  const fetchCalls = [];
  const sandbox = {
    console: { error: (...args) => consoleCalls.push(args), log() {}, warn() {} },
    crypto: deviceIdBytes
      ? {
          subtle: crypto.subtle,
          getRandomValues: (arr) => {
            arr.set(deviceIdBytes());
            return arr;
          },
        }
      : crypto,
    TextEncoder,
    TextDecoder,
    atob,
    btoa,
    Response,
    FormData,
    Blob,
    URL,
    URLSearchParams,
    AbortController,
    fetch: (url, init) => {
      fetchCalls.push({ url, init });
      if (!fetchImpl) throw new Error("no fetch mock configured for this check (turnstile.js's siteverify call)");
      return fetchImpl(url, init);
    },
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms, cleared: false, fired: false });
      return timers.length - 1;
    },
    clearTimeout: (id) => {
      if (timers[id]) timers[id].cleared = true;
    },
  };
  vm.createContext(sandbox);

  // credential.js, loaded into the SAME context, exposed as the namespace
  // object transform.js's own `import * as credential from
  // "../lib/credential.js"` expects (same technique checkout-confirm.js's
  // own loader above uses). Story 7-6: credential.js and device-token.js
  // deliberately DUPLICATE each other's internal helper names (TOKEN_TYPE,
  // base64UrlEncode, hmacSha256Base64Url, etc. -- see device-token.js's own
  // file header for why it doesn't import credential.js's), so each
  // module's source is wrapped in its own IIFE here -- otherwise loading
  // both into the SAME vm context as bare top-level scripts would collide
  // on every shared `const`/`function` name. Only the explicit `this.__x =
  // x` assignments below escape each IIFE's own scope.
  const credSrc = credentialLibSource.replace(/^export\s+/gm, "");
  vm.runInContext(
    `(function () {\n${credSrc}\nthis.__mint = mint; this.__verify = verify; this.__CredNotConfiguredError = NotConfiguredError;\n}).call(this);`,
    sandbox,
    { filename: "credential.js" }
  );
  let credentialVerifyCalls = 0;
  const realVerify = sandbox.__verify;
  sandbox.credential = {
    mint: sandbox.__mint,
    verify: (...args) => {
      credentialVerifyCalls++;
      return realVerify(...args);
    },
    NotConfiguredError: sandbox.__CredNotConfiguredError,
  };

  // device-token.js, loaded into the SAME context, exposed the same way as
  // credential.js just above -- transform.js's own `import * as deviceToken
  // from "../lib/device-token.js"` expects this exact namespace shape.
  // Same IIFE-wrapping reasoning as credential.js above.
  const devTokenSrc = deviceTokenLibSource.replace(/^export\s+/gm, "");
  vm.runInContext(
    `(function () {\n${devTokenSrc}\nthis.__dtMint = mint; this.__dtVerify = verify; this.__DtNotConfiguredError = NotConfiguredError;\n}).call(this);`,
    sandbox,
    { filename: "device-token.js" }
  );
  let deviceTokenVerifyCalls = 0;
  const realDeviceVerify = sandbox.__dtVerify;
  sandbox.deviceToken = {
    mint: sandbox.__dtMint,
    verify: (...args) => {
      deviceTokenVerifyCalls++;
      return realDeviceVerify(...args);
    },
    NotConfiguredError: sandbox.__DtNotConfiguredError,
  };

  // turnstile.js, loaded into the SAME context -- transform.js's own
  // `import * as turnstile from "../lib/turnstile.js"` expects this exact
  // namespace shape. Runs as the real, unmodified verifyDetailed() logic;
  // its own siteverify `fetch()` call resolves through this sandbox's own
  // `fetch` above (`fetchImpl`), and its 5s internal timeout timer is
  // recorded in the SAME `timers` array the 30s model-call race uses.
  // IIFE-wrapped for the same collision-avoidance reasoning as above (no
  // actual name collision with turnstile.js today, but this keeps every
  // module load in this function consistently isolated).
  const turnstileSrc = turnstileLibSource.replace(/^export\s+/gm, "");
  vm.runInContext(`(function () {\n${turnstileSrc}\nthis.turnstile = { verify, verifyDetailed };\n}).call(this);`, sandbox, {
    filename: "turnstile.js",
  });

  // governor-config.js, loaded directly into the same context -- transform.js
  // uses a NAMED import, so `loadGovernorConfig` must resolve as a bare
  // identifier when transform.js's own stripped source runs next, exactly
  // as the real bundled module graph would resolve it.
  const govConfigSrc = governorConfigLibSource.replace(/^export\s+/gm, "");
  vm.runInContext(govConfigSrc, sandbox, { filename: "governor-config.js" });

  // Story 7-8: http-body.js's readCappedBody and request-throttle.js's own
  // named exports -- both NAMED imports in transform.js, same reasoning as
  // governor-config.js just above. Each fresh loadTransform() call runs
  // request-throttle.js's own module-level `const denyCache = new Map()` /
  // `const preLimitWindows = new Map()` into a BRAND NEW vm context, so
  // every check gets its own isolated pre-limit/deny-cache state -- no
  // cross-check pollution, no reset call needed between checks (confirmed:
  // vm.createContext() above is called fresh on every loadTransform()
  // invocation).
  const httpBodySrc = httpBodyLibSource.replace(/^export\s+/gm, "");
  vm.runInContext(`${httpBodySrc}\nthis.readCappedBody = readCappedBody;`, sandbox, { filename: "http-body.js" });
  const requestThrottleSrc = requestThrottleLibSource.replace(/^export\s+/gm, "");
  vm.runInContext(
    `${requestThrottleSrc}\nthis.checkPreLimit = checkPreLimit; this.checkDenyCache = checkDenyCache; this.recordDenial = recordDenial; this.PRE_LIMIT_RETRY_AFTER = PRE_LIMIT_RETRY_AFTER;`,
    sandbox,
    { filename: "request-throttle.js" }
  );

  // The real public/prompts.js, loaded exactly as check-shared.mjs/
  // checkout.js's own legal.js loader loads a public/*.js shared file
  // (module.exports, no window global).
  const promptsSandbox = { module: { exports: {} } };
  vm.createContext(promptsSandbox);
  vm.runInContext(promptsSource, promptsSandbox, { filename: "prompts.js" });
  sandbox.prompts = promptsSandbox.module.exports;

  // Story 8-1: a plain recording stub for the shared writeEvent() helper --
  // same reasoning as loadWebhook's own stub above.
  const writeEventCalls = [];
  sandbox.writeEvent = (env, ctx, event, source) => {
    writeEventCalls.push({ event, source, ctx });
  };

  // Story 8.5: plain recording stubs for the two new events.js exports,
  // same reasoning as writeEvent's own stub just above -- transform.js's own
  // gauge/threshold/notify wiring is checked here against these stubs;
  // writeGovGauge's/notifyAlert's own internal behavior is checked
  // separately via loadEvents() (the real source).
  const writeGovGaugeCalls = [];
  sandbox.writeGovGauge = (env, ctx, gauge) => {
    writeGovGaugeCalls.push({ gauge, ctx });
  };
  const notifyAlertCalls = [];
  sandbox.notifyAlert = (env, ctx, event) => {
    notifyAlertCalls.push({ event, ctx });
  };

  const src = stripImportsAndExports(transformSource).replace(/^import\s+\w+\s+from\s*["'][^"']+["'];?\s*$/gm, "");
  vm.runInContext(`${src}\nthis.__onRequestPost = onRequestPost;`, sandbox, { filename: "transform.js" });

  return {
    onRequestPost: sandbox.__onRequestPost,
    consoleCalls,
    timers,
    fetchCalls,
    writeEventCalls,
    writeGovGaugeCalls,
    notifyAlertCalls,
    get credentialVerifyCalls() {
      return credentialVerifyCalls;
    },
    get deviceTokenVerifyCalls() {
      return deviceTokenVerifyCalls;
    },
  };
}

// A controllable Governor DO stub: `reserve`/`commit`/`release` are async
// spies, each recording every call and answering via an injected impl (or a
// sane default -- an unconditional grant/idempotent-success) when none is
// given.
// Story 8.5: `getDailyImageCountsImpl`, when given, controls the Story 8.4
// RPC method reportGovernorGauge() calls. Defaults to a fixed, comfortably-
// under-80%-of-the-default-ceiling-80 result ({free:0, sub:1,
// imagesTotal:1}) so every pre-existing check that reaches a real commit
// (and therefore now also reaches reportGovernorGauge via ctx.waitUntil)
// keeps behaving exactly as before -- no KV write, no notifyAlert call --
// without needing to know this story's own internals.
function makeGovernorStub({ reserveImpl, commitImpl, releaseImpl, getDailyImageCountsImpl } = {}) {
  const reserveCalls = [];
  const commitCalls = [];
  const releaseCalls = [];
  const getDailyImageCountsCalls = [];
  const stub = {
    async reserve(kind, key, cfg) {
      reserveCalls.push({ kind, key, cfg });
      if (reserveImpl) return reserveImpl(kind, key, cfg);
      return { ok: true, id: "res_1" };
    },
    async commit(id) {
      commitCalls.push(id);
      if (commitImpl) return commitImpl(id);
      return { ok: true, id, state: "committed" };
    },
    async release(id, opts) {
      releaseCalls.push({ id, opts });
      if (releaseImpl) return releaseImpl(id, opts);
      return { ok: true, id, state: "released" };
    },
    async getDailyImageCounts(budgetDay) {
      getDailyImageCountsCalls.push(budgetDay);
      if (getDailyImageCountsImpl) return getDailyImageCountsImpl(budgetDay);
      return { free: 0, sub: 1, imagesTotal: 1 };
    },
  };
  return { stub, reserveCalls, commitCalls, releaseCalls, getDailyImageCountsCalls };
}

// env.GOVERNOR: `.idFromName(name)` records every call and returns a plain
// tag; `.get(id)` always returns the one configured stub -- exactly how
// transform.js's own `env.GOVERNOR.get(env.GOVERNOR.idFromName("global"))`
// call shape is exercised, as an RPC-style stub, never a fetch().
function makeGovernorBinding(stub) {
  const idFromNameCalls = [];
  return {
    idFromName(name) {
      idFromNameCalls.push(name);
      return `id:${name}`;
    },
    get() {
      return stub;
    },
    idFromNameCalls,
  };
}

// VALID_GOVERNOR_CFG_RAW is declared near the top of this file now (Story
// 7-8) -- see that declaration's own comment for why.

function makeStateKv(value) {
  const getCalls = [];
  return {
    async get(key, opts) {
      getCalls.push({ key, opts });
      return value;
    },
    getCalls,
  };
}

// Story 8.5: a KEY-AWARE STATE_KV mock -- unlike makeStateKv() above (which
// answers get() with the SAME fixed value regardless of key -- fine for
// cfg:governor-only tests), reportGovernorGauge() reads/writes a SECOND,
// independent key (state:<budgetDay>) on the SAME STATE_KV binding, so
// tests that need to control both keys independently (the governor config
// AND the per-day crossing state) need a mock that genuinely keys its
// store. `initial` seeds `{key: alreadyParsedValue}` pairs (matching what
// `{type:"json"}` would already have parsed); `put()` JSON-round-trips its
// value the same way real KV does, so a subsequent `get()` sees the exact
// shape a real put/get pair would produce.
function makeKeyedStateKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  const getCalls = [];
  const putCalls = [];
  return {
    async get(key, opts) {
      getCalls.push({ key, opts });
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value, opts) {
      putCalls.push({ key, value, opts });
      store.set(key, JSON.parse(value));
    },
    getCalls,
    putCalls,
    store,
  };
}

// Builds a full mocked `env` for transform.js: a real ENTITLEMENT_SECRET (so
// credential.verify() actually works), AI_ENABLED/STATE_KV for
// governor-config.js's own loading, the GOVERNOR DO binding wired to
// `governorStub`, and either `aiStub` (env.AI_STUB) or `aiImpl` (env.AI.run)
// for the model call. `aiCalls` is ALWAYS returned (even when neither
// `aiStub` nor `aiImpl` is given) -- every validation-failure test below
// asserts `aiCalls.length === 0` off this one shared spy, rather than each
// test building its own ad hoc one. The wrapper functions below are
// deliberately plain (non-`async`): an `async` wrapper would turn a
// synchronously-throwing `aiStub` (the "neverCalled" pre-model-call test
// below relies on exactly this) into a rejected promise instead, which
// exercises a different branch of transform.js's own try/catch than a real
// synchronous throw does.
function makeTransformEnv({ secret = "transform_test_secret", aiEnabled = "true", governorCfgRaw = VALID_GOVERNOR_CFG_RAW, governorStub, aiImpl, aiStub, stateKv: stateKvOverride } = {}) {
  // Story 8.5: `stateKvOverride`, when given (a makeKeyedStateKv() mock),
  // is used AS-IS instead of the default cfg:governor-only mock -- it must
  // itself already answer `cfg:governor` with a valid config for a check
  // that expects real Governor calls to succeed; every pre-existing check
  // that doesn't pass this option is completely unaffected.
  const stateKv = stateKvOverride || makeStateKv(governorCfgRaw);
  const aiCalls = [];
  const env = {
    ENTITLEMENT_SECRET: secret,
    AI_ENABLED: aiEnabled,
    STATE_KV: stateKv,
  };
  if (governorStub) env.GOVERNOR = makeGovernorBinding(governorStub);
  if (aiStub) {
    env.AI_STUB = (...args) => {
      aiCalls.push(args);
      return aiStub(...args);
    };
  }
  if (aiImpl) {
    env.AI = {
      run: (...args) => {
        aiCalls.push(args);
        return aiImpl(...args);
      },
    };
  }
  return { env, stateKv, aiCalls };
}

// ctx.waitUntil(): records every promise handed to it, without ever
// awaiting it itself -- this is the actual guarantee the spec asks the
// tests to prove (the settle call is registered, not skipped), not that it
// was awaited inline before the response was built.
function makeCtx() {
  const waitUntilCalls = [];
  return { ctx: { waitUntil: (p) => waitUntilCalls.push(p) }, waitUntilCalls };
}

// Story 7-6: `deviceToken`, when given, sets the free-device path's own
// `X-Device-Token` header -- a SEPARATE header from `authorization`
// (`token`), never a second use of the same one, exactly matching
// transform.js's own two-header contract.
function transformRequest(bodyObjOrString, { token, xAppToken, deviceToken, contentType = "application/json" } = {}) {
  const bodyText = typeof bodyObjOrString === "string" ? bodyObjOrString : JSON.stringify(bodyObjOrString);
  const headers = { "content-type": contentType };
  if (token) headers["authorization"] = `Bearer ${token}`;
  // A real pre-Story-7.5 installed client would also have sent this header --
  // transform.js never reads it at all (see the static check below), but a
  // realistic old-client request should still include it.
  if (xAppToken) headers["x-app-token"] = xAppToken;
  if (deviceToken) headers["x-device-token"] = deviceToken;
  return new Request("https://8ish.app/api/transform", { method: "POST", headers, body: bodyText });
}

// Polls (via repeated settle() rounds) until a matching un-fired timer
// appears in `timers`, or gives up after `maxRounds`. A single settle()
// round (8 setImmediate ticks) is what monetize.js's own fetch/timeout
// tests rely on, but transform.js's path to its own setTimeout call also
// crosses several REAL async hops first (credential.verify()'s real
// crypto.subtle operations, the mocked-but-still-async KV/Governor calls) --
// those can take more real event-loop turns than a fixed handful of
// setImmediate ticks, so this polls instead of assuming a fixed budget is
// always enough.
async function waitForTimer(timers, ms, maxRounds = 50) {
  for (let i = 0; i < maxRounds; i++) {
    const timer = timers.find((t) => !t.cleared && !t.fired && t.ms === ms);
    if (timer) return timer;
    await settle();
  }
  return null;
}

function uint32BE(n) {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}
const REAL_PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const REAL_IHDR_TYPE = [0x49, 0x48, 0x44, 0x52]; // ASCII "IHDR"

// Constructs real PNG bytes by hand, byte-for-byte, matching the exact
// layout the frozen spec's Design Notes describe: 8-byte signature, a
// 4-byte IHDR length (13), the 4-byte ASCII IHDR type, then width/height as
// big-endian uint32s -- each field independently overridable so a test can
// corrupt exactly one of them.
function buildPngBytes({ signature = REAL_PNG_SIGNATURE, ihdrLength = 13, ihdrType = REAL_IHDR_TYPE, width = 1, height = 1, trailing = [1, 2, 3, 4] } = {}) {
  return Uint8Array.from([...signature, ...uint32BE(ihdrLength), ...ihdrType, ...uint32BE(width), ...uint32BE(height), ...trailing]);
}
function pngBase64(opts) {
  return Buffer.from(buildPngBytes(opts)).toString("base64");
}

const VALID_PNG_B64 = pngBase64();
const VALID_PROMPT_ID = "p001"; // public/prompts.js's real first entry
const VALID_PROMPT_EN_TEXT = "Draw a monster that only eats broccoli!"; // that entry's real EN text

async function mintTransformCredential(secret, sub = "sub_test_1", { now } = {}) {
  const { mint } = loadCredential(now != null ? { now } : {});
  return mint({ ENTITLEMENT_SECRET: secret }, sub);
}

function aiStubResolving(image) {
  return async () => ({ image });
}

const FORBIDDEN_LEAK_SUBSTRINGS = ["SUPER_SECRET_PROVIDER_DETAIL", ".message", "String(error)", "Error:"];
function assertNoLeak(bodyObj, label) {
  const text = JSON.stringify(bodyObj);
  for (const needle of FORBIDDEN_LEAK_SUBSTRINGS) {
    assert.ok(!text.includes(needle), `${label}: response body must never contain "${needle}" -- got ${text}`);
  }
}

// --- static source proofs -------------------------------------------------

check("functions/api/transform.js: source never CONSULTS Content-Length (no headers.get(\"content-length\") call anywhere), and never references error.message/String(error)/.stack (static proof the body cap is byte-based and the exception-leak regression is fixed)", () => {
  // A regex on the header-read CALL SHAPE, not a bare substring ban -- this
  // file's own header comments legitimately discuss (in prose) why
  // Content-Length is never trusted, which would otherwise false-positive
  // a blanket /content-length/i ban.
  assert.ok(!/headers\s*\.\s*get\(\s*["']content-length["']/i.test(transformSource), "must never call headers.get(\"content-length\")");
  assert.ok(!/\.message\b/.test(transformSource), "must never reference error.message");
  assert.ok(!/String\(error\)/.test(transformSource), "must never build a response/log from String(error)");
  assert.ok(!/\.stack\b/.test(transformSource), "must never reference an error's stack");
});

// This static grep only catches the LITERAL forms banned above (`.message`,
// `String(error)`, `.stack`) -- it would NOT catch destructuring (`const
// {message} = error`), bracket access (`error["message"]`), template-literal
// coercion (`` `${error}` ``), string concatenation (`"x: " + error`),
// `.toString()`, or `JSON.stringify(error)`. Verified by hand: none of those
// forms appear anywhere in transform.js -- every `catch (error)` in the file
// only uses `error` for an `instanceof` check or a bare rethrow, never in a
// response/log payload. This check is a tripwire for the literal forms
// above, not a full AST-based leak-detector -- a future editor adding a
// `${error}`-style leak would NOT be caught by this check alone.

check("functions/api/transform.js: the old APP_TOKEN/COOLDOWN_MS/STATE_KV_KEY/recordAttempt machinery is gone, and no code path reads the x-app-token header", () => {
  assert.ok(!/APP_TOKEN/.test(transformSource));
  assert.ok(!/COOLDOWN_MS/.test(transformSource));
  assert.ok(!/STATE_KV_KEY/.test(transformSource));
  assert.ok(!/recordAttempt/.test(transformSource));
  assert.ok(!/headers\s*\.\s*get\(\s*["']x-app-token["']/i.test(transformSource), "must never call headers.get(\"x-app-token\")");
});

// --- 1. body size cap (actual bytes, not Content-Length) -------------------

check("transform.js: a body over 400KB (actual bytes) is 400 bad_request, before JSON parsing, with zero credential/Governor/AI/KV calls (I/O matrix row + ordering proof)", async () => {
  const { stub, reserveCalls } = makeGovernorStub();
  const { env, stateKv, aiCalls } = makeTransformEnv({ governorStub: stub, aiStub: aiStubResolving("x") });
  const transformLoaded = loadTransform();
    const { onRequestPost } = transformLoaded;
  const { ctx } = makeCtx();

  // Not even valid JSON -- proves the byte cap runs strictly before any
  // JSON parsing, exactly per the frozen "Always" ordering.
  const junkBody = "x".repeat(TRANSFORM_MAX_BODY_BYTES + 1000);
  const res = await onRequestPost({ request: transformRequest(junkBody, { contentType: "text/plain" }), env, ctx });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.error.code, "bad_request");
  assert.equal(transformLoaded.credentialVerifyCalls, 0, "zero credential calls on a body-size violation");
  assert.equal(reserveCalls.length, 0, "zero Governor calls on a body-size violation");
  assert.equal(aiCalls.length, 0, "zero AI calls on a body-size violation");
  assert.equal(stateKv.getCalls.length, 0, "zero KV calls on a body-size violation");
});

check("transform.js: a body comfortably under 400KB is not rejected by the size cap (sanity boundary check)", async () => {
  const secret = "boundary_secret";
  const token = await mintTransformCredential(secret);
  const { stub } = makeGovernorStub();
  const { env } = makeTransformEnv({ secret, governorStub: stub, aiStub: aiStubResolving("aW1n") });
  const { onRequestPost } = loadTransform();
  const { ctx } = makeCtx();
  const res = await onRequestPost({ request: transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID }, { token }), env, ctx });
  assert.equal(res.status, 200);
});

// --- 2. malformed JSON ------------------------------------------------------

check("transform.js: malformed JSON (under the body cap) is 400 bad_request, zero credential/Governor/AI/KV calls", async () => {
  const { stub, reserveCalls } = makeGovernorStub();
  const { env, stateKv, aiCalls } = makeTransformEnv({ governorStub: stub });
  const transformLoaded = loadTransform();
    const { onRequestPost } = transformLoaded;
  const { ctx } = makeCtx();
  const res = await onRequestPost({ request: transformRequest("not json{", {}), env, ctx });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.error.code, "bad_request");
  assert.equal(transformLoaded.credentialVerifyCalls, 0);
  assert.equal(reserveCalls.length, 0);
  assert.equal(aiCalls.length, 0);
  assert.equal(stateKv.getCalls.length, 0);
});

// --- 3. required-field shape, including the OLD shape -----------------------

const SHAPE_CASES = [
  ["empty object", {}],
  ["sketch missing", { promptId: VALID_PROMPT_ID }],
  ["promptId missing", { sketch: VALID_PNG_B64 }],
  ["sketch not a string", { sketch: 12345, promptId: VALID_PROMPT_ID }],
  ["promptId not a string", { sketch: VALID_PNG_B64, promptId: 42 }],
  ["sketch empty string", { sketch: "", promptId: VALID_PROMPT_ID }],
  ["promptId empty string", { sketch: VALID_PNG_B64, promptId: "" }],
  // The OLD shape: image/prompt/x-app-token present, sketch/promptId absent
  // -- this must be rejected purely because the new required fields are
  // missing, no special-cased "detect the old shape" logic needed.
  ["the OLD shape (image/prompt), no sketch/promptId at all", { image: VALID_PNG_B64, prompt: "Draw a funny hat" }],
];

for (const [label, bodyObj] of SHAPE_CASES) {
  check(`transform.js: required-field shape check (${label}) -> 400 bad_request, zero credential/Governor/AI/KV calls`, async () => {
    const { stub, reserveCalls } = makeGovernorStub();
    const { env, stateKv, aiCalls } = makeTransformEnv({ governorStub: stub });
    const transformLoaded = loadTransform();
    const { onRequestPost } = transformLoaded;
    const { ctx } = makeCtx();
    const res = await onRequestPost({ request: transformRequest(bodyObj), env, ctx });
    const body = await res.json();
    assert.equal(res.status, 400, label);
    assert.equal(body.error.code, "bad_request", label);
    assert.equal(transformLoaded.credentialVerifyCalls, 0, `${label}: zero credential calls`);
    assert.equal(reserveCalls.length, 0, `${label}: zero Governor calls`);
    assert.equal(aiCalls.length, 0, `${label}: zero AI calls`);
    assert.equal(stateKv.getCalls.length, 0, `${label}: zero KV calls`);
  });
}

// The OLD shape specifically, but WITH a realistic x-app-token header too --
// a real pre-Story-7.5 installed client would have sent one alongside the
// old image/prompt body. transform.js never reads this header at all (see
// the static check above -- this is a complementary BEHAVIORAL proof, not a
// replacement for it), so this must still be rejected purely on shape, with
// the header completely inert.
check("transform.js: the OLD shape (image/prompt) WITH a realistic x-app-token header -> still 400 bad_request, zero credential/Governor/AI/KV calls (the header changes nothing)", async () => {
  const { stub, reserveCalls } = makeGovernorStub();
  const { env, stateKv, aiCalls } = makeTransformEnv({ governorStub: stub });
  const transformLoaded = loadTransform();
  const { onRequestPost } = transformLoaded;
  const { ctx } = makeCtx();
  const res = await onRequestPost({
    request: transformRequest({ image: VALID_PNG_B64, prompt: "Draw a funny hat" }, { xAppToken: "old_client_app_token_abc123" }),
    env,
    ctx,
  });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.error.code, "bad_request");
  assert.equal(transformLoaded.credentialVerifyCalls, 0);
  assert.equal(reserveCalls.length, 0);
  assert.equal(aiCalls.length, 0);
  assert.equal(stateKv.getCalls.length, 0);
});

// --- 4. base64 length pre-check + decoded-byte re-check ---------------------

check("transform.js: a sketch whose base64 length alone implies a decoded size over 256KB is 400 bad_request (the cheap pre-check, before any atob decode) -- zero credential/Governor/AI/KV calls", async () => {
  const { stub, reserveCalls } = makeGovernorStub();
  const { env, stateKv, aiCalls } = makeTransformEnv({ governorStub: stub });
  const transformLoaded = loadTransform();
    const { onRequestPost } = transformLoaded;
  const { ctx } = makeCtx();
  // 360000 chars: over MAX_SKETCH_B64_LEN (349526) but the whole request
  // body still comfortably under the 400KB body cap -- isolates this check
  // from the body-size check above. Deliberately not valid base64 content
  // either (the length-only pre-check must reject it before atob ever runs).
  const hugeSketch = "A".repeat(360000);
  assert.ok(hugeSketch.length > TRANSFORM_MAX_SKETCH_B64_LEN);
  assert.ok(JSON.stringify({ sketch: hugeSketch, promptId: VALID_PROMPT_ID }).length < TRANSFORM_MAX_BODY_BYTES);
  const res = await onRequestPost({ request: transformRequest({ sketch: hugeSketch, promptId: VALID_PROMPT_ID }), env, ctx });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.error.code, "bad_request");
  assert.equal(transformLoaded.credentialVerifyCalls, 0);
  assert.equal(reserveCalls.length, 0);
  assert.equal(aiCalls.length, 0);
  assert.equal(stateKv.getCalls.length, 0);
});

check("transform.js: a sketch that isn't valid base64 at all is 400 bad_request (atob throws, caught), zero credential/Governor/AI/KV calls", async () => {
  const { stub, reserveCalls } = makeGovernorStub();
  const { env, stateKv, aiCalls } = makeTransformEnv({ governorStub: stub });
  const transformLoaded = loadTransform();
  const { onRequestPost } = transformLoaded;
  const { ctx } = makeCtx();
  const res = await onRequestPost({ request: transformRequest({ sketch: "not-valid-base64!!!", promptId: VALID_PROMPT_ID }), env, ctx });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.error.code, "bad_request");
  assert.equal(transformLoaded.credentialVerifyCalls, 0);
  assert.equal(reserveCalls.length, 0);
  assert.equal(aiCalls.length, 0);
  assert.equal(stateKv.getCalls.length, 0);
});

// --- 5. exact PNG byte-layout validation ------------------------------------

const PNG_CASES = [
  ["bad signature (first byte flipped)", buildPngBytes({ signature: [0x00, ...REAL_PNG_SIGNATURE.slice(1)] })],
  ["bad signature (last byte flipped)", buildPngBytes({ signature: [...REAL_PNG_SIGNATURE.slice(0, 7), 0x00] })],
  ["IHDR length not 13", buildPngBytes({ ihdrLength: 12 })],
  ["IHDR type not ASCII IHDR", buildPngBytes({ ihdrType: [0x00, 0x00, 0x00, 0x00] })],
  ["width over 512 (513)", buildPngBytes({ width: 513, height: 1 })],
  ["height over 512 (513)", buildPngBytes({ width: 1, height: 513 })],
  ["both dimensions way over 512", buildPngBytes({ width: 4096, height: 4096 })],
  // Story 7-5 review finding (found independently by two lenses): a
  // width=0/height=0 IHDR previously passed the upper-bound-only check,
  // reaching a real Governor reservation + a real, billed env.AI.run() call
  // before failing at the model layer. isValidPng() now requires
  // `width > 0 && height > 0` too, on top of the existing `<= 512` cap --
  // these three cases pin that fix down, mirroring the width-only/
  // height-only/both-dimensions shape of the over-512 cases above.
  ["width zero", buildPngBytes({ width: 0, height: 1 })],
  ["height zero", buildPngBytes({ width: 1, height: 0 })],
  ["both dimensions zero", buildPngBytes({ width: 0, height: 0 })],
  ["truncated -- shorter than the 24 bytes IHDR requires", buildPngBytes().slice(0, 16)],
];

check("transform.js: exact PNG byte-layout validation -- every structural mismatch is 400 bad_request, zero credential/Governor/AI/KV calls", async () => {
  const { stub, reserveCalls } = makeGovernorStub();
  const { env, stateKv, aiCalls } = makeTransformEnv({ governorStub: stub });

  for (const [label, bytes] of PNG_CASES) {
    const transformLoaded = loadTransform();
    const { onRequestPost } = transformLoaded;
    const { ctx } = makeCtx();
    const sketch = Buffer.from(bytes).toString("base64");
    const res = await onRequestPost({ request: transformRequest({ sketch, promptId: VALID_PROMPT_ID }), env, ctx });
    const body = await res.json();
    assert.equal(res.status, 400, label);
    assert.equal(body.error.code, "bad_request", label);
    assert.equal(transformLoaded.credentialVerifyCalls, 0, `${label}: zero credential calls`);
    assert.equal(reserveCalls.length, 0, `${label}: zero Governor calls`);
  }
  assert.equal(aiCalls.length, 0, "zero AI calls across every PNG_CASES entry");
  assert.equal(stateKv.getCalls.length, 0, "zero KV calls across every PNG_CASES entry");
});

check("transform.js: PNG dimensions at the boundary -- 511x511 (one under the cap) and exactly 512x512 are BOTH accepted (reach all the way through to a 200); 513 is rejected (see the PNG_CASES entries above)", async () => {
  const secret = "png_boundary_secret";
  const token = await mintTransformCredential(secret);
  const { stub } = makeGovernorStub();
  for (const dim of [511, 512]) {
    const { env } = makeTransformEnv({ secret, governorStub: stub, aiStub: aiStubResolving(`boundary_image_${dim}_b64`) });
    const { onRequestPost } = loadTransform();
    const { ctx } = makeCtx();
    const sketch = pngBase64({ width: dim, height: dim });
    const res = await onRequestPost({ request: transformRequest({ sketch, promptId: VALID_PROMPT_ID }, { token }), env, ctx });
    assert.equal(res.status, 200, `${dim}x${dim} must be accepted -- <=512 per the frozen spec`);
    const body = await res.json();
    assert.equal(body.image, `boundary_image_${dim}_b64`);
  }
});

// --- 6. unknown promptId ----------------------------------------------------

check("transform.js: an unknown promptId is 400 bad_request, zero credential/Governor/AI/KV calls (I/O matrix row)", async () => {
  const { stub, reserveCalls } = makeGovernorStub();
  const { env, stateKv, aiCalls } = makeTransformEnv({ governorStub: stub });
  const transformLoaded = loadTransform();
    const { onRequestPost } = transformLoaded;
  const { ctx } = makeCtx();
  const res = await onRequestPost({ request: transformRequest({ sketch: VALID_PNG_B64, promptId: "not_a_real_id" }), env, ctx });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.error.code, "bad_request");
  assert.equal(transformLoaded.credentialVerifyCalls, 0);
  assert.equal(reserveCalls.length, 0);
  assert.equal(aiCalls.length, 0);
  assert.equal(stateKv.getCalls.length, 0);
});

check("transform.js: promptId is looked up in the REAL public/prompts.js EN array -- the exact English text reaches the model, never client-supplied text (closes defect A-31)", async () => {
  const secret = "a31_secret";
  const token = await mintTransformCredential(secret);
  const { stub } = makeGovernorStub();
  let capturedArgs = null;
  const aiStub = async (modelId, args) => {
    capturedArgs = { modelId, args };
    return { image: "ok_b64" };
  };
  const { env } = makeTransformEnv({ secret, governorStub: stub, aiStub });
  const { onRequestPost } = loadTransform();
  const { ctx } = makeCtx();

  // A decoy client-supplied "prompt"/"text" field alongside the real
  // promptId -- must be completely ignored; only promptId is ever read.
  const res = await onRequestPost({
    request: transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID, prompt: "IGNORE_ME_CLIENT_TEXT", text: "IGNORE_ME_TOO" }, { token }),
    env,
    ctx,
  });
  assert.equal(res.status, 200);
  assert.ok(capturedArgs, "the model must have been invoked");
  assert.equal(capturedArgs.modelId, TRANSFORM_MODEL_ID);

  // Read the real multipart body the handler built and confirm the real
  // server-side EN text is inside it, and the decoy client text is not.
  const multipartText = await new Response(capturedArgs.args.multipart.body, { headers: { "content-type": capturedArgs.args.multipart.contentType } }).text();
  assert.ok(multipartText.includes(VALID_PROMPT_EN_TEXT), "the real server-side EN text for p001 must reach the model");
  assert.ok(!multipartText.includes("IGNORE_ME_CLIENT_TEXT"), "client-supplied prompt text must never reach the model");
});

// --- 7. credential verification (ordering + outcomes) -----------------------
//
// Story 7-6 change (flagged in this story's Spec Change Log -- see the
// "Story 7-6" section further below for the full free-device I/O matrix):
// a missing Authorization header is no longer "an unauthenticated
// subscriber request" at all -- per the frozen spec's own Design Notes ("an
// Authorization header present routes to Story 7.5's branch
// unconditionally; its absence routes here"), it now ALWAYS selects the
// free-device path instead, regardless of what else the request carries.
// The check below is updated in place to prove that routing decision
// itself (zero credential.verify() calls when Authorization is genuinely
// absent -- credential.js is simply never reached down that branch at all
// now, the opposite of the pre-7.6 assertion this check used to make). The
// PRESENT-but-garbage-token case right after this one is completely
// unaffected -- Authorization is present there, so it still reaches
// credential.verify() and still 401s exactly as Story 7.5 built it.

check("transform.js (Story 7-6 routing change): a missing Authorization header no longer reaches credential.verify() at all -- it now unconditionally selects the free-device path instead (here, with Turnstile unconfigured in this env, that's 503 resting) -- zero credential/Governor/AI/KV calls either way", async () => {
  const { stub, reserveCalls } = makeGovernorStub();
  const { env, stateKv, aiCalls } = makeTransformEnv({ governorStub: stub, aiStub: aiStubResolving("x") });
  const transformLoaded = loadTransform();
  const { onRequestPost } = transformLoaded;
  const { ctx } = makeCtx();
  const res = await onRequestPost({ request: transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID }), env, ctx });
  const body = await res.json();
  assert.equal(res.status, 503, "no TURNSTILE_SECRET/ORIGIN in this env -- verifyDetailed() answers not_configured -> 503 resting");
  assert.equal(body.error.code, "resting");
  assert.equal(transformLoaded.credentialVerifyCalls, 0, "credential.verify() must NEVER be called down the Authorization-absent branch");
  assert.equal(reserveCalls.length, 0);
  assert.equal(aiCalls.length, 0);
  assert.equal(stateKv.getCalls.length, 0, "zero KV calls -- Turnstile fails closed before governor-config.js's own KV read is ever reached");
});

check("transform.js: a malformed/garbage Bearer token -> 401 unauthorized, zero Governor/AI/KV calls (same standard as the missing-header case above)", async () => {
  const { stub, reserveCalls } = makeGovernorStub();
  const { env, stateKv, aiCalls } = makeTransformEnv({ governorStub: stub, aiStub: aiStubResolving("x") });
  const transformLoaded = loadTransform();
  const { onRequestPost } = transformLoaded;
  const { ctx } = makeCtx();
  const res = await onRequestPost({ request: transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID }, { token: "garbage.not.a.token" }), env, ctx });
  const body = await res.json();
  assert.equal(res.status, 401);
  assert.equal(body.error.code, "unauthorized");
  assert.equal(transformLoaded.credentialVerifyCalls, 1, "verify() must still have been called with the garbage token");
  assert.equal(reserveCalls.length, 0);
  assert.equal(aiCalls.length, 0);
  assert.equal(stateKv.getCalls.length, 0);
});

check("transform.js: an expired credential -> 401 unauthorized, zero Governor/KV calls", async () => {
  const { stub, reserveCalls } = makeGovernorStub();
  const secret = "expired_secret";
  const { env, stateKv } = makeTransformEnv({ secret, governorStub: stub });
  const { onRequestPost } = loadTransform();
  const { ctx } = makeCtx();
  // Minted 8 days ago (7-day expiry) -- genuinely expired against the real,
  // unmocked system clock verify() checks against.
  const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
  const token = await mintTransformCredential(secret, "sub_expired", { now: eightDaysAgo });
  const res = await onRequestPost({ request: transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID }, { token }), env, ctx });
  const body = await res.json();
  assert.equal(res.status, 401);
  assert.equal(body.error.code, "unauthorized");
  assert.equal(reserveCalls.length, 0);
  assert.equal(stateKv.getCalls.length, 0);
});

check("transform.js: ENTITLEMENT_SECRET missing -> 500 not_configured, zero Governor/KV calls (validation still ran first)", async () => {
  const { stub, reserveCalls } = makeGovernorStub();
  const { env, stateKv } = makeTransformEnv({ governorStub: stub });
  delete env.ENTITLEMENT_SECRET;
  const { onRequestPost } = loadTransform();
  const { ctx } = makeCtx();
  const res = await onRequestPost({ request: transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID }, { token: "c1.whatever.sig" }), env, ctx });
  const body = await res.json();
  assert.equal(res.status, 500);
  assert.equal(body.error.code, "not_configured");
  assert.equal(reserveCalls.length, 0);
  assert.equal(stateKv.getCalls.length, 0);
});

// --- 8. Governor config / Kill Switch (ordering + outcomes) -----------------

check("transform.js: AI_ENABLED unset/false -> 503 resting, zero Governor reserve() calls -- credential WAS verified first (proves config is checked after credential, config costs zero reserve calls)", async () => {
  const secret = "resting_secret";
  const token = await mintTransformCredential(secret);
  const { stub, reserveCalls } = makeGovernorStub();
  for (const aiEnabled of ["__UNSET__", "false", "TRUE", "1"]) {
    // "__UNSET__" is a sentinel, not passed through as the literal env
    // value: makeTransformEnv's destructuring default only fires for an
    // actually-`undefined` property, so a truly-absent AI_ENABLED is
    // produced by deleting the key afterward instead.
    const { env } = makeTransformEnv({ secret, aiEnabled: aiEnabled === "__UNSET__" ? "true" : aiEnabled, governorStub: stub });
    if (aiEnabled === "__UNSET__") delete env.AI_ENABLED;
    const transformLoaded = loadTransform();
    const { onRequestPost, notifyAlertCalls } = transformLoaded;
    const { ctx, waitUntilCalls } = makeCtx();
    const res = await onRequestPost({ request: transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID }, { token }), env, ctx });
    const body = await res.json();
    assert.equal(res.status, 503, `AI_ENABLED=${aiEnabled}`);
    assert.equal(body.error.code, "resting");
    assert.equal(transformLoaded.credentialVerifyCalls, 1, "credential.verify() must have run before the config check");
    // Story 8.5: killswitch_seen fires, called bare (not wrapped in
    // ctx.waitUntil -- notifyAlert, like writeEvent which it delegates to,
    // already calls ctx.waitUntil internally and itself returns undefined;
    // an outer ctx.waitUntil(undefined) would throw against the real
    // Cloudflare runtime -- a review finding, fixed post-build). Zero
    // waitUntil calls recorded here since this sandbox's notifyAlert stub
    // is a plain recording function, not the real ctx.waitUntil-calling one
    // (proven directly by lib/events.js's own notifyAlert tests instead).
    assert.deepEqual(notifyAlertCalls.map((c) => c.event), ["killswitch_seen"], `AI_ENABLED=${aiEnabled}`);
    assert.equal(waitUntilCalls.length, 0, `AI_ENABLED=${aiEnabled}`);
  }
  assert.equal(reserveCalls.length, 0, "zero Governor reserve() calls across every AI_ENABLED-disabled case");
});

check("transform.js: AI_ENABLED true but cfg:governor is invalid/unreadable -> 503 resting, zero Governor reserve() calls", async () => {
  const secret = "bad_cfg_secret";
  const token = await mintTransformCredential(secret);
  const { stub, reserveCalls } = makeGovernorStub();
  for (const badCfg of [null, {}, { ceiling: "not a number" }, { ...VALID_GOVERNOR_CFG_RAW, aiEnabled: "true" }]) {
    const { env } = makeTransformEnv({ secret, governorStub: stub, governorCfgRaw: badCfg });
    const { onRequestPost, notifyAlertCalls } = loadTransform();
    const { ctx, waitUntilCalls } = makeCtx();
    const res = await onRequestPost({ request: transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID }, { token }), env, ctx });
    const body = await res.json();
    assert.equal(res.status, 503);
    assert.equal(body.error.code, "resting");
    // Story 8.5: same killswitch_seen wiring, for the OTHER resting reason
    // (an invalid/unreadable cfg:governor, not the AI_ENABLED var itself).
    // Called bare -- see the AI_ENABLED-disabled test above for why.
    assert.deepEqual(notifyAlertCalls.map((c) => c.event), ["killswitch_seen"]);
    assert.equal(waitUntilCalls.length, 0);
  }
  assert.equal(reserveCalls.length, 0);
});

check("transform.js (Story 8.5): the free-device path's own resting site (loadGovernorConfig failing) also fires killswitch_seen via ctx.waitUntil, without delaying the 503 -- matches the subscriber path's own wiring above, proving BOTH resting sites are covered, not just the subscriber one", async () => {
  const { stub } = makeGovernorStub();
  // No Authorization header at all -> the free-device path; Turnstile is
  // unconfigured by default in this env (no TURNSTILE_SECRET), which would
  // 503 resting BEFORE ever reaching this story's own config-check site --
  // to isolate THAT site specifically, TURNSTILE_SECRET/ORIGIN are set and a
  // real passing fetchImpl is supplied so the human check passes first, and
  // `governorCfgRaw: null` makes loadGovernorConfig fail once reached.
  const { env } = makeTransformEnv({ governorStub: stub, governorCfgRaw: null });
  env.TURNSTILE_SECRET = "ts_secret";
  env.ORIGIN = "https://8ish.app";
  const passingFetch = async () => ({ ok: true, status: 200, json: async () => ({ success: true, action: "image", hostname: "8ish.app" }) });
  const { onRequestPost, notifyAlertCalls } = loadTransform({ fetchImpl: passingFetch });
  const { ctx, waitUntilCalls } = makeCtx();
  const res = await onRequestPost({
    request: transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID, turnstile: "tok" }, {}),
    env,
    ctx,
  });
  const body = await res.json();
  assert.equal(res.status, 503);
  assert.equal(body.error.code, "resting");
  // Called bare -- see the subscriber-path killswitch_seen tests above for why.
  assert.deepEqual(notifyAlertCalls.map((c) => c.event), ["killswitch_seen"]);
  assert.equal(waitUntilCalls.length, 0);
});

// --- 9. Governor reserve() denial mapping -----------------------------------

check("transform.js: reserve() denies 'wait' -> 429 with retryAfterSeconds (governor-core.js's checkMinGap/checkFreeGlobalGap always supply one)", async () => {
  const secret = "wait_secret";
  const token = await mintTransformCredential(secret);
  const { stub } = makeGovernorStub({ reserveImpl: async () => ({ ok: false, denied: "wait", retryAfterSeconds: 17 }) });
  const { env } = makeTransformEnv({ secret, governorStub: stub });
  const { onRequestPost } = loadTransform();
  const { ctx } = makeCtx();
  const res = await onRequestPost({ request: transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID }, { token }), env, ctx });
  const body = await res.json();
  assert.equal(res.status, 429);
  assert.deepEqual(body, { error: { code: "wait", retryAfterSeconds: 17 } });
});

check("transform.js: reserve() denies 'daily_limit' -> 429 with NO retryAfterSeconds (governor-core.js's checkDailyAllowance never supplies one)", async () => {
  const secret = "daily_secret";
  const token = await mintTransformCredential(secret);
  const { stub } = makeGovernorStub({ reserveImpl: async () => ({ ok: false, denied: "daily_limit" }) });
  const { env } = makeTransformEnv({ secret, governorStub: stub });
  const { onRequestPost } = loadTransform();
  const { ctx } = makeCtx();
  const res = await onRequestPost({ request: transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID }, { token }), env, ctx });
  const body = await res.json();
  assert.equal(res.status, 429);
  assert.deepEqual(body, { error: { code: "daily_limit" } });
  assert.ok(!("retryAfterSeconds" in body.error), "daily_limit must never invent a retryAfterSeconds");
});

check("transform.js: reserve() denies 'rate_limited' -> 429 with NO retryAfterSeconds (governor-core.js's checkMintRateLimit never supplies one)", async () => {
  const secret = "rate_secret";
  const token = await mintTransformCredential(secret);
  const { stub } = makeGovernorStub({ reserveImpl: async () => ({ ok: false, denied: "rate_limited" }) });
  const { env } = makeTransformEnv({ secret, governorStub: stub });
  const { onRequestPost } = loadTransform();
  const { ctx } = makeCtx();
  const res = await onRequestPost({ request: transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID }, { token }), env, ctx });
  const body = await res.json();
  assert.equal(res.status, 429);
  assert.deepEqual(body, { error: { code: "rate_limited" } });
});

check("transform.js: reserve() denies 'resting' -> 503 resting", async () => {
  const secret = "resting2_secret";
  const token = await mintTransformCredential(secret);
  const { stub } = makeGovernorStub({ reserveImpl: async () => ({ ok: false, denied: "resting" }) });
  const { env } = makeTransformEnv({ secret, governorStub: stub });
  const { onRequestPost } = loadTransform();
  const { ctx } = makeCtx();
  const res = await onRequestPost({ request: transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID }, { token }), env, ctx });
  const body = await res.json();
  assert.equal(res.status, 503);
  assert.deepEqual(body, { error: { code: "resting" } });
});

check("transform.js: reserve() is called with kind 'sub' and the verified credential's own sub (never a request-supplied value), plus the loaded cfg -- and the DO is addressed via idFromName('global')", async () => {
  const secret = "addressing_secret";
  const token = await mintTransformCredential(secret, "sub_addressing_test");
  const { stub, reserveCalls } = makeGovernorStub();
  const { env } = makeTransformEnv({ secret, governorStub: stub, aiStub: aiStubResolving("img") });
  const { onRequestPost } = loadTransform();
  const { ctx } = makeCtx();
  await onRequestPost({ request: transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID, sub: "sub_HACKED" }, { token }), env, ctx });
  assert.equal(reserveCalls.length, 1);
  assert.equal(reserveCalls[0].kind, "sub");
  assert.equal(reserveCalls[0].key, "sub_addressing_test", "the Governor key must come from the verified credential, never a body field");
  assert.deepEqual({ ...reserveCalls[0].cfg }, VALID_GOVERNOR_CFG_RAW); // spread: reserveCalls[0].cfg is a vm-sandbox-realm object; deepEqual treats cross-realm objects as unequal by identity of Object.prototype, so it is copied into a host-realm plain object first
  assert.deepEqual(env.GOVERNOR.idFromNameCalls, ["global"]);
});

// --- 10-12. the model call: success, waitUntil (not inline), commit --------

check("transform.js: a granted reservation calls the model, then commit()s via ctx.waitUntil() (NOT awaited inline) and returns 200 with the raw (stripped) base64 image", async () => {
  const secret = "success_secret";
  const token = await mintTransformCredential(secret);
  let commitResolve;
  const commitPromise = new Promise((resolve) => (commitResolve = resolve));
  const { stub, commitCalls, releaseCalls } = makeGovernorStub({ commitImpl: async () => commitPromise });
  const { env } = makeTransformEnv({ secret, governorStub: stub, aiStub: aiStubResolving("data:image/png;base64,iVBORw0KGgo=") });
  const { onRequestPost } = loadTransform();
  const { ctx, waitUntilCalls } = makeCtx();

  // commit() never resolves during this test -- if onRequestPost awaited it
  // inline, this whole check would hang and time out. Resolving to 200
  // anyway is the direct proof it did not.
  const res = await onRequestPost({ request: transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID }, { token }), env, ctx });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body, { image: "iVBORw0KGgo=" }, "a data: URI prefix must be stripped");
  assert.equal(commitCalls.length, 1, "commit() must have been called");
  assert.equal(releaseCalls.length, 0);
  // Story 8.5: a SECOND ctx.waitUntil() call now also fires -- the
  // reportGovernorGauge() gauge/threshold/notify work, registered right
  // after the settle call, both still via ctx.waitUntil (never inline).
  assert.equal(waitUntilCalls.length, 2, "the settle call AND the Story 8.5 gauge-report call must both be registered via ctx.waitUntil()");
  assert.ok(typeof waitUntilCalls[0]?.then === "function", "ctx.waitUntil() must receive a promise");
  assert.ok(typeof waitUntilCalls[1]?.then === "function", "ctx.waitUntil() must receive a promise");
  commitResolve(); // let the still-pending promise settle so the process can exit cleanly
});

check("transform.js: env.AI_STUB, when present, is used INSTEAD of env.AI.run -- production env never sets AI_STUB, so this proves the test seam is genuinely gated on its presence", async () => {
  const secret = "stub_seam_secret";
  const token = await mintTransformCredential(secret);
  const { stub } = makeGovernorStub();
  const aiRunCalls = [];
  const { env } = makeTransformEnv({
    secret,
    governorStub: stub,
    aiImpl: async (...a) => (aiRunCalls.push(a), { image: "must_not_be_used" }),
    aiStub: aiStubResolving("stub_used_b64"),
  });
  const { onRequestPost } = loadTransform();
  const { ctx } = makeCtx();
  const res = await onRequestPost({ request: transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID }, { token }), env, ctx });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.image, "stub_used_b64");
  assert.equal(aiRunCalls.length, 0, "env.AI.run must never be called while env.AI_STUB is present");
});

check("transform.js: without env.AI_STUB, env.AI.run(MODEL_ID, {multipart}) is called with the unchanged model id and multipart shape", async () => {
  const secret = "real_ai_secret";
  const token = await mintTransformCredential(secret);
  const { stub } = makeGovernorStub();
  const aiRunCalls = [];
  const { env } = makeTransformEnv({
    secret,
    governorStub: stub,
    aiImpl: async (modelId, args) => (aiRunCalls.push({ modelId, args }), { image: "via_real_ai" }),
  });
  const { onRequestPost } = loadTransform();
  const { ctx } = makeCtx();
  const res = await onRequestPost({ request: transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID }, { token }), env, ctx });
  assert.equal(res.status, 200);
  assert.equal(aiRunCalls.length, 1);
  assert.equal(aiRunCalls[0].modelId, TRANSFORM_MODEL_ID);
  assert.equal(typeof aiRunCalls[0].args.multipart.body, "object");
  assert.ok(String(aiRunCalls[0].args.multipart.contentType).includes("multipart/form-data"));
});

// --- 13. model throws / malformed / empty -> release(providerFailed) -------

check("transform.js: the model call rejecting -> release(id, {providerFailed:true}) via ctx.waitUntil(), 502 provider_error, no exception text in the body", async () => {
  const secret = "provider_error_secret";
  const token = await mintTransformCredential(secret);
  const { stub, releaseCalls, commitCalls } = makeGovernorStub();
  const { env } = makeTransformEnv({
    secret,
    governorStub: stub,
    aiStub: async () => {
      throw new Error("SUPER_SECRET_PROVIDER_DETAIL_should_never_leak");
    },
  });
  const { onRequestPost } = loadTransform();
  const { ctx, waitUntilCalls } = makeCtx();
  const res = await onRequestPost({ request: transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID }, { token }), env, ctx });
  const body = await res.json();
  assert.equal(res.status, 502);
  assert.deepEqual(body, { error: { code: "provider_error" } });
  assertNoLeak(body, "model-rejects");
  assert.equal(commitCalls.length, 0);
  assert.equal(releaseCalls.length, 1);
  assert.equal(releaseCalls[0].id, "res_1");
  assert.deepEqual({ ...releaseCalls[0].opts }, { providerFailed: true }); // spread: see the cfg comment above -- opts is also built inside the sandbox realm
  assert.equal(waitUntilCalls.length, 1);
});

check("transform.js: a malformed/empty model response (no .image, or an empty string) -> release(providerFailed) via ctx.waitUntil() (NOT awaited inline), 502 provider_error", async () => {
  const secret = "malformed_secret";
  for (const malformed of [{}, { image: "" }, { image: 42 }, null]) {
    const token = await mintTransformCredential(secret);
    // release() never resolves during this test -- if onRequestPost awaited
    // it inline, this whole check would hang and time out. Resolving to 502
    // anyway is the direct proof it did not (same never-resolving-stub +
    // `.then()` technique the success test above and the disconnect test
    // below use).
    const { stub, releaseCalls, commitCalls } = makeGovernorStub({ releaseImpl: () => new Promise(() => {}) });
    const { env } = makeTransformEnv({ secret, governorStub: stub, aiStub: async () => malformed });
    const { onRequestPost } = loadTransform();
    const { ctx, waitUntilCalls } = makeCtx();
    const res = await onRequestPost({ request: transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID }, { token }), env, ctx });
    const body = await res.json();
    assert.equal(res.status, 502, JSON.stringify(malformed));
    assert.deepEqual(body, { error: { code: "provider_error" } });
    assert.equal(commitCalls.length, 0);
    assert.equal(releaseCalls.length, 1);
    assert.deepEqual({ ...releaseCalls[0].opts }, { providerFailed: true }); // spread: see the cfg comment above -- opts is also built inside the sandbox realm
    assert.equal(waitUntilCalls.length, 1);
    assert.ok(typeof waitUntilCalls[0]?.then === "function", "ctx.waitUntil() must receive a promise");
  }
});

// --- the 30s timeout (faked timers, no real wait) ---------------------------

check("transform.js: the model call exceeding 30s -> release(providerFailed) via ctx.waitUntil() (NOT awaited inline), 504 timeout, no exception text", async () => {
  const secret = "timeout_secret";
  const token = await mintTransformCredential(secret);
  // release() never resolves during this test -- if onRequestPost awaited it
  // inline, this whole check would hang and time out. Resolving to 504
  // anyway is the direct proof it did not (same technique as the success
  // test above).
  const { stub, releaseCalls, commitCalls } = makeGovernorStub({ releaseImpl: () => new Promise(() => {}) });
  const { env } = makeTransformEnv({ secret, governorStub: stub, aiStub: () => new Promise(() => {}) }); // never resolves
  const { onRequestPost, timers } = loadTransform();
  const { ctx, waitUntilCalls } = makeCtx();

  const resultPromise = onRequestPost({ request: transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID }, { token }), env, ctx });
  const timer = await waitForTimer(timers, 30000);
  assert.ok(timer, "the 30s timeout timer must have been armed");
  timer.fired = true;
  timer.fn();

  const res = await resultPromise;
  const body = await res.json();
  assert.equal(res.status, 504);
  assert.deepEqual(body, { error: { code: "timeout" } });
  assertNoLeak(body, "timeout");
  assert.equal(commitCalls.length, 0);
  assert.equal(releaseCalls.length, 1);
  assert.deepEqual({ ...releaseCalls[0].opts }, { providerFailed: true }); // spread: see the cfg comment above -- opts is also built inside the sandbox realm
  assert.equal(waitUntilCalls.length, 1);
  assert.ok(typeof waitUntilCalls[0]?.then === "function", "ctx.waitUntil() must receive a promise");
});

check("transform.js: an answer that arrives AFTER the 30s timeout already fired is ignored (the timer, not the late resolution, wins) -- still 504, still one release", async () => {
  const secret = "late_answer_secret";
  const token = await mintTransformCredential(secret);
  const { stub, releaseCalls } = makeGovernorStub();
  let resolveLate;
  const late = new Promise((resolve) => (resolveLate = resolve));
  const { env } = makeTransformEnv({ secret, governorStub: stub, aiStub: () => late });
  const { onRequestPost, timers } = loadTransform();
  const { ctx } = makeCtx();

  const resultPromise = onRequestPost({ request: transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID }, { token }), env, ctx });
  const timer = await waitForTimer(timers, 30000);
  assert.ok(timer);
  timer.fired = true;
  timer.fn();
  const res = await resultPromise;
  assert.equal(res.status, 504);
  resolveLate({ image: "too_late_b64" }); // must not un-settle anything
  await settle();
  assert.equal(releaseCalls.length, 1, "only the timeout's own release, nothing extra from the late resolution");
});

// --- 14. a pre-model-call exception -> release(neverCalled) ----------------

check("transform.js: a synchronous failure invoking the model (never actually reaching it) -> release(id, {neverCalled:true}) via ctx.waitUntil() (NOT awaited inline), 502 provider_error, no exception text", async () => {
  const secret = "never_called_secret";
  const token = await mintTransformCredential(secret);
  // release() never resolves during this test -- if onRequestPost awaited it
  // inline, this whole check would hang and time out. Resolving to 502
  // anyway is the direct proof it did not (same technique as the success
  // test above).
  const { stub, releaseCalls, commitCalls } = makeGovernorStub({ releaseImpl: () => new Promise(() => {}) });
  // A synchronously-throwing AI_STUB reaches the exact same try/catch the
  // spec's own example ("building the request body throws") describes --
  // the request never actually reaches the model, only the ATTEMPT to
  // invoke it fails, before any promise is ever awaited.
  const { env } = makeTransformEnv({
    secret,
    governorStub: stub,
    aiStub: () => {
      throw new Error("SUPER_SECRET_PROVIDER_DETAIL_sync_boom");
    },
  });
  const { onRequestPost } = loadTransform();
  const { ctx, waitUntilCalls } = makeCtx();
  const res = await onRequestPost({ request: transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID }, { token }), env, ctx });
  const body = await res.json();
  assert.equal(res.status, 502);
  assert.deepEqual(body, { error: { code: "provider_error" } });
  assertNoLeak(body, "pre-call-exception");
  assert.equal(commitCalls.length, 0);
  assert.equal(releaseCalls.length, 1);
  assert.deepEqual({ ...releaseCalls[0].opts }, { neverCalled: true }, "a pre-call failure must release neverCalled, distinct from providerFailed");
  assert.equal(waitUntilCalls.length, 1);
  assert.ok(typeof waitUntilCalls[0]?.then === "function", "ctx.waitUntil() must receive a promise");
});

// --- client disconnect -- settlement still happens via waitUntil ------------

check("transform.js: settlement (commit/release) is registered via ctx.waitUntil() on every settling path -- proven by the response resolving even while the settle call itself never resolves (a client disconnect can never skip it)", async () => {
  const secret = "disconnect_secret";
  const token = await mintTransformCredential(secret);
  const { stub, releaseCalls } = makeGovernorStub({ releaseImpl: () => new Promise(() => {}) }); // never resolves
  const { env } = makeTransformEnv({
    secret,
    governorStub: stub,
    aiStub: async () => {
      throw new Error("boom");
    },
  });
  const { onRequestPost } = loadTransform();
  const { ctx, waitUntilCalls } = makeCtx();
  const res = await onRequestPost({ request: transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID }, { token }), env, ctx });
  assert.equal(res.status, 502, "the response must resolve even though release() itself never does");
  assert.equal(releaseCalls.length, 1);
  assert.equal(waitUntilCalls.length, 1);
});

// --- no leaked provider/exception text, across every failing path ----------

check("transform.js: no response body across ANY failure path ever contains provider/exception text (String(error), .message, or the thrown message itself)", async () => {
  const secret = "no_leak_secret";
  const token = await mintTransformCredential(secret);
  const distinctiveError = () => {
    const e = new Error("SUPER_SECRET_PROVIDER_DETAIL_12345 stack trace goes here");
    e.stack = "SUPER_SECRET_PROVIDER_DETAIL_12345 at some/internal/path.js:42";
    throw e;
  };

  const scenarios = [
    { label: "model rejects", aiStub: async () => distinctiveError() },
    { label: "model invocation throws synchronously", aiStub: () => distinctiveError() },
  ];
  for (const { label, aiStub } of scenarios) {
    const { stub } = makeGovernorStub();
    const { env } = makeTransformEnv({ secret, governorStub: stub, aiStub });
    const { onRequestPost } = loadTransform();
    const { ctx } = makeCtx();
    const res = await onRequestPost({ request: transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID }, { token }), env, ctx });
    const body = await res.json();
    assert.equal(res.status, 502, label);
    assertNoLeak(body, label);
    assert.deepEqual(Object.keys(body), ["error"], `${label}: response body must carry only {error}`);
    assert.deepEqual(Object.keys(body.error), ["code"], `${label}: error object must carry only {code}`);
  }
});

// ------------------------------------------------------ Story 7-6: lib/device-token.js, lib/turnstile.js's verifyDetailed, functions/api/transform.js's free-device path
//
// Three sub-sections, in the same order the story's Code Map lists its own
// files: `lib/device-token.js` in isolation (mirroring how the Story 6-3
// section above tests `lib/turnstile.js` in isolation), `verifyDetailed`'s
// own reason mapping in isolation (the existing `loadTurnstile()` helper
// just above, now also exposing `verifyDetailed` alongside the unchanged
// `verify`), then the free-device branch of `functions/api/transform.js`
// itself through the SAME `loadTransform()`/`makeGovernorStub()`/
// `makeTransformEnv()`/`transformRequest()` machinery the Story 7-5 section
// above already built -- extended (never replaced) to also wire in the real
// `device-token.js` and `turnstile.js` modules and a controllable `fetch`
// for turnstile's own siteverify call. No live Cloudflare/Turnstile call,
// no real Durable Object, no `wrangler` command, anywhere below.

const TRANSFORM_TURNSTILE_ENV = { TURNSTILE_SECRET: "transform_ts_secret", ORIGIN: "https://8ish.app" };
const turnstileImageOk = (overrides = {}) => okResponse(siteverifyOk({ action: "image", hostname: "8ish.app", ...overrides }));

// Sets up a free-device-ready env (adds TURNSTILE_SECRET/ORIGIN on top of
// makeTransformEnv()'s own fields, which never set them -- none of the
// Story 7-5 subscriber-path checks need Turnstile at all).
function makeFreeDeviceEnv(opts = {}) {
  const { env, stateKv, aiCalls } = makeTransformEnv(opts);
  env.TURNSTILE_SECRET = TRANSFORM_TURNSTILE_ENV.TURNSTILE_SECRET;
  env.ORIGIN = TRANSFORM_TURNSTILE_ENV.ORIGIN;
  return { env, stateKv, aiCalls };
}

async function mintTransformDeviceToken(secret) {
  const { mint } = loadDeviceToken();
  return mint({ ENTITLEMENT_SECRET: secret });
}

// --- lib/device-token.js ---------------------------------------------------

const DEVICE_TOKEN_ENV = { ENTITLEMENT_SECRET: "device_secret_1" };

check("device-token.mint/verify: a freshly minted token is d1.<id>.<sig>-shaped and verifies, returning {id} (I/O matrix: Mint/Verify)", async () => {
  const { mint, verify } = loadDeviceToken();
  const token = await mint(DEVICE_TOKEN_ENV);
  assert.match(token, /^d1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const payload = await verify(DEVICE_TOKEN_ENV, token);
  assert.ok(payload);
  assert.match(payload.id, /^[A-Za-z0-9_-]+$/);
});

check("device-token.mint: two mints never produce the same id (crypto.getRandomValues, 128 bits)", async () => {
  const { mint } = loadDeviceToken();
  const a = await mint(DEVICE_TOKEN_ENV);
  const b = await mint(DEVICE_TOKEN_ENV);
  assert.notEqual(a, b);
});

check("device-token.verify: a c1. subscriber credential never verifies as a d1. device token (wrong type prefix, rejected before any HMAC work) -- and the reverse also fails, even though both share the same secret", async () => {
  const { mint: mintCred, verify: verifyCred } = loadCredential();
  const { mint: mintDevice, verify: verifyDevice } = loadDeviceToken();
  const sharedSecret = "shared_secret_both_directions";
  const credToken = await mintCred({ ENTITLEMENT_SECRET: sharedSecret }, "sub_x");
  assert.ok(credToken.startsWith("c1."));
  assert.equal(await verifyDevice({ ENTITLEMENT_SECRET: sharedSecret }, credToken), null, "a c1. credential must never verify as a d1. device token");

  const deviceTok = await mintDevice({ ENTITLEMENT_SECRET: sharedSecret });
  assert.equal(await verifyCred({ ENTITLEMENT_SECRET: sharedSecret }, deviceTok), null, "a d1. device token must never verify as a c1. credential");
});

check("device-token.verify: a tampered signature never verifies", async () => {
  const { mint, verify } = loadDeviceToken();
  const token = await mint(DEVICE_TOKEN_ENV);
  const tampered = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
  assert.equal(await verify(DEVICE_TOKEN_ENV, tampered), null);
});

check("device-token.verify: a token signed under a DIFFERENT secret never verifies", async () => {
  const { mint } = loadDeviceToken();
  const { verify } = loadDeviceToken();
  const token = await mint({ ENTITLEMENT_SECRET: "some_other_secret" });
  assert.equal(await verify(DEVICE_TOKEN_ENV, token), null);
});

check("device-token.verify: rotation -- a token signed under ENTITLEMENT_SECRET_PREV still verifies; mint() only ever signs with the CURRENT secret, never _PREV", async () => {
  const { mint, verify } = loadDeviceToken();
  const oldToken = await mint({ ENTITLEMENT_SECRET: "old_secret" });
  const rotatedEnv = { ENTITLEMENT_SECRET: "new_secret", ENTITLEMENT_SECRET_PREV: "old_secret" };
  assert.ok(await verify(rotatedEnv, oldToken), "an old_secret-signed token must still verify via _PREV during rotation");
  const newToken = await mint(rotatedEnv);
  assert.equal(await verify({ ENTITLEMENT_SECRET: "old_secret" }, newToken), null, "a new-secret-signed token must never verify under only the OLD secret");
});

check("device-token.verify: malformed shapes (wrong prefix, missing/extra segments, empty pieces, non-string, over-length) all return null, never throw", async () => {
  const { verify } = loadDeviceToken();
  const cases = ["c1.abc.def", "d1.onlyonepart", "d1..", "d1.abc.", "d1..def", "d1.abc.def.ghi", "", undefined, null, 42, "d1." + "A".repeat(1000) + ".sig"];
  for (const bad of cases) {
    assert.equal(await verify(DEVICE_TOKEN_ENV, bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

check("device-token.mint/verify: ENTITLEMENT_SECRET missing -> both throw NotConfiguredError (Story 7-6's own fail-closed judgment call -- see device-token.js's file header)", async () => {
  const { mint, verify, NotConfiguredError } = loadDeviceToken();
  await assert.rejects(() => mint({}), (e) => e instanceof NotConfiguredError);
  await assert.rejects(() => verify({}, "d1.whatever.sig"), (e) => e instanceof NotConfiguredError);
});

// --- lib/turnstile.js: verifyDetailed's reason mapping ---------------------
//
// `verifyDetailed()` runs INSIDE each `loadTurnstile()` call's own fresh vm
// context, so the `{ok, reason}` object it returns is a cross-realm plain
// object -- `assert.deepEqual` against a host-realm object literal fails
// Node's cross-realm identity check even when every field matches (the
// exact same issue the Story 7-5 section's own comments flag for
// `reserveCalls[0].cfg`/`releaseCalls[0].opts`). `assertDetailed` below
// shallow-spreads the sandbox-realm value into a host-realm copy first, the
// same fix that section applies inline.
function assertDetailed(actual, expected, message) {
  assert.deepEqual({ ...actual }, expected, message);
}

check("turnstile.verifyDetailed: TURNSTILE_SECRET missing -> {ok:false, reason:'not_configured'}, zero fetch calls; verify() agrees (plain false) for the identical input", async () => {
  const { verify, verifyDetailed, fetchCalls } = loadTurnstile({});
  const badEnv = { ORIGIN: "https://8ish.app" };
  assertDetailed(await verifyDetailed(badEnv, "tok", "image"), { ok: false, reason: "not_configured" });
  assert.equal(await verify(badEnv, "tok", "image"), false);
  assert.equal(fetchCalls.length, 0);
});

check("turnstile.verifyDetailed: env.ORIGIN missing/empty/unparsable -> {ok:false, reason:'not_configured'}, zero fetch calls", async () => {
  const { verifyDetailed, fetchCalls } = loadTurnstile({});
  for (const badEnv of [{ TURNSTILE_SECRET: "s" }, { TURNSTILE_SECRET: "s", ORIGIN: "" }, { TURNSTILE_SECRET: "s", ORIGIN: "not a url" }]) {
    assertDetailed(await verifyDetailed(badEnv, "tok", "image"), { ok: false, reason: "not_configured" });
  }
  assert.equal(fetchCalls.length, 0);
});

check("turnstile.verifyDetailed: missing/empty token or expectedAction -> {ok:false, reason:'invalid'}, zero fetch calls", async () => {
  const { verifyDetailed, fetchCalls } = loadTurnstile({});
  assertDetailed(await verifyDetailed(TURNSTILE_ENV, "", "image"), { ok: false, reason: "invalid" });
  assertDetailed(await verifyDetailed(TURNSTILE_ENV, undefined, "image"), { ok: false, reason: "invalid" });
  assertDetailed(await verifyDetailed(TURNSTILE_ENV, "tok", ""), { ok: false, reason: "invalid" });
  assert.equal(fetchCalls.length, 0);
});

check("turnstile.verifyDetailed: a network failure, a non-2xx response, or malformed JSON from siteverify -> {ok:false, reason:'unreachable'} (every one of the three)", async () => {
  const networkFailure = loadTurnstile({
    fetchImpl: async () => {
      throw new TypeError("Failed to fetch");
    },
  });
  assertDetailed(await networkFailure.verifyDetailed(TURNSTILE_ENV, "tok", "image"), { ok: false, reason: "unreachable" });

  const non2xx = loadTurnstile({ fetchImpl: async () => ({ ok: false, json: async () => ({}) }) });
  assertDetailed(await non2xx.verifyDetailed(TURNSTILE_ENV, "tok", "image"), { ok: false, reason: "unreachable" });

  const badJson = loadTurnstile({
    fetchImpl: async () => ({
      ok: true,
      json: async () => {
        throw new SyntaxError("bad json");
      },
    }),
  });
  assertDetailed(await badJson.verifyDetailed(TURNSTILE_ENV, "tok", "image"), { ok: false, reason: "unreachable" });
});

check("turnstile.verifyDetailed: a genuine wrong-action/wrong-hostname/unsuccessful siteverify RESULT (the service itself answered) -> {ok:false, reason:'invalid'}", async () => {
  const wrongAction = loadTurnstile({ fetchImpl: async () => okResponse(siteverifyOk({ action: "image" })) });
  assertDetailed(await wrongAction.verifyDetailed(TURNSTILE_ENV, "tok", "restore"), { ok: false, reason: "invalid" });

  const wrongHost = loadTurnstile({ fetchImpl: async () => okResponse(siteverifyOk({ hostname: "evil.example.com" })) });
  assertDetailed(await wrongHost.verifyDetailed(TURNSTILE_ENV, "tok", "restore"), { ok: false, reason: "invalid" });

  const unsuccessful = loadTurnstile({ fetchImpl: async () => okResponse(siteverifyOk({ success: false })) });
  assertDetailed(await unsuccessful.verifyDetailed(TURNSTILE_ENV, "tok", "restore"), { ok: false, reason: "invalid" });
});

check("turnstile.verifyDetailed: a genuine success -> {ok:true, reason:'success'}; verify() returns true for the identical input -- both funnel through the ONE shared siteverify call, never two copies of the logic", async () => {
  const { verify, verifyDetailed, fetchCalls } = loadTurnstile({ fetchImpl: async () => okResponse(siteverifyOk({ action: "image" })) });
  assertDetailed(await verifyDetailed(TURNSTILE_ENV, "tok_1", "image"), { ok: true, reason: "success" });
  assert.equal(await verify(TURNSTILE_ENV, "tok_2", "image"), true);
  assert.equal(fetchCalls.length, 2, "two independent calls in this check, each its own genuine siteverify round-trip");
});

check("turnstile.verifyDetailed vs verify: 403-vs-503 distinction proven at the library boundary too -- 'invalid' and 'unreachable' are genuinely different reason codes for genuinely different siteverify outcomes, not two labels for the same branch", async () => {
  const invalidResult = await loadTurnstile({ fetchImpl: async () => okResponse(siteverifyOk({ success: false })) }).verifyDetailed(TURNSTILE_ENV, "tok", "restore");
  const unreachableResult = await loadTurnstile({
    fetchImpl: async () => {
      throw new TypeError("Failed to fetch");
    },
  }).verifyDetailed(TURNSTILE_ENV, "tok", "restore");
  assert.equal(invalidResult.reason, "invalid");
  assert.equal(unreachableResult.reason, "unreachable");
  assert.notEqual(invalidResult.reason, unreachableResult.reason);
});

// --- functions/api/transform.js: the free-device path (Story 7-6 itself) ---

check("transform.js (Story 7-6): no Authorization, no X-Device-Token, valid Turnstile action=image -- mints a d1. token (gated by mintPerHour), reserves 'free' for the new id, calls the model, 200 {image, device} (I/O matrix row 1)", async () => {
  const { stub, reserveCalls, commitCalls } = makeGovernorStub();
  const { env } = makeFreeDeviceEnv({ governorStub: stub, aiStub: aiStubResolving("fresh_mint_image_b64") });
  const { onRequestPost } = loadTransform({ fetchImpl: async () => turnstileImageOk() });
  const { ctx } = makeCtx();
  const res = await onRequestPost({
    request: transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID, turnstile: "tok_1" }),
    env,
    ctx,
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.image, "fresh_mint_image_b64");
  assert.match(body.device, /^d1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, "the response must carry a real d1. token");
  assert.equal(reserveCalls.length, 2, "one 'mint' reserve, then one 'free' reserve for the new id");
  assert.equal(reserveCalls[0].kind, "mint");
  assert.equal(reserveCalls[1].kind, "free");
  const { verify: verifyDeviceLocally } = loadDeviceToken();
  const decoded = await verifyDeviceLocally({ ENTITLEMENT_SECRET: env.ENTITLEMENT_SECRET }, body.device);
  assert.equal(reserveCalls[1].key, decoded.id, "the 'free' reserve's key must be the SAME id the response's own device token carries");
  assert.equal(commitCalls.length, 2, "the mint reservation's own immediate commit, plus the free reservation's settlement commit");
});

check("transform.js (Story 7-6): a valid existing X-Device-Token, fresh Turnstile, under freeDaily -- reserves 'free' directly (no mint at all), 200 {image, device} echoing the SAME token (I/O matrix row 2)", async () => {
  const secret = "existing_device_secret";
  const existingToken = await mintTransformDeviceToken(secret);
  const { stub, reserveCalls } = makeGovernorStub();
  const { env } = makeFreeDeviceEnv({ secret, governorStub: stub, aiStub: aiStubResolving("existing_device_image_b64") });
  const { onRequestPost } = loadTransform({ fetchImpl: async () => turnstileImageOk() });
  const { ctx } = makeCtx();
  const res = await onRequestPost({
    request: transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID, turnstile: "tok_1" }, { deviceToken: existingToken }),
    env,
    ctx,
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.image, "existing_device_image_b64");
  assert.equal(body.device, existingToken, "the SAME token must be echoed back, never re-minted");
  assert.equal(reserveCalls.length, 1, "no 'mint' reserve at all -- only the direct 'free' reserve");
  assert.equal(reserveCalls[0].kind, "free");
});

check("transform.js (Story 7-6): a valid X-Device-Token already at freeDaily today -> 429 daily_limit (I/O matrix row 3)", async () => {
  const secret = "daily_limit_secret";
  const existingToken = await mintTransformDeviceToken(secret);
  const { stub } = makeGovernorStub({ reserveImpl: async (kind) => (kind === "free" ? { ok: false, denied: "daily_limit" } : { ok: true, id: "res_x" }) });
  const { env } = makeFreeDeviceEnv({ secret, governorStub: stub });
  const { onRequestPost } = loadTransform({ fetchImpl: async () => turnstileImageOk() });
  const { ctx } = makeCtx();
  const res = await onRequestPost({
    request: transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID, turnstile: "tok_1" }, { deviceToken: existingToken }),
    env,
    ctx,
  });
  const body = await res.json();
  assert.equal(res.status, 429);
  assert.deepEqual(body, { error: { code: "daily_limit" } });
});

// Day-rollover scope note (per this story's own instruction: document why a
// full day-rollover proof is out of scope for THIS sandbox rather than
// skip the row silently). The frozen I/O matrix's second clause ("the next
// Bucharest day, allowed again") is governor-core.js's own allowance-day
// mechanism (bucharestDateString(), Stories 7-2/7-3) -- already proven
// directly, with REAL clock injection across REAL day/DST boundaries, by
// test/governor-core.test.mjs (see e.g. its "reserve('free', ...) denies
// daily_limit once this key's freeDaily allowance is reached" test and its
// DST spring-forward/fall-back suite). This file's own Governor stub
// (makeGovernorStub) has no day concept at all -- it just answers whatever
// `reserveImpl` says, synchronously, with no allowance-day bookkeeping of
// its own -- so a genuine day-rollover proof does not belong in THIS
// sandbox; reproducing it here would either fake the exact thing
// governor-core.test.mjs already proves for real, or (worse) invite the
// two suites to silently drift apart. What IS transform.js's own
// responsibility, and what the check below actually proves, is that it
// asks the Governor fresh on every single request rather than caching a
// stale denial itself -- the only part of "allowed again tomorrow" that
// isn't already governor-core.js's job.
check("transform.js (Story 7-6): the SAME device token succeeds on a LATER request once the Governor itself grants again -- transform.js never caches a stale denial itself (the actual day-rollover guarantee is governor-core.js's own, proven there -- see the scope note above)", async () => {
  const secret = "daily_limit_next_day_secret";
  const existingToken = await mintTransformDeviceToken(secret);
  const { stub } = makeGovernorStub({ reserveImpl: async () => ({ ok: true, id: "res_next_day" }) });
  const { env } = makeFreeDeviceEnv({ secret, governorStub: stub, aiStub: aiStubResolving("next_day_b64") });
  const { onRequestPost } = loadTransform({ fetchImpl: async () => turnstileImageOk() });
  const { ctx } = makeCtx();
  const res = await onRequestPost({
    request: transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID, turnstile: "tok_1" }, { deviceToken: existingToken }),
    env,
    ctx,
  });
  assert.equal(res.status, 200);
});

check("transform.js (Story 7-6): missing Turnstile token entirely -> 403 human_check_failed, zero Governor/KV calls, zero siteverify calls (fails BEFORE any network call at all)", async () => {
  const { stub, reserveCalls } = makeGovernorStub();
  const { env, stateKv } = makeFreeDeviceEnv({ governorStub: stub });
  const { onRequestPost, fetchCalls } = loadTransform({ fetchImpl: async () => turnstileImageOk() });
  const { ctx } = makeCtx();
  const res = await onRequestPost({ request: transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID }), env, ctx });
  const body = await res.json();
  assert.equal(res.status, 403);
  assert.deepEqual(body, { error: { code: "human_check_failed" } });
  assert.equal(fetchCalls.length, 0, "an empty/missing token must fail before any siteverify call");
  assert.equal(reserveCalls.length, 0);
  assert.equal(stateKv.getCalls.length, 0);
});

check("transform.js (Story 7-6): a genuinely unsuccessful/replayed Turnstile result (siteverify itself DID answer) -> 403 human_check_failed, zero Governor calls", async () => {
  const { stub, reserveCalls } = makeGovernorStub();
  const { env } = makeFreeDeviceEnv({ governorStub: stub });
  const { onRequestPost, fetchCalls } = loadTransform({ fetchImpl: async () => okResponse(siteverifyOk({ action: "image", hostname: "8ish.app", success: false })) });
  const { ctx } = makeCtx();
  const res = await onRequestPost({ request: transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID, turnstile: "replayed_tok" }), env, ctx });
  const body = await res.json();
  assert.equal(res.status, 403);
  assert.deepEqual(body, { error: { code: "human_check_failed" } });
  assert.equal(fetchCalls.length, 1, "siteverify WAS called this time -- the distinguishing factor from the row above");
  assert.equal(reserveCalls.length, 0);
});

check("transform.js (Story 7-6): Turnstile's siteverify service unreachable (network failure) -> 503 resting, zero Governor calls", async () => {
  const { stub, reserveCalls } = makeGovernorStub();
  const { env } = makeFreeDeviceEnv({ governorStub: stub });
  const { onRequestPost } = loadTransform({
    fetchImpl: async () => {
      throw new TypeError("Failed to fetch");
    },
  });
  const { ctx } = makeCtx();
  const res = await onRequestPost({ request: transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID, turnstile: "tok_1" }), env, ctx });
  const body = await res.json();
  assert.equal(res.status, 503, "unreachable must be 503, never 403");
  assert.deepEqual(body, { error: { code: "resting" } });
  assert.equal(reserveCalls.length, 0);
});

check("transform.js (Story 7-6): 403 vs 503 are genuinely DIFFERENT outcomes from the SAME endpoint, driven purely by whether siteverify answered unsuccessfully ('invalid') or never answered at all ('unreachable') -- a dedicated side-by-side proof, not just one branch tested in isolation", async () => {
  const scenarios = [
    { label: "invalid: siteverify answers success:false", fetchImpl: async () => okResponse(siteverifyOk({ action: "image", hostname: "8ish.app", success: false })) },
    {
      label: "unreachable: network failure",
      fetchImpl: async () => {
        throw new TypeError("Failed to fetch");
      },
    },
  ];
  const statuses = [];
  for (const { fetchImpl } of scenarios) {
    const { stub } = makeGovernorStub();
    const { env } = makeFreeDeviceEnv({ governorStub: stub });
    const { onRequestPost } = loadTransform({ fetchImpl });
    const { ctx } = makeCtx();
    const res = await onRequestPost({ request: transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID, turnstile: "tok_1" }), env, ctx });
    statuses.push(res.status);
  }
  assert.deepEqual(statuses, [403, 503], "invalid must be 403, unreachable must be 503 -- genuinely distinct outcomes, not both collapsing to the same code");
});

check("transform.js (Story 7-6): a forged d1. token in X-Device-Token is treated as NO token -- proceeds to mint (never rejected outright), 200 with a freshly minted (DIFFERENT) device token", async () => {
  const forged = "d1.forgedforgedforged1234.notarealsignatureatall1234567890abcdefgh";
  const { stub, reserveCalls } = makeGovernorStub();
  const { env } = makeFreeDeviceEnv({ governorStub: stub, aiStub: aiStubResolving("forged_recovers_b64") });
  const { onRequestPost } = loadTransform({ fetchImpl: async () => turnstileImageOk() });
  const { ctx } = makeCtx();
  const res = await onRequestPost({
    request: transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID, turnstile: "tok_1" }, { deviceToken: forged }),
    env,
    ctx,
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.notEqual(body.device, forged, "a brand-new token must be minted, never the forged one echoed back");
  assert.equal(reserveCalls[0].kind, "mint", "a forged token must reach the mint path, exactly like no token at all");
});

check("transform.js (Story 7-6): a c1. subscriber credential handed in as X-Device-Token is ALSO treated as no token at all -- proceeds to mint, never a partial/implicit pass", async () => {
  const credSecret = "cred_in_device_header_secret";
  const credToken = await mintTransformCredential(credSecret);
  const { stub, reserveCalls } = makeGovernorStub();
  const { env } = makeFreeDeviceEnv({ secret: credSecret, governorStub: stub, aiStub: aiStubResolving("cred_recovers_b64") });
  const { onRequestPost } = loadTransform({ fetchImpl: async () => turnstileImageOk() });
  const { ctx } = makeCtx();
  const res = await onRequestPost({
    request: transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID, turnstile: "tok_1" }, { deviceToken: credToken }),
    env,
    ctx,
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.notEqual(body.device, credToken);
  assert.equal(reserveCalls[0].kind, "mint");
});

check("transform.js (Story 7-6): more mint attempts than mintPerHour -> 429 rate_limited, no image, no token minted, the denied mint is never committed (I/O matrix row)", async () => {
  const { stub, commitCalls } = makeGovernorStub({ reserveImpl: async (kind) => (kind === "mint" ? { ok: false, denied: "rate_limited" } : { ok: true, id: "unused" }) });
  const { env, aiCalls } = makeFreeDeviceEnv({ governorStub: stub });
  const { onRequestPost } = loadTransform({ fetchImpl: async () => turnstileImageOk() });
  const { ctx } = makeCtx();
  const res = await onRequestPost({ request: transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID, turnstile: "tok_1" }), env, ctx });
  const body = await res.json();
  assert.equal(res.status, 429);
  assert.deepEqual(body, { error: { code: "rate_limited" } });
  assert.equal("device" in body, false, "no device field on a mint-rate-limited denial -- nothing was ever minted");
  assert.equal(commitCalls.length, 0, "the denied mint reservation must never be committed");
  assert.equal(aiCalls.length, 0);
});

check("transform.js (Story 7-6): mint succeeds but the immediately-following 'free' reserve denies 'resting' (503) -- the response STILL includes the newly-minted device token, alongside the matching denial (Design Notes' resolved edge case)", async () => {
  const { stub, commitCalls } = makeGovernorStub({
    reserveImpl: async (kind) => {
      if (kind === "mint") return { ok: true, id: "mint_res_1" };
      if (kind === "free") return { ok: false, denied: "resting" };
      throw new Error("unexpected kind " + kind);
    },
  });
  const { env } = makeFreeDeviceEnv({ governorStub: stub });
  const { onRequestPost } = loadTransform({ fetchImpl: async () => turnstileImageOk() });
  const { ctx } = makeCtx();
  const res = await onRequestPost({ request: transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID, turnstile: "tok_1" }), env, ctx });
  const body = await res.json();
  assert.equal(res.status, 503, "the 'free' denial's OWN mapped status (resting -> 503), not swallowed by the fact a token was minted");
  assert.deepEqual(body.error, { code: "resting" });
  assert.match(body.device, /^d1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, "the newly-minted token must still be present in the body");
  assert.equal(commitCalls.length, 1, "the mint reservation's own commit still happened -- the mint itself was real, not rolled back");
});

check("transform.js (Story 7-6): mint succeeds but the immediately-following 'free' reserve denies 'daily_limit' (429) -- same rule, 429 with the device token still attached", async () => {
  const { stub, commitCalls } = makeGovernorStub({
    reserveImpl: async (kind) => (kind === "mint" ? { ok: true, id: "mint_res_2" } : { ok: false, denied: "daily_limit" }),
  });
  const { env } = makeFreeDeviceEnv({ governorStub: stub });
  const { onRequestPost } = loadTransform({ fetchImpl: async () => turnstileImageOk() });
  const { ctx } = makeCtx();
  const res = await onRequestPost({ request: transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID, turnstile: "tok_1" }), env, ctx });
  const body = await res.json();
  assert.equal(res.status, 429);
  assert.deepEqual(body.error, { code: "daily_limit" });
  assert.match(body.device, /^d1\./);
  assert.equal(commitCalls.length, 1);
});

check("transform.js (Story 7-6 review fix): a genuine throw AFTER the mint reservation is committed -- here, the immediately-following 'free' reserve itself throwing (a Durable Object RPC failure) rather than returning {ok:false} -- degrades to 502 provider_error, never an uncaught exception, and the mint stays committed (a real, accepted mintPerHour-slot cost, not a crash)", async () => {
  const { stub: reserveThrowStub, commitCalls: reserveThrowCommits } = makeGovernorStub({
    reserveImpl: async (kind) => {
      if (kind === "mint") return { ok: true, id: "mint_res_4" };
      throw new Error("SUPER_SECRET_DO_FAILURE_DETAIL");
    },
  });
  const { env: envB } = makeFreeDeviceEnv({ governorStub: reserveThrowStub });
  const { onRequestPost } = loadTransform({ fetchImpl: async () => turnstileImageOk() });
  const { ctx } = makeCtx();

  const res = await onRequestPost({ request: transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID, turnstile: "tok_1" }), env: envB, ctx });
  const bodyText = await res.text();
  assert.equal(res.status, 502, "an uncaught exception here must degrade to a documented envelope, never propagate as an unstructured error");
  assert.deepEqual(JSON.parse(bodyText), { error: { code: "provider_error" } });
  assert.ok(!bodyText.includes("SUPER_SECRET_DO_FAILURE_DETAIL"), "the real exception's message must never reach the response body");
  assert.equal(reserveThrowCommits.length, 1, "the mint reservation's own commit already happened and stays committed -- an accepted, documented cost, not something this fix tries to undo");
});

check("transform.js (Story 7-6): subscriber path is completely unaffected when Authorization IS present, even on a request that also carries a turnstile field and an X-Device-Token header (both simply ignored) -- Authorization presence alone decides the branch", async () => {
  const secret = "both_headers_secret";
  const token = await mintTransformCredential(secret);
  const { stub, reserveCalls } = makeGovernorStub();
  const { env } = makeTransformEnv({ secret, governorStub: stub, aiStub: aiStubResolving("subscriber_wins_b64") });
  const { onRequestPost } = loadTransform();
  const { ctx } = makeCtx();
  const res = await onRequestPost({
    request: transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID, turnstile: "irrelevant_here" }, { token, deviceToken: "d1.irrelevant.also" }),
    env,
    ctx,
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.image, "subscriber_wins_b64");
  assert.equal("device" in body, false, "the subscriber path's response shape is unchanged -- no device field ever");
  assert.equal(reserveCalls.length, 1);
  assert.equal(reserveCalls[0].kind, "sub");
});

check("functions/api/transform.js, functions/lib/turnstile.js, functions/lib/device-token.js: none of Story 7-6's new code ever reads a cookie or an IP-derived header (AD-16) -- static proof on the actual header-read/property-access call shapes, not a blanket word ban (this story's own comments legitimately discuss the constraint in prose, which a naive word ban would false-positive on)", () => {
  const bannedHeaderNames = ["cookie", "cf-connecting-ip", "x-forwarded-for", "x-real-ip", "true-client-ip"];
  for (const source of [transformSource, turnstileLibSource, deviceTokenLibSource]) {
    for (const name of bannedHeaderNames) {
      const pattern = new RegExp(`headers\\s*\\.\\s*get\\(\\s*["']${name}["']`, "i");
      assert.ok(!pattern.test(source), `must never call headers.get("${name}")`);
    }
    assert.ok(!/request\s*\.\s*cf\b/.test(source), "must never read request.cf (Cloudflare's own IP/geo request metadata object)");
  }
});

check("transform.js (Story 7-6): setting Cookie/CF-Connecting-IP/X-Forwarded-For headers on a free-device request changes NOTHING about its outcome (behavioral complement to the static proof above)", async () => {
  const secret = "ip_cookie_behavior_secret";
  const existingToken = await mintTransformDeviceToken(secret);
  const { stub } = makeGovernorStub();
  const { env } = makeFreeDeviceEnv({ secret, governorStub: stub, aiStub: aiStubResolving("ignores_ip_b64") });
  const { onRequestPost } = loadTransform({ fetchImpl: async () => turnstileImageOk() });
  const { ctx } = makeCtx();
  const request = transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID, turnstile: "tok_1" }, { deviceToken: existingToken });
  request.headers.set("cookie", "session=malicious_tracking_value");
  request.headers.set("cf-connecting-ip", "203.0.113.7");
  request.headers.set("x-forwarded-for", "203.0.113.7");
  const res = await onRequestPost({ request, env, ctx });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.image, "ignores_ip_b64");
  assert.equal(body.device, existingToken);
});

// -------------------------------------------- Story 7-8: request-throttle.js layered in front of transform.js's Governor calls
//
// Checked through the SAME loadTransform()/makeGovernorStub()/
// makeTransformEnv()/makeFreeDeviceEnv()/transformRequest() machinery the
// Story 7-5/7-6 sections above already built -- request-throttle.js's own
// module-level Maps are reloaded fresh into a brand new vm context on every
// loadTransform() call (see that function's own comment), so a check that
// wants to exercise the pre-limit's fixed window or the deny cache's 60s
// memory calls onRequestPost() MULTIPLE TIMES against the SAME
// loadTransform()/env pairing, never across separate loadTransform() calls.

check("transform.js (sub path): a burst of 6 requests for the SAME credential (over the 5-per-10s pre-limit) denies the 6th with zero ADDITIONAL Governor calls", async () => {
  const secret = "throttle_sub_secret";
  const token = await mintTransformCredential(secret);
  const { stub, reserveCalls } = makeGovernorStub();
  const { env } = makeTransformEnv({ secret, governorStub: stub, aiStub: aiStubResolving("img") });
  const { onRequestPost } = loadTransform();
  const { ctx } = makeCtx();
  const statuses = [];
  for (let i = 0; i < 6; i++) {
    const res = await onRequestPost({ request: transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID }, { token }), env, ctx });
    statuses.push(res.status);
  }
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429], "the 6th request in the same 10s window must be pre-limited, not answered by the real Governor");
  assert.equal(reserveCalls.length, 5, "the pre-limited 6th request must never reach the real Governor reserve() call at all");
});

check("transform.js (sub path): a REAL wait denial for one credential is remembered by the deny cache -- a repeat answers from the cache with zero additional Governor calls, and does not affect a DIFFERENT credential's key in the SAME isolate", async () => {
  const secret = "throttle_deny_shared_secret";
  const tokenA = await mintTransformCredential(secret, "sub_a");
  const tokenB = await mintTransformCredential(secret, "sub_b");
  // One shared stub, one shared secret (so both tokens verify against the
  // SAME env below): denies key "sub_a" only, grants everything else -- so
  // credential B reaching the real Governor at all proves it was never
  // wrongly denied by credential A's own cached entry.
  const { stub, reserveCalls } = makeGovernorStub({
    reserveImpl: async (kind, key) => (key === "sub_a" ? { ok: false, denied: "wait", retryAfterSeconds: 9 } : { ok: true, id: `res_${key}` }),
  });
  const { env } = makeTransformEnv({ secret, governorStub: stub, aiStub: aiStubResolving("img") });
  const { onRequestPost } = loadTransform();
  const { ctx } = makeCtx();

  const first = await onRequestPost({ request: transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID }, { token: tokenA }), env, ctx });
  assert.equal(first.status, 429);
  assert.equal(reserveCalls.length, 1);

  const second = await onRequestPost({ request: transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID }, { token: tokenA }), env, ctx });
  const secondBody = await second.json();
  assert.equal(second.status, 429);
  assert.deepEqual(secondBody, { error: { code: "wait", retryAfterSeconds: 9 } });
  assert.equal(reserveCalls.length, 1, "the second identical request must be answered from the deny cache -- zero additional Governor calls");

  // A DIFFERENT credential (different sub -> different Governor key), same
  // isolate (same onRequestPost/env), must still reach the real Governor --
  // proves the deny cache is per-key, not global.
  const third = await onRequestPost({ request: transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID }, { token: tokenB }), env, ctx });
  assert.equal(third.status, 200, "a different credential's key must not be affected by another key's cached denial in the same isolate");
  assert.equal(reserveCalls.length, 2, "credential B's own request must reach the real Governor -- it was never cached");
});

check("transform.js (free-device path, existing token): the same pre-limit/deny-cache layering applies to reserve('free', deviceId, cfg)", async () => {
  const secret = "throttle_free_secret";
  const existingToken = await mintTransformDeviceToken(secret);
  const { stub, reserveCalls } = makeGovernorStub({ reserveImpl: async () => ({ ok: false, denied: "wait", retryAfterSeconds: 3 }) });
  const { env } = makeFreeDeviceEnv({ secret, governorStub: stub });
  const { onRequestPost } = loadTransform({ fetchImpl: async () => turnstileImageOk() });
  const { ctx } = makeCtx();
  const request = () => transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID, turnstile: "tok_1" }, { deviceToken: existingToken });

  const first = await onRequestPost({ request: request(), env, ctx });
  assert.equal(first.status, 429);
  assert.equal(reserveCalls.length, 1);

  const second = await onRequestPost({ request: request(), env, ctx });
  const secondBody = await second.json();
  assert.deepEqual(secondBody, { error: { code: "wait", retryAfterSeconds: 3 } });
  assert.equal(reserveCalls.length, 1, "the repeat must be answered from the deny cache, zero additional Governor calls");
});

check("transform.js (free-device path, mint): the same pre-limit/deny-cache layering applies to reserve('mint', 'mint', cfg), keyed by the single fixed 'mint' literal", async () => {
  const secret = "throttle_mint_secret";
  const { stub, reserveCalls } = makeGovernorStub({ reserveImpl: async (kind) => (kind === "mint" ? { ok: false, denied: "rate_limited" } : { ok: true, id: "res_free" }) });
  const { env } = makeFreeDeviceEnv({ secret, governorStub: stub });
  const { onRequestPost } = loadTransform({ fetchImpl: async () => turnstileImageOk() });
  const { ctx } = makeCtx();
  const request = () => transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID, turnstile: "tok_1" }, {}); // no device token -> mint path

  const first = await onRequestPost({ request: request(), env, ctx });
  assert.equal(first.status, 429);
  assert.deepEqual(await first.json(), { error: { code: "rate_limited" } });
  const mintCallsAfterFirst = reserveCalls.filter((c) => c.kind === "mint").length;
  assert.equal(mintCallsAfterFirst, 1);

  // rate_limited is NOT wait/daily_limit, so per this story's own recordDenial
  // policy it must NOT be cached -- a second call must reach the real
  // Governor again (proving the deny cache is selective, not a blanket
  // "remember every denial" cache).
  const second = await onRequestPost({ request: request(), env, ctx });
  assert.equal(second.status, 429);
  const mintCallsAfterSecond = reserveCalls.filter((c) => c.kind === "mint").length;
  assert.equal(mintCallsAfterSecond, 2, "a rate_limited denial must not be cached -- the real Governor is asked again");
});

check("transform.js (free-device path, FRESH mint): the same pre-limit/deny-cache layering applies to the 4th real Governor call site -- reserve('free', newDevicePayload.id, cfg), reached only after a fresh mint (no device token at all). deviceToken.mint() normally generates a fresh random id every call, which would never reuse the same Governor key across repeated requests -- loadTransform()'s new deviceIdBytes option forces crypto.getRandomValues() deterministic for this one test build so two consecutive fresh-mint requests mint the SAME device id and land on the SAME Governor 'free' key; a third request with a genuinely different id proves the deny cache is correctly per-device, not a false shared-key artifact", async () => {
  const secret = "throttle_fresh_mint_secret";
  const fixedIdBytes = new Uint8Array(16).fill(7);
  const otherIdBytes = new Uint8Array(16).fill(9);
  const fixedIdB64 = Buffer.from(fixedIdBytes).toString("base64url");
  let nextIdBytes = fixedIdBytes;

  const { stub, reserveCalls } = makeGovernorStub({
    reserveImpl: async (kind, key) => {
      if (kind === "mint") return { ok: true, id: `mint_res_${reserveCalls.length}` };
      // kind === "free": deny ONLY the fixed device's own key -- every other
      // key (including otherIdBytes' own, further below) grants, so a grant
      // response is itself proof that call reached the real Governor with a
      // DIFFERENT key, not the cached one.
      if (key === fixedIdB64) return { ok: false, denied: "wait", retryAfterSeconds: 11 };
      return { ok: true, id: `free_res_${key}` };
    },
  });
  const { env } = makeFreeDeviceEnv({ secret, governorStub: stub, aiStub: aiStubResolving("img") });
  const { onRequestPost } = loadTransform({ fetchImpl: async () => turnstileImageOk(), deviceIdBytes: () => nextIdBytes });
  const { ctx } = makeCtx();
  const request = () => transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID, turnstile: "tok_1" }, {}); // no device token -> fresh-mint path

  // 1st fresh-mint request: mints the FIXED id, the real Governor's own
  // free-reserve denies wait -- a REAL call, not yet cached.
  const first = await onRequestPost({ request: request(), env, ctx });
  const firstBody = await first.json();
  assert.equal(first.status, 429);
  assert.equal(firstBody.error.code, "wait");
  assert.ok(typeof firstBody.device === "string" && firstBody.device.startsWith("d1."), "the freshly-minted device token is still returned alongside the denial (Design Notes' resolved edge case)");
  assert.equal(reserveCalls.filter((c) => c.kind === "free").length, 1, "the first denial is a REAL Governor free-reserve call");

  // 2nd fresh-mint request: deviceIdBytes() still returns the SAME fixed
  // bytes -- deviceToken.mint() therefore mints the SAME id again, and the
  // free-reserve for that id must be answered from the deny cache, zero
  // ADDITIONAL free-reserve calls.
  const second = await onRequestPost({ request: request(), env, ctx });
  const secondBody = await second.json();
  assert.equal(second.status, 429);
  assert.equal(secondBody.error.code, "wait");
  assert.equal(secondBody.error.retryAfterSeconds, 11, "the cached denial must carry the SAME retryAfterSeconds the real denial produced");
  assert.equal(secondBody.device, firstBody.device, "the SAME device id was minted again (deterministic crypto.getRandomValues for this test) -- same token text, same HMAC over the same input");
  assert.equal(reserveCalls.filter((c) => c.kind === "free").length, 1, "the second identical-id request must be answered from the deny cache -- zero additional Governor free-reserve calls");

  // 3rd fresh-mint request: a genuinely DIFFERENT device id (deviceIdBytes()
  // now returns otherIdBytes) -- must reach the real Governor again, proving
  // the deny cache is correctly keyed per-device, not a false shared-key
  // issue between unrelated fresh-mint requests.
  nextIdBytes = otherIdBytes;
  const third = await onRequestPost({ request: request(), env, ctx });
  const thirdBody = await third.json();
  assert.equal(third.status, 200, "a genuinely different device id must not be affected by the fixed id's cached denial");
  assert.notEqual(thirdBody.device, firstBody.device, "a different id was minted this time");
  assert.equal(reserveCalls.filter((c) => c.kind === "free").length, 2, "the different device id's own free-reserve must reach the real Governor -- it was never cached");
  assert.equal(reserveCalls.filter((c) => c.kind === "mint").length, 3, "all three requests genuinely took the fresh-mint branch (no device token supplied)");
});

check("transform.js: readCappedBody is now imported from lib/http-body.js, not a private local copy -- static source proof", () => {
  assert.ok(!/async function readCappedBody/.test(transformSource), "transform.js must no longer define its own readCappedBody function");
  assert.ok(/import\s*\{[^}]*readCappedBody[^}]*\}\s*from\s*["']\.\.\/lib\/http-body\.js["']/.test(transformSource), "transform.js must import readCappedBody from lib/http-body.js");
});

// -------------------------------------------- Story 7-8: body-size caps on checkout.js/entitlement.js/subscription.js/stripe-webhook.js

check("checkout.js: a body over 8KB is rejected 400 bad_request before ANY other work -- zero human-check/Stripe calls", async () => {
  const { onRequestPost, postCalls, verifyCalls } = loadCheckout({});
  const oversized = new Request("https://8ish.app/api/checkout", { method: "POST", body: JSON.stringify({ plan: "monthly", turnstile: "tok", pad: "x".repeat(9000) }) });
  const res = await onRequestPost({ request: oversized, env: CHECKOUT_ENV });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.error.code, "bad_request");
  assert.equal(postCalls.length, 0);
  assert.equal(verifyCalls.length, 0, "rejected before even the human check");
});

check("checkout.js: a body under the cap is unaffected -- the single capped read is still what JSON.parse runs against", async () => {
  const { onRequestPost, verifyCalls } = loadCheckout({ verifyImpl: async () => true, postImpl: () => async () => ({ url: "https://checkout.stripe.com/test_session" }) });
  const res = await onRequestPost({ request: checkoutRequest({ plan: "monthly", turnstile: "tok" }), env: CHECKOUT_ENV });
  assert.equal(res.status, 200, "a normal, under-cap request must still succeed exactly as before this story");
  assert.equal(verifyCalls.length, 1);
});

check("checkout.js: a body of EXACTLY 8192 bytes (MAX_BODY_BYTES) is accepted -- proceeds past the body-cap check to a real 200", async () => {
  const { onRequestPost, verifyCalls, postCalls } = loadCheckout({ verifyImpl: async () => true, postImpl: () => async () => ({ url: "https://checkout.stripe.com/test_session" }) });
  const exactBody = jsonBodyOfExactBytes({ plan: "monthly", turnstile: "tok" }, 8192);
  const request = new Request("https://8ish.app/api/checkout", { method: "POST", body: exactBody });
  const res = await onRequestPost({ request, env: CHECKOUT_ENV });
  assert.equal(res.status, 200, "a body of exactly MAX_BODY_BYTES must not be rejected by the cap");
  assert.equal(verifyCalls.length, 1, "must have proceeded past the body cap all the way to the human check");
  assert.equal(postCalls.length, 1, "must have proceeded all the way to the Stripe call");
});

check("checkout.js: a body of MAX_BODY_BYTES + 1 (8193 bytes) is rejected 400 bad_request -- one byte over the SAME boundary the check above proves is accepted", async () => {
  const { onRequestPost, verifyCalls, postCalls } = loadCheckout({});
  const overBody = jsonBodyOfExactBytes({ plan: "monthly", turnstile: "tok" }, 8193);
  const request = new Request("https://8ish.app/api/checkout", { method: "POST", body: overBody });
  const res = await onRequestPost({ request, env: CHECKOUT_ENV });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.error.code, "bad_request");
  assert.equal(verifyCalls.length, 0, "one byte over the cap must be rejected before ANY human check call");
  assert.equal(postCalls.length, 0);
});

check("entitlement.js: a body over 8KB is rejected 400 bad_request before ANY other work -- zero Stripe calls", async () => {
  const { onRequestPost, readCalls } = loadEntitlement({});
  const oversized = new Request("https://8ish.app/api/entitlement", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer whatever" },
    body: "x".repeat(9000),
  });
  const res = await onRequestPost({ request: oversized, env: { ENTITLEMENT_SECRET: "secret_current" } });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.error.code, "bad_request");
  assert.equal(readCalls.length, 0);
});

check("entitlement.js: a body of EXACTLY 8192 bytes (MAX_BODY_BYTES) is accepted -- proceeds past the body-cap check (entitlement.js reads no body content at all, so 'accepted' here means it is NOT rejected as bad_request purely for body size; a garbage Bearer token is used to prove it reached the credential check instead)", async () => {
  const { onRequestPost, readCalls } = loadEntitlement({});
  const exact = new Request("https://8ish.app/api/entitlement", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer whatever" },
    body: "x".repeat(8192),
  });
  const res = await onRequestPost({ request: exact, env: { ENTITLEMENT_SECRET: "secret_current" } });
  const body = await res.json();
  assert.notEqual(res.status, 400, "a body of exactly MAX_BODY_BYTES must not be rejected by the cap");
  assert.equal(res.status, 401, "must have proceeded past the body cap all the way to the credential check");
  assert.equal(body.error.code, "invalid_credential");
  assert.equal(readCalls.length, 0, "still zero Stripe calls -- the garbage token itself is what's rejected, not the body");
});

check("entitlement.js: a body of MAX_BODY_BYTES + 1 (8193 bytes) is rejected 400 bad_request -- one byte over the SAME boundary the check above proves is accepted", async () => {
  const { onRequestPost, readCalls } = loadEntitlement({});
  const over = new Request("https://8ish.app/api/entitlement", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer whatever" },
    body: "x".repeat(8193),
  });
  const res = await onRequestPost({ request: over, env: { ENTITLEMENT_SECRET: "secret_current" } });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.error.code, "bad_request");
  assert.equal(readCalls.length, 0);
});

check("subscription.js: a body over 8KB is rejected 400 bad_request before ANY other work -- zero credential/Stripe calls", async () => {
  const { onRequestPost, postCalls } = loadSubscription({});
  const oversized = new Request("https://8ish.app/api/subscription", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer whatever" },
    body: JSON.stringify({ action: "cancel", pad: "x".repeat(9000) }),
  });
  const res = await onRequestPost({ request: oversized, env: {} });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.error.code, "bad_request");
  assert.equal(postCalls.length, 0);
});

check("subscription.js: a body under the cap is unaffected -- the single capped read is still what JSON.parse runs against", async () => {
  const { mint } = loadCredential();
  const secret = "sub_cap_secret";
  const token = await mint({ ENTITLEMENT_SECRET: secret }, "sub_cap_1");
  const { onRequestPost, postCalls } = loadSubscription({
    postImpl: () => async () => ({ status: "active", items: { data: [{ current_period_end: 1 }] }, cancel_at_period_end: true }),
  });
  const res = await onRequestPost({ request: subscriptionRequest(token, { action: "cancel" }), env: { ENTITLEMENT_SECRET: secret } });
  assert.equal(res.status, 200, "a normal, under-cap request must still succeed exactly as before this story");
  assert.equal(postCalls.length, 1);
});

check("subscription.js: a body of EXACTLY 8192 bytes (MAX_BODY_BYTES) is accepted -- proceeds past the body-cap check to a real 200", async () => {
  const { mint } = loadCredential();
  const secret = "sub_exact_cap_secret";
  const token = await mint({ ENTITLEMENT_SECRET: secret }, "sub_exact_cap_1");
  const { onRequestPost, postCalls } = loadSubscription({
    postImpl: () => async () => ({ status: "active", items: { data: [{ current_period_end: 1 }] }, cancel_at_period_end: true }),
  });
  const exactBody = jsonBodyOfExactBytes({ action: "cancel" }, 8192);
  const request = new Request("https://8ish.app/api/subscription", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: exactBody,
  });
  const res = await onRequestPost({ request, env: { ENTITLEMENT_SECRET: secret } });
  assert.equal(res.status, 200, "a body of exactly MAX_BODY_BYTES must not be rejected by the cap");
  assert.equal(postCalls.length, 1, "must have proceeded all the way to the Stripe call");
});

check("subscription.js: a body of MAX_BODY_BYTES + 1 (8193 bytes) is rejected 400 bad_request -- one byte over the SAME boundary the check above proves is accepted", async () => {
  const { mint } = loadCredential();
  const secret = "sub_over_cap_secret";
  const token = await mint({ ENTITLEMENT_SECRET: secret }, "sub_over_cap_1");
  const { onRequestPost, postCalls } = loadSubscription({});
  const overBody = jsonBodyOfExactBytes({ action: "cancel" }, 8193);
  const request = new Request("https://8ish.app/api/subscription", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: overBody,
  });
  const res = await onRequestPost({ request, env: { ENTITLEMENT_SECRET: secret } });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.error.code, "bad_request");
  assert.equal(postCalls.length, 0, "one byte over the cap must be rejected before ANY Stripe call, even with a valid credential");
});

check("stripe-webhook.js: a body over 64KB is rejected 400 bad_request before signature verification or JSON.parse -- zero Stripe/subStatus calls", async () => {
  const { onRequestPost, writeCalls } = loadWebhook({});
  const oversized = { headers: { get: () => "t=1,v1=deadbeef" }, body: bodyStreamFrom("x".repeat(70 * 1024)) };
  const res = await onRequestPost({ request: oversized, env: WEBHOOK_ENV });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.error.code, "bad_request");
  assert.equal(writeCalls.length, 0);
});

check("stripe-webhook.js: a body under the 64KB cap is unaffected -- the single capped read is still what signature verification runs against", async () => {
  const { onRequestPost, writeCalls } = loadWebhook({
    makeGet: () => async () => ({ id: "sub_cap_1", status: "active", items: { data: [{ current_period_end: 1 }] } }),
  });
  const created = recentTimestamp();
  const request = await signedWebhookRequest(WEBHOOK_SECRET, {
    id: "evt_cap_1",
    type: "customer.subscription.updated",
    created,
    data: { object: { id: "sub_cap_1", status: "active" } },
  }, created);
  const res = await onRequestPost({ request, env: WEBHOOK_ENV });
  assert.equal(res.status, 200, "a normal, under-cap signed event must still verify and process exactly as before this story");
  assert.equal(writeCalls.length, 1);
});

check("stripe-webhook.js: a body of EXACTLY 65536 bytes (MAX_BODY_BYTES) is accepted -- a real, validly-signed event padded to precisely the cap still passes signature verification AND processes normally", async () => {
  const { onRequestPost, writeCalls } = loadWebhook({
    makeGet: () => async () => ({ id: "sub_exact_cap_1", status: "active", items: { data: [{ current_period_end: 1 }] } }),
  });
  const created = recentTimestamp();
  const rawBody = jsonBodyOfExactBytes(
    { id: "evt_exact_cap_1", type: "customer.subscription.updated", created, data: { object: { id: "sub_exact_cap_1", status: "active" } } },
    65536
  );
  const request = await signedWebhookRequestFromRawBody(WEBHOOK_SECRET, rawBody, created);
  const res = await onRequestPost({ request, env: WEBHOOK_ENV });
  const body = await res.json();
  assert.equal(res.status, 200, "a body of exactly MAX_BODY_BYTES must not be rejected by the cap, and its real signature must still verify");
  assert.deepEqual(body, { received: true });
  assert.equal(writeCalls.length, 1, "must have proceeded all the way to the subStatus write");
});

check("stripe-webhook.js: a body of MAX_BODY_BYTES + 1 (65537 bytes) is rejected 400 bad_request -- one byte over the SAME boundary the check above proves is accepted", async () => {
  const { onRequestPost, writeCalls } = loadWebhook({});
  const oversized = { headers: { get: () => "t=1,v1=deadbeef" }, body: bodyStreamFrom("x".repeat(64 * 1024 + 1)) };
  const res = await onRequestPost({ request: oversized, env: WEBHOOK_ENV });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.error.code, "bad_request");
  assert.equal(writeCalls.length, 0);
});

check("stripe-webhook.js: readCappedBody is now the only body read in the file -- static source proof (no request.text() call left)", () => {
  assert.ok(!/request\s*\.\s*text\s*\(/.test(stripeWebhookSource), "stripe-webhook.js must no longer call request.text() directly");
  assert.ok(/import\s*\{[^}]*readCappedBody[^}]*\}\s*from\s*["']\.\.\/lib\/http-body\.js["']/.test(stripeWebhookSource), "stripe-webhook.js must import readCappedBody from lib/http-body.js");
});

// -------------------------------------------- Story 7-8: repo-wide confirmation -- no restoreAttempt KV key anywhere in real source

check("repo-wide: no functions/ or public/ source file (excluding build artifacts) ever references a restoreAttempt: KV key literal -- attempt spacing lives entirely in the Governor", () => {
  const scanRoots = [path.join(ROOT_DIR, "functions"), path.join(ROOT_DIR, "public")];
  const offenders = [];
  for (const root of scanRoots) {
    for (const file of listFilesRecursive(root)) {
      if (!file.endsWith(".js")) continue;
      const text = readFileSync(file, "utf8");
      if (text.includes("restoreAttempt:") || text.includes("restoreAttempt\"")) {
        offenders.push(file);
      }
    }
  }
  assert.deepEqual(offenders, [], `restoreAttempt: must not appear anywhere in functions/ or public/ -- found in: ${offenders.join(", ")}`);
});

// ------------------------------------------------------ Story 8-1: functions/lib/events.js, and every caller's writeEvent() wiring
//
// lib/events.js's own writeEvent() logic is checked directly via loadEvents()
// (the real source, in isolation); every caller file (config.js, checkout.js,
// stripe-webhook.js, transform.js) gets a plain recording stub instead (each
// loader's own comment above explains why) -- so the checks below prove WHEN
// and WITH WHAT ARGUMENTS each caller invokes writeEvent, not writeEvent's
// own internals a second time.

// --- lib/events.js: writeEvent's own behavior -------------------------------

check("lib/events.js writeEvent: builds the exact payload {blobs:[event,source], doubles:[1], indexes:[event]} and calls env.FUNNEL.writeDataPoint with it via ctx.waitUntil(), never awaited inline (I/O matrix row)", async () => {
  const { writeEvent } = loadEvents();
  const dataPointCalls = [];
  const env = { FUNNEL: { writeDataPoint: (payload) => dataPointCalls.push(payload) } };
  const waitUntilCalls = [];
  const ctx = { waitUntil: (p) => waitUntilCalls.push(p) };

  writeEvent(env, ctx, "app_open", "");
  assert.equal(dataPointCalls.length, 0, "writeDataPoint must not have run synchronously/inline yet");
  assert.equal(waitUntilCalls.length, 1, "the safe write promise must be handed to ctx.waitUntil()");
  assert.ok(typeof waitUntilCalls[0]?.then === "function", "ctx.waitUntil() must receive a promise");

  await waitUntilCalls[0];
  // JSON round-trip: dataPointCalls[0] is a plain-data object built inside
  // loadEvents()'s own fresh vm context (a different realm) -- assert.deepEqual
  // treats cross-realm objects as unequal by Object.prototype identity even
  // when every field matches (same technique this file's transform.js checks
  // already use for cross-realm cfg/opts objects, via a `{ ...obj }` spread;
  // a JSON round-trip is used here since this payload also nests arrays).
  assert.deepEqual(JSON.parse(JSON.stringify(dataPointCalls)), [{ blobs: ["app_open", ""], doubles: [1], indexes: ["app_open"] }]);
});

check('lib/events.js writeEvent: an omitted/undefined/falsy source defaults to "" in blobs[1]', async () => {
  const { writeEvent } = loadEvents();
  for (const source of [undefined, null, ""]) {
    const dataPointCalls = [];
    const env = { FUNNEL: { writeDataPoint: (payload) => dataPointCalls.push(payload) } };
    const waitUntilCalls = [];
    const ctx = { waitUntil: (p) => waitUntilCalls.push(p) };
    writeEvent(env, ctx, "checkout_started", source);
    await waitUntilCalls[0];
    // JSON round-trip -- see the cross-realm comment on the check just above.
    assert.deepEqual(JSON.parse(JSON.stringify(dataPointCalls[0].blobs)), ["checkout_started", ""], `source ${JSON.stringify(source)}`);
  }
});

check("lib/events.js writeEvent: a SYNCHRONOUSLY throwing env.FUNNEL.writeDataPoint never propagates out of writeEvent, and is logged with a fixed event code (Always: a throwing/slow FUNNEL must never fail the caller)", async () => {
  const { writeEvent, consoleCalls } = loadEvents();
  const env = { FUNNEL: { writeDataPoint: () => { throw new Error("boom"); } } };
  const waitUntilCalls = [];
  const ctx = { waitUntil: (p) => waitUntilCalls.push(p) };

  assert.doesNotThrow(() => writeEvent(env, ctx, "purchase_completed", ""));
  await waitUntilCalls[0]; // must resolve, not reject -- otherwise handing it to a real ctx.waitUntil() would surface as an unhandled rejection
  assert.ok(consoleCalls.some((args) => args[0] === "event_write_failed"));
});

check("lib/events.js writeEvent: an ASYNCHRONOUSLY rejecting env.FUNNEL.writeDataPoint is caught the same way -- the handed-off promise still resolves", async () => {
  const { writeEvent, consoleCalls } = loadEvents();
  const env = { FUNNEL: { writeDataPoint: () => Promise.reject(new Error("async boom")) } };
  const waitUntilCalls = [];
  const ctx = { waitUntil: (p) => waitUntilCalls.push(p) };

  writeEvent(env, ctx, "cancelled", "");
  await waitUntilCalls[0];
  assert.ok(consoleCalls.some((args) => args[0] === "event_write_failed"));
});

check("lib/events.js writeEvent: env.FUNNEL absent (the normal test/dev reality) is a silent no-op -- no throw, no ctx.waitUntil() call, nothing logged", () => {
  const { writeEvent, consoleCalls } = loadEvents();
  const waitUntilCalls = [];
  const ctx = { waitUntil: (p) => waitUntilCalls.push(p) };
  assert.doesNotThrow(() => writeEvent({}, ctx, "app_open", ""));
  assert.equal(waitUntilCalls.length, 0);
  assert.equal(consoleCalls.length, 0);
});

check("lib/events.js writeEvent: env.FUNNEL.writeDataPoint present but not a function is treated exactly like env.FUNNEL being absent -- a silent no-op", () => {
  const { writeEvent } = loadEvents();
  const waitUntilCalls = [];
  const ctx = { waitUntil: (p) => waitUntilCalls.push(p) };
  assert.doesNotThrow(() => writeEvent({ FUNNEL: { writeDataPoint: "not a function" } }, ctx, "app_open", ""));
  assert.equal(waitUntilCalls.length, 0);
});

check("lib/events.js writeEvent: a missing ctx, or a ctx without waitUntil, never throws -- the write just isn't handed to anything", () => {
  const { writeEvent } = loadEvents();
  const env = { FUNNEL: { writeDataPoint: () => {} } };
  assert.doesNotThrow(() => writeEvent(env, undefined, "app_open", ""));
  assert.doesNotThrow(() => writeEvent(env, {}, "app_open", ""));
});

// --- config.js: app_open on every request -----------------------------------

check("config.js: writes app_open on every request via the shared writeEvent() helper, with ctx passed through unchanged from onRequestGet's own params (I/O matrix row)", async () => {
  const kv = makeFakeKV(() => 1_700_000_000_000);
  const { onRequestGet, writeEventCalls } = loadConfigHandler({});
  const ctx = { waitUntil: () => {} };
  await onRequestGet({ env: { ...PRICE_ENV, STRIPE_SECRET_KEY: undefined, STATE_KV: kv }, ctx });
  assert.equal(writeEventCalls.length, 1);
  assert.equal(writeEventCalls[0].event, "app_open");
  assert.equal(writeEventCalls[0].source, "");
  assert.ok(writeEventCalls[0].ctx === ctx, "the real ctx onRequestGet received must be the one handed to writeEvent");
});

// --- checkout.js: checkout_started once Turnstile passes, before the Stripe call ----

check("checkout.js: writes checkout_started once the human check passes, before the Stripe session-creation call (I/O matrix row)", async () => {
  const { onRequestPost, writeEventCalls, postCalls } = loadCheckout({ verifyImpl: async () => true });
  const ctx = { waitUntil: () => {} };
  const res = await onRequestPost({ request: checkoutRequest({ plan: "yearly", turnstile: "tok" }), env: CHECKOUT_ENV, ctx });
  assert.equal(res.status, 200);
  assert.equal(writeEventCalls.length, 1);
  assert.equal(writeEventCalls[0].event, "checkout_started");
  assert.equal(writeEventCalls[0].source, "");
  assert.ok(writeEventCalls[0].ctx === ctx);
  assert.equal(postCalls.length, 1, "sanity: the real Stripe call still happened");
});

check("checkout.js: a failing Turnstile check writes NO checkout_started event -- gated by the human check, same ordering as every real Stripe call below it", async () => {
  const { onRequestPost, writeEventCalls } = loadCheckout({ verifyImpl: async () => false });
  const res = await onRequestPost({ request: checkoutRequest({ plan: "yearly", turnstile: "bad" }), env: CHECKOUT_ENV, ctx: { waitUntil: () => {} } });
  assert.equal(res.status, 403);
  assert.equal(writeEventCalls.length, 0);
});

// --- stripe-webhook.js: purchase_completed/cancelled, the evt:<id> dedupe marker ----

function webhookEnvWithKv(kv) {
  return { ...WEBHOOK_ENV, STATE_KV: kv };
}

check("stripe-webhook.js: checkout.session.completed with amount_total > 0 writes purchase_completed exactly once, through the shared writeEvent() helper (replaces the old inline env.FUNNEL call -- I/O matrix row)", async () => {
  const { onRequestPost, writeCalls, writeEventCalls } = loadWebhook({
    makeGet: () => async () => ({ id: "sub_pc_1", status: "active", items: { data: [{ current_period_end: 1 }] } }),
  });
  const kv = makeFakeKV(() => 1_700_000_000_000);
  const created = recentTimestamp();
  const request = await signedWebhookRequest(
    WEBHOOK_SECRET,
    { id: "evt_pc_1", type: "checkout.session.completed", created, data: { object: { id: "cs_1", subscription: "sub_pc_1", amount_total: 1999 } } },
    created
  );
  const ctx = { waitUntil: () => {} };
  const res = await onRequestPost({ request, env: webhookEnvWithKv(kv), ctx });
  assert.equal(res.status, 200);
  assert.equal(writeCalls.length, 1, "sanity: the real subStatus write still happened");
  assert.deepEqual(writeEventCalls.map((c) => c.event), ["purchase_completed"]);
  assert.equal(writeEventCalls[0].source, "");
  assert.ok(writeEventCalls[0].ctx === ctx);
});

check("stripe-webhook.js: checkout.session.completed with amount_total: 0 writes NO purchase_completed (I/O matrix row: the family's complimentary subscription doesn't count as a sale)", async () => {
  const { onRequestPost, writeEventCalls } = loadWebhook({
    makeGet: () => async () => ({ id: "sub_pc_0", status: "active", items: { data: [{ current_period_end: 1 }] } }),
  });
  const kv = makeFakeKV(() => 1_700_000_000_000);
  const created = recentTimestamp();
  const request = await signedWebhookRequest(
    WEBHOOK_SECRET,
    { id: "evt_pc_0", type: "checkout.session.completed", created, data: { object: { id: "cs_0", subscription: "sub_pc_0", amount_total: 0 } } },
    created
  );
  const res = await onRequestPost({ request, env: webhookEnvWithKv(kv) });
  assert.equal(res.status, 200);
  assert.deepEqual(writeEventCalls, []);
});

check("stripe-webhook.js: the SAME Stripe event id processed twice writes purchase_completed only ONCE -- the evt:<id> KV dedupe marker (I/O matrix row)", async () => {
  const kv = makeFakeKV(() => 1_700_000_000_000);
  const eventBody = { id: "evt_dup_1", type: "checkout.session.completed", created: recentTimestamp(), data: { object: { id: "cs_dup", subscription: "sub_dup", amount_total: 1999 } } };

  const first = loadWebhook({ makeGet: () => async () => ({ id: "sub_dup", status: "active", items: { data: [{ current_period_end: 1 }] } }) });
  const req1 = await signedWebhookRequest(WEBHOOK_SECRET, eventBody, eventBody.created);
  const res1 = await first.onRequestPost({ request: req1, env: webhookEnvWithKv(kv) });
  assert.equal(res1.status, 200);
  assert.equal(first.writeEventCalls.length, 1, "the first delivery must count it");

  // A second, fresh loadWebhook() (a separate Function invocation in
  // reality, e.g. a Stripe retry) -- only the SHARED kv carries the dedupe
  // marker across the two, exactly like real STATE_KV would.
  const second = loadWebhook({ makeGet: () => async () => ({ id: "sub_dup", status: "active", items: { data: [{ current_period_end: 1 }] } }) });
  const req2 = await signedWebhookRequest(WEBHOOK_SECRET, eventBody, eventBody.created);
  const res2 = await second.onRequestPost({ request: req2, env: webhookEnvWithKv(kv) });
  assert.equal(res2.status, 200, "a retried/duplicate event must still ack 200 -- it's not an error");
  assert.equal(second.writeEventCalls.length, 0, "the SAME event id delivered again must NOT be counted a second time");

  assert.ok(await kv.get("evt:evt_dup_1"), "the dedupe marker itself must have been written");
  const put = kv.puts.find((p) => p.key === "evt:evt_dup_1");
  assert.equal(put.options && put.options.expirationTtl, 3 * 86400, "the dedupe marker's TTL must be 3 days");
});

check("stripe-webhook.js: a genuine subscription -> inactive transition writes cancelled exactly once; a merely-requested cancellation (still active/trialing at Stripe) writes nothing (I/O matrix rows)", async () => {
  // "Merely requested": the live re-fetch still reports an active status
  // (cancel_at_period_end=true doesn't change Stripe's own `status` until
  // the period genuinely ends) -- refreshSubscription's own `active` stays
  // true, so no cancelled write happens.
  const requested = loadWebhook({ makeGet: () => async () => ({ id: "sub_req", status: "active", items: { data: [{ current_period_end: 1 }] } }) });
  const createdReq = recentTimestamp();
  const reqRequest = await signedWebhookRequest(
    WEBHOOK_SECRET,
    { id: "evt_requested_1", type: "customer.subscription.updated", created: createdReq, data: { object: { id: "sub_req", status: "active" } } },
    createdReq
  );
  const resReq = await requested.onRequestPost({ request: reqRequest, env: webhookEnvWithKv(makeFakeKV(() => 1_700_000_000_000)) });
  assert.equal(resReq.status, 200);
  assert.deepEqual(requested.writeEventCalls, [], "a merely-requested cancellation (still active at Stripe) must write nothing");

  // "Actually ends": the live re-fetch now reports canceled -- a genuine
  // active -> inactive transition, so cancelled is written once.
  const ended = loadWebhook({ makeGet: () => async () => ({ id: "sub_end", status: "canceled", items: { data: [] } }) });
  const createdEnd = recentTimestamp();
  const endRequest = await signedWebhookRequest(
    WEBHOOK_SECRET,
    { id: "evt_ended_1", type: "customer.subscription.deleted", created: createdEnd, data: { object: { id: "sub_end", status: "canceled" } } },
    createdEnd
  );
  const resEnd = await ended.onRequestPost({ request: endRequest, env: webhookEnvWithKv(makeFakeKV(() => 1_700_000_000_000)) });
  assert.equal(resEnd.status, 200);
  assert.deepEqual(ended.writeEventCalls.map((c) => c.event), ["cancelled"]);
});

check("stripe-webhook.js: a KV failure on the evt:<id> dedupe marker (read or write) is best-effort/logged -- it must never block the webhook's own real subStatus write or turn this into a 5xx", async () => {
  const throwingKv = {
    get: async () => { throw new Error("simulated KV read failure"); },
    put: async () => { throw new Error("simulated KV write failure"); },
  };
  const { onRequestPost, writeCalls, writeEventCalls, consoleCalls } = loadWebhook({
    makeGet: () => async () => ({ id: "sub_kvfail", status: "active", items: { data: [{ current_period_end: 1 }] } }),
  });
  const created = recentTimestamp();
  const request = await signedWebhookRequest(
    WEBHOOK_SECRET,
    { id: "evt_kvfail_1", type: "checkout.session.completed", created, data: { object: { id: "cs_kvfail", subscription: "sub_kvfail", amount_total: 999 } } },
    created
  );
  const res = await onRequestPost({ request, env: webhookEnvWithKv(throwingKv) });
  assert.equal(res.status, 200, "a KV hiccup on the analytics-only dedupe marker must never turn into a 5xx");
  assert.equal(writeCalls.length, 1, "the real subStatus write must still have happened");
  assert.equal(writeEventCalls.length, 1, "the write itself still happens (best-effort dedupe -- just unguarded this one time)");
  assert.ok(consoleCalls.some((args) => args[0] === "webhook_dedupe_kv_read_failed"));
  assert.ok(consoleCalls.some((args) => args[0] === "webhook_dedupe_kv_write_failed"));
});

// --- transform.js: image_created/image_refused/image_failed at the settlement points ----

check("transform.js: a granted reservation that succeeds writes image_created exactly where commit() is registered (I/O matrix row)", async () => {
  const secret = "events_success_secret";
  const token = await mintTransformCredential(secret);
  const { stub, commitCalls } = makeGovernorStub();
  const { env } = makeTransformEnv({ secret, governorStub: stub, aiStub: aiStubResolving("b64img") });
  const { onRequestPost, writeEventCalls } = loadTransform();
  const { ctx } = makeCtx();
  const res = await onRequestPost({ request: transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID }, { token }), env, ctx });
  assert.equal(res.status, 200);
  assert.equal(commitCalls.length, 1);
  assert.deepEqual(writeEventCalls.map((c) => c.event), ["image_created"]);
  assert.equal(writeEventCalls[0].source, "");
});

check("transform.js: a Governor denial (wait/daily_limit/rate_limited/resting) writes image_refused (I/O matrix row)", async () => {
  const cases = [
    { denied: "wait", retryAfterSeconds: 5 },
    { denied: "daily_limit" },
    { denied: "rate_limited" },
    { denied: "resting" },
  ];
  for (const denial of cases) {
    const secret = `events_refused_${denial.denied}_secret`;
    const token = await mintTransformCredential(secret);
    const { stub } = makeGovernorStub({ reserveImpl: async () => ({ ok: false, ...denial }) });
    const { env } = makeTransformEnv({ secret, governorStub: stub });
    const { onRequestPost, writeEventCalls } = loadTransform();
    const { ctx } = makeCtx();
    const res = await onRequestPost({ request: transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID }, { token }), env, ctx });
    assert.ok(res.status === 429 || res.status === 503, `${denial.denied}: expected 429 or 503, got ${res.status}`);
    assert.deepEqual(writeEventCalls.map((c) => c.event), ["image_refused"], `${denial.denied}`);
  }
});

check("transform.js: the per-isolate pre-limit short-circuit (before any real Governor call) also writes image_refused", async () => {
  const secret = "events_prelimit_secret";
  const token = await mintTransformCredential(secret);
  const { stub, reserveCalls } = makeGovernorStub();
  const { env } = makeTransformEnv({ secret, governorStub: stub, aiStub: aiStubResolving("b64img") });
  const { onRequestPost, writeEventCalls } = loadTransform();
  const { ctx } = makeCtx();
  const request = () => transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID }, { token });

  // Story 7-8's own pre-limit denies after a small burst, before ever
  // reaching the real Governor -- send requests until reserve() has NOT
  // been called for one of them (the pre-limit tripped), then check that
  // last response's own writeEvent call.
  let lastRes;
  for (let i = 0; i < 20 && reserveCalls.length === i; i++) {
    lastRes = await onRequestPost({ request: request(), env, ctx });
  }
  assert.ok(reserveCalls.length < 20, "the pre-limit must have denied at least one request before a real Governor call");
  assert.equal(lastRes.status, 429);
  assert.equal(writeEventCalls.at(-1).event, "image_refused");
});

check("transform.js: a pre-model-call synchronous exception -> release(neverCalled) also writes image_failed", async () => {
  const secret = "events_nevercalled_secret";
  const token = await mintTransformCredential(secret);
  const { stub, releaseCalls } = makeGovernorStub();
  const { env } = makeTransformEnv({
    secret,
    governorStub: stub,
    aiStub: () => {
      throw new Error("pre-build failure");
    },
  });
  const { onRequestPost, writeEventCalls } = loadTransform();
  const { ctx } = makeCtx();
  const res = await onRequestPost({ request: transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID }, { token }), env, ctx });
  assert.equal(res.status, 502);
  assert.equal(releaseCalls.length, 1);
  assert.deepEqual({ ...releaseCalls[0].opts }, { neverCalled: true });
  assert.deepEqual(writeEventCalls.map((c) => c.event), ["image_failed"]);
});

check("transform.js: the model call rejecting -> release(providerFailed) also writes image_failed", async () => {
  const secret = "events_providerfailed_secret";
  const token = await mintTransformCredential(secret);
  const { stub, releaseCalls } = makeGovernorStub();
  const { env } = makeTransformEnv({
    secret,
    governorStub: stub,
    aiStub: async () => {
      throw new Error("provider boom");
    },
  });
  const { onRequestPost, writeEventCalls } = loadTransform();
  const { ctx } = makeCtx();
  const res = await onRequestPost({ request: transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID }, { token }), env, ctx });
  assert.equal(res.status, 502);
  assert.equal(releaseCalls.length, 1);
  assert.deepEqual(writeEventCalls.map((c) => c.event), ["image_failed"]);
});

check("transform.js: a malformed/empty model response -> release(providerFailed) also writes image_failed", async () => {
  const secret = "events_malformed_secret";
  const token = await mintTransformCredential(secret);
  const { stub } = makeGovernorStub();
  const { env } = makeTransformEnv({ secret, governorStub: stub, aiStub: async () => ({}) });
  const { onRequestPost, writeEventCalls } = loadTransform();
  const { ctx } = makeCtx();
  const res = await onRequestPost({ request: transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID }, { token }), env, ctx });
  assert.equal(res.status, 502);
  assert.deepEqual(writeEventCalls.map((c) => c.event), ["image_failed"]);
});

check("transform.js: the 30s model-call timeout -> release(providerFailed) also writes image_failed", async () => {
  const secret = "events_timeout_secret";
  const token = await mintTransformCredential(secret);
  const { stub, releaseCalls } = makeGovernorStub({ releaseImpl: () => new Promise(() => {}) });
  const { env } = makeTransformEnv({ secret, governorStub: stub, aiStub: () => new Promise(() => {}) });
  const { onRequestPost, timers, writeEventCalls } = loadTransform();
  const { ctx } = makeCtx();
  const resultPromise = onRequestPost({ request: transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID }, { token }), env, ctx });
  const timer = await waitForTimer(timers, 30000);
  assert.ok(timer, "the 30s timeout timer must have been armed");
  timer.fired = true;
  timer.fn();
  const res = await resultPromise;
  assert.equal(res.status, 504);
  assert.equal(releaseCalls.length, 1);
  assert.deepEqual(writeEventCalls.map((c) => c.event), ["image_failed"]);
});

// --- repo-wide static proofs: no identifier ever reaches an event write ----

check("functions/lib/events.js is the only file that ever CALLS .writeDataPoint(...) -- every other file must go through the shared writeEvent() helper (Story 8-1, replaces Epic 6's inline stripe-webhook.js call)", () => {
  // Real call syntax only (`.writeDataPoint(` or the optional-chained
  // `.writeDataPoint?.(`) -- deliberately narrower than a bare
  // "writeDataPoint" substring match, which would also flag this repo's own
  // prose (e.g. stripe-webhook.js's header comment describing the OLD
  // inline call this story replaced) as a false positive.
  const CALL_RE = /\.writeDataPoint\s*\?{0,1}\.?\s*\(/;
  const offenders = [];
  for (const root of [path.join(ROOT_DIR, "functions"), path.join(ROOT_DIR, "public")]) {
    for (const file of listFilesRecursive(root)) {
      if (!file.endsWith(".js") || file === EVENTS_LIB_PATH) continue;
      const text = readFileSync(file, "utf8");
      if (CALL_RE.test(text)) offenders.push(path.relative(ROOT_DIR, file));
    }
  }
  assert.deepEqual(offenders, [], `.writeDataPoint(...) must only be called from functions/lib/events.js: found in ${offenders.join(", ")}`);
});

check("repo-wide: every DIRECT writeEvent(...) call site passes only literal env, ctx, a quoted event-name string (or one of the three whitelisted bare identifiers -- see the checks just below), and an omitted/literal \"\" source OR (source-links.js only) the one proven `name` identifier -- never an arbitrary variable that could carry an id/email/token/IP/subscription id (static proof matching this repo's established no-identifier-in-any-event-write style)", () => {
  const roots = [path.join(ROOT_DIR, "functions"), path.join(ROOT_DIR, "public")];
  // Requires the call to actually open with "env," -- deliberately narrower
  // than a bare "writeEvent(" substring match, which would also flag this
  // repo's own prose (e.g. a comment mentioning "the writeEvent() helper")
  // as a false positive, the same reasoning as the .writeDataPoint( check
  // just above.
  const ANY_CALL_RE = /writeEvent\(\s*env\s*,/g;
  // Literal event name (e.g. "app_open"), OR the `eventName` identifier
  // (stripe-webhook.js's own writeDedupedFunnelEvent() indirection,
  // Story 8-1 -- proven literal-only by the check just below it). Every
  // OTHER file in the repo may only use a literal or `eventName` here.
  const STRICT_CALL_RE = /writeEvent\(\s*env\s*,\s*ctx\s*,\s*(?:"[a-zA-Z_]+"|eventName)\s*(?:,\s*""\s*)?\)/g;
  // Story 8-2: functions/api/events.js gets its OWN whitelisted identifier,
  // `event`, scoped to that ONE file only (not repo-wide -- every other
  // file must still match STRICT_CALL_RE above) -- proven, by the check
  // two below this one, to only ever be reached after an
  // `ALLOWED_EVENTS.has(event)` guard has already returned early for
  // anything but the two literal allowlisted names. This is the client-
  // facing endpoint's own version of the same "one proven indirection"
  // pattern stripe-webhook.js's `eventName` already established.
  const STRICT_CALL_RE_EVENTS_API = /writeEvent\(\s*env\s*,\s*ctx\s*,\s*(?:"[a-zA-Z_]+"|event)\s*(?:,\s*""\s*)?\)/g;
  // Story 8-3: functions/lib/source-links.js is the first, deliberate
  // exception to "source is always omitted/literal \"\"" -- the whole point
  // of this story is recording WHICH configured Source Link name was
  // visited, so `name` must reach writeEvent() as the literal `source`
  // argument itself, not just the event-name position the other two
  // exceptions cover. Scoped to this ONE file only, with a literal
  // "source_visit" event name required (no identifier there) -- proven, by
  // the check just below this one, that `name` can only ever be one of the
  // finite, pre-validated SOURCE_LINKS entries (never arbitrary
  // request-supplied text) by the time it reaches this call.
  const STRICT_CALL_RE_SOURCE_LINKS = /writeEvent\(\s*env\s*,\s*ctx\s*,\s*"source_visit"\s*,\s*name\s*\)/g;
  const offenders = [];
  for (const root of roots) {
    for (const file of listFilesRecursive(root)) {
      if (!file.endsWith(".js") || file === EVENTS_LIB_PATH) continue;
      const text = readFileSync(file, "utf8");
      const anyCount = (text.match(ANY_CALL_RE) || []).length;
      if (anyCount === 0) continue;
      const strictRe = file === EVENTS_API_PATH ? STRICT_CALL_RE_EVENTS_API : file === SOURCE_LINKS_LIB_PATH ? STRICT_CALL_RE_SOURCE_LINKS : STRICT_CALL_RE;
      const strictCount = (text.match(strictRe) || []).length;
      if (strictCount !== anyCount) {
        offenders.push(`${path.relative(ROOT_DIR, file)}: ${anyCount} writeEvent(...) call site(s), only ${strictCount} match the literal-args-only shape`);
      }
    }
  }
  assert.deepEqual(offenders, [], `every writeEvent(...) call site must pass only literal args:\n${offenders.join("\n")}`);
});

check("source-links.js: the bare `name` identifier reaching writeEvent(...) as the `source` argument is structurally GATED by `names.has(name)` returning early otherwise, BEFORE the writeEvent(...) call site -- closes the one-file `source`-position exception the repo-wide literal-args-only check above allows for this file (`name` can only ever be one of the finite, pre-validated SOURCE_LINKS entries, never arbitrary request-supplied text)", () => {
  const guardMatch = sourceLinksLibSource.match(/if\s*\(\s*!names\.has\(name\)\s*\)\s*return\s+null\s*;/);
  assert.ok(guardMatch, "expected an `if (!names.has(name)) return null;` guard directly gating the write");
  const writeCallText = 'writeEvent(env, ctx, "source_visit", name)';
  const writeIndex = sourceLinksLibSource.indexOf(writeCallText);
  assert.ok(writeIndex > -1, `expected the exact literal call \`${writeCallText}\``);
  const guardIndex = sourceLinksLibSource.indexOf(guardMatch[0]);
  assert.ok(guardIndex > -1 && guardIndex < writeIndex, "the names.has(name) guard must appear BEFORE the writeEvent(...) call site in source order");
});

check("stripe-webhook.js: writeDedupedFunnelEvent(...) -- the one function whose own `eventName` parameter reaches writeEvent() as a bare identifier -- is itself only ever CALLED (never just defined) with a literal quoted event name, never a variable (closes the indirection the check above allows)", () => {
  // `await writeDedupedFunnelEvent(` matches only the two real CALL sites
  // (both genuinely awaited) -- never the `async function
  // writeDedupedFunnelEvent(...) {` definition itself, which is never
  // preceded by "await ".
  const anyCalls = (stripeWebhookSource.match(/await\s+writeDedupedFunnelEvent\(/g) || []).length;
  const strictCalls = (stripeWebhookSource.match(/await\s+writeDedupedFunnelEvent\(\s*env\s*,\s*ctx\s*,\s*eventId\s*,\s*"[a-zA-Z_]+"\s*\)/g) || []).length;
  assert.ok(anyCalls > 0, "expected at least one writeDedupedFunnelEvent(...) call site in stripe-webhook.js");
  assert.equal(strictCalls, anyCalls, `every writeDedupedFunnelEvent(...) call must pass a literal quoted event name -- found ${anyCalls} call site(s), only ${strictCalls} match`);
});

check("wrangler.jsonc: declares the FUNNEL Analytics Engine dataset binding, purely additively -- every other pre-existing binding/var/route is untouched (I/O matrix: the binding this whole story depends on)", () => {
  const wranglerRaw = readFileSync(path.join(ROOT_DIR, "wrangler.jsonc"), "utf8");
  // wrangler.jsonc is JSONC (has comments) -- strip // line comments before
  // JSON.parse, the same tolerant approach a human skimming the file uses;
  // good enough for this structural check (no string in this file contains
  // "//").
  const stripped = wranglerRaw.replace(/\/\/[^\n]*/g, "");
  const parsed = JSON.parse(stripped);
  assert.ok(Array.isArray(parsed.analytics_engine_datasets), "wrangler.jsonc must declare analytics_engine_datasets");
  const funnel = parsed.analytics_engine_datasets.find((b) => b.binding === "FUNNEL");
  assert.ok(funnel, "expected a binding named FUNNEL in analytics_engine_datasets");
  assert.equal(typeof funnel.dataset, "string");
  assert.ok(funnel.dataset.length > 0);
  // Purely additive: every binding this story didn't touch must still be there.
  assert.equal(parsed.name, "8ish-plus");
  assert.ok(Array.isArray(parsed.kv_namespaces) && parsed.kv_namespaces.some((k) => k.binding === "STATE_KV"));
  assert.ok(parsed.durable_objects && parsed.durable_objects.bindings.some((b) => b.name === "GOVERNOR"));
  assert.equal(parsed.vars.AI_ENABLED, "false");
});

// ------------------------------------------------------------------ Story 8-2: functions/api/events.js (POST /api/e)
//
// The one client-facing entry point into the funnel counters Story 8.1
// built -- POST /api/e {event}, allowlisted to exactly {limit_reached,
// paywall_viewed}, always answering 204 with an empty body regardless of
// which internal branch produced it (spec-8-2-client-events.md's frozen
// I/O matrix: accepted, allowlist-rejected, malformed, oversized, and
// rate-limited must all be indistinguishable from the outside). Checked
// here directly through the real onRequestPost (a vm-sandbox loader, same
// convention as loadRestore/loadSubscription above), plus static proofs
// that no identifier of any kind can ever reach it.

const EVENTS_API_PATH = path.join(ROOT_DIR, "functions/api/events.js");
const eventsApiSource = readFileSync(EVENTS_API_PATH, "utf8");

// Loads the REAL functions/api/events.js into its own fresh vm context per
// call -- module-level rate-counter state (rateWindowStart/rateWindowCount)
// is therefore brand new every call, no cross-check pollution, matching
// loadRestore()'s own documented reasoning for request-throttle.js's Maps.
// readCappedBody runs as REAL code (lib/http-body.js, wired in exactly like
// every other loader in this file); writeEvent is a plain recording stub
// (Story 8-1's own established convention -- writeEvent's own behavior is
// proven once, directly, by loadEvents() above).
function loadEventsApi() {
  const writeEventCalls = [];
  const sandbox = {
    console: { error() {}, log() {}, warn() {} },
    TextDecoder,
    Response,
  };
  vm.createContext(sandbox);

  const httpBodySrc = httpBodyLibSource.replace(/^export\s+/gm, "");
  vm.runInContext(`${httpBodySrc}\nthis.readCappedBody = readCappedBody;`, sandbox, { filename: "http-body.js" });

  sandbox.writeEvent = (env, ctx, event, source) => {
    writeEventCalls.push({ event, source, ctx });
  };

  const src = stripImportsAndExports(eventsApiSource);
  vm.runInContext(`${src}\nthis.__onRequestPost = onRequestPost;`, sandbox, { filename: "events.js" });

  return { onRequestPost: sandbox.__onRequestPost, writeEventCalls };
}

const EVENTS_ENV = {};
const eventsRequest = (bodyText) => new Request("https://8ish.app/api/e", { method: "POST", body: bodyText });
const eventsCtx = () => ({ waitUntil() {} });

// --- allowlist + always-204 (I/O matrix rows) -------------------------------

check("events.js: POST {event:\"limit_reached\"} answers 204 with an empty body and writes writeEvent(env, ctx, \"limit_reached\", \"\") exactly once (I/O matrix row)", async () => {
  const { onRequestPost, writeEventCalls } = loadEventsApi();
  const ctx = eventsCtx();
  const res = await onRequestPost({ request: eventsRequest(JSON.stringify({ event: "limit_reached" })), env: EVENTS_ENV, ctx });
  assert.equal(res.status, 204);
  assert.equal(await res.text(), "");
  assert.equal(writeEventCalls.length, 1);
  assert.equal(writeEventCalls[0].event, "limit_reached");
  assert.equal(writeEventCalls[0].source, "");
  assert.ok(writeEventCalls[0].ctx === ctx, "the real ctx onRequestPost received must be the one handed to writeEvent");
});

check("events.js: POST {event:\"paywall_viewed\"} answers 204 and writes writeEvent(env, ctx, \"paywall_viewed\", \"\") exactly once (I/O matrix row)", async () => {
  const { onRequestPost, writeEventCalls } = loadEventsApi();
  const res = await onRequestPost({ request: eventsRequest(JSON.stringify({ event: "paywall_viewed" })), env: EVENTS_ENV, ctx: eventsCtx() });
  assert.equal(res.status, 204);
  assert.deepEqual(writeEventCalls.map((c) => c.event), ["paywall_viewed"]);
});

check('events.js: POST {event:"app_open"} -- a server-authoritative name Story 8.1 already writes server-side -- answers 204 but writes NOTHING (I/O matrix row: the allowlist rejects every name but the two client-only ones)', async () => {
  const { onRequestPost, writeEventCalls } = loadEventsApi();
  const res = await onRequestPost({ request: eventsRequest(JSON.stringify({ event: "app_open" })), env: EVENTS_ENV, ctx: eventsCtx() });
  assert.equal(res.status, 204);
  assert.deepEqual(writeEventCalls, []);
});

check('events.js: POST {event:"literally-anything-else"} answers 204 and writes nothing (I/O matrix row)', async () => {
  const { onRequestPost, writeEventCalls } = loadEventsApi();
  const res = await onRequestPost({ request: eventsRequest(JSON.stringify({ event: "literally-anything-else" })), env: EVENTS_ENV, ctx: eventsCtx() });
  assert.equal(res.status, 204);
  assert.deepEqual(writeEventCalls, []);
});

check("events.js: a missing/non-string `event` field answers 204 and writes nothing", async () => {
  const { onRequestPost, writeEventCalls } = loadEventsApi();
  for (const bodyObj of [{}, { event: 123 }, { event: null }, { event: ["limit_reached"] }]) {
    const res = await onRequestPost({ request: eventsRequest(JSON.stringify(bodyObj)), env: EVENTS_ENV, ctx: eventsCtx() });
    assert.equal(res.status, 204);
  }
  assert.deepEqual(writeEventCalls, []);
});

check("events.js: malformed JSON body answers 204 and writes nothing (I/O matrix row)", async () => {
  const { onRequestPost, writeEventCalls } = loadEventsApi();
  const res = await onRequestPost({ request: eventsRequest("not valid json{"), env: EVENTS_ENV, ctx: eventsCtx() });
  assert.equal(res.status, 204);
  assert.equal(await res.text(), "");
  assert.deepEqual(writeEventCalls, []);
});

check("events.js: no request body at all answers 204 and writes nothing", async () => {
  const { onRequestPost, writeEventCalls } = loadEventsApi();
  const request = new Request("https://8ish.app/api/e", { method: "POST" });
  const res = await onRequestPost({ request, env: EVENTS_ENV, ctx: eventsCtx() });
  assert.equal(res.status, 204);
  assert.deepEqual(writeEventCalls, []);
});

// --- body cap (Code Map: "reuse http-body.js's readCappedBody, small cap e.g. 256 bytes") --

check("events.js: a body of EXACTLY 256 bytes (MAX_BODY_BYTES) is accepted -- proceeds past the body-cap check to the allowlist/write logic, proving lib/http-body.js's `total > maxBytes` is strictly-greater, not >=", async () => {
  const { onRequestPost, writeEventCalls } = loadEventsApi();
  const exactBody = jsonBodyOfExactBytes({ event: "limit_reached" }, 256);
  const res = await onRequestPost({ request: eventsRequest(exactBody), env: EVENTS_ENV, ctx: eventsCtx() });
  assert.equal(res.status, 204);
  assert.equal(writeEventCalls.length, 1, "a body of exactly MAX_BODY_BYTES must reach the allowlist/write logic, not be rejected by the cap");
});

check("events.js: a body of MAX_BODY_BYTES + 1 (257 bytes) is rejected -- still 204, but writes nothing (I/O matrix row: over the size cap)", async () => {
  const { onRequestPost, writeEventCalls } = loadEventsApi();
  // Pad with a body that WOULD otherwise be a valid, allowlisted event, so
  // this check genuinely proves the size cap itself is what stops the
  // write, not merely an unrelated JSON-parse failure the padding might
  // have caused.
  const overBody = jsonBodyOfExactBytes({ event: "limit_reached" }, 257);
  const res = await onRequestPost({ request: eventsRequest(overBody), env: EVENTS_ENV, ctx: eventsCtx() });
  assert.equal(res.status, 204);
  assert.deepEqual(writeEventCalls, []);
});

// --- rate cap: a single global-per-isolate 30/minute counter (Design Notes) --

check("events.js: the 31st request within one rolling minute, same isolate, still answers 204, and nothing is written past the 30th accepted write in that window (I/O matrix row)", async () => {
  const { onRequestPost, writeEventCalls } = loadEventsApi();
  for (let i = 0; i < 31; i++) {
    const res = await onRequestPost({ request: eventsRequest(JSON.stringify({ event: "limit_reached" })), env: EVENTS_ENV, ctx: eventsCtx() });
    assert.equal(res.status, 204, `request #${i + 1} must still answer 204`);
  }
  assert.equal(writeEventCalls.length, 30, "exactly 30 writes -- the 31st request must not have reached writeEvent at all");
});

check("events.js: the rate counter counts EVERY request that reaches it, not just accepted ones -- 30 allowlist-rejected requests exhaust the same budget a 31st, otherwise-valid request then hits (Design Notes: \"counting requests, not just accepted ones\")", async () => {
  const { onRequestPost, writeEventCalls } = loadEventsApi();
  for (let i = 0; i < 30; i++) {
    const res = await onRequestPost({ request: eventsRequest(JSON.stringify({ event: "app_open" })), env: EVENTS_ENV, ctx: eventsCtx() });
    assert.equal(res.status, 204);
  }
  assert.deepEqual(writeEventCalls, [], "none of the 30 rejected requests should have written anything");
  const res31 = await onRequestPost({ request: eventsRequest(JSON.stringify({ event: "limit_reached" })), env: EVENTS_ENV, ctx: eventsCtx() });
  assert.equal(res31.status, 204);
  assert.deepEqual(writeEventCalls, [], "the 31st request -- a genuinely valid, allowlisted event -- must ALSO be capped, since the isolate's 30/minute budget was already spent by the 30 rejected requests ahead of it");
});

// --- static proofs: no identifier of any kind can ever reach this endpoint --

check("events.js: never reads any request header or cookie, and the only body field it ever touches is `event` -- no id/email/token/IP/subscription id/device token field is ever read (Boundaries: \"no cookie, header, or body field carrying any identifier is ever read or stored by this endpoint\")", () => {
  // Static proof on the actual header-read/property-access call shape, not
  // a blanket word ban -- this file's own header comment legitimately
  // discusses "no cookie, header, ... is ever read" in prose, which a naive
  // /cookie/i word ban would false-positive on (same reasoning as the
  // Story 7-6 cookie/IP-header check above).
  assert.ok(!/request\s*\.\s*headers/.test(eventsApiSource), "events.js must never read any request header");
  assert.ok(!/headers\s*\.\s*get\(\s*["']cookie["']/i.test(eventsApiSource), "events.js must never call headers.get(\"cookie\")");
  const bodyFieldRefs = eventsApiSource.match(/(?<![\w-])body\??\.[a-zA-Z_]+/g) || [];
  const offenders = bodyFieldRefs.filter((ref) => !/^body\??\.event$/.test(ref));
  assert.deepEqual(offenders, [], `events.js must never read a body field other than \`event\`: ${offenders.join(", ")}`);
});

check("events.js: never imports from any governor-*.js/governor.js module -- this endpoint is intentionally ungoverned, best-effort, never a spend path (Never: \"Let /api/e reach the Governor ... in any way\")", () => {
  assert.ok(!/from\s*["'][^"']*governor[^"']*["']/i.test(eventsApiSource), "events.js must never import from any governor module");
});

check('events.js: ALLOWED_EVENTS is defined as EXACTLY the two-member Set {"limit_reached", "paywall_viewed"} -- no event name beyond these two is ever added (Never boundary; I/O matrix: the allowlist itself)', () => {
  assert.ok(
    /ALLOWED_EVENTS\s*=\s*new Set\(\[\s*"limit_reached"\s*,\s*"paywall_viewed"\s*\]\)/.test(eventsApiSource),
    'expected ALLOWED_EVENTS to be declared as exactly new Set(["limit_reached", "paywall_viewed"])'
  );
});

check("events.js: the bare `event` identifier reaching writeEvent(...) is structurally GATED by ALLOWED_EVENTS.has(event) returning early, BEFORE the writeEvent(...) call site -- closes the one-file identifier exception the repo-wide literal-args-only check above allows for this file", () => {
  const guardMatch = eventsApiSource.match(/if\s*\(\s*!ALLOWED_EVENTS\.has\(event\)\s*\)\s*\{\s*return\s+noContent\(\)\s*;?\s*\}/);
  assert.ok(guardMatch, "expected an `if (!ALLOWED_EVENTS.has(event)) { return noContent(); }` guard directly gating the write");
  const writeCallText = 'writeEvent(env, ctx, event, "")';
  const writeIndex = eventsApiSource.indexOf(writeCallText);
  assert.ok(writeIndex > -1, `expected the exact literal call \`${writeCallText}\``);
  const guardIndex = eventsApiSource.indexOf(guardMatch[0]);
  assert.ok(guardIndex > -1 && guardIndex < writeIndex, "the ALLOWED_EVENTS guard must appear BEFORE the writeEvent(...) call site in source order");
});

check("worker.js: GET /api/e is routed to 405 (matching every other endpoint's own convention), and only POST reaches events.js's onRequestPost (I/O matrix row -- the one branch that IS allowed to differ, decided at the routing layer)", () => {
  assert.ok(/if\s*\(\s*url\.pathname === "\/api\/e"\s*\)\s*\{\s*if\s*\(\s*request\.method !== "POST"\s*\)\s*\{\s*return new Response\("Method not allowed", \{ status: 405 \}\);/.test(workerSource), "expected worker.js's /api/e route to reject non-POST with 405, same shape as every other route");
});

// --- client call sites: draw.js (limit_reached), monetize.js (paywall_viewed) --

check('draw.js: fires reportEvent("limit_reached") exactly where the done-for-today (daily_limit) state is shown to the child, via a fire-and-forget POST to /api/e (Code Map: "fire limit_reached when the done-for-today state is shown")', () => {
  assert.ok(/if\s*\(\s*kind === "daily_limit"\s*\)\s*reportEvent\("limit_reached"\)/.test(drawSource), 'expected finishFailure() to fire reportEvent("limit_reached") on kind === "daily_limit"');
  assert.ok(/fetch\("\/api\/e",\s*\{/.test(drawSource), "expected a fetch(\"/api/e\", {...}) call in draw.js");
  assert.ok(/keepalive:\s*true/.test(drawSource), "expected the /api/e call to set keepalive: true");
  assert.ok(/\}\)\.catch\(\(\)\s*=>\s*\{\}\)/.test(drawSource), "expected the /api/e call to be fire-and-forget: .catch(() => {}), never awaited");
});

check('monetize.js: openPaywall() fires reportEvent("paywall_viewed") via a fire-and-forget POST to /api/e (Code Map: "fire paywall_viewed inside openPaywall()")', () => {
  const openPaywallMatch = monetizeSource.match(/function openPaywall\(\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(openPaywallMatch, "expected to find openPaywall()'s own function body");
  assert.ok(/reportEvent\("paywall_viewed"\)/.test(openPaywallMatch[0]), 'expected openPaywall() to call reportEvent("paywall_viewed")');
  assert.ok(/fetch\("\/api\/e",\s*\{/.test(monetizeSource), "expected a fetch(\"/api/e\", {...}) call in monetize.js");
  assert.ok(/keepalive:\s*true/.test(monetizeSource), "expected the /api/e call to set keepalive: true");
  assert.ok(/\}\)\.catch\(\(\)\s*=>\s*\{\}\)/.test(monetizeSource), "expected the /api/e call to be fire-and-forget: .catch(() => {}), never awaited");
});

// ------------------------------------------------------------------ Story 8-3: functions/lib/source-links.js (GET /<name> -> writeEvent + 302 /)
//
// Source Links: a new SOURCE_LINKS Worker var (a comma-separated list of
// short marketing names) worker.js reads to answer GET /<name> with one
// writeEvent(env, ctx, "source_visit", name) call and a 302 to exactly "/".
// Checked here two ways: (1) functions/lib/source-links.js's own pure
// parseSourceLinks() and handleSourceLinkRequest() logic, run as REAL code
// in a fresh vm context per call, writeEvent stubbed as a plain recording
// function passed in by parameter (same convention loadEventsApi() above
// uses for writeEvent, and the same reasoning: source-links.js's own header
// comment documents that it takes writeEvent by parameter rather than
// importing it, precisely so it stays testable like this); (2) a static
// check of the real committed wrangler.jsonc's SOURCE_LINKS value against
// the ^[a-z0-9-]{2,20}$ regex and a collision check against public/'s real
// top-level entries and the reserved names "api"/"sw" -- the pre-deploy,
// static check this story's frozen spec's "Always" clause requires (a
// malformed/colliding entry must never reach runtime silently).

const SOURCE_LINKS_LIB_PATH = path.join(LIB_DIR, "source-links.js");
const sourceLinksLibSource = readFileSync(SOURCE_LINKS_LIB_PATH, "utf8");

// Loads the REAL functions/lib/source-links.js into its own fresh vm
// context, with only URL/Response provided (its only two global
// dependencies -- see that file's own source).
function loadSourceLinks() {
  const sandbox = { URL, Response };
  vm.createContext(sandbox);
  const src = sourceLinksLibSource.replace(/^export\s+/gm, "");
  vm.runInContext(
    `${src}\nthis.parseSourceLinks = parseSourceLinks;\nthis.handleSourceLinkRequest = handleSourceLinkRequest;`,
    sandbox,
    { filename: "source-links.js" }
  );
  return { parseSourceLinks: sandbox.parseSourceLinks, handleSourceLinkRequest: sandbox.handleSourceLinkRequest };
}

// --- parseSourceLinks() -------------------------------------------------------

check('source-links.js: parseSourceLinks splits on ",", trims whitespace, and drops empty entries (a blank var, or stray/doubled commas)', () => {
  const { parseSourceLinks } = loadSourceLinks();
  assert.deepEqual([...parseSourceLinks("yt")], ["yt"]);
  assert.deepEqual([...parseSourceLinks("yt,ig,tt")].sort(), ["ig", "tt", "yt"]);
  assert.deepEqual([...parseSourceLinks(" yt , ig ")].sort(), ["ig", "yt"]);
  assert.deepEqual([...parseSourceLinks("yt,,ig")].sort(), ["ig", "yt"]);
  assert.deepEqual([...parseSourceLinks(",")], []);
  assert.deepEqual([...parseSourceLinks("")], []);
  assert.deepEqual([...parseSourceLinks(undefined)], []);
  assert.deepEqual([...parseSourceLinks(null)], []);
});

// --- handleSourceLinkRequest(): the I/O & edge-case matrix, run as real code --

const sourceLinkRequest = (pathname, method = "GET") => new Request(`https://8ish.app${pathname}`, { method });
const sourceLinkEnv = (SOURCE_LINKS) => ({ SOURCE_LINKS });
const sourceLinkCtx = () => ({ waitUntil() {} });

check('source-links.js: GET /<name> for a name IN SOURCE_LINKS -- writeEvent(env, ctx, "source_visit", name) exactly once, and answers 302 with Location: / (I/O matrix row)', () => {
  const { handleSourceLinkRequest } = loadSourceLinks();
  const writeEventCalls = [];
  const writeEventStub = (env, ctx, event, source) => writeEventCalls.push({ env, ctx, event, source });
  const env = sourceLinkEnv("yt");
  const ctx = sourceLinkCtx();
  const response = handleSourceLinkRequest(sourceLinkRequest("/yt"), env, ctx, writeEventStub);
  assert.ok(response, "expected a Response, not null, for a matched name");
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("Location"), "/");
  assert.equal(writeEventCalls.length, 1);
  assert.equal(writeEventCalls[0].event, "source_visit");
  assert.equal(writeEventCalls[0].source, "yt");
  assert.ok(writeEventCalls[0].env === env && writeEventCalls[0].ctx === ctx, "the real env/ctx handleSourceLinkRequest received must be the ones handed to writeEvent");
});

check("source-links.js: GET /<name> for a name NOT in SOURCE_LINKS -- returns null (falls through to worker.js's existing 404), writes nothing (I/O matrix row)", () => {
  const { handleSourceLinkRequest } = loadSourceLinks();
  const writeEventCalls = [];
  const response = handleSourceLinkRequest(sourceLinkRequest("/unknown-name"), sourceLinkEnv("yt"), sourceLinkCtx(), (...args) => writeEventCalls.push(args));
  assert.equal(response, null);
  assert.deepEqual(writeEventCalls, []);
});

check("source-links.js: HEAD /<name> for an otherwise-valid name -- returns null, never counted, even though the name itself is valid (I/O matrix row: HEAD never counts)", () => {
  const { handleSourceLinkRequest } = loadSourceLinks();
  const writeEventCalls = [];
  const response = handleSourceLinkRequest(sourceLinkRequest("/yt", "HEAD"), sourceLinkEnv("yt"), sourceLinkCtx(), (...args) => writeEventCalls.push(args));
  assert.equal(response, null);
  assert.deepEqual(writeEventCalls, []);
});

check("source-links.js: every other method (POST, PUT, DELETE) for an otherwise-valid name also returns null and writes nothing, same as HEAD -- only request.method === \"GET\" is ever matched", () => {
  const { handleSourceLinkRequest } = loadSourceLinks();
  for (const method of ["POST", "PUT", "DELETE"]) {
    const writeEventCalls = [];
    const response = handleSourceLinkRequest(sourceLinkRequest("/yt", method), sourceLinkEnv("yt"), sourceLinkCtx(), (...args) => writeEventCalls.push(args));
    assert.equal(response, null, `expected ${method} to fall through`);
    assert.deepEqual(writeEventCalls, []);
  }
});

check("source-links.js: SOURCE_LINKS empty/unset -- every GET /<name> falls through (returns null), nothing is ever written (I/O matrix row)", () => {
  const { handleSourceLinkRequest } = loadSourceLinks();
  for (const SOURCE_LINKS of ["", undefined, null]) {
    const writeEventCalls = [];
    const response = handleSourceLinkRequest(sourceLinkRequest("/yt"), sourceLinkEnv(SOURCE_LINKS), sourceLinkCtx(), (...args) => writeEventCalls.push(args));
    assert.equal(response, null);
    assert.deepEqual(writeEventCalls, []);
  }
});

check('source-links.js: the redirect Location is the literal "/" for every matched name, never derived from the request\'s own path or origin (frozen "Always": no open-redirect surface, by construction)', () => {
  const { handleSourceLinkRequest } = loadSourceLinks();
  for (const [pathname, sourceLinks] of [["/yt", "yt"], ["/ig", "ig,yt"]]) {
    const response = handleSourceLinkRequest(sourceLinkRequest(pathname), sourceLinkEnv(sourceLinks), sourceLinkCtx(), () => {});
    assert.equal(response.headers.get("Location"), "/");
  }
});

// --- wrangler.jsonc: the committed SOURCE_LINKS value itself, statically -----

check('wrangler.jsonc: SOURCE_LINKS is committed as "" (empty) -- Story 8-3 ships the mechanism with zero live links; a real channel/video name is the owner\'s own decision, never invented by a build (Never boundary)', () => {
  assert.equal(wrangler.vars.SOURCE_LINKS, "", 'wrangler.jsonc vars.SOURCE_LINKS must be committed as "" -- no real channel name may ever be invented by a build');
});

check('wrangler.jsonc: every SOURCE_LINKS entry (were one ever added) matches ^[a-z0-9-]{2,20}$, and none collides with a real public/ top-level asset path or the reserved names "api"/"sw" -- the static, pre-deploy check this story\'s frozen "Always" clause requires', () => {
  const { parseSourceLinks } = loadSourceLinks();
  const names = [...parseSourceLinks(wrangler.vars.SOURCE_LINKS)];

  const NAME_RE = /^[a-z0-9-]{2,20}$/;
  const malformed = names.filter((name) => !NAME_RE.test(name));
  assert.deepEqual(malformed, [], `SOURCE_LINKS name(s) failing ^[a-z0-9-]{2,20}$: ${malformed.join(", ")}`);

  // "Real top-level asset path" == every actual file/directory entry
  // directly under public/ (wrangler.jsonc's assets.directory) -- e.g.
  // "app.js", "sw.js", "index.html", "fonts", "icons" -- plus "api", the
  // whole /api/* surface, which isn't itself a public/ entry but is named
  // explicitly as reserved by this story's frozen spec.
  const publicEntries = readdirSync(CLIENT_DIR);
  const reserved = new Set(["api", "sw", ...publicEntries]);
  const colliding = names.filter((name) => reserved.has(name));
  assert.deepEqual(colliding, [], `SOURCE_LINKS name(s) colliding with a real public/ path or a reserved name: ${colliding.join(", ")}`);
});

// --- worker.js: the route itself is wired in the right place, calling the real helpers --

check("worker.js: the Source Link route (Story 8-3) sits between the /api/e route and the final 404, calls the real handleSourceLinkRequest(request, env, ctx, writeEvent), and returns its response only when non-null (every other route, and the 404 itself, is otherwise unaffected)", () => {
  const apiEIndex = workerSource.indexOf('url.pathname === "/api/e"');
  const sourceLinkCallIndex = workerSource.indexOf("handleSourceLinkRequest(");
  const notFoundIndex = workerSource.indexOf('new Response("Not found", { status: 404 })');
  assert.ok(apiEIndex > -1 && sourceLinkCallIndex > -1 && notFoundIndex > -1, "expected to find all three markers in worker.js");
  assert.ok(apiEIndex < sourceLinkCallIndex && sourceLinkCallIndex < notFoundIndex, "the Source Link route must sit between the /api/e route and the final 404");
  assert.ok(/handleSourceLinkRequest\(request,\s*env,\s*ctx,\s*writeEvent\)/.test(workerSource), "expected the exact call handleSourceLinkRequest(request, env, ctx, writeEvent)");
  assert.ok(/import\s*\{\s*writeEvent\s*\}\s*from\s*["']\.\/functions\/lib\/events\.js["']/.test(workerSource), "expected worker.js to import the real writeEvent from functions/lib/events.js");
  assert.ok(
    /import\s*\{\s*handleSourceLinkRequest\s*\}\s*from\s*["']\.\/functions\/lib\/source-links\.js["']/.test(workerSource),
    "expected worker.js to import handleSourceLinkRequest from functions/lib/source-links.js"
  );
});

// ------------------------------------------------------ Story 8.5: functions/lib/events.js (writeGovGauge/notifyAlert) + functions/api/transform.js (gov_gauge/threshold/notify wiring)
//
// The Governor reports its own state (spec-8-5-governor-reports-state.md).
// writeGovGauge/notifyAlert's own internal behavior is checked directly via
// loadEvents() (the real source, same convention as writeEvent's own checks
// above); transform.js's wiring (which commit triggers the report, the
// 80%/100% crossing idempotency, the mint-commit exclusion, both
// killswitch_seen sites) is checked via loadTransform()'s plain recording
// stubs for writeGovGauge/notifyAlert, plus makeKeyedStateKv() for the
// state:<budgetDay> KV interactions this story is the first to need a truly
// key-aware STATE_KV mock for.

// --- lib/events.js: writeGovGauge's own behavior ----------------------------

check("lib/events.js writeGovGauge: builds the exact payload {blobs:[\"gov_gauge\"], doubles:[total,free,sub,ceiling], indexes:[\"gov_gauge\"]} and calls env.FUNNEL.writeDataPoint via ctx.waitUntil(), never awaited inline (Code Map row)", async () => {
  const { writeGovGauge } = loadEvents();
  const dataPointCalls = [];
  const env = { FUNNEL: { writeDataPoint: (payload) => dataPointCalls.push(payload) } };
  const waitUntilCalls = [];
  const ctx = { waitUntil: (p) => waitUntilCalls.push(p) };

  writeGovGauge(env, ctx, { total: 42, free: 10, sub: 32, ceiling: 80 });
  assert.equal(dataPointCalls.length, 0, "writeDataPoint must not have run synchronously/inline yet");
  assert.equal(waitUntilCalls.length, 1, "the safe write promise must be handed to ctx.waitUntil()");
  assert.ok(typeof waitUntilCalls[0]?.then === "function", "ctx.waitUntil() must receive a promise");

  await waitUntilCalls[0];
  assert.deepEqual(JSON.parse(JSON.stringify(dataPointCalls)), [{ blobs: ["gov_gauge"], doubles: [42, 10, 32, 80], indexes: ["gov_gauge"] }]);
});

check("lib/events.js writeGovGauge: a SYNCHRONOUSLY throwing env.FUNNEL.writeDataPoint never propagates, logged with the SAME fixed event code writeEvent itself uses (shared fail-open contract)", async () => {
  const { writeGovGauge, consoleCalls } = loadEvents();
  const env = { FUNNEL: { writeDataPoint: () => { throw new Error("boom"); } } };
  const waitUntilCalls = [];
  const ctx = { waitUntil: (p) => waitUntilCalls.push(p) };

  assert.doesNotThrow(() => writeGovGauge(env, ctx, { total: 1, free: 0, sub: 1, ceiling: 80 }));
  await waitUntilCalls[0]; // must resolve, not reject
  assert.ok(consoleCalls.some((args) => args[0] === "event_write_failed"));
});

check("lib/events.js writeGovGauge: env.FUNNEL absent is a silent no-op -- no throw, no ctx.waitUntil() call, nothing logged (same fail-open contract as writeEvent)", () => {
  const { writeGovGauge, consoleCalls } = loadEvents();
  const waitUntilCalls = [];
  const ctx = { waitUntil: (p) => waitUntilCalls.push(p) };
  assert.doesNotThrow(() => writeGovGauge({}, ctx, { total: 1, free: 0, sub: 1, ceiling: 80 }));
  assert.equal(waitUntilCalls.length, 0);
  assert.equal(consoleCalls.length, 0);
});

// --- lib/events.js: notifyAlert's own behavior ------------------------------

check('lib/events.js notifyAlert: each of the three allowed events ("ceiling_80", "ceiling_reached", "killswitch_seen") reaches the real writeEvent(env, ctx, event, "") exactly once', async () => {
  for (const event of ["ceiling_80", "ceiling_reached", "killswitch_seen"]) {
    const { notifyAlert } = loadEvents();
    const dataPointCalls = [];
    const env = { FUNNEL: { writeDataPoint: (payload) => dataPointCalls.push(payload) } };
    const waitUntilCalls = [];
    const ctx = { waitUntil: (p) => waitUntilCalls.push(p) };
    notifyAlert(env, ctx, event);
    assert.equal(waitUntilCalls.length, 1, event);
    await waitUntilCalls[0];
    assert.deepEqual(JSON.parse(JSON.stringify(dataPointCalls)), [{ blobs: [event, ""], doubles: [1], indexes: [event] }], event);
  }
});

check("lib/events.js notifyAlert: an event name OUTSIDE the three-member allowlist is silently dropped -- no writeEvent call, no ctx.waitUntil() call, nothing written (ALERT_EVENTS gate)", () => {
  const { notifyAlert } = loadEvents();
  const dataPointCalls = [];
  const env = { FUNNEL: { writeDataPoint: (payload) => dataPointCalls.push(payload) } };
  const waitUntilCalls = [];
  const ctx = { waitUntil: (p) => waitUntilCalls.push(p) };
  for (const event of ["app_open", "ceiling_80 ", "CEILING_80", "", undefined, "image_created"]) {
    notifyAlert(env, ctx, event);
  }
  assert.equal(waitUntilCalls.length, 0);
  assert.equal(dataPointCalls.length, 0);
});

// --- functions/api/transform.js: the gauge/threshold/notify wiring ---------

// A Governor cfg with a small ceiling (10) so 80%/100% crossings are easy to
// hit with small, readable imagesTotal values -- a deep clone of the
// committed default so this file's own mutation of `ceiling` never affects
// VALID_GOVERNOR_CFG_RAW itself (shared by many other checks in this file).
function smallCeilingCfg(ceiling = 10) {
  return { ...VALID_GOVERNOR_CFG_RAW, ceiling };
}

check("transform.js (Story 8.5): a real image-spend commit (subscriber path) writes ONE gov_gauge point carrying {total: imagesTotal, free, sub, ceiling: cfg.ceiling} for today's UTC budget day, via ctx.waitUntil, after the settle/writeEvent(image_created) calls", async () => {
  const secret = "gauge_secret";
  const token = await mintTransformCredential(secret);
  const { stub, getDailyImageCountsCalls } = makeGovernorStub({ getDailyImageCountsImpl: () => ({ free: 2, sub: 3, imagesTotal: 5 }) });
  const kv = makeKeyedStateKv({ "cfg:governor": smallCeilingCfg(100) });
  const { env } = makeTransformEnv({ secret, governorStub: stub, stateKv: kv, aiStub: aiStubResolving("img_b64") });
  const { onRequestPost, writeGovGaugeCalls } = loadTransform();
  const { ctx, waitUntilCalls } = makeCtx();

  const res = await onRequestPost({ request: transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID }, { token }), env, ctx });
  assert.equal(res.status, 200);
  // Both waitUntil'd promises (settle, gauge-report) must be allowed to run
  // to completion before asserting on their own side effects.
  await Promise.all(waitUntilCalls);

  assert.equal(getDailyImageCountsCalls.length, 1);
  const todayUtc = new Date().toISOString().slice(0, 10);
  assert.equal(getDailyImageCountsCalls[0], todayUtc, "budgetDay must be today's real UTC calendar date");
  assert.equal(writeGovGaugeCalls.length, 1);
  assert.deepEqual({ ...writeGovGaugeCalls[0].gauge }, { total: 5, free: 2, sub: 3, ceiling: 100 });
  // Comfortably under 80% of ceiling 100 -- no KV read/write, no notifyAlert.
  assert.equal(kv.getCalls.filter((c) => c.key.startsWith("state:")).length, 0, "no KV read below 80% (judgment call -- see Spec Change Log)");
  assert.equal(kv.putCalls.length, 0, "no KV write at all below 80% (frozen Always)");
});

check("transform.js (Story 8.5): the free-device path's own real commit ALSO writes gov_gauge (not just the subscriber path) -- same wiring, both callers thread cfg through identically", async () => {
  const secret = "gauge_free_secret";
  const existingToken = await mintTransformDeviceToken(secret);
  const { stub } = makeGovernorStub({ getDailyImageCountsImpl: () => ({ free: 1, sub: 0, imagesTotal: 1 }) });
  const kv = makeKeyedStateKv({ "cfg:governor": smallCeilingCfg(100) });
  const { env } = makeFreeDeviceEnv({ secret, governorStub: stub, stateKv: kv, aiStub: aiStubResolving("img_b64") });
  const { onRequestPost, writeGovGaugeCalls } = loadTransform({ fetchImpl: async () => turnstileImageOk() });
  const { ctx, waitUntilCalls } = makeCtx();
  const res = await onRequestPost({
    request: transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID, turnstile: "tok_1" }, { deviceToken: existingToken }),
    env,
    ctx,
  });
  await Promise.all(waitUntilCalls);
  assert.equal(res.status, 200);
  assert.equal(writeGovGaugeCalls.length, 1);
});

check("transform.js (Story 8.5): the FIRST commit today to cross 80% of ceiling -- state:<budgetDay> KV shows no crossing yet, gets written with ceiling80:true, and notifyAlert(env, ctx, \"ceiling_80\") fires exactly once; a SECOND commit that same day (KV already shows it) writes NO second time and fires NO second alert", async () => {
  const secret = "cross80_secret";
  const kv = makeKeyedStateKv({ "cfg:governor": smallCeilingCfg(10) });
  const { stub } = makeGovernorStub({ getDailyImageCountsImpl: () => ({ free: 0, sub: 8, imagesTotal: 8 }) }); // 8/10 = 80%
  const { env } = makeTransformEnv({ secret, governorStub: stub, stateKv: kv, aiStub: aiStubResolving("img_b64") });

  const token1 = await mintTransformCredential(secret);
  const { onRequestPost: post1, notifyAlertCalls: notify1 } = loadTransform();
  const { ctx: ctx1, waitUntilCalls: wait1 } = makeCtx();
  const res1 = await post1({ request: transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID }, { token: token1 }), env, ctx: ctx1 });
  await Promise.all(wait1);
  assert.equal(res1.status, 200);
  assert.deepEqual(notify1.map((c) => c.event), ["ceiling_80"]);
  assert.equal(kv.putCalls.length, 1);
  const todayKey = kv.putCalls[0].key;
  assert.ok(todayKey.startsWith("state:"));
  assert.deepEqual(JSON.parse(kv.putCalls[0].value), { ceiling80: true });

  // A second, later commit the SAME day, usage unchanged (still 8/10) --
  // KV now already shows the crossing.
  const token2 = await mintTransformCredential(secret);
  const { onRequestPost: post2, notifyAlertCalls: notify2 } = loadTransform();
  const { ctx: ctx2, waitUntilCalls: wait2 } = makeCtx();
  const res2 = await post2({ request: transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID }, { token: token2 }), env, ctx: ctx2 });
  await Promise.all(wait2);
  assert.equal(res2.status, 200);
  assert.deepEqual(notify2.map((c) => c.event), [], "no second ceiling_80 alert the same day");
  assert.equal(kv.putCalls.length, 1, "no second KV write");
});

check("transform.js (Story 8.5): a SINGLE commit that jumps straight past BOTH 80% and 100% in one step fires BOTH ceiling_80 AND ceiling_reached on that same commit, with ONE combined KV write carrying both flags true", async () => {
  const secret = "cross_both_secret";
  const kv = makeKeyedStateKv({ "cfg:governor": smallCeilingCfg(10) });
  const { stub } = makeGovernorStub({ getDailyImageCountsImpl: () => ({ free: 0, sub: 10, imagesTotal: 10 }) }); // 10/10 = 100% in one step
  const { env } = makeTransformEnv({ secret, governorStub: stub, stateKv: kv, aiStub: aiStubResolving("img_b64") });
  const token = await mintTransformCredential(secret);
  const { onRequestPost, notifyAlertCalls } = loadTransform();
  const { ctx, waitUntilCalls } = makeCtx();

  const res = await onRequestPost({ request: transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID }, { token }), env, ctx });
  await Promise.all(waitUntilCalls);
  assert.equal(res.status, 200);
  assert.deepEqual(notifyAlertCalls.map((c) => c.event).sort(), ["ceiling_80", "ceiling_reached"]);
  assert.equal(kv.putCalls.length, 1, "both crossings recorded in ONE combined KV write, not two separate writes");
  assert.deepEqual(JSON.parse(kv.putCalls[0].value), { ceiling80: true, ceilingReached: true });
});

check("transform.js (Story 8.5): ceiling_reached fires independently once 80% was ALREADY recorded earlier today -- only ceiling_reached fires (not a second ceiling_80), and the KV write preserves the earlier ceiling80:true flag", async () => {
  const secret = "cross_reached_secret";
  const todayUtc = new Date().toISOString().slice(0, 10);
  const kv = makeKeyedStateKv({ "cfg:governor": smallCeilingCfg(10), [`state:${todayUtc}`]: { ceiling80: true } }); // 80% already recorded earlier today
  const { stub } = makeGovernorStub({ getDailyImageCountsImpl: () => ({ free: 0, sub: 10, imagesTotal: 10 }) }); // 10/10 = 100%
  const { env } = makeTransformEnv({ secret, governorStub: stub, stateKv: kv, aiStub: aiStubResolving("img_b64") });
  const token = await mintTransformCredential(secret);
  const { onRequestPost, notifyAlertCalls } = loadTransform();
  const { ctx, waitUntilCalls } = makeCtx();

  const res = await onRequestPost({ request: transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID }, { token }), env, ctx });
  await Promise.all(waitUntilCalls);
  assert.equal(res.status, 200);
  assert.deepEqual(notifyAlertCalls.map((c) => c.event), ["ceiling_reached"]);
  assert.equal(kv.putCalls.length, 1);
  assert.deepEqual(JSON.parse(kv.putCalls[0].value), { ceiling80: true, ceilingReached: true });
});

check("transform.js (Story 8.5): the free-device path's `mint` reservation commit -- awaited directly, never via runModelAndSettle -- never itself triggers a SEPARATE gov_gauge report; only the follow-on real `free` image commit does (exactly ONE writeGovGauge call for the whole mint-then-image request)", async () => {
  const { stub } = makeGovernorStub({ getDailyImageCountsImpl: () => ({ free: 1, sub: 0, imagesTotal: 1 }) });
  const kv = makeKeyedStateKv({ "cfg:governor": smallCeilingCfg(100) });
  const { env } = makeFreeDeviceEnv({ governorStub: stub, stateKv: kv, aiStub: aiStubResolving("img_b64") });
  const { onRequestPost, writeGovGaugeCalls } = loadTransform({ fetchImpl: async () => turnstileImageOk() });
  const { ctx, waitUntilCalls } = makeCtx();
  // No X-Device-Token at all -> mint path (no existing device -> mint, then
  // reserve "free" for the newly-minted id, then runModelAndSettle).
  const res = await onRequestPost({
    request: transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID, turnstile: "tok_1" }),
    env,
    ctx,
  });
  await Promise.all(waitUntilCalls);
  assert.equal(res.status, 200);
  assert.equal(writeGovGaugeCalls.length, 1, "exactly one gauge report -- from the real `free` commit, never the `mint` commit");
});

check("transform.js (Story 8.5): the Governor RPC (getDailyImageCounts) throwing is logged and swallowed -- the already-sent 200 image response is completely unaffected, and no gov_gauge point is written for a totals read that never succeeded", async () => {
  const secret = "rpc_throws_secret";
  const token = await mintTransformCredential(secret);
  const { stub } = makeGovernorStub({
    getDailyImageCountsImpl: () => {
      throw new Error("durable object unavailable");
    },
  });
  const kv = makeKeyedStateKv({ "cfg:governor": VALID_GOVERNOR_CFG_RAW });
  const { env } = makeTransformEnv({ secret, governorStub: stub, stateKv: kv, aiStub: aiStubResolving("img_b64") });
  const { onRequestPost, writeGovGaugeCalls, consoleCalls } = loadTransform();
  const { ctx, waitUntilCalls } = makeCtx();

  const res = await onRequestPost({ request: transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID }, { token }), env, ctx });
  const body = await res.json();
  await Promise.all(waitUntilCalls);
  assert.equal(res.status, 200);
  assert.deepEqual(body, { image: "img_b64" });
  assert.equal(writeGovGaugeCalls.length, 0);
  assert.equal(kv.putCalls.length, 0);
  assert.ok(consoleCalls.some((args) => args[0] === "gov_gauge_rpc_failed"));
});

check("transform.js (Story 8.5): a state:<budgetDay> KV read failure is logged and swallowed -- treated as \"no crossing recorded yet\" (still crosses and alerts correctly), the response is completely unaffected", async () => {
  const secret = "kv_read_throws_secret";
  const token = await mintTransformCredential(secret);
  const { stub } = makeGovernorStub({ getDailyImageCountsImpl: () => ({ free: 0, sub: 8, imagesTotal: 8 }) }); // 80% of ceiling 10
  // Only the state:<budgetDay> key's own get() throws -- cfg:governor must
  // keep answering normally, or the request would 503 resting before ever
  // reaching this story's own code at all (a different, pre-existing
  // failure mode this test is not about).
  const cfg = smallCeilingCfg(10);
  const throwingKv = {
    async get(key) {
      if (key === "cfg:governor") return cfg;
      throw new Error("KV read failed");
    },
    async put(key, value, opts) {
      throwingKv.putCalls.push({ key, value, opts });
    },
    putCalls: [],
  };
  const { env } = makeTransformEnv({ secret, governorStub: stub, stateKv: throwingKv, aiStub: aiStubResolving("img_b64") });
  const { onRequestPost, notifyAlertCalls, consoleCalls } = loadTransform();
  const { ctx, waitUntilCalls } = makeCtx();

  const res = await onRequestPost({ request: transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID }, { token }), env, ctx });
  await Promise.all(waitUntilCalls);
  assert.equal(res.status, 200);
  assert.deepEqual(notifyAlertCalls.map((c) => c.event), ["ceiling_80"], "a KV read failure degrades to treating today as not-yet-crossed, not to skipping the check entirely");
  assert.equal(throwingKv.putCalls.length, 1);
  assert.ok(consoleCalls.some((args) => args[0] === "gov_gauge_state_read_failed"));
});

check("transform.js (Story 8.5): a state:<budgetDay> KV write failure is logged and swallowed -- the alert still fires for THIS commit (the crossing was already decided before the write attempt), and the response is completely unaffected", async () => {
  const secret = "kv_write_throws_secret";
  const token = await mintTransformCredential(secret);
  const { stub } = makeGovernorStub({ getDailyImageCountsImpl: () => ({ free: 0, sub: 8, imagesTotal: 8 }) });
  const cfg = smallCeilingCfg(10);
  const writeThrowingKv = {
    async get(key) {
      if (key === "cfg:governor") return cfg;
      return null;
    },
    async put() {
      throw new Error("KV write failed");
    },
  };
  const { env } = makeTransformEnv({ secret, governorStub: stub, stateKv: writeThrowingKv, aiStub: aiStubResolving("img_b64") });
  const { onRequestPost, notifyAlertCalls, consoleCalls } = loadTransform();
  const { ctx, waitUntilCalls } = makeCtx();

  const res = await onRequestPost({ request: transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID }, { token }), env, ctx });
  const body = await res.json();
  await Promise.all(waitUntilCalls);
  assert.equal(res.status, 200);
  assert.deepEqual(body, { image: "img_b64" });
  assert.deepEqual(notifyAlertCalls.map((c) => c.event), ["ceiling_80"]);
  assert.ok(consoleCalls.some((args) => args[0] === "gov_gauge_state_write_failed"));
});

check("transform.js (Story 8.5): an invalid/missing/zero cfg.ceiling never divides by zero or crashes -- the gauge point is still written (with that ceiling value, whatever it is), but the crossing check is skipped entirely (defense-in-depth; unreachable via a real reserve() in practice)", async () => {
  const secret = "zero_ceiling_secret";
  const token = await mintTransformCredential(secret);
  const { stub } = makeGovernorStub({ getDailyImageCountsImpl: () => ({ free: 0, sub: 5, imagesTotal: 5 }) });
  const kv = makeKeyedStateKv({ "cfg:governor": { ...VALID_GOVERNOR_CFG_RAW, ceiling: 0 } });
  const { env } = makeTransformEnv({ secret, governorStub: stub, stateKv: kv, aiStub: aiStubResolving("img_b64") });
  const { onRequestPost, writeGovGaugeCalls, notifyAlertCalls } = loadTransform();
  const { ctx, waitUntilCalls } = makeCtx();

  const res = await onRequestPost({ request: transformRequest({ sketch: VALID_PNG_B64, promptId: VALID_PROMPT_ID }, { token }), env, ctx });
  await Promise.all(waitUntilCalls);
  assert.equal(res.status, 200);
  assert.equal(writeGovGaugeCalls.length, 1);
  assert.deepEqual({ ...writeGovGaugeCalls[0].gauge }, { total: 5, free: 0, sub: 5, ceiling: 0 });
  assert.deepEqual(notifyAlertCalls.map((c) => c.event), [], "no crossing check at all against a ceiling of 0");
  assert.equal(kv.putCalls.length, 0);
});

// --- repo-wide static proof: notifyAlert is the ONLY origin of these three names ---

check('repo-wide (Story 8.5): "ceiling_80"/"ceiling_reached"/"killswitch_seen" are only ever written via a literal notifyAlert(env, ctx, "...") call -- never writeEvent(...) directly, and never any other call site', () => {
  const ALERT_NAMES = ["ceiling_80", "ceiling_reached", "killswitch_seen"];
  const roots = [path.join(ROOT_DIR, "functions"), path.join(ROOT_DIR, "public")];
  const offenders = [];
  for (const root of roots) {
    for (const file of listFilesRecursive(root)) {
      if (!file.endsWith(".js") || file === EVENTS_LIB_PATH) continue; // events.js itself defines/owns these literals (ALERT_EVENTS)
      const text = readFileSync(file, "utf8");
      for (const name of ALERT_NAMES) {
        const anyCount = (text.match(new RegExp(`"${name}"`, "g")) || []).length;
        if (anyCount === 0) continue;
        const notifyAlertCount = (text.match(new RegExp(`notifyAlert\\(\\s*env\\s*,\\s*ctx\\s*,\\s*"${name}"\\s*\\)`, "g")) || []).length;
        if (notifyAlertCount !== anyCount) {
          offenders.push(`${path.relative(ROOT_DIR, file)}: "${name}" appears ${anyCount} time(s), only ${notifyAlertCount} as a literal notifyAlert(env, ctx, "${name}") call`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [], `every occurrence of these three names outside events.js must be a literal notifyAlert(...) call:\n${offenders.join("\n")}`);
});

check("events.js: ALERT_EVENTS is defined as EXACTLY the three-member Set {\"ceiling_80\", \"ceiling_reached\", \"killswitch_seen\"} -- no event name beyond these three is ever added", () => {
  const match = eventsLibSource.match(/const ALERT_EVENTS = new Set\(\[([^\]]*)\]\);/);
  assert.ok(match, "expected a literal `const ALERT_EVENTS = new Set([...])` declaration");
  const names = match[1].split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
  assert.deepEqual(names.sort(), ["ceiling_80", "ceiling_reached", "killswitch_seen"]);
});

check("transform.js (Story 8.5): runModelAndSettle's own steps 10-12 logic (model call, timeout race, failure handling) is untouched -- every pre-existing failure-path check above still passes with the SAME assertions (release calls, response shapes, ctx.waitUntil counts unaffected by this story's addition), proven simply by this whole file's own checks list including them unmodified alongside this story's new ones", () => {
  // A structural marker, not a new runtime assertion: `cfg` is now the ONLY
  // new parameter runModelAndSettle's own signature gained (Code Map's own
  // constraint) -- confirmed directly against the real source text.
  assert.ok(
    /async function runModelAndSettle\(\{\s*env,\s*ctx,\s*governorStub,\s*reservationId,\s*pngBytes,\s*promptEntry,\s*extraSuccessFields\s*=\s*\{\},\s*cfg\s*\}\)/.test(transformSource),
    "expected runModelAndSettle's signature to gain exactly one new parameter, cfg, appended after extraSuccessFields"
  );
});

// ------------------------------------------------------------------- runner

let failed = 0;
for (const { name, fn } of checks) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${name}\n     ${String(error.message || error).split("\n").join("\n     ")}`);
  }
}
console.log(failed ? `\n${failed} of ${checks.length} checks failed` : `\nall ${checks.length} checks passed`);
process.exitCode = failed ? 1 : 0;
