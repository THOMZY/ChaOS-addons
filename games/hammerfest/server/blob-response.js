// @ts-check
// Response of the loader's `/api/v1/blobs/:id/raw`: the frozen build files
// (SWF, XML, music) under stable ids.
import { createReadStream, statSync } from 'node:fs';

/**
 * The build is final: its files never change under the same id, so the browser
 * keeps them for a year instead of downloading ~10 MB on every launch. A file
 * that did change would need a new blob id in build.js, never new bytes here.
 * `no-transform` keeps the site's `compression` middleware from gzipping the
 * body: the Flash loader needs Content-Length for its progress bar, and these
 * blobs are already compressed or consumed as is.
 */
export const BLOB_CACHE_CONTROL = 'public, max-age=31536000, immutable, no-transform';

/**
 * Stream one installed blob.
 * @param {string} path  absolute path of the file in `data/`
 * @param {string} mediaType
 * @param {import('express').Response} res
 */
export function sendBlob(path, mediaType, res) {
  // The loader drives its progress bar from Content-Length: without it the
  // download never reports completion.
  const size = statSync(path).size;
  res.setHeader('Content-Type', mediaType);
  res.setHeader('Content-Length', String(size));
  res.setHeader('Cache-Control', BLOB_CACHE_CONTROL);
  createReadStream(path)
    .on('error', () => res.status(500).end())
    .pipe(res);
}
