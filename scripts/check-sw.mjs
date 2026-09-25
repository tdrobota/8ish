// Proves the service worker's cache rules by running sw.js in a sandbox with a
// fake `self`, `caches` and `fetch`, then runs a few static checks on the
// source and on the files the app loads. No dependencies, Node 18+.
//
//   node scripts/check-sw.mjs
//
// Exits 0 when every check passes, 1 otherwise. Run by hand until Epic 4.4
// wires it into the pipeline.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

// The one place that names the client folder: everything the site publishes
// lives in public/ (wrangler.jsonc assets.directory).
const CLIENT_DIR = fileURLToPath(new URL("../public/", import.meta.url));

const ORIGIN = "https://8ish.test";
const SW_URL = `${ORIGIN}/sw.js`;
const swSource = readFileSync(path.join(CLIENT_DIR, "sw.js"), "utf8");

// ---------------------------------------------------------------- fake world

const abs = (url) => new URL(typeof url === "string" ? url : url.url, SW_URL).href;

function res(body, { status = 200, type = "basic", redirected = false } = {}) {
  return {
    body,
    status,
    type,
    redirected,
    ok: status >= 200 && status <= 299,
    clone: () => res(body, { status, type, redirected }),
  };
}

// A fresh worker in its own sandbox: fake fetch (online/offline, per-URL
// overrides, a log of every request), fake Cache Storage (a log of every put
// and addAll), and a way to fire install, activate and fetch events.
function makeWorld() {
  const world = {
    online: true,
    responses: new Map(), // absolute URL -> response the fake network returns
    fetchLog: [], // absolute URLs requested from the network
    putLog: [], // { cache, url } for every cache.put
    addAllLog: [], // { cache, urls } for every cache.addAll
    stores: new Map(), // cache name -> Map(absolute URL -> response)
    listeners: {},
    claimed: false,
  };

  const fakeFetch = async (request) => {
    const url = abs(request);
    world.fetchLog.push(url);
    if (!world.online) throw new TypeError("Failed to fetch");
    return world.responses.get(url) || res(`net:${url}`);
  };

  const openStore = (name) => {
    if (!world.stores.has(name)) world.stores.set(name, new Map());
    return world.stores.get(name);
  };

  const fakeCaches = {
    async open(name) {
      const store = openStore(name);
      return {
        async match(key) {
          return store.get(abs(key));
        },
        async put(key, response) {
          world.putLog.push({ cache: name, url: abs(key) });
          store.set(abs(key), response);
        },
        async addAll(urls) {
          world.addAllLog.push({ cache: name, urls: urls.map(abs) });
          for (const url of urls) store.set(abs(url), await fakeFetch(url));
        },
        async add() {
          throw new Error("cache.add is not allowed");
        },
      };
    },
    async keys() {
      return [...world.stores.keys()];
    },
    async delete(name) {
      return world.stores.delete(name);
    },
    async match() {
      throw new Error("global caches.match is not allowed; read through caches.open(CACHE_NAME)");
    },
  };

  const fakeSelf = {
    location: new URL(SW_URL),
    addEventListener(type, listener) {
      (world.listeners[type] ||= []).push(listener);
    },
    skipWaiting() {},
    clients: {
      claim() {
        world.claimed = true;
      },
    },
  };

  world.context = vm.createContext({ self: fakeSelf, caches: fakeCaches, fetch: fakeFetch, URL, console });
  vm.runInContext(swSource, world.context, { filename: "sw.js" });

  // Fire a lifecycle or fetch event; waits for everything passed to
  // waitUntil / respondWith.
  world.fire = async (type, request) => {
    const pending = [];
    const event = {
      request,
      responded: false,
      respondWith(promise) {
        assert.ok(!this.responded, "respondWith called twice");
        this.responded = true;
        this.promise = promise;
      },
      waitUntil(promise) {
        pending.push(promise);
      },
    };
    (world.listeners[type] || []).forEach((listener) => listener(event));
    const out = { responded: event.responded, result: undefined, error: undefined };
    if (event.responded) {
      try {
        out.result = await event.promise;
      } catch (error) {
        out.error = error;
      }
    }
    await Promise.all(pending);
    // In a browser, an undefined answer to respondWith is a network error too.
    out.failed = out.responded && (out.error !== undefined || out.result === undefined);
    return out;
  };

  world.get = (pathOrUrl, { mode = "cors", method = "GET" } = {}) =>
    world.fire("fetch", { url: abs(pathOrUrl), method, mode });

  world.install = () => world.fire("install");
  world.activate = () => world.fire("activate");
  world.seed = (cacheName, pathOrUrl, body) => openStore(cacheName).set(abs(pathOrUrl), res(body));
  world.cacheName = () => vm.runInContext("CACHE_NAME", world.context);
  world.precacheUrls = () => vm.runInContext("PRECACHE_URLS", world.context);
  world.cacheKeys = (name) => [...openStore(name).keys()];
  world.resetLogs = () => {
    world.fetchLog.length = 0;
    world.putLog.length = 0;
    world.addAllLog.length = 0;
  };
  return world;
}

