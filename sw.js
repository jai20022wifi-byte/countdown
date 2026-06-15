/* Service worker for the Price Calculator PWA.
   Caches only the calculator's own assets so it works fully offline.
   Any request not in this app's shell is passed straight to the network,
   so it never interferes with other pages served from the same origin. */

const CACHE = 'price-calc-v2';

// App shell — the files the calculator needs to run offline.
const SHELL = [
  'price-calculator.html',
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const path = url.pathname.split('/').pop();
  const isShell = url.origin === self.location.origin && SHELL.includes(path);
  const isFont = url.hostname.includes('fonts.googleapis.com') || url.hostname.includes('fonts.gstatic.com');

  // Only handle our own app shell and the web font; leave everything else alone.
  if (!isShell && !isFont) return;

  const isHTML = path === 'price-calculator.html' || req.mode === 'navigate';

  if (isHTML) {
    // Network-first for the page: always get the latest version when online,
    // fall back to the cached copy when offline.
    event.respondWith(
      fetch(req).then((res) => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('price-calculator.html', copy));
        }
        return res;
      }).catch(() => caches.match(req).then((c) => c || caches.match('price-calculator.html')))
    );
    return;
  }

  // Cache-first for static assets (icons, manifest, font) — and cache on first online load.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => cached);
    })
  );
});
