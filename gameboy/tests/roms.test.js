import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RomLibrary, looksLikeRom, readHeader } from '../server/roms.mjs';

function rom(title = 'TEST ROM') {
  const buffer = Buffer.alloc(32768);
  buffer[0x104] = 0xce;
  buffer[0x105] = 0xed;
  buffer.write(title, 0x134);
  return buffer;
}

test('ROM validation does not accept arbitrary files with a GBA extension', () => {
  assert.equal(looksLikeRom(Buffer.alloc(32768), 'fake.gba'), false);
});

test('GBA header identification reads the binary fixed byte', () => {
  const buffer = Buffer.alloc(32768);
  buffer[0xb2] = 0x96;
  buffer.write('ADVANCE', 0xa0);
  assert.equal(readHeader(buffer, 'renamed.bin').model, 'AGB');
});

test('a ROM library only resolves validated indexed ROM files and never overwrites a cartridge', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'chaos-rom-library-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const library = new RomLibrary(directory);
  await library.init();
  await writeFile(join(directory, 'secret.txt'), 'private');
  assert.equal(library.path('secret.txt'), null);
  const original = rom();
  await library.add('demo.gb', original);
  await assert.rejects(library.add('demo.gb', rom('OTHER')), /already_exists/);
  assert.deepEqual(await readFile(join(directory, 'demo.gb')), original);
  assert.equal(library.path('../demo.gb'), null);
  assert.equal(library.path('demo.gb'), join(directory, 'demo.gb'));
});

test('scanning rejects invalid cartridges and detects same-size replacements', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'chaos-rom-scan-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'invalid.gba'), Buffer.alloc(32768));
  const library = new RomLibrary(directory);
  await library.init();
  assert.equal(library.list().length, 0);
  await library.add('demo.gb', rom());
  const previous = library.list()[0].crc;
  await writeFile(join(directory, 'demo.gb'), rom('CHANGED'));
  await library.scan();
  assert.notEqual(library.list()[0].crc, previous);
});
