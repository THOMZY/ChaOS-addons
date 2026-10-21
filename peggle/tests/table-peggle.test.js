import test from 'node:test';
import assert from 'node:assert/strict';
// Registers the Peggle rules with the shared tables, as the site does at boot.
import '../server/index.js';
import { createTableRuntime } from '../../platform/table-runtime.js';
import { gameClock } from '../../../tests/helpers/game-clock.mjs';

test('a funded Peggle table hides scores until both runs end, then pays the best score', async () => {
  const clock = gameClock(),
    events = [];
  const users = new Map(
    ['alice', 'bob', 'eve'].map((id) => [id, { userId: `public-${id}`, pseudo: id, points: 100 }]),
  );
  const runtime = createTableRuntime({
    users,
    timers: clock.timers,
    logger: { error() {} },
    change: (id, delta) => ({ points: users.get(id).points + delta, lastDailyBonus: 0 }),
  });
  runtime.init({ emit: (event, payload) => events.push({ event, payload }) });
  const table = runtime.tables.create('eve', { gameId: 'peggle', bet: 10, seats: 2 }).table;
  runtime.tables.sit(table.id, 'alice', 0, 1);
  runtime.tables.sit(table.id, 'bob', 1, 1);
  const running = runtime.list()[0];
  assert.equal(running.phase, 'running');
  assert.ok(running.game.pegs.length > 0, 'both seats receive the same level');
  assert.equal(runtime.tables.move(table.id, 'alice', 1, { type: 'score', score: 4000 }).ok, true);
  const hidden = events.findLast((event) => event.event === 'tables:update').payload[0];
  assert.deepEqual(
    hidden.game.players.map((player) => [player.isDone, player.score]),
    [
      [true, null],
      [false, null],
    ],
    'a finished run does not reveal its score to the other seat',
  );
  runtime.tables.move(table.id, 'bob', 1, { type: 'score', score: 3000 });
  assert.deepEqual(runtime.list()[0].result, { winnerSeat: 0, reason: 'played' });
  assert.deepEqual(
    runtime.list()[0].game.players.map((player) => player.score),
    [4000, 3000],
  );
  assert.deepEqual(
    [...users.values()].map((user) => user.points),
    [110, 90, 100],
  );
  await runtime.stop();
  assert.equal(clock.active.size, 0);
});
