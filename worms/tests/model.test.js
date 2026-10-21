import test from 'node:test';
import assert from 'node:assert/strict';

import { WormGameManager } from '../server/model.js';

const HOST = { accountId: 'host-account', userId: 'host', pseudo: 'Host', color: '#66dd33' };
const GUEST = { accountId: 'guest-account', userId: 'guest', pseudo: 'Guest', color: '#ff6633' };

function launchedGame(t) {
  const manager = new WormGameManager();
  const created = manager.createRoom(HOST, 0, 2);
  assert.equal(created.ok, true);
  assert.equal(manager.joinRoom(GUEST, created.roomId).ok, true);
  assert.equal(manager.launchRoom(HOST.accountId, created.roomId, 0).ok, true);
  const room = manager.getRoom(created.roomId);
  assert.equal(typeof manager.publicRoom, 'function');
  assert.equal(manager.publicRoom(room).id, created.roomId);
  t.after(() => manager.closeRoom(created.roomId));
  return { manager, room, roomId: created.roomId };
}

function resetFlatArena(room) {
  room.terrain = new Array(960).fill(320);
  room.mask = null;
  room.holes = [];
  const active = room.worms.find(w => w.id === room.activeWormId);
  active.cx = 120;
  active.cy = 309;
  const others = room.worms.filter(w => w.id !== active.id);
  for (let i = 0; i < others.length; i++) {
    others[i].cx = 700 + i * 20;
    others[i].cy = 309;
  }
  return active;
}

test('Worms accepts one authoritative weapon action per turn', (t) => {
  const { manager, room, roomId } = launchedGame(t);
  resetFlatArena(room);
  const before = room.playerAmmo[HOST.userId].shotgun;

  const first = manager.fire(HOST.accountId, roomId, {
    angle: -Math.PI / 3,
    power: 0.55,
    weapon: 'shotgun',
  });
  assert.equal(first.ok, true);
  assert.equal(room.playerAmmo[HOST.userId].shotgun, before - 1);

  const duplicate = manager.fire(HOST.accountId, roomId, {
    angle: -Math.PI / 3,
    power: 0.55,
    weapon: 'shotgun',
  });
  assert.deepEqual(duplicate, { ok: false, error: 'action_taken' });
  assert.equal(room.playerAmmo[HOST.userId].shotgun, before - 1);
});

test('invalid teleport keeps its ammo and does not spend the turn action', (t) => {
  const { manager, room, roomId } = launchedGame(t);
  resetFlatArena(room);
  const before = room.playerAmmo[HOST.userId].teleport;

  const invalid = manager.fire(HOST.accountId, roomId, {
    angle: 0,
    power: 1,
    weapon: 'teleport',
    targetX: 'not-a-number',
    targetY: 100,
  });

  assert.deepEqual(invalid, { ok: false, error: 'invalid_target' });
  assert.equal(room.playerAmmo[HOST.userId].teleport, before);
  assert.equal(room.turnActionTaken, false);
});

test('teleport snaps the worm onto solid, dry ground', (t) => {
  const { manager, room, roomId } = launchedGame(t);
  const active = resetFlatArena(room);

  const result = manager.fire(HOST.accountId, roomId, {
    angle: 0,
    power: 1,
    weapon: 'teleport',
    targetX: 500,
    targetY: 100,
  });

  assert.equal(result.ok, true);
  assert.equal(result.teleported, true);
  assert.equal(active.cx, 500);
  assert.ok(active.cy >= 308 && active.cy <= 310);
  assert.ok(active.cy < room.waterLevel);
});

test('airstrike uses the selected world position instead of a fixed offset', (t) => {
  const { manager, room, roomId } = launchedGame(t);
  resetFlatArena(room);

  const result = manager.fire(HOST.accountId, roomId, {
    angle: 0,
    power: 1,
    weapon: 'airstrike',
    targetX: 640,
  });

  assert.equal(result.ok, true);
  assert.equal(result.newHoles.length, 3);
  assert.deepEqual(result.newHoles.map(h => Math.round(h.cx)), [602, 640, 678]);
});

test('crate collection requires the active player to be physically nearby', (t) => {
  const { manager, room, roomId } = launchedGame(t);
  resetFlatArena(room);
  room.crates = [{ id: 'crate-1', cx: 800, cy: 309, type: 'health', weapon: null }];

  assert.equal(manager.collectCrate(HOST.accountId, roomId, 'crate-1'), null);
  assert.equal(manager.collectCrate(GUEST.accountId, roomId, 'crate-1'), null);
  assert.equal(room.crates.length, 1);
});

test('movement sync rejects impossible jumps and resolves drowning', (t) => {
  const { manager, room, roomId } = launchedGame(t);
  const active = resetFlatArena(room);

  const impossible = manager.updateWormPos(HOST.accountId, roomId, active.id, 800, 20);
  assert.equal(impossible, null);
  assert.equal(active.cx, 120);

  room.terrain = new Array(960).fill(470);
  active.cy = 450;
  room._moveAudit = new Map([[active.id, { cx: active.cx, cy: active.cy, at: Date.now() - 100 }]]);
  const drowned = manager.updateWormPos(HOST.accountId, roomId, active.id, active.cx, room.waterLevel);
  assert.ok(drowned?.drowned);
  assert.equal(active.alive, false);
  assert.equal(active.hp, 0);
});

test('movement tools spend the action without auto-firing a projectile', (t) => {
  const { manager, room, roomId } = launchedGame(t);
  resetFlatArena(room);

  const result = manager.useMovementTool(HOST.accountId, roomId, 'ninja_rope');
  assert.equal(result.ok, true);
  assert.equal(result.trajectories.length, 0);
  assert.equal(room.turnActionTaken, true);
  assert.equal(room.activeTool, 'ninja_rope');
});

test('the real level images load from the feature folder, without procedural fallback', async (t) => {
  // Why: the level directory is resolved relative to the module; moving the
  // model out of server/chat/ silently fell back to generated terrain.
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  const { preloadLevels } = await import('../server/model.js');
  await preloadLevels();
  assert.deepEqual(warnings.filter((line) => line.includes('[worms] level')), []);
});
