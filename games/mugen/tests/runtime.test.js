import { createPointsStore } from '../../../server/chat/points-store.js';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test, { after } from 'node:test';
import { createAccount } from '../../../server/auth/service.js';
import { db } from '../../../server/db/index.js';
import { loadUserSettings, updatePoints } from '../../../server/chat/backlog.js';
import { User } from '../../../server/chat/user.js';
import { createCasinoWallet } from '../../../games/platform/casino-wallet.js';
import { createMugenRuntime } from '../server/runtime.js';
import { MATCH_TIMEOUT_MS, RESULT_GRACE_MS, SELECTION_TIMEOUT_MS } from '../server/model.js';
import { gameClock } from '../../../tests/helpers/game-clock.mjs';
import { fakeCatalog } from './fixtures.js';

let sequence = 0;
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
  all(event) {
    return this.sent.filter((item) => item.event === event).map((item) => item.data);
  }
}
after(() => db.close());

async function fixture(t, options = {}) {
  const clock = gameClock(),
    users = new Map(),
    players = [],
    ns = new Socket();
  let now = 1000;
  const store = createCasinoWallet({
    users,
    change: createPointsStore({ db }).change,
    codePrefix: 'MUGEN',
  });
  const wallet = options.wallet ?? store;
  const runtime = createMugenRuntime({
    catalog: options.catalog ?? fakeCatalog(),
    users,
    wallet,
    timers: clock.timers,
    now: () => now,
    random: () => 0,
    report() {},
  });
  runtime.init(ns);
  for (let i = 0; i < (options.count ?? 3); i++) {
    const unique = ++sequence;
    const { account } = await createAccount({
      email: `mugen-runtime-${unique}@example.test`,
      pseudo: `Mugen Runtime ${unique}`,
      password: 'isolated-mugen-test-password',
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
      return;
    }
    for (const room of [...runtime.fightMgr._rooms.values()])
      runtime.onUserDisconnect(room.players[0].accountId);
    await runtime.stop();
    assert.equal(clock.active.size, 0);
  });
  const value = {
    ...clock,
    runtime,
    users,
    wallet: store,
    players,
    ns,
    manager: runtime.fightMgr,
    advance(ms) {
      now += ms;
    },
    create(bet = 100, index = 0) {
      players[index].socket.receive('mugen:create', { bet });
      return runtime.fightMgr.getRoom(players[index].socket.latest('mugen:created')?.roomId);
    },
    join(room, index = 1) {
      players[index].socket.receive('mugen:join', { roomId: room.id });
    },
    select(room, stage = null) {
      players[0].socket.receive('mugen:select_char', {
        roomId: room.id,
        character: 'kfm/kfm.def',
        stage,
      });
      players[1].socket.receive('mugen:select_char', {
        roomId: room.id,
        character: 'Ryu/wrapped/ryu.def',
      });
    },
    start(bet = 100) {
      const room = value.create(bet);
      value.join(room);
      value.select(room);
      return room;
    },
    report(room, index, payload) {
      players[index].socket.receive('mugen:result', {
        roomId: room.id,
        ...payload,
      });
    },
    saved() {
      return players.map((player) => loadUserSettings(player.account.id)?.points);
    },
  };
  return value;
}

test('MUGEN invalid and insufficient creates never debit', async (t) => {
  const value = await fixture(t);
  for (const bet of [-1, 1.5e300, 'abc', 2000]) {
    value.players[0].socket.receive('mugen:create', { bet });
    assert.ok(value.players[0].socket.latest('mugen:error'));
  }
  assert.equal(value.manager._rooms.size, 0);
  assert.deepEqual(value.saved(), [1000, 1000, 1000]);
});

test('MUGEN start seats the creator as host with validated characters and a stage', async (t) => {
  const value = await fixture(t),
    room = value.create();
  value.join(room);
  value.players[0].socket.receive('mugen:select_char', {
    roomId: room.id,
    character: '../../etc/passwd',
  });
  assert.equal(value.players[0].socket.latest('mugen:error').error, 'unknown_character');
  assert.equal(room.players[0].character, null);
  value.select(room);
  assert.equal(room.state, 'playing');
  assert.equal(room._timer.delay, MATCH_TIMEOUT_MS);
  const host = value.players[0].socket.latest('mugen:start');
  const guest = value.players[1].socket.latest('mugen:start');
  assert.equal(host.role, 'host');
  assert.equal(guest.role, 'guest');
  assert.deepEqual(host.p1, { path: 'kfm/kfm.def', name: 'Kung Fu Man' });
  assert.deepEqual(guest.p2, { path: 'Ryu/wrapped/ryu.def', name: 'Ryu' });
  assert.deepEqual(host.stage, { path: 'dojo/dojo.def', name: 'Dojo' });
  assert.equal(value.ns.latest('mugen:live_open').id, room.id);
  assert.deepEqual(value.saved(), [900, 900, 1000]);
});

