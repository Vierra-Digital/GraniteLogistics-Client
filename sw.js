/* Granite Logistics service worker.
 * NETWORK-FIRST for the app shell: a fresh deploy shows up immediately whenever the
 * device is online, while a cache fallback keeps the app usable offline. This avoids
 * the "installed PWA is stuck on an old version" problem that cache-first causes. */
var CACHE = "granite-logistics-v60";
var ASSETS = [
  "./", "./index.html", "./app.html", "./track.html", "./landing.css", "./landing.js",
  "./styles.css", "./app.js", "./barcode.js", "./manifest.webmanifest",
  "./assets/logo.png", "./assets/logo-mark.png", "./assets/favicon-32.png", "./assets/apple-touch-icon.png"
];

self.addEventListener("install", function (e) {
  // Take over as soon as installed so a new version doesn't wait for every tab to close.
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("message", function (e) {
  if (e.data === "skip-waiting") self.skipWaiting();
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  if (req.url.indexOf("/api/") !== -1) return; // never cache API calls

  // Network-first: always try the live version so deploys win; fall back to cache offline.
  e.respondWith(
    fetch(req).then(function (res) {
      if (res && res.ok && res.type === "basic") {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () {
      // Offline. Try the exact request first, then the same URL ignoring its query
      // string, so a deep link like /track.html?n=GL-1041 still resolves to the cached
      // /track.html instead of missing and being served the wrong page.
      return caches.match(req).then(function (hit) {
        return hit || caches.match(req, { ignoreSearch: true });
      }).then(function (hit) {
        if (hit) return hit;
        // Only substitute a document for an actual navigation. Handing app.html back
        // for a missing stylesheet or image would be worse than failing honestly.
        if (req.mode === "navigate") {
          return caches.match("./app.html").then(function (h) { return h || caches.match("./index.html"); });
        }
        return Response.error();
      });
    })
  );
});
