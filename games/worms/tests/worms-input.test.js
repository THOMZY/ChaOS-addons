import test from 'node:test';
import assert from 'node:assert/strict';
import { createWormsInput } from '../client/worms-input.js';
import { readLegacyGameKey } from '../../../website/core/js/games/input/keyboard-layout.js';

function createScene(options = {}) {
  let owner,
    time = 1000,
    reads = 0,
    isActive = true,
    isVisible = true,
    isOwned = true;
  const actions = [],
    warnings = [],
    targets = [];
  const state = {
    keys: new Set(),
    physics: { cx: 100, cy: 200, facing: 1 },
    worms: [
      { id: 'a1', playerId: 'a', alive: true, cx: 480, cy: 240 },
      { id: 'a2', playerId: 'a', alive: true },
      { id: 'dead', playerId: 'a', alive: false },
      { id: 'b1', playerId: 'b', alive: true },
    ],
    activeWormId: 'a1',
    myUserId: 'a',
    isMyTurn: true,
    hasShotFired: false,
    isAnimating: false,
    selectedWeapon: 'bazooka',
    isPhysicsSynced: false,
    chargeStart: null,
    power: 0,
    aimAngle: 0,
    mouseX: 480,
    mouseY: 240,
    grenadeFuse: 3,
    teleportTarget: null,
  };
  function createTarget() {
    const handlers = new Map(),
      captured = new Map(),
      captures = new Set(),
      released = [];
    const target = {
      on(type, callback, options) {
        if (!handlers.has(type)) handlers.set(type, new Set());
        handlers.get(type).add(callback);
        if (!captured.has(type)) captured.set(type, []);
        captured.get(type).push(callback);
        options?.signal?.addEventListener('abort', () => target.off(type, callback), {
          once: true,
        });
      },
      off(type, callback) {
        handlers.get(type)?.delete(callback);
      },
      fire(type, values = {}) {
        const event = {
          type,
          key: 'q',
          button: 0,
          pointerId: 7,
          clientX: 480,
          clientY: 240,
          repeat: false,
          prevented: false,
          preventDefault() {
            this.prevented = true;
          },
          ...values,
        };
        for (const callback of [...(handlers.get(type) ?? [])]) callback(event);
        return event;
      },
      capture(type) {
        return [...(captured.get(type) ?? [])];
      },
      count() {
        return [...handlers.values()].reduce((total, values) => total + values.size, 0);
      },
      getBoundingClientRect() {
        options.onRect?.(owner);
        return options.rect ?? { left: 0, top: 0, width: 960, height: 480 };
      },
      setPointerCapture(id) {
        options.onCapture?.(owner);
        captures.add(id);
      },
      hasPointerCapture: (id) => captures.has(id),
      releasePointerCapture(id) {
        captures.delete(id);
        released.push(id);
        options.onRelease?.(owner);
      },
      captures,
      released,
    };
    targets.push(target);
    return target;
  }
  const document = createTarget(),
    canvas = createTarget();
  const on = (target, type, callback, signal) => {
    target.on(type, callback, signal);
    options.onBind?.(owner);
  };
  const off = (target, type, callback) => {
    target.off(type, callback);
    options.onRemove?.(owner);
  };
  owner = createWormsInput({
    getState() {
      reads++;
      options.onState?.(owner);
      return state;
    },
    eventTarget: document,
    readKey: options.readKey,
    on,
    off,
    ownsInput(event) {
      options.onOwns?.(owner);
      return isOwned && !event.ctrlKey && !event.altKey && !event.metaKey && !event.isComposing;
    },
    isVisible() {
      options.onVisible?.(owner);
      return isVisible;
    },
    isActive: () => isActive,
    fuseWeapons: new Set(['hand_grenade', 'holy_grenade']),
    selectWeapon: (weapon) => {
      actions.push(['weapon', weapon]);
      state.selectedWeapon = weapon;
    },
    updateFuseDisplay: () => actions.push(['fuse', state.grenadeFuse]),
    selectWorm: (id) => actions.push(['worm', id]),
    playSound: (...args) => {
      options.onSound?.(owner);
      actions.push(['sound', ...args]);
    },
    playRandomSpeech: (name) => {
      options.onSpeech?.(owner);
      actions.push(['speech', name]);
    },
    fire: () => {
      actions.push(['fire', state.power, state.teleportTarget]);
      options.onFire?.(owner);
    },
    now() {
      options.onNow?.(owner);
      return time;
    },
    logger: { warn: (...args) => warnings.push(args) },
  });
  return {
    owner,
    state,
    document,
    canvas,
    targets,
    actions,
    warnings,
    createTarget,
    on,
    off,
    get reads() {
      return reads;
    },
    setTime(value) {
      time = value;
    },
    deactivate() {
      isActive = false;
    },
    hide() {
      isVisible = false;
    },
    disown() {
      isOwned = false;
    },
  };
}

