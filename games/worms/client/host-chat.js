// Worms owns its window (roadmap J5c); its controller and styles come from the
// Worms add-on (ChaOS-addons, roadmap J7d), served under /games/worms/client/.
// Room lists are retained while the window is closed; the controller and its
// assets load when the window opens or when this account is admitted.
import { createDeferredGame } from '/core/js/games/platform/deferred-game.js';
import { createGameScope } from '/core/js/games/platform/game-scope.js';
import { loadFeatureStyle } from '/core/js/features/feature-styles.js';
import { t } from '/core/js/localization/i18n.js';

export const WORMS_EVENTS = Object.freeze([
  'worms:rooms',
  'worms:open',
  'worms:closed',
  'worms:live_open',
  'worms:live_closed',
  'worms:spectate_start',
  'worms:lobby_update',
  'worms:start',
  'worms:pos_update',
  'worms:fire_result',
  'worms:tool_used',
  'worms:drowned',
  'worms:next_turn',
  'worms:delayed_explosion',
  'worms:game_over',
  'worms:rematch_waiting',
  'worms:rematch_lobby',
  'worms:post_exit',
  'worms:forfeit_player',
  'worms:retreat',
  'worms:worm_selected',
  'worms:crate_spawn',
  'worms:crate_collected',
  'worms:error',
  'worms:created',
  'worms:joined',
]);
const PASSIVE = new Set(WORMS_EVENTS.slice(0, 5));
let current = null;

export function initDeferredWorms(socket, getMe, pushSystem, { openWindow, closeWindow } = {}) {
  if (current?.socket === socket) return current;
  current?.stop();
  const win = document.querySelector('[data-win-id="worms"]');
  const body = win?.querySelector(':scope > .wm-body');
  if (!win || !body) return null;
  const show =
    openWindow ||
    ((id) => import('/core/js/desktop/windows/windows.js').then((module) => module.openWindow(id)));
  const hide = closeWindow || (() => win.querySelector('.wm-btn-close')?.click());
  let connected = socket.connected !== false,
    stopped = false,
    instance = null,
    needsLobby = false;
  const isShown = () => win.dataset.minimized !== '1';
  function activate() {
    if (!instance || stopped) return;
    needsLobby = false;
    // Leaving the lobby closes the window; reopening it shows the lobby again.
    // A game in progress is never reset by closing and reopening the window.
    instance.activateWorms(body, () => {
      needsLobby = true;
      if (!stopped && isShown()) hide('worms');
    });
  }
  function onStatus(state) {
    if (state.phase === 'ready') return;
    const message = document.createElement('div');
    message.setAttribute('role', ['error', 'blocked'].includes(state.phase) ? 'alert' : 'status');
    if (state.phase === 'loading') message.textContent = t('games.status.loading');
    else if (state.phase === 'error') {
      message.textContent = `${t('games.status.loadFailed')} `;
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'btn';
      retry.textContent = t('common.retry');
      retry.addEventListener('click', () => {
        void feature.open().catch(() => {});
      });
      message.appendChild(retry);
    } else if (state.phase === 'blocked') message.textContent = t('games.status.interrupted');
    else
      message.textContent = connected
        ? t('games.status.openWindow')
        : t('games.status.chatRequired');
    body.replaceChildren(message);
  }
  const feature = createDeferredGame({
    socket,
    events: WORMS_EVENTS,
    passive: PASSIVE,
    snapshots: new Set(['worms:rooms']),
    load: (attempt) =>
      attempt
        ? import(`/games/worms/client/worms.js?retry=${attempt}`)
        : Promise.all([
            loadFeatureStyle('/games/worms/client/style.css'),
            import('/games/worms/client/worms.js'),
          ]).then((result) => result[1]),
    scopeFactory: () => createGameScope({ allowInput: () => isShown() }),
    mount(module, proxy, scope) {
      instance = module.initWorms(proxy, getMe, pushSystem, scope);
      activate();
      return instance;
    },
    onStatus,
  });
  const onVisibility = () => {
    if (!isShown()) {
      feature.hide();
      return;
    }
    if (!connected) return;
    if (feature.status().phase === 'ready') {
      if (needsLobby) activate();
      return;
    }
    void feature.open().catch(() => {});
  };
  const observer = new MutationObserver(onVisibility);
  observer.observe(win, {
    attributes: true,
    attributeFilter: ['data-minimized'],
  });
  const onDisconnect = () => {
    connected = false;
    instance = null;
    feature.reset();
  };
  const onConnect = () => {
    connected = true;
    instance = null;
    feature.reset();
    socket.emit('worms:rooms_request');
    if (isShown()) void feature.open().catch(() => {});
  };
  // A game this account entered (created, joined, started, spectated) brings its window forward.
  const onAdmitted = () => {
    if (connected && !stopped && !isShown()) void show('worms');
  };
  const ADMISSIONS = ['worms:created', 'worms:joined', 'worms:start', 'worms:spectate_start'];
  for (const event of ADMISSIONS) socket.on(event, onAdmitted);
  socket.on('disconnect', onDisconnect);
  socket.on('connect', onConnect);
  const owner = {
    socket,
    status: () => ({ worms: feature.status(), connected }),
    stop() {
      if (stopped) return;
      stopped = true;
      connected = false;
      observer.disconnect();
      socket.off('disconnect', onDisconnect);
      socket.off('connect', onConnect);
      for (const event of ADMISSIONS) socket.off(event, onAdmitted);
      feature.stop();
      if (current === owner) current = null;
    },
  };
  current = owner;
  if (connected) onConnect();
  return owner;
}

export function initChat({ socket, getMe, pushSystem }) {
  return initDeferredWorms(socket, getMe, pushSystem);
}
