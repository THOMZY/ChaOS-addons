/**
 * Integration test for the game server foundation.
 *
 * Start the application on an ephemeral port and communicate with it like the
 * client: obtain a ticket over HTTP, then open two WebSocket connections that
 * must see each other. This test verifies the complete path
 * (discovery → ticket → WebSocket upgrade → welcome → roster → pose relay).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { WebSocket } from 'ws';
import { Server as SocketIOServer } from 'socket.io';

import { registerGameServerRoutes, attachGameServerSockets, mintTicket } from '../../platform/game-servers/core.js';
import { FLAG, MAP_ROTATION } from '../server/room.js';

const PROTOCOL = 'chaos-surf-v1';

/** Start an isolated instance and return the handles needed to communicate with it. */
async function boot({ withSocketIo = false } = {}) {
  const app = express();
  app.use(express.json());
  registerGameServerRoutes(app);
  const server = http.createServer(app);
  attachGameServerSockets(server);
  // Reproduce production order: Socket.IO is added AFTER the game rooms.
  const io = withSocketIo ? new SocketIOServer(server) : null;
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, io };
}

function openSocket(base, ticket, protocol = PROTOCOL) {
  // Match the client: subprotocol first, then the ticket in second position.
  const ws = new WebSocket(`${base.replace('http', 'ws')}/servers/eu/ws?v=1`, protocol ? [protocol, ticket] : [ticket]);
  const state = { ws, messages: [], binary: [], closed: null };
  ws.on('message', (data, isBinary) => {
    if (isBinary) state.binary.push(data);
    else { try { state.messages.push(JSON.parse(data.toString())); } catch { state.messages.push(data.toString()); } }
  });
  ws.on('close', (code, reason) => { state.closed = { code, reason: reason.toString() }; });
  // A 401 rejection emits `error` on the ws client. Without a handler, Node
  // would fail the test before the assertion can check the result.
  ws.on('error', (err) => { state.error = err.message; });
  return state;
}

/** Encode a pose batch as emitted by the CLIENT (kind 1, 12-byte header). */
function encodeClientBatch({ sequence, epoch, samples }) {
  const buf = Buffer.alloc(12 + samples.length * 32);
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  v.setUint8(0, 1); v.setUint8(1, 1); v.setUint8(2, samples.length);
  v.setUint32(4, sequence, true); v.setUint32(8, epoch, true);
  samples.forEach((s, i) => {
    const o = 12 + i * 32;
    v.setUint32(o, s.time, true);
    v.setFloat32(o + 4, s.x, true); v.setFloat32(o + 8, s.y, true); v.setFloat32(o + 12, s.z, true);
    v.setInt16(o + 16, s.vx, true); v.setInt16(o + 18, s.vy, true); v.setInt16(o + 20, s.vz, true);
    v.setUint16(o + 22, Math.round((((s.yaw % 360) + 360) % 360) / 360 * 65535), true);
    v.setInt16(o + 24, Math.round((s.pitch / 90) * 32767), true);
    v.setUint8(o + 26, s.flags); v.setUint8(o + 27, 0);
    v.setFloat32(o + 28, s.seconds, true);
  });
  return buf;
}

function waitFor(predicate, what, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (predicate()) return resolve(true);
      if (Date.now() - t0 > timeout) return reject(new Error(`timeout : ${what}`));
      setTimeout(tick, 20);
    };
    tick();
  });
}

