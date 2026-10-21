import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test, { after } from 'node:test';
import { createAccount } from '../../../server/auth/service.js';
import { db } from '../../../server/db/index.js';
import { chatState } from '../../../server/chat/state.js';
import { User } from '../../../server/chat/user.js';
import { loadUserSettings, updatePoints } from '../../../server/chat/backlog.js';
import { createSf2Runtime } from '../server/runtime.js';
import { gameClock } from '../../../tests/helpers/game-clock.mjs';

class Socket extends EventEmitter {
  packets = [];
  emit(event, data) {
    this.packets.push({ event, data });
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
    sf2 = createSf2Runtime({ timers: clock.timers });
  sf2.init(new Socket());
  for (let i = 0; i < 3; i++) {
    const unique = ++sequence;
    const { account } = await createAccount({
      email: `sf2-regression-${unique}@example.test`,
      pseudo: `SF2 ${unique}`,
      password: 'isolated-sf2-test-password',
    });
    const user = new User(account.id, { pseudo: account.pseudo }),
      socket = new Socket();
    user.points = 1000;
    user.clients.add(socket);
    chatState.users.set(account.id, user);
    updatePoints(account.id, 1000, 123);
    sf2.wire(socket, { user, accountId: account.id });
    players.push({ account, user, socket });
  }
  t.after(async () => {
    for (const room of [...sf2.sf2Mgr._rooms.values()])
      sf2.onUserDisconnect(room.players[0].accountId);
    await sf2.stop();
    assert.equal(clock.active.size, 0);
    chatState.users.clear();
  });
  players[0].socket.receive('sf2:create', { bet: 100 });
  const room = [...sf2.sf2Mgr._rooms.values()][0];
  return {
    sf2,
    clock,
    players,
    room,
    saved: () => players.map((player) => loadUserSettings(player.account.id).points),
    join() {
      players[1].socket.receive('sf2:join', { roomId: room.id });
    },
  };
}
test('SF2 outsider cannot cancel a funded waiting room', async (t) => {
  const value = await fixture(t);
  value.players[2].socket.receive('sf2:forfeit', { roomId: value.room.id });
  assert.strictEqual(value.sf2.sf2Mgr.getRoom(value.room.id), value.room);
});
test('SF2 actual waiting expiry refunds the creator', async (t) => {
  const value = await fixture(t);
  value.clock.fire(value.room._expireTimer);
  assert.deepEqual(value.saved(), [1000, 1000, 1000]);
});
test('SF2 last waiting disconnect refunds the current offline balance', async (t) => {
  const value = await fixture(t),
    id = value.players[0].account.id;
  chatState.users.delete(id);
  updatePoints(id, 800, 456);
  value.sf2.onUserDisconnect(id);
  assert.equal(loadUserSettings(id).points, 900);
  assert.equal(loadUserSettings(id).lastDailyBonus, 456);
});
test('SF2 outsider cannot relay inputs to participants', async (t) => {
  const value = await fixture(t);
  value.join();
  value.players[2].socket.receive('sf2:input', { roomId: value.room.id, input: { punch: true } });
  assert.equal(
    value.players[0].socket.packets.filter((packet) => packet.event === 'sf2:input').length,
    0,
  );
});
test('SF2 copied waiting expiry cannot erase a started duel', async (t) => {
  const value = await fixture(t),
    expire = value.room._expireTimer;
  value.join();
  value.clock.fire(expire);
  assert.strictEqual(value.sf2.sf2Mgr.getRoom(value.room.id), value.room);
  assert.deepEqual(value.saved(), [900, 900, 1000]);
});
