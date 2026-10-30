import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import express from 'express';
import surfRouter from '../server/api.js';
import { createAccount, createSession, SESSION_COOKIE } from '../../../server/auth/service.js';
import { saveUserSettings } from '../../../server/chat/backlog.js';
// Since site schema 4 the add-on creates its own `surf_*` tables.
import { ensureSchema } from '../server/schema.js';
import { db } from '../../../server/db/index.js';

ensureSchema();

test('progression names the requested player, not the viewer', async (t) => {
  const app = express();
  app.use('/api/surf', surfRouter);
  const server = createServer(app);
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const { account: viewer } = await createAccount({
    email: 'surf-viewer@invalid.test',
    pseudo: 'Viewer',
    password: 'isolated-surf-viewer-password',
  });
  const { account: other } = await createAccount({
    email: 'surf-other@invalid.test',
    pseudo: 'Other account',
    password: 'isolated-surf-other-password',
  });
  // The chat pseudo wins over the account pseudo, as everywhere else (U7).
  saveUserSettings(other.id, { pseudo: 'Other in chat' });
  const cookie = `${SESSION_COOKIE}=${createSession(viewer.id)}`;
  const progression = async (query) => {
    const response = await fetch(`${origin}/api/surf?action=progression${query}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(response.status, 200);
    return response.json();
  };

  const theirs = await progression(`&userId=${encodeURIComponent(other.id)}`);
  assert.equal(theirs.userId, other.id);
  assert.equal(theirs.name, 'Other in chat');

  const mine = await progression('');
  assert.equal(mine.userId, viewer.id);
  assert.equal(mine.name, 'Viewer');
});
