import test from 'node:test';
import assert from 'node:assert/strict';
import { createWormsTurnAnimations } from '../client/worms-turn-animations.js';
function createScene(options = {}) {
  const state = {
      isMyTurn: true,
      physics: { walking: false },
      selectedWeapon: 'a',
      turnDeadline: 5000,
    },
    sounds = [],
    pending = new Map(),
    captured = [];
  let owner,
    sequence = 0,
    reads = 0,
    isActive = true,
    time = 1000;
  const definitions = {
    a: {
      takeOut: { img: 'take-a', frames: 10, ms: 50 },
      aim: { img: 'aim-a', frames: 32, ms: 60 },
    },
    b: { takeOut: { img: 'take-b', frames: 5, ms: 50 }, aim: null },
  };
  owner = createWormsTurnAnimations({
    getState() {
      reads++;
      options.onState?.(owner);
      return state;
    },
    getWeaponDefinition(key) {
      options.onDefinition?.(owner);
      return definitions[key];
    },
    playSound(...args) {
      sounds.push(args);
      options.onSound?.(owner);
    },
    clock() {
      options.onClock?.(owner);
      return time;
    },
    now() {
      options.onNow?.(owner);
      return time;
    },
    isActive: () => isActive,
    timers: {
      setTimeout(callback, delay) {
        const id = ++sequence;
        pending.set(id, { callback, delay });
        captured.push(callback);
        options.onTimer?.(owner);
        return id;
      },
      clearTimeout(id) {
        pending.delete(id);
      },
    },
  });
  function fire(id) {
    const entry = pending.get(id);
    pending.delete(id);
    entry.callback();
  }
  return {
    owner,
    state,
    sounds,
    pending,
    captured,
    definitions,
    fire,
    reads: () => reads,
    deactivate: () => {
      isActive = false;
    },
    setTime: (value) => {
      time = value;
    },
  };
}
test('walking sounds alternate every 220ms and idle restarts the cadence', () => {
  const s = createScene();
  s.state.physics.walking = true;
  s.owner.updateWalkSounds(0.01);
  s.owner.updateWalkSounds(0.1);
  s.owner.updateWalkSounds(0.13);
  assert.deepEqual(s.sounds, [
    ['WalkExpand', 0.25],
    ['WalkCompress', 0.25],
  ]);
  s.state.physics.walking = false;
  s.owner.updateWalkSounds(0);
  s.state.physics.walking = true;
  s.owner.updateWalkSounds(0);
  assert.equal(s.sounds[2][0], 'WalkExpand');
});
test('weapon takeout uses frame duration then enters aim', () => {
  const s = createScene();
  s.owner.updateWeaponTakeoutAnim();
  assert.equal(s.owner.getWeaponAnimation().phase, 'takeout');
  assert.equal(s.pending.get(1).delay, 500);
  s.fire(1);
  assert.equal(s.owner.getWeaponAnimation().phase, 'aim');
  assert.equal(s.owner.getWeaponAnimation().img, 'aim-a');
});
test('a weapon without aim clears animation after takeout', () => {
  const s = createScene();
  s.state.selectedWeapon = 'b';
  s.owner.updateWeaponTakeoutAnim();
  assert.equal(s.pending.get(1).delay, 250);
  s.fire(1);
  assert.equal(s.owner.getWeaponAnimation(), null);
});
test('same selection and remote turns do not schedule another takeout', () => {
  const s = createScene();
  s.state.isMyTurn = false;
  s.owner.updateWeaponTakeoutAnim();
  assert.equal(s.pending.size, 0);
  s.state.isMyTurn = true;
  s.owner.updateWeaponTakeoutAnim();
  s.owner.updateWeaponTakeoutAnim();
  assert.equal(s.pending.size, 1);
});
test('final seconds tick once then permit the same second after 950ms', () => {
  const s = createScene();
  s.owner.playTimerTickIfNeeded();
  s.owner.playTimerTickIfNeeded();
  assert.deepEqual(s.sounds, [['TIMERTICK', 0.6]]);
  assert.equal(s.pending.get(1).delay, 950);
  s.fire(1);
  s.owner.playTimerTickIfNeeded();
  assert.equal(s.sounds.length, 2);
});
test('timer ticks skip remote turn, missing deadline, more than five seconds and expired turn', () => {
  const s = createScene();
  s.state.turnDeadline = 10000;
  s.owner.playTimerTickIfNeeded();
  s.state.turnDeadline = 0;
  s.owner.playTimerTickIfNeeded();
  s.state.turnDeadline = 1000;
  s.owner.playTimerTickIfNeeded();
  s.state.turnDeadline = 5000;
  s.state.isMyTurn = false;
  s.owner.playTimerTickIfNeeded();
  assert.equal(s.sounds.length, 0);
  assert.equal(s.pending.size, 0);
});

