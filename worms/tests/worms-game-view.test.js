import test from 'node:test';
import assert from 'node:assert/strict';
import { createWormsGameView } from '../client/worms-game-view.js';

function createScene(options = {}) {
  const state = {
      selectedWeapon: 'bazooka',
      isMuted: false,
      isSpectateMode: false,
      isMyTurn: true,
    },
    actions = [],
    nodes = [],
    warnings = [];
  let owner,
    reads = 0,
    isActive = true,
    attached = null;
  function createElement(tag, attrs = {}, text = null) {
    const handlers = new Map(),
      captured = [];
    const node = {
      tagName: tag.toUpperCase(),
      style: { ...attrs.style },
      className: attrs.class ?? '',
      dataset: {},
      attributes: {},
      children: [],
      parentNode: null,
      textContent: text ?? '',
      width: 0,
      height: 0,
      append(...values) {
        for (const value of values) this.appendChild(value);
      },
      appendChild(child) {
        child.remove?.();
        this.children.push(child);
        child.parentNode = this;
        return child;
      },
      replaceChildren(...values) {
        for (const child of this.children) child.parentNode = null;
        this.children = [];
        this.append(...values);
      },
      insertBefore(child, before) {
        const index = this.children.indexOf(before);
        if (index < 0) throw Error('missing sibling');
        this.children.splice(index, 0, child);
        child.parentNode = this;
      },
      remove() {
        if (this.parentNode) {
          const index = this.parentNode.children.indexOf(this);
          this.parentNode.children.splice(index, 1);
          this.parentNode = null;
        }
      },
      setAttribute(key, value) {
        this.attributes[key] = value;
      },
      removeAttribute(key) {
        delete this.attributes[key];
        if (key === 'src') this.src = '';
      },
      addEventListener(type, callback) {
        if (!handlers.has(type)) handlers.set(type, new Set());
        handlers.get(type).add(callback);
        captured.push({ type, callback });
      },
      removeEventListener(type, callback) {
        handlers.get(type)?.delete(callback);
      },
      fire(type) {
        this['on' + type]?.();
        for (const callback of [...(handlers.get(type) ?? [])]) callback({ type });
      },
      capture(type) {
        return captured.find((entry) => entry.type === type)?.callback ?? this['on' + type];
      },
      getContext() {
        options.onContext?.(owner);
        return options.noContext ? null : { canvas: this };
      },
    };
    nodes.push(node);
    if (owner) options.onElement?.(owner, node);
    return node;
  }
  const root = createElement('main');
  nodes.length = 0;
  const weapons = { bazooka: { icon: '🚀', key: '1' }, drill: { icon: '🔩', key: '8' } };
  owner = createWormsGameView({
    getState() {
      reads++;
      options.onState?.(owner);
      return state;
    },
    createElement,
    weapons,
    getWeaponLabel(key) {
      options.onLabel?.(owner);
      return 'label:' + key;
    },
    getWeaponIconName: (key) => (key === 'bazooka' ? 'iconbazooka' : null),
    translate(key) {
      options.onTranslate?.(owner);
      return key.split('.').at(-1);
    },
    attachInput(canvas, name, help) {
      attached = canvas;
      actions.push(['attach', canvas, name, help]);
      options.onAttach?.(owner);
    },
    detachInput(canvas) {
      if (attached === canvas) {
        attached = null;
        actions.push(['detach', canvas]);
      }
    },
    mountTerrain() {
      actions.push(['terrain']);
      options.onTerrain?.(owner);
    },
    onSelectWeapon: (key) => actions.push(['select', key]),
    onQuitSpectating: () => actions.push(['quit']),
    onEndTurn() {
      if (state.isMyTurn) actions.push(['end']);
    },
    onForfeit: () => actions.push(['forfeit']),
    confirm(message) {
      actions.push(['confirm', message]);
      options.onConfirm?.(owner);
      return options.confirmed ?? true;
    },
    logger: { warn: (...args) => warnings.push(args) },
    isActive: () => isActive,
  });
  return {
    owner,
    warnings,
    state,
    actions,
    nodes,
    root,
    reads: () => reads,
    attached: () => attached,
    deactivate: () => {
      isActive = false;
    },
    mount: () => owner.mount(root),
  };
}
function findByText(scene, text) {
  return scene.nodes.find((node) => node.tagName === 'BUTTON' && node.textContent === text);
}

