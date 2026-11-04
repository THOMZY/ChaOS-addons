import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { db as database } from '../../../server/db/index.js';
import { withCurrentIdentities } from '../../../server/api/score-identities.js';
const HAMMERFEST_BEST_SQL = `
  WITH ranked AS (
    SELECT r.account_id AS accountId,
      r.game_mode AS mode,
      r.max_level AS maxLevel,
      r.ended_at AS endedAt,
      CAST(COALESCE(json_extract(r.scores, '$[0]'), 0) AS INTEGER) AS score,
      ROW_NUMBER() OVER (
        PARTITION BY r.game_mode, r.account_id
        ORDER BY CAST(COALESCE(json_extract(r.scores, '$[0]'), 0) AS INTEGER) DESC
      ) AS rank
    FROM hammerfest_runs AS r
    WHERE r.status = 'finished' AND r.scores IS NOT NULL
  )
  SELECT accountId, mode, score, maxLevel, endedAt FROM ranked WHERE rank = 1
  ORDER BY mode ASC, score DESC
  LIMIT ?`;
function hasTable(database, table) {
  return Boolean(
    database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
  );
}
function readTitles(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    // Surf ships a `[{ id, title }]` list; Hammerfest a build document whose
    // modes live under `modes`. Anything else falls back to the raw object.
    const source = Array.isArray(raw)
      ? raw
      : raw?.modes && typeof raw.modes === 'object'
        ? raw.modes
        : (raw ?? {});
    /** @type {Map<string, string>} */
    const titles = new Map();
    const entries = Array.isArray(source) ? source : Object.entries(source);
    for (const entry of entries) {
      if (Array.isArray(entry)) {
        const [id, value] = entry;
        const label = value?.display_name ?? value?.title;
        if (typeof label === 'string' && label) titles.set(String(id), label);
        continue;
      }
      const label = entry?.title ?? entry?.display_name;
      if (entry?.id && typeof label === 'string' && label) titles.set(String(entry.id), label);
    }
    return titles;
  } catch {
    // Add-on layout may change between versions: the admin still shows raw ids.
    return new Map();
  }
}
function hammerfestScores({ database, isInstalled, buildFile, limit }) {
  if (!isInstalled('hammerfest') || !hasTable(database, 'hammerfest_runs')) return null;
  const titles = readTitles(buildFile);
  const rows = database
    .prepare(HAMMERFEST_BEST_SQL)
    .all(limit)
    .map((row) => {
      const mode = String(row.mode);
      return {
        accountId: String(row.accountId),
        // Filled from the account below; a deleted account keeps a neutral row.
        pseudo: null,
        color: null,
        mode,
        modeTitle: titles.get(mode) ?? mode,
        score: Number(row.score) || 0,
        maxLevel: Number(row.maxLevel) || 0,
        endedAt: Number(row.endedAt) || 0,
      };
    });
  return { installed: true, rows: withCurrentIdentities(database, rows) };
}
export default function readScoreboard() {
  return hammerfestScores({
    database,
    isInstalled: () => true,
    buildFile: fileURLToPath(new URL('./build.json', import.meta.url)),
    limit: 200,
  });
}
