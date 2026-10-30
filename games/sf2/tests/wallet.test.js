import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { EventEmitter } from 'node:events';
import { db } from '../../../server/db/index.js';
import { User } from '../../../server/chat/user.js';
import { gameClock } from '../../../tests/helpers/game-clock.mjs';
import { createSf2Runtime } from '../server/runtime.js';

class Socket extends EventEmitter {
  sent = [];
  emit(event, data) {
    this.sent.push({ event, data });
    return true;
  }
  receive(...args) {
    return super.emit(...args);
  }
  to() {
    return this;
  }
  join() {}
  leave() {}
}
after(() => db.close());
const seed = (id) => {
  db.prepare('INSERT INTO accounts VALUES (?,?,?,?,?,?,?)').run(
    id,
    id + '@invalid.test',
    id,
    id,
    'hash',
    1,
    1,
  );
  db.prepare(
    'INSERT INTO chat_user_settings (account_id,points,last_daily_bonus,updated_at) VALUES (?,777,987,1)',
  ).run(id);
  const user = new User(id, { pseudo: id });
  user.points = 1000;
  user.lastDailyBonus = 123;
  return user;
};
const saved = (id) =>
  db.prepare('SELECT points,last_daily_bonus FROM chat_user_settings WHERE account_id=?').get(id);
const newer = (id) =>
  db
    .prepare('UPDATE chat_user_settings SET points=888,last_daily_bonus=654 WHERE account_id=?')
    .run(id);
const cases = [
  // Table games pay through games/platform/tables.js (tables-accounting.test.js).
  // Worms checks the same contract in its add-on (ChaOS-addons, worms/tests/wallet.test.js).
  ['sf2', createSf2Runtime],
];
for (const [name, create] of cases)
  test(`default ${name} adapter debits current SQLite and refunds a later offline balance`, async (t) => {
    const id = 'default-' + name,
      user = seed(id),
      socket = new Socket(),
      users = new Map([[id, user]]),
      clock = gameClock();
    user.clients.add(socket);
    const runtime = create({
      users,
      timers: clock.timers,
      now: () => 1000,
      preload: () => Promise.resolve(),
      report() {},
      recordRound: () => true,
    });
    runtime.init(new Socket());
    if (runtime.ready) await runtime.ready();
    runtime.wire(socket, { user, accountId: id });
    t.after(async () => {
      runtime.onUserDisconnect(id);
      await runtime.stop();
      assert.equal(clock.active.size, 0);
    });
    socket.receive(name + ':create', { bet: 100, maxPlayers: 2, type: 'rps' });
    assert.deepEqual(saved(id), { points: 677, last_daily_bonus: 987 });
    assert.equal(user.points, 677);
    assert.equal(user.lastDailyBonus, 987);
    newer(id);
    users.delete(id);
    runtime.onUserDisconnect(id);
    assert.deepEqual(saved(id), { points: 988, last_daily_bonus: 654 });
    assert.equal(user.points, 677, 'departed cache is not rewritten');
  });