test('game view builds four regions in order and the original canvas/input/terrain contract', () => {
  const s = createScene(),
    view = s.mount();
  assert.deepEqual(
    s.root.children.map((node) => node.className),
    ['worms-topbar', 'worms-stage', 'worms-toolbar', 'worms-healthbar'],
  );
  assert.equal(view.canvas.width, 960);
  assert.equal(view.canvas.height, 480);
  assert.equal(view.context.canvas, view.canvas);
  assert.equal(view.turnLabel.attributes['data-game-status'], '');
  assert.equal(s.actions[0][0], 'attach');
  assert.equal(s.actions[0][2], 'Worms');
  assert.equal(s.actions[0][3], 'controls');
  assert.equal(s.actions[1][0], 'terrain');
  assert.ok(s.root.style.cssText.includes('flex-direction:column'));
});
test('weapon controls retain order, labels, pressed state, shortcuts and ammo hooks', () => {
  const s = createScene(),
    view = s.mount();
  assert.deepEqual(Object.keys(view.weaponButtons), ['bazooka', 'drill']);
  const bazooka = view.weaponButtons.bazooka,
    drill = view.weaponButtons.drill;
  assert.equal(bazooka.title, 'label:bazooka');
  assert.equal(bazooka.attributes['aria-label'], 'label:bazooka');
  assert.equal(bazooka.attributes['aria-pressed'], 'true');
  assert.equal(drill.attributes['aria-pressed'], 'false');
  assert.equal(bazooka.children[1].textContent, '1');
  assert.equal(bazooka.children[2].dataset.ammo, 'bazooka');
  assert.equal(view.fuse.style.display, 'none');
  assert.equal(view.fuse.title, 'grenadeTimerHelp');
});
test('weapon clicks call the existing selection action', () => {
  const s = createScene(),
    view = s.mount();
  view.weaponButtons.drill.fire('click');
  assert.deepEqual(s.actions.at(-1), ['select', 'drill']);
});
test('weapon image paths preserve fallback names and native error uses a textual icon', () => {
  const s = createScene(),
    view = s.mount(),
    button = view.weaponButtons.drill,
    image = button.children[0];
  assert.equal(image.src, '/worms-assets/images/weaponicons/iconbazooka.png');
  image.fire('error');
  assert.equal(image.style.display, 'none');
  assert.equal(button.children[1].textContent, '🔩');
  assert.equal(button.children[2].textContent, '8');
});
test('mute control toggles shared state, emoji and pressed semantics', () => {
  const s = createScene(),
    view = s.mount();
  assert.equal(view.muteButton.attributes['aria-label'], 'sound');
  assert.equal(view.muteButton.attributes['aria-pressed'], 'true');
  view.muteButton.fire('click');
  assert.equal(s.state.isMuted, true);
  assert.equal(view.muteButton.textContent, '🔇');
  assert.equal(view.muteButton.attributes['aria-pressed'], 'false');
  view.muteButton.fire('click');
  assert.equal(s.state.isMuted, false);
  assert.equal(view.muteButton.textContent, '🔊');
});
test('end-turn action rechecks local turn at click time', () => {
  const s = createScene();
  s.mount();
  const button = findByText(s, 'endTurn');
  s.state.isMyTurn = false;
  button.fire('click');
  assert.equal(
    s.actions.some((action) => action[0] === 'end'),
    false,
  );
  s.state.isMyTurn = true;
  button.fire('click');
  assert.deepEqual(s.actions.at(-1), ['end']);
});
for (const confirmed of [false, true]) {
  test(`forfeit confirmation ${confirmed} preserves the action gate`, () => {
    const s = createScene({ confirmed });
    s.mount();
    const button = findByText(s, '✗');
    assert.equal(button.title, 'forfeit');
    button.fire('click');
    assert.deepEqual(
      s.actions.filter((action) => action[0] === 'confirm'),
      [['confirm', 'confirmForfeit']],
    );
    assert.equal(
      s.actions.some((action) => action[0] === 'forfeit'),
      confirmed,
    );
  });
}
test('spectator toolbar offers quit instead of end-turn and forfeit', () => {
  const s = createScene();
  s.state.isSpectateMode = true;
  s.mount();
  assert.equal(findByText(s, 'endTurn'), undefined);
  assert.equal(findByText(s, '✗'), undefined);
  findByText(s, 'leaveSpectator').fire('click');
  assert.deepEqual(s.actions.at(-1), ['quit']);
});
test('missing native 2D context retains the controller null-context behavior', () => {
  const s = createScene({ noContext: true });
  assert.equal(s.mount().context, null);
});

