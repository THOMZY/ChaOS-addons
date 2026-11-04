import { existsSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';

/** Keep private packs when installing the renamed add-on; never merge two packs. */
export function migrateMugenData({ root, destination, dataFolders, movePath }) {
  const legacy = resolve(root, 'games/fighting');
  if (!existsSync(legacy)) return;
  if (lstatSync(legacy).isSymbolicLink()) throw new Error('Linked legacy MUGEN directory');
  const paths = [...dataFolders]
    .map((name) => [resolve(legacy, name), resolve(destination, name)])
    .filter(([from]) => existsSync(from));
  for (const [from, to] of paths) {
    if (lstatSync(from).isSymbolicLink() || !lstatSync(from).isDirectory())
      throw new Error('Invalid legacy MUGEN data directory');
    if (existsSync(to)) throw new Error('Conflicting MUGEN data directories');
  }
  for (const [from, to] of paths) movePath(from, to);
}

export default migrateMugenData;
