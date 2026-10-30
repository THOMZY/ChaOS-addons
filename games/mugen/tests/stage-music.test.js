import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCatalog } from '../server/catalog.js';
import { stageMusicOverrides } from '../server/stage-music.js';
import { createBrowserFileSystem } from '../client/engine/vfs.js';

test('stage music resolves old sound paths within its pack and preserves legacy bytes', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mugen-music-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, bytes) => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), bytes);
  };
  const legacy = Buffer.from(
    '[Info]\r\nname = Caf\xe9\r\n[BGdef]\r\nspr = night.sff\r\n[Music]\r\nbgmusic = sound/Caf\xe9.mp3 ; keep comment\r\nbgmvolume = 100\r\n',
    'latin1',
  );
  put('Stages/night/night.def', legacy);
  put('Stages/night/Café.mp3', 'music');
  put('Stages/nested/stages/other.def', '[BGdef]\n[Music]\nbgmusic = sound/music.ogg\n');
  put('Stages/nested/sound/music.ogg', 'other');
  put('Stages/silent/silent.def', '[BGdef]\n[Music]\nbgmusic = \n');
  const generated = stageMusicOverrides(createCatalog({ dataRoot: root }));
  const patched = Buffer.from(generated['stages/night/night.def'].base64, 'base64');
  assert.ok(
    patched
      .subarray(0, legacy.indexOf('bgmusic'))
      .equals(legacy.subarray(0, legacy.indexOf('bgmusic'))),
  );
  assert.ok(patched.includes(Buffer.from('bgmusic = "stages/night/Café.mp3"; keep comment\r\n')));
  assert.ok(patched.includes(Buffer.from('bgmvolume = 100')));
  assert.match(
    Buffer.from(generated['stages/nested/stages/other.def'].base64, 'base64').toString(),
    /"stages\/nested\/sound\/music.ogg"/,
  );
  assert.equal(generated['stages/silent/silent.def'], undefined);
  const vfs = createBrowserFileSystem({ generated });
  assert.equal(vfs.readText('stages/night/night.def').includes('stages/night/Café.mp3'), true);
});

test('stage music never borrows a different pack or guesses between ambiguous tracks', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mugen-music-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, text) => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  put('Stages/a/a.def', '[BGdef]\n[Music]\nbgmusic = sound/song.mp3\n');
  put('Stages/b/song.mp3', 'wrong pack');
  const catalog = createCatalog({ dataRoot: root });
  assert.deepEqual(stageMusicOverrides(catalog), {});
  put('Stages/a/one/song.mp3', 'one');
  put('Stages/a/two/song.mp3', 'two');
  catalog.invalidate();
  assert.deepEqual(stageMusicOverrides(catalog), {});
});
