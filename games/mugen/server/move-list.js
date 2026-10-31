import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { isUtf8 } from 'node:buffer';
import { parseSections } from './catalog.js';

const MAX_TEXT_BYTES = 2 * 1024 * 1024;

export function parseMoveList(text) {
  const moves = [],
    seen = new Set();
  let command = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split(';')[0].trim();
    if (line.startsWith('[')) {
      command = /^\[command\]$/i.test(line) ? {} : null;
      if (command) moves.push(command);
      continue;
    }
    const pair = /^(name|command)\s*=\s*(.*?)\s*$/i.exec(line);
    if (command && pair) command[pair[1].toLowerCase()] = pair[2].replace(/^"(.*)"$/, '$1');
  }
  return moves
    .filter((move) => {
      if (!move.name || !move.command || move.name.length > 120 || move.command.length > 256)
        return false;
      if (/^(?:ai|cpu)(?:\d|\W|_|$)|^hold(?:_|fwd|back|up|down)/i.test(move.name)) return false;
      if (
        !move.command.split(',').every((step) =>
          step
            .trim()
            .split('+')
            .every((input) => /^[~/$>\d]*(?:[DU][FB]?|[FBxyzabcs])$/.test(input.trim())),
        )
      )
        return false;
      const key = move.name + '\0' + move.command.replace(/\s/g, '');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 500)
    .map((move) => ({ name: move.name, input: move.command }));
}

export function readMoveList(catalog, characterPath) {
  const character = catalog.character(characterPath);
  if (!character) return null;
  const files = new Map(
    catalog.files().characters.map(([path, size]) => [path.toLowerCase(), { path, size }]),
  );
  const read = (path) => {
    const file = files.get(posix.normalize(path.replaceAll('\\', '/')).toLowerCase());
    // Only catalogued regular files can be read; pack paths cannot escape the data root.
    if (!file || file.size > MAX_TEXT_BYTES) return '';
    try {
      const bytes = readFileSync(join(catalog.roots.characters, file.path));
      if (bytes.length > MAX_TEXT_BYTES) return '';
      return bytes.toString(isUtf8(bytes) ? 'utf8' : 'latin1');
    } catch {
      return ''; // A pack removed during the request has no commands to show.
    }
  };
  const definition = parseSections(read(character.path));
  const commandPath = definition.get('files')?.get('cmd');
  const text = commandPath
    ? read(posix.join(posix.dirname(character.path), commandPath.replaceAll('\\', '/')))
    : '';
  return { character, moves: parseMoveList(text) };
}
