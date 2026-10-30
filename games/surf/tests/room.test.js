/**
 * Tests for the `chaos-surf-v1` codec.
 *
 * The "oracle" functions below independently reimplement the client behavior,
 * based directly on the format observed in its bundle. If they continue to
 * agree with the adapter, the client and server speak the same protocol.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  encodeSnapshot, decodeBatch, FLAG, SurfRoom, MAP_ROTATION, multiplayerUrlFor, roomBanOf,
} from '../server/room.js';
import { chatState } from '../../../server/chat/state.js';

const SAMPLE_SIZE = 32;
const HEADER_BATCH = 12;
const HEADER_SNAPSHOT = 4;
const BLOCK_HEADER = 14;

// ── Oracle: encode a client-to-server batch as the client does ───────────────
function oracleEncodeBatch({ sequence, epoch, samples }) {
  const buf = Buffer.alloc(HEADER_BATCH + samples.length * SAMPLE_SIZE);
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  v.setUint8(0, 1); v.setUint8(1, 1); v.setUint8(2, samples.length);
  v.setUint32(4, sequence, true); v.setUint32(8, epoch, true);
  samples.forEach((s, i) => oracleWriteSample(v, HEADER_BATCH + i * SAMPLE_SIZE, s));
  return buf;
}
function oracleWriteSample(v, o, s) {
  v.setUint32(o, s.time, true);
  v.setFloat32(o + 4, s.x, true); v.setFloat32(o + 8, s.y, true); v.setFloat32(o + 12, s.z, true);
  v.setInt16(o + 16, Math.round(s.vx), true);
  v.setInt16(o + 18, Math.round(s.vy), true);
  v.setInt16(o + 20, Math.round(s.vz), true);
  v.setUint16(o + 22, Math.round((((s.yaw % 360) + 360) % 360) / 360 * 65535), true);
  v.setInt16(o + 24, Math.round((s.pitch / 90) * 32767), true);
  v.setUint8(o + 26, s.flags); v.setUint8(o + 27, 0);
  v.setFloat32(o + 28, s.seconds, true);
}

// ── Oracle: decode a server-to-client snapshot as the client does ────────────
function oracleDecodeSnapshot(buf) {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  assert.equal(v.getUint8(0), 1, 'octet 0 = version de protocole');
  assert.equal(v.getUint8(1), 2, 'byte 1 = snapshot type');
  const blocks = v.getUint16(2, true);
  assert.ok(blocks <= 100, 'the client rejects more than 100 blocks');
  const parts = [];
  let r = HEADER_SNAPSHOT;
  for (let i = 0; i < blocks; i++) {
    const slot = v.getUint16(r, true);
    const sequence = v.getUint32(r + 2, true);
    const epoch = v.getUint32(r + 6, true);
    const n = v.getUint8(r + 10);
    assert.ok(n >= 1 && n <= 2, 'the client rejects 0 or more than 2 samples');
    assert.equal(v.getUint8(r + 11), 0, 'reserved byte');
    assert.equal(v.getUint16(r + 12, true), 0, 'reserved byte');
    r += BLOCK_HEADER;
    const samples = [];
    for (let k = 0; k < n; k++) {
      samples.push({
        time: v.getUint32(r, true),
        x: v.getFloat32(r + 4, true),
        y: v.getFloat32(r + 8, true),
        z: v.getFloat32(r + 12, true),
        vx: v.getInt16(r + 16, true),
        vy: v.getInt16(r + 18, true),
        vz: v.getInt16(r + 20, true),
        yaw: (v.getUint16(r + 22, true) / 65535) * 360,
        pitch: (v.getInt16(r + 24, true) / 32767) * 90,
        flags: v.getUint8(r + 26),
        seconds: v.getFloat32(r + 28, true),
      });
      assert.equal(v.getUint8(r + 27), 0, 'reserved sample byte');
      r += SAMPLE_SIZE;
    }
    parts.push({ slot, sequence, epoch, samples });
  }
  assert.equal(r, buf.byteLength, 'no extra bytes');
  return parts;
}

const sample = (over = {}) => ({
  time: 1234, x: 1.5, y: -2.25, z: 300.125,
  vx: -120, vy: 0, vz: 850,
  yaw: 91.5, pitch: -12.25, flags: FLAG.grounded, seconds: 3.5,
  ...over,
});

test('decodeBatch accepts what the client emits', () => {
  const batch = decodeBatch(oracleEncodeBatch({ sequence: 7, epoch: 3, samples: [sample(), sample({ time: 1250 })] }));
  assert.equal(batch.sequence, 7);
  assert.equal(batch.epoch, 3);
  assert.equal(batch.samples.length, 2);
  assert.equal(batch.samples[0].x, 1.5);
  assert.equal(batch.samples[0].vz, 850);
  assert.equal(batch.samples[1].time, 1250);
});

test('decodeBatch keeps useful precision (floats and angles)', () => {
  const [b] = [decodeBatch(oracleEncodeBatch({ sequence: 1, epoch: 1, samples: [sample()] }))];
  const s = b.samples[0];
  assert.equal(s.x, 1.5);
  assert.equal(s.y, -2.25);
  assert.equal(s.z, 300.125);
  assert.ok(Math.abs(s.yaw - 91.5) < 0.01, `yaw ${s.yaw}`);
  assert.ok(Math.abs(s.pitch + 12.25) < 0.01, `pitch ${s.pitch}`);
  assert.equal(s.seconds, 3.5);
});

test('encodeSnapshot produces exactly the expected size and bytes', () => {
  const blocks = [
    { slot: 0, sequence: 10, epoch: 2, samples: [sample()] },
    { slot: 3, sequence: 11, epoch: 2, samples: [sample({ time: 1300 }), sample({ time: 1316 })] },
  ];
  const buf = encodeSnapshot(blocks);
  assert.equal(buf.length, HEADER_SNAPSHOT + (BLOCK_HEADER + SAMPLE_SIZE) + (BLOCK_HEADER + 2 * SAMPLE_SIZE));
  const back = oracleDecodeSnapshot(buf);
  assert.equal(back.length, 2);
  assert.equal(back[0].slot, 0);
  assert.equal(back[1].slot, 3);
  assert.equal(back[1].sequence, 11);
  assert.equal(back[1].samples.length, 2);
  assert.equal(back[1].samples[1].time, 1316);
});

test('encodeSnapshot refuse plus de 100 blocs en tronquant proprement', () => {
  const many = Array.from({ length: 140 }, (_, i) => ({ slot: i, sequence: i, epoch: 1, samples: [sample()] }));
  const back = oracleDecodeSnapshot(encodeSnapshot(many));
  assert.equal(back.length, 100);
});

test('angle conversions: yaw wrapped into [0,360) and pitch clamped', () => {
  const back = oracleDecodeSnapshot(encodeSnapshot([
    { slot: 1, sequence: 1, epoch: 1, samples: [sample({ yaw: -45, pitch: 90 })] },
  ]));
  assert.ok(Math.abs(back[0].samples[0].yaw - 315) < 0.02, `yaw ${back[0].samples[0].yaw}`);
  assert.ok(back[0].samples[0].pitch <= 90.01);
});

test('decodeBatch rejects an invalid header', () => {
  const bad = oracleEncodeBatch({ sequence: 1, epoch: 1, samples: [sample()] });
  bad[1] = 2;                                   // Snapshot kind instead of batch kind.
  assert.throws(() => decodeBatch(bad), /Invalid header/);
  assert.throws(() => decodeBatch(Buffer.alloc(4)), /Invalid buffer length/);
});

// ── Room ─────────────────────────────────────────────────────────────────────
test('describe() exposes the fields read by the client server list', () => {
  const room = new SurfRoom({ id: 'eu', name: 'ChaOS EU', region: 'eu', capacity: 20 });
  const d = room.describe();
  for (const key of ['id', 'name', 'region', 'players', 'capacity', 'mapId', 'online', 'endsAt']) {
    assert.ok(key in d, `champ manquant : ${key}`);
  }
  assert.equal(d.online, true);
  assert.ok(MAP_ROTATION.includes(d.mapId), 'mapId must exist in the client rotation');
});

test('unique slots, released on leave, and a consistent roster', () => {
  const room = new SurfRoom({ id: 'eu', name: 'ChaOS EU', capacity: 3 });
  const sock = () => ({ readyState: 1, send() {} });
  const a = room.join(sock(), { accountId: 1, name: 'a' });
  const b = room.join(sock(), { accountId: 2, name: 'b' });
  const c = room.join(sock(), { accountId: 3, name: 'c' });
  assert.deepEqual(room.players.map((p) => p.slot).sort(), [0, 1, 2]);
  assert.equal(room.allocateSlot(), null, 'salle pleine → pas de slot');
  room.leave(b.player.connectionId);
  assert.deepEqual(room.players.map((p) => p.slot).sort(), [0, 2]);
  const d = room.join(sock(), { accountId: 4, name: 'd' });
  assert.equal(d.player.slot, 1, 'the released slot is reused');
  void a; void c;
});

test('setMap bumps the epoch and resets the timer', () => {
  const room = new SurfRoom({ id: 'eu', name: 'ChaOS EU', capacity: 4 });
  room.broadcast = () => {};
  const before = { epoch: room.epoch, mapId: room.mapId };
  room.setMap(room.mapIndex + 1, 'test');
  assert.equal(room.epoch, (before.epoch + 1) >>> 0);
  assert.notEqual(room.mapId, before.mapId);
  assert.ok(room.endsAt > Date.now());
});

test('the roster includes the fields read by the client', () => {
  const room = new SurfRoom({ id: 'eu', name: 'ChaOS EU', capacity: 4 });
  room.join({ readyState: 1, send() {} }, { accountId: 7, name: 'x' });
  const [p] = room.roster();
  // Regression: roster rendering calls `player.points.toLocaleString()`, so a
  // missing or non-numeric `points` value breaks the client player bar.
  assert.equal(typeof p.points, 'number', 'points must be a number');
  assert.ok('appearance' in p, 'appearance est attendu');
  assert.equal(typeof p.slot, 'number');
  assert.ok(p.connectionId && p.name);
  // The client gates all social features on `guest`; false is required here.
  assert.equal(p.guest, false, 'no guest concept in a room anymore');
  assert.equal(p.rank, '', 'empty rank → the client shows no label');
});

test('l\'apparence porte la couleur ChaOS convertie au format du client', () => {
  const room = new SurfRoom({ id: 'eu', name: 'ChaOS EU', capacity: 4 });
  room.join({ readyState: 1, send() {} }, { accountId: 7, name: 'Thomzy', color: 'hsl(52, 75%, 60%)' });
  const [p] = room.roster();
  // ChaOS stores colors as `hsl(...)`, but the client accepts only #rrggbb.
  assert.equal(p.appearance.nameColor, '#e6d14d');
  assert.equal(p.appearance.title, '', 'ChaOS n\'a pas de titre de joueur');
  assert.equal(p.appearance.titleColor, null);
  assert.ok(Number.isInteger(p.appearance.revision) && p.appearance.revision >= 0);
  assert.equal(p.name, 'Thomzy', 'the ChaOS nickname is preserved');
});

test('never an invalid colour sent to the client', () => {
  // The client rejects the ENTIRE appearance unless `nameColor` is exactly
  // #rrggbb, which also removes the color. Send null rather than a dubious
  // string, and verify that no value violates the contract.
  const accepted = /^#[0-9a-f]{6}$/i;
  for (const color of ['hsl(52, 75%, 60%)', 'hsl(249, 75%, 60%)', '#824DE6', null, undefined, 'nawak', '', 42]) {
    const room = new SurfRoom({ id: 'eu', name: 'ChaOS EU', capacity: 4 });
    room.join({ readyState: 1, send() {} }, { accountId: 9, name: 'x', color });
    const sent = room.roster()[0].appearance.nameColor;
    assert.ok(sent === null || accepted.test(sent), `colour out of contract: ${sent} (input ${color})`);
  }
});

test('chat includes the appearance used to color the nickname', () => {
  const room = new SurfRoom({ id: 'eu', name: 'ChaOS EU', capacity: 4 });
  const sent = [];
  room.broadcast = (m) => sent.push(m);
  const a = room.join({ readyState: 1, send() {} }, { accountId: 1, name: 'Alice', color: 'hsl(249, 75%, 60%)' });
  room.onMessage(a, { type: 'chat', text: 'salut' });

  const chat = sent.find((m) => m.type === 'chat');
  assert.equal(chat.text, 'salut');
  assert.equal(chat.name, 'Alice');
  assert.equal(chat.appearance.nameColor, '#634de6', 'ChaOS color in the chat feed');
  assert.equal(chat.rank, '', 'no rank badge');
});

test('a player ChaOS did not identify does not enter the room', () => {
  // Since guests are unsupported, there is no player to announce without an
  // account. The API rejects this earlier (401); here we verify that the core
  // does not fabricate a fallback identity such as "Guest".
  const room = new SurfRoom({ id: 'eu', name: 'ChaOS EU', capacity: 4 });
  room.join({ readyState: 1, send() {} }, { accountId: null, name: 'Player' });
  const [p] = room.roster();
  assert.equal(p.guest, false);
  assert.notEqual(p.name, 'Guest');
  assert.match(p.id, /^p_c\d+$/, 'only an ephemeral public id is exposed');
});

test('welcome.maps announces id AND title (the client resolves the map name there)', () => {
  const room = new SurfRoom({ id: 'eu', name: 'ChaOS EU', capacity: 4 });
  const w = room.welcome({ player: { slot: 0 } });
  assert.deepEqual(w.maps.map((m) => m.id), MAP_ROTATION);
  assert.ok(w.maps.every((m) => typeof m.title === 'string' && m.title.length > 0));
  assert.equal(w.maps[0].title, 'Boreas');
});

test('multiplayerUrlFor produces URLs the client can build', () => {
  const req = { get: () => 'thomzy.fr', protocol: 'https' };
  const base = multiplayerUrlFor(req);
  assert.equal(base, 'https://thomzy.fr');
  // Discovery and ping: concatenate the base URL and path.
  assert.equal(`${base}/servers`, 'https://thomzy.fr/servers');
  assert.equal(`${base}/servers/eu/ping`, 'https://thomzy.fr/servers/eu/ping');
  // WebSocket: `new URL(absolutePath, base)` always resolves from the origin.
  assert.equal(new URL('/servers/eu/ws', base).pathname, '/servers/eu/ws');
  // A non-empty base path would be ignored for the WebSocket, which is why
  // BASE_PATH is empty for this game.
  assert.equal(new URL('/servers/eu/ws', 'https://thomzy.fr/game/surf').pathname, '/servers/eu/ws');
});

// ── Spectator stream ─────────────────────────────────────────────────────────
// The client emits DETAILED spectator poses (binary kinds 3 and 4) only while
// someone watches it, 30 times a second, and hardcodes the slot to 0. The
// server must stamp the real slot and relay to the watchers only — and must
// never close the watched player's socket for a frame it does not know.

function spectatorFrame(room, kind = 3, slot = 0, epoch = null) {
  const frame = Buffer.alloc(56);
  frame[0] = 1;
  frame[1] = kind;
  frame.writeUInt16LE(slot, 2);
  frame.writeUInt32LE(5, 4);
  frame.writeUInt32LE(epoch ?? room.epoch, 8);
  return frame;
}

test('detailed spectator poses are accepted and DROPPED, never relayed', () => {
  // Why: the client decodes a detailed spectator pose only for binary kind 4
  // (`kb(e, true)`). Kind 3 falls through to the snapshot decoder, which
  // requires byte 1 to be 2, throws "Invalid snapshot header", and the client
  // closes ITSELF with 4002 — i.e. relaying those frames disconnects the
  // SPECTATOR. The watched player stays visible through the regular kind-2
  // snapshots, so the right server behaviour is to swallow them.
  const room = new SurfRoom({ id: 'eu', name: 'ChaOS EU', capacity: 4 });
  const bags = new Map();
  const sock = (name) => {
    const bag = [];
    bags.set(name, bag);
    return { readyState: 1, send: (m) => bag.push(m), close: () => bag.push({ closed: true }) };
  };
  room.join(sock('dummy'), { accountId: 10, name: 'Dummy' });
  const target = room.join(sock('target'), { accountId: 11, name: 'Target' });
  const watcher = room.join(sock('watcher'), { accountId: 12, name: 'Watcher' });
  room.setSpectator(watcher, { type: 'spectate', connectionId: target.player.connectionId, request: 1 });

  room.onBinary(target, spectatorFrame(room, 3, 0));
  room.onBinary(target, spectatorFrame(room, 4, 0));

  const binary = (name) => bags.get(name).filter((m) => Buffer.isBuffer(m));
  assert.equal(binary('watcher').length, 0, 'nothing is relayed to the spectator');
  assert.equal(binary('target').length, 0, 'nothing is echoed to the watched player');
  assert.equal(bags.get('target').filter((m) => m && m.closed).length, 0, 'the watched player stays connected');
  assert.equal(bags.get('watcher').filter((m) => m && m.closed).length, 0, 'the spectator stays connected');
});

test('an unknown binary kind is ignored, not punished with a disconnect', () => {
  const room = new SurfRoom({ id: 'eu', name: 'ChaOS EU', capacity: 4 });
  const bag = [];
  const conn = room.join({ readyState: 1, send: (m) => bag.push(m), close: () => bag.push({ closed: true }) },
    { accountId: 21, name: 'Future client' });
  room.onBinary(conn, Buffer.from([1, 9, 0, 0]));
  room.onBinary(conn, Buffer.alloc(56, 7));   // malformed batch
  assert.equal(bag.filter((m) => m && m.closed).length, 0, 'no close was sent');
});

test('a burst of poses is dropped, never a kick', () => {
  const room = new SurfRoom({ id: 'eu', name: 'ChaOS EU', capacity: 4 });
  const bag = [];
  const conn = room.join({ readyState: 1, send: (m) => bag.push(m), close: () => bag.push({ closed: true }) },
    { accountId: 22, name: 'Flood' });
  for (let i = 0; i < 300; i++) room.onBinary(conn, spectatorFrame(room, 3));
  assert.equal(bag.filter((m) => m && m.closed).length, 0, 'flooding drops frames, it does not disconnect');
});

// ── Room moderation and votes ────────────────────────────────────────────────
/** Room whose sockets record JSON messages and closes, for moderation tests. */
function moderationRoom() {
  const room = new SurfRoom({ id: 'eu', name: 'ChaOS EU', capacity: 8 });
  const join = (accountId, name, { moderator = false } = {}) => {
    const socket = {
      readyState: 1, messages: [], closed: [],
      send(data) { if (typeof data === 'string') this.messages.push(JSON.parse(data)); },
      close(code, reason) { this.closed.push({ code, reason }); this.readyState = 3; },
    };
    return room.join(socket, { accountId, name, moderator });
  };
  return { room, join };
}

