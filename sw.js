// Cache-first offline shell (CAP-6). Bump CACHE_NAME on any asset change
// so returning devices pick up the new version instead of a stale cache.
const CACHE_NAME = "qcards-v17";

const PRECACHE_URLS = [
  "./",
  "./style.css",
  "./app.js",
  "./ui.js",
  "./questions.js",
  "./challenges.js",
  "./games.js",
  "./prompts.js",
  "./draw.js",
  "./manifest.webmanifest",
  "./fonts/poppins.woff2",
  "./fonts/poppins-ext.woff2",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-512-maskable.png",
  "./icons/apple-touch-icon.png",
];

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

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;

      return fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => {
          if (event.request.mode === "navigate") {
            return caches.match("./");
          }
          return undefined;
        });
    })
  );
});
