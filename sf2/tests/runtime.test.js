import { createPointsStore } from '../../../server/chat/points-store.js';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test, { after } from 'node:test';
import { createAccount } from '../../../server/auth/service.js';
import { db } from '../../../server/db/index.js';
import { loadUserSettings, updatePoints } from '../../../server/chat/backlog.js';
import { User } from '../../../server/chat/user.js';
import { createCasinoWallet } from '../../../games/platform/casino-wallet.js';
import { createSf2Runtime } from '../server/runtime.js';
import { gameClock } from '../../../tests/helpers/game-clock.mjs';

class Socket extends EventEmitter {
  sent = [];
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
let sequence = 0;
after(() => db.close());
async function fixture(t, options = {}) {
  const clock = gameClock(),
    users = new Map(),
    players = [],
    ns = new Socket();
  const wallet = createCasinoWallet({
    users,
    change: createPointsStore({ db }).change,
    codePrefix: 'SF_TWO',
  });
  const runtime = createSf2Runtime({
    users,
    wallet,
    timers: clock.timers,
    now: () => 1234,
    report() {},
    ...options.runtime,
  });
  runtime.init(ns);
  for (let i = 0; i < (options.count ?? 2); i++) {
    const unique = ++sequence;
    const { account } = await createAccount({
      email: `sf2-runtime-${unique}@example.test`,
      pseudo: `SF2 Runtime ${unique}`,
      password: 'isolated-sf2-test-password',
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
      for (const room of [...runtime.sf2Mgr._rooms.values()])
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
    manager: runtime.sf2Mgr,
    create(bet = 100, index = 0, char) {
      players[index].socket.receive('sf2:create', { bet, char });
      return runtime.sf2Mgr.getRoom(players[index].socket.latest('sf2:created')?.roomId);
    },
    join(room, index = 1, char) {
      players[index].socket.receive('sf2:join', { roomId: room.id, char });
    },
    forfeit(room, index = 0) {
      players[index].socket.receive('sf2:forfeit', { roomId: room.id });
    },
    round(room, loserSlot = 1, index = 0) {
      players[index].socket.receive('sf2:round_end', { roomId: room.id, loserSlot });
    },
    saved() {
      return players.map((player) => loadUserSettings(player.account.id)?.points);
    },
  };
}

test('SF2 invalid, insufficient and scheduler-refused creates never debit', async (t) => {
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
  assert.equal(value.players[0].socket.latest('sf2:error').error, 'timer_unavailable');
});
test('SF2 duplicate and concurrent admissions have no second debit or compensating credit', async (t) => {
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
test('SF2 join acquires its round clock before debit and known refusal removes only the entrant', async (t) => {
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
test('SF2 uncertain join remains observable without a free start or guessed refund', async (t) => {
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
  value.fire(room._expireTimer);
  assert.deepEqual(value.saved(), [900, 900]);
  assert.equal(calls, 2);
  assert.equal(value.runtime.status().uncertainRooms, 1);
  assert.equal(value.players[0].socket.latest('sf2:start'), undefined);
  assert.equal(value.runtime.status().failureCode, 'SF_TWO_CHARGE_FAILED');
});
test('SF2 rejected async wallet is observed rather than accepted as confirmed funding', async (t) => {
  const value = await fixture(t, {
    failedStop: true,
    runtime: { wallet: { charge: () => Promise.reject(new Error('private')), credit: () => true } },
  });
  value.create();
  await Promise.resolve();
  assert.equal(value.runtime.status().uncertainRooms, 1);
  assert.deepEqual(value.saved(), [1000, 1000]);
});
test('SF2 Ryu/Ken defaults, slots, public payload and own inputs are preserved', async (t) => {
  const value = await fixture(t),
    room = value.create(100, 0, 'invalid');
  value.join(room, 1, 'kEn');
  assert.deepEqual(
    room.players.map((player) => player.char),
    ['Ryu', 'Ken'],
  );
  assert.deepEqual(
    value.players.map((player) => player.socket.latest('sf2:start').slot),
    [0, 1],
  );
  assert.equal(value.players[0].socket.latest('sf2:start').bet, 100);
  value.players[0].socket.receive('sf2:input', { roomId: room.id, input: { right: true } });
  assert.deepEqual(value.players[1].socket.latest('sf2:input'), { input: { right: true } });
  assert.equal(value.players[0].socket.latest('sf2:input'), undefined);
  value.players[0].socket.receive('sf2:rooms_request');
  assert.equal(value.players[0].socket.latest('sf2:rooms').liveRooms[0].roomId, room.id);
});
test('SF2 non-host, outsider and invalid round reports cannot score or disarm the clock', async (t) => {
  const value = await fixture(t, { count: 3 }),
    room = value.create();
  value.join(room);
  const clock = room._timer;
  value.round(room, 1, 1);
  value.round(room, 1, 2);
  for (const loser of [NaN, Infinity, -1, 2, '1', null]) value.round(room, loser);
  value.forfeit(room, 2);
  assert.deepEqual(room.wins, [0, 0]);
  assert.strictEqual(room._timer, clock);
  assert.deepEqual(value.saved(), [900, 900, 1000]);
});
test('SF2 first-to-two rounds pay an offline winner on latest SQLite exactly once', async (t) => {
  const value = await fixture(t),
    room = value.create();
  value.join(room);
  value.round(room);
  assert.deepEqual(room.wins, [1, 0]);
  assert.equal(room.round, 2);
  assert.deepEqual(value.players[1].socket.latest('sf2:next_round'), { round: 2, wins: [1, 0] });
  const id = value.players[0].account.id;
  value.users.delete(id);
  updatePoints(id, 800, 456);
  value.round(room);
  value.round(room);
  value.forfeit(room);
  assert.deepEqual(value.saved(), [1000, 900]);
  assert.equal(loadUserSettings(id).lastDailyBonus, 456);
  assert.equal(value.manager.getRoom(room.id), null);
  assert.deepEqual(value.players[1].socket.latest('sf2:game_over').wins, [2, 0]);
  assert.equal(value.active.size, 0);
});
test('SF2 split wins require a third round and preserve winner/loser payloads', async (t) => {
  const value = await fixture(t),
    room = value.create();
  value.join(room);
  value.round(room, 1);
  value.round(room, 0);
  value.round(room, 0);
  assert.deepEqual(value.saved(), [900, 1100]);
  const end = value.players[0].socket.latest('sf2:game_over');
  assert.deepEqual(end.wins, [1, 2]);
  assert.equal(end.winner.userId, value.players[1].user.userId);
  assert.equal(end.loser.userId, value.players[0].user.userId);
  assert.equal(end.payout, 200);
  assert.equal(value.ns.latest('bot').date, 1234);
});
test('SF2 actual 110-second timeout refunds the entire match offline, even after one round won', async (t) => {
  const value = await fixture(t),
    room = value.create();
  value.join(room);
  value.round(room);
  const timer = room._timer;
  assert.equal(timer.delay, 110000);
  for (const player of value.players) {
    value.users.delete(player.account.id);
    updatePoints(player.account.id, 800, 456);
  }
  value.fire(timer);
  value.fire(timer);
  value.manager.emit('room:round_timeout', {
    roomId: room.id,
    players: room.players,
    bet: room.bet,
  });
  assert.deepEqual(value.saved(), [900, 900]);
  assert.equal(value.manager.getRoom(room.id), null);
  assert.equal(value.runtime.status().pendingRooms, 0);
});
test('SF2 timeout retains the legacy draw payload and does not invent a winner', async (t) => {
  const value = await fixture(t),
    room = value.create();
  value.join(room);
  value.fire(room._timer);
  assert.deepEqual(value.players[0].socket.latest('sf2:game_over'), {
    draw: true,
    roomId: room.id,
  });
  assert.equal(value.ns.latest('bot'), undefined);
  assert.deepEqual(value.saved(), [1000, 1000]);
});
test('SF2 cancelled waiting and old round callbacks cannot refund or score a later round', async (t) => {
  const value = await fixture(t),
    room = value.create(),
    wait = room._expireTimer;
  value.join(room);
  const first = room._timer;
  value.round(room);
  const current = room._timer;
  value.fire(wait);
  value.fire(first);
  value.manager.emit('room:expired', { roomId: room.id });
  value.manager.emit('room:round_timeout', { roomId: room.id });
  assert.strictEqual(room._timer, current);
  assert.deepEqual(room.wins, [1, 0]);
  assert.deepEqual(value.saved(), [900, 900]);
  assert.equal(value.runtime.status().failed, false);
});
test('SF2 next-round clock refusal preserves the old round, score and both paid stakes', async (t) => {
  const value = await fixture(t),
    room = value.create();
  value.join(room);
  const timer = room._timer;
  value.failNext();
  value.round(room);
  assert.strictEqual(room._timer, timer);
  assert.deepEqual(room.wins, [0, 0]);
  assert.equal(room.round, 1);
  value.fire(timer);
  assert.deepEqual(value.saved(), [1000, 1000]);
});
test('SF2 forfeit pays one pot, cancels every timer and cannot be replayed', async (t) => {
  const value = await fixture(t),
    room = value.create();
  value.join(room);
  const timer = room._timer;
  value.forfeit(room);
  value.fire(timer);
  value.forfeit(room);
  assert.deepEqual(value.saved(), [900, 1100]);
  assert.equal(value.active.size, 0);
  assert.equal(value.players[0].socket.latest('sf2:game_over').forfeit, true);
  assert.equal(value.players[0].socket.latest('sf2:game_over').wins, null);
});
test('SF2 failed payout remains pending after room deletion without publishing or replaying it', async (t) => {
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
  value.forfeit(room);
  value.forfeit(room);
  assert.deepEqual(value.saved(), [900, 1100]);
  assert.equal(credits, 1);
  assert.equal(value.manager.getRoom(room.id), null);
  assert.equal(value.runtime.status().pendingRooms, 1);
  assert.equal(value.runtime.status().failureCode, 'SF_TWO_PAYOUT_FAILED');
  assert.equal(value.players[1].socket.latest('sf2:game_over'), undefined);
});
test('SF2 partially refunded draw retains uncertainty and cannot credit the first player twice', async (t) => {
  let value,
    credits = 0;
  value = await fixture(t, {
    failedStop: true,
    runtime: {
      wallet: {
        charge: (...args) => value.wallet.charge(...args),
        credit(...args) {
          credits++;
          return credits === 2 ? false : value.wallet.credit(...args);
        },
      },
    },
  });
  const room = value.create();
  value.join(room);
  const timer = room._timer;
  value.fire(timer);
  value.fire(timer);
  value.manager.emit('room:round_timeout', { roomId: room.id });
  assert.deepEqual(value.saved(), [1000, 900]);
  assert.equal(credits, 2);
  assert.equal(value.runtime.status().uncertainRooms, 1);
  assert.equal(value.players[0].socket.latest('sf2:game_over'), undefined);
});
test('SF2 failed waiting refund stays observable after removal and is not replayed', async (t) => {
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
    timer = room._expireTimer;
  value.fire(timer);
  value.fire(timer);
  value.manager.emit('room:expired', { roomId: room.id });
  assert.equal(credits, 1);
  assert.deepEqual(value.saved(), [900, 1000]);
  assert.equal(value.runtime.status().pendingRooms, 1);
});
test('SF2 deleted winner account is refused, not recreated by settlement', async (t) => {
  const value = await fixture(t, { failedStop: true }),
    room = value.create();
  value.join(room);
  const id = value.players[1].account.id;
  value.users.delete(id);
  db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
  value.forfeit(room);
  assert.equal(db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(id), undefined);
  assert.equal(value.runtime.status().failureCode, 'SF_TWO_PAYOUT_FAILED');
});
test('SF2 publication failure after credit is retained without replaying a completed payout', async (t) => {
  const value = await fixture(t, { failedStop: true }),
    room = value.create();
  value.join(room);
  value.ns.emit = (event) => {
    if (event === 'sf2:live_closed') throw new Error('private');
    return true;
  };
  value.forfeit(room);
  value.forfeit(room);
  assert.deepEqual(value.saved(), [900, 1100]);
  assert.equal(value.runtime.status().pendingRooms, 0);
  assert.equal(value.runtime.status().pendingResults, 1);
  assert.equal(value.runtime.status().failed, true);
});
test('SF2 socket disposal makes copied handlers inert and preserves neighboring listeners', async (t) => {
  const value = await fixture(t),
    socket = value.players[0].socket,
    copied = socket.listeners('sf2:create')[0];
  let neighbor = 0;
  socket.on('sf2:create', () => neighbor++);
  value.runtime.onSocketDisconnect(socket);
  copied({ bet: 100 });
  socket.receive('sf2:create', { bet: 100 });
  assert.equal(neighbor, 1);
  assert.equal(value.manager._rooms.size, 0);
  assert.deepEqual(value.saved(), [1000, 1000]);
  assert.equal(socket.listenerCount('disconnect'), 0);
});
test('SF2 stop closes admissions but lets an already funded match finish normally', async (t) => {
  const value = await fixture(t),
    room = value.create();
  value.join(room);
  const stop = value.runtime.stop();
  assert.strictEqual(value.runtime.stop(), stop);
  value.create();
  assert.equal(value.players[0].socket.latest('sf2:error').error, 'unavailable');
  value.round(room);
  value.round(room);
  await stop;
  assert.deepEqual(value.saved(), [1100, 900]);
  assert.equal(value.runtime.status().activeListeners, 0);
  assert.equal(value.runtime.status().activeSockets, 0);
});
test('SF2 five-second drain rejection persists while the real waiting expiry can still refund later', async (t) => {
  const value = await fixture(t, { failedStop: true }),
    room = value.create(),
    expiry = room._expireTimer;
  const stop = value.runtime.stop(),
    rejected = assert.rejects(stop, { code: 'SF_TWO_DRAIN_TIMEOUT' });
  value.fire([...value.active].find((handle) => handle.delay === 5000));
  await rejected;
  assert.deepEqual(value.saved(), [900, 1000]);
  value.fire(expiry);
  assert.deepEqual(value.saved(), [1000, 1000]);
  assert.equal(value.runtime.status().stopped, true);
  assert.equal(value.active.size, 0);
});
test('SF2 stop requested during credit waits for the full result publication', async (t) => {
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
  value.forfeit(room);
  await stop;
  assert.equal(value.players[1].socket.latest('sf2:game_over').payout, 200);
  assert.equal(value.runtime.status().pendingResults, 0);
  assert.equal(value.active.size, 0);
});
test('SF2 init/wiring are idempotent and instances have independent rooms, money and clocks', async (t) => {
  const first = await fixture(t),
    second = await fixture(t),
    room = first.create();
  second.create();
  first.runtime.init(first.ns);
  first.runtime.wire(first.players[0].socket, {
    user: first.players[0].user,
    accountId: first.players[0].account.id,
  });
  assert.equal(first.players[0].socket.listenerCount('sf2:create'), 1);
  assert.throws(() => first.runtime.init(new Socket()), /ALREADY_INITIALIZED/);
  const handles = [...second.active];
  first.forfeit(room);
  await first.runtime.stop();
  assert.deepEqual([...second.active], handles);
  assert.deepEqual(second.saved(), [900, 1000]);
});
test('SF2 stop before init is final and acquires no resource', async () => {
  const clock = gameClock(),
    runtime = createSf2Runtime({ timers: clock.timers });
  assert.throws(() => runtime.wire(new Socket(), {}), /NOT_INITIALIZED/);
  const stop = runtime.stop();
  assert.strictEqual(runtime.stop(), stop);
  await stop;
  assert.equal(runtime.init(new Socket()), false);
  assert.equal(runtime.wire(new Socket(), {}), false);
  assert.equal(clock.active.size, 0);
});
test('SF2 zero stakes play normally without touching a wallet', async (t) => {
  const value = await fixture(t, {
    runtime: {
      wallet: {
        charge() {
          throw new Error('must not debit');
        },
        credit() {
          throw new Error('must not credit');
        },
      },
    },
  });
  const room = value.create(0);
  value.join(room);
  value.round(room);
  value.round(room);
  assert.deepEqual(value.saved(), [1000, 1000]);
  assert.equal(value.players[0].socket.latest('sf2:game_over').payout, 0);
  assert.equal(value.runtime.status().failed, false);
});
