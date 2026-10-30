import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createHttpApp } from '../../../server/http/app.js';
import {
  createAccount,
  createSession,
  revokeSession,
  SESSION_COOKIE,
} from '../../../server/auth/service.js';
import { invalidateConnections } from '../../../server/security/connections.js';
import { createGameboyFeature } from '../server/addon.js';
import { crc32 } from '../server/roms.mjs';

let accountSequence = 0;

async function fixture(context, options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'chaos-gameboy-api-'));
  const buffer = Buffer.alloc(32768);
  buffer[0x104] = 0xce;
  buffer[0x105] = 0xed;
  buffer.write('FIXTURE', 0x134);
  await writeFile(join(dataDir, 'fixture.gb'), buffer);
  const room = {
    title: 'Fixture',
    romPath: join(dataDir, 'fixture.gb'),
    model: 'DMG',
    mono: true,
    width: 160,
    height: 144,
    palette: [0, 0, 0],
    players: new Map(),
    inputs: [],
    stopped: false,
    start() {},
    async stop() {
      this.stopped = true;
    },
    addPlayer(id, name, color) {
      this.players.set(id, { name, color });
    },
    removePlayer(id) {
      this.players.delete(id);
    },
    input(...args) {
      this.inputs.push(args);
    },
    async switchRom() {
      return { title: this.title, model: this.model, width: 160, height: 144 };
    },
  };
  const feature = createGameboyFeature({
    dataDir,
    createRoom: async () => room,
    fetchArtwork: async () => null,
    ...options,
  });
  const app = createHttpApp();
  feature.routes(app);
  const server = createServer(app);
  feature.upgrade(server, { accepting: () => true });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const sockets = [];
  context.after(async () => {
    for (const socket of sockets) socket.terminate();
    await feature.stop();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  const { account } = await createAccount({
    email: `gameboy-${crypto.randomUUID()}@example.org`,
    pseudo: `Player ${++accountSequence}`,
    password: 'gameboy-test-password',
  });
  const token = createSession(account.id);
  const cookie = `${SESSION_COOKIE}=${token}`;
  async function connect(headers = {}, query = '') {
    const socket = new WebSocket(origin.replace('http', 'ws') + '/gameboy-ws' + query, { headers });
    sockets.push(socket);
    const hello = new Promise((resolve, reject) => {
      socket.on('message', (value) => {
        const message = JSON.parse(value.toString());
        if (message.type === 'hello') resolve(message);
        if (message.type === 'error') reject(new Error(message.reason));
      });
      socket.once('error', reject);
    });
    return { socket, hello: await hello };
  }
  return { feature, origin, room, cookie, token, account, connect, buffer, dataDir };
}

// Waits for an observable effect instead of a fixed delay: the full suite runs
// with many files in parallel, so 30 ms is not a duration anything guarantees.
async function until(condition, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met before timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('Game Boy writes require a live account and the same origin before reading an upload', async (context) => {
  const scene = await fixture(context);
  const url = scene.origin + '/gameboy-api/roms?name=uploaded.gb';
  assert.equal((await fetch(url, { method: 'POST', body: scene.buffer })).status, 401);
  assert.equal(
    (
      await fetch(url, {
        method: 'POST',
        headers: { Cookie: scene.cookie, Origin: 'https://other.example' },
        body: scene.buffer,
      })
    ).status,
    403,
  );
  const uploaded = await fetch(url, {
    method: 'POST',
    headers: { Cookie: scene.cookie, 'Content-Type': 'application/octet-stream' },
    body: scene.buffer,
  });
  assert.equal(uploaded.status, 200);
  const loaded = await fetch(scene.origin + '/gameboy-api/load', {
    method: 'POST',
    headers: { Cookie: scene.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: 'uploaded.gb' }),
  });
  assert.equal(loaded.status, 200);
  assert.equal(
    (await fetch(scene.origin + '/gameboy-media/not-a-crc/roms.index.json')).status,
    404,
  );
});

test('spectators cannot control the core; account revocation releases authenticated input immediately', async (context) => {
  const scene = await fixture(context);
  const guest = await scene.connect();
  assert.equal(guest.hello.canControl, false);
  guest.socket.send(JSON.stringify({ type: 'input', btn: 'a', down: true }));
  const player = await scene.connect({ Cookie: scene.cookie });
  assert.equal(player.hello.canControl, true);
  player.socket.send(JSON.stringify({ type: 'input', btn: 'b', down: true }));
  await until(() => scene.room.inputs.length > 0);
  assert.deepEqual(
    scene.room.inputs.map((input) => input[1]),
    ['b'],
  );
  const closed = new Promise((resolve) => player.socket.once('close', resolve));
  revokeSession(scene.token);
  invalidateConnections({ accountId: scene.account.id });
  await closed;
  assert.equal(scene.room.players.size, 0);
});

test('shared control snapshots preserve simultaneous holds, prime newcomers and clear on sleep or disconnect', async (context) => {
  const scene = await fixture(context);
  const guest = await scene.connect();
  const updates = [];
  guest.socket.on('message', (value) => {
    const message = JSON.parse(value.toString());
    if (message.type === 'controls') updates.push(message.players);
  });
  const first = await scene.connect({ Cookie: scene.cookie });
  first.socket.send(JSON.stringify({ type: 'input', btn: 'l', down: true }));
  first.socket.send(JSON.stringify({ type: 'input', btn: '__proto__', down: true }));
  first.socket.send(JSON.stringify({ type: 'input', btn: 'a', down: true }));
  await until(() => updates.length > 0);
  assert.deepEqual(updates.at(-1), [{ id: first.hello.id, buttons: ['a'] }]);
  const second = await scene.connect({ Cookie: scene.cookie });
  assert.deepEqual(second.hello.controls, [{ id: first.hello.id, buttons: ['a'] }]);
  second.socket.send(JSON.stringify({ type: 'input', btn: 'a', down: true }));
  await until(() => updates.at(-1)?.length === 2);
  first.socket.send(JSON.stringify({ type: 'input', btn: 'a', down: false }));
  await until(() => updates.at(-1)?.length === 1);
  assert.deepEqual(updates.at(-1), [{ id: second.hello.id, buttons: ['a'] }]);
  second.socket.send(JSON.stringify({ type: 'sleep', on: true }));
  await until(() => updates.at(-1)?.length === 0);
  first.socket.send(JSON.stringify({ type: 'input', btn: 'b', down: true }));
  await until(() => updates.at(-1)?.[0]?.buttons[0] === 'b');
  const beforeGuest = updates.length;
  guest.socket.send(JSON.stringify({ type: 'input', btn: 'start', down: true }));
  guest.socket.send(JSON.stringify({ type: 'sleep', on: false }));
  await until(() => scene.feature.status().awake === 2);
  first.socket.close();
  await until(() => updates.length > beforeGuest && updates.at(-1)?.length === 0);
  assert.ok(
    updates.every((players) => players.every((player) => player.id !== guest.hello.id)),
    'a spectator cannot forge a pressed button',
  );
});

test('production accepts the local request origin alongside the public proxy origin', async (context) => {
  const previousMode = process.env.NODE_ENV;
  const previousOrigin = process.env.PUBLIC_ORIGIN;
  process.env.NODE_ENV = 'production';
  process.env.PUBLIC_ORIGIN = 'https://console.example.org';
  context.after(() => {
    if (previousMode === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousMode;
    if (previousOrigin === undefined) delete process.env.PUBLIC_ORIGIN;
    else process.env.PUBLIC_ORIGIN = previousOrigin;
  });
  const scene = await fixture(context);
  const local = await scene.connect({ Origin: scene.origin });
  assert.equal(local.hello.proto, 4);
  const proxied = await scene.connect({ Origin: 'https://console.example.org' });
  assert.equal(proxied.hello.proto, 4);
  await assert.rejects(scene.connect({ Origin: 'https://other.example.org' }), /403/);
});

test('a core that finishes loading after stop is closed instead of resurrecting the feature', async (context) => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  let roomCreated;
  const created = new Promise((resolve) => {
    roomCreated = resolve;
  });
  const scene = await fixture(context, {
    createRoom: () => {
      roomCreated();
      return pending;
    },
  });
  const request = fetch(scene.origin + '/gameboy-api/load', {
    method: 'POST',
    headers: { Cookie: scene.cookie, 'Content-Type': 'application/json' },
    body: '{"file":"fixture.gb"}',
  });
  // The stop must land while the load is inside createRoom, not after a guess.
  await created;
  const stopping = scene.feature.stop();
  release(scene.room);
  await stopping;
  assert.equal(scene.room.stopped, true);
  assert.equal(scene.feature.status().isStopped, true);
  assert.equal((await request).status, 503);
});

test('standby removes the player from the roster, power on brings it back', async (context) => {
  const scene = await fixture(context);
  const player = await scene.connect({ Cookie: scene.cookie });
  const spectator = await scene.connect();

  // Record every roster each socket receives, then read the latest one: no
  // race between "send" and "the server has not answered yet".
  const seen = new Map();
  for (const [tag, socket] of [
    ['player', player.socket],
    ['spectator', spectator.socket],
  ]) {
    seen.set(tag, []);
    socket.on('message', (value) => {
      const raw = value.toString();
      if (!raw.startsWith('{')) return;
      const message = JSON.parse(raw);
      if (message.type === 'roster') seen.get(tag).push(message.players);
    });
  }
  const last = (tag) => seen.get(tag).at(-1) ?? [];
  const settle = () => new Promise((resolve) => setTimeout(resolve, 250));

  player.socket.send(JSON.stringify({ type: 'sleep', on: false }));
  await settle();
  assert.equal(last('spectator').length, 1, 'an awake player is listed');

  player.socket.send(JSON.stringify({ type: 'sleep', on: true }));
  await settle();
  assert.deepEqual(last('spectator'), [], 'standby must remove the player for the others');
  assert.deepEqual(last('player'), [], 'the sleeping console keeps an honest count');

  player.socket.send(JSON.stringify({ type: 'sleep', on: false }));
  await settle();
  assert.equal(last('spectator').length, 1, 'power on must restore the player');

  player.socket.close();
  await settle();
  assert.deepEqual(last('spectator'), [], 'closing the console removes the player');
});

test('shared close unloads the core, disconnects every viewer and forbids automatic resurrection', async (context) => {
  const scene = await fixture(context);
  const player = await scene.connect({ Cookie: scene.cookie });
  const guest = await scene.connect();
  const closed = [player, guest].map(
    ({ socket }) => new Promise((resolve) => socket.once('close', resolve)),
  );
  const response = await fetch(scene.origin + '/gameboy-api/unload', {
    method: 'POST',
    headers: { Cookie: scene.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ generation: player.hello.generation }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, unloaded: true });
  // The core is gone: its viewers must be forgotten before this response, not
  // when each transport finishes closing — that close event always lands later,
  // and /status would keep reporting players of a dead core until then.
  assert.equal(scene.feature.status().players, 0);
  await Promise.all(closed);
  assert.equal(scene.room.stopped, true);
  assert.equal(scene.feature.status().rom, null);
  assert.equal(scene.feature.status().players, 0);
  await assert.rejects(scene.connect({ Cookie: scene.cookie }), /rom-unloaded/);
  await assert.rejects(scene.connect({}, '?start=1'), /rom-unloaded/);
  assert.equal(scene.feature.status().rom, null);
  const restarted = await scene.connect({ Cookie: scene.cookie }, '?start=1');
  assert.ok(restarted.hello.generation > player.hello.generation);
  const stale = await fetch(scene.origin + '/gameboy-api/unload', {
    method: 'POST',
    headers: { Cookie: scene.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ generation: player.hello.generation }),
  });
  assert.deepEqual(await stale.json(), { ok: true, unloaded: false });
  assert.notEqual(
    scene.feature.status().rom,
    null,
    'a delayed close from an older core cannot unload its replacement',
  );
});

