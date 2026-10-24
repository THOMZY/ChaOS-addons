// @ts-check
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RomLibrary } from './server/roms.mjs';

const library = new RomLibrary(fileURLToPath(new URL('./data/', import.meta.url)));
await library.init();
if (process.argv[2]) {
  const source = resolve(process.argv[2]);
  for (const file of await readdir(source, { withFileTypes: true })) {
    if (file.isFile() && /\.(gb|gbc|gba)$/i.test(file.name))
      await library.add(file.name, await readFile(resolve(source, file.name)));
  }
}
console.info(`[gameboy] ${library.list().length} ROM(s) available`);
