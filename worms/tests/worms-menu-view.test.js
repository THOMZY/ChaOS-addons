import test from 'node:test';
import assert from 'node:assert/strict';
import { createWormsMenuView } from '../client/worms-menu-view.js';

function createScene(options = {}) {
  const nodes = [],
    actions = [],
    warnings = [];
  let owner,
    reads = 0,
    isActive = true;
  const state = { openRooms: [], liveRooms: [], myUserId: 'a', selectedTheme: 0 };
  const room = {
    id: 'one',
    bet: 10,
    maxPlayers: 4,
    players: [
      { userId: 'a', pseudo: '<Alice>', color: '#123456' },
      { userId: 'b', pseudo: 'Bob' },
    ],
  };
  function createElement(tag, attrs = {}, text = null) {
    const handlers = new Map(),
      captured = new Map();
    const node = {
      tagName: tag.toUpperCase(),
      attributes: { ...attrs },
      style: { ...attrs.style },
      dataset: {},
      children: [],
      parentNode: null,
      textContent: text ?? '',
      disabled: false,
      appendChild(child) {
        child.remove();
        this.children.push(child);
        child.parentNode = this;
        return child;
      },
      append(...children) {
        children.forEach((child) => this.appendChild(child));
      },
      replaceChildren(...children) {
        this.children.slice().forEach((child) => child.remove());
        this.append(...children);
      },
      remove() {
        if (this.parentNode) {
          this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
          this.parentNode = null;
        }
      },
      setAttribute(key, value) {
        this.attributes[key] = value;
      },
      addEventListener(type, callback) {
        handlers.set(type, callback);
        captured.set(type, callback);
        options.onListen?.(owner, node);
      },
      removeEventListener(type) {
        handlers.delete(type);
        options.onRemove?.(node);
      },
      click() {
        handlers.get('click')?.();
      },
      capture() {
        return captured.get('click');
      },
    };
    nodes.push(node);
    options.onElement?.(owner, node);
    return node;
  }
  const root = createElement('main');
  nodes.length = 0;
  const callbacks = Object.fromEntries(
    ['create', 'join', 'watch', 'exit', 'launch', 'leaveWaiting', 'rematch', 'leaveResults'].map(
      (name) => [name, (...args) => actions.push([name, ...args])],
    ),
  );
  owner = createWormsMenuView({
    getState() {
      reads++;
      options.onState?.(owner);
      return state;
    },
    createElement,
    translate(key, values) {
      options.onTranslate?.(owner);
      return key.split('.').at(-1) + (values ? ':' + JSON.stringify(values) : '');
    },
    setSafeHtml(node, html) {
      node.html = html;
      options.onHtml?.(owner);
    },
    colorSpan(pseudo) {
      return pseudo.replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    },
    levels: [
      { emoji: 'A', name: 'First', skyB: '#111' },
      { emoji: 'B', name: 'Second', skyB: '#222' },
    ],
    actions: {
      ...callbacks,
      canRematch() {
        options.onRematchCheck?.(owner);
        return options.canRematch !== false;
      },
      selectTheme(index, waitingRoom) {
        state.selectedTheme = index;
        owner.mount(root, 'waiting', waitingRoom);
      },
    },
    isActive: () => isActive,
    logger: { warn: (...args) => warnings.push(args) },
  });
  return {
    owner,
    nodes,
    root,
    state,
    room,
    actions,
    warnings,
    get reads() {
      return reads;
    },
    deactivate() {
      isActive = false;
    },
    button(label) {
      return nodes.findLast((node) => node.tagName === 'BUTTON' && node.textContent === label);
    },
  };
}

