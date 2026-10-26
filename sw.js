// Keeps a copy of the app on the device so it opens with no connection.
//
// Network first: when the device is online it always gets the latest files
// (and refreshes the stored copy); offline, or if the network is too slow,
// the stored copy is used. So updates reach tablets on their own the next
// time they open the app with a connection.
//
// Each file is stored on its own, so one missing file (an icon, say) can't
// stop the rest being saved. The page checks the ESSENTIAL files are all
// stored before it says it is ready to use offline.
const CACHE = 'field-logger';
const ESSENTIAL = ['./', 'index.html', 'app.js', 'recorder-worklet.js'];
const OPTIONAL = ['manifest.webmanifest', 'icon-192.png', 'icon-512.png'];
const NETWORK_TIMEOUT_MS = 3000;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE)
    .then((c) => Promise.allSettled([...ESSENTIAL, ...OPTIONAL].map((f) => c.add(f))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      // Fetch by URL: a page navigation can't be re-issued with options.
      const response = await Promise.race([
        fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), NETWORK_TIMEOUT_MS)),
      ]);
      if (response.ok) cache.put(req.url, response.clone());
      return response;
    } catch (e) {
      const hit = await cache.match(req.url, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate') {
        const page = await cache.match('./');
        if (page) return page;
      }
      throw e;
    }
  })());
});
