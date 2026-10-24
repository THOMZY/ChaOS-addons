import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeRle,
  renderIndexedFrame,
  tintMonochromePalette,
} from '../client/gameboy-frame-codec.js';

test('truncated, oversized or incomplete deltas never corrupt the retained frame', () => {
  for (const source of [[1], [0, 3], [5, 3], [3, 3]]) {
    const target = new Uint8Array([1, 2, 3, 4]);
    assert.equal(decodeRle(Uint8Array.from(source), target), false);
    assert.deepEqual([...target], [1, 2, 3, 4]);
  }
  const target = new Uint8Array(4);
  assert.equal(decodeRle(Uint8Array.from([2, 3, 2, 4]), target), true);
  assert.deepEqual([...target], [3, 3, 4, 4]);
});

test('indexed frames preserve colour and only neutral monochrome palettes are tinted', () => {
  const colours = [
    [255, 0, 0],
    [0, 255, 0],
  ];
  assert.equal(tintMonochromePalette(colours), colours);
  const output = new Uint8ClampedArray(8);
  assert.equal(renderIndexedFrame(Uint8Array.from([0, 1]), colours, output), true);
  assert.deepEqual([...output], [255, 0, 0, 255, 0, 255, 0, 255]);
  assert.notDeepEqual(
    tintMonochromePalette([
      [0, 0, 0],
      [255, 255, 255],
    ]),
    [
      [0, 0, 0],
      [255, 255, 255],
    ],
  );
});
