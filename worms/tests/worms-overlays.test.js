import test from 'node:test';
import assert from 'node:assert/strict';
import { createWormsOverlays } from '../client/worms-overlays.js';

function createScene(options = {}) {
  const calls = [],
    images = new Map(),
    properties = {},
    stack = [];
  const state = {
    isMyTurn: true,
    worms: [{ id: 'a', cx: 40, cy: 80 }],
    activeWormId: 'a',
    isPhysicsSynced: false,
    physics: { cx: 60, cy: 100, onGround: false, parachute: false },
    rope: null,
    isJetpackActive: false,
    jetpackFuel: 0.5,
    hasShotFired: false,
    isAnimating: false,
    selectedWeapon: 'bazooka',
    mouseX: 20,
    mouseY: 30,
    aimAngle: 0,
    chargeStart: null,
    crates: [],
    dynamites: [],
    mines: [],
  };
  let owner,
    reads = 0,
    isActive = true;
  const ctx = new Proxy(
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
        return (...args) => calls.push([key, ...args, { ...properties }]);
      },
      set(_target, key, value) {
        properties[key] = value;
        return true;
      },
    },
  );
  owner = createWormsOverlays({
    getState() {
      reads++;
      options.onState?.(owner);
      return state;
    },
    getImage(key) {
      options.onImage?.(owner);
      return images.get(key);
    },
    getWeaponDefinition(key) {
      options.onWeapon?.(owner);
      return key === 'bazooka' ? { icon: 'rocket', color: '#ff7700' } : null;
    },
    playSound(...args) {
      calls.push(['sound', ...args]);
      options.onSound?.(owner);
    },
    translate() {
      options.onTranslate?.(owner);
      return 'Power';
    },
    clock() {
      options.onClock?.(owner);
      return 900;
    },
    now() {
      options.onNow?.(owner);
      return 2500;
    },
    targetedWeapons: new Set(['airstrike', 'napalm']),
    isActive: () => isActive,
  });
  function image(key) {
    const image = { key, complete: true, naturalWidth: 16, naturalHeight: 512 };
    images.set(key, image);
    return image;
  }
  const of = (name) => calls.filter((c) => c[0] === name);
  return {
    owner,
    state,
    ctx,
    calls,
    image,
    of,
    reads: () => reads,
    depth: () => stack.length,
    deactivate: () => {
      isActive = false;
    },
  };
}

