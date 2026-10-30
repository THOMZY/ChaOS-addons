import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { BLOB_CACHE_CONTROL, sendBlob } from '../server/blob-response.js';

/** Writable response that records its headers and body. */
function fakeResponse() {
  const res = /** @type {any} */ (new PassThrough());
  res.headers = {};
  res.setHeader = (name, value) => { res.headers[name.toLowerCase()] = value; };
  res.status = (code) => { res.statusCode = code; return res; };
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.finished = new Promise((resolve) => res.on('end', () => resolve(Buffer.concat(chunks))));
  return res;
}

test('a frozen build blob is cached for a year and keeps its exact length', async (t) => {
  // Why: the blobs went out as `no-cache` without any validator, so the ~10 MB
  // of SWF, XML and music were downloaded again on every launch.
  const dir = mkdtempSync(join(tmpdir(), 'hf-blob-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'game.swf');
  writeFileSync(file, 'FWS-bytes');
  const res = fakeResponse();
  sendBlob(file, 'application/x-shockwave-flash', res);
  assert.equal((await res.finished).toString(), 'FWS-bytes');
  assert.equal(res.headers['cache-control'], BLOB_CACHE_CONTROL);
  assert.match(BLOB_CACHE_CONTROL, /\bmax-age=31536000\b/);
  assert.match(BLOB_CACHE_CONTROL, /\bimmutable\b/);
  assert.match(BLOB_CACHE_CONTROL, /\bno-transform\b/, 'compression would drop Content-Length');
  assert.equal(res.headers['content-length'], '9');
  assert.equal(res.headers['content-type'], 'application/x-shockwave-flash');
});
