import assert from 'node:assert/strict';
import test from 'node:test';
import { createEngineResources, defaultCacheLimit } from '../client/engine/resources.js';
import { createBrowserFileSystem } from '../client/engine/vfs.js';

test('RAM cache scales with the browser memory hint without reserving it up front', () => {
  assert.equal(defaultCacheLimit(2), 128 * 1024 * 1024);
  assert.equal(defaultCacheLimit(4), 256 * 1024 * 1024);
  assert.equal(defaultCacheLimit(8), 512 * 1024 * 1024);
  assert.equal(defaultCacheLimit(undefined), 256 * 1024 * 1024);
});

function temporaryStorage() {
  const caches = new Map();
  return {
    caches,
    async open(name) {
      if (!caches.has(name)) caches.set(name, new Map());
      const entries = caches.get(name);
      return {
        match: async (url) => entries.get(url)?.clone(),
        put: async (url, response) => entries.set(url, response.clone()),
      };
    },
    async delete(name) {
      return caches.delete(name);
    },
  };
}

test('leaving the page releases its temporary cache and is safe to dispose again', async () => {
  const window = new EventTarget(),
    storage = temporaryStorage();
  const resources = createEngineResources({
    window,
    storage,
    fetch: async () => new Response('pack'),
  });
  await resources.fetchFile('/mugen/hero.sff');
  window.dispatchEvent(new Event('pagehide'));
  await resources.dispose();
  await resources.dispose();
  assert.equal(storage.caches.size, 0);
  assert.equal(resources.status().bytes, 0);
});

test('large fighters remain cached across matches after RAM eviction, with private writable files', async () => {
  const storage = temporaryStorage();
  const fetched = [];
  const resources = createEngineResources({
    storage,
    maxBytes: 3,
    fetch: async (url) => {
      fetched.push(url);
      return new Response(new Uint8Array([1, 2, 3, 4]));
    },
  });
  const files = {
    groups: [
      {
        prefix: 'chars/',
        base: '/mugen/',
        files: [
          ['hero/hero.sff', 4],
          ['hero/hero.snd', 4],
        ],
      },
    ],
  };
  const call = (fs, method, ...args) =>
    new Promise((resolve, reject) =>
      fs[method](...args, (error, value) => (error ? reject(error) : resolve(value))),
    );
  const open = async () => {
    const vfs = createBrowserFileSystem(files, { fetchFile: resources.fetchFile });
    for (const path of ['chars/hero/hero.sff', 'chars/hero/hero.snd']) {
      const fd = await call(vfs.fs, 'open', path, 0, 0);
      await call(vfs.fs, 'close', fd);
    }
    return vfs;
  };
  const first = await open();
  first.writeText('chars/hero/hero.sff', 'modified');
  const second = await open();
  assert.deepEqual(fetched, ['/mugen/hero/hero.sff', '/mugen/hero/hero.snd']);
  assert.deepEqual(
    [...new TextEncoder().encode(second.readText('chars/hero/hero.sff'))],
    [1, 2, 3, 4],
  );
  assert.equal(
    resources.status().bytes,
    0,
    'oversized files live on disk rather than accumulating in RAM',
  );
  assert.equal(storage.caches.size, 1);
  await resources.dispose();
  assert.equal(storage.caches.size, 0);
});

test('engine scripts refresh when only the bundle revision changes', async () => {
  const fetched = [];
  const storage = temporaryStorage();
  let revision = 'r3';
  const resources = createEngineResources({
    storage,
    compile: async () => ({}),
    fetch: async (url) => {
      fetched.push(url);
      if (url === '/api/mugen/fs')
        return Response.json({
          engine: { version: revision, wasm: 'same.wasm' },
          groups: [{ prefix: '', base: '/engine/fs/', files: [['external/script/main.lua', 1]] }],
        });
      return new Response('x');
    },
  });
  for (const version of ['r3', 'r4']) {
    revision = version;
    await resources.warm();
    const vfs = createBrowserFileSystem(await resources.manifest(), {
      fetchFile: resources.fetchFile,
    });
    await new Promise((resolve, reject) =>
      vfs.fs.open('external/script/main.lua', 0, 0, (error) => (error ? reject(error) : resolve())),
    );
  }
  assert.equal(
    fetched.filter((url) => url === '/engine/fs/external/script/main.lua?v=r3').length,
    1,
  );
  assert.equal(
    fetched.filter((url) => url === '/engine/fs/external/script/main.lua?v=r4').length,
    1,
  );
  assert.equal(fetched.filter((url) => url.endsWith('same.wasm')).length, 1);
  await resources.dispose();
});

test('blocked browser storage falls back to memory and still permits matches', async () => {
  let fetched = 0;
  const resources = createEngineResources({
    storage: {
      open: async () => {
        throw new Error('disabled');
      },
    },
    fetch: async () => {
      fetched++;
      return new Response('bytes');
    },
  });
  await resources.fetchFile('/mugen/hero.sff');
  await resources.fetchFile('/mugen/hero.sff');
  assert.equal(fetched, 1);
  await resources.dispose();
});

test('compiled engine and original asset bytes survive successive match filesystems', async () => {
  const calls = [];
  let compiled = 0;
  const resources = createEngineResources({
    fetch: async (url) => {
      calls.push(url);
      return new Response(new Uint8Array([1, 2, 3]));
    },
    compile: async () => ({ id: ++compiled }),
  });
  const [first, second] = await Promise.all([
    resources.engine({ wasm: 'one.wasm' }),
    resources.engine({ wasm: 'one.wasm' }),
  ]);
  assert.equal(first, second);
  assert.equal(await resources.engine({ wasm: 'one.wasm' }), first);
  const a = new Uint8Array(await (await resources.fetchFile('/pack')).arrayBuffer());
  a[0] = 99;
  const b = new Uint8Array(await (await resources.fetchFile('/pack')).arrayBuffer());
  assert.deepEqual([...b], [1, 2, 3]);
  assert.equal(calls.length, 2);
  assert.equal(compiled, 1);
  await resources.engine({ wasm: 'two.wasm' });
  assert.equal(resources.status().modules, 1);
  resources.dispose();
  assert.deepEqual(resources.status(), { modules: 0, assets: 0, bytes: 0 });
});

test('resource cache bounds pack memory and retries failures', async () => {
  let count = 0;
  const resources = createEngineResources({
    maxBytes: 3,
    fetch: async () => {
      if (++count === 1) throw new Error('offline');
      return new Response(new Uint8Array([1, 2, 3]));
    },
  });
  await assert.rejects(resources.fetchFile('/a'), /offline/);
  await resources.fetchFile('/a');
  await resources.fetchFile('/b');
  assert.equal(resources.status().bytes, 3);
  assert.equal(resources.status().assets, 1);
  await resources.fetchFile('/a');
  assert.equal(count, 4);
  resources.dispose();
});
