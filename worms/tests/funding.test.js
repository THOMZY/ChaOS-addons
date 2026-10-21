import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createAccount } from '../../../server/auth/service.js';
import { db } from '../../../server/db/index.js';
import { chatState } from '../../../server/chat/state.js';
import { User } from '../../../server/chat/user.js';
import { loadUserSettings, updatePoints } from '../../../server/chat/backlog.js';
import { createWormsRuntime } from '../server/runtime.js';

class Socket extends EventEmitter {
  emit() { return true; }
  receive(event, data) { return super.emit(event, data); }
}
test('worms offline waiting creator receives its confirmed refund on the latest SQLite balance', async t => {
  const { account } = await createAccount({ email: 'worms-regression@example.test', pseudo: 'Worms Regression', password: 'isolated-worms-test-password' });
  const user = new User(account.id, { pseudo: account.pseudo }), socket = new Socket();
  user.points = 1000; user.clients.add(socket); chatState.users.set(account.id, user); updatePoints(account.id, 1000, 123);
  const worms = createWormsRuntime({ preload: () => Promise.resolve() });
  worms.init(new Socket()); await worms.ready();
  worms.wire(socket, { user, accountId: account.id });
  t.after(async () => { await worms.stop(); chatState.users.clear(); db.close(); });
  socket.receive('worms:create', { bet: 100, maxPlayers: 8 }); assert.equal(loadUserSettings(account.id).points, 900);
  chatState.users.delete(account.id); updatePoints(account.id, 800, 456); worms.onUserDisconnect(account.id);
  assert.equal(loadUserSettings(account.id).points, 900); assert.equal(loadUserSettings(account.id).lastDailyBonus, 456);
});
