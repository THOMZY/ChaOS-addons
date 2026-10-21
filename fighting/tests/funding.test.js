import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test, { after } from 'node:test';
import { createAccount } from '../../../server/auth/service.js';
import { db } from '../../../server/db/index.js';
import { chatState } from '../../../server/chat/state.js';
import { User } from '../../../server/chat/user.js';
import { loadUserSettings, updatePoints } from '../../../server/chat/backlog.js';
import { createFightingRuntime } from '../server/runtime.js';
import { gameClock } from '../../../tests/helpers/game-clock.mjs';

class Socket extends EventEmitter {
  emit() {
    return true;
  }
  receive(event, data) {
    return super.emit(event, data);
  }
}
let sequence = 0;
after(() => db.close());
async function fixture(t) {
  const players = [],
    clock = gameClock(),
    fighting = createFightingRuntime({ timers: clock.timers });
  fighting.init(new Socket());
  for (let i = 0; i < 3; i++) {
    const unique = ++sequence;
    const { account } = await createAccount({
      email: `fight-regression-${unique}@example.test`,
      pseudo: `Fight ${unique}`,
      password: 'isolated-fighting-test-password',
    });
    const user = new User(account.id, { pseudo: account.pseudo }),
      socket = new Socket();
    user.points = 1000;
    user.clients.add(socket);
    chatState.users.set(account.id, user);
    updatePoints(account.id, 1000, 123);
    fighting.wire(socket, { user, accountId: account.id });
    players.push({ account, user, socket });
  }
  t.after(async () => {
    for (const room of [...fighting.fightMgr._rooms.values()])
      fighting.onUserDisconnect(room.players[0].accountId);
    await fighting.stop();
    assert.equal(clock.active.size, 0);
    chatState.users.clear();
  });
  players[0].socket.receive('fighting:create', { bet: 100 });
  const room = [...fighting.fightMgr._rooms.values()][0];
  return {
    fighting,
    players,
    room,
    saved: () => players.map((player) => loadUserSettings(player.account.id).points),
    join() {
      players[1].socket.receive('fighting:join', { roomId: room.id });
    },
    expire() {
      clock.fire(room._timer ?? room._expireTimer);
    },
  };
}
test('Fighting outsider forfeit cannot remove a funded waiting room', async (t) => {
  const value = await fixture(t);
  value.players[2].socket.receive('fighting:forfeit', { roomId: value.room.id });
  assert.strictEqual(value.fighting.fightMgr.getRoom(value.room.id), value.room);
  assert.deepEqual(value.saved(), [900, 1000, 1000]);
});
test('Fighting actual waiting expiry refunds its funded creator', async (t) => {
  const value = await fixture(t);
  value.expire();
  assert.deepEqual(value.saved(), [1000, 1000, 1000]);
});
test('Fighting actual character-lobby expiry refunds both funded participants', async (t) => {
  const value = await fixture(t);
  value.join();
  value.expire();
  assert.deepEqual(value.saved(), [1000, 1000, 1000]);
});
test('Fighting last waiting disconnect credits current offline SQLite rather than losing the stake', async (t) => {
  const value = await fixture(t),
    id = value.players[0].account.id;
  chatState.users.delete(id);
  updatePoints(id, 800, 456);
  value.fighting.onUserDisconnect(id);
  assert.equal(loadUserSettings(id).points, 900);
  assert.equal(loadUserSettings(id).lastDailyBonus, 456);
});