test('ROM unload requires a live same-origin account', async (context) => {
  const scene = await fixture(context);
  await scene.connect({ Cookie: scene.cookie });
  const url = scene.origin + '/gameboy-api/unload';
  assert.equal((await fetch(url, { method: 'POST' })).status, 401);
  assert.equal(
    (
      await fetch(url, {
        method: 'POST',
        headers: { Cookie: scene.cookie, Origin: 'https://other.example' },
      })
    ).status,
    403,
  );
  assert.equal(scene.room.stopped, false);
});

test('a delayed close cannot unload a cartridge explicitly loaded after it', async (context) => {
  const scene = await fixture(context);
  const player = await scene.connect({ Cookie: scene.cookie });
  const loaded = await fetch(scene.origin + '/gameboy-api/load', {
    method: 'POST',
    headers: { Cookie: scene.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: 'fixture.gb' }),
  });
  assert.equal(loaded.status, 200);
  const stale = await fetch(scene.origin + '/gameboy-api/unload', {
    method: 'POST',
    headers: { Cookie: scene.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ generation: player.hello.generation }),
  });
  assert.deepEqual(await stale.json(), { ok: true, unloaded: false });
  assert.equal(scene.room.stopped, false);
});

test('closing during a pending native boot waits for it and unloads the returned core', async (context) => {
  let releaseCore, reportBoot;
  const pendingCore = new Promise((resolve) => {
    releaseCore = resolve;
  });
  const bootEntered = new Promise((resolve) => {
    reportBoot = resolve;
  });
  const scene = await fixture(context, {
    createRoom: () => {
      reportBoot();
      return pendingCore;
    },
  });
  const loading = fetch(scene.origin + '/gameboy-api/load', {
    method: 'POST',
    headers: { Cookie: scene.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: 'fixture.gb' }),
  });
  await bootEntered;
  const closing = fetch(scene.origin + '/gameboy-api/unload', {
    method: 'POST',
    headers: { Cookie: scene.cookie },
  });
  releaseCore(scene.room);
  assert.equal((await loading).status, 200);
  assert.equal((await closing).status, 200);
  assert.equal(scene.room.stopped, true);
  assert.equal(scene.feature.status().rom, null);
});

