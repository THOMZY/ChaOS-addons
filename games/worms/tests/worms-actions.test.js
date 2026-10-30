import test from 'node:test';
import assert from 'node:assert/strict';
import { createWormsActions } from '../client/worms-actions.js';

function createScene(options = {}) {
  let owner,
    reads = 0,
    isActive = true;
  const commands = [],
    sounds = [],
    order = [];
  const state = {
    roomId: 'one',
    physics: { cx: 100, cy: 200, vy: 10, onGround: true },
    isMyTurn: true,
    hasShotFired: false,
    isAnimating: false,
    selectedWeapon: 'bazooka',
    aimAngle: 0.5,
    power: 0.75,
    mouseX: 650,
    grenadeFuse: 4,
    hasMovementToolUsed: false,
    rope: null,
    isJetpackActive: false,
    jetpackFuel: 0,
    teleportTarget: null,
  };
  owner = createWormsActions({
    getState() {
      reads++;
      options.onState?.(owner, state);
      return state;
    },
    sendCommand(name, payload) {
      commands.push([name, payload]);
      order.push(['command', state.hasShotFired, state.hasMovementToolUsed]);
      options.onSend?.(owner, state);
    },
    playSound(name, volume) {
      sounds.push([name, volume]);
      order.push(['sound', state.hasShotFired, state.hasMovementToolUsed]);
      options.onSound?.(owner, state);
    },
    targetedWeapons: new Set(['airstrike', 'napalm']),
    fuseWeapons: new Set(['hand_grenade', 'cluster_bomb', 'banana_bomb']),
    isActive: () => isActive,
  });
  return {
    owner,
    state,
    commands,
    sounds,
    order,
    get reads() {
      return reads;
    },
    deactivate() {
      isActive = false;
    },
  };
}

