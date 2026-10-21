import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import express from 'express';
import feature from '../server/index.js';

test('Fighting serves its migrated data and only its public client', async (t) => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'fighting-routes-'));
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));
  for (const folder of ['Characters/Ryu/wrapped', 'Stages/dojo', 'Stages/incomplete'])
    mkdirSync(join(dataRoot, folder), { recursive: true });
  writeFileSync(join(dataRoot, 'Characters/Ryu/wrapped/ryu.def'), '[Info]\ndisplayname = "Ryu"');
  writeFileSync(join(dataRoot, 'Stages/dojo/dojo.def'), '[Info]\nname = "Dojo"');
  writeFileSync(join(dataRoot, 'Stages/dojo/dojo.sff'), 'stage-data');
  writeFileSync(join(dataRoot, 'Stages/incomplete/empty.def'), '[Info]');
  const app = express();
  let limitedRequests = 0;
  feature.routes(app, {
    dataRoot,
    apiLimiter(_request, _response, next) {
      limitedRequests++;
      next();
    },
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const get = (path) => fetch(origin + path);
  assert.deepEqual(await (await get('/api/mugen/chars')).json(), [
    { folder: 'Ryu/wrapped', defFile: 'ryu.def', name: 'Ryu' },
  ]);
  assert.deepEqual(await (await get('/api/mugen/stages')).json(), [
    { folder: 'dojo', defFile: 'dojo.def', sffFile: 'dojo.sff', name: 'Dojo' },
  ]);
  assert.equal(limitedRequests, 2);
  const definition = await get('/mugen/Ryu/wrapped/ryu.def');
  assert.equal(definition.status, 200);
  assert.equal(definition.headers.get('cache-control'), 'no-cache');
  assert.match(await definition.text(), /Ryu/);
  const stage = await get('/mugen-stages/dojo/dojo.sff');
  assert.equal(await stage.text(), 'stage-data');
  const client = await get('/games/fighting/client/index.js');
  assert.equal(client.status, 200);
  assert.equal(client.headers.get('cache-control'), 'no-cache');
  assert.equal((await get('/games/fighting/client/mugen/safe-url.js')).status, 200);
  assert.equal((await get('/games/fighting/server/runtime.js')).status, 404);
});
