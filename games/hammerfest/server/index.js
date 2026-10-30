// @ts-check
// Hammerfest add-on: the game build, the loader API it expects, and the
// account-backed endpoints the site reads (profile, runs, inventory).
//
// The loader derives its API base from its own origin, so serving it here is
// enough for it to talk to ChaOS website — nothing to configure on its side.
import express from 'express';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineFeature } from '../../../server/core/features.js';
import { accountFromHeaders } from '../../../server/auth/service.js';
import { sendBlob } from './blob-response.js';
import { BLOBS, DEV_GAME_ID, DEV_PATCHER_BLOB, GAME_ID, GAME_ROOT, LOCALES, MAIN_LOCALE, blobPath, gameDocument, isDevBuildInstalled, modeKeys, modeList, modeOptions } from './build.js';
import { createRun, finishRun, itemsOf, leaderboard, recentRuns, runById, runOf, startRun } from './store.js';
import { buildProfile, computeHighlights, describeRun, unlockedFamilies } from './profile.js';
import { labelsFor } from './locale-names.js';
import { isAdminAccount } from '../../../server/auth/admin-policy.js';
import { loadUserSettings } from '../../../server/chat/backlog.js';

const CLIENT_ROOT = fileURLToPath(new URL('../client/', import.meta.url));
const require = createRequire(import.meta.url);

/**
 * Directory of the Ruffle reader, installed from npm instead of being shipped
 * with the add-on (30 MB of WASM nobody edits). `null` when the dependency is
 * missing: the page then shows its "Flash unavailable" notice.
 * @returns {string | null}
 */
function ruffleDirectory() {
  for (const specifier of ['@ruffle-rs/ruffle', '@ruffle-rs/ruffle/package.json']) {
    try {
      return dirname(require.resolve(specifier));
    } catch {
      // Try the next specifier: `exports` maps may hide one of them.
    }
  }
  return null;
}
const OWNER = Object.freeze({ id: 'b7f3c1d2-4e5a-4b6c-9d8e-1a2b3c4d5e6b', display_name: 'THOMZY' });

const DEFAULT_SETTINGS = Object.freeze({ detail: true, music: false, shake: true, sound: true, volume: 0.6 });

/** Mode id -> label, read from the build so the page never invents a name. */
const MODE_LABELS = new Map(modeList().map((mode) => [mode.id, mode.display_name]));
/** @param {string} id */
const modeLabel = (id) => MODE_LABELS.get(id) ?? id;

/** @param {import('express').Request} req */
function accountOf(req) {
  return accountFromHeaders(req.headers);
}

/** @param {import('express').Request} _req @param {import('express').Response} res @param {import('express').NextFunction} next */
function requireAccount(_req, res, next) {
  const account = accountOf(_req);
  if (!account) return res.status(401).json({ error: 'authentication_required' });
  next();
}

/** @param {any} account */
function userRef(account) {
  return { type: 'User', id: account.id, display_name: account.pseudo };
}

/**
 * Locale the game plays in: the account's site language (`chat_user_settings`),
 * French by default. A locale the build does not ship falls back to its main one.
 * @param {string | null | undefined} accountId
 */
function gameLocale(accountId) {
  if (!accountId) return MAIN_LOCALE;
  const language = loadUserSettings(accountId)?.language ?? null;
  const wanted = language === 'en' ? 'en-US' : MAIN_LOCALE;
  return LOCALES.includes(wanted) ? wanted : MAIN_LOCALE;
}

/** @param {any} run */
function runDocument(run, account) {
  let settings;
  try {
    settings = JSON.parse(run.settings ?? '{}');
  } catch {
    settings = {};
  }
  return {
    id: run.id,
    created_at: new Date(run.created_at).toISOString(),
    started_at: run.started_at ? new Date(run.started_at).toISOString() : null,
    game: { type: 'Game', id: GAME_ID, key: 'hammerfest' },
    user: userRef(account),
    game_mode: run.game_mode,
    game_options: run.game_options ? String(run.game_options).split(',').filter(Boolean) : [],
    settings: { ...DEFAULT_SETTINGS, ...settings },
    locale: typeof settings?.locale === 'string' ? settings.locale : MAIN_LOCALE,
  };
}

