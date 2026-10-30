// Quake 3 add-on entry (ChaOS-addons). The site loads it from games/quake/ when
// the add-on is installed (games/addons.js): the Q3JS client under /quake/
// with its asset cache worker, /api/quake, and the WebSocket↔UDP tunnel to the
// `quake` container (Compose profile `quake`). Without it, the site lists
// Quake « À installer » and its window reports the game as missing.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineFeature } from '../../../server/core/features.js';
import { clientFiles } from '../../../server/http/game-clients.js';
import { GAME_CLIENT_PERMISSIONS_POLICY } from '../../../server/http/csp.js';
import { quakeAssetCacheWorker } from './cache-worker.js';
import router from './api.js';
// Registers the "quake3" tunnel with the game-server foundation.
import './game.js';

/** Installed client: games/quake/data/, or <GAME_CLIENT_ASSET_ROOT>/quake in tests. */
export const QUAKE_CLIENT_ROOT = process.env.GAME_CLIENT_ASSET_ROOT
  ? resolve(process.env.GAME_CLIENT_ASSET_ROOT, 'quake')
  : fileURLToPath(new URL('../data/', import.meta.url));

/** @param {import('express').Express} app */
function mountClient(app) {
  const quake = QUAKE_CLIENT_ROOT;
  app.get('/quake/sw.js', (_req, res) => {
    res.type('application/javascript');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Service-Worker-Allowed', '/quake/');
    res.send(quakeAssetCacheWorker);
  });
  app.get('/quake/cache-bootstrap.js', (_req, res) => {
    res.type('application/javascript');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(
      "if ('serviceWorker' in navigator) navigator.serviceWorker.register('/quake/sw.js', { scope: '/quake/', updateViaCache: 'none' }).catch(() => {});",
    );
  });
  app.get('/quake/game', async (req, res, next) => {
    res.setHeader('Permissions-Policy', GAME_CLIENT_PERMISSIONS_POLICY);
    res.setHeader('Origin-Agent-Cluster', '?1');
    res.removeHeader('X-Frame-Options');
    // Header-only Flight requests share the document URL: caches must retain
    // this representation dimension even when the body answers 304.
    res.vary('RSC');
    const flight = '_rsc' in req.query || req.get('RSC') === '1';
    res.setHeader('Cache-Control', flight ? 'no-store' : 'no-cache');
    try {
      // Read current installation bytes, not a boot-time Flight snapshot that
      // can disagree with the freshly read HTML after a client reinstall.
      const text = await readFile(resolve(quake, flight ? 'game.rsc' : 'game'), 'utf8');
      if (res.destroyed) return;
      if (flight) {
        if (!text) return res.status(204).end();
        return res.type('text/x-component').send(text);
      }
      res.type('html');
      return res.send(text.replace('</head>', '<script src="/quake/cache-bootstrap.js"></script></head>'));
    } catch (error) {
      if (res.destroyed) return;
      if (error.code !== 'ENOENT') return next(error);
      if (flight) return res.status(204).end();
      return next();
    }
  });
  app.use(
    '/quake',
    clientFiles(quake, {
      index: false,
      fallthrough: false,
      acceptRanges: true,
      setHeaders(res, path) {
        // WASM and baseq3/pak*.pk3 are replaced under stable URLs as well.
        res.setHeader('Cache-Control', 'no-cache');
        if (/(^|[\\/])game$/.test(path)) {
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
        } else if (/\.wasm$/i.test(path)) {
          res.setHeader('Content-Type', 'application/wasm');
        }
        res.setHeader('Permissions-Policy', GAME_CLIENT_PERMISSIONS_POLICY);
        res.setHeader('Origin-Agent-Cluster', '?1');
      },
    }),
  );
}

export default defineFeature({
  id: 'quake',
  routes(app, { apiLimiter = (_request, _response, next) => next() } = {}) {
    app.use('/api/quake', apiLimiter, router);
    mountClient(/** @type {import('express').Express} */ (app));
  },
});
