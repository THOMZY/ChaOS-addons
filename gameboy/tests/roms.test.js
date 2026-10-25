import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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

test('removing a cartridge deletes its save, its clock, its cover and its index entry', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'chaos-rom-remove-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const library = new RomLibrary(directory);
  await library.init();
  const entry = await library.add('demo.gb', rom());
  await writeFile(join(directory, 'demo.sav'), 'battery');
  await writeFile(join(directory, 'demo.rtc.json'), '{"elapsed":1}');
  await library.writeMedia(entry.crc, { status: 'ok' });

  const removed = await library.remove('demo.gb');
  assert.equal(removed.entry.crc, entry.crc);
  assert.deepEqual(removed.existed, { rom: true, save: true, clock: true, media: true });
  for (const name of ['demo.gb', 'demo.sav', 'demo.rtc.json'])
    assert.equal(existsSync(join(directory, name)), false, `${name} must be deleted`);
  assert.equal(
    existsSync(join(directory, 'media', entry.crc)),
    false,
    'the cover folder must be deleted',
  );
  assert.deepEqual(library.list(), []);
  assert.deepEqual(
    Object.keys(JSON.parse(await readFile(join(directory, 'roms.index.json'), 'utf8'))),
    [],
  );
});

test('two uploads of the same dump share one cover that only the last removal drops', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'chaos-rom-shared-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const library = new RomLibrary(directory);
  await library.init();
  const first = await library.add('first.gb', rom());
  const second = await library.add('second.gb', rom());
  assert.equal(first.crc, second.crc);
  await library.writeMedia(first.crc, { status: 'ok' });

  const kept = await library.remove('first.gb');
  assert.equal(kept.existed.media, false, 'a shared cover is not reported as deleted');
  assert.equal(existsSync(join(directory, 'media', first.crc)), true, 'the other copy keeps it');

  const last = await library.remove('second.gb');
  assert.equal(last.existed.media, true);
  assert.equal(existsSync(join(directory, 'media', first.crc)), false);
});

test('a cartridge deleted outside the app leaves an entry the library can still drop', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'chaos-rom-ghost-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const library = new RomLibrary(directory);
  await library.init();
  await library.add('ghost.gb', rom());
  // Exactly what a hand deletion leaves behind: the file is gone, the entry is
  // still what the shelf draws as an empty box.
  await rm(join(directory, 'ghost.gb'));
  assert.equal(library.list().length, 1);

  const removed = await library.remove('ghost.gb');
  assert.equal(removed.existed.rom, false);
  assert.deepEqual(library.list(), []);
  assert.deepEqual(
    Object.keys(JSON.parse(await readFile(join(directory, 'roms.index.json'), 'utf8'))),
    [],
  );
});

test('a cartridge keeps the save of another cartridge sharing its name without extension', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'chaos-rom-stem-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const library = new RomLibrary(directory);
  await library.init();
  await library.add('demo.gb', rom());
  await library.add('demo.gbc', rom('COLOUR'));
  await writeFile(join(directory, 'demo.sav'), 'battery');
  await writeFile(join(directory, 'demo.rtc.json'), '{"elapsed":1}');

  // mGBA strips only the last extension: both cartridges read demo.sav.
  const kept = await library.remove('demo.gb');
  assert.deepEqual(
    { save: kept.existed.save, clock: kept.existed.clock },
    { save: false, clock: false },
  );
  assert.equal(existsSync(join(directory, 'demo.sav')), true, 'the other cartridge keeps its save');
  assert.equal(existsSync(join(directory, 'demo.rtc.json')), true);

  const last = await library.remove('demo.gbc');
  assert.deepEqual(
    { save: last.existed.save, clock: last.existed.clock },
    { save: true, clock: true },
  );
  for (const name of ['demo.sav', 'demo.rtc.json'])
    assert.equal(existsSync(join(directory, name)), false, `${name} goes with the last cartridge`);
});

test('removing an unknown name changes nothing', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'chaos-rom-unknown-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const library = new RomLibrary(directory);
  await library.init();
  await library.add('demo.gb', rom());
  assert.equal(await library.remove('other.gb'), null);
  assert.equal(await library.remove('../demo.gb'), null);
  assert.equal(library.list().length, 1);
});
