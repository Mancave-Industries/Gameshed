// Game Shed service worker: network first, fall back to the cached hub when offline.
const CACHE = 'gameshed-v2';
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'assets/gameshed-badge.webp', 'assets/shed-art-v3.webp', 'assets/shed-art-v3-mobile.webp', 'assets/icon-192.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || !url.pathname.startsWith('/Gameshed/')) return;
  e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; })
    .catch(() => caches.match(e.request).then(m => m || caches.match('index.html'))));
});
