// Surf owns its tables from site schema version 4 onward. Keep initialization
// explicit so importing this module never modifies a database.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { db } from '../../../server/db/index.js';

const SCHEMA_PATH = fileURLToPath(new URL('../schema.sql', import.meta.url));

/** Create missing Surf tables without changing existing rows or the site ledger. */
export function ensureSchema(database = db) {
  database.transaction(() => {
    database.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  })();
}
