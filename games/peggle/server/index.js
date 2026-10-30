// Peggle add-on entry (ChaOS-addons, roadmap J7e). The site loads it from
// games/peggle/ when the add-on is installed (games/addons.js), before its
// shared tables start: Peggle rules join the table games, and its media are
// served under /peggle-images and /peggle-sounds. Its table client
// (client/index.js) is served by the site's catalogue.
import express from 'express';
import { fileURLToPath } from 'node:url';
import { defineFeature } from '../../../server/core/features.js';
import { registerTableRules } from '../../platform/table-games.js';
import { peggleRules } from './table-rules.js';

registerTableRules('peggle', peggleRules);

// fallthrough:false → a missing sprite or sound answers 404 instead of the SPA
// catch-all HTML (which would silently break Image()/Audio() with a 200).
const media = (folder) =>
  express.static(fileURLToPath(new URL(`../media/${folder}/`, import.meta.url)), {
    fallthrough: false,
    cacheControl: true,
    maxAge: '1d',
  });

export default defineFeature({
  id: 'peggle',
  routes(app) {
    app.use('/peggle-images', media('images'));
    app.use('/peggle-sounds', media('sounds'));
  },
});
