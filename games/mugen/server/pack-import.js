// ZIP packs are staged outside the public catalog, validated, then published
// in one rename. Existing fighters/stages are never replaced during a duel.
import { createReadStream, createWriteStream, existsSync, readdirSync, renameSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join, posix, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32 } from 'node:zlib';
import { isUtf8 } from 'node:buffer';
import yauzl from 'yauzl';
import { createCatalog, parseSections, walk } from './catalog.js';

export const PACK_LIMITS = Object.freeze({
  upload: 128 * 1024 * 1024,
  unpacked: 256 * 1024 * 1024,
  file: 128 * 1024 * 1024,
  entries: 5000,
});
const ASSET_TYPES = new Set([
  '.def',
  '.sff',
  '.snd',
  '.air',
  '.cmd',
  '.cns',
  '.st',
  '.zss',
  '.act',
  '.pal',
  '.txt',
  '.md',
  '.ini',
  '.dat',
  '.fnt',
  '.ttf',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.pcx',
  '.wav',
  '.ogg',
  '.mp3',
  '.flac',
  '.mid',
  '.midi',
  '.mp4',
  '.webm',
  '.gltf',
  '.bin',
]);
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

function safePath(name) {
  const parts = name.replace(/\/$/, '').split('/');
  if (
    !name ||
    name.length > 240 ||
    name.startsWith('/') ||
    parts.some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        /[\\:\x00-\x1f]/.test(part) ||
        /[. ]$/.test(part) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    )
  )
    throw fail('invalid_pack_path');
  return parts;
}

function packName(filename) {
  if (typeof filename !== 'string' || !/\.zip$/i.test(filename) || /[\\/\x00-\x1f]/.test(filename))
    throw fail('zip_required');
  const name = filename
    .slice(0, -4)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 60);
  if (!name || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) throw fail('invalid_pack_name');
  return name;
}

function stripWrapper(entries) {
  let depth = 0;
  while (
    entries.every(
      (entry) => entry.parts.length > depth + 1 && entry.parts[depth] === entries[0].parts[depth],
    )
  )
    depth++;
  return entries.map((entry) => Object.assign(entry, { path: entry.parts.slice(depth).join('/') }));
}

async function extract(zip, entries, root, signal) {
  for (const entry of entries) {
    signal?.throwIfAborted();
    const destination = resolve(root, entry.path);
    if (!destination.startsWith(root + sep)) throw fail('invalid_pack_path');
    await mkdir(dirname(destination), { recursive: true });
    let bytes = 0,
      checksum = 0;
    const meter = new Transform({
      transform(chunk, _encoding, done) {
        bytes += chunk.length;
        if (bytes > entry.uncompressedSize || bytes > PACK_LIMITS.file)
          return done(fail('pack_too_large', 413));
        checksum = crc32(chunk, checksum);
        done(null, chunk);
      },
    });
    const input = await zip.openReadStreamPromise(entry);
    await pipeline(input, meter, createWriteStream(destination, { flags: 'wx' }), { signal });
    if (bytes !== entry.uncompressedSize || checksum !== entry.crc32) throw fail('invalid_zip');
  }
}

function findAsset(files, definition, raw) {
  const reference = raw.replaceAll('\\', '/');
  if (/^(?:\/|[a-z]+:)/i.test(reference)) return null;
  const relative = posix.normalize(posix.join(posix.dirname(definition), reference));
  const direct = [relative, posix.normalize(reference)].find((candidate) =>
    files.has(candidate.toLowerCase()),
  );
  if (direct) return files.get(direct.toLowerCase());
  // Many distributed stage packs retain "stages/foo.sff" after their ZIP
  // wrapper was removed. Resolve that asset only when the match is unique.
  const candidates = [...files.values()].filter(
    (path) =>
      path.toLowerCase().endsWith('/' + reference.toLowerCase()) ||
      posix.basename(path).toLowerCase() === posix.basename(reference).toLowerCase(),
  );
  return candidates.length === 1 ? candidates[0] : null;
}

