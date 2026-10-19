// Makes the app installable and lets the page shell open offline.
// Ship data always comes from the network.
const CACHE = 'ship-track-v11';
const SHELL = ['/', '/style.css', '/app.js', '/icons/icon.svg', '/icons/icon-180.png', '/icons/icon-192.png', '/icons/icon-512.png', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  // Network first, so a new version shows on the next load; the cache is only for offline.
  e.respondWith(caches.open(CACHE).then((cache) => fetch(e.request).then((res) => {
    if (res.ok) cache.put(e.request, res.clone());
    return res;
  }).catch(() => cache.match(e.request))));
});
