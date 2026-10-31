// MUGEN window: lobby, paid duels and training around Ikemen GO.
// The fight itself runs in engine/host.html (Ikemen GO compiled to
// WebAssembly); this module seats the players, relays the engines' netplay
// traffic through the chat socket and reports how the match ended.
import { createGameScope } from '/core/js/games/game-scope.js';
import { t } from '/core/js/i18n.js';
import { renderUserName } from '/core/js/user-name.js';
import { el } from './dom.js';
import { createPicker } from './picker.js';
import { createLibraryView } from './library-view.js';
import { portrait } from './portrait.js';
import { duelArgs } from './match-options.js';
import { bindVolumeControls } from './volume.js';
import { createEngineResources } from './engine/resources.js';
import { createResidentEngine } from './resident-engine.js';
import { createMoveList } from './move-list.js';

const STYLE_ID = 'mugen-addon-style';
const LIBRARY_STYLE_ID = 'mugen-library-style';
const ONLINE = 'webrtc-casual'; // Ikemen's matchmade path: ChaOS decides who hosts.
const AI_LEVELS = [1, 2, 3, 4, 5, 6, 7, 8];

/** A site translation when it exists, else the English text shipped here. */
function tr(key, fallback, values) {
  const text = t(key, values);
  if (text !== key) return text;
  return fallback.replace(/\{(\w+)\}/g, (_, name) => String(values?.[name] ?? ''));
}

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  document.head.append(
    el('link', {
      id: STYLE_ID,
      rel: 'stylesheet',
      href: '/games/mugen/client/mugen.css',
    }),
  );
}

function ensureLibraryStyle() {
  if (document.getElementById(LIBRARY_STYLE_ID)) return;
  document.head.append(
    el('link', {
      id: LIBRARY_STYLE_ID,
      rel: 'stylesheet',
      href: '/games/mugen/client/library.css',
    }),
  );
}

function playerName(player) {
  return renderUserName(player ?? {}, { fallbackPseudo: '?' });
}

