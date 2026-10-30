import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const clientDir = new URL('../client/', import.meta.url);
const sources = readdirSync(clientDir, { recursive: true })
  .filter((name) => name.endsWith('.js'))
  .map((name) => [name, readFileSync(new URL(name, clientDir), 'utf8')]);

test('MUGEN client never parses dynamic text as HTML', () => {
  for (const [name, source] of sources) {
    assert.doesNotMatch(source, /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML/, name);
  }
});

test('MUGEN client renders player names through the shared site helper', () => {
  const lobby = sources.find(([name]) => name === 'index.js')[1];
  assert.match(lobby, /renderUserName\(/);
});

test('MUGEN client only listens to events the site forwards', () => {
  const lobby = sources.find(([name]) => name === 'index.js')[1];
  // website/core/js/games/addons/mugen-entry.js forwards exactly these.
  const forwarded = new Set([
    'mugen:rooms',
    'mugen:open',
    'mugen:closed',
    'mugen:live_open',
    'mugen:live_closed',
    'mugen:created',
    'mugen:joined',
    'mugen:char_picked',
    'mugen:cancelled',
    'mugen:start',
    'mugen:input',
    'mugen:game_over',
    'mugen:forfeit',
    'mugen:spectate_start',
    'mugen:replay',
    'mugen:error',
  ]);
  const handled = [...lobby.matchAll(/^\s{4}['"](mugen:[a-z_]+)['"]:/gm)].map((match) => match[1]);
  assert.ok(handled.length > 10);
  for (const event of handled) assert.ok(forwarded.has(event), event);
});
