import test from 'node:test';
import assert from 'node:assert/strict';
import { createScene } from './fixtures/worms-events.js';

function start(options) {
  const scene = createScene(options);
  scene.owner.bind();
  return scene;
}

test('construction is inert and stop is terminal and idempotent', () => {
  const scene = createScene();
  assert.equal(scene.reads, 0);
  assert.equal(scene.socket.handlers.size, 0);
  assert.equal(scene.scheduled.size, 0);
  scene.owner.stop();
  scene.owner.stop();
  assert.equal(scene.owner.bind(), false);
  assert.deepEqual(scene.owner.status(), {
    isStopped: true,
    isBound: false,
    listeners: 0,
    timeouts: 0,
    intervals: 0,
  });
});
test('reset cancels round timers while preserving all lobby subscriptions and borrowed state', () => {
  const scene = start();
  scene.socket.fire('worms:fire_result', { weapon: 'hand_grenade' });
  const projectiles = scene.state.projectiles;
  scene.owner.reset();
  assert.equal(scene.scheduled.size, 0);
  assert.equal(scene.owner.status().listeners, 26);
  assert.equal(scene.state.projectiles, projectiles);
  scene.state.mode = 'lobby';
  scene.socket.fire('worms:rooms', { rooms: [{ id: 1 }], liveRooms: [] });
  assert.deepEqual(scene.state.openRooms, [{ id: 1 }]);
});
for (const phase of ['impact', 'damage', 'results', 'delayed'])
  test(`${phase}: captured old timers cannot affect a new round`, () => {
    const scene = start();
    if (phase === 'delayed')
      scene.socket.fire('worms:delayed_explosion', { newHoles: [{ cx: 1 }] });
    else {
      scene.socket.fire('worms:fire_result', {
        weapon: 'hand_grenade',
        gameOver: phase === 'results',
      });
      if (phase !== 'impact') scene.runTimeout(500);
      if (phase === 'results') scene.runTimeout(560);
    }
    const old = scene.history.map((entry) => entry.callback);
    scene.owner.reset();
    scene.state.mode = 'game';
    scene.state.isAnimating = false;
    scene.state.projectiles = [{ next: true }];
    scene.actions.length = 0;
    for (const callback of old) callback();
    assert.deepEqual(scene.actions, []);
    assert.deepEqual(scene.state.projectiles, [{ next: true }]);
    assert.equal(scene.state.mode, 'game');
    assert.equal(scene.scheduled.size, 0);
  });
