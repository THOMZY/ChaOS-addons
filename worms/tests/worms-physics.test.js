import test from 'node:test';
import assert from 'node:assert/strict';
import { createWormsPhysics } from '../client/worms-physics.js';

function createScene(options = {}) {
  const sounds = [],
    particles = [];
  const state = {
    physics: {
      cx: 50,
      cy: 60,
      vx: 0,
      vy: 0,
      onGround: true,
      facing: 1,
      walking: false,
      backflipping: false,
      backflipAngle: 0,
      parachute: false,
    },
    isMyTurn: true,
    isPhysicsSynced: true,
    worms: [{ id: 'a', cx: 50, cy: 60, alive: true }],
    activeWormId: 'a',
    terrain: Array(120).fill(70),
    terrainMask: null,
    holes: [],
    waterLevel: 90,
    keys: new Set(),
    rope: null,
    isJetpackActive: false,
    jetpackFuel: 0,
    hasShotFired: false,
    hasMovementToolUsed: false,
    isRetreating: false,
    isAnimating: false,
    aimAngle: 0,
  };
  let owner,
    reads = 0,
    isActive = true;
  owner = createWormsPhysics({
    getState() {
      reads++;
      options.onState?.(owner);
      return state;
    },
    playSound(...args) {
      sounds.push(args);
      options.onSound?.(owner);
    },
    spawnParticles(...args) {
      particles.push(args);
      options.onParticles?.(owner);
    },
    randomUnit() {
      options.onRandom?.(owner);
      return options.random ?? 0.75;
    },
    width: 120,
    height: 100,
    wormRadius: 10,
    isActive: () => isActive,
  });
  return {
    owner,
    state,
    body: state.physics,
    sounds,
    particles,
    step: (dt) => owner.step(dt),
    reads: () => reads,
    deactivate: () => {
      isActive = false;
    },
  };
}
function near(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} differs from ${expected}`);
}

test('turn init mirrors active worm and resets tools without replacing shared physics', () => {
  const s = createScene(),
    body = s.body;
  s.state.worms[0].cx = 40;
  s.state.worms[0].cy = 50;
  s.state.rope = {};
  s.state.isJetpackActive = true;
  s.state.jetpackFuel = 1;
  s.state.isPhysicsSynced = false;
  s.owner.initTurn();
  assert.equal(s.state.physics, body);
  assert.equal(body.cx, 40);
  assert.equal(body.cy, 50);
  assert.equal(body.onGround, true);
  assert.equal(body.facing, 1);
  assert.equal(s.state.isPhysicsSynced, true);
  assert.equal(s.state.rope, null);
  assert.equal(s.state.isJetpackActive, false);
  assert.equal(s.state.jetpackFuel, 0);
});
for (const [field, value] of [
  ['isMyTurn', false],
  ['isPhysicsSynced', false],
  ['hasShotFired', true],
  ['isAnimating', true],
]) {
  test(`step gate rejects ${field}=${value}`, () => {
    const s = createScene();
    s.state[field] = value;
    s.state.keys.add(' ');
    assert.equal(s.step(0.1), false);
    assert.equal(s.body.cy, 60);
    assert.equal(s.sounds.length, 0);
  });
}
for (const field of ['hasMovementToolUsed', 'isRetreating']) {
  test(`${field} permits movement after a shot`, () => {
    const s = createScene();
    s.state.hasShotFired = true;
    s.state[field] = true;
    s.state.keys.add('d');
    assert.equal(s.step(0.1), true);
    near(s.body.cx, 58.8);
  });
}
test('ground walking, dual-key priority and keyboard aim retain their equations', () => {
  const s = createScene();
  s.state.keys = new Set(['q', 'd', 'z']);
  s.step(0.1);
  near(s.body.cx, 41.2);
  assert.equal(s.body.facing, 1);
  near(s.state.aimAngle, -0.18);
  assert.equal(s.body.walking, true);
  s.state.keys = new Set(['s']);
  s.step(0.1);
  near(s.state.aimAngle, 0);
  assert.equal(s.body.walking, false);
});
test('forward hop consumes key and preserves impulse plus first-frame gravity/drag', () => {
  const s = createScene();
  s.state.keys.add(' ');
  s.step(0.05);
  near(s.body.vy, -215);
  near(s.body.vx, 110 * Math.exp(-0.09));
  near(s.body.cy, 49.25);
  assert.equal(s.body.onGround, false);
  assert.equal(s.state.keys.has(' '), false);
  assert.deepEqual(s.sounds, [['JUMP1', 0.5]]);
});
test('backflip uses opposite impulse, spin and one consumed key', () => {
  const s = createScene();
  s.state.keys.add('backspace');
  s.step(0.05);
  near(s.body.vy, -290);
  near(s.body.vx, -150 * Math.exp(-0.09));
  near(s.body.backflipAngle, -0.25);
  assert.equal(s.body.backflipping, true);
  assert.equal(s.state.keys.has('backspace'), false);
  assert.deepEqual(s.sounds, [['JUMP1', 0.5]]);
});
test('forward hop wins when both jump keys are down', () => {
  const s = createScene();
  s.state.keys = new Set([' ', 'backspace']);
  s.step(0);
  assert.equal(s.body.vy, -235);
  assert.equal(s.body.backflipping, false);
  assert.equal(s.state.keys.has('backspace'), true);
});
test('parachute opens above threshold, caps fall speed and damps horizontal motion', () => {
  const s = createScene();
  Object.assign(s.body, { cy: 20, onGround: false, vy: 250, vx: 100 });
  s.step(0.05);
  assert.equal(s.body.parachute, true);
  assert.equal(s.body.vy, 65);
  near(s.body.vx, 100 * Math.exp(-0.075) * Math.exp(-0.09));
  assert.deepEqual(s.sounds, [['ParachuteOpen', 0.55]]);
});
test('landing resets air flags and plays sound only above the speed threshold', () => {
  const s = createScene();
  Object.assign(s.body, {
    cy: 59,
    onGround: false,
    vy: 160,
    backflipping: true,
    backflipAngle: 2,
    parachute: false,
  });
  s.step(0.05);
  assert.equal(s.body.cy, 60);
  assert.equal(s.body.vy, 0);
  assert.equal(s.body.onGround, true);
  assert.equal(s.body.backflipping, false);
  assert.equal(s.body.backflipAngle, 0);
  assert.deepEqual(s.sounds, [['WormLanding', 0.55]]);
});
test('steep uphill blocks walking while a deep drop starts a fall', () => {
  const s = createScene();
  s.state.keys.add('d');
  s.state.terrain[59] = 40;
  s.step(0.1);
  assert.equal(s.body.cx, 50);
  s.state.terrain[59] = 95;
  s.step(0.1);
  near(s.body.cx, 58.8);
  assert.equal(s.body.onGround, false);
  assert.equal(s.body.vy, 0);
});
test('living neighbors block walking while dead neighbors do not', () => {
  const s = createScene();
  s.state.keys.add('d');
  s.state.worms.push({ id: 'b', cx: 65, cy: 60, alive: true });
  s.step(0.1);
  assert.equal(s.body.cx, 50);
  s.state.worms[1].alive = false;
  s.step(0.1);
  near(s.body.cx, 58.8);
});
test('airborne wall stops horizontal motion and ceiling cancels rising velocity', () => {
  const s = createScene();
  s.state.terrain.fill(10);
  Object.assign(s.body, { cx: 50, cy: 30, vx: 100, vy: -100, onGround: false });
  s.step(0.05);
  assert.equal(s.body.cx, 50);
  assert.equal(s.body.vx, 0);
  assert.equal(s.body.vy, 0);
});
test('collision uses pixel bounds, floor indexing and mask authority before fallback heights', () => {
  const s = createScene();
  assert.equal(s.owner.isSolid(-1, 80), false);
  assert.equal(s.owner.isSolid(120, 80), false);
  assert.equal(s.owner.isSolid(1, 100), false);
  assert.equal(s.owner.isSolid(20, 69.9), false);
  assert.equal(s.owner.isSolid(20, 70), true);
  s.state.terrainMask = new Uint8Array(120 * 100);
  s.state.terrainMask[30 * 120 + 20] = 1;
  assert.equal(s.owner.isSolid(20.9, 30.8), true);
  assert.equal(s.owner.isSolid(20, 80), false);
});
test('holes carve inclusively through the mask and change scanned surface', () => {
  const s = createScene();
  s.state.holes = [{ cx: 50, cy: 70, r: 5 }];
  assert.equal(s.owner.isSolid(50, 75), false);
  assert.equal(s.owner.isSolid(50, 76), true);
  assert.equal(s.owner.getSurfaceAt(50), 66);
});
test('surface keeps rounded columns, absent-terrain midpoint and water fallback', () => {
  const s = createScene();
  s.state.terrain[51] = 80;
  assert.equal(s.owner.getSurfaceAt(50.6), 70);
  s.state.holes = [{ cx: 50, cy: 80, r: 50 }];
  assert.equal(s.owner.getSurfaceAt(50), 90);
  s.state.terrain = null;
  assert.equal(s.owner.getSurfaceAt(50), 50);
});
test('rope hook flies with gravity and attaches on solid terrain', () => {
  const s = createScene();
  Object.assign(s.body, { cy: 20, onGround: false });
  s.state.rope = { state: 'flying', cx: 50, cy: 69, vx: 0, vy: 0 };
  s.step(0.1);
  assert.equal(s.state.rope.state, 'attached');
  assert.equal(s.body.onGround, false);
  assert.deepEqual(s.sounds[0], ['GRENADEIMPACT', 0.25]);
});
test('rope detaches beyond water/world bounds', () => {
  const s = createScene();
  s.state.rope = { state: 'flying', cx: 130, cy: 20, vx: 0, vy: 0 };
  s.step(0);
  assert.equal(s.state.rope, null);
});
test('attached rope reels, constrains radius and removes outward radial velocity', () => {
  const s = createScene();
  s.state.terrain = null;
  s.state.rope = { state: 'attached', anchorX: 50, anchorY: 0, len: 40 };
  s.state.keys.add('z');
  Object.assign(s.body, { onGround: false, cx: 50, cy: 60, vx: 0, vy: 0 });
  s.step(0.1);
  assert.equal(s.state.rope.len, 32);
  near(s.body.cy, 32);
  near(s.body.vy, 0);
});
test('rope landing detaches with its original damping and sound', () => {
  const s = createScene();
  s.state.rope = { state: 'attached', anchorX: 50, anchorY: 0, len: 200 };
  Object.assign(s.body, { onGround: false, cy: 59, vx: 10, vy: 20 });
  s.step(0.1);
  assert.equal(s.state.rope, null);
  assert.equal(s.body.onGround, true);
  assert.equal(s.body.cy, 60);
  near(s.body.vx, 10 * Math.exp(-0.06) * 0.35);
  assert.deepEqual(s.sounds, [['WormLanding', 0.4]]);
});
test('jetpack thrust drains fuel, limits vertical speed and produces deterministic particles', () => {
  const s = createScene({ random: 0.25 });
  s.state.isJetpackActive = true;
  s.state.jetpackFuel = 1;
  s.state.keys.add('z');
  Object.assign(s.body, { onGround: false, cy: 40, vy: -210 });
  s.step(0.1);
  assert.equal(s.body.vy, -220);
  near(s.state.jetpackFuel, 0.978);
  near(s.body.cy, 18);
  assert.deepEqual(s.particles, [[50, 50, 1]]);
});
test('empty jetpack falls with partial gravity then deactivates', () => {
  const s = createScene();
  s.state.isJetpackActive = true;
  Object.assign(s.body, { onGround: false, cy: 20, vy: 0 });
  s.step(0.1);
  near(s.body.vy, 26);
  assert.equal(s.state.isJetpackActive, false);
});
test('jetpack horizontal damping, ceiling clamp and landing remain intact', () => {
  const s = createScene();
  s.state.isJetpackActive = true;
  s.state.jetpackFuel = 1;
  s.state.keys = new Set(['z', 'd']);
  Object.assign(s.body, { cy: 10, onGround: false, vy: -100 });
  s.step(0.1);
  assert.equal(s.body.cy, 10);
  assert.equal(s.body.vy, 0);
  near(s.body.vx, 20 * Math.exp(-0.15));
  s.state.keys.clear();
  s.body.cy = 59;
  s.body.vy = 100;
  s.step(0.1);
  assert.equal(s.body.onGround, true);
  assert.equal(s.state.isJetpackActive, false);
  assert.equal(s.body.vx, 0);
  assert.deepEqual(s.sounds, [['WormLanding', 0.45]]);
});

test('construction and inactive entry points never read or mutate shared state', () => {
  const s = createScene();
  assert.equal(s.reads(), 0);
  s.deactivate();
  const before = JSON.stringify(s.body);
  s.owner.initTurn();
  s.owner.step(0.1);
  s.owner.isSolid(50, 80);
  s.owner.getSurfaceAt(50);
  assert.equal(s.reads(), 0);
  assert.equal(JSON.stringify(s.body), before);
  assert.equal(s.sounds.length, 0);
});
test('stop is terminal and preserves borrowed physics, masks, keys and tools', () => {
  const s = createScene(),
    body = s.body,
    keys = s.state.keys,
    terrain = s.state.terrain;
  const rope = { state: 'flying', cx: 50, cy: 20, vx: 10, vy: 0 };
  s.state.rope = rope;
  s.owner.stop();
  s.owner.stop();
  s.owner.reset();
  const reads = s.reads();
  s.owner.initTurn();
  s.owner.step(0.1);
  s.owner.isSolid(50, 80);
  s.owner.getSurfaceAt(50);
  assert.equal(s.reads(), reads);
  assert.equal(s.state.physics, body);
  assert.equal(s.state.keys, keys);
  assert.equal(s.state.terrain, terrain);
  assert.equal(s.state.rope, rope);
  assert.equal(rope.cx, 50);
  assert.deepEqual(s.owner.status(), { isStopped: true });
});
test('write-through state accessors keep scalar changes immediately visible', () => {
  const s = createScene(),
    backing = {};
  for (const key of ['isPhysicsSynced', 'rope', 'isJetpackActive', 'jetpackFuel', 'aimAngle']) {
    backing[key] = s.state[key];
    Object.defineProperty(s.state, key, {
      configurable: true,
      get: () => backing[key],
      set: (value) => {
        backing[key] = value;
      },
    });
  }
  backing.isPhysicsSynced = false;
  backing.rope = {};
  backing.isJetpackActive = true;
  backing.jetpackFuel = 1;
  s.owner.initTurn();
  assert.equal(backing.isPhysicsSynced, true);
  assert.equal(backing.rope, null);
  assert.equal(backing.isJetpackActive, false);
  assert.equal(backing.jetpackFuel, 0);
  s.state.keys.add('z');
  s.step(0.1);
  near(backing.aimAngle, -0.18);
});
test('reset during state read abandons the retired step and permits another', () => {
  let shouldReset = true;
  const s = createScene({
    onState(owner) {
      if (shouldReset) {
        shouldReset = false;
        owner.reset();
      }
    },
  });
  s.state.keys.add('d');
  assert.equal(s.step(0.1), undefined);
  assert.equal(s.body.cx, 50);
  assert.equal(s.step(0.1), true);
  near(s.body.cx, 58.8);
});
test('stop during state read prevents initialization and every movement write', () => {
  const s = createScene({ onState: (owner) => owner.stop() });
  s.body.cx = 25;
  s.state.keys.add(' ');
  s.owner.initTurn();
  s.step(0.1);
  assert.equal(s.body.cx, 25);
  assert.equal(s.body.vy, 0);
  assert.equal(s.state.keys.has(' '), true);
});
for (const action of ['stop', 'reset']) {
  test(`${action} during jump sound stops the rest of the current integration`, () => {
    const s = createScene({ onSound: (owner) => owner[action]() });
    s.state.keys.add(' ');
    assert.equal(s.step(0.1), undefined);
    assert.equal(s.body.vy, -235);
    assert.equal(s.body.cy, 60);
    assert.equal(s.body.vx, 110);
    assert.equal(s.state.keys.has(' '), false);
  });
}
test('stop during random sampling prevents emission and remaining jetpack movement', () => {
  const s = createScene({ onRandom: (owner) => owner.stop(), random: 0.25 });
  s.state.isJetpackActive = true;
  s.state.jetpackFuel = 1;
  s.state.keys.add('z');
  Object.assign(s.body, { cy: 40, onGround: false });
  assert.equal(s.step(0.1), undefined);
  assert.equal(s.particles.length, 0);
  assert.equal(s.body.cx, 50);
  assert.equal(s.body.cy, 40);
});
test('reset during particle emission abandons subsequent integration but keeps scalar writes', () => {
  const s = createScene({ onParticles: (owner) => owner.reset(), random: 0.25 });
  s.state.isJetpackActive = true;
  s.state.jetpackFuel = 1;
  s.state.keys.add('z');
  Object.assign(s.body, { cy: 40, onGround: false });
  assert.equal(s.step(0.1), undefined);
  assert.equal(s.particles.length, 1);
  near(s.state.jetpackFuel, 0.978);
  assert.equal(s.body.cy, 40);
});
test('landing observers see a detached rope before sound playback', () => {
  let s;
  s = createScene({
    onSound() {
      assert.equal(s.state.rope, null);
      assert.equal(s.body.onGround, true);
    },
  });
  s.state.rope = { state: 'attached', anchorX: 50, anchorY: 0, len: 200 };
  Object.assign(s.body, { cy: 59, vy: 20, onGround: false });
  s.step(0.1);
});
test('real sound failures propagate without continuing the step', () => {
  const s = createScene({
    onSound() {
      throw Error('playback failed');
    },
  });
  s.state.keys.add(' ');
  assert.throws(() => s.step(0.1), /playback failed/);
  assert.equal(s.body.cy, 60);
  assert.equal(s.body.vy, -235);
});
