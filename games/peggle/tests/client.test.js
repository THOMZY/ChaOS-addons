// Peggle engine (client/peggle.js, a classic script) and UI (client/peggle-ui.js),
// moved from the site's tests/website/core/js/classic-game-resources.test.js
// (roadmap J7e). The UI imports the site's modules by URL: see site-modules.mjs.
import './site-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const { createPeggleUi } = await import('../client/peggle-ui.js');

const engineSource = await readFile(new URL('../client/peggle.js', import.meta.url), 'utf8');
function engineFixture() {
  const frames = new Map(), timers = new Map(), sounds = []; let frameId = 0, timerId = 0;
  class Sound { constructor() { sounds.push(this); } cloneNode() { return new Sound(); } play() { this.playing = true; return Promise.resolve(); } pause() { this.playing = false; this.paused = true; } removeAttribute() { this.released = true; } load() {} }
  const context = vm.createContext({ Image: class {}, Audio: Sound, crypto: globalThis.crypto,
    requestAnimationFrame: fn => { const id = frameId++; frames.set(id, fn); return id; }, cancelAnimationFrame: id => frames.delete(id),
    setTimeout: fn => { const id = timerId++; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id) });
  vm.runInContext(engineSource, context);
  const canvas = new EventTarget(); canvas.width = 554; canvas.height = 464; canvas.getContext = () => ({ setTransform() {} });
  const engine = new context.PeggleEngine(canvas, []);
  return { engine, context, frames, timers, sounds, canvas };
}

test('real Peggle engine stop cancels RAF zero, delayed victory and all cloned audio', () => {
  const { engine, frames, timers, sounds } = engineFixture();
  const lateFrame = frames.get(0); engine._endShot(); assert.equal(timers.size, 1); const lateSound = [...timers.values()][0];
  assert.ok(sounds.some(sound => sound.playing)); engine.destroy(); engine.destroy();
  assert.equal(frames.size, 0); assert.equal(timers.size, 0); assert.ok(sounds.every(sound => sound.paused && sound.released));
  const count = sounds.length; lateSound(); lateFrame(123); engine._playSound('late'); assert.equal(sounds.length, count); assert.equal(frames.size, 0);
});

test('real Peggle loop cannot render or schedule after synchronous destruction in game over', () => {
  const { engine, frames } = engineFixture(); let renders = 0;
  engine._update = () => engine.destroy(); engine._render = () => renders++;
  const frame = frames.get(0); frames.delete(0); frame(123); assert.equal(renders, 0); assert.equal(frames.size, 0);
});

test('late classic script evaluation can run twice without global lexical redeclarations', () => {
  const { context } = engineFixture(); assert.doesNotThrow(() => vm.runInContext(engineSource, context)); assert.equal(typeof context.PeggleEngine, 'function');
});

test('Peggle accessible angle uses the pointer bounds and rejects non-finite or in-flight input', () => {
  const { engine } = engineFixture();
  assert.equal(engine.aimAt(Infinity), false);
  assert.equal(engine.aimAt(-10), true); assert.equal(engine.aimAngle, 0.04);
  engine.aimAt(200); assert.equal(engine.aimAngle, Math.PI - 0.04);
  engine.aimAt(90); engine.shoot(); const angle = engine.aimAngle;
  assert.equal(engine.aimAt(30), false); assert.equal(engine.aimAngle, angle);
  engine.destroy(); assert.equal(engine.aimAt(45), false);
});
test('Peggle keyboard shot consumes one ball and cannot refire during flight or after destruction', () => {
  const { engine } = engineFixture(); let updates = 0; engine.onControlState = () => updates++;
  engine.shoot(); engine.shoot(); assert.equal(engine.balls, 9); assert.equal(updates, 1);
  engine.destroy(); engine.state = 'aim'; engine.shoot(); assert.equal(engine.balls, 9);
});