test('captured socket callbacks are inert after stop or rebind', () => {
  const scene = start();
  const old = scene.socket.captured.get('worms:retreat')[0];
  scene.owner.bind();
  scene.state.hasShotFired = false;
  old({});
  assert.equal(scene.state.hasShotFired, false);
  scene.owner.stop();
  for (const callback of scene.socket.captured.get('worms:retreat')) callback({});
  assert.equal(scene.state.hasShotFired, false);
});
test('stop removes only its listeners from a borrowed socket', () => {
  const scene = createScene();
  const foreign = () => {};
  scene.socket.on('worms:rooms', foreign);
  scene.owner.bind();
  scene.socket.fire('worms:fire_result', { weapon: 'hand_grenade' });
  scene.owner.stop();
  assert.equal(scene.socket.handlers.size, 1);
  assert.deepEqual([...scene.socket.handlers.get('worms:rooms')], [foreign]);
  assert.equal(scene.scheduled.size, 0);
});
test('rebinding never accumulates subscriptions or timers', () => {
  const scene = start();
  for (let index = 0; index < 3; index++) {
    scene.socket.fire('worms:fire_result', {});
    scene.owner.bind();
  }
  assert.equal(scene.socket.handlers.size, 26);
  assert.equal(scene.owner.status().listeners, 26);
  assert.equal(scene.scheduled.size, 0);
});
test('retirement during state access suppresses an event before it writes', () => {
  let shouldRetire = false;
  const scene = start({
    onState: (owner) => {
      if (shouldRetire) owner.reset();
    },
  });
  shouldRetire = true;
  scene.state.hasShotFired = false;
  scene.socket.fire('worms:retreat', {});
  assert.equal(scene.state.hasShotFired, false);
  assert.equal(scene.state.isRetreating, false);
});
test('retirement during a service prevents the rest of the old event', () => {
  const scene = start({
    onService(name, owner) {
      if (name === 'applyWormStates') owner.reset();
    },
  });
  scene.socket.fire('worms:drowned', {});
  assert.deepEqual(
    scene.actions.map((action) => action[0]),
    ['applyWormStates'],
  );
});
test('retirement during translation cannot clear the successor action state', () => {
  const scene = start({ onTranslate: (owner) => owner.reset() });
  scene.socket.fire('worms:error', { error: 'no_ammo' });
  assert.equal(scene.state.hasShotFired, true);
  assert.equal(scene.state.chargeStart, 10);
  assert.deepEqual(scene.actions, []);
});
test('retirement during an impact cannot schedule its old damage phase', () => {
  const scene = start({
    onService(name, owner) {
      if (name === 'applyTerrainHoles') owner.reset();
    },
  });
  scene.socket.fire('worms:fire_result', {});
  scene.runTimeout(500);
  assert.equal(scene.scheduled.size, 0);
  assert.deepEqual(
    scene.actions.map((action) => action[0]),
    ['applyTerrainHoles'],
  );
});
test('late timer allocations after reset are cleared before they can run', () => {
  const scene = start({ onTimer: (owner) => owner.reset() });
  scene.socket.fire('worms:fire_result', {});
  assert.equal(scene.scheduled.size, 0);
  assert.equal(scene.owner.status().timeouts, 0);
  scene.history[0].callback();
  assert.equal(scene.actions.length, 0);
});
test('a completed timeout cannot cancel a reused timer identifier', () => {
  const scene = start({ reuseId: 1 });
  scene.socket.fire('worms:fire_result', {});
  const old = scene.history[0].callback;
  scene.runTimeout(500);
  assert.equal(scene.owner.status().timeouts, 1);
  old();
  assert.equal(scene.scheduled.size, 1);
  assert.equal(scene.owner.status().timeouts, 1);
  scene.runTimeout(560);
  assert.equal(scene.scheduled.size, 0);
});
test('an abandoned binding cannot remove the replacement subscriptions', () => {
  let shouldReplace = true;
  const scene = createScene({
    onBind(owner) {
      if (shouldReplace) {
        shouldReplace = false;
        owner.bind();
      }
    },
  });
  assert.equal(scene.owner.bind(), false);
  assert.equal(scene.owner.status().listeners, 26);
  assert.equal(scene.socket.handlers.size, 26);
  scene.socket.fire('worms:retreat', {});
  assert.equal(scene.state.isRetreating, true);
});
test('late listener registration after stop is removed', () => {
  const scene = createScene({ onBind: (owner) => owner.stop() });
  assert.equal(scene.owner.bind(), false);
  assert.equal(scene.socket.handlers.size, 0);
  assert.equal(scene.owner.status().listeners, 0);
});
test('real subscription errors propagate after cleaning partial bindings', () => {
  const scene = createScene({
    onBind() {
      throw new Error('socket unavailable');
    },
  });
  assert.throws(() => scene.owner.bind(), /socket unavailable/);
  assert.equal(scene.socket.handlers.size, 0);
  assert.equal(scene.owner.status().isBound, false);
});
test('real service errors propagate and completed timers leave no stale deadline', () => {
  const scene = start({
    onService(name) {
      if (name === 'applyTerrainHoles') throw new Error('terrain unavailable');
    },
  });
  scene.socket.fire('worms:fire_result', {});
  assert.throws(() => scene.runTimeout(500), /terrain unavailable/);
  assert.equal(scene.owner.status().timeouts, 0);
});
test('cleanup failures are logged while all other owned resources are released', () => {
  const scene = start({
    onOff() {
      throw new Error('off failed');
    },
    onClear() {
      throw new Error('timer clear failed');
    },
  });
  scene.socket.fire('worms:fire_result', { weapon: 'hand_grenade' });
  scene.owner.stop();
  assert.equal(scene.socket.handlers.size, 0);
  assert.equal(scene.scheduled.size, 0);
  assert.equal(scene.owner.status().listeners, 0);
  assert.ok(scene.warnings.length > 0);
});
test('scope inactivity suppresses callbacks and stop still releases everything', () => {
  const scene = start();
  scene.socket.fire('worms:fire_result', { weapon: 'hand_grenade' });
  scene.deactivate();
  scene.actions.length = 0;
  for (const entry of scene.history) entry.callback();
  scene.socket.fire('worms:retreat', {});
  assert.deepEqual(scene.actions, []);
  scene.owner.stop();
  assert.equal(scene.scheduled.size, 0);
  assert.equal(scene.socket.handlers.size, 0);
});

test('retirement during a game-over state read cannot end the successor game', () => {
  let shouldRetire = false;
  const scene = start({
    onState: (owner) => {
      if (shouldRetire) owner.reset();
    },
  });
  shouldRetire = true;
  scene.socket.fire('worms:game_over', {});
  assert.equal(scene.state.mode, 'game');
  assert.deepEqual(scene.actions, []);
});
test('retirement during a results deadline state read cannot publish old results', () => {
  let shouldRetire = false;
  const scene = start({
    onState: (owner) => {
      if (shouldRetire) owner.reset();
    },
  });
  scene.socket.fire('worms:fire_result', { gameOver: true });
  scene.runTimeout(500);
  scene.runTimeout(560);
  shouldRetire = true;
  scene.actions.length = 0;
  scene.runTimeout(900);
  assert.equal(scene.state.mode, 'game');
  assert.deepEqual(scene.actions, []);
});
