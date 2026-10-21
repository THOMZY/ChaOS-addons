import { SF2Manager } from './model.js';
import { chatState } from '../../../server/chat/state.js';
import { db } from '../../../server/db/index.js';
import { createPointsStore } from '../../../server/chat/points-store.js';
import { createCasinoWallet } from '../../platform/casino-wallet.js';
import { createRoomStakes } from '../../platform/room-stakes.js';
import { createGameLifecycle } from '../../platform/game-lifecycle.js';

export function createSf2Runtime({
  users = chatState.users,
  timers,
  now = Date.now,
  timeoutMs,
  report,
  wallet = createCasinoWallet({
    users,
    change: createPointsStore({ db }).change,
    codePrefix: 'SF_TWO',
  }),
} = {}) {
  let sf2Mgr, ns;
  const wired = new WeakSet(),
    pendingResults = new Set();
  const lifecycle = createGameLifecycle({
    name: 'sf-two',
    codePrefix: 'SF_TWO',
    timers,
    timeoutMs,
    report,
    quiesce: () => sf2Mgr.quiesce(),
    pending: () => stakes.pending() || pendingResults.size > 0 || sf2Mgr._rooms.size > 0,
    finish() {
      for (const room of [...sf2Mgr._rooms.values()]) sf2Mgr.closeRoom(room.id);
    },
  });
  const stakes = createRoomStakes({ wallet, report: (code) => lifecycle.fail('SF_TWO_' + code) });
  sf2Mgr = new SF2Manager({ timers: lifecycle.timers, beforeStart: (room) => stakes.ready(room) });
  const roomId = (payload) =>
    typeof payload?.roomId === 'string' && payload.roomId.length <= 20 ? payload.roomId : null;
  function emitUser(id, event, payload) {
    for (const socket of users.get(id)?.clients ?? []) socket.emit(event, payload);
  }
  function emitPlayers(room, event, payload) {
    for (const player of room.players) emitUser(player.accountId, event, payload);
  }
  function notify(id) {
    const user = users.get(id);
    if (user) emitUser(id, 'points:update', { balance: user.points });
  }
  function charge(room, id) {
    const result = stakes.charge(room, id);
    if (result.ok) notify(id);
    return result;
  }
  function admit(socket, id) {
    const error = !sf2Mgr.accepting
      ? 'unavailable'
      : [...pendingResults].some((room) => room.players.some((player) => player.accountId === id))
        ? 'settlement_pending'
        : null;
    if (!error) return true;
    socket.emit('sf2:error', { error });
    return false;
  }
  function cancelWaiting(room) {
    if (!room || room.state !== 'waiting' || sf2Mgr.getRoom(room.id) || pendingResults.has(room))
      return;
    pendingResults.add(room);
    for (const player of room.players) {
      if (!stakes.refund(room, player.accountId).ok) throw lifecycle.fail('SF_TWO_REFUND_FAILED');
      notify(player.accountId);
    }
    ns.emit('sf2:closed', { roomId: room.id });
    pendingResults.delete(room);
  }
  function settle(room, result) {
    if (
      !room ||
      room.state !== 'done' ||
      !room._settlementPending ||
      pendingResults.has(room) ||
      stakes.canReplace(room)
    )
      return false;
    pendingResults.add(room);
    const { winner = null, loser = null } = result;
    if (!stakes.settle(room, winner)) throw lifecycle.fail('SF_TWO_SETTLEMENT_FAILED');
    for (const player of room.players) notify(player.accountId);
    if (result.draw) {
      emitPlayers(room, 'sf2:game_over', { draw: true, roomId: room.id });
      ns.emit('sf2:closed', { roomId: room.id });
    } else {
      const pot = room.bet * 2,
        forfeit = result.type === 'forfeit';
      emitPlayers(room, 'sf2:game_over', {
        winner: winner
          ? { userId: winner.userId, pseudo: winner.pseudo, color: winner.color }
          : null,
        loser: loser ? { userId: loser.userId, pseudo: loser.pseudo } : null,
        wins: forfeit ? null : result.wins,
        payout: pot,
        ...(forfeit ? { forfeit: true } : {}),
      });
      ns.emit('sf2:live_closed', { roomId: room.id });
      ns.emit('bot', {
        kind: 'bot',
        pseudo: 'sf2',
        color: '#e8c000',
        date: now(),
        translationKey: forfeit
          ? 'chat.game.sf2Forfeit'
          : room.bet > 0
            ? 'chat.game.sf2WinBet'
            : 'chat.game.sf2Win',
        translationValues: forfeit
          ? { loser: loser.pseudo, winner: winner.pseudo }
          : { winner: winner.pseudo, loser: loser.pseudo, pot },
      });
    }
    room._settlementPending = false;
    pendingResults.delete(room);
    return true;
  }
  function forfeit(room, id) {
    const result = sf2Mgr.forfeit(id, room.id);
    if (!result.ok) return result;
    if (result.type === 'cancelled') cancelWaiting(room);
    else settle(room, result);
    return result;
  }
  function init(namespace) {
    if (lifecycle.status().stopped) return false;
    if (ns === namespace && ns) return true;
    if (ns) throw new Error('SF2_ALREADY_INITIALIZED');
    if (!namespace || typeof namespace.emit !== 'function')
      throw new TypeError('SF2_INVALID_NAMESPACE');
    return lifecycle.run(() => {
      ns = namespace;
      lifecycle.listen(sf2Mgr, 'room:expired', ({ roomId }) =>
        cancelWaiting(stakes.roomById(roomId)),
      );
      lifecycle.listen(sf2Mgr, 'room:round_timeout', ({ roomId }) =>
        settle(stakes.roomById(roomId), { draw: true }),
      );
      return true;
    });
  }
  function wire(socket, { user, accountId }) {
    if (lifecycle.status().stopped) return false;
    if (!ns) throw new Error('SF2_NOT_INITIALIZED');
    return lifecycle.run(() => {
      if (wired.has(socket)) return false;
      wired.add(socket);
      const error = (result) =>
        socket.emit('sf2:error', { error: result?.error ?? 'settlement_pending' });
      const player = () => ({
        accountId,
        userId: user.userId,
        pseudo: user.pseudo,
        color: user.color,
      });
      lifecycle.onSocket(socket, 'sf2:rooms_request', () =>
        socket.emit('sf2:rooms', { rooms: sf2Mgr.openRooms(), liveRooms: sf2Mgr.liveRooms() }),
      );
      lifecycle.onSocket(socket, 'sf2:create', (payload) => {
        if (!user || !admit(socket, accountId)) return;
        const raw = payload?.bet ?? 0,
          bet = Math.floor(typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : NaN);
        if (!Number.isSafeInteger(bet) || bet < 0 || bet > Math.floor(Number.MAX_SAFE_INTEGER / 8))
          return error({ error: 'invalid_bet' });
        const result = sf2Mgr.createRoom(player(), bet, payload?.char);
        if (!result.ok) return error(result);
        const room = sf2Mgr.getRoom(result.roomId);
        if (!stakes.open(room)) throw lifecycle.fail('SF_TWO_FUNDING_FAILED');
        const funded = charge(room, accountId);
        if (!funded.ok) {
          if (funded.error === 'insufficient_balance') sf2Mgr.closeRoom(room.id);
          return error(funded);
        }
        socket.emit('sf2:created', { roomId: room.id, room: result.public });
        ns.emit('sf2:open', result.public);
      });
      lifecycle.onSocket(socket, 'sf2:join', (payload) => {
        if (!user || !admit(socket, accountId)) return;
        const id = roomId(payload);
        if (!id) return;
        const result = sf2Mgr.joinRoom(player(), id, payload?.char, (room) =>
          charge(room, accountId),
        );
        if (!result?.ok) return error(result);
        const room = result.room;
        ns.emit('sf2:closed', { roomId: room.id });
        for (const entry of room.players)
          emitUser(entry.accountId, 'sf2:start', {
            roomId: room.id,
            slot: entry.slot,
            players: result.public.players,
            bet: room.bet,
          });
        ns.emit('sf2:live_open', result.public);
      });
      lifecycle.onSocket(socket, 'sf2:input', (payload) => {
        const id = roomId(payload);
        if (!user || !id || !payload?.input) return;
        const opponent = sf2Mgr.relayInput(accountId, id);
        if (opponent) emitUser(opponent, 'sf2:input', { input: payload.input });
      });
      lifecycle.onSocket(socket, 'sf2:round_end', (payload) => {
        const room = sf2Mgr.getRoom(roomId(payload));
        if (!user || !room) return;
        const result = sf2Mgr.reportRoundEnd(accountId, room.id, payload?.loserSlot);
        if (!result.ok) {
          if (result.error) error(result);
          return;
        }
        if (result.type === 'next_round')
          emitPlayers(room, 'sf2:next_round', { round: result.round, wins: result.wins });
        else settle(room, result);
      });
      lifecycle.onSocket(socket, 'sf2:forfeit', (payload) => {
        const room = sf2Mgr.getRoom(roomId(payload));
        if (user && room) forfeit(room, accountId);
      });
      return true;
    });
  }
  return {
    sf2Mgr,
    init,
    wire,
    stop: lifecycle.stop,
    onSocketDisconnect: (socket) => lifecycle.safely(() => lifecycle.disposeSocket(socket)),
    onUserDisconnect: (id) =>
      lifecycle.safely(() => {
        for (const room of [...sf2Mgr._rooms.values()]) {
          if (room.players.some((player) => player.accountId === id)) forfeit(room, id);
        }
      }),
    status: () => ({
      ...lifecycle.status(),
      ...stakes.status(),
      failureCode: lifecycle.status().failureCode,
      pendingResults: pendingResults.size,
      accepting: sf2Mgr.accepting,
      rooms: sf2Mgr._rooms.size,
    }),
  };
}
