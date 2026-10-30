import assert from 'node:assert/strict';
import test from 'node:test';
import { createReplays } from '../server/replays.js';
import { createLiveReplay, createReplaySender, REPLAY_PATH } from '../client/engine/live-replay.js';
import { createBrowserFileSystem } from '../client/engine/vfs.js';

const call = (fs, method, ...args) =>
  new Promise((resolve, reject) => {
    fs[method](...args, (error, value) => (error ? reject(error) : resolve(value)));
  });

test('successive replay sessions restore filesystem hooks and begin from byte zero', async () => {
  const files = createBrowserFileSystem({ groups: [] });
  const original = { open: files.fs.open, read: files.fs.read, close: files.fs.close };
  for (const value of [7, 9]) {
    const replay = createLiveReplay(files);
    replay.push({ offset: 0, data: new Uint8Array([value]) });
    replay.end();
    const fd = await call(files.fs, 'open', REPLAY_PATH, 0, 0),
      bytes = new Uint8Array(1);
    await call(files.fs, 'read', fd, bytes, 0, 1, 0);
    assert.equal(bytes[0], value);
    await call(files.fs, 'close', fd);
    replay.dispose();
    assert.equal(files.fs.open, original.open);
    assert.equal(files.fs.read, original.read);
    assert.equal(files.fs.close, original.close);
  }
});

test('MUGEN replay history retains every byte in order and fails closed on gaps', () => {
  const replays = createReplays({ now: () => 0 });
  const push = (offset, data = Buffer.from([1, 2])) => replays.push('room', { offset, data });
  for (const offset of [-1, 0.5, NaN]) assert.equal(push(offset), null);
  assert.equal(push(0, new Uint8Array([1])), null);
  assert.equal(push(0, Buffer.alloc(32769)), null);
  assert.equal(push(2), null, 'history cannot begin mid-file');
  const bytes = Buffer.from([5, 6]);
  push(0, bytes);
  bytes[0] = 99;
  push(2);
  assert.deepEqual(
    replays.snapshot('room').map((chunk) => [...chunk.data]),
    [
      [5, 6],
      [1, 2],
    ],
  );
  assert.equal(push(5), null);
  assert.equal(replays.invalid('room'), true);
  assert.deepEqual(replays.snapshot('room'), []);
  assert.equal(push(4), null, 'a corrupt history cannot resume');
  replays.clear('room');
  assert.equal(replays.size(), 0);
});

test('MUGEN replay history enforces bandwidth and total memory limits', () => {
  let now = 0;
  const replays = createReplays({ now: () => now });
  const bytes = Buffer.alloc(32768);
  for (let i = 0; i < 4; i++)
    assert.ok(replays.push('rate', { offset: i * bytes.length, data: bytes }));
  assert.equal(replays.push('rate', { offset: 4 * bytes.length, data: bytes }), null);
  assert.equal(replays.invalid('rate'), true);
  for (let i = 0; i < 512; i++) {
    now += 1000;
    assert.ok(replays.push('size', { offset: i * bytes.length, data: bytes }));
  }
  now += 1000;
  assert.equal(replays.push('size', { offset: 16 * 1024 * 1024, data: bytes }), null);
  replays.clearAll();
  assert.equal(replays.size(), 0);
});

test('MUGEN live replay blocks partial reads, preserves seed bytes and ends at real EOF', async () => {
  const files = createBrowserFileSystem({});
  const replay = createLiveReplay(files);
  const handle = await call(files.fs, 'open', REPLAY_PATH, 0, 0);
  const bytes = new Uint8Array(8);
  let settled = false;
  const reading = call(files.fs, 'read', handle, bytes, 0, 8, 0).then((count) => {
    settled = true;
    return count;
  });
  replay.push({ offset: 0, data: [73, 75, 82, 80] });
  await Promise.resolve();
  assert.equal(settled, false, 'temporary EOF must not terminate playback');
  replay.push({ offset: 4, data: [76, 67, 70, 71] });
  assert.equal(await reading, 8);
  assert.equal(new TextDecoder().decode(bytes), 'IKRPLCFG');
  replay.push({ offset: 8, data: new Uint8Array(64 * 121) });
  assert.equal(replay.speed(), 8);
  await call(files.fs, 'read', handle, bytes, 0, 8, 64 * 121);
  assert.equal(replay.speed(), 1);
  const eof = call(files.fs, 'read', handle, bytes, 0, 8, 64 * 121 + 8);
  replay.end();
  assert.equal(await eof, 0);
  await call(files.fs, 'close', handle);
});

test('MUGEN live replay rejects gaps and releases pending reads on close', async () => {
  const files = createBrowserFileSystem({});
  const replay = createLiveReplay(files);
  const handle = await call(files.fs, 'open', REPLAY_PATH, 0, 0);
  const reading = call(files.fs, 'read', handle, new Uint8Array(8), 0, 8, 0);
  const rejected = assert.rejects(reading, /replay_gap/);
  replay.push({ offset: 4, data: [1] });
  await rejected;
  await call(files.fs, 'close', handle);
  const other = createBrowserFileSystem({});
  createLiveReplay(other);
  const another = await call(other.fs, 'open', REPLAY_PATH, 0, 0);
  const pending = assert.rejects(
    call(other.fs, 'read', another, new Uint8Array(1), 0, 1, 0),
    /replay_closed/,
  );
  await call(other.fs, 'close', another);
  await pending;
});

test('MUGEN replay sender copies Go memory and flushes the final inputs before results', async () => {
  const sent = [],
    tasks = new Map();
  let next = 0;
  const sender = createReplaySender((chunk) => sent.push(chunk), {
    setTimeout(fn) {
      tasks.set(++next, fn);
      return next;
    },
    clearTimeout(id) {
      tasks.delete(id);
    },
  });
  const files = createBrowserFileSystem({}, { onWrite: sender.write });
  const handle = await call(files.fs, 'open', REPLAY_PATH, files.fs.constants.O_CREAT, 0);
  const bytes = new Uint8Array([1, 2, 3]);
  await call(files.fs, 'write', handle, bytes, 0, 3, 0);
  bytes[0] = 99;
  await call(files.fs, 'write', handle, new Uint8Array([4]), 0, 1, 3);
  assert.equal(sent.length, 0);
  [...tasks.values()][0]();
  assert.deepEqual([...sent[0].data], [1, 2, 3, 4]);
  await call(files.fs, 'write', handle, new Uint8Array([5]), 0, 1, 4);
  sender.dispose();
  assert.deepEqual(
    sent.map((chunk) => [chunk.offset, ...chunk.data]),
    [
      [0, 1, 2, 3, 4],
      [4, 5],
    ],
  );
  assert.equal(tasks.size, 0);
});
