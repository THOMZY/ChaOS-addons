import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MBC,
  RTC_DAY_WRAP,
  RTC_REG,
  normalizeRtcSeconds,
  loadRtcState,
  partsFromRtc,
  projectRtc,
  projectRtcState,
  readRtcSnapshot,
  readRtc,
  rtcFromParts,
  rtcSidecarPath,
  saveRtcState,
  writeRtc,
} from '../server/rtc.js';

/** Minimal MBC3: RAM/RTC enable, register select, latch, data port. */
function fakeMbc3() {
  const live = { second: 0, minute: 0, hour: 0, dayLow: 0, dayHigh: 0 };
  const latched = { ...live };
  const ram = new Uint8Array(4 * 8192);
  const state = { enabled: false, select: 0, bank: 0, halt: false, carry: false };
  return {
    state,
    ram,
    live,
    async write8(address, value) {
      if (address === MBC.ENABLE) state.enabled = value === 0x0a;
      else if (address === MBC.SELECT) state.select = value;
      else if (address === MBC.LATCH) {
        if (value === 0x01) Object.assign(latched, live);
      } else if (address === MBC.DATA && state.enabled) {
        if (state.select >= RTC_REG.second && state.select <= RTC_REG.dayHigh) {
          const key = ['second', 'minute', 'hour', 'dayLow', 'dayHigh'][
            state.select - RTC_REG.second
          ];
          latched[key] = value;
          live[key] = value;
        } else ram[state.select * 8192] = value;
      }
    },
    async read8(address) {
      if (address !== MBC.DATA) return 0;
      if (!state.enabled) return 0xff;
      if (state.select >= RTC_REG.second && state.select <= RTC_REG.dayHigh) {
        const key = ['second', 'minute', 'hour', 'dayLow', 'dayHigh'][
          state.select - RTC_REG.second
        ];
        return latched[key];
      }
      return ram[state.select * 8192];
    },
  };
}

test('the sidecar sits next to the save file', () => {
  assert.equal(rtcSidecarPath('C:/data/Pokemon Argent.gbc'), 'C:/data/Pokemon Argent.rtc.json');
  assert.equal(rtcSidecarPath('/data/Super Mario Land.gb'), '/data/Super Mario Land.rtc.json');
});

test('seconds and MBC3 parts round-trip', () => {
  for (const seconds of [0, 1, 59, 60, 3599, 86399, 86400, 12 * 86400 + 9 * 3600 + 30 * 60 + 50]) {
    assert.equal(rtcFromParts(partsFromRtc(seconds)), seconds);
  }
  assert.deepEqual(partsFromRtc(0), { second: 0, minute: 0, hour: 0, day: 0 });
  assert.deepEqual(partsFromRtc(12 * 86400 + 9 * 3600 + 30 * 60 + 50), {
    second: 50,
    minute: 30,
    hour: 9,
    day: 12,
  });
});

test('the 9-bit day counter wraps like the real chip', () => {
  const span = RTC_DAY_WRAP * 86400;
  assert.equal(normalizeRtcSeconds(span), 0);
  assert.equal(normalizeRtcSeconds(span + 90), 90);
  assert.equal(normalizeRtcSeconds(-90), span - 90);
  assert.equal(partsFromRtc(normalizeRtcSeconds(span + 5)).day, 0);
});

test('a restart projects the stored clock forward by the time spent offline', () => {
  const saved = { seconds: 1000, at: 1_700_000_000_000 };
  assert.equal(projectRtc(saved, 1_700_000_000_000), 1000, 'no time offline');
  assert.equal(projectRtc(saved, 1_700_000_060_000), 1060, 'one minute offline');
  assert.equal(projectRtc(saved, 1_700_086_400_000), 1000 + 86400, 'one day offline');
  assert.equal(projectRtc(null, 1_700_000_000_000), 0, 'no sidecar: like a dead battery');
  assert.equal(projectRtc({ seconds: 5 }, 1_700_000_059_000), 5, 'missing timestamp is ignored');
});

