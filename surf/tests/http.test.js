// HTTP contract of the Surf client files, served by the add-on (moved from the
// site's tests/server/game-client-http.test.js, roadmap J7). Spawns the real
// server with the add-on installed and the shared synthetic client fixtures.
import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { gameClientFixtures } from '../../../tests/helpers/game-client-fixtures.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const assets = process.env.GAME_CLIENT_ASSET_ROOT;
let child, port, files, output = '';
function get(path, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, headers, method }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.end();
  });
}
before(async () => {
  files = gameClientFixtures(assets);
  const probe = createServer();
  await new Promise(done => probe.listen(0, '127.0.0.1', done));
  port = probe.address().port;
  await new Promise(done => probe.close(done));
  child = spawn(process.execPath, ['--import', './tests/helpers/isolated-env.mjs', 'server/server.js'], {
    cwd: root, windowsHide: true, env: { ...process.env, PORT: String(port), CHAOS_TEST_REUSE_ENV: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(output)), 30000);
    const collect = chunk => { output += chunk; if (output.includes('listening on')) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.once('error', reject);
    child.once('exit', () => { clearTimeout(timer); reject(new Error(output)); });
  });
});
after(async () => {
  if (child && child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit'); }
});

test('Surf installation rewrites revalidate manifests and code despite upstream-looking names', async () => {
  for (const path of ['/surf/', '/surf/assets/index-upstream.js', '/surf/assets/client-upstream.js',
    '/surf/packed/' + files.manifest, '/surf/packed/catalog.json.gz']) {
    const first = await get(path);
    assert.equal(first.status, 200, path);
    assert.equal(first.headers['cache-control'], 'no-cache', path);
    assert.ok(first.headers.etag);
    const cached = await get(path, { 'if-none-match': first.headers.etag });
    assert.equal(cached.status, 304, path);
    assert.equal(cached.body.length, 0);
  }
});
test('only unmodified SHA256 visual packs are immutable, never a whole packed directory', async () => {
  const pack = await get('/surf/packed/' + files.pack);
  assert.equal(pack.status, 200);
  assert.equal(pack.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.deepEqual(pack.body, files.rawPack);
  assert.equal(pack.headers['content-encoding'], undefined, 'already compressed packs are not double encoded');
  const ordinary = await get('/surf/packed/ordinary.visual-assets.gz');
  assert.equal(ordinary.headers['cache-control'], 'no-cache');
});
test('a rewritten manifest changes ETag at the same URL and returns the current bytes', async () => {
  const path = '/surf/packed/' + files.manifest;
  const old = await get(path);
  files.write('surf/packed/' + files.manifest, gzipSync('{"packs":[{"url":"/surf/packed/replaced-longer"}]}'));
  const changed = await get(path, { 'if-none-match': old.headers.etag });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.etag, old.headers.etag);
  assert.match(gunzipSync(changed.body).toString(), /replaced-longer/);
});
test('Surf code negotiates gzip and keeps Vary on revalidation', async () => {
  const path = '/surf/assets/client-upstream.js';
  const plain = await get(path, { 'accept-encoding': 'identity' });
  const compressed = await get(path, { 'accept-encoding': 'gzip' });
  assert.equal(compressed.headers['cache-control'], 'no-cache');
  assert.equal(compressed.headers['content-encoding'], 'gzip');
  assert.deepEqual(gunzipSync(compressed.body), plain.body);
  assert.match(compressed.headers.vary, /Accept-Encoding/i);
});
test('missing Surf files and traversal never fall through to the SPA', async () => {
  for (const path of ['/surf/missing.js', '/surf/..%2Fprivate-marker.txt']) {
    const response = await get(path);
    assert.ok([400, 403, 404].includes(response.status), `${path}: ${response.status}`);
    assert.doesNotMatch(response.body.toString(), /DO-NOT-SERVE|<title>ChaOS/);
  }
});
test('the Surf client answers the HEAD preflight the browser sends', async () => {
  const response = await get('/surf/', {}, 'HEAD');
  assert.equal(response.status, 200);
  assert.equal(response.body.length, 0);
  assert.equal((await get('/surf/missing.html', {}, 'HEAD')).status, 404);
});