test('change-map: refused to a non-moderator, applied for a site moderator', (t) => {
  const { room, join } = moderationRoom();
  const player = join('surf-player', 'Player');
  const mod = join('surf-mod', 'Mod', { moderator: true });
  chatState.modAccounts.add('surf-mod');
  t.after(() => chatState.modAccounts.delete('surf-mod'));
  const target = MAP_ROTATION[(room.mapIndex + 2) % MAP_ROTATION.length];

  room.onMessage(player, { type: 'change-map', mapId: target });
  assert.notEqual(room.mapId, target);
  assert.ok(player.socket.messages.some((m) => m.type === 'notice' && m.text === 'Moderator only.'));

  room.onMessage(mod, { type: 'change-map', mapId: target });
  assert.equal(room.mapId, target);
});

test('a moderator removed on the site loses room powers without reconnecting', (t) => {
  // Why: the ticket froze `moderator: true` at connection time; authority must
  // follow the live `chat_mods` list.
  const { room, join } = moderationRoom();
  const demoted = join('surf-demoted', 'Former mod', { moderator: true });
  const victim = join('surf-victim', 'Victim');
  chatState.modAccounts.delete('surf-demoted');
  t.after(() => chatState.modAccounts.delete('surf-demoted'));
  const before = room.mapId;

  room.onMessage(demoted, { type: 'change-map', mapId: MAP_ROTATION[(room.mapIndex + 1) % MAP_ROTATION.length] });
  room.onMessage(demoted, { type: 'moderate', playerId: victim.player.id, action: 'kick' });
  assert.equal(room.mapId, before);
  assert.deepEqual(victim.socket.closed, []);
});

