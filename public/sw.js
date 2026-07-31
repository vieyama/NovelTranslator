// Lightweight "cache pages I've already opened" service worker (SPEC.md §3.5).
//
// Not a full offline-first rewrite: there's no precache list and no attempt to
// let the reader work on pages never visited. Every same-origin GET response
// (navigations, Next's RSC fetches, static assets) is stored network-first;
// if a later request for that exact URL fails (offline / server down), the
// last-seen cached response is served instead of a browser error page.
//
// Mutations (POST/PATCH/DELETE — translate, mark-read, delete book) are never
// intercepted: those need a live server by definition, and must never be
// answered from a stale cache.

const CACHE_NAME = "novel-translator-v1";
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.add(OFFLINE_URL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  if (request.method !== "GET") return;
  if (new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);

      try {
        const response = await fetch(request);
        if (response.ok) {
          await cache.put(request, response.clone());
        }
        return response;
      } catch {
        const cached = await cache.match(request);
        if (cached) return cached;

        if (request.mode === "navigate") {
          const offline = await cache.match(OFFLINE_URL);
          if (offline) return offline;
        }

        throw new Error("offline and not cached");
      }
    })(),
  );
});
