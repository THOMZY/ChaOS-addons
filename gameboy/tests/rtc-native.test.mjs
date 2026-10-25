import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mgba } from 'node-mgba';
import { buildDiagnosticRom } from './fixtures/diagnostic-rom.mjs';
import { MBC, readRtcSnapshot, writeRtc } from '../server/rtc.js';

test(
  'reading the native MBC3 clock preserves SRAM bank and enable state',
  { timeout: 15000 },
  async (context) => {
    const directory = await mkdtemp(join(tmpdir(), 'chaos-rtc-native-'));
    let core;
    context.after(async () => {
      await core?.close();
      await rm(directory, { recursive: true, force: true });
    });
    const rom = buildDiagnosticRom();
    rom[0x147] = 0x10;
    rom[0x149] = 3;
    let checksum = 0;
    for (let index = 0x134; index <= 0x14c; index++) checksum -= rom[index] + 1;
    rom[0x14d] = checksum & 255;
    const path = join(directory, 'rtc.gb');
    await writeFile(path, rom);
    core = await Mgba.load(path);
    await writeRtc(core.memory, 12345);
    await core.memory.write8(MBC.SELECT, 2);
    await core.memory.write8(MBC.DATA, 77);
    assert.equal(await core.memory.read8(MBC.DATA), 77);
    const clock = await readRtcSnapshot(core);
    assert.equal(clock.seconds, 12345);
    assert.equal(await core.memory.read8(MBC.DATA), 77, 'bank 2 must remain selected');
    await core.memory.write8(MBC.ENABLE, 0);
    const disabledValue = await core.memory.read8(MBC.DATA);
    await readRtcSnapshot(core);
    assert.equal(await core.memory.read8(MBC.DATA), disabledValue, 'disabled SRAM stays disabled');
  },
);