test('MUGEN creator can pick before an opponent joins and keeps the pick through admission', async (t) => {
  const value = await fixture(t);
  const room = value.create();
  const [host, guest, outsider] = value.players.map((entry) => entry.socket);
  outsider.receive('mugen:select_char', { roomId: room.id, character: 'Ryu/wrapped/ryu.def' });
  assert.equal(room.players[0].character, null);
  host.receive('mugen:select_char', {
    roomId: room.id,
    character: 'kfm/kfm.def',
    stage: 'dojo/dojo.def',
  });
  assert.equal(room.state, 'waiting');
  assert.equal(host.latest('mugen:char_picked').character.path, 'kfm/kfm.def');
  assert.equal(host.all('mugen:start').length, 0);
  assert.ok(room._expireTimer, 'a picked waiting room still expires');
  value.join(room);
  for (const socket of [host, guest])
    assert.equal(socket.latest('mugen:joined').players[0].character.path, 'kfm/kfm.def');
  assert.equal(room.state, 'lobby');
  assert.equal(host.all('mugen:start').length, 0);
  guest.receive('mugen:select_char', { roomId: room.id, character: 'Ryu/wrapped/ryu.def' });
  assert.equal(room.state, 'playing');
  assert.equal(host.latest('mugen:start').p1.path, 'kfm/kfm.def');
  assert.equal(host.latest('mugen:start').stage.path, 'dojo/dojo.def');
  assert.deepEqual(value.saved(), [900, 900, 1000]);
});

test('MUGEN refuses a duel when no stage is installed', async (t) => {
  const value = await fixture(t, { catalog: fakeCatalog({ stages: [] }) }),
    room = value.create();
  value.join(room);
  value.select(room);
  assert.equal(value.players[0].socket.latest('mugen:error').error, 'no_stage');
  assert.equal(room.state, 'lobby');
});

test('MUGEN relays netplay bytes to the opponent only, within limits', async (t) => {
  const value = await fixture(t),
    room = value.create();
  value.join(room);
  const bytes = Buffer.from([1, 2, 3]);
  value.players[0].socket.receive('mugen:net', {
    roomId: room.id,
    channel: 0,
    data: bytes,
  });
  assert.equal(value.players[1].socket.all('mugen:input').length, 0, 'nothing before the match');
  value.select(room);
  value.players[0].socket.receive('mugen:net', {
    roomId: room.id,
    channel: 1,
    data: bytes,
  });
  assert.deepEqual(value.players[1].socket.latest('mugen:input'), {
    roomId: room.id,
    channel: 1,
    data: bytes,
  });
  assert.equal(value.players[0].socket.all('mugen:input').length, 0);
  assert.equal(value.players[2].socket.all('mugen:input').length, 0);
  for (const payload of [
    { channel: 3, data: bytes },
    { channel: 0, data: 'text' },
    { channel: 0, data: Buffer.alloc(0) },
    { channel: 0, data: Buffer.alloc(9000) },
  ])
    value.players[0].socket.receive('mugen:net', {
      roomId: room.id,
      ...payload,
    });
  value.players[2].socket.receive('mugen:net', {
    roomId: room.id,
    channel: 0,
    data: bytes,
  });
  assert.equal(value.players[1].socket.all('mugen:input').length, 1);
  value.advance(1000);
  for (let i = 0; i < 700; i++)
    value.players[0].socket.receive('mugen:net', {
      roomId: room.id,
      channel: 1,
      data: bytes,
    });
  assert.equal(value.players[1].socket.all('mugen:input').length, 601, 'one second of budget');
  value.advance(1000);
  value.players[0].socket.receive('mugen:net', {
    roomId: room.id,
    channel: 1,
    data: bytes,
  });
  assert.equal(value.players[1].socket.all('mugen:input').length, 602);
});

