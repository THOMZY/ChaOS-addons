import { createPointsStore } from '../../../server/chat/points-store.js';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test, { after } from 'node:test';
import { createAccount } from '../../../server/auth/service.js';
import { db } from '../../../server/db/index.js';
import { updatePoints, loadUserSettings } from '../../../server/chat/backlog.js';
import { User } from '../../../server/chat/user.js';
import { createCasinoWallet } from '../../../games/platform/casino-wallet.js';
import { createWormsRuntime } from '../server/runtime.js';
import { gameClock } from '../../../tests/helpers/game-clock.mjs';

let sequence = 0;
class Socket extends EventEmitter {
  sent = [];
  emit(event, data) { this.sent.push({ event, data }); return true; }
  receive(event, data) { return super.emit(event, data); }
  latest(event) { return this.sent.findLast(item => item.event === event)?.data; }
}
after(() => db.close());
async function fixture(t, options = {}) {
  const clock = gameClock(), users = new Map(), players = [], ns = new Socket();
  const wallet = createCasinoWallet({ users, change: createPointsStore({ db }).change, codePrefix: 'WORMS' });
  const runtime = createWormsRuntime({ users, wallet, timers: clock.timers, now: () => 1000,
    preload: () => Promise.resolve(), report() {}, ...options.runtime }); runtime.init(ns); await runtime.ready();
  for (let i = 0; i < (options.count ?? 2); i++) {
    const unique = ++sequence;
    const { account } = await createAccount({ email: `worms-${unique}@example.test`, pseudo: `Worms ${unique}`, password: 'isolated-worms-test-password' });
    const user = new User(account.id, { pseudo: account.pseudo }), socket = new Socket(); user.points = 1000; user.clients.add(socket); users.set(account.id, user);
    updatePoints(account.id, 1000, user.lastDailyBonus); runtime.wire(socket, { user, accountId: account.id }); players.push({ account, user, socket });
  }
  t.after(async () => {
    if (options.failedStop) { await assert.rejects(runtime.stop()); clock.active.clear(); }
    else {
      for (const room of [...runtime.wormsMgr._rooms.values()]) {
        for (const player of room.players) {
          if (room.state === 'done' || !runtime.wormsMgr.getRoom(room.id)) break;
          runtime.onUserDisconnect(player.accountId);
        }
      }
      await runtime.stop(); assert.equal(clock.active.size, 0);
    }
  });
  return { ...clock, runtime, users, wallet, players, ns, manager: runtime.wormsMgr,
    create(bet = 100) {
      players[0].socket.receive('worms:create', { bet, maxPlayers: 8 });
      return runtime.wormsMgr.getRoom(players[0].socket.latest('worms:created')?.roomId);
    },
    join(room, index = 1) { players[index].socket.receive('worms:join', { roomId: room.id }); },
    launch(room) { players[0].socket.receive('worms:launch', { roomId: room.id, theme: 0 }); },
    end(room, index = 0) { players[index].socket.receive('worms:forfeit', { roomId: room.id }); },
    rematch(room) { for (const player of players) player.socket.receive('worms:rematch', { roomId: room.id }); },
    saved() { return players.map(player => loadUserSettings(player.account.id)?.points); },
  };
}
function flat(room) {
  room.terrain = new Array(960).fill(320); room.mask = null; room.holes = [];
  const active = room.worms.find(worm => worm.id === room.activeWormId); active.cx = 120; active.cy = 309;
  room.worms.filter(worm => worm !== active).forEach((worm, i) => { worm.cx = 700 + i * 20; worm.cy = 309; });
}

