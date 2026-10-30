import test from 'node:test';
import assert from 'node:assert/strict';
import { createWormsSprites } from '../client/worms-sprites.js';

function createScene(options = {}) {
  const calls = [],
    canvases = [],
    images = new Map();
  const worm = { id: 'a', alive: true, cx: 40, cy: 80, hp: 80, name: 'Alice', color: '#123456' };
  const state = {
    worms: [worm],
    activeWormId: null,
    isPhysicsSynced: false,
    physics: { cx: 60, cy: 100, facing: -1, onGround: true, walking: false, backflipAngle: 0 },
    bumps: new Map(),
    dying: new Map(),
    weaponAnimation: null,
    aimAngle: 0,
  };
  let reads = 0,
    imageReads = 0,
    isActive = true;
  function context(label) {
    const properties = {},
      stack = [];
    return new Proxy(
      {
        save() {
          stack.push({ ...properties });
        },
        restore() {
          Object.assign(properties, stack.pop());
        },
      },
      {
        get(target, key) {
          if (key in target) return target[key];
          if (key in properties) return properties[key];
          return (...args) => calls.push([label, key, ...args, { ...properties }]);
        },
        set(_target, key, value) {
          properties[key] = value;
          return true;
        },
      },
    );
  }
  const ctx = context('target');
  let owner;
  owner = createWormsSprites({
    getState() {
      reads++;
      options.onState?.(owner);
      return state;
    },
    getImage(key) {
      imageReads++;
      options.onImage?.(owner);
      return images.get(key);
    },
    clock() {
      options.onClock?.(owner);
      return 400;
    },
    isActive: () => isActive,
    createCanvas() {
      const canvas = {
        width: 0,
        height: 0,
        getContext() {
          options.onContext?.(owner);
          return options.noContext ? null : context('bitmap');
        },
      };
      canvases.push(canvas);
      options.onCanvas?.(owner);
      return canvas;
    },
  });
  function image(key, frames = 12, frameHeight = 10, width = 10) {
    const value = { key, complete: true, naturalWidth: width, naturalHeight: frames * frameHeight };
    images.set(key, value);
    return value;
  }
  function draw(now = 400, dt = 0) {
    owner.draw(ctx, now, dt);
  }
  const of = (label, method) => calls.filter((c) => c[0] === label && c[1] === method);
  return {
    owner,
    state,
    worm,
    calls,
    canvases,
    images,
    image,
    draw,
    of,
    reads: () => [reads, imageReads],
    deactivate: () => {
      isActive = false;
    },
  };
}

