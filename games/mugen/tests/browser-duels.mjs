import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import express from 'express';
import { Server } from 'socket.io';
import { createCatalog } from '../server/catalog.js';
import { mountMugenRoutes } from '../server/routes.js';
import { createMugenRuntime } from '../server/runtime.js';
import { startBrowser } from './browser-driver.mjs';
import { installNativeGamepad, readConfirmedPadInputs } from './fixtures/gamepad-browser.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const catalog = createCatalog({ dataRoot: root + 'games/mugen/data' });
const fighter = catalog.characters().find((entry) => entry.path.startsWith('Goku/'));
const stage = catalog.stages()[0];
const app = express();
mountMugenRoutes(app, { catalog });
app.use('/games/mugen/client', express.static(root + 'games/mugen/client'));
app.use('/core', express.static(root + 'website/core'));
app.get('/', (_request, response) =>
  response.type('html').send(`<!doctype html>
<div id="mugen-body" style="height:650px"></div>
<script src="/socket.io/socket.io.js"></script><script type="module">
import { initMugen } from '/games/mugen/client/index.js';
window.notices=[]; window.received=[]; window.socket=io();
socket.onAny((event,payload)=>received.push({event,payload}));
window.controller=initMugen(socket,()=>null,message=>notices.push(message));
</script>`),
);
const server = createServer(app);
const io = new Server(server);
const users = new Map();
const runtime = createMugenRuntime({ catalog, users });
runtime.init(io);
io.on('connection', (socket) => {
  const user = { userId: socket.id, pseudo: socket.id, clients: new Set([socket]), points: 0 };
  users.set(socket.id, user);
  runtime.wire(socket, { user, accountId: socket.id });
  socket.on('disconnect', () => {
    runtime.onSocketDisconnect(socket);
    runtime.onUserDisconnect(socket.id);
    users.delete(socket.id);
  });
});
let browser;
const pages = [];
try {
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  browser = await startBrowser({ commandTimeout: 60000 });
  const url = 'http://127.0.0.1:' + server.address().port;
  const openPlayer = async () => {
    const { targetId } = await browser.send('Target.createTarget', {
      url: 'about:blank',
      newWindow: process.argv.includes('--separate-windows'),
    });
    const page = await browser.attach(targetId);
    await page.command('Page.navigate', { url });
    return page;
  };
  const host = await openPlayer(),
    guest = await openPlayer();
  pages.push(host, guest);
  for (const page of [host, guest]) await page.wait('!!window.controller', 'controller');
  await host.evaluate("void socket.emit('mugen:create',{bet:0})");
  const created = await host.wait(
    "received.find(item=>item.event==='mugen:created')?.payload",
    'room',
  );
  await guest.evaluate(`void socket.emit('mugen:join',{roomId:${JSON.stringify(created.roomId)}})`);
  for (const page of [host, guest]) {
    await page.evaluate(
      `void socket.emit('mugen:select_char',${JSON.stringify({ roomId: created.roomId, character: fighter.path, stage: stage.path })})`,
    );
  }
  for (const page of [host, guest]) {
    await page.wait(
      "document.querySelector('iframe')?.contentWindow.chaosSession?.presented",
      'online fight presented',
      30000,
    );
    await page.wait(
      "document.querySelector('iframe')?.contentWindow.chaosSession?.ticks >= 30",
      'online fight advances on both peers',
      30000,
    );
  }
  assert.deepEqual(await host.evaluate('notices'), []);
  assert.deepEqual(await guest.evaluate('notices'), []);
  for (const page of [host, guest]) await page.evaluate(`(${installNativeGamepad.toString()})()`);
  await host.evaluate(
    "Object.assign(document.querySelector('iframe').contentWindow.testGamepad.buttons[0],{pressed:true,value:1}); document.querySelector('iframe').contentWindow.testGamepad.buttons[14].pressed=true; true",
  );
  await guest.evaluate(
    "Object.assign(document.querySelector('iframe').contentWindow.testGamepad.buttons[2],{pressed:true,value:1}); document.querySelector('iframe').contentWindow.testGamepad.buttons[15].pressed=true; true",
  );
  await host.wait(
    `(${readConfirmedPadInputs.toString()})().then(inputs => inputs && (inputs[0] & 20) === 20 && (inputs[1] & 136) === 136)`,
    'both players use their first local controller',
  );
  for (const page of [host, guest])
    await page.evaluate("document.querySelector('iframe').contentWindow.testGamepad=null");
  await host.wait(
    `(${readConfirmedPadInputs.toString()})().then(inputs => inputs && inputs[0] === 0 && inputs[1] === 0)`,
    'controller disconnect releases both players',
  );
  console.info('PASS native Mugen controller inputs for host and guest, including disconnect');
  await host.command('Page.bringToFront');
  await host.evaluate(`(() => {
    const frame = document.querySelector('iframe').contentWindow;
    frame.document.dispatchEvent(new frame.KeyboardEvent('keydown', {key:'ArrowRight',code:'ArrowRight',bubbles:true}));
    frame.document.dispatchEvent(new frame.KeyboardEvent('keydown', {key:'Escape',code:'Escape',bubbles:true,cancelable:true}));
  })()`);
  await host.wait(
    "document.querySelectorAll('.mugen-move-row').length > 0",
    'character commands shown with Escape',
  );
  assert.equal(
    await host.evaluate("document.querySelector('.mugen-move-legend kbd').textContent"),
    'W',
    'French AZERTY labels',
  );
  await host.evaluate("import('/core/js/i18n.js').then(module=>module.applyAccountLanguage('en'))");
  await host.wait(
    "document.querySelector('.mugen-move-legend kbd')?.textContent === 'Z'",
    'English QWERTY labels update during play',
  );
  await host.evaluate(
    "(() => {const select=document.querySelector('.mugen-move-list select');select.value='gamepad';select.dispatchEvent(new Event('change'));})()",
  );
  await host.wait(
    "document.querySelector('.mugen-move-legend kbd')?.textContent === 'A / ✕' && document.querySelectorAll('.mugen-move-row').length > 0",
    'controller move notation',
  );
  await host.evaluate("import('/core/js/i18n.js').then(module=>module.applyAccountLanguage('fr'))");
  await host.evaluate(
    "document.querySelector('iframe').dispatchEvent(new MouseEvent('mouseenter'))",
  );
  assert.equal(
    await host.evaluate(
      "document.querySelector('.mugen-move-list').contains(document.activeElement)",
    ),
    true,
    'the engine cannot steal focus from its move list',
  );
  assert.equal(await host.evaluate("document.querySelectorAll('[role=tab]').length"), 2);
  assert.equal(
    await host.evaluate("document.querySelector('iframe').contentWindow.chaosSession.stop"),
    false,
    'Escape must not cancel the native fight',
  );
  await host.evaluate("document.querySelectorAll('[role=tab]')[1].click()");
  await host.wait(
    "document.querySelectorAll('[role=tab]')[1].getAttribute('aria-selected') === 'true' && document.querySelectorAll('.mugen-move-row').length > 0",
    'opponent commands shown',
  );
  if (process.env.MUGEN_SCREENSHOT) {
    await host.command('Emulation.setDeviceMetricsOverride', {
      width: 460,
      height: 700,
      deviceScaleFactor: 1,
      mobile: false,
    });
    assert.equal(
      await host.evaluate(
        "document.querySelector('.mugen-move-list').scrollWidth <= document.querySelector('.mugen-move-list').clientWidth",
      ),
      true,
      'move list fits a narrow game window',
    );
    const screenshot = await host.command('Page.captureScreenshot', { format: 'png' });
    await writeFile(process.env.MUGEN_SCREENSHOT, Buffer.from(screenshot.data, 'base64'));
  }
  await host.evaluate(
    "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true,cancelable:true}))",
  );
  assert.equal(await host.evaluate("!!document.querySelector('.mugen-move-list')"), false);
  assert.equal(
    await host.evaluate("document.activeElement === document.querySelector('iframe')"),
    true,
    'closing restores engine focus',
  );
  assert.equal(
    await host.evaluate("document.querySelector('iframe').contentWindow.chaosSession.stop"),
    false,
  );
  console.info('PASS two real socket clients start a native duel');
  console.info('PASS Escape shows both command lists and closes without cancelling the fight');
} catch (error) {
  for (const page of pages)
    console.error(
      JSON.stringify(
        await page.evaluate(
          `({notices,events:received.map(item=>item.event),session:(()=>{const session=document.querySelector('iframe')?.contentWindow.chaosSession;return session && {trace:session.trace.map(item=>item.name),presented:session.presented,polls:session.polls,loads:session.loads,ticks:session.ticks};})()})`,
        ),
      ),
    );
  console.error(browser?.consoleMessages.join('\n'));
  throw error;
} finally {
  await browser?.close();
  for (const id of users.keys()) runtime.onUserDisconnect(id);
  await runtime.stop();
  io.close();
  server.closeAllConnections();
}
