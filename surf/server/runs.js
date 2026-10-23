// ChaOS Surf: record run times per ChaOS account.
//
// WHY THIS MODULE EXISTS
// The recovered Surf client (games/surf/data) built its "verified times"
// feature on Supabase (Google/X accounts, signed replay uploads, and server
// verification). None of that exists here, so its online layer is disabled and
// it falls back to a personal record stored in the browser, making it seem as
// though "nothing is saved."
//
// The client cannot be modified, but it deliberately exposes its timer through
// `window.__SURF__.snapshot()`, which returns
// `{ phase: 'ready'|'running'|'finished', startTick, endTick, splits, elapsed,
//    invalidReason, ... }`. `elapsed` and `splits` are in SECONDS
// (`(endTick - startTick) * dt`, `dt = 1/66`). The site polls it — see
// `website/core/js/games/embedded-clients.js` — and submits each completed run here.
//
// WHAT WE VALIDATE AND WHAT WE DO NOT
// Integrity cannot be verified: the original server replayed each command, and
// we do not have that verification engine. We validate the SHAPE (time bounds,
// strictly increasing splits, and a known map) and trust the reported time.
// This is an intentional choice for a private site, not a public leaderboard.
import { readFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../../../server/db/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// The add-on initializes its schema before exposing routes.

/** Same limit as the client: it rejects `timeUs >= 36e8`, which is one hour. */
export const MAX_TIME_MS = 3_600_000;
/** Same limit as the client: at most 64 checkpoints. */
export const MAX_SPLITS = 64;

/**
 * Validates the shape of a run submitted by the site.
 * @returns {{ok: true, value: object} | {ok: false, error: string}}
 */
export function validateRun({ mapId, timeMs, splitsMs, mapVersion, physics }) {
  if (typeof mapId !== 'string' || !/^[a-z0-9_]{1,64}$/.test(mapId)) {
    return { ok: false, error: 'invalid_map' };
  }
  if (!Number.isSafeInteger(timeMs) || timeMs <= 0 || timeMs >= MAX_TIME_MS) {
    return { ok: false, error: 'invalid_time' };
  }
  const splits = Array.isArray(splitsMs) ? splitsMs : [];
  if (splits.length > MAX_SPLITS) return { ok: false, error: 'too_many_splits' };
  let precedent = -1;
  for (const s of splits) {
    if (!Number.isSafeInteger(s) || s <= precedent || s < 0 || s > timeMs) {
      return { ok: false, error: 'invalid_splits' };
    }
    precedent = s;
  }
  return {
    ok: true,
    value: {
      mapId,
      timeMs,
      splits,
      mapVersion: typeof mapVersion === 'string' ? mapVersion.slice(0, 64) : null,
      physics: physics && typeof physics === 'object' ? physics : null,
    },
  };
}

/**
 * Records a run and returns the data needed to notify the player.
 * @returns {{id: number, improved: boolean, bestMs: number, previousBestMs: number|null, rank: number, total: number, runs: number}}
 */
export function saveRun({ accountId, run, roomId = null, at = Date.now() }) {
  const { mapId, timeMs, splits, mapVersion, physics } = run;

  const avant = db.prepare(
    'SELECT MIN(time_ms) AS best, COUNT(*) AS n FROM surf_runs WHERE account_id = ? AND map_id = ?',
  ).get(accountId, mapId);
  const previousBestMs = avant?.best ?? null;

  const info = db.prepare(`
    INSERT INTO surf_runs (account_id, map_id, map_version, time_ms, splits_json, room_id, physics_json, created_at)
    VALUES (@account_id, @map_id, @map_version, @time_ms, @splits_json, @room_id, @physics_json, @created_at)
  `).run({
    account_id: accountId,
    map_id: mapId,
    map_version: mapVersion,
    time_ms: timeMs,
    splits_json: splits.length ? JSON.stringify(splits) : null,
    room_id: roomId,
    physics_json: physics ? JSON.stringify(physics) : null,
    created_at: at,
  });

  const bestMs = previousBestMs === null ? timeMs : Math.min(previousBestMs, timeMs);
  const rang = db.prepare(`
    SELECT COUNT(*) + 1 AS rank FROM (
      SELECT account_id, MIN(time_ms) AS best FROM surf_runs WHERE map_id = ? GROUP BY account_id
    ) WHERE best < ?
  `).get(mapId, bestMs);

  return {
    id: Number(info.lastInsertRowid),
    improved: previousBestMs === null || timeMs < previousBestMs,
    bestMs,
    previousBestMs,
    rank: rang?.rank ?? 1,
    total: db.prepare('SELECT COUNT(DISTINCT account_id) AS n FROM surf_runs WHERE map_id = ?').get(mapId)?.n ?? 0,
    runs: (avant?.n ?? 0) + 1,
  };
}

/**
 * Map leaderboard: each player's best time, ChaOS nickname, and color
 * included (using the same settings as the site's chat).
 */
export function mapLeaderboard(mapId, limit = 50) {
  const entries = db.prepare(`
    SELECT r.account_id                AS accountId,
           MIN(r.time_ms)              AS timeMs,
           MIN(r.created_at)           AS at,
           COUNT(*)                    AS runs,
           (SELECT r2.id FROM surf_runs AS r2
            WHERE r2.account_id = r.account_id AND r2.map_id = r.map_id
            ORDER BY r2.time_ms ASC, r2.created_at ASC, r2.id ASC LIMIT 1) AS bestRunId,
           COALESCE(s.pseudo, a.pseudo) AS pseudo,
           s.color                     AS color
    FROM surf_runs AS r
    LEFT JOIN chat_user_settings AS s ON s.account_id = r.account_id
    LEFT JOIN accounts           AS a ON a.id         = r.account_id
    WHERE r.map_id = ?
    GROUP BY r.account_id
    ORDER BY timeMs ASC, at ASC
    LIMIT ?
  `).all(mapId, limit);
  return {
    total: db.prepare('SELECT COUNT(DISTINCT account_id) AS n FROM surf_runs WHERE map_id = ?').get(mapId)?.n ?? 0,
    entries: entries.map((e, i) => ({
      rank: i + 1,
      accountId: e.accountId,
      pseudo: e.pseudo ?? 'Player',
      color: e.color ?? null,
      timeMs: e.timeMs,
      runs: e.runs,
      at: e.at,
      // The client uses the attempt ID (UUID) as the replay's public ID. A time
      // without a replay remains visible, but has no "Watch" button.
      runId: db.prepare('SELECT attempt_id AS id FROM surf_replays WHERE run_id = ?')
        .get(e.bestRunId)?.id ?? null,
    })),
  };
}

/** A player's personal records, one row per map. */
export function playerBests(accountId) {
  return db.prepare(`
    SELECT map_id AS mapId, MIN(time_ms) AS timeMs, COUNT(*) AS runs, MIN(created_at) AS at
    FROM surf_runs WHERE account_id = ? GROUP BY map_id ORDER BY timeMs ASC
  `).all(accountId);
}

/** A player's most recent runs. */
export function playerRuns(accountId, limit = 20) {
  return db.prepare(`
    SELECT id, map_id AS mapId, time_ms AS timeMs, room_id AS roomId, created_at AS at
    FROM surf_runs WHERE account_id = ? ORDER BY created_at DESC LIMIT ?
  `).all(accountId, limit);
}

/** A player's best time on a map, or null if there is none. */
export function bestOf(accountId, mapId) {
  return db.prepare('SELECT MIN(time_ms) AS timeMs FROM surf_runs WHERE account_id = ? AND map_id = ?')
    .get(accountId, mapId)?.timeMs ?? null;
}

// ── Board catalog ────────────────────────────────────────────────────────────
//
// Copied as-is from the client bundle: matching IDs and fingerprints ensure
// that all client-side comparisons agree by construction. Served through
// `config.maps` and used to open an attempt from a `boardId`.
export const BOARDS = JSON.parse(readFileSync(resolve(__dirname, 'boards.json'), 'utf8'));

export function findBoard(cle) {
  return BOARDS.find((b) => b.boardId === cle || b.id === cle) ?? null;
}

/** Human-readable map title derived from its slug ("forbidden-ways" → "Forbidden Ways"). */
function titreDe(board) {
  return String(board.slug || board.id)
    .split(/[-_]/)
    .filter(Boolean)
    .map((mot) => mot.charAt(0).toUpperCase() + mot.slice(1))
    .join(' ');
}

// ── Ranked attempts ──────────────────────────────────────────────────────────
//
// The client opens an attempt before play and tracks it afterward. The time is
// NOT sent through this channel (only an ID is sent): the site has already
// recorded it by reading the game timer. A submission is therefore matched to
// its corresponding run in `surf_runs`.
const ATTEMPT_TTL_MS = 24 * 60 * 60 * 1000;

export function openAttempt({ accountId, board, roomId = null, at = Date.now() }) {
  const id = randomUUID();
  const claimToken = randomBytes(24).toString('base64url');
  const expiresAt = at + ATTEMPT_TTL_MS;
  db.prepare(`
    INSERT INTO surf_attempts (id, account_id, board_id, map_id, claim_token, room_id, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, accountId, board.boardId, board.id, claimToken, roomId, at, expiresAt);
  // This is the ticket as stored and revalidated by the client (`Fr`).
  return {
    id,
    boardId: board.boardId,
    claimToken,
    issuedAt: new Date(at).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

export function attemptById(id, accountId) {
  if (typeof id !== 'string') return null;
  return db.prepare('SELECT * FROM surf_attempts WHERE id = ? AND account_id = ?').get(id, accountId) ?? null;
}

/**
 * Run to match with this attempt: a run by the same player on the same map,
 * recorded after the attempt opened and not yet claimed.
 */
export function matchRun(attempt) {
  return db.prepare(`
    SELECT * FROM surf_runs
    WHERE account_id = ? AND map_id = ? AND created_at >= ? AND id NOT IN (
      SELECT run_id FROM surf_attempts WHERE run_id IS NOT NULL
    )
    ORDER BY created_at ASC LIMIT 1
  `).get(attempt.account_id, attempt.map_id, attempt.created_at) ?? null;
}

export function claimRun(attemptId, runId) {
  db.prepare('UPDATE surf_attempts SET run_id = ? WHERE id = ?').run(runId, attemptId);
}

export function saveReplay(attempt, data, at = Date.now()) {
  if (!attempt?.run_id || !Buffer.isBuffer(data) || data.length === 0 || data.length > 10 * 1024 * 1024) {
    return false;
  }
  db.prepare(`
    INSERT INTO surf_replays (attempt_id, run_id, data, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(attempt_id) DO UPDATE SET data = excluded.data, created_at = excluded.created_at
  `).run(attempt.id, attempt.run_id, data, at);
  return true;
}

export function replayForAttempt(attemptId) {
  return db.prepare(`
    SELECT rp.data, r.map_id AS mapId, r.time_ms AS timeMs
    FROM surf_replays AS rp JOIN surf_runs AS r ON r.id = rp.run_id
    WHERE rp.attempt_id = ?
  `).get(attemptId) ?? null;
}

/** `submission` response: the client expects a status followed by a result. */
export function submissionFor(attempt, account) {
  if (!attempt) return { status: 'rejected', reason: 'This run is no longer attached to your account.' };
  if (attempt.run_id) {
    const run = db.prepare('SELECT * FROM surf_runs WHERE id = ?').get(attempt.run_id);
    return run ? resultFor(run, attempt, account) : { status: 'rejected', reason: 'That run is gone.' };
  }
  const run = matchRun(attempt);
  // The site's watcher submits the time one second after the run ends. Until it
  // arrives, report "pending," which the client can display and poll again.
  if (!run) return { status: 'verifying' };
  claimRun(attempt.id, run.id);
  if (!replayForAttempt(attempt.id)) return { status: 'issued' };
  return resultFor(run, attempt, account);
}

function resultFor(run, attempt, account) {
  const board = BOARDS.find((b) => b.boardId === attempt.board_id) ?? { id: run.map_id, slug: run.map_id };
  const avant = db.prepare(`
    SELECT MIN(time_ms) AS best FROM surf_runs
    WHERE account_id = ? AND map_id = ? AND id < ?
  `).get(run.account_id, run.map_id, run.id)?.best ?? null;
  const classement = mapLeaderboard(run.map_id, 1000);
  const ligne = classement.entries.find((e) => e.accountId === run.account_id);
  const resultat = {
    status: 'verified',
    id: attempt.id,
    runId: attempt.id,
    mapId: run.map_id,
    mapTitle: titreDe(board),
    timeUs: run.time_ms * 1000,
    splitsUs: run.splits_json ? JSON.parse(run.splits_json).map((s) => s * 1000) : [],
    record: ligne?.rank === 1,
    personalBest: avant === null || run.time_ms < avant,
    previousBestUs: avant === null ? null : avant * 1000,
    leaderboardRank: ligne?.rank ?? null,
    leaderboardTotal: classement.total,
    name: account?.pseudo ?? ligne?.pseudo ?? 'Player',
    userId: run.account_id,
    at: run.created_at,
  };
  // Depending on the code path, the client reads the result from the submission
  // itself or its `run` field, so provide both with identical values.
  return { ...resultat, run: resultat };
}
