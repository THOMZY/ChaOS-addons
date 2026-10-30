import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import express from 'express';
import surfRouter from '../server/api.js';
// The add-on creates its own `surf_*` tables since site schema 4.
import { ensureSchema } from '../server/schema.js';
import { db } from '../../../server/db/index.js';

ensureSchema();

// Staged boards are part of newer client generations: for each staged map the
// client reads stage records, a stage leaderboard and the viewer's stage bests.
// ChaOS records whole-run times only, so these actions must answer with valid
// EMPTY lists. They used to fall through to the router default (401), which the
// client renders as "Stage records are unavailable right now." on every staged
// map.
test('stage actions answer valid empty shapes instead of 401', async (t) => {
  const app = express();
  app.use('/api/surf', surfRouter);
  const server = createServer(app);
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const boardId = 'a'.repeat(64);

  const read = async (action) => {
    const response = await fetch(`${origin}/api/surf?action=${action}&boardId=${boardId}&stage=1`);
    assert.equal(response.status, 200, `${action} must be served, not refused`);
    return response.json();
  };

  assert.deepEqual((await read('stage-records')).records, []);
  assert.deepEqual((await read('stage-leaderboard-public')).entries, []);
  assert.deepEqual((await read('stage-bests')).bests, []);
});