// These cases describe the original command payloads and local effects.
test('wrong turn, fired shot and animation suppress every action', () => {
  for (const patch of [{ isMyTurn: false }, { hasShotFired: true }, { isAnimating: true }]) {
    const scene = createScene();
    Object.assign(scene.state, patch);
    scene.owner.fire();
    assert.deepEqual(scene.commands, []);
    assert.deepEqual(scene.sounds, []);
  }
});
test('normal weapons preserve angle, power, room and optional command fields', () => {
  for (const weapon of [
    'bazooka',
    'shotgun',
    'minigun',
    'mortar',
    'drill',
    'dynamite',
    'land_mine',
    'bat',
  ]) {
    const scene = createScene();
    scene.state.selectedWeapon = weapon;
    scene.owner.fire();
    assert.deepEqual(scene.commands, [
      [
        'worms:fire',
        { roomId: 'one', angle: 0.5, power: 0.75, weapon, targetX: undefined, fuseMs: undefined },
      ],
    ]);
    assert.equal(scene.state.hasShotFired, true);
    assert.deepEqual(scene.sounds, []);
  }
});
test('airstrike and napalm forward only the horizontal pointer target', () => {
  for (const weapon of ['airstrike', 'napalm']) {
    const scene = createScene();
    scene.state.selectedWeapon = weapon;
    scene.owner.fire();
    assert.equal(scene.commands[0][1].targetX, 650);
    assert.equal(Object.hasOwn(scene.commands[0][1], 'targetY'), false);
  }
});
test('adjustable grenades convert the selected fuse seconds to milliseconds', () => {
  for (const weapon of ['hand_grenade', 'cluster_bomb', 'banana_bomb']) {
    for (const fuse of [1, 3, 5]) {
      const scene = createScene();
      scene.state.selectedWeapon = weapon;
      scene.state.grenadeFuse = fuse;
      scene.owner.fire();
      assert.equal(scene.commands[0][1].fuseMs, fuse * 1000);
    }
  }
});
test('holy grenade retains its fixed three-second fuse', () => {
  const scene = createScene();
  scene.state.selectedWeapon = 'holy_grenade';
  scene.state.grenadeFuse = 5;
  scene.owner.fire();
  assert.equal(scene.commands[0][1].fuseMs, 3000);
});
test('rope launch preserves hook origin, speed and empty anchor state', () => {
  for (const angle of [0, Math.PI / 2, Math.PI]) {
    const scene = createScene();
    scene.state.selectedWeapon = 'ninja_rope';
    scene.state.aimAngle = angle;
    scene.owner.fire();
    assert.deepEqual(scene.commands, [['worms:use_tool', { roomId: 'one', weapon: 'ninja_rope' }]]);
    assert.deepEqual(scene.state.rope, {
      state: 'flying',
      cx: 100 + Math.cos(angle) * 16,
      cy: 200 + Math.sin(angle) * 16,
      vx: Math.cos(angle) * 530,
      vy: Math.sin(angle) * 530,
      anchorX: 0,
      anchorY: 0,
      len: 0,
    });
    assert.equal(scene.state.hasMovementToolUsed, true);
    assert.deepEqual(scene.sounds, [['THROWRELEASE', 0.4]]);
  }
});
test('an existing rope is released without sending a new command', () => {
  const scene = createScene();
  scene.state.selectedWeapon = 'ninja_rope';
  scene.state.rope = { state: 'attached' };
  scene.owner.fire();
  assert.equal(scene.state.rope, null);
  assert.equal(scene.state.hasShotFired, false);
  assert.deepEqual(scene.commands, []);
});
test('rope use retains the one-action-per-turn guard', () => {
  const scene = createScene();
  scene.state.selectedWeapon = 'ninja_rope';
  scene.owner.fire();
  const rope = scene.state.rope;
  scene.owner.fire();
  assert.equal(scene.commands.length, 1);
  assert.equal(scene.state.rope, rope);
});
test('jetpack starts with full fuel and the original liftoff impulse', () => {
  const scene = createScene();
  scene.state.selectedWeapon = 'jetpack';
  scene.owner.fire();
  assert.deepEqual(scene.commands, [['worms:use_tool', { roomId: 'one', weapon: 'jetpack' }]]);
  assert.equal(scene.state.isJetpackActive, true);
  assert.equal(scene.state.jetpackFuel, 1);
  assert.equal(scene.state.physics.onGround, false);
  assert.equal(scene.state.physics.vy, -40);
  assert.equal(scene.state.hasMovementToolUsed, true);
  assert.deepEqual(scene.sounds, [['THROWRELEASE', 0.45]]);
});
test('an already active jetpack does not consume another action', () => {
  const scene = createScene();
  scene.state.selectedWeapon = 'jetpack';
  scene.state.isJetpackActive = true;
  scene.owner.fire();
  assert.equal(scene.state.hasShotFired, false);
  assert.deepEqual(scene.commands, []);
});
test('teleport requires a selected target', () => {
  const scene = createScene();
  scene.state.selectedWeapon = 'teleport';
  scene.owner.fire();
  assert.equal(scene.state.hasShotFired, false);
  assert.deepEqual(scene.commands, []);
});
test('teleport sends both coordinates at fixed angle and full power then consumes its target', () => {
  const scene = createScene();
  scene.state.selectedWeapon = 'teleport';
  scene.state.teleportTarget = { x: 150, y: 350 };
  scene.owner.fire();
  assert.deepEqual(scene.commands, [
    [
      'worms:fire',
      { roomId: 'one', angle: 0, power: 1, weapon: 'teleport', targetX: 150, targetY: 350 },
    ],
  ]);
  assert.equal(scene.state.teleportTarget, null);
  assert.equal(scene.state.hasShotFired, true);
  assert.deepEqual(scene.sounds, []);
});
test('normal and teleport commands cannot be sent twice in the same turn', () => {
  for (const weapon of ['bazooka', 'teleport']) {
    const scene = createScene();
    scene.state.selectedWeapon = weapon;
    scene.state.teleportTarget = { x: 1, y: 2 };
    scene.owner.fire();
    scene.owner.fire();
    assert.equal(scene.commands.length, 1);
  }
});
test('tool flags are committed before their sound callback', () => {
  for (const weapon of ['ninja_rope', 'jetpack']) {
    const scene = createScene();
    scene.state.selectedWeapon = weapon;
    scene.owner.fire();
    assert.deepEqual(scene.order, [
      ['command', false, false],
      ['sound', true, true],
    ]);
  }
});
test('normal shots mark the action before sending its command', () => {
  const scene = createScene();
  scene.owner.fire();
  assert.deepEqual(scene.order, [['command', true, false]]);
});
test('state accessors publish tool updates to the borrowed owner immediately', () => {
  const scene = createScene();
  let fired = false,
    rope = null;
  Object.defineProperty(scene.state, 'hasShotFired', {
    get: () => fired,
    set: (value) => {
      fired = value;
    },
  });
  Object.defineProperty(scene.state, 'rope', {
    get: () => rope,
    set: (value) => {
      rope = value;
    },
  });
  scene.state.selectedWeapon = 'ninja_rope';
  scene.owner.fire();
  assert.equal(fired, true);
  assert.equal(rope.state, 'flying');
});

