// Offline support. The whole game is a single HTML file plus a few icons, so everything is
// precached on install. Requests go to the network first, so a new deploy shows up right away,
// and fall back to the cache when offline (or when the network is too slow to answer).
const CACHE = 'dice-isles-v1';
const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/favicon.svg',
  './icons/favicon-32.png',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './easter/dog.webp',
];
const NETWORK_TIMEOUT = 4000;

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(networkFirst(request));
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  const network = fetch(request).then(response => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  });
  network.catch(() => {}); // a late failure after we already answered from the cache is fine
  const fromCache = () => cache.match(request, { ignoreSearch: true })
    .then(hit => hit || (request.mode === 'navigate' ? cache.match('./index.html') : undefined));

  try {
    // Don't leave the player staring at a blank screen on a flaky connection.
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), NETWORK_TIMEOUT));
    return await Promise.race([network, timeout]);
  } catch {
    const cached = await fromCache();
    if (cached) return cached;
    return network.catch(() => Response.error());
  }
}