// A worker that has installed while online, then has its logs cleared.
async function installedWorld() {
  const world = makeWorld();
  await world.install();
  world.resetLogs();
  return world;
}

const served = (out, body) => {
  assert.ok(out.responded, "worker did not respond");
  assert.equal(out.error, undefined, `respondWith rejected: ${out.error}`);
  assert.equal(out.result && out.result.body, body);
};
const ignored = (out) => assert.equal(out.responded, false, "worker must not call respondWith");

const LEGAL_PATHS = ["/terms", "/terms.html", "/privacy", "/privacy.html"];
const NEXT_VERSION = 24;

// ------------------------------------------------------------------ scenarios

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

check("precached file, cached: served from cache, no network", async () => {
  const world = await installedWorld();
  world.responses.set(abs("/app.js"), res("fresh-from-network"));
  served(await world.get("/app.js"), `net:${abs("/app.js")}`);
  assert.deepEqual(world.fetchLog, []);
  assert.deepEqual(world.putLog, []);
});

check("precached shell (/) and font, cached, offline: still served", async () => {
  const world = await installedWorld();
  world.online = false;
  served(await world.get("/", { mode: "navigate" }), `net:${abs("/")}`);
  served(await world.get("/fonts/poppins.woff2"), `net:${abs("/fonts/poppins.woff2")}`);
  served(await world.get("/app.js"), `net:${abs("/app.js")}`);
});

check("precached file, not cached, online: network response, not stored", async () => {
  const world = makeWorld();
  served(await world.get("/app.js"), `net:${abs("/app.js")}`);
  assert.deepEqual(world.fetchLog, [abs("/app.js")]);
  assert.deepEqual(world.putLog, []);
});

check("precached file, not cached, offline: fails normally", async () => {
  const world = makeWorld();
  world.online = false;
  const out = await world.get("/app.js");
  assert.ok(out.failed);
  assert.deepEqual(world.putLog, []);
});

check("precached URL with a query string is not treated as precached", async () => {
  const world = await installedWorld();
  ignored(await world.get("/app.js?v=2"));
  assert.deepEqual(world.putLog, []);
});

check("/api/config, /api/entitlement?x=1, /api/checkout/confirm: ignored, never read from cache", async () => {
  const world = await installedWorld();
  for (const p of ["/api/config", "/api/entitlement?x=1", "/api/checkout/confirm?session_id=cs_x"]) {
    // A stale entry planted by an old worker must not be read either.
    world.seed(world.cacheName(), p, "STALE");
    ignored(await world.get(p));
  }
  ignored(await world.get("/api/config", { mode: "navigate" }));
  assert.deepEqual(world.fetchLog, [], "worker must not fetch API requests itself");
  assert.deepEqual(world.putLog, []);
});

check("API request while offline: ignored (fails visibly in the browser)", async () => {
  const world = await installedWorld();
  world.online = false;
  ignored(await world.get("/api/entitlement"));
});

check("Stripe return navigation online: network response, not stored", async () => {
  const world = await installedWorld();
  const url = "/?checkout=success&session_id=cs_x";
  served(await world.get(url, { mode: "navigate" }), `net:${abs(url)}`);
  assert.deepEqual(world.fetchLog, [abs(url)]);
  assert.deepEqual(world.putLog, []);
});

