import { t } from '/core/js/localization/i18n.js';
export { startEmbeddedClient } from '/core/js/games/platform/embedded-clients.js';
// ─── Quake 3 (ioquake3 compiled to WebAssembly, served under /quake/) ───────
// Three things are specific to Quake 3:
//
//  1. the engine requests pointer lock itself (including in fullscreen); the
//     shared owner already listens for both events;
//  2. the player nickname is not stored in the client: `/api/quake` reads it
//     from the ChaOS session and places it in the game page URL; the engine
//     reads it as `name`;
//  3. the host and port passed to the engine are functional: Emscripten's SOCKFS
//     rebuilds its WebSocket URL from these values, and the engine runs
//     `+connect <host>:<port>`.
const QUAKE_PAGE = '/quake/game';
const QUAKE_CACHE_WORKER = '/quake/sw.js';

/** Game-page origin host and port; the port is always explicit. */
function authority(origin) {
  const url = new URL(origin, globalThis.location?.origin ?? 'http://localhost');
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return { host: url.hostname, port };
}

/** Game page URL with the parameters expected by the original client. */
export function quakePageUrl(name, gameOrigin) {
  const { host, port } = authority(gameOrigin);
  const params = new URLSearchParams({
    host,
    proxyPort: String(port),
    fs_game: 'baseq3',
    name: name || 'Player',
  });
  return `${new URL(QUAKE_PAGE, gameOrigin)}?${params}`;
}

/**
 * Game server state and the player's ChaOS nickname. Never throw: gameplay
 * must not depend on this request. Without a response, keep the engine's
 * default nickname and attempt to connect anyway.
 */
async function quakeState(fetchFn) {
  try {
    const res = await fetchFn('/api/quake?action=config', {
      cache: 'no-store',
    });
    if (!res?.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  }
}

/** Persistent cache limited to Quake assets; registration never blocks gameplay. */
async function preparerCacheAssets() {
  if (!globalThis.navigator || !('serviceWorker' in navigator)) return;
  try {
    // `navigator.serviceWorker.ready` is unsuitable here: the ChaOS document is
    // at `/`, outside the `/quake/` scope, so this promise can wait indefinitely
    // for a controller that cannot control it. The iframe will be in scope once
    // it navigates.
    await Promise.race([
      navigator.serviceWorker.register(QUAKE_CACHE_WORKER, {
        scope: '/quake/',
        updateViaCache: 'none',
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Quake cache registration timed out')), 1_500),
      ),
    ]);
  } catch (error) {
    // Private mode, insufficient quota, or an older browser: the game remains playable.
    console.warn('[quake3] asset cache unavailable:', error);
  }
}

export const QUAKE = {
  id: 'quake3',
  clickToLoad: true,
  label: 'Quake III',
  iframeId: 'quake3-iframe',
  statusId: 'quake3-loading',
  loadingCopy: () => t('games.loadingQuake'),
  unloadDelayMs: 120_000,
  freeze: true,
  preflight: true,
  rejectSelector: '#app',
  async source({ fetch: fetchFn }) {
    const state = await quakeState(fetchFn);
    if (state && state.online === false) {
      // The game server is not responding. Load the client anyway; the engine
      // will retry its connection, but report the issue once.
      console.warn('[quake3] game server is unreachable (is the `quake` container stopped?)');
    }
    const origin = state?.gameOrigin || globalThis.location?.origin;
    return quakePageUrl(state?.player?.name, origin);
  },
  prepare: () => preparerCacheAssets(),
  // The SDL/Emscripten engine fills its ScriptProcessor from the render loop.
  // Freezing only that loop makes the browser replay the last audio buffer
  // indefinitely, so the page exposes a bridge to the AudioContexts it creates.
  onVisibility(suspended, { iframe }) {
    suspendAudio(iframe, suspended);
  },
  onStop(_reason, { iframe }) {
    suspendAudio(iframe, true);
  },
};

function suspendAudio(iframe, suspended) {
  try {
    iframe?.contentWindow?.__CHAOS_SET_AUDIO_SUSPENDED?.(suspended);
  } catch (_) {
    /* The iframe is navigating; there is nothing to suspend. */
  }
}
