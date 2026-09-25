// Offline shell (CAP-6), as an allowlist. Bump CACHE_NAME on any change to the
// precached files or to this file, so returning devices drop the old cache
// (activate deletes every cache except CACHE_NAME) instead of a stale one.
//
// Rules, in order:
//   1. Other origin or non-GET: ignored, the browser handles it.
//   2. The four legal-page URLs: network-first, the copy is refreshed on every
//      successful online fetch; the cache is used only when offline or on a 5xx.
//   3. PRECACHE_URLS members (exact URL, no query string): cache-first, never
//      written at runtime.
//   4. A navigation to anything else (for example the return from Stripe):
//      network, falling back to the cached "./" only when offline.
//   5. Everything else (every /api/* call, Source Links, URLs with a query
//      string): no respondWith at all, a plain network request that fails
//      visibly. Parent-facing state (subscription, prices, limits) must never
//      come from this cache.
//
// scripts/check-sw.mjs simulates this worker and proves each rule. It is run by
// hand until Epic 4.4 wires it into the pipeline: node scripts/check-sw.mjs
const CACHE_NAME = "qcards-v28"; // bumped: draw prompt bank rewritten for simpler/quicker-to-sketch subjects (prompts.js)

const PRECACHE_URLS = [
  "./",
  "./style.css",
  "./i18n.js",
  "./app.js",
  "./ui.js",
  "./questions.js",
  "./templates.js",
  "./challenges.js",
  "./games.js",
  "./prompts.js",
  "./draw.js",
  "./monetize.js",
  "./legal.js",
  "./manifest.webmanifest",
  "./fonts/poppins.woff2",
  "./fonts/poppins-ext.woff2",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-512-maskable.png",
  "./icons/apple-touch-icon.png",
];

// Production answers /terms.html with a redirect to /terms (and the same for
// privacy); dev servers serve the .html file directly. Match both addresses.
const LEGAL_PAGES = [
  ["./terms", "./terms.html"],
  ["./privacy", "./privacy.html"],
];

const absolute = (url) => new URL(url, self.location).href;

const HOME = absolute("./");
const PRECACHED = new Set(PRECACHE_URLS.map(absolute));
// Absolute legal URL -> both addresses of that page, its own address first.
const LEGAL = new Map();
LEGAL_PAGES.forEach((pair) => {
  const urls = pair.map(absolute);
  urls.forEach((url) => LEGAL.set(url, [url, ...urls.filter((other) => other !== url)]));
});

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

// First cached copy among the given URLs, or undefined.
async function fromCache(cache, urls) {
  for (const url of urls) {
    const cached = await cache.match(url);
    if (cached) return cached;
  }
  return undefined;
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request.url);
  return cached || fetch(request);
}

async function networkFirst(event, addresses) {
  const cache = await caches.open(CACHE_NAME);
  let response;
  try {
    response = await fetch(event.request);
  } catch (error) {
    const cached = await fromCache(cache, addresses);
    if (cached) return cached;
    throw error;
  }
  if (response.ok && !response.redirected) {
    // Only a real 200-range page served at this address is kept; a redirect
    // (opaque, or followed) or an error page is not.
    event.waitUntil(cache.put(event.request.url, response.clone()).catch(() => {}));
  } else if (response.status >= 500) {
    const cached = await fromCache(cache, addresses);
    if (cached) return cached;
  }
  return response;
}

async function navigateWithFallback(request) {
  try {
    return await fetch(request);
  } catch (error) {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(HOME);
    if (cached) return cached;
    throw error;
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== new URL(self.location).origin) return;

  const legal = LEGAL.get(request.url);
  if (legal) {
    event.respondWith(networkFirst(event, legal));
    return;
  }

  if (PRECACHED.has(request.url)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  if (request.mode === "navigate" && !url.pathname.startsWith("/api/")) {
    event.respondWith(navigateWithFallback(request));
  }
});
