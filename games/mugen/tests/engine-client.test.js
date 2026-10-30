import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserFileSystem, normalizePath } from '../client/engine/vfs.js';
import { CONTROL, DATAGRAM, STREAM, createNetBridge } from '../client/engine/net-bridge.js';
import { readWinSide } from '../client/engine/host.js';
import { duelArgs } from '../client/match-options.js';

test('MUGEN duel and replay use explicit palettes even for a mirror match', () => {
  const p1 = { path: 'kfm/kfm.def' },
    stage = { path: 'kfm.def' };
  for (const p2 of [p1, { path: 'Ryu/ryu.def' }]) {
    const args = duelArgs({ p1, p2, stage });
    assert.equal(args[args.indexOf('-p1.pal') + 1], '1');
    assert.equal(args[args.indexOf('-p2.pal') + 1], p1 === p2 ? '2' : '1');
    assert.equal(args[args.indexOf('-s') + 1], 'stages/kfm.def');
  }
});

const call = (fs, method, ...args) =>
  new Promise((resolve, reject) =>
    fs[method](...args, (error, value) => (error ? reject(error) : resolve(value))),
  );

test('resident VFS admits newly uploaded packs without discarding existing match files', async () => {
  const files = createBrowserFileSystem(
    { groups: [] },
    { fetchFile: async () => new Response('sprite') },
  );
  files.writeText('save/private.log', 'keep');
  files.mount({ groups: [{ prefix: 'chars/', base: '/mugen/', files: [['new/new.sff', 6]] }] });
  const fd = await call(files.fs, 'open', 'chars/new/new.sff', 0, 0);
  assert.ok(fd >= 3);
  assert.equal(files.readText('save/private.log'), 'keep');
  await call(files.fs, 'close', fd);
});

function fileSystem(files = {}) {
  const fetched = [];
  const manifest = {
    groups: [
      { prefix: '', base: '/engine/fs/', files: [['data/fight.def', 5]] },
      {
        prefix: 'chars/',
        base: '/mugen/',
        files: Object.entries(files).map(([path, text]) => [path, text.length]),
      },
    ],
    generated: { 'data/select.def': '[Characters]\n' },
  };
  const files_ = createBrowserFileSystem(manifest, {
    async fetchFile(url) {
      fetched.push(url);
      const path = decodeURIComponent(url.replace('/mugen/', ''));
      const text = url.startsWith('/engine/') ? 'fight' : files[path];
      return text === undefined
        ? { ok: false }
        : { ok: true, arrayBuffer: async () => new TextEncoder().encode(text).buffer };
    },
  });
  return { ...files_, fetched };
}

async function readAll(fs, path) {
  const handle = await call(fs, 'open', path, 0, 0);
  const { size } = await call(fs, 'fstat', handle);
  const buffer = new Uint8Array(size);
  const count = await call(fs, 'read', handle, buffer, 0, size, null);
  await call(fs, 'close', handle);
  return new TextDecoder().decode(buffer.subarray(0, count));
}

test('MUGEN browser file system resolves paths without case and fetches on first open', async () => {
  const { fs, fetched } = fileSystem({ 'Ryu/Ryu.DEF': '[Files]', 'Ryu/sprites/ryu.sff': 'SFF' });
  assert.equal(await readAll(fs, '/chars/ryu/ryu.def'), '[Files]');
  assert.equal(await readAll(fs, 'chars/RYU/Sprites/RYU.SFF'), 'SFF');
  assert.deepEqual(fetched, ['/mugen/Ryu/Ryu.DEF', '/mugen/Ryu/sprites/ryu.sff']);
  assert.equal(await readAll(fs, 'data/select.def'), '[Characters]\n');
  assert.deepEqual((await call(fs, 'readdir', 'chars')).sort(), ['Ryu']);
  assert.equal((await call(fs, 'stat', 'chars/ryu')).isDirectory(), true);
  await assert.rejects(call(fs, 'open', 'chars/ryu/missing.air', 0, 0), { code: 'ENOENT' });
});

