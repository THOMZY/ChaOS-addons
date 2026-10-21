import { SandboxManager } from './sandbox-model.js';
import { chatState } from '../../../server/chat/state.js';
import { createGameLifecycle } from '../../platform/game-lifecycle.js';

export function createSandboxRuntime({ users = chatState.users, timers, timeoutMs, report } = {}) {
  const sbMgr = new SandboxManager(),
    wired = new WeakSet();
  let ns;
  const lifecycle = createGameLifecycle({
    name: 'sandbox',
    codePrefix: 'SANDBOX',
    timers,
    timeoutMs,
    report,
    pending: () => false,
    quiesce: () => sbMgr.quiesce(),
    finish: () => sbMgr.clear(),
  });
  function admit(socket) {
    if (sbMgr.accepting) return true;
    socket.emit('sandbox:error', { error: 'unavailable' });
    return false;
  }
  function init(namespace) {
    if (lifecycle.status().stopped) return false;
    if (ns === namespace && ns) return true;
    if (ns) throw new Error('SANDBOX_ALREADY_INITIALIZED');
    if (!namespace || typeof namespace.emit !== 'function')
      throw new TypeError('SANDBOX_INVALID_NAMESPACE');
    return lifecycle.run(() => {
      ns = namespace;
      return true;
    });
  }
  function wire(socket, { user, accountId }) {
    if (lifecycle.status().stopped) return false;
    if (!ns) throw new Error('SANDBOX_NOT_INITIALIZED');
    return lifecycle.run(() => {
      if (wired.has(socket)) return false;
      wired.add(socket);
      lifecycle.onSocket(socket, 'sandbox:join', (payload) => {
        if (!user || !admit(socket)) return;
        const char = typeof payload?.char === 'string' ? payload.char : null;
        const defFile = typeof payload?.defFile === 'string' ? payload.defFile : null;
        const result = sbMgr.join(
          { accountId, userId: user.userId, pseudo: user.pseudo, color: user.color },
          char,
          defFile,
        );
        if (!result.ok) return;
        // Send full state snapshot to the joiner
        const state = sbMgr.getState();
        socket.emit('sandbox:state', {
          players: state.players,
          stage: state.stage,
          mySlot: result.slot,
        });
        if (!result.rejoin) {
          // Notify all others that a new player joined
          socket.broadcast.emit('sandbox:player_joined', {
            slot: result.slot,
            userId: user.userId,
            pseudo: user.pseudo,
            color: user.color,
            char,
            defFile,
            x: null,
            y: null,
          });
          ns.emit('sandbox:count', { count: sbMgr.getCount() });
        }
      });

      lifecycle.onSocket(socket, 'sandbox:leave', () => {
        const result = sbMgr.leave(accountId);
        if (!result.ok) return;
        socket.broadcast.emit('sandbox:player_left', { slot: result.slot });
        ns.emit('sandbox:count', { count: sbMgr.getCount() });
      });

      lifecycle.onSocket(socket, 'sandbox:input', (payload) => {
        if (!sbMgr.hasPlayer(accountId)) return;
        const p = sbMgr.getPlayer(accountId);
        // Update last known position for late joiners
        sbMgr.updatePos(
          accountId,
          typeof payload?.x === 'number' ? payload.x : null,
          typeof payload?.y === 'number' ? payload.y : null,
          typeof payload?.stateId === 'string' ? payload.stateId : null,
        );
        // Relay input to all other clients (not the sender)
        socket.broadcast.emit('sandbox:input', {
          slot: p.slot,
          input: payload?.input ?? null,
          x: payload?.x ?? null,
          y: payload?.y ?? null,
          stateId: payload?.stateId ?? null,
          assertedCmd: typeof payload?.assertedCmd === 'string' ? payload.assertedCmd : null,
        });
      });

      lifecycle.onSocket(socket, 'sandbox:hit', (payload) => {
        if (!sbMgr.hasPlayer(accountId)) return;
        const fromPlayer = sbMgr.getPlayer(accountId);
        const targetSlot = typeof payload?.targetSlot === 'number' ? payload.targetSlot : null;
        if (targetSlot === null) return;
        // Find target player and send hit only to their sockets
        for (const [hash, p] of sbMgr._players) {
          if (p.slot === targetSlot) {
            const targetUser = users.get(hash);
            if (targetUser) {
              for (const sock of targetUser.clients) {
                sock.emit('sandbox:hit', { fromSlot: fromPlayer.slot });
              }
            }
            break;
          }
        }
      });

      lifecycle.onSocket(socket, 'sandbox:change_char', (payload) => {
        if (!sbMgr.hasPlayer(accountId)) return;
        const char = typeof payload?.char === 'string' ? payload.char : null;
        const defFile = typeof payload?.defFile === 'string' ? payload.defFile : null;
        const result = sbMgr.changeChar(accountId, char, defFile);
        if (!result.ok) return;
        ns.emit('sandbox:char_changed', { slot: result.slot, char, defFile });
      });

      lifecycle.onSocket(socket, 'sandbox:change_stage', (payload) => {
        if (!sbMgr.hasPlayer(accountId)) return;
        if (!payload?.stage || typeof payload.stage.folder !== 'string') return;
        sbMgr.changeStage(payload.stage);
        ns.emit('sandbox:stage_changed', { stage: sbMgr.getState().stage });
      });

      lifecycle.onSocket(socket, 'sandbox:count_request', () => {
        socket.emit('sandbox:count', { count: sbMgr.getCount() });
      });
      return true;
    });
  }
  return {
    sbMgr,
    init,
    wire,
    stop: lifecycle.stop,
    onSocketDisconnect: (socket) => lifecycle.safely(() => lifecycle.disposeSocket(socket)),
    onUserDisconnect: (id) =>
      lifecycle.safely(() => {
        const result = sbMgr.leave(id);
        if (result.ok) {
          ns.emit('sandbox:player_left', { slot: result.slot });
          ns.emit('sandbox:count', { count: sbMgr.getCount() });
        }
      }),
    status: () => ({
      ...lifecycle.status(),
      accepting: sbMgr.accepting,
      players: sbMgr.getCount(),
    }),
  };
}
