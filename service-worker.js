// Service worker — installable PWA + offline cache.
// Same-origin: network-first (so GitHub updates show), fall back to cache offline.
// Cross-origin (Google Apps Script data, Google Fonts): pass straight through.
const CACHE = 'vs-countdown-v1';
const CORE = [
  './', './index.html',
  './icon-192.png', './icon-512.png', './apple-touch-icon.png',
  './images/p1.png', './images/p2.png', './images/p3.png', './images/p4.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return; // let Apps Script / fonts pass through
  e.respondWith(
    fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
      return res;
    }).catch(() => caches.match(req))
  );
});