// These assertions describe the original menu presentation and command arguments.
test('lobby keeps empty-state labels, menu styling and player counts', () => {
  const scene = createScene();
  scene.owner.mount(scene.root, 'lobby');
  assert.equal(scene.root.dataset.gameMode, 'worms-menu');
  assert.match(scene.root.style.cssText, /padding:10px/);
  assert.ok(scene.nodes.some((node) => node.textContent === 'noRooms'));
  assert.deepEqual(
    scene.nodes.filter((node) => node.tagName === 'OPTION').map((node) => node.value),
    [2, 3, 4, 5, 6, 7, 8],
  );
  assert.equal(
    scene.nodes.find((node) => node.tagName === 'OPTION' && node.value === 4).selected,
    true,
  );
});
test('create normalizes negative and invalid bets and forwards player selection', () => {
  const scene = createScene();
  scene.owner.mount(scene.root, 'lobby');
  const input = scene.nodes.find((node) => node.tagName === 'INPUT'),
    select = scene.nodes.find((node) => node.tagName === 'SELECT');
  select.value = '6';
  for (const value of ['-1', 'bad', '25']) {
    input.value = value;
    scene.button('create').click();
  }
  assert.deepEqual(scene.actions, [
    ['create', 0, 6],
    ['create', 0, 6],
    ['create', 25, 6],
  ]);
});
test('open room keeps focus identity, accessible player names and safe markup', () => {
  const scene = createScene();
  scene.state.openRooms = [scene.room];
  scene.owner.mount(scene.root, 'lobby');
  const button = scene.button('join');
  button.click();
  assert.equal(button.attributes['data-game-focus'], 'worms:join:one');
  assert.match(button.attributes['aria-label'], /<Alice>, Bob/);
  assert.ok(scene.nodes.some((node) => node.html?.includes('&lt;Alice&gt;')));
  assert.deepEqual(scene.actions, [['join', scene.room]]);
});
test('live room exposes its spectator action', () => {
  const scene = createScene();
  scene.state.liveRooms = [scene.room];
  scene.owner.mount(scene.root, 'lobby');
  const button = scene.nodes.find((node) => node.attributes['data-worms-watch']);
  button.click();
  assert.equal(button.attributes['data-worms-watch'], 'one');
  assert.deepEqual(scene.actions, [['watch', 'one']]);
});
test('lobby back invokes exit', () => {
  const scene = createScene();
  scene.owner.mount(scene.root, 'lobby');
  scene.button('back').click();
  assert.deepEqual(scene.actions, [['exit']]);
});
test('creator can launch and choose a map before leaving', () => {
  const scene = createScene();
  scene.owner.mount(scene.root, 'waiting', scene.room);
  scene.button('B Second').click();
  assert.equal(scene.state.selectedTheme, 1);
  assert.equal(scene.button('B Second').style.background, '#222');
  scene.button('launch').click();
  scene.button('leave').click();
  assert.deepEqual(scene.actions, [['launch'], ['leaveWaiting']]);
});
test('single-player creator cannot launch', () => {
  const scene = createScene();
  scene.room.players.pop();
  scene.owner.mount(scene.root, 'waiting', scene.room);
  scene.button('launch').click();
  assert.equal(scene.button('launch').style.cursor, 'not-allowed');
  assert.deepEqual(scene.actions, []);
});
test('guest cannot change maps or launch', () => {
  const scene = createScene();
  scene.state.myUserId = 'b';
  scene.owner.mount(scene.root, 'waiting', scene.room);
  scene.button('B Second').click();
  assert.equal(scene.state.selectedTheme, 0);
  assert.equal(scene.button('launch'), undefined);
});
test('draw and missing winner retain draw text without a payout', () => {
  for (const data of [{ draw: true, winner: { pseudo: 'A' }, payout: 50 }, {}]) {
    const scene = createScene();
    scene.owner.mount(scene.root, 'results', data);
    assert.ok(scene.nodes.some((node) => node.textContent === 'draw'));
    assert.ok(scene.nodes.some((node) => node.textContent === 'everyoneDied'));
    assert.equal(
      scene.nodes.some((node) => node.textContent === '+50 pts'),
      false,
    );
  }
});
test('winner, payout and replay acknowledgement retain presentation', () => {
  const scene = createScene();
  scene.owner.mount(scene.root, 'results', {
    winner: { pseudo: '<Alice>', color: '#123456' },
    payout: 50,
  });
  const heading = scene.nodes.find((node) => node.tagName === 'H2');
  assert.match(heading.textContent, /<Alice>/);
  assert.equal(heading.style.color, '#123456');
  assert.ok(scene.nodes.some((node) => node.textContent === '+50 pts'));
  const button = scene.button('playAgain');
  button.click();
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, 'rematchSent');
  scene.button('leave').click();
  assert.deepEqual(scene.actions, [['rematch'], ['leaveResults']]);
});
test('construction is inert and stop is terminal and idempotent', () => {
  const scene = createScene();
  assert.equal(scene.reads, 0);
  assert.equal(scene.nodes.length, 0);
  scene.owner.stop();
  scene.owner.stop();
  assert.equal(scene.owner.mount(scene.root, 'lobby'), false);
  assert.deepEqual(scene.owner.status(), {
    isStopped: true,
    isMounted: false,
    nodes: 0,
    listeners: 0,
  });
});
for (const screen of ['lobby', 'waiting', 'results']) {
  test(`${screen}: reset invalidates captured clicks and releases owned nodes`, () => {
    const scene = createScene();
    scene.state.openRooms = [scene.room];
    scene.state.liveRooms = [scene.room];
    scene.owner.mount(scene.root, screen, screen === 'waiting' ? scene.room : {});
    const captured = scene.nodes.map((node) => node.capture()).filter(Boolean);
    scene.owner.reset();
    const sibling = { remove() {}, parentNode: null };
    scene.root.appendChild(sibling);
    captured.forEach((callback) => callback());
    assert.deepEqual(scene.actions, []);
    assert.deepEqual(scene.root.children, [sibling]);
    assert.equal(scene.owner.status().listeners, 0);
    assert.equal(scene.owner.status().nodes, 0);
  });
}
test('replacement invalidates controls even when returning to the same screen', () => {
  const scene = createScene();
  scene.owner.mount(scene.root, 'lobby');
  const click = scene.button('create').capture();
  scene.owner.mount(scene.root, 'waiting', scene.room);
  scene.owner.mount(scene.root, 'lobby');
  click();
  assert.deepEqual(scene.actions, []);
});
test('inactive scope suppresses captured actions', () => {
  const scene = createScene();
  scene.owner.mount(scene.root, 'lobby');
  scene.deactivate();
  scene.button('back').capture()();
  assert.deepEqual(scene.actions, []);
});
test('replay is single submission and refusal leaves the button unchanged', () => {
  const scene = createScene();
  scene.owner.mount(scene.root, 'results', {});
  const button = scene.button('playAgain');
  button.click();
  button.capture()();
  assert.deepEqual(scene.actions, [['rematch']]);
  const refused = createScene({ canRematch: false });
  refused.owner.mount(refused.root, 'results', {});
  refused.button('playAgain').click();
  assert.equal(refused.button('playAgain').disabled, false);
  assert.deepEqual(refused.actions, []);
});
test('retirement during rematch eligibility cannot acknowledge or send a command', () => {
  const scene = createScene({ onRematchCheck: (owner) => owner.reset() });
  scene.owner.mount(scene.root, 'results', {});
  const button = scene.button('playAgain');
  button.click();
  assert.equal(button.disabled, false);
  assert.deepEqual(scene.actions, []);
});
for (const hook of ['onElement', 'onState', 'onTranslate', 'onHtml', 'onListen']) {
  test(`retirement during ${hook} cancels a partial mount`, () => {
    const scene = createScene({ [hook]: (owner) => owner?.reset() });
    scene.state.openRooms = [scene.room];
    assert.equal(scene.owner.mount(scene.root, 'lobby'), false);
    assert.equal(scene.owner.status().listeners, 0);
    assert.equal(scene.root.children.length, 0);
  });
}
test('real construction errors propagate after cleanup', () => {
  let shouldFail = false;
  const scene = createScene({
    onElement: () => {
      if (shouldFail) throw new Error('DOM unavailable');
    },
  });
  shouldFail = true;
  assert.throws(() => scene.owner.mount(scene.root, 'lobby'), /DOM unavailable/);
  assert.equal(scene.owner.status().isMounted, false);
  assert.equal(scene.root.children.length, 0);
});
test('listener cleanup failures are reported without retaining owned nodes', () => {
  const scene = createScene({
    onRemove: () => {
      throw new Error('remove failed');
    },
  });
  scene.owner.mount(scene.root, 'lobby');
  const click = scene.button('back').capture();
  scene.owner.reset();
  click();
  assert.ok(scene.warnings.length > 0);
  assert.equal(scene.root.children.length, 0);
  assert.equal(scene.owner.status().nodes, 0);
  assert.deepEqual(scene.actions, []);
});

