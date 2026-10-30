import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { Server } from 'socket.io';
import { createWormsRuntime } from '../server/runtime.js';
import { chatState } from '../../../server/chat/state.js';
import { updatePoints, loadUserSettings } from '../../../server/chat/backlog.js';
import { realtimePolicy, trackRealtimeSocket } from '../../../server/security/realtime-policy.js';
import { createAccount, createSession, SESSION_COOKIE } from '../../../server/auth/service.js';
import { db } from '../../../server/db/index.js';
import { connectSocketIo } from '../../../tests/helpers/socket-io-client.mjs';
import { gameClock } from '../../../tests/helpers/game-clock.mjs';

test('worms real sockets keep multi-tab stakes, refund the last offline tab and drain a paid game without removing neighbors', { timeout: 10000 }, async t => {
  const clock = gameClock(), server = createServer(), io = new Server(server), ns = io.of('/chat'), clients = [];
  const runtime = createWormsRuntime({ timers: clock.timers, preload: () => Promise.resolve() }); runtime.init(ns); await runtime.ready(); ns.use(realtimePolicy());
  ns.on('connection', socket => {
    trackRealtimeSocket(socket);
    socket.on('sibling:ping', () => socket.emit('sibling:pong', { ok: true }));
    let accountId, user;
    if (!socket.data.spectator) {
      accountId = socket.data.account.id;
      ({ user } = chatState.registerSocket(socket, accountId, socket.data.clientIp, socket.data.account));
    }
    if (user) runtime.wire(socket, { user, accountId });
    socket.on('disconnect', () => {
      runtime.onSocketDisconnect(socket); const result = chatState.unregisterSocket(socket);
      if (result?.removed) runtime.onUserDisconnect(accountId);
    });
    socket.emit('hello', {});
  });
  t.after(async () => {
    await Promise.all(clients.map(client => client.close())); await runtime.stop();
    await new Promise(resolve => io.close(resolve)); db.close();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${server.address().port}`;
  const accounts = [];
  for (const suffix of ['a', 'b']) {
    const { account } = await createAccount({ email: `worms-socket-${suffix}@example.test`, pseudo: `Worms Socket ${suffix}`, password: 'isolated-worms-socket-password' });
    updatePoints(account.id, 1000, 123); accounts.push({ account, token: createSession(account.id) });
  }
  const connect = async index => {
    const client = await connectSocketIo(origin, index == null ? undefined : `${SESSION_COOKIE}=${accounts[index].token}`, { namespace: '/chat' });
    clients.push(client); await client.waitFor('hello'); return client;
  };
  const first = await connect(0), second = await connect(0), opponent = await connect(1);
  first.emit('worms:create', { bet: 100, maxPlayers: 8 }); const { roomId } = await first.waitFor('worms:created');
  opponent.emit('worms:join', { roomId }); await opponent.waitFor('worms:joined');
  const firstGone = once(ns.sockets.get(first.id), 'disconnect'); await first.close(); await firstGone;
  assert.equal(runtime.wormsMgr.getRoom(roomId).players.length, 2); assert.equal(loadUserSettings(accounts[0].account.id).points, 900);
  updatePoints(accounts[0].account.id, 800, 456);
  const secondGone = once(ns.sockets.get(second.id), 'disconnect'); await second.close(); await secondGone;
  assert.equal(chatState.users.has(accounts[0].account.id), false); assert.equal(runtime.wormsMgr.getRoom(roomId), null);
  assert.equal(loadUserSettings(accounts[0].account.id).points, 900); assert.equal(loadUserSettings(accounts[0].account.id).lastDailyBonus, 456);
  assert.equal(loadUserSettings(accounts[1].account.id).points, 1000);
  const host = await connect(0); host.emit('worms:create', { bet: 100, maxPlayers: 8 });
  const next = await host.waitFor('worms:created'); opponent.emit('worms:join', { roomId: next.roomId }); await opponent.waitFor('worms:joined');
  host.emit('worms:launch', { roomId: next.roomId }); await host.waitFor('worms:start');
  const anonymous = await connect(); anonymous.emit('worms:watch', { roomId: next.roomId });
  assert.equal((await anonymous.waitFor('command:error')).code, 'authentication_required');
  const spectator = await connect(0); spectator.emit('worms:watch', { roomId: next.roomId }); await spectator.waitFor('worms:spectate_start');
  assert.equal(runtime.status().spectatorRooms, 1);
  const spectatorGone = once(ns.sockets.get(spectator.id), 'disconnect'); await spectator.close(); await spectatorGone;
  assert.equal(runtime.status().spectatorRooms, 0);
  const stop = runtime.stop(); host.emit('worms:create', { bet: 100 }); assert.equal((await host.waitFor('worms:error')).error, 'unavailable');
  host.emit('worms:forfeit', { roomId: next.roomId }); await host.waitFor('worms:game_over'); await stop;
  assert.equal(loadUserSettings(accounts[0].account.id).points, 800); assert.equal(loadUserSettings(accounts[1].account.id).points, 1100);
  assert.equal(runtime.status().activeTimers, 0); assert.equal(runtime.status().activeListeners, 0); assert.equal(clock.active.size, 0);
  assert.equal(ns.sockets.get(host.id).listenerCount('worms:create'), 0);
  host.emit('sibling:ping'); assert.deepEqual(await host.waitFor('sibling:pong'), { ok: true });
  const late = await connect(0); assert.equal(ns.sockets.get(late.id).listenerCount('worms:create'), 0);
  assert.equal(chatState.users.get(accounts[0].account.id).points, 800);
});

test('worms native turn, fuse, impact and post timers drain and the isolated child exits naturally', { timeout: 6000 }, async () => {
  const source = `
    const { createWormsRuntime } = await import(process.argv[1]);
    const { EventEmitter } = await import('node:events');
    class Socket extends EventEmitter { emit() { return true; } receive(e, p) { return super.emit(e, p); } }
    const users = new Map();
    for (const id of ['a','b']) users.set(id, { accountId:id, userId:id, pseudo:id, points:1000, clients:new Set([new Socket()]) });
    const runtime = createWormsRuntime({ users, preload: () => Promise.resolve(), wallet: {
      charge(id, amount) { users.get(id).points -= amount; return true; }, credit(id, amount) { users.get(id).points += amount; return true; } } });
    runtime.init(new EventEmitter()); await runtime.ready();
    const sockets = [...users.values()].map(user => { const socket = [...user.clients][0]; runtime.wire(socket, { user, accountId:user.accountId }); return socket; });
    sockets[0].receive('worms:create', { bet:100, maxPlayers:8 }); const room = [...runtime.wormsMgr._rooms.values()][0];
    sockets[1].receive('worms:join', { roomId:room.id }); sockets[0].receive('worms:launch', { roomId:room.id });
    room.terrain = new Array(960).fill(320); room.mask = null; room.holes = [];
    const active = room.worms.find(w => w.id === room.activeWormId); active.cx = 120; active.cy = 309;
    room.worms.filter(w => w !== active).forEach((w, i) => { w.cx = 700 + i * 20; w.cy = 309; });
    sockets[0].receive('worms:fire', { roomId:room.id, weapon:'dynamite', angle:0, power:0.5 });
    if (room._dynTimers?.size !== 1 || room._wireTimers?.size !== 2) throw new Error('Missing native jobs');
    sockets[0].receive('worms:forfeit', { roomId:room.id }); await runtime.stop();
    console.log(JSON.stringify({ balances:[...users.values()].map(user => user.points), stopped:runtime.status().stopped,
      timers:runtime.status().activeTimers, pending:runtime.status().pendingRooms, signals:process.listenerCount('SIGTERM') }));
  `;
  const { stdout } = await promisify(execFile)(process.execPath,
    ['--import', new URL('../../../tests/helpers/isolated-env.mjs', import.meta.url).href, '--input-type=module', '-e', source,
      new URL('../server/runtime.js', import.meta.url).href], { timeout: 4500, windowsHide: true });
  assert.deepEqual(JSON.parse(stdout), { balances: [900, 1100], stopped: true, timers: 0, pending: 0, signals: 0 });
});
