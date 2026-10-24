import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  async function connect(headers = {}) {
    const socket = new WebSocket(origin.replace('http', 'ws') + '/gameboy-ws', { headers });
    sockets.push(socket);
    const hello = new Promise((resolve, reject) => {
      socket.on('message', (value) => {
        const message = JSON.parse(value.toString());
        if (message.type === 'hello') resolve(message);
      });
      socket.once('error', reject);
    });
    return { socket, hello: await hello };
  }
  return { feature, origin, room, cookie, token, account, connect, buffer };
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
  await new Promise((resolve) => setTimeout(resolve, 30));
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

test('a core that finishes loading after stop is closed instead of resurrecting the feature', async (context) => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const scene = await fixture(context, { createRoom: () => pending });
  const request = fetch(scene.origin + '/gameboy-api/load', {
    method: 'POST',
    headers: { Cookie: scene.cookie, 'Content-Type': 'application/json' },
    body: '{"file":"fixture.gb"}',
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const stopping = scene.feature.stop();
  release(scene.room);
  await stopping;
  assert.equal(scene.room.stopped, true);
  assert.equal(scene.feature.status().isStopped, true);
  assert.equal((await request).status, 503);
});