async function validateDefinitions(root, kind) {
  const catalog = createCatalog({ dataRoot: root });
  const definitions = kind === 'characters' ? catalog.characters() : catalog.stages();
  if (!definitions.length)
    throw fail(kind === 'characters' ? 'character_definition_missing' : 'stage_definition_missing');
  const packRoot = join(root, kind === 'characters' ? 'Characters' : 'Stages');
  const files = new Map(walk(packRoot).map(([path]) => [path.toLowerCase(), path]));
  for (const definition of definitions) {
    const full = join(packRoot, definition.path);
    const original = await readFile(full);
    // Preserve legacy MUGEN encodings: changing paths must not re-encode names.
    const encoding = isUtf8(original) ? 'utf8' : 'latin1';
    const text = original.toString(encoding);
    const sections = parseSections(text);
    const section = kind === 'characters' ? 'files' : 'bgdef';
    const spriteKey = kind === 'characters' ? 'sprite' : 'spr';
    const sprite = sections.get(section)?.get(spriteKey);
    const spritePath = sprite && findAsset(files, definition.path, sprite);
    if (!spritePath) throw fail('pack_assets_missing');
    const header = Buffer.alloc(12);
    const input = createReadStream(join(packRoot, spritePath), { start: 0, end: 11 });
    let offset = 0;
    for await (const bytes of input) {
      bytes.copy(header, offset);
      offset += bytes.length;
    }
    if (header.toString('ascii') !== 'ElecbyteSpr\0') throw fail('invalid_sprite');
    let currentSection = '';
    const patched = text
      .split(/\r?\n/)
      .map((line) => {
        const heading = /^\s*\[([^\]]+)\]/.exec(line);
        if (heading) currentSection = heading[1].toLowerCase();
        const pair = /^(\s*([^=;]+?)\s*=\s*)([^;]*)(.*)$/.exec(line);
        if (!pair) return line;
        const key = pair[2].trim().toLowerCase();
        const isFile =
          currentSection === section &&
          (kind === 'characters' ? /^(sprite|anim|cmd|cns|sound|st\d*)$/.test(key) : key === 'spr');
        const isMusic = currentSection === 'music' && /(?:^|\.)(bgmusic|bgm|music)$/.test(key);
        if (!isFile && !isMusic) return line;
        const raw = pair[3].trim().replace(/^"(.*)"$/, '$1');
        if (!raw) return line;
        const asset = findAsset(files, definition.path, raw);
        if (!asset) {
          if (isFile) throw fail('pack_assets_missing');
          return line; // Music is optional in MUGEN packs.
        }
        return (
          pair[1] + '"' + posix.relative(posix.dirname(definition.path), asset) + '"' + pair[4]
        );
      })
      .join('\n');
    if (patched !== text) await writeFile(full, Buffer.from(patched, encoding));
  }
  return definitions;
}

export async function importPack({ catalog, kind, filename, buffer, signal }) {
  if (!['characters', 'stages'].includes(kind)) throw fail('invalid_pack_kind');
  const name = packName(filename);
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw fail('invalid_zip');
  if (buffer.length > PACK_LIMITS.upload) throw fail('pack_too_large', 413);
  const dataRoot = dirname(catalog.roots.characters);
  await mkdir(dataRoot, { recursive: true });
  let staging, zip;
  try {
    zip = await yauzl.fromBufferPromise(buffer, { autoClose: false, validateEntrySizes: true });
    if (zip.entryCount > PACK_LIMITS.entries) throw fail('pack_too_many_files', 413);
    const entries = [],
      paths = new Set();
    let total = 0;
    for await (const entry of zip.eachEntry()) {
      signal?.throwIfAborted();
      const parts = safePath(entry.fileName);
      const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
      if (mode && mode !== 0x8000 && mode !== 0x4000) throw fail('invalid_pack_path');
      const pathKey = entry.fileName.replace(/\/$/, '').toLowerCase();
      if (paths.has(pathKey)) throw fail('duplicate_pack_path');
      paths.add(pathKey);
      if (entry.fileName.endsWith('/')) continue;
      if (parts.some((part) => part.startsWith('.') || part === '__MACOSX')) continue;
      if (!ASSET_TYPES.has(extname(entry.fileName).toLowerCase()))
        throw fail('unsupported_pack_file');
      if (entry.isEncrypted()) throw fail('encrypted_zip');
      total += entry.uncompressedSize;
      if (entry.uncompressedSize > PACK_LIMITS.file || total > PACK_LIMITS.unpacked)
        throw fail('pack_too_large', 413);
      entries.push(Object.assign(entry, { parts }));
    }
    if (!entries.length) throw fail('empty_pack');
    staging = await mkdtemp(join(dataRoot, '.incoming-pack-'));
    const folder = kind === 'characters' ? 'Characters' : 'Stages';
    const unpacked = resolve(staging, folder, name);
    await mkdir(unpacked, { recursive: true });
    await extract(zip, stripWrapper(entries), unpacked, signal);
    const definitions = await validateDefinitions(staging, kind);
    signal?.throwIfAborted();
    const targetRoot = catalog.roots[kind];
    await mkdir(targetRoot, { recursive: true });
    // This check and rename have no asynchronous gap: concurrent imports in
    // this process cannot overwrite an existing pack, even with case aliases.
    if (
      readdirSync(targetRoot).some((entry) => entry.toLowerCase() === name.toLowerCase()) ||
      existsSync(join(targetRoot, name))
    )
      throw fail('pack_already_exists', 409);
    signal?.throwIfAborted();
    renameSync(unpacked, join(targetRoot, name));
    catalog.invalidate();
    return { kind, name, entries: definitions };
  } catch (error) {
    if (error.status || signal?.aborted) throw error;
    if (['EACCES', 'EPERM', 'ENOSPC'].includes(error.code))
      throw fail('pack_storage_unavailable', 503);
    throw fail('invalid_zip');
  } finally {
    zip?.close();
    if (staging) await rm(staging, { recursive: true, force: true });
  }
}