test('writeRtc then readRtc gives the same time back', async () => {
  const memory = fakeMbc3();
  const target = 12 * 86400 + 9 * 3600 + 30 * 60 + 50;
  await writeRtc(memory, target);
  assert.equal(await readRtc(memory), target);
  assert.deepEqual(memory.live, { second: 50, minute: 30, hour: 9, dayLow: 12, dayHigh: 0 });
});

test('writeRtc keeps the halt and carry flags of the chip', async () => {
  const memory = fakeMbc3();
  memory.live.dayHigh = 0xc1; // halt + carry + day bit 8
  await writeRtc(memory, 60);
  assert.equal(memory.live.dayHigh & 0xc0, 0xc0, 'halt/carry preserved');
  assert.equal(memory.live.dayHigh & 1, 0, 'day bit 8 cleared for a small counter');
});

test('the RTC registers leave the chip on RAM bank 0, so saves still work', async () => {
  const memory = fakeMbc3();
  await writeRtc(memory, 500);
  await memory.write8(MBC.DATA, 0x99);
  assert.equal(memory.ram[0], 0x99, 'SRAM writes still land in bank 0');
  await readRtc(memory);
  assert.equal(await memory.read8(MBC.DATA), 0x99, 'and reads too');
});

test('a day counter above 255 uses the ninth bit', async () => {
  const memory = fakeMbc3();
  const target = 300 * 86400 + 3600; // day 300
  await writeRtc(memory, target);
  assert.equal(memory.live.dayHigh & 1, 1);
  assert.equal(memory.live.dayLow, 300 & 0xff);
  assert.equal(await readRtc(memory), target);
});

test('a halted clock stays halted offline and a wrapped clock keeps its carry flag', () => {
  assert.deepEqual(
    projectRtcState({ seconds: 60, at: 1000, isHalted: true, hasCarry: true }, 90000),
    { seconds: 60, isHalted: true, hasCarry: true },
  );
  assert.deepEqual(projectRtcState({ seconds: RTC_DAY_WRAP * 86400 - 10, at: 1000 }, 21000), {
    seconds: 10,
    isHalted: false,
    hasCarry: true,
  });
});

test('restoring a clock applies its persisted halt and carry flags', async () => {
  const memory = fakeMbc3();
  await writeRtc(memory, 60, { isHalted: true, hasCarry: true });
  assert.equal(memory.live.dayHigh, 0xc0);
});

test('clock sampling restores the core even when reading the bus fails', async () => {
  const snapshot = { id: 'before-read' };
  let restored = null;
  const core = {
    memory: {
      write8: async () => {
        throw new Error('read_failed');
      },
    },
    states: {
      save: async () => snapshot,
      restore: async (state) => {
        restored = state;
        return true;
      },
    },
  };
  await assert.rejects(readRtcSnapshot(core), /read_failed/);
  assert.equal(restored, snapshot);
});

test('a refused snapshot restore is surfaced so the room cannot keep emulating corrupted state', async () => {
  const core = {
    memory: fakeMbc3(),
    states: { save: async () => 'saved', restore: async () => false },
  };
  await assert.rejects(readRtcSnapshot(core), /gameboy_clock_snapshot_restore_failed/);
});

test('sidecar replacement preserves clock flags and reads legacy files', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'chaos-rtc-sidecar-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'clock.rtc.json');
  await writeFile(file, JSON.stringify({ seconds: 100, at: 1000 }));
  assert.deepEqual(await loadRtcState(file), {
    seconds: 100,
    at: 1000,
    isHalted: false,
    hasCarry: false,
  });
  const state = { seconds: 200, at: 2000, isHalted: true, hasCarry: true };
  await saveRtcState(file, state);
  assert.deepEqual(await loadRtcState(file), state);
  await assert.rejects(readFile(file + '.pending'), { code: 'ENOENT' });
});