test('a moderator kicks with 4009; a ban also keeps the account out of the room', (t) => {
  const { room, join } = moderationRoom();
  const mod = join('surf-mod-2', 'Mod', { moderator: true });
  chatState.modAccounts.add('surf-mod-2');
  t.after(() => chatState.modAccounts.delete('surf-mod-2'));
  const kicked = join('surf-kicked', 'Kicked');
  const banned = join('surf-banned', 'Banned');

  room.onMessage(mod, { type: 'moderate', playerId: kicked.player.id, action: 'kick' });
  assert.deepEqual(kicked.socket.closed, [{ code: 4009, reason: 'Kicked by a moderator' }]);
  assert.equal(roomBanOf('surf-kicked'), null, 'a kick is not a ban');

  room.onMessage(mod, { type: 'moderate', playerId: banned.player.id, action: 'ban', minutes: 5 });
  assert.deepEqual(banned.socket.closed, [{ code: 4009, reason: 'Banned by a moderator' }]);
  assert.ok(roomBanOf('surf-banned'));
  const back = join('surf-banned', 'Banned again');
  assert.deepEqual(back.socket.closed, [{ code: 4009, reason: 'Banned by a moderator' }]);

  room.onMessage(mod, { type: 'moderate', playerId: mod.player.id, action: 'kick' });
  assert.deepEqual(mod.socket.closed, [], 'a moderator cannot kick himself');
});