export default defineFeature({
  id: 'hammerfest',
  phase: 'producers',
  /** @param {any} app */
  routes(app) {
    // --- files the loader and the host page download -----------------------
    // The Flash reader comes from npm, not from the repository.
    const ruffle = ruffleDirectory();
    if (ruffle) {
      app.use(
        '/hammerfest/data/ruffle',
        express.static(ruffle, {
          index: false,
          setHeaders(response) {
            response.setHeader('Cache-Control', 'no-cache');
          },
        }),
      );
    }
    // The game build ships with the add-on (`game/`): no install step, the
    // deployment brings the files.
    app.use(
      '/hammerfest/data',
      express.static(GAME_ROOT, {
        index: false,
        setHeaders(response, path) {
          if (/\.swf$/i.test(path)) response.setHeader('Content-Type', 'application/x-shockwave-flash');
          if (/\.xml$/i.test(path)) response.setHeader('Content-Type', 'application/xml; charset=utf-8');
          response.setHeader('Cache-Control', 'no-cache');
        },
      }),
    );
    app.use(
      '/games/hammerfest/client',
      express.static(CLIENT_ROOT, {
        index: 'play.html',
        setHeaders(response) {
          response.setHeader('Cache-Control', 'no-cache');
        },
      }),
    );

    // --- loader API -------------------------------------------------------
    app.get('/api/v1/games/:id', (req, res) => {
      if (req.params.id === DEV_GAME_ID) {
        // The debug build is served only to an administrator session: knowing the
        // game id is not enough. 404 (not 403) keeps the route existence hidden.
        if (!isDevBuildInstalled() || !isAdminAccount(accountOf(req)?.id ?? '')) {
          return res.status(404).json({ error: 'game_not_found' });
        }
        return res.json(gameDocument(OWNER, { debug: true }));
      }
      if (req.params.id !== GAME_ID) return res.status(404).json({ error: 'game_not_found' });
      res.json(gameDocument(OWNER));
    });

    app.get('/api/v1/blobs/:id/raw', (req, res) => {
      const entry = /** @type {Record<string, {file: string, mediaType: string}>} */ (BLOBS)[req.params.id];
      if (!entry) return res.status(404).json({ error: 'blob_not_found' });
      // Debug build binaries are admin-only: otherwise a player knowing the id
      // could download the cheat patcher.
      if (req.params.id === DEV_PATCHER_BLOB && !isAdminAccount(accountOf(req)?.id ?? '')) {
        return res.status(404).json({ error: 'blob_not_found' });
      }
      sendBlob(blobPath(req.params.id), entry.mediaType, res);
    });

    app.post('/api/v1/runs', requireAccount, express.json(), (req, res) => {
      const account = accountOf(req);
      if (!account) return res.status(401).json({ error: 'authentication_required' });
      const mode = typeof req.body?.mode === 'string' ? req.body.mode : 'solo';
      if (!modeKeys().includes(mode)) return res.status(400).json({ error: 'invalid_mode' });
      const options = Array.isArray(req.body?.options) ? req.body.options.map(String) : [];
      const settings = { ...DEFAULT_SETTINGS, ...(req.body?.settings ?? {}) };
      if (typeof req.body?.locale === 'string') settings.locale = req.body.locale;
      const run = createRun({ accountId: account.id, mode, options, settings });
      res.status(201).json(runDocument(run, account));
    });

    // The loader has no session (Flash HTTP has no cookie jar here), so the run
    // UUID is the capability that authenticates these two calls — the same model
    // Eternalfest uses. Everything else about the run stays server-side.
    app.post('/api/v1/runs/:id/start', (req, res) => {
      const run = runById(req.params.id);
      if (!run) return res.status(404).json({ error: 'run_not_found' });
      if (run.status === 'finished') return res.status(409).json({ error: 'run_finished' });
      const started = run.status === 'started' ? null : startRun(run.id, run.account_id);
      // Reloading the window must not break the run: hand the same secret back.
      const key = started ? started.key : run.run_key;
      const items = itemsOf(run.account_id);
      if (!key) return res.status(409).json({ error: 'run_not_started' });
      res.json({
        run: { type: 'Run', id: run.id },
        started_at: new Date(started ? started.startedAt : run.started_at ?? Date.now()).toISOString(),
        // Families unlocked by the account (base + quest rewards): without them the game
        // hides quest descriptions behind "???".
        families: unlockedFamilies(itemsOf(run.account_id)),
        items,
        key,
      });
    });

    // The loader sends the result as an urlencoded form whose values are JSON
    // strings (`items=%7B...%7D`), with POST. JSON bodies are accepted too, for
    // our own tooling.
    const readResult = (/** @type {any} */ req) => {
      const source = req.body ?? {};
      /** @param {unknown} value */
      const parse = (value) => {
        if (typeof value !== 'string') return value;
        try {
          return JSON.parse(value);
        } catch {
          return value;
        }
      };
      return {
        is_victory: parse(source.is_victory) === true,
        max_level: Number(parse(source.max_level)) || 0,
        scores: parse(source.scores) ?? [],
        items: parse(source.items) ?? {},
        stats: parse(source.stats) ?? {},
      };
    };
    const resultParsers = [express.json({ limit: '2mb' }), express.urlencoded({ extended: false, limit: '2mb' })];
    const setResult = (/** @type {any} */ req, /** @type {any} */ res) => {
      const run = runById(req.params.id);
      if (!run) return res.status(404).json({ error: 'run_not_found' });
      if (run.status === 'finished') return res.status(409).json({ error: 'result_already_set' });
      // What the run changed must be computed before merging into the inventory.
      const result = readResult(req);
      const highlights = computeHighlights(itemsOf(run.account_id), result.items, labelsFor(gameLocale(run.account_id)));
      const finished = finishRun(run.id, run.account_id, result, highlights);
      if (!finished) return res.status(409).json({ error: 'run_not_started' });
      res.status(204).end();
    };
    app.post('/api/v1/runs/:id/result', resultParsers, setResult);
    app.put('/api/v1/runs/:id/result', resultParsers, setResult);

    // --- what the site shows ----------------------------------------------
    app.get('/api/v1/hammerfest/profile', requireAccount, (req, res) => {
      const account = accountOf(req);
      if (!account) return res.status(401).json({ error: 'authentication_required' });
      res.json(buildProfile(account, itemsOf(account.id), recentRuns(account.id, 12), modeLabel, labelsFor(gameLocale(account.id))));
    });

    app.get('/api/v1/hammerfest/runs', requireAccount, (req, res) => {
      const account = accountOf(req);
      if (!account) return res.status(401).json({ error: 'authentication_required' });
      res.json({ runs: recentRuns(account.id, 50) });
    });

    app.get('/api/v1/hammerfest/runs/:id', requireAccount, (req, res) => {
      const account = accountOf(req);
      if (!account) return res.status(401).json({ error: 'authentication_required' });
      const run = runOf(req.params.id, account.id);
      if (!run) return res.status(404).json({ error: 'run_not_found' });
      res.json({ run: describeRun(run, modeLabel) });
    });

    /** Public leaderboard: each player's best score, mode by mode. */
    app.get('/api/v1/hammerfest/leaderboard', (_req, res) => {
      res.json({
        modes: leaderboard().map((entry) => ({ ...entry, modeLabel: modeLabel(entry.mode) })),
      });
    });

    /** What the host page needs to build a run (game id, modes, options, defaults). */
    app.get('/api/v1/hammerfest/config', (req, res) => {
      // The debug build (in-game level warp and item spawn) is offered to the
      // site's administrator accounts only (`ADMIN_ACCOUNT_IDS`).
      const isAdmin = isAdminAccount(accountOf(req)?.id ?? '');
      const hasDevBuild = isDevBuildInstalled();
      const isDebug = req.query.dev === '1' && hasDevBuild && isAdmin;
      const locale = gameLocale(accountOf(req)?.id);
      res.json({
        gameId: isDebug ? DEV_GAME_ID : GAME_ID,
        debug: isDebug,
        // The page shows a "debug mode" link for those accounts only.
        canDebug: hasDevBuild && isAdmin,
        locale,
        settings: DEFAULT_SETTINGS,
        modes: modeList(),
        options: modeOptions(),
      });
    });

    /**
     * The loader navigates here when a run ends (`/runs/<id>`, absolute to the
     * origin). It runs inside the game's iframe, so it stays a small standalone
     * page instead of the SPA.
     */
    // The loader navigates here when a run ends (`/runs/<id>`). The page is served
    // by the add-on and reads the id from its own path.
    app.get('/runs/:id', (_req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.sendFile(fileURLToPath(new URL('../client/result.html', import.meta.url)));
    });
  },
});
