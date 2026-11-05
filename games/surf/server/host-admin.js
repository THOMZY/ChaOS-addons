import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { db as database } from '../../../../server/db/index.js';
import { withCurrentIdentities } from '../../../../server/api/score-identities.js';
const SURF_BEST_SQL = `
  SELECT r.account_id AS accountId, r.map_id AS mapId, r.time_ms AS timeMs, r.created_at AS recordedAt
  FROM surf_runs AS r
  WHERE r.id = (
    SELECT best.id FROM surf_runs AS best
    WHERE best.account_id = r.account_id AND best.map_id = r.map_id
    ORDER BY best.time_ms ASC, best.id ASC
    LIMIT 1
  )
  ORDER BY r.map_id ASC, r.time_ms ASC
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
function surfScores({ database, isInstalled, mapsFile, limit }) {
  if (!isInstalled('surf') || !hasTable(database, 'surf_runs')) return null;
  const titles = readTitles(mapsFile);
  const rows = database
    .prepare(SURF_BEST_SQL)
    .all(limit)
    .map((row) => {
      const mapId = String(row.mapId);
      return {
        accountId: String(row.accountId),
        // Filled from the account below; a deleted account keeps a neutral row.
        pseudo: null,
        color: null,
        mapId,
        mapTitle: titles.get(mapId) ?? mapId,
        timeMs: Number(row.timeMs) || 0,
        recordedAt: Number(row.recordedAt) || 0,
      };
    });
  return { installed: true, rows: withCurrentIdentities(database, rows) };
}
export default function readScoreboard() {
  return surfScores({
    database,
    isInstalled: () => true,
    mapsFile: fileURLToPath(new URL('./maps.json', import.meta.url)),
    limit: 200,
  });
}
