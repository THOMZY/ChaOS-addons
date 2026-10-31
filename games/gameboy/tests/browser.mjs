import '../../../tests/helpers/isolated-env.mjs';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createHttpApp } from '../../../server/http/app.js';
import { createAccount, createSession, SESSION_COOKIE } from '../../../server/auth/service.js';
import { createGameboyFeature } from '../server/addon.js';
import { buildDiagnosticRom } from './fixtures/diagnostic-rom.mjs';

const delay = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
async function until(check, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(40);
  }
  throw new Error(`Timed out: ${label}`);
}
const dataDir = mkdtempSync(resolve(tmpdir(), 'chaos-gameboy-browser-data-'));
const feature = createGameboyFeature({ dataDir, fetchArtwork: async () => null });
const app = createHttpApp();
feature.routes(app);
const clientRoot = resolve(import.meta.dirname, '../client');
app.use('/games/gameboy/client', express.static(clientRoot));
app.use('/core', express.static(resolve(import.meta.dirname, '../../../website/core')));
app.get('/', (_request, response) =>
  response.send(`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/games/gameboy/client/gameboy.css">
<style>.wm-win{width:600px;height:900px}.gameboy-body{width:100%;height:100%}</style>
<textarea id="chat"></textarea><div class="wm-win" data-minimized="0" tabindex="-1"><div id="gameboy-body"></div></div>
<script>window.probe={intervals:new Set(),observers:new Set(),contexts:[]};
const set=setInterval,clear=clearInterval;window.setInterval=(...args)=>{const id=set(...args);probe.intervals.add(id);return id};window.clearInterval=id=>{probe.intervals.delete(id);clear(id)};
for(const name of ['MutationObserver','ResizeObserver']){const Native=window[name];window[name]=class extends Native{constructor(...args){super(...args);probe.observers.add(this)}disconnect(){probe.observers.delete(this);super.disconnect()}}}
const Context=AudioContext;window.AudioContext=class extends Context{constructor(...args){super(...args);probe.contexts.push(this)}};
document.querySelector('.wm-win').addEventListener('wm:close',()=>window.owner?.destroy());
if(location.search.includes('pcm'))window.AudioDecoder=undefined;</script>
<script type="module">import {mountWindow} from '/games/gameboy/client/gameboy.js';window.mount=mountWindow;window.owner=mountWindow();window.ready=true;</script>`),
);
const server = createServer(app);
feature.upgrade(server);
await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const origin = `http://127.0.0.1:${server.address().port}`;
const executable = [
  process.env.BROWSER_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/chromium',
].find((path) => path && existsSync(path));
assert.ok(executable, 'Set BROWSER_PATH to a Chromium browser');
const profile = mkdtempSync(resolve(tmpdir(), 'chaos-gameboy-browser-'));
let browser, socket;
const pending = new Map(),
  errors = [],
  clients = [];
