import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { installAddonPackage } from '../../../server/addons/install-package.js';
import { changeAddonFiles } from '../../../games/platform/addon-storage.js';

function createFixture(context) {
  const root = mkdtempSync(resolve(tmpdir(), 'mugen-migration-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, contents) => {
    mkdirSync(resolve(root, path, '..'), { recursive: true });
    writeFileSync(resolve(root, path), contents);
  };
  write(
    'source/games/mugen/addon.json',
    JSON.stringify({
      id: 'mugen',
      chaosAddonApi: 2,
      version: '1',
      data: { dir: 'data', legacyIds: ['fighting'] },
      migration: 'install/migrate-data.js',
    }),
  );
  write('source/games/mugen/client/index.js', 'new client');
  write(
    'source/games/mugen/install/migrate-data.js',
    readFileSync(new URL('../install/migrate-data.js', import.meta.url), 'utf8'),
  );
  write('games/fighting/data/Characters/Ryu/ryu.sff', Buffer.from([0, 255, 128]));
  write('games/mugen/manifest.js', 'site manifest');
  return {
    root,
    write,
    install: () =>
      installAddonPackage({
        root,
        source: resolve(root, 'source'),
        id: 'mugen',
      }),
  };
}

test('installing MUGEN migrates former add-on data once and uninstall preserves it', async (context) => {
  const { root, install } = createFixture(context);
  await install();
  await install();
  assert.equal(existsSync(resolve(root, 'games/fighting/data')), false);
  changeAddonFiles({ root, id: 'mugen', remove: true });
  assert.deepEqual(
    readFileSync(resolve(root, 'games/mugen/data/Characters/Ryu/ryu.sff')),
    Buffer.from([0, 255, 128]),
  );
  assert.equal(existsSync(resolve(root, 'games/mugen/manifest.js')), false);
});

test('conflicting MUGEN packs are refused before moving data or installing code', async (context) => {
  const { root, write, install } = createFixture(context);
  write('games/mugen/data/Characters/Ken/ken.sff', 'existing pack');
  await assert.rejects(install, /Conflicting MUGEN data directories/);
  assert.equal(existsSync(resolve(root, 'games/fighting/data/Characters/Ryu/ryu.sff')), true);
  assert.equal(
    readFileSync(resolve(root, 'games/mugen/data/Characters/Ken/ken.sff'), 'utf8'),
    'existing pack',
  );
  assert.equal(existsSync(resolve(root, 'games/mugen/client')), false);
});

test('remembered data folders follow the renamed add-on and survive subsequent installs', async (context) => {
  const { root, write, install } = createFixture(context);
  write('server/data/addon-folders.json', JSON.stringify({ fighting: ['data', 'packs'] }));
  write('games/fighting/packs/stage.def', 'stage bytes');
  await install();
  await install();
  assert.equal(readFileSync(resolve(root, 'games/mugen/packs/stage.def'), 'utf8'), 'stage bytes');
  assert.deepEqual(
    JSON.parse(readFileSync(resolve(root, 'server/data/addon-folders.json'), 'utf8')),
    { mugen: ['data', 'packs'] },
  );
});