test('rematch waiting updates only the current owned results button', () => {
  const scene = createScene();
  scene.owner.mount(scene.root, 'results', {});
  const oldButton = scene.button('playAgain');
  scene.owner.markRematchWaiting();
  assert.equal(oldButton.disabled, true);
  assert.equal(oldButton.textContent, 'waiting');
  scene.owner.mount(scene.root, 'lobby');
  scene.owner.markRematchWaiting();
  scene.owner.stop();
  scene.owner.markRematchWaiting();
  assert.equal(oldButton.textContent, 'waiting');
});
test('replacement during construction survives abandoned mount cleanup', () => {
  let shouldReplace = true;
  const scene = createScene({
    onTranslate(owner) {
      if (shouldReplace) {
        shouldReplace = false;
        owner.mount(scene.root, 'results', {});
      }
    },
  });
  assert.equal(scene.owner.mount(scene.root, 'lobby'), false);
  assert.equal(scene.owner.status().isMounted, true);
  scene.button('leave').click();
  assert.deepEqual(scene.actions, [['leaveResults']]);
});
test('retirement while translating replay acknowledgement cancels its action', () => {
  let shouldRetire = false;
  const scene = createScene({
    onTranslate: (owner) => {
      if (shouldRetire) owner.reset();
    },
  });
  scene.owner.mount(scene.root, 'results', {});
  const button = scene.button('playAgain');
  shouldRetire = true;
  button.click();
  assert.equal(button.disabled, false);
  assert.deepEqual(scene.actions, []);
});
