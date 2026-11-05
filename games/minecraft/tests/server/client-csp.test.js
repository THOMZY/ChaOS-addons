// Security policy contract for the Minecraft client (/mc/).
//
// The third-party client needs 'unsafe-eval' and blob:, which cannot be avoided
// without rewriting it. The `default-src *` wildcard was avoidable; it allowed
// any origin for scripts, frames, and outbound connections from a document
// sharing the site's origin. This test locks down the tightened policy (batch
// 90): every resource type is named and no wildcard remains.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FORBIDDEN_DIRECTIVES } from '../../../../../server/http/csp.js';
import { MC_CLIENT_CSP } from '../../server/client-csp.js';

const DIRECTIVES = new Map(
  MC_CLIENT_CSP.split(';').map((part) => {
    const [name, ...values] = part.trim().split(/\s+/);
    return [name, values];
  }),
);

test('the Minecraft client policy never grants a wildcard origin', () => {
  for (const pattern of FORBIDDEN_DIRECTIVES) {
    assert.equal(pattern.test(MC_CLIENT_CSP), false, `wildcard forbidden by ${pattern}`);
  }
  assert.equal(MC_CLIENT_CSP.includes('*'), false, 'no wildcard at all');
});

test('the client keeps exactly what it needs to run', () => {
  assert.equal(DIRECTIVES.get('default-src').join(' '), "'none'", 'nothing is allowed implicitly');
  const script = DIRECTIVES.get('script-src');
  for (const value of ["'self'", "'unsafe-eval'", "'wasm-unsafe-eval'", 'blob:', 'data:']) {
    assert.ok(script.includes(value), `script-src needs ${value}`);
  }
  assert.deepEqual(DIRECTIVES.get('worker-src'), ["'self'", 'blob:'], 'asm.js/wasm workers');
  const connect = DIRECTIVES.get('connect-src');
  for (const value of ["'self'", 'ws:', 'wss:'])
    assert.ok(connect.includes(value), `connect-src needs ${value}`);
  assert.ok(DIRECTIVES.get('media-src').includes('mediastream:'), 'audio stream capture survives');
  assert.deepEqual(DIRECTIVES.get('frame-ancestors'), ["'self'"], 'only the site may embed it');
  assert.deepEqual(DIRECTIVES.get('object-src'), ["'none'"], 'no plugin document');
  assert.deepEqual(DIRECTIVES.get('base-uri'), ["'self'"], 'no base-tag hijack');
  assert.deepEqual(DIRECTIVES.get('form-action'), ["'self'"], 'no cross-origin form post');
});

test('every directive is a real CSP directive and appears once', () => {
  const known = new Set([
    'default-src',
    'script-src',
    'script-src-attr',
    'style-src',
    'img-src',
    'media-src',
    'font-src',
    'connect-src',
    'worker-src',
    'frame-src',
    'frame-ancestors',
    'base-uri',
    'form-action',
    'object-src',
  ]);
  const names = [...DIRECTIVES.keys()];
  assert.equal(new Set(names).size, names.length, 'no duplicated directive');
  for (const name of names) assert.ok(known.has(name), `unknown directive ${name}`);
});

test('the header is a single line the browser can parse', () => {
  assert.equal(MC_CLIENT_CSP.includes('\n'), false);
  assert.equal(/;\s*;/.test(MC_CLIENT_CSP), false, 'no empty directive');
  assert.equal(MC_CLIENT_CSP.trim(), MC_CLIENT_CSP);
});