// These cases preserve the original input rules and numeric formulas.
test('physical AZERTY and QWERTY movement keys share the same Worms actions', () => {
  const scene = createScene({ readKey: readLegacyGameKey });
  scene.owner.bind(scene.canvas);
  for (const key of ['q', 'a']) {
    scene.document.fire('keydown', { key, code: 'KeyA' });
    assert.equal(scene.state.keys.has('q'), true);
    scene.document.fire('keyup', { key, code: 'KeyA' });
    assert.equal(scene.state.keys.has('q'), false);
  }
  scene.document.fire('keydown', { key: '&', code: 'Digit1' });
  assert.deepEqual(scene.actions.at(-1), ['weapon', 'bazooka']);
});
test('movement keys prevent browser defaults and release shared keys', () => {
  const scene = createScene();
  scene.owner.bind(scene.canvas);
  for (const key of [
    'q',
    'D',
    'z',
    's',
    ' ',
    'ArrowLeft',
    'ArrowRight',
    'ArrowUp',
    'ArrowDown',
    'Backspace',
  ]) {
    assert.equal(scene.document.fire('keydown', { key }).prevented, true);
    assert.ok(scene.state.keys.has(key.toLowerCase()));
    scene.document.fire('keyup', { key });
    assert.equal(scene.state.keys.size, 0);
  }
});
test('unowned and modified keyboard events cannot move or fire', () => {
  const scene = createScene();
  scene.owner.bind(scene.canvas);
  for (const modifier of ['ctrlKey', 'altKey', 'metaKey', 'isComposing'])
    scene.document.fire('keydown', { key: 'Enter', [modifier]: true });
  scene.disown();
  scene.document.fire('keydown', { key: 'q' });
  assert.equal(scene.state.keys.size, 0);
  assert.deepEqual(scene.actions, []);
});
test('all weapon shortcuts preserve the catalogue mapping', () => {
  const scene = createScene();
  scene.owner.bind(scene.canvas);
  const shortcuts = {
    1: 'bazooka',
    2: 'hand_grenade',
    3: 'cluster_bomb',
    4: 'shotgun',
    5: 'minigun',
    6: 'mortar',
    7: 'airstrike',
    8: 'drill',
    9: 'dynamite',
    0: 'holy_grenade',
    a: 'banana_bomb',
    e: 'napalm',
    r: 'land_mine',
    t: 'ninja_rope',
    y: 'jetpack',
    u: 'bat',
    i: 'teleport',
  };
  for (const [key, weapon] of Object.entries(shortcuts)) {
    scene.state.selectedWeapon = 'bazooka';
    scene.document.fire('keydown', { key });
    assert.deepEqual(scene.actions.at(-1), ['weapon', weapon]);
  }
});
test('fuse digits take priority over weapons only while a grenade can act', () => {
  const scene = createScene();
  scene.owner.bind(scene.canvas);
  scene.state.selectedWeapon = 'hand_grenade';
  for (const key of ['1', '2', '3', '4', '5']) {
    scene.document.fire('keydown', { key });
    assert.deepEqual(scene.actions.at(-1), ['fuse', Number(key)]);
  }
  scene.state.hasShotFired = true;
  scene.document.fire('keydown', { key: '2' });
  assert.deepEqual(scene.actions.at(-1), ['weapon', 'hand_grenade']);
});
test('worm cycling skips dead and opposing worms, wraps and ignores repeats', () => {
  const scene = createScene();
  scene.owner.bind(scene.canvas);
  assert.equal(scene.document.fire('keydown', { key: 'c' }).prevented, true);
  assert.deepEqual(scene.actions.at(-1), ['worm', 'a2']);
  scene.state.activeWormId = 'a2';
  scene.document.fire('keydown', { key: 'c' });
  assert.deepEqual(scene.actions.at(-1), ['worm', 'a1']);
  scene.state.activeWormId = 'missing';
  scene.document.fire('keydown', { key: 'c' });
  assert.deepEqual(scene.actions.at(-1), ['worm', 'a1']);
  const count = scene.actions.length;
  scene.document.fire('keydown', { key: 'c', repeat: true });
  scene.state.isMyTurn = false;
  scene.document.fire('keydown', { key: 'c' });
  assert.equal(scene.actions.length, count);
});
test('one live worm cannot cycle', () => {
  const scene = createScene();
  scene.state.worms[1].alive = false;
  scene.owner.bind(scene.canvas);
  scene.document.fire('keydown', { key: 'c' });
  assert.deepEqual(scene.actions, []);
});
for (const [name, rect, point, expected] of [
  [
    'wide letterbox',
    { left: 10, top: 20, width: 1200, height: 480 },
    { clientX: 610, clientY: 260 },
    [480, 240],
  ],
  [
    'tall letterbox',
    { left: 10, top: 20, width: 960, height: 800 },
    { clientX: 250, clientY: 420 },
    [240, 240],
  ],
  [
    'outside clamping',
    { left: 10, top: 20, width: 960, height: 480 },
    { clientX: -100, clientY: 2000 },
    [0, 480],
  ],
])
  test(`${name}: pointer maps into the world`, () => {
    const scene = createScene({ rect });
    scene.owner.bind(scene.canvas);
    scene.canvas.fire('pointermove', point);
    assert.equal(scene.state.mouseX, expected[0]);
    assert.equal(scene.state.mouseY, expected[1]);
  });