test('construction is inert and stop is terminal and idempotent', () => {
  const scene = createScene();
  assert.equal(scene.reads, 0);
  assert.deepEqual(scene.owner.status(), { isStopped: false, isFiring: false });
  scene.owner.stop();
  scene.owner.stop();
  assert.equal(scene.owner.fire(), false);
  assert.equal(scene.reads, 0);
  assert.deepEqual(scene.commands, []);
});
test('reset invalidates operations without clearing borrowed game state', () => {
  const scene = createScene();
  scene.state.rope = { state: 'attached' };
  scene.state.teleportTarget = { x: 1, y: 2 };
  scene.owner.reset();
  assert.deepEqual(scene.state.rope, { state: 'attached' });
  assert.deepEqual(scene.state.teleportTarget, { x: 1, y: 2 });
  assert.equal(scene.reads, 0);
});
test('inactive scope is rejected before state access', () => {
  const scene = createScene();
  scene.deactivate();
  assert.equal(scene.owner.fire(), false);
  assert.equal(scene.reads, 0);
});
for (const operation of ['reset', 'stop'])
  test(`retirement during state access via ${operation} prevents all effects`, () => {
    const scene = createScene({ onState: (owner) => owner[operation]() });
    assert.equal(scene.owner.fire(), false);
    assert.deepEqual(scene.commands, []);
    assert.equal(scene.state.hasShotFired, false);
  });
for (const weapon of ['ninja_rope', 'jetpack', 'teleport'])
  test(`${weapon}: a new turn during send prevents old local writes`, () => {
    const scene = createScene({
      onSend(owner, state) {
        owner.reset();
        state.hasShotFired = false;
        state.teleportTarget = { x: 900, y: 400 };
      },
    });
    scene.state.selectedWeapon = weapon;
    scene.state.teleportTarget = { x: 1, y: 2 };
    assert.equal(scene.owner.fire(), false);
    assert.equal(scene.state.rope, null);
    assert.equal(scene.state.isJetpackActive, false);
    assert.equal(scene.state.jetpackFuel, 0);
    assert.equal(scene.state.physics.vy, 10);
    assert.equal(scene.state.hasShotFired, false);
    assert.deepEqual(scene.state.teleportTarget, { x: 900, y: 400 });
    assert.deepEqual(scene.sounds, []);
  });
for (const weapon of ['ninja_rope', 'jetpack'])
  test(`${weapon}: reentrant send cannot duplicate tool use`, () => {
    const scene = createScene({ onSend: (owner) => owner.fire() });
    scene.state.selectedWeapon = weapon;
    scene.owner.fire();
    assert.equal(scene.commands.length, 1);
    assert.equal(scene.sounds.length, 1);
    assert.equal(scene.owner.status().isFiring, false);
  });
