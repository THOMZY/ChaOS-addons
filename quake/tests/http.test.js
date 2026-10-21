// HTTP contract of the Quake 3 client files, served by the add-on (moved from
// the site's tests/server/game-client-http.test.js, roadmap J7b). Spawns the
// real server with the add-on installed and the shared synthetic client fixtures.
import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { unlinkSync } from 'node:fs';
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

test('Quake HTML and flight requests select the right representation and keep isolation headers', async () => {
  const page = await get('/quake/game');
  assert.equal(page.headers['cache-control'], 'no-cache');
  assert.match(page.headers['content-type'], /^text\/html/);
  assert.match(page.body.toString(), /cache-bootstrap\.js/);
  assert.equal(page.headers['x-frame-options'], undefined);
  assert.equal(page.headers['origin-agent-cluster'], '?1');
  assert.match(page.headers['permissions-policy'], /keyboard-map/);
  for (const [path, headers] of [['/quake/game?_rsc=fixture', {}], ['/quake/game', { RSC: '1' }]]) {
    const flight = await get(path, headers);
    assert.equal(flight.status, 200);
    assert.equal(flight.headers['cache-control'], 'no-store');
    assert.match(flight.headers['content-type'], /^text\/x-component/);
    assert.match(flight.headers.vary, /\bRSC\b/i);
    assert.equal(flight.body.toString(), 'synthetic-flight-v1');
  }
});
test('the installed flight is reread after replacement instead of serving the boot snapshot', async () => {
  files.write('quake/game.rsc', 'synthetic-flight-v2-reinstalled');
  const changed = await get('/quake/game?_rsc=reinstalled');
  assert.equal(changed.body.toString(), 'synthetic-flight-v2-reinstalled');
});
test('missing Flight is an empty 204, while a missing document is a real 404', async () => {
  unlinkSync(join(assets, 'quake/game.rsc'));
  unlinkSync(join(assets, 'quake/game'));
  const flight = await get('/quake/game?_rsc=missing');
  assert.equal(flight.status, 204);
  assert.equal(flight.body.length, 0);
  assert.equal(flight.headers['cache-control'], 'no-store');
  assert.equal((await get('/quake/game')).status, 404);
});
test('stable Quake WASM and pak URLs revalidate instead of trusting a week of stale bytes', async () => {
  for (const path of ['/quake/ioquake3.wasm', '/quake/baseq3/pak0.pk3', '/quake/ioquake3.js', '/quake/_next/static/chunks/synthetic.js']) {
    const first = await get(path);
    assert.equal(first.status, 200);
    assert.equal(first.headers['cache-control'], 'no-cache', path);
    const cached = await get(path, { 'if-none-match': first.headers.etag });
    assert.equal(cached.status, 304);
    if (path.endsWith('.wasm')) assert.equal(first.headers['content-type'], 'application/wasm');
  }
});
test('ranges keep 206/416 and If-Range/HEAD semantics through the real static middleware', async () => {
  const path = '/quake/baseq3/pak0.pk3';
  const first = await get(path);
  const part = await get(path, { range: 'bytes=2-5' });
  assert.equal(part.status, 206);
  assert.equal(part.headers['content-range'], 'bytes 2-5/15');
  assert.equal(part.body.toString(), '2345');
  const end = await get(path, { range: 'bytes=99-' });
  assert.equal(end.status, 416);
  assert.equal(end.headers['content-range'], 'bytes */15');
  const stale = await get(path, { range: 'bytes=2-5', 'if-range': '"old"' });
  assert.equal(stale.status, 200);
  assert.deepEqual(stale.body, first.body);
  const weak = await get(path, { range: 'bytes=2-5', 'if-range': first.headers.etag });
  assert.equal(weak.status, 200, 'a weak static ETag cannot validate a partial representation');
  assert.deepEqual(weak.body, first.body);
  for (const date of [first.headers['last-modified'], 'Wed, 01 Jan 2100 00:00:00 GMT']) {
    const dated = await get(path, { range: 'bytes=2-5', 'if-range': date });
    assert.equal(dated.status, 200, 'a metadata date does not prove a strongly validated representation');
    assert.deepEqual(dated.body, first.body);
  }
  const head = await get(path, {}, 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.equal(head.headers['content-length'], '15');
});
test('Quake code negotiates gzip and keeps Vary on revalidation', async () => {
  const path = '/quake/ioquake3.js';
  const plain = await get(path, { 'accept-encoding': 'identity' });
  const compressed = await get(path, { 'accept-encoding': 'gzip' });
  assert.equal(compressed.headers['cache-control'], 'no-cache');
  assert.equal(compressed.headers['content-encoding'], 'gzip');
  assert.deepEqual(gunzipSync(compressed.body), plain.body);
  assert.match(compressed.headers.vary, /Accept-Encoding/i);
  const cached = await get(path, { 'accept-encoding': 'gzip', 'if-none-match': compressed.headers.etag });
  assert.equal(cached.status, 304);
});
test('SW stays scoped and revalidated; missing files and traversal never fall through to the SPA', async () => {
  const worker = await get('/quake/sw.js');
  assert.equal(worker.headers['service-worker-allowed'], '/quake/');
  assert.equal(worker.headers['cache-control'], 'no-cache');
  for (const path of ['/quake/missing.wasm', '/quake/..%2Fprivate-marker.txt']) {
    const response = await get(path);
    assert.ok([400, 403, 404].includes(response.status), `${path}: ${response.status}`);
    assert.doesNotMatch(response.body.toString(), /DO-NOT-SERVE|<title>ChaOS/);
  }
});
// The embedded client probes for a game client with HEAD before navigating.
test('the Quake client answers the HEAD preflight the browser sends', async () => {
  // A previous test removed the page to verify the 404 for a missing client.
  files.write('quake/game', '<!doctype html><title>Quake fixture</title><body>synthetic client</body>');
  for (const path of ['/quake/game', '/quake/sw.js', '/quake/cache-bootstrap.js']) {
    const response = await get(path, {}, 'HEAD');
    assert.equal(response.status, 200, path);
    assert.equal(response.body.length, 0, path);
  }
  assert.equal((await get('/quake/missing.html', {}, 'HEAD')).status, 404);
});
