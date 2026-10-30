import express from 'express';
import { buildFsManifest } from './manifest.js';
import { createPortraits } from './portraits.js';
import { createStagePreviews } from './stage-previews.js';
import { fileURLToPath } from 'node:url';

// Text files the engine parses are small and may be edited in place on the
// server: revalidate them. Sprites, sounds and music keep a day of cache.
const TEXT_ASSET = /\.(def|air|cns|cmd|st|zss|const|txt|dat|lua|ini)$/i;

function assetOptions() {
  return {
    cacheControl: true,
    maxAge: '1d',
    acceptRanges: true,
    fallthrough: false,
    setHeaders(response, filePath) {
      response.setHeader('X-Content-Type-Options', 'nosniff');
      if (TEXT_ASSET.test(filePath)) response.setHeader('Cache-Control', 'no-cache');
    },
  };
}

export function mountMugenRoutes(
  app,
  { catalog, apiLimiter = (_request, _response, next) => next() },
) {
  const { roots } = catalog;
  const portraits = createPortraits({ catalog });
  const stages = createStagePreviews({ catalog });
  app.get('/api/mugen/stage-preview', apiLimiter, async (request, response, next) => {
    try {
      const found = await stages.preview(
        typeof request.query.path === 'string' ? request.query.path : '',
      );
      response.setHeader('X-Content-Type-Options', 'nosniff');
      if (!found) return response.status(404).end();
      response.setHeader('Cache-Control', 'public, max-age=86400');
      response.setHeader('ETag', found.etag);
      if (request.headers['if-none-match'] === found.etag) return response.status(304).end();
      response.type('png').send(found.png);
    } catch (error) {
      next(error);
    }
  });
  app.get('/mugen-library', (_request, response) => {
    response.setHeader('Cache-Control', 'no-cache');
    response.sendFile(fileURLToPath(new URL('../client/library.html', import.meta.url)));
  });
  // /mugen-stages must be registered before /mugen to avoid the prefix overlap.
  app.use('/mugen-stages', express.static(roots.stages, assetOptions()));
  app.use('/mugen', express.static(roots.characters, assetOptions()));
  app.use(
    '/games/mugen/engine',
    express.static(roots.engine, {
      fallthrough: false,
      setHeaders(response, filePath) {
        // The engine and its loader carry their content hash in their name.
        if (/\.[0-9a-f]{12}\.(wasm|js)$/.test(filePath))
          response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        else if (TEXT_ASSET.test(filePath)) response.setHeader('Cache-Control', 'no-cache');
        else response.setHeader('Cache-Control', 'public, max-age=86400');
        if (filePath.endsWith('.wasm')) response.setHeader('Content-Type', 'application/wasm');
      },
    }),
  );

  app.get('/api/mugen/chars', apiLimiter, (_request, response) => {
    response.json(catalog.characters());
  });
  app.get('/api/mugen/stages', apiLimiter, (_request, response) => {
    response.json(catalog.stages());
  });
  // The character's select-screen portrait (sprite 9000,0, or 9000,1 for `size=large`).
  app.get('/api/mugen/portrait', apiLimiter, (request, response) => {
    const path = typeof request.query.path === 'string' ? request.query.path : '';
    const size = request.query.size === 'large' ? 'large' : 'small';
    const found = portraits.portrait(path, size);
    if (!found?.png) {
      response.setHeader('Cache-Control', 'public, max-age=300');
      response.status(404).end();
      return;
    }
    response.setHeader('Cache-Control', 'public, max-age=86400');
    response.setHeader('ETag', found.etag);
    if (request.headers['if-none-match'] === found.etag) {
      response.status(304).end();
      return;
    }
    response.type('png').send(found.png);
  });
  app.get('/api/mugen/fs', apiLimiter, (_request, response) => {
    const manifest = buildFsManifest(catalog);
    response.setHeader('Cache-Control', 'no-store');
    if (manifest) response.json(manifest);
    else response.status(503).json({ error: 'engine_missing' });
  });
}
