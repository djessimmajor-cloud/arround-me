const CACHE_NAME = "yopi-v2";
const ASSETS = ["./manifest.json", "./icon-192.png", "./icon-512.png", "./assets/hero-banner.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Never cache API calls or cross-origin requests — always go straight to
  // the network so /api/places respects its own Cache-Control freshness window.
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  // The app shell (HTML / navigations) must always be checked against the
  // network first so deploys show up immediately. Cache is only a fallback
  // for when the user is offline.
  const isAppShell = event.request.mode === "navigate" || url.pathname.endsWith("index.html") || url.pathname === "/";
  if (isAppShell) {
    event.respondWith(
      fetch(event.request).then((resp) => {
        if (resp && resp.ok) {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return resp;
      }).catch(() => caches.match(event.request))
    );
    return;
  }

  // Static assets (icons, images, manifest): cache-first is fine, they rarely change.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((resp) => {
        if (resp && resp.ok) {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return resp;
      }).catch(() => cached);
    })
  );
});
