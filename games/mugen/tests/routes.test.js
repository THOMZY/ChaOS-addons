import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import express from 'express';
import { createCatalog } from '../server/catalog.js';
import { mountMugenRoutes } from '../server/routes.js';

async function serve(t, dataRoot) {
  const app = express();
  let limited = 0;
  mountMugenRoutes(app, {
    catalog: createCatalog({ dataRoot }),
    apiLimiter(_request, _response, next) {
      limited++;
      next();
    },
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = 'http://127.0.0.1:' + server.address().port;
  return { get: (path) => fetch(origin + path), limited: () => limited };
}

function write(root, path, content) {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), content);
}

test('MUGEN lists packs, serves them and answers 503 until the engine is installed', async (t) => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'mugen-routes-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  write(
    dataRoot,
    'Characters/Ryu/wrapped/ryu.def',
    '[Info]\ndisplayname = "Ryu"\n[Files]\nsprite = ryu.sff\n',
  );
  write(dataRoot, 'Characters/Ryu/wrapped/ryu.sff', 'sprites');
  write(dataRoot, 'Characters/Ryu/wrapped/intro.def', '[SceneDef]\nspr = intro.sff\n');
  write(dataRoot, 'Stages/dojo/dojo.def', '[Info]\nname = "Dojo"\n[StageInfo]\nzoffset = 200\n');
  write(dataRoot, 'Stages/dojo/dojo.sff', 'stage-data');
  const { get, limited } = await serve(t, dataRoot);
  assert.deepEqual(await (await get('/api/mugen/chars')).json(), [
    { path: 'Ryu/wrapped/ryu.def', name: 'Ryu' },
  ]);
  assert.deepEqual(await (await get('/api/mugen/stages')).json(), [
    { path: 'dojo/dojo.def', name: 'Dojo' },
  ]);
  const missing = await get('/api/mugen/fs');
  assert.equal(missing.status, 503);
  assert.deepEqual(await missing.json(), { error: 'engine_missing' });
  assert.equal(limited(), 3);
  const definition = await get('/mugen/Ryu/wrapped/ryu.def');
  assert.equal(definition.headers.get('cache-control'), 'no-cache');
  assert.match(await definition.text(), /Ryu/);
  assert.equal(await (await get('/mugen-stages/dojo/dojo.sff')).text(), 'stage-data');
  assert.equal((await get('/mugen/../server/index.js')).status, 404);
});

test('MUGEN describes the browser file system of an installed engine', async (t) => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'mugen-fs-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  const kfm = '[Info]\nname = KFM\n[Files]\nsprite = kfm.sff\n';
  write(dataRoot, 'Characters/kfm/kfm.def', kfm);
  write(dataRoot, 'Stages/dojo.def', '[BGdef]\n');
  write(dataRoot, 'engine/ikemen.0123456789ab.wasm', 'wasm');
  write(dataRoot, 'engine/wasm_exec.0123456789ab.js', 'loader');
  write(dataRoot, 'engine/fs/external/script/main.lua', '-- main');
  write(
    dataRoot,
    'engine/engine.json',
    JSON.stringify({
      version: 'test',
      wasm: 'ikemen.0123456789ab.wasm',
      loader: 'wasm_exec.0123456789ab.js',
      files: [['external/script/main.lua', 7]],
    }),
  );
  const { get } = await serve(t, dataRoot);
  const response = await get('/api/mugen/fs');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const manifest = await response.json();
  assert.deepEqual(manifest.engine, {
    wasm: 'ikemen.0123456789ab.wasm',
    loader: 'wasm_exec.0123456789ab.js',
    version: 'test',
  });
  assert.deepEqual(manifest.groups[1], {
    prefix: 'chars/',
    base: '/mugen/',
    files: [['kfm/kfm.def', Buffer.byteLength(kfm)]],
  });
  assert.match(
    manifest.generated['data/select.def'],
    /\[Characters\]\nkfm\/kfm\.def\n\n\[ExtraStages\]\nstages\/dojo\.def/,
  );
  const wasm = await get('/games/mugen/engine/ikemen.0123456789ab.wasm');
  assert.equal(wasm.headers.get('content-type'), 'application/wasm');
  assert.match(wasm.headers.get('cache-control'), /immutable/);
  assert.equal(
    await (await get('/games/mugen/engine/fs/external/script/main.lua')).text(),
    '-- main',
  );
});

test('MUGEN move list endpoint serves commands and rejects unknown characters', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mugen-move-route-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  write(root, 'Characters/Ryu/ryu.def', '[Files]\nsprite=ryu.sff\ncmd=ryu.cmd');
  write(root, 'Characters/Ryu/ryu.cmd', '[Command]\nname=Hadouken\ncommand=D,DF,F,x');
  const { get } = await serve(t, root);
  const response = await get('/api/mugen/moves?path=Ryu%2Fryu.def');
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).moves, [{ name: 'Hadouken', input: 'D,DF,F,x' }]);
  assert.equal((await get('/api/mugen/moves?path=../private.def')).status, 404);
});
