const CACHE = 'tycoon-mafia-v1';
const ASSETS = ['/index.html', '/main.html', '/chat.html', '/option.html', '/setroles.html', '/manifest.json', '/LOGO.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

// Network first, fallback to cache
self.addEventListener('fetch', e => {
  if (e.request.url.includes('/socket.io')) return; // never cache socket
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
