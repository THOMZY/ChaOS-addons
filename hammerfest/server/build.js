// @ts-check
// The build served to the loader. The manifest (`build.json`) is the real
// Eternalfest build — modes, families, i18n — with our own blob ids; byte sizes
// are read from `data/` so they always match what we actually serve.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SERVER_DIR = new URL('./', import.meta.url);
const DATA_DIR = new URL('../data/', import.meta.url);
const TEMPLATE = JSON.parse(readFileSync(fileURLToPath(new URL('build.json', SERVER_DIR)), 'utf8'));
/** blob id -> {byte_size, digest}, computed once from the installed files. */
const META_CACHE = new Map();

/** Id of the game in the loader API (stable: it is written in nothing else). */
export const GAME_ID = 'b7f3c1d2-4e5a-4b6c-9d8e-1a2b3c4d5e6f';
export const GAME_KEY = 'hammerfest';
/** Runs are limited to the families the build allows. */
export const FAMILIES = '0,7,13,15,18,1000,1028,5015';

/** Blob id -> file in `data/`. The loader downloads these by id. */
export const BLOBS = Object.freeze({
  'a1b2c3d4-0001-4a0b-8c1d-000000000001': { file: 'game.swf', mediaType: 'application/x-shockwave-flash' },
  'a1b2c3d4-0002-4a0b-8c1d-000000000002': { file: 'patchman.swf', mediaType: 'application/x-shockwave-flash' },
  'a1b2c3d4-0003-4a0b-8c1d-000000000003': { file: 'content.xml', mediaType: 'application/xml' },
  'a1b2c3d4-0004-4a0b-8c1d-000000000004': { file: 'locales.fr-FR.xml', mediaType: 'application/xml' },
  'a1b2c3d4-0005-4a0b-8c1d-000000000005': { file: 'locales.en-US.xml', mediaType: 'application/xml' },
  'a1b2c3d4-0006-4a0b-8c1d-000000000006': { file: 'locales.es-SP.xml', mediaType: 'application/xml' },
  // Musiques du build (mp3) : le loader les précharge quand la case « Musique » est cochée.
  'ae187ff4-13cb-49cd-89b5-74e989d13723': { file: 'musics/music-01.mp3', mediaType: 'audio/mp3' },
  'ea4c1fcf-b764-4cb4-b0d6-a399034f56f6': { file: 'musics/music-02.mp3', mediaType: 'audio/mp3' },
  '31a0536c-e2ef-4e5e-821d-7e8b36bc294c': { file: 'musics/music-03.mp3', mediaType: 'audio/mp3' },
  'c8634d57-3248-45f1-ad7c-6a7aa240203e': { file: 'musics/music-04.mp3', mediaType: 'audio/mp3' },
  '1eb431bc-33ed-43f8-8c14-9d5f17de767d': { file: 'musics/music-05.mp3', mediaType: 'audio/mp3' },
  'f23a6fc5-b5e5-484c-bdd8-047b2e1c8be8': { file: 'musics/music-06.mp3', mediaType: 'audio/mp3' },
});

export const DATA_ROOT = fileURLToPath(DATA_DIR);

/** Absolute path of an installed data file. */
export function dataFile(name) {
  return fileURLToPath(new URL(name, DATA_DIR));
}

/**
 * Size and digests of an installed blob. The loader's `Blob` model requires a
 * `digest` (sha2-256 and sha3-256): without it the manifest is unreadable and the
 * loader stops before starting the run. Hashed once, then cached.
 */
function metaOf(id) {
  const cached = META_CACHE.get(id);
  if (cached) return cached;
  const entry = /** @type {Record<string, {file: string}>} */ (BLOBS)[id];
  if (!entry) throw new Error(`hammerfest: unknown blob ${id}`);
  const bytes = readFileSync(dataFile(entry.file));
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
 * The `Game` document the loader reads through `GET /api/v1/games/<id>`.
 * @param {{ id: string, display_name: string }} owner
 */
export function gameDocument(owner) {
  const build = {
    ...TEMPLATE,
    modes: openModes(TEMPLATE.modes),
    engine: { ...TEMPLATE.engine, blob: withSize(TEMPLATE.engine.blob) },
    patcher: TEMPLATE.patcher ? { ...TEMPLATE.patcher, blob: withSize(TEMPLATE.patcher.blob) } : null,
    content: withSize(TEMPLATE.content),
    content_i18n: withSize(TEMPLATE.content_i18n),
    // Sans ces entrées le loader ne précharge aucune musique : `$music=1` reste sans effet.
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
