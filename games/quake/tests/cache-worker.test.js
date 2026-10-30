import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { quakeAssetCacheWorker } from '../server/cache-worker.js';

const origin = 'https://game.invalid';
const reply = (body, options) => Object.defineProperty(new Response(body, options), 'type', { value: 'basic' });
function fixture() {
  const handlers = new Map(), stores = new Map(), calls = [];
  let network = () => reply('v1', { headers: { 'cache-control': 'no-cache' } });
  let refused = false;
  const caches = {
    keys: async () => [...stores.keys()],
    delete: async key => stores.delete(key),
    async open(name) {
      if (refused) throw new Error('cache storage unavailable');
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name), key = request => typeof request === 'string' ? request : request.url;
      return {
        match: async request => store.get(key(request))?.clone(),
        put: async (request, response) => { store.set(key(request), response.clone()); },
        delete: async request => store.delete(key(request)),
      };
    },
  };
  const self = { location: { origin }, addEventListener: (name, fn) => handlers.set(name, fn),
    skipWaiting() {}, clients: { claim() {} } };
  runInNewContext(quakeAssetCacheWorker, { self, caches, URL, fetch: async (request, options) => {
    calls.push({ request, options }); return network(request, options);
  } });
  return {
    calls, stores, caches,
    network(fn) { network = fn; },
    refuseCache() { refused = true; },
    async fetch(path, options) {
      const waits = [];
      let response;
      const request = new Request(new URL(path, origin), options);
      handlers.get('fetch')({ request, respondWith(value) { response = value; }, waitUntil(value) { waits.push(value); } });
      if (!response) return null;
      const result = await response;
      await Promise.all(waits);
      return result;
    },
    async activate() {
      const waits = [];
      handlers.get('activate')({ waitUntil(value) { waits.push(value); } });
      await Promise.all(waits);
    },
  };
}

test('a stable Quake URL revalidates online and replaces its offline copy', async () => {
  const f = fixture();
  assert.equal(await (await f.fetch('/quake/ioquake3.js')).text(), 'v1');
  f.network(() => reply('v2', { headers: { 'cache-control': 'no-cache' } }));
  assert.equal(await (await f.fetch('/quake/ioquake3.js')).text(), 'v2');
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].options.cache, 'no-cache');
  f.network(() => { throw new TypeError('offline'); });
  assert.equal(await (await f.fetch('/quake/ioquake3.js')).text(), 'v2');
  assert.equal(f.calls.length, 3);
});
test('Range, conditional, authenticated and no-store requests bypass CacheStorage', async () => {
  const f = fixture();
  for (const options of [{ headers: { range: 'bytes=2-5' } }, { headers: { 'if-range': '"old"' } },
    { headers: { 'if-none-match': '"old"' } }, { headers: { 'if-modified-since': 'Wed, 01 Jan 2020 00:00:00 GMT' } },
    { headers: { authorization: 'synthetic' } }, { cache: 'no-store' }]) {
    assert.equal(await f.fetch('/quake/baseq3/pak0.pk3', options), null);
  }
  assert.equal(f.calls.length, 0);
});
test('worker never intercepts documents, APIs, unrelated scopes or writes', async () => {
  const f = fixture();
  for (const path of ['/quake/game', '/quake/game?_rsc=1', '/api/history', '/surf/assets/game.js', 'https://other.invalid/quake/ioquake3.js']) {
    assert.equal(await f.fetch(path), null);
  }
  assert.equal(await f.fetch('/quake/ioquake3.js', { method: 'POST', body: 'ignored' }), null);
});
test('storage failure cannot turn a successful network response into a failed game load', async () => {
  const f = fixture(); f.refuseCache();
  assert.equal(await (await f.fetch('/quake/ioquake3.wasm')).text(), 'v1');
});
test('HTTP errors are returned and deletion evicts an old offline copy', async () => {
  const f = fixture();
  await f.fetch('/quake/baseq3/pak0.pk3');
  f.network(() => reply('gone', { status: 404 }));
  const response = await f.fetch('/quake/baseq3/pak0.pk3');
  assert.equal(response.status, 404);
  f.network(() => { throw new TypeError('offline'); });
  await assert.rejects(f.fetch('/quake/baseq3/pak0.pk3'), /offline/);
});
test('no-store and partial responses never populate the offline cache', async () => {
  for (const options of [{ headers: { 'cache-control': 'no-store' } }, { status: 206, headers: { 'content-range': 'bytes 0-1/8' } }]) {
    const f = fixture();
    f.network(() => reply('not cached', options));
    await f.fetch('/quake/ioquake3.wasm');
    f.network(() => { throw new TypeError('offline'); });
    await assert.rejects(f.fetch('/quake/ioquake3.wasm'), /offline/);
  }
});
test('a no-store replacement removes an older offline copy and HTTP 503 stays visible online', async () => {
  const f = fixture();
  await f.fetch('/quake/ioquake3.js');
  f.network(() => reply('temporarily unavailable', { status: 503 }));
  assert.equal((await f.fetch('/quake/ioquake3.js')).status, 503);
  f.network(() => reply('restricted', { headers: { 'cache-control': 'private, no-store' } }));
  assert.equal(await (await f.fetch('/quake/ioquake3.js')).text(), 'restricted');
  f.network(() => { throw new TypeError('offline'); });
  await assert.rejects(f.fetch('/quake/ioquake3.js'), /offline/);
});
test('activation removes v1 immutable snapshots while preserving unrelated caches', async () => {
  const f = fixture();
  f.stores.set('chaos-quake-assets-v1', new Map());
  f.stores.set('another-feature', new Map());
  await f.activate();
  assert.equal(f.stores.has('chaos-quake-assets-v1'), false);
  assert.equal(f.stores.has('another-feature'), true);
});
