import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('Hammerfest declares its bundled game installation and preserves the data directory', () => {
  const addon = JSON.parse(readFileSync(new URL('../addon.json', import.meta.url), 'utf8'));
  assert.equal(addon.data.dir, 'data');
  assert.equal(addon.data.install, 'node scripts/games/games-install.mjs hammerfest');
  for (const file of ['game.swf', 'patchman.swf', 'content.xml', 'loader.swf']) {
    assert.ok(readFileSync(new URL(`../game/${file}`, import.meta.url)).length > 0);
  }
});
