import express from 'express';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { WebSocketServer } from 'ws';
import { defineFeature } from '../../../server/core/features.js';
import { requireAccount, requireSameOrigin } from '../../../server/api/auth.js';
import {
  readTransportAccess,
  trackTransport,
  rejectUpgrade,
} from '../../../server/security/transport-access.js';
import { createUploadRequestService } from '../../../server/uploads/admission.js';
import { GbRoom, CONST } from './room.mjs';
import { RomLibrary } from './roms.mjs';
import { fetchArt } from './retrobase.mjs';

const DATA = process.env.GAME_CLIENT_ASSET_ROOT
  ? resolve(process.env.GAME_CLIENT_ASSET_ROOT, 'gameboy')
  : fileURLToPath(new URL('../data/', import.meta.url));
const WS_PATH = '/gameboy-ws';
const COLORS = ['#c6e04a', '#7fd0e8', '#e8b45a', '#c79ae0', '#e08a93', '#8fe0a0'];
const CLIENT_ROOT = fileURLToPath(new URL('../client/', import.meta.url));

function framePacket(frame, payload, palette, isKey) {
  const hasPalette = Array.isArray(palette) && palette.length >= 3;
  const count = hasPalette ? palette.length / 3 : 0;
  const buffer = Buffer.alloc(6 + (hasPalette ? 1 + count * 3 : 0) + payload.length);
  buffer.write('F');
  buffer.writeUInt32LE(frame >>> 0, 1);
  buffer[5] = (isKey ? 1 : 0) | (hasPalette ? 2 : 0);
  let offset = 6;
  if (hasPalette) {
    buffer[offset++] = count;
    buffer.set(palette, offset);
    offset += palette.length;
  }
  buffer.set(payload, offset);
  return buffer;
}

