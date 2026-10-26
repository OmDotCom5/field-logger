// Keeps a copy of the app on the device so it opens with no connection.
//
// Network first: when the device is online it always gets the latest files
// (and refreshes the stored copy); offline, or if the network is too slow,
// the stored copy is used. So updates reach tablets on their own the next
// time they open the app with a connection.
const CACHE = 'field-logger';
const FILES = ['./', 'index.html', 'app.js', 'recorder-worklet.js', 'manifest.webmanifest',
               'icons/icon-192.png', 'icons/icon-512.png'];
const NETWORK_TIMEOUT_MS = 3000;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await Promise.race([
        fetch(event.request, { cache: 'no-cache' }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), NETWORK_TIMEOUT_MS)),
      ]);
      if (response.ok) cache.put(event.request, response.clone());
      return response;
    } catch (e) {
      const hit = await cache.match(event.request, { ignoreSearch: true });
      if (hit) return hit;
      throw e;
    }
  })());
});
