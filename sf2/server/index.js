import express from 'express';
import { fileURLToPath } from 'node:url';
import { defineFeature } from '../../../server/core/features.js';
import { createSf2Runtime } from './runtime.js';

const runtime = createSf2Runtime();
export const { sf2Mgr, init, wire, onSocketDisconnect, onUserDisconnect } = runtime;
export default defineFeature({
  id: 'sf2',
  phase: 'producers',
  routes(app) {
    app.use(
      '/sf2',
      express.static(fileURLToPath(new URL('../web/', import.meta.url)), {
        index: 'index.html',
        maxAge: '1d',
        setHeaders(response, path) {
          if (/\.(js|mjs)$/i.test(path)) response.setHeader('Cache-Control', 'no-cache');
        },
      }),
    );
    app.use(
      '/games/sf2/client',
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
