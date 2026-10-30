// Run from the ChaOS website: node games/mugen/tests/browser-library.mjs [screenshot.png]
import '../../../tests/helpers/isolated-env.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createHttpApp } from '../../../server/http/app.js';
import { requireAccount } from '../../../server/api/auth.js';
import { createAccount, createSession, SESSION_COOKIE } from '../../../server/auth/service.js';
import { db } from '../../../server/db/index.js';
import { createCatalog } from '../server/catalog.js';
import { mountMugenRoutes } from '../server/routes.js';
import { createPackUploads } from '../server/pack-uploads.js';
import { characterPack, stageSpriteFixture, zipFixture } from './zip-fixture.js';
import { startBrowser } from './browser-driver.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const client = fileURLToPath(new URL('../client/', import.meta.url));
const dataRoot = await mkdtemp(join(tmpdir(), 'mugen-library-fixture-'));
const catalog = createCatalog({ dataRoot });
const packs = createPackUploads({ catalog });
const app = createHttpApp();
mountMugenRoutes(app, { catalog });
packs.mount(app);
app.use('/games/mugen/client', express.static(client));
app.use('/core', express.static(resolve(root, 'website/core')));
app.get('/api/auth/me', requireAccount, (request, response) =>
  response.json({ account: request.account }),
);
app.get('/', (_request, response) =>
  response.type('html').send(`<!doctype html><html><body>
  <input id="fg-bgm-slider" type="range" value="50"><input id="fg-sfx-slider" type="range" value="50">
  <div id="mugen-body" style="height:600px"></div><script type="module">
  import {initMugen} from '/games/mugen/client/index.js';
  const handlers = new Map();
  window.fixtureSocket = {on(e,f){handlers.set(e,f)},off(e){handlers.delete(e)},emit(){},fire(e,p){handlers.get(e)?.(p)}};
  window.fixtureController = initMugen(fixtureSocket,()=>({userId:'host',pseudo:'Host'}),()=>{});
  fixtureSocket.fire('mugen:created',{roomId:'fixture',room:{players:[{userId:'host',pseudo:'Host'}],bet:0}});
  </script></body></html>`),
);
const server = createServer(app);
let browser;
try {
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { account } = await createAccount({
    email: 'mugen-library-browser@example.test',
    pseudo: 'Library Browser',
    password: 'isolated-library-test-password',
  });
  browser = await startBrowser();
  const main = await browser.page(origin);
  await main.command('Network.setCookie', {
    name: SESSION_COOKIE,
    value: createSession(account.id),
    url: origin,
    httpOnly: true,
    sameSite: 'Lax',
  });
  await main.command('Emulation.setDeviceMetricsOverride', {
    width: 1100,
    height: 760,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await main.wait(`!!document.querySelector('.mugen-picker')`, 'waiting room picker');

  // The library opens inside the MUGEN window: same tab, no popup target.
  const openLibrary = async () =>
    main.evaluate(`(() => {
      const button = [...document.querySelectorAll('.mugen-button')].find(
        (candidate) => candidate.textContent === 'Bibliothèque',
      );
      if (!button) return false;
      button.click();
      return true;
    })()`);
  const closeLibrary = () =>
    main.evaluate(`document.querySelector('.mugen-library .library-back').click()`);
  assert.equal(await openLibrary(), true, 'library button in the room');
  await main.wait(
    `!!document.querySelector('.mugen-library')`,
    'library panel in the MUGEN window',
  );
  assert.equal(
    (await browser.send('Target.getTargets')).targetInfos.filter((target) =>
      target.url.includes('/mugen-library'),
    ).length,
    0,
    'the library must not open another window',
  );
  await main.wait(
    `document.querySelector('.mugen-library .upload-button')?.disabled === false`,
    'authenticated upload control',
  );

  const selectZip = (name, buffer) =>
    main.evaluate(`(() => {
    const bytes=Uint8Array.from(atob(${JSON.stringify(buffer.toString('base64'))}), c=>c.charCodeAt(0));
    const files=new DataTransfer(); files.items.add(new File([bytes],${JSON.stringify(name)},{type:'application/zip'}));
    const input=document.querySelector('.mugen-library .pack-input');input.files=files.files;
    input.dispatchEvent(new Event('change'));
  })()`);
  const count = (kind) =>
    `document.querySelector('.mugen-library [data-kind="${kind}"] .tab-count')?.textContent`;

  await selectZip('hero.zip', characterPack());
  await main.wait(
    `${count('characters')} === '1' && !document.querySelector('.mugen-library .upload-button').disabled`,
    'uploaded character on shelf',
  );
  await closeLibrary();
  await main.wait(
    `!!document.querySelector('.mugen-picker .mugen-character[data-path="hero/hero.def"]')`,
    'new character in the open room picker',
  );
  assert.equal(
    await main.evaluate(`!!document.querySelector('.mugen-library')`),
    false,
    'closing the library returns to the view underneath',
  );

  assert.equal(await openLibrary(), true, 'library reopens');
  await main.wait(
    `document.querySelector('.mugen-library')?.classList.contains('is-compact')`,
    'window layout',
  );
  await main.evaluate(`document.querySelector('.mugen-library [data-kind="stages"]').click()`);
  const stage = zipFixture([
    {
      name: 'dojo/dojo.def',
      data: '[Info]\nname = Dojo\n[BGdef]\nspr = dojo.sff\n[BG sky]\ntype = normal\nspriteno = 0,0\nstart = -160,0\n',
    },
    { name: 'dojo/dojo.sff', data: stageSpriteFixture() },
  ]);
  await selectZip('dojo.zip', stage);
  await main.wait(
    `${count('stages')} === '1' && !document.querySelector('.mugen-library .upload-button').disabled`,
    'uploaded stage on shelf',
  );
  await main.wait(
    `document.querySelector('.mugen-library .mugen-stage-preview')?.naturalWidth === 320`,
    'real stage thumbnail on the shelf',
  );
  await closeLibrary();
  await main.wait(
    `!!document.querySelector('.mugen-picker select option[value="dojo/dojo.def"]')`,
    'new stage in the open room picker',
  );
  await main.wait(
    `document.querySelector('.mugen-stage-card .mugen-stage-preview')?.naturalWidth === 320`,
    'stage thumbnail in the picker',
  );
  await main.evaluate(`document.querySelector('.mugen-stage-card').click()`);
  assert.equal(
    await main.evaluate(`document.querySelector('.mugen-picker select').value`),
    'dojo/dojo.def',
  );
  assert.equal(catalog.characters().length, 1);
  assert.equal(catalog.stages().length, 1);

  // Opening the panel from the lobby keeps the lobby mounted underneath.
  await main.evaluate(`fixtureSocket.fire('mugen:cancelled')`);
  await main.wait(`!!document.querySelector('.mugen-lobby')`, 'lobby');
  await main.evaluate(
    `(() => { document.querySelector('.mugen-lobby .mugen-input').value = '25'; })()`,
  );
  assert.equal(await openLibrary(), true, 'library opens from the lobby');
  await main.wait(`!!document.querySelector('.mugen-library')`, 'library panel from the lobby');
  await closeLibrary();
  await main.wait(`!document.querySelector('.mugen-library')`, 'library closed');
  assert.equal(
    await main.evaluate(`document.querySelector('.mugen-lobby .mugen-input').value`),
    '25',
    'browsing the library leaves the lobby untouched',
  );

  assert.equal(await openLibrary(), true, 'library opens for the screenshot');
  await main.wait(`!!document.querySelector('.mugen-library .pack')`, 'library shelf');
  assert.equal(await main.evaluate(`document.documentElement.scrollWidth <= innerWidth`), true);
  if (process.argv[2]) {
    const image = await main.command('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
    });
    await writeFile(resolve(process.argv[2]), Buffer.from(image.data, 'base64'));
  }

  await main.command('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  assert.equal(
    await main.evaluate(`document.documentElement.scrollWidth <= innerWidth`),
    true,
    'mobile library has no horizontal overflow',
  );
  assert.equal(
    await main.evaluate(`(() => {
      const overlay = document.querySelector('.mugen-library-overlay');
      const style = getComputedStyle(overlay);
      return overlay.scrollHeight <= overlay.clientHeight || style.overflowY === 'auto';
    })()`),
    true,
    'mobile shelf stays reachable inside the window',
  );

  // The standalone page stays available for a direct link.
  await main.command('Network.deleteCookies', { name: SESSION_COOKIE, url: origin });
  await main.command('Page.navigate', { url: origin + '/mugen-library' });
  await main.wait(
    `document.querySelector('.mugen-library .account-note')?.textContent.includes('Connecte-toi')`,
    'signed-out upload restriction',
  );
  assert.equal(
    await main.evaluate(`document.querySelector('.mugen-library .upload-button').disabled`),
    true,
  );
  assert.equal(await main.evaluate(`${count('characters')}`), '1');
  assert.deepEqual(browser.exceptions, []);
  console.info(
    'PASS MUGEN library: opens inside the MUGEN window, character/stage uploads refresh the open picker, responsive shelf, standalone page stays read-only when signed out',
  );
} finally {
  await browser?.close();
  await packs.stop();
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  db.close();
  await rm(dataRoot, { recursive: true, force: true });
}