for (const attached of [false, true]) {
  test(`rope ${attached ? 'attached' : 'flying'} keeps endpoints, dashes and tip color`, () => {
    const s = createScene();
    s.state.rope = {
      state: attached ? 'attached' : 'flying',
      cx: 10,
      cy: 15,
      anchorX: 20,
      anchorY: 25,
    };
    s.owner.drawRope(s.ctx);
    assert.deepEqual(s.of('moveTo')[0].slice(1, -1), [40, 80]);
    assert.deepEqual(s.of('lineTo')[0].slice(1, -1), attached ? [20, 25] : [10, 15]);
    assert.deepEqual(
      s.of('setLineDash').map((c) => Array.from(c[1])),
      [[4, 3], []],
    );
    assert.equal(s.of('fill')[0].at(-1).fillStyle, attached ? '#ffdd44' : '#aaddaa');
  });
}
test('jetpack uses synchronized position, fuel hue and original bar geometry', () => {
  const s = createScene();
  s.state.isPhysicsSynced = true;
  s.state.isJetpackActive = true;
  s.owner.drawJetpackFuel(s.ctx);
  assert.deepEqual(
    s.of('fillRect').map((c) => c.slice(1, -1)),
    [
      [45, 115, 30, 4],
      [45, 115, 15, 4],
    ],
  );
  assert.equal(s.of('fillRect')[1].at(-1).fillStyle, 'hsl(60,90%,55%)');
});
for (const field of ['isMyTurn', 'hasShotFired', 'isAnimating']) {
  test(`aiming is suppressed by ${field}`, () => {
    const s = createScene();
    s.state[field] = field === 'isMyTurn' ? false : true;
    s.owner.drawAimAndTargeting(s.ctx, 100);
    assert.equal(s.calls.length, 0);
  });
}
for (const [weapon, mouseX, x] of [
  ['airstrike', -100, 24],
  ['napalm', 2000, 936],
]) {
  test(`${weapon} targeting clamps at world edges`, () => {
    const s = createScene();
    s.state.selectedWeapon = weapon;
    s.state.mouseX = mouseX;
    s.owner.drawAimAndTargeting(s.ctx, 100);
    assert.deepEqual(
      s
        .of('lineTo')
        .slice(-3)
        .map((c) => c.slice(1, -1)),
      [
        [x - 30, 480],
        [x, 480],
        [x + 30, 480],
      ],
    );
  });
}
test('crosshair uses synchronized position and thirty-two frame sheet', () => {
  const s = createScene(),
    image = s.image('crshairr');
  s.state.isPhysicsSynced = true;
  s.owner.drawAimAndTargeting(s.ctx, 450);
  assert.deepEqual(s.of('drawImage')[0].slice(1, -1), [image, 0, 144, 16, 16, 92, 88, 24, 24]);
});
test('missing crosshair uses weapon color and unsynchronized position', () => {
  const s = createScene();
  s.owner.drawAimAndTargeting(s.ctx, 450);
  assert.deepEqual(s.of('arc')[0].slice(1, -1), [84, 80, 4, 0, Math.PI * 2]);
  assert.equal(s.of('fill')[0].at(-1).fillStyle, '#ff7700');
});
test('falling crates keep speed, parachute and one landing sound', () => {
  const s = createScene(),
    crate = { cx: 40, cy: 10, fallingCy: 9, landed: false, type: 'weapon' };
  s.state.crates.push(crate);
  s.owner.drawCratesFrame(s.ctx, 0.01, 0);
  assert.equal(crate.fallingCy, 9.38);
  assert.equal(s.of('arc')[0][3], 12);
  assert.equal(s.of('sound').length, 0);
  s.owner.drawCratesFrame(s.ctx, 0.1, 0);
  s.owner.drawCratesFrame(s.ctx, 0.1, 0);
  assert.equal(crate.fallingCy, 10);
  assert.equal(crate.landed, true);
  assert.deepEqual(s.of('sound'), [['sound', 'GRENADEIMPACT', 0.35]]);
});
test('new falling crate starts at minus thirty pixels', () => {
  const s = createScene(),
    crate = { cx: 40, cy: 80, landed: false };
  s.state.crates.push(crate);
  s.owner.drawCratesFrame(s.ctx, 0.1, 0);
  assert.equal(crate.fallingCy, -26.2);
});
test('health crate keeps box, cross and landed pulse', () => {
  const s = createScene();
  s.state.crates.push({ cx: 40, cy: 80, type: 'health', landed: true });
  s.owner.drawCratesFrame(s.ctx, 0, 0);
  assert.deepEqual(s.of('fillRect')[0].slice(1, -1), [33, 66, 14, 14]);
  assert.equal(s.of('fillRect')[0].at(-1).fillStyle, '#e8e8e8');
  assert.equal(s.of('stroke').at(-1).at(-1).strokeStyle, '#cc0000');
  assert.deepEqual(s.of('strokeRect').at(-1).slice(1, -1), [31, 64, 18, 18]);
  assert.equal(s.of('strokeRect').at(-1).at(-1).strokeStyle, 'rgba(255,80,80,0.3)');
});
for (const [weapon, icon] of [
  ['bazooka', 'rocket'],
  ['missing', '?'],
]) {
  test(`weapon crate renders ${weapon} icon as plain text`, () => {
    const s = createScene();
    s.state.crates.push({ cx: 40, cy: 80, type: 'weapon', weapon, landed: true });
    s.owner.drawCratesFrame(s.ctx, 0, 0);
    assert.deepEqual(s.of('fillText')[0].slice(1, -1), [icon, 40, 76]);
  });
}
test('placed dynamite uses monotonic clock, fuse flash and decimal seconds', () => {
  const s = createScene();
  s.state.dynamites.push({ cx: 40, cy: 80, placedAt: 0, fuseMs: 3000 });
  s.owner.drawDynamites(s.ctx);
  assert.equal(s.of('fillRect')[0].at(-1).fillStyle, '#ff5555');
  assert.deepEqual(s.of('fillText')[0].slice(1, -1), ['0.5', 40, 63]);
  assert.deepEqual(s.of('arc')[0].slice(1, -1), [40, 67, 2, 0, Math.PI * 2]);
});
test('mine keeps circle, warning and colors', () => {
  const s = createScene();
  s.state.mines.push({ cx: 40, cy: 80 });
  s.owner.drawMines(s.ctx);
  assert.deepEqual(s.of('arc')[0].slice(1, -1), [40, 80, 8, 0, Math.PI * 2]);
  assert.equal(s.of('fill')[0].at(-1).fillStyle, '#556655');
  assert.deepEqual(s.of('fillText')[0].slice(1, -1), ['!', 40, 83]);
});
test('teleport preview keeps pointer circle and cross geometry', () => {
  const s = createScene();
  s.state.selectedWeapon = 'teleport';
  s.owner.drawTeleportPreview(s.ctx);
  assert.deepEqual(s.of('arc')[0].slice(1, -1), [20, 30, 10, 0, Math.PI * 2]);
  assert.deepEqual(
    s.of('lineTo').map((c) => c.slice(1, -1)),
    [
      [34, 30],
      [20, 44],
    ],
  );
});
test('parachute uses local physics, canopy and five cords', () => {
  const s = createScene();
  s.state.physics.parachute = true;
  s.owner.drawParachute(s.ctx);
  assert.deepEqual(s.of('arc')[0].slice(1, -1), [60, 68, 18, Math.PI, 0]);
  assert.equal(s.of('lineTo').length, 5);
  assert.ok(s.of('lineTo').every((c) => c[1] === 60 && c[2] === 90));
});
for (const [start, fraction, color] of [
  [600, 0.2, '#44ee44'],
  [0, 0.6, '#ffcc00'],
  [-1000, 1, '#ff4400'],
]) {
  test(`charge ${fraction} keeps wall clock, colors, clamping and translated label`, () => {
    const s = createScene();
    s.state.chargeStart = start;
    s.owner.drawChargeBar(s.ctx);
    assert.deepEqual(s.of('fillRect')[1].slice(1, -1), [-5, 44, 90 * fraction, 10]);
    assert.equal(s.of('fillRect')[1].at(-1).fillStyle, color);
    assert.deepEqual(s.of('fillText')[0].slice(1, -1), [
      `Power ${Math.round(fraction * 100)}%`,
      40,
      41,
    ]);
  });
}
test('inapplicable tools, missing worm and completed shots draw nothing', () => {
  const s = createScene();
  s.owner.drawRope(s.ctx);
  s.owner.drawJetpackFuel(s.ctx);
  s.owner.drawTeleportPreview(s.ctx);
  s.owner.drawParachute(s.ctx);
  s.owner.drawChargeBar(s.ctx);
  s.state.worms = [];
  s.state.physics.parachute = true;
  s.state.chargeStart = 0;
  s.owner.drawParachute(s.ctx);
  s.owner.drawChargeBar(s.ctx);
  assert.equal(s.calls.length, 0);
});

