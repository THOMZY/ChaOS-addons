-- ChaOS Surf: recorded times per account.
--
-- One row = one completed and valid run (the client submits it with
-- phase "finished" and no invalidReason). The time comes from the client timer,
-- converted to milliseconds. The original server re-verified replays command by
-- command; we do not have that engine, so reported times are trusted. Validation
-- here checks SHAPE (bounds and increasing splits), not integrity.
--
-- Keep `map_version` and `physics` exactly as reported by the client. A map or
-- physics configuration change makes earlier times incomparable, and we need
-- to detect that later instead of mixing different versions.
CREATE TABLE IF NOT EXISTS surf_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id   TEXT    NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  map_id       TEXT    NOT NULL,
  map_version  TEXT,
  time_ms      INTEGER NOT NULL,
  splits_json  TEXT,
  room_id      TEXT,
  physics_json TEXT,
  created_at   INTEGER NOT NULL
);

-- Map leaderboard: best time first.
CREATE INDEX IF NOT EXISTS idx_surf_runs_map    ON surf_runs(map_id, time_ms);
-- A player's personal best and history on a map.
CREATE INDEX IF NOT EXISTS idx_surf_runs_player ON surf_runs(account_id, map_id, time_ms);

-- Ranked attempts.
--
-- The client opens an attempt before play (`attempt`) and tracks it through a
-- submission. Preserve its terminology so it shows an online status instead of
-- falling back to local mode. The time is not sent through this channel (the
-- client sends only an ID): the site has already recorded it by reading the
-- game timer (see website/core/js/games/embedded-clients.js). The submission is
-- matched to the corresponding run in `surf_runs`, and that recorded time is returned.
CREATE TABLE IF NOT EXISTS surf_attempts (
  id          TEXT    PRIMARY KEY,
  account_id  TEXT    NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  board_id    TEXT    NOT NULL,
  map_id      TEXT    NOT NULL,
  claim_token TEXT    NOT NULL,
  room_id     TEXT,
  run_id      INTEGER REFERENCES surf_runs(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_surf_attempts_account ON surf_attempts(account_id, created_at);

-- Replays are optional; the game already produces them in compressed form.
-- They are not used to verify times, only as keepsakes that friends can play
-- from a map's leaderboard.
CREATE TABLE IF NOT EXISTS surf_replays (
  attempt_id TEXT    PRIMARY KEY REFERENCES surf_attempts(id) ON DELETE CASCADE,
  run_id     INTEGER NOT NULL UNIQUE REFERENCES surf_runs(id) ON DELETE CASCADE,
  data        BLOB    NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_surf_replays_run ON surf_replays(run_id);
