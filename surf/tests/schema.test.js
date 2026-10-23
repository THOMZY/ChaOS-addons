import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { migrateDatabase, inspectDatabaseSchema } from '../../../server/db/migrations.js';
import { ensureSchema } from '../server/schema.js';

test('Surf initializes a fresh site database and preserves its ledger and rows on repetition', t => {
  const database = new Database(':memory:');
  t.after(() => database.close());
  database.pragma('foreign_keys = ON');
  migrateDatabase(database);
  assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE name = 'surf_runs'").get(), undefined);
  const ledger = database.prepare('SELECT * FROM _chaos_migrations').all();
  ensureSchema(database);
  database.exec(`INSERT INTO accounts VALUES ('player', 'player@invalid.test', 'Player', 'player', 'hash', 1, 2);
    INSERT INTO surf_runs (id, account_id, map_id, time_ms, created_at) VALUES (27, 'player', 'map', 123, 1);
    INSERT INTO surf_attempts VALUES ('attempt', 'player', 'board', 'map', 'claim', NULL, 27, 1, 999);
    INSERT INTO surf_replays VALUES ('attempt', 27, X'010203FF', 1);`);
  const tables = ['surf_runs', 'surf_attempts', 'surf_replays'];
  const rows = tables.map(table => database.prepare(`SELECT * FROM ${table}`).all());
  ensureSchema(database);
  assert.deepEqual(tables.map(table => database.prepare(`SELECT * FROM ${table}`).all()), rows);
  assert.deepEqual(database.prepare('SELECT * FROM _chaos_migrations').all(), ledger);
  assert.deepEqual(inspectDatabaseSchema(database), { version: 4, pending: [] });
  assert.deepEqual(migrateDatabase(database), { from: 4, to: 4, applied: [] });
  database.exec("DELETE FROM accounts WHERE id = 'player'");
  assert.deepEqual(tables.map(table => database.prepare(`SELECT * FROM ${table}`).all()), [[], [], []]);
  assert.deepEqual(database.pragma('foreign_key_check'), []);
});

test('Surf schema initialization rolls back partial DDL on failure', t => {
  const database = new Database(':memory:');
  t.after(() => database.close());
  migrateDatabase(database);
  database.exec('CREATE VIEW surf_attempts AS SELECT 1 AS id');
  assert.throws(() => ensureSchema(database));
  assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE name = 'surf_runs'").get(), undefined);
  assert.deepEqual(inspectDatabaseSchema(database), { version: 4, pending: [] });
});
