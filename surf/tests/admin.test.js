/**
 * Tests for the in-process Surf admin bridge (moved from the site's
 * tests/server/api/games.test.js with the add-on, roadmap J7).
 *
 * Surf does not use a container: these functions act on the actual
 * rooms (`SurfRoom`), so the test joins a fake player to the real room and
 * checks observable effects — forced map, broadcast message, and player ejection.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as surfAdmin from '../server/admin.js';

/** Minimal fake socket for the room (readyState + send + close). */
function fakeSocket() {
  return {
    readyState: 1,
    sent: [],
    closed: [],
    send(data) { this.sent.push(data); },
    close(code, reason) { this.closed.push({ code, reason }); },
  };
}

test('snapshot() exposes players in the actual room', () => {
  const room = surfAdmin.listRooms()[0];
  const socket = fakeSocket();
  room.join(socket, { accountId: 'acc-1', name: 'Tester', color: 'hsl(200 90% 50%)' });
  try {
    const rooms = surfAdmin.snapshot();
    const eu = rooms.find((r) => r.id === room.id);
    assert.equal(eu.players.length, 1);
    assert.equal(eu.players[0].name, 'Tester');
    assert.ok(eu.players[0].connectionId, 'connectionId must be exposed for kicking');
  } finally {
    room.connections.clear();
  }
});

test('setMap() forces the map and increments epoch', () => {
  const room = surfAdmin.listRooms()[0];
  const before = room.epoch;
  const result = surfAdmin.setMap(null, 'surf_lux', 'test');
  assert.equal(result.ok, true);
  assert.equal(room.mapId, 'surf_lux');
  assert.equal(room.epoch, (before + 1) >>> 0);
  assert.deepEqual(surfAdmin.setMap(null, 'nonexistent_map'), { ok: false, error: 'unknown_map' });
});

test('broadcast() sends a notice to the room', () => {
  const room = surfAdmin.listRooms()[0];
  const socket = fakeSocket();
  room.join(socket, { accountId: 'acc-2', name: 'Listener' });
  try {
    assert.equal(surfAdmin.broadcast(null, 'Admin message').ok, true);
    const payloads = socket.sent.map((raw) => JSON.parse(raw.toString()));
    assert.ok(payloads.some((p) => p.type === 'notice' && p.text === 'Admin message'));
    assert.deepEqual(surfAdmin.broadcast(null, '   '), { ok: false, error: 'empty_message' });
  } finally {
    room.connections.clear();
  }
});

test('admin failures use English error codes', () => {
  for (const action of [
    () => surfAdmin.setMap('missing-room', 'surf_lux'),
    () => surfAdmin.broadcast('missing-room', 'Notice'),
    () => surfAdmin.kick('missing-room', 'missing-player'),
    () => surfAdmin.openVote('missing-room'),
  ]) assert.deepEqual(action(), { ok: false, error: 'unknown_room' });
  assert.deepEqual(surfAdmin.kick(null, 'missing-player'), { ok: false, error: 'player_not_found' });
});

test('kick() closes the targeted player socket', () => {
  const room = surfAdmin.listRooms()[0];
  const socket = fakeSocket();
  const conn = room.join(socket, { accountId: 'acc-3', name: 'Target' });
  try {
    const result = surfAdmin.kick(null, conn.player.connectionId);
    assert.equal(result.ok, true);
    assert.equal(result.name, 'Target');
    assert.equal(socket.closed.length, 1);
    assert.equal(socket.closed[0].code, 4004);
  } finally {
    room.connections.clear();
  }
});
