import test from 'node:test';
import assert from 'node:assert/strict';
import { createScene } from './fixtures/worms-round.js';

test('setup retains menu, state, terrain, view, health, camera, input and HUD order', () => {
  const scene = createScene();
  scene.owner.start(scene.data);
  assert.deepEqual(scene.order, [
    'clearMenu',
    'clearSprites',
    'markGameMode',
    'resetData',
    'prepareTerrain',
    'mountView',
    'updateHealth',
    'initTurn',
    'bindInput',
    'requestFrame',
    'updateHUD',
    'setTimeout',
  ]);
  assert.equal(scene.actions.find((action) => action[0] === 'resetData')[1], scene.data);
  assert.equal(scene.actions.find((action) => action[0] === 'prepareTerrain')[1], scene.data);
});
test('the initial frame is scheduled after input is ready', () => {
  const scene = createScene();
  scene.owner.start(scene.data);
  assert.equal(scene.frames.size, 1);
  assert.equal(scene.timers.size, 1);
  assert.ok(scene.order.indexOf('bindInput') < scene.order.indexOf('requestFrame'));
});
test('camera preserves the world-sized viewport clamp and target alignment', () => {
  const scene = createScene();
  scene.owner.start(scene.data);
  assert.deepEqual(scene.camera, { x: 0, y: 0, tx: 0, ty: 0 });
});
test('a missing active worm leaves the borrowed camera unchanged', () => {
  const scene = createScene();
  scene.data.activeWormId = 'missing';
  scene.owner.start(scene.data);
  assert.deepEqual(scene.camera, { x: 99, y: 88, tx: 77, ty: 66 });
});
test('a failed view mount prevents input, frame, HUD and sound startup', () => {
  const scene = createScene({ hasView: false });
  scene.owner.start(scene.data);
  assert.deepEqual(scene.order, [
    'clearMenu',
    'clearSprites',
    'markGameMode',
    'resetData',
    'prepareTerrain',
    'mountView',
  ]);
  assert.equal(scene.frames.size + scene.timers.size, 0);
});
test('failed input binding prevents loop and sound startup', () => {
  const scene = createScene({ hasInput: false });
  scene.owner.start(scene.data);
  assert.equal(scene.frames.size + scene.timers.size, 0);
  assert.equal(scene.order.at(-1), 'bindInput');
});
test('StartRound sound keeps its 200 ms delay and volume', () => {
  const scene = createScene();
  scene.owner.start(scene.data);
  assert.equal(scene.history.find((entry) => entry.kind === 'timer').delay, 200);
  scene.runSound();
  assert.deepEqual(scene.actions.at(-1), ['playSound', 'StartRound', 0.5]);
});
test('frame requests the next frame before physics, render and damage-label updates', () => {
  const scene = createScene();
  scene.owner.start(scene.data);
  scene.order.length = 0;
  scene.runFrame(1016);
  assert.deepEqual(scene.order, ['requestFrame', 'step', 'render', 'tickDamage']);
  assert.deepEqual(scene.actions.slice(-3), [
    ['step', 0.016],
    ['render', 1016, 0.016],
    ['tickDamage', 0.016],
  ]);
  assert.equal(scene.frames.size, 1);
});
test('frame delta keeps its 50 ms ceiling and uses the last callback time', () => {
  const scene = createScene();
  scene.owner.start(scene.data);
  scene.runFrame(1500);
  assert.deepEqual(scene.actions.at(-3), ['step', 0.05]);
  scene.runFrame(1510);
  assert.deepEqual(scene.actions.at(-3), ['step', 0.01]);
});
test('restarting keeps one pending loop', () => {
  const scene = createScene();
  scene.owner.start(scene.data);
  scene.owner.start(scene.data);
  assert.equal(scene.frames.size, 1);
});
test('construction is inert and stop is terminal/idempotent', () => {
  const scene = createScene();
  assert.deepEqual(scene.actions, []);
  assert.equal(scene.frames.size + scene.timers.size, 0);
  scene.owner.stop();
  scene.owner.stop();
  assert.equal(scene.owner.start(scene.data), false);
  assert.deepEqual(scene.owner.status(), {
    isStopped: true,
    isRunning: false,
    frames: 0,
    timeouts: 0,
  });
});
test('reset cancels frame and startup sound without changing borrowed data or camera', () => {
  const scene = createScene();
  scene.owner.start(scene.data);
  const before = { ...scene.camera };
  scene.owner.reset();
  assert.equal(scene.frames.size + scene.timers.size, 0);
  assert.deepEqual(scene.camera, before);
  assert.equal(scene.data.worms.length, 1);
  assert.equal(scene.owner.status().isRunning, false);
});
test('captured frames and startup sounds cannot run after reset or replacement', () => {
  const scene = createScene();
  scene.owner.start(scene.data);
  const old = scene.history.slice();
  scene.owner.reset();
  scene.owner.start(scene.data);
  scene.actions.length = 0;
  for (const entry of old) entry.callback(2000);
  assert.deepEqual(scene.actions, []);
  assert.equal(scene.frames.size, 1);
  assert.equal(scene.timers.size, 1);
});
test('completed startup callback stays single-use', () => {
  const scene = createScene();
  scene.owner.start(scene.data);
  const old = scene.history.find((entry) => entry.kind === 'timer').callback;
  scene.runSound();
  old();
  assert.equal(scene.actions.filter((action) => action[0] === 'playSound').length, 1);
  assert.equal(scene.owner.status().timeouts, 0);
});
test('completed frame callbacks cannot consume or replace a reused frame identifier', () => {
  const scene = createScene({ frameId: 1 });
  scene.owner.start(scene.data);
  const old = scene.history[0].callback;
  scene.runFrame(1016);
  const count = scene.actions.length;
  old(1032);
  assert.equal(scene.actions.length, count);
  assert.equal(scene.frames.size, 1);
  scene.owner.reset();
  assert.equal(scene.frames.size, 0);
});
for (const name of [
  'clearMenu',
  'resetData',
  'prepareTerrain',
  'mountView',
  'updateHealth',
  'initTurn',
  'bindInput',
  'updateHUD',
])
  test(`retirement during ${name} cancels the remaining startup`, () => {
    const scene = createScene({
      onService(service, owner) {
        if (service === name) owner.reset();
      },
    });
    assert.equal(scene.owner.start(scene.data), false);
    assert.equal(scene.frames.size + scene.timers.size, 0);
    assert.equal(scene.order.at(-1), name);
  });