export function initMugen(socket, getMe, pushSystem, scope = createGameScope()) {
  const body = document.getElementById('mugen-body');
  if (!body) throw new Error('MUGEN panel unavailable');
  ensureStyle();
  const root = el('div', { class: 'mugen-root' });
  body.replaceChildren(root);

  const state = {
    view: 'lobby',
    rooms: [],
    liveRooms: [],
    room: null, // { id, slot, players, bet, picks: [character|null, character|null] }
    match: null, // { roomId, frame, engine, pending, reported, finished }
    spectating: null, // { roomId, frame, engine, pending, result }
    catalog: null,
  };
  const notice = (message) => pushSystem?.(message);
  const resources = createEngineResources();
  scope.cleanup(() => resources.dispose());
  const residentEngine = createResidentEngine({ container: body, scope, resources });
  const moveList = createMoveList({
    root,
    scope,
    tr,
    releaseInput: () => state.match?.frame.releaseInput(),
    focusEngine: () => state.match?.frame.focus(),
  });
  void resources.warm().catch(() => {
    // A missing/offline engine is reported when a match is requested; the
    // lobby and uploads remain usable while the engine is being installed.
  });
  bindVolumeControls(scope, (values) => {
    state.match?.frame.setVolume(values);
    state.spectating?.frame.setVolume(values);
  });
  // ── Library ─────────────────────────────────────────────────────────────────

  // The library is a panel of this window, not another window: the view behind
  // stays mounted, so someone who only browses keeps their selection.
  let library = null; // { view, overlay, refreshView }
  let catalogChanged = false;
  let deferredRender = null;

  function closeLibrary() {
    catalogChanged = false;
    deferredRender = null;
    if (!library) return;
    const { view, overlay, behind } = library;
    library = null;
    for (const node of behind) node.inert = false;
    overlay.remove();
    view.destroy();
  }

  /** Closes the panel the way the player asked: what changed underneath re-renders. */
  function leaveLibrary() {
    const refreshView = library?.refreshView ?? null;
    const changed = catalogChanged;
    const pending = deferredRender;
    closeLibrary();
    if (pending) pending();
    else if (changed) refreshView?.();
  }

  /** A socket-driven re-render waits for the panel to close. */
  function whenLibraryClosed(renderView) {
    if (library) deferredRender = renderView;
    else renderView();
  }

  function openLibrary(refreshView = null) {
    if (library) return;
    ensureLibraryStyle();
    const view = createLibraryView({
      text: (key, values) => t('games.mugen.' + key, values),
      compact: true,
      backText: t('games.mugen.back'),
      onBack: leaveLibrary,
      onCatalogChanged: () => {
        state.catalog = null;
        catalogChanged = true;
      },
    });
    const overlay = el('div', { class: 'mugen-library-overlay' }, [view.element]);
    // The view underneath stays mounted (its selection is kept) but must not
    // take keyboard focus while the panel covers it.
    const behind = [...root.children];
    root.append(overlay);
    for (const node of behind) node.inert = true;
    library = { view, overlay, refreshView, behind };
  }

  const libraryButton = (refreshView = null) =>
    el('button', {
      class: 'mugen-button',
      text: tr('games.mugen.library', 'Library'),
      onclick: () => openLibrary(refreshView),
    });

  // ── Catalog ─────────────────────────────────────────────────────────────────

  async function loadCatalog() {
    if (state.catalog) return state.catalog;
    const [characters, stages] = await Promise.all(
      ['/api/mugen/chars', '/api/mugen/stages'].map((url) =>
        scope.fetch(url).then((response) => {
          if (!response.ok) throw new Error('catalog');
          return response.json();
        }),
      ),
    );
    state.catalog = { characters, stages };
    return state.catalog;
  }

  // ── Views ───────────────────────────────────────────────────────────────────

  function show(view, ...nodes) {
    closeLibrary();
    if (state.view === 'match' && view !== 'match') stopEngine();
    if (state.view === 'spectate' && view !== 'spectate') stopWatching();
    state.view = view;
    root.replaceChildren(...nodes);
  }

  function renderLobby() {
    const bet = el('input', {
      type: 'number',
      class: 'mugen-input',
      min: 0,
      value: 0,
      'aria-label': t('games.mugen.betPoints'),
    });
    const openList = el('div', { class: 'mugen-list' });
    const liveList = el('div', { class: 'mugen-list' });
    fillRoomLists(openList, liveList);
    show(
      'lobby',
      el('div', { class: 'mugen-lobby' }, [
        el('section', { class: 'mugen-card' }, [
          el('h3', { text: t('games.mugen.createGame') }),
          el('label', { class: 'mugen-field' }, [tr('games.mugen.betPoints', 'Bet (points)'), bet]),
          el('button', {
            class: 'mugen-button mugen-primary',
            text: t('games.mugen.create'),
            onclick: () =>
              socket.emit('mugen:create', {
                bet: Math.max(0, Math.floor(Number(bet.value) || 0)),
              }),
          }),
          el('button', {
            class: 'mugen-button',
            text: tr('games.mugen.training', 'Training vs CPU'),
            onclick: () => void renderTraining(),
          }),
          libraryButton(),
        ]),
        el('section', { class: 'mugen-card' }, [
          el('h3', { text: t('games.mugen.openRooms') }),
          openList,
        ]),
        el('section', { class: 'mugen-card' }, [
          el('h3', { text: t('games.mugen.liveMatches') }),
          liveList,
        ]),
      ]),
    );
    socket.emit('mugen:rooms_request');
  }

  function fillRoomLists(
    openList = root.querySelectorAll('.mugen-list')[0],
    liveList = root.querySelectorAll('.mugen-list')[1],
  ) {
    if (!openList || !liveList) return;
    openList.replaceChildren(
      ...(state.rooms.length
        ? state.rooms.map((room) =>
            el('div', { class: 'mugen-row' }, [
              playerName(room.players[0]),
              el('span', {
                class: 'mugen-bet',
                text: room.bet ? `${room.bet} pts` : t('games.mugen.free'),
              }),
              el('button', {
                class: 'mugen-button',
                text: t('games.mugen.join'),
                onclick: () => socket.emit('mugen:join', { roomId: room.id }),
              }),
            ]),
          )
        : [
            el('div', {
              class: 'mugen-empty',
              text: t('games.mugen.noOpenRooms'),
            }),
          ]),
    );
    liveList.replaceChildren(
      ...(state.liveRooms.length
        ? state.liveRooms.map((room) =>
            el('div', { class: 'mugen-row' }, [
              el('span', { class: 'mugen-versus' }, [
                portrait(room.players[0]?.character, {
                  size: 'small',
                  className: 'mugen-face',
                }),
                playerName(room.players[0]),
                ' vs ',
                portrait(room.players[1]?.character, {
                  size: 'small',
                  className: 'mugen-face',
                }),
                playerName(room.players[1]),
              ]),
              el('button', {
                class: 'mugen-button',
                text: t('games.mugen.watch'),
                onclick: () => socket.emit('mugen:spectate', { roomId: room.id }),
              }),
            ]),
          )
        : [
            el('div', {
              class: 'mugen-empty',
              text: t('games.mugen.noLiveMatches'),
            }),
          ]),
    );
  }

  async function renderRoom() {
    const room = state.room;
    const sides = [0, 1].map((slot) =>
      el('div', { class: 'mugen-side' + (slot === room.slot ? ' mugen-mine' : '') }, [
        room.players[slot]
          ? playerName(room.players[slot])
          : el('em', { text: t('games.mugen.waiting') }),
        portrait(room.picks[slot]),
        el('div', {
          class: 'mugen-pick',
          text:
            room.picks[slot]?.name ?? (room.players[slot] ? t('games.mugen.chooseCharacter') : ''),
        }),
      ]),
    );
    const leave = el('button', {
      class: 'mugen-button',
      text: t('games.mugen.cancel'),
      onclick: () => {
        socket.emit('mugen:forfeit', { roomId: room.id });
        state.room = null;
        renderLobby();
      },
    });
    const header = el('div', { class: 'mugen-room-header' }, [
      el('span', { text: t('games.mugen.room', { roomId: room.id }) }),
      room.bet ? el('span', { class: 'mugen-bet', text: `${room.bet} pts` }) : null,
    ]);
    if (room.picks[room.slot]) {
      show(
        'room',
        el('div', { class: 'mugen-room' }, [
          header,
          el('div', { class: 'mugen-sides' }, [sides[0], el('b', { text: 'VS' }), sides[1]]),
          el('div', { class: 'mugen-actions' }, [leave]),
        ]),
      );
      return;
    }
    show(
      'room',
      el('div', { class: 'mugen-room' }, [
        header,
        el('div', {
          class: 'mugen-empty',
          text: t('games.mugen.loadingCharacters'),
        }),
      ]),
    );
    let catalog;
    try {
      catalog = await loadCatalog();
    } catch {
      notice(t('games.mugen.charactersLoadFailed'));
      return;
    }
    if (state.view !== 'room' || state.room !== room) return;
    const picker = createPicker({
      characters: catalog.characters,
      stages: room.slot === 0 ? catalog.stages : null,
      tr,
      confirmText: t('games.mugen.confirm'),
      onConfirm: ({ character, stage }) => {
        socket.emit('mugen:select_char', {
          roomId: room.id,
          character: character.path,
          stage: stage?.path ?? null,
        });
      },
    });
    show(
      'room',
      el('div', { class: 'mugen-room' }, [
        header,
        el('div', { class: 'mugen-sides' }, [sides[0], el('b', { text: 'VS' }), sides[1]]),
        picker,
        el('div', { class: 'mugen-actions' }, [libraryButton(() => void renderRoom()), leave]),
      ]),
    );
  }

  async function renderTraining() {
    let catalog;
    try {
      catalog = await loadCatalog();
    } catch {
      notice(t('games.mugen.charactersLoadFailed'));
      return;
    }
    const level = el(
      'select',
      {
        class: 'mugen-input',
        'aria-label': tr('games.mugen.cpuLevel', 'CPU level'),
      },
      AI_LEVELS.map((value) => el('option', { value, text: String(value), selected: value === 4 })),
    );
    const picker = createPicker({
      characters: catalog.characters,
      stages: catalog.stages,
      opponent: true,
      tr,
      confirmText: t('games.mugen.fight'),
      onConfirm: ({ character, opponent, stage }) =>
        startTraining({
          character,
          opponent: opponent ?? character,
          stage,
          level: Number(level.value),
        }),
    });
    show(
      'training',
      el('div', { class: 'mugen-room' }, [
        el('div', { class: 'mugen-room-header' }, [
          el('span', { text: tr('games.mugen.training', 'Training vs CPU') }),
          el('label', { class: 'mugen-field' }, [tr('games.mugen.cpuLevel', 'CPU level'), level]),
        ]),
        picker,
        el('div', { class: 'mugen-actions' }, [
          libraryButton(() => void renderTraining()),
          el('button', {
            class: 'mugen-button',
            text: t('games.mugen.back'),
            onclick: renderLobby,
          }),
        ]),
      ]),
    );
  }

  function renderResult({ title, detail }) {
    show(
      'result',
      el('div', { class: 'mugen-result' }, [
        el('h2', { text: title }),
        detail ? el('p', { text: detail }) : null,
        el('button', {
          class: 'mugen-button mugen-primary',
          text: t('games.mugen.lobby'),
          onclick: renderLobby,
        }),
      ]),
    );
  }

  // ── Engine ──────────────────────────────────────────────────────────────────

  function stopEngine() {
    moveList.setCharacters([]);
    state.match?.frame.destroy();
    state.match = null;
  }

  function stopWatching() {
    if (state.spectating) socket.emit('mugen:unspectate');
    state.spectating?.frame.destroy();
    state.spectating = null;
  }

  function engineStatusText(status) {
    if (status.phase === 'engine')
      return tr('games.mugen.loadingEngine', 'Loading the engine… {percent}%', {
        percent: Math.round((status.progress ?? 0) * 100),
      });
    if (status.phase === 'running') return '';
    return t('games.mugen.loadingFighters');
  }

  /** Mounts the engine view and starts a match; resolves with the engine's exit outcome. */
  function runEngine({
    args,
    net = null,
    roomId = null,
    onForfeit = null,
    characters = [],
    slot = 0,
  }) {
    const overlay = el('div', {
      class: 'mugen-overlay',
      text: t('games.mugen.loadingFighters'),
    });
    const stage = el('div', { class: 'mugen-stage' }, [overlay]);
    const bar = el('div', { class: 'mugen-bar' }, [
      el('span', {
        class: 'mugen-hint',
        'data-mugen-controls': '',
        text: tr('games.mugen.ikemenControls', 'Arrows move · Z X C / A S D attack · Enter start'),
      }),
      el('button', {
        class: 'mugen-button',
        text: tr('games.mugen.movesButton', 'Move list · Esc'),
        'data-mugen-moves': '',
        onclick: moveList.toggle,
      }),
      onForfeit
        ? el('button', {
            class: 'mugen-button',
            text: t('games.mugen.forfeit'),
            onclick: onForfeit,
          })
        : el('button', {
            class: 'mugen-button',
            text: t('games.mugen.quit'),
            onclick: renderLobby,
          }),
    ]);
    show('match', el('div', { class: 'mugen-match' }, [stage, bar]));
    moveList.setCharacters(characters, slot);
    const frame = residentEngine.acquire(stage);
    const match = {
      roomId,
      role: net?.role ?? null,
      frame,
      engine: null,
      pending: [],
      reported: false,
      finished: false,
    };
    state.match = match;
    return new Promise((resolve) => {
      frame
        .start({
          args,
          net,
          onEscape: moveList.toggle,
          canFocus: () => !moveList.isOpen(),
          onStatus: (status) => {
            if (state.match !== match) return;
            overlay.textContent = engineStatusText(status);
            if (status.phase === 'running') overlay.remove();
          },
          onExit: (outcome) => resolve(outcome),
        })
        .then((engine) => {
          if (state.match !== match) return;
          match.engine = engine;
          for (const [channel, data] of match.pending) engine.receive(channel, data);
          match.pending = [];
        })
        .catch((error) => {
          const missing = error?.message === 'engine_missing';
          resolve({
            code: 2,
            winSide: null,
            errors: [
              missing
                ? tr(
                    'games.mugen.engineMissing',
                    'The MUGEN engine is not installed on this server.',
                  )
                : String(error?.message ?? error),
            ],
          });
        });
    });
  }

  async function startTraining({ character, opponent, stage, level }) {
    const stages = state.catalog?.stages ?? [];
    const chosen = stage ?? stages[Math.floor(Math.random() * stages.length)];
    const args = ['-p1', character.path, '-p2', opponent.path, '-p2.ai', String(level)];
    if (chosen) args.push('-s', 'stages/' + chosen.path);
    const pending = runEngine({ args, characters: [character, opponent] });
    const match = state.match;
    const outcome = await pending;
    if (state.view !== 'match' || state.match !== match) return;
    stopEngine();
    if (outcome.code !== 0 && outcome.errors.length) notice(outcome.errors.at(-1));
    void renderTraining();
  }

  async function startOnline(start) {
    state.room = null;
    const roomId = start.roomId;
    const names = start.players.map((player) => player?.pseudo ?? '?');
    const args = [...duelArgs(start), '-ip', ONLINE];
    const net = {
      role: start.role,
      names,
      sendReplay: (chunk) => socket.emit('mugen:replay', { roomId, ...chunk }),
      // The engine frame is another realm: copy its bytes so the socket sees a local Uint8Array.
      send: (channel, data) =>
        socket.emit('mugen:net', {
          roomId,
          channel,
          data: new Uint8Array(data),
        }),
    };
    const outcome = await runEngine({
      args,
      net,
      roomId,
      characters: [start.p1, start.p2],
      slot: start.slot,
      onForfeit: () => {
        if (window.confirm(t('games.mugen.confirmForfeit')))
          socket.emit('mugen:forfeit', { roomId });
      },
    });
    const match = state.match;
    if (!match || match.roomId !== roomId || match.reported) return;
    match.reported = true;
    socket.emit(
      'mugen:result',
      outcome.winSide === 0 || outcome.winSide === 1
        ? { roomId, winSide: outcome.winSide }
        : { roomId, aborted: true },
    );
    if (outcome.code !== 0 && outcome.errors.length) notice(outcome.errors.at(-1));
    moveList.setCharacters([]);
    match.frame.destroy();
    if (!match.finished)
      show(
        'match',
        el('div', { class: 'mugen-result' }, [
          el('p', {
            text: tr('games.mugen.waitingResult', 'Waiting for the result…'),
          }),
        ]),
      );
  }

  function finishMatch({ winner, loser, refunded, payout }) {
    const me = getMe?.();
    const won = winner && (winner.userId === me?.userId || winner.pseudo === me?.pseudo);
    if (state.match) state.match.finished = true;
    stopEngine();
    if (refunded) {
      renderResult({
        title: tr('games.mugen.refunded', 'Match cancelled'),
        detail: tr(
          'games.mugen.refundedDetail',
          'The engines disagreed or the match was interrupted: bets were refunded.',
        ),
      });
      return;
    }
    const isPlayer = [winner, loser].some(
      (player) => player && (player.userId === me?.userId || player.pseudo === me?.pseudo),
    );
    if (!isPlayer) {
      renderResult({
        title: `${winner?.pseudo ?? '?'} ${tr('games.mugen.wins', 'wins')}`,
        detail: payout ? `${payout} pts` : '',
      });
      return;
    }
    renderResult({
      title: won ? t('games.mugen.victory') : t('games.mugen.defeat'),
      detail: payout ? `${payout} pts` : '',
    });
  }

  function renderSpectate({ roomId, players, stage, p1, p2 }) {
    // The server has already moved this socket to the new room.
    state.spectating?.frame.destroy();
    state.spectating = null;
    const waiting = el('div', {
      class: 'mugen-overlay',
      text: t('games.mugen.loadingFighters'),
    });
    const canvasStage = el('div', { class: 'mugen-stage' }, [waiting]);
    const status = el('span', { class: 'mugen-hint', text: stage?.name ?? '' });
    const side = (player) =>
      el('div', { class: 'mugen-spectator-side' }, [
        portrait(player?.character, { size: 'small', className: 'mugen-face' }),
        playerName(player),
        el('span', {
          class: 'mugen-pick',
          text: player?.character?.name ?? '',
        }),
      ]);
    show(
      'spectate',
      el('div', { class: 'mugen-match' }, [
        el('div', { class: 'mugen-bar' }, [
          side(players[0]),
          el('b', { text: 'VS' }),
          side(players[1]),
        ]),
        canvasStage,
        el('div', { class: 'mugen-bar' }, [
          status,
          el('button', {
            class: 'mugen-button',
            text: t('games.mugen.back'),
            onclick: renderLobby,
          }),
        ]),
      ]),
    );
    const frame = residentEngine.acquire(canvasStage);
    const watching = {
      roomId,
      frame,
      engine: null,
      pending: [],
      result: null,
      exited: false,
      ready: false,
    };
    state.spectating = watching;
    frame
      .start({
        args: duelArgs({ p1, p2, stage }),
        replay: {
          onProgress: ({ behindBytes }) => {
            if (state.spectating !== watching) return;
            if (watching.ready) waiting.remove();
            status.textContent =
              behindBytes > 64 * 120
                ? tr('games.mugen.catchingUp', 'Catching up to the live match…')
                : tr('games.mugen.live', 'Live');
          },
        },
        onStatus: (value) => {
          if (state.spectating !== watching) return;
          waiting.textContent = engineStatusText(value);
          if (value.phase === 'running') {
            watching.ready = true;
            waiting.remove();
            status.textContent = tr('games.mugen.waitingReplay', 'Waiting for confirmed inputs…');
          }
        },
        onExit: (outcome) => {
          if (state.spectating !== watching) return;
          watching.exited = true;
          if (watching.result) finishMatch(watching.result);
          else if (outcome.code !== 0) {
            notice(outcome.errors?.at(-1) ?? 'replay_failed');
            renderLobby();
          }
        },
      })
      .then((engine) => {
        if (state.spectating !== watching) return;
        watching.engine = engine;
        for (const chunk of watching.pending) engine.receiveReplay(chunk);
        watching.pending = [];
        if (watching.result) engine.endReplay();
      })
      .catch((error) => {
        if (state.spectating !== watching) return;
        notice(String(error?.message ?? error));
        if (watching.result) finishMatch(watching.result);
        else renderLobby();
      });
  }

  // ── Socket ──────────────────────────────────────────────────────────────────

  const handlers = {
    'mugen:rooms': ({ rooms = [], liveRooms = [] } = {}) => {
      state.rooms = rooms;
      state.liveRooms = liveRooms;
      if (state.view === 'lobby') fillRoomLists();
    },
    'mugen:open': (room) => {
      if (!room?.id || state.rooms.some((entry) => entry.id === room.id)) return;
      state.rooms.push(room);
      if (state.view === 'lobby') fillRoomLists();
    },
    'mugen:closed': ({ roomId } = {}) => {
      state.rooms = state.rooms.filter((room) => room.id !== roomId);
      if (state.view === 'lobby') fillRoomLists();
    },
    'mugen:live_open': (room) => {
      if (!room?.id || state.liveRooms.some((entry) => entry.id === room.id)) return;
      state.liveRooms.push(room);
      if (state.view === 'lobby') fillRoomLists();
    },
    'mugen:live_closed': ({ roomId } = {}) => {
      state.liveRooms = state.liveRooms.filter((room) => room.id !== roomId);
      if (state.view === 'lobby') fillRoomLists();
    },
    'mugen:created': ({ roomId, room }) => {
      state.catalog = null;
      state.room = {
        id: roomId,
        slot: 0,
        players: room.players,
        bet: room.bet,
        picks: [room.players[0]?.character ?? null, room.players[1]?.character ?? null],
      };
      void renderRoom();
    },
    'mugen:joined': ({ roomId, slot, players, bet }) => {
      state.catalog = null;
      state.room = {
        id: roomId,
        slot,
        players,
        bet,
        picks: [players[0]?.character ?? null, players[1]?.character ?? null],
      };
      whenLibraryClosed(() => void renderRoom());
    },
    'mugen:char_picked': ({ slot, character }) => {
      if (!state.room || (slot !== 0 && slot !== 1)) return;
      state.room.picks[slot] = character;
      whenLibraryClosed(() => void renderRoom());
    },
    'mugen:start': (start) => void startOnline(start),
    'mugen:input': ({ roomId, channel, data }) => {
      const match = state.match;
      if (!match || match.roomId !== roomId) return;
      const bytes = new Uint8Array(data);
      if (match.engine) match.engine.receive(channel, bytes);
      else match.pending.push([channel, bytes]);
    },
    'mugen:game_over': (result) => {
      const watching = state.spectating;
      if (!watching || watching.roomId !== result.roomId) {
        if (state.match?.roomId === result.roomId) finishMatch(result);
        return;
      }
      watching.result = result;
      if (watching.exited || result.refunded) finishMatch(result);
      else watching.engine?.endReplay();
    },
    'mugen:forfeit': () => {
      // The game_over that follows carries the outcome.
    },
    'mugen:cancelled': () => {
      stopEngine();
      state.room = null;
      notice(t('games.mugen.opponentForfeited'));
      renderLobby();
    },
    'mugen:spectate_start': (payload) => renderSpectate(payload),
    'mugen:replay': (chunk) => {
      const watching = state.spectating;
      if (watching?.roomId !== chunk?.roomId) return;
      const local = { offset: chunk.offset, data: new Uint8Array(chunk.data) };
      if (watching.engine) watching.engine.receiveReplay(local);
      else watching.pending.push(local);
    },
    'mugen:error': ({ error, roomId } = {}) => {
      notice(tr(`games.mugen.error.${error}`, error ?? 'error'));
      if (error === 'replay_unavailable' && state.spectating?.roomId === roomId) renderLobby();
    },
  };
  scope.on(document, 'chaos:language:changed', () => {
    const hint = root.querySelector('[data-mugen-controls]');
    const button = root.querySelector('[data-mugen-moves]');
    if (hint) hint.textContent = t('games.mugen.ikemenControls');
    if (button) button.textContent = t('games.mugen.movesButton');
  });
  for (const [event, handler] of Object.entries(handlers)) socket.on(event, handler);
  scope.cleanup(() => {
    for (const [event, handler] of Object.entries(handlers)) socket.off(event, handler);
    closeLibrary();
    stopEngine();
    stopWatching();
  });

  renderLobby();
  return {
    disconnected: () => {
      state.rooms = [];
      state.liveRooms = [];
      if ((state.match && !state.match.roomId) || state.view === 'training') return;
      stopEngine();
      stopWatching();
      state.room = null;
      renderLobby();
    },
    close: () => {
      const roomId = state.match?.roomId ?? state.room?.id;
      if (roomId && !state.match?.reported && !state.match?.finished)
        socket.emit('mugen:forfeit', { roomId });
      if (state.spectating) socket.emit('mugen:unspectate');
    },
    refresh: () => {
      state.catalog = null;
      socket.emit('mugen:rooms_request');
    },
    releaseInput: () => {
      document.activeElement?.blur?.();
    },
  };
}
