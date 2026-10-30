import assert from 'node:assert/strict';
import test from 'node:test';
import { bindVolumeControls, createAudioControl, readVolumes } from '../client/volume.js';

test('MUGEN volume controls apply both sliders live, remember preferences and release listeners', () => {
  const bgm = Object.assign(new EventTarget(), { value: '50' });
  const sfx = Object.assign(new EventTarget(), { value: '50' });
  const elements = { 'fg-bgm-slider': bgm, 'fg-sfx-slider': sfx };
  const document = { getElementById: (id) => elements[id] };
  const saved = new Map([
    ['mugen.volume.bgm', '25'],
    ['mugen.volume.sfx', '75'],
  ]);
  const storage = {
    getItem: (key) => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, value),
  };
  const cleanup = [],
    applied = [];
  const scope = {
    on(target, event, listener) {
      target.addEventListener(event, listener);
      cleanup.push(() => target.removeEventListener(event, listener));
    },
  };
  bindVolumeControls(scope, (values) => applied.push(values), { document, storage });
  assert.deepEqual(readVolumes(document), { bgm: 25, sfx: 75 });
  bgm.value = '0';
  bgm.dispatchEvent(new Event('input'));
  sfx.value = '100';
  sfx.dispatchEvent(new Event('change'));
  assert.deepEqual(applied, [
    { bgm: 0, sfx: 75 },
    { bgm: 0, sfx: 100 },
  ]);
  assert.equal(saved.get('mugen.volume.bgm'), '0');
  cleanup.forEach((stop) => stop());
  bgm.dispatchEvent(new Event('input'));
  assert.equal(applied.length, 2);
});

test('MUGEN audio settings remain independent and clamp invalid slider values', () => {
  const host = createAudioControl({ bgm: 30, sfx: 40 });
  const spectator = createAudioControl({ bgm: 10, sfx: 20 });
  host.setVolume({ bgm: 0 });
  host.setVolume({ sfx: 999 });
  assert.deepEqual(host.state, { bgm: 0, sfx: 100, revision: 2 });
  assert.deepEqual(spectator.state, { bgm: 10, sfx: 20, revision: 0 });
  host.setVolume({ bgm: NaN, sfx: -20 });
  assert.deepEqual(host.state, { bgm: 0, sfx: 0, revision: 3 });
  assert.deepEqual(readVolumes({ getElementById: () => null }), { bgm: 20, sfx: 20 });
});
