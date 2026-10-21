// Surf add-on entry (ChaOS-games). The site loads it from games/surf/ when the
// add-on is installed (games/addons.js): HTTP API, client files, rooms on the
// game-server foundation and the admin-panel console. Without it, the site
// lists Surf « À installer » and its window reports the game as missing.
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineFeature } from '../../../server/core/features.js';
import { clientFiles } from '../../../server/http/game-clients.js';
import { GAME_CLIENT_PERMISSIONS_POLICY } from '../../../server/http/csp.js';
import { registerInProcessAdmin } from '../../platform/game-admin/registry.js';
import * as admin from './admin.js';
import router from './api.js';
// Registers the "surf" room game with the game-server foundation.
import './room.js';

/** Installed client: games/surf/data/, or <GAME_CLIENT_ASSET_ROOT>/surf in tests. */
export const SURF_CLIENT_ROOT = process.env.GAME_CLIENT_ASSET_ROOT
  ? resolve(process.env.GAME_CLIENT_ASSET_ROOT, 'surf')
  : fileURLToPath(new URL('../data/', import.meta.url));

registerInProcessAdmin('surf', admin);

export default defineFeature({
  id: 'surf',
  routes(app, { apiLimiter = (_request, _response, next) => next() } = {}) {
    app.use('/api/surf', apiLimiter, router);
    app.use(
      '/surf',
      clientFiles(SURF_CLIENT_ROOT, {
        index: 'index.html',
        fallthrough: false,
        setHeaders(response, path) {
          // The installer rewrites visual manifests and JS/CSS without renaming
          // them. Only the untouched SHA256-addressed payload packs stay immutable.
          const pack = /^packed\/[a-f0-9]{64}\.(?:visual-assets|json)\.gz$/i.test(
            relative(SURF_CLIENT_ROOT, path).replaceAll('\\', '/'),
          );
          response.setHeader('Cache-Control', pack ? 'public, max-age=31536000, immutable' : 'no-cache');
          response.setHeader('Permissions-Policy', GAME_CLIENT_PERMISSIONS_POLICY);
        },
      }),
    );
  },
});
