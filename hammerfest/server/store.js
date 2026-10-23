// @ts-check
// Runs, items and quests of Hammerfest, keyed by the site's accounts.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { db } from '../../../server/db/index.js';

const SCHEMA_PATH = fileURLToPath(new URL('../schema.sql', import.meta.url));

// Each domain applies its own schema: the site migrates `server/db/schema.sql`
// and the chat, an add-on brings its tables with it.
export function ensureSchema() {
  const sql = readFileSync(SCHEMA_PATH, 'utf8').replace(/SET QUOTED_IDENTIFIER ON;?/gi, '');
  db.exec(sql);
  // Bases créées avant la colonne `highlights` : on l'ajoute sur place.
  const columns = /** @type {{ name: string }[]} */ (db.pragma('table_info(hammerfest_runs)'));
  if (!columns.some((column) => column.name === 'highlights')) {
    db.exec('ALTER TABLE hammerfest_runs ADD COLUMN highlights TEXT');
  }
}
ensureSchema();

/** @typedef {{ id: string, account_id: string, game_mode: string, game_options: string, status: string, created_at: number, started_at: number | null, ended_at: number | null }} RunRow */

const insertRun = db.prepare(
  `INSERT INTO hammerfest_runs (id, account_id, game_mode, game_options, settings, status, created_at)
   VALUES (?, ?, ?, ?, ?, 'created', ?)`,
);
const selectRun = db.prepare('SELECT * FROM hammerfest_runs WHERE id = ? AND account_id = ?');
const selectAnyRun = db.prepare('SELECT * FROM hammerfest_runs WHERE id = ?');
const selectOpenRun = db.prepare(
  "SELECT * FROM hammerfest_runs WHERE account_id = ? AND status IN ('created', 'started') ORDER BY created_at DESC LIMIT 1",
);
const markStarted = db.prepare(
  "UPDATE hammerfest_runs SET status = 'started', started_at = ?, run_key = ? WHERE id = ? AND account_id = ?",
);
const finish = db.prepare(
  `UPDATE hammerfest_runs SET status = 'finished', ended_at = ?, is_victory = ?, max_level = ?,
     scores = ?, items = ?, stats = ?, highlights = ? WHERE id = ? AND account_id = ?`,
);
const listRanked = db.prepare(
  `WITH ranked AS (
     SELECT r.game_mode, a.pseudo, r.max_level, r.ended_at,
            CAST(COALESCE(json_extract(r.scores, '$[0]'), 0) AS INTEGER) AS score,
            ROW_NUMBER() OVER (
              PARTITION BY r.game_mode, r.account_id
              ORDER BY CAST(COALESCE(json_extract(r.scores, '$[0]'), 0) AS INTEGER) DESC
            ) AS rn
     FROM hammerfest_runs r JOIN accounts a ON a.id = r.account_id
     WHERE r.status = 'finished' AND r.scores IS NOT NULL
   )
   SELECT game_mode, pseudo, max_level, ended_at, score FROM ranked WHERE rn = 1
   ORDER BY game_mode, score DESC`,
);
const listRuns = db.prepare(
  'SELECT * FROM hammerfest_runs WHERE account_id = ? AND status = \'finished\' ORDER BY ended_at DESC LIMIT ?',
);
const listItems = db.prepare('SELECT item_id, quantity FROM hammerfest_items WHERE account_id = ? ORDER BY item_id');
// L'inventaire Hammerfest est la SOMME des résultats de parties (c'est ainsi que la
// plateforme Eternalfest le calcule : `SUM(run_items.item_count)`). Les compteurs
// s'accumulent — c'est ce qui permet d'atteindre le seuil de 10 exemplaires.
const addItem = db.prepare(
  `INSERT INTO hammerfest_items (account_id, item_id, quantity, updated_at) VALUES (?, ?, ?, ?)
   ON CONFLICT(account_id, item_id) DO UPDATE SET quantity = quantity + excluded.quantity, updated_at = excluded.updated_at`,
);

/**
 * Opens a run for an account. One live run per account: starting a new one
 * abandons the previous unfinished run.
 *
 * @param {{ accountId: string, mode: string, options: readonly string[], settings: unknown }} input
 */
