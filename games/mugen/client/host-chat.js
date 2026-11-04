import { createDeferredGame } from '/core/js/games/platform/deferred-game.js';
import { t } from '/core/js/localization/i18n.js';
const EVENTS = [
  'mugen:rooms',
  'mugen:open',
  'mugen:closed',
  'mugen:live_open',
  'mugen:live_closed',
  'mugen:created',
  'mugen:joined',
  'mugen:char_picked',
  'mugen:cancelled',
  'mugen:start',
  'mugen:input',
  'mugen:game_over',
  'mugen:forfeit',
  'mugen:spectate_start',
  'mugen:replay',
  'mugen:error',
];
export function initChat({ socket, getMe, pushSystem }) {
  const win = document.querySelector('[data-win-id="mugen"]');
  if (!win) return null;
  const body = win.querySelector('#mugen-body');
  let isConnected = socket.connected !== false,
    isStopped = false;
  const wrapped = new Map();
  const transport = {
    on(event, handler) {
      const guard = (payload) => {
        if (isConnected && !isStopped) handler(payload);
      };
      wrapped.set(handler, guard);
      socket.on(event, guard);
    },
    off(event, handler) {
      const guard = wrapped.get(handler);
      if (guard) socket.off(event, guard);
      wrapped.delete(handler);
    },
    emit(...args) {
      if (isConnected && !isStopped) socket.emit(...args);
    },
  };
  const feature = createDeferredGame({
    socket: transport,
    events: EVENTS,
    passive: new Set(EVENTS.slice(0, 5)),
    snapshots: new Set(['mugen:rooms']),
    load: (attempt) =>
      import('/games/mugen/client/index.js' + (attempt ? '?retry=' + attempt : '')),
    mount: (module, proxy, scope) => module.initMugen(proxy, getMe, pushSystem, scope),
    onStatus(state) {
      if (state.phase === 'ready') return;
      const message = document.createElement('div');
      message.setAttribute(
        'role',
        state.phase === 'error' || state.phase === 'blocked' ? 'alert' : 'status',
      );
      message.textContent = t(
        state.phase === 'loading'
          ? 'games.status.loading'
          : state.phase === 'error'
            ? 'games.status.loadFailed'
            : state.phase === 'blocked'
              ? 'games.status.interrupted'
              : isConnected
                ? 'games.status.openWindow'
                : 'games.status.chatRequired',
      );
      if (state.phase === 'error') {
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.textContent = t('common.retry');
        retry.addEventListener(
          'click',
          () => void feature.open().catch((error) => console.warn('[mugen] retry failed:', error)),
        );
        message.append(retry);
      }
      body.replaceChildren(message);
    },
  });
  const show = () => {
    if (!isConnected || isStopped || win.dataset.minimized === '1') return;
    if (feature.status().phase === 'ready') feature.refresh();
    void feature.open().catch((error) => console.warn('[mugen] client unavailable:', error));
  };
  let isVisible = win.dataset.minimized !== '1';
  const observer = new MutationObserver(() => {
    const next = win.dataset.minimized !== '1';
    if (next === isVisible) return;
    isVisible = next;
    if (win.dataset.minimized === '1') feature.hide();
    else show();
  });
  observer.observe(win, {
    attributes: true,
    attributeFilter: ['data-minimized'],
  });
  const close = () => feature.close();
  win.addEventListener('wm:close', close);
  const disconnect = () => {
    isConnected = false;
    feature.reset();
  };
  const connect = () => {
    isConnected = true;
    feature.refresh();
    socket.emit('mugen:rooms_request');
    show();
  };
  socket.on('disconnect', disconnect);
  socket.on('connect', connect);
  if (isConnected) connect();
  return {
    socket,
    open: () => feature.open(),
    hide: () => feature.hide(),
    status: () => ({ isStopped, isConnected, feature: feature.status() }),
    stop() {
      if (isStopped) return;
      isStopped = true;
      isConnected = false;
      observer.disconnect();
      win.removeEventListener('wm:close', close);
      socket.off('disconnect', disconnect);
      socket.off('connect', connect);
      feature.stop();
      wrapped.clear();
    },
  };
}