test('MUGEN two matching reports pay the winner once', async (t) => {
  const value = await fixture(t),
    room = value.start();
  value.report(room, 0, { winSide: 1 });
  assert.equal(room._timer.delay, RESULT_GRACE_MS);
  value.report(room, 1, { winSide: 1 });
  value.report(room, 1, { winSide: 1 });
  assert.deepEqual(value.saved(), [900, 1100, 1000]);
  const over = value.players[0].socket.latest('mugen:game_over');
  assert.equal(over.payout, 200);
  assert.equal(over.winner.pseudo, value.players[1].user.pseudo);
  assert.equal(over.refunded, false);
  assert.equal(value.manager.getRoom(room.id), null);
  assert.equal(value.active.size, 0);
  assert.equal(value.ns.latest('bot').translationKey, 'chat.game.mugenWinBet');
});

test('MUGEN reports that disagree, or an aborted engine, refund both players', async (t) => {
  const value = await fixture(t);
  const disputed = value.start();
  value.report(disputed, 0, { winSide: 0 });
  value.report(disputed, 1, { winSide: 1 });
  assert.deepEqual(value.saved(), [1000, 1000, 1000]);
  assert.equal(value.players[1].socket.latest('mugen:game_over').refunded, true);
  const aborted = value.start();
  value.report(aborted, 0, { aborted: true });
  value.report(aborted, 1, { winSide: 0 });
  assert.deepEqual(value.saved(), [1000, 1000, 1000]);
});

test('MUGEN a single report wins after the grace period', async (t) => {
  const value = await fixture(t),
    room = value.start();
  value.report(room, 0, { winSide: 0 });
  const grace = room._timer;
  value.fire(grace);
  assert.deepEqual(value.saved(), [1100, 900, 1000]);
  value.fire(grace);
  assert.deepEqual(value.saved(), [1100, 900, 1000], 'a stale grace timer pays nothing');
});

test('MUGEN selection and match timeouts refund both players', async (t) => {
  const value = await fixture(t);
  const lobby = value.create();
  value.join(lobby);
  assert.equal(lobby._timer.delay, SELECTION_TIMEOUT_MS);
  value.fire(lobby._timer);
  assert.deepEqual(value.saved(), [1000, 1000, 1000]);
  assert.equal(value.players[0].socket.latest('mugen:cancelled').reason, 'selection_timeout');
  const playing = value.start();
  value.fire(playing._timer);
  assert.deepEqual(value.saved(), [1000, 1000, 1000]);
  assert.equal(value.players[1].socket.latest('mugen:cancelled').reason, 'match_timeout');
  assert.equal(value.ns.latest('mugen:live_closed').roomId, playing.id);
});

test('MUGEN forfeit refunds before the match and pays the opponent during it', async (t) => {
  const value = await fixture(t);
  const lobby = value.create();
  value.join(lobby);
  value.players[2].socket.receive('mugen:forfeit', { roomId: lobby.id });
  assert.ok(value.manager.getRoom(lobby.id), 'an outsider cannot end a room');
  value.players[1].socket.receive('mugen:forfeit', { roomId: lobby.id });
  assert.deepEqual(value.saved(), [1000, 1000, 1000]);
  const playing = value.start();
  value.players[0].socket.receive('mugen:forfeit', { roomId: playing.id });
  assert.deepEqual(value.saved(), [900, 1100, 1000]);
  assert.equal(value.players[1].socket.latest('mugen:game_over').payout, 200);
  assert.ok(value.players[0].socket.latest('mugen:forfeit'));
});

test('MUGEN disconnecting during a match forfeits it', async (t) => {
  const value = await fixture(t),
    room = value.start();
  value.runtime.onUserDisconnect(value.players[1].account.id);
  assert.deepEqual(value.saved(), [1100, 900, 1000]);
  assert.equal(value.manager.getRoom(room.id), null);
});

test('MUGEN spectators see the players and the result, never the netplay bytes', async (t) => {
  const value = await fixture(t),
    room = value.start(),
    spectator = value.players[2].socket;
  value.players[0].socket.receive('mugen:spectate', { roomId: room.id });
  assert.equal(value.players[0].socket.latest('mugen:error').error, 'cannot_spectate_own');
  spectator.receive('mugen:spectate', { roomId: room.id });
  const start = spectator.latest('mugen:spectate_start');
  assert.equal(start.players[0].character.name, 'Kung Fu Man');
  assert.equal(start.players[0].accountId, undefined);
  value.players[0].socket.receive('mugen:net', {
    roomId: room.id,
    channel: 1,
    data: Buffer.from([1]),
  });
  assert.equal(spectator.all('mugen:input').length, 0);
  value.report(room, 0, { winSide: 0 });
  value.report(room, 1, { winSide: 0 });
  assert.equal(spectator.latest('mugen:game_over').winner.pseudo, value.players[0].user.pseudo);
  assert.equal(value.runtime.status().spectatorRooms, 0);
});

