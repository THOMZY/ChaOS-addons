import express from 'express';
import { fileURLToPath } from 'node:url';
import { defineFeature } from '../../../server/core/features.js';
import { GAME_CLIENT_PERMISSIONS_POLICY, MC_CLIENT_CSP } from '../../../server/http/csp.js';
import { attachMinecraftProxy } from './proxy.js';

const WEB_ROOT = fileURLToPath(new URL('../web/', import.meta.url));
let stopProxy;

export default defineFeature({
  id: 'minecraft',
  phase: 'transports',
  routes(app) {
    app.use(
      '/mc',
      express.static(WEB_ROOT, {
        extensions: ['html'],
        setHeaders(response) {
          response.setHeader('Cache-Control', 'no-cache');
          response.setHeader('Content-Security-Policy', MC_CLIENT_CSP);
          response.setHeader('Permissions-Policy', GAME_CLIENT_PERMISSIONS_POLICY);
        },
      }),
    );
  },
  upgrade(server, { accepting }) {
    if (stopProxy) throw new Error('Minecraft proxy already attached');
    stopProxy = attachMinecraftProxy(server, { accepting });
  },
  stop() {
    return stopProxy?.();
  },
  status() {
    return { attached: Boolean(stopProxy) };
  },
});
