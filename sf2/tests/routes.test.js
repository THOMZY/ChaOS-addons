import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';
import feature from '../server/index.js';

test('SF2 serves its standalone iframe and public client without Fighting', async (t) => {
  const app = express();
  feature.routes(app);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const get = (path) => fetch(origin + path);
  const page = await get('/sf2/index.html');
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes('src/index.js'));
  const engine = await get('/sf2/src/index.js');
  assert.equal(engine.status, 200);
  assert.equal(engine.headers.get('cache-control'), 'no-cache');
  assert.equal((await get('/sf2/images/ryu.png')).status, 200);
  const client = await get('/games/sf2/client/index.js');
  assert.equal(client.status, 200);
  assert.equal(client.headers.get('cache-control'), 'no-cache');
  assert.equal((await get('/games/sf2/server/runtime.js')).status, 404);
  assert.equal((await get('/api/mugen/chars')).status, 404);
});
