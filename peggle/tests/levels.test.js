import test from 'node:test';
import assert from 'node:assert/strict';

import { LEVELS, assignPegColors } from '../server/levels.js';

test('Peggle parses all untouched addon levels and object shapes', () => {
  assert.equal(LEVELS.length, 13);
  assert.equal(LEVELS[0].name, 'Ironforge');
  assert.equal(LEVELS[12].name, 'Sulfuron Spire');
  assert.equal(LEVELS[0].pegs.length, 91);

  assert.deepEqual(LEVELS[0].pegs[0], {
    x: 36.5, y: 382.5, shape: 'peg', animation: null,
  });
  assert.deepEqual(LEVELS[0].pegs[40], {
    x: 492.6, y: 109.5, shape: 'brick', rotation: 290,
    radiusKey: 180, animation: null,
  });
  assert.deepEqual(LEVELS[0].pegs[42], {
    x: 515.6, y: 120.1, shape: 'brick', rotation: 295,
    radiusKey: 0, animation: null,
  });
});

test('Peggle preserves the addon animation flags and phase', () => {
  assert.deepEqual(LEVELS[0].pegs[85].animation, {
    type: 1,
    duration: 5,
    phase: 0,
    pingPong: true,
    active: true,
    value1: 0,
    value2: 0,
    value3: 137,
    value4: 40,
  });

  const phased = LEVELS.flatMap(level => level.pegs)
    .find(object => object.animation?.phase === 0.75);
  assert.ok(phased, 'expected at least one 75% phased animated object');
});

test('Peggle color assignment keeps the classic object distribution', () => {
  const colored = assignPegColors(LEVELS[0].pegs, 12345);
  const counts = colored.reduce((all, peg) => {
    all[peg.type] = (all[peg.type] ?? 0) + 1;
    return all;
  }, {});

  assert.equal(counts.orange, 25);
  assert.equal(counts.green, 2);
  assert.equal(counts.purple, 1);
  assert.equal(counts.blue, LEVELS[0].pegs.length - 28);
});