check("Stripe return navigation offline: cached ./", async () => {
  const world = await installedWorld();
  world.online = false;
  served(await world.get("/?checkout=success&session_id=cs_x", { mode: "navigate" }), `net:${abs("/")}`);
});

check("navigation to an unknown page offline: cached ./; nothing stored", async () => {
  const world = await installedWorld();
  world.online = false;
  served(await world.get("/somewhere", { mode: "navigate" }), `net:${abs("/")}`);
  assert.deepEqual(world.putLog, []);
});

check("navigation to an unknown page offline with no cached ./ fails normally", async () => {
  const world = makeWorld();
  world.online = false;
  assert.ok((await world.get("/somewhere", { mode: "navigate" })).failed);
});

check("non-navigation request to an unknown same-origin URL: ignored, not stored", async () => {
  const world = await installedWorld();
  ignored(await world.get("/source-link"));
  ignored(await world.get("/img/x.png"));
  assert.deepEqual(world.putLog, []);
});

for (const p of LEGAL_PATHS) {
  check(`legal page ${p} online: network response returned and stored`, async () => {
    const world = await installedWorld();
    served(await world.get(p, { mode: "navigate" }), `net:${abs(p)}`);
    assert.deepEqual(world.fetchLog, [abs(p)]);
    assert.deepEqual(world.putLog, [{ cache: world.cacheName(), url: abs(p) }]);
  });
}

check("legal page: every online visit refreshes the cached copy", async () => {
  const world = await installedWorld();
  world.seed(world.cacheName(), "/terms", "OLD TEXT");
  world.responses.set(abs("/terms"), res("NEW TEXT"));
  served(await world.get("/terms", { mode: "navigate" }), "NEW TEXT");
  world.online = false;
  served(await world.get("/terms", { mode: "navigate" }), "NEW TEXT");
});

for (const p of LEGAL_PATHS) {
  check(`legal page ${p} offline: cached copy`, async () => {
    const world = await installedWorld();
    // The copy exists under the other address only (a real visit goes
    // through the redirect, so only one address is ever stored).
    const other = { "/terms": "/terms.html", "/terms.html": "/terms", "/privacy": "/privacy.html", "/privacy.html": "/privacy" }[p];
    world.seed(world.cacheName(), other, `cached:${other}`);
    world.online = false;
    served(await world.get(p, { mode: "navigate" }), `cached:${other}`);
    assert.deepEqual(world.putLog, []);
  });
}

check("legal page offline with no cached copy: network error, nothing stored", async () => {
  const world = await installedWorld();
  world.online = false;
  assert.ok((await world.get("/privacy", { mode: "navigate" })).failed);
  assert.deepEqual(world.putLog, []);
});

check("legal page redirect (opaque, not ok): passed through, never stored, never replaced by cache", async () => {
  const world = await installedWorld();
  world.seed(world.cacheName(), "/terms", "CACHED");
  world.responses.set(abs("/terms.html"), res("", { status: 0, type: "opaqueredirect" }));
  const out = await world.get("/terms.html", { mode: "navigate" });
  assert.equal(out.result.type, "opaqueredirect");
  assert.deepEqual(world.putLog, []);
});

check("legal page fetched with redirects followed (ok but redirected): passed through, never stored", async () => {
  const world = await installedWorld();
  world.responses.set(abs("/terms.html"), res("TERMS", { redirected: true }));
  served(await world.get("/terms.html"), "TERMS");
  assert.deepEqual(world.putLog, []);
});

check("legal page 5xx with a cached copy: cached copy, 5xx not stored", async () => {
  const world = await installedWorld();
  world.seed(world.cacheName(), "/terms", "CACHED");
  world.responses.set(abs("/terms"), res("boom", { status: 503 }));
  served(await world.get("/terms", { mode: "navigate" }), "CACHED");
  assert.deepEqual(world.putLog, []);
});