test('nominate puts the nominated map first; ballots are keyed by roster id', () => {
  const { room, join } = moderationRoom();
  const a = join('surf-voter-a', 'A');
  join('surf-voter-b', 'B');
  join('surf-voter-c', 'C');
  const nominated = MAP_ROTATION[(room.mapIndex + 7) % MAP_ROTATION.length];

  room.onMessage(a, { type: 'nominate', mapId: nominated });
  assert.equal(room.vote.kind, 'next');
  assert.equal(room.vote.choices[0], nominated);
  assert.equal(new Set(room.vote.choices).size, room.vote.choices.length, 'no duplicate choice');

  room.onMessage(a, { type: 'vote', voteId: room.vote.id, choice: nominated });
  assert.deepEqual(room.vote.ballots, { [a.player.id]: nominated });
});

test('an unknown nominated map falls back to the rotation', () => {
  const { room, join } = moderationRoom();
  const a = join('surf-voter-d', 'D');
  room.onMessage(a, { type: 'nominate', mapId: 'surf_not_installed' });
  assert.ok(!room.vote.choices.includes('surf_not_installed'));
  assert.equal(room.vote.choices.length, 3);
});

test('extend opens an extension vote; a majority for @extend extends the map', () => {
  const { room, join } = moderationRoom();
  const a = join('surf-ext-a', 'A');
  const b = join('surf-ext-b', 'B');
  const endsAt = room.endsAt;

  room.onMessage(a, { type: 'extend' });
  assert.equal(room.endsAt, endsAt, 'opening the vote does not extend yet');
  assert.deepEqual(room.vote.choices, ['@extend', '@continue']);
  assert.equal(room.state().vote.kind, 'extend', 'the client reads the vote kind');

  room.onMessage(a, { type: 'vote', voteId: room.vote.id, choice: '@extend' });
  room.onMessage(b, { type: 'vote', voteId: room.vote.id, choice: '@extend' });
  assert.equal(room.vote, null);
  assert.equal(room.extensions, 1);
  assert.equal(room.endsAt, endsAt + 15 * 60_000);
});