export function createGameboyFeature({
  dataDir = DATA,
  createRoom = (path, callbacks) => GbRoom.create(path, callbacks),
  fetchArtwork = fetchArt,
  logger = console,
  now = Date.now,
} = {}) {
  const library = new RomLibrary(dataDir);
  const clients = new Map();
  const uploads = createUploadRequestService({ maxConcurrent: 2 });
  let room = null,
    starting = null,
    libraryReady = null,
    webSockets = null;
  let isStopped = false,
    nextId = 1,
    server = null,
    upgradeHandler = null,
    stopping = null;
  let operation = Promise.resolve();
  let isRomUnloaded = false,
    roomGeneration = 0;
  const unavailable = () => Object.assign(new Error('gameboy_stopping'), { status: 503 });
  function assertAccepting() {
    if (isStopped) throw unavailable();
  }
  function ensureLibrary() {
    assertAccepting();
    return (libraryReady ??= library.init().catch((error) => {
      libraryReady = null;
      throw error;
    }));
  }
  function send(socket, value) {
    if (socket.readyState !== 1) return;
    // Skipping an XOR delta would corrupt every subsequent frame.
    if (socket.bufferedAmount > 1024 * 1024) {
      socket.terminate();
      return;
    }
    socket.send(value, (error) => {
      if (error) socket.terminate();
    });
  }
  const awakeCount = () =>
    [...clients].filter(([socket, client]) => socket.readyState === 1 && !client.isSleeping).length;
  function syncClients() {
    if (room) room.clients = awakeCount();
  }
  /* Who counts as a player: a console on standby (power off) is not playing.
     The room keeps its player entries; we only expose the awake ones. */
  const roster = () => {
    if (!room) return [];
    const awake = new Set(
      [...clients]
        .filter(([socket, client]) => socket.readyState === 1 && !client.isSleeping)
        .map(([, client]) => client.id),
    );
    return [...room.players]
      .filter(([id]) => awake.has(id))
      .map(([id, player]) => ({ id, name: player.name, color: player.color }));
  };
  function broadcast(value) {
    for (const [socket, client] of clients)
      if (typeof value === 'string' || !client.isSleeping) send(socket, value);
  }
  function describeRoom() {
    return room
      ? {
          title: room.title,
          file: room.romPath.split(/[\\/]/).pop(),
          model: room.model,
          mono: room.mono,
          width: room.width || CONST.W,
          height: room.height || CONST.H,
        }
      : null;
  }
  async function ensureRoom(canStart = false) {
    assertAccepting();
    if (isRomUnloaded && !canStart) throw Object.assign(new Error('rom-unloaded'), { status: 409 });
    if (room) return room;
    if (starting) return starting;
    starting = (async () => {
      await ensureLibrary();
      assertAccepting();
      const first = library.list().find((entry) => library.path(entry.file));
      if (!first) throw Object.assign(new Error('no-rom'), { status: 404 });
      const created = await createRoom(library.path(first.file), {
        onFrame(frame, payload, isKey, palette) {
          if (!isStopped) broadcast(framePacket(frame, payload, palette, isKey));
        },
        onAudio(frame, packets, pcm) {
          if (isStopped) return;
          for (const [socket, client] of clients) {
            if (client.isSleeping) continue;
            if (client.codec === 'pcm') {
              const buffer = Buffer.alloc(5 + pcm.length);
              buffer.write('A');
              buffer.writeUInt32LE(frame >>> 0, 1);
              pcm.copy(buffer, 5);
              send(socket, buffer);
            } else
              for (const packet of packets) send(socket, Buffer.concat([Buffer.from('O'), packet]));
          }
        },
        logger,
      });
      if (isStopped) {
        await created.stop();
        throw unavailable();
      }
      room = created;
      isRomUnloaded = false;
      roomGeneration++;
      syncClients();
      room.start();
      return room;
    })().finally(() => {
      starting = null;
    });
    return starting;
  }
  function serialize(task) {
    const result = operation.then(() => {
      assertAccepting();
      return task();
    });
    operation = result.catch(() => {}); // Keep a rejected request from poisoning later work.
    return result;
  }
  const reply = (response, status, value) =>
    response.status(status).set('Cache-Control', 'no-store').json(value);
  /**
   * Stops the shared core and ejects every viewer. Shared by the explicit
   * unload and by cartridge removal, which must not delete a cartridge the
   * core still holds (mGBA would rewrite its .sav on the way out).
   */
  async function detachRoom() {
    await starting;
    const active = room;
    if (!active) {
      isRomUnloaded = true;
      return false;
    }
    await active.stop();
    room = null;
    isRomUnloaded = true;
    roomGeneration++;
    broadcast(JSON.stringify({ type: 'unloaded' }));
    // The transport close event only arrives after this response, so forget
    // every viewer now: /status must never report players of a dead core.
    for (const [socket, client] of [...clients]) {
      client.release();
      socket.close(1000, 'rom_unloaded');
    }
    return true;
  }
  function routes(app, { apiLimiter } = {}) {
    const api = express.Router();
    if (apiLimiter) api.use(apiLimiter);
    api.use((request, response, next) => {
      response.set('Cache-Control', 'no-store');
      if (isStopped) return reply(response, 503, { error: 'gameboy_stopping' });
      if (['GET', 'HEAD'].includes(request.method)) return next();
      requireSameOrigin(request, response, () => requireAccount(request, response, next));
    });
    api.get('/roms', async (_request, response, next) => {
      try {
        await ensureLibrary();
        reply(response, 200, { current: describeRoom(), roms: library.list() });
      } catch (error) {
        next(error);
      }
    });
    api.post(
      '/roms',
      uploads.handle(
        express.raw({ type: 'application/octet-stream', limit: '32mb' }),
        async (request, response) => {
          if (typeof request.query.name !== 'string' || !Buffer.isBuffer(request.body))
            return reply(response, 400, { error: 'invalid_rom_upload' });
          const entry = await serialize(async () => {
            await ensureLibrary();
            return library.add(request.query.name, request.body);
          });
          let media = library.cachedMedia(entry.crc);
          if (!media) {
            media = await fetchArtwork(
              { crc: entry.crc, filename: entry.file, signal: request.uploadSignal },
              library.mediaDir,
            ).catch((error) => {
              logger.warn('[gameboy] artwork unavailable:', error.message);
              return null;
            });
            request.uploadSignal.throwIfAborted();
            media ||= { status: 'empty', fetchedAt: now() };
            // The cartridge can be removed — or replaced by another dump under
            // the same name — while its cover downloads. The entry must still
            // carry this CRC, otherwise the artwork belongs to nobody.
            await serialize(async () => {
              if (library.crcOf(entry.file) === String(entry.crc))
                await library.writeMedia(entry.crc, media);
              // The fetcher writes its images itself, after this point.
              else await library.pruneMedia(entry.crc);
            });
          }
          reply(response, 200, { rom: entry, media });
        },
      ),
    );
    /* Removing a cartridge is the only write that also stops the core: deleting
       one that is loaded would let mGBA rewrite its .sav on the way out, and
       the shared console would keep running a file that no longer exists. */
    api.delete('/roms/:file', async (request, response, next) => {
      try {
        const file = request.params.file;
        if (!file || /[\\/]/.test(file)) return reply(response, 400, { error: 'invalid_rom' });
        const result = await serialize(async () => {
          await ensureLibrary();
          if (!library.has(file)) throw Object.assign(new Error('rom_not_found'), { status: 404 });
          // Compare paths rather than names: the core was opened with the path
          // resolved by the library, and a cartridge deleted outside the app
          // still has to be ejected before its entry goes.
          const isActive = Boolean(
            room?.romPath && resolve(room.romPath) === resolve(join(dataDir, file)),
          );
          const unloaded = isActive ? await detachRoom() : false;
          const removed = await library.remove(file);
          if (!removed) throw Object.assign(new Error('rom_not_found'), { status: 404 });
          return { unloaded, removed: { title: removed.entry.title, ...removed.existed } };
        });
        reply(response, 200, { ok: true, file, ...result });
      } catch (error) {
        next(error);
      }
    });
    api.post('/load', express.json({ limit: '8kb' }), async (request, response, next) => {
      try {
        const result = await serialize(async () => {
          await ensureLibrary();
          const file = request.body?.file,
            path = library.path(file);
          if (!path) throw Object.assign(new Error('rom_not_found'), { status: 404 });
          const active = await ensureRoom(true),
            info = await active.switchRom(path);
          assertAccepting();
          roomGeneration++;
          const details = { ...info, file, generation: roomGeneration };
          broadcast(JSON.stringify({ type: 'rom', ...details }));
          return details;
        });
        reply(response, 200, { ok: true, ...result });
      } catch (error) {
        next(error);
      }
    });
    api.post('/unload', express.json({ limit: '1kb' }), async (request, response, next) => {
      try {
        const generation = request.body?.generation;
        if (generation !== undefined && !Number.isSafeInteger(generation))
          return reply(response, 400, { error: 'invalid_room_generation' });
        const unloaded = await serialize(async () => {
          if (generation !== undefined && generation !== roomGeneration) return false;
          return detachRoom();
        });
        reply(response, 200, { ok: true, unloaded });
      } catch (error) {
        next(error);
      }
    });
    api.get('/status', (_request, response) =>
      reply(response, 200, {
        rom: room?.title ?? null,
        model: room?.model ?? null,
        players: clients.size,
        awake: awakeCount(),
        isStopped,
      }),
    );
    api.use((error, _request, response, _next) =>
      reply(response, error.status || 500, {
        error: error.status ? error.message : 'gameboy_unavailable',
      }),
    );
    app.use('/gameboy-api', api);
    app.get('/gameboy-library', (_request, response) =>
      response.set('Cache-Control', 'no-cache').sendFile(join(CLIENT_ROOT, 'library.html')),
    );
    app.get('/gameboy-media/:crc/:file', (request, response) => {
      const { crc, file } = request.params;
      if (!/^[a-f0-9]{8}$/i.test(crc) || !/^(front|spine|back)\.(png|jpg|webp)$/.test(file))
        return response.sendStatus(404);
      response.set('Cache-Control', 'no-cache').sendFile(resolve(dataDir, 'media', crc, file));
    });
  }
  function upgrade(httpServer, { accepting = () => true } = {}) {
    assertAccepting();
    if (server) throw new Error('Game Boy transport already attached');
    server = httpServer;
    webSockets = new WebSocketServer({ noServer: true, maxPayload: 4096 });
    upgradeHandler = (request, socket, head) => {
      let path, canStart;
      try {
        const url = new URL(request.url, 'http://localhost');
        path = url.pathname;
        canStart = url.searchParams.get('start') === '1';
      } catch {
        return;
      }
      if (path !== WS_PATH) return;
      if (isStopped || !accepting()) return rejectUpgrade(socket, { status: 503 });
      let access;
      try {
        const origin = request.headers.origin;
        const requestOrigin = `${request.socket.encrypted ? 'https' : 'http'}://${request.headers.host}`;
        // Docker also serves its own host directly; PUBLIC_ORIGIN describes the TLS proxy.
        const publicOrigin =
          process.env.NODE_ENV === 'production' ? process.env.PUBLIC_ORIGIN : null;
        if (origin && origin !== requestOrigin && origin !== publicOrigin)
          throw Object.assign(new Error('invalid_origin'), { status: 403 });
        access = readTransportAccess(request);
      } catch (error) {
        rejectUpgrade(socket, error);
        return;
      }
      webSockets.handleUpgrade(request, socket, head, (connection) => {
        void connect(connection, access, canStart).catch((error) => {
          logger.warn('[gameboy] connection failed:', error.message);
          connection.terminate();
        });
      });
    };
    server.on('upgrade', upgradeHandler);
  }
  async function connect(socket, access, canStart = false) {
    const id = nextId++,
      color = COLORS[(id - 1) % COLORS.length];
    const client = {
      id,
      isSleeping: false,
      codec: 'opus',
      security: null,
      startedAt: now(),
      messages: 0,
    };
    clients.set(socket, client);
    const release = () => {
      if (!clients.delete(socket)) return;
      client.security?.dispose();
      room?.removePlayer(id);
      syncClients();
      broadcast(JSON.stringify({ type: 'roster', players: roster() }));
    };
    // Closing a socket also happens from outside (ROM unload): expose the same
    // teardown so a dead core never keeps counting its viewers.
    client.release = release;
    socket.once('close', release);
    socket.on('error', () => {
      release();
      socket.terminate();
    });
    client.security = trackTransport(access, () => {
      release();
      socket.terminate();
    });
    let active;
    try {
      active = await serialize(() => ensureRoom(canStart && Boolean(access.account)));
    } catch (error) {
      send(socket, JSON.stringify({ type: 'error', reason: error.message }));
      release();
      socket.close();
      return;
    }
    if (isStopped || !clients.has(socket) || socket.readyState !== 1 || !client.security.check()) {
      release();
      return;
    }
    if (access.account) active.addPlayer(id, access.account.pseudo || `Player ${id}`, color);
    syncClients();
    const palette = [],
      flat = active.palette.flat();
    for (let index = 0; index < flat.length; index += 3) palette.push(flat.slice(index, index + 3));
    send(
      socket,
      JSON.stringify({
        type: 'hello',
        proto: 4,
        generation: roomGeneration,
        id,
        color,
        players: roster(),
        ...describeRoom(),
        rom: active.title,
        canControl: Boolean(access.account),
        fps: CONST.FPS,
        audio: true,
        audioRate: CONST.AUDIO_RATE,
        audioCodec: 'opus',
        palette,
      }),
    );
    active.needKey = true;
    broadcast(JSON.stringify({ type: 'roster', players: roster() }));
    socket.on('message', (raw, isBinary) => {
      if (isStopped || isBinary || !clients.has(socket) || !client.security.check()) return;
      if (now() - client.startedAt >= 1000) {
        client.startedAt = now();
        client.messages = 0;
      }
      if (++client.messages > 240) {
        socket.close(1008, 'rate_limited');
        return;
      }
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!message || typeof message !== 'object') return;
      if (
        message.type === 'input' &&
        access.account &&
        !client.isSleeping &&
        typeof message.btn === 'string' &&
        typeof message.down === 'boolean'
      )
        active.input(id, message.btn, message.down);
      if (message.type === 'sleep' && typeof message.on === 'boolean') {
        client.isSleeping = message.on;
        for (const button of Object.keys(CONST.BTN)) active.input(id, button, false);
        if (!message.on) active.needKey = true;
        syncClients();
        // The counter must drop the player who just put the console on standby:
        // everyone awake gets the new roster, and the sleeper keeps its own
        // count right even though the broadcast skips it.
        const update = JSON.stringify({ type: 'roster', players: roster() });
        broadcast(update);
        if (client.isSleeping) send(socket, update);
      }
      if (message.type === 'resync') active.needKey = true;
      if (message.type === 'caps') client.codec = message.opus === true ? 'opus' : 'pcm';
    });
  }
  function stop() {
    if (stopping) return stopping;
    isStopped = true;
    if (server && upgradeHandler) server.off('upgrade', upgradeHandler);
    for (const [socket, client] of clients) {
      client.security?.dispose();
      socket.terminate();
    }
    clients.clear();
    syncClients();
    stopping = (async () => {
      await uploads.stop();
      await starting?.catch(() => {}); // Late core creation closes itself after the terminal flag.
      await operation;
      await room?.stop();
      room = null;
      if (webSockets) await new Promise((resolveClose) => webSockets.close(resolveClose));
    })();
    return stopping;
  }
  return defineFeature({
    id: 'gameboy',
    phase: 'transports',
    routes,
    upgrade,
    stop,
    status: () => ({
      rom: room?.title ?? null,
      players: clients.size,
      awake: awakeCount(),
      isStopped,
    }),
  });
}

export default createGameboyFeature();