check("legal page 5xx with no cached copy: 5xx passed through, not stored", async () => {
  const world = await installedWorld();
  world.responses.set(abs("/terms"), res("boom", { status: 500 }));
  const out = await world.get("/terms", { mode: "navigate" });
  assert.equal(out.result.status, 500);
  assert.deepEqual(world.putLog, []);
});

check("legal page 404 passed through, not stored, cached copy left alone", async () => {
  const world = await installedWorld();
  world.responses.set(abs("/terms"), res("nope", { status: 404 }));
  assert.equal((await world.get("/terms", { mode: "navigate" })).result.status, 404);
  assert.deepEqual(world.putLog, []);
});

check("production flow: /terms.html redirects, /terms is stored, both open offline", async () => {
  const world = await installedWorld();
  world.responses.set(abs("/terms.html"), res("", { status: 0, type: "opaqueredirect" }));
  await world.get("/terms.html", { mode: "navigate" }); // redirect, not stored
  await world.get("/terms", { mode: "navigate" }); // the browser follows it
  assert.deepEqual(world.putLog.map((p) => p.url), [abs("/terms")]);
  world.online = false;
  served(await world.get("/terms", { mode: "navigate" }), `net:${abs("/terms")}`);
  served(await world.get("/terms.html", { mode: "navigate" }), `net:${abs("/terms")}`);
});

check("non-GET requests are ignored", async () => {
  const world = await installedWorld();
  ignored(await world.get("/api/x", { method: "POST" }));
  ignored(await world.get("/terms", { method: "POST" }));
  ignored(await world.get("/app.js", { method: "HEAD" }));
  assert.deepEqual(world.fetchLog, []);
});

check("other-origin requests are ignored", async () => {
  const world = await installedWorld();
  ignored(await world.get("https://example.com/app.js"));
  ignored(await world.get("https://example.com/terms", { mode: "navigate" }));
  ignored(await world.get("https://example.com/api/config"));
  assert.deepEqual(world.fetchLog, []);
});

check("install precaches exactly PRECACHE_URLS into CACHE_NAME", async () => {
  const world = makeWorld();
  await world.install();
  assert.equal(world.addAllLog.length, 1);
  assert.equal(world.addAllLog[0].cache, world.cacheName());
  assert.deepEqual(world.addAllLog[0].urls, world.precacheUrls().map(abs));
  assert.ok(world.precacheUrls().every((u) => !/\/(terms|privacy|api)(\.html|\/|$)/.test(abs(u))), "legal pages and API stay out of the precache");
});

check("activate deletes every cache except CACHE_NAME, so no /api/* entry survives", async () => {
  const world = makeWorld();
  const current = world.cacheName();
  world.seed("qcards-v23", "/api/entitlement", "STALE");
  world.seed("qcards-v22", "/api/config", "STALE");
  world.seed("something-else", "/api/checkout/confirm?session_id=x", "STALE");
  world.seed(current, "/app.js", "keep");
  await world.activate();
  assert.deepEqual([...world.stores.keys()], [current]);
  assert.deepEqual(world.cacheKeys(current), [abs("/app.js")]);
  for (const name of world.stores.keys()) {
    assert.ok(world.cacheKeys(name).every((url) => !new URL(url).pathname.startsWith("/api/")), `/api/* entry in ${name}`);
  }
  assert.ok(world.claimed, "clients.claim was not called");
});

check("CACHE_NAME version is above 23", async () => {
  const match = /^qcards-v(\d+)$/.exec(makeWorld().cacheName());
  assert.ok(match, "CACHE_NAME must look like qcards-vNN");
  assert.ok(Number(match[1]) >= NEXT_VERSION, `CACHE_NAME version must be at least ${NEXT_VERSION}, got ${match[1]}`);
});

// -------------------------------------------------------------- static checks

function stripComments(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 2;
    } else if (c === '"' || c === "'" || c === "`") {
      out += c;
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === "\\") out += src[i++];
        out += src[i++] ?? "";
      }
      out += c;
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

// Index just past the ")" that closes the "(" at openIdx, skipping strings.
function closeParen(code, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < code.length; i++) {
    const c = code[i];
    if (c === '"' || c === "'" || c === "`") {
      i++;
      while (i < code.length && code[i] !== c) i += code[i] === "\\" ? 2 : 1;
    } else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i + 1;
  }
  throw new Error("unbalanced parentheses in sw.js");
}

