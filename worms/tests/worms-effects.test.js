import test from 'node:test';
import assert from 'node:assert/strict';
import { createWormsEffects } from '../client/worms-effects.js';

function createScene(options = {}) {
  const calls = [],
    images = new Map();
  const state = { projectiles: [], selectedWeapon: 'bazooka' };
  let owner,
    reads = 0,
    isActive = true;
  const properties = { globalAlpha: 1, textAlign: 'left' },
    stack = [];
  const ctx = new Proxy(
    {
      save() {
        stack.push({ ...properties });
      },
      restore() {
        Object.assign(properties, stack.pop());
      },
      createRadialGradient(...args) {
        calls.push(['gradient', ...args]);
        return {
          addColorStop(...stop) {
            calls.push(['stop', ...stop]);
          },
        };
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
  owner = createWormsEffects({
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
      return key === 'grenade'
        ? { color: '#112233', trailColor: 'green' }
        : { color: '#ff7700', trailColor: 'orange' };
    },
    clock() {
      options.onClock?.(owner);
      return 450;
    },
    randomUnit() {
      options.onRandom?.(owner);
      return 0.5;
    },
    isActive: () => isActive,
  });
  function image(key, frames = 32) {
    const image = { key, complete: true, naturalWidth: 8, naturalHeight: frames * 8 };
    images.set(key, image);
    return image;
  }
  function projectile(overrides = {}) {
    const projectile = {
      trajectory: Array.from({ length: 40 }, (_, i) => ({ cx: 20 + i, cy: 30 })),
      idx: 0,
      ...overrides,
    };
    state.projectiles.push(projectile);
    return projectile;
  }
  const of = (name) => calls.filter((c) => c[0] === name);
  return {
    owner,
    state,
    ctx,
    calls,
    image,
    projectile,
    of,
    reads: () => reads,
    deactivate: () => {
      isActive = false;
    },
  };
}

test('projectile advancement keeps twenty samples per second and draws final frame once', () => {
  const s = createScene(),
    p = s.projectile();
  s.owner.drawProjectiles(s.ctx, 0.125);
  assert.equal(p.fidx, 2.5);
  assert.equal(p.idx, 2);
  assert.equal(p.done, undefined);
  s.owner.drawProjectiles(s.ctx, 2);
  assert.equal(p.idx, 39);
  assert.equal(p.done, true);
  const count = s.calls.length;
  s.owner.drawProjectiles(s.ctx, 1);
  assert.equal(s.calls.length, count);
});
test('projectile trails keep fourteen samples every two points', () => {
  const s = createScene();
  s.projectile({ idx: 39, fidx: 39 });
  s.owner.drawProjectiles(s.ctx, 0);
  assert.deepEqual(s.of('moveTo')[0].slice(1, -1), [59, 30]);
  assert.equal(s.of('lineTo').length, 13);
  assert.deepEqual(s.of('lineTo').at(-1).slice(1, -1), [33, 30]);
  assert.equal(s.of('stroke')[0].at(-1).strokeStyle, 'orange');
});
for (const [label, dx, dy, frame] of [
  ['right', 1, 0, 0],
  ['down', 0, 1, 8],
  ['left', -1, 0, 16],
  ['up', 0, -1, 24],
]) {
  test(`missile ${label} uses directional frame`, () => {
    const s = createScene(),
      image = s.image('missile');
    s.projectile({
      trajectory: [
        { cx: 30, cy: 30 },
        { cx: 30 + dx, cy: 30 + dy },
      ],
      fidx: 1,
    });
    s.owner.drawProjectiles(s.ctx, 0);
    assert.deepEqual(s.of('drawImage')[0].slice(1, -1), [
      image,
      0,
      frame * 8,
      8,
      8,
      -8,
      -8,
      16,
      16,
    ]);
  });
}
for (const [weapon, key, frames] of [
  ['hand_grenade', 'grenade', 32],
  ['cluster_bomb', 'grenade', 32],
  ['mortar', 'grenade', 32],
  ['holy_grenade', 'hgrenade', 32],
  ['banana_bomb', 'hgrenade', 32],
  ['dynamite', 'dynamite', 129],
]) {
  test(`${weapon} keeps sprite mapping and wall clock animation`, () => {
    const s = createScene(),
      image = s.image(key, frames);
    s.projectile({ weapon });
    s.owner.drawProjectiles(s.ctx, 0);
    assert.equal(s.of('drawImage')[0][1], image);
    assert.equal(s.of('drawImage')[0][3], 72);
  });
}
test('projectile fallback uses selected weapon and handles empty trajectories', () => {
  const s = createScene();
  s.state.selectedWeapon = 'grenade';
  s.projectile();
  s.projectile({ trajectory: [] });
  s.owner.drawProjectiles(s.ctx, 0);
  assert.equal(s.of('fill')[0].at(-1).fillStyle, '#112233');
  assert.equal(s.of('arc')[0][3], 10);
  assert.equal(s.of('arc').length, 2);
});
test('explosion geometry, color stops and expiry retain their formulas', () => {
  const s = createScene();
  s.owner.addExplosion({ cx: 40, cy: 50, r: 30, startMs: 100, durationMs: 500 });
  s.owner.drawExplosions(s.ctx, 350);
  assert.equal(s.of('arc')[0][3], 36.00000000000001);
  assert.equal(s.of('arc')[1][3], 30);
  assert.equal(s.of('stop').length, 5);
  assert.equal(s.of('stop')[4][2], 'rgba(80,20,0,0)');
  s.owner.drawExplosions(s.ctx, 600);
  const count = s.calls.length;
  s.owner.drawExplosions(s.ctx, 700);
  assert.equal(s.calls.length, count);
});
test('particles retain seeded generation, gravity, fade and expiry', () => {
  const s = createScene();
  s.owner.spawnParticles(40, 50, 1);
  s.owner.drawParticles(s.ctx, 0.1);
  const arc = s.of('arc')[0];
  assert.ok(Math.abs(arc[1] - 24) < 1e-10);
  assert.equal(arc[2], 44);
  assert.equal(arc[3], 3.5);
  assert.equal(s.of('fill')[0].at(-1).fillStyle, 'rgba(200,80,10,0.77)');
  s.owner.drawParticles(s.ctx, 1);
  const count = s.calls.length;
  s.owner.drawParticles(s.ctx, 1);
  assert.equal(s.calls.length, count);
});
test('damage labels retain killed colors, geometry, drift and fade', () => {
  const s = createScene();
  s.owner.addDamageLabel({ cx: 40, cy: 50, text: '-20', alpha: 1, killed: true });
  s.owner.drawDamageLabels(s.ctx);
  assert.deepEqual(s.of('fillText')[0].slice(1, -1), ['-20', 40, 50]);
  assert.equal(s.of('fillText')[0].at(-1).fillStyle, '#ff4400');
  s.owner.tickDamageLabels(0.5);
  s.owner.drawDamageLabels(s.ctx);
  assert.equal(s.of('fillText')[1][3], 35);
  assert.equal(s.of('fillText')[1].at(-1).globalAlpha, 0.7);
  assert.equal(s.ctx.globalAlpha, 1);
  assert.equal(s.ctx.textAlign, 'left');
  s.owner.tickDamageLabels(2);
  const count = s.calls.length;
  s.owner.drawDamageLabels(s.ctx);
  assert.equal(s.calls.length, count);
});
for (const [remaining, color] of [
  [3, '#ffffff'],
  [2, '#ffcc00'],
  [1, '#ff4400'],
]) {
  test(`fuse ${remaining}s keeps ceiling, text and color`, () => {
    const s = createScene();
    s.projectile({ fuseMs: remaining * 1000, startMs: 100, idx: 0 });
    s.owner.drawFuseCountdowns(s.ctx, 101);
    assert.deepEqual(s.of('fillText')[0].slice(1, -1), [String(remaining), 20, 16]);
    assert.equal(s.of('fillText')[0].at(-1).fillStyle, color);
    assert.equal(s.of('fillText')[0].at(-1).font, `bold ${10 + remaining * 3}px monospace`);
  });
}
test('fuses skip done, absent and expired timers; missing index falls back to last point', () => {
  const s = createScene();
  s.projectile({ done: true, fuseMs: 1000 });
  s.projectile();
  s.projectile({ startMs: 0, fuseMs: 1000 });
  s.projectile({ idx: 999, fuseMs: 2000 });
  s.owner.drawFuseCountdowns(s.ctx, 2000);
  assert.deepEqual(
    s.of('fillText').map((c) => c.slice(1, -1)),
    [['2', 59, 16]],
  );
});

test('construction and inactive methods do not read state or admit effects', () => {
  const s = createScene();
  assert.equal(s.reads(), 0);
  s.deactivate();
  s.owner.addExplosion({});
  s.owner.addDamageLabel({});
  s.owner.spawnParticles(0, 0, 1);
  s.owner.drawProjectiles(s.ctx, 1);
  s.owner.drawExplosions(s.ctx, 1);
  s.owner.drawParticles(s.ctx, 1);
  s.owner.drawDamageLabels(s.ctx);
  s.owner.drawFuseCountdowns(s.ctx, 1);
  s.owner.tickDamageLabels(1);
  assert.equal(s.reads(), 0);
  assert.equal(s.calls.length, 0);
  assert.deepEqual(s.owner.status(), {
    isStopped: false,
    explosions: 0,
    particles: 0,
    damageLabels: 0,
  });
});
test('reset releases owned arrays, leaves trajectories intact and permits another round', () => {
  const s = createScene(),
    p = s.projectile();
  s.owner.addExplosion({ cx: 40, cy: 50, r: 30, startMs: 0, durationMs: 500 });
  s.owner.addDamageLabel({ cx: 40, cy: 50, text: '-2', alpha: 1 });
  s.owner.spawnParticles(40, 50, 2);
  assert.deepEqual(s.owner.status(), {
    isStopped: false,
    explosions: 1,
    particles: 2,
    damageLabels: 1,
  });
  s.owner.reset();
  s.owner.reset();
  assert.deepEqual(s.owner.status(), {
    isStopped: false,
    explosions: 0,
    particles: 0,
    damageLabels: 0,
  });
  assert.equal(s.state.projectiles[0], p);
  assert.equal(p.trajectory.length, 40);
  s.owner.addExplosion({ cx: 40, cy: 50, r: 30, startMs: 0, durationMs: 500 });
  s.owner.drawExplosions(s.ctx, 100);
  assert.equal(s.of('gradient').length, 1);
});
test('stop is terminal and keeps borrowed trajectories and image sources intact', () => {
  const s = createScene(),
    image = s.image('missile'),
    p = s.projectile();
  s.owner.spawnParticles(40, 50, 2);
  s.owner.addExplosion({});
  s.owner.addDamageLabel({});
  s.owner.stop();
  s.owner.stop();
  const reads = s.reads();
  s.owner.spawnParticles(40, 50, 2);
  s.owner.addExplosion({});
  s.owner.addDamageLabel({});
  s.owner.drawProjectiles(s.ctx, 1);
  s.owner.drawExplosions(s.ctx, 1);
  s.owner.drawParticles(s.ctx, 1);
  s.owner.drawDamageLabels(s.ctx);
  s.owner.drawFuseCountdowns(s.ctx, 1);
  s.owner.tickDamageLabels(1);
  assert.equal(s.reads(), reads);
  assert.equal(s.calls.length, 0);
  assert.equal(p.idx, 0);
  assert.equal(image.naturalWidth, 8);
  assert.deepEqual(s.owner.status(), {
    isStopped: true,
    explosions: 0,
    particles: 0,
    damageLabels: 0,
  });
});
for (const hook of ['onState', 'onImage', 'onClock', 'onWeapon']) {
  test(`stop during ${hook} abandons subsequent projectile drawing`, () => {
    const s = createScene({ [hook]: (owner) => owner.stop() });
    s.image('grenade');
    s.projectile({ weapon: 'hand_grenade' });
    s.owner.drawProjectiles(s.ctx, 0);
    assert.equal(s.of('drawImage').length, 0);
    assert.equal(s.owner.status().isStopped, true);
  });
}
test('reset during random sampling cannot append particles to the following round', () => {
  let reset = true;
  const s = createScene({
    onRandom(owner) {
      if (reset) {
        reset = false;
        owner.reset();
      }
    },
  });
  s.owner.spawnParticles(40, 50, 2);
  assert.equal(s.owner.status().particles, 0);
  s.owner.spawnParticles(40, 50, 2);
  assert.equal(s.owner.status().particles, 2);
});
test('stop during the last random sample releases previously spawned particles too', () => {
  let samples = 0;
  const s = createScene({
    onRandom(owner) {
      if (++samples === 10) owner.stop();
    },
  });
  s.owner.spawnParticles(40, 50, 2);
  assert.equal(s.owner.status().particles, 0);
});
test('reset during an image read abandons the old render and allows the next', () => {
  let shouldReset = true;
  const s = createScene({
    onImage(owner) {
      if (shouldReset) {
        shouldReset = false;
        owner.reset();
      }
    },
  });
  s.image('missile');
  s.projectile();
  s.owner.drawProjectiles(s.ctx, 0);
  assert.equal(s.of('drawImage').length, 0);
  s.owner.drawProjectiles(s.ctx, 0);
  assert.equal(s.of('drawImage').length, 1);
});
test('unexpected dependency errors are not swallowed', () => {
  const s = createScene({
    onImage() {
      throw new Error('image lookup failed');
    },
  });
  s.projectile();
  assert.throws(() => s.owner.drawProjectiles(s.ctx, 0), /image lookup failed/);
});
