import { mountMugenRoutes } from './routes.js';
import { defineFeature } from '../../../server/core/features.js';
import { createFightingRuntime } from './runtime.js';
import express from 'express';
import { fileURLToPath } from 'node:url';
const runtime = createFightingRuntime();
export const { fightMgr, sbMgr, init, wire, onSocketDisconnect, onUserDisconnect } = runtime;
export default defineFeature({
  id: 'fighting',
  phase: 'producers',
  routes(app, context) {
    mountMugenRoutes(app, context);
    app.use(
      '/games/fighting/client',
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
  stop: runtime.stop,
  status: runtime.status,
});