function uiFixture(t, Engine) {
  const saved = new Map(), observers = [];
  const set = (key, value) => { saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); };
  t.after(() => { for (const [key, value] of saved) { if (value) Object.defineProperty(globalThis, key, value); else delete globalThis[key]; } });
  class Node extends EventTarget {
    children = []; style = {}; className = ''; clientWidth = 554; clientHeight = 464;
    set innerHTML(value) { this.children = []; }
    replaceChildren(...nodes) { this.children = nodes; }
    appendChild(node) { this.children.push(node); return node; }
    setAttribute(key, value) { this[key] = value; }
    querySelector(selector) {
      for (const node of this.children) {
        if (selector.startsWith('.') ? node.className?.split(' ').includes(selector.slice(1)) : node.tagName === selector) return node;
        const nested = node.querySelector?.(selector); if (nested) return nested;
      }
      return null;
    }
  }
  const body = new Node(), scores = [], forfeits = [];
  set('document', { createElement(tagName) { const node = new Node(); node.tagName = tagName; return node; }, createTextNode: text => ({ text }) });
  set('PeggleEngine', Engine);
  set('ResizeObserver', class { constructor(fn) { this.fn = fn; observers.push(this); } observe() { this.active = true; } disconnect() { this.active = false; } });
  const ui = createPeggleUi({ getContainer: () => body, emitScore: (...args) => scores.push(args), emitForfeit: id => forfeits.push(id) });
  t.after(() => ui.dispose()); return { ui, body, observers, scores, forfeits };
}

test('Peggle UI invalidates previous engine callbacks and forfeit button on replacement', t => {
  const callbacks = [], engines = [];
  const { ui, body, scores, forfeits, observers } = uiFixture(t, class { constructor(canvas, pegs, opts) { callbacks.push(opts.onGameOver); engines.push(this); } destroy() { this.destroyed = true; } });
  ui.start({ gameId: 'old', pegs: [] }); const button = body.querySelector('.peggle-forfeit-btn'), canvas = body.querySelector('canvas');
  ui.start({ gameId: 'new', pegs: [] }); callbacks[0](999); button.dispatchEvent(new Event('click'));
  assert.equal(scores.length + forfeits.length, 0); assert.ok(engines[0].destroyed);
  const width = canvas.style.width; body.clientWidth = 20; observers[0].fn(); assert.equal(canvas.style.width, width);
  callbacks[1](42); callbacks[1](43); assert.deepEqual(scores, [['new', 42]]); assert.ok(body.querySelector('.peggle-waiting'));
  assert.ok(observers.every(observer => !observer.active));
});

test('Peggle UI terminal dispose forbids remount and cannot restore a newer owner styles', t => {
  const { ui, body, forfeits } = uiFixture(t, class { destroy() {} });
  ui.start({ gameId: 'old', pegs: [] }); const oldButton = body.querySelector('.peggle-forfeit-btn');
  const next = createPeggleUi({ getContainer: () => body, emitScore() {} });
  next.start({ gameId: 'new', pegs: [] }); oldButton.dispatchEvent(new Event('click')); assert.equal(forfeits.length, 0); ui.dispose(); ui.dispose();
  assert.equal(body.style.display, 'flex'); assert.equal(ui.start({ gameId: 'late', pegs: [] }), false); next.dispose();
});

test('Peggle partial engine construction releases observer and supports a fresh attempt', t => {
  const { ui, observers, body } = uiFixture(t, class { constructor() { throw Error('constructor failed'); } });
  assert.throws(() => ui.start({ gameId: 'paid', pegs: [] }), /constructor failed/);
  assert.ok(observers.every(observer => !observer.active)); assert.equal(body.style.display, '');
  globalThis.PeggleEngine = class { destroy() {} }; assert.equal(ui.start({ gameId: 'paid', pegs: [] }), true);
});

test('synchronous game over during Peggle construction destroys the returned engine and scores once', t => {
  let destroyed = 0;
  const { ui, scores, body } = uiFixture(t, class { constructor(canvas, pegs, opts) { opts.onGameOver(10); opts.onGameOver(20); } destroy() { destroyed++; } });
  assert.equal(ui.start({ gameId: 'paid', pegs: [] }), true); assert.deepEqual(scores, [['paid', 10]]);
  assert.equal(destroyed, 1); assert.ok(body.querySelector('.peggle-waiting'));
});

test('synchronous result during score emission cannot be overwritten by a waiting screen', t => {
  let complete;
  const { ui, body } = uiFixture(t, class { constructor(canvas, pegs, opts) { complete = opts.onGameOver; } destroy() {} });
  const owner = createPeggleUi({ getContainer: () => body, emitScore() { owner.stop(); body.innerHTML = ''; body.style.display = 'result'; } });
  owner.start({ gameId: 'paid', pegs: [] }); complete(42); assert.equal(body.style.display, 'result'); assert.equal(body.querySelector('.peggle-waiting'), null); owner.dispose(); ui.dispose();
});

test('the table client loads the engine through the site resource loader only', async () => {
  const client = await readFile(new URL('../client/index.js', import.meta.url), 'utf8');
  assert.match(client, /loadGameResources\('peggle'\)/);
  assert.doesNotMatch(client, /from ['"][^'"]*peggle-ui\.js['"]/);
});
