// Fighting: paid duel lifecycle and client-assisted health arbitration.
// The room primitive is capped at two seats; other duel games are not changed.
import { EventEmitter } from 'node:events';
import { createFFAManager } from '../../platform/ffa-rooms.js';
export { SandboxManager } from './sandbox-model.js';

export class FightingManager extends EventEmitter {
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
      waitTimeoutMs: 180000,
      defaultMax: 2,
      timerKeys: ['_expireTimer', '_timer', '_readyTimer'],
      _publicRoom: (room) => this._pub(room),
      mkRoom: (id, player, bet) => ({
        id,
        state: 'waiting',
        bet,
        maxPlayers: 2,
        players: [{ ...player, slot: 0, char: null, defFile: null }],
        health: [100, 100],
        round: 1,
        wins: [0, 0],
        lastHit: [0, 0],
        _expireTimer: null,
        _timer: null,
        _readyTimer: null,
        _readySlots: null,
        _roundReadySlots: null,
        stage: null,
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
        .filter((room) => ['loading', 'playing'].includes(room.state))
        .map((room) => this._pub(room));
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
  createRoom(player, bet) {
    if (!this.accepting) return { ok: false, error: 'unavailable' };
    if (!Number.isSafeInteger(bet) || bet < 0 || bet > Math.floor(Number.MAX_SAFE_INTEGER / 8))
      return { ok: false, error: 'invalid_bet' };
    if (this.findPlayerRoom(player.accountId)) return { ok: false, error: 'already_in_room' };
    return this.duel.createRoom(player, bet, 2);
  }
  _schedule(room, key, delay, state, callback, round = room.round) {
    const handle = this.timers.setTimeout(() => {
      if (
        this.getRoom(room.id) !== room ||
        room.state !== state ||
        room[key] !== handle ||
        room.round !== round
      )
        return;
      room[key] = null;
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
    let lobby;
    try {
      lobby = this._schedule(room, '_timer', 60000, 'lobby', () => this._expireLobby(room));
    } catch {
      return { ok: false, error: 'timer_unavailable' };
    }
    let committed = false;
    try {
      room.players.push({ ...player, slot: 1, char: null, defFile: null });
      const result = fund(room);
      if (result && typeof result.then === 'function') {
        Promise.resolve(result).catch(() => {});
        throw new Error('FIGHTING_ASYNC_FUNDING');
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
      room._timer = lobby;
      committed = true;
      return { ok: true, public: this._pub(room) };
    } finally {
      if (!committed) this.timers.clearTimeout(lobby);
    }
  }
  _expireLobby(room) {
    this.closeRoom(room.id);
    this.emit('room:expired', {
      roomId: room.id,
      players: [...room.players],
      bet: room.bet,
      reason: 'lobby_timeout',
    });
  }
  selectChar(accountId, roomId, char, defFile, stage) {
    const room = this.getRoom(roomId);
    if (!room || !['waiting', 'lobby'].includes(room.state)) return { ok: false };
    const slot = this._slot(room, accountId);
    if (slot < 0) return { ok: false };
    room.players[slot].char = char || null;
    room.players[slot].defFile = defFile || null;
    if (slot === 0 && stage && typeof stage.folder === 'string') {
      room.stage = {
        folder: stage.folder.slice(0, 100),
        defFile: typeof stage.defFile === 'string' ? stage.defFile.slice(0, 128) : '',
        sffFile: typeof stage.sffFile === 'string' ? stage.sffFile.slice(0, 128) : '',
      };
    }
    const bothReady = room.players.length === 2 && room.players.every((player) => player.char);
    if (bothReady) {
      if (!this.beforeStart(room)) return { ok: false };
      const fallback = this._schedule(room, '_readyTimer', 30000, 'loading', () =>
        this._forceBegin(room),
      );
      this.timers.clearTimeout(room._timer);
      this.timers.clearTimeout(room._expireTimer);
      room._timer = room._expireTimer = null;
      room.state = 'loading';
      room._readySlots = new Set();
      room._readyTimer = fallback;
    }
    return { ok: true, slot, bothReady: !!bothReady, public: this._pub(room) };
  }
  _beginRound(room) {
    if (!this.beforeStart(room)) return false;
    const roundTimer = this._schedule(room, '_timer', 60000, 'playing', () =>
      this._handleTimeOver(room.id),
    );
    this.timers.clearTimeout(room._readyTimer);
    this.timers.clearTimeout(room._timer);
    room._readyTimer = null;
    room._readySlots = room._roundReadySlots = null;
    room.state = 'playing';
    room._timer = roundTimer;
    return true;
  }
  _forceBegin(room) {
    if (this._beginRound(room)) this.emit('room:force_begin', { roomId: room.id });
  }
  markReady(accountId, roomId) {
    const room = this.getRoom(roomId),
      slot = room ? this._slot(room, accountId) : -1;
    if (slot < 0) return { ok: false };
    const slots =
      room.state === 'loading'
        ? room._readySlots
        : room.state === 'playing'
          ? room._roundReadySlots
          : null;
    if (!slots) return { ok: false };
    slots.add(slot);
    return {
      ok: true,
      bothReady: slots.size >= room.players.length ? this._beginRound(room) : false,
    };
  }
  relayInput(accountId, roomId) {
    const room = this.getRoom(roomId);
    if (!room || room.state !== 'playing' || room._roundReadySlots) return { ok: false };
    const slot = this._slot(room, accountId);
    return slot < 0
      ? { ok: false }
      : { ok: true, opponentAccountId: room.players[1 - slot].accountId };
  }
  reportHit(accountId, roomId, targetSlot, attackerX, targetX, clientDamage) {
    const room = this.getRoom(roomId);
    if (!room || room.state !== 'playing' || room._roundReadySlots) return { ok: false };
    const slot = this._slot(room, accountId);
    if (slot < 0 || targetSlot !== 1 - slot) return { ok: false };
    if (
      [attackerX, targetX, clientDamage].some(
        (value) => typeof value === 'number' && !Number.isFinite(value),
      )
    )
      return { ok: false };
    const now = this.now();
    if (now - room.lastHit[slot] < 300) return { ok: false };
    if (
      typeof attackerX === 'number' &&
      typeof targetX === 'number' &&
      Math.abs(attackerX - targetX) > 200
    )
      return { ok: false };
    const damage = Math.max(
      1,
      Math.min(100, typeof clientDamage === 'number' && clientDamage > 0 ? clientDamage : 15),
    );
    room.lastHit[slot] = now;
    room.health[targetSlot] = Math.max(0, room.health[targetSlot] - damage);
    return {
      ok: true,
      health: [...room.health],
      roundOver: room.health[targetSlot] === 0,
      loserSlot: room.health[targetSlot] === 0 ? targetSlot : -1,
      damage,
    };
  }
  nextRound(roomId, loserSlot) {
    const room = this.getRoom(roomId);
    if (
      !room ||
      room.state !== 'playing' ||
      room._roundReadySlots ||
      (loserSlot !== 0 && loserSlot !== 1)
    )
      return null;
    const winnerSlot = 1 - loserSlot,
      wins = [...room.wins];
    wins[winnerSlot]++;
    if (wins[winnerSlot] >= 2) {
      room.wins = wins;
      room.state = 'done';
      room._settlementPending = true;
      this.closeRoom(roomId);
      return {
        type: 'game_over',
        winner: room.players[winnerSlot],
        loser: room.players[loserSlot],
        wins,
        bet: room.bet,
      };
    }
    const fallback = this._schedule(
      room,
      '_readyTimer',
      15000,
      'playing',
      () => this._forceBegin(room),
      room.round + 1,
    );
    this.timers.clearTimeout(room._timer);
    this.timers.clearTimeout(room._readyTimer);
    room._timer = null;
    room.wins = wins;
    room.round++;
    room.health = [100, 100];
    room.lastHit = [0, 0];
    room._roundReadySlots = new Set();
    room._readyTimer = fallback;
    return { type: 'next_round', round: room.round, wins: [...wins] };
  }
  forfeit(accountId, roomId) {
    const room = this.getRoom(roomId),
      slot = room ? this._slot(room, accountId) : -1;
    if (
      slot < 0 ||
      room._settlementPending ||
      !['waiting', 'lobby', 'loading', 'playing'].includes(room.state)
    )
      return { ok: false };
    const cancelled = room.state === 'waiting' || room.state === 'lobby';
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
  _slot(room, id) {
    return room.players.findIndex((player) => player.accountId === id);
  }
  _handleTimeOver(roomId) {
    const room = this.getRoom(roomId);
    if (!room || room.state !== 'playing' || room._roundReadySlots) return;
    this.emit('room:timeout', {
      roomId,
      loserSlot: room.health[0] >= room.health[1] ? 1 : 0,
      players: room.players,
      bet: room.bet,
    });
  }
  _pub(room) {
    return {
      id: room.id,
      state: room.state,
      bet: room.bet,
      round: room.round,
      wins: [...room.wins],
      health: [...room.health],
      players: room.players.map(({ accountId: _, ...rest }) => rest),
      stage: room.stage ?? null,
    };
  }
}
