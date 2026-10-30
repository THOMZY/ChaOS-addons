import { createReplays } from './replays.js';
import { MugenManager } from './model.js';
import { chatState } from '../../../server/chat/state.js';
import { db } from '../../../server/db/index.js';
import { createPointsStore } from '../../../server/chat/points-store.js';
import { createCasinoWallet } from '../../platform/casino-wallet.js';
import { createRoomStakes } from '../../platform/room-stakes.js';
import { createGameLifecycle } from '../../platform/game-lifecycle.js';

// Netplay bytes are relayed, never read. GGPO datagrams are a few dozen bytes
// and the lobby stream carries the engine handshake and its settings.
const MAX_PACKET_BYTES = 8192;
const MAX_PACKETS_PER_SECOND = 600;
const ROOM_ID = /^[0-9a-f]{12}$/;

export function createMugenRuntime({
  catalog,
  users = chatState.users,
  timers,
  now = Date.now,
  timeoutMs,
  report,
  random = Math.random,
  wallet = createCasinoWallet({
    users,
    change: createPointsStore({ db }).change,
    codePrefix: 'MUGEN',
  }),
} = {}) {
  if (!catalog) throw new TypeError('MUGEN_CATALOG_REQUIRED');
  let fightMgr, stopping;
  const pendingResults = new Set(),
    wired = new WeakSet(),
    spectators = new Map(),
    replays = createReplays({ now }),
    packetBudgets = new WeakMap();
  const lifecycle = createGameLifecycle({
    name: 'mugen',
    codePrefix: 'MUGEN',
    timers,
    timeoutMs,
    report,
    quiesce: () => fightMgr.quiesce(),
    pending: () => stakes.pending() || pendingResults.size > 0 || fightMgr._rooms.size > 0,
    finish() {
      spectators.clear();
      replays.clearAll();
    },
  });
  const stakes = createRoomStakes({
    wallet,
    report: (code) => lifecycle.fail('MUGEN_' + code),
  });
  fightMgr = new MugenManager({
    timers: lifecycle.timers,
    now,
    beforeStart: (room) => stakes.ready(room),
  });
  let namespace = null;

  const roomIdOf = (payload) =>
    typeof payload?.roomId === 'string' && ROOM_ID.test(payload.roomId) ? payload.roomId : null;
  const publicPlayer = ({ accountId: _accountId, ...rest }) => rest;

  function emitToUser(accountId, event, payload) {
    const user = users.get(accountId);
    if (user) for (const socket of user.clients) socket.emit(event, payload);
  }
  function emitToPlayers(players, event, payloadFor) {
    players.forEach((player, slot) =>
      emitToUser(
        player.accountId,
        event,
        typeof payloadFor === 'function' ? payloadFor(player, slot) : payloadFor,
      ),
    );
  }
  function emitToSpectators(roomId, event, payload) {
    for (const socket of spectators.get(roomId) ?? []) socket.emit(event, payload);
  }
  function notifyBalance(accountId) {
    const user = users.get(accountId);
    if (user) emitToUser(accountId, 'points:update', { balance: user.points });
  }
  function charge(room, accountId) {
    const result = stakes.charge(room, accountId);
    if (result.ok) notifyBalance(accountId);
    return result;
  }
  function admit(socket) {
    if (fightMgr.accepting) return true;
    socket.emit('mugen:error', { error: 'unavailable' });
    return false;
  }
  function removeSpectator(socket) {
    for (const [roomId, sockets] of spectators) {
      if (!sockets.delete(socket)) continue;
      if (!sockets.size) {
        spectators.delete(roomId);
      }
    }
  }
  function endReplay(roomId) {
    spectators.delete(roomId);
    replays.clear(roomId);
  }

  function init(ns) {
    if (lifecycle.status().stopped) return false;
    if (namespace === ns && ns) return true;
    if (namespace) throw new Error('MUGEN_ALREADY_INITIALIZED');
    if (!ns || typeof ns.emit !== 'function') throw new TypeError('MUGEN_INVALID_NAMESPACE');
    return lifecycle.run(() => {
      namespace = ns;
      lifecycle.listen(fightMgr, 'room:expired', ({ roomId, reason }) => {
        const room = stakes.roomById(roomId);
        if (room && !fightMgr.getRoom(roomId)) cancel(room, null, reason);
      });
      lifecycle.listen(fightMgr, 'room:decided', (decision) => settle(decision));
      return true;
    });
  }

  // ── Settlement ─────────────────────────────────────────────────────────────

  function settle(decision) {
    const room = stakes.roomById(decision.roomId);
    if (!room || room.state !== 'done' || !room._settlementPending || pendingResults.has(room))
      return false;
    if (stakes.canReplace(room)) return false;
    pendingResults.add(room);
    const winner = decision.type === 'win' ? decision.winner : null;
    if (!stakes.settle(room, winner)) throw lifecycle.fail('MUGEN_SETTLEMENT_FAILED');
    for (const player of room.players) notifyBalance(player.accountId);
    const pot = room.bet * 2;
    const payload = {
      roomId: room.id,
      winner: winner ? publicPlayer(winner) : null,
      loser: winner ? publicPlayer(decision.loser) : null,
      payout: winner ? pot : 0,
      refunded: !winner,
    };
    emitToPlayers(room.players, 'mugen:game_over', payload);
    emitToSpectators(room.id, 'mugen:game_over', payload);
    endReplay(room.id);
    namespace.emit('mugen:live_closed', { roomId: room.id });
    if (winner)
      namespace.emit('bot', {
        kind: 'bot',
        pseudo: 'fight',
        color: '#ff6a3d',
        date: now(),
        translationKey: room.bet > 0 ? 'chat.game.mugenWinBet' : 'chat.game.mugenWin',
        translationValues: {
          winner: winner.pseudo,
          loser: decision.loser.pseudo,
          pot,
        },
      });
    room._settlementPending = false;
    pendingResults.delete(room);
    return true;
  }

  function cancel(room, leavingId, reason = 'cancelled') {
    pendingResults.add(room);
    // A room without a stake record never charged anyone (creation refused it).
    if (stakes.roomById(room.id))
      for (const player of room.players) {
        if (!stakes.refund(room, player.accountId).ok) throw lifecycle.fail('MUGEN_REFUND_FAILED');
        notifyBalance(player.accountId);
      }
    for (const player of room.players)
      if (player.accountId !== leavingId)
        emitToUser(player.accountId, 'mugen:cancelled', { reason });
    namespace.emit('mugen:closed', { roomId: room.id });
    if (room.state === 'playing' || room.startedAt)
      namespace.emit('mugen:live_closed', { roomId: room.id });
    emitToSpectators(room.id, 'mugen:game_over', {
      roomId: room.id,
      refunded: true,
      payout: 0,
    });
    endReplay(room.id);
    pendingResults.delete(room);
  }

  function forfeit(room, accountId) {
    const result = fightMgr.forfeit(accountId, room.id);
    if (!result.ok) return result;
    if (result.cancelled) cancel(room, accountId);
    else if (
      settle({
        roomId: room.id,
        type: 'win',
        winner: result.winner,
        loser: result.loser,
      })
    ) {
      const payload = {
        winner: publicPlayer(result.winner),
        loser: publicPlayer(result.loser),
      };
      for (const player of [result.winner, result.loser])
        emitToUser(player.accountId, 'mugen:forfeit', payload);
    }
    return result;
  }

  // ── Match start ────────────────────────────────────────────────────────────

  function startMatch(room) {
    const [p1, p2] = room.players;
    const stage = room.stage ?? pickStage();
    room.stage = stage;
    const match = {
      roomId: room.id,
      players: room.players.map(publicPlayer),
      p1: p1.character,
      p2: p2.character,
      stage,
    };
    // The creator hosts: Ikemen's host is always side 1.
    emitToPlayers(room.players, 'mugen:start', (_player, slot) => ({
      ...match,
      slot,
      role: slot === 0 ? 'host' : 'guest',
    }));
    namespace.emit('mugen:live_open', fightMgr._pub(room));
  }

  function pickStage() {
    const stages = catalog.stages();
    return stages.length ? stages[Math.floor(random() * stages.length)] : null;
  }

  function withinBudget(socket) {
    const second = Math.floor(now() / 1000);
    const budget = packetBudgets.get(socket);
    if (!budget || budget.second !== second) {
      packetBudgets.set(socket, { second, count: 1 });
      return true;
    }
    budget.count++;
    return budget.count <= MAX_PACKETS_PER_SECOND;
  }

  // ── Socket handlers ────────────────────────────────────────────────────────

  function wireSocket(socket, { user, accountId }) {
    const player = () => ({
      accountId,
      userId: user.userId,
      pseudo: user.pseudo,
      color: user.color,
    });

    lifecycle.onSocket(socket, 'mugen:rooms_request', () => {
      socket.emit('mugen:rooms', {
        rooms: fightMgr.openRooms(),
        liveRooms: fightMgr.liveRooms(),
      });
    });

    lifecycle.onSocket(socket, 'mugen:create', (payload) => {
      if (!user || !admit(socket)) return;
      const raw = payload?.bet ?? 0,
        bet = Math.floor(typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : NaN);
      if (!Number.isSafeInteger(bet) || bet < 0 || bet > Math.floor(Number.MAX_SAFE_INTEGER / 8)) {
        socket.emit('mugen:error', { error: 'invalid_bet' });
        return;
      }
      const result = fightMgr.createRoom(player(), bet);
      if (!result.ok) {
        socket.emit('mugen:error', { error: result.error });
        return;
      }
      const room = fightMgr.getRoom(result.roomId);
      if (!stakes.open(room)) throw lifecycle.fail('MUGEN_FUNDING_FAILED');
      const funded = charge(room, accountId);
      if (!funded.ok) {
        if (funded.error === 'insufficient_balance') fightMgr.closeRoom(room.id);
        socket.emit('mugen:error', { error: funded.error });
        return;
      }
      removeSpectator(socket);
      socket.emit('mugen:created', {
        roomId: result.roomId,
        room: result.public,
      });
      namespace.emit('mugen:open', result.public);
    });

    lifecycle.onSocket(socket, 'mugen:join', (payload) => {
      if (!user) return;
      const roomId = roomIdOf(payload);
      if (!roomId) return;
      const room = fightMgr.getRoom(roomId);
      if (!room) {
        socket.emit('mugen:error', { error: 'not_found' });
        return;
      }
      if (!admit(socket)) return;
      const result = fightMgr.joinRoom(player(), roomId, (joined) => charge(joined, accountId));
      if (!result.ok) {
        socket.emit('mugen:error', { error: result.error });
        return;
      }
      removeSpectator(socket);
      namespace.emit('mugen:closed', { roomId });
      emitToPlayers(room.players, 'mugen:joined', (_player, slot) => ({
        roomId,
        slot,
        players: result.public.players,
        bet: result.public.bet,
      }));
    });

    lifecycle.onSocket(socket, 'mugen:select_char', (payload) => {
      if (!user) return;
      const roomId = roomIdOf(payload);
      const character =
        typeof payload?.character === 'string' ? catalog.character(payload.character) : null;
      const stage = typeof payload?.stage === 'string' ? catalog.stage(payload.stage) : null;
      if (!roomId || !character) {
        socket.emit('mugen:error', { error: 'unknown_character' });
        return;
      }
      if (!stage && !catalog.stages().length) {
        socket.emit('mugen:error', { error: 'no_stage' });
        return;
      }
      const result = fightMgr.selectCharacter(accountId, roomId, character, stage);
      if (!result.ok) return;
      const room = fightMgr.getRoom(roomId);
      if (!room) return;
      emitToPlayers(room.players, 'mugen:char_picked', {
        slot: result.slot,
        character,
      });
      if (result.started) startMatch(room);
    });

    // Binary netplay traffic between the two engines, relayed unchanged.
    lifecycle.onSocket(socket, 'mugen:net', (payload) => {
      if (!user) return;
      const roomId = roomIdOf(payload);
      const channel = payload?.channel;
      const data = payload?.data;
      // 0: engine byte stream, 1: rollback datagrams, 2: bridge control.
      if (!roomId || ![0, 1, 2].includes(channel)) return;
      if (!Buffer.isBuffer(data) || data.length === 0 || data.length > MAX_PACKET_BYTES) return;
      if (!withinBudget(socket)) return;
      const opponent = fightMgr.opponentOf(accountId, roomId);
      if (opponent)
        emitToUser(opponent.accountId, 'mugen:input', {
          roomId,
          channel,
          data,
        });
    });

    lifecycle.onSocket(socket, 'mugen:result', (payload) => {
      if (!user) return;
      const roomId = roomIdOf(payload);
      if (!roomId) return;
      const outcome =
        payload?.winSide === 0 || payload?.winSide === 1
          ? { winSide: payload.winSide }
          : { aborted: true };
      const result = fightMgr.reportResult(accountId, roomId, outcome);
      if (result.ok && result.decided) settle(result.decided);
    });

    lifecycle.onSocket(socket, 'mugen:forfeit', (payload) => {
      if (!user) return;
      const roomId = roomIdOf(payload);
      const room = roomId ? fightMgr.getRoom(roomId) : null;
      if (room) forfeit(room, accountId);
    });

    lifecycle.onSocket(socket, 'mugen:spectate', (payload) => {
      const roomId = roomIdOf(payload);
      const room = roomId ? fightMgr.getRoom(roomId) : null;
      if (!room || room.state !== 'playing') {
        socket.emit('mugen:error', { error: 'spectate_not_found' });
        return;
      }
      if (room.players.some((entry) => entry.accountId === accountId)) {
        socket.emit('mugen:error', { error: 'cannot_spectate_own' });
        return;
      }
      if (fightMgr.findPlayerRoom(accountId)) {
        socket.emit('mugen:error', { error: 'already_in_room' });
        return;
      }
      if (replays.invalid(roomId)) {
        socket.emit('mugen:error', { error: 'replay_unavailable' });
        return;
      }
      removeSpectator(socket);
      if (!spectators.has(roomId)) spectators.set(roomId, new Set());
      spectators.get(roomId).add(socket);
      socket.emit('mugen:spectate_start', {
        roomId,
        players: room.players.map(publicPlayer),
        stage: room.stage,
        p1: room.players[0].character,
        p2: room.players[1].character,
      });
      for (const chunk of replays.snapshot(roomId)) socket.emit('mugen:replay', chunk);
    });

    // Confirmed native replay bytes. Keep history even before anybody watches.
    lifecycle.onSocket(socket, 'mugen:replay', (payload) => {
      if (!user) return;
      const roomId = roomIdOf(payload);
      const room = roomId ? fightMgr.getRoom(roomId) : null;
      if (!room || room.state !== 'playing' || room.players[0].accountId !== accountId) return;
      const chunk = replays.push(roomId, payload);
      if (chunk) emitToSpectators(roomId, 'mugen:replay', chunk);
      else if (replays.invalid(roomId) && spectators.has(roomId)) {
        emitToSpectators(roomId, 'mugen:error', {
          roomId,
          error: 'replay_unavailable',
        });
        spectators.delete(roomId);
      }
    });

    lifecycle.onSocket(socket, 'mugen:unspectate', () => removeSpectator(socket));
  }

  function wire(socket, context) {
    if (lifecycle.status().stopped) return false;
    if (!namespace) throw new Error('MUGEN_NOT_INITIALIZED');
    return lifecycle.run(() => {
      if (wired.has(socket)) return false;
      wired.add(socket);
      wireSocket(socket, context);
      return true;
    });
  }
  function onSocketDisconnect(socket) {
    return lifecycle.safely(() => {
      removeSpectator(socket);
      lifecycle.disposeSocket(socket);
    });
  }
  function onUserDisconnect(accountId) {
    return lifecycle.safely(() => {
      const room = fightMgr.findPlayerRoom(accountId);
      if (room) forfeit(room, accountId);
    });
  }
  function stop() {
    stopping ??= lifecycle.stop();
    return stopping;
  }
  function status() {
    const life = lifecycle.status();
    return {
      ...stakes.status(),
      ...life,
      stopping: !!stopping || life.stopping,
      accepting: fightMgr.accepting,
      rooms: fightMgr._rooms.size,
      pendingResults: pendingResults.size,
      spectatorRooms: spectators.size,
      replays: replays.size(),
    };
  }
  return {
    fightMgr,
    init,
    wire,
    onSocketDisconnect,
    onUserDisconnect,
    stop,
    status,
  };
}
