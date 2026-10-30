import test from 'node:test';
import assert from 'node:assert/strict';
import { createScene } from './fixtures/worms-events.js';

function start(options) {
  const scene = createScene(options);
  scene.owner.bind();
  return scene;
}
const names = (scene) => scene.actions.map((action) => action[0]);

test('bind keeps the complete 26-event protocol inventory', () => {
  const scene = start();
  assert.equal(scene.socket.handlers.size, 26);
  for (const name of [
    'worms:rooms',
    'worms:created',
    'worms:joined',
    'worms:start',
    'worms:fire_result',
    'worms:game_over',
    'worms:error',
  ])
    assert.ok(scene.socket.handlers.has(name), name);
});
test('room snapshots preserve list identities and render only in the lobby', () => {
  const scene = start(),
    open = scene.state.openRooms,
    live = scene.state.liveRooms;
  scene.socket.fire('worms:rooms', { rooms: [{ id: 1 }], liveRooms: [{ id: 2 }] });
  assert.equal(scene.state.openRooms, open);
  assert.equal(scene.state.liveRooms, live);
  assert.deepEqual(open, [{ id: 1 }]);
  assert.deepEqual(scene.actions, []);
  scene.state.mode = 'lobby';
  scene.socket.fire('worms:rooms', { rooms: [], liveRooms: [] });
  assert.deepEqual(names(scene), ['renderLobby']);
});
test('open and live room changes are routed to their respective lists', () => {
  const scene = start();
  scene.socket.fire('worms:open', { id: 1 });
  scene.socket.fire('worms:live_open', { id: 2 });
  scene.socket.fire('worms:live_closed', { roomId: 2 });
  assert.equal(scene.actions[0][1], scene.state.openRooms);
  assert.equal(scene.actions[1][1], scene.state.liveRooms);
  assert.deepEqual(names(scene), ['noteRoomOpen', 'noteRoomOpen', 'noteRoomClosed']);
});
test('closing the current waiting room returns to the lobby and requests rooms', () => {
  const scene = start();
  scene.state.mode = 'waiting';
  scene.socket.fire('worms:closed', { roomId: 'other' });
  assert.equal(scene.state.mode, 'waiting');
  scene.socket.fire('worms:closed', { roomId: 'one' });
  assert.equal(scene.state.mode, 'lobby');
  assert.equal(scene.state.roomId, null);
  assert.deepEqual(scene.sent, [['worms:rooms_request']]);
  assert.ok(names(scene).includes('renderLobby'));
});
test('closing the watched room exits after stopping the game', () => {
  const scene = start();
  scene.state.isSpectateMode = true;
  scene.socket.fire('worms:live_closed', { roomId: 'one' });
  assert.equal(scene.state.mode, 'idle');
  assert.equal(scene.state.roomId, null);
  assert.equal(scene.state.isSpectateMode, false);
  assert.deepEqual(names(scene), ['noteRoomClosed', 'stopGame', 'onExit']);
});
test('spectator snapshots require a root and spectate mode and clear the player identity', () => {
  const scene = start();
  scene.socket.fire('worms:spectate_start', { roomId: 'two' });
  assert.deepEqual(scene.actions, []);
  scene.state.isSpectateMode = true;
  scene.socket.fire('worms:spectate_start', { roomId: 'two' });
  assert.equal(scene.state.myUserId, null);
  assert.equal(scene.state.roomId, 'two');
  assert.equal(scene.state.mode, 'game');
  assert.equal(scene.actions[0][0], 'setupGame');
});
test('lobby updates render the matching waiting room or lobby', () => {
  const scene = start();
  scene.state.mode = 'waiting';
  scene.socket.fire('worms:lobby_update', { id: 'one' });
  assert.deepEqual(names(scene), ['upsertRoom', 'renderWaiting']);
  scene.state.mode = 'lobby';
  scene.socket.fire('worms:lobby_update', { id: 'two' });
  assert.deepEqual(names(scene).slice(-2), ['upsertRoom', 'renderLobby']);
});
test('created and joined events delegate admission', () => {
  const scene = start();
  for (const name of ['worms:created', 'worms:joined'])
    scene.socket.fire(name, { roomId: 'two', room: { id: 'two' } });
  assert.deepEqual(names(scene), ['enterWaitingRoom', 'enterWaitingRoom']);
  assert.equal(scene.actions[0][1], 'two');
});
test('start keeps the stake fallback and requires a mounted root', () => {
  const scene = start();
  scene.state.hasRoot = false;
  scene.socket.fire('worms:start', { bet: 20 });
  assert.equal(scene.state.lastBet, 5);
  scene.state.hasRoot = true;
  scene.socket.fire('worms:start', {});
  assert.equal(scene.state.lastBet, 5);
  scene.socket.fire('worms:start', { bet: 20 });
  assert.equal(scene.state.lastBet, 20);
  assert.equal(scene.state.mode, 'game');
  assert.deepEqual(names(scene), ['setupGame', 'setupGame']);
});
test('positions update known worms only while in game', () => {
  const scene = start();
  scene.socket.fire('worms:pos_update', { wormId: 'w', cx: 12, cy: 34 });
  assert.equal(scene.state.worms[0].cx, 12);
  scene.state.mode = 'results';
  scene.socket.fire('worms:pos_update', { wormId: 'w', cx: 99, cy: 99 });
  assert.equal(scene.state.worms[0].cy, 34);
});
test('shot result keeps the fired guard, own ammo copy and projectile timing', () => {
  const scene = start(),
    ammo = { bazooka: 2 };
  scene.socket.fire('worms:fire_result', {
    playerId: 'a',
    ammo,
    trajectories: [Array(10).fill({ cx: 1, cy: 2 })],
    weapon: 'bazooka',
  });
  assert.equal(scene.state.hasShotFired, true);
  assert.equal(scene.state.isAnimating, true);
  assert.equal(scene.state.chargeStart, null);
  assert.deepEqual(scene.state.ammo, ammo);
  assert.notEqual(scene.state.ammo, ammo);
  assert.equal(scene.state.projectiles[0].startMs, 100);
  assert.equal(scene.history[0].delay, 700);
  assert.equal(scene.state.projectiles[0].fuseMs, null);
});
test('projectiles have a minimum impact delay of 500 ms', () => {
  const scene = start();
  scene.socket.fire('worms:fire_result', {});
  assert.equal(scene.history[0].delay, 500);
  assert.deepEqual(scene.state.projectiles, []);
});
test('grenade fuse repeats at 900 ms and is stopped at impact', () => {
  const scene = start();
  scene.socket.fire('worms:fire_result', { weapon: 'hand_grenade', fuseMs: 4000 });
  const interval = scene.history.find((entry) => entry.isInterval);
  assert.equal(interval.delay, 900);
  scene.fireTimer(interval.id);
  assert.deepEqual(
    scene.actions.filter((action) => action[0] === 'playSound'),
    [
      ['playSound', 'fuse', 0.5],
      ['playSound', 'fuse', 0.5],
    ],
  );
  scene.runTimeout(500);
  assert.equal(scene.owner.status().intervals, 0);
});
test('impact applies holes, visual reaction and deferred final worm states in order', () => {
  const scene = start(),
    holes = [{ cx: 1, cy: 2, r: 3 }],
    worms = [{ id: 'w' }],
    damages = [{ wormId: 'w', damage: 5 }];
  scene.state.wormBumps.set('w', {});
  scene.socket.fire('worms:fire_result', {
    newHoles: holes,
    worms,
    wormDamages: damages,
    weapon: 'bat',
  });
  scene.runTimeout(500);
  assert.deepEqual(names(scene), ['applyTerrainHoles', 'playHoleExplosions', 'bumpDamagedWorms']);
  assert.deepEqual(scene.actions[1].slice(1), [holes, 14, 320]);
  assert.deepEqual(scene.actions[2].at(-1), { bat: true });
  scene.runTimeout(560);
  assert.deepEqual(names(scene).slice(-3), [
    'applyWormStates',
    'addDamageLabels',
    'updateHealthBar',
  ]);
  assert.equal(scene.state.wormBumps.size, 0);
  assert.equal(scene.state.isAnimating, false);
  assert.deepEqual(scene.state.projectiles, []);
});
test('teleport impact uses server landing coordinates and a pop sound', () => {
  const scene = start();
  scene.socket.fire('worms:fire_result', { teleported: true, cx: 20, cy: 30 });
  scene.runTimeout(500);
  assert.deepEqual(
    scene.actions.find((action) => action[0] === 'spawnParticles'),
    ['spawnParticles', 20, 30, 7],
  );
  assert.deepEqual(
    scene.actions.find((action) => action[0] === 'playSound'),
    ['playSound', 'TELEPORT', 0.5],
  );
});
test('planted dynamite aligns its monotonic countdown with server wall time', () => {
  const scene = start();
  scene.socket.fire('worms:fire_result', {
    planted: true,
    weapon: 'dynamite',
    dynId: 'd',
    cx: 20,
    cy: 30,
    fuseStarted: 9500,
  });
  scene.runTimeout(500);
  assert.deepEqual(scene.state.dynamites, [
    { id: 'd', cx: 20, cy: 30, fuseMs: 5000, placedAt: -400 },
  ]);
  assert.ok(scene.actions.some((action) => action[0] === 'playSound' && action[1] === 'PLACE'));
});
test('planted mines are stored at their landing position', () => {
  const scene = start();
  scene.socket.fire('worms:fire_result', {
    planted: true,
    weapon: 'land_mine',
    mineId: 'm',
    cx: 20,
    cy: 30,
  });
  scene.runTimeout(500);
  assert.deepEqual(scene.state.mines, [{ id: 'm', cx: 20, cy: 30 }]);
});
test('next turn waits for the shot animation then is applied once', () => {
  const scene = start(),
    turn = { currentTurn: 'b' };
  scene.socket.fire('worms:fire_result', {});
  scene.socket.fire('worms:next_turn', turn);
  assert.equal(scene.state.pendingNextTurn, turn);
  scene.runTimeout(500);
  scene.runTimeout(560);
  assert.equal(scene.state.pendingNextTurn, null);
  assert.deepEqual(scene.actions.at(-1), ['applyNextTurn', turn]);
});
test('game-over impact waits 900 ms before switching to results', () => {
  const scene = start(),
    winner = { pseudo: 'A' };
  scene.socket.fire('worms:fire_result', { gameOver: true, winner });
  scene.runTimeout(500);
  scene.runTimeout(560);
  scene.runTimeout(900);
  assert.equal(scene.state.mode, 'results');
  assert.deepEqual(scene.actions.at(-1), ['renderResults', { winner, draw: false, payout: 0 }]);
  assert.equal(scene.owner.status().timeouts, 0);
});
test('tool ammo is updated only for the local player', () => {
  const scene = start(),
    ammo = { ninja_rope: 1 };
  scene.socket.fire('worms:tool_used', { playerId: 'b', ammo });
  assert.deepEqual(scene.actions, []);
  scene.socket.fire('worms:tool_used', { playerId: 'a', ammo });
  assert.deepEqual(scene.state.ammo, ammo);
  assert.notEqual(scene.state.ammo, ammo);
  assert.deepEqual(names(scene), ['updateWeaponBtns']);
});
test('drowning applies damage and health before farewell speech', () => {
  const scene = start();
  scene.socket.fire('worms:drowned', { worms: [], wormDamages: [] });
  assert.deepEqual(names(scene), [
    'applyWormStates',
    'addDamageLabels',
    'updateHealthBar',
    'playRandomSpeech',
  ]);
  assert.equal(scene.actions.at(-1)[1], 'byebye');
});
test('an idle next turn is applied immediately', () => {
  const scene = start(),
    turn = { currentTurn: 'b' };
  scene.socket.fire('worms:next_turn', turn);
  assert.deepEqual(scene.actions, [['applyNextTurn', turn]]);
});
test('delayed explosions remove only their planted object and retain damage delay', () => {
  for (const [weapon, idKey, list] of [
    ['dynamite', 'dynId', 'dynamites'],
    ['land_mine', 'mineId', 'mines'],
  ]) {
    const scene = start();
    scene.state[list] = [{ id: 'one' }, { id: 'keep' }];
    scene.socket.fire('worms:delayed_explosion', { weapon, [idKey]: 'one', newHoles: [{}] });
    assert.deepEqual(scene.state[list], [{ id: 'keep' }]);
    assert.deepEqual(scene.actions[1].slice(-2), [16, 400]);
    scene.runTimeout(560);
    assert.ok(names(scene).includes('applyWormStates'));
  }
});
test('game over renders results or exits the spectator and announces the winner', () => {
  const scene = start();
  scene.socket.fire('worms:game_over', { winner: { pseudo: 'A' } });
  assert.equal(scene.state.mode, 'results');
  assert.deepEqual(names(scene), ['stopGame', 'renderResults']);
  const spectator = start();
  spectator.state.isSpectateMode = true;
  spectator.socket.fire('worms:game_over', { winner: { pseudo: 'A' } });
  assert.equal(spectator.state.mode, 'idle');
  assert.equal(spectator.state.roomId, null);
  assert.deepEqual(names(spectator), ['stopGame', 'onExit', 'notify']);
});
test('rematch acknowledgement is room-scoped and a new lobby keeps its stake', () => {
  const scene = start();
  scene.socket.fire('worms:rematch_waiting', { roomId: 'other' });
  assert.deepEqual(scene.actions, []);
  scene.socket.fire('worms:rematch_waiting', { roomId: 'one' });
  scene.socket.fire('worms:rematch_lobby', { roomId: 'two', room: { bet: 10 } });
  assert.equal(scene.state.roomId, 'two');
  assert.equal(scene.state.lastBet, 10);
  assert.equal(scene.state.mode, 'waiting');
  assert.deepEqual(names(scene), ['markRematchWaiting', 'renderWaiting']);
});
test('post-exit ignores another room and reports insufficient balance before exiting', () => {
  const scene = start();
  scene.socket.fire('worms:post_exit', { roomId: 'other' });
  assert.deepEqual(scene.actions, []);
  scene.socket.fire('worms:post_exit', { roomId: 'one', reason: 'insufficient_balance' });
  assert.deepEqual(names(scene), ['notify', 'exit']);
});
test('forfeit announcements prefer known player names', () => {
  const scene = start();
  scene.socket.fire('worms:forfeit_player', { userId: 'a', pseudo: 'fallback' });
  assert.match(scene.actions[0][1], /<Alice>/);
});
test('retreat blocks firing and keeps the five-second fallback', () => {
  const scene = start();
  scene.state.hasShotFired = false;
  scene.socket.fire('worms:retreat', {});
  assert.equal(scene.state.isRetreating, true);
  assert.equal(scene.state.retreatEnd, 15000);
  assert.equal(scene.state.hasShotFired, true);
});
test('worm selection resets sprites and local physics before the HUD', () => {
  const scene = start();
  scene.socket.fire('worms:worm_selected', { activeWormId: 'new' });
  assert.equal(scene.state.activeWormId, 'new');
  assert.deepEqual(names(scene), ['clearSprites', 'initWsTurn', 'updateHUD']);
});
test('crate spawn starts above the world and collection updates local health/ammo', () => {
  const scene = start();
  scene.socket.fire('worms:crate_spawn', { crate: { id: 'c', cy: 100 } });
  assert.deepEqual(scene.state.crates, [{ id: 'c', cy: 100, landed: false, fallingCy: -30 }]);
  const ammo = { bazooka: 5 };
  scene.socket.fire('worms:crate_collected', {
    crateId: 'c',
    type: 'health',
    wormId: 'w',
    hp: 120,
    ammo,
  });
  assert.equal(scene.state.worms[0].hp, 120);
  assert.equal(scene.state.ammo, ammo);
  assert.deepEqual(scene.state.crates, []);
  assert.ok(names(scene).includes('playRandomSpeech'));
  assert.equal(scene.actions.at(-1)[0], 'updateHealthBar');
});
test('crate weapon pickups format the weapon label and preserve the unknown-worm fallback', () => {
  const scene = start();
  scene.socket.fire('worms:crate_collected', {
    crateId: 'c',
    weapon: 'bazooka',
    wormId: 'missing',
  });
  assert.match(scene.actions.find((action) => action[0] === 'notify')[1], /weapon:bazooka/);
  assert.match(scene.actions.find((action) => action[0] === 'notify')[1], /\?/);
});
test('recoverable errors clear only rejected action state and unknown errors stay generic', () => {
  const scene = start();
  scene.socket.fire('worms:error', { error: 'invalid_target' });
  assert.equal(scene.state.hasShotFired, false);
  assert.equal(scene.state.hasMovementToolUsed, false);
  assert.equal(scene.state.rope, null);
  assert.equal(scene.state.isJetpackActive, false);
  assert.equal(scene.state.chargeStart, null);
  assert.deepEqual(names(scene), ['updateHUD', 'notify']);
  scene.socket.fire('worms:error', { error: '__proto__' });
  assert.match(scene.actions.at(-1)[1], /games.unknownError/);
});
test('game-only events are inert outside a game', () => {
  const scene = start();
  scene.state.mode = 'lobby';
  for (const name of [
    'pos_update',
    'fire_result',
    'tool_used',
    'drowned',
    'next_turn',
    'delayed_explosion',
    'forfeit_player',
    'retreat',
    'worm_selected',
    'crate_spawn',
    'crate_collected',
  ])
    scene.socket.fire('worms:' + name, {});
  assert.deepEqual(scene.actions, []);
  assert.equal(scene.owner.status().timeouts, 0);
});
