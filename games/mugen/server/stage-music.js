// Distributed packs often keep old sound/ paths after being moved into their
// own stage directory. Repair only references to files actually in that pack.
import { readFileSync } from 'node:fs';
import { isUtf8 } from 'node:buffer';
import { join, posix } from 'node:path';

const AUDIO = /\.(mp3|ogg|wav|flac|mid|midi|xm|mod|it|s3m)$/i;

function findMusic(files, definition, reference) {
  const path = reference.replaceAll('\\', '/');
  if (!AUDIO.test(path) || /^(?:\/|[a-z]+:)/i.test(path)) return null;
  const pack = definition.includes('/') ? definition.split('/')[0] + '/' : '';
  const local = files.filter(([name]) => name.startsWith(pack));
  const candidates = [
    posix.join(posix.dirname(definition), path),
    posix.join(pack, path),
    path,
    posix.join(posix.dirname(definition), posix.basename(path)),
  ].map((value) => value.toLowerCase());
  for (const candidate of candidates) {
    const found = local.find(([name]) => name.toLowerCase() === candidate);
    if (found) return found[0];
  }
  const matches = local.filter(
    ([name]) => posix.basename(name).toLowerCase() === posix.basename(path).toLowerCase(),
  );
  return matches.length === 1 ? matches[0][0] : null;
}

export function stageMusicOverrides(catalog) {
  const generated = {};
  const files = catalog.files().stages;
  for (const stage of catalog.stages()) {
    let original;
    try {
      original = readFileSync(join(catalog.roots.stages, stage.path));
    } catch {
      continue;
    }
    let section = '',
      changed = false;
    // Byte-preserving edits: old packs contain Shift-JIS or Windows-1252 text.
    // Only a repaired music value is written as UTF-8 for the Go path reader.
    const patched = original
      .toString('latin1')
      .split(/(?<=\n)/)
      .map((line) => {
        const heading = /^\s*\[([^\]]+)\]/.exec(line);
        if (heading) section = heading[1].trim().toLowerCase();
        if (section !== 'music') return Buffer.from(line, 'latin1');
        const pair = /^(\s*bgmusic(?:\.[\w]+)*\s*=\s*)([^;\r\n]*)([^]*)$/i.exec(line);
        if (!pair) return Buffer.from(line, 'latin1');
        const bytes = Buffer.from(pair[2].trim().replace(/^"(.*)"$/, '$1'), 'latin1');
        const reference = bytes.toString(isUtf8(bytes) ? 'utf8' : 'latin1');
        const music = findMusic(files, stage.path, reference);
        if (!music) return Buffer.from(line, 'latin1');
        changed = true;
        return Buffer.concat([
          Buffer.from(pair[1], 'latin1'),
          Buffer.from('"stages/' + music + '"'),
          Buffer.from(pair[3], 'latin1'),
        ]);
      });
    if (changed)
      generated['stages/' + stage.path] = { base64: Buffer.concat(patched).toString('base64') };
  }
  return generated;
}
