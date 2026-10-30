import assert from 'node:assert/strict';
import test from 'node:test';

import { VOL_MIN_DB, gainFromVolume } from '../client/volume.js';

const dB = (gain) => (gain > 0 ? 20 * Math.log10(gain) : -Infinity);

test('silence at 0 and full scale at 100', () => {
  assert.equal(gainFromVolume(0), 0);
  assert.equal(gainFromVolume(100), 1);
});

test('1 % is far below the old linear value', () => {
  const log = gainFromVolume(1);
  assert.ok(log < 0.005, `1 % should be near -48 dB, got ${log}`);
  assert.ok(log < 0.1 / 10, 'log taper must be much quieter than 1/100');
  assert.equal(Number(dB(log).toFixed(1)), -47.5);
});

test('the curve is logarithmic: equal steps multiply by an equal factor', () => {
  const ratios = [];
  for (let v = 10; v < 100; v += 10) ratios.push(gainFromVolume(v + 10) / gainFromVolume(v));
  const expected = 10 ** (VOL_MIN_DB / -200); // -48 dB spread over 10 steps
  for (const r of ratios) assert.ok(Math.abs(r - expected) < 1e-9, `ratio ${r} != ${expected}`);
  assert.ok(expected > 1.5 && expected < 2, `each 10 % should roughly double, got ${expected}`);
});

test('the curve is monotonic and stays inside 0…1', () => {
  let previous = -1;
  for (let v = 0; v <= 100; v += 1) {
    const g = gainFromVolume(v);
    assert.ok(g >= 0 && g <= 1, `gain out of range at ${v}: ${g}`);
    assert.ok(g > previous, `gain must grow at ${v}`);
    previous = g;
  }
});

test('out of range and garbage input are clamped', () => {
  assert.equal(gainFromVolume(-20), 0);
  assert.equal(gainFromVolume(140), 1);
  assert.equal(gainFromVolume(Number.NaN), 0);
  assert.equal(gainFromVolume('50'), gainFromVolume(50));
});

test('halving the slider is not halving the loudness', () => {
  // 50 % sits at -24 dB: quiet enough for background play, still audible.
  assert.equal(Number(dB(gainFromVolume(50)).toFixed(1)), -24);
});
