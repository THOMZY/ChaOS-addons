import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { Server } from 'socket.io';
import { createFightingRuntime } from '../server/runtime.js';
import { chatState } from '../../../server/chat/state.js';
import { updatePoints, loadUserSettings } from '../../../server/chat/backlog.js';
import { realtimePolicy, trackRealtimeSocket } from '../../../server/security/realtime-policy.js';
import { createAccount, createSession, SESSION_COOKIE } from '../../../server/auth/service.js';
import { db } from '../../../server/db/index.js';
import { connectSocketIo } from '../../../tests/helpers/socket-io-client.mjs';
import { gameClock } from '../../../tests/helpers/game-clock.mjs';

test(
  'Fighting real sockets keep multi-tab funding, refund last departure and drain paid play separately from Sandbox',
  { timeout: 10000 },
  async (t) => {
    const clock = gameClock(),
      server = createServer(),
      io = new Server(server),
      ns = io.of('/chat'),
      clients = [];
    const runtime = createFightingRuntime({ timers: clock.timers });
    runtime.init(ns);
    ns.use(realtimePolicy());
    ns.on('connection', (socket) => {
      trackRealtimeSocket(socket);
      socket.on('sibling:ping', () => socket.emit('sibling:pong', { ok: true }));
      if (!socket.data.spectator) {
        const accountId = socket.data.account.id;
        const { user } = chatState.registerSocket(
          socket,
          accountId,
          socket.data.clientIp,
          socket.data.account,
        );
        runtime.wire(socket, { user, accountId });
        socket.on('disconnect', () => {
          runtime.onSocketDisconnect(socket);
          const result = chatState.unregisterSocket(socket);
          if (result?.removed) runtime.onUserDisconnect(accountId);
        });
      }
      socket.emit('hello', {});
    });
    t.after(async () => {
      await Promise.all(clients.map((client) => client.close()));
      await runtime.stop();
      await new Promise((resolve) => io.close(resolve));
      db.close();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const principals = [];
    for (const suffix of ['a', 'b', 'c']) {
      const { account } = await createAccount({
        email: `fighting-socket-${suffix}@example.test`,
        pseudo: `Fighting Socket ${suffix}`,
        password: 'isolated-fighting-socket-password',
      });
      updatePoints(account.id, 1000, 123);
      principals.push({ account, token: createSession(account.id) });
    }
    const connect = async (index) => {
      const client = await connectSocketIo(
        origin,
        index == null ? undefined : `${SESSION_COOKIE}=${principals[index].token}`,
        { namespace: '/chat' },
      );
      clients.push(client);
      await client.waitFor('hello');
      return client;
    };
    const anonymous = await connect();
    anonymous.emit('fighting:create', { bet: 100 });
    assert.equal((await anonymous.waitFor('command:error')).code, 'authentication_required');
    const first = await connect(0),
      tab = await connect(0),
      opponent = await connect(1);
    first.emit('fighting:create', { bet: 100 });
    const waiting = await first.waitFor('fighting:created');
    const firstGone = once(ns.sockets.get(first.id), 'disconnect');
    await first.close();
    await firstGone;
    assert.ok(runtime.fightMgr.getRoom(waiting.roomId));
    assert.equal(loadUserSettings(principals[0].account.id).points, 900);
    updatePoints(principals[0].account.id, 800, 456);
    const lastGone = once(ns.sockets.get(tab.id), 'disconnect');
    await tab.close();
    await lastGone;
    assert.equal(runtime.fightMgr.getRoom(waiting.roomId), null);
    assert.equal(loadUserSettings(principals[0].account.id).points, 900);
    assert.equal(loadUserSettings(principals[0].account.id).lastDailyBonus, 456);
    const host = await connect(0);
    host.emit('fighting:create', { bet: 100 });
    const { roomId } = await host.waitFor('fighting:created');
    opponent.emit('fighting:join', { roomId });
    await host.waitFor('fighting:joined');
    await opponent.waitFor('fighting:joined');
    host.emit('fighting:select_char', { roomId, char: 'Synthetic A' });
    opponent.emit('fighting:select_char', { roomId, char: 'Synthetic B' });
    await host.waitFor('fighting:start');
    await opponent.waitFor('fighting:start');
    host.emit('fighting:ready', { roomId });
    opponent.emit('fighting:ready', { roomId });
    await host.waitFor('fighting:begin');
    await opponent.waitFor('fighting:begin');
    const spectator = await connect(2);
    spectator.emit('fighting:spectate', { roomId });
    await spectator.waitFor('fighting:spectate_start');
    host.emit('fighting:input', { roomId, input: { right: true } });
    assert.equal((await spectator.waitFor('fighting:input')).slot, 0);
    host.emit('sandbox:join', { char: 'Free' });
    await host.waitFor('sandbox:state');
    assert.equal(runtime.sbMgr.getCount(), 1);
    const stop = runtime.stop();
    assert.equal(runtime.status().sandbox.stopped, true);
    assert.equal(runtime.sbMgr.getCount(), 0);
    assert.equal(ns.sockets.get(host.id).listenerCount('sandbox:join'), 0);
    host.emit('fighting:create', { bet: 100 });
    assert.equal((await host.waitFor('fighting:error')).error, 'unavailable');
    host.emit('fighting:forfeit', { roomId });
    assert.equal((await opponent.waitFor('fighting:game_over')).payout, 200);
    await spectator.waitFor('fighting:game_over');
    await stop;
    assert.equal(loadUserSettings(principals[0].account.id).points, 800);
    assert.equal(loadUserSettings(principals[1].account.id).points, 1100);
    assert.equal(loadUserSettings(principals[2].account.id).points, 1000);
    assert.equal(runtime.status().activeListeners, 0);
    assert.equal(runtime.status().spectatorRooms, 0);
    assert.equal(clock.active.size, 0);
    host.emit('sibling:ping');
    assert.deepEqual(await host.waitFor('sibling:pong'), { ok: true });
    const late = await connect(0);
    assert.equal(ns.sockets.get(late.id).listenerCount('fighting:create'), 0);
    assert.equal(ns.sockets.get(late.id).listenerCount('sandbox:join'), 0);
  },
);

test(
  'Fighting native loading/round/ready timers drain and isolated child exits without forced signals',
  { timeout: 6000 },
  async () => {
    const source = `
    const { createFightingRuntime } = await import(process.argv[1]);
    const { EventEmitter } = await import('node:events');
    class Socket extends EventEmitter { broadcast={emit(){}}; emit(){return true;} receive(e,p){return super.emit(e,p);} }
    const users=new Map();
    for(const id of ['a','b'])users.set(id,{accountId:id,userId:id,pseudo:id,points:1000,clients:new Set([new Socket()])});
    const runtime=createFightingRuntime({users,wallet:{charge(id,n){users.get(id).points-=n;return true;},credit(id,n){users.get(id).points+=n;return true;}}});
    runtime.init(new EventEmitter());
    const sockets=[...users.values()].map(user=>{const socket=[...user.clients][0];runtime.wire(socket,{user,accountId:user.accountId});return socket;});
    sockets[0].receive('fighting:create',{bet:100});const room=[...runtime.fightMgr._rooms.values()][0];
    sockets[1].receive('fighting:join',{roomId:room.id});
    for(const socket of sockets)socket.receive('fighting:select_char',{roomId:room.id,char:'Synthetic'});
    if(!room._readyTimer||room.state!=='loading')throw new Error('Missing native loading clock');
    for(const socket of sockets)socket.receive('fighting:ready',{roomId:room.id});
    if(!room._timer||room.state!=='playing')throw new Error('Missing native round clock');
    sockets[0].receive('fighting:hit',{roomId:room.id,targetSlot:1,damage:100});
    if(!room._readyTimer||room.round!==2)throw new Error('Missing native inter-round clock');
    for(const socket of sockets)socket.receive('fighting:ready',{roomId:room.id});
    sockets[0].receive('sandbox:join',{char:'Free'});
    const stop=runtime.stop();sockets[0].receive('fighting:forfeit',{roomId:room.id});await stop;
    console.log(JSON.stringify({balances:[...users.values()].map(user=>user.points),stopped:runtime.status().stopped,
      timers:runtime.status().activeTimers,pending:runtime.status().pendingRooms,free:runtime.sbMgr.getCount(),signals:process.listenerCount('SIGTERM')}));
  `;
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        '--import',
        new URL('../../../tests/helpers/isolated-env.mjs', import.meta.url).href,
        '--input-type=module',
        '-e',
        source,
        new URL('../server/runtime.js', import.meta.url).href,
      ],
      { timeout: 4500, windowsHide: true },
    );
    assert.deepEqual(JSON.parse(stdout), {
      balances: [900, 1100],
      stopped: true,
      timers: 0,
      pending: 0,
      free: 0,
      signals: 0,
    });
  },
);
