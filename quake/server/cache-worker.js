// Source served at /quake/sw.js. Its scope remains /quake/ and therefore cannot
// control any part of the ChaOS desktop.
export const quakeAssetCacheWorker = String.raw`/* Quake asset runtime cache — /quake/ scope only. */
// v1 returned unversioned engine/pak/chunk bytes forever, hiding installs.
const CACHE = 'chaos-quake-assets-v2';
const assetPath = pathname => /^\/quake\/(?:baseq3\/|ioquake3\.(?:js|wasm)$|_next\/static\/)/.test(pathname);

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil((async () => {
  const keys = await caches.keys();
  await Promise.all(keys
    .filter(key => key.startsWith('chaos-quake-assets-') && key !== CACHE)
    .map(key => caches.delete(key)));
  await self.clients.claim();
})()));

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || !assetPath(url.pathname)) return;
  // Partial/conditional requests belong to HTTP, not a full-body CacheStorage
  // snapshot; caller no-store and authenticated requests never use this cache.
  if (request.cache === 'no-store' || ['range', 'if-range', 'if-none-match', 'if-modified-since', 'authorization']
    .some(name => request.headers.has(name))) return;
  event.respondWith((async () => {
    let response;
    try {
      // HTTP validators keep unchanged large files cheap while detecting new
      // bytes at the same URL. CacheStorage is only an offline fallback.
      response = await fetch(request, { cache: 'no-cache' });
    } catch (error) {
      const cached = await caches.open(CACHE).then(cache => cache.match(request)).catch(() => null);
      if (cached) return cached;
      throw error;
    }
    const noStore = /(?:^|,)\s*no-store\b/i.test(response.headers.get('cache-control') || '');
    if (response.status === 200 && response.type === 'basic' && !response.headers.has('content-range') && !noStore) {
      const copy = response.clone();
      event.waitUntil(caches.open(CACHE).then(cache => cache.put(request, copy)).catch(() => {}));
    } else if (noStore || response.status === 404 || response.status === 410) {
      event.waitUntil(caches.open(CACHE).then(cache => cache.delete(request)).catch(() => {}));
    }
    return response;
  })());
});
`;
