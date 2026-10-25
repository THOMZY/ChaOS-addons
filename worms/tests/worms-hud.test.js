import test from 'node:test';
import assert from 'node:assert/strict';
import { createWormsHud } from '../client/worms-hud.js';

function createNode(tag = 'div', attrs = {}, text = null) {
  const node = {
    tag,
    style: { ...attrs.style },
    children: [],
    attributes: {},
    textContent: text ?? '',
    append(...values) {
      this.children.push(...values);
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    replaceChildren(...values) {
      this.children = [...values];
      this.textContent = '';
    },
    setAttribute(key, value) {
      this.attributes[key] = value;
    },
    querySelector() {
      return this.badge ?? null;
    },
  };
  return node;
}
function createScene(options = {}) {
  const state = {
    players: [{ userId: 'p', pseudo: '<Player>', color: '#00ff00' }],
    worms: [
      { id: 'a', playerId: 'p', name: 'Alpha', hp: 80, alive: true },
      { id: 'b', playerId: 'p', name: 'Beta', hp: 0, alive: false },
    ],
    currentTurn: 'p',
    myUserId: 'p',
    activeWormId: 'a',
    isMyTurn: true,
    round: 2,
    wind: 0,
    isSuddenDeath: false,
    selectedWeapon: 'bazooka',
    ammo: { bazooka: 0, drill: 1 },
    hasShotFired: false,
    grenadeFuse: 3,
    turnDeadline: 10000,
    isRetreating: false,
    retreatEnd: 4000,
  };
  const weaponButtons = Object.fromEntries(
    ['bazooka', 'drill', 'rope'].map((key) => {
      const node = createNode('button');
      node.badge = createNode('span');
      return [key, node];
    }),
  );
  const view = {
    turnLabel: createNode(),
    wind: createNode(),
    health: createNode(),
    weaponButtons,
    fuse: createNode(),
    timer: createNode(),
  };
  let owner,
    reads = 0,
    isActive = true,
    time = 1000;
  const calls = [];
  const ctx = new Proxy(
    {
      save() {
        calls.push(['save']);
      },
      restore() {
        calls.push(['restore']);
      },
      measureText() {
        return { width: 30 };
      },
    },
    {
      get(target, key) {
        return target[key] ?? ((...args) => calls.push([key, ...args]));
      },
      set(target, key, value) {
        target[key] = value;
        calls.push(['set', key, value]);
        return true;
      },
    },
  );
  owner = createWormsHud({
    getState() {
      reads++;
      options.onState?.(owner);
      return state;
    },
    getView() {
      options.onView?.(owner);
      return view;
    },
    createElement(...args) {
      options.onElement?.(owner);
      return createNode(...args);
    },
    renderUserName(player) {
      options.onName?.(owner);
      return createNode('name', {}, player.pseudo);
    },
    setSafeHtml(node, html) {
      options.onHtml?.(owner);
      node.html = html;
    },
    translate(key, params) {
      options.onTranslate?.(owner);
      return key.split('.').at(-1) + (params?.seconds ? ':' + params.seconds : '');
    },
    unlimitedAmmo: (count) => count === undefined || count === null || count === Infinity,
    clock() {
      options.onClock?.(owner);
      return time;
    },
    now() {
      options.onNow?.(owner);
      return 100;
    },
    width: 960,
    height: 480,
    fuseWeapons: new Set(['hand_grenade', 'cluster_bomb', 'banana_bomb']),
    isActive: () => isActive,
  });
  return {
    owner,
    state,
    view,
    ctx,
    calls,
    reads: () => reads,
    deactivate: () => {
      isActive = false;
    },
    setTime: (value) => {
      time = value;
    },
  };
}
test('HUD keeps player/worm labels as nodes and current-player marker', () => {
  const s = createScene();
  s.owner.updateHUD();
  const children = s.view.turnLabel.children;
  assert.equal(children[0], 'turnOf ');
  assert.equal(children[1].textContent, '<Player>');
  assert.equal(children[3].textContent, 'Alpha');
  assert.equal(children.at(-1).textContent, 'you');
  assert.equal(s.view.health.children[0].children[1].textContent, 'Alpha 80');
  assert.equal(s.view.health.children[0].children[2].textContent, 'Beta ☠');
  assert.equal(s.view.health.children[0].children[2].style.textDecoration, 'line-through');
});
for (const [wind, expected] of [
  [0, '💨 calmWind'],
  [-4, '💨 ← 4'],
  [7, '💨 → 7'],
]) {
  test(`wind ${wind} retains direction and sudden-death round`, () => {
    const s = createScene();
    s.state.wind = wind;
    s.state.isSuddenDeath = true;
    s.owner.updateHUD();
    assert.equal(s.view.wind.html, expected + ' <span style="color:#f44">💀R2</span>');
  });
}
test('missing main label keeps HUD update inert', () => {
  const s = createScene();
  s.view.turnLabel = null;
  s.owner.updateHUD();
  assert.equal(s.view.health.children.length, 0);
  assert.equal(s.view.wind.html, undefined);
});
test('weapon states retain disabled ammo, pressed selection and badges', () => {
  const s = createScene();
  s.owner.updateWeaponBtns();
  assert.equal(s.view.weaponButtons.bazooka.disabled, true);
  assert.equal(s.view.weaponButtons.bazooka.attributes['aria-pressed'], 'true');
  assert.equal(s.view.weaponButtons.bazooka.badge.textContent, '×0');
  assert.equal(s.view.weaponButtons.drill.badge.style.color, '#ff6644');
  assert.equal(s.view.weaponButtons.rope.badge.textContent, '∞');
  s.state.isMyTurn = false;
  s.owner.updateWeaponBtns();
  assert.equal(s.view.weaponButtons.bazooka.attributes['aria-pressed'], 'false');
});
for (const count of [undefined, null, Infinity]) {
  test(`unlimited ammunition ${count} stays enabled`, () => {
    const s = createScene();
    s.state.ammo.bazooka = count;
    s.owner.updateWeaponBtns();
    assert.equal(s.view.weaponButtons.bazooka.disabled, false);
    assert.equal(s.view.weaponButtons.bazooka.badge.textContent, '∞');
  });
}
test('fuse indicator requires a fuse weapon, local turn and no shot', () => {
  const s = createScene();
  s.state.selectedWeapon = 'hand_grenade';
  s.owner.updateFuseDisplay();
  assert.equal(s.view.fuse.textContent, '⏱ 3s');
  assert.equal(s.view.fuse.style.display, '');
  s.state.hasShotFired = true;
  s.owner.updateFuseDisplay();
  assert.equal(s.view.fuse.style.display, 'none');
});
for (const [time, color, text] of [
  [1000, '#ffcc00', '09'],
  [2000, '#ff8844', '08'],
  [5000, '#ff2222', '05'],
  [11000, '#ff2222', '00'],
]) {
  test(`timer at ${time} keeps ceiling, clamp and threshold color`, () => {
    const s = createScene();
    s.setTime(time);
    s.owner.updateTimerDisplay();
    assert.equal(s.view.timer.textContent, '⏱ ' + text + 's');
    assert.equal(s.view.timer.style.color, color);
  });
}
test('retreat timer is translated and blue while absent deadline leaves display untouched', () => {
  const s = createScene();
  s.state.isRetreating = true;
  s.owner.updateTimerDisplay();
  assert.equal(s.view.timer.textContent, 'retreatTimer:03');
  assert.equal(s.view.timer.style.color, '#88ddff');
  s.state.turnDeadline = 0;
  s.view.timer.textContent = 'keep';
  s.owner.updateTimerDisplay();
  assert.equal(s.view.timer.textContent, 'keep');
});
test('announcement keeps fallback worm, name/color, fade and expiration', () => {
  const s = createScene();
  s.owner.showTurnAnnouncement({
    currentTurn: 'p',
    activeWormId: 'c',
    worms: [{ id: 'c', name: 'Gamma' }],
  });
  s.owner.drawTurnAnnouncement(s.ctx, 2100);
  assert.ok(s.calls.some((c) => c[0] === 'set' && c[1] === 'globalAlpha' && c[2] === 0.5));
  assert.deepEqual(
    s.calls.find((c) => c[0] === 'fillText'),
    ['fillText', '<Player>  —  Gamma', 480, 186.4],
  );
  assert.equal(s.calls.filter((c) => c[0] === 'save').length, 1);
  assert.equal(s.calls.filter((c) => c[0] === 'restore').length, 1);
  const count = s.calls.length;
  s.owner.drawTurnAnnouncement(s.ctx, 2500);
  s.owner.drawTurnAnnouncement(s.ctx, 2600);
  assert.equal(s.calls.length, count);
});

test('HUD construction and inactive calls do not read state or allocate nodes', () => {
  const s = createScene();
  assert.equal(s.reads(), 0);
  s.deactivate();
  s.owner.updateHUD();
  s.owner.updateTimerDisplay();
  s.owner.showTurnAnnouncement({ currentTurn: 'p' });
  assert.equal(s.reads(), 0);
  assert.equal(s.view.turnLabel.children.length, 0);
});
test('HUD stop is terminal, clears announcement and preserves borrowed nodes', () => {
  const s = createScene();
  s.owner.showTurnAnnouncement({ currentTurn: 'p', activeWormId: 'a' });
  s.owner.stop();
  s.owner.stop();
  s.owner.reset();
  const reads = s.reads();
  s.owner.updateHUD();
  s.owner.updateTimerDisplay();
  s.owner.drawTurnAnnouncement(s.ctx, 200);
  assert.equal(s.reads(), reads);
  assert.equal(s.view.health.children.length, 0);
  assert.deepEqual(s.owner.status(), { isStopped: true, hasAnnouncement: false });
});
for (const hook of [
  'onState',
  'onView',
  'onElement',
  'onName',
  'onHtml',
  'onTranslate',
  'onClock',
  'onNow',
]) {
  test(`HUD stop during ${hook} prevents subsequent update work`, () => {
    const s = createScene({ [hook]: (owner) => owner.stop() });
    if (hook === 'onClock') s.owner.updateTimerDisplay();
    else if (hook === 'onNow')
      s.owner.showTurnAnnouncement({ currentTurn: 'p', activeWormId: 'a' });
    else s.owner.updateHUD();
    assert.equal(s.owner.status().isStopped, true);
    assert.equal(s.view.health.children.length, 0);
    const reads = s.reads();
    s.owner.updateHUD();
    assert.equal(s.reads(), reads);
  });
}
test('HUD reset during element creation abandons the old update and allows another', () => {
  let reset = true;
  const s = createScene({
    onElement(owner) {
      if (reset) {
        reset = false;
        owner.reset();
      }
    },
  });
  s.owner.updateHUD();
  assert.equal(s.view.health.children.length, 0);
  s.owner.updateHUD();
  assert.equal(s.view.health.children.length, 1);
});
test('announcement restores canvas context when native text measurement fails', () => {
  const s = createScene();
  s.owner.showTurnAnnouncement({ currentTurn: 'p', activeWormId: 'a' });
  s.ctx.measureText = () => {
    throw Error('measurement failed');
  };
  assert.throws(() => s.owner.drawTurnAnnouncement(s.ctx, 200), /measurement failed/);
  assert.equal(s.calls.filter((c) => c[0] === 'save').length, 1);
  assert.equal(s.calls.filter((c) => c[0] === 'restore').length, 1);
});
