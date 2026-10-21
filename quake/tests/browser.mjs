// Real Chromium Service Worker + real composed server, synthetic packs only
// (moved from the site's scripts/check-game-clients-browser.mjs, roadmap J7b).
// Run from the site with the add-on installed: node games/quake/tests/browser.mjs
import '../../../tests/helpers/isolated-env.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { gameClientFixtures } from '../../../tests/helpers/game-client-fixtures.mjs';

const root = resolve(import.meta.dirname, '../../..');
const files = gameClientFixtures(process.env.GAME_CLIENT_ASSET_ROOT);
files.write('quake/probe.html', '<!doctype html><title>synthetic SW probe</title>');
files.write('quake/legacy-sw.js', `const CACHE='chaos-quake-assets-v1';
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('fetch',e=>{if(new URL(e.request.url).pathname==='/quake/ioquake3.js')
e.respondWith(caches.open(CACHE).then(c=>c.match(e.request)).then(r=>r||fetch(e.request)));});`);
const pause = ms => new Promise(done => setTimeout(done, ms));
async function until(check, label) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { if (await check()) return; await pause(60); }
  throw new Error('Timed out: ' + label);
}
const probe = createServer();
await new Promise(done => probe.listen(0, '127.0.0.1', done));
const port = probe.address().port;
await new Promise(done => probe.close(done));
const origin = `http://127.0.0.1:${port}`;
let child, browser, ws, output = '', sequence = 0;
const pending = new Map(), errors = [], labels = [];
const pass = label => { labels.push(label); console.log('PASS ' + label); };
async function stopServer() {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    await Promise.race([new Promise(done => child.once('exit', done)), pause(5000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}
try {
  child = spawn(process.execPath, ['--import', './tests/helpers/isolated-env.mjs', 'server/server.js'], {
    cwd: root, windowsHide: true, env: { ...process.env, PORT: String(port), CHAOS_TEST_REUSE_ENV: '1', HTTP_LOG_MODE: 'verbose' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  await until(() => { assert.equal(child.exitCode, null, output); return output.includes('listening on'); }, 'isolated boot');
  const executable = [process.env.BROWSER_PATH, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium'].find(path => path && existsSync(path));
  assert.ok(executable, 'Set BROWSER_PATH to a Chromium browser');
  const profile = mkdtempSync(resolve(tmpdir(), 'chaos-game-clients-'));
  browser = spawn(executable, ['--headless=new', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  let endpoint;
  await until(() => {
    const path = resolve(profile, 'DevToolsActivePort');
    if (!existsSync(path)) return false;
    const [debugPort, socket] = readFileSync(path, 'utf8').trim().split(/\r?\n/);
    if (!/^\d+$/.test(debugPort) || !socket?.startsWith('/devtools/browser/')) return false;
    endpoint = `ws://127.0.0.1:${debugPort}${socket}`; return true;
  }, 'complete browser endpoint');
  ws = new WebSocket(endpoint);
  await new Promise((done, reject) => { ws.onopen = done; ws.onerror = reject; });
  function send(method, params = {}, sessionId) {
    return new Promise((done, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 30000);
      pending.set(id, { done, reject, timer }); ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const call = pending.get(message.id); if (!call) return;
      pending.delete(message.id); clearTimeout(call.timer);
      if (message.error) call.reject(new Error(JSON.stringify(message.error))); else call.done(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
  };
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const command = (method, params) => send(method, params, sessionId);
  await command('Page.enable'); await command('Runtime.enable');
  async function evaluate(expression) {
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  await command('Page.navigate', { url: origin + '/surf/' });
  await until(() => evaluate(`location.pathname==='/surf/' && document.readyState==='complete'`), 'Surf fixture');
  await evaluate(`(async()=>{
    const old=await caches.open('chaos-quake-assets-v1');
    await old.put('/quake/ioquake3.js',new Response('stale-legacy-engine'));
    await caches.open('unrelated-feature');
    await navigator.serviceWorker.register('/quake/legacy-sw.js',{scope:'/quake/'});
  })()`);
  await command('Page.navigate', { url: origin + '/quake/probe.html' });
  await until(() => evaluate(`navigator.serviceWorker.controller?.scriptURL.endsWith('/legacy-sw.js')`), 'old worker controls fixture');
  assert.equal(await evaluate(`fetch('/quake/ioquake3.js').then(r=>r.text())`), 'stale-legacy-engine');
  pass('legacy worker really replays old bytes at a stable URL');
  await evaluate(`navigator.serviceWorker.register('/quake/sw.js',{scope:'/quake/',updateViaCache:'none'}).then(()=>true)`);
  await until(() => evaluate(`navigator.serviceWorker.controller?.scriptURL.endsWith('/quake/sw.js') && navigator.serviceWorker.controller.state==='activated'`), 'new worker activation finishes');
  const keys = await evaluate(`caches.keys()`);
  assert.ok(!keys.includes('chaos-quake-assets-v1')); assert.ok(keys.includes('unrelated-feature'));
  pass('real worker upgrade activates v2 and removes only old Quake caches');
  assert.match(await evaluate(`fetch('/quake/ioquake3.js').then(r=>r.text())`), /syntheticEngine = 1/);
  assert.match(await evaluate(`fetch('/quake/ioquake3.js').then(r=>r.text())`), /syntheticEngine = 1/);
  await until(() => /GET \/quake\/ioquake3\.js 304/.test(output), 'real HTTP 304 behind the worker');
  pass('online worker revalidates unchanged engine with a real HTTP 304');
  files.write('quake/ioquake3.js', 'window.syntheticEngine = 2; /* new installation */\n'.repeat(80));
  assert.match(await evaluate(`fetch('/quake/ioquake3.js').then(r=>r.text())`), /syntheticEngine = 2/);
  await until(() => evaluate(`caches.open('chaos-quake-assets-v2').then(c=>c.match('/quake/ioquake3.js')).then(r=>r&&r.text()).then(t=>t?.includes('syntheticEngine = 2'))`), 'offline copy updated');
  pass('same-URL reinstall returns new engine bytes and refreshes the offline copy');
  assert.equal(await evaluate(`WebAssembly.instantiateStreaming(fetch('/quake/ioquake3.wasm')).then(()=>true)`), true);
  pass('real streaming WASM instantiation accepts the served MIME and bytes');
  await evaluate(`fetch('/quake/baseq3/pak0.pk3').then(r=>r.arrayBuffer()).then(()=>true)`);
  const range = await evaluate(`fetch('/quake/baseq3/pak0.pk3',{headers:{Range:'bytes=2-5'}}).then(async r=>({status:r.status,range:r.headers.get('content-range'),body:await r.text()}))`);
  assert.deepEqual(range, { status: 206, range: 'bytes 2-5/15', body: '2345' });
  pass('Range bypasses the full-body SW cache and retains HTTP 206');
  const flight = await evaluate(`fetch('/quake/game',{headers:{RSC:'1'}}).then(async r=>({type:r.headers.get('content-type'),body:await r.text()}))`);
  assert.match(flight.type, /^text\/x-component/); assert.equal(flight.body, 'synthetic-flight-v1');
  pass('header-only Flight chooses the component representation through the real browser');
  await evaluate(`fetch('/quake/_next/static/chunks/synthetic.js').then(r=>r.text())`);
  await until(() => evaluate(`caches.open('chaos-quake-assets-v2').then(c=>c.match('/quake/_next/static/chunks/synthetic.js')).then(Boolean)`), 'chunk cached');
  unlinkSync(resolve(process.env.GAME_CLIENT_ASSET_ROOT, 'quake/_next/static/chunks/synthetic.js'));
  assert.equal(await evaluate(`fetch('/quake/_next/static/chunks/synthetic.js').then(r=>r.status)`), 404);
  await until(() => evaluate(`caches.open('chaos-quake-assets-v2').then(c=>c.match('/quake/_next/static/chunks/synthetic.js')).then(r=>!r)`), 'removed chunk evicted');
  pass('HTTP 404 is returned and deletes the obsolete offline copy');
  await stopServer();
  assert.match(await evaluate(`fetch('/quake/ioquake3.js').then(r=>r.text())`), /syntheticEngine = 2/);
  assert.equal(await evaluate(`fetch('/quake/_next/static/chunks/synthetic.js').then(()=>false,()=>true)`), true);
  assert.equal(await evaluate(`fetch('/quake/baseq3/pak0.pk3',{headers:{Range:'bytes=2-5'}}).then(()=>false,()=>true)`), true);
  pass('after real server shutdown offline cache works, deleted assets and ranges stay unavailable');
  assert.deepEqual(errors, []);
  console.log('GAME_CLIENT_BROWSER ' + JSON.stringify({ passes: labels.length, labels, runtimeErrors: errors.length }));
} catch (error) { console.error(output.slice(-3500)); throw error; }
finally {
  for (const call of pending.values()) { clearTimeout(call.timer); call.reject(new Error('Browser closed')); }
  ws?.close(); browser?.kill(); await stopServer();
}
