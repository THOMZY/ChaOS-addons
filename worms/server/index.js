// Worms add-on entry (ChaOS-games, roadmap J7d). The site loads it from
// games/worms/ when the add-on is installed (games/addons.js): rooms, stakes
// and timers on /chat, and the game media under /worms-assets. Its browser
// controller (client/worms.js) is loaded by the site's Worms window.
import express from 'express';
import { fileURLToPath } from 'node:url';
import { defineFeature } from '../../../server/core/features.js';
import { createWormsRuntime } from './runtime.js';

// Worms: rules in model.js, rooms, stakes and timers in runtime.js.
const runtime = createWormsRuntime();

// The manager instance, for the wire contract test.
export const { wormsMgr } = runtime;

// Images and sounds from the Apache-2.0 licensed clone project.
const MEDIA = fileURLToPath(new URL('../media/', import.meta.url));

export default defineFeature({
  id: 'worms',
  phase: 'producers',
  routes(app) {
    app.use('/worms-assets', express.static(MEDIA, { cacheControl: true, maxAge: '1d' }));
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
