import { WormGameManager, preloadLevels } from './model.js';
import { chatState } from '../../../server/chat/state.js';
import { db } from '../../../server/db/index.js';
import { createPointsStore } from '../../../server/chat/points-store.js';
import { randomUnit } from '../../../server/utils/secure-random.js';
import { requireUserRoom, emitToSpectators } from '../../platform/room-messages.js';
import { createCasinoWallet } from '../../platform/casino-wallet.js';
import { createRoomStakes } from '../../platform/room-stakes.js';
import { createGameLifecycle } from '../../platform/game-lifecycle.js';

const RETREAT_MS = 5000;
export function createWormsRuntime({
  users = chatState.users,
  timers,
  now = Date.now,
  timeoutMs,
  report,
  preload = preloadLevels,
  wallet = createCasinoWallet({
    users,
    change: createPointsStore({ db }).change,
    codePrefix: 'WORMS',
  }),
} = {}) {
  let wormsMgr,
    loading = false,
    levelJob;
  const wired = new WeakSet();
  const lifecycle = createGameLifecycle({
    name: 'worms',
    codePrefix: 'WORMS',
    timers,
    timeoutMs,
    report,
    quiesce: () => wormsMgr.quiesce(),
    pending: () =>
      loading ||
      stakes.pending() ||
      [...wormsMgr._rooms.values()].some(
        (room) => room.state !== 'done' || room._settlementPending,
      ),
    finish() {
      for (const room of [...wormsMgr._rooms.values()]) wormsMgr.closeRoom(room.id);
      _spectators.clear();
      wormsMgr._wormTurn.clear();
    },
  });
  const stakes = createRoomStakes({ wallet, report: (code) => lifecycle.fail('WORMS_' + code) });
  wormsMgr = new WormGameManager({
    timers: lifecycle.timers,
    now,
    beforeLaunch: (room) => stakes.ready(room),
    settlementReady: (room) => stakes.canReplace(room),
  });
  function notifyPoints(id) {
    const user = users.get(id);
    for (const socket of user?.clients ?? [])
      socket.emit('points:update', { balance: user.points });
  }
  function charge(room, id) {
    const result = stakes.charge(room, id);
    if (result.ok) notifyPoints(id);
    return result;
  }
  function refund(room, id) {
    if (!stakes.refund(room, id).ok) throw lifecycle.fail('WORMS_REFUND_FAILED');
    notifyPoints(id);
  }
  function emitToPlayers(players, event, payload) {
    for (const player of players)
      for (const socket of users.get(player.accountId)?.clients ?? []) socket.emit(event, payload);
  }
  function emitToRoomAndSpecs(spectators, room, event, payload) {
    emitToPlayers(room.players, event, payload);
    emitToSpectators(spectators, room.id, event, payload);
  }
  function roomIdFromPayload(payload, max = 20) {
    return typeof payload?.roomId === 'string' && payload.roomId.length <= max
      ? payload.roomId
      : null;
  }
  function admit(socket) {
    if (wormsMgr.accepting) return true;
    socket.emit('worms:error', { error: 'unavailable' });
    return false;
  }
  function schedule(room, callback, delay, sameTurn = false) {
    const generation = room._generation,
      serial = room._turnSerial;
    room._wireTimers ??= new Set();
    const timer = lifecycle.timers.setTimeout(() => {
      room._wireTimers.delete(timer);
      if (
        wormsMgr.getRoom(room.id) !== room ||
        room.state !== 'playing' ||
        room._generation !== generation ||
        (sameTurn && room._turnSerial !== serial)
      )
        return;
      callback();
    }, delay);
    room._wireTimers.add(timer);
    return timer;
  }
  function cancelJobs(room) {
    for (const timer of room._wireTimers ?? []) lifecycle.timers.clearTimeout(timer);
    room._wireTimers?.clear();
    room._dynTimers?.clear();
  }
  function removeSpectator(socket) {
    for (const [id, sockets] of _spectators) {
      sockets.delete(socket);
      if (!sockets.size) _spectators.delete(id);
    }
  }
  function forfeit(room, id) {
    const wasCurrent =
      room.currentTurn === room.players.find((player) => player.accountId === id)?.userId;
    const result = wormsMgr.forfeit(id, room.id);
    if (!result.ok || result.waiting) return result; // Waiting-room event refunds every confirmed participant once.
    _broadcastToRoom(room, 'worms:forfeit_player', {
      roomId: room.id,
      userId: result.player.userId,
      pseudo: result.player.pseudo,
    });
    if (result.gameOver) _settleGame(room, result.winner);
    else if (wasCurrent) _nextTurnAndBroadcast(room.id);
    return result;
  }
  let _ns = null;

  // Spectators: roomId → Set<socket>
  const _spectators = new Map();

  // ── Init ─────────────────────────────────────────────────────────────────────
  function init(ns) {
    if (lifecycle.status().stopped) return false;
    if (_ns === ns) return true;
    if (_ns) throw new Error('WORMS_ALREADY_INITIALIZED');
    if (!ns || typeof ns.emit !== 'function') throw new TypeError('WORMS_INVALID_NAMESPACE');
    return lifecycle.run(() => {
      _ns = ns;
      loading = true;
      let job;
      try {
        job = preload();
      } catch {
        loading = false;
        throw lifecycle.fail('WORMS_LEVELS_FAILED');
      }
      levelJob = Promise.resolve(job).then(
        () =>
          lifecycle.safely(() => {
            loading = false;
            return true;
          }),
        () =>
          lifecycle.safely(() => {
            loading = false;
            lifecycle.fail('WORMS_LEVELS_FAILED');
            return false;
          }),
      );

      lifecycle.listen(wormsMgr, 'room:expired', ({ roomId }) => {
        const room = stakes.roomById(roomId);
        if (!room) return;
        for (const player of room.players) refund(room, player.accountId);
        if (_ns) _ns.emit('worms:closed', { roomId });
      });

      lifecycle.listen(wormsMgr, 'turn:timeout', ({ roomId }) => {
        if (!_ns) return;
        _nextTurnAndBroadcast(roomId);
      });
      return true;
    });
  }

  // ── Internal helpers ──────────────────────────────────────────────────────────
  function _broadcastToRoom(room, event, payload) {
    emitToRoomAndSpecs(_spectators, room, event, payload);
  }

  function _exitPostGame(roomId, players, reason = 'lobby') {
    emitToPlayers(players, 'worms:post_exit', { roomId, reason });
    _ns?.emit('worms:live_closed', { roomId });
  }

  function _settleGame(room, winner) {
    if (stakes.canReplace(room)) return false;
    room._settlementPending = true;
    if (!stakes.settle(room, winner)) throw lifecycle.fail('WORMS_SETTLEMENT_FAILED');
    for (const player of room.players) notifyPoints(player.accountId);
    cancelJobs(room);
    wormsMgr.markSettled(room.id);
    const pot = room.bet * room.players.length;
    const payload = {
      winner: winner ? { userId: winner.userId, pseudo: winner.pseudo, color: winner.color } : null,
      draw: !winner,
      payout: winner && room.bet > 0 ? pot : 0,
    };
    _broadcastToRoom(room, 'worms:game_over', payload);
    if (_ns) _ns.emit('worms:live_closed', { roomId: room.id });

    if (_ns)
      _ns.emit('bot', {
        kind: 'bot',
        pseudo: 'worms',
        color: '#66dd33',
        translationKey: winner ? 'chat.game.wormsWin' : 'chat.game.wormsDraw',
        translationValues: winner
          ? { winner: winner.pseudo, prize: room.bet > 0 ? ` (${pot} pts)` : '' }
          : {},
        date: Date.now(),
      });
  }

  // ── Shared handler helpers (eliminate Codacy duplication) ──────────────────
  function _nextTurnAndBroadcast(roomId) {
    const room = wormsMgr.getRoom(roomId);
    if (!room) return false;
    const turn = wormsMgr.nextTurn(roomId);
    if (!turn) return false;
    if (turn.gameOver) {
      _settleGame(room, turn.winner);
      return true;
    }
    _broadcastToRoom(room, 'worms:next_turn', { roomId, ...turn });
    for (const mr of turn.mineResults ?? []) {
      _broadcastToRoom(room, 'worms:delayed_explosion', { roomId, weapon: 'land_mine', ...mr });
      if (mr.gameOver) {
        _settleGame(room, mr.winner);
        return true;
      }
    }
    if (randomUnit() < 0.3) {
      const crate = wormsMgr.spawnCrate(roomId);
      if (crate) _broadcastToRoom(room, 'worms:crate_spawn', { roomId, crate });
    }
    return true;
  }

  // ── Socket handlers ───────────────────────────────────────────────────────────
  function wire(socket, { user, accountId }) {
    if (lifecycle.status().stopped) return false;
    if (!_ns) throw new Error('WORMS_NOT_INITIALIZED');
    return lifecycle.run(() => {
      if (wired.has(socket)) return false;
      wired.add(socket);
      // ── Rooms list ──────────────────────────────────────────────────────────────
      lifecycle.onSocket(socket, 'worms:rooms_request', () => {
        socket.emit('worms:rooms', {
          rooms: wormsMgr.openRooms(),
          liveRooms: wormsMgr.liveRooms(),
        });
      });

      // ── Create room ─────────────────────────────────────────────────────────────
      lifecycle.onSocket(socket, 'worms:create', (payload) => {
        if (!user || !admit(socket)) return;
        const raw = payload?.bet ?? 0;
        const bet = Math.floor(
          typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : NaN,
        );
        if (
          !Number.isSafeInteger(bet) ||
          bet < 0 ||
          bet > Math.floor(Number.MAX_SAFE_INTEGER / 8)
        ) {
          socket.emit('worms:error', { error: 'invalid_bet' });
          return;
        }
        const maxPlayers = Math.max(2, Math.min(8, Math.floor(+payload?.maxPlayers || 4)));

        const result = wormsMgr.createRoom(
          { accountId, userId: user.userId, pseudo: user.pseudo, color: user.color },
          bet,
          maxPlayers,
        );
        if (!result.ok) {
          socket.emit('worms:error', { error: result.error });
          return;
        }

        const room = wormsMgr.getRoom(result.roomId);
        if (!stakes.open(room)) throw lifecycle.fail('WORMS_FUNDING_FAILED');
        const funded = charge(room, accountId);
        if (!funded.ok) {
          if (funded.error === 'insufficient_balance') wormsMgr.closeRoom(room.id);
          socket.emit('worms:error', { error: funded.error });
          return;
        }
        socket.emit('worms:created', { roomId: result.roomId, room: result.public });
        if (_ns) _ns.emit('worms:open', result.public);
      });

      // ── Join room ────────────────────────────────────────────────────────────────
      lifecycle.onSocket(socket, 'worms:join', (payload) => {
        if (!user || !admit(socket)) return;
        const { ok, room, roomId } = requireUserRoom(
          socket,
          user,
          payload,
          (rid) => wormsMgr.getRoom(rid),
          'worms:error',
        );
        if (!ok) return;

        const result = wormsMgr.joinRoom(
          { accountId, userId: user.userId, pseudo: user.pseudo, color: user.color },
          roomId,
        );
        if (!result.ok) {
          socket.emit('worms:error', { error: result.error });
          return;
        }

        const funded = charge(room, accountId);
        if (!funded.ok) {
          if (funded.error === 'insufficient_balance')
            room.players = room.players.filter((player) => player.accountId !== accountId);
          socket.emit('worms:error', { error: funded.error });
          return;
        }
        socket.emit('worms:joined', { roomId, room: result.public });
        // Notify all players + global lobby
        if (_ns) _ns.emit('worms:lobby_update', result.public);
      });

      // ── Launch game (creator only) ───────────────────────────────────────────────
      lifecycle.onSocket(socket, 'worms:launch', (payload) => {
        if (!user) return;
        const roomId = roomIdFromPayload(payload);
        if (!roomId) return;

        const roomSnap = wormsMgr.getRoom(roomId);
        if (!roomSnap) {
          socket.emit('worms:error', { error: 'not_found' });
          return;
        }

        const result = wormsMgr.launchRoom(accountId, roomId, payload?.theme ?? 0);
        if (!result.ok) {
          socket.emit('worms:error', { error: result.error });
          return;
        }

        // Broadcast game start to all players
        _broadcastToRoom(roomSnap, 'worms:start', result.game);
        if (_ns) {
          _ns.emit('worms:closed', { roomId });
          _ns.emit('worms:live_open', wormsMgr.publicRoom(wormsMgr.getRoom(roomId) ?? roomSnap));
        }
      });

      // ── Fire ─────────────────────────────────────────────────────────────────────
      lifecycle.onSocket(socket, 'worms:fire', (payload) => {
        const {
          ok: vok,
          room,
          roomId,
        } = requireUserRoom(socket, user, payload, (rid) => wormsMgr.getRoom(rid), 'worms:error');
        if (!vok) return;

        const { ok, ...shotData } = wormsMgr.fire(accountId, roomId, {
          angle: payload?.angle,
          power: payload?.power,
          weapon: payload?.weapon,
          targetX: payload?.targetX,
          targetY: payload?.targetY,
          fuseMs: payload?.fuseMs,
        });
        if (!ok) {
          socket.emit('worms:error', { error: shotData.error });
          return;
        }

        _broadcastToRoom(room, 'worms:fire_result', {
          roomId,
          weapon: payload?.weapon,
          ...shotData,
        });

        // A committed weapon action owns the rest of the turn. Stop the regular
        // turn clock so it cannot advance underneath the impact/retreat sequence.
        // Movement tools keep the clock because the player still controls the worm.
        if (!room.activeTool) {
          lifecycle.timers.clearTimeout(room._turnTimer);
          room._turnTimer = null;
        }

        if (shotData.gameOver) {
          _settleGame(room, shotData.winner);
        } else if (shotData.planted && payload?.weapon === 'dynamite') {
          // Dynamite: run 5s fuse then detonate independently of turn flow
          const dynId = shotData.dynId;
          if (!room._dynTimers) room._dynTimers = new Map();
          room._dynTimers.set(
            dynId,
            schedule(
              room,
              () => {
                room._dynTimers.delete(dynId);
                const r2 = wormsMgr.getRoom(roomId);
                if (!r2 || r2.state !== 'playing') return;
                const result = wormsMgr.detonateDynamite(roomId, dynId);
                if (!result) return;
                _broadcastToRoom(r2, 'worms:delayed_explosion', {
                  roomId,
                  weapon: 'dynamite',
                  ...result,
                });
                if (result.gameOver) _settleGame(r2, result.winner);
              },
              5000,
            ),
          );
          // Retreat + next turn still happen normally
          schedule(
            room,
            () => {
              const r2 = wormsMgr.getRoom(roomId);
              if (!r2 || r2.state !== 'playing') return;
              r2.retreating = true;
              _broadcastToRoom(r2, 'worms:retreat', { roomId, retreatMs: RETREAT_MS });
              r2._retreatTimer = schedule(
                r2,
                () => {
                  if (_nextTurnAndBroadcast(roomId)) return;
                },
                RETREAT_MS,
                true,
              );
            },
            2600,
            true,
          );
        } else {
          // After explosion animation: signal retreat phase, then advance turn
          schedule(
            room,
            () => {
              const r2 = wormsMgr.getRoom(roomId);
              if (!r2 || r2.state !== 'playing') return;
              r2.retreating = true;
              _broadcastToRoom(r2, 'worms:retreat', { roomId, retreatMs: RETREAT_MS });
              r2._retreatTimer = schedule(
                r2,
                () => {
                  _nextTurnAndBroadcast(roomId);
                },
                RETREAT_MS,
                true,
              );
            },
            2600,
            true,
          );
        }
      });

      // Movement tools stay client-simulated for responsiveness, but the server
      // authoritatively records that this turn's action has been spent.
      lifecycle.onSocket(socket, 'worms:use_tool', (payload) => {
        const {
          ok: roomOk,
          room,
          roomId,
        } = requireUserRoom(socket, user, payload, (rid) => wormsMgr.getRoom(rid), 'worms:error');
        if (!roomOk) return;
        const weapon = typeof payload?.weapon === 'string' ? payload.weapon : '';
        const result = wormsMgr.useMovementTool(accountId, roomId, weapon);
        if (!result.ok) {
          socket.emit('worms:error', { error: result.error });
          return;
        }
        _broadcastToRoom(room, 'worms:tool_used', {
          roomId,
          weapon,
          playerId: result.playerId,
          ammo: result.ammo,
        });
      });

      // ── Worm position sync (movement during active turn) ─────────────────────────
      lifecycle.onSocket(socket, 'worms:pos', (payload) => {
        if (!user) return;
        const roomId = roomIdFromPayload(payload);
        if (!roomId) return;

        const pos = wormsMgr.updateWormPos(
          accountId,
          roomId,
          payload?.wormId,
          payload?.cx,
          payload?.cy,
        );
        if (!pos) return;

        const room = wormsMgr.getRoom(roomId);
        if (!room) return;

        // Relay position to all other players (not sender)
        for (const p of room.players) {
          if (p.accountId === accountId) continue;
          const u = users.get(p.accountId);
          if (u)
            for (const s of u.clients)
              s.emit('worms:pos_update', { roomId, wormId: pos.wormId, cx: pos.cx, cy: pos.cy });
        }
        // Relay to spectators
        const specs = _spectators.get(roomId);
        if (specs)
          for (const s of specs)
            s.emit('worms:pos_update', { roomId, wormId: pos.wormId, cx: pos.cx, cy: pos.cy });

        if (pos.drowned) {
          _broadcastToRoom(room, 'worms:drowned', { roomId, ...pos.drowned });
          if (pos.drowned.gameOver) _settleGame(room, pos.drowned.winner);
          else _nextTurnAndBroadcast(roomId);
          return;
        }

        // Broadcast mine triggers to entire room
        for (const mr of pos.mineResults ?? []) {
          _broadcastToRoom(room, 'worms:delayed_explosion', { roomId, weapon: 'land_mine', ...mr });
          if (mr.gameOver) _settleGame(room, mr.winner);
        }
      });

      // ── End turn manually (also cancels retreat timer) ───────────────────────────
      lifecycle.onSocket(socket, 'worms:end_turn', (payload) => {
        const { ok, room, roomId } = requireUserRoom(socket, user, payload, (rid) =>
          wormsMgr.getRoom(rid),
        );
        if (!ok) return;
        const player = room.players.find((p) => p.accountId === accountId);
        if (!player || player.userId !== room.currentTurn) return;

        // Projectile/melee actions advance through the authoritative
        // impact -> retreat -> next-turn sequence above. Only an unused turn or an
        // active movement tool may be ended manually.
        if (room.turnActionTaken && !room.activeTool) return;

        // Cancel any pending retreat timer
        if (room._retreatTimer) {
          lifecycle.timers.clearTimeout(room._retreatTimer);
          room._wireTimers?.delete(room._retreatTimer);
          room._retreatTimer = null;
        }

        _nextTurnAndBroadcast(roomId);
      });

      // ── Collect crate ───────────────────────────────────────────────────────────────
      lifecycle.onSocket(socket, 'worms:collect_crate', (payload) => {
        if (!user) return;
        const roomId = roomIdFromPayload(payload);
        const crateId = typeof payload?.crateId === 'string' ? payload.crateId.slice(0, 20) : null;
        if (!roomId || !crateId) return;
        const room = wormsMgr.getRoom(roomId);
        if (!room) return;
        const result = wormsMgr.collectCrate(accountId, roomId, crateId);
        if (!result) return;
        _broadcastToRoom(room, 'worms:crate_collected', { roomId, ...result });
      });

      // ── Select active worm (Tab key) ───────────────────────────────────────────────
      lifecycle.onSocket(socket, 'worms:select_worm', (payload) => {
        if (!user) return;
        const roomId = roomIdFromPayload(payload);
        const wormId = typeof payload?.wormId === 'string' ? payload.wormId.slice(0, 20) : null;
        if (!roomId || !wormId) return;

        const room = wormsMgr.getRoom(roomId);
        if (!room) return;

        const result = wormsMgr.selectWorm(accountId, roomId, wormId);
        if (!result) return;

        _broadcastToRoom(room, 'worms:worm_selected', { roomId, ...result });
      });

      // ── Forfeit ───────────────────────────────────────────────────────────────────
      lifecycle.onSocket(socket, 'worms:forfeit', (payload) => {
        const { ok, room } = requireUserRoom(
          socket,
          user,
          payload,
          (id) => wormsMgr.getRoom(id),
          'worms:error',
        );
        if (ok) forfeit(room, accountId);
      });

      lifecycle.onSocket(socket, 'worms:rematch', (payload) => {
        if (!user || !admit(socket)) return;
        const roomId = roomIdFromPayload(payload);
        if (!roomId) return;
        const vote = wormsMgr.requestRematch(accountId, roomId);
        if (!vote.ok) {
          socket.emit('worms:error', { error: vote.error });
          return;
        }
        if (vote.waiting) {
          for (const s of user.clients) s.emit('worms:rematch_waiting', { roomId });
          return;
        }
        if (!stakes.canReplace(vote.room)) return;
        if (
          vote.room.players.some(
            (player) =>
              !users.has(player.accountId) || wormsMgr.ffa.findPlayerRoom(player.accountId),
          )
        ) {
          wormsMgr.closeRoom(roomId);
          _exitPostGame(roomId, vote.room.players, 'insufficient_balance');
          return;
        }
        const result = wormsMgr.reopenForRematch(roomId);
        if (!result.ok) {
          socket.emit('worms:error', { error: result.error });
          return;
        }
        if (!stakes.open(result.room, true)) throw lifecycle.fail('WORMS_FUNDING_FAILED');
        for (const player of result.room.players) {
          const funded = charge(result.room, player.accountId);
          if (funded.ok) continue;
          if (funded.error === 'insufficient_balance') {
            for (const previous of result.room.players) {
              if (previous.accountId === player.accountId) break;
              refund(result.room, previous.accountId);
            }
            wormsMgr.closeRoom(roomId);
            _exitPostGame(roomId, result.room.players, 'insufficient_balance');
          }
          return;
        }
        _broadcastToRoom(result.room, 'worms:rematch_lobby', { roomId, room: result.public });
        if (_ns) _ns.emit('worms:open', result.public);
      });

      lifecycle.onSocket(socket, 'worms:post_exit', (payload) => {
        if (!user) return;
        const roomId = roomIdFromPayload(payload);
        if (!roomId) return;
        const result = wormsMgr.leavePostGame(accountId, roomId);
        if (!result.ok) {
          socket.emit('worms:error', { error: result.error });
          return;
        }
        _exitPostGame(roomId, result.players, 'lobby');
      });

      // ── Spectate ───────────────────────────────────────────────────────────────
      lifecycle.onSocket(socket, 'worms:watch', (d = {}) => {
        const { roomId } = d || {};
        const rid = roomIdFromPayload({ roomId });
        if (!rid) return;
        const room = wormsMgr.getRoom(rid);
        if (!room || room.state !== 'playing') {
          socket.emit('worms:error', { error: 'not_found' });
          return;
        }
        removeSpectator(socket);
        if (!_spectators.has(rid)) _spectators.set(rid, new Set());
        _spectators.get(rid).add(socket);
        socket.emit('worms:spectate_start', wormsMgr._snap(room));
      });

      lifecycle.onSocket(socket, 'worms:unwatch', (payload) => {
        const roomId = roomIdFromPayload(payload),
          spectators = _spectators.get(roomId);
        spectators?.delete(socket);
        if (!spectators?.size) _spectators.delete(roomId);
      });
      return true;
    });
  }

  return {
    wormsMgr,
    init,
    wire,
    stop: lifecycle.stop,
    ready: () => levelJob ?? Promise.resolve(false),
    onSocketDisconnect: (socket) =>
      lifecycle.safely(() => {
        removeSpectator(socket);
        lifecycle.disposeSocket(socket);
      }),
    onUserDisconnect: (id) =>
      lifecycle.safely(() => {
        for (const room of [...wormsMgr._rooms.values()]) {
          if (room.state !== 'done' && room.players.some((player) => player.accountId === id))
            forfeit(room, id);
        }
      }),
    status: () => ({
      ...lifecycle.status(),
      ...stakes.status(),
      failureCode: lifecycle.status().failureCode,
      accepting: wormsMgr.accepting,
      loading,
      rooms: wormsMgr._rooms.size,
      spectatorRooms: _spectators.size,
    }),
  };
}
