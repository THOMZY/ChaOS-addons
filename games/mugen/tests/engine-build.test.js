import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PATCHES, applyPatches } from '../engine/patches.mjs';
import { SOURCE_PATCHES, applySourcePatches } from '../engine/source-patches.mjs';
import { readPins } from '../engine/pins.mjs';
import { createCatalog, parseSections } from '../server/catalog.js';

test('MUGEN engine pins are valid', () => {
  const pins = readPins();
  assert.match(pins.ikemen.commit, /^[0-9a-f]{40}$/);
  assert.match(pins.screenpack.commit, /^[0-9a-f]{40}$/);
  assert.match(pins.go, /^\d+\.\d+$/);
  assert.ok(pins.revision >= 1);
});

test('MUGEN quick-match netplay patch applies once and refuses a changed script', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mugen-patch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const patch = PATCHES.find((item) => item.replace.includes('netLoadingReady'));
  mkdirSync(join(root, 'external/script'), { recursive: true });
  writeFileSync(join(root, patch.file), PATCHES.map((item) => item.find).join('\n-- divider\n'));
  applyPatches(root);
  const patched = readFileSync(join(root, patch.file), 'utf8');
  assert.match(patched, /while not netLoadingReady\(\) do/);
  assert.throws(() => applyPatches(root), /no longer matches/);
});

test('MUGEN source patches refuse changed engines and expose only confirmed GGPO queues', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mugen-source-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const file of new Set(SOURCE_PATCHES.map((patch) => patch.file))) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(
      join(root, file),
      SOURCE_PATCHES.filter((patch) => patch.file === file)
        .map((patch) => patch.find)
        .join('\n'),
    );
  }
  applySourcePatches(root);
  const peer = readFileSync(join(root, 'third_party/ggpo/peer.go'), 'utf8');
  assert.ok(peer.indexOf('GetConfirmedInputs') < peer.indexOf('SetLastConfirmedFrame'));
  assert.match(readFileSync(join(root, 'src/chaos_replay.go'), 'utf8'), /writeReplayInput/);
  assert.throws(() => applySourcePatches(root), /no longer matches/);
});

test('MUGEN catalog prefers the current fighter over same-name backups in its folder', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mugen-catalog-backups-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, name) => {
    mkdirSync(join(root, 'Characters', path, '..'), { recursive: true });
    writeFileSync(
      join(root, 'Characters', path),
      `[Info]\nname = ${name}\n[Files]\nsprite = fighter.sff\n`,
    );
  };
  write('juh/0-older.def', 'juh');
  write('juh/juh_Aug_09_2024.def', 'juh');
  write('juh/JuH.DEF', 'juh');
  write('juh/juh_Nov_08_2024.def', 'juh');
  write('juh/extra.def', 'juh EX');
  write('other-pack/fighter.def', 'juh');
  write('wrapped/fighter/fighter.def', 'Wrapped');
  write('wrapped/fighter/old.def', 'Wrapped');
  const catalog = createCatalog({ dataRoot: root });
  assert.deepEqual(
    catalog
      .characters()
      .map((entry) => entry.path)
      .sort(),
    ['juh/JuH.DEF', 'juh/extra.def', 'other-pack/fighter.def', 'wrapped/fighter/fighter.def'],
  );
  assert.equal(catalog.character('juh/juh_Aug_09_2024.def'), null);
  assert.ok(
    catalog.files().characters.some(([path]) => path === 'juh/juh_Aug_09_2024.def'),
    'backup resources stay available on disk',
  );
});

test('MUGEN catalog keeps fighter and stage definitions, not storyboards', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mugen-catalog-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, text) => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  write(
    'Characters/Zed/zed.def',
    '; comment\n[Info]\nname = "Zed" ; trailing\ndisplayname = Zed EX\n[Files]\nSprite = zed.sff\n',
  );
  write('Characters/Zed/ending.def', '[SceneDef]\n');
  write('Characters/abel/abel.def', '[Files]\nsprite = abel.sff\n');
  write('Stages/Night/night.def', '[Info]\nname = Night\n[BGdef]\n');
  write('Stages/broken.def', '[Info]\nname = Broken\n');
  let now = 0;
  const catalog = createCatalog({ dataRoot: root, now: () => now });
  assert.deepEqual(catalog.characters(), [
    { path: 'abel/abel.def', name: 'abel' },
    { path: 'Zed/zed.def', name: 'Zed EX' },
  ]);
  assert.deepEqual(catalog.stages(), [{ path: 'Night/night.def', name: 'Night' }]);
  write('Characters/new/new.def', '[Files]\nsprite = new.sff\n');
  assert.equal(catalog.characters().length, 2, 'listing is cached');
  now = 31_000;
  assert.equal(catalog.characters().length, 3);
  assert.equal(catalog.character('Zed/zed.def').name, 'Zed EX');
  assert.equal(catalog.character('../Zed/zed.def'), null);
  assert.equal(parseSections('[A]\nk = "v"\nk = w\n').get('a').get('k'), 'v');
});
