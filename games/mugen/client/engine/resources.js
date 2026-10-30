// One resource cache belongs to the MUGEN window, rather than to a short-lived
// Go instance. Match state stays private, while compilation and immutable pack
// bytes survive successive matches. RAM is bounded; the temporary browser cache
// retains larger fighters until the MUGEN instance is disposed.
import { engineFileUrl } from './file-url.js';
const ENGINE_BASE = '/games/mugen/engine/';
export function defaultCacheLimit(memory = globalThis.navigator?.deviceMemory) {
  const mib = Number(memory) >= 8 ? 512 : Number(memory) >= 4 || !Number(memory) ? 256 : 128;
  return mib * 1024 * 1024;
}

export function createEngineResources({
  fetch = globalThis.fetch,
  compile = (bytes) => WebAssembly.compile(bytes),
  maxBytes = defaultCacheLimit(),
  storage = globalThis.caches,
  window = globalThis.window,
} = {}) {
  const modules = new Map(),
    assets = new Map();
  let size = 0,
    disposed = false;
  const controller = new AbortController();
  const cacheName =
    'mugen-window-' + (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`);
  let disk = null;
  const writes = new Set();
  let disposal = null;

  function dispose() {
    if (disposal) return disposal;
    disposed = true;
    controller.abort();
    window?.removeEventListener('pagehide', dispose);
    modules.clear();
    assets.clear();
    size = 0;
    disposal = (disk ?? Promise.resolve())
      .then(async () => {
        await Promise.allSettled([...writes]);
        await storage?.delete(cacheName);
      })
      .catch(() => {
        /* Browser shutdown may end storage access before cleanup finishes. */
      });
    return disposal;
  }
  window?.addEventListener('pagehide', dispose, { once: true });

  function sessionCache() {
    disk ??= Promise.resolve()
      .then(() => storage?.open(cacheName))
      .catch(() => null);
    return disk;
  }

  async function download(url) {
    const cache = await sessionCache();
    let response;
    try {
      response = await cache?.match(url);
    } catch {
      /* Memory caching still works when disk storage is unavailable. */
    }
    if (!response) {
      response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error('asset_unavailable');
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (cache && !disposed) {
        const write = cache.put(url, new Response(bytes)).catch(() => {
          // Quota exhaustion falls back to the bounded memory cache.
        });
        writes.add(write);
        await write;
        writes.delete(write);
      }
      return bytes;
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  async function manifest() {
    const response = await fetch('/api/mugen/fs', { cache: 'no-store', signal: controller.signal });
    if (!response.ok)
      throw new Error(response.status === 503 ? 'engine_missing' : 'files_unavailable');
    return response.json();
  }

  function asset(url) {
    const found = assets.get(url);
    if (found) {
      assets.delete(url);
      assets.set(url, found);
      return found.promise;
    }
    const record = { bytes: 0, promise: null };
    record.promise = download(url)
      .then((bytes) => {
        if (!disposed && assets.get(url) === record) {
          record.bytes = bytes.byteLength;
          size += record.bytes;
          for (const [key, entry] of assets) {
            if (size <= maxBytes) break;
            if (!entry.bytes) continue;
            size -= entry.bytes;
            assets.delete(key);
          }
        }
        return bytes;
      })
      .catch((error) => {
        if (assets.get(url) === record) assets.delete(url);
        throw error;
      });
    assets.set(url, record);
    return record.promise;
  }

  function engine(stamp, onProgress = () => {}) {
    const url = ENGINE_BASE + stamp.wasm;
    if (modules.has(url)) {
      onProgress(1);
      return modules.get(url);
    }
    const promise = (async () => {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error('engine_unavailable');
      const total = Number(response.headers.get('content-length')) || 0;
      const chunks = [];
      let received = 0;
      const reader = response.body?.getReader();
      if (!reader) return compile(await response.arrayBuffer());
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        onProgress(total ? received / total : 0);
      }
      const bytes = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      const module = await compile(bytes);
      onProgress(1);
      return module;
    })().catch((error) => {
      modules.delete(url);
      throw error;
    });
    modules.set(url, promise);
    // A changed engine version replaces the previous one after an update.
    for (const key of modules.keys()) if (key !== url) modules.delete(key);
    return promise;
  }

  return {
    manifest,
    engine,
    async fetchFile(url) {
      const bytes = await asset(url);
      // VFS writes must never mutate a later match's cached original.
      return { ok: true, arrayBuffer: async () => bytes.slice().buffer };
    },
    async warm() {
      const files = await manifest();
      await engine(files.engine);
      const core = files.groups.find((group) => group.prefix === '');
      const queue = [...(core?.files ?? [])];
      await Promise.all(
        Array.from({ length: 4 }, async () => {
          while (queue.length && !disposed) {
            const [path] = queue.shift();
            await asset(engineFileUrl(core, path, files.engine.version));
          }
        }),
      );
    },
    status: () => ({ modules: modules.size, assets: assets.size, bytes: size }),
    dispose,
  };
}
