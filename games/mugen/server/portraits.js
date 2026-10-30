// Portrait PNGs per character, cut once and kept in memory. A portrait is a
// few kilobytes; uploads publish new folders without replacing active assets.
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { PORTRAIT_SPRITES, characterFiles, readPortrait } from './portrait.js';

const MAX_ENTRIES = 1000;

export function createPortraits({ catalog, read = readPortrait }) {
  const cache = new Map(); // `${path}|${size}` -> { stamp, png, etag }

  function stampOf(paths) {
    return paths
      .map((path) => (path ? `${statSync(path).mtimeMs}:${statSync(path).size}` : '-'))
      .join('|');
  }

  /** { png, etag } for a listed character, { png: null } when it has no portrait, null when unknown. */
  function portrait(path, size = 'small') {
    const character = catalog.character(path);
    if (!character || !PORTRAIT_SPRITES[size]) return null;
    const definition = join(catalog.roots.characters, character.path);
    const key = `${character.path}|${size}`;
    let files, stamp;
    try {
      files = characterFiles(definition);
      stamp = stampOf([definition, files.sprite, files.palette]);
    } catch {
      return { png: null };
    }
    const cached = cache.get(key);
    if (cached?.stamp === stamp) {
      cache.delete(key);
      cache.set(key, cached); // most recently used last
      return cached;
    }
    let png = null;
    try {
      png = files.sprite
        ? read(files.sprite, { palettePath: files.palette, sprites: PORTRAIT_SPRITES[size] })
        : null;
    } catch {
      // A damaged or unusual sprite file simply has no portrait.
    }
    const entry = {
      stamp,
      png,
      etag: png ? `"${createHash('sha1').update(png).digest('base64url').slice(0, 20)}"` : null,
    };
    cache.set(key, entry);
    if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
    return entry;
  }

  return { portrait, size: () => cache.size };
}
