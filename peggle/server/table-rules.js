// @ts-check
import { randomInt } from 'node:crypto';
import { LEVELS, assignPegColors } from './levels.js';

// Every seat plays the same level in its own browser, then reports its score,
// as in the historical duels: the server trusts it within bounds.
const BOARD_HEIGHT = 464;
const MAX_SCORE = 10 ** 7;
const BALLS = 10;

/**
 * @typedef {{id:number, name:string, pegs:object[]}} PeggleLevel
 * @typedef {{level:PeggleLevel, scores:(number|null)[], forfeited:boolean[], isFinished:boolean}} PeggleTable
 */

/** @param {(max:number)=>number} random @returns {PeggleLevel} */
export function drawPeggleLevel(random = randomInt) {
  const level = LEVELS[random(LEVELS.length)];
  // The addon rows are Y-up; the browser engine draws Y-down.
  const pegs = level.pegs.map((/** @type {{y:number}} */ peg) => ({
    ...peg,
    y: BOARD_HEIGHT - peg.y,
  }));
  return { id: level.id, name: level.name, pegs: assignPegColors(pegs, random(2 ** 31 - 1)) };
}

/** @param {PeggleTable} state */
function evaluate(state) {
  const active = state.scores.flatMap((score, seat) =>
    state.forfeited[seat] ? [] : [{ seat, score }],
  );
  if (active.length > 1 && active.some((entry) => entry.score === null))
    return { ok: true, finished: false };
  state.isFinished = true;
  if (active.length === 1) return { ok: true, finished: true, winnerSeat: active[0].seat };
  const best = Math.max(...active.map((entry) => /** @type {number} */ (entry.score)));
  const leaders = active.filter((entry) => entry.score === best);
  // An equal best score refunds the round instead of choosing a winner.
  return { ok: true, finished: true, winnerSeat: leaders.length === 1 ? leaders[0].seat : null };
}

/** @param {{random?:(max:number)=>number, drawLevel?:()=>PeggleLevel}} [options] */
export function createPeggleRules({
  random = randomInt,
  drawLevel = () => drawPeggleLevel(random),
} = {}) {
  /** @type {import('../../platform/table-rounds.js').TableRules} */
  const rules = {
    timeoutMs: 15 * 60_000,
    create: (seats) => ({
      level: drawLevel(),
      scores: Array(seats).fill(null),
      forfeited: Array(seats).fill(false),
      isFinished: false,
    }),
    play(state, seat, move) {
      if (seat < 0 || seat >= state.scores.length) return { ok: false, error: 'not_in_game' };
      const { type, score } = /** @type {Record<string, unknown>} */ (move ?? {});
      if (type !== 'score' || typeof score !== 'number' || !Number.isFinite(score) || score < 0)
        return { ok: false, error: 'invalid_move' };
      if (state.forfeited[seat] || state.scores[seat] !== null)
        return { ok: false, error: 'already_scored' };
      state.scores[seat] = Math.min(MAX_SCORE, Math.round(score));
      return evaluate(state);
    },
    leave(state, seat) {
      if (seat < 0 || seat >= state.scores.length || state.forfeited[seat])
        return { ok: false, error: 'not_in_game' };
      state.forfeited[seat] = true;
      return evaluate(state);
    },
    snapshot: (state) => ({
      levelId: state.level.id,
      levelName: state.level.name,
      pegs: state.level.pegs.map((/** @type {object} */ peg) => ({ ...peg })),
      balls: BALLS,
      // Scores stay hidden until the round ends, like the historical duels.
      players: state.scores.map((score, seat) => ({
        seat,
        isDone: score !== null,
        hasForfeited: state.forfeited[seat],
        score: state.isFinished ? score : null,
      })),
    }),
  };
  return rules;
}

export const peggleRules = createPeggleRules();
