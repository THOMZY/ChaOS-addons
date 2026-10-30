import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import { createCatalog } from '../server/catalog.js';
import { mountMugenRoutes } from '../server/routes.js';
import { createMugenRuntime } from '../server/runtime.js';
import { startBrowser } from './browser-driver.mjs';

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
  console.info('PASS two real socket clients start a native duel');
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
