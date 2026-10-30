// @ts-check
// The build served to the loader. The manifest (`build.json`) is the real
// Eternalfest build — modes, families, i18n — with our own blob ids; byte sizes
// are read from `game/` so they always match what we actually serve. The assets
// travel with the add-on, so a deploy installs them; only the Ruffle reader comes
// from npm (`@ruffle-rs/ruffle`).
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SERVER_DIR = new URL('./', import.meta.url);
const GAME_DIR = new URL('../game/', import.meta.url);
const TEMPLATE = JSON.parse(readFileSync(fileURLToPath(new URL('build.json', SERVER_DIR)), 'utf8'));
/** blob id -> {byte_size, digest}, computed once from the installed files. */
const META_CACHE = new Map();

/** Id of the game in the loader API (stable: it is written in nothing else). */
export const GAME_ID = 'b7f3c1d2-4e5a-4b6c-9d8e-1a2b3c4d5e6f';
export const GAME_KEY = 'hammerfest';
/** Locale the build speaks natively; other locales are patches under `i18n`. */
export const MAIN_LOCALE = /** @type {string} */ (TEMPLATE.main_locale ?? 'fr-FR');
/** Locales this build can play in (main locale first). */
export const LOCALES = Object.freeze([MAIN_LOCALE, ...Object.keys(TEMPLATE.i18n ?? {})]);
/** Runs are limited to the families the build allows. */
export const FAMILIES = '0,7,13,15,18,1000,1028,5015';

/**
 * Debug build: only the **patcher** differs (it forces `fl_debug` from
 * `GameMode.main`). Engine and content stay those of the public build, served
 * under their usual ids — nothing extra to ship beyond these 70 KB.
 */
export const DEV_PATCHER_BLOB = 'a1b2c3d4-0002-4a0b-8c1d-0000000000d6';
/** Shipped with the add-on (not in `data/`), so a deploy installs it. */
const DEV_PATCHER_PATH = fileURLToPath(new URL('../dev/patchman.swf', import.meta.url));
/** Distinct game id: the loader requests this document for the debug build. */
export const DEV_GAME_ID = 'b7f3c1d2-4e5a-4b6c-9d8e-1a2b3c4d5e6e';

/** Blob id -> file in `data/`. The loader downloads these by id. */
export const BLOBS = Object.freeze({
  'a1b2c3d4-0001-4a0b-8c1d-000000000001': { file: 'game.swf', mediaType: 'application/x-shockwave-flash' },
  'a1b2c3d4-0002-4a0b-8c1d-000000000002': { file: 'patchman.swf', mediaType: 'application/x-shockwave-flash' },
  // Debug build: in-game debug controls, admin accounts only. The patcher lives
  // in the add-on (`dev/`), the rest is the public build.
  [DEV_PATCHER_BLOB]: { file: 'dev/patchman.swf', absolute: DEV_PATCHER_PATH, mediaType: 'application/x-shockwave-flash' },
  'a1b2c3d4-0003-4a0b-8c1d-000000000003': { file: 'content.xml', mediaType: 'application/xml' },
  'a1b2c3d4-0004-4a0b-8c1d-000000000004': { file: 'locales.fr-FR.xml', mediaType: 'application/xml' },
  'a1b2c3d4-0005-4a0b-8c1d-000000000005': { file: 'locales.en-US.xml', mediaType: 'application/xml' },
  'a1b2c3d4-0006-4a0b-8c1d-000000000006': { file: 'locales.es-SP.xml', mediaType: 'application/xml' },
  // Build musics (mp3): the loader preloads them when the "Music" box is checked.
  'ae187ff4-13cb-49cd-89b5-74e989d13723': { file: 'musics/music-01.mp3', mediaType: 'audio/mp3' },
  'ea4c1fcf-b764-4cb4-b0d6-a399034f56f6': { file: 'musics/music-02.mp3', mediaType: 'audio/mp3' },
  '31a0536c-e2ef-4e5e-821d-7e8b36bc294c': { file: 'musics/music-03.mp3', mediaType: 'audio/mp3' },
  'c8634d57-3248-45f1-ad7c-6a7aa240203e': { file: 'musics/music-04.mp3', mediaType: 'audio/mp3' },
  '1eb431bc-33ed-43f8-8c14-9d5f17de767d': { file: 'musics/music-05.mp3', mediaType: 'audio/mp3' },
  'f23a6fc5-b5e5-484c-bdd8-047b2e1c8be8': { file: 'musics/music-06.mp3', mediaType: 'audio/mp3' },
});

export const GAME_ROOT = fileURLToPath(GAME_DIR);

/** Absolute path of a shipped game file. */
export function gameFile(name) {
  return fileURLToPath(new URL(name, GAME_DIR));
}

/**
 * Absolute path of a blob. The debug patcher is the only one shipped inside the
 * add-on (`dev/`) instead of `data/`: 70 KB travel with the code, so a deploy
 * installs it and nothing has to be copied by hand on the server.
 */
