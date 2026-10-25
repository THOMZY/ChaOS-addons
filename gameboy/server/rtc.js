/**
 * Cartridge real-time clock (MBC3 + battery).
 *
 * The emulated clock follows the host clock while the emulator runs, but it
 * starts again from zero on every load: the elapsed time is not part of the
 * .sav. We keep that elapsed time in a small sidecar file next to the save,
 * project it forward by the wall time spent offline and write it back into the
 * RTC registers at boot — which is what the battery of the original cartridge
 * did. Writes go through the MBC3 registers, so the game sees them exactly like
 * a cartridge that kept counting.
 */
import { readFile, rename, rm, writeFile } from 'node:fs/promises';

export const RTC_SECONDS_PER_DAY = 86400;
/** MBC3 keeps a 9-bit day counter. */
export const RTC_DAY_WRAP = 512;
export const RTC_SPAN = RTC_DAY_WRAP * RTC_SECONDS_PER_DAY;

/** MBC3 registers: RAM/RTC enable, register select, RTC latch. */
export const MBC = { ENABLE: 0x0000, SELECT: 0x4000, LATCH: 0x6000, DATA: 0xa000 };
export const RTC_REG = { second: 0x08, minute: 0x09, hour: 0x0a, dayLow: 0x0b, dayHigh: 0x0c };

/** `<game>.gb` -> `<game>.rtc.json`, next to the battery save. */
export function rtcSidecarPath(romPath) {
  return String(romPath).replace(/\.[^./\\]+$/, '') + '.rtc.json';
}

export function normalizeRtcSeconds(total) {
  const value = Math.floor(Number(total) || 0);
  return ((value % RTC_SPAN) + RTC_SPAN) % RTC_SPAN;
}

/** Cartridge time at boot: what was stored, plus the time spent offline. */
export function projectRtc(state, wallNow = Date.now()) {
  const seconds = Number(state?.seconds);
  if (!Number.isFinite(seconds)) return 0;
  const at = Number(state?.at);
  const elapsed = !state?.isHalted && Number.isFinite(at) ? Math.max(0, wallNow - at) / 1000 : 0;
  return normalizeRtcSeconds(seconds + elapsed);
}

export function projectRtcState(state, wallNow = Date.now()) {
  const elapsed =
    !state?.isHalted && Number.isFinite(state?.at) ? Math.max(0, wallNow - state.at) / 1000 : 0;
  return {
    seconds: projectRtc(state, wallNow),
    isHalted: state?.isHalted === true,
    hasCarry: state?.hasCarry === true || Number(state?.seconds) + elapsed >= RTC_SPAN,
  };
}

export function partsFromRtc(total) {
  const value = normalizeRtcSeconds(total);
  const day = Math.floor(value / RTC_SECONDS_PER_DAY);
  const rest = value - day * RTC_SECONDS_PER_DAY;
  return {
    second: rest % 60,
    minute: Math.floor(rest / 60) % 60,
    hour: Math.floor(rest / 3600) % 24,
    day,
  };
}

export function rtcFromParts({ second = 0, minute = 0, hour = 0, day = 0 } = {}) {
  return normalizeRtcSeconds(day * RTC_SECONDS_PER_DAY + hour * 3600 + minute * 60 + second);
}

/** Latch, then read the five RTC registers as a number of elapsed seconds. */
export async function readRtc(memory) {
  return (await readRtcState(memory)).seconds;
}

async function readRtcState(memory) {
  await memory.write8(MBC.LATCH, 0x00);
  await memory.write8(MBC.LATCH, 0x01);
  await memory.write8(MBC.ENABLE, 0x0a);
  const value = [];
  for (const register of [
    RTC_REG.second,
    RTC_REG.minute,
    RTC_REG.hour,
    RTC_REG.dayLow,
    RTC_REG.dayHigh,
  ]) {
    await memory.write8(MBC.SELECT, register);
    value.push(await memory.read8(MBC.DATA));
  }
  await memory.write8(MBC.SELECT, 0x00);
  const seconds = rtcFromParts({
    second: value[0],
    minute: value[1],
    hour: value[2],
    day: ((value[4] & 1) << 8) | value[3],
  });
  return { seconds, isHalted: (value[4] & 0x40) !== 0, hasCarry: (value[4] & 0x80) !== 0 };
}

/** MBC registers are write-only: restore a snapshot instead of guessing the active bank. */
export async function readRtcSnapshot(core) {
  const snapshot = await core.states.save();
  let state, readError;
  try {
    state = await readRtcState(core.memory);
  } catch (error) {
    readError = error;
  }
  try {
    if (!(await core.states.restore(snapshot))) throw new Error('snapshot_refused');
  } catch (cause) {
    throw new Error('gameboy_clock_snapshot_restore_failed', { cause });
  }
  if (readError) throw readError;
  return state;
}

/** Write an elapsed time into the clock; the core keeps counting from there. */
export async function writeRtc(memory, total, state) {
  const { second, minute, hour, day } = partsFromRtc(total);
  // Latch first: the data port serves the latched snapshot, and the halt and
  // carry bits of the day register live there too.
  await memory.write8(MBC.LATCH, 0x00);
  await memory.write8(MBC.LATCH, 0x01);
  await memory.write8(MBC.ENABLE, 0x0a);
  await memory.write8(MBC.SELECT, RTC_REG.dayHigh);
  const flags = state
    ? (state.isHalted ? 0x40 : 0) | (state.hasCarry ? 0x80 : 0)
    : await memory.read8(MBC.DATA);
  const registers = [
    [RTC_REG.second, second],
    [RTC_REG.minute, minute],
    [RTC_REG.hour, hour],
    [RTC_REG.dayLow, day & 0xff],
    [RTC_REG.dayHigh, (flags & 0xc0) | ((day >> 8) & 1)],
  ];
  for (const [register, value] of registers) {
    await memory.write8(MBC.SELECT, register);
    await memory.write8(MBC.DATA, value);
  }
  await memory.write8(MBC.SELECT, 0x00);
}

export async function loadRtcState(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    return Number.isFinite(Number(parsed?.seconds))
      ? {
          seconds: normalizeRtcSeconds(parsed.seconds),
          at: Number(parsed.at) || 0,
          isHalted: parsed.isHalted === true,
          hasCarry: parsed.hasCarry === true,
        }
      : null;
  } catch {
    // Missing or invalid sidecars are treated like a cartridge with a new battery.
    return null;
  }
}

export async function saveRtcState(file, state) {
  const pendingFile = file + '.pending';
  try {
    await writeFile(
      pendingFile,
      JSON.stringify({
        seconds: normalizeRtcSeconds(state.seconds),
        at: Math.round(state.at),
        isHalted: state.isHalted === true,
        hasCarry: state.hasCarry === true,
      }) + '\n',
    );
    await rename(pendingFile, file);
  } finally {
    await rm(pendingFile, { force: true });
  }
}