test('zero-size canvas does not update aim or pointer state', () => {
  const scene = createScene({ rect: { left: 0, top: 0, width: 0, height: 0 } });
  scene.owner.bind(scene.canvas);
  scene.canvas.fire('pointermove', { clientX: 1, clientY: 1 });
  assert.equal(scene.state.mouseX, 480);
  assert.equal(scene.state.aimAngle, 0);
});
test('pointer aim uses active or synced physics origin and preserves held keyboard aim', () => {
  const scene = createScene();
  scene.owner.bind(scene.canvas);
  scene.canvas.fire('pointermove', { clientX: 0, clientY: 240 });
  assert.equal(scene.state.aimAngle, Math.PI);
  assert.equal(scene.state.physics.facing, -1);
  scene.state.isPhysicsSynced = true;
  scene.canvas.fire('pointermove', { clientX: 100, clientY: 300 });
  assert.equal(scene.state.aimAngle, Math.PI / 2);
  for (const key of ['z', 's', 'arrowup', 'arrowdown']) {
    scene.state.keys.add(key);
    scene.canvas.fire('pointermove', { clientX: 500, clientY: 200 });
    assert.equal(scene.state.aimAngle, Math.PI / 2);
    scene.state.keys.clear();
  }
  scene.state.hasShotFired = true;
  scene.canvas.fire('pointermove', { clientX: 100, clientY: 0 });
  assert.equal(scene.state.aimAngle, Math.PI / 2);
});
test('pointer charging preserves sound, speech and clamped power', () => {
  for (const [duration, power] of [
    [0, 0.08],
    [750, 0.5],
    [2000, 1],
  ]) {
    const scene = createScene();
    scene.owner.bind(scene.canvas);
    scene.canvas.fire('pointerdown');
    assert.equal(scene.state.chargeStart, 1000);
    scene.setTime(1000 + duration);
    scene.canvas.fire('pointerup');
    assert.equal(scene.state.power, power);
    assert.equal(scene.state.chargeStart, null);
    assert.deepEqual(scene.actions, [
      ['sound', 'THROWPOWERUP', 0.35],
      ['speech', 'fire'],
      ['fire', power, null],
    ]);
  }
});
test('Enter repeat cannot restart charging and release fires once', () => {
  const scene = createScene();
  scene.owner.bind(scene.canvas);
  scene.document.fire('keydown', { key: 'Enter' });
  scene.setTime(1750);
  scene.document.fire('keydown', { key: 'Enter', repeat: true });
  assert.equal(scene.state.chargeStart, 1000);
  scene.document.fire('keyup', { key: 'Enter' });
  assert.equal(scene.state.power, 0.5);
  assert.equal(scene.actions.filter((action) => action[0] === 'fire').length, 1);
});
test('teleport click chooses a target and fires at full power immediately', () => {
  const scene = createScene();
  scene.state.selectedWeapon = 'teleport';
  scene.owner.bind(scene.canvas);
  scene.canvas.fire('pointerdown', { clientX: 120, clientY: 350 });
  assert.deepEqual(scene.actions, [
    ['speech', 'fire'],
    ['fire', 1, { x: 120, y: 350 }],
  ]);
  assert.equal(scene.state.chargeStart, null);
});
test('wrong button, turn, animation and already fired state suppress charging', () => {
  for (const patch of [{ isMyTurn: false }, { hasShotFired: true }, { isAnimating: true }]) {
    const scene = createScene();
    Object.assign(scene.state, patch);
    scene.owner.bind(scene.canvas);
    scene.canvas.fire('pointerdown');
    scene.document.fire('keydown', { key: 'Enter' });
    assert.deepEqual(scene.actions, []);
  }
  const scene = createScene();
  scene.owner.bind(scene.canvas);
  scene.canvas.fire('pointerdown', { button: 2 });
  assert.deepEqual(scene.actions, []);
});
test('shot becoming ineligible cancels the charge without firing', () => {
  const scene = createScene();
  scene.owner.bind(scene.canvas);
  scene.document.fire('keydown', { key: 'Enter' });
  scene.state.isAnimating = true;
  scene.document.fire('keyup', { key: 'Enter' });
  assert.equal(scene.state.chargeStart, null);
  assert.equal(scene.actions.length, 1);
});