test('construction and inactive draws never read state or touch the canvas', () => {
  const s = createScene();
  assert.equal(s.reads(), 0);
  s.deactivate();
  for (const name of [
    'drawRope',
    'drawJetpackFuel',
    'drawAimAndTargeting',
    'drawCratesFrame',
    'drawDynamites',
    'drawMines',
    'drawTeleportPreview',
    'drawParachute',
    'drawChargeBar',
  ])
    s.owner[name](s.ctx, 0.1, 100);
  assert.equal(s.reads(), 0);
  assert.equal(s.calls.length, 0);
});
test('stop is terminal and preserves borrowed objects and images', () => {
  const s = createScene(),
    image = s.image('crshairr'),
    crate = { cx: 40, cy: 10, fallingCy: 9, landed: false };
  s.state.crates.push(crate);
  s.owner.stop();
  s.owner.stop();
  s.owner.reset();
  const reads = s.reads();
  for (const name of [
    'drawRope',
    'drawJetpackFuel',
    'drawAimAndTargeting',
    'drawCratesFrame',
    'drawDynamites',
    'drawMines',
    'drawTeleportPreview',
    'drawParachute',
    'drawChargeBar',
  ])
    s.owner[name](s.ctx, 0.1, 100);
  assert.equal(s.reads(), reads);
  assert.equal(s.calls.length, 0);
  assert.equal(crate.fallingCy, 9);
  assert.equal(image.naturalWidth, 16);
  assert.deepEqual(s.owner.status(), { isStopped: true });
});
for (const hook of [
  'onState',
  'onImage',
  'onWeapon',
  'onSound',
  'onNow',
  'onClock',
  'onTranslate',
]) {
  test(`stop during ${hook} abandons subsequent rendering and balances saved context`, () => {
    const s = createScene({ [hook]: (owner) => owner.stop() });
    s.image('crshairr');
    if (hook === 'onWeapon' || hook === 'onSound') {
      s.state.crates.push({
        cx: 40,
        cy: 10,
        fallingCy: 9,
        landed: hook !== 'onSound',
        type: 'weapon',
        weapon: 'bazooka',
      });
      s.owner.drawCratesFrame(s.ctx, 0.1, 100);
    } else if (hook === 'onNow') {
      s.state.dynamites.push({ cx: 40, cy: 80, placedAt: 0, fuseMs: 3000 });
      s.owner.drawDynamites(s.ctx);
    } else if (hook === 'onClock' || hook === 'onTranslate') {
      s.state.chargeStart = 0;
      s.owner.drawChargeBar(s.ctx);
    } else s.owner.drawAimAndTargeting(s.ctx, 100);
    assert.equal(s.owner.status().isStopped, true);
    assert.equal(s.of('fillText').length, 0);
    assert.equal(s.of('drawImage').length, 0);
    assert.equal(s.depth(), 0);
  });
}
test('reset during image read abandons the old frame and allows a new one', () => {
  let shouldReset = true;
  const s = createScene({
    onImage(owner) {
      if (shouldReset) {
        shouldReset = false;
        owner.reset();
      }
    },
  });
  s.image('crshairr');
  s.owner.drawAimAndTargeting(s.ctx, 100);
  assert.equal(s.of('drawImage').length, 0);
  s.owner.drawAimAndTargeting(s.ctx, 100);
  assert.equal(s.of('drawImage').length, 1);
});
test('reset during crate lookup restores context and allows drawing the next frame', () => {
  let shouldReset = true;
  const s = createScene({
    onWeapon(owner) {
      if (shouldReset) {
        shouldReset = false;
        owner.reset();
      }
    },
  });
  s.state.crates.push({ cx: 40, cy: 80, landed: true, type: 'weapon', weapon: 'bazooka' });
  s.owner.drawCratesFrame(s.ctx, 0, 100);
  assert.equal(s.depth(), 0);
  assert.equal(s.of('fillText').length, 0);
  s.owner.drawCratesFrame(s.ctx, 0, 100);
  assert.equal(s.depth(), 0);
  assert.equal(s.of('fillText').length, 1);
});
test('real dependency errors propagate while crate context is restored', () => {
  const s = createScene({
    onWeapon() {
      throw new Error('definition lookup failed');
    },
  });
  s.state.crates.push({ cx: 40, cy: 80, landed: true, type: 'weapon', weapon: 'bazooka' });
  assert.throws(() => s.owner.drawCratesFrame(s.ctx, 0, 100), /definition lookup failed/);
  assert.equal(s.depth(), 0);
});
