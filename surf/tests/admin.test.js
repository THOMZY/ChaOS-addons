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

test('snapshot() expose les joueurs de la salle réelle', () => {
  const room = surfAdmin.listRooms()[0];
  const socket = fakeSocket();
  room.join(socket, { accountId: 'acc-1', name: 'Testeur', color: 'hsl(200 90% 50%)' });
  try {
    const rooms = surfAdmin.snapshot();
    const eu = rooms.find((r) => r.id === room.id);
    assert.equal(eu.players.length, 1);
    assert.equal(eu.players[0].name, 'Testeur');
    assert.ok(eu.players[0].connectionId, 'le connectionId doit être exposé pour le kick');
  } finally {
    room.connections.clear();
  }
});

test('setMap() impose la map et incrémente epoch', () => {
  const room = surfAdmin.listRooms()[0];
  const before = room.epoch;
  const result = surfAdmin.setMap(null, 'surf_lux', 'test');
  assert.equal(result.ok, true);
  assert.equal(room.mapId, 'surf_lux');
  assert.equal(room.epoch, (before + 1) >>> 0);
  assert.equal(surfAdmin.setMap(null, 'map_inexistante').ok, false);
});

test('broadcast() diffuse un « notice » à la salle', () => {
  const room = surfAdmin.listRooms()[0];
  const socket = fakeSocket();
  room.join(socket, { accountId: 'acc-2', name: 'Auditeur' });
  try {
    assert.equal(surfAdmin.broadcast(null, 'Message admin').ok, true);
    const payloads = socket.sent.map((raw) => JSON.parse(raw.toString()));
    assert.ok(payloads.some((p) => p.type === 'notice' && p.text === 'Message admin'));
    assert.equal(surfAdmin.broadcast(null, '   ').ok, false);
  } finally {
    room.connections.clear();
  }
});

test('kick() ferme le socket du joueur visé', () => {
  const room = surfAdmin.listRooms()[0];
  const socket = fakeSocket();
  const conn = room.join(socket, { accountId: 'acc-3', name: 'Cible' });
  try {
    const result = surfAdmin.kick(null, conn.player.connectionId);
    assert.equal(result.ok, true);
    assert.equal(result.name, 'Cible');
    assert.equal(socket.closed.length, 1);
    assert.equal(socket.closed[0].code, 4004);
  } finally {
    room.connections.clear();
  }
});