test('discovery, ticket, welcome, roster and pose relay', async (t) => {
  const { server, base } = await boot();
  const sockets = [];
  t.after(() => { for (const c of sockets) { try { c.ws.close(); } catch { /* already closed */ } } server.close(); });

  // ── Discovery ──────────────────────────────────────────────────────────────
  const listed = await (await fetch(`${base}/servers`)).json();
  assert.ok(Array.isArray(listed.servers), 'the list must contain `servers`');
  const room = listed.servers.find((s) => s.id === 'eu');
  assert.ok(room, 'the eu room must be advertised');
  assert.equal(room.online, true);
  assert.ok(MAP_ROTATION.includes(room.mapId), 'mapId must belong to the client rotation');

  // ── Latency measurement ────────────────────────────────────────────────────
  const ping = await fetch(`${base}/servers/eu/ping`);
  assert.equal(ping.status, 204);

  // ── A ticket is required ───────────────────────────────────────────────────
  const refused = openSocket(base, 'ticket-bidon');
  await waitFor(() => refused.error || refused.closed, 'rejection without a valid ticket');
  assert.match(refused.error ?? '', /401/, 'an unknown ticket must be rejected');

  // ── Valid connection ───────────────────────────────────────────────────────
  const ticketA = mintTicket('surf', { accountId: 1, name: 'Alice', color: 'hsl(52, 75%, 60%)' }).token;
  const a = openSocket(base, ticketA);
  sockets.push(a);
  await waitFor(() => a.messages.some((m) => m.type === 'welcome'), 'welcome de A');

  const welcome = a.messages.find((m) => m.type === 'welcome');
  assert.ok(welcome.player.slot >= 0, 'a slot is assigned');
  assert.equal(welcome.player.name, 'Alice');
  assert.ok(Number.isInteger(welcome.state.epoch) && welcome.state.epoch >= 1);
  assert.ok(MAP_ROTATION.includes(welcome.state.mapId), 'the forced map must exist in the client');
  assert.ok(welcome.serverTime > 0, 'the client needs serverTime for clock synchronization');
  assert.deepEqual(welcome.maps.map((m) => m.id), MAP_ROTATION, 'the rotation is advertised to the client');
  assert.ok(welcome.maps.every((m) => m.title), 'each map must include its title');
  assert.equal(welcome.players.length, 1);
  assert.equal(welcome.players[0].points, 0, 'numeric points for client toLocaleString');
  // ChaOS identity: no guest, and the ChaOS color is converted to the strict
  // format required by the client (#rrggbb), or it would be lost.
  assert.equal(welcome.player.guest, false, 'guest mode is disabled so the client enables social features');
  assert.equal(welcome.player.appearance.nameColor, '#e6d14d', 'couleur ChaOS convertie');
  assert.equal(welcome.player.rank, '', 'no rank means no badge');
  assert.equal(welcome.players[0].appearance.nameColor, '#e6d14d', 'the roster also includes the color');

  // ── A second player joins; both players can see each other ────────────────
  const ticketB = mintTicket('surf', { accountId: 2, name: 'Bob', color: '#824de6' }).token;
  const b = openSocket(base, ticketB);
  sockets.push(b);
  await waitFor(() => b.messages.some((m) => m.type === 'welcome'), 'welcome de B');
  await waitFor(
    () => {
      const last = [...a.messages].reverse().find((m) => m.type === 'roster');
      return last && last.players.length === 2;
    },
    'two-player roster received by A',
  );
  const roster = [...a.messages].reverse().find((m) => m.type === 'roster');
  assert.deepEqual(roster.players.map((p) => p.name).sort(), ['Alice', 'Bob']);
  const slotB = b.messages.find((m) => m.type === 'welcome').player.slot;
  assert.equal(roster.players.find((p) => p.name === 'Bob').slot, slotB);
  assert.equal(roster.players.find((p) => p.name === 'Bob').appearance.nameColor, '#824de6');

  // ── A publishes a pose; B receives it tagged with A's slot ────────────────
  const slotA = welcome.player.slot;
  const sample = {
    time: 480, x: 12.5, y: 64, z: -300.25,
    vx: 250, vy: 0, vz: -900,
    yaw: 45, pitch: -5, flags: FLAG.grounded, seconds: 0.48,
  };
  a.ws.send(encodeClientBatch({ sequence: 1, epoch: welcome.state.epoch, samples: [sample] }));
  await waitFor(() => b.binary.length > 0, 'snapshot received by B');

  // The server must tag the packet with the sender's REAL slot, not the slot
  // supplied by the client (99 here); this prevents a client from impersonating
  // another player.
  const snap = b.binary[0];
  assert.equal(snap[0], 1, 'version de protocole');
  assert.equal(snap[1], 2, 'snapshot type');
  assert.equal(snap.readUInt16LE(2), 1, 'un bloc');
  assert.equal(snap.readUInt16LE(4), slotA, 'block tagged with the sender slot');
  assert.equal(snap.readUInt32LE(6), 1, 'sequence transmise');
  assert.equal(snap[14], 1, 'one sample');
  assert.equal(snap.readUInt32LE(18), sample.time, 'time transmis');
  assert.ok(Math.abs(snap.readFloatLE(22) - sample.x) < 1e-6, 'x transmis');
  assert.equal(snap.readInt16LE(38), sample.vz, 'vz transmis');

  // ── A must not receive its own echo ────────────────────────────────────────
  assert.equal(a.binary.length, 0, 'no echo to the sender');

  // ── Ping / pong and chat ───────────────────────────────────────────────────
  a.ws.send('ping');
  await waitFor(() => a.messages.includes('pong'), 'pong');
  b.ws.send(JSON.stringify({ type: 'chat', text: 'salut' }));
  await waitFor(() => a.messages.some((m) => m.type === 'chat'), 'chat relayed');
  const chat = a.messages.find((m) => m.type === 'chat');
  assert.equal(chat.text, 'salut');
  assert.equal(chat.name, 'Bob');
  // The chat event includes the sender's ChaOS nickname color.
  assert.equal(chat.appearance.nameColor, '#824de6');
  assert.equal(chat.rank, '');

  // ── Leave → roster updated ────────────────────────────────────────────────
  b.ws.close();
  await waitFor(() => {
    const last = [...a.messages].reverse().find((m) => m.type === 'roster');
    return last && last.players.length === 1;
  }, 'one-player roster after departure');
});

test('the map changes epoch and notifies the client', async (t) => {
  const { server, base } = await boot();
  const ticket = mintTicket('surf', { accountId: 3, name: 'Carol' }).token;
  const c = openSocket(base, ticket);
  t.after(() => { try { c.ws.close(); } catch { /* already closed */ } server.close(); });
  await waitFor(() => c.messages.some((m) => m.type === 'welcome'), 'welcome');

  const before = c.messages.find((m) => m.type === 'welcome').state;
  // The foundation exposes the room; force a map change as a timer expiration
  // or an accepted vote would.
  const { surfGame } = await import('../server/room.js');
  surfGame.room('eu').setMap(surfGame.room('eu').mapIndex + 1, 'test');
  await waitFor(() => c.messages.some((m) => m.type === 'state' && m.state.epoch !== before.epoch), 'new state');

  const next = [...c.messages].reverse().find((m) => m.type === 'state').state;
  assert.equal(next.epoch, (before.epoch + 1) >>> 0);
  assert.notEqual(next.mapId, before.mapId);
  assert.ok(c.messages.some((m) => m.type === 'notice'), 'a notice is broadcast');
});

test('Socket.IO keeps an accepted Surf WebSocket upgrade open', async (t) => {
  const { server, base, io } = await boot({ withSocketIo: true });
  const ticket = mintTicket('surf', { accountId: 4, name: 'Dana' }).token;
  const client = openSocket(base, ticket);
  t.after(() => { try { client.ws.close(); } catch { /* already closed */ } io?.close(); server.close(); });

  await waitFor(() => client.messages.some((m) => m.type === 'welcome'), 'welcome behind Socket.IO');
  assert.equal(client.closed, null, 'Engine.IO must not destroy the Surf socket');
});
