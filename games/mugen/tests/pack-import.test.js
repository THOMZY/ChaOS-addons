import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCatalog } from '../server/catalog.js';
import { importPack, PACK_LIMITS } from '../server/pack-import.js';
import { zipFixture, spriteFixture, characterPack } from './zip-fixture.js';
import { characterFiles } from '../server/portrait.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'mugen-pack-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const catalog = createCatalog({ dataRoot: root });
  const upload = (buffer, kind = 'characters', filename = 'hero.zip', signal) =>
    importPack({ catalog, kind, filename, buffer, signal });
  return { root, catalog, upload };
}

test('MUGEN imports a wrapped character ZIP, repairs case/path references and refreshes its catalog', async (t) => {
  const { root, catalog, upload } = await fixture(t);
  assert.deepEqual(catalog.characters(), []);
  const result = await upload(characterPack());
  assert.equal(result.name, 'hero');
  assert.deepEqual(catalog.characters(), [{ path: 'hero/hero.def', name: 'Hero' }]);
  assert.match(
    await readFile(join(root, 'Characters/hero/hero.def'), 'utf8'),
    /sprite = "hero.sff"/,
  );
  assert.deepEqual(await readdir(root), ['Characters']);
});

test('MUGEN imports UTF-8 names and asset paths without corrupting their encoding', async (t) => {
  const { root, catalog, upload } = await fixture(t);
  const buffer = zipFixture([
    { name: '忍者/hero.def', data: '[Info]\nname = 忍者\n[Files]\nsprite = 絵.sff\n' },
    { name: '忍者/絵.sff', data: spriteFixture },
  ]);
  await upload(buffer, 'characters', '忍者.zip');
  assert.deepEqual(catalog.characters(), [{ path: '忍者/hero.def', name: '忍者' }]);
  const file = join(root, 'Characters/忍者/hero.def');
  assert.match(await readFile(file, 'utf8'), /sprite = "絵.sff"/);
  assert.equal(characterFiles(file).sprite, join(root, 'Characters/忍者/絵.sff'));
});

test('MUGEN hides dated same-name definitions even when the ZIP has a versioned name', async (t) => {
  const { catalog, upload } = await fixture(t);
  await upload(
    zipFixture([
      { name: 'juh.def', data: '[Info]\nname = juh\n[Files]\nsprite = juh.sff\n' },
      { name: 'juh_older.def', data: '[Info]\nname = juh\n[Files]\nsprite = juh.sff\n' },
      { name: 'juh.sff', data: spriteFixture },
    ]),
    'characters',
    'juh-release.zip',
  );
  assert.deepEqual(catalog.characters(), [{ path: 'juh-release/juh.def', name: 'juh' }]);
});

test('MUGEN imports stage assets from a ZIP retaining the stages/ prefix', async (t) => {
  const { root, catalog, upload } = await fixture(t);
  const buffer = zipFixture([
    {
      name: 'stages/night.def',
      data: '[Info]\nname = Night\n[BGdef]\nspr = stages/night.sff\n[Music]\nbgmusic = sound/night.ogg\n',
    },
    { name: 'stages/night.sff', data: spriteFixture },
    { name: 'sound/night.ogg', data: 'optional music' },
  ]);
  await upload(buffer, 'stages', 'night.zip');
  assert.deepEqual(catalog.stages(), [{ path: 'night/stages/night.def', name: 'Night' }]);
  const text = await readFile(join(root, 'Stages/night/stages/night.def'), 'utf8');
  assert.match(text, /spr = "night.sff"/);
  assert.match(text, /bgmusic = "..\/sound\/night.ogg"/);
});

test('MUGEN never overwrites an installed pack, including a case alias', async (t) => {
  const { root, upload } = await fixture(t);
  await mkdir(join(root, 'Characters/HERO'), { recursive: true });
  await writeFile(join(root, 'Characters/HERO/existing.txt'), 'untouched');
  await assert.rejects(upload(characterPack()), (error) => error.status === 409);
  assert.equal(await readFile(join(root, 'Characters/HERO/existing.txt'), 'utf8'), 'untouched');
  assert.ok(!(await readdir(root)).some((name) => name.startsWith('.incoming-')));
});

test('MUGEN refuses traversal, Windows aliases, links, duplicate names and executable web files', async (t) => {
  const { root, upload } = await fixture(t);
  for (const files of [
    [{ name: '../outside.txt', data: 'bad' }],
    [{ name: '/absolute.txt', data: 'bad' }],
    [{ name: 'C:/outside.txt', data: 'bad' }],
    [{ name: 'file.txt:stream', data: 'bad' }],
    [{ name: 'NUL.txt', data: 'bad' }],
    [{ name: 'file.txt ', data: 'bad' }],
    [{ name: 'link.txt', data: '../outside', mode: 0xa1ff }],
    [
      { name: 'a.txt', data: 'one' },
      { name: 'A.txt', data: 'two' },
    ],
    [{ name: 'payload.html', data: '<script>bad()</script>' }],
    [{ name: 'payload.js', data: 'bad()' }],
  ])
    await assert.rejects(upload(zipFixture(files)), (error) => error.status === 400);
  assert.deepEqual(await readdir(root), []);
});

test('MUGEN refuses missing definitions/assets, wrong sprite signatures and corrupt archives', async (t) => {
  const { root, upload } = await fixture(t);
  for (const buffer of [
    Buffer.from('not a zip'),
    zipFixture([{ name: 'readme.txt', data: 'no fighter' }]),
    zipFixture([{ name: 'hero.def', data: '[Files]\nsprite = missing.sff\n' }]),
    zipFixture([
      { name: 'hero.def', data: '[Files]\nsprite = hero.sff\n' },
      { name: 'hero.sff', data: 'invalid' },
    ]),
    zipFixture([
      { name: 'hero.def', data: '[Files]\nsprite = hero.sff\n', crc: 0 },
      { name: 'hero.sff', data: spriteFixture },
    ]),
  ])
    await assert.rejects(upload(buffer), (error) => error.status === 400);
  assert.deepEqual(await readdir(root), []);
});

test('MUGEN bounds decompression and rejects uploads that were cancelled before publication', async (t) => {
  const { root, upload } = await fixture(t);
  await assert.rejects(
    upload(zipFixture([{ name: 'huge.sff', data: 'small', size: PACK_LIMITS.file + 1 }])),
    (error) => error.status === 413,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(upload(characterPack(), 'characters', 'hero.zip', controller.signal), {
    name: 'AbortError',
  });
  assert.deepEqual(await readdir(root), []);
  for (const [kind, name] of [
    ['invalid', 'hero.zip'],
    ['characters', '../hero.zip'],
    ['characters', 'hero.rar'],
  ])
    await assert.rejects(upload(characterPack(), kind, name), (error) => error.status === 400);
});
