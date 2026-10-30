// MUGEN paid duels. Ikemen GO plays the match in both browsers; the server
// only seats two players, keeps their stakes and settles on what both engines
// report. One honest report beats a silent opponent; two reports that disagree
// refund both players.
import { EventEmitter } from 'node:events';
import { createFFAManager } from '../../platform/ffa-rooms.js';

export const WAITING_TIMEOUT_MS = 180_000;
export const SELECTION_TIMEOUT_MS = 120_000;
export const MATCH_TIMEOUT_MS = 20 * 60_000;
export const RESULT_GRACE_MS = 30_000;

const MAX_BET = Math.floor(Number.MAX_SAFE_INTEGER / 8);

export class MugenManager extends EventEmitter {
  constructor({
    timers = { setTimeout, clearTimeout },
    now = Date.now,
    beforeStart = () => true,
  } = {}) {
    super();
    this.timers = timers;
    this.now = now;
    this.beforeStart = beforeStart;
    this.accepting = true;
    const base = createFFAManager({
      timers,
      waitTimeoutMs: WAITING_TIMEOUT_MS,
      defaultMax: 2,
      timerKeys: ['_expireTimer', '_timer'],
      _publicRoom: (room) => this._pub(room),
      mkRoom: (id, player, bet) => ({
        id,
        state: 'waiting',
        bet,
        maxPlayers: 2,
        players: [{ ...player, slot: 0, character: null }],
        stage: null,
        results: [null, null],
        _expireTimer: null,
        _timer: null,
        _settlementPending: false,
      }),
    });
    this.duel = base;
    this._rooms = base._rooms;
    this.getRoom = base.getRoom;
    this.closeRoom = base.closeRoom;
    this.openRooms = base.openRooms;
    this.liveRooms = () =>
      [...this._rooms.values()]
        .filter((room) => room.state === 'playing')
        .map((room) => this._pub(room));
    base.on('room:expired', (payload) => this.emit('room:expired', payload));
  }

  quiesce() {
    this.accepting = false;
  }

  findPlayerRoom(accountId) {
    return (
      [...this._rooms.values()].find(
        (room) =>
          (room.state !== 'done' || room._settlementPending) &&
          room.players.some((player) => player.accountId === accountId),
      ) ?? null
    );
  }

  createRoom(player, bet) {
    if (!this.accepting) return { ok: false, error: 'unavailable' };
    if (!Number.isSafeInteger(bet) || bet < 0 || bet > MAX_BET)
      return { ok: false, error: 'invalid_bet' };
    if (this.findPlayerRoom(player.accountId)) return { ok: false, error: 'already_in_room' };
    return this.duel.createRoom(player, bet, 2);
  }

  // A stale callback (room replaced, state moved on, timer re-armed) must do nothing.
  _schedule(room, delay, state, callback) {
    const handle = this.timers.setTimeout(() => {
      if (this.getRoom(room.id) !== room || room.state !== state || room._timer !== handle) return;
      room._timer = null;
      callback();
    }, delay);
    return handle;
  }

  joinRoom(player, roomId, fund = () => ({ ok: true })) {
    if (!this.accepting) return { ok: false, error: 'unavailable' };
    const room = this.getRoom(roomId);
    if (!room) return { ok: false, error: 'not_found' };
    if (room.state !== 'waiting' || room.players.length !== 1)
      return { ok: false, error: 'already_started' };
    if (room.players[0].accountId === player.accountId)
      return { ok: false, error: 'cannot_join_own' };
    if (this.findPlayerRoom(player.accountId)) return { ok: false, error: 'already_in_room' };
    let selection;
    try {
      selection = this._schedule(room, SELECTION_TIMEOUT_MS, 'lobby', () =>
        this._expire(room, 'selection_timeout'),
      );
    } catch {
      return { ok: false, error: 'timer_unavailable' };
    }
    let committed = false;
    try {
      room.players.push({ ...player, slot: 1, character: null });
      const result = fund(room);
      if (result && typeof result.then === 'function') {
        Promise.resolve(result).catch(() => {});
        throw new Error('MUGEN_ASYNC_FUNDING');
      }
      if (result?.ok !== true) {
        if (result?.error === 'insufficient_balance') room.players.pop();
        return result;
      }
      if (this.getRoom(roomId) !== room || !this.beforeStart(room))
        return { ok: false, error: 'settlement_pending' };
      this.timers.clearTimeout(room._expireTimer);
      room._expireTimer = null;
      room.state = 'lobby';
      room._timer = selection;
      committed = true;
      return { ok: true, public: this._pub(room) };
    } finally {
      if (!committed) this.timers.clearTimeout(selection);
    }
  }

