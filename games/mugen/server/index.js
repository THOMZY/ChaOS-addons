import express from 'express';
import { fileURLToPath } from 'node:url';
import { defineFeature } from '../../../server/core/features.js';
import { createCatalog } from './catalog.js';
import { mountMugenRoutes } from './routes.js';
import { createMugenRuntime } from './runtime.js';
import { createPackUploads } from './pack-uploads.js';

const catalog = createCatalog({ dataRoot: fileURLToPath(new URL('../data/', import.meta.url)) });
const runtime = createMugenRuntime({ catalog });
const packs = createPackUploads({ catalog });
let stopping;
export const { fightMgr, init, wire, onSocketDisconnect, onUserDisconnect } = runtime;

export default defineFeature({
  id: 'mugen',
  phase: 'producers',
  routes(app, context) {
    mountMugenRoutes(app, { catalog, apiLimiter: context?.apiLimiter });
    packs.mount(app, { apiLimiter: context?.apiLimiter });
    app.use(
      '/games/mugen/client',
      express.static(fileURLToPath(new URL('../client/', import.meta.url)), {
        setHeaders(response) {
          response.setHeader('Cache-Control', 'no-cache');
        },
      }),
    );
  },
  chat: {
    init: runtime.init,
    wire: runtime.wire,
    onSocketDisconnect: runtime.onSocketDisconnect,
    onUserDisconnect: runtime.onUserDisconnect,
  },
  stop: () => (stopping ??= Promise.all([packs.stop(), runtime.stop()])),
  status: () => ({ ...runtime.status(), uploads: packs.status() }),
});