test('MUGEN browser file system keeps the engine writes in memory', async () => {
  const files = fileSystem();
  const { fs } = files;
  await call(fs, 'mkdir', 'save/logs', 0o755);
  const handle = await call(fs, 'open', 'save/chaos-match.log', 0o100 | 1, 0o644);
  const bytes = new TextEncoder().encode('  ["WinSide"] => 1\n');
  assert.equal(await call(fs, 'write', handle, bytes, 0, bytes.length, null), bytes.length);
  await call(fs, 'close', handle);
  assert.equal(readWinSide(files.readText('save/chaos-match.log')), 1);
  assert.equal((await call(fs, 'stat', 'save/logs')).isDirectory(), true);
  assert.equal(normalizePath('/a/./b/../c\\d'), 'a/c/d');
});

test('MUGEN growing file buffers do not restore stale bytes after a file replacement', async () => {
  const { fs, writeText } = fileSystem();
  const handle = await call(fs, 'open', 'save/replay', 0o100 | 2, 0o644);
  await call(fs, 'write', handle, new Uint8Array([1, 2]), 0, 2, 0);
  writeText('save/replay', 'ab');
  await call(fs, 'write', handle, new Uint8Array([3, 4]), 0, 2, 2);
  const bytes = new Uint8Array(4);
  assert.equal(await call(fs, 'read', handle, bytes, 0, 4, 0), 4);
  assert.deepEqual([...bytes], [97, 98, 3, 4]);
  await call(fs, 'close', handle);
});

test('MUGEN reads the winner from the engine match log only when it is a side', () => {
  assert.equal(readWinSide('table: 0x1 {\n  ["WinSide"] => 0\n  ["Wins"] => table {\n'), 0);
  assert.equal(readWinSide('  ["WinSide"] => -1\n'), null);
  assert.equal(readWinSide('      ["WinSide"] => 1\n'), null, 'nested tables do not count');
  assert.equal(readWinSide(null), null);
});

test('MUGEN netplay bridge connects once both engines listen and splits the stream', () => {
  const sent = [];
  const timers = { setInterval: () => 1, clearInterval() {} };
  const host = createNetBridge({
    role: 'host',
    names: ['A', 'B'],
    send: (channel, bytes) => sent.push([channel, [...bytes]]),
    timers,
  });
  assert.equal(host.bridge.queueRole(), '');
  host.bridge.start('casual');
  assert.equal(host.bridge.queueRole(), 'host');
  assert.equal(host.bridge.connected(), false);
  assert.deepEqual(sent, [[CONTROL, [1]]]);
  host.receive(CONTROL, Uint8Array.of(1));
  assert.equal(host.bridge.connected(), true);
  assert.equal(host.bridge.queueNames(), 'A\nB');
  host.receive(STREAM, Uint8Array.of(1, 2, 3));
  assert.deepEqual([...host.bridge.read(2)], [1, 2]);
  assert.deepEqual([...host.bridge.read(8)], [3]);
  assert.equal(host.bridge.read(8).length, 0);
  host.receive(DATAGRAM, Uint8Array.of(9));
  assert.deepEqual([...host.bridge.readGGPO()], [9]);
  assert.equal(host.bridge.readGGPO().length, 0);
  assert.equal(host.bridge.send(Uint8Array.of(7)), true);
  host.bridge.sendGGPO(Uint8Array.of(8));
  assert.deepEqual(sent.slice(-2), [
    [STREAM, [7]],
    [DATAGRAM, [8]],
  ]);
  host.receive(CONTROL, Uint8Array.of(2));
  assert.equal(host.bridge.failed(), true);
  host.dispose();
  assert.equal(host.bridge.read(1), null);
  assert.equal(host.bridge.readGGPO(), null);
  assert.deepEqual(sent.at(-1), [CONTROL, [2]]);
});

test('MUGEN netplay bridge answers a peer that started first', () => {
  const sent = [];
  const guest = createNetBridge({
    role: 'guest',
    send: (channel, bytes) => sent.push([channel, [...bytes]]),
    timers: { setInterval: () => 1, clearInterval() {} },
  });
  guest.receive(CONTROL, Uint8Array.of(1));
  assert.equal(guest.bridge.connected(), false);
  guest.bridge.start('casual');
  assert.equal(guest.bridge.connected(), true);
  assert.deepEqual(sent, [[CONTROL, [1]]]);
});
