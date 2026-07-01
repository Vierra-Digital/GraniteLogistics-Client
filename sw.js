/* Granite Logistics — service worker.
 * NETWORK-FIRST for the app shell: a fresh deploy shows up immediately whenever the
 * device is online, while a cache fallback keeps the app usable offline. This avoids
 * the "installed PWA is stuck on an old version" problem that cache-first causes. */
var CACHE = "granite-logistics-v51";
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
      return caches.match(req).then(function (hit) {
        return hit || caches.match("./app.html") || caches.match("./index.html");
      });
    })
  );
});
