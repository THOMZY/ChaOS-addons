import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { Server } from 'socket.io';
import { createMugenRuntime } from '../server/runtime.js';
import { chatState } from '../../../server/chat/state.js';
import { updatePoints, loadUserSettings } from '../../../server/chat/backlog.js';
import { realtimePolicy, trackRealtimeSocket } from '../../../server/security/realtime-policy.js';
import { createAccount, createSession, SESSION_COOKIE } from '../../../server/auth/service.js';
import { db } from '../../../server/db/index.js';
import { connectSocketIo } from '../../../tests/helpers/socket-io-client.mjs';
import { gameClock } from '../../../tests/helpers/game-clock.mjs';
import { fakeCatalog } from './fixtures.js';

test(
  'MUGEN real sockets keep multi-tab funding, refund last departure and drain paid play',
  { timeout: 10000 },
  async (t) => {
    const clock = gameClock(),
      server = createServer(),
      io = new Server(server),
      ns = io.of('/chat'),
      clients = [];
    const runtime = createMugenRuntime({ catalog: fakeCatalog(), timers: clock.timers });
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
        email: `mugen-socket-${suffix}@example.test`,
        pseudo: `MUGEN Socket ${suffix}`,
        password: 'isolated-mugen-socket-password',
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
    anonymous.emit('mugen:create', { bet: 100 });
    assert.equal((await anonymous.waitFor('command:error')).code, 'authentication_required');
    const first = await connect(0),
      tab = await connect(0),
      opponent = await connect(1);
    first.emit('mugen:create', { bet: 100 });
    const waiting = await first.waitFor('mugen:created');
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
    host.emit('mugen:create', { bet: 100 });
    const { roomId } = await host.waitFor('mugen:created');
    opponent.emit('mugen:join', { roomId });
    await host.waitFor('mugen:joined');
    await opponent.waitFor('mugen:joined');
    host.emit('mugen:select_char', { roomId, character: 'kfm/kfm.def' });
    opponent.emit('mugen:select_char', { roomId, character: 'Ryu/wrapped/ryu.def' });
    assert.equal((await host.waitFor('mugen:start')).role, 'host');
    assert.equal((await opponent.waitFor('mugen:start')).role, 'guest');
    const spectator = await connect(2);
    host.emit('mugen:replay', { roomId, offset: 0, data: Buffer.from('IKRPLCFG') });
    spectator.emit('mugen:spectate', { roomId });
    await spectator.waitFor('mugen:spectate_start');
    assert.equal(runtime.status().replays, 0, 'JSON pretending to be binary is refused');
    // The test client speaks JSON only; binary relay is covered by runtime.test.js.
    host.emit('mugen:net', { roomId, channel: 1, data: [1, 2, 3] });
    const stop = runtime.stop();
    host.emit('mugen:create', { bet: 100 });
    assert.equal((await host.waitFor('mugen:error')).error, 'unavailable');
    host.emit('mugen:forfeit', { roomId });
    assert.equal((await opponent.waitFor('mugen:game_over')).payout, 200);
    await spectator.waitFor('mugen:game_over');
    await stop;
    assert.equal(loadUserSettings(principals[0].account.id).points, 800);
    assert.equal(loadUserSettings(principals[1].account.id).points, 1100);
    assert.equal(loadUserSettings(principals[2].account.id).points, 1000);
    assert.equal(runtime.status().activeListeners, 0);
    assert.equal(runtime.status().spectatorRooms, 0);
    assert.equal(runtime.status().replays, 0);
    assert.equal(clock.active.size, 0);
    host.emit('sibling:ping');
    assert.deepEqual(await host.waitFor('sibling:pong'), { ok: true });
    const late = await connect(0);
    assert.equal(ns.sockets.get(late.id).listenerCount('mugen:create'), 0);
  },
);

test(
  'MUGEN native selection, match and result timers drain and isolated child exits without forced signals',
  { timeout: 6000 },
  async () => {
    const source = `
    const { createMugenRuntime } = await import(process.argv[1]);
    const { EventEmitter } = await import('node:events');
    class Socket extends EventEmitter { emit(){return true;} receive(e,p){return super.emit(e,p);} }
    const users=new Map();
    for(const id of ['a','b'])users.set(id,{accountId:id,userId:id,pseudo:id,points:1000,clients:new Set([new Socket()])});
    const fighter={path:'kfm/kfm.def',name:'KFM'},stage={path:'dojo.def',name:'Dojo'};
    const catalog={characters:()=>[fighter],stages:()=>[stage],character:p=>p===fighter.path?fighter:null,stage:p=>p===stage.path?stage:null};
    const runtime=createMugenRuntime({catalog,users,wallet:{charge(id,n){users.get(id).points-=n;return true;},credit(id,n){users.get(id).points+=n;return true;}}});
    runtime.init(new EventEmitter());
    const sockets=[...users.values()].map(user=>{const socket=[...user.clients][0];runtime.wire(socket,{user,accountId:user.accountId});return socket;});
    sockets[0].receive('mugen:create',{bet:100});const room=[...runtime.fightMgr._rooms.values()][0];
    sockets[1].receive('mugen:join',{roomId:room.id});
    if(!room._timer||room.state!=='lobby')throw new Error('Missing native selection clock');
    for(const socket of sockets)socket.receive('mugen:select_char',{roomId:room.id,character:fighter.path});
    if(!room._timer||room.state!=='playing')throw new Error('Missing native match clock');
    sockets[0].receive('mugen:result',{roomId:room.id,winSide:1});
    if(!room._timer)throw new Error('Missing native result clock');
    const stop=runtime.stop();sockets[1].receive('mugen:result',{roomId:room.id,winSide:1});await stop;
    console.log(JSON.stringify({balances:[...users.values()].map(user=>user.points),stopped:runtime.status().stopped,
      timers:runtime.status().activeTimers,pending:runtime.status().pendingRooms,signals:process.listenerCount('SIGTERM')}));
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
      signals: 0,
    });
  },
);
