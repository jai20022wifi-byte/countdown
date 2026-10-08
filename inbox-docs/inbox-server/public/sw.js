// INBOX app shell. The page itself is fetched fresh first (falls back to the device copy when offline),
// so a new upload on GitHub shows on the next open. Libraries and icons open from the device cache.
// Calls to Google (Apps Script, Drive) are never cached here.
const CACHE = 'inbox-shell-v4';
const SHELL = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  const own = u.origin === location.origin, lib = /cdn\.jsdelivr\.net|fonts\.(googleapis|gstatic)\.com/.test(u.host);
  if (!own && !lib) return;
  const page = own && (e.request.mode === 'navigate' || /\/(index\.html)?$/.test(u.pathname));
  e.respondWith(caches.open(CACHE).then(async c => {
    if (page) {
      try { const r = await fetch(e.request, { cache: 'no-store' }); if (r && r.ok) c.put(e.request, r.clone()); return r; }
      catch (err) { return (await c.match(e.request, { ignoreSearch: true })) || (await c.match('./index.html')); }
    }
    const hit = await c.match(e.request, { ignoreSearch: own });
    const net = fetch(e.request).then(r => { if (r && (r.ok || r.type === 'opaque')) c.put(e.request, r.clone()); return r; }).catch(() => hit);
    return hit || net;
  }));
});

// Web Push: show the notification; tapping it opens (or focuses) the app on that document.
self.addEventListener('push', e => {
  let d = {}; try { d = e.data.json(); } catch (x) { d = { title: 'INBOX', body: e.data ? e.data.text() : '' }; }
  const setBadge = typeof d.badge === 'number' && self.navigator.setAppBadge ? (d.badge ? self.navigator.setAppBadge(d.badge) : self.navigator.clearAppBadge()).catch(() => {}) : Promise.resolve();
  e.waitUntil(Promise.all([setBadge, self.registration.showNotification(d.title || 'INBOX', { body: d.body || '', icon: './icon-192.png', badge: './icon-192.png', tag: d.tag, renotify: !!d.tag, data: { url: d.url || './', doc: d.doc } })]));
});
self.addEventListener('notificationclick', e => {
  e.notification.close(); const { url, doc } = e.notification.data || {};
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(ws => {
    const w = ws[0]; if (w) { if (doc) w.postMessage({ openDoc: doc }); return w.focus(); }
    return clients.openWindow(url || './');
  }));
});
