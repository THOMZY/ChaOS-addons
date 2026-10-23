-- Hammerfest : parties, inventaire et missions, rattachés aux comptes du site.
-- Le compte est `accounts(id)` : supprimer un compte efface ses données de jeu.

CREATE TABLE IF NOT EXISTS hammerfest_runs (
  id           TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  game_mode    TEXT NOT NULL,
  game_options TEXT NOT NULL DEFAULT '',
  settings     TEXT,
  status       TEXT NOT NULL DEFAULT 'created', -- created | started | finished
  run_key      TEXT,
  created_at   INTEGER NOT NULL,
  started_at   INTEGER,
  ended_at     INTEGER,
  is_victory   INTEGER,
  max_level    INTEGER,
  scores       TEXT,
  items        TEXT,
  stats        TEXT,
  -- Ce que la partie a changé : objets ramassés / débloqués et quêtes qui ont
  -- progressé (JSON), calculé à la fin de la partie avant la fusion.
  highlights   TEXT
);
CREATE INDEX IF NOT EXISTS idx_hf_runs_account ON hammerfest_runs(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hf_runs_open ON hammerfest_runs(account_id, status);

CREATE TABLE IF NOT EXISTS hammerfest_items (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  item_id    TEXT NOT NULL,
  quantity   INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, item_id)
);