test('construction is inert; stop is terminal and idempotent', () => {
  const scene = createScene();
  assert.equal(scene.reads, 0);
  assert.equal(scene.document.count(), 0);
  scene.owner.stop();
  scene.owner.stop();
  assert.equal(scene.owner.bind(scene.canvas), false);
  assert.deepEqual(scene.owner.status(), {
    isStopped: true,
    isBound: false,
    listeners: 0,
    hasPointer: false,
  });
});
test('reset removes every listener, clears keys and charge, and releases capture', () => {
  const scene = createScene();
  scene.owner.bind(scene.canvas);
  scene.document.fire('keydown', { key: 'q' });
  scene.canvas.fire('pointerdown');
  assert.equal(scene.owner.status().listeners, 9);
  scene.owner.reset();
  assert.equal(scene.document.count() + scene.canvas.count(), 0);
  assert.equal(scene.state.keys.size, 0);
  assert.equal(scene.state.chargeStart, null);
  assert.deepEqual(scene.canvas.released, [7]);
});
test('callbacks captured before reset or replacement cannot control the next game', () => {
  const scene = createScene();
  scene.owner.bind(scene.canvas);
  const oldKeys = scene.document.capture('keydown'),
    oldDown = scene.canvas.capture('pointerdown');
  scene.owner.reset();
  const next = scene.createTarget();
  scene.owner.bind(next);
  for (const callback of [...oldKeys, ...oldDown])
    callback({ key: 'Enter', button: 0, pointerId: 7, preventDefault() {} });
  assert.deepEqual(scene.actions, []);
  assert.equal(scene.state.keys.size, 0);
  assert.equal(scene.owner.status().listeners, 9);
});
test('rebinding never accumulates listeners', () => {
  const scene = createScene();
  for (let index = 0; index < 5; index++) scene.owner.bind(scene.canvas);
  assert.equal(scene.document.count() + scene.canvas.count(), 9);
  scene.owner.stop();
  assert.equal(scene.document.count() + scene.canvas.count(), 0);
});
test('another pointer cannot move, cancel or release the owned charge', () => {
  const scene = createScene();
  scene.owner.bind(scene.canvas);
  scene.canvas.fire('pointerdown');
  scene.setTime(1750);
  const x = scene.state.mouseX;
  scene.canvas.fire('pointermove', { pointerId: 8, clientX: 0 });
  scene.canvas.fire('pointerdown', { pointerId: 8 });
  scene.canvas.fire('pointercancel', { pointerId: 8 });
  scene.canvas.fire('pointerup', { pointerId: 8 });
  assert.equal(scene.state.chargeStart, 1000);
  assert.equal(scene.state.mouseX, x);
  assert.equal(scene.actions.length, 1);
  scene.canvas.fire('pointerup');
  assert.equal(scene.state.power, 0.5);
  assert.deepEqual(scene.canvas.released, [7]);
});
test('pointer cancellation, lost capture and external release never validate a shot', () => {
  for (const type of ['pointercancel', 'lostpointercapture', 'external']) {
    const scene = createScene();
    scene.owner.bind(scene.canvas);
    scene.canvas.fire('pointerdown');
    if (type === 'external') scene.owner.release();
    else scene.canvas.fire(type);
    scene.canvas.fire('pointerup');
    assert.equal(scene.state.chargeStart, null);
    assert.equal(scene.actions.length, 1);
    assert.equal(scene.canvas.captures.size, 0);
  }
});
test('keyboard and pointer releases cannot validate the other device hold', () => {
  const scene = createScene();
  scene.owner.bind(scene.canvas);
  scene.canvas.fire('pointerdown');
  scene.document.fire('keyup', { key: 'Enter' });
  assert.equal(scene.actions.length, 1);
  scene.canvas.fire('pointerup');
  scene.document.fire('keydown', { key: 'Enter' });
  scene.canvas.fire('pointerup');
  scene.canvas.fire('pointerdown');
  assert.equal(scene.actions.filter((action) => action[0] === 'fire').length, 1);
  scene.document.fire('keyup', { key: 'Enter' });
  assert.equal(scene.actions.filter((action) => action[0] === 'fire').length, 2);
});
test('hidden input cancels an existing hold and ignores new pointer actions', () => {
  const scene = createScene();
  scene.owner.bind(scene.canvas);
  scene.canvas.fire('pointerdown');
  scene.hide();
  scene.canvas.fire('pointerup');
  scene.canvas.fire('pointerdown');
  assert.equal(scene.state.chargeStart, null);
  assert.equal(scene.canvas.captures.size, 0);
  assert.equal(scene.actions.length, 1);
});
test('inactive scope still releases shared state and capture during stop', () => {
  const scene = createScene();
  scene.owner.bind(scene.canvas);
  scene.document.fire('keydown', { key: 'q' });
  scene.canvas.fire('pointerdown');
  scene.deactivate();
  scene.owner.stop();
  assert.equal(scene.state.keys.size, 0);
  assert.equal(scene.state.chargeStart, null);
  assert.equal(scene.canvas.captures.size, 0);
});
for (const hook of ['onState', 'onBind'])
  test(`retirement during ${hook} cancels binding`, () => {
    const scene = createScene({ [hook]: (owner) => owner.reset() });
    assert.equal(scene.owner.bind(scene.canvas), false);
    assert.equal(scene.document.count() + scene.canvas.count(), 0);
    assert.equal(scene.owner.status().isBound, false);
  });