test('construction and inactive mount read no state and create no nodes', () => {
  const s = createScene();
  assert.equal(s.reads(), 0);
  assert.equal(s.nodes.length, 0);
  s.deactivate();
  assert.equal(s.mount(), null);
  assert.equal(s.reads(), 0);
  assert.equal(s.nodes.length, 0);
});
test('reset releases listeners, sources, bitmap and input while preserving foreign root content', () => {
  const s = createScene(),
    view = s.mount(),
    images = s.nodes.filter((node) => node.tagName === 'IMG');
  const foreign = { parentNode: null };
  s.root.appendChild(foreign);
  s.owner.reset();
  assert.equal(view.canvas.width, 0);
  assert.equal(view.canvas.height, 0);
  assert.ok(images.every((image) => !image.src));
  assert.equal(s.attached(), null);
  assert.deepEqual(s.root.children, [foreign]);
  assert.deepEqual(s.owner.status(), { isStopped: false, hasView: false, listeners: 0, images: 0 });
  assert.equal(s.owner.getView(), null);
});
test('remount retires captured clicks and icon errors without affecting the following view', () => {
  const s = createScene(),
    first = s.mount(),
    oldImage = first.weaponButtons.drill.children[0],
    click = first.weaponButtons.drill.capture('click'),
    error = oldImage.capture('error'),
    mute = first.muteButton.capture('click');
  const second = s.mount(),
    count = s.actions.length;
  click({ type: 'click' });
  error({ type: 'error' });
  mute({ type: 'click' });
  assert.equal(s.actions.length, count);
  assert.equal(s.state.isMuted, false);
  assert.equal(first.canvas.width, 0);
  assert.equal(second.canvas.width, 960);
  assert.equal(s.owner.getView(), second);
  assert.equal(s.root.children.length, 4);
});
test('stop is terminal and leaves borrowed state and catalogue intact', () => {
  const s = createScene(),
    view = s.mount(),
    click = view.weaponButtons.bazooka.capture('click');
  s.owner.stop();
  s.owner.stop();
  const reads = s.reads();
  click({ type: 'click' });
  assert.equal(s.mount(), null);
  assert.equal(s.reads(), reads);
  assert.equal(s.state.selectedWeapon, 'bazooka');
  assert.deepEqual(s.owner.status(), { isStopped: true, hasView: false, listeners: 0, images: 0 });
});
test('an icon error produces exactly one text fallback even through a captured callback', () => {
  const s = createScene(),
    view = s.mount(),
    button = view.weaponButtons.drill,
    image = button.children[0],
    error = image.capture('error');
  image.fire('error');
  error({ type: 'error' });
  image.fire('error');
  assert.equal(button.children.length, 4);
  assert.equal(button.children.filter((child) => child.textContent === '🔩').length, 1);
});
test('initial mute icon reflects persisted mute state on every mount', () => {
  const s = createScene();
  s.state.isMuted = true;
  let view = s.mount();
  assert.equal(view.muteButton.textContent, '🔇');
  assert.equal(view.muteButton.attributes['aria-pressed'], 'false');
  view = s.mount();
  assert.equal(view.muteButton.textContent, '🔇');
});
test('mute writes through shared accessors without copying scalar state', () => {
  const s = createScene();
  let muted = true;
  Object.defineProperty(s.state, 'isMuted', {
    get: () => muted,
    set: (value) => {
      muted = value;
    },
    configurable: true,
  });
  const view = s.mount();
  view.muteButton.fire('click');
  assert.equal(muted, false);
  assert.equal(view.muteButton.textContent, '🔊');
});
test('a confirmation that retires the view cannot forfeit another game', () => {
  const s = createScene({ onConfirm: (owner) => owner.stop() });
  s.mount();
  findByText(s, '✗').fire('click');
  assert.equal(
    s.actions.some((action) => action[0] === 'forfeit'),
    false,
  );
  assert.equal(s.owner.status().hasView, false);
});
for (const hook of [
  'onState',
  'onElement',
  'onLabel',
  'onTranslate',
  'onAttach',
  'onContext',
  'onTerrain',
]) {
  test(`stop during ${hook} abandons construction and releases partial resources`, () => {
    const s = createScene({ [hook]: (owner) => owner.stop() });
    assert.equal(s.mount(), null);
    assert.equal(s.owner.getView(), null);
    assert.equal(s.attached(), null);
    assert.ok(
      s.nodes
        .filter((node) => node.tagName === 'CANVAS')
        .every((node) => node.width === 0 && node.height === 0),
    );
    assert.ok(s.nodes.filter((node) => node.tagName === 'IMG').every((node) => !node.src));
    assert.deepEqual(s.owner.status(), {
      isStopped: true,
      hasView: false,
      listeners: 0,
      images: 0,
    });
  });
}
test('reset during allocation abandons the old mount and permits retry', () => {
  let shouldReset = true;
  const s = createScene({
    onElement(owner) {
      if (shouldReset) {
        shouldReset = false;
        owner.reset();
      }
    },
  });
  assert.equal(s.mount(), null);
  const view = s.mount();
  assert.equal(view.canvas.width, 960);
  assert.equal(s.owner.status().hasView, true);
});
test('reentrant replacement survives cleanup of the retired outer mount', () => {
  let shouldReplace = true,
    s;
  s = createScene({
    onLabel(owner) {
      if (shouldReplace) {
        shouldReplace = false;
        owner.mount(s.root);
      }
    },
  });
  assert.equal(s.mount(), null);
  const next = s.owner.getView();
  assert.ok(next);
  assert.equal(next.canvas.width, 960);
  assert.equal(s.attached(), next.canvas);
  assert.equal(s.root.children.length, 4);
});
test('real context errors propagate after partial view cleanup', () => {
  const s = createScene({
    onContext() {
      throw Error('context failed');
    },
  });
  assert.throws(() => s.mount(), /context failed/);
  assert.equal(s.owner.status().hasView, false);
  assert.equal(s.attached(), null);
  assert.ok(s.nodes.filter((node) => node.tagName === 'CANVAS').every((node) => node.width === 0));
});
test('cleanup failures are logged while the remaining resources are released', () => {
  const s = createScene(),
    view = s.mount(),
    images = s.nodes.filter((node) => node.tagName === 'IMG');
  images[0].removeAttribute = () => {
    throw Error('source blocked');
  };
  s.owner.reset();
  assert.equal(s.warnings.length, 1);
  assert.equal(images[1].src, '');
  assert.equal(view.canvas.width, 0);
  assert.equal(s.attached(), null);
  assert.equal(s.root.children.length, 0);
});
