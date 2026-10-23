// Tests for recording Surf run times.
//
// The database is a temporary COPY: DB_PATH is set BEFORE the first import of
// the db module, and the test runner executes each file in its own process.
// Real data is never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'surf-runs-')), 'hub.db');

const { db } = await import('../../../server/db/index.js');
// Since site schema 4 the add-on creates its own `surf_*` tables.
const { ensureSchema } = await import('../server/schema.js');
ensureSchema();
// The leaderboard joins chat_user_settings (site nickname and color), so the
// chat table must exist without importing its module, which has side effects.
const chatSchema = readFileSync(new URL('../../../server/chat/schema.sql', import.meta.url), 'utf8')
  .replace(/^\s*SET\s+QUOTED_IDENTIFIER\s+ON;\s*/i, '');
db.exec(chatSchema);

const { validateRun, saveRun, mapLeaderboard, playerBests, bestOf, MAX_TIME_MS,
  findBoard, openAttempt, attemptById, submissionFor, saveReplay, replayForAttempt } =
  await import('../server/runs.js');

const at = Date.now();
function compte(id, pseudo) {
  db.prepare(`INSERT INTO accounts (id, email, pseudo, pseudo_key, password_hash, created_at, updated_at)
              VALUES (?, ?, ?, ?, 'x', ?, ?)`).run(id, `${id}@test.local`, pseudo, id.toLowerCase(), at, at);
}
compte('acc-thomzy', 'Thomzy');
compte('acc-zgoung', 'Zgoung');

db.prepare(`INSERT INTO chat_user_settings (account_id, pseudo, color, updated_at) VALUES (?,?,?,?)`)
  .run('acc-thomzy', 'Thomzy', 'hsl(52, 75%, 60%)', at);

const run = (mapId, timeMs, splitsMs = []) => ({ mapId, timeMs, splitsMs });

test('a run is shape-checked', () => {
  assert.equal(validateRun(run('surf_boreas', 12_345)).ok, true);
  assert.equal(validateRun(run('../../etc/passwd', 12_345)).ok, false);
  assert.equal(validateRun(run('surf_boreas', 0)).ok, false);
  assert.equal(validateRun(run('surf_boreas', -5)).ok, false);
  assert.equal(validateRun(run('surf_boreas', MAX_TIME_MS)).ok, false, 'one hour or more is refused');
  assert.equal(validateRun(run('surf_boreas', 2.5)).ok, false, 'a non-integer time is refused');
  assert.equal(validateRun(run('surf_boreas', 10_000, [3_000, 2_000])).ok, false, 'non-increasing splits');
  assert.equal(validateRun(run('surf_boreas', 10_000, [3_000, 11_000])).ok, false, 'split after the finish');
  assert.equal(validateRun(run('surf_boreas', 10_000, Array(65).fill(1))).ok, false, 'too many splits');
  assert.equal(validateRun(run('surf_boreas', 10_000, [2_000, 5_000])).ok, true);
});

test('the first run starts the player count', () => {
  const r = saveRun({ accountId: 'acc-thomzy', run: validateRun(run('surf_boreas', 42_000, [10_000])).value });
  assert.equal(r.improved, true);
  assert.equal(r.previousBestMs, null);
  assert.equal(r.bestMs, 42_000);
  assert.equal(r.runs, 1);
  assert.equal(r.rank, 1);
  assert.equal(r.total, 1);
});

test('a better time improves, a worse one does not — and nothing is lost', () => {
  const meilleur = saveRun({ accountId: 'acc-thomzy', run: validateRun(run('surf_boreas', 38_000)).value });
  assert.equal(meilleur.improved, true);
  assert.equal(meilleur.previousBestMs, 42_000);
  assert.equal(meilleur.bestMs, 38_000);

  const pire = saveRun({ accountId: 'acc-thomzy', run: validateRun(run('surf_boreas', 55_000)).value });
  assert.equal(pire.improved, false);
  assert.equal(pire.bestMs, 38_000, 'the record remains the best time');
  assert.equal(pire.runs, 3, 'the run is kept anyway');

  assert.equal(bestOf('acc-thomzy', 'surf_boreas'), 38_000);
  assert.equal(bestOf('acc-thomzy', 'surf_lux'), null);
});

test('the leaderboard keeps each player best time, nickname and color', () => {
  saveRun({ accountId: 'acc-zgoung', run: validateRun(run('surf_boreas', 41_000)).value });
  saveRun({ accountId: 'acc-zgoung', run: validateRun(run('surf_boreas', 33_000)).value });
  saveRun({ accountId: 'acc-zgoung', run: validateRun(run('surf_boreas', 60_000)).value });

  const c = mapLeaderboard('surf_boreas');
  assert.equal(c.entries.length, 2, 'one row per player, regardless of run count');
  assert.deepEqual(c.entries.map((e) => [e.rank, e.pseudo, e.timeMs]), [
    [1, 'Zgoung', 33_000],
    [2, 'Thomzy', 38_000],
  ]);
  assert.equal(c.entries[0].runs, 3);
  assert.equal(c.total, 2);
  // Zgoung never opened settings: fall back to the account nickname and keep
  // the color null rather than inventing a value.
  assert.equal(c.entries[0].color, null);
  // Thomzy has chat settings, so that color is returned.
  assert.equal(c.entries[1].color, 'hsl(52, 75%, 60%)');
});

test('maps do not mix', () => {
  saveRun({ accountId: 'acc-zgoung', run: validateRun(run('surf_lux', 20_000)).value });
  const boreas = mapLeaderboard('surf_boreas');
  assert.equal(boreas.entries.every((e) => e.timeMs > 30_000), true);
  assert.deepEqual(playerBests('acc-zgoung').map((b) => b.mapId).sort(), ['surf_boreas', 'surf_lux']);
});

test('a replay is attached to the time, then readable by its public id', () => {
  const board = findBoard('surf_boreas');
  const openedAt = at + 10_000;
  const ticket = openAttempt({ accountId: 'acc-thomzy', board, at: openedAt });
  saveRun({
    accountId: 'acc-thomzy',
    run: validateRun(run('surf_boreas', 25_000)).value,
    at: openedAt + 1_000,
  });

  const pending = submissionFor(attemptById(ticket.id, 'acc-thomzy'), { pseudo: 'Thomzy' });
  assert.equal(pending.status, 'issued', 'the client must upload its replay before validation');

  const claimed = attemptById(ticket.id, 'acc-thomzy');
  assert.equal(saveReplay(claimed, Buffer.from('test gzip replay')), true);
  const verified = submissionFor(attemptById(ticket.id, 'acc-thomzy'), { pseudo: 'Thomzy' });
  assert.equal(verified.status, 'verified');
  assert.equal(verified.runId, ticket.id);
  assert.deepEqual(replayForAttempt(ticket.id).data, Buffer.from('test gzip replay'));
  assert.equal(mapLeaderboard('surf_boreas').entries[0].runId, ticket.id,
    'the board points to the best-time replay');
});