for (const name of ['step', 'render', 'tickDamage'])
  test(`retirement during ${name} cancels the rest of the old frame`, () => {
    let shouldRetire = false;
    const scene = createScene({
      onService(service, owner) {
        if (shouldRetire && service === name) owner.reset();
      },
    });
    scene.owner.start(scene.data);
    shouldRetire = true;
    scene.runFrame(1016);
    assert.equal(scene.actions.at(-1)[0], name);
    assert.equal(scene.frames.size + scene.timers.size, 0);
  });
test('a replacement started during setup survives abandoned startup cleanup', () => {
  let shouldReplace = true;
  const scene = createScene({
    onService(name, owner) {
      if (name === 'resetData' && shouldReplace) {
        shouldReplace = false;
        owner.start(scene.data);
      }
    },
  });
  assert.equal(scene.owner.start(scene.data), false);
  assert.equal(scene.owner.status().isRunning, true);
  assert.equal(scene.frames.size, 1);
  assert.equal(scene.timers.size, 1);
});
for (const hook of ['onFrame', 'onTimer', 'onNow'])
  test(`retirement during ${hook} releases late allocations`, () => {
    const scene = createScene({ [hook]: (owner) => owner.reset() });
    assert.equal(scene.owner.start(scene.data), false);
    assert.equal(scene.frames.size + scene.timers.size, 0);
  });
test('an inactive scope ignores callbacks but stop still releases all allocations', () => {
  const scene = createScene();
  scene.owner.start(scene.data);
  scene.deactivate();
  scene.actions.length = 0;
  for (const entry of scene.history) entry.callback(2000);
  assert.deepEqual(scene.actions, []);
  scene.owner.stop();
  assert.equal(scene.frames.size + scene.timers.size, 0);
});
test('real setup errors propagate after cancelling allocations', () => {
  const scene = createScene({
    onService(name) {
      if (name === 'updateHUD') throw new Error('HUD unavailable');
    },
  });
  assert.throws(() => scene.owner.start(scene.data), /HUD unavailable/);
  assert.equal(scene.frames.size + scene.timers.size, 0);
  assert.equal(scene.owner.status().isRunning, false);
});
test('real frame errors propagate after cancelling the already scheduled next frame and sound', () => {
  const scene = createScene({
    onService(name) {
      if (name === 'step') throw new Error('physics failed');
    },
  });
  scene.owner.start(scene.data);
  assert.throws(() => scene.runFrame(1016), /physics failed/);
  assert.equal(scene.frames.size + scene.timers.size, 0);
  assert.equal(scene.owner.status().isRunning, false);
});
test('cleanup errors are reported while all allocations are released', () => {
  const scene = createScene({
    onCancel() {
      throw new Error('frame cancel failed');
    },
    onClear() {
      throw new Error('sound cancel failed');
    },
  });
  scene.owner.start(scene.data);
  scene.owner.stop();
  assert.equal(scene.frames.size + scene.timers.size, 0);
  assert.equal(scene.warnings.length, 2);
});

test('replacement during old frame cancellation wins over the interrupted restart', () => {
  let shouldReplace = false;
  const scene = createScene({
    onCancel(owner) {
      if (shouldReplace) {
        shouldReplace = false;
        owner.start(scene.data);
      }
    },
  });
  scene.owner.start(scene.data);
  shouldReplace = true;
  assert.equal(scene.owner.start(scene.data), false);
  assert.equal(scene.owner.status().isRunning, true);
  assert.equal(scene.frames.size, 1);
  assert.equal(scene.timers.size, 1);
});