test('cartridge removal requires a live same-origin account and deletes nothing', async (context) => {
  const scene = await fixture(context);
  const url = scene.origin + '/gameboy-api/roms/fixture.gb';
  assert.equal((await fetch(url, { method: 'DELETE' })).status, 401);
  assert.equal(
    (
      await fetch(url, {
        method: 'DELETE',
        headers: { Cookie: scene.cookie, Origin: 'https://other.example' },
      })
    ).status,
    403,
  );
  assert.equal(existsSync(join(scene.dataDir, 'fixture.gb')), true);
  assert.equal(
    (await fetch(scene.origin + '/gameboy-api/roms/missing.gb', { method: 'DELETE' })).status,
    401,
  );
});

test('removing the cartridge on the console unloads the core and empties the shelf', async (context) => {
  const scene = await fixture(context);
  const player = await scene.connect({ Cookie: scene.cookie });
  const closed = new Promise((resolve) => player.socket.once('close', resolve));
  const response = await fetch(scene.origin + '/gameboy-api/roms/fixture.gb', {
    method: 'DELETE',
    headers: { Cookie: scene.cookie },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.unloaded, true, 'the core must be stopped before its file goes');
  assert.equal(body.removed.rom, true);
  assert.equal(scene.room.stopped, true);
  assert.equal(scene.feature.status().players, 0);
  assert.equal(scene.feature.status().rom, null);
  await closed;
  assert.equal(existsSync(join(scene.dataDir, 'fixture.gb')), false);
  const listed = await (await fetch(scene.origin + '/gameboy-api/roms')).json();
  assert.deepEqual(listed.roms, []);
  assert.equal(listed.current, null);
  const again = await fetch(scene.origin + '/gameboy-api/roms/fixture.gb', {
    method: 'DELETE',
    headers: { Cookie: scene.cookie },
  });
  assert.equal(again.status, 404);
});

test('a cartridge deleted outside the app can be dropped from the library through the API', async (context) => {
  const scene = await fixture(context);
  const extra = Buffer.from(scene.buffer);
  extra.write('EXTRA', 0x134);
  const uploaded = await fetch(scene.origin + '/gameboy-api/roms?name=extra.gb', {
    method: 'POST',
    headers: { Cookie: scene.cookie, 'Content-Type': 'application/octet-stream' },
    body: extra,
  });
  assert.equal(uploaded.status, 200);
  // What a hand deletion leaves: the file is gone, the shelf still draws a box
  // because the index entry only disappears at the next scan.
  await rm(join(scene.dataDir, 'extra.gb'));
  const listed = await (await fetch(scene.origin + '/gameboy-api/roms')).json();
  assert.ok(
    listed.roms.some((rom) => rom.file === 'extra.gb'),
    'the entry outlives an external deletion',
  );

  const response = await fetch(scene.origin + '/gameboy-api/roms/extra.gb', {
    method: 'DELETE',
    headers: { Cookie: scene.cookie },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.removed.rom, false, 'nothing was left on disk to delete');
  assert.equal(body.unloaded, false, 'an unloaded cartridge has no core to stop');
  const after = await (await fetch(scene.origin + '/gameboy-api/roms')).json();
  assert.deepEqual(
    after.roms.map((rom) => rom.file),
    ['fixture.gb'],
  );
});

test('a cartridge removed while its cover downloads leaves no artwork behind', async (context) => {
  let reportArtwork, releaseArtwork;
  const artworkStarted = new Promise((resolve) => {
    reportArtwork = resolve;
  });
  const artwork = new Promise((resolve) => {
    releaseArtwork = resolve;
  });
  const scene = await fixture(context, {
    fetchArtwork: async ({ crc }, mediaDir) => {
      reportArtwork();
      await artwork;
      // The real fetcher writes the images itself, after the removal.
      mkdirSync(join(mediaDir, crc), { recursive: true });
      writeFileSync(join(mediaDir, crc, 'front.webp'), 'webp');
      return { status: 'ok', front: `/gameboy-media/${crc}/front.webp` };
    },
  });
  const late = Buffer.from(scene.buffer);
  late.write('LATE', 0x134);
  const uploading = fetch(scene.origin + '/gameboy-api/roms?name=late.gb', {
    method: 'POST',
    headers: { Cookie: scene.cookie, 'Content-Type': 'application/octet-stream' },
    body: late,
  });
  await artworkStarted;
  // The cartridge is removed while its cover is still downloading: writing the
  // media afterwards would recreate media/<crc>/ for an entry that is gone.
  const removed = await fetch(scene.origin + '/gameboy-api/roms/late.gb', {
    method: 'DELETE',
    headers: { Cookie: scene.cookie },
  });
  assert.equal(removed.status, 200);
  releaseArtwork({ status: 'ok', front: '/gameboy-media/00000000/front.webp' });
  assert.equal((await uploading).status, 200);
  assert.equal(
    existsSync(join(scene.dataDir, 'media', crc32(late))),
    false,
    'no artwork may be recreated after the removal',
  );
  const listed = await (await fetch(scene.origin + '/gameboy-api/roms')).json();
  assert.deepEqual(
    listed.roms.map((rom) => rom.file),
    ['fixture.gb'],
  );
});

test('a re-upload under the same name during a cover download keeps only its own artwork', async (context) => {
  let reportArtwork, releaseArtwork;
  let calls = 0;
  const artworkStarted = new Promise((resolve) => {
    reportArtwork = resolve;
  });
  const artwork = new Promise((resolve) => {
    releaseArtwork = resolve;
  });
  const scene = await fixture(context, {
    fetchArtwork: async ({ crc }, mediaDir) => {
      calls += 1;
      if (calls === 1) {
        reportArtwork();
        await artwork;
      }
      mkdirSync(join(mediaDir, crc), { recursive: true });
      writeFileSync(join(mediaDir, crc, 'front.webp'), 'webp');
      return { status: 'ok', front: `/gameboy-media/${crc}/front.webp` };
    },
  });
  const first = Buffer.from(scene.buffer);
  first.write('FIRST', 0x134);
  const uploading = fetch(scene.origin + '/gameboy-api/roms?name=swap.gb', {
    method: 'POST',
    headers: { Cookie: scene.cookie, 'Content-Type': 'application/octet-stream' },
    body: first,
  });
  await artworkStarted;
  assert.equal(
    (
      await fetch(scene.origin + '/gameboy-api/roms/swap.gb', {
        method: 'DELETE',
        headers: { Cookie: scene.cookie },
      })
    ).status,
    200,
  );
  // Another dump takes the same name while the first cover is in flight.
  const second = Buffer.from(scene.buffer);
  second.write('SECOND', 0x134);
  assert.equal(
    (
      await fetch(scene.origin + '/gameboy-api/roms?name=swap.gb', {
        method: 'POST',
        headers: { Cookie: scene.cookie, 'Content-Type': 'application/octet-stream' },
        body: second,
      })
    ).status,
    200,
  );
  releaseArtwork();
  assert.equal((await uploading).status, 200);
  assert.equal(
    existsSync(join(scene.dataDir, 'media', crc32(first))),
    false,
    'the removed dump keeps no cover under its own CRC',
  );
  assert.equal(
    existsSync(join(scene.dataDir, 'media', crc32(second))),
    true,
    'the new dump keeps its own cover',
  );
  const listed = await (await fetch(scene.origin + '/gameboy-api/roms')).json();
  assert.equal(listed.roms.find((rom) => rom.file === 'swap.gb').crc, crc32(second));
});
