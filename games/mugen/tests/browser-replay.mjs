// Real WebAssembly/netplay/replay smoke test, using only the screenpack's KFM.
// node mugen/tests/browser-replay.mjs <built bundle> <screenpack checkout>
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { walk } from '../server/catalog.js';

const addon = fileURLToPath(new URL('../', import.meta.url));
const bundle = resolve(process.argv[2]),
  screenpack = resolve(process.argv[3]);
const stamp = JSON.parse(readFileSync(resolve(bundle, 'engine.json'), 'utf8'));
assert.equal(stamp.replayProtocol, 1);
const manifest = {
  engine: stamp,
  groups: [
    { prefix: '', base: '/engine/fs/', files: stamp.files },
    {
      prefix: 'chars/',
      base: '/chars/',
      files: walk(resolve(screenpack, 'chars')),
    },
    {
      prefix: 'stages/',
      base: '/stages/',
      files: walk(resolve(screenpack, 'stages')),
    },
  ],
  generated: {
    'data/select.def': '[Characters]\nkfm/kfm.def\n[ExtraStages]\nstages/kfm.def\n',
  },
};
const mounts = [
  ['/games/mugen/client/', resolve(addon, 'client')],
  ['/games/mugen/engine/', bundle],
  ['/engine/', bundle],
  ['/chars/', resolve(screenpack, 'chars')],
  ['/stages/', resolve(screenpack, 'stages')],
];
const server = createServer((request, response) => {
  const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  if (path === '/api/mugen/fs') {
    response.setHeader('Content-Type', 'application/json');
    return response.end(JSON.stringify(manifest));
  }
  if (path === '/') {
    response.setHeader('Content-Type', 'text/html');
    return response.end('<!doctype html><script type="module" src="/fixture.js"></script>');
  }
  if (path === '/fixture.js') {
    response.setHeader('Content-Type', 'text/javascript');
    return response.end(readFileSync(new URL('./fixtures/replay-browser.js', import.meta.url)));
  }
  for (const [prefix, root] of mounts) {
    if (!path.startsWith(prefix)) continue;
    const file = resolve(root, path.slice(prefix.length));
    if (!file.startsWith(root + sep)) break;
    try {
      const types = {
        js: 'text/javascript',
        html: 'text/html',
        wasm: 'application/wasm',
      };
      response.setHeader(
        'Content-Type',
        types[file.split('.').at(-1)] ?? 'application/octet-stream',
      );
      return response.end(readFileSync(file));
    } catch {
      break;
    }
  }
  response.writeHead(404).end();
});
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(check, label, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await pause(100);
  }
  throw new Error('Timed out: ' + label);
}
let browser, socket;
const diagnostics = [];
const logPath = resolve(bundle, 'replay-browser.log');
writeFileSync(logPath, '');
try {
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const executable = [
    process.env.BROWSER_PATH,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/usr/bin/chromium',
  ].find((path) => path && existsSync(path));
  assert.ok(executable, 'Set BROWSER_PATH to Chromium');
  const profile = mkdtempSync(resolve(tmpdir(), 'mugen-replay-browser-'));
  browser = spawn(
    executable,
    [
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--autoplay-policy=no-user-gesture-required',
      '--enable-unsafe-swiftshader',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { windowsHide: true, stdio: 'ignore' },
  );
  await until(() => existsSync(resolve(profile, 'DevToolsActivePort')), 'Chromium');
  const [port, path] = readFileSync(resolve(profile, 'DevToolsActivePort'), 'utf8')
    .trim()
    .split(/\r?\n/);
  socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  await new Promise((done, reject) => {
    socket.onopen = done;
    socket.onerror = reject;
  });
  const pending = new Map();
  let sequence = 0;
  const send = (method, params = {}, sessionId) =>
    new Promise((done, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('CDP timed out: ' + method + '\n' + diagnostics.join('\n')));
      }, 20000);
      pending.set(id, { done, reject, timer });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Runtime.consoleAPICalled') {
      const line = message.params.args.map((item) => item.value ?? item.description).join(' ');
      appendFileSync(logPath, line + '\n');
      diagnostics.push(line);
      if (diagnostics.length > 40) diagnostics.shift();
    }
    if (message.method === 'Page.javascriptDialogOpening') {
      appendFileSync(logPath, 'DIALOG: ' + message.params.message + '\n');
      void send('Page.handleJavaScriptDialog', { accept: true }, message.sessionId).catch(() => {});
    }
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    clearTimeout(call.timer);
    if (message.error) call.reject(new Error(JSON.stringify(message.error)));
    else call.done(message.result);
  };
  const { targetId } = await send('Target.createTarget', {
    url: 'about:blank',
  });
  const { sessionId } = await send('Target.attachToTarget', {
    targetId,
    flatten: true,
  });
  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` }, sessionId);
  const evaluate = async (expression) => {
    const reply = await send('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
    assert.ok(!reply.exceptionDetails, JSON.stringify(reply.exceptionDetails));
    return reply.result.value;
  };
  let last,
    reported = 0;
  await until(async () => {
    last = await evaluate('window.replayTest && ({...window.replayTest, history: undefined})');
    if (Date.now() - reported > 15000) {
      console.info(JSON.stringify(last));
      reported = Date.now();
    }
    if (last?.failure) throw new Error(last.failure + '\n' + JSON.stringify(last));
    return last?.done;
  }, 'two engines and late replay spectator').catch((error) => {
    throw new Error(error.message + '\n' + JSON.stringify(last) + '\n' + diagnostics.join('\n'));
  });
  assert.equal(last.host.winSide, last.guest.winSide);
  assert.equal(last.spectator.winSide, last.host.winSide);
  assert.ok([0, 1].includes(last.host.winSide));
  assert.ok(last.bytes > 8192, 'confirmed inputs were recorded');
  assert.ok(last.caughtUp, 'late spectator used accelerated playback');
  assert.ok(last.audioControls, 'Go applied independent local BGM and SFX changes during play');
  const normalized = (text) => text.replace(/table: 0x[0-9a-f]+/g, 'table');
  assert.equal(
    normalized(last.hostStats),
    normalized(last.spectatorStats),
    'replay reproduces the complete match statistics',
  );
  assert.ok(!diagnostics.some((line) => /Replay synchronization failed/.test(line)));
  const firstWinner = last.host.winSide;
  await evaluate(
    'window.replayRestart().catch(error => window.replayTest.failure = String(error))',
  );
  await until(async () => {
    last = await evaluate('window.replayTest && ({...window.replayTest, history: undefined})');
    if (last.failure) throw new Error(last.failure);
    return last.restart;
  }, 'another match in the same MUGEN window');
  assert.equal(last.restart.code, 0);
  assert.equal(last.restartPhase, 'running', 'engine signals when fighters are loaded');
  assert.equal(last.wasmDownloads, 1, 'successive matches reuse the compiled engine');
  assert.equal(last.host.winSide, last.guest.winSide);
  assert.equal(last.host.winSide, last.spectator.winSide);
  assert.notEqual(
    last.host.winSide,
    firstWinner,
    'second match result must not be the first match cached statistics',
  );
  assert.equal(normalized(last.hostStats), normalized(last.spectatorStats));
  const native = await evaluate(
    'Array.from(document.querySelectorAll("iframe"), frame => ({loads:frame.contentWindow.chaosSession.loads,reuses:frame.contentWindow.chaosSession.reuses}))',
  );
  assert.equal(native.length, 3, 'the same three native engines remain');
  console.info(JSON.stringify({ native }));
  for (const state of native) {
    assert.equal(state.loads, 2);
    assert.equal(state.reuses, 2);
  }
  await evaluate('window.replayOffline().catch(error=>window.replayTest.failure=String(error))');
  await until(async () => {
    last = await evaluate('window.replayTest && ({...window.replayTest,history:undefined})');
    if (last.failure) throw new Error(last.failure);
    return last.offline;
  }, 'offline match after persistent versus');
  assert.equal(last.offline.code, 0);
  assert.equal(
    await evaluate('document.querySelector("iframe").contentWindow.chaosSession.loads'),
    3,
    'returning to the original fighter uses its retained compiled assets',
  );
  console.info(
    JSON.stringify({
      passed: true,
      bytes: last.bytes,
      winner: last.host.winSide,
      caughtUp: last.caughtUp,
      audioControls: last.audioControls,
      restart: last.restart.code,
      wasmDownloads: last.wasmDownloads,
    }),
  );
} finally {
  socket?.close();
  browser?.kill();
  await new Promise((done) => server.close(done));
}
