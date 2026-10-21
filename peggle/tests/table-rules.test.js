import test from 'node:test';
import assert from 'node:assert/strict';
import { createPeggleRules, drawPeggleLevel } from '../server/table-rules.js';

const level = { id: 3, name: 'Test', pegs: [{ x: 1, y: 2, type: 'orange' }] };
const rules = createPeggleRules({ drawLevel: () => level });

test('every Peggle seat plays one shared level drawn from the addon levels', () => {
  const drawn = drawPeggleLevel(() => 0);
  assert.ok(drawn.pegs.length > 0);
  assert.ok(
    drawn.pegs.every((peg) => peg.y >= 0 && peg.y <= 464),
    'pegs are flipped to the canvas',
  );
  assert.equal(drawn.pegs.filter((peg) => peg.type === 'orange').length, 25);
  const snapshot = rules.snapshot(rules.create(2));
  assert.deepEqual([snapshot.levelId, snapshot.levelName, snapshot.balls], [3, 'Test', 10]);
  snapshot.pegs[0].x = 99;
  assert.equal(level.pegs[0].x, 1, 'snapshots are copies');
});

test('Peggle scores stay hidden until every seat reported, then the best score wins', () => {
  const state = rules.create(3);
  assert.deepEqual(rules.play(state, 0, { type: 'score', score: 1200.4 }), {
    ok: true,
    finished: false,
  });
  assert.equal(rules.play(state, 0, { type: 'score', score: 9 }).error, 'already_scored');
  for (const move of [
    { type: 'score', score: -1 },
    { type: 'score', score: '9' },
    { score: 9 },
    null,
  ])
    assert.equal(rules.play(state, 1, move).error, 'invalid_move');
  const hidden = rules.snapshot(state).players;
  assert.deepEqual(
    hidden.map((player) => [player.isDone, player.score]),
    [
      [true, null],
      [false, null],
      [false, null],
    ],
  );
  rules.play(state, 1, { type: 'score', score: 5e9 });
  assert.deepEqual(rules.play(state, 2, { type: 'score', score: 50 }), {
    ok: true,
    finished: true,
    winnerSeat: 1,
  });
  assert.deepEqual(
    rules.snapshot(state).players.map((player) => player.score),
    [1200, 10 ** 7, 50],
  );
});

test('an equal best score refunds and a departure leaves the last player the pot', () => {
  const tie = rules.create(2);
  rules.play(tie, 0, { type: 'score', score: 70 });
  assert.equal(rules.play(tie, 1, { type: 'score', score: 70 }).winnerSeat, null);
  const duel = rules.create(2);
  assert.deepEqual(rules.leave(duel, 0), { ok: true, finished: true, winnerSeat: 1 });
  const three = rules.create(3);
  rules.leave(three, 2);
  rules.play(three, 0, { type: 'score', score: 10 });
  assert.equal(rules.play(three, 2, { type: 'score', score: 10 }).error, 'already_scored');
  assert.equal(rules.play(three, 1, { type: 'score', score: 11 }).winnerSeat, 1);
});
