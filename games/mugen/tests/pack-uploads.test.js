import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpApp } from '../../../server/http/app.js';
import {
  createAccount,
  createSession,
  revokeSession,
  SESSION_COOKIE,
  accountFromHeaders,
} from '../../../server/auth/service.js';
import { db } from '../../../server/db/index.js';
import { createCatalog } from '../server/catalog.js';
import { mountMugenRoutes } from '../server/routes.js';
import { createPackUploads } from '../server/pack-uploads.js';
import { characterPack, spriteFixture, zipFixture } from './zip-fixture.js';

after(() => db.close());

async function fixture(t) {
  const dataRoot = await mkdtemp(join(tmpdir(), 'mugen-pack-api-'));
  const catalog = createCatalog({ dataRoot });
  const packs = createPackUploads({ catalog });
  const app = createHttpApp();
  mountMugenRoutes(app, { catalog });
  packs.mount(app);
  const server = createServer(app);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(async () => {
    await packs.stop();
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await rm(dataRoot, { recursive: true, force: true });
  });
  const { account } = await createAccount({
    email: `mugen-pack-${crypto.randomUUID()}@example.test`,
    pseudo: `Pack ${crypto.randomUUID().slice(0, 8)}`,
    password: 'mugen-pack-test-password',
  });
  const token = createSession(account.id),
    cookie = `${SESSION_COOKIE}=${token}`;
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (kind, name, body, headers = { Cookie: cookie }) =>
    fetch(`${origin}/api/mugen/packs/${kind}?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', ...headers },
      body,
    });
  return { dataRoot, catalog, packs, token, cookie, origin, post };
}

test('MUGEN pack uploads require a current account and same origin before parsing the archive', async (t) => {
  const scene = await fixture(t);
  assert.equal((await scene.post('characters', 'hero.zip', 'bad', {})).status, 401);
  assert.equal(
    (
      await scene.post('characters', 'hero.zip', 'bad', {
        Cookie: scene.cookie,
        Origin: 'https://other.invalid',
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await scene.post('characters', 'hero.zip', characterPack(), {
        Cookie: scene.cookie,
        Origin: scene.origin,
      })
    ).status,
    201,
  );
  revokeSession(accountFromHeaders({ cookie: scene.cookie }).sessionId);
  assert.equal((await scene.post('characters', 'other.zip', characterPack())).status, 401);
});

test('MUGEN uploaded characters and stages appear immediately in the shared picker and file manifest', async (t) => {
  const scene = await fixture(t);
  assert.deepEqual((await (await fetch(scene.origin + '/api/mugen/packs')).json()).characters, []);
  assert.equal((await scene.post('characters', 'hero.zip', characterPack())).status, 201);
  const map = zipFixture([
    { name: 'dojo/dojo.def', data: '[Info]\nname = Dojo\n[BGdef]\nspr = dojo.sff\n' },
    { name: 'dojo/dojo.sff', data: spriteFixture },
  ]);
  assert.equal((await scene.post('stages', 'dojo.zip', map)).status, 201);
  const library = await fetch(scene.origin + '/api/mugen/packs');
  assert.equal(library.headers.get('cache-control'), 'no-store');
  const data = await library.json();
  assert.deepEqual(data.characters, [{ path: 'hero/hero.def', name: 'Hero' }]);
  assert.deepEqual(data.stages, [{ path: 'dojo/dojo.def', name: 'Dojo' }]);
  assert.deepEqual(await (await fetch(scene.origin + '/api/mugen/chars')).json(), data.characters);
  assert.deepEqual(await (await fetch(scene.origin + '/api/mugen/stages')).json(), data.stages);
  const sprites = await fetch(scene.origin + '/mugen/hero/hero.sff');
  assert.equal(sprites.status, 200);
  assert.equal(sprites.headers.get('x-content-type-options'), 'nosniff');
  const page = await fetch(scene.origin + '/mugen-library');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /\/games\/mugen\/client\/library\.js/);
});

test('MUGEN rejects invalid/duplicate packs without leaving partial public files and stops upload admission', async (t) => {
  const scene = await fixture(t);
  assert.equal((await scene.post('characters', 'bad.zip', 'not a zip')).status, 400);
  assert.deepEqual(await readdir(scene.dataRoot), []);
  assert.equal((await scene.post('characters', 'hero.zip', characterPack())).status, 201);
  assert.equal((await scene.post('characters', 'hero.zip', characterPack())).status, 409);
  assert.deepEqual(await readdir(scene.dataRoot), ['Characters']);
  await scene.packs.stop();
  assert.equal((await scene.post('characters', 'late.zip', characterPack())).status, 503);
  assert.deepEqual(scene.packs.status(), { accepting: false, activeRequests: 0 });
});