test('worms admissions charge once and duplicate or concurrent rooms cannot spend again', async t => {
  const value = await fixture(t), room = value.create(); value.join(room);
  value.join(room); value.create(); assert.deepEqual(value.saved(), [900, 900]);
  assert.equal(value.manager._rooms.size, 1); assert.equal(value.runtime.status().failed, false);
});
test('worms invalid, insufficient and scheduler-refused creates never debit', async t => {
  const value = await fixture(t);
  for (const bet of [NaN, Infinity, -1, Number.MAX_SAFE_INTEGER, {}]) { value.create(bet); assert.equal(value.manager._rooms.size, 0); }
  value.create(1001); value.failNext(); value.create();
  assert.equal(value.players[0].socket.latest('worms:error').error, 'timer_unavailable');
  assert.deepEqual(value.saved(), [1000, 1000]); assert.equal(value.active.size, 0);
});
test('worms refused join preserves the funded host and does not refund an uncharged guest', async t => {
  const value = await fixture(t), room = value.create(); value.players[1].user.points = 50;
  updatePoints(value.players[1].account.id, 50, 123); value.join(room);
  assert.deepEqual(value.saved(), [900, 50]); assert.equal(room.players.length, 1);
  assert.equal(value.players[1].socket.latest('worms:error').error, 'insufficient_balance');
});
for (const action of ['expiry', 'forfeit', 'host-disconnect', 'guest-disconnect']) {
  test(`worms waiting ${action} refunds every confirmed participant once`, async t => {
    const value = await fixture(t), room = value.create(); value.join(room); const expiry = room._expireTimer;
    if (action === 'expiry') value.fire(expiry);
    else if (action === 'forfeit') value.end(room, 1);
    else value.runtime.onUserDisconnect(value.players[action === 'host-disconnect' ? 0 : 1].account.id);
    value.fire(expiry); value.runtime.onUserDisconnect(value.players[0].account.id);
    assert.deepEqual(value.saved(), [1000, 1000]); assert.equal(value.manager.getRoom(room.id), null);
    assert.equal(value.runtime.status().pendingRooms, 0); assert.equal(value.runtime.status().failed, false);
  });
}
test('worms launch cancels the actual FFA expiry and a copied callback cannot refund a paid game', async t => {
  const value = await fixture(t), room = value.create(); value.join(room); const expiry = room._expireTimer;
  value.launch(room); value.fire(expiry); assert.equal(room.state, 'playing'); assert.deepEqual(value.saved(), [900, 900]);
});
test('worms win pays once on latest offline SQLite balance and preserves its timestamp', async t => {
  const value = await fixture(t), room = value.create(); value.join(room); value.launch(room);
  value.users.delete(value.players[1].account.id); updatePoints(value.players[1].account.id, 800, 456);
  value.end(room); value.end(room);
  assert.deepEqual(value.saved(), [900, 1000]); assert.equal(loadUserSettings(value.players[1].account.id).lastDailyBonus, 456);
  assert.equal(room._settlementPending, false); assert.equal(value.runtime.status().pendingRooms, 0);
});
test('worms draw returns only the committed stakes once', async t => {
  const value = await fixture(t), room = value.create(); value.join(room); value.launch(room);
  for (const worm of room.worms) { worm.alive = false; worm.hp = 0; }
  value.fire(room._turnTimer); value.end(room);
  assert.deepEqual(value.saved(), [1000, 1000]); assert.equal(value.players[0].socket.latest('worms:game_over').draw, true);
  const notice = value.ns.latest('bot');
  assert.deepEqual({ ...notice, date: undefined }, {
    kind: 'bot', pseudo: 'worms', color: '#66dd33', translationKey: 'chat.game.wormsDraw',
    translationValues: {}, date: undefined,
  });
});
test('worms rematch opens a new funding generation and old expiry, turn and post callbacks stay inert', async t => {
  const value = await fixture(t), room = value.create(); value.join(room); const expiry = room._expireTimer;
  value.launch(room); const turn = room._turnTimer; value.end(room); const post = room._postTimer;
  value.rematch(room); assert.deepEqual(value.saved(), [800, 1000]); assert.equal(room.state, 'waiting');
  for (const handle of [expiry, turn, post]) value.fire(handle);
  assert.equal(room.state, 'waiting'); assert.deepEqual(value.saved(), [800, 1000]);
});
test('worms rematch timer refusal happens before any new debit and preserves the settled room', async t => {
  const value = await fixture(t), room = value.create(); value.join(room); value.launch(room); value.end(room); const before = value.saved();
  value.failNext(); value.rematch(room); assert.deepEqual(value.saved(), before); assert.equal(room.state, 'done');
  assert.equal(value.players[1].socket.latest('worms:error').error, 'timer_unavailable');
});
test('worms second rematch refusal compensates only earlier confirmed debits', async t => {
  const value = await fixture(t), room = value.create(); value.join(room); value.launch(room); value.end(room);
  value.players[1].user.points = 50; updatePoints(value.players[1].account.id, 50, 123); value.rematch(room);
  assert.deepEqual(value.saved(), [900, 50]); assert.equal(value.manager.getRoom(room.id), null); assert.equal(value.runtime.status().pendingRooms, 0);
});
test('worms uncertain rematch debit is retained without compensation, launch or replay', async t => {
  let value, calls = 0;
  value = await fixture(t, { failedStop: true, runtime: { wallet: {
    charge(...args) { calls++; const result = value.wallet.charge(...args); if (calls === 4) throw new Error('private debit'); return result; },
    credit: (...args) => value.wallet.credit(...args),
  } } });
  const room = value.create(); value.join(room); value.launch(room); value.end(room); value.rematch(room);
  assert.deepEqual(value.saved(), [800, 1000]); assert.equal(value.runtime.status().uncertainRooms, 1);
  value.launch(room); assert.equal(room.state, 'waiting'); value.fire(room._expireTimer);
  assert.deepEqual(value.saved(), [800, 1000]); assert.equal(calls, 4); assert.equal(value.runtime.status().failureCode, 'WORMS_CHARGE_FAILED');
});
test('worms uncertain payout never publishes success or permits post-exit, rematch or retry', async t => {
  let value, credits = 0;
  value = await fixture(t, { failedStop: true, runtime: { wallet: {
    charge: (...args) => value.wallet.charge(...args),
    credit(...args) { credits++; value.wallet.credit(...args); throw new Error('private write'); },
  } } });
  const room = value.create(); value.join(room); value.launch(room); value.end(room); value.end(room);
  value.players[0].socket.receive('worms:post_exit', { roomId: room.id });
  assert.equal(value.players[0].socket.latest('worms:error').error, 'settlement_pending'); value.rematch(room);
  assert.deepEqual(value.saved(), [900, 1100]); assert.equal(credits, 1); assert.equal(room._settlementPending, true);
  assert.equal(room._postTimer, null); assert.equal(value.players[0].socket.latest('worms:game_over'), undefined);
});
test('worms failed waiting refund retains the obligation after room deletion without retry', async t => {
  let value, credits = 0;
  value = await fixture(t, { failedStop: true, runtime: { wallet: {
    charge: (...args) => value.wallet.charge(...args), credit() { credits++; return false; },
  } } });
  const room = value.create(), expiry = room._expireTimer; value.fire(expiry); value.fire(expiry);
  assert.equal(value.manager.getRoom(room.id), null); assert.equal(value.runtime.status().uncertainRooms, 1);
  assert.equal(value.runtime.status().failureCode, 'WORMS_REFUND_FAILED'); assert.deepEqual(value.saved(), [900, 1000]); assert.equal(credits, 1);
});
test('worms deleted payout account is not recreated and settlement remains failed', async t => {
  const value = await fixture(t, { failedStop: true }), room = value.create(); value.join(room); value.launch(room);
  const id = value.players[1].account.id; value.users.delete(id); db.prepare('DELETE FROM accounts WHERE id = ?').run(id); value.end(room);
  assert.equal(db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(id), undefined);
  assert.equal(value.runtime.status().failureCode, 'WORMS_PAYOUT_FAILED'); assert.equal(value.runtime.status().uncertainRooms, 1);
});
test('worms stop closes new admissions but keeps paid launches and forfeits active until settlement', async t => {
  const value = await fixture(t), room = value.create(); value.join(room); const stop = value.runtime.stop();
  assert.strictEqual(value.runtime.stop(), stop); value.create(); assert.equal(value.players[0].socket.latest('worms:error').error, 'unavailable');
  value.launch(room); assert.equal(room.state, 'playing'); value.end(room); await stop;
  assert.deepEqual(value.saved(), [900, 1100]); assert.equal(value.active.size, 0); assert.equal(value.runtime.status().activeListeners, 0);
});
test('worms timeout stays rejected while the normal waiting expiry may still refund later', async t => {
  const value = await fixture(t, { failedStop: true }), room = value.create(), expiry = room._expireTimer;
  const stop = value.runtime.stop(), rejected = assert.rejects(stop, { code: 'WORMS_DRAIN_TIMEOUT' });
  value.fire([...value.active].find(handle => handle.delay === 5000)); await rejected;
  value.fire(expiry); assert.deepEqual(value.saved(), [1000, 1000]); assert.equal(value.runtime.status().stopped, true);
  assert.equal(value.runtime.status().failed, true); assert.equal(value.active.size, 0);
});
test('worms current forfeit advances the turn while an out-of-turn forfeit preserves its clock', async t => {
  const value = await fixture(t, { count: 3 }), room = value.create(); value.join(room); value.join(room, 2); value.launch(room);
  const first = room._turnTimer; value.end(room, 2); assert.strictEqual(room._turnTimer, first); assert.equal(value.active.has(first), true);
  value.end(room); assert.equal(room.state, 'done'); assert.deepEqual(value.saved(), [900, 1200, 900]);
});
test('worms forfeit after a shot invalidates its old impact and retreat callbacks without skipping the next turn', async t => {
  const value = await fixture(t, { count: 3 }), room = value.create(); value.join(room); value.join(room, 2); value.launch(room); flat(room);
  value.players[0].socket.receive('worms:fire', { roomId: room.id, weapon: 'shotgun', angle: -Math.PI / 3, power: 0.55 });
  const impact = value.installed.findLast(handle => handle.delay === 2600); assert.ok(impact); value.fire(impact);
  const retreat = room._retreatTimer; assert.ok(retreat); value.end(room);
  assert.equal(room.currentTurn, value.players[1].user.userId); const turn = room._turnTimer;
  value.fire(impact); value.fire(retreat); assert.strictEqual(room._turnTimer, turn); assert.equal(room.retreating, false);
});
test('worms dynamite fuse survives a turn change but not settlement or a new room generation', async t => {
  const value = await fixture(t, { count: 3 }), room = value.create(); value.join(room); value.join(room, 2); value.launch(room); flat(room);
  value.players[0].socket.receive('worms:fire', { roomId: room.id, weapon: 'dynamite', angle: 0, power: 0.5 });
  const fuse = [...room._dynTimers.values()][0]; assert.ok(fuse); value.end(room);
  assert.equal(room.state, 'playing'); value.fire(fuse); assert.equal(room.dynamites.length, 0); assert.equal(room._dynTimers.size, 0);
  value.end(room, 1); value.rematch(room); assert.equal(room.state, 'waiting'); value.fire(fuse);
  assert.equal(room.state, 'waiting'); assert.deepEqual(value.saved(), [800, 800, 1100]);
});
test('worms socket disposal removes only owned handlers and spectators; copied commands cannot debit', async t => {
  const value = await fixture(t), room = value.create(); value.join(room); value.launch(room);
  const spectator = new Socket(); value.runtime.wire(spectator, { user: null, accountId: null });
  spectator.receive('worms:watch', { roomId: room.id }); assert.equal(value.runtime.status().spectatorRooms, 1);
  const copied = spectator.listeners('worms:create')[0], neighbor = () => {}; spectator.on('worms:create', neighbor);
  value.runtime.onSocketDisconnect(spectator); copied({ bet: 100 });
  assert.equal(spectator.listenerCount('worms:create'), 1); assert.equal(value.runtime.status().spectatorRooms, 0);
  assert.deepEqual(value.saved(), [900, 900]); assert.equal(value.runtime.status().failed, false);
});
test('worms a settled historical room does not hide a later paid lobby on last disconnect', async t => {
  const value = await fixture(t), room = value.create(); value.join(room); value.launch(room); value.end(room);
  const next = value.create(); assert.notEqual(next.id, room.id); value.users.delete(value.players[0].account.id);
  value.runtime.onUserDisconnect(value.players[0].account.id); assert.deepEqual(value.saved(), [900, 1100]);
  assert.equal(value.manager.getRoom(next.id), null);
});
test('worms init/wire are idempotent and separate runtimes do not share rooms, timers or wallets', async t => {
  const first = await fixture(t), second = await fixture(t); const room = first.create(); second.create();
  first.runtime.init(first.ns); first.runtime.wire(first.players[0].socket, { user: first.players[0].user, accountId: first.players[0].account.id });
  assert.equal(first.players[0].socket.listenerCount('worms:create'), 1); assert.throws(() => first.runtime.init(new Socket()), /ALREADY_INITIALIZED/);
  const handles = [...second.active]; first.end(room); await first.runtime.stop();
  assert.deepEqual([...second.active], handles); assert.deepEqual(second.saved(), [900, 1000]);
});
test('worms stop waits for owned level loading and does not cancel or invent completion of Sharp work', async () => {
  const clock = gameClock(); let resolve, calls = 0;
  const runtime = createWormsRuntime({ timers: clock.timers, preload() { calls++; return new Promise(done => { resolve = done; }); } });
  const ns = new Socket(); runtime.init(ns); runtime.init(ns); const stop = runtime.stop();
  assert.equal(runtime.status().loading, true); assert.equal(runtime.status().stopped, false); assert.equal(calls, 1);
  resolve(); await runtime.ready(); await stop; assert.equal(runtime.status().loading, false); assert.equal(clock.active.size, 0);
});
test('worms loading timeout stays failed after late completion and cannot be restarted', async () => {
  const clock = gameClock(); let resolve;
  const runtime = createWormsRuntime({ timers: clock.timers, report() {}, preload: () => new Promise(done => { resolve = done; }) });
  runtime.init(new Socket()); const stop = runtime.stop(), rejected = assert.rejects(stop, { code: 'WORMS_DRAIN_TIMEOUT' });
  clock.fire([...clock.active][0]); await rejected; resolve(); await runtime.ready();
  assert.strictEqual(runtime.stop(), stop); assert.equal(runtime.status().stopped, true); assert.equal(runtime.status().failed, true);
  assert.equal(runtime.init(new Socket()), false); assert.equal(clock.active.size, 0);
});
test('worms rejected preloader is observed and reported without private error details', async () => {
  const reports = [], runtime = createWormsRuntime({ preload: () => Promise.reject(new Error('private path')),
    report: line => reports.push(line) }); runtime.init(new Socket()); await runtime.ready();
  await assert.rejects(runtime.stop(), { code: 'WORMS_LEVELS_FAILED' });
  assert.equal(runtime.status().loading, false); assert.equal(runtime.status().activeTimers, 0); assert.ok(reports.length);
  assert.equal(reports.some(line => line.includes('private')), false);
});
test('worms stop before init is final and does not start level loading', async () => {
  let calls = 0; const runtime = createWormsRuntime({ preload() { calls++; } }); await runtime.stop();
  assert.equal(runtime.init(new Socket()), false); assert.equal(runtime.wire(new Socket(), {}), false); assert.equal(calls, 0);
});
