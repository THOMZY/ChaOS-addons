import assert from 'node:assert/strict';
import test from 'node:test';
import { GbRoom } from '../server/room.mjs';

function core(model = 'DMG') {
  let capture;
  return {
    romInfo: { title: model, model },
    closed: 0,
    diagnostics: {
      onAudioChunk(callback) {
        capture = callback;
      },
    },
    audio: (value) => capture(value),
    controls: {
      async hold() {},
      async release() {},
      async tick() {
        return {
          width: model === 'AGB' ? 240 : 160,
          height: model === 'AGB' ? 160 : 144,
          strideBytes: (model === 'AGB' ? 240 : 160) * 4,
          frameIndex: 1,
          buffer: Buffer.alloc((model === 'AGB' ? 240 * 160 : 160 * 144) * 4, 255),
        };
      },
    },
    async close() {
      this.closed++;
    },
  };
}

function options(loadCore, extra = {}) {
  return {
    loadCore,
    createResampler: () => ({ process: (chunk) => chunk, reset() {} }),
    createEncoder: () => ({ encode: () => Buffer.from([1]), reset() {}, drop() {} }),
    ...extra,
  };
}

test('GBA frames retain their complete 240 by 160 geometry', async () => {
  const emulator = core('AGB');
  const room = await GbRoom.create(
    'test.gba',
    options(async () => emulator),
  );
  room.running = true;
  await room.step();
  assert.equal(room.width, 240);
  assert.equal(room.height, 160);
  assert.equal(room.indices.length, 240 * 160);
  await room.stop();
  assert.equal(emulator.closed, 1);
});

test('failed replacement preserves the current core and terminal stop closes it once', async () => {
  const emulator = core();
  const room = await GbRoom.create(
    'first.gb',
    options(async (path) => {
      if (path === 'broken.gb') throw new Error('invalid ROM');
      return emulator;
    }),
  );
  await assert.rejects(room.switchRom('broken.gb'), /invalid ROM/);
  assert.equal(room.romPath, 'first.gb');
  assert.equal(emulator.closed, 0);
  await room.stop();
  await room.stop();
  assert.equal(emulator.closed, 1);
  await assert.rejects(room.switchRom('next.gb'), /stopped/);
});

test('PCM fallback receives every captured sample even before an Opus packet is ready', async () => {
  const emulator = core();
  const audio = [];
  const room = await GbRoom.create(
    'test.gb',
    options(async () => emulator, { onAudio: (...args) => audio.push(args) }),
  );
  room.running = true;
  const buffer = Buffer.alloc(400);
  buffer.writeInt16LE(1200, 0);
  emulator.audio({ buffer });
  await room.step();
  assert.equal(audio.length, 1);
  assert.equal(audio[0][2].length, 200);
  await room.stop();
});

test('shared input merges players, cancels opposites and ignores malformed button values', async () => {
  const room = await GbRoom.create(
    'test.gb',
    options(async () => core()),
  );
  room.addPlayer(1, 'First', 'red');
  room.addPlayer(2, 'Second', 'blue');
  room.input(1, 'a', true);
  room.input(2, 'a', true);
  room.input(1, 'up', true);
  room.input(2, 'down', true);
  room.input(1, { toString: 'invalid' }, true);
  assert.deepEqual([...room.mergedInput()], ['a']);
  room.removePlayer(1);
  assert.deepEqual([...room.mergedInput()].sort(), ['a', 'down']);
  await room.stop();
});