test('construction is inert and inactive drawing reads nothing', () => {
  const s = createScene();
  assert.deepEqual(s.reads(), [0, 0]);
  s.deactivate();
  s.draw();
  assert.deepEqual(s.reads(), [0, 0]);
  assert.deepEqual(s.owner.status(), { isStopped: false, bitmaps: 0 });
});
test('inactive sprite is frame zero, centered, flipped and cached', () => {
  const s = createScene(),
    image = s.image('wselbak');
  s.draw();
  s.draw();
  assert.equal(s.canvases.length, 1);
  assert.deepEqual(s.of('bitmap', 'drawImage')[0].slice(2, -1), [
    image,
    0,
    0,
    10,
    10,
    0,
    0,
    22,
    22,
  ]);
  assert.equal(s.of('bitmap', 'drawImage').length, 1);
  assert.deepEqual(s.of('target', 'scale')[0].slice(2, -1), [-1, 1]);
  assert.deepEqual(s.of('target', 'drawImage')[0].slice(2, -1), [s.canvases[0], -11, -12]);
});
test('replacement image with unchanged geometry repaints the cached frame', () => {
  const s = createScene();
  s.image('wselbak');
  s.draw();
  const replacement = s.image('wselbak');
  s.draw();
  assert.equal(s.canvases.length, 1);
  assert.equal(s.of('bitmap', 'drawImage').length, 2);
  assert.equal(s.of('bitmap', 'drawImage')[1][2], replacement);
});
test('different frame height rerasterizes even with matching output dimensions', () => {
  const s = createScene(),
    image = s.image('wselbak');
  s.draw();
  image.naturalWidth = 20;
  image.naturalHeight = 240;
  s.draw();
  assert.equal(s.of('bitmap', 'drawImage').length, 2);
  assert.deepEqual(s.of('bitmap', 'drawImage')[1].slice(3, -1), [0, 0, 20, 20, 0, 0, 22, 22]);
});
test('clear releases every bitmap, preserves borrowed state and allows reuse', () => {
  const s = createScene();
  s.image('wselbak');
  s.state.worms.push({ ...s.worm, id: 'b' });
  s.state.bumps.set('foreign', {});
  s.state.dying.set('foreign', {});
  s.draw();
  s.owner.clear();
  assert.equal(s.owner.status().bitmaps, 0);
  assert.ok(s.canvases.every((c) => c.width === 0 && c.height === 0));
  assert.equal(s.state.bumps.size, 1);
  assert.equal(s.state.dying.size, 1);
  s.draw();
  assert.equal(s.canvases.length, 4);
});
test('stop is terminal, idempotent and keeps borrowed images intact', () => {
  const s = createScene(),
    image = s.image('wselbak');
  s.draw();
  const reads = s.reads();
  s.owner.stop();
  s.owner.stop();
  s.owner.clear();
  s.draw();
  assert.deepEqual(s.reads(), reads);
  assert.equal(image.naturalWidth, 10);
  assert.equal(s.canvases[0].width, 0);
  assert.equal(s.owner.status().isStopped, true);
});
for (const hook of ['onState', 'onImage', 'onClock', 'onCanvas', 'onContext']) {
  test(`stop during ${hook} abandons the render and releases pending allocation`, () => {
    const s = createScene({ [hook]: (owner) => owner.stop() });
    s.image('wselbak');
    s.draw(hook === 'onClock' ? 0 : 400);
    assert.equal(s.calls.length, 0);
    assert.equal(s.owner.status().bitmaps, 0);
    assert.ok(s.canvases.every((c) => c.width === 0 && c.height === 0));
  });
}
test('clear during image lookup abandons old frame and next draw can allocate', () => {
  let shouldClear = true;
  const s = createScene({
    onImage(owner) {
      if (shouldClear) {
        shouldClear = false;
        owner.clear();
      }
    },
  });
  s.image('wselbak');
  s.draw();
  assert.equal(s.calls.length, 0);
  s.draw();
  assert.equal(s.owner.status().bitmaps, 1);
});
test('a missing 2D bitmap context falls back and releases the allocation', () => {
  const s = createScene({ noContext: true });
  s.image('wselbak');
  s.draw();
  assert.equal(s.owner.status().bitmaps, 0);
  assert.equal(s.canvases[0].width, 0);
  assert.ok(s.of('target', 'ellipse').length > 0);
});
test('unexpected image errors propagate', () => {
  const s = createScene({
    onImage() {
      throw new Error('lookup failed');
    },
  });
  assert.throws(() => s.draw(), /lookup failed/);
});
for (const [label, fields, key, frames, ms] of [
  ['idle', {}, 'wselbak', 12, 200],
  ['walking', { walking: true }, 'wwalk', 15, 50],
  ['falling', { onGround: false, vy: 100 }, 'wfall', 2, 100],
  ['jumping beats walking', { onGround: false, vy: -1, walking: true }, 'wflyup', 2, 100],
  ['backflip beats jumping', { backflipAngle: 0.5, onGround: false, vy: -1 }, 'wbackflp', 22, 50],
]) {
  test(`active ${label} preserves frame selection and local pose`, () => {
    const s = createScene();
    s.state.activeWormId = 'a';
    s.state.isPhysicsSynced = true;
    Object.assign(s.state.physics, fields);
    const image = s.image(key, frames);
    s.draw(450);
    assert.equal(s.of('bitmap', 'drawImage')[0][2], image);
    assert.equal(s.of('bitmap', 'drawImage')[0][4], (Math.floor(450 / ms) % frames) * 10);
    assert.deepEqual(s.of('target', 'translate')[0].slice(2, -1), [60, 100]);
    assert.deepEqual(s.of('target', 'scale')[0].slice(2, -1), [1, 1]);
    if (fields.backflipAngle) assert.equal(s.of('target', 'rotate')[0][2], 0.5);
    else if (key === 'wfall') assert.equal(s.of('target', 'rotate')[0][2], -0.38);
  });
}
test('low HP selects breathing and weapon animation takes priority', () => {
  const s = createScene();
  s.worm.hp = 29;
  const breathing = s.image('wbrth2', 13);
  s.draw();
  assert.equal(s.of('bitmap', 'drawImage')[0][2], breathing);
  s.state.activeWormId = 'a';
  s.state.weaponAnimation = { img: 'wbaz', phase: 'aim', frames: 32, ms: 60 };
  const weapon = s.image('wbaz', 32);
  s.draw();
  assert.equal(s.of('bitmap', 'drawImage')[1][2], weapon);
});
test('aim frames clamp at both extremes and still drive a walking animation', () => {
  const s = createScene();
  s.state.activeWormId = 'a';
  s.state.isPhysicsSynced = true;
  s.state.physics.walking = true;
  s.state.weaponAnimation = { phase: 'aim' };
  s.image('wwalk', 15);
  for (const [angle, frame] of [
    [-10, 14],
    [0, 7],
    [10, 0],
  ]) {
    s.state.aimAngle = angle;
    s.draw();
    assert.equal(s.of('bitmap', 'drawImage').at(-1)[4], frame * 10);
  }
});
test('zero timestamp uses injected clock', () => {
  const s = createScene();
  s.state.activeWormId = 'a';
  s.image('wselbak');
  s.draw(0);
  assert.equal(s.of('bitmap', 'drawImage')[0][4], 20);
});
test('bump equations and deletion threshold stay on borrowed map', () => {
  const s = createScene();
  s.image('wselbak');
  const bump = { vx: 20, vy: -50, dx: 2, dy: -1 };
  s.state.bumps.set('a', bump);
  s.draw(400, 0.1);
  assert.equal(bump.vx, 20 * Math.exp(-0.4));
  assert.equal(bump.vy, -15);
  assert.deepEqual(s.of('target', 'translate')[0].slice(2, -1), [40 + (2 + bump.vx * 0.1), 77.5]);
  s.state.bumps.set('a', { vx: 0, vy: 1, dx: 0, dy: 1 });
  s.draw();
  assert.equal(s.state.bumps.has('a'), false);
});
test('procedural fallback and inactive label work without image allocation', () => {
  const s = createScene();
  s.worm.name = null;
  s.draw();
  assert.equal(s.canvases.length, 0);
  assert.equal(s.of('target', 'ellipse').length, 5);
  assert.deepEqual(
    s.of('target', 'fillText').map((c) => c.slice(2, -1)),
    [['?', 0, -24]],
  );
});
for (const [hp, color] of [
  [80, '#22dd22'],
  [40, '#ffcc00'],
  [20, '#ff2222'],
]) {
  test(`HP ${hp} keeps bar geometry and active text`, () => {
    const s = createScene();
    s.worm.hp = hp;
    s.state.activeWormId = 'a';
    s.image(hp < 30 ? 'wbrth2' : 'wselbak', hp < 30 ? 13 : 12);
    s.draw();
    const bar = s.of('target', 'fillRect').find((c) => c.at(-1).fillStyle === color);
    assert.deepEqual(bar.slice(2, -1), [-13, -22, (26 * hp) / 80, 5]);
    assert.deepEqual(
      s.of('target', 'fillText').map((c) => c.slice(2, -1)),
      [
        ['Alice', 0, -25],
        [String(hp), 0, -17.5],
      ],
    );
  });
}
test('active arrow sprite preserves frame and source geometry', () => {
  const s = createScene();
  s.state.activeWormId = 'a';
  s.image('wselbak');
  const arrow = s.image('arrowdnb', 30);
  s.draw(450);
  assert.deepEqual(s.of('target', 'drawImage').at(-1).slice(2, -1), [
    arrow,
    0,
    150,
    10,
    10,
    30,
    22,
    20,
    20,
  ]);
});
test('active arrow has a timed procedural fallback', () => {
  const s = createScene();
  s.state.activeWormId = 'a';
  s.image('wselbak');
  s.draw(400);
  assert.ok(s.of('target', 'moveTo').some((c) => c[2] === 40 && c[3] === 54 + Math.sin(2) * 3));
});
test('death animation freezes last frame and only retires after 800ms', () => {
  const s = createScene();
  s.worm.alive = false;
  s.worm._facing = -1;
  s.state.dying.set('a', { startMs: 100 });
  const death = s.image('wdie', 60);
  s.draw(900);
  assert.deepEqual(s.of('target', 'drawImage')[0].slice(2, -1), [
    death,
    0,
    590,
    10,
    10,
    30.5,
    61,
    19,
    19,
  ]);
  assert.equal(s.state.dying.size, 1);
  s.draw(901);
  assert.equal(s.state.dying.size, 0);
  assert.equal(s.of('target', 'fillText').length, 0);
});
test('grave uses deterministic image and final sheet frame', () => {
  const s = createScene();
  s.worm.alive = false;
  const grave = s.image('grave2', 20);
  s.draw();
  assert.deepEqual(s.of('target', 'drawImage')[0].slice(2, -1), [
    grave,
    0,
    190,
    10,
    10,
    23,
    46,
    34,
    34,
  ]);
});
test('missing death and grave image paints the procedural cross', () => {
  const s = createScene();
  s.worm.alive = false;
  s.state.dying.set('a', { startMs: 100 });
  s.draw();
  assert.deepEqual(
    s.of('target', 'fillRect').map((c) => c.slice(2, -1)),
    [
      [38, 60, 4, 16],
      [32, 65, 16, 4],
    ],
  );
});