check("sw.js has exactly one cache put", async () => {
  const code = stripComments(swSource);
  const puts = code.match(/\.put\s*\(|\[\s*["'`]put["'`]\s*\]/g) || [];
  assert.equal(puts.length, 1, `expected exactly one .put( in sw.js, found ${puts.length}`);
});

check("sw.js calls cache add/addAll only inside the install handler", async () => {
  const code = stripComments(swSource);
  const start = code.indexOf('addEventListener("install"');
  assert.ok(start >= 0, 'no addEventListener("install") found');
  const end = closeParen(code, code.indexOf("(", start));
  for (const match of code.matchAll(/\.(?:add|addAll)\s*\(|\[\s*["'`]add(?:All)?["'`]\s*\]/g)) {
    assert.ok(match.index >= start && match.index < end, `${match[0]} outside the install handler at offset ${match.index}`);
  }
});

const readClient = (file) => readFileSync(path.join(CLIENT_DIR, file), "utf8");
const isLocal = (ref) => ref && !ref.startsWith("#") && !/^[a-z][a-z0-9+.-]*:/i.test(ref) && !ref.startsWith("//");

// Absolute URL (fragment dropped) of a reference found in a file served at
// the site root, or null when it is not a local asset.
function assetUrl(ref) {
  if (!isLocal(ref.trim())) return null;
  const url = new URL(ref.trim(), `${ORIGIN}/`);
  url.hash = "";
  return url.href;
}

check("every PRECACHE_URLS file exists on disk", async () => {
  for (const entry of makeWorld().precacheUrls()) {
    const url = new URL(entry, SW_URL);
    let rel = decodeURIComponent(url.pathname).replace(/^\//, "");
    if (rel === "") rel = "index.html";
    assert.ok(existsSync(path.join(CLIENT_DIR, rel)), `${entry} is precached but ${rel} does not exist`);
  }
});

check("every local asset index.html, terms.html, privacy.html, style.css and the manifest load is in PRECACHE_URLS", async () => {
  const precached = new Set(makeWorld().precacheUrls().map(abs));
  const referenced = new Map(); // absolute URL -> where it was referenced

  // The legal pages are served offline from the cache too, and load the same
  // shell assets, so they are held to the same rule.
  for (const file of ["index.html", "terms.html", "privacy.html"]) {
    const html = readClient(file).replace(/<!--[\s\S]*?-->/g, "");
    for (const tag of html.matchAll(/<(link|script|img|source|video|audio|iframe)\b[^>]*>/gi)) {
      for (const attr of tag[0].matchAll(/\b(?:href|src)\s*=\s*"([^"]*)"|\b(?:href|src)\s*=\s*'([^']*)'/gi)) {
        const url = assetUrl(attr[1] ?? attr[2]);
        if (url) referenced.set(url, `${file} ${tag[1]}`);
      }
    }
  }

  const css = readClient("style.css").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi)) {
    const url = assetUrl(m[1] ?? m[2] ?? m[3]);
    if (url) referenced.set(url, "style.css url()");
  }

  const manifest = JSON.parse(readClient("manifest.webmanifest"));
  const manifestRefs = [manifest.start_url];
  for (const list of [manifest.icons, manifest.screenshots, ...(manifest.shortcuts || []).map((s) => s.icons)]) {
    (list || []).forEach((item) => manifestRefs.push(item.src));
  }
  for (const ref of manifestRefs) {
    const url = ref && assetUrl(ref);
    if (url) referenced.set(url, "manifest.webmanifest");
  }

  assert.ok(referenced.size > 10, `suspiciously few referenced assets (${referenced.size}); did the parsing break?`);
  const missing = [...referenced].filter(([url]) => !precached.has(url));
  assert.deepEqual(
    missing.map(([url, where]) => `${url.replace(ORIGIN, "")} (${where})`),
    [],
    "loaded by the app but missing from PRECACHE_URLS (it would fail offline)"
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
