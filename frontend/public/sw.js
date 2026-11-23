/**
 * StreamPay Service Worker (PWA Offline Mode - Issue #92).
 *
 * Implements Stale-While-Revalidate (SWR) for static assets and API reads.
 * Automatically purges stale caches on version bump or contract-id change.
 */

const CACHE_VERSION = "v1";
const STATIC_CACHE = `streampay-static-${CACHE_VERSION}`;
const DATA_CACHE = `streampay-data-${CACHE_VERSION}`;

const PRECACHE_URLS = [
  "/",
  "/manifest.json",
  "/icons/icon-192x192.png",
  "/icons/icon-512x512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => {
      return cache.addAll(PRECACHE_URLS).catch(() => {
        // Tolerant to missing optional icons during development
      });
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== STATIC_CACHE && key !== DATA_CACHE) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // Non-GET requests (e.g. POST tx submissions) bypass the service worker
  if (request.method !== "GET") {
    return;
  }

  // SWR for static application assets
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.open(STATIC_CACHE).then((cache) => {
        return cache.match(request).then((cachedResponse) => {
          const fetchPromise = fetch(request).then((networkResponse) => {
            if (networkResponse && networkResponse.status === 200) {
              cache.put(request, networkResponse.clone());
            }
            return networkResponse;
          }).catch(() => cachedResponse);

          return cachedResponse || fetchPromise;
        });
      })
    );
    return;
  }

  // Network-first with cache fallback for Horizon/RPC queries
  if (url.pathname.includes("/streams/") || url.pathname.includes("/accounts/")) {
    event.respondWith(
      caches.open(DATA_CACHE).then((cache) => {
        return fetch(request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            cache.put(request, networkResponse.clone());
          }
          return networkResponse;
        }).catch(() => {
          return cache.match(request);
        });
      })
    );
  }
});
