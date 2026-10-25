import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldStream } from '../client/stream-state.js';

const open = { display: 'flex', visibility: 'visible', width: 400, height: 600 };

test('a background tab keeps streaming', () => {
  // document.hidden is not part of the decision any more: audio must go on.
  assert.equal(shouldStream({ ...open }), true);
});

test('a closed window stops', () => {
  assert.equal(shouldStream({ ...open, closed: true }), false);
});

test('a minimised window stops', () => {
  assert.equal(shouldStream({ ...open, minimized: true }), false);
});

test('display:none and visibility:hidden stop', () => {
  assert.equal(shouldStream({ ...open, display: 'none' }), false);
  assert.equal(shouldStream({ ...open, visibility: 'hidden' }), false);
});

test('a collapsed window stops', () => {
  assert.equal(shouldStream({ ...open, width: 0 }), false);
  assert.equal(shouldStream({ ...open, height: 3 }), false);
});

test('missing fields do not crash and stop the stream', () => {
  assert.equal(shouldStream({}), false);
  assert.equal(shouldStream({ display: 'flex', visibility: 'visible' }), false);
});