test('a successor action survives the abandoned action finally block', () => {
  let shouldReplace = true;
  const scene = createScene({
    onSend(owner, state) {
      if (shouldReplace) {
        shouldReplace = false;
        owner.reset();
        state.roomId = 'two';
        state.selectedWeapon = 'bazooka';
        state.hasShotFired = false;
        owner.fire();
      }
    },
  });
  scene.state.selectedWeapon = 'ninja_rope';
  scene.owner.fire();
  assert.deepEqual(
    scene.commands.map(([name, payload]) => [name, payload.roomId]),
    [
      ['worms:use_tool', 'one'],
      ['worms:fire', 'two'],
    ],
  );
  assert.equal(scene.state.rope, null);
  assert.equal(scene.state.hasShotFired, true);
  assert.deepEqual(scene.sounds, []);
  assert.equal(scene.owner.status().isFiring, false);
});
test('reset in a sound callback cannot undo successor state', () => {
  const scene = createScene({
    onSound(owner, state) {
      owner.reset();
      state.rope = { state: 'successor' };
      state.hasShotFired = false;
    },
  });
  scene.state.selectedWeapon = 'ninja_rope';
  assert.equal(scene.owner.fire(), false);
  assert.deepEqual(scene.state.rope, { state: 'successor' });
  assert.equal(scene.state.hasShotFired, false);
});
test('stop during send prevents old tool allocation', () => {
  const scene = createScene({ onSend: (owner) => owner.stop() });
  scene.state.selectedWeapon = 'ninja_rope';
  assert.equal(scene.owner.fire(), false);
  assert.equal(scene.state.rope, null);
  assert.equal(scene.owner.status().isStopped, true);
});
test('scope deactivation during send prevents old tool allocation', () => {
  const scene = createScene({ onSend: () => scene.deactivate() });
  scene.state.selectedWeapon = 'jetpack';
  assert.equal(scene.owner.fire(), false);
  assert.equal(scene.state.isJetpackActive, false);
});
test('send errors propagate without leaving an operation lock or inventing rollback', () => {
  for (const weapon of ['bazooka', 'ninja_rope']) {
    const scene = createScene({
      onSend() {
        throw new Error('send failed');
      },
    });
    scene.state.selectedWeapon = weapon;
    assert.throws(() => scene.owner.fire(), /send failed/);
    assert.equal(scene.owner.status().isFiring, false);
    assert.equal(scene.state.hasShotFired, weapon === 'bazooka');
    assert.equal(scene.state.rope, null);
  }
});
test('sound errors leave the already sent tool committed and release the lock', () => {
  const scene = createScene({
    onSound() {
      throw new Error('sound failed');
    },
  });
  scene.state.selectedWeapon = 'jetpack';
  assert.throws(() => scene.owner.fire(), /sound failed/);
  assert.equal(scene.state.isJetpackActive, true);
  assert.equal(scene.state.hasShotFired, true);
  assert.equal(scene.owner.status().isFiring, false);
  scene.owner.fire();
  assert.equal(scene.commands.length, 1);
});
test('state access errors propagate and a later action can still proceed', () => {
  let shouldFail = true;
  const scene = createScene({
    onState() {
      if (shouldFail) throw new Error('state failed');
    },
  });
  assert.throws(() => scene.owner.fire(), /state failed/);
  assert.equal(scene.owner.status().isFiring, false);
  shouldFail = false;
  scene.owner.fire();
  assert.equal(scene.commands.length, 1);
});
test('status reports the operation only while injected effects run', () => {
  const statuses = [];
  const scene = createScene({
    onSend: (owner) => statuses.push(owner.status().isFiring),
    onSound: (owner) => statuses.push(owner.status().isFiring),
  });
  scene.state.selectedWeapon = 'ninja_rope';
  scene.owner.fire();
  assert.deepEqual(statuses, [true, true]);
  assert.equal(scene.owner.status().isFiring, false);
});
