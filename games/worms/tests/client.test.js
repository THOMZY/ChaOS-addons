// Worms browser controller (client/worms.js), moved from the site's
// tests/website/core/js/common-games.test.js and games-user-names.test.js
// (roadmap J7d). The window and its event inventory stay in the site
// (website/core/js/games/worms-entry.js): both must agree.
import './site-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { WORMS_EVENTS } from '../../../website/core/js/games/worms-entry.js';

const CLIENT = new URL('../client/worms.js', import.meta.url);

class Socket {
  connected = true; handlers = new Map(); sent = [];
  on(event, fn) { if (!this.handlers.has(event)) this.handlers.set(event, new Set()); this.handlers.get(event).add(fn); }
  off(event, fn) { this.handlers.get(event)?.delete(fn); if (!this.handlers.get(event)?.size) this.handlers.delete(event); }
  emit(...args) { this.sent.push(args); }
}

test('the site inventory of Worms events covers every socket registration of the controller', async () => {
  const source = await readFile(new URL('../client/worms-events.js', import.meta.url), 'utf8');
  const events = [...source.matchAll(/listen\('([^']+)'/g)].map((match) => match[1]);
  events.push('worms:created', 'worms:joined');
  assert.deepEqual([...new Set(events)].sort(), [...WORMS_EVENTS].sort());
  assert.equal(new Set(WORMS_EVENTS).size, WORMS_EVENTS.length);
});

test('controller instances own socket/global input and stop cannot remove a replacement', async (t) => {
  const saved = new Map();
  const set = (key, value) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  const doc = new EventTarget(), win = new EventTarget();
  doc.getElementById = () => null; doc.querySelector = () => null;
  set('document', doc); set('window', win);
  t.after(() => { for (const [key, value] of saved) { if (value) Object.defineProperty(globalThis, key, value); else delete globalThis[key]; } });
  const module = await import(CLIENT.href);
  const a = new Socket(), b = new Socket();
  const first = module.initWorms(a, () => ({}), () => {}); assert.ok(a.handlers.size > 0);
  first.stop(); first.stop(); assert.equal(a.handlers.size, 0);
  const next = module.initWorms(b, () => ({}), () => {});
  first.stop(); assert.ok(b.handlers.size > 0); next.stop(); assert.equal(b.handlers.size, 0);
});

test('player names go through the site helper, never painted by hand', async () => {
  const source = await readFile(CLIENT, 'utf8');
  assert.match(source, /(?:renderUserName|userNameHtml)\(/);
  assert.doesNotMatch(source, /style: \{ color: [\w?.[\]]+\.color[^}]*\} *\}?, *[\w?.[\]]+\.pseudo/);
  assert.doesNotMatch(source, /style="color:\$\{[^}]*\.color[^}]*\}[^"]*">\$\{[^}]*pseudo/);
});
