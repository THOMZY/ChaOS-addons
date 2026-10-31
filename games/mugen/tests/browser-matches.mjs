// Run from the website checkout with installed engine/packs:
// node games/mugen/tests/browser-matches.mjs [character-path] [stage-path]
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createCatalog } from '../server/catalog.js';
import { mountMugenRoutes } from '../server/routes.js';
import { startBrowser, pause } from './browser-driver.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const catalog = createCatalog({ dataRoot: root + 'games/mugen/data' });
const fighter =
  process.argv[2] ?? catalog.characters().find((entry) => entry.path.startsWith('Goku/'))?.path;
const stage =
  process.argv[3] ?? catalog.stages().find((entry) => entry.path.startsWith('Sunset/'))?.path;
assert.ok(fighter && stage, 'Install a fighter and stage or pass their catalogue paths');
const requests = new Map();
const musicRequests = [];
const app = express();
app.use((request, _response, next) => {
  if (request.path.startsWith('/mugen/'))
    requests.set(request.path, (requests.get(request.path) ?? 0) + 1);
  if (request.path.startsWith('/mugen-stages/') && /\.(mp3|ogg|wav)$/i.test(request.path))
    musicRequests.push(request.path);
  next();
});
// Simulate a browser holding the old unversioned Lua script without the ready
// marker. The corrected client must request the bundle's version instead.
app.get('/games/mugen/engine/fs/external/script/main.lua', async (request, response, next) => {
  if (request.query.v) return next();
  const script = await readFile(
    root + 'games/mugen/data/engine/fs/external/script/main.lua',
    'utf8',
  );
  response.type('text').send(script.replace(/^.*main\.f_printTable\(\{ready = true\}.*$/m, ''));
});
mountMugenRoutes(app, { catalog });
app.get('/games/mugen/client/engine/host.html', async (_request, response) => {
  const html = await readFile(root + 'games/mugen/client/engine/host.html', 'utf8');
  response.type('html').send(
    html.replace(
      '<head>',
      `<head><script>
  let nativeBridge;
  Object.defineProperty(window,'chaosSession',{get:()=>nativeBridge,set:bridge=>{
    nativeBridge=bridge;
    let shown=false,allow=true,pending=false;
    Object.defineProperty(bridge,'presented',{get:()=>shown,set:value=>{if(!value){shown=false;return;}if(allow)shown=true;else pending=true;}});
    const present=bridge.present;
    bridge.present=()=>{allow=false;pending=false;const polls=bridge.polls;present();setTimeout(()=>{
      parent.paintStayedStill &&= bridge.polls===polls;
      parent.presentations++;
      allow=true;if(pending)shown=true;
    },250);};
  }});
  const copy = AudioBuffer.prototype.copyToChannel;
  AudioBuffer.prototype.copyToChannel = function(samples, ...args) {
    for (let i=0;i<samples.length;i+=64) if (Math.abs(samples[i])>0.0001) { parent.audioEnergy++; break; }
    return copy.call(this,samples,...args);
  };
  </script>`,
    ),
  );
});
app.use('/games/mugen/client', express.static(root + 'games/mugen/client'));
app.use('/core', express.static(root + 'website/core'));
app.get('/', (_request, response) =>
  response.type('html').send(`<!doctype html><body>
<input id="fg-bgm-slider" type="range" value="60"><input id="fg-sfx-slider" type="range" value="0">
<div id="mugen-body" style="height:650px"></div><script type="module">
import { initMugen } from '/games/mugen/client/index.js';
import { createGameScope } from '/core/js/games/game-scope.js';
window.fixtureScope = createGameScope(); window.notices=[]; window.audioEnergy=0;window.paintStayedStill=true;window.presentations=0;
window.controller=initMugen({on(){},off(){},emit(){}},()=>null,message=>notices.push(message),fixtureScope);
</script>`),
);
const server = createServer(app);
let browser;
try {
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  browser = await startBrowser({ commandTimeout: 60000 });
  const page = await browser.page('http://127.0.0.1:' + server.address().port);
  const openTraining = () =>
    page.evaluate(
      `(() => { document.querySelectorAll('.mugen-card')[0].querySelectorAll('button')[1].click(); })()`,
    );
  const launch = async () => {
    const started = Date.now();
    await page.wait(`!!document.querySelector('.mugen-picker')`, 'training picker');
    await page.evaluate(`(() => {
      const button = [...document.querySelectorAll('.mugen-character')].find(button => button.dataset.path === ${JSON.stringify(fighter)});
      button.click(); button.click();
      document.querySelector('.mugen-picker select').value=${JSON.stringify(stage)};
      document.querySelector('.mugen-picker .mugen-primary').click();
    })()`);
    await page.wait(`!!document.querySelector('.mugen-engine-frame')`, 'engine frame');
    await page
      .wait(
        `!!document.querySelector('.mugen-engine-frame') && !document.querySelector('.mugen-overlay')`,
        'loading message removed after fighters are ready',
        120000,
      )
      .catch((error) => {
        throw new Error(error.message + '\n' + browser.consoleMessages.join('\n'));
      });
    assert.deepEqual(await page.evaluate('window.notices'), []);
    await pause(800);
    return Date.now() - started;
  };
  await page.wait(`!!document.querySelector('.mugen-lobby')`, 'lobby');
  await openTraining();
  const coldMs = await launch();
  const cold = await page.evaluate(
    `(() => { const frame=document.querySelector('.mugen-engine-frame'); window.firstEngine=frame.contentWindow;window.firstFs=firstEngine.fs;return {...firstEngine.chaosSession}; })()`,
  );
  assert.equal(cold.loads, 2, 'both native fighters were loaded once');
  await page.evaluate(`(() => {
    firstEngine.document.dispatchEvent(new firstEngine.KeyboardEvent('keydown', {key:'Escape',code:'Escape',bubbles:true,cancelable:true}));
  })()`);
  await page.wait("document.querySelectorAll('.mugen-move-row').length > 0", 'training move list');
  assert.equal(
    await page.evaluate('firstEngine.chaosSession.stop'),
    false,
    'Escape opens the list without quitting training',
  );
  await page.evaluate(
    "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true,cancelable:true}))",
  );
  assert.equal(await page.evaluate("!!document.querySelector('.mugen-move-list')"), false);
  // Oto unlocks its audio context on the first input inside the engine frame.
  await page.command('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'ArrowRight',
    code: 'ArrowRight',
    windowsVirtualKeyCode: 39,
  });
  await page.command('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'ArrowRight',
    code: 'ArrowRight',
    windowsVirtualKeyCode: 39,
  });
  await page.wait('window.audioEnergy > 0', 'audible stage music with SFX muted', 30000);
  assert.ok(musicRequests.length, 'stage music file was fetched');
  const first = new Map(requests);
  assert.ok(first.size > 2, 'native engine actually loaded fighter resources');
  await page.evaluate(`document.querySelector('.mugen-bar button:last-child').click()`);
  await page.wait(`!!document.querySelector('.mugen-lobby')`, 'quit first match');
  await openTraining();
  const warmMs = await launch();
  const warm = await page.evaluate(
    `(() => {const frame=document.querySelector('.mugen-engine-frame');return {sameWindow:frame.contentWindow===firstEngine,sameFs:frame.contentWindow.fs===firstFs,loads:frame.contentWindow.chaosSession.loads,reuses:frame.contentWindow.chaosSession.reuses,trace:frame.contentWindow.chaosSession.trace};})()`,
  );
  assert.equal(warm.sameWindow, true, 'iframe document stays alive across matches');
  console.info(JSON.stringify(warm.trace));
  assert.equal(warm.sameFs, true, 'same Go filesystem and engine instance');
  assert.equal(warm.loads, cold.loads, 'no fighter is recompiled or decoded on the rematch');
  assert.equal(warm.reuses, cold.reuses + 2, 'native loader reuses both fighters');
  assert.ok(
    warmMs < 8000,
    `resident rematch should not stall on full-track audio decoding (${warmMs}ms)`,
  );
  assert.equal(
    await page.evaluate('window.paintStayedStill'),
    true,
    'native match does not advance while browser paint acknowledgment is delayed',
  );
  assert.equal(await page.evaluate('window.presentations'), 2);
  if (process.argv[4]) {
    const image = await page.command('Page.captureScreenshot', { format: 'png' });
    await writeFile(process.argv[4], Buffer.from(image.data, 'base64'));
  }
  for (const [path, count] of first)
    assert.equal(requests.get(path), count, 'fighter resource is reused: ' + path);
  const caches = await page.evaluate(
    `caches.keys().then(names=>names.filter(name=>name.startsWith('mugen-window-')).length)`,
  );
  assert.equal(caches, 1, 'one temporary cache belongs to the MUGEN window');
  await page.evaluate('fixtureScope.stop()');
  assert.equal(
    await page.evaluate('document.querySelectorAll(".mugen-engine-frame").length'),
    0,
    'unloading the window removes its native engine',
  );
  await page.wait(
    `caches.keys().then(names=>names.every(name=>!name.startsWith('mugen-window-')))`,
    'temporary cache removed on disposal',
  );
  assert.deepEqual(browser.exceptions, []);
  console.info(
    `PASS two native matches with ${fighter}: same runtime, ${warm.loads} native loads total, ${warm.reuses} native reuses; cold ${coldMs}ms / warm ${warmMs}ms; paint barrier held; music audible; temporary cache cleaned`,
  );
} catch (error) {
  console.error('Stage audio requests:', musicRequests);
  console.error(browser?.consoleMessages.join('\n'));
  throw error;
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
}
