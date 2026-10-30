import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GbRoom } from '../server/room.mjs';
import { MBC, RTC_REG } from '../server/rtc.js';

/** Minimal MBC3 chip: RAM/RTC enable, register select, latch, data port. */
function mbc3() {
  const live = { second: 0, minute: 0, hour: 0, dayLow: 0, dayHigh: 0 };
  const latched = { ...live };
  const keys = ['second', 'minute', 'hour', 'dayLow', 'dayHigh'];
  let enabled = false;
  let select = 0;
  return {
    live,
    async write8(address, value) {
      if (address === MBC.ENABLE) enabled = value === 0x0a;
      else if (address === MBC.SELECT) select = value;
      else if (address === MBC.LATCH && value === 0x01) Object.assign(latched, live);
      else if (
        address === MBC.DATA &&
        enabled &&
        select >= RTC_REG.second &&
        select <= RTC_REG.dayHigh
      ) {
        const key = keys[select - RTC_REG.second];
        latched[key] = value;
        live[key] = value;
      }
    },
    async read8(address) {
      if (address === 0x147) return 0x10;
      if (address !== MBC.DATA || !enabled) return 0;
      if (select < RTC_REG.second || select > RTC_REG.dayHigh) return 0;
      return latched[keys[select - RTC_REG.second]];
    },
  };
}

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

test('L and R reach the core on an Advance cartridge and nowhere else', async () => {
  const holds = [];
  const advanced = core('AGB');
  advanced.controls.hold = async (buttons) => holds.push(...buttons);
  const advance = await GbRoom.create(
    'test.gba',
    options(async () => advanced),
  );
  advance.addPlayer(1, 'First', 'red');
  advance.input(1, 'l', true);
  advance.input(1, 'r', true);
  await advance.applyInput();
  assert.deepEqual(holds, ['L', 'R']);
  await advance.stop();

  const classic = await GbRoom.create(
    'test.gb',
    options(async () => core('DMG')),
  );
  classic.addPlayer(1, 'First', 'red');
  classic.input(1, 'l', true);
  classic.input(1, 'r', true);
  assert.deepEqual([...classic.mergedInput()], []);
  await classic.stop();
});

test('a battery clock is restored at boot and stored before the core closes', async (context) => {
  const dir = await mkdtemp(join(tmpdir(), 'gb-clock-'));
  context.after(() => rm(dir, { recursive: true, force: true }));
  const romPath = join(dir, 'pokemon.gbc');
  const sidecar = join(dir, 'pokemon.rtc.json');
  // The room stopped one hour ago with 1000 s on the cartridge clock.
  await writeFile(sidecar, JSON.stringify({ seconds: 1000, at: Date.now() - 3600_000 }));

  const chip = mbc3();
  const emulator = {
    ...core(),
    romInfo: { title: 'Pokemon', model: 'DMG', hasRtc: true },
    memory: chip,
    states: { save: async () => 'snapshot', restore: async () => true },
  };
  const room = await GbRoom.create(
    romPath,
    options(async () => emulator),
  );

  // Boot: the clock was projected forward by the hour spent offline.
  const expected = 1000 + 3600;
  const restored =
    chip.live.dayLow * 86400 + chip.live.hour * 3600 + chip.live.minute * 60 + chip.live.second;
  assert.ok(
    Math.abs(restored - expected) <= 2,
    `clock should be around ${expected} s, got ${restored} s`,
  );

  // Stop: the elapsed time (not the wall clock) is what gets stored.
  const before = Date.now();
  await room.stop();
  const stored = JSON.parse(await readFile(sidecar, 'utf8'));
  assert.ok(Math.abs(stored.seconds - expected) <= 2, `stored ${stored.seconds}`);
  assert.ok(stored.at >= before, 'the timestamp is fresh');
});

test('a GBA RTC never receives MBC3 memory commands', async () => {
  let writes = 0;
  const emulator = {
    ...core('AGB'),
    romInfo: { model: 'AGB', hasRtc: true },
    memory: {
      write8: async () => {
        writes++;
      },
    },
  };
  const room = await GbRoom.create(
    'advance.gba',
    options(async () => emulator),
  );
  await room.stop();
  assert.equal(writes, 0);
  assert.equal(emulator.closed, 1);
});

test('a failed clock snapshot restore halts emulation but still allows terminal cleanup', async () => {
  const emulator = {
    ...core(),
    romInfo: { model: 'DMG', hasRtc: true },
    memory: mbc3(),
    states: { save: async () => 'snapshot', restore: async () => false },
  };
  const warnings = [];
  const room = await GbRoom.create(
    'clock.gb',
    options(async () => emulator, { logger: { warn: (...args) => warnings.push(args) } }),
  );
  room.running = true;
  await room.saveClock();
  assert.equal(room.running, false);
  assert.equal(warnings.length, 1);
  await room.stop();
  assert.equal(emulator.closed, 1);
});
