import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeSession } from '../client/engine/native-session.js';

test('cancelled training completes before the next match is queued, preserving per-match callbacks', async () => {
  const results = [],
    volumes = [];
  let match = 0;
  const session = createNativeSession({
    outcome: () => ({ match }),
    onReady: () => match++,
    setVolume: (value) => volumes.push(value),
  });
  const options = (name) => ({
    args: ['-p1', name],
    audio: { bgm: 20, sfx: 0 },
    onStatus() {},
    onExit: (result) => results.push([name, result.match]),
  });
  await session.launch(options('first'), true);
  session.cancel();
  assert.equal(session.bridge.stop, true);
  let started = false;
  const second = session.launch(options('second')).then(() => (started = true));
  await Promise.resolve();
  assert.equal(started, false);
  session.bridge.finished();
  await second;
  assert.deepEqual(results, [['first', 1]]);
  assert.equal(session.bridge.pending, '["-p1","second"]');
  assert.equal(session.bridge.stop, false);
  session.bridge.finished();
  assert.deepEqual(results, [
    ['first', 1],
    ['second', 2],
  ]);
  assert.equal(volumes.length, 2);
});

test('presentation waits through a browser paint before the native engine may advance', async (t) => {
  const previous = globalThis.requestAnimationFrame,
    frames = [],
    status = [];
  globalThis.requestAnimationFrame = (callback) => frames.push(callback);
  t.after(() => {
    globalThis.requestAnimationFrame = previous;
  });
  const session = createNativeSession({ outcome: () => ({}), onReady() {}, setVolume() {} });
  await session.launch(
    { args: [], audio: {}, onStatus: (value) => status.push(value.phase), onExit() {} },
    true,
  );
  session.bridge.present();
  assert.equal(status.at(-1), 'running');
  assert.equal(session.bridge.presented, false);
  frames.shift()();
  assert.equal(session.bridge.presented, false);
  frames.shift()();
  assert.equal(session.bridge.presented, true);
});