let sequence = 0;
try {
  browser = spawn(
    executable,
    [
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--autoplay-policy=no-user-gesture-required',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      'about:blank',
    ],
    { windowsHide: true, stdio: 'ignore' },
  );
  await until(() => existsSync(resolve(profile, 'DevToolsActivePort')), 'browser');
  const [port, path] = readFileSync(resolve(profile, 'DevToolsActivePort'), 'utf8')
    .trim()
    .split(/\r?\n/);
  socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  await new Promise((resolveOpen, reject) => {
    socket.onopen = resolveOpen;
    socket.onerror = reject;
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolveCall, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out: ${method}`));
      }, 15000);
      pending.set(id, { resolve: resolveCall, reject, timer });
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
    // The library asks for a confirmation before deleting a cartridge: the bench
    // accepts it, then asserts the observable effect on the shelf and on disk.
    if (message.method === 'Page.javascriptDialogOpening' && message.sessionId)
      void send('Page.handleJavaScriptDialog', { accept: true }, message.sessionId).catch(() => {});
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    clearTimeout(call.timer);
    if (message.error) call.reject(new Error(JSON.stringify(message.error)));
    else call.resolve(message.result);
  };
  for (let index = 0; index < 2; index++) {
    const { account } = await createAccount({
      email: `gb-browser-${index}@example.org`,
      pseudo: `GB Browser ${index}`,
      password: 'gameboy-browser-password',
    });
    const token = createSession(account.id);
    const { browserContextId } = await send('Target.createBrowserContext');
    const { targetId } = await send('Target.createTarget', {
      url: 'about:blank',
      browserContextId,
    });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const evaluate = async (expression) => {
      const result = await send(
        'Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: true },
        sessionId,
      );
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    await send('Runtime.enable', {}, sessionId);
    await send('Network.enable', {}, sessionId);
    await send('Network.setCookie', { name: SESSION_COOKIE, value: token, url: origin }, sessionId);
    await send('Page.navigate', { url: origin + (index ? '/?pcm' : '/') }, sessionId);
    clients.push({ evaluate, sessionId, cookie: `${SESSION_COOKIE}=${token}` });
    await until(
      () => evaluate('!!window.ready && !document.getElementById("gb-start").hidden'),
      'explicit start screen',
    );
    assert.equal(await evaluate("document.querySelector('[data-key-code=KeyW]').textContent"), 'Z');
    await evaluate("import('/core/js/i18n.js').then(module => module.applyAccountLanguage('en'))");
    assert.equal(await evaluate("document.querySelector('[data-key-code=KeyW]').textContent"), 'W');
    await evaluate("import('/core/js/i18n.js').then(module => module.applyAccountLanguage('fr'))");
    await evaluate('document.querySelector(".wm-win").dataset.minimized="1"');
    await delay(80);
    await evaluate('document.querySelector(".wm-win").dataset.minimized="0"');
    await delay(80);
    assert.equal(
      await evaluate('owner.status().hasSocket'),
      false,
      'restore cannot bypass explicit start',
    );
    const startButton = await evaluate(
      'document.getElementById("gb-startbtn").getBoundingClientRect().toJSON()',
    );
    const startPosition = {
      x: startButton.x + startButton.width / 2,
      y: startButton.y + startButton.height / 2,
      button: 'left',
      clickCount: 1,
    };
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...startPosition }, sessionId);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...startPosition }, sessionId);
    if (index === 0) {
      await until(
        () =>
          evaluate(
            '!!window.ready && document.getElementById("gb-wait").textContent.includes("Aucune ROM")',
          ),
        'empty console invitation',
      );
      const cartridge = await evaluate(
        'document.getElementById("gb-lib").getBoundingClientRect().toJSON()',
      );
      const position = {
        x: cartridge.x + cartridge.width / 2,
        y: cartridge.y + cartridge.height / 2,
        button: 'left',
        clickCount: 1,
      };
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...position }, sessionId);
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...position }, sessionId);
      let libraryTarget;
      await until(async () => {
        libraryTarget = (await send('Target.getTargets')).targetInfos.find(
          (target) => target.url === origin + '/gameboy-library',
        );
        return libraryTarget;
      }, 'ROM library popup');
      const { sessionId: librarySession } = await send('Target.attachToTarget', {
        targetId: libraryTarget.targetId,
        flatten: true,
      });
      await send('Runtime.enable', {}, librarySession);
      const libraryEvaluate = async (expression) => {
        const result = await send(
          'Runtime.evaluate',
          { expression, awaitPromise: true, returnByValue: true },
          librarySession,
        );
        if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
        return result.result.value;
      };
      await until(
        () => libraryEvaluate('!!document.querySelector(".add")'),
        'library upload control',
      );
      await libraryEvaluate(`(() => {
        const bytes = Uint8Array.from(atob(${JSON.stringify(buildDiagnosticRom().toString('base64'))}), character => character.charCodeAt(0));
        const transfer = new DataTransfer();
        transfer.items.add(new File([bytes], 'diagnostic.gb', {type:'application/octet-stream'}));
        const input = document.getElementById('file');
        input.files = transfer.files;
        input.dispatchEvent(new Event('change'));
      })()`);
      await until(
        () => libraryEvaluate('!!document.querySelector(".game[title=\\"diagnostic.gb\\"]")'),
        'uploaded cartridge on the library shelf',
      );
      await libraryEvaluate('document.querySelector(".game").click()');
      await send('Page.bringToFront', {}, sessionId);
      console.info(
        'PASS first installation: empty console, library popup, authenticated upload/load and opener resume',
      );
    }
    await until(
      () =>
        evaluate(
          '!!window.ready && document.getElementById("gb-state").textContent === "connecté"',
        ),
      'console stream',
    );
  }
  await until(() => feature.status().players === 2, 'two native clients');
  await delay(600);
  for (const client of clients) {
    assert.equal(await client.evaluate('document.getElementById("gb-canvas").width'), 160);
    assert.ok(
      await client.evaluate('probe.contexts.some(context=>context.state === "running")'),
      'real audio context is playing',
    );
    assert.ok(
      await client.evaluate('owner.status().sources > 0'),
      'decoded audio blocks are scheduled',
    );
  }
  assert.deepEqual(
    await clients[0].evaluate(
      'Array.from(document.getElementById("gb-canvas").getContext("2d").getImageData(0,0,4,4).data)',
    ),
    await clients[1].evaluate(
      'Array.from(document.getElementById("gb-canvas").getContext("2d").getImageData(0,0,4,4).data)',
    ),
  );
  assert.ok(
    await clients[0].evaluate(
      'new Set(Array.from(document.getElementById("gb-canvas").getContext("2d").getImageData(0,0,4,4).data).filter((_,index)=>index%4===0)).size > 1',
    ),
    'the core renders the authored diagnostic pattern',
  );
  console.info(
    'PASS real mGBA: two independent clients receive identical pixels and Opus/PCM audio',
  );
  const first = clients[0];
  const press = await first.evaluate(`(()=>{
    const r=document.querySelector('[data-btn=a]').getBoundingClientRect();
    return {x:r.x+r.width/2,y:r.y+r.height/2,button:'left',clickCount:1};
  })()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...press }, first.sessionId);
  await until(
    () =>
      clients[1].evaluate('document.querySelector("[data-btn=a]").classList.contains("active")'),
    'mouse press visible on the other console',
  );
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...press }, first.sessionId);
  await until(
    () =>
      clients[1].evaluate('!document.querySelector("[data-btn=a]").classList.contains("active")'),
    'mouse release visible on the other console',
  );
  console.info('PASS real mouse press and release animate both independent consoles');
  await first.evaluate('document.getElementById("gb-canvas").focus()');
  await send(
    'Input.dispatchKeyEvent',
    { type: 'keyDown', key: 'x', code: 'KeyX', windowsVirtualKeyCode: 88 },
    first.sessionId,
  );
  assert.equal(
    await first.evaluate('document.querySelector("[data-btn=a]").classList.contains("active")'),
    true,
  );
  await first.evaluate('window.dispatchEvent(new Event("blur"))');
  assert.equal(
    await first.evaluate('document.querySelector("[data-btn=a]").classList.contains("active")'),
    false,
  );
  await first.evaluate('document.querySelector("[data-btn=a]").focus()');
  await send(
    'Input.dispatchKeyEvent',
    { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 },
    first.sessionId,
  );
  assert.equal(
    await first.evaluate('document.querySelector("[data-btn=a]").classList.contains("active")'),
    true,
  );
  await send(
    'Input.dispatchKeyEvent',
    { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 },
    first.sessionId,
  );
  assert.equal(
    await first.evaluate('document.querySelector("[data-btn=a]").classList.contains("active")'),
    false,
  );
  await first.evaluate('document.getElementById("chat").focus()');
  await send(
    'Input.dispatchKeyEvent',
    { type: 'keyDown', key: 'x', code: 'KeyX', windowsVirtualKeyCode: 88 },
    first.sessionId,
  );
  assert.equal(
    await first.evaluate('document.querySelector("[data-btn=a]").classList.contains("active")'),
    false,
  );
  await first.evaluate('document.getElementById("gb-power").click()');
  await until(() => feature.status().awake === 1, 'local sleep');
  assert.equal(
    await clients[1].evaluate('document.getElementById("gb-power").getAttribute("aria-checked")'),
    'true',
  );
  await first.evaluate('document.getElementById("gb-power").click()');
  await until(() => feature.status().awake === 2, 'local resume');
  console.info(
    'PASS scoped keyboard, text input exclusion, held-key release and independent local power',
  );
  await first.evaluate('document.querySelector(".wm-win").dataset.minimized="1"');
  await until(() => feature.status().players === 1, 'minimized console disconnect');
  assert.equal(
    await first.evaluate('owner.status().isStopped'),
    false,
    'minimize preserves its local owner',
  );
  await until(
    () => first.evaluate('probe.contexts.every(context=>context.state === "closed")'),
    'minimized audio cleanup',
  );
  await clients[1].evaluate('document.querySelector(".wm-win").dataset.minimized="1"');
  await until(() => feature.status().players === 0, 'every console minimized');
  assert.notEqual(feature.status().rom, null, 'minimizing all windows keeps the ROM loaded');
  await clients[1].evaluate('document.querySelector(".wm-win").dataset.minimized="0"');
  await first.evaluate('document.querySelector(".wm-win").dataset.minimized="0"');
  await until(() => feature.status().players === 2, 'minimized console resumes');
  console.info(
    'PASS minimize disconnects local streaming and audio; restore resumes without resetting the shared game',
  );
  await first.evaluate(
    'window.previousOwner=owner; document.querySelector(".wm-win").dispatchEvent(new Event("wm:close")); document.querySelector(".wm-win").dataset.minimized="1"',
  );
  await until(
    () => feature.status().players === 0 && feature.status().rom === null,
    'shared close unloads the server ROM',
  );
  await until(
    () =>
      clients[1].evaluate(
        '!document.getElementById("gb-start").hidden && !owner.status().hasSocket',
      ),
    'shared close stops the other console',
  );
  await delay(1800);
  assert.equal(feature.status().rom, null, 'reconnect timers cannot reload a closed ROM');
  assert.deepEqual(
    await first.evaluate(
      '({intervals:probe.intervals.size,observers:probe.observers.size,contexts:probe.contexts.filter(context=>context.state!=="closed").length})',
    ),
    { intervals: 0, observers: 0, contexts: 0 },
  );
  await first.evaluate(
    'document.querySelector(".wm-win").dataset.minimized="0"; window.owner=mount()',
  );
  assert.equal(
    await first.evaluate('document.getElementById("gb-start").hidden'),
    false,
    'a closed console requires an explicit new start',
  );
  assert.equal(await first.evaluate('owner.status().hasSocket'), false);
  await first.evaluate('document.getElementById("gb-startbtn").click()');
  await until(() => feature.status().players === 1, 'explicit restart boots a fresh console');
  await clients[1].evaluate('document.getElementById("gb-startbtn").click()');
  await until(() => feature.status().players === 2, 'console remount');
  assert.equal(await first.evaluate('previousOwner.status().hasSocket'), false);
  console.info(
    'PASS shared close unloads the server ROM and stops every stream; explicit restart boots a fresh core',
  );
  const uploaded = await fetch(origin + '/gameboy-api/roms?name=advance.gba', {
    method: 'POST',
    headers: { Cookie: first.cookie, 'Content-Type': 'application/octet-stream' },
    body: buildDiagnosticRom('AGB'),
  });
  assert.equal(uploaded.status, 200);
  const loaded = await fetch(origin + '/gameboy-api/load', {
    method: 'POST',
    headers: { Cookie: first.cookie, 'Content-Type': 'application/json' },
    body: '{"file":"advance.gba"}',
  });
  assert.equal(loaded.status, 200);
  await until(
    async () =>
      (
        await Promise.all(
          clients.map((client) => client.evaluate('document.getElementById("gb-canvas").width')),
        )
      ).every((width) => width === 240),
    'full GBA canvas',
  );
  // The Advance shell must follow the cartridge: landscape body, 3/2 screen and
  // the two shoulder buttons, on every connected console.
  assert.deepEqual(
    await Promise.all(
      clients.map((client) =>
        client.evaluate(`(() => {
          const shell = document.querySelector('.gb-shell');
          const screen = document.getElementById('gb-screen').getBoundingClientRect();
          return [
            shell.dataset.model,
            Math.round((screen.width / screen.height) * 100) / 100,
            Boolean(document.querySelector('[data-btn="l"]')),
            Boolean(document.querySelector('[data-btn="r"]')),
            Boolean(document.querySelector('.gb-art[data-case="AGB"]')),
          ];
        })()`),
      ),
    ),
    clients.map(() => ['AGB', 1.5, true, true, true]),
    'every console shows the Advance shell with its shoulders',
  );
  assert.deepEqual(errors, []);
  console.info(
    'PASS authenticated ROM upload/load updates both consoles to full GBA geometry; no browser exceptions',
  );
  // Removing a cartridge from the library must take its box off the shelf and
  // its file off the disk. The popup stays open from the first installation.
  let shelfTarget;
  await until(async () => {
    shelfTarget = (await send('Target.getTargets')).targetInfos.find(
      (target) => target.url === origin + '/gameboy-library',
    );
    return shelfTarget;
  }, 'library popup for removal');
  const { sessionId: shelfSession } = await send('Target.attachToTarget', {
    targetId: shelfTarget.targetId,
    flatten: true,
  });
  await send('Runtime.enable', {}, shelfSession);
  await send('Page.enable', {}, shelfSession);
  const shelfEvaluate = async (expression) => {
    const result = await send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      shelfSession,
    );
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const shelfBox = '.game[title=\\"diagnostic.gb\\"]';
  await until(
    () => shelfEvaluate(`!!document.querySelector("${shelfBox}")`),
    'cartridge on the shelf',
  );
  await shelfEvaluate(`document.querySelector("${shelfBox} .remove").click()`);
  await until(
    () => shelfEvaluate(`!document.querySelector("${shelfBox}")`),
    'cartridge removed from the shelf',
  );
  assert.equal(
    existsSync(resolve(dataDir, 'diagnostic.gb')),
    false,
    'the cartridge file must be deleted with its box',
  );
  console.info('PASS library removal deletes the cartridge file and clears its box');
} catch (error) {
  console.error('[gameboy browser]', JSON.stringify({ status: feature.status(), errors }));
  for (const client of clients)
    console.error(
      await client.evaluate(
        '({ready:window.ready,state:document.getElementById("gb-state")?.textContent,overlay:document.getElementById("gb-wait")?.textContent})',
      ),
    );
  throw error;
} finally {
  for (const client of clients) {
    try {
      await client.evaluate('owner.destroy()');
    } catch {
      /* A failed page may already be detached. */
    }
  }
  for (const call of pending.values()) {
    clearTimeout(call.timer);
    call.reject(new Error('Browser closed'));
  }
  socket?.close();
  browser?.kill();
  await feature.stop();
  server.closeAllConnections();
  await new Promise((resolveClose) => server.close(resolveClose));
}