export function blobPath(id) {
  const entry = /** @type {Record<string, {file: string, absolute?: string}>} */ (BLOBS)[id];
  if (!entry) throw new Error(`hammerfest: unknown blob ${id}`);
  return entry.absolute ?? gameFile(entry.file);
}

/**
 * Size and digests of an installed blob. The loader's `Blob` model requires a
 * `digest` (sha2-256 and sha3-256): without it the manifest is unreadable and the
 * loader stops before starting the run. Hashed once, then cached.
 */
function metaOf(id) {
  const cached = META_CACHE.get(id);
  if (cached) return cached;
  const bytes = readFileSync(blobPath(id));
  const meta = {
    byte_size: bytes.length,
    digest: {
      sha2_256: createHash('sha256').update(bytes).digest('hex'),
      sha3_256: createHash('sha3-256').update(bytes).digest('hex'),
    },
  };
  META_CACHE.set(id, meta);
  return meta;
}

/** @param {any} blob */
function withSize(blob) {
  return blob ? { ...blob, ...metaOf(blob.id) } : blob;
}

/**
 * The site has no progression gating: every mode is visible and every option is
 * enabled. Without this the loader rejects a non-default option with
 * "InvalidGameOptions" (the spec's `is_enabled` follows the account's progress
 * on Eternalfest, which we do not track).
 */
function openModes(modes) {
  return Object.fromEntries(
    Object.entries(modes ?? {}).map(([id, spec]) => [
      id,
      {
        ...spec,
        is_visible: true,
        options: Object.fromEntries(
          Object.entries(spec.options ?? {}).map(([key, option]) => [key, { ...option, is_enabled: true }]),
        ),
      },
    ]),
  );
}

/** Options of each mode, for the launcher (id, French label, default value). */
export function modeOptions() {
  const modes = openModes(TEMPLATE.modes);
  return Object.fromEntries(
    Object.entries(modes).map(([id, spec]) => [
      id,
      Object.entries(spec.options ?? {})
        .filter(([, option]) => option.is_visible !== false)
        .map(([key, option]) => ({ key, display_name: option.display_name ?? key, checked: option.default_value === true })),
    ]),
  );
}

/**
 * The debug build is offered only when its patcher is installed: without it,
 * `metaOf` would throw on the first game document request.
 */
export function isDevBuildInstalled() {
  return existsSync(blobPath(DEV_PATCHER_BLOB));
}

/**
 * The `Game` document the loader reads through `GET /api/v1/games/<id>`.
 * @param {{ id: string, display_name: string }} owner
 * @param {{ debug?: boolean }} [options]
 */
export function gameDocument(owner, { debug = false } = {}) {
  // The debug build changes ONLY the patcher: same engine, same content, same
  // locales, under the same ids. Digests come from the files actually served.
  const patcherBlob = debug ? { ...TEMPLATE.patcher.blob, id: DEV_PATCHER_BLOB } : TEMPLATE.patcher.blob;
  const build = {
    ...TEMPLATE,
    modes: openModes(TEMPLATE.modes),
    engine: { ...TEMPLATE.engine, blob: withSize(TEMPLATE.engine.blob) },
    patcher: TEMPLATE.patcher ? { ...TEMPLATE.patcher, blob: withSize(patcherBlob) } : null,
    content: withSize(TEMPLATE.content),
    content_i18n: withSize(TEMPLATE.content_i18n),
    // Without these entries the loader preloads nothing: `$music=1` has no effect.
    musics: (TEMPLATE.musics ?? []).map((music) => ({ ...music, blob: withSize(music.blob) })),
    i18n: Object.fromEntries(
      Object.entries(TEMPLATE.i18n ?? {}).map(([locale, entry]) => [
        locale,
        { ...entry, content_i18n: withSize(entry.content_i18n) },
      ]),
    ),
  };
  return {
    type: 'Game',
    id: GAME_ID,
    created_at: TEMPLATE.created_at,
    key: GAME_KEY,
    owner: { type: 'User', id: owner.id, display_name: owner.display_name },
    channels: {
      offset: 0,
      limit: 1,
      count: 1,
      is_count_exact: true,
      active: {
        type: 'GameChannel',
        key: 'main',
        is_enabled: true,
        is_pinned: true,
        publication_date: '2026-10-19T00:00:00.000Z',
        sort_update_date: TEMPLATE.created_at,
        default_permission: 'Play',
        build,
      },
    },
  };
}

/** Mode ids accepted for a run (the nine modes of the build). */
export function modeKeys() {
  return Object.keys(TEMPLATE.modes ?? {});
}

/**
 * The modes shown in the window: id and label, taken from the build so the site
 * never diverges from the game. `is_visible` is not applied: it encodes the
 * platform's progress gating, and the site offers every mode.
 */
export function modeList() {
  return Object.entries(openModes(TEMPLATE.modes)).map(([id, spec]) => ({
    id,
    display_name: /** @type {any} */ (spec).display_name ?? id,
  }));
}
