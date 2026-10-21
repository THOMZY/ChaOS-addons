import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { Server } from 'socket.io';
import { createSf2Runtime } from '../server/runtime.js';
import { chatState } from '../../../server/chat/state.js';
import { updatePoints, loadUserSettings } from '../../../server/chat/backlog.js';
import { realtimePolicy, trackRealtimeSocket } from '../../../server/security/realtime-policy.js';
import { createAccount, createSession, SESSION_COOKIE } from '../../../server/auth/service.js';
import { db } from '../../../server/db/index.js';
import { connectSocketIo } from '../../../tests/helpers/socket-io-client.mjs';
import { gameClock } from '../../../tests/helpers/game-clock.mjs';

test(
  'SF2 real sockets preserve multi-tab stakes, offline refunds, inputs and paid drain',
  { timeout: 10000 },
  async (t) => {
    const clock = gameClock(),
      server = createServer(),
      io = new Server(server),
      ns = io.of('/chat'),
      clients = [];
    const runtime = createSf2Runtime({ timers: clock.timers });
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
        email: `sf2-socket-${suffix}@example.test`,
        pseudo: `SF2 Socket ${suffix}`,
        password: 'isolated-sf2-socket-password',
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
    anonymous.emit('sf2:create', { bet: 100 });
    assert.equal((await anonymous.waitFor('command:error')).code, 'authentication_required');
    const first = await connect(0),
      tab = await connect(0),
      opponent = await connect(1);
    first.emit('sf2:create', { bet: 100 });
    const waiting = await first.waitFor('sf2:created');
    const firstGone = once(ns.sockets.get(first.id), 'disconnect');
    await first.close();
    await firstGone;
    assert.ok(runtime.sf2Mgr.getRoom(waiting.roomId));
    assert.equal(loadUserSettings(principals[0].account.id).points, 900);
    updatePoints(principals[0].account.id, 800, 456);
    const lastGone = once(ns.sockets.get(tab.id), 'disconnect');
    await tab.close();
    await lastGone;
    assert.equal(runtime.sf2Mgr.getRoom(waiting.roomId), null);
    assert.equal(loadUserSettings(principals[0].account.id).points, 900);
    assert.equal(loadUserSettings(principals[0].account.id).lastDailyBonus, 456);
    const host = await connect(0);
    host.emit('sf2:create', { bet: 100 });
    const { roomId } = await host.waitFor('sf2:created');
    opponent.emit('sf2:join', { roomId });
    assert.equal((await host.waitFor('sf2:start')).slot, 0);
    assert.equal((await opponent.waitFor('sf2:start')).slot, 1);
    host.emit('sf2:input', { roomId, input: { right: true } });
    assert.deepEqual(await opponent.waitFor('sf2:input'), { input: { right: true } });
    const outsider = await connect(2);
    outsider.emit('sf2:forfeit', { roomId });
    outsider.emit('sf2:input', { roomId, input: { punch: true } });
    outsider.emit('sibling:ping');
    await outsider.waitFor('sibling:pong');
    assert.ok(runtime.sf2Mgr.getRoom(roomId));
    assert.equal(loadUserSettings(principals[2].account.id).points, 1000);
    const stop = runtime.stop();
    host.emit('sf2:create', { bet: 100 });
    assert.equal((await host.waitFor('sf2:error')).error, 'unavailable');
    host.emit('sf2:round_end', { roomId, loserSlot: 1 });
    assert.deepEqual(await opponent.waitFor('sf2:next_round'), { round: 2, wins: [1, 0] });
    host.emit('sf2:round_end', { roomId, loserSlot: 1 });
    assert.equal((await opponent.waitFor('sf2:game_over')).payout, 200);
    await stop;
    assert.equal(loadUserSettings(principals[0].account.id).points, 1000);
    assert.equal(loadUserSettings(principals[1].account.id).points, 900);
    assert.equal(runtime.status().activeListeners, 0);
    assert.equal(clock.active.size, 0);
    host.emit('sibling:ping');
    assert.deepEqual(await host.waitFor('sibling:pong'), { ok: true });
    const late = await connect(0);
    assert.equal(ns.sockets.get(late.id).listenerCount('sf2:create'), 0);
  },
);

test(
  'SF2 native waiting and successive round clocks drain; child exits naturally without signals',
  { timeout: 6000 },
  async () => {
    const source = `
    const { createSf2Runtime } = await import(process.argv[1]);
    const { EventEmitter } = await import('node:events');
    class Socket extends EventEmitter { emit(){return true;} receive(e,p){return super.emit(e,p);} }
    const users=new Map();
    for(const id of ['a','b'])users.set(id,{accountId:id,userId:id,pseudo:id,points:1000,clients:new Set([new Socket()])});
    const runtime=createSf2Runtime({users,wallet:{charge(id,n){users.get(id).points-=n;return true;},credit(id,n){users.get(id).points+=n;return true;}}});
    runtime.init(new EventEmitter());
    const sockets=[...users.values()].map(user=>{const socket=[...user.clients][0];runtime.wire(socket,{user,accountId:user.accountId});return socket;});
    sockets[0].receive('sf2:create',{bet:100});const room=[...runtime.sf2Mgr._rooms.values()][0];
    if(!room._expireTimer||room.state!=='waiting')throw new Error('Missing native waiting clock');
    sockets[1].receive('sf2:join',{roomId:room.id});
    if(!room._timer||room._expireTimer||room.state!=='playing')throw new Error('Missing native round clock');
    const first=room._timer;sockets[0].receive('sf2:round_end',{roomId:room.id,loserSlot:1});
    if(!room._timer||room._timer===first||room.round!==2)throw new Error('Missing next native round clock');
    const stop=runtime.stop();sockets[0].receive('sf2:round_end',{roomId:room.id,loserSlot:1});await stop;
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
      balances: [1100, 900],
      stopped: true,
      timers: 0,
      pending: 0,
      signals: 0,
    });
  },
);
