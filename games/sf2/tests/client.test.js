import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8');
test('sf2 renders player names through the shared site helper', () => {
  assert.match(source, /(?:renderUserName|userNameHtml)\(/);
  assert.doesNotMatch(source, /style="color:\$\{[^}]*\.color[^}]*\}[^"]*">\$\{[^}]*pseudo/);
});