test('animation construction is inert and inactive updates schedule nothing', () => {
  const s = createScene();
  assert.equal(s.reads(), 0);
  assert.equal(s.pending.size, 0);
  s.deactivate();
  s.owner.updateWalkSounds(1);
  s.owner.updateWeaponTakeoutAnim();
  s.owner.playTimerTickIfNeeded();
  assert.equal(s.reads(), 0);
  assert.equal(s.pending.size, 0);
});
test('A-B-A selection cannot be advanced by the first A timeout', () => {
  const s = createScene();
  s.owner.updateWeaponTakeoutAnim();
  s.state.selectedWeapon = 'b';
  s.owner.updateWeaponTakeoutAnim();
  s.state.selectedWeapon = 'a';
  s.owner.updateWeaponTakeoutAnim();
  assert.equal(s.pending.size, 1);
  s.captured[0]();
  assert.equal(s.owner.getWeaponAnimation().phase, 'takeout');
  s.fire(3);
  assert.equal(s.owner.getWeaponAnimation().phase, 'aim');
});
test('reset clears owned deadlines, ticks and animation while keeping the walking phase', () => {
  const s = createScene();
  s.state.physics.walking = true;
  s.owner.updateWalkSounds(0);
  s.owner.updateWeaponTakeoutAnim();
  s.owner.playTimerTickIfNeeded();
  s.owner.reset();
  assert.equal(s.pending.size, 0);
  assert.equal(s.owner.status().timerTicks, 0);
  assert.equal(s.owner.getWeaponAnimation(), null);
  s.state.physics.walking = false;
  s.owner.updateWalkSounds(0);
  s.state.physics.walking = true;
  s.owner.updateWalkSounds(0);
  assert.equal(s.sounds.at(-1)[0], 'WalkCompress');
});
test('retired tick callback cannot clear the following turn duplicate guard', () => {
  const s = createScene();
  s.owner.playTimerTickIfNeeded();
  const old = s.captured[0];
  s.owner.reset();
  s.owner.playTimerTickIfNeeded();
  old();
  s.owner.playTimerTickIfNeeded();
  assert.equal(s.sounds.length, 2);
  assert.equal(s.owner.status().timerTicks, 1);
});
test('stop cancels every timer and late callbacks do not read state or revive animation', () => {
  const s = createScene();
  s.owner.updateWeaponTakeoutAnim();
  s.owner.playTimerTickIfNeeded();
  s.owner.stop();
  s.owner.stop();
  const reads = s.reads();
  for (const callback of s.captured) callback();
  s.owner.updateWalkSounds(1);
  s.owner.updateWeaponTakeoutAnim();
  s.owner.playTimerTickIfNeeded();
  assert.equal(s.reads(), reads);
  assert.equal(s.pending.size, 0);
  assert.deepEqual(s.owner.status(), {
    isStopped: true,
    timers: 0,
    timerTicks: 0,
    hasWeaponAnimation: false,
  });
});
for (const hook of ['onState', 'onDefinition', 'onNow', 'onClock', 'onTimer', 'onSound']) {
  test(`animation stop during ${hook} cannot retain a newly allocated deadline`, () => {
    const s = createScene({ [hook]: (owner) => owner.stop() });
    if (hook === 'onClock' || hook === 'onSound') s.owner.playTimerTickIfNeeded();
    else s.owner.updateWeaponTakeoutAnim();
    assert.equal(s.owner.status().isStopped, true);
    assert.equal(s.owner.getWeaponAnimation(), null);
    assert.equal(s.pending.size, 0);
    assert.equal(s.owner.status().timerTicks, 0);
  });
}
test('weapon callback rechecks local turn before entering aim', () => {
  const s = createScene();
  s.owner.updateWeaponTakeoutAnim();
  s.state.isMyTurn = false;
  s.fire(1);
  assert.equal(s.owner.getWeaponAnimation().phase, 'takeout');
});
test('definition errors propagate without an owned timeout', () => {
  const s = createScene({
    onDefinition() {
      throw Error('definition failed');
    },
  });
  assert.throws(() => s.owner.updateWeaponTakeoutAnim(), /definition failed/);
  assert.equal(s.pending.size, 0);
});

test('completed weapon timer cannot cancel an unrelated timer that reuses its identifier', () => {
  const s = createScene();
  s.owner.updateWeaponTakeoutAnim();
  s.state.isMyTurn = false;
  s.fire(1);
  const foreign = { callback() {}, delay: 2000 };
  s.pending.set(1, foreign);
  s.state.isMyTurn = true;
  s.state.selectedWeapon = 'b';
  s.owner.updateWeaponTakeoutAnim();
  assert.equal(s.pending.get(1), foreign);
  s.owner.stop();
  assert.equal(s.pending.get(1), foreign);
});
