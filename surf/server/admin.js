/**
 * Admin API for the in-process Surf server.
 *
 * Remember that Surf is NOT a container. Its rooms live in the site's Node
 * process (`games/surf/server/room.js`), so start/stop actions do not apply:
 * the server is online whenever the site is online. This module gives the
 * admin panel the same controls as Minecraft/Quake: list players, change the
 * map, broadcast a message, and kick a player.
 *
 * Rooms are controlled the same way the game controls them (`setMap`
 * increments `epoch`, which makes clients reload the map). Nothing is
 * reimplemented here; the public `SurfRoom` methods are reused.
 */
import { surfGame, MAP_ROTATION, MAPS } from './room.js';

export { MAP_ROTATION, MAPS };

/** All Surf rooms (currently just one: `eu`). */
export function listRooms() {
  return surfGame.rooms();
}

export function findRoom(roomId) {
  const rooms = listRooms();
  if (!roomId) return rooms[0] ?? null;
  return rooms.find((room) => room.id === roomId) ?? null;
}

/** Serializable room view for the admin panel. */
function roomView(room) {
  return {
    id: room.id,
    name: room.name,
    region: room.region,
    capacity: room.capacity,
    players: room.players.map((player) => ({
      connectionId: player.connectionId,
      slot: player.slot,
      name: player.name,
      accountId: player.accountId,
    })),
    mapId: room.mapId,
    epoch: room.epoch,
    endsAt: room.endsAt,
    extensions: room.extensions,
    vote: room.vote ? { id: room.vote.id, choices: room.vote.choices, endsAt: room.vote.endsAt } : null,
  };
}

export function snapshot() {
  return listRooms().map(roomView);
}

/**
 * Set a map by ID (`surf_lux`) or rotation index. `setMap` resets extensions
 * and the vote, then increments `epoch`, which makes clients reload as expected
 * after an admin map change.
 */
export function setMap(roomId, mapRef, reason = 'admin') {
  const room = findRoom(roomId);
  if (!room) return { ok: false, error: 'room_inconnue' };
  const index = typeof mapRef === 'number'
    ? mapRef
    : MAP_ROTATION.indexOf(String(mapRef));
  if (index < 0) return { ok: false, error: 'map_inconnue' };
  room.setMap(index, reason);
  return { ok: true, mapId: room.mapId, epoch: room.epoch };
}

/** Broadcast a service message (the client's `notice` banner). */
export function broadcast(roomId, text) {
  const room = findRoom(roomId);
  if (!room) return { ok: false, error: 'room_inconnue' };
  const clean = String(text ?? '').slice(0, 200).trim();
  if (!clean) return { ok: false, error: 'message_vide' };
  room.broadcast({ type: 'notice', text: clean });
  return { ok: true };
}

/** Kick a player by `connectionId`. */
export function kick(roomId, connectionId) {
  const room = findRoom(roomId);
  if (!room) return { ok: false, error: 'room_inconnue' };
  const conn = room.connections.get(connectionId);
  if (!conn) return { ok: false, error: 'joueur_absent' };
  const name = conn.player.name;
  try { conn.socket.close(4004, 'Kicked by admin'); } catch { /* Already closed. */ }
  return { ok: true, name };
}

/** Start a map-change vote, as a player would with the RTV button. */
export function openVote(roomId) {
  const room = findRoom(roomId);
  if (!room) return { ok: false, error: 'room_inconnue' };
  room.openVote();
  return { ok: true };
}
