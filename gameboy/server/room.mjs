import { Mgba, PcmS16StereoResampler } from 'node-mgba';
import { Encoder as OpusEncoder } from '@evan/opus';
import {
  loadRtcState,
  projectRtcState,
  readRtcSnapshot,
  rtcSidecarPath,
  saveRtcState,
  writeRtc,
} from './rtc.js';

export const FPS = 59.7275;
export const FRAME_MS = 1000 / FPS;
export const W = 160,
  H = 144,
  AUDIO_RATE = 48000;
const KEY_INTERVAL = 120,
  OPUS_FRAME = 960;
const BTN = {
  a: 'A',
  b: 'B',
  start: 'Start',
  select: 'Select',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
};
const ALL = Object.keys(BTN);

export class GbRoom {
  static async create(path, options = {}) {
    const room = new GbRoom(path, options);
    try {
      await room.init();
      return room;
    } catch (error) {
      await room.stop();
      throw error;
    }
  }
  constructor(
    path,
    {
      onFrame = () => {},
      onAudio = () => {},
      loadCore = (path) => Mgba.load(path, { batterySavePath: true }),
      createResampler = () => new PcmS16StereoResampler({ targetSampleRate: AUDIO_RATE }),
      createEncoder = () =>
        new OpusEncoder({ channels: 1, sample_rate: AUDIO_RATE, application: 'audio' }),
      now = () => performance.now(),
      timers = { setTimeout, clearTimeout },
      logger = console,
    } = {},
  ) {
    this.romPath = path;
    this.onFrame = onFrame;
    this.onAudio = onAudio;
    this.loadCore = loadCore;
    this.now = now;
    this.timers = timers;
    this.logger = logger;
    this.players = new Map();
    this.held = new Set();
    this.frame = 0;
    this.tick = 0;
    this.running = false;
    this.clients = 0;
    this.power = true;
    this.isStopped = false;
    this.resampler = createResampler();
    this.opus = createEncoder();
    this.opus.bitrate = 32000;
    this.pcmAccum = Buffer.alloc(0);
    this.pcmQueue = [];
    this.audioQueue = [];
    this.audioReady = false;
    this.operation = Promise.resolve();
    this.loop = null;
    this.configureFrame(W, H);
    this.palette = [15, 56, 15, 48, 98, 48, 139, 172, 15, 155, 188, 15];
    this.rtcFile = rtcSidecarPath(path);
    this.rtcClock = false;
    this.rtcBusy = false;
    this.rtcSavedAt = 0;
  }
  configureFrame(width, height) {
    this.width = width;
    this.height = height;
    this.indices = new Uint8Array(width * height);
    this.xorBuf = new Uint8Array(width * height);
    this.prevPacked = null;
    this.needKey = true;
    this.sentColors = null;
  }
  configureCore(core, path) {
    this.emu = core;
    this.romPath = path;
    this.title = core.romInfo?.title || path.split(/[\\/]/).pop();
    this.model = core.romInfo?.model || 'DMG';
    this.mono = this.model === 'DMG';
    this.configureFrame(this.model === 'AGB' ? 240 : W, this.model === 'AGB' ? 160 : H);
    this.resampler.reset();
    this.opus.reset();
    this.pcmAccum = Buffer.alloc(0);
    this.pcmQueue = [];
    this.audioQueue = [];
    this.hookAudio(core);
    this.audioReady = true;
    this.rtcFile = rtcSidecarPath(path);
    // A cartridge with a battery clock (Pokemon Gold/Silver, Harvest Moon...).
    this.rtcClock = core.romInfo?.hasRtc === true && this.model !== 'AGB';
  }
  async init() {
    this.configureCore(await this.loadCore(this.romPath), this.romPath);
    await this.restoreClock();
  }
  /** Give the cartridge its elapsed time back, exactly like its battery did. */
  async restoreClock() {
    if (!this.rtcClock || !this.emu) return;
    try {
      // GBA and non-MBC3 clocks use other protocols; never write MBC3 commands there.
      const cartridgeType = await this.emu.memory.read8(0x147);
      if (cartridgeType !== 0x0f && cartridgeType !== 0x10) {
        this.rtcClock = false;
        return;
      }
      const state = projectRtcState(await loadRtcState(this.rtcFile), Date.now());
      await writeRtc(this.emu.memory, state.seconds, state);
      this.rtcSavedAt = Date.now();
    } catch (error) {
      this.logger.warn('[gameboy] clock restore failed:', error.message);
    }
  }
  /** Store the elapsed cartridge time: the .sav itself cannot hold it. */
  async saveClock() {
    if (!this.rtcClock || !this.emu || this.rtcBusy) return;
    this.rtcBusy = true;
    try {
      const state = await readRtcSnapshot(this.emu);
      await saveRtcState(this.rtcFile, { ...state, at: Date.now() });
      this.rtcSavedAt = Date.now();
    } catch (error) {
      this.logger.warn('[gameboy] clock save failed:', error.message);
      if (error.message === 'gameboy_clock_snapshot_restore_failed') {
        this.running = false;
        this.rtcClock = false;
      }
    } finally {
      this.rtcBusy = false;
    }
  }
  hookAudio(core) {
    core.diagnostics.onAudioChunk((chunk) => {
      if (!this.audioReady || this.isStopped || this.emu !== core) return;
      try {
        const pcm = Buffer.from(this.resampler.process(chunk).buffer);
        const mono = Buffer.alloc((pcm.length >> 2) * 2);
        for (let index = 0; index < mono.length / 2; index++)
          mono.writeInt16LE(
            Math.round((pcm.readInt16LE(index * 4) + pcm.readInt16LE(index * 4 + 2)) / 2),
            index * 2,
          );
        this.pcmQueue.push(mono);
        this.pcmAccum = Buffer.concat([this.pcmAccum, mono]);
        while (this.pcmAccum.length >= OPUS_FRAME * 2) {
          this.audioQueue.push(
            Buffer.from(this.opus.encode(this.pcmAccum.subarray(0, OPUS_FRAME * 2))),
          );
          this.pcmAccum = this.pcmAccum.subarray(OPUS_FRAME * 2);
        }
      } catch (error) {
        this.logger.warn('[gameboy] audio capture failed:', error.message);
      }
    });
  }
  addPlayer(id, name, color) {
    this.players.set(id, { id, name, color, held: new Set() });
  }
  removePlayer(id) {
    this.players.delete(id);
  }
  input(id, button, isDown) {
    const player = this.players.get(id);
    if (!player || typeof button !== 'string' || !Object.hasOwn(BTN, button)) return;
    if (isDown) player.held.add(button);
    else player.held.delete(button);
  }
  mergedInput() {
    const buttons = new Set([...this.players.values()].flatMap((player) => [...player.held]));
    for (const [first, second] of [
      ['up', 'down'],
      ['left', 'right'],
    ])
      if (buttons.has(first) && buttons.has(second)) {
        buttons.delete(first);
        buttons.delete(second);
      }
    return buttons;
  }
  serialize(task) {
    const result = this.operation.then(() => {
      if (this.isStopped) throw new Error('gameboy_stopped');
      return task();
    });
    this.operation = result.catch(() => {}); // A failed replacement preserves the existing core.
    return result;
  }
  async applyInput() {
    const wanted = this.mergedInput();
    const hold = [...wanted]
      .filter((button) => !this.held.has(button))
      .map((button) => BTN[button]);
    const release = [...this.held]
      .filter((button) => !wanted.has(button))
      .map((button) => BTN[button]);
    if (hold.length) await this.emu.controls.hold(hold);
    if (release.length) await this.emu.controls.release(release);
    this.held = wanted;
  }
  buildFrame(rgba, stride) {
    const colors = [],
      map = new Map();
    for (let y = 0; y < this.height; y++)
      for (let x = 0; x < this.width; x++) {
        const offset = y * stride + x * 4;
        let red = rgba[offset],
          green = rgba[offset + 1],
          blue = rgba[offset + 2];
        // GBA supports more colours than the indexed wire format. A 6x7x6 palette
        // bounds it to 252 colours without turning overflow pixels black.
        if (this.model === 'AGB') {
          red = Math.round(red / 51) * 51;
          green = (Math.round((green * 6) / 255) * 255) / 6;
          blue = Math.round(blue / 51) * 51;
          green = Math.round(green);
        }
        const key = red * 65536 + green * 256 + blue;
        let index = map.get(key);
        if (index === undefined) {
          index = colors.length / 3;
          if (index >= 255) index = 0;
          else {
            map.set(key, index);
            colors.push(red, green, blue);
          }
        }
        this.indices[y * this.width + x] = index;
      }
    return colors;
  }
  static rle(buffer) {
    const pairs = [];
    for (let index = 0; index < buffer.length;) {
      const value = buffer[index];
      let count = 1;
      while (index + count < buffer.length && buffer[index + count] === value && count < 255)
        count++;
      pairs.push(count, value);
      index += count;
    }
    return Uint8Array.from(pairs);
  }
  step() {
    return this.serialize(async () => {
      if (!this.running) return;
      await this.applyInput();
      const packet = await this.emu.controls.tick(1);
      if (this.isStopped) return;
      if (packet.width !== this.width || packet.height !== this.height)
        this.configureFrame(packet.width, packet.height);
      this.frame = packet.frameIndex;
      const colors = this.buildFrame(packet.buffer, packet.strideBytes);
      const isKey = this.prevPacked === null || this.needKey || this.frame % KEY_INTERVAL === 0;
      let payload;
      if (isKey) {
        payload = GbRoom.rle(this.indices);
        this.prevPacked = this.indices.slice();
        this.needKey = false;
      } else {
        for (let index = 0; index < this.indices.length; index++)
          this.xorBuf[index] = this.indices[index] ^ this.prevPacked[index];
        payload = GbRoom.rle(this.xorBuf);
        this.prevPacked.set(this.indices);
      }
      const colorKey = colors.join(',');
      const palette = isKey || colorKey !== this.sentColors ? colors.slice() : null;
      this.palette = colors;
      this.sentColors = colorKey;
      this.onFrame(this.frame, payload, isKey, palette);
      if (this.audioQueue.length || this.pcmQueue.length) {
        const packets = this.audioQueue,
          pcm = Buffer.concat(this.pcmQueue);
        this.audioQueue = [];
        this.pcmQueue = [];
        this.onAudio(this.frame, packets, pcm);
      }
    });
  }
  switchRom(path) {
    return this.serialize(async () => {
      await this.saveClock();
      if (this.emu.batterySavePath)
        await this.emu.states.saveBatteryToFile(this.emu.batterySavePath);
      const next = await this.loadCore(path);
      if (this.isStopped) {
        await next.close();
        throw new Error('gameboy_stopped');
      }
      const previous = this.emu;
      this.audioReady = false;
      this.configureCore(next, path);
      await this.restoreClock();
      this.held.clear();
      for (const player of this.players.values()) player.held.clear();
      await previous.close();
      this.origin = this.now() - this.tick * FRAME_MS;
      return {
        title: this.title,
        model: this.model,
        mono: this.mono,
        width: this.width,
        height: this.height,
      };
    });
  }
  reset() {
    return this.switchRom(this.romPath);
  }
  setPower(isOn) {
    this.power = isOn;
    this.origin = this.now() - this.tick * FRAME_MS;
  }
  start() {
    if (this.running || this.isStopped) return;
    this.running = true;
    this.origin = this.now();
    this.loop = this.run().catch((error) => {
      this.running = false;
      if (!this.isStopped) this.logger.error('[gameboy] emulation stopped:', error.message);
    });
  }
  async run() {
    while (this.running && !this.isStopped) {
      if (!this.power || this.clients === 0) {
        // An idle room must release CPU, rather than busy-poll with setImmediate.
        await new Promise((resolve) => this.timers.setTimeout(resolve, 50));
        this.origin = this.now() - this.tick * FRAME_MS;
        continue;
      }
      await this.step();
      this.tick++;
      // Every 30 s of wall time: the clock must survive a hard stop too. The
      // read goes through the room queue so it never lands in the middle of a
      // frame (the MBC register select is shared with the game's SRAM access).
      if (this.rtcClock && !this.rtcBusy && Date.now() - this.rtcSavedAt > 30000) {
        this.rtcSavedAt = Date.now();
        void this.serialize(() => this.saveClock()).catch(() => {});
      }
      if (this.now() - this.origin - this.tick * FRAME_MS > 3 * FRAME_MS)
        this.origin = this.now() - this.tick * FRAME_MS;
      const delay = Math.max(1, this.origin + this.tick * FRAME_MS - this.now());
      await new Promise((resolve) => this.timers.setTimeout(resolve, delay));
    }
  }
  stop() {
    if (this.stopping) return this.stopping;
    this.isStopped = true;
    this.running = false;
    this.audioReady = false;
    this.stopping = (async () => {
      await this.loop;
      await this.operation;
      await this.saveClock();
      await this.emu?.close();
      this.emu = null;
      this.opus.drop?.();
      this.players.clear();
      this.held.clear();
      this.audioQueue = [];
      this.pcmQueue = [];
      this.pcmAccum = Buffer.alloc(0);
    })();
    return this.stopping;
  }
  status() {
    return {
      isStopped: this.isStopped,
      isRunning: this.running,
      players: this.players.size,
      width: this.width,
      height: this.height,
    };
  }
}
export const CONST = { FPS, FRAME_MS, W, H, AUDIO_RATE, BTN, ALL };