for (const hook of ['onOwns', 'onVisible', 'onRect', 'onNow', 'onSound', 'onSpeech'])
  test(`retirement during ${hook} suppresses the abandoned action`, () => {
    let shouldRetire = false;
    const scene = createScene({
      [hook]: (owner) => {
        if (shouldRetire) owner.reset();
      },
    });
    scene.owner.bind(scene.canvas);
    if (hook === 'onSpeech') {
      scene.canvas.fire('pointerdown');
      shouldRetire = true;
      scene.canvas.fire('pointerup');
    } else {
      shouldRetire = true;
      if (hook === 'onOwns') scene.document.fire('keydown', { key: 'Enter' });
      else scene.canvas.fire('pointerdown');
    }
    assert.equal(
      scene.actions.some((action) => action[0] === 'fire'),
      false,
    );
    assert.equal(scene.state.chargeStart, null);
    assert.equal(scene.canvas.captures.size, 0);
  });
test('replacement during a sound callback survives old event cleanup', () => {
  let shouldReplace = true;
  const scene = createScene({
    onSound(owner) {
      if (shouldReplace) {
        shouldReplace = false;
        owner.bind(scene.createTarget());
      }
    },
  });
  scene.owner.bind(scene.canvas);
  scene.canvas.fire('pointerdown');
  assert.equal(scene.owner.status().isBound, true);
  assert.equal(scene.owner.status().listeners, 9);
  assert.equal(scene.canvas.captures.size, 0);
});
test('late capture allocation after retirement is released', () => {
  const scene = createScene({ onCapture: (owner) => owner.reset() });
  scene.owner.bind(scene.canvas);
  scene.canvas.fire('pointerdown');
  assert.equal(scene.canvas.captures.size, 0);
  assert.equal(scene.state.chargeStart, null);
  assert.deepEqual(scene.actions, []);
});
test('real input errors propagate and release the pointer hold', () => {
  const scene = createScene({
    onSound() {
      throw new Error('audio failed');
    },
  });
  scene.owner.bind(scene.canvas);
  assert.throws(() => scene.canvas.fire('pointerdown'), /audio failed/);
  assert.equal(scene.state.chargeStart, null);
  assert.equal(scene.canvas.captures.size, 0);
});
test('cleanup errors are logged while the remaining resources are released', () => {
  const scene = createScene({
    onRemove() {
      throw new Error('listener failed');
    },
    onRelease() {
      throw new Error('capture failed');
    },
  });
  scene.owner.bind(scene.canvas);
  scene.canvas.fire('pointerdown');
  scene.owner.reset();
  assert.equal(scene.document.count() + scene.canvas.count(), 0);
  assert.equal(scene.canvas.captures.size, 0);
  assert.ok(scene.warnings.length > 0);
  assert.equal(scene.owner.status().listeners, 0);
});

test('keyboard charge errors cancel the shared hold before propagating', () => {
  const scene = createScene({
    onSound() {
      throw new Error('keyboard audio failed');
    },
  });
  scene.owner.bind(scene.canvas);
  assert.throws(() => scene.document.fire('keydown', { key: 'Enter' }), /keyboard audio failed/);
  assert.equal(scene.state.chargeStart, null);
  assert.equal(scene.state.keys.size, 0);
});
