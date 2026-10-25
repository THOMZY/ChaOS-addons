import test from 'node:test';
import assert from 'node:assert/strict';
import { createWormsCatalog } from '../client/worms-catalog.js';
const createCatalog = () => createWormsCatalog({ translate: (key) => 'label:' + key });

test('world geometry, water, radius, turn duration and asset URL retain their values', () => {
  const catalog = createCatalog();
  assert.deepEqual(catalog.world, {
    width: 960,
    height: 480,
    waterY: 455,
    wormRadius: 10,
    turnMs: 30000,
  });
  assert.equal(catalog.assetsBase, '/worms-assets');
});
test('the five levels keep their authoritative order and files', () => {
  const catalog = createCatalog();
  assert.deepEqual(
    catalog.levels.map((level) => [level.name, level.file]),
    [
      ['Treasure', 'level2'],
      ['Jungle', 'castles'],
      ['Ruins', 'level3'],
      ['Battleship', 'level5'],
      ['Titanic', 'level20'],
    ],
  );
  assert.equal(catalog.levels.at(-1).stars, true);
  assert.equal(catalog.levels[0].skyB, '#89216b');
});
test('weapons, animations and icons describe the same seventeen weapons', () => {
  const catalog = createCatalog(),
    keys = Object.keys(catalog.weapons);
  assert.equal(keys.length, 17);
  assert.deepEqual(Object.keys(catalog.weaponAnimations), keys);
  assert.deepEqual(Object.keys(catalog.weaponIcons), keys);
  assert.deepEqual(keys, [
    'bazooka',
    'hand_grenade',
    'cluster_bomb',
    'shotgun',
    'minigun',
    'mortar',
    'airstrike',
    'drill',
    'dynamite',
    'holy_grenade',
    'banana_bomb',
    'napalm',
    'land_mine',
    'ninja_rope',
    'jetpack',
    'bat',
    'teleport',
  ]);
});
test('weapon labels are translated on demand and preserve unknown-value fallbacks', () => {
  const catalog = createCatalog();
  assert.equal(catalog.getWeaponLabel('bazooka'), '🚀 label:games.worms.weapon.bazooka');
  assert.equal(catalog.getWeaponLabel('missing'), 'missing');
  assert.equal(catalog.getWeaponLabel(null), '?');
});
test('definition, animation and icon lookups reject inherited or non-string keys', () => {
  const catalog = createCatalog();
  for (const key of ['__proto__', 'constructor', 'missing', null, undefined, {}, 1])
    for (const lookup of [
      catalog.getWeaponDefinition,
      catalog.getWeaponAnimation,
      catalog.getWeaponIconName,
    ])
      assert.equal(lookup(key), null);
});
test('known lookups return the borrowed catalogue entries', () => {
  const catalog = createCatalog();
  assert.equal(catalog.getWeaponDefinition('bazooka'), catalog.weapons.bazooka);
  assert.equal(catalog.getWeaponAnimation('bazooka'), catalog.weaponAnimations.bazooka);
  assert.equal(catalog.getWeaponIconName('bazooka'), 'iconbazooka');
  assert.equal(catalog.getWeaponAnimation('drill').aim, null);
});
test('invalid level indexes fall back to the first level', () => {
  const catalog = createCatalog();
  for (const index of [-1, 5, 0.5, NaN, '1', undefined])
    assert.equal(catalog.getLevel(index), catalog.levels[0]);
  assert.equal(catalog.getLevel(4), catalog.levels[4]);
});
test('unlimited ammo preserves undefined, null and Infinity only', () => {
  const catalog = createCatalog();
  for (const value of [undefined, null, Infinity])
    assert.equal(catalog.hasUnlimitedAmmo(value), true);
  for (const value of [0, -1, 1, NaN, 'Infinity'])
    assert.equal(catalog.hasUnlimitedAmmo(value), false);
});
test('targeted weapons, adjustable fuses and fuse sounds keep distinct sets', () => {
  const catalog = createCatalog();
  assert.deepEqual([...catalog.targetedWeapons], ['airstrike', 'napalm']);
  assert.deepEqual([...catalog.fuseWeapons], ['hand_grenade', 'cluster_bomb', 'banana_bomb']);
  assert.deepEqual(
    [...catalog.fuseSoundWeapons],
    ['hand_grenade', 'cluster_bomb', 'holy_grenade', 'banana_bomb'],
  );
});
test('catalogue instances preserve controller-local mutable data', () => {
  const first = createCatalog(),
    second = createCatalog();
  first.levels[0].skyB = 'changed';
  first.weapons.bazooka.color = 'changed';
  first.weaponAnimations.bazooka.aim.frames = 1;
  first.weaponIcons.bazooka = 'changed';
  first.fuseWeapons.clear();
  first.world.width = 1;
  assert.equal(second.levels[0].skyB, '#89216b');
  assert.equal(second.weapons.bazooka.color, '#ff7700');
  assert.equal(second.weaponAnimations.bazooka.aim.frames, 32);
  assert.equal(second.weaponIcons.bazooka, 'iconbazooka');
  assert.equal(second.fuseWeapons.size, 3);
  assert.equal(second.world.width, 960);
});
test('construction performs no translation or other deferred label work', () => {
  let reads = 0;
  const catalog = createWormsCatalog({
    translate: (key) => {
      reads++;
      return key;
    },
  });
  assert.equal(reads, 0);
  catalog.getWeaponLabel('bazooka');
  assert.equal(reads, 1);
});
