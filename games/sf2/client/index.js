import { createGameScope } from '/core/js/games/game-scope.js';
import { setSafeHtml } from '/core/js/safe-dom.js';
import { t } from '/core/js/i18n.js';
import { renderUserName, userNameHtml } from '/core/js/user-name.js';
// ChaOS — Street Fighter 2 client module
//
// Handles the SF2 window lifecycle:
//   lobby  → create/join a room
//   waiting → creator waiting for opponent
//   playing → iframe with the SF2 game + postMessage bridge
//   over   → result screen
//
// Only the parent page has a socket.io connection.
// The iframe communicates via postMessage.

const VALID_CHARS = ['Ryu', 'Ken'];

export function initSF2(socket, getMe, pushSystem, scope = createGameScope()) {
  const body = document.getElementById('sf2-body');
  if (!body) throw new Error('SF2 panel unavailable');

  let _stage     = 'lobby'; // 'lobby' | 'waiting' | 'playing' | 'over'
  let _openRooms = [];
  let _liveRooms = [];
  let _myRoomId  = null;
  let _mySlot    = -1;
  let _wins      = [0, 0];
  let _round     = 1;
  let _iframe    = null;
  let _myChar    = 'Ryu';
  let _oppChar   = 'Ken';

  function escHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => {
      switch (ch) {
        case '&': return '&amp;';
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '"': return '&quot;';
        case "'": return '&#39;';
        default: return '';
      }
    });
  }

  function safeChar(value, fallback = 'Ryu') {
    return VALID_CHARS.includes(value) ? value : fallback;
  }

  function playerAt(players, index) {
    return Array.isArray(players) ? players.at(index) : null;
  }

  function sf2ErrorMessage(error) {
    const msgs = {
      insufficient_balance: t('games.sf2.error.insufficientBalance'),
      already_in_room:      t('games.sf2.error.alreadyInRoom'),
      cannot_join_own:      t('games.sf2.error.cannotJoinOwn'),
      not_found:            t('games.sf2.error.notFound'),
      already_started:      t('games.sf2.error.alreadyStarted'),
    };
    return Object.hasOwn(msgs, error) ? Reflect.get(msgs, error) : t('games.unknownError');
  }

  // ── Key forwarding to iframe (fixes focus issue) ─────────────────────────
  // Keyboard events fire on the main page window (where focus usually stays).
  // We forward them to the iframe via postMessage so the game always receives
  // input regardless of whether the iframe has keyboard focus.
  const SF2_GAME_KEYS = new Set(['q','z','d','s','u','i','o','j','k','l']);
  let _keyFwdDown      = null;
  let _keyFwdUp        = null;
  let _keyFwdPress     = null; // blocks Firefox quick-find on keypress
  let _sf2FocusHandler = null;
  let _sf2BlurHandler  = null;
  let _sf2VisHandler   = null;
  let _sf2Focused      = false; // true when user has clicked the SF2 panel

  // Release all game keys in the iframe (call on blur / focus-loss)
  function _releaseAllSf2Keys() {
    if (!_iframe?.contentWindow) return;
    for (const k of SF2_GAME_KEYS) {
      _iframe.contentWindow.postMessage({ type: 'sf2:key', isDown: false, key: k }, window.location.origin);
    }
  }

  function _setupKeyForwarding() {
    _teardownKeyForwarding();
    // Start focused — the game just launched so we want immediate input.
    _sf2Focused = true;

    // Track focus: click inside the SF2 panel → focused; click anywhere else → unfocused.
    _sf2FocusHandler = (e) => {
      const sf2Panel = e.target.closest('.fg-panel-sf2');
      const wasFocused = _sf2Focused;
      _sf2Focused = !!sf2Panel;
      // Release all held keys whenever focus state changes to prevent stuck keys.
      if (wasFocused || _sf2Focused) _releaseAllSf2Keys();
    };
    scope.on(document, 'mousedown', _sf2FocusHandler, true);

    // Release keys on window/tab blur so keyup-less focus-loss can't leave keys stuck.
    _sf2BlurHandler = () => { _sf2Focused = false; _releaseAllSf2Keys(); };
    _sf2VisHandler  = () => { if (document.hidden) _sf2BlurHandler(); };
    scope.on(window, 'blur', _sf2BlurHandler);
    scope.on(document, 'visibilitychange', _sf2VisHandler);

    // Use capture phase (fires before browser built-ins) so we can block Firefox's
    // "Find As You Type" / quick-find bar for game keys while the game is active.
    _keyFwdDown = (e) => {
      if (body.closest('.wm-win')?.dataset.minimized === '1') return;
      if (!SF2_GAME_KEYS.has(e.key.toLowerCase())) return;
      // Always block browser default for game keys during play (stops Firefox quick-find).
      e.preventDefault();
      if (!_sf2Focused || e.repeat) return;
      _iframe?.contentWindow?.postMessage({ type: 'sf2:key', isDown: true,  key: e.key }, window.location.origin);
    };
    _keyFwdUp = (e) => {
      if (body.closest('.wm-win')?.dataset.minimized === '1') return;
      if (!SF2_GAME_KEYS.has(e.key.toLowerCase())) return;
      e.preventDefault();
      if (!_sf2Focused) return;
      _iframe?.contentWindow?.postMessage({ type: 'sf2:key', isDown: false, key: e.key }, window.location.origin);
    };
    // keypress: Firefox's quick-find bar is triggered here; block it for game keys.
    _keyFwdPress = (e) => {
      if (body.closest('.wm-win')?.dataset.minimized === '1') return;
      if (SF2_GAME_KEYS.has(e.key?.toLowerCase())) e.preventDefault();
    };
    scope.on(document, 'keydown',  _keyFwdDown,  true);
    scope.on(document, 'keyup',    _keyFwdUp,    true);
    scope.on(document, 'keypress', _keyFwdPress, true);
  }

  function _teardownKeyForwarding() {
    _releaseAllSf2Keys();
    if (_sf2FocusHandler) { scope.off(document, 'mousedown',   _sf2FocusHandler, true); _sf2FocusHandler = null; }
    if (_sf2BlurHandler)  { scope.off(window, 'blur',          _sf2BlurHandler);         _sf2BlurHandler  = null; }
    if (_sf2VisHandler)   { scope.off(document, 'visibilitychange', _sf2VisHandler);     _sf2VisHandler   = null; }
    if (_keyFwdDown)      { scope.off(document, 'keydown',     _keyFwdDown,  true);      _keyFwdDown      = null; }
    if (_keyFwdUp)        { scope.off(document, 'keyup',       _keyFwdUp,    true);      _keyFwdUp        = null; }
    if (_keyFwdPress)     { scope.off(document, 'keypress',    _keyFwdPress, true);      _keyFwdPress     = null; }
    _sf2Focused = false;
  }

  // ── render helpers ───────────────────────────────────────────────────────

  function render() {
    if (_stage === 'lobby')   renderLobby();
    else if (_stage === 'waiting') renderWaiting();
    else if (_stage === 'playing') renderPlaying();
    else if (_stage === 'over')    renderOver();
  }

  function renderLobby() {
    _teardownKeyForwarding();
    setSafeHtml(body, `
      <div class="sf2-lobby">
        <div class="sf2-lobby-split">
          <!-- Create form -->
          <section class="sf2-section">
            <h3 class="sf2-section-title">🥊 ${t('games.sf2.createGame')}</h3>
            <div class="sf2-char-row" id="sf2-char-create">
              ${VALID_CHARS.map(c => `
                <button class="sf2-char-btn${c === _myChar ? ' active' : ''}" data-char="${c}">${c}</button>
              `).join('')}
            </div>
            <div class="sf2-bet-row">
              <label class="sf2-label">${t('games.sf2.betPoints')}</label>
              <input class="sf2-bet-input" id="sf2-bet" type="number" min="0" step="100" value="0" placeholder="0">
            </div>
            <button class="sf2-btn sf2-btn-create" id="sf2-create-btn">${t('games.sf2.create')}</button>
          </section>

          <!-- Open rooms -->
          <section class="sf2-section sf2-rooms-section">
            <h3 class="sf2-section-title">${t('games.sf2.openRooms')}</h3>
            <div class="sf2-room-list" id="sf2-open-list">
              ${renderOpenListHtml()}
            </div>
          </section>
        </div>

        <!-- Live games -->
        ${_liveRooms.length > 0 ? `
          <section class="sf2-section sf2-live-section">
            <h3 class="sf2-section-title">${t('games.sf2.liveMatches')}</h3>
            <div class="sf2-room-list" id="sf2-live-list">
              ${renderLiveList()}
            </div>
          </section>
        ` : ''}

        <p class="sf2-controls-hint">
          <strong style="color:#e8c000">${t('games.sf2.controls')}</strong> — ZQSD ← ↑ ↓ → &nbsp;|&nbsp; U/I/O LP·MP·HP &nbsp; J/K/L LK·MK·HK
        </p>
      </div>
    `);
    // Char select
    body.querySelectorAll('.sf2-char-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        _myChar = safeChar(btn.dataset.char, _myChar);
        body.querySelectorAll('.sf2-char-btn').forEach(b => b.classList.toggle('active', b === btn));
      });
    });
    body.querySelector('#sf2-create-btn')?.addEventListener('click', () => {
      const bet = Math.max(0, parseInt(body.querySelector('#sf2-bet')?.value || '0', 10) || 0);
      socket.emit('sf2:create', { char: _myChar, bet });
    });
  }

  function renderOpenListHtml() {
    if (!_openRooms.length) return `<p class="sf2-empty">${t('games.sf2.noOpenRooms')}</p>`;
    return _openRooms.map(r => {
      const me = getMe();
      const creator = playerAt(r.players, 0);
      const isMine = creator?.userId === me?.userId;
      const roomId = escHtml(r.roomId);
      const bet = Math.max(0, Number(r.bet) || 0);
      return `
        <div class="sf2-room-entry">
          ${userNameHtml(creator, { className: 'sf2-room-name', fallbackPseudo: '?' })}
          <span class="sf2-room-char">${escHtml(safeChar(creator?.char, '?'))} vs ?</span>
          ${bet > 0 ? `<span class="sf2-room-bet">${bet} pts</span>` : ''}
          ${!isMine ? `<button class="sf2-btn sf2-btn-join" data-room="${roomId}">${t('games.sf2.join')}</button>` : `<button class="sf2-btn sf2-btn-cancel" data-room="${roomId}">${t('games.sf2.cancel')}</button>`}
        </div>
      `;
    }).join('');
  }

  function renderLiveList() {
    return _liveRooms.map(r => {
      const p0 = playerAt(r.players, 0);
      const p1 = playerAt(r.players, 1);
      const round = Math.max(1, Number(r.round) || 1);
      return `
      <div class="sf2-room-entry">
        ${userNameHtml(p0, { className: 'sf2-room-name', fallbackPseudo: '?' })}
        <span class="sf2-room-vs">vs</span>
        ${userNameHtml(p1, { className: 'sf2-room-name', fallbackPseudo: '?' })}
        <span class="sf2-room-round">R${round}</span>
      </div>
    `;
    }).join('');
  }

  function bindLobbyListEvents() {
    body.querySelectorAll('.sf2-btn-join').forEach(btn => {
      btn.addEventListener('click', () => {
        const roomId = btn.dataset.room;
        // Pick the opponent char (flip from creator's char or just pick)
        const room = _openRooms.find(r => r.roomId === roomId);
        const creatorChar = safeChar(playerAt(room?.players, 0)?.char, 'Ryu');
        const joinChar = VALID_CHARS.find(c => c !== creatorChar) ?? 'Ken';
        socket.emit('sf2:join', { roomId, char: joinChar });
      });
    });
    body.querySelectorAll('.sf2-btn-cancel').forEach(btn => {
      btn.addEventListener('click', () => {
        socket.emit('sf2:forfeit', { roomId: btn.dataset.room });
      });
    });
  }

  function renderWaiting() {
    _teardownKeyForwarding();
    setSafeHtml(body, `
      <div class="sf2-waiting">
        <p class="sf2-waiting-msg">${t('games.sf2.waitingForOpponent')}</p>
        <p class="sf2-waiting-room">${t('games.sf2.roomLabel')} <code>${escHtml(_myRoomId)}</code></p>
        <button class="sf2-btn sf2-btn-cancel-wait" id="sf2-cancel-wait">${t('games.sf2.cancel')}</button>
      </div>
    `);
    body.querySelector('#sf2-cancel-wait')?.addEventListener('click', () => {
      socket.emit('sf2:forfeit', { roomId: _myRoomId });
    });
  }

  function renderPlaying() {
    // Create the game iframe
    const params = new URLSearchParams({
      slot:   _mySlot,
      roomId: _myRoomId,
      p0:     _oppChar && _mySlot === 1 ? _oppChar : _myChar,
      p1:     _oppChar && _mySlot === 0 ? _oppChar : _myChar,
    });
    // p0 = slot 0 char, p1 = slot 1 char
    if (_mySlot === 0) {
      params.set('p0', _myChar);
      params.set('p1', _oppChar || 'Ken');
    } else {
      params.set('p0', _oppChar || 'Ryu');
      params.set('p1', _myChar);
    }

    const gameWrap = document.createElement('div');
    gameWrap.className = 'sf2-game-wrap';
    const hud = document.createElement('div');
    hud.className = 'sf2-hud';
    const p1Wins = document.createElement('span');
    p1Wins.className = 'sf2-wins';
    p1Wins.textContent = `P1: ${'★'.repeat((_wins.at(0) ?? 0))}${'☆'.repeat(2 - (_wins.at(0) ?? 0))}`;
    const round = document.createElement('span');
    round.className = 'sf2-round';
    round.textContent = t('games.sf2.round', { round: _round });
    const p2Wins = document.createElement('span');
    p2Wins.className = 'sf2-wins sf2-wins-right';
    p2Wins.textContent = `P2: ${'★'.repeat((_wins.at(1) ?? 0))}${'☆'.repeat(2 - (_wins.at(1) ?? 0))}`;
    hud.append(p1Wins, round, p2Wins);
    const iframe = document.createElement('iframe');
    iframe.id = 'sf2-iframe';
    iframe.className = 'sf2-iframe';
    iframe.src = `/sf2/index.html?${params.toString()}`;
    iframe.allow = 'autoplay; keyboard-map';
    iframe.allowFullscreen = true;
    const forfeitButton = document.createElement('button');
    forfeitButton.id = 'sf2-forfeit-btn';
    forfeitButton.className = 'sf2-btn sf2-btn-forfeit';
    forfeitButton.textContent = t('games.sf2.forfeit');
    gameWrap.append(hud, iframe, forfeitButton);
    body.replaceChildren(gameWrap);
    _iframe = body.querySelector('#sf2-iframe');
    _setupKeyForwarding();

    body.querySelector('#sf2-forfeit-btn')?.addEventListener('click', () => {
      if (confirm(t('games.sf2.confirmForfeit'))) {
        socket.emit('sf2:forfeit', { roomId: _myRoomId });
      }
    });
  }

  function renderOver() {
    _stage = 'lobby';
    _myRoomId = null;
    _mySlot = -1;
    _wins = [0, 0];
    _round = 1;
    _iframe = null;
    _myChar = 'Ryu';
    _oppChar = 'Ken';
    renderLobby();
    bindLobbyListEvents();
  }

  function renderGameOver({ winner, wins, payout, forfeit, draw }) {
    _teardownKeyForwarding();
    _iframe = null;
    const me = getMe();
    const isWinner = !draw && winner?.userId === me?.userId;
    const isDraw   = !!draw;
    const isForfeit = !!forfeit;

    const { titleKey, titleColor } = _gameOverTitle(isDraw, isWinner);
    const over = _buildGameOverScreen(titleKey, titleColor, winner, isDraw, isWinner, isForfeit, wins, payout);
    body.replaceChildren(over);
  }

  function _gameOverTitle(isDraw, isWinner) {
    if (isDraw) return { titleKey: t('games.sf2.draw'), titleColor: '#e8c000' };
    if (isWinner) return { titleKey: t('games.sf2.victory'), titleColor: '#2dce6e' };
    return { titleKey: t('games.sf2.defeat'), titleColor: '#e84040' };
  }

  function _buildGameOverScreen(titleKey, titleColor, winner, isDraw, isWinner, isForfeit, wins, payout) {
    const needed = 2;
    const p0Wins = Array.isArray(wins) ? (wins.at(0) ?? 0) : 0;
    const p1Wins = Array.isArray(wins) ? (wins.at(1) ?? 0) : 0;

    const over = document.createElement('div');
    over.className = 'sf2-over';
    over.style.cssText = 'flex:1;display:flex;align-items:center;justify-content:center;min-height:0;background:#05050a;position:relative;overflow:hidden;';

    const bg = document.createElement('div');
    bg.className = 'sf2-over-bg';
    over.appendChild(bg);

    const content = document.createElement('div');
    content.className = 'sf2-over-content';
    content.style.cssText = 'position:relative;display:flex;flex-direction:column;align-items:center;gap:18px;text-align:center;padding:32px 40px;';
    over.appendChild(content);

    const title = document.createElement('div');
    title.className = 'sf2-over-title';
    title.style.setProperty('--clr', titleColor);
    title.style.color = titleColor;
    title.textContent = titleKey;
    content.appendChild(title);

    _addGameOverWinner(content, winner, isDraw, payout);
    _addGameOverStars(content, wins, needed, p0Wins, p1Wins, isDraw);
    _addGameOverForfeit(content, isForfeit, isWinner);
    _addGameOverBackBtn(content);

    return over;
  }

  function _addGameOverWinner(content, winner, isDraw, payout) {
    if (!isDraw && winner) {
      const winnerEl = document.createElement('div');
      winnerEl.className = 'sf2-over-winner';
      const label = document.createElement('span');
      label.className = 'sf2-over-winner-label';
      label.textContent = t('games.sf2.winner');
      const name = renderUserName(winner, { className: 'sf2-over-winner-name', fallbackPseudo: '?' });
      winnerEl.append(label, name);
      const paid = Math.max(0, Number(payout) || 0);
      if (paid > 0) {
        const payoutEl = document.createElement('span');
        payoutEl.className = 'sf2-over-payout';
        payoutEl.textContent = `+${paid} pts`;
        winnerEl.appendChild(payoutEl);
      }
      content.appendChild(winnerEl);
    } else if (isDraw) {
      const drawEl = document.createElement('div');
      drawEl.className = 'sf2-over-winner';
      const label = document.createElement('span');
      label.className = 'sf2-over-winner-label';
      label.textContent = t('games.sf2.draw');
      drawEl.appendChild(label);
      content.appendChild(drawEl);
    }
  }

  function _addGameOverStars(content, wins, needed, p0Wins, p1Wins, isDraw) {
    if (!wins || isDraw) return;
    const stars = document.createElement('div');
    stars.className = 'sf2-over-stars';
    const p0 = document.createElement('span');
    p0.className = 'sf2-over-stars-p';
    p0.style.color = p0Wins >= needed ? '#e8c000' : '#555';
    p0.textContent = '★'.repeat(p0Wins) + '☆'.repeat(needed - p0Wins);
    const sep = document.createElement('span');
    sep.className = 'sf2-over-stars-sep';
    sep.textContent = '—';
    const p1 = document.createElement('span');
    p1.className = 'sf2-over-stars-p';
    p1.style.color = p1Wins >= needed ? '#e8c000' : '#555';
    p1.textContent = '★'.repeat(p1Wins) + '☆'.repeat(needed - p1Wins);
    stars.append(p0, sep, p1);
    content.appendChild(stars);
  }

  function _addGameOverForfeit(content, isForfeit, isWinner) {
    if (!isForfeit || isWinner) return;
    const note = document.createElement('p');
    note.className = 'sf2-over-note';
    note.textContent = t('games.sf2.opponentForfeited');
    content.appendChild(note);
  }

  function _addGameOverBackBtn(content) {
    const lobbyBtn = document.createElement('button');
    lobbyBtn.className = 'sf2-over-back-btn';
    lobbyBtn.id = 'sf2-lobby-btn';
    lobbyBtn.textContent = t('games.sf2.backToLobby');
    lobbyBtn.addEventListener('click', renderOver);
    content.appendChild(lobbyBtn);
  }

  // ── postMessage bridge ────────────────────────────────────────────────────

  scope.on(window, 'message', (e) => {
    if (e.origin !== window.location.origin || !_iframe || e.source !== _iframe.contentWindow) return;
    const data = e.data;
    if (!data?.type) return;

    if (data.type === 'sf2:input') {
      // Local player's input snapshot — relay to server
      socket.emit('sf2:input', { roomId: _myRoomId, input: data.input });
    } else if (data.type === 'sf2:round_end') {
      // Only slot-0 reports to server to avoid double-report
      if (_mySlot === 0) {
        socket.emit('sf2:round_end', { roomId: _myRoomId, loserSlot: data.loserSlot });
      }
    } else if (data.type === 'sf2:forfeit') {
      socket.emit('sf2:forfeit', { roomId: _myRoomId });
    }
  });

  // ── socket events ─────────────────────────────────────────────────────────

  socket.on('sf2:rooms', ({ rooms, liveRooms }) => {
    _openRooms = rooms || [];
    _liveRooms = liveRooms || [];
    if (_stage === 'lobby') { renderLobby(); bindLobbyListEvents(); }
  });

  socket.on('sf2:open', (room) => {
    _openRooms = _openRooms.filter(r => r.roomId !== room.roomId);
    _openRooms.unshift(room);
    if (_stage === 'lobby') {
      const list = body.querySelector('#sf2-open-list');
      if (list) { setSafeHtml(list, renderOpenListHtml()); bindLobbyListEvents(); }
    }
  });

  socket.on('sf2:closed', ({ roomId }) => {
    _openRooms = _openRooms.filter(r => r.roomId !== roomId);
    if (_stage === 'lobby') {
      const list = body.querySelector('#sf2-open-list');
      if (list) { setSafeHtml(list, renderOpenListHtml()); bindLobbyListEvents(); }
    }
  });

  socket.on('sf2:live_open', (room) => {
    _liveRooms = _liveRooms.filter(r => r.roomId !== room.roomId);
    _liveRooms.unshift(room);
    if (_stage === 'lobby') { renderLobby(); bindLobbyListEvents(); }
  });

  socket.on('sf2:live_closed', ({ roomId }) => {
    _liveRooms = _liveRooms.filter(r => r.roomId !== roomId);
    if (_stage === 'lobby') {
      const list = body.querySelector('#sf2-live-list');
      if (list) { setSafeHtml(list, renderLiveList()); }
    }
  });

  socket.on('sf2:created', ({ roomId }) => {
    _myRoomId = roomId;
    _stage = 'waiting';
    renderWaiting();
  });

  socket.on('sf2:start', ({ roomId, slot, players }) => {
    _myRoomId = roomId;
    _mySlot   = slot;
    _wins     = [0, 0];
    _round    = 1;
    _myChar   = safeChar(playerAt(players, slot)?.char, 'Ryu');
    _oppChar  = safeChar(playerAt(players, 1 - slot)?.char, 'Ken');
    _stage    = 'playing';
    renderPlaying();
  });

  socket.on('sf2:input', ({ input }) => {
    // Received opponent's input — relay into iframe
    if (_iframe?.contentWindow) {
      _iframe.contentWindow.postMessage({ type: 'sf2:remote_input', input }, window.location.origin);
    }
  });

  socket.on('sf2:next_round', ({ round, wins }) => {
    _round = round;
    _wins  = wins;
    // Reload iframe for next round (resets HP/state)
    if (_iframe) {
      const frame = _iframe;
      const src = _iframe.src;
      _iframe.src = '';
      scope.timeout(() => {
        if (_iframe === frame) {
          _iframe.src = src;
          // Update HUD
          const hudWins = body.querySelectorAll('.sf2-wins');
          const roundEl = body.querySelector('.sf2-round');
          if (hudWins[0]) hudWins[0].textContent = `P1: ${'★'.repeat((_wins.at(0) ?? 0))}${'☆'.repeat(2 - (_wins.at(0) ?? 0))}`;
          if (hudWins[1]) hudWins[1].textContent = `P2: ${'★'.repeat((_wins.at(1) ?? 0))}${'☆'.repeat(2 - (_wins.at(1) ?? 0))}`;
          if (roundEl) roundEl.textContent = t('games.sf2.round', { round: _round });
        }
      }, 200);
    }
  });

  socket.on('sf2:game_over', (data) => {
    const { winner, payout, forfeit, draw } = data;
    const me = getMe();
    if (draw) {
      pushSystem(t('games.sf2.systemDraw'));
    } else if (winner) {
      const isWinner = winner.userId === me?.userId;
      const betAmount = payout > 0 ? ` (+${payout} pts)` : '';
      if (isWinner) pushSystem(t('games.sf2.systemWin', { betAmount }));
      else pushSystem(t(forfeit ? 'games.sf2.systemWinnerForfeit' : 'games.sf2.systemWinner', { winner: winner.pseudo, betAmount }));
    }
    _stage = 'over';
    renderGameOver(data);
  });

  socket.on('sf2:error', ({ error }) => {
    pushSystem(t('games.sf2.systemError', { error: sf2ErrorMessage(error) }));
  });

  scope.cleanup(() => {
    _teardownKeyForwarding();
    if (_iframe) { _iframe.src = 'about:blank'; _iframe.remove(); _iframe = null; }
    body.replaceChildren();
  });

  // ── initial state ─────────────────────────────────────────────────────────
  socket.emit('sf2:rooms_request');
  render();
  return { releaseInput: _releaseAllSf2Keys, refresh: () => socket.emit('sf2:rooms_request'), stop: () => scope.stop() };
}
