// SF2 owns rooms/clocks, not money or simulation. Slot 0 still reports KOs.
import { EventEmitter } from 'node:events';
import { createFFAManager } from '../../platform/ffa-rooms.js';

export class SF2Manager extends EventEmitter {
  constructor({ timers = { setTimeout, clearTimeout }, beforeStart = () => true } = {}) {
    super();
    this.timers = timers;
    this.beforeStart = beforeStart;
    this.accepting = true;
    const base = createFFAManager({
      timers,
      waitTimeoutMs: 180000,
      defaultMax: 2,
      timerKeys: ['_expireTimer', '_timer'],
      _publicRoom: (room) => this._pub(room),
      mkRoom: (id, player, bet) => ({
        id,
        state: 'waiting',
        bet,
        maxPlayers: 2,
        players: [{ ...player, slot: 0 }],
        wins: [0, 0],
        round: 1,
        _expireTimer: null,
        _timer: null,
        _settlementPending: false,
      }),
    });
    this.base = base;
    this._rooms = base._rooms;
    this.getRoom = base.getRoom;
    this.closeRoom = base.closeRoom;
    this.openRooms = base.openRooms;
    this.liveRooms = base.liveRooms;
    base.on('room:expired', (payload) => this.emit('room:expired', payload));
  }
  quiesce() {
    this.accepting = false;
  }
  findPlayerRoom(id) {
    return (
      [...this._rooms.values()].find(
        (room) =>
          (room.state !== 'done' || room._settlementPending) &&
          room.players.some((player) => player.accountId === id),
      ) ?? null
    );
  }
  _sanitizeChar(char, fallback) {
    return (
      ['Ryu', 'Ken'].find(
        (value) => typeof char === 'string' && value.toLowerCase() === char.toLowerCase(),
      ) ?? fallback
    );
  }
  _pub(room) {
    return {
      roomId: room.id,
      state: room.state,
      bet: room.bet,
      players: room.players.map(({ userId, pseudo, color, slot, char }) => ({
        userId,
        pseudo,
        color,
        slot,
        char,
      })),
      wins: [...room.wins],
      round: room.round,
    };
  }
  createRoom(player, bet, char) {
    if (!this.accepting) return { ok: false, error: 'unavailable' };
    if (!Number.isSafeInteger(bet) || bet < 0 || bet > Math.floor(Number.MAX_SAFE_INTEGER / 8))
      return { ok: false, error: 'invalid_bet' };
    if (this.findPlayerRoom(player.accountId)) return { ok: false, error: 'already_in_room' };
    return this.base.createRoom({ ...player, char: this._sanitizeChar(char, 'Ryu') }, bet, 2);
  }
  _roundClock(room, round) {
    const handle = this.timers.setTimeout(() => {
      if (
        this.getRoom(room.id) !== room ||
        room.state !== 'playing' ||
        room.round !== round ||
        room._timer !== handle
      )
        return;
      room._timer = null;
      this._finish(room);
      this.emit('room:round_timeout', { roomId: room.id, players: room.players, bet: room.bet });
    }, 110000);
    return handle;
  }
  joinRoom(player, roomId, char, fund = () => ({ ok: true })) {
    if (!this.accepting) return { ok: false, error: 'unavailable' };
    const room = this.getRoom(roomId);
    if (!room) return { ok: false, error: 'not_found' };
    if (room.state !== 'waiting' || room.players.length !== 1)
      return { ok: false, error: 'already_started' };
    if (room.players[0].accountId === player.accountId)
      return { ok: false, error: 'cannot_join_own' };
    if (this.findPlayerRoom(player.accountId)) return { ok: false, error: 'already_in_room' };
    let timer;
    try {
      timer = this._roundClock(room, 1);
    } catch {
      return { ok: false, error: 'timer_unavailable' };
    }
    let committed = false;
    try {
      room.players.push({ ...player, slot: 1, char: this._sanitizeChar(char, 'Ken') });
      const result = fund(room);
      if (result && typeof result.then === 'function') {
        Promise.resolve(result).catch(() => {});
        throw new Error('SF2_ASYNC_FUNDING');
      }
      if (result?.ok !== true) {
        if (result?.error === 'insufficient_balance') room.players.pop();
        return result;
      }
      if (this.getRoom(roomId) !== room || !this.beforeStart(room))
        return { ok: false, error: 'settlement_pending' };
      this.timers.clearTimeout(room._expireTimer);
      room._expireTimer = null;
      room.state = 'playing';
      room._timer = timer;
      committed = true;
      return { ok: true, room, public: this._pub(room) };
    } finally {
      if (!committed) this.timers.clearTimeout(timer);
    }
  }
  relayInput(id, roomId) {
    const room = this.getRoom(roomId);
    if (room?.state !== 'playing' || !room.players.some((player) => player.accountId === id))
      return null;
    return room.players.find((player) => player.accountId !== id)?.accountId ?? null;
  }
  _finish(room) {
    room.state = 'done';
    room._settlementPending = true;
    this.closeRoom(room.id);
  }
  reportRoundEnd(id, roomId, loserSlot) {
    const room = this.getRoom(roomId);
    if (
      room?.state !== 'playing' ||
      room.players[0].accountId !== id ||
      (loserSlot !== 0 && loserSlot !== 1)
    )
      return { ok: false };
    const winnerSlot = 1 - loserSlot,
      wins = [...room.wins];
    wins[winnerSlot]++;
    let next;
    if (wins[winnerSlot] < 2) {
      try {
        next = this._roundClock(room, room.round + 1);
      } catch {
        return { ok: false, error: 'timer_unavailable' };
      }
    }
    this.timers.clearTimeout(room._timer);
    room._timer = next ?? null;
    room.wins = wins;
    if (wins[winnerSlot] >= 2) {
      this._finish(room);
      return {
        ok: true,
        type: 'game_over',
        winner: room.players[winnerSlot],
        loser: room.players[loserSlot],
        wins: [...wins],
        bet: room.bet,
        round: room.round,
      };
    }
    room.round++;
    return { ok: true, type: 'next_round', round: room.round, wins: [...wins] };
  }
  forfeit(id, roomId) {
    const room = this.getRoom(roomId);
    if (!room) return { ok: false, error: 'not_found' };
    if (!room.players.some((player) => player.accountId === id))
      return { ok: false, error: 'not_in_room' };
    if (room.state === 'waiting') {
      this.closeRoom(room.id);
      return { ok: true, type: 'cancelled', bet: room.bet, player: room.players[0] };
    }
    if (room.state !== 'playing') return { ok: false, error: 'not_playing' };
    this._finish(room);
    return {
      ok: true,
      type: 'forfeit',
      winner: room.players.find((player) => player.accountId !== id),
      loser: room.players.find((player) => player.accountId === id),
      bet: room.bet,
    };
  }
}