test('MUGEN stores confirmed replay history before spectators join and accepts only the host', async (t) => {
  const value = await fixture(t, { count: 4 }),
    room = value.start(),
    [host, guest, spectator, late] = value.players.map((player) => player.socket);
  const chunk = (offset, bytes = [1, 2, 3]) => ({
    roomId: room.id,
    offset,
    data: Buffer.from(bytes),
  });
  host.receive('mugen:replay', chunk(0));
  assert.equal(value.runtime.status().replays, 1, 'history is kept from the start');

  spectator.receive('mugen:spectate', { roomId: room.id });
  assert.equal(spectator.latest('mugen:spectate_start').p1.name, 'Kung Fu Man');
  host.receive('mugen:replay', chunk(3));
  guest.receive('mugen:replay', chunk(6, [9]));
  const relayed = spectator.all('mugen:replay');
  assert.equal(relayed.length, 2);
  assert.deepEqual([...relayed[0].data], [1, 2, 3]);

  // Every late spectator starts with the complete config/seed/input history.
  late.receive('mugen:spectate', { roomId: room.id });
  assert.deepEqual(
    late.all('mugen:replay').map((item) => item.offset),
    [0, 3],
  );

  spectator.receive('mugen:unspectate');
  late.receive('mugen:unspectate');
  assert.equal(value.runtime.status().spectatorRooms, 0);
  assert.equal(value.runtime.status().replays, 1, 'leaving never destroys history');
  value.report(room, 0, { winSide: 0 });
  value.report(room, 1, { winSide: 0 });
  assert.equal(value.runtime.status().replays, 0);
});

test('MUGEN invalid replay histories notify viewers and refuse late arrivals', async (t) => {
  const value = await fixture(t, { count: 4 });
  const room = value.start();
  const [host, , spectator, late] = value.players.map((entry) => entry.socket);
  spectator.receive('mugen:spectate', { roomId: room.id });
  host.receive('mugen:replay', { roomId: room.id, offset: 0, data: Buffer.from([1]) });
  host.receive('mugen:replay', { roomId: room.id, offset: 2, data: Buffer.from([2]) });
  assert.equal(spectator.latest('mugen:error').error, 'replay_unavailable');
  assert.equal(value.runtime.status().spectatorRooms, 0);
  late.receive('mugen:spectate', { roomId: room.id });
  assert.equal(late.latest('mugen:error').error, 'replay_unavailable');
  assert.equal(late.all('mugen:replay').length, 0);
});

test('MUGEN players in another room cannot replace their game with a spectator session', async (t) => {
  const value = await fixture(t, { count: 4 });
  const live = value.start();
  value.create(0, 3);
  value.players[3].socket.receive('mugen:spectate', { roomId: live.id });
  assert.equal(value.players[3].socket.latest('mugen:error').error, 'already_in_room');
  assert.equal(value.runtime.status().spectatorRooms, 0);
});

test('MUGEN stop closes admissions but lets a paid duel finish', async (t) => {
  const value = await fixture(t),
    room = value.start();
  const stop = value.runtime.stop();
  value.players[2].socket.receive('mugen:create', { bet: 10 });
  assert.equal(value.players[2].socket.latest('mugen:error').error, 'unavailable');
  let stopped = false;
  void stop.then(() => (stopped = true));
  await Promise.resolve();
  assert.equal(stopped, false);
  value.report(room, 0, { winSide: 0 });
  value.report(room, 1, { winSide: 0 });
  await stop;
  assert.deepEqual(value.saved(), [1100, 900, 1000]);
  assert.equal(value.runtime.status().stopped, true);
});

test('MUGEN a failed payout stays visible and is never replayed', async (t) => {
  let value,
    credits = 0;
  value = await fixture(t, {
    failedStop: true,
    wallet: {
      charge: (...args) => value.wallet.charge(...args),
      credit(...args) {
        credits++;
        value.wallet.credit(...args);
        throw new Error('private');
      },
    },
  });
  const room = value.start();
  value.report(room, 0, { winSide: 1 });
  value.report(room, 1, { winSide: 1 });
  value.report(room, 0, { winSide: 1 });
  assert.equal(value.manager.getRoom(room.id), null);
  assert.deepEqual(value.saved(), [900, 1100, 1000]);
  assert.equal(credits, 1);
  assert.equal(value.runtime.status().failureCode, 'MUGEN_PAYOUT_FAILED');
  assert.equal(value.runtime.status().pendingRooms, 1);
  assert.equal(value.players[1].socket.latest('mugen:game_over'), undefined);
});
