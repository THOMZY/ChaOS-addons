// What the installed packs contain, read from games/mugen/data/. The engine
// reads the files themselves through the browser file system (vfs.js); the
// server only lists them, names them and validates what players pick.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep, posix } from 'node:path';
import { isUtf8 } from 'node:buffer';

const MAX_DEPTH = 6;
const MAX_FILES = 200_000;
const CACHE_MS = 30_000;

/** One cached view per data root; packs change rarely and listing is a disk walk. */
export function createCatalog({ dataRoot, now = Date.now }) {
  const roots = {
    characters: join(dataRoot, 'Characters'),
    stages: join(dataRoot, 'Stages'),
    engine: join(dataRoot, 'engine'),
  };
  let cached = null;

  function load() {
    if (cached && now() - cached.at < CACHE_MS) return cached;
    const characterFiles = walk(roots.characters);
    const stageFiles = walk(roots.stages);
    cached = {
      at: now(),
      characterFiles,
      stageFiles,
      characters: findDefinitions(roots.characters, characterFiles, isCharacterDef),
      stages: findDefinitions(roots.stages, stageFiles, isStageDef),
    };
    return cached;
  }

  return {
    roots,
    characters: () => load().characters,
    stages: () => load().stages,
    character: (path) => load().characters.find((entry) => entry.path === path) ?? null,
    stage: (path) => load().stages.find((entry) => entry.path === path) ?? null,
    files: () => ({ characters: load().characterFiles, stages: load().stageFiles }),
    engine: () => readEngineStamp(roots.engine),
    invalidate() {
      cached = null;
    },
  };
}

/** Files under root as [relativePath, size], forward slashes, symlinks ignored. */
export function walk(root) {
  const files = [];
  const visit = (dir, depth) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // a missing pack folder simply lists nothing
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return;
      if (entry.name.startsWith('.')) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory() && depth < MAX_DEPTH) visit(path, depth + 1);
      else if (entry.isFile()) {
        try {
          files.push([relative(root, path).split(sep).join('/'), statSync(path).size]);
        } catch {
          // removed while listing: the next listing will not show it either
        }
      }
    }
  };
  visit(root, 0);
  return files;
}

function findDefinitions(root, files, accepts) {
  const found = [];
  for (const [path, size] of files) {
    if (!/\.def$/i.test(path) || size > 512 * 1024 || path.split('/').length > 3) continue;
    let text;
    try {
      const data = readFileSync(join(root, path));
      text = data.toString(isUtf8(data) ? 'utf8' : 'latin1');
    } catch {
      continue;
    }
    const sections = parseSections(text);
    if (!accepts(sections)) continue;
    const info = sections.get('info') ?? new Map();
    const name = info.get('displayname') || info.get('name') || path.split('/').at(-2) || path;
    found.push({ path, name: name.slice(0, 64) });
  }
  const entries = accepts === isCharacterDef ? preferCanonicalCharacters(found) : found;
  return entries.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
}

function preferCanonicalCharacters(entries) {
  const key = (entry) => `${posix.dirname(entry.path).toLowerCase()}\0${entry.name.toLowerCase()}`;
  const canonical = new Map();
  for (const entry of entries) {
    const folder = posix.basename(posix.dirname(entry.path)).toLowerCase();
    const filename = posix.basename(entry.path).toLowerCase();
    const rank =
      filename === folder + '.def' ? 2 : filename === entry.name.toLowerCase() + '.def' ? 1 : 0;
    if (rank > (canonical.get(key(entry))?.rank ?? 0))
      canonical.set(key(entry), { path: entry.path, rank });
  }
  // Packs may keep dated definitions next to their current <folder>.def.
  // Keep distinct names and separate packs, and leave all resources on disk.
  return entries.filter(
    (entry) => !canonical.has(key(entry)) || canonical.get(key(entry)).path === entry.path,
  );
}

const isCharacterDef = (sections) => sections.get('files')?.has('sprite') ?? false;
const isStageDef = (sections) => sections.has('stageinfo') || sections.has('bgdef');

/** Minimal MUGEN ini reader: lower-case section and key names, comments removed. */
export function parseSections(text) {
  const sections = new Map();
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split(';')[0].trim();
    if (!line) continue;
    const header = /^\[([^\]]+)\]/.exec(line);
    if (header) {
      const name = header[1].trim().toLowerCase();
      current = sections.get(name) ?? new Map();
      sections.set(name, current);
      continue;
    }
    const pair = /^([^=]+)=(.*)$/.exec(line);
    if (!pair || !current) continue;
    const key = pair[1].trim().toLowerCase();
    if (!current.has(key)) current.set(key, pair[2].trim().replace(/^"(.*)"$/, '$1'));
  }
  return sections;
}

function readEngineStamp(root) {
  try {
    const stamp = JSON.parse(readFileSync(join(root, 'engine.json'), 'utf8'));
    return stamp && typeof stamp.wasm === 'string' && Array.isArray(stamp.files) ? stamp : null;
  } catch {
    return null;
  }
}