export function createRun({ accountId, mode, options, settings }) {
  const previous = selectOpenRun.get(accountId);
  if (previous) db.prepare("UPDATE hammerfest_runs SET status = 'abandoned' WHERE id = ?").run(previous.id);
  const id = randomUUID();
  const createdAt = Date.now();
  insertRun.run(id, accountId, mode, options.join(','), JSON.stringify(settings ?? {}), createdAt);
  return /** @type {RunRow} */ (selectRun.get(id, accountId));
}

/** @param {string} id @param {string} accountId */
export function runOf(id, accountId) {
  return /** @type {RunRow | undefined} */ (selectRun.get(id, accountId));
}

/**
 * Looks a run up by id only: the loader has no session, so the run UUID is the
 * capability that authenticates it (same model as Eternalfest).
 *
 * @param {string} id
 */
export function runById(id) {
  return /** @type {RunRow | undefined} */ (selectAnyRun.get(id));
}

/**
 * Marks the run as started and hands the game its secret, its families and the
 * player's current inventory (the fridge is read at run start).
 *
 * @param {string} id @param {string} accountId
 */
export function startRun(id, accountId) {
  const key = randomBytes(16).toString('hex');
  const now = Date.now();
  const result = markStarted.run(now, key, id, accountId);
  if (result.changes === 0) return null;
  return { run: runOf(id, accountId), key, startedAt: now, items: itemsOf(accountId) };
}

/**
 * Stores the result sent by the loader. Items and quests are materialised later
 * from the raw result: nothing is lost if the rules change.
 *
 * @param {string} id @param {string} accountId @param {Record<string, unknown>} body
 */
export function finishRun(id, accountId, body, highlights = null) {
  const endedAt = Date.now();
  const scores = Array.isArray(body.scores) ? body.scores : [];
  const result = finish.run(
    endedAt,
    body.is_victory ? 1 : 0,
    Number.isInteger(body.max_level) ? body.max_level : 0,
    JSON.stringify(scores),
    JSON.stringify(body.items ?? {}),
    JSON.stringify(body.stats ?? {}),
    highlights === null ? null : JSON.stringify(highlights),
    id,
    accountId,
  );
  if (result.changes === 0) return null;
  // What the run granted joins the account's inventory (fridge, quests, profile).
  addItems(accountId, /** @type {any} */ (body).items ?? {});
  return runOf(id, accountId);
}

/**
 * Merges the items a run granted into the account's inventory.
 *
 * @param {string} accountId
 * @param {Record<string, number>} gained
 */
export function addItems(accountId, gained) {
  const now = Date.now();
  db.transaction(() => {
    for (const [itemId, quantity] of Object.entries(gained ?? {})) {
      const count = Math.trunc(Number(quantity));
      if (!Number.isFinite(count) || count <= 0) continue;
      addItem.run(accountId, String(itemId), count, now);
    }
  })();
}

/** @param {string} accountId */
export function itemsOf(accountId) {
  /** @type {Record<string, number>} */
  const items = {};
  for (const row of listItems.all(accountId)) items[/** @type {any} */ (row).item_id] = /** @type {any} */ (row).quantity;
  return items;
}

/**
 * Classement : pour chaque mode, le meilleur score de chaque joueur, du plus haut
 * au plus bas. La fenêtre SQL garde la meilleure partie par (mode, compte).
 *
 * @param {number} [limit]
 */
export function leaderboard(limit = 25) {
  const rows = listRanked.all();
  /** @type {Map<string, any[]>} */
  const byMode = new Map();
  for (const row of rows) {
    if (!byMode.has(row.game_mode)) byMode.set(row.game_mode, []);
    const entries = byMode.get(row.game_mode);
    if (entries.length < limit) {
      entries.push({
        rank: entries.length + 1,
        pseudo: row.pseudo,
        score: row.score ?? 0,
        maxLevel: row.max_level ?? 0,
        endedAt: row.ended_at,
      });
    }
  }
  return Object.entries(Object.fromEntries(byMode)).map(([mode, entries]) => ({ mode, entries }));
}

/** @param {string} accountId @param {number} [limit] */
export function recentRuns(accountId, limit = 20) {
  return listRuns.all(accountId, limit);
}
