import { FightingManager } from './model.js';
import { createSandboxRuntime } from './sandbox-runtime.js';
import { chatState } from '../../../server/chat/state.js';
import { db } from '../../../server/db/index.js';
import { createPointsStore } from '../../../server/chat/points-store.js';
import { createCasinoWallet } from '../../platform/casino-wallet.js';
import { createRoomStakes } from '../../platform/room-stakes.js';
import { createGameLifecycle } from '../../platform/game-lifecycle.js';

export function createFightingRuntime({
  users = chatState.users,
  timers,
  now = Date.now,
  timeoutMs,
  report,
  wallet = createCasinoWallet({
    users,
    change: createPointsStore({ db }).change,
    codePrefix: 'FIGHTING',
  }),
} = {}) {
  let fightMgr, stopping;
  const pendingResults = new Set(),
    wired = new WeakSet();
  const sandbox = createSandboxRuntime({ users, timers, timeoutMs, report }),
    sbMgr = sandbox.sbMgr;
  const lifecycle = createGameLifecycle({
    name: 'fighting',
    codePrefix: 'FIGHTING',
    timers,
    timeoutMs,
    report,
    quiesce: () => fightMgr.quiesce(),
    pending: () => stakes.pending() || pendingResults.size > 0 || fightMgr._rooms.size > 0,
    finish() {
      fightSpectators.clear();
    },
  });
  const stakes = createRoomStakes({ wallet, report: (code) => lifecycle.fail('FIGHTING_' + code) });
  fightMgr = new FightingManager({
    timers: lifecycle.timers,
    now,
    beforeStart: (room) => stakes.ready(room),
  });
  const roomIdFromPayload = (payload) =>
    typeof payload?.roomId === 'string' && payload.roomId.length <= 20 ? payload.roomId : null;
  function emitToRoomPlayers(room, event, payload) {
    _emitToFightPlayers(room.players, event, payload);
  }
  function notify(id) {
    const user = users.get(id);
    if (user) _emitToUserClients(id, 'points:update', { balance: user.points });
  }
  function charge(room, id) {
    const result = stakes.charge(room, id);
    if (result.ok) notify(id);
    return result;
  }
  function admit(socket) {
    if (fightMgr.accepting) return true;
    socket.emit('fighting:error', { error: 'unavailable' });
    return false;
  }
  function removeSpectator(socket) {
    for (const [id, sockets] of fightSpectators) {
      sockets.delete(socket);
      if (!sockets.size) fightSpectators.delete(id);
    }
  }
  const fightSpectators = new Map();

  let _ns = null;

  function init(ns) {
    if (lifecycle.status().stopped) return false;
    if (_ns === ns && ns) return true;
    if (_ns) throw new Error('FIGHTING_ALREADY_INITIALIZED');
    if (!ns || typeof ns.emit !== 'function') throw new TypeError('FIGHTING_INVALID_NAMESPACE');
    return lifecycle.run(() => {
      _ns = ns;

      lifecycle.listen(fightMgr, 'room:timeout', ({ roomId, loserSlot, players }) => {
        if (!_ns) return;
        const result = fightMgr.nextRound(roomId, loserSlot);
        _settleFightRound(roomId, result, players);
      });

      lifecycle.listen(fightMgr, 'room:expired', ({ roomId }) => {
        const room = stakes.roomById(roomId);
        if (room && !fightMgr.getRoom(roomId) && ['waiting', 'lobby'].includes(room.state))
          cancel(room);
      });

      lifecycle.listen(fightMgr, 'room:force_begin', ({ roomId }) => {
        if (!_ns) return;
        const room = fightMgr.getRoom(roomId);
        if (!room) return;
        emitToRoomPlayers(room, 'fighting:begin', {});
      });
      sandbox.init(ns);
      return true;
    });
  }

  // ── Internal helpers ────────────────────────────────────────────────────────

  function _settleFightRound(roomId, result, players) {
    if (!result) return;
    if (result.type === 'game_over') {
      _settleFightGame(roomId, result);
    } else if (result.type === 'next_round') {
      for (const p of players) {
        const u = users.get(p.accountId);
        if (u) for (const sock of u.clients) sock.emit('fighting:next_round', result);
      }
      const specs = fightSpectators.get(roomId);
      if (specs) for (const s of specs) s.emit('fighting:next_round', result);
    }
  }

  function _settleFightGame(roomId, { winner, loser, wins, bet }) {
    const room = stakes.roomById(roomId);
    if (
      !room ||
      room.state !== 'done' ||
      !room._settlementPending ||
      pendingResults.has(room) ||
      stakes.canReplace(room)
    )
      return false;
    pendingResults.add(room);
    room._settlementPending = true;
    if (!stakes.settle(room, winner)) throw lifecycle.fail('FIGHTING_SETTLEMENT_FAILED');
    for (const player of room.players) notify(player.accountId);
    const pot = bet * 2;
    const payload = {
      winner: winner ? { userId: winner.userId, pseudo: winner.pseudo, color: winner.color } : null,
      loser: loser ? { userId: loser.userId, pseudo: loser.pseudo } : null,
      wins,
      payout: pot,
    };
    _emitToFightPlayers(room.players, 'fighting:game_over', payload);
    _emitToFightSpectators(roomId, 'fighting:game_over', payload);
    fightSpectators.delete(roomId);
    _ns.emit('fighting:live_closed', { roomId });
    if (winner)
      _ns.emit('bot', {
        kind: 'bot',
        pseudo: 'fight',
        color: '#ff6a3d',
        date: now(),
        translationKey: bet > 0 ? 'chat.game.fightingWinBet' : 'chat.game.fightingWin',
        translationValues: { winner: winner.pseudo, loser: loser?.pseudo ?? '?', pot },
      });
    room._settlementPending = false;
    pendingResults.delete(room);
    return true;
  }
  function _emitToUserClients(accountId, event, payload) {
    const u = users.get(accountId);
    if (u) for (const sock of u.clients) sock.emit(event, payload);
  }

  function _emitToFightPlayers(players, event, payloadForPlayer) {
    players.forEach((p, slot) => {
      const payload =
        typeof payloadForPlayer === 'function' ? payloadForPlayer(p, slot) : payloadForPlayer;
      _emitToUserClients(p.accountId, event, payload);
    });
  }

  function _emitToFightSpectators(roomId, event, payload) {
    const specs = fightSpectators.get(roomId);
    if (specs) for (const s of specs) s.emit(event, payload);
  }

  function _broadcastFightHealth(roomId, room, health) {
    const payload = { health };
    _emitToFightPlayers(room.players, 'fighting:health', payload);
    _emitToFightSpectators(roomId, 'fighting:health', payload);
  }

  function _emitCharPick(room, slot, char, defFile, preview = false) {
    const payload = { slot, char, defFile: defFile ?? null };
    if (preview) payload.preview = true;
    _emitToFightPlayers(room.players, 'fighting:char_picked', payload);
  }

  function _startSelectedFight(roomId, room, pub) {
    _ns.emit('fighting:live_open', pub);
    const chars = pub.players.map((p) => p.char);
    _emitToFightPlayers(room.players, 'fighting:start', (_p, slot) => ({
      roomId,
      slot,
      players: pub.players,
      health: pub.health,
      round: pub.round,
      wins: pub.wins,
      chars,
      stage: pub.stage ?? null,
    }));
  }

  function _hitPayload(payload) {
    return {
      roomId: typeof payload?.roomId === 'string' ? payload.roomId : null,
      targetSlot: typeof payload?.targetSlot === 'number' ? payload.targetSlot : -1,
      damage: typeof payload?.damage === 'number' ? payload.damage : 0,
      attackerX: typeof payload?.attackerX === 'number' ? payload.attackerX : null,
      targetX: typeof payload?.targetX === 'number' ? payload.targetX : null,
    };
  }

  function _refundFightPlayers(room) {
    if (!stakes.roomById(room.id)) return;
    for (const player of room.players) {
      if (!stakes.refund(room, player.accountId).ok) throw lifecycle.fail('FIGHTING_REFUND_FAILED');
      notify(player.accountId);
    }
  }
  function cancel(room, leavingId) {
    pendingResults.add(room);
    _refundFightPlayers(room);
    _notifyFightCancelled(room.players, leavingId);
    _ns.emit('fighting:closed', { roomId: room.id });
    fightSpectators.delete(room.id);
    pendingResults.delete(room);
  }
  function forfeit(room, accountId) {
    const result = fightMgr.forfeit(accountId, room.id);
    if (!result.ok) return result;
    if (result.cancelled) cancel(room, accountId);
    else if (_settleFightGame(room.id, { ...result, wins: [0, 0] })) _emitForfeitResult(result);
    return result;
  }
  function _notifyFightCancelled(players, accountId) {
    for (const p of players || []) {
      if (p.accountId !== accountId) _emitToUserClients(p.accountId, 'fighting:cancelled', {});
    }
  }

  function _emitForfeitResult(result) {
    const payload = {
      winner: { userId: result.winner.userId, pseudo: result.winner.pseudo },
      loser: { userId: result.loser.userId, pseudo: result.loser.pseudo },
    };
    for (const p of [result.winner, result.loser].filter(Boolean)) {
      _emitToUserClients(p.accountId, 'fighting:forfeit', payload);
    }
  }
  // ── Socket handlers ─────────────────────────────────────────────────────────

  function _wire(socket, { user, accountId }) {
    lifecycle.onSocket(socket, 'fighting:rooms_request', () => {
      socket.emit('fighting:rooms', {
        rooms: fightMgr.openRooms(),
        liveRooms: fightMgr.liveRooms(),
      });
      socket.emit('sandbox:count', { count: sbMgr.getCount() });
    });

    lifecycle.onSocket(socket, 'fighting:create', (payload) => {
      if (!user) return;
      if (!admit(socket)) return;
      const raw = payload?.bet ?? 0,
        bet = Math.floor(typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : NaN);
      if (!Number.isSafeInteger(bet) || bet < 0 || bet > Math.floor(Number.MAX_SAFE_INTEGER / 8)) {
        socket.emit('fighting:error', { error: 'invalid_bet' });
        return;
      }
      const result = fightMgr.createRoom(
        { accountId, userId: user.userId, pseudo: user.pseudo, color: user.color },
        bet,
      );
      if (!result.ok) {
        socket.emit('fighting:error', { error: result.error });
        return;
      }
      const room = fightMgr.getRoom(result.roomId);
      if (!stakes.open(room)) throw lifecycle.fail('FIGHTING_FUNDING_FAILED');
      const funded = charge(room, accountId);
      if (!funded.ok) {
        if (funded.error === 'insufficient_balance') fightMgr.closeRoom(room.id);
        socket.emit('fighting:error', { error: funded.error });
        return;
      }
      socket.emit('fighting:created', { roomId: result.roomId, room: result.public });
      _ns.emit('fighting:open', result.public);
    });

    lifecycle.onSocket(socket, 'fighting:join', (payload) => {
      if (!user) return;
      const roomId = typeof payload?.roomId === 'string' ? payload.roomId : null;
      if (!roomId) return;
      const room = fightMgr.getRoom(roomId);
      if (!room) {
        socket.emit('fighting:error', { error: 'not_found' });
        return;
      }
      if (!admit(socket)) return;
      const result = fightMgr.joinRoom(
        { accountId, userId: user.userId, pseudo: user.pseudo, color: user.color },
        roomId,
        (joined) => charge(joined, accountId),
      );
      if (!result.ok) {
        socket.emit('fighting:error', { error: result.error });
        return;
      }
      _ns.emit('fighting:closed', { roomId });
      // Both players enter the room lobby to select their characters
      const pub = result.public;
      for (let slot = 0; slot < 2; slot++) {
        const target = users.get(room.players[slot].accountId);
        if (target) {
          for (const sock of target.clients) {
            sock.emit('fighting:joined', { roomId, slot, players: pub.players, bet: pub.bet });
          }
        }
      }
    });

    // Preview: broadcast char choice to opponent without marking ready
    lifecycle.onSocket(socket, 'fighting:preview_char', (payload) => {
      if (!user) return;
      const roomId = roomIdFromPayload(payload);
      const char = typeof payload?.char === 'string' ? payload.char.slice(0, 64) : null;
      const defFile = typeof payload?.defFile === 'string' ? payload.defFile.slice(0, 128) : null;
      if (!roomId || !char) return;
      const room = fightMgr.getRoom(roomId);
      if (!room) return;
      const slot = fightMgr._slot(room, accountId);
      if (slot === -1) return;
      // Only relay to the other player in the room
      const oppSlot = slot === 0 ? 1 : 0;
      const opp = room.players[oppSlot];
      if (!opp) return;
      const target = users.get(opp.accountId);
      if (target) {
        for (const sock of target.clients) {
          sock.emit('fighting:char_picked', {
            slot,
            char,
            defFile: defFile ?? null,
            preview: true,
          });
        }
      }
    });

    lifecycle.onSocket(socket, 'fighting:select_char', (payload) => {
      if (!user) return;
      const roomId = roomIdFromPayload(payload);
      const char = typeof payload?.char === 'string' ? payload.char.slice(0, 64) : null;
      const defFile = typeof payload?.defFile === 'string' ? payload.defFile.slice(0, 128) : null;
      const stage = payload?.stage && typeof payload.stage === 'object' ? payload.stage : null;
      if (!roomId || !char) return;
      const result = fightMgr.selectChar(accountId, roomId, char, defFile, stage);
      if (!result.ok) return;
      const room = fightMgr.getRoom(roomId);
      if (!room) return;
      _emitCharPick(room, result.slot, char, defFile);
      if (result.bothReady) _startSelectedFight(roomId, room, result.public);
    });

    lifecycle.onSocket(socket, 'fighting:ready', (payload) => {
      if (!user) return;
      const roomId = roomIdFromPayload(payload);
      if (!roomId) return;
      const result = fightMgr.markReady(accountId, roomId);
      if (!result.ok || !result.bothReady) return;
      const room = fightMgr.getRoom(roomId);
      if (!room) return;
      // Both players ready — start the round
      emitToRoomPlayers(room, 'fighting:begin', {});
    });

    lifecycle.onSocket(socket, 'fighting:input', (payload) => {
      if (!user) return;
      const roomId = typeof payload?.roomId === 'string' ? payload.roomId : null;
      if (!roomId || !payload?.input) return;
      const relay = fightMgr.relayInput(accountId, roomId);
      if (!relay.ok) return;
      const oppUser = users.get(relay.opponentAccountId);
      const slot =
        fightMgr.getRoom(roomId)?.players.findIndex((p) => p.accountId === accountId) ?? -1;
      if (oppUser) {
        for (const sock of oppUser.clients) {
          sock.emit('fighting:input', { slot, input: payload.input });
        }
      }
      // Relay to spectators
      const specs = fightSpectators.get(roomId);
      if (specs && slot !== -1) {
        const inputData = { slot, input: payload.input };
        for (const s of specs) s.emit('fighting:input', inputData);
      }
    });

    lifecycle.onSocket(socket, 'fighting:hit', (payload) => {
      if (!user) return;
      const hit = _hitPayload(payload);
      if (!hit.roomId || hit.targetSlot < 0) return;

      const room = fightMgr.getRoom(hit.roomId);
      if (!room) return;

      const result = fightMgr.reportHit(
        accountId,
        hit.roomId,
        hit.targetSlot,
        hit.attackerX,
        hit.targetX,
        hit.damage,
      );
      if (!result.ok) return;

      _broadcastFightHealth(hit.roomId, room, result.health);
      if (result.roundOver) {
        const roundResult = fightMgr.nextRound(hit.roomId, result.loserSlot);
        _settleFightRound(hit.roomId, roundResult, room.players);
      }
    });

    lifecycle.onSocket(socket, 'fighting:round_end', (payload) => {
      // Client-reported timeout — only accept from slot 0 to avoid duplicate
      if (!user) return;
      const roomId = typeof payload?.roomId === 'string' ? payload.roomId : null;
      const loserSlot = typeof payload?.loserSlot === 'number' ? payload.loserSlot : -1;
      if (!roomId || loserSlot < 0) return;
      const room = fightMgr.getRoom(roomId);
      if (!room || room.state !== 'playing') return;
      if (room.players[0]?.accountId !== accountId) return; // only P0 reports timeout
      const roundResult = fightMgr.nextRound(roomId, loserSlot);
      _settleFightRound(roomId, roundResult, room.players);
    });

    lifecycle.onSocket(socket, 'fighting:forfeit', (payload) => {
      if (!user) return;
      const roomId = typeof payload?.roomId === 'string' ? payload.roomId : null;
      if (!roomId) return;
      const room = fightMgr.getRoom(roomId);
      if (!room) return;
      forfeit(room, accountId);
    });

    lifecycle.onSocket(socket, 'fighting:spectate', (payload) => {
      const roomId = typeof payload?.roomId === 'string' ? payload.roomId : null;
      if (!roomId) return;
      const room = fightMgr.getRoom(roomId);
      if (!room || room.state !== 'playing') {
        socket.emit('fighting:error', { error: 'spectate_not_found' });
        return;
      }
      // Can't spectate your own game
      if (room.players.some((p) => p.accountId === accountId)) {
        socket.emit('fighting:error', { error: 'cannot_spectate_own' });
        return;
      }
      // Leave any previous fight spectate session
      removeSpectator(socket);
      if (!fightSpectators.has(roomId)) fightSpectators.set(roomId, new Set());
      fightSpectators.get(roomId).add(socket);
      socket.emit('fighting:spectate_start', {
        roomId,
        players: room.players.map(({ accountId: _ch, ...rest }) => rest),
        health: [...room.health],
        round: room.round,
        wins: [...room.wins],
        chars: room.players.map((p) => p.char),
      });
    });

    lifecycle.onSocket(socket, 'fighting:unspectate', (payload) => {
      const roomId = typeof payload?.roomId === 'string' ? payload.roomId : null;
      if (!roomId) return;
      fightSpectators.get(roomId)?.delete(socket);
      if (!fightSpectators.get(roomId)?.size) fightSpectators.delete(roomId);
    });

    // -----------------------------------------------------------------
  }
  function wire(socket, context) {
    if (lifecycle.status().stopped) return false;
    if (!_ns) throw new Error('FIGHTING_NOT_INITIALIZED');
    sandbox.wire(socket, context);
    return lifecycle.run(() => {
      if (wired.has(socket)) return false;
      wired.add(socket);
      _wire(socket, context);
      return true;
    });
  }
  function onSocketDisconnect(socket) {
    sandbox.onSocketDisconnect(socket);
    return lifecycle.safely(() => {
      removeSpectator(socket);
      lifecycle.disposeSocket(socket);
    });
  }
  function onUserDisconnect(id) {
    const result = lifecycle.safely(() => {
      const room = fightMgr.findPlayerRoom(id);
      if (room) forfeit(room, id);
    });
    sandbox.onUserDisconnect(id);
    return result;
  }
  function stop() {
    if (!stopping) {
      let resolveStop, rejectStop;
      stopping = new Promise((resolve, reject) => {
        resolveStop = resolve;
        rejectStop = reject;
      });
      Promise.all([lifecycle.stop(), sandbox.stop()]).then(() => resolveStop(), rejectStop);
    }
    return stopping;
  }
  function status() {
    const fight = lifecycle.status(),
      free = sandbox.status();
    return {
      ...fight,
      ...stakes.status(),
      stopping: !!stopping || fight.stopping || free.stopping,
      stopped: fight.stopped && free.stopped,
      failed: fight.failed || free.failed,
      failureCode: fight.failureCode ?? free.failureCode,
      activeTimers: fight.activeTimers + free.activeTimers,
      activeListeners: fight.activeListeners + free.activeListeners,
      activeCallbacks: fight.activeCallbacks + free.activeCallbacks,
      activeSockets: fight.activeSockets + free.activeSockets,
      accepting: fightMgr.accepting,
      rooms: fightMgr._rooms.size,
      pendingResults: pendingResults.size,
      spectatorRooms: fightSpectators.size,
      sandbox: free,
    };
  }
  return { fightMgr, sbMgr, init, wire, onSocketDisconnect, onUserDisconnect, stop, status };
}
