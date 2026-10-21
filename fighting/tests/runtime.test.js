import { createPointsStore } from '../../../server/chat/points-store.js';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test, { after } from 'node:test';
import { createAccount } from '../../../server/auth/service.js';
import { db } from '../../../server/db/index.js';
import { loadUserSettings, updatePoints } from '../../../server/chat/backlog.js';
import { User } from '../../../server/chat/user.js';
import { createCasinoWallet } from '../../../games/platform/casino-wallet.js';
import { createFightingRuntime } from '../server/runtime.js';
import { createSandboxRuntime } from '../server/sandbox-runtime.js';
import { gameClock } from '../../../tests/helpers/game-clock.mjs';

let sequence = 0;
class Socket extends EventEmitter {
  sent = [];
  broadcasted = [];
  broadcast = { emit: (event, data) => this.broadcasted.push({ event, data }) };
  emit(event, data) {
    this.sent.push({ event, data });
    return true;
  }
  receive(event, data) {
    return super.emit(event, data);
  }
  latest(event) {
    return this.sent.findLast((item) => item.event === event)?.data;
  }
}
after(() => db.close());
async function fixture(t, options = {}) {
  const clock = gameClock(),
    users = new Map(),
    players = [],
    ns = new Socket();
  let now = 1000;
  const wallet = createCasinoWallet({
    users,
    change: createPointsStore({ db }).change,
    codePrefix: 'FIGHTING',
  });
  const runtime = createFightingRuntime({
    users,
    wallet,
    timers: clock.timers,
    now: () => now,
    report() {},
    ...options.runtime,
  });
  runtime.init(ns);
  for (let i = 0; i < (options.count ?? 2); i++) {
    const unique = ++sequence;
    const { account } = await createAccount({
      email: `fight-runtime-${unique}@example.test`,
      pseudo: `Fight Runtime ${unique}`,
      password: 'isolated-fighting-test-password',
    });
    const user = new User(account.id, { pseudo: account.pseudo }),
      socket = new Socket();
    user.points = 1000;
    user.clients.add(socket);
    users.set(account.id, user);
    updatePoints(account.id, 1000, 123);
    runtime.wire(socket, { user, accountId: account.id });
    players.push({ account, user, socket });
  }
  t.after(async () => {
    if (options.failedStop) {
      await assert.rejects(runtime.stop());
      clock.active.clear();
    } else {
      for (const room of [...runtime.fightMgr._rooms.values()])
        runtime.onUserDisconnect(room.players[0].accountId);
      await runtime.stop();
      assert.equal(clock.active.size, 0);
    }
  });
  return {
    ...clock,
    runtime,
    users,
    wallet,
    players,
    ns,
    manager: runtime.fightMgr,
    advance(ms) {
      now += ms;
    },
    create(bet = 100, index = 0) {
      players[index].socket.receive('fighting:create', { bet });
      return runtime.fightMgr.getRoom(players[index].socket.latest('fighting:created')?.roomId);
    },
    join(room, index = 1) {
      players[index].socket.receive('fighting:join', { roomId: room.id });
    },
    select(room) {
      for (const player of players.slice(0, 2))
        player.socket.receive('fighting:select_char', {
          roomId: room.id,
          char: player.user.pseudo,
          defFile: 'char.def',
        });
    },
    ready(room) {
      for (const player of players.slice(0, 2))
        player.socket.receive('fighting:ready', { roomId: room.id });
    },
    forfeit(room, index = 0) {
      players[index].socket.receive('fighting:forfeit', { roomId: room.id });
    },
    hit(room) {
      players[0].socket.receive('fighting:hit', {
        roomId: room.id,
        targetSlot: 1,
        attackerX: 0,
        targetX: 50,
        damage: 100,
      });
    },
    saved() {
      return players.map((player) => loadUserSettings(player.account.id)?.points);
    },
  };
}
test('Fighting invalid, insufficient and scheduler-refused creates never debit', async (t) => {
  const value = await fixture(t),
    changes = db.prepare('SELECT total_changes() AS n').get().n;
  for (const bet of [NaN, Infinity, -1, Number.MAX_SAFE_INTEGER, {}]) {
    value.create(bet);
    assert.equal(value.manager._rooms.size, 0);
  }
  value.create(1001);
  value.failNext();
  value.create();
  assert.deepEqual(value.saved(), [1000, 1000]);
  assert.equal(db.prepare('SELECT total_changes() AS n').get().n, changes);
  assert.equal(value.players[0].socket.latest('fighting:error').error, 'timer_unavailable');
});
test('Fighting duplicate/concurrent admission cannot spend or refund a second stake', async (t) => {
  const value = await fixture(t, { count: 3 }),
    room = value.create();
  value.join(room);
  const other = value.create(100, 2);
  const changes = db.prepare('SELECT total_changes() AS n').get().n;
  value.create();
  value.join(room);
  value.join(other, 0);
  assert.deepEqual(value.saved(), [900, 900, 900]);
  assert.equal(db.prepare('SELECT total_changes() AS n').get().n, changes);
});
test('Fighting lobby timer refusal precedes join debit; insufficient join removes only that entrant', async (t) => {
  const value = await fixture(t),
    room = value.create();
  value.failNext();
  value.join(room);
  assert.deepEqual(value.saved(), [900, 1000]);
  assert.equal(room.players.length, 1);
  assert.equal(room.state, 'waiting');
  value.players[1].user.points = 50;
  updatePoints(value.players[1].account.id, 50, 123);
  value.join(room);
  assert.deepEqual(value.saved(), [900, 50]);
  assert.equal(room.players.length, 1);
  assert.equal(value.active.size, 1);
});
test('Fighting uncertain join is retained, cannot select/start and cannot be automatically refunded', async (t) => {
  let value,
    calls = 0;
  value = await fixture(t, {
    failedStop: true,
    runtime: {
      wallet: {
        charge(...args) {
          calls++;
          const result = value.wallet.charge(...args);
          if (calls === 2) throw new Error('private');
          return result;
        },
        credit: (...args) => value.wallet.credit(...args),
      },
    },
  });
  const room = value.create();
  value.join(room);
  value.select(room);
  value.ready(room);
  value.fire(room._expireTimer);
  assert.deepEqual(value.saved(), [900, 900]);
  assert.equal(calls, 2);
  assert.equal(value.runtime.status().uncertainRooms, 1);
  assert.equal(value.players[0].socket.latest('fighting:start'), undefined);
  assert.equal(value.runtime.status().failureCode, 'FIGHTING_CHARGE_FAILED');
});
test('Fighting async wallet rejection is observed without creating a free paid room', async (t) => {
  const value = await fixture(t, {
    failedStop: true,
    runtime: { wallet: { charge: () => Promise.reject(new Error('private')), credit: () => true } },
  });
  value.create();
  await Promise.resolve();
  assert.equal(value.runtime.status().uncertainRooms, 1);
  assert.deepEqual(value.saved(), [1000, 1000]);
});
test('Fighting actual lobby expiry refunds all offline participants on latest SQLite once', async (t) => {
  const value = await fixture(t),
    room = value.create();
  value.join(room);
  const expiry = room._timer;
  for (const player of value.players) {
    value.users.delete(player.account.id);
    updatePoints(player.account.id, 800, 456);
  }
  value.fire(expiry);
  value.fire(expiry);
  assert.deepEqual(value.saved(), [900, 900]);
  assert.equal(value.runtime.status().pendingRooms, 0);
  assert.ok(
    value.players.every((player) => loadUserSettings(player.account.id).lastDailyBonus === 456),
  );
});
test('Fighting old waiting/lobby expiry callbacks and notifications cannot refund a loaded game', async (t) => {
  const value = await fixture(t),
    room = value.create(),
    wait = room._expireTimer;
  value.join(room);
  const lobby = room._timer;
  value.select(room);
  value.ready(room);
  value.fire(wait);
  value.fire(lobby);
  value.manager.emit('room:expired', { roomId: room.id });
  assert.equal(room.state, 'playing');
  assert.deepEqual(value.saved(), [900, 900]);
  assert.equal(value.runtime.status().failed, false);
});
test('Fighting ready synchronization and force-begin fallbacks preserve the sixty-second round', async (t) => {
  const value = await fixture(t),
    room = value.create();
  value.join(room);
  value.select(room);
  const loading = room._readyTimer;
  assert.equal(room.state, 'loading');
  assert.equal(loading.delay, 30000);
  value.players[0].socket.receive('fighting:ready', { roomId: room.id });
  assert.equal(room.state, 'loading');
  value.players[1].socket.receive('fighting:ready', { roomId: room.id });
  const timer = room._timer;
  assert.equal(timer.delay, 60000);
  value.fire(loading);
  assert.strictEqual(room._timer, timer);
  value.fire(timer);
  const next = room._readyTimer;
  assert.equal(next.delay, 15000);
  assert.equal(room.round, 2);
  value.fire(next);
  assert.equal(room._roundReadySlots, null);
  assert.equal(room._timer.delay, 60000);
  assert.equal(
    value.players[0].socket.sent.filter((item) => item.event === 'fighting:begin').length,
    2,
  );
});
test('Fighting two confirmed rounds pay the offline winner once and remove all timers', async (t) => {
  const value = await fixture(t),
    room = value.create();
  value.join(room);
  value.select(room);
  value.ready(room);
  value.hit(room);
  assert.equal(room.round, 2);
  assert.deepEqual(room.wins, [1, 0]);
  value.ready(room);
  value.advance(301);
  const winner = value.players[0].account.id;
  value.users.delete(winner);
  updatePoints(winner, 800, 456);
  value.hit(room);
  value.hit(room);
  assert.deepEqual(value.saved(), [1000, 900]);
  assert.equal(loadUserSettings(winner).lastDailyBonus, 456);
  assert.equal(value.manager.getRoom(room.id), null);
  assert.equal(value.active.size, 0);
  assert.deepEqual(value.players[1].socket.latest('fighting:game_over').wins, [2, 0]);
});
test('Fighting does not accept duplicate/invalid round reports during inter-round readiness', async (t) => {
  const value = await fixture(t),
    room = value.create();
  value.join(room);
  value.select(room);
  value.ready(room);
  value.players[0].socket.receive('fighting:round_end', { roomId: room.id, loserSlot: NaN });
  assert.deepEqual(room.wins, [0, 0]);
  value.hit(room);
  const fallback = room._readyTimer;
  value.players[0].socket.receive('fighting:round_end', { roomId: room.id, loserSlot: 1 });
  value.hit(room);
  assert.deepEqual(room.wins, [1, 0]);
  assert.strictEqual(room._readyTimer, fallback);
  assert.equal(value.runtime.status().failed, false);
});
test('Fighting health arbitration rejects nonfinite values, invalid targets and out-of-range hits', async (t) => {
  const value = await fixture(t),
    room = value.create();
  value.join(room);
  value.select(room);
  value.ready(room);
  const id = value.players[0].account.id;
  assert.equal(value.manager.reportHit(id, room.id, 1, NaN, 0, 10).ok, false);
  assert.equal(value.manager.reportHit(id, room.id, 1, 0, 300, 10).ok, false);
  assert.equal(value.manager.reportHit(id, room.id, 0, 0, 0, 10).ok, false);
  assert.equal(value.manager.reportHit(id, room.id, 1, 0, 20, NaN).ok, false);
  assert.equal(value.manager.reportHit(id, room.id, 1, 0, 20, 10).ok, true);
  assert.equal(value.manager.reportHit(id, room.id, 1, 0, 20, 10).ok, false);
  assert.deepEqual(room.health, [100, 90]);
});
test('Fighting forfeit during loading cancels its ready callback and pays only one pot', async (t) => {
  const value = await fixture(t),
    room = value.create();
  value.join(room);
  value.select(room);
  const loading = room._readyTimer;
  value.forfeit(room);
  value.fire(loading);
  value.forfeit(room);
  assert.equal(value.manager.getRoom(room.id), null);
  assert.deepEqual(value.saved(), [900, 1100]);
  assert.equal(value.active.size, 0);
  assert.equal(
    value.players[0].socket.latest('fighting:forfeit').winner.userId,
    value.players[1].user.userId,
  );
});
test('Fighting old round/fallback callbacks cannot score or restart a later round', async (t) => {
  const value = await fixture(t),
    room = value.create();
  value.join(room);
  value.select(room);
  value.ready(room);
  const timer = room._timer;
  value.hit(room);
  const fallback = room._readyTimer;
  value.ready(room);
  const current = room._timer;
  value.fire(timer);
  value.fire(fallback);
  assert.strictEqual(room._timer, current);
  assert.deepEqual(room.wins, [1, 0]);
});
test('Fighting loading clock allocation failure retains paid lobby and a failed drain', async (t) => {
  const value = await fixture(t, { failedStop: true }),
    room = value.create();
  value.join(room);
  value.failNext();
  value.select(room);
  assert.equal(room.state, 'lobby');
  assert.deepEqual(value.saved(), [900, 900]);
  assert.equal(value.runtime.status().failed, true);
  value.fire(room._timer);
  assert.deepEqual(value.saved(), [1000, 1000]);
});
test('Fighting failed payout remains visible after deletion without publishing success or replay', async (t) => {
  let value,
    credits = 0;
  value = await fixture(t, {
    failedStop: true,
    runtime: {
      wallet: {
        charge: (...args) => value.wallet.charge(...args),
        credit(...args) {
          credits++;
          value.wallet.credit(...args);
          throw new Error('private');
        },
      },
    },
  });
  const room = value.create();
  value.join(room);
  value.select(room);
  value.forfeit(room);
  value.forfeit(room);
  assert.equal(value.manager.getRoom(room.id), null);
  assert.deepEqual(value.saved(), [900, 1100]);
  assert.equal(credits, 1);
  assert.equal(value.runtime.status().failureCode, 'FIGHTING_PAYOUT_FAILED');
  assert.equal(value.runtime.status().pendingRooms, 1);
  assert.equal(value.players[1].socket.latest('fighting:game_over'), undefined);
  assert.equal(value.players[1].socket.latest('fighting:forfeit'), undefined);
});
test('Fighting failed refund remains an obligation after waiting room deletion', async (t) => {
  let value,
    credits = 0;
  value = await fixture(t, {
    failedStop: true,
    runtime: {
      wallet: {
        charge: (...args) => value.wallet.charge(...args),
        credit() {
          credits++;
          return false;
        },
      },
    },
  });
  const room = value.create(),
    expiry = room._expireTimer;
  value.fire(expiry);
  value.fire(expiry);
  assert.deepEqual(value.saved(), [900, 1000]);
  assert.equal(credits, 1);
  assert.equal(value.runtime.status().uncertainRooms, 1);
});
test('Fighting deleted winner account is not recreated by settlement', async (t) => {
  const value = await fixture(t, { failedStop: true }),
    room = value.create();
  value.join(room);
  value.select(room);
  const id = value.players[1].account.id;
  value.users.delete(id);
  db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
  value.forfeit(room);
  assert.equal(db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(id), undefined);
  assert.equal(value.runtime.status().failureCode, 'FIGHTING_PAYOUT_FAILED');
});
test('Fighting spectator cleanup and owned socket disposal preserve neighboring handlers', async (t) => {
  const value = await fixture(t, { count: 3 }),
    room = value.create();
  value.join(room);
  value.select(room);
  value.ready(room);
  const socket = value.players[2].socket;
  socket.receive('fighting:spectate', { roomId: room.id });
  assert.equal(value.runtime.status().spectatorRooms, 1);
  const copied = socket.listeners('fighting:create')[0];
  let neighbors = 0;
  socket.on('fighting:create', () => neighbors++);
  value.runtime.onSocketDisconnect(socket);
  copied({ bet: 100 });
  socket.receive('fighting:create', { bet: 100 });
  assert.equal(neighbors, 1);
  assert.equal(value.runtime.status().spectatorRooms, 0);
  assert.deepEqual(value.saved(), [900, 900, 1000]);
});
test('Fighting stop closes admissions, stops free Sandbox immediately, but lets a paid duel finish', async (t) => {
  const value = await fixture(t),
    room = value.create();
  value.join(room);
  value.players[0].socket.receive('sandbox:join', { char: 'free' });
  const stop = value.runtime.stop();
  assert.strictEqual(value.runtime.stop(), stop);
  assert.equal(value.runtime.status().sandbox.stopped, true);
  assert.equal(value.runtime.sbMgr.getCount(), 0);
  assert.equal(value.players[0].socket.listenerCount('sandbox:join'), 0);
  value.select(room);
  value.ready(room);
  value.forfeit(room);
  await stop;
  assert.deepEqual(value.saved(), [900, 1100]);
  assert.equal(value.runtime.status().activeTimers, 0);
  assert.equal(value.runtime.status().activeListeners, 0);
});
test('Fighting timeout stays rejected while normal waiting expiry can still refund later', async (t) => {
  const value = await fixture(t, { failedStop: true }),
    room = value.create(),
    expiry = room._expireTimer;
  const stop = value.runtime.stop(),
    rejected = assert.rejects(stop, { code: 'FIGHTING_DRAIN_TIMEOUT' });
  value.fire([...value.active].find((handle) => handle.delay === 5000));
  await rejected;
  assert.deepEqual(value.saved(), [900, 1000]);
  value.fire(expiry);
  assert.deepEqual(value.saved(), [1000, 1000]);
  assert.equal(value.runtime.status().stopped, true);
  assert.equal(value.active.size, 0);
});
test('Fighting stopping during a failed payment still releases the unrelated free Sandbox', async (t) => {
  const value = await fixture(t, {
      failedStop: true,
      runtime: { wallet: { charge: () => true, credit: () => false } },
    }),
    room = value.create();
  value.join(room);
  value.select(room);
  value.players[0].socket.receive('sandbox:join', { char: 'free' });
  value.forfeit(room);
  await assert.rejects(value.runtime.stop());
  assert.equal(value.runtime.status().sandbox.stopped, true);
  assert.equal(value.runtime.sbMgr.getCount(), 0);
});
test('Fighting init/wiring are idempotent and independent instances do not share state or balances', async (t) => {
  const first = await fixture(t),
    second = await fixture(t),
    room = first.create();
  second.create();
  first.runtime.init(first.ns);
  first.runtime.wire(first.players[0].socket, {
    user: first.players[0].user,
    accountId: first.players[0].account.id,
  });
  assert.equal(first.players[0].socket.listenerCount('fighting:create'), 1);
  assert.equal(first.players[0].socket.listenerCount('sandbox:join'), 1);
  assert.throws(() => first.runtime.init(new Socket()), /ALREADY_INITIALIZED/);
  const handles = [...second.active];
  first.forfeit(room);
  await first.runtime.stop();
  assert.deepEqual([...second.active], handles);
  assert.deepEqual(second.saved(), [900, 1000]);
});
test('Sandbox free join/rejoin, input, hit, character and stage remain independent of duel funding', async (t) => {
  const value = await fixture(t),
    [first, second] = value.players;
  for (const player of value.players)
    player.socket.receive('sandbox:join', { char: 'free', defFile: 'free.def' });
  first.socket.receive('sandbox:join', { char: 'ignored' });
  assert.equal(value.runtime.sbMgr.getCount(), 2);
  first.socket.receive('sandbox:input', {
    input: { right: true },
    x: 10,
    y: 20,
    stateId: 'walking',
  });
  first.socket.receive('sandbox:hit', { targetSlot: second.socket.latest('sandbox:state').mySlot });
  assert.equal(second.socket.latest('sandbox:hit').fromSlot, 0);
  first.socket.receive('sandbox:change_char', { char: 'changed' });
  first.socket.receive('sandbox:change_stage', { stage: { folder: 'stage', defFile: 3 } });
  assert.equal(value.runtime.sbMgr.getPlayer(first.account.id).lastX, 10);
  assert.equal(value.runtime.sbMgr.getState().stage.defFile, '');
  assert.deepEqual(value.saved(), [1000, 1000]);
  first.socket.receive('sandbox:leave');
  assert.equal(value.runtime.sbMgr.getCount(), 1);
});
test('Sandbox owns only its handlers and stopped copied mutations cannot rejoin or alter a neighbor', async () => {
  const user = { userId: 'a', pseudo: 'A' },
    socket = new Socket(),
    ns = new Socket(),
    users = new Map([['a', { ...user, clients: new Set([socket]) }]]);
  const sandbox = createSandboxRuntime({ users });
  sandbox.init(ns);
  sandbox.wire(socket, { user, accountId: 'a' });
  const copied = socket.listeners('sandbox:join')[0];
  socket.receive('sandbox:join', { char: 'free' });
  let neighbor = 0;
  socket.on('sandbox:join', () => neighbor++);
  await sandbox.stop();
  copied({ char: 'late' });
  socket.receive('sandbox:join', { char: 'late' });
  assert.equal(sandbox.sbMgr.getCount(), 0);
  assert.equal(neighbor, 1);
  assert.equal(sandbox.status().activeListeners, 0);
});
test('Fighting composite stop before init is final and does not acquire a native resource', async () => {
  const clock = gameClock(),
    runtime = createFightingRuntime({ timers: clock.timers });
  assert.throws(() => runtime.wire(new Socket(), {}), /NOT_INITIALIZED/);
  const stop = runtime.stop();
  assert.strictEqual(runtime.stop(), stop);
  await stop;
  assert.equal(runtime.init(new Socket()), false);
  assert.equal(runtime.wire(new Socket(), {}), false);
  assert.equal(runtime.status().sandbox.stopped, true);
  assert.equal(clock.active.size, 0);
});
test('Fighting initial loading fallback starts normally without losing the paid roster', async (t) => {
  const value = await fixture(t),
    room = value.create();
  value.join(room);
  value.select(room);
  value.fire(room._readyTimer);
  assert.equal(room.state, 'playing');
  assert.equal(room._timer.delay, 60000);
  assert.ok(value.players[0].socket.latest('fighting:begin'));
  assert.deepEqual(value.saved(), [900, 900]);
});
test('Fighting stop requested within a confirmed credit waits for the entire paid publication', async (t) => {
  let value, stop;
  value = await fixture(t, {
    runtime: {
      wallet: {
        charge: (...args) => value.wallet.charge(...args),
        credit(...args) {
          const result = value.wallet.credit(...args);
          stop = value.runtime.stop();
          assert.equal(value.runtime.status().stopped, false);
          return result;
        },
      },
    },
  });
  const room = value.create();
  value.join(room);
  value.select(room);
  value.forfeit(room);
  await stop;
  assert.deepEqual(value.saved(), [900, 1100]);
  assert.equal(value.runtime.status().pendingResults, 0);
  assert.equal(value.players[1].socket.latest('fighting:game_over').payout, 200);
  assert.equal(value.active.size, 0);
});
test('Fighting composite status exposes a Sandbox cleanup refusal rather than a green stop', async () => {
  const runtime = createFightingRuntime({ report() {} }),
    socket = new Socket(),
    user = { userId: 'a', pseudo: 'A' };
  runtime.init(new Socket());
  runtime.wire(socket, { user, accountId: 'a' });
  const original = socket.off.bind(socket);
  socket.off = (event, handler) => {
    if (event === 'sandbox:join') throw new Error('private cleanup');
    return original(event, handler);
  };
  await assert.rejects(runtime.stop(), { code: 'SANDBOX_CLEANUP_FAILED' });
  assert.equal(runtime.status().failed, true);
  assert.equal(runtime.status().failureCode, 'SANDBOX_CLEANUP_FAILED');
  assert.equal(runtime.status().activeListeners, 1);
  assert.equal(runtime.status().sandbox.activeListeners, 1);
  // Only the synthetic emitter is released manually after asserting failure.
  for (const handler of socket.listeners('sandbox:join')) original('sandbox:join', handler);
});