  _expire(room, reason) {
    this.closeRoom(room.id);
    this.emit('room:expired', {
      roomId: room.id,
      players: [...room.players],
      bet: room.bet,
      reason,
    });
  }

  // Each player picks their own fighter; the creator also picks the stage.
  selectCharacter(accountId, roomId, character, stage) {
    const room = this.getRoom(roomId);
    if (!room || !['waiting', 'lobby'].includes(room.state)) return { ok: false };
    const slot = this._slot(room, accountId);
    if (slot < 0 || room.players[slot].character) return { ok: false };
    room.players[slot].character = character;
    if (slot === 0) room.stage = stage ?? null;
    const bothPicked =
      room.players.length === 2 && room.players.every((player) => player.character);
    if (!bothPicked) return { ok: true, slot, started: false, public: this._pub(room) };
    if (!this.beforeStart(room)) return { ok: false };
    const deadline = this._schedule(room, MATCH_TIMEOUT_MS, 'playing', () =>
      this._expire(room, 'match_timeout'),
    );
    this.timers.clearTimeout(room._timer);
    room._timer = deadline;
    room.state = 'playing';
    room.startedAt = this.now();
    return { ok: true, slot, started: true, public: this._pub(room) };
  }

  // outcome: { winSide: 0 | 1 } from an engine that finished, { aborted: true } otherwise.
  reportResult(accountId, roomId, outcome) {
    const room = this.getRoom(roomId);
    if (!room || room.state !== 'playing') return { ok: false };
    const slot = this._slot(room, accountId);
    if (slot < 0 || room.results[slot]) return { ok: false };
    room.results[slot] = outcome;
    const other = room.results[1 - slot];
    if (!other) {
      const grace = this._schedule(room, RESULT_GRACE_MS, 'playing', () =>
        this.emit('room:decided', this._decide(room)),
      );
      this.timers.clearTimeout(room._timer);
      room._timer = grace;
      return { ok: true, decided: null };
    }
    return { ok: true, decided: this._decide(room) };
  }

  _decide(room) {
    const reports = room.results.filter(Boolean);
    const agreed =
      reports.length > 0 &&
      reports.every((report) => !report.aborted && report.winSide === reports[0].winSide);
    room.state = 'done';
    room._settlementPending = true;
    this.closeRoom(room.id);
    if (!agreed)
      return { roomId: room.id, type: 'refund', bet: room.bet, players: [...room.players] };
    const winnerSlot = reports[0].winSide;
    return {
      roomId: room.id,
      type: 'win',
      winner: room.players[winnerSlot],
      loser: room.players[1 - winnerSlot],
      bet: room.bet,
    };
  }

  forfeit(accountId, roomId) {
    const room = this.getRoom(roomId),
      slot = room ? this._slot(room, accountId) : -1;
    if (
      slot < 0 ||
      room._settlementPending ||
      !['waiting', 'lobby', 'playing'].includes(room.state)
    )
      return { ok: false };
    const cancelled = room.state !== 'playing';
    if (!cancelled) {
      room.state = 'done';
      room._settlementPending = true;
    }
    this.closeRoom(roomId);
    return cancelled
      ? { ok: true, cancelled, bet: room.bet, players: [...room.players] }
      : {
          ok: true,
          cancelled,
          winner: room.players[1 - slot],
          loser: room.players[slot],
          bet: room.bet,
        };
  }

  opponentOf(accountId, roomId) {
    const room = this.getRoom(roomId);
    if (!room || room.state !== 'playing') return null;
    const slot = this._slot(room, accountId);
    return slot < 0 ? null : room.players[1 - slot];
  }

  _slot(room, accountId) {
    return room.players.findIndex((player) => player.accountId === accountId);
  }

  _pub(room) {
    return {
      id: room.id,
      state: room.state,
      bet: room.bet,
      players: room.players.map(({ accountId: _accountId, ...rest }) => rest),
      stage: room.stage ?? null,
    };
  }
}
