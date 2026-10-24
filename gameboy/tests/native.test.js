import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GbRoom } from '../server/room.mjs';
import { buildDiagnosticRom } from './fixtures/diagnostic-rom.mjs';

test(
  'the real native mGBA core boots GB, GBC and GBA diagnostics, emits frames/audio and closes',
  { timeout: 15000 },
  async (context) => {
    const directory = await mkdtemp(join(tmpdir(), 'chaos-native-gameboy-'));
    context.after(() => rm(directory, { recursive: true, force: true }));
    for (const [model, extension] of [
      ['DMG', 'gb'],
      ['CGB', 'gbc'],
      ['AGB', 'gba'],
    ]) {
      const path = join(directory, `diagnostic.${extension}`);
      await writeFile(path, buildDiagnosticRom(model));
      let frames = 0,
        audioPackets = 0;
      const room = await GbRoom.create(path, {
        onFrame: () => frames++,
        onAudio: (_frame, packets) => {
          audioPackets += packets.length;
        },
      });
      context.after(() => room.stop());
      room.running = true;
      for (let frame = 0; frame < 5; frame++) await room.step();
      assert.equal(frames, 5);
      assert.equal(room.width, model === 'AGB' ? 240 : 160);
      assert.equal(room.height, model === 'AGB' ? 160 : 144);
      assert.ok(audioPackets > 0, `${model} produces encoded audio samples`);
      await room.stop();
      assert.equal(room.status().isStopped, true);
      const reopened = await GbRoom.create(path);
      reopened.running = true;
      await reopened.step();
      await reopened.stop();
    }
  },
);
