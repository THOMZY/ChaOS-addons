// ChaOS — Fighting Game v2 — MUGEN-powered client engine
//
// Architecture:
//   - Loads real MUGEN character files (.sff sprites, .air animations with
//     hitboxes, .cns stats/HitDef, .cmd commands)
//   - 60fps canvas game loop, fixed timestep physics
//   - Input relay netcode: local inputs sent at 30Hz; server relays opponent
//     inputs. Both clients simulate locally for fluid visuals.
//   - Hitbox/hurtbox detection uses actual Clsn1/Clsn2 rectangles from AIR files
//   - Server authoritative on health; client reports hits, server validates
//
// Controls (P1):
//   Move  : W/A/S/D (QWERTY)  ·  Z/Q/S/D (AZERTY)  — auto-detected
//   Attack: U=LP  I=MP  O=HP  (punches)
//           J=LK  K=MK  L=HK  (kicks)
//   Block : Space (hold)
//   List  : Escape (toggle movelist)
//   Debug : F1 (toggle hitbox overlay)

import { createGameScope } from '/core/js/games/game-scope.js';
import { t } from '/core/js/i18n.js';
import { loadMugenChar, loadCharPreview, loadCharPortrait, ANIM, resumeSndCtx, getSndAudioCtx } from './mugen/loader.js';
import { loadStage } from './mugen/stage-loader.js';
import { renderUserName, userNameHtml } from '/core/js/user-name.js';

// Module-level socket reference so onFightingWindowOpen can use it
let socket_ref = null;

// Set to true while the SF2 tab is shown — prevents MUGEN key capture
let _sf2TabActiveFlag = false;
export function setSF2TabActive(val) { _sf2TabActiveFlag = val; }

// Stage constants
const STAGE_W   = 800;
const STAGE_H   = 450;
const FLOOR_Y_DEFAULT = 380;
const MAX_WINS  = 2;
const ROUND_SEC = 60;
const MUGEN_PX_S = 60;
const SEND_HZ       = 30;
const SEND_INTERVAL = 1000 / SEND_HZ;
const CLR_CLSN1 = 'rgba(255,50,50,0.6)';
const CLR_CLSN2 = 'rgba(50,200,255,0.4)';

// Fighter state IDs
const ST = {
  IDLE:         'idle',
  WALK_FWD:     'walk_fwd',
  WALK_BACK:    'walk_back',
  RUN_FWD:      'run_fwd',      // dash forward (double-tap F)
  RUN_BACK:     'run_back',     // backdash (double-tap B)
  CROUCH_START: 'crouch_start',
  CROUCH:       'crouch',
  CROUCH_END:   'crouch_end',
  JUMP_START:   'jump_start',
  AIR:          'air',
  AIR_GUARD:    'air_guard',    // Ikemen-GO air guard state
  LAND:         'land',
  ATTACK:       'attack',
  HITSTUN:      'hitstun',
  BLOCKSTUN:    'blockstun',
  FALL:         'fall',         // hard knockdown / tumble
  FALL_LAND:    'fall_land',    // landing from a fall
  DIZZY:        'dizzy',        // Ikemen-GO dizzy state
  INTRO:        'intro',
  WIN:          'win',
  LOSE:         'lose',
};

export function initFighting(socket, getMe, pushSystem, scope = createGameScope()) {
  socket_ref = socket;
  const body = document.getElementById('fighting-body');
  if (!body) throw new Error('Fighting panel unavailable');

  let _stage    = 'lobby';
  let _chars    = [];        // [{folder, defFile, name}]
  let _stages   = [];        // [{folder, defFile, sffFile, name}]
  let _pickedChar = null;    // folder name
  let _pickedDefFile = null; // defFile for the picked char
  let _pickedStage   = null; // {folder, defFile, sffFile} chosen by creator
  let _mySlot   = -1;
  let _roomId   = null;
  let _fighters = [null, null];
  let _health   = [100, 100];
  let _round    = 1;
  let _wins     = [0, 0];
  let _timer    = ROUND_SEC;
  let _timerMs  = 0;
  let _openRooms    = [];
  let _liveRooms    = [];
  let _betAmount    = 0;
  let _playerColors  = ['#33ff88', '#44aaff'];
  let _playerPseudos = ['?', '?'];
  let _showHitboxes = false;
  let _lastSendTs   = 0;
  let _raf          = null;
  let _lastTs       = 0;
  let _accumulator  = 0;
  let _localInputBuf = [];
  let _globalFrame   = 0;
  let _roundStarting      = false; // true between round-end and fighting:begin (timer frozen)
  let _poseTimer          = 0;    // countdown (game ticks) for WIN/LOSE pose hold before next round
  let _pendingRoundResult = null; // buffered {type, data} during pose
  let _projectiles        = [];   // active projectiles [{id,ownerSlot,char,x,y,vx,vy,...}]
  let _projIdCounter      = 0;
  let _explods            = [];   // active visual FX [{char,animId,x,y,facing,frame,...}]
  let _helpers            = [];   // active MUGEN helper entities
  // _audioCtx removed — use the snd-parser shared context (AudioBuffers are bound to it)
  let _stageData     = null;  // loaded MUGEN stage (null = use default gradient)
  let _floorY        = FLOOR_Y_DEFAULT; // dynamic floor Y, updated per stage
  let _camX          = 0;     // camera horizontal offset in MUGEN coords
  let _bgmAudio      = null;  // HTMLAudioElement for stage BGM
  let _screenShakeFrames = 0; // frames of screen shake remaining
  let _screenShakeAmp    = 0; // amplitude in px
  let _shakeCtxSaved     = false; // whether ctx.save() was called for shake this frame

  function _playBgm(url) {
    _stopBgm();
    if (!url) return;
    _bgmAudio = new Audio(url);
    _bgmAudio.loop   = true;
    _bgmAudio.volume = _bgmVol;
    _bgmAudio.play().catch(() => {});
  }
  function _stopBgm() {
    if (_bgmAudio) { _bgmAudio.pause(); _bgmAudio.src = ''; _bgmAudio = null; }
  }

  // ── SFX helpers ──────────────────────────────────────────────────────────
  function _getSfxCtx() {
    return getSndAudioCtx(); // must be the SAME context that decoded the AudioBuffers
  }
  function _playSound(char, group, index, vol = 0.45) {
    if (!char?.sounds) return;
    const buf = char.sounds.get(`${group}_${index}`);
    if (!buf) return;
    const ctx = _getSfxCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    try {
      const src  = ctx.createBufferSource();
      src.buffer = buf;
      const gain = ctx.createGain();
      gain.gain.value = Math.max(0, vol * _sfxVol);
      src.connect(gain);
      gain.connect(ctx.destination);
      src.start();
    } catch { /* sound is optional (autoplay policy, closed context) */ }
  }

  // ── Volume sliders (BGM + SFX) wired once (survives root.innerHTML resets) ──
  const _bgmSlider = document.getElementById('fg-bgm-slider');
  const _sfxSlider = document.getElementById('fg-sfx-slider');

  // Restore persisted values (guard against NaN from corrupted/empty storage)
  const _rawBgm = parseFloat(localStorage.getItem('fg-bgm-vol') ?? '50');
  const _rawSfx = parseFloat(localStorage.getItem('fg-sfx-vol') ?? '50');
  const _savedBgm = isFinite(_rawBgm) ? Math.max(0, Math.min(100, _rawBgm)) : 50;
  const _savedSfx = isFinite(_rawSfx) ? Math.max(0, Math.min(100, _rawSfx)) : 50;
  if (_bgmSlider) _bgmSlider.value = _savedBgm;
  if (_sfxSlider) _sfxSlider.value = _savedSfx;

  let _bgmVol = _savedBgm / 100;
  let _sfxVol = _savedSfx / 100;

  // Update the visual fill gradient on the slider track (--vol-pct CSS var)
  function _updateSliderFill(slider) {
    if (!slider) return;
    const pct = ((slider.valueAsNumber - Number(slider.min || 0)) /
                 (Number(slider.max || 100) - Number(slider.min || 0))) * 100;
    slider.style.setProperty('--vol-pct', `${pct}%`);
  }
  _updateSliderFill(_bgmSlider);
  _updateSliderFill(_sfxSlider);

  // Prevent label area (pointer-events:auto in CSS) from triggering titlebar drag
  const _bgmLabel = _bgmSlider?.closest('.fg-vol-label');
  const _sfxLabel = _sfxSlider?.closest('.fg-vol-label');
  [_bgmLabel, _sfxLabel].forEach(label => {
    if (!label) return;
    scope.on(label, 'mousedown', e => e.stopPropagation());
    scope.on(label, 'touchstart', e => e.stopPropagation(), { passive: false });
  });

  if (_bgmSlider) {
    scope.on(_bgmSlider, 'input', () => {
      _bgmVol = _bgmSlider.valueAsNumber / 100;
      localStorage.setItem('fg-bgm-vol', _bgmSlider.value);
      _updateSliderFill(_bgmSlider);
      if (_bgmAudio) _bgmAudio.volume = _bgmVol;
    });
    scope.on(_bgmSlider, 'mousedown', e => e.stopPropagation());
    scope.on(_bgmSlider, 'touchstart', e => e.stopPropagation(), { passive: false });
  }
  if (_sfxSlider) {
    scope.on(_sfxSlider, 'input', () => {
      _sfxVol = _sfxSlider.valueAsNumber / 100;
      localStorage.setItem('fg-sfx-vol', _sfxSlider.value);
      _updateSliderFill(_sfxSlider);
    });
    scope.on(_sfxSlider, 'mousedown', e => e.stopPropagation());
    scope.on(_sfxSlider, 'touchstart', e => e.stopPropagation(), { passive: false });
  }

  const root = document.createElement('div');
  root.className = 'fg-root';
  // This panel is re-rendered by the fighting lobby; replace any previous
  // content instead of appending a second UI tree.
  body.replaceChildren(root);

  // ── Lobby ────────────────────────────────────────────────────────────────
  function renderLobby() {
    stopLoop();
    _stage = 'lobby';
    root.innerHTML = `
      <div style="display:flex;flex-direction:column;height:100%;overflow:hidden">
        <div class="fg-sp-banner">
          <button class="fg-sp-btn" id="fg-sp-btn">
            SHITPOST
            <span class="fg-sp-count" id="fg-sp-count">${_sbCount}</span>
          </button>
        </div>
        <div class="fg-lobby">
          <div class="fg-lobby-col">
            <h3>${t('games.fighting.createGame')}</h3>
            <input type="number" id="fg-bet" class="fg-input" placeholder="${t('games.fighting.betPoints')}" min="0" value="0">
            <button class="fg-btn fg-btn-create" id="fg-create-btn">${t('games.fighting.create')}</button>
          </div>
          <div class="fg-lobby-col">
            <h3>${t('games.fighting.openRooms')}</h3>
            <div id="fg-open-rooms" class="fg-room-list"></div>
          </div>
          <div class="fg-lobby-col">
            <h3>${t('games.fighting.liveMatches')}</h3>
            <div id="fg-live-rooms" class="fg-room-list"></div>
          </div>
        </div>
      </div>`;
    renderRoomLists();
    document.getElementById('fg-create-btn').onclick = () => {
      const bet = parseInt(document.getElementById('fg-bet').value, 10) || 0;
      _betAmount = bet;
      socket.emit('fighting:create', { bet });
    };
    document.getElementById('fg-sp-btn').onclick = () => showSandbox();
    socket.emit('fighting:rooms_request');
  }

  function renderRoomLists() {
    const openEl = document.getElementById('fg-open-rooms');
    const liveEl = document.getElementById('fg-live-rooms');
    if (!openEl || !liveEl) return;
    openEl.innerHTML = _openRooms.length
      ? _openRooms.map(r => `
          <div class="fg-room-entry">
            ${userNameHtml({ ...r.players[0], pseudo: r.players[0]?.pseudo ?? r.players[0]?.name }, { fallbackPseudo: '?' })}
            <span class="fg-room-bet">${r.bet ? r.bet + ' pts' : t('games.fighting.free')}</span>
            <button class="fg-btn fg-btn-join" data-id="${r.id}">${t('games.fighting.join')}</button>
          </div>`).join('')
      : `<div class="fg-room-empty">${t('games.fighting.noOpenRooms')}</div>`;
    liveEl.innerHTML = _liveRooms.length
      ? _liveRooms.map(r => `
          <div class="fg-room-entry">
            <span>${userNameHtml({ ...r.players[0], pseudo: r.players[0]?.pseudo ?? r.players[0]?.name }, { fallbackPseudo: '?' })} vs ${userNameHtml({ ...r.players[1], pseudo: r.players[1]?.pseudo ?? r.players[1]?.name }, { fallbackPseudo: '?' })}</span>
            <button class="fg-btn fg-btn-spec" data-id="${r.id}">${t('games.fighting.watch')}</button>
          </div>`).join('')
      : `<div class="fg-room-empty">${t('games.fighting.noLiveMatches')}</div>`;
    openEl.querySelectorAll('.fg-btn-join').forEach(btn => {
      btn.onclick = () => socket.emit('fighting:join', { roomId: btn.dataset.id });
    });
    liveEl.querySelectorAll('.fg-btn-spec').forEach(btn => {
      btn.onclick = () => socket.emit('fighting:spectate', { roomId: btn.dataset.id });
    });
  }

  // ── Room Lobby (shared char-select for both players) ────────────────────
  function showRoomLobby(roomId, mySlot, players) {
    stopLoop();
    _stage    = 'room_lobby';
    _roomId   = roomId;
    _mySlot   = mySlot;
    _pickedChar    = null;
    _pickedDefFile = null;

    const myPlayer  = players[mySlot]  ?? null;
    const oppSlot   = mySlot === 0 ? 1 : 0;
    const oppPlayer = players[oppSlot] ?? null;
    const myName    = myPlayer?.pseudo ?? getMe()?.pseudo ?? '?';
    const oppName   = oppPlayer?.pseudo ?? '?';
    const betLabel  = _betAmount > 0 ? `<span class="fg-rl-bet">${_betAmount} pts</span>` : '';

    const isCreator = mySlot === 0;
    _playerColors[mySlot]  = myPlayer?.color  || '#33ff88';
    _playerColors[oppSlot] = oppPlayer?.color || '#44aaff';

    root.innerHTML = `
      <div class="fg-room-lobby">
        <div class="fg-rl-header">
          <span class="fg-rl-room-id">${t('games.fighting.room', { roomId })}</span>${betLabel}
        </div>
        <div class="fg-rl-arena">
          <div class="fg-rl-side fg-rl-mine">
            <div class="fg-rl-player-name">${myName}</div>
            <canvas id="fg-rl-my-preview" width="160" height="160" class="fg-rl-preview"></canvas>
            <div class="fg-rl-status" id="fg-rl-my-status">${t('games.fighting.chooseCharacter')}</div>
          </div>
          <div class="fg-rl-vs">VS</div>
          <div class="fg-rl-side fg-rl-opp">
            <div class="fg-rl-player-name" id="fg-rl-opp-name">${oppPlayer ? oppName : `<em>${t('games.fighting.waiting')}</em>`}</div>
            <canvas id="fg-rl-opp-preview" width="160" height="160" class="fg-rl-preview fg-rl-preview-opp"></canvas>
            <div class="fg-rl-status" id="fg-rl-opp-status">${oppPlayer ? t('games.fighting.chooseCharacter') : ''}</div>
          </div>
        </div>
        <div class="fg-rl-charlist" id="fg-rl-charlist"></div>
        ${isCreator ? `<div class="fg-rl-stage-row" id="fg-rl-stage-row"><label class="fg-rl-stage-label">${t('games.fighting.stageLabel')}</label><select class="fg-rl-stage-select" id="fg-rl-stage-select"><option value="">${t('games.fighting.randomStage')}</option></select></div>` : ''}
        <div class="fg-rl-actions">
          <button class="fg-btn fg-btn-validate" id="fg-validate-btn" disabled>${t('games.fighting.confirm')}</button>
          <button class="fg-btn fg-btn-cancel" id="fg-cancel-btn">${t('games.fighting.cancel')}</button>
        </div>
      </div>`;

    document.getElementById('fg-cancel-btn').onclick = () => {
      socket.emit('fighting:forfeit', { roomId });
      renderLobby();
    };

    document.getElementById('fg-validate-btn').onclick = () => {
      if (!_pickedChar) return;
      const stagePayload = isCreator ? (_pickedStage ?? null) : null;
      socket.emit('fighting:select_char', { roomId, char: _pickedChar, defFile: _pickedDefFile, stage: stagePayload });
      // Joiner (slot 1) cannot change after validating; creator can re-pick freely
      if (!isCreator) {
        const list = document.getElementById('fg-rl-charlist');
        if (list) list.classList.add('fg-rl-locked');
        document.getElementById('fg-validate-btn').disabled = true;
      }
    };

    // Load chars and stages (creator only) in parallel
    const charPromise = _chars.length
      ? Promise.resolve(_chars)
      : scope.fetch('/api/mugen/chars').then(r => r.json()).then(c => { if (scope.active) _chars = c; return c; });

    if (isCreator) {
      const stagePromise = _stages.length
        ? Promise.resolve(_stages)
        : scope.fetch('/api/mugen/stages').then(r => r.json()).then(s => { if (scope.active) _stages = s; return s; });
      stagePromise.then(stages => {
        if (!scope.active) return;
        const sel = document.getElementById('fg-rl-stage-select');
        if (!sel) return;
        stages.forEach(s => {
          const opt = document.createElement('option');
          opt.value = JSON.stringify({ folder: s.folder, defFile: s.defFile, sffFile: s.sffFile });
          opt.textContent = s.name || s.folder;
          sel.appendChild(opt);
        });
        sel.onchange = () => {
          const v = sel.value;
          _pickedStage = v ? JSON.parse(v) : null;
        };
      }).catch(() => {});
    }

    charPromise.then(chars => {
      if (!scope.active) return;
      const list = document.getElementById('fg-rl-charlist');
      if (!list) return;
      list.innerHTML = chars.map(c => `
        <div class="fg-char-tile fg-rl-char-tile" data-folder="${c.folder}" data-deffile="${c.defFile || ''}">
          <canvas class="fg-char-tile-portrait" width="100" height="108"></canvas>
          <div class="fg-char-tile-name">${c.name}</div>
        </div>`).join('');
      _loadTilePortraits(list);

      // Helper: apply a player's color to their selected tile
      function _applySlotColor(folder, slot) {
        const color = _playerColors[slot] || (slot === 0 ? '#33ff88' : '#44aaff');
        list.querySelectorAll('[data-sel-slot]').forEach(t => {
          if (t.getAttribute('data-sel-slot') === String(slot)) {
            t.removeAttribute('data-sel-slot');
            t.style.borderColor = '';
            t.style.background  = '';
          }
        });
        const t = list.querySelector(`[data-folder="${folder}"]`);
        if (t) {
          t.setAttribute('data-sel-slot', slot);
          t.style.borderColor = color;
          t.style.background  = `color-mix(in srgb, ${color} 20%, #0d0d1a)`;
        }
      }

      // Restore my selection if already picked (e.g. rejoined after opponent joined)
      if (myPlayer?.char) {
        _pickedChar    = myPlayer.char;
        _pickedDefFile = myPlayer.defFile || null;
        _applySlotColor(myPlayer.char, mySlot);
        const myStatus = document.getElementById('fg-rl-my-status');
        if (myStatus) myStatus.textContent = chars.find(c => c.folder === myPlayer.char)?.name || myPlayer.char;
        _previewRLChar('my', myPlayer.char, myPlayer.defFile);
        const validateBtn = document.getElementById('fg-validate-btn');
        if (validateBtn) validateBtn.disabled = false;
        // Joiner already validated — keep list locked
        if (!isCreator) {
          list.classList.add('fg-rl-locked');
          if (validateBtn) validateBtn.disabled = true;
        }
      }

      // Show opponent's char if already picked
      if (oppPlayer?.char) {
        const oppStatus = document.getElementById('fg-rl-opp-status');
        if (oppStatus) oppStatus.textContent = chars.find(c => c.folder === oppPlayer.char)?.name || oppPlayer.char;
        _previewRLChar('opp', oppPlayer.char, oppPlayer.defFile);
        _applySlotColor(oppPlayer.char, oppSlot);
      }

      list.querySelectorAll('.fg-rl-char-tile').forEach(tile => {
        tile.onclick = () => {
          if (_stage !== 'room_lobby') return;
          _applySlotColor(tile.dataset.folder, _mySlot);
          _pickedChar    = tile.dataset.folder;
          _pickedDefFile = tile.dataset.deffile || null;
          const charName = tile.querySelector('.fg-char-tile-name').textContent;
          const myStatus = document.getElementById('fg-rl-my-status');
          if (myStatus) myStatus.textContent = charName;
          _previewRLChar('my', _pickedChar, _pickedDefFile);
          // Broadcast preview to opponent without confirming
          socket.emit('fighting:preview_char', { roomId, char: _pickedChar, defFile: _pickedDefFile });
          // Enable validate button — don't emit the final confirm yet
          const validateBtn = document.getElementById('fg-validate-btn');
          if (validateBtn) validateBtn.disabled = false;
        };
      });
    }).catch(() => {
      if (!scope.active) return;
      const list = document.getElementById('fg-rl-charlist');
      if (list) list.textContent = t('games.fighting.charactersLoadFailed');
    });
  }

  async function _previewRLChar(side, folder, defFile) {
    const canvas = document.getElementById(`fg-rl-${side}-preview`);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, W, H);
    try {
      const res = await loadCharPreview(folder, defFile || null);
      if (!scope.active || !res?.sprite) return;
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = '#111';
      ctx.fillRect(0, 0, W, H);
      _drawSpritePreview(ctx, res.sprite, W, H, res.portraitscale ?? 1);
    } catch { /* a missing preview keeps the placeholder */ }
  }

  function _drawSpritePreview(ctx, sprite, W, H, portraitscale = 1) {
    const margin = 8;
    const scale  = Math.min((W - 2 * margin) / sprite.width, (H - 2 * margin) / sprite.height, 1.5) * portraitscale;
    const feetGap = (sprite.height - sprite.axisY) * scale;
    const axisY   = H - margin - feetGap;
    ctx.drawImage(sprite.canvas,
      W / 2 - sprite.axisX * scale, axisY - sprite.axisY * scale,
      sprite.width * scale, sprite.height * scale);
  }

  // Load portraits into every .fg-char-tile canvas in listEl (all in parallel; cached after first load).
  async function _loadTilePortraits(listEl) {
    const tiles = Array.from(listEl.querySelectorAll('.fg-char-tile'));
    await Promise.allSettled(tiles.map(async tile => {
        const cvs = tile.querySelector('.fg-char-tile-portrait');
        if (!cvs) return;
        const ctx = cvs.getContext('2d');
        const W = cvs.width, H = cvs.height;
        ctx.fillStyle = '#0a0a15';
        ctx.fillRect(0, 0, W, H);
        try {
          const res = await loadCharPortrait(tile.dataset.folder, tile.dataset.deffile || null);
          if (!scope.active || !res?.sprite) return;
          ctx.clearRect(0, 0, W, H);
          ctx.fillStyle = '#0a0a15';
          ctx.fillRect(0, 0, W, H);
          if (res.isPortrait) {
            // Center the portrait sprite in the tile (axis is not feet-based for 9000 sprites)
            const margin = 4;
            const s = Math.min((W - 2 * margin) / res.sprite.width, (H - 2 * margin) / res.sprite.height, 3);
            const dw = res.sprite.width * s, dh = res.sprite.height * s;
            ctx.drawImage(res.sprite.canvas, (W - dw) / 2, (H - dh) / 2, dw, dh);
          } else {
            _drawSpritePreview(ctx, res.sprite, W, H, 1);
          }
        } catch { /* a missing preview keeps the placeholder */ }
      }));
  }

  function showLoading(msg) {
    stopLoop();
    _stage = 'loading';
    root.innerHTML = `
      <div class="fg-loading">
        <div class="fg-loading-text" id="fg-load-msg">${msg || t('games.fighting.loadingFighters')}</div>
        <div class="fg-loading-bar"><div class="fg-loading-fill" id="fg-load-fill" style="width:0%"></div></div>
      </div>`;
  }

  function setLoadProgress(msg, pct) {
    if (!scope.active) return;
    const el  = document.getElementById('fg-load-msg');
    const bar = document.getElementById('fg-load-fill');
    if (el)  el.textContent   = msg;
    if (bar) bar.style.width  = pct + '%';
  }

  // ── Fight screen ─────────────────────────────────────────────────────────
  let _canvas = null;
  let _ctx    = null;

  function showFight() {
    _stage = 'fight';
    root.innerHTML = `
      <div class="fg-fight-wrap">
        <div class="fg-hud">
          <div class="fg-hud-left">
            <div class="fg-player-name" id="fg-p1name"></div>
            <div class="fg-hpbar-wrap">
              <div class="fg-hpbar fg-hpbar-p1">
                <div class="fg-hpbar-fill" id="fg-hp0-fill"></div>
                <div class="fg-hpbar-redlife" id="fg-hp0-redlife"></div>
              </div>
            </div>
            <div class="fg-gpbar-wrap">
              <div class="fg-gpbar" id="fg-gp0-track"><div class="fg-gpbar-fill" id="fg-gp0-fill"></div></div>
            </div>
            <div class="fg-pwbar-wrap">
              <div class="fg-pwbar" id="fg-pw0-track"><div class="fg-pwbar-fill" id="fg-pw0-fill"></div></div>
            </div>
            <div class="fg-dizzy-icon" id="fg-dizzy0" style="display:none">${t('games.fighting.dizzy')}</div>
          </div>
          <div class="fg-hud-center">
            <div class="fg-wins" id="fg-wins0"></div>
            <div class="fg-timer" id="fg-timer">60</div>
            <div class="fg-wins" id="fg-wins1"></div>
          </div>
          <div class="fg-hud-right">
            <div class="fg-player-name" id="fg-p2name"></div>
            <div class="fg-hpbar-wrap fg-hpbar-wrap-right">
              <div class="fg-hpbar fg-hpbar-p2">
                <div class="fg-hpbar-fill" id="fg-hp1-fill"></div>
                <div class="fg-hpbar-redlife" id="fg-hp1-redlife"></div>
              </div>
            </div>
            <div class="fg-gpbar-wrap fg-gpbar-wrap-right">
              <div class="fg-gpbar" id="fg-gp1-track"><div class="fg-gpbar-fill" id="fg-gp1-fill"></div></div>
            </div>
            <div class="fg-pwbar-wrap fg-pwbar-wrap-right">
              <div class="fg-pwbar" id="fg-pw1-track"><div class="fg-pwbar-fill" id="fg-pw1-fill"></div></div>
            </div>
            <div class="fg-dizzy-icon" id="fg-dizzy1" style="display:none">${t('games.fighting.dizzy')}</div>
          </div>
        </div>
        <div class="fg-canvas-wrap">
          <canvas id="fg-canvas" width="${STAGE_W}" height="${STAGE_H}"></canvas>
          <div class="fg-overlay" id="fg-overlay"></div>
          <div class="fg-movelist" id="fg-movelist" style="display:none"></div>
        </div>
        <div class="fg-hint">${t('games.fighting.controlsHint', { moveKeys: _moveHintKeys() })} <button class="fg-btn" id="fg-forfeit-btn">${t('games.fighting.forfeit')}</button></div>
      </div>`;
    _canvas = document.getElementById('fg-canvas');
    _ctx    = _canvas.getContext('2d');
    // Measure HUD chrome and enforce aspect-ratio on the window
    scope.frame(() => {
      const _wmWin = document.getElementById('fighting-body')?.closest('.wm-win');
      const _hud   = document.getElementById('fighting-body')?.querySelector('.fg-hud');
      if (_wmWin && _hud) {
        _wmWin.dataset.aspectExtra = String(_hud.offsetHeight || 0);
        _wmWin._enforceAspect?.();
      }
    });
    _updateHud();
    document.getElementById('fg-forfeit-btn').onclick = () => {
      if (confirm(t('games.fighting.confirmForfeit'))) socket.emit('fighting:forfeit', { roomId: _roomId });
    };
    startLoop();
  }

  // ── Result screen ────────────────────────────────────────────────────────
  function showResult(data) {
    stopLoop();
    _stage = 'result';
    const me  = getMe();
    const won = data.winner?.accountId === me?.accountId;
    root.innerHTML = `
      <div class="fg-result ${won ? 'fg-result-win' : 'fg-result-lose'}">
        <div class="fg-result-title">${t(won ? 'games.fighting.victory' : 'games.fighting.defeat')}</div>
        ${data.payout > 0 ? '<div class="fg-result-payout">+' + data.payout + ' pts</div>' : ''}
        <button class="fg-btn" id="fg-rematch-btn">${t('games.fighting.rematch')}</button>
        <button class="fg-btn fg-btn-back" id="fg-lobby-btn">${t('games.fighting.lobby')}</button>
      </div>`;
    document.getElementById('fg-rematch-btn').onclick = () => renderLobby();
    document.getElementById('fg-lobby-btn').onclick   = () => renderLobby();
  }

  // ── Fighter factory ──────────────────────────────────────────────────────
  function makeFighter(slot, char) {
    const stats = char.stats;
    return {
      slot, char,
      x:      slot === 0 ? STAGE_W * 0.3 : STAGE_W * 0.7,
      y:      _floorY,
      vx:     0, vy: 0,
      facing:       slot === 0 ? 1 : -1,
      visualFacing: slot === 0 ? 1 : -1,
      onGround: true,
      stateId:    ST.IDLE,
      stateTimer: 0,
      animAction: ANIM.IDLE,
      animFrame:  0,
      animTimer:  0,
      isBlocking:    false,
      hitstunLeft:   0,
      blockstunLeft: 0,
      hitLanded:     false,
      currentMove:   null,
      hitstopLeft:   0,
      comboCount:    0,
      comboTimer:    0,
      hitFlashFrames: 0,
      power:         0,
      maxPower:      stats.maxPower ?? 3000,
      projSpawned:   false,
      hFired:        new Set(),
      _lastDirs:     [],
      _pendingBtns:  new Set(),
      _spawnedPersistentHelpers: new Set(),  // IDs of state -2 helpers already spawned
      // Ikemen-GO extended meters
      dizzyPoints:     stats.dizzyPoints  ?? 1000,  // current dizzy HP
      maxDizzyPoints:  stats.dizzyPoints  ?? 1000,
      guardPoints:     stats.guardPoints  ?? 1000,  // current guard HP
      maxGuardPoints:  stats.guardPoints  ?? 1000,
      redLife:         0,                           // pending red life (chip dmg owed to attacker)
      redLifeDisplay:  0,                           // smooth visual segment
      // Double-tap / dash detection
      _lastFwdTap:   0,    // frame of last F tap (for double-tap dash)
      _lastBckTap:   0,    // frame of last B tap
      _dashDone:     false, // true = dash consumed (reset on landing/idle)
      _airJumpsLeft: stats.airJumps ?? 0,
      // Fall/KO physics
      _fallBounced:  false, // has already bounced once during KO fall
      // MUGEN variable arrays
      vars:  new Int32Array(60),   // int vars 0-59
      fvars: new Float32Array(40), // float vars 0-39
    };
  }

  // ── Input ────────────────────────────────────────────────────────────────
  const _keys = new Set();
  const _keyPressedThisFrame = new Set();
  const _pendingOutBtns = new Set(); // attack presses accumulated between 30Hz sends
  let   _inputLocked = false;
  let   _chatFocused  = false;  // true while chat-input has focus → keys pass through

  // Keys that must be preventDefault'd to avoid browser shortcuts
  const _FIGHT_CODES = new Set([
    'KeyW','KeyA','KeyS','KeyD',
    'KeyU','KeyI','KeyO','KeyJ','KeyK','KeyL',
    'Space','Escape','F1',
  ]);

  // Keyboard layout detection: KeyW = W (QWERTY) or Z (AZERTY), KeyA = A or Q
  // Defaults to QWERTY; updated async via KeyboardLayoutMap API.
  let _moveKeys = { up: 'W', left: 'A' };
  function _moveHintKeys() { return `${_moveKeys.left}/D/${_moveKeys.up}/S`; }
  (async () => {
    try {
      if (navigator?.keyboard?.getLayoutMap) {
        const map = await navigator.keyboard.getLayoutMap();
        if (!scope.active) return;
        const up   = (map.get('KeyW') ?? 'w').toUpperCase();
        const left = (map.get('KeyA') ?? 'a').toUpperCase();
        if (up !== _moveKeys.up || left !== _moveKeys.left) {
          _moveKeys = { up, left };
          document.querySelectorAll('.fg-move-keys').forEach(el => { el.textContent = _moveHintKeys(); });
        }
      }
    } catch { /* layout API refused: keep the default key hints */ }
  })();

  // Lock inputs when clicking inside the fighting window, unlock otherwise.
  // Clicking #chat-input suspends fight-input capture so the user can type.
  // When the SF2 tab is active, MUGEN key capture is disabled entirely.
  scope.on(document, 'mousedown', e => {
    const winEl = document.querySelector('[data-win-id="fighting"]');
    if (e.target.closest('#chat-input')) {
      // Chat input clicked — release fight-input capture
      _chatFocused = true;
      _keys.clear();
      _keyPressedThisFrame.clear();
    } else if (winEl?.contains(e.target)) {
      _sf2TabActiveFlag = !!e.target.closest('.fg-panel-sf2');
      _chatFocused = false;
      // SF2 tab: don't lock MUGEN keys — the iframe handles its own events
      if (!_sf2TabActiveFlag) _inputLocked = true;
    } else if (_inputLocked) {
      _inputLocked = false;
      _keys.clear();
      _keyPressedThisFrame.clear();
    }
  }, true);

  // Clear held keys when the page loses focus so keys don't get stuck
  // (keyup is not reliably fired when alt-tabbing or switching windows)
  function _clearKeys() {
    _keys.clear();
    _keyPressedThisFrame.clear();
  }
  scope.on(window, 'blur', _clearKeys);
  scope.on(document, 'visibilitychange', () => { if (document.hidden) _clearKeys(); });

  const _ATTACK_KEY_TO_BTN = { KeyU:'j', KeyI:'k', KeyO:'i', KeyJ:'u', KeyK:'b', KeyL:'c' };

  function _getInputSnapshot() {
    const dirs = _getDirectionSnapshot();
    const btns = _getButtonSnapshot();
    return { dirs, btns };
  }

  function _getDirectionSnapshot() {
    const dirs = new Set();
    const localFacing = (_sbActive ? _sbFighters.get(_sbMySlot) : _fighters[_mySlot])?.facing ?? 1;
    const horizontal = localFacing === 1 ? { KeyA: 'B', KeyD: 'F' } : { KeyA: 'F', KeyD: 'B' };
    for (const [code, dir] of Object.entries(horizontal)) if (_keys.has(code)) dirs.add(dir);
    if (_keys.has('KeyW')) dirs.add('U');
    if (_keys.has('KeyS')) dirs.add('D');
    if (dirs.has('D') && dirs.has('F')) dirs.add('DF');
    if (dirs.has('D') && dirs.has('B')) dirs.add('DB');
    return dirs;
  }

  function _getButtonSnapshot() {
    const btns = new Set();
    for (const [code, btn] of Object.entries(_ATTACK_KEY_TO_BTN)) {
      if (_keyPressedThisFrame.has(code)) btns.add(btn);
    }
    if (_keys.has('Space')) btns.add('block');
    return btns;
  }

  scope.on(document, 'keydown', e => {
    if (body.closest('.wm-win')?.dataset.minimized === '1') return;
    if (_chatFocused) return;                  // chat-input focused — let keys through
    if (_sf2TabActiveFlag) return;             // SF2 iframe handles its own keys
    if (!_inputLocked && !_sbActive) return;
    // In sandbox: block ALL keys except Ctrl/Alt/Meta combos so nothing leaks to the browser
    // In fight mode: only block known fight codes
    if (_sbActive && !e.ctrlKey && !e.altKey && !e.metaKey) e.preventDefault();
    else if (_FIGHT_CODES.has(e.code)) e.preventDefault();
    if (e.repeat) return;
    _keys.add(e.code);
    _keyPressedThisFrame.add(e.code);
    // Accumulate attack presses for outgoing sync (flushed on every 30Hz send)
    if (_ATTACK_KEY_TO_BTN[e.code]) _pendingOutBtns.add(_ATTACK_KEY_TO_BTN[e.code]);
    if (e.code === 'F1') _showHitboxes = !_showHitboxes;
    if (e.code === 'Escape') _toggleMovelist();
  }, false);

  scope.on(document, 'keyup', e => {
    _keys.delete(e.code); // always clear to avoid stuck keys if lock changes mid-press
  }, false);

  // ── CMD input matching ───────────────────────────────────────────────────
  function _matchCommands(char, inputBuf) {
    if (!inputBuf.some(f => f.btns.size > 0)) return null;
    for (const cmd of char.commands) {
      if (!_commandIsPlayable(char, cmd)) continue;
      const end = _findCommandEndFrame(cmd, inputBuf);
      if (end >= 0 && _matchedCommandIsFresh(inputBuf, end, cmd.timeWindow)) return cmd.name;
    }
    return null;
  }

  function _commandIsPlayable(char, cmd) {
    if (!cmd.steps.length || !char.moveMap.has(cmd.name)) return false;
    return !cmd.name.startsWith('AI') && !cmd.name.startsWith('hold') && cmd.name !== 'recovery';
  }

  function _findCommandEndFrame(cmd, inputBuf) {
    const lastStep = cmd.steps[cmd.steps.length - 1];
    for (let end = inputBuf.length - 1; end >= 0; end--) {
      if (_stepMatches(lastStep, inputBuf[end]) && _commandStepsMatch(cmd.steps, inputBuf, end, cmd.timeWindow)) return end;
    }
    return -1;
  }

  function _commandStepsMatch(steps, inputBuf, end, win) {
    let pos = end;
    for (let s = steps.length - 2; s >= 0; s--) {
      const foundAt = _findPreviousMatchingStep(steps[s], inputBuf, pos, end, win);
      if (foundAt < 0) return false;
      pos = foundAt;
    }
    return true;
  }

  function _findPreviousMatchingStep(step, inputBuf, pos, end, win) {
    for (let f = pos - 1; f >= 0; f--) {
      if (inputBuf[end].frame - inputBuf[f].frame > win) break;
      if (_stepMatches(step, inputBuf[f])) return f;
    }
    return -1;
  }

  function _matchedCommandIsFresh(inputBuf, end, win) {
    return inputBuf[inputBuf.length - 1].frame - inputBuf[end].frame <= win;
  }

  function _stepMatches(step, frame) {
    if (step.type === 'dir')  return step.dirs.some(d => frame.dirs.has(d));
    if (step.type === 'btn')  return step.btns.some(b => frame.btns.has(_mugenBtn(b)));
    if (step.type === 'simultaneous') return step.btns.every(b => frame.btns.has(_mugenBtn(b)));
    return false;
  }

  function _mugenBtn(b) {
    return { x:'j', y:'k', z:'i', a:'u', b:'b', c:'c' }[b] || b;
  }

  // ── Movelist overlay ─────────────────────────────────────────────────────
  let _movelistOpen      = false;
  let _assertedCmd       = null;  // move name injected by clicking the movelist (local)
  let _pendingSbAssertCmd = null; // same, queued for next sandbox:input emit
  let _assertedPose       = null; // pose state injected by clicking the movelist (local)
  let _pendingSbAssertPose = null; // same, queued for next sandbox:input emit

  function _onMovelistClick(e) {
    const poseTarget = e.target.closest('[data-pose]');
    if (poseTarget) {
      _assertedPose        = poseTarget.dataset.pose;
      _pendingSbAssertPose = poseTarget.dataset.pose;
      _toggleMovelist();
      return;
    }
    const target = e.target.closest('[data-cmd]');
    if (!target) return;
    _assertedCmd        = target.dataset.cmd;
    _pendingSbAssertCmd = target.dataset.cmd;  // broadcast to other sandbox players
    _toggleMovelist();
  }

  function _toggleMovelist() {
    const el = document.getElementById('fg-movelist');
    if (!el) return;
    _movelistOpen = !_movelistOpen;
    if (_movelistOpen) {
      const char = (_sbActive ? _sbFighters.get(_sbMySlot) : _fighters[_mySlot])?.char;
      el.innerHTML = char ? _buildMovelistHtml(char) : `<div class="fg-ml-empty">${t('games.fighting.noCharacterLoaded')}</div>`;
      el.style.display = '';
      el.addEventListener('click', _onMovelistClick);
    } else {
      el.removeEventListener('click', _onMovelistClick);
      el.style.display = 'none';
    }
  }

  function _buildMovelistHtml(char) {
    const DIR_SYM  = { F:'→', B:'←', U:'↑', D:'↓', DF:'↘', DB:'↙', UF:'↗', UB:'↖' };
    const BTN_NAME = { x:'LP', y:'MP', z:'HP', a:'LK', b:'MK', c:'HK' };
    // Internal code → keyboard key label
    // Convert a raw CMD name to a human-readable label.
    // Handles numpad notation ("623c" → "DP HK", "236b" → "QCF MK")
    // and bare button names ("y" → "MP").
    const MOTION_NAMES = {
      '236236':'DQCFwd', '214214':'DQCBck', '63214':'HCB', '41236':'HCF',
      '236': 'QCF', '214': 'QCB', '623': 'DP', '421': 'RDP',
      '22': '↓↓', '28': 'DP↑', '27': '↓↑'
    };
    function _cmdLabel(name) {
      // Numpad + button: "236c", "623ab", "22b"
      if (/^\d+[a-z]{1,3}$/i.test(name)) {
        const motion = name.replace(/[a-z]+$/i, '');
        const btns   = name.match(/[a-z]+$/i)[0].toLowerCase().split('');
        const btnStr = btns.map(b => BTN_NAME[b] ?? b.toUpperCase()).join('+');
        const motStr = MOTION_NAMES[motion] ?? motion;
        return `${motStr} ${btnStr}`;
      }
      // Pure button-only name: "y", "xz", "abc"
      if (/^[a-z]{1,3}$/i.test(name) && [...name.toLowerCase()].every(c => BTN_NAME[c])) {
        return [...name.toLowerCase()].map(c => BTN_NAME[c]).join('+');
      }
      return name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    }

    function stepsToStr(steps) {
      return steps.map(step => {
        if (step.type === 'dir') {
          const sym = step.dirs.map(d => DIR_SYM[d] ?? d).join('');
          return (step.held ? '(hold)' : '') + sym;
        }
        if (step.type === 'btn' || step.type === 'simultaneous') {
          return step.btns.map(b => BTN_NAME[b] ?? b).join(step.type === 'simultaneous' ? '+' : '/');
        }
        return '?';
      }).join(' ');
    }

    // Controls reference
    let html = `
      <div class="fg-ml-header">${char.name ?? 'Movelist'}</div>
      <div class="fg-ml-section-title">${t('games.fighting.controls')}</div>
      <div class="fg-ml-controls">
        <div class="fg-ml-row"><span class="fg-ml-key fg-move-keys">${_moveHintKeys()}</span><span>${t('games.fighting.moveJumpCrouch')}</span></div>
        <div class="fg-ml-row"><span class="fg-ml-key">U</span><span>LP</span> <span class="fg-ml-key">I</span><span>MP</span> <span class="fg-ml-key">O</span><span>HP</span></div>
        <div class="fg-ml-row"><span class="fg-ml-key">J</span><span>LK</span> <span class="fg-ml-key">K</span><span>MK</span> <span class="fg-ml-key">L</span><span>HK</span></div>
        <div class="fg-ml-row"><span class="fg-ml-key">Space</span><span>${t('games.fighting.blockHold')}</span></div>
      </div>`;

    // Poses section — show only poses the character actually has animations for
    const POSE_DEFS = [
      { pose: 'intro', label: t('games.fighting.poseIntro'),  anim: ANIM.INTRO  },
      { pose: 'win',   label: t('games.fighting.poseWin'),    anim: ANIM.WIN    },
      { pose: 'win_2', label: t('games.fighting.poseWinTwo'), anim: ANIM.WIN_2  },
      { pose: 'win_3', label: t('games.fighting.poseWinThree'), anim: ANIM.WIN_3 },
      { pose: 'lose',  label: t('games.fighting.poseKnockout'), anim: ANIM.KO_LIE, fallbacks: [ANIM.LOSE_KO, ANIM.FALL_LAND, ANIM.LOSE] },
      { pose: 'dizzy', label: t('games.fighting.dizzy'), anim: ANIM.DIZZY },
    ];
    const availablePoses = POSE_DEFS.filter(p => {
      if (char.anims.has(p.anim)) return true;
      return p.fallbacks?.some(a => char.anims.has(a));
    });
    if (availablePoses.length) {
      const poseRows = availablePoses.map(p =>
        `<div class="fg-ml-row fg-ml-clickable fg-ml-pose" data-pose="${p.pose}"><span class="fg-ml-notation">★</span><span class="fg-ml-name">${p.label}</span></div>`
      ).join('');
      html += `<div class="fg-ml-section-title">${t('games.fighting.poses')}</div>${poseRows}`;
    }

    // Gather special/super moves from commands that are in moveMap
    const normals  = [];
    const specials = [];
    const supers   = [];

    for (const cmd of char.commands) {
      if (!char.moveMap.has(cmd.name)) continue;
      if (cmd.name.startsWith('AI') || cmd.name === 'recovery') continue;
      const binding = char.moveMap.get(cmd.name);
      const notation = stepsToStr(cmd.steps);
      const label = _cmdLabel(cmd.name);
      const entry = { label, notation, binding, cmdName: cmd.name };
      if (binding.powerCost >= 2000) supers.push(entry);
      else if (binding.powerCost >= 1000 || cmd.steps.length > 1) specials.push(entry);
      else normals.push(entry);
    }

    function renderSection(title, items) {
      if (!items.length) return '';
      const rows = items.map(({ label, notation, cmdName }) =>
        `<div class="fg-ml-row fg-ml-clickable" data-cmd="${cmdName}"><span class="fg-ml-notation">${notation}</span><span class="fg-ml-name">${label}</span></div>`
      ).join('');
      return `<div class="fg-ml-section-title">${title}</div>${rows}`;
    }

    // Normal moves table (static layout based on key bindings)
    const NORMAL_ROWS = [
      [t('games.fighting.stanceStanding'), 'stand_lp','stand_mp','stand_hp','stand_lk','stand_mk','stand_hk'],
      [t('games.fighting.stanceCrouching'), 'crouch_lp','crouch_mp','crouch_hp','crouch_lk','crouch_mk','crouch_hk'],
      [t('games.fighting.stanceAirborne'), 'air_lp','air_mp','air_hp','air_lk','air_mk','air_hk'],
    ];
    const BTNS_ORDER = [
      { code:'j', key:'U', label:'LP' }, { code:'k', key:'I', label:'MP' }, { code:'i', key:'O', label:'HP' },
      { code:'u', key:'J', label:'LK' }, { code:'b', key:'K', label:'MK' }, { code:'c', key:'L', label:'HK' },
    ];

    let normalHtml = `<div class="fg-ml-section-title">${t('games.fighting.normalMoves')}</div>
      <div class="fg-ml-normals-header">
        <span></span>${BTNS_ORDER.map(b => `<span class="fg-ml-key">${b.key}<small>${b.label}</small></span>`).join('')}
      </div>`;

    for (const [stance, ...moveNames] of NORMAL_ROWS) {
      const prefix = stance === 'Crouch' ? '↓+' : stance === 'Air' ? '(air)' : '';
      const cells = moveNames.map(mn => {
        const binding = char.moveMap.get(mn);
        return binding
          ? `<span class="fg-ml-has fg-ml-clickable" data-cmd="${mn}" title="${mn.replace(/_/g,' ')}">●</span>`
          : `<span class="fg-ml-none">—</span>`;
      }).join('');
      normalHtml += `<div class="fg-ml-normals-row"><span class="fg-ml-stance">${prefix || stance}</span>${cells}</div>`;
    }

    html += normalHtml;
    html += renderSection(t('games.fighting.specialMoves'), specials);
    html += renderSection(t('games.fighting.superMoves'), supers);

    html += `<div class="fg-ml-close">${t('games.fighting.movelistHelp')}</div>`;
    return html;
  }

  // ── Pose assertion helper ────────────────────────────────────────────────
  function _applyAssertedPose(f, pose) {
    switch (pose) {
      case 'intro': _transition(f, ST.INTRO); break;
      case 'win':   _transition(f, ST.WIN);   f._sbPosePreview = true; break;
      case 'win_2': _transition(f, ST.WIN);   if (f.char.anims.has(ANIM.WIN_2)) f.animAction = ANIM.WIN_2; f._sbPosePreview = true; break;
      case 'win_3': _transition(f, ST.WIN);   if (f.char.anims.has(ANIM.WIN_3)) f.animAction = ANIM.WIN_3; f._sbPosePreview = true; break;
      case 'lose':  _transition(f, ST.LOSE);  f._sbPosePreview = true; break;
      case 'dizzy': _transition(f, ST.DIZZY); break;
    }
  }

  // ── Physics / state machine ──────────────────────────────────────────────
  function tickFighter(f, opp, inp, dt) {
    if (!f?.char) return;
    const stats = f.char.stats;
    if (_consumeHitstop(f)) return;

    _updateFacing(f, opp);
    _applyAirGravity(f, stats);
    _trackDashInputs(f, inp);
    _runStateNeg2(f, opp);
    _tickState(f, opp, inp, stats);
    _integrateFighter(f, dt);
    _spawnAttackProjectile(f);
    _handleGroundContact(f, stats);
    _constrainFighterX(f, stats);
    _separateFighters(f, opp, stats);
    _finishFighterTick(f);
  }

  function _consumeHitstop(f) {
    if (f.hitstopLeft <= 0) return false;
    f.hitstopLeft--;
    return true;
  }

  function _updateFacing(f, opp) {
    const lockedStates = [ST.ATTACK, ST.HITSTUN, ST.BLOCKSTUN, ST.FALL, ST.FALL_LAND, ST.WALK_FWD, ST.WALK_BACK, ST.WIN, ST.LOSE, ST.INTRO, ST.DIZZY];
    if (opp && !lockedStates.includes(f.stateId)) f.facing = opp.x > f.x ? 1 : -1;
  }

  function _applyAirGravity(f, stats) {
    const noGravityStates = [ST.WIN, ST.LOSE, ST.INTRO, ST.DIZZY];
    if (!f.onGround && !noGravityStates.includes(f.stateId)) f.vy += (stats.yaccel || 0.44) * MUGEN_PX_S;
  }

  function _trackDashInputs(f, inp) {
    if (f.slot !== _mySlot) return;
    _trackDashTap(f, inp, 'F', '_lastFwdTap', '_dashFwdReady');
    _trackDashTap(f, inp, 'B', '_lastBckTap', '_dashBckReady');
    f._prevDirs = new Set(inp.dirs);
  }

  function _trackDashTap(f, inp, dir, lastKey, readyKey) {
    if (!inp.dirs.has(dir) || f._prevDirs?.has(dir)) return;
    if (_globalFrame - (f[lastKey] || 0) <= 8) f[readyKey] = true;
    f[lastKey] = _globalFrame;
  }

  function _integrateFighter(f, dt) {
    f.x += f.vx * dt;
    f.y += f.vy * dt;
  }

  function _spawnAttackProjectile(f) {
    if (f.stateId === ST.ATTACK && f.currentMove?.projDef && !f.projSpawned && f.animFrame >= 1) _spawnProjectile(f);
  }

  function _handleGroundContact(f, stats) {
    if (f.y < _floorY) return;
    f.y = _floorY;
    f.vy = 0;
    if (f.onGround) return;
    f.onGround = true;
    f._airJumpsLeft = stats.airJumps ?? 0;
    if (f.stateId === ST.AIR) _transition(f, ST.LAND);
    else if (f.stateId === ST.FALL) _transition(f, ST.FALL_LAND);
  }

  function _constrainFighterX(f, stats) {
    const hw = stats.groundFront || 20;
    f.x = Math.max(hw, Math.min(STAGE_W - hw, f.x));
  }

  function _separateFighters(f, opp, stats) {
    if (!opp) return;
    const minD = (stats.groundFront || 20) + (opp.char.stats.groundFront || 20) + 4;
    const dist = Math.abs(f.x - opp.x);
    if (dist >= minD) return;
    const push = (minD - dist) / 2;
    const sign = f.x >= opp.x ? 1 : -1;
    f.x += sign * push;
    opp.x -= sign * push;
  }

  function _finishFighterTick(f) {
    _tickAnim(f);
    f.visualFacing = f.facing;
    f.stateTimer++;
  }

  function _transition(f, newState, moveName) {
    f.stateId = newState;
    f.stateTimer = 0;
    f.animFrame = 0;
    f.animTimer = 0;
    _TRANSITION_HANDLERS[newState]?.(f, f.char.stats, moveName);
  }

  function _transitionIdle(f) {
    f.animAction = ANIM.IDLE;
    f.vx = 0;
    f.hitLanded = false;
    f.currentMove = null;
    f._dashDone = false;
    _applyStateZeroChangeAnim(f);
  }

  function _applyStateZeroChangeAnim(f) {
    if (!f.vars) return;
    const sd0 = f.char.stateDefs?.get(0);
    if (!sd0) return;
    const ent0 = _fighterControllerEntity(f, 0);
    for (const ctrl of sd0.controllers) {
      if (ctrl.type !== 'changeanim' && ctrl.type !== 'changeanim2') continue;
      if (!_evalTriggers(ctrl, ent0)) continue;
      const animVal = Math.trunc(_evalExpr(ctrl.valueExpr ?? String(ctrl.value), ent0));
      if (f.char.anims.has(animVal)) {
        f.animAction = animVal;
        f.animFrame = 0;
        f.animTimer = 0;
        ent0.animAction = animVal;
      }
      break;
    }
  }

  function _transitionWalkFwd(f, stats) {
    f.animAction = ANIM.WALK_FWD;
    f.vx = f.facing * (stats.walkFwd || 3) * MUGEN_PX_S;
  }

  function _transitionWalkBack(f, stats) {
    f.animAction = ANIM.WALK_BACK;
    f.vx = -f.facing * Math.abs(stats.walkBack || 2.5) * MUGEN_PX_S;
  }

  function _transitionRunFwd(f, stats) {
    f.animAction = f.char.anims.has(ANIM.RUN_FWD) ? ANIM.RUN_FWD : ANIM.WALK_FWD;
    f.vx = f.facing * Math.abs(stats.runFwd || 6) * MUGEN_PX_S;
  }

  function _transitionRunBack(f, stats) {
    f.animAction = f.char.anims.has(ANIM.RUN_BACK) ? ANIM.RUN_BACK : ANIM.WALK_BACK;
    f.vx = -f.facing * Math.abs(stats.walkBack || 2.5) * MUGEN_PX_S * 1.5;
  }

  function _transitionSimpleAnim(f, animAction) {
    f.animAction = animAction;
    f.vx = 0;
  }

  function _transitionJumpStart(f, stats) {
    const jn = stats.jumpNeu || [0, -11];
    f.animAction = ANIM.JUMP_START;
    f.vy = jn[1] * MUGEN_PX_S;
    f.vx = _jumpVelocityX(f, stats, f._jumpDir ?? 'N', jn[0]);
    f.onGround = false;
  }

  function _jumpVelocityX(f, stats, dir, neutralX = 0) {
    if (dir === 'F') return f.facing * Math.abs(stats.jumpFwd || 2) * MUGEN_PX_S;
    if (dir === 'B') return -f.facing * Math.abs(stats.jumpBack || 2) * MUGEN_PX_S;
    return neutralX * MUGEN_PX_S;
  }

  function _transitionAir(f) {
    const jd = f._jumpDir ?? 'N';
    const wantAnim = jd === 'F' ? ANIM.JUMP_FWD : jd === 'B' ? ANIM.JUMP_BACK : ANIM.JUMP_AIR;
    f.animAction = f.char.anims.has(wantAnim) ? wantAnim
                 : f.char.anims.has(ANIM.JUMP_AIR) ? ANIM.JUMP_AIR
                 : ANIM.IDLE;
  }

  function _transitionAttack(f, stats, moveName) {
    if (!moveName) { _transition(f, ST.IDLE); return; }
    const move = f.char.moveMap.get(moveName);
    if (!move) { _transition(f, ST.IDLE); return; }
    f.animAction = move.anim;
    f.hitLanded = false;
    f.currentMove = { name: moveName, hitDef: move.hitDef, projDef: move.projDef ?? null, stateNum: move.stateNum };
    f.hFired?.clear();
    f.vx = 0;
    f.projSpawned = false;
    if (move.powerCost > 0) f.power = Math.max(0, f.power - move.powerCost);
    if (move.snd) _playSound(f.char, move.snd.g, move.snd.i);
  }

  function _transitionHitstun(f) {
    const hitChoices = [
      [f._hitstunWasAir, ANIM.HIT_AIR],
      [f._hitstunWasCrouch, ANIM.HIT_CROUCH],
      [true, ANIM.HIT_STAND],
      [true, ANIM.IDLE],
    ];
    f.animAction = hitChoices.find(([ok, anim]) => ok && f.char.anims.has(anim))?.[1] ?? ANIM.IDLE;
  }

  function _transitionBlockstun(f) {
    f.animAction = _firstExistingAnim(f, [ANIM.GUARD_STAND, ANIM.GUARD_CROUCH, ANIM.IDLE], f.animAction);
  }

  function _transitionAirGuard(f) {
    f.animAction = _firstExistingAnim(f, [ANIM.GUARD_AIR, ANIM.GUARD_STAND, ANIM.IDLE], ANIM.IDLE);
  }

  function _transitionFall(f) {
    f.animAction = f.char.anims.has(ANIM.FALL) ? ANIM.FALL : ANIM.HIT_AIR;
    f._fallBounced = false;
  }

  function _transitionFallLand(f) {
    f.animAction = _firstExistingAnim(f, [ANIM.FALL_LAND, ANIM.LOSE_KO, ANIM.IDLE], ANIM.IDLE);
    f.vx = 0;
    f.vy = 0;
  }

  function _transitionDizzy(f) {
    f.animAction = f.char.anims.has(ANIM.DIZZY) ? ANIM.DIZZY : ANIM.IDLE;
    f.vx = 0;
    f.vy = 0;
  }

  function _transitionIntro(f) {
    f.animAction = f.char.anims.has(ANIM.INTRO) ? ANIM.INTRO : ANIM.IDLE;
    f.vx = 0;
    f.vy = 0;
  }

  function _transitionWin(f) {
    const winOpts = [ANIM.WIN, ANIM.WIN_2, ANIM.WIN_3].filter(a => f.char.anims.has(a));
    f.animAction = winOpts[Math.floor(Math.random() * winOpts.length)] ?? ANIM.WIN;
    f.vx = 0;
    f.vy = 0;
  }

  function _transitionLose(f) {
    f.animAction = _firstExistingAnim(f, [ANIM.KO_LIE, ANIM.LOSE_KO, ANIM.FALL_LAND, ANIM.LOSE, ANIM.HIT_STAND, ANIM.IDLE], ANIM.IDLE);
    f.vx = 0;
    f.vy = 0;
  }

  function _firstExistingAnim(f, anims, fallback) {
    return anims.find(a => f.char.anims.has(a)) ?? fallback;
  }

  function _fighterControllerEntity(f, stateTime = Math.max(0, f.stateTimer - 1)) {
    return { stateTime, animFrame: f.animFrame, animTimer: f.animTimer, char: f.char, animAction: f.animAction, vars: f.vars, fvars: f.fvars };
  }

  const _TRANSITION_HANDLERS = {
    [ST.IDLE]: _transitionIdle,
    [ST.WALK_FWD]: _transitionWalkFwd,
    [ST.WALK_BACK]: _transitionWalkBack,
    [ST.RUN_FWD]: _transitionRunFwd,
    [ST.RUN_BACK]: _transitionRunBack,
    [ST.CROUCH_START]: f => _transitionSimpleAnim(f, ANIM.CROUCH_START),
    [ST.CROUCH]: f => _transitionSimpleAnim(f, ANIM.CROUCH),
    [ST.CROUCH_END]: f => _transitionSimpleAnim(f, ANIM.CROUCH_END),
    [ST.JUMP_START]: _transitionJumpStart,
    [ST.AIR]: _transitionAir,
    [ST.LAND]: f => _transitionSimpleAnim(f, ANIM.JUMP_LAND),
    [ST.ATTACK]: _transitionAttack,
    [ST.HITSTUN]: _transitionHitstun,
    [ST.BLOCKSTUN]: _transitionBlockstun,
    [ST.AIR_GUARD]: _transitionAirGuard,
    [ST.FALL]: _transitionFall,
    [ST.FALL_LAND]: _transitionFallLand,
    [ST.DIZZY]: _transitionDizzy,
    [ST.INTRO]: _transitionIntro,
    [ST.WIN]: _transitionWin,
    [ST.LOSE]: _transitionLose,
  };
  function _tickState(f, opp, inp, stats) {
    _STATE_TICKERS[f.stateId]?.(f, opp, inp, stats);
  }

  function _tickIdle(f, opp, inp) {
    f.vx = 0;
    const wasBlockingIdle = f.isBlocking;
    f.isBlocking = inp.btns.has('block');
    if (f.isBlocking) { _setGuardAnim(f, ANIM.GUARD_STAND, ANIM.IDLE); return; }
    _resetIdleGuardAnimation(f, wasBlockingIdle);

    const isLocal = _isLocalFighter(f);
    if (_consumeAssertedLocalAction(f, isLocal)) return;
    if (_consumeAssertedRemoteAction(f, isLocal)) return;
    if (_tryBufferedCommand(f)) return;
    if (_transitionPressedAttack(f, inp, true)) return;
    if (inp.dirs.has('D')) { _transition(f, ST.CROUCH_START); return; }
    if (inp.dirs.has('U')) { _startJumpFromInput(f, inp); return; }
    if (_consumeDash(f, '_dashFwdReady', ST.RUN_FWD)) return;
    if (_consumeDash(f, '_dashBckReady', ST.RUN_BACK)) return;
    if (inp.dirs.has('F')) { _transition(f, ST.WALK_FWD); return; }
    if (inp.dirs.has('B')) _transition(f, ST.WALK_BACK);
  }

  function _setGuardAnim(f, preferred, fallback) {
    const ga = f.char.anims.has(preferred) ? preferred : fallback;
    if (f.animAction !== ga) { f.animAction = ga; f.animFrame = 0; f.animTimer = 0; }
  }

  function _resetIdleGuardAnimation(f, wasBlockingIdle) {
    if (!wasBlockingIdle || f.animAction !== ANIM.GUARD_STAND) return;
    f.animAction = ANIM.IDLE;
    const idleFrames = f.char.anims.get(ANIM.IDLE);
    if (idleFrames && f.animFrame >= idleFrames.length) { f.animFrame = 0; f.animTimer = 0; }
  }

  function _isLocalFighter(f) {
    return _sbActive ? f.slot === _sbMySlot : f.slot === _mySlot;
  }

  function _consumeAssertedLocalAction(f, isLocal) {
    if (!isLocal) return false;
    if (_assertedCmd) {
      const cmd = _assertedCmd;
      _assertedCmd = null;
      if (f.char.moveMap.has(cmd)) { _transition(f, ST.ATTACK, cmd); return true; }
    }
    if (_assertedPose) {
      const pose = _assertedPose;
      _assertedPose = null;
      _applyAssertedPose(f, pose);
      return true;
    }
    return false;
  }

  function _consumeAssertedRemoteAction(f, isLocal) {
    if (isLocal || !_sbActive) return false;
    if (f._assertedCmd) {
      const cmd = f._assertedCmd;
      f._assertedCmd = null;
      if (f.char.moveMap.has(cmd)) { _transition(f, ST.ATTACK, cmd); return true; }
    }
    if (f._assertedPose) {
      const pose = f._assertedPose;
      f._assertedPose = null;
      _applyAssertedPose(f, pose);
      return true;
    }
    return false;
  }

  function _tryBufferedCommand(f) {
    if (f.slot !== _mySlot) return false;
    const cmd = _matchCommands(f.char, _localInputBuf);
    const mv = cmd ? f.char.moveMap.get(cmd) : null;
    if (!mv || f.power < (mv.powerCost || 0)) return false;
    _transition(f, ST.ATTACK, cmd);
    return true;
  }

  function _transitionPressedAttack(f, inp, isStand = true, isCrouch = false, isAir = false) {
    const btn = _attackBtn(inp, isStand, isCrouch, isAir);
    if (!btn) return false;
    _transition(f, ST.ATTACK, btn);
    return true;
  }

  function _startJumpFromInput(f, inp) {
    f._jumpDir = inp.dirs.has('F') ? 'F' : inp.dirs.has('B') ? 'B' : 'N';
    _transition(f, ST.JUMP_START);
  }

  function _consumeDash(f, readyKey, state) {
    if (!f[readyKey]) return false;
    f[readyKey] = false;
    _transition(f, state);
    return true;
  }

  function _tickRunFwd(f, opp, inp, stats) {
    const runDone = !f.char.anims.has(ANIM.RUN_FWD) || _animDone(f) || f.stateTimer > 20;
    if (runDone && !inp.dirs.has('F')) { _transition(f, ST.IDLE); return; }
    if (runDone && inp.dirs.has('F')) f.vx = f.facing * Math.abs(stats.runFwd || 6) * MUGEN_PX_S;
  }

  function _tickRunBack(f) {
    if (_animDone(f) || f.stateTimer > 18) _transition(f, ST.IDLE);
  }

  function _tickWalkFwd(f, opp, inp, stats) {
    if (_walkInputReleased(inp, 'F')) { _transition(f, ST.IDLE); return; }
    if (_transitionPressedAttack(f, inp, true)) return;
    f.vx = f.facing * (stats.walkFwd || 3) * MUGEN_PX_S;
  }

  function _tickWalkBack(f, opp, inp, stats) {
    if (_walkInputReleased(inp, 'B')) { _transition(f, ST.IDLE); return; }
    f.vx = -f.facing * Math.abs(stats.walkBack || 2.5) * MUGEN_PX_S;
  }

  function _walkInputReleased(inp, dir) {
    return !inp.dirs.has(dir) || inp.dirs.has('D') || inp.dirs.has('U');
  }

  function _tickCrouchStart(f, opp, inp) {
    if (!inp.dirs.has('D')) { _transition(f, ST.CROUCH_END); return; }
    if (!f.char.anims.has(ANIM.CROUCH_START) || _animDone(f)) _transition(f, ST.CROUCH);
  }

  function _tickCrouch(f, opp, inp) {
    const wasBlockingCrouch = f.isBlocking;
    f.isBlocking = inp.btns.has('block') || inp.dirs.has('B');
    if (f.isBlocking) _setGuardAnim(f, ANIM.GUARD_CROUCH, ANIM.CROUCH);
    else _resetCrouchGuardAnimation(f, wasBlockingCrouch);
    if (!inp.dirs.has('D')) { _transition(f, ST.CROUCH_END); return; }
    _transitionPressedAttack(f, inp, false, true);
  }

  function _resetCrouchGuardAnimation(f, wasBlockingCrouch) {
    if (!wasBlockingCrouch || (f.animAction !== ANIM.GUARD_CROUCH && f.animAction !== ANIM.GUARD_STAND)) return;
    f.animAction = ANIM.CROUCH;
    f.animFrame = 0;
    f.animTimer = 0;
  }

  function _tickCrouchEnd(f) {
    if (!f.char.anims.has(ANIM.CROUCH_END) || _animDone(f)) _transition(f, ST.IDLE);
  }

  function _tickJumpStart(f) {
    if (!f.char.anims.has(ANIM.JUMP_START) || _animDone(f) || f.vy < 0) _transition(f, ST.AIR);
  }

  function _tickAir(f, opp, inp, stats) {
    if (f.onGround) { _transition(f, ST.LAND); return; }
    if (inp.btns.has('block')) { _transition(f, ST.AIR_GUARD); return; }
    if (_tryAirJump(f, inp, stats)) return;
    if (_transitionPressedAttack(f, inp, false, false, true)) return;
    f.vx = _jumpVelocityX(f, stats, inp.dirs.has('F') ? 'F' : inp.dirs.has('B') ? 'B' : 'N');
  }

  function _tryAirJump(f, inp, stats) {
    if (!inp.dirs.has('U') || f._airJumpsLeft <= 0) return false;
    f._airJumpsLeft--;
    const jn = stats.jumpNeu || [0, -9];
    f.vy = jn[1] * MUGEN_PX_S;
    f._jumpDir = inp.dirs.has('F') ? 'F' : inp.dirs.has('B') ? 'B' : 'N';
    _transition(f, ST.AIR);
    return true;
  }

  function _tickAirGuard(f, opp, inp) {
    if (f.onGround) { _transition(f, ST.LAND); return; }
    if (!inp.btns.has('block')) { _transition(f, ST.AIR); return; }
    f.vx *= 0.9;
  }

  function _tickLand(f) {
    if (!f.char.anims.has(ANIM.JUMP_LAND) || _animDone(f)) _transition(f, ST.IDLE);
  }

  function _tickAttack(f, opp) {
    _runFighterHelpers(f, opp);
    if (_attackIsDone(f)) _finishAttack(f);
  }

  function _attackIsDone(f) {
    const frames = f.char.anims.get(f.animAction);
    const holdLast = frames?.length && frames[frames.length - 1].dur < 0;
    return _animDone(f) || (holdLast && f.animFrame >= (frames?.length ?? 1) - 1 && f.stateTimer > 40);
  }

  function _finishAttack(f) {
    for (const h of _helpers) if (h.alive && h.parentSlot === f.slot && !h.persistent) h.alive = false;
    for (const ex of _explods) if (!ex.done && ex.ownerSlot === f.slot && ex.removetime === -1) ex.done = true;
    _transition(f, f.onGround ? ST.IDLE : ST.AIR);
  }

  function _tickHitstun(f) {
    _tickTimedStun(f, 'hitstunLeft', f.onGround ? ST.IDLE : ST.AIR);
  }

  function _tickBlockstun(f) {
    _tickTimedStun(f, 'blockstunLeft', ST.IDLE, () => { f.isBlocking = false; });
  }

  function _tickTimedStun(f, counter, nextState, beforeTransition) {
    f[counter]--;
    if (f.onGround) f.vx *= 0.7;
    if (f[counter] > 0) return;
    beforeTransition?.();
    _transition(f, nextState);
  }

  function _tickFall(f) {
    f.vx *= 0.95;
  }

  function _tickFallLand(f) {
    if (!_animDone(f) && f.stateTimer <= 60) return;
    _transition(f, _health[f.slot] <= 0 ? ST.LOSE : ST.IDLE);
  }

  function _tickDizzy(f, opp, inp) {
    if (f.stateTimer < 180 && inp.btns.size === 0) return;
    f.dizzyPoints = Math.round(f.maxDizzyPoints * 0.5);
    _transition(f, ST.IDLE);
  }

  function _tickIntro(f) {
    if (_animDone(f) || f.stateTimer > 300) _transition(f, ST.IDLE);
  }

  function _tickPosePreview(f) {
    f.vx = 0;
    f.vy = 0;
    if (!f._sbPosePreview || (!_animDone(f) && f.stateTimer <= 300)) return;
    f._sbPosePreview = false;
    _transition(f, ST.IDLE);
  }

  const _STATE_TICKERS = {
    [ST.IDLE]: _tickIdle,
    [ST.RUN_FWD]: _tickRunFwd,
    [ST.RUN_BACK]: _tickRunBack,
    [ST.WALK_FWD]: _tickWalkFwd,
    [ST.WALK_BACK]: _tickWalkBack,
    [ST.CROUCH_START]: _tickCrouchStart,
    [ST.CROUCH]: _tickCrouch,
    [ST.CROUCH_END]: _tickCrouchEnd,
    [ST.JUMP_START]: _tickJumpStart,
    [ST.AIR]: _tickAir,
    [ST.AIR_GUARD]: _tickAirGuard,
    [ST.LAND]: _tickLand,
    [ST.ATTACK]: _tickAttack,
    [ST.HITSTUN]: _tickHitstun,
    [ST.BLOCKSTUN]: _tickBlockstun,
    [ST.FALL]: _tickFall,
    [ST.FALL_LAND]: _tickFallLand,
    [ST.DIZZY]: _tickDizzy,
    [ST.INTRO]: _tickIntro,
    [ST.WIN]: _tickPosePreview,
    [ST.LOSE]: _tickPosePreview,
  };
  function _attackBtn(inp, _isStand = true, isCrouch = false, isAir = false) {
    if (isCrouch) {
      if (inp.btns.has('j')) return 'crouch_lp';
      if (inp.btns.has('k')) return 'crouch_mp';
      if (inp.btns.has('i')) return 'crouch_hp';
    } else if (isAir) {
      if (inp.btns.has('j')) return 'air_lp';
      if (inp.btns.has('k')) return 'air_mp';
      if (inp.btns.has('i')) return 'air_hp';
      if (inp.btns.has('u')) return 'air_lp';  // LK mapped to air_lp as fallback
    } else {
      if (inp.btns.has('j')) return 'stand_lp';
      if (inp.btns.has('k')) return 'stand_mp';
      if (inp.btns.has('i')) return 'stand_hp';
      if (inp.btns.has('u')) return 'stand_lp';
    }
    return null;
  }

  function _animDone(f) {
    const frames = f.char.anims.get(f.animAction);
    if (!frames?.length) return true;
    if (f.animFrame < frames.length - 1) return false;
    const last = frames[frames.length - 1];
    // dur=-1 means "hold on last frame indefinitely" — the caller must provide
    // its own exit condition (e.g. stateTimer fallback) rather than relying on _animDone.
    if (last.dur < 0) return false;
    return f.animTimer >= (last.dur || 1);
  }

  function _tickAnim(f) {
    const frames = f.char.anims.get(f.animAction);
    if (!frames?.length) return;
    const cur = frames[f.animFrame];
    const dur = cur.dur < 0 ? 999999 : (cur.dur || 1);
    f.animTimer++;
    if (f.animTimer >= dur) {
      // Guard animations hold on last frame — don't loop them
      const _isGuardAnim = f.isBlocking &&
        (f.animAction === ANIM.GUARD_STAND || f.animAction === ANIM.GUARD_CROUCH);
      const loops = !_isGuardAnim &&
        [ST.IDLE, ST.WALK_FWD, ST.WALK_BACK, ST.CROUCH, ST.AIR, ST.BLOCKSTUN, ST.WIN].includes(f.stateId);
      if (f.animFrame < frames.length - 1) {
        f.animTimer = 0;
        f.animFrame++;
      } else if (loops) {
        f.animTimer = 0;
        f.animFrame = frames._loopStart ?? 0;  // respect Loopstart directive
      }
      // else: last frame of non-looping state — keep animTimer ≥ dur so
      // _animDone() returns true on the next _tickState check.
    }
  }

  // ── Hit detection ────────────────────────────────────────────────────────
  function checkHits(atk, def) {
    if (!atk || !def) return;
    if (atk.stateId !== ST.ATTACK || atk.hitLanded) return;
    if ([ST.HITSTUN, ST.BLOCKSTUN, ST.WIN, ST.LOSE, ST.INTRO].includes(def.stateId)) return;
    const frames = atk.char.anims.get(atk.animAction);
    if (!frames) return;
    const frame = frames[atk.animFrame];

    // Use the frame's Clsn1 attack boxes; if none are defined, synthesise a
    // forward-facing hitbox from the character's size stats so attacks can always land.
    const s = atk.char.stats;
    const rawClsn1 = frame?.clsn1?.length
      ? frame.clsn1
      : [{ x1: 10, y1: -(s.height * 0.8), x2: (s.groundFront || 30) + 40, y2: -(s.height * 0.15) }];

    const c1 = _worldClsn(rawClsn1, atk);
    const c2 = _worldClsn(_hurtbox(def), def);
    for (const a of c1) for (const d of c2) {
      if (a.x1 < d.x2 && a.x2 > d.x1 && a.y1 < d.y2 && a.y2 > d.y1) {
        _applyHit(atk, def); return;
      }
    }
  }

  function _hurtbox(f) {
    const frames = f.char.anims.get(f.animAction);
    if (frames?.[f.animFrame]?.clsn2.length) return frames[f.animFrame].clsn2;
    const s = f.char.stats;
    return [{ x1: -(s.groundBack || 20), y1: -(s.height || 60), x2: (s.groundFront || 20), y2: 0 }];
  }

  function _worldClsn(arr, f) {
    return arr.map(c => f.facing === 1
      ? { x1: f.x + c.x1, y1: f.y + c.y1, x2: f.x + c.x2, y2: f.y + c.y2 }
      : { x1: f.x - c.x2, y1: f.y + c.y1, x2: f.x - c.x1, y2: f.y + c.y2 });
  }

  // ── Projectile system ────────────────────────────────────────────────────

  function _spawnProjectile(f) {
    const pd = f.currentMove.projDef;
    if (!pd) return;
    f.projSpawned = true;
    _projectiles.push({
      id:         ++_projIdCounter,
      ownerSlot:  f.slot,
      char:       f.char,
      x:          f.x + f.facing * pd.ox,
      y:          f.y + pd.oy,
      vx:         f.facing * pd.vx * MUGEN_PX_S,
      vy:         pd.vy   * MUGEN_PX_S,
      animId:     pd.animId,
      hitAnimId:  pd.hitAnimId,
      animFrame:  0,
      animTimer:  0,
      hitDef:     pd.hitDef,
      hit:        false,
      done:       false,
    });
  }

  function _tickProjectiles(dt) {
    for (const p of _projectiles) _tickProjectile(p, dt);
    _projectiles = _projectiles.filter(p => !p.done);
  }

  function _tickProjectile(p, dt) {
    if (p.done) return;
    if (!p.hit) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
    if (_projectileOffscreen(p)) { p.done = true; return; }
    _advanceProjectileAnim(p);
  }

  function _projectileOffscreen(p) {
    return p.x < -100 || p.x > STAGE_W + 100;
  }

  function _advanceProjectileAnim(p) {
    const frames = p.char.anims.get(p.hit ? p.hitAnimId : p.animId);
    if (!frames?.length) { if (p.hit) p.done = true; return; }
    const frameDur = frames[p.animFrame]?.dur ?? 4;
    if (++p.animTimer < (frameDur < 0 ? 999999 : frameDur)) return;
    p.animTimer = 0;
    p.animFrame++;
    if (p.animFrame < frames.length) return;
    if (p.hit) p.done = true;
    else p.animFrame = 0;
  }
  function _checkProjectileHits() {
    for (const p of _projectiles) {
      const def = _projectileDefender(p);
      if (!def || !_projectileHitsDefender(p, def)) continue;
      _detonateProjectile(p);
      _applyProjectileHit(p, def);
    }
  }

  function _projectileDefender(p) {
    const def = _fighters[p.ownerSlot === 0 ? 1 : 0];
    if (!def || p.hit || p.done) return null;
    return [ST.HITSTUN, ST.BLOCKSTUN, ST.WIN, ST.LOSE, ST.INTRO].includes(def.stateId) ? null : def;
  }

  function _projectileHitsDefender(p, def) {
    const projFacing = p.vx >= 0 ? 1 : -1;
    const projClsn = [{ x1: -30, y1: -30, x2: 30, y2: 0 }];
    return _collisionSetsOverlap(
      _worldClsn(projClsn, { x: p.x, y: p.y, facing: projFacing }),
      _worldClsn(_hurtbox(def), def),
    );
  }

  function _collisionSetsOverlap(aBoxes, bBoxes) {
    for (const a of aBoxes) for (const b of bBoxes) if (_boxesOverlap(a, b)) return true;
    return false;
  }

  function _boxesOverlap(a, b) {
    return a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
  }

  function _detonateProjectile(p) {
    p.hit = true;
    p.vx = 0;
    p.vy = 0;
    p.animFrame = 0;
    p.animTimer = 0;
  }

  function _applyProjectileHit(p, def) {
    const hitDef = p.hitDef;
    const blocked = def.isBlocking;
    const rawDmg = blocked ? Math.max(1, Math.floor(hitDef.damage * 0.1)) : hitDef.damage;
    const dmg = Math.max(1, Math.min(99, Math.round(rawDmg / (p.char.stats.life || 1000) * 100)));
    _applyHitVelocity(def, hitDef, blocked);
    _gainProjectilePower(p.ownerSlot, def);
    _playHitSound(p.char, hitDef, blocked);
    _rememberHitStance(def);
    _transitionProjectileDefender(def, hitDef, blocked);
    const atk = _fighters[p.ownerSlot];
    if (atk) _spawnHitSpark(atk, def, hitDef, blocked);
    socket.emit('fighting:hit', { roomId: _roomId, targetSlot: def.slot, damage: dmg, blocked, attackerX: p.x, targetX: def.x });
  }

  function _applyHitVelocity(def, hitDef, blocked = false) {
    if (!def.onGround && hitDef.airVelocity && (hitDef.airVelocity[0] || hitDef.airVelocity[1])) {
      def.vx = -def.facing * Math.abs(hitDef.airVelocity[0] || 3) * MUGEN_PX_S;
      def.vy = (hitDef.airVelocity[1] || -4) * MUGEN_PX_S;
    } else {
      def.vx = -def.facing * Math.abs(hitDef.groundVelocity || 3) * MUGEN_PX_S;
      def.vy = (hitDef.groundVelocityY || 0) * MUGEN_PX_S;
    }
    if (blocked) def.vx = -def.facing * Math.abs(hitDef.guardVelocity || 2) * MUGEN_PX_S;
  }

  function _gainProjectilePower(ownerSlot, def) {
    const atk = _fighters[ownerSlot];
    if (atk) atk.power = Math.min(atk.maxPower, (atk.power || 0) + 30);
    def.power = Math.min(def.maxPower, (def.power || 0) + 15);
  }

  function _playHitSound(char, hitDef, blocked) {
    if (blocked && hitDef.guardsound) _playSound(char, hitDef.guardsound[0], hitDef.guardsound[1], 0.7);
    else if (!blocked && hitDef.hitsound) _playSound(char, hitDef.hitsound[0], hitDef.hitsound[1]);
  }

  function _rememberHitStance(def) {
    def._hitstunWasAir = !def.onGround;
    def._hitstunWasCrouch = [ST.CROUCH, ST.CROUCH_START, ST.CROUCH_END].includes(def.stateId);
  }

  function _transitionProjectileDefender(def, hitDef, blocked) {
    if (blocked) {
      def.blockstunLeft = Math.max(4, Math.round((hitDef.groundHitTime || 12) * 0.5));
      _transition(def, ST.BLOCKSTUN);
      return;
    }
    const hittime = def._hitstunWasAir ? (hitDef.airHitTime || hitDef.groundHitTime || 16) : (hitDef.groundHitTime || 16);
    def.hitstunLeft = Math.max(4, hittime);
    _transition(def, ST.HITSTUN);
    _screenShakeFrames = 8;
    _screenShakeAmp = 5;
    def.hitFlashFrames = 6;
  }
  // ── Explod / visual FX system ─────────────────────────────────────────────

  /**
   * Spawn a sprite-based visual effect using a character's own animation.
   * If opts.id != 0 and opts.ownerSlot is set, any existing explod with the
   * same id+owner is replaced (MUGEN id-dedup behaviour).
   */
  function _spawnExplod(char, animId, x, y, facing = 1, opts = {}) {
    if (!char?.anims?.has(animId)) return;
    const removetime = opts.removetime ?? -2;
    const id = opts.id ?? 0;
    const ownerSlot = opts.ownerSlot ?? -1;
    const bindtime = opts.bindtime ?? 0;
    _dedupeExplod(id, ownerSlot);
    const bindOffset = _explodBindOffset(x, y, ownerSlot, bindtime);
    _explods.push({
      char, animId, x, y, facing,
      frame: 0, frameTimer: 0,
      removetime,
      ticksLeft: removetime > 0 ? removetime : 9999,
      scale: opts.scale ?? [1, 1],
      done: false, procedural: false,
      xid: id, ownerSlot,
      bindtime, bx: bindOffset.x, by: bindOffset.y,
      lifeTicks: 0,
    });
  }

  function _dedupeExplod(id, ownerSlot) {
    if (id === 0 || ownerSlot < 0) return;
    for (const ex of _explods) {
      if (!ex.done && ex.xid === id && ex.ownerSlot === ownerSlot) ex.done = true;
    }
  }

  function _explodBindOffset(x, y, ownerSlot, bindtime) {
    const parent = bindtime !== 0 && ownerSlot >= 0 ? _fighters[ownerSlot] : null;
    return parent
      ? { x: (x - parent.x) / (parent.facing || 1), y: y - parent.y }
      : { x: 0, y: 0 };
  }
  /**
   * Spawn the appropriate hit spark when an attack connects or is blocked.
   * Uses the HitDef's sparkno / guard.sparkno / sparkxy to position and choose the animation.
   * Falls back to a procedural canvas flash if no character-owned sprite animation is found.
   */
  function _spawnHitSpark(atk, def, hitDef, blocked) {
    if (!hitDef) return;
    const spark = blocked ? (hitDef.guardSparkno ?? hitDef.sparkno) : hitDef.sparkno;
    const sx = hitDef.sparkxy ? hitDef.sparkxy[0] : 0;
    const sy = hitDef.sparkxy ? hitDef.sparkxy[1] : -60;
    // Spark position: negative sx = deeper into defender; sy relative to attacker's base Y
    const sparkX = def.x - def.facing * sx;
    const sparkY = atk.y + sy;
    if (spark?.fromChar && atk.char?.anims?.has(spark.id)) {
      _spawnExplod(atk.char, spark.id, sparkX, sparkY, atk.facing);
    } else {
      // Procedural flash fallback (used when no sprite-based spark is available)
      _explods.push({
        char: null, animId: -1,
        x: sparkX, y: sparkY,
        facing: 1, frame: 0, frameTimer: 0,
        removetime: 18, ticksLeft: 18,
        scale: [1, 1], done: false, procedural: true,
        xid: 0, ownerSlot: -1, bindtime: 0, lifeTicks: 0,
      });
    }
  }

  /** Advance all active explods by one tick; remove expired ones. */
  function _updateExplods() {
    for (const ex of _explods) _updateExplod(ex);
    _explods = _explods.filter(ex => !ex.done);
  }

  function _updateExplod(ex) {
    if (ex.done) return;
    if (++ex.lifeTicks >= 600) { ex.done = true; return; }
    if (ex.procedural) { if (--ex.ticksLeft <= 0) ex.done = true; return; }
    _updateBoundExplod(ex);
    const frames = ex.char?.anims?.get(ex.animId);
    if (!frames?.length) { ex.done = true; return; }
    _advanceExplodFrame(ex, frames);
    if (ex.removetime > 0 && --ex.ticksLeft <= 0) ex.done = true;
  }

  function _updateBoundExplod(ex) {
    if (ex.bindtime === 0) return;
    const parent = ex.ownerSlot >= 0 ? _fighters[ex.ownerSlot] : null;
    if (parent) { ex.x = parent.x + ex.bx * parent.facing; ex.y = parent.y + ex.by; }
    if (ex.bindtime > 0 && --ex.bindtime === 0 && parent) {
      ex.bx = (ex.x - parent.x) / (parent.facing || 1);
      ex.by = ex.y - parent.y;
    }
  }

  function _advanceExplodFrame(ex, frames) {
    const dur = frames[ex.frame]?.dur ?? 4;
    if (dur < 0) { if (ex.removetime === -2) ex.done = true; return; }
    if (++ex.frameTimer < dur) return;
    ex.frameTimer = 0;
    ex.frame++;
    if (ex.frame < frames.length) return;
    if (ex.removetime === -2) ex.done = true;
    else ex.frame = frames._loopStart ?? 0;
  }
  /** Draw all active explods on top of fighters. */
  function _drawExplods(ctx) {
    for (const ex of _explods) {
      if (ex.procedural) { _drawProceduralSpark(ctx, ex); continue; }
      const frames = ex.char?.anims?.get(ex.animId);
      if (!frames?.length) continue;
      const frame = frames[Math.min(ex.frame, frames.length - 1)];
      if (!frame) continue;
      const sprite = ex.char.sprites.get(`${frame.g}_${frame.i}`);
      if (!sprite?.canvas) continue;
      const fh = frame.flipH ? -1 : 1;
      ctx.save();
      ctx.translate(ex.x + frame.ox * ex.facing, ex.y + frame.oy);
      ctx.scale(ex.scale[0] * ex.facing * fh, ex.scale[1]);
      ctx.drawImage(sprite.canvas, -sprite.axisX, -sprite.axisY);
      ctx.restore();
    }
  }

  /** Draw a procedural star-shaped flash used as a hit spark fallback. */
  function _drawProceduralSpark(ctx, ex) {
    const progress = 1 - ex.ticksLeft / Math.max(1, ex.removetime);
    const alpha    = Math.max(0, 1 - progress * 1.4);
    const size     = 40 * Math.pow(1 - progress, 0.4); // fast burst then shrink
    if (size < 1) return;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(ex.x, ex.y);

    // Outer glow
    const grd = ctx.createRadialGradient(0, 0, 0, 0, 0, size * 1.3);
    grd.addColorStop(0,   '#fff');
    grd.addColorStop(0.15, '#ffe066');
    grd.addColorStop(0.5,  'rgba(255,120,0,0.5)');
    grd.addColorStop(1,    'rgba(255,0,0,0)');
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.arc(0, 0, size * 1.3, 0, Math.PI * 2);
    ctx.fill();

    // 4-pointed star (MUGEN-style spark)
    const NUM_SPIKES = 4;
    const outerR = size;
    const innerR = size * 0.18;
    ctx.fillStyle = '#fff';
    ctx.globalAlpha = alpha * 0.95;
    ctx.beginPath();
    for (let i = 0; i < NUM_SPIKES * 2; i++) {
      const angle = (i * Math.PI / NUM_SPIKES) - Math.PI / 4;
      const r = i % 2 === 0 ? outerR : innerR;
      if (i === 0) ctx.moveTo(Math.cos(angle) * r, Math.sin(angle) * r);
      else         ctx.lineTo(Math.cos(angle) * r, Math.sin(angle) * r);
    }
    ctx.closePath();
    ctx.fill();

    // White core
    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.15, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  // ── MUGEN Helper system ───────────────────────────────────────────────────

  /** Evaluate one MUGEN trigger expression against an entity (fighter or helper). */
  /** Find first index of `op` at top level (not inside parens or double-quotes). */
  function _topLevelOpIndex(s, op) {
    let depth = 0, inQ = false;
    for (let i = 0; i <= s.length - op.length; i++) {
      const c = s[i];
      if (c === '"') inQ = !inQ;
      if (inQ) continue;
      if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') depth--;
      else if (depth === 0 && s.startsWith(op, i)) return i;
    }
    return -1;
  }
  /** Return index of ')' that closes '(' at `start`, or -1. */
  function _matchParenEnd(s, start) {
    let depth = 0;
    for (let i = start; i < s.length; i++) {
      if (s[i] === '(') depth++;
      else if (s[i] === ')') { if (--depth === 0) return i; }
    }
    return -1;
  }

  /**
   * Evaluate a MUGEN arithmetic expression at runtime, returning a number.
   * Handles: integer/float literals, var(N), fvar(N), !expr (logical not as int),
   * and binary ops: N+var(M), var(M)+N, N-var(M), var(M)-N, var(M)*N, N*var(M).
   */
  function _evalExpr(expr, entity) {
    const e = String(expr ?? '0').trim();
    if (!e) return 0;
    if (e.startsWith('!')) return _evalExpr(e.slice(1), entity) === 0 ? 1 : 0;
    const varValue = _evalPlainVarExpr(e, entity);
    if (varValue !== null) return varValue;
    const n = Number(e);
    if (!isNaN(n)) return n;
    const varMath = _evalVarMathExpr(e, entity);
    if (varMath !== null) return varMath;
    const timeMath = _evalTimeExpr(e, entity);
    if (timeMath !== null) return timeMath;
    const fb = parseInt(e, 10);
    return isNaN(fb) ? 0 : fb;
  }

  function _evalPlainVarExpr(e, entity) {
    const m = e.match(/^(f?var)\s*\(\s*(\d+)\s*\)$/i);
    return m ? _entityVarValue(entity, m[1], +m[2]) : null;
  }

  function _entityVarValue(entity, kind, idx) {
    return kind.toLowerCase() === 'fvar' ? (entity?.fvars?.[idx] ?? 0) : (entity?.vars?.[idx] ?? 0);
  }

  function _evalVarMathExpr(e, entity) {
    const leftNum = e.match(/^(-?[\d.]+)\s*([+\-*])\s*(f?var)\s*\(\s*(\d+)\s*\)$/i);
    if (leftNum) return _applyMath(+leftNum[1], leftNum[2], _entityVarValue(entity, leftNum[3], +leftNum[4]));
    const rightNum = e.match(/^(f?var)\s*\(\s*(\d+)\s*\)\s*([+\-*])\s*(-?[\d.]+)$/i);
    if (rightNum) return _applyMath(_entityVarValue(entity, rightNum[1], +rightNum[2]), rightNum[3], +rightNum[4]);
    return null;
  }

  function _applyMath(left, op, right) {
    if (op === '+') return left + right;
    if (op === '-') return left - right;
    return left * right;
  }

  function _evalTimeExpr(e, entity) {
    const t = entity?.stateTime ?? 0;
    if (/^time$/i.test(e)) return t;
    let m = e.match(/^time\s*\*\s*(-?[\d.]+)$/i);
    if (m) return t * +m[1];
    m = e.match(/^(-?[\d.]+)\s*\*\s*time$/i);
    if (m) return +m[1] * t;
    m = e.match(/^(-?[\d.]+)\s*([+-])\s*time\s*\*\s*(-?[\d.]+)$/i);
    if (m) return m[2] === '+' ? +m[1] + t * +m[3] : +m[1] - t * +m[3];
    return null;
  }
  function _evalTrigger(expr, entity) {
    const trimmed = expr.trim();
    const compound = _evalCompoundTrigger(trimmed, entity);
    if (compound !== null) return compound;

    const norm = trimmed.replace(/\s+/g, ' ');
    const e = norm.toLowerCase();
    for (const evaluator of _TRIGGER_EVALUATORS) {
      const result = evaluator(norm, e, entity);
      if (result !== null) return result;
    }
    return false;
  }

  function _evalCompoundTrigger(trimmed, entity) {
    const orIdx = _topLevelOpIndex(trimmed, '||');
    if (orIdx >= 0) return _evalTrigger(trimmed.slice(0, orIdx), entity) || _evalTrigger(trimmed.slice(orIdx + 2), entity);
    const andIdx = _topLevelOpIndex(trimmed, '&&');
    if (andIdx >= 0) return _evalTrigger(trimmed.slice(0, andIdx), entity) && _evalTrigger(trimmed.slice(andIdx + 2), entity);
    if (trimmed.startsWith('(')) {
      const end = _matchParenEnd(trimmed, 0);
      if (end === trimmed.length - 1) return _evalTrigger(trimmed.slice(1, -1), entity);
    }
    if (trimmed.startsWith('!') && !trimmed.startsWith('!=')) return !_evalTrigger(trimmed.slice(1), entity);
    return null;
  }

  function _compareValues(left, op, right) {
    if (op === '=') return left === right;
    if (op === '!=') return left !== right;
    if (op === '>') return left > right;
    if (op === '>=') return left >= right;
    if (op === '<') return left < right;
    return left <= right;
  }

  function _evalLiteralTrigger(norm, e) {
    if (e === '1') return true;
    if (e === '0') return false;
    return null;
  }

  function _evalAnimTimeTrigger(norm, e, entity) {
    if (e !== 'animtime = 0' && e !== 'animtime=0') return null;
    const frames = entity.char?.anims?.get(entity.animAction);
    if (!frames?.length) return true;
    const last = frames[frames.length - 1];
    return entity.animFrame >= frames.length - 1 && (last.dur < 0 || entity.animTimer >= (last.dur || 1));
  }

  function _evalTimeTrigger(norm, e, entity) {
    const t = entity.stateTime ?? entity.stateTimer ?? 0;
    let m = e.match(/^time\s*=\s*(\d+)$/);
    if (m) return t === +m[1];
    m = e.match(/^time\s*(>=|<=|!=|>|<)\s*(\d+)$/);
    if (m) return _compareValues(t, m[1], +m[2]);
    m = e.match(/^time\s*=\s*\[(\d+)\s*,\s*(\d+)\]$/);
    if (m) return t >= +m[1] && t <= +m[2];
    m = e.match(/^timemod\s*=\s*(\d+)\s*,\s*(\d+)$/);
    if (m) return t % +m[1] === +m[2];
    m = e.match(/^animelem\s*=\s*(\d+)$/);
    return m ? (entity.animFrame ?? 0) >= +m[1] - 1 : null;
  }

  function _evalCountTrigger(norm, e) {
    const helper = _evalCountMatch(e, /^(!?)\s*numhelper\s*\(\s*(\d+)\s*\)\s*(?:(=|!=|>|>=|<|<=)\s*(\d+))?$/, id => _helpers.filter(h => h.id === id).length);
    if (helper !== null) return helper;
    return _evalCountMatch(e, /^(!?)\s*numexplod\s*\(\s*(\d+)\s*\)\s*(?:(=|!=|>|>=|<|<=)\s*(\d+))?$/, id => _explods.filter(ex => !ex.done && ex.xid === id).length);
  }

  function _evalCountMatch(e, regex, countFn) {
    const m = e.match(regex);
    if (!m) return null;
    const count = countFn(+m[2]);
    const result = m[3] ? _compareValues(count, m[3], +m[4]) : count > 0;
    return m[1] === '!' ? !result : result;
  }

  function _evalRoundStateTrigger(norm, e) {
    let m = e.match(/^roundstate\s*=\s*\[\s*(\d+)\s*,\s*(\d+)\s*\]$/);
    if (m) return 2 >= +m[1] && 2 <= +m[2];
    m = e.match(/^roundstate\s*(>=|<=|!=|>|<|=)\s*(\d+)$/);
    return m ? _compareValues(2, m[1], +m[2]) : null;
  }

  function _evalRootStateTrigger(norm, e, entity) {
    const range = e.match(/^root\s*,\s*stateno\s*=\s*\[\s*(\d+)\s*,\s*(\d+)\s*\]$/);
    if (range && entity.parentSlot !== undefined) {
      const mugenSt = _parentFighter(entity)?.currentMove?.stateNum ?? -1;
      return mugenSt >= +range[1] && mugenSt <= +range[2];
    }
    const m = e.match(/^root\s*,\s*stateno\s*(=|!=|>|>=|<|<=)\s*(-?\d+)$/i);
    if (!m || entity.parentSlot === undefined) return null;
    return _compareValues(_parentFighter(entity)?.currentMove?.stateNum ?? -1, m[1], +m[2]);
  }

  function _evalRootTimeTrigger(norm, e, entity) {
    const m = e.match(/^root\s*,\s*time\s*(=|!=|>|>=|<|<=)\s*(\d+)$/i);
    if (!m || entity.parentSlot === undefined) return null;
    return _compareValues(_parentFighter(entity)?.stateTimer ?? 0, m[1], +m[2]);
  }

  function _parentFighter(entity) {
    return _sbActive ? _sbFighters.get(entity.parentSlot) : _fighters[entity.parentSlot];
  }

  function _evalAliveTrigger(norm, e) {
    const m = e.match(/^alive\s*(=|!=|>|>=|<|<=)?\s*(\d+)?$/);
    if (!m) return null;
    return m[1] ? _compareValues(1, m[1], +(m[2] ?? 0)) : true;
  }

  function _evalPrevStateTrigger(norm, e, entity) {
    const m = e.match(/^prevstateno\s*(=|!=|>|>=|<|<=)\s*(-?\d+)$/);
    return m ? _compareValues(entity.prevStateNum ?? -1, m[1], +m[2]) : null;
  }

  function _evalVarTrigger(norm, e, entity) {
    let m = e.match(/^(?:(?:root|parent|helper)\s*,\s*)?(f?var)\s*\(\s*(\d+)\s*\)$/);
    if (m) return _entityVarValue(entity, m[1], +m[2]) !== 0;
    m = e.match(/^(?:(?:root|parent|helper)\s*,\s*)?(f?var)\s*\(\s*(\d+)\s*\)\s*(=|!=|>|>=|<|<=)\s*(-?[\d.]+)$/);
    return m ? _compareValues(_entityVarValue(entity, m[1], +m[2]), m[3], +m[4]) : null;
  }

  function _evalRootCommandTrigger(norm, e, entity) {
    if (entity.parentSlot === undefined) return null;
    let m = norm.match(/^root\s*,\s*command\s*=\s*"([^"]+)"$/i);
    if (m) return _parentFighter(entity)?.currentMove?.name === m[1];
    m = norm.match(/^root\s*,\s*command\s*!=\s*"([^"]+)"$/i);
    return m ? _parentFighter(entity)?.currentMove?.name !== m[1] : null;
  }

  function _evalAnimTrigger(norm, e, entity) {
    let m = e.match(/^anim\s*=\s*\[\s*(\d+)\s*,\s*(\d+)\s*\]$/);
    if (m) { const a = entity.animAction ?? -1; return a >= +m[1] && a <= +m[2]; }
    m = e.match(/^anim\s*(=|!=|>|>=|<|<=)\s*(.+)$/);
    return m ? _compareValues(entity.animAction ?? -1, m[1], _evalExpr(m[2].trim(), entity)) : null;
  }

  const _TRIGGER_EVALUATORS = [
    _evalLiteralTrigger,
    _evalAnimTimeTrigger,
    _evalTimeTrigger,
    _evalCountTrigger,
    _evalRoundStateTrigger,
    _evalRootStateTrigger,
    _evalRootTimeTrigger,
    _evalAliveTrigger,
    _evalPrevStateTrigger,
    _evalVarTrigger,
    _evalRootCommandTrigger,
    _evalAnimTrigger,
  ];
  function _evalTriggers(ctrl, entity) {
    for (const t of (ctrl.triggerall ?? [])) { if (!_evalTrigger(t, entity)) return false; }
    const ts = ctrl.triggers ?? [];
    if (ts.length === 0) return (ctrl.triggerall?.length ?? 0) > 0;
    // MUGEN semantics: AND within a trigger group, OR between groups.
    // ts is string[][] — each element is one group; all conditions in a group must pass.
    return ts.some(group =>
      (Array.isArray(group) ? group : [group]).every(t => _evalTrigger(t, entity))
    );
  }

  /** Spawn a helper entity from a parent fighter and a parsed Helper controller. */
  function _spawnHelper(parent, opp, ctrl) {
    const char = parent.char;
    if (!char?.stateDefs) return;
    const point = _helperSpawnPoint(parent, opp, ctrl);
    const hFacing = parent.facing * (ctrl.facing || 1);
    const sd = char.stateDefs.get(ctrl.stateno);
    _helpers.push(_createHelperEntity(parent, char, ctrl, point, hFacing, sd));
  }

  function _helperSpawnPoint(parent, opp, ctrl) {
    const px = ctrl.pos?.[0] ?? 0;
    const py = ctrl.pos?.[1] ?? 0;
    const ptype = (ctrl.postype ?? 'p1').toLowerCase();
    if (ptype === 'p2' && opp) return { x: opp.x + px * opp.facing, y: opp.y + py };
    if (ptype === 'left') return { x: px, y: parent.y + py };
    if (ptype === 'right') return { x: STAGE_W + px, y: parent.y + py };
    if (ptype === 'none') return { x: px, y: py };
    return { x: parent.x + px * parent.facing, y: parent.y + py };
  }

  function _createHelperEntity(parent, char, ctrl, point, hFacing, sd) {
    return {
      id: ctrl.id || 0,
      name: ctrl.name || '',
      parentSlot: parent.slot,
      char,
      x: point.x, y: point.y,
      vx: sd ? hFacing * sd.velset[0] * MUGEN_PX_S : 0,
      vy: sd ? sd.velset[1] * MUGEN_PX_S : 0,
      facing: hFacing,
      stateNum: ctrl.stateno || 0,
      stateTime: 0,
      animAction: _helperInitialAnim(char, sd),
      animFrame: 0, animTimer: 0,
      alive: true,
      persistent: false,
      scale: ctrl.scale ?? [1, 1],
      removeTime: ctrl.removetime ?? -2,
      bindtime: ctrl.bindtime ?? 0,
      bindOffX: ctrl.pos?.[0] ?? 0,
      bindOffY: ctrl.pos?.[1] ?? 0,
      alphaS: 256,
      alphaD: 256,
      invisible: false,
      drawScaleX: 1,
      drawScaleY: 1,
      drawAngle: 0,
      vars: new Int32Array(60),
      fvars: new Float32Array(40),
    };
  }

  function _helperInitialAnim(char, sd) {
    if (!sd) return -1;
    if (sd.anim >= 0) return sd.anim;
    const initCtrl = sd.controllers.find(c =>
      (c.type === 'changeanim' || c.type === 'changeanim2') &&
      (c.triggers ?? []).flat().some(t => typeof t === 'string' && /^time\s*=\s*0$/i.test(t.trim())) &&
      c.value >= 0 && char.anims.has(c.value)
    );
    return initCtrl?.value ?? -1;
  }
  /** Execute a single controller on an active helper. */
  function _execHelperCtrl(ctrl, h) {
    _HELPER_CTRL_EXECUTORS[ctrl.type]?.(ctrl, h);
  }

  function _helperChangeAnim(ctrl, h) {
    const animVal = Math.trunc(_evalExpr(ctrl.valueExpr ?? String(ctrl.value), h));
    if (!h.char.anims.has(animVal)) return;
    h.animAction = animVal;
    h.animFrame = ctrl.elem > 1 ? ctrl.elem - 1 : 0;
    h.animTimer = 0;
  }

  function _helperVelSet(ctrl, h) {
    if (ctrl.x !== null) h.vx = h.facing * ctrl.x * MUGEN_PX_S;
    if (ctrl.y !== null) h.vy = ctrl.y * MUGEN_PX_S;
  }

  function _helperVelAdd(ctrl, h) {
    if (ctrl.x !== null) h.vx += h.facing * ctrl.x * MUGEN_PX_S;
    if (ctrl.y !== null) h.vy += ctrl.y * MUGEN_PX_S;
  }

  function _helperPosAdd(ctrl, h) {
    if (ctrl.x !== null) h.x += h.facing * ctrl.x;
    if (ctrl.y !== null) h.y += ctrl.y;
  }

  function _helperPosSet(ctrl, h) {
    const parent = _sbActive ? _sbFighters.get(h.parentSlot) : _fighters[h.parentSlot];
    if (ctrl.x !== null) h.x = parent ? parent.x + ctrl.x * parent.facing : ctrl.x;
    if (ctrl.y !== null) h.y = parent ? parent.y + ctrl.y : ctrl.y;
  }

  function _helperSpawnExplod(ctrl, h) {
    if (!h.char.anims.has(ctrl.anim)) return;
    const point = _helperExplodPoint(ctrl, h);
    _spawnExplod(h.char, ctrl.anim, point.x, point.y, h.facing, {
      removetime: ctrl.removetime,
      id: ctrl.id,
      ownerSlot: h.parentSlot,
      bindtime: ctrl.bindtime,
      scale: ctrl.scale,
    });
  }

  function _helperExplodPoint(ctrl, h) {
    const postype = (ctrl.postype ?? 'p1').toLowerCase();
    if (postype === 'p2') {
      const opp = _fighters[h.parentSlot === 0 ? 1 : 0];
      return opp
        ? { x: opp.x + ctrl.pos[0] * opp.facing, y: opp.y + ctrl.pos[1] }
        : { x: h.x + ctrl.pos[0] * h.facing, y: h.y + ctrl.pos[1] };
    }
    if (postype === 'left') return { x: ctrl.pos[0], y: ctrl.pos[1] };
    if (postype === 'right') return { x: STAGE_W + ctrl.pos[0], y: ctrl.pos[1] };
    return { x: h.x + ctrl.pos[0] * h.facing, y: h.y + ctrl.pos[1] };
  }

  function _helperPlaySound(ctrl, h) {
    const parent = _fighters[h.parentSlot];
    if (parent) _playSound(parent.char, ctrl.g, ctrl.i);
  }

  function _helperTrans(ctrl, h) {
    h.alphaS = ctrl.alpha?.[0] ?? 256;
    h.alphaD = ctrl.alpha?.[1] ?? 256;
  }

  function _helperAssertSpecial(ctrl, h) {
    if (ctrl.flag === 'invisible' || ctrl.flag2 === 'invisible') h.invisible = true;
  }

  function _helperAngleDraw(ctrl, h) {
    const sx = _evalExpr(ctrl.scaleXExpr ?? '1', h);
    const sy = _evalExpr(ctrl.scaleYExpr ?? '1', h);
    const ag = _evalExpr(ctrl.angleExpr ?? '0', h);
    if (isFinite(sx) && sx > 0) h.drawScaleX = sx;
    if (isFinite(sy) && sy > 0) h.drawScaleY = sy;
    if (isFinite(ag)) h.drawAngle = ag;
  }

  function _helperBind(ctrl, h) {
    h.bindtime = -1;
    h.bindOffX = ctrl.pos?.[0] ?? 0;
    h.bindOffY = ctrl.pos?.[1] ?? 0;
  }

  function _helperChangeState(ctrl, h) {
    const newSD = h.char.stateDefs?.get(ctrl.value);
    h.stateNum = ctrl.value;
    h.stateTime = 0;
    if (!newSD) return;
    if (newSD.anim >= 0 && h.char.anims.has(newSD.anim)) {
      h.animAction = newSD.anim;
      h.animFrame = 0;
      h.animTimer = 0;
    }
    h.vx = h.facing * newSD.velset[0] * MUGEN_PX_S;
    h.vy = newSD.velset[1] * MUGEN_PX_S;
  }

  const _HELPER_CTRL_EXECUTORS = {
    changeanim: _helperChangeAnim,
    changeanim2: _helperChangeAnim,
    velset: _helperVelSet,
    veladd: _helperVelAdd,
    posadd: _helperPosAdd,
    posset: _helperPosSet,
    destroyself: (ctrl, h) => { h.alive = false; },
    explod: _helperSpawnExplod,
    removeexplod: (ctrl, h) => _removeExplodsById(ctrl.id, h.parentSlot),
    playsnd: _helperPlaySound,
    trans: _helperTrans,
    assertspecial: _helperAssertSpecial,
    angledraw: _helperAngleDraw,
    bindtoroot: _helperBind,
    bindtoparent: _helperBind,
    changestate: _helperChangeState,
  };
  /** Advance helper animation one tick. */
  function _tickHelperAnim(h) {
    if (h.animAction < 0) return;
    const frames = h.char?.anims?.get(h.animAction);
    if (!frames?.length) return;
    const cur = frames[h.animFrame];
    const dur = cur.dur < 0 ? 999999 : (cur.dur || 1);
    if (++h.animTimer >= dur) {
      h.animTimer = 0;
      h.animFrame = h.animFrame < frames.length - 1 ? h.animFrame + 1 : (frames._loopStart ?? 0);
    }
  }

  /** Advance all active helpers by one tick. */
  function _tickHelpers(dt) {
    for (const h of _helpers) _tickHelper(h, dt);
    _helpers = _helpers.filter(h => h.alive);
  }

  function _tickHelper(h, dt) {
    if (!h.alive) return;
    if (_helperExpired(h)) return;
    _moveHelper(h, dt);
    _runHelperStateControllers(h);
    if (!h.alive) return;
    h.stateTime++;
    _tickHelperAnim(h);
  }

  function _helperExpired(h) {
    if (h.removeTime <= 0) return false;
    h.removeTime--;
    if (h.removeTime > 0) return false;
    h.alive = false;
    return true;
  }

  function _moveHelper(h, dt) {
    if (h.bindtime !== 0) {
      const parent = _sbActive ? _sbFighters.get(h.parentSlot) : _fighters[h.parentSlot];
      if (parent) {
        h.x = parent.x + h.bindOffX * parent.facing;
        h.y = parent.y + h.bindOffY;
      }
      if (h.bindtime > 0) h.bindtime--;
      return;
    }
    h.x += h.vx * dt;
    h.y += h.vy * dt;
  }

  function _runHelperStateControllers(h) {
    const sd = h.char.stateDefs?.get(h.stateNum);
    if (!sd) { h.alphaS = 0; return; }
    _resetHelperDrawState(h);
    for (const ctrl of sd.controllers) {
      if (!_evalTriggers(ctrl, h)) continue;
      _execHelperCtrl(ctrl, h);
      if (!h.alive) break;
    }
  }

  function _resetHelperDrawState(h) {
    h.invisible = false;
    h.alphaS = 256;
    h.alphaD = 256;
    h.drawScaleX = 1;
    h.drawScaleY = 1;
    h.drawAngle = 0;
  }
  /** Draw all active helpers. */
  function _drawHelpers(ctx) {
    for (const h of _helpers) {
      if (!h.alive || h.animAction < 0) continue;
      if (h.invisible) continue;                          // assertspecial invisible
      const alphaS = h.alphaS ?? 256;
      if (alphaS === 0) continue;                         // trans addalpha alpha=0,X
      const frames = h.char?.anims?.get(h.animAction);
      if (!frames?.length) continue;
      const frame = frames[Math.min(h.animFrame, frames.length - 1)];
      if (!frame) continue;
      const sprite = h.char.sprites.get(`${frame.g}_${frame.i}`);
      if (!sprite?.canvas) continue;
      const fh = frame.flipH ? -1 : 1;
      ctx.save();
      if (alphaS < 256) ctx.globalAlpha = alphaS / 256;
      const sx = h.scale[0] * (h.drawScaleX ?? 1);
      const sy = h.scale[1] * (h.drawScaleY ?? 1);
      ctx.translate(h.x + frame.ox * h.facing, h.y + frame.oy);
      if (h.drawAngle) ctx.rotate(h.drawAngle * Math.PI / 180);
      ctx.scale(sx * h.facing * fh, sy);
      ctx.drawImage(sprite.canvas, -sprite.axisX, -sprite.axisY);
      ctx.restore();
    }
  }

  /** Remove explods by id. id=-1 removes all owned by ownerSlot; id=0 removes all. */
  function _removeExplodsById(id, ownerSlot = -1) {
    for (const ex of _explods) {
      if (ex.done) continue;
      if (id < 0)  { if (ownerSlot < 0 || ex.ownerSlot === ownerSlot) ex.done = true; }
      else if (id === 0) { ex.done = true; }
      else         { if (ex.xid === id && (ownerSlot < 0 || ex.ownerSlot === ownerSlot)) ex.done = true; }
    }
  }

  /** Run Helper / Explod controllers from the current attack statedef (called every attack tick). */
  function _runFighterHelpers(f, opp) {
    const stateNum = f.currentMove?.stateNum;
    if (stateNum == null) return;
    const sd = f.char.stateDefs?.get(stateNum);
    if (!sd) return;
    const entity = _fighterControllerEntity(f);
    for (let ci = 0; ci < sd.controllers.length; ci++) {
      _runFighterController(f, opp, sd.controllers[ci], ci, entity);
    }
  }

  function _runFighterController(f, opp, ctrl, ci, entity) {
    const runner = _FIGHTER_CTRL_RUNNERS[ctrl.type];
    if (runner) runner(f, opp, ctrl, ci, entity);
  }

  function _fighterCtrlTriggered(ctrl, entity) {
    return _evalTriggers(ctrl, entity);
  }

  function _runFighterHelperCtrl(f, opp, ctrl, ci, entity) {
    if (f.hFired.has(ci) || !_fighterCtrlTriggered(ctrl, entity)) return;
    _spawnHelper(f, opp, ctrl);
    f.hFired.add(ci);
  }

  function _runFighterExplodCtrl(f, opp, ctrl, ci, entity) {
    if (ctrl.id === 0 && f.hFired.has(ci)) return;
    if (!_fighterCtrlTriggered(ctrl, entity)) return;
    _spawnFighterExplod(f, opp, ctrl);
    if (ctrl.id === 0) f.hFired.add(ci);
  }

  function _spawnFighterExplod(f, opp, ctrl) {
    if (!f.char.anims.has(ctrl.anim)) return;
    const point = _fighterExplodPoint(f, opp, ctrl);
    _spawnExplod(f.char, ctrl.anim, point.x, point.y, f.facing, {
      removetime: ctrl.removetime,
      id: ctrl.id,
      ownerSlot: f.slot,
      bindtime: ctrl.bindtime,
      scale: ctrl.scale,
    });
  }

  function _fighterExplodPoint(f, opp, ctrl) {
    const postype = (ctrl.postype ?? 'p1').toLowerCase();
    if (postype === 'p2' && opp) return { x: opp.x + ctrl.pos[0] * opp.facing, y: opp.y + ctrl.pos[1] };
    if (postype === 'left') return { x: ctrl.pos[0], y: ctrl.pos[1] };
    if (postype === 'right') return { x: STAGE_W + ctrl.pos[0], y: ctrl.pos[1] };
    return { x: f.x + ctrl.pos[0] * f.facing, y: f.y + ctrl.pos[1] };
  }

  function _runFighterRemoveExplodCtrl(f, opp, ctrl, ci, entity) {
    if (_fighterCtrlTriggered(ctrl, entity)) _removeExplodsById(ctrl.id, f.slot);
  }

  function _runFighterPlaySoundCtrl(f, opp, ctrl, ci, entity) {
    if (f.hFired.has(ci) || !_fighterCtrlTriggered(ctrl, entity)) return;
    _playSound(f.char, ctrl.g, ctrl.i, (ctrl.volume ?? 100) / 100 * 0.45);
    f.hFired.add(ci);
  }

  function _runFighterVarCtrl(f, opp, ctrl, ci, entity) {
    if (!_fighterCtrlTriggered(ctrl, entity)) return;
    const isF = ctrl.isFloat || ctrl.type === 'parentfvarset';
    const arr = isF ? f.fvars : f.vars;
    if (!arr || ctrl.idx < 0 || ctrl.idx >= arr.length) return;
    const val = _evalExpr(ctrl.valueExpr ?? String(ctrl.value), entity);
    arr[ctrl.idx] = isF ? val : Math.trunc(val);
  }

  function _runFighterChangeAnimCtrl(f, opp, ctrl, ci, entity) {
    if (!_fighterCtrlTriggered(ctrl, entity)) return;
    const animVal = Math.trunc(_evalExpr(ctrl.valueExpr ?? String(ctrl.value), entity));
    if (!f.char.anims.has(animVal)) return;
    f.animAction = animVal;
    f.animFrame = ctrl.elem > 1 ? ctrl.elem - 1 : 0;
    f.animTimer = 0;
    entity.animAction = animVal;
  }

  const _FIGHTER_CTRL_RUNNERS = {
    helper: _runFighterHelperCtrl,
    explod: _runFighterExplodCtrl,
    removeexplod: _runFighterRemoveExplodCtrl,
    playsnd: _runFighterPlaySoundCtrl,
    varset: _runFighterVarCtrl,
    fvarset: _runFighterVarCtrl,
    parentvarset: _runFighterVarCtrl,
    parentfvarset: _runFighterVarCtrl,
    changeanim: _runFighterChangeAnimCtrl,
    changeanim2: _runFighterChangeAnimCtrl,
  };
  /**
   * Process [State -2] controllers every tick — these always run regardless of fighter state.
   * Used for persistent helpers (e.g. Jotaro's Star Platinum) and always-active logic.
   */
  function _runStateNeg2(f, opp) {
    const sd = f.char.stateDefs?.get(-2);
    if (!sd) return;
    const entity = { stateTime: Math.max(0, f.stateTimer - 1), animFrame: f.animFrame, animTimer: f.animTimer, char: f.char, animAction: f.animAction, vars: f.vars, fvars: f.fvars };
    for (let ci = 0; ci < sd.controllers.length; ci++) {
      const ctrl = sd.controllers[ci];
      if (ctrl.type === 'helper') {
        const id = ctrl.id || 0;
        // Idempotent: each helper ID is only ever spawned ONCE per fighter.
        // Without this guard, helpers that die (destroyself) would re-spawn every tick.
        if (f._spawnedPersistentHelpers.has(id)) continue;
        if (!_evalTriggers(ctrl, entity)) continue;
        _spawnHelper(f, opp, ctrl);
        if (_helpers.length > 0) _helpers[_helpers.length - 1].persistent = true;
        f._spawnedPersistentHelpers.add(id);
      } else if (ctrl.type === 'varset' || ctrl.type === 'fvarset') {
        if (!_evalTriggers(ctrl, entity)) continue;
        const isF = ctrl.isFloat;
        const arr = isF ? f.fvars : f.vars;
        if (arr && ctrl.idx >= 0 && ctrl.idx < arr.length) {
          const val = _evalExpr(ctrl.valueExpr ?? String(ctrl.value), entity);
          arr[ctrl.idx] = isF ? val : Math.trunc(val);
        }
      }
    }
  }

  function _applyHit(atk, def) {
    const hitDef = atk.currentMove?.hitDef;
    if (!hitDef) return;
    const blocked = def.isBlocking;
    const { rawDmg, dmg } = _hitDamage(hitDef, def, blocked);

    if (blocked && rawDmg > 0) def.redLife = Math.min(50, (def.redLife || 0) + dmg);
    atk.hitLanded = true;
    atk.hitstopLeft = Math.round(hitDef.pauseAttacker || 4);
    def.hitstopLeft = Math.round(hitDef.pauseDefender || 8);

    _applyHitVelocity(def, hitDef, blocked);
    _gainAttackPower(atk, def, hitDef);
    _playHitSound(atk.char, hitDef, blocked);
    _rememberHitStance(def);

    if (blocked) {
      if (_tryGuardBreak(atk, def, hitDef, dmg)) return;
      _applyBlockstun(def, hitDef);
    } else {
      if (_tryDizzy(atk, def, hitDef, dmg)) return;
      _applyStandardHitstun(def, hitDef);
    }

    _finishHit(atk, def, hitDef, dmg, blocked);
  }

  function _hitDamage(hitDef, def, blocked) {
    const rawDmg = blocked
      ? (hitDef.guardDamage > 0 ? hitDef.guardDamage : Math.max(1, Math.floor(hitDef.damage * 0.02)))
      : hitDef.damage;
    const lifeMax = def.char.stats.life || 1000;
    return { rawDmg, dmg: Math.max(0, Math.min(99, Math.round(rawDmg / lifeMax * 100))) };
  }

  function _gainAttackPower(atk, def, hitDef) {
    const atkPowMul = atk.char.charConstants?.get('default.attack.lifetopowermul') ?? 0.7;
    const defPowMul = def.char.charConstants?.get('default.gethit.lifetopowermul') ?? 0.6;
    atk.power = Math.min(atk.maxPower, (atk.power || 0) + Math.max(1, Math.round(hitDef.damage * atkPowMul / 100)));
    def.power = Math.min(def.maxPower, (def.power || 0) + Math.max(1, Math.round(hitDef.damage * defPowMul / 100)));
  }

  function _tryGuardBreak(atk, def, hitDef, dmg) {
    if ((hitDef.guardPointsAdd ?? 0) <= 0) return false;
    def.guardPoints = Math.max(0, (def.guardPoints ?? def.maxGuardPoints ?? 1000) - hitDef.guardPointsAdd);
    if (def.guardPoints > 0) return false;
    def.isBlocking = false;
    def.guardPoints = def.maxGuardPoints ?? 1000;
    def.hitstunLeft = Math.max(8, def._hitstunWasAir ? (hitDef.airHitTime || 20) : (hitDef.groundHitTime || 20));
    _transition(def, ST.HITSTUN);
    _screenShakeFrames = 10;
    _screenShakeAmp = 7;
    def.hitFlashFrames = 8;
    _finishHit(atk, def, hitDef, Math.max(1, dmg), false);
    return true;
  }

  function _applyBlockstun(def, hitDef) {
    def.blockstunLeft = Math.max(4, Math.round((hitDef.groundHitTime || 12) * 0.5));
    _transition(def, def._hitstunWasAir ? ST.AIR_GUARD : ST.BLOCKSTUN);
  }

  function _tryDizzy(atk, def, hitDef, dmg) {
    if ((hitDef.dizzyPointsAdd ?? 0) <= 0) return false;
    def.dizzyPoints = Math.max(0, (def.dizzyPoints ?? def.maxDizzyPoints ?? 1000) - hitDef.dizzyPointsAdd);
    if (def.dizzyPoints > 0 || def.stateId === ST.DIZZY) return false;
    def.dizzyPoints = def.maxDizzyPoints ?? 1000;
    _transition(def, ST.DIZZY);
    _screenShakeFrames = 6;
    _screenShakeAmp = 4;
    _finishHit(atk, def, hitDef, dmg, false);
    return true;
  }

  function _applyStandardHitstun(def, hitDef) {
    if (hitDef.fall) {
      def.onGround = false;
      def.vy = Math.min(-3, def.vy - 2) * MUGEN_PX_S;
      _transition(def, ST.FALL);
    } else {
      def.hitstunLeft = Math.max(4, _hitstunTime(def, hitDef));
      _transition(def, ST.HITSTUN);
    }
    _screenShakeFrames = 8;
    _screenShakeAmp = 5;
    def.hitFlashFrames = 6;
  }

  function _hitstunTime(def, hitDef) {
    return def._hitstunWasAir ? (hitDef.airHitTime || hitDef.groundHitTime || 16) : (hitDef.groundHitTime || 16);
  }

  function _finishHit(atk, def, hitDef, dmg, blocked) {
    _spawnHitSpark(atk, def, hitDef, blocked);
    socket.emit('fighting:hit', { roomId: _roomId, targetSlot: def.slot, damage: dmg, blocked, attackerX: atk.x, targetX: def.x });
    atk.comboCount++;
    atk.comboTimer = 90;
  }
  // ── Rendering ────────────────────────────────────────────────────────────

  /** Update camera position to track the midpoint of both fighters, bounded by stage camera. */
  function _updateCamera() {
    if (!_fighters[0] || !_fighters[1] || !_stageData) { _camX = 0; return; }
    const { localcoord, camera } = _stageData;
    const scaleX = STAGE_W / localcoord.w;
    const midX   = (_fighters[0].x + _fighters[1].x) / 2;
    // Convert canvas mid to MUGEN coords, offset from center
    const mugenMid = (midX - STAGE_W / 2) / scaleX;
    _camX = Math.max(camera.boundLeft, Math.min(camera.boundRight, mugenMid));
  }

  function _drawStageBg(ctx, layerno) {
    if (!_stageData) return;
    const metrics = _stageMetrics();
    for (const bg of _stageData.bgs) {
      if (bg.layerno !== layerno) continue;
      _drawStageLayer(ctx, bg, metrics);
    }
  }

  function _stageMetrics() {
    const { localcoord, zoffset, floorCoordH } = _stageData;
    return {
      scaleX: STAGE_W / localcoord.w,
      scaleY: STAGE_H / localcoord.h,
      zoffsetLocal: zoffset * localcoord.h / (floorCoordH || localcoord.h),
    };
  }

  function _drawStageLayer(ctx, bg, metrics) {
    const spr = _stageLayerSprite(bg);
    if (!spr?.canvas) return;
    const geometry = _stageLayerGeometry(bg, spr, metrics);
    if (geometry.drawW <= 0 || geometry.drawH <= 0) return;
    const prev = _applyStageLayerComposite(ctx, bg);
    _clipStageLayer(ctx, bg, metrics);
    _drawStageLayerTiles(ctx, spr, bg, geometry);
    if (bg.window) ctx.restore();
    ctx.globalCompositeOperation = prev.op;
    ctx.globalAlpha = prev.alpha;
  }

  function _stageLayerSprite(bg) {
    const { sprites, anims } = _stageData;
    if (bg.type !== 'anim' || bg.actionno < 0) return sprites.get(bg.spriteno[0] + '_' + bg.spriteno[1]);
    const frames = anims.get(bg.actionno);
    if (!frames?.length) return null;
    const fi = bg._animFrame < frames.length ? bg._animFrame : 0;
    const fr = frames[fi];
    _advanceStageLayerAnim(bg, frames, fi);
    return sprites.get(fr.g + '_' + fr.i);
  }

  function _advanceStageLayerAnim(bg, frames, frameIndex) {
    bg._animTick++;
    if (bg._animTick < (frames[frameIndex]?.ticks ?? 4)) return;
    bg._animTick = 0;
    bg._animFrame = (bg._animFrame + 1) % frames.length;
  }

  function _stageLayerGeometry(bg, spr, metrics) {
    const sw = spr.canvas.width;
    const sh = spr.canvas.height;
    if (!('_velOx' in bg)) { bg._velOx = 0; bg._velOy = 0; }
    bg._velOx = (bg._velOx + bg.velocity[0]) % (sw * metrics.scaleX || 1);
    bg._velOy = (bg._velOy + bg.velocity[1]) % (sh * metrics.scaleY || 1);
    const baseX = STAGE_W / 2 + (bg.start[0] - _camX * bg.delta[0]) * metrics.scaleX;
    const baseY = _floorY + (bg.start[1] - metrics.zoffsetLocal) * metrics.scaleY;
    const drawW = sw * metrics.scaleX;
    const drawH = sh * metrics.scaleY;
    return {
      drawX: baseX + bg._velOx - spr.axisX * metrics.scaleX,
      drawY: baseY + bg._velOy - spr.axisY * metrics.scaleY,
      drawW,
      drawH,
      stepX: Math.max(1, drawW + bg.tilespacing[0] * metrics.scaleX),
      stepY: Math.max(1, drawH + bg.tilespacing[1] * metrics.scaleY),
    };
  }

  function _applyStageLayerComposite(ctx, bg) {
    const prev = { op: ctx.globalCompositeOperation, alpha: ctx.globalAlpha };
    if (bg.trans === 'add' || bg.trans === 'add1') ctx.globalCompositeOperation = 'lighter';
    else if (bg.trans === 'addalpha' && bg.alpha) { ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = bg.alpha[0] / 256; }
    else if (bg.trans === 'sub') ctx.globalCompositeOperation = 'difference';
    return prev;
  }

  function _clipStageLayer(ctx, bg, metrics) {
    if (!bg.window) return;
    ctx.save();
    const wx1 = bg.window[0] * metrics.scaleX;
    const wy1 = bg.window[1] * metrics.scaleY;
    const wx2 = (bg.window[2] + 1) * metrics.scaleX;
    const wy2 = (bg.window[3] + 1) * metrics.scaleY;
    ctx.beginPath(); ctx.rect(wx1, wy1, wx2 - wx1, wy2 - wy1); ctx.clip();
  }

  function _drawStageLayerTiles(ctx, spr, bg, geometry) {
    const tileX = bg.tile[0] !== 0;
    const tileY = bg.tile[1] !== 0;
    if (!tileX && !tileY) {
      ctx.drawImage(spr.canvas, geometry.drawX, geometry.drawY, geometry.drawW, geometry.drawH);
      return;
    }
    const startX = tileX ? geometry.drawX - Math.ceil((geometry.drawX + geometry.drawW) / geometry.stepX) * geometry.stepX : geometry.drawX;
    const startY = tileY ? geometry.drawY - Math.ceil((geometry.drawY + geometry.drawH) / geometry.stepY) * geometry.stepY : geometry.drawY;
    for (let ty = startY; ty < STAGE_H + geometry.drawH; ty += (tileY ? geometry.stepY : STAGE_H + geometry.drawH * 2)) {
      for (let tx = startX; tx < STAGE_W + geometry.drawW; tx += (tileX ? geometry.stepX : STAGE_W + geometry.drawW * 2)) {
        ctx.drawImage(spr.canvas, tx, ty, geometry.drawW, geometry.drawH);
      }
    }
  }
  function _applyScreenShake(ctx) {
    if (_screenShakeFrames <= 0) return false;
    const amp = _screenShakeAmp * (_screenShakeFrames / 8);
    ctx.save();
    ctx.translate(Math.random() * amp * 2 - amp, Math.random() * amp - amp / 2);
    _screenShakeFrames--;
    return true;
  }

  function _drawFightBackdrop(ctx) {
    if (_stageData) {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, STAGE_W, STAGE_H);
      _drawStageBg(ctx, 0);
    } else {
      _drawDefaultBackdrop(ctx);
    }
    _drawFloorLine(ctx);
  }

  function _drawDefaultBackdrop(ctx) {
    ctx.fillStyle = '#0a0a12';
    ctx.fillRect(0, 0, STAGE_W, STAGE_H);
    const grd = ctx.createLinearGradient(0, _floorY - 50, 0, STAGE_H);
    grd.addColorStop(0, 'rgba(30,0,60,0.8)');
    grd.addColorStop(1, 'rgba(60,0,100,0.3)');
    ctx.fillStyle = grd;
    ctx.fillRect(0, _floorY - 50, STAGE_W, STAGE_H - _floorY + 50);
    _drawBackdropGrid(ctx);
  }

  function _drawBackdropGrid(ctx) {
    ctx.strokeStyle = 'rgba(180,100,255,0.12)';
    ctx.lineWidth = 1;
    for (let x = 0; x < STAGE_W; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, STAGE_H); ctx.stroke(); }
    for (let y = 0; y < STAGE_H; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(STAGE_W, y); ctx.stroke(); }
  }

  function _drawFloorLine(ctx) {
    ctx.strokeStyle = _stageData ? 'rgba(0,0,0,0)' : 'rgba(200,150,255,0.5)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, _floorY); ctx.lineTo(STAGE_W, _floorY); ctx.stroke();
  }

  function _drawProjectiles(ctx) {
    for (const p of _projectiles) _drawProjectile(ctx, p);
  }

  function _drawProjectile(ctx, p) {
    const activeId = p.hit ? p.hitAnimId : p.animId;
    const frames = p.char.anims.get(activeId);
    if (!frames?.length) return;
    const frame = frames[Math.min(p.animFrame, frames.length - 1)];
    const sprite = p.char.sprites.get(`${frame.g}_${frame.i}`);
    if (!sprite?.canvas) return;
    const facing = p.hit ? 1 : (p.vx >= 0 ? 1 : -1);
    ctx.save();
    ctx.translate(p.x + frame.ox * facing, p.y + frame.oy);
    ctx.scale((p.char.stats.xscale || 1) * facing, p.char.stats.yscale || 1);
    ctx.drawImage(sprite.canvas, -sprite.axisX, -sprite.axisY);
    ctx.restore();
  }

  function render() {
    if (!_ctx) return;
    const ctx = _ctx;

    // Update camera to track fighter midpoint
    _updateCamera();

    // Screen shake: briefly jitter the canvas on hard hits
    _shakeCtxSaved = _applyScreenShake(ctx);
    _drawFightBackdrop(ctx);

    for (const f of _fighters) if (f) _drawFighter(ctx, f);

    // Draw helpers (sub-entities like Star Platinum) above fighters
    _drawHelpers(ctx);

    // Draw explods (hit sparks and attack FX) above fighters
    _drawExplods(ctx);

    // Draw projectiles
    _drawProjectiles(ctx);


    // Stage foreground layers (layerno=1) drawn over fighters
    _drawStageBg(ctx, 1);

    // Restore canvas transform if screen shake was applied
    if (_shakeCtxSaved) { ctx.restore(); _shakeCtxSaved = false; }

    // Combo counters & dizzy indicators
    for (const f of _fighters) {
      if (!f) continue;
      if (f.comboCount > 1 && f.comboTimer > 0) {
        const alpha = Math.min(1, f.comboTimer / 30);
        const cx = f.slot === 0 ? 90 : STAGE_W - 90;
        const cy = Math.round(STAGE_H * 0.42);
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.font = 'bold 36px monospace';
        ctx.fillStyle = '#ff0';
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 4;
        ctx.textAlign = 'center';
        ctx.strokeText(f.comboCount + ' HIT', cx, cy);
        ctx.fillText  (f.comboCount + ' HIT', cx, cy);
        ctx.restore();
      }
      // Dizzy stars overlay
      if (f.stateId === ST.DIZZY) {
        const dx = f.x;
        const dy = f.y - 60;
        ctx.save();
        ctx.font = '18px serif';
        ctx.textAlign = 'center';
        for (let i = 0; i < 3; i++) {
          const angle = (Date.now() / 300 + i * Math.PI * 2 / 3) % (Math.PI * 2);
          const sx2 = dx + Math.cos(angle) * 20;
          const sy2 = dy + Math.sin(angle) * 8;
          ctx.fillText('★', sx2, sy2);
        }
        ctx.restore();
      }
    }
  }

  function _drawFighter(ctx, f) {
    const frameData = _fighterFrameData(f);
    if (!frameData) return;
    const { frame, sprite } = frameData;
    if (sprite?.canvas) _drawFighterSprite(ctx, f, frame, sprite);
    if (_showHitboxes) _drawFighterHitboxes(ctx, f, frame);
  }

  function _fighterFrameData(f) {
    const frames = f.char.anims.get(f.animAction);
    if (!frames?.length) return null;
    const frame = frames[Math.min(f.animFrame, frames.length - 1)];
    if (!frame) return null;
    return { frame, sprite: f.char.sprites.get(frame.g + '_' + frame.i) };
  }

  function _drawFighterSprite(ctx, f, frame, sprite) {
    const vf = f.visualFacing ?? f.facing;
    const fh = frame.flipH ? -1 : 1;
    ctx.save();
    ctx.translate(f.x + frame.ox * vf, f.y + frame.oy);
    ctx.scale((f.char.stats.xscale || 1) * vf * fh, f.char.stats.yscale || 1);
    _applyFrameBlend(ctx, frame);
    _applyFighterEffects(ctx, f);
    ctx.drawImage(sprite.canvas, -sprite.axisX, -sprite.axisY);
    ctx.filter = 'none';
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.restore();
  }

  function _applyFrameBlend(ctx, frame) {
    if (!frame.blend) return;
    if (frame.blend.type === 'add') ctx.globalCompositeOperation = 'lighter';
    else if (frame.blend.type === 'sub') ctx.globalCompositeOperation = 'difference';
    else if (frame.blend.type === 'alpha') ctx.globalAlpha = Math.max(0, Math.min(1, (frame.blend.src ?? 256) / 256));
  }

  function _applyFighterEffects(ctx, f) {
    if (f.stateId === ST.DIZZY && (f.stateTimer & 3) === 0) ctx.globalAlpha = (ctx.globalAlpha ?? 1) * 0.5;
    if (f.hitFlashFrames <= 0) return;
    const t = f.hitFlashFrames / 6;
    ctx.filter = `brightness(${1 + t * 4}) saturate(${1 - t * 0.8})`;
    f.hitFlashFrames--;
  }

  function _drawFighterHitboxes(ctx, f, frame) {
    _drawClsn(ctx, frame.clsn1, f, CLR_CLSN1);
    _drawClsn(ctx, frame.clsn2, f, CLR_CLSN2);
    ctx.fillStyle = '#fff'; ctx.fillRect(f.x - 2, f.y - 2, 4, 4);
  }
  function _drawClsn(ctx, arr, f, color) {
    ctx.fillStyle = ctx.strokeStyle = color; ctx.lineWidth = 1;
    const vf = f.visualFacing ?? f.facing;
    for (const c of arr) {
      const x1 = vf === 1 ? f.x + c.x1 : f.x - c.x2;
      const x2 = vf === 1 ? f.x + c.x2 : f.x - c.x1;
      ctx.fillRect(x1, f.y + c.y1, x2 - x1, c.y2 - c.y1);
      ctx.strokeRect(x1, f.y + c.y1, x2 - x1, c.y2 - c.y1);
    }
  }

  // ── HUD ──────────────────────────────────────────────────────────────────
  function _updateHud() {
    const byId = id => document.getElementById(id);
    _updateHealthHud(byId);
    _updateRoundHud(byId);
    _updateNameHud(byId);
    _updatePowerHud(byId);
    _updateGuardHud(byId);
    _updateDizzyHud(byId);
  }

  function _updateHealthHud(byId) {
    _updateHealthFill(byId('fg-hp0-fill'), byId('fg-hp0-redlife'), _fighters[0], _health[0]);
    _updateHealthFill(byId('fg-hp1-fill'), byId('fg-hp1-redlife'), _fighters[1], _health[1]);
  }

  function _updateHealthFill(fill, redLife, fighter, health) {
    if (!fill) return;
    fill.style.width = health + '%';
    fill.style.background = health < 25 ? '#f00' : '';
    if (redLife && fighter) {
      redLife.style.width = Math.min(health, fighter.redLife || 0) + '%';
      redLife.style.right = '0';
    }
  }

  function _updateRoundHud(byId) {
    const tmr = byId('fg-timer');
    if (tmr) { tmr.textContent = Math.ceil(_timer); tmr.classList.toggle('fg-timer-warn', _timer <= 10); }
    _updateWins(byId('fg-wins0'), _wins[0]);
    _updateWins(byId('fg-wins1'), _wins[1]);
  }

  function _updateWins(el, wins) {
    if (el) el.textContent = String.fromCharCode(9679).repeat(wins) + String.fromCharCode(9675).repeat(Math.max(0, MAX_WINS - 1 - wins));
  }

  function _updateNameHud(byId) {
    _updateFighterName(byId('fg-p1name'), _fighters[0], _playerColors[0], _playerPseudos[0]);
    _updateFighterName(byId('fg-p2name'), _fighters[1], _playerColors[1], _playerPseudos[1]);
  }

  function _updateFighterName(el, fighter, color, pseudo) {
    if (!el || !fighter) return;
    const name = fighter.char.lifebarname || fighter.char.name || '';
    // The character name comes from uploaded MUGEN files: text only.
    const character = document.createElement('small');
    character.textContent = name;
    el.replaceChildren(renderUserName({ pseudo, color }, { fallbackPseudo: '?' }), document.createElement('br'), character);
  }

  function _updatePowerHud(byId) {
    _updatePowerFill(byId('fg-pw0-fill'), _fighters[0]);
    _updatePowerFill(byId('fg-pw1-fill'), _fighters[1]);
  }

  function _updatePowerFill(fill, fighter) {
    if (!fill || !fighter) return;
    const pct = Math.round(fighter.power / (fighter.maxPower || 3000) * 100);
    fill.style.width = pct + '%';
    fill.classList.toggle('fg-pwbar-full', fighter.power >= fighter.maxPower);
  }

  function _updateGuardHud(byId) {
    _updateGuardFill(byId('fg-gp0-fill'), _fighters[0]);
    _updateGuardFill(byId('fg-gp1-fill'), _fighters[1]);
  }

  function _updateGuardFill(fill, fighter) {
    if (!fill || !fighter) return;
    const gpct = Math.round((fighter.guardPoints ?? fighter.maxGuardPoints ?? 1000) / (fighter.maxGuardPoints || 1000) * 100);
    fill.style.width = gpct + '%';
  }

  function _updateDizzyHud(byId) {
    const diz0 = byId('fg-dizzy0');
    const diz1 = byId('fg-dizzy1');
    if (diz0) diz0.style.display = (_fighters[0]?.stateId === ST.DIZZY) ? 'block' : 'none';
    if (diz1) diz1.style.display = (_fighters[1]?.stateId === ST.DIZZY) ? 'block' : 'none';
  }
  function _showOverlay(text, sub, frames = 120) {
    const el = document.getElementById('fg-overlay');
    if (!el) return;
    el.innerHTML = '<div class="fg-overlay-text">' + text + '</div>' + (sub ? '<div class="fg-overlay-sub">' + sub + '</div>' : '');
    el.style.opacity = '1';
    scope.clearTimeout(el._t);
    el._t = scope.timeout(() => { if (el) el.style.opacity = '0'; }, frames * 16);
  }

  // ── Game loop ────────────────────────────────────────────────────────────
  function startLoop() {
    if (_raf) return;
    _lastTs = performance.now();
    _accumulator = 0;
    const TICK = 1 / 60;
    const loop = (ts) => {
      _raf = scope.frame(loop);
      _runFightFrame(ts, TICK);
    };
    _raf = scope.frame(loop);
  }

  function _runFightFrame(ts, tick) {
    if (_stage !== 'fight') return;
    const dt = Math.min((ts - _lastTs) / 1000, 1 / 30);
    _lastTs = ts;
    const inp = _getInputSnapshot();
    const myF = _fighters[_mySlot];
    const oppF = _fighters[_mySlot === 0 ? 1 : 0];
    _advanceFightTicks(inp, myF, oppF, dt, tick);
    _sendFightInput(ts, inp, myF);
    render();
    _updateHud();
  }

  function _advanceFightTicks(inp, myF, oppF, dt, tick) {
    _accumulator += dt;
    const ticks = Math.min(Math.floor(_accumulator / tick), 4);
    if (ticks <= 0) return;
    _accumulator -= ticks * tick;
    _keyPressedThisFrame.clear();
    _localInputBuf.push({ dirs: new Set(inp.dirs), btns: new Set(inp.btns), frame: _globalFrame++ });
    if (_localInputBuf.length > 120) _localInputBuf.shift();
    for (let t = 0; t < ticks; t++) _runFightTick(t, myF, oppF, inp, tick);
  }

  function _runFightTick(t, myF, oppF, inp, tick) {
    tickFighter(myF, oppF, inp, tick);
    _tickRemoteFighter(t, oppF, myF, tick);
    checkHits(myF, oppF);
    checkHits(oppF, myF);
    _tickFightSystems(tick);
    _tickRoundClock(tick);
    _tickPoseTimer();
    _tickComboTimers(_fighters);
  }

  function _tickRemoteFighter(t, oppF, myF, tick) {
    if (!oppF) return;
    const remBtns = t === 0
      ? new Set([...(oppF._lastBtns || []), ...(oppF._pendingBtns ?? [])])
      : new Set(oppF._lastBtns || []);
    tickFighter(oppF, myF, { dirs: new Set(oppF._lastDirs || []), btns: remBtns }, tick);
    if (t === 0) oppF._pendingBtns = new Set();
  }

  function _tickFightSystems(tick) {
    _tickProjectiles(tick);
    _checkProjectileHits();
    _updateExplods();
    _tickHelpers(tick);
  }

  function _tickRoundClock(tick) {
    if (_roundStarting || _poseTimer !== 0) return;
    _timerMs += tick * 1000;
    if (_timerMs >= 1000) { _timerMs -= 1000; _timer = Math.max(0, _timer - 1); }
  }

  function _tickPoseTimer() {
    if (_poseTimer <= 0) return;
    _poseTimer--;
    if (_poseTimer !== 0 || !_pendingRoundResult) return;
    const r = _pendingRoundResult;
    _pendingRoundResult = null;
    if (r.type === 'next_round') _doNextRound(r.data);
    else if (r.type === 'game_over') _doGameOver(r.data);
  }

  function _tickComboTimers(fighters) {
    for (const f of fighters) if (f?.comboTimer > 0 && --f.comboTimer === 0) f.comboCount = 0;
  }

  function _sendFightInput(ts, inp, myF) {
    if (ts - _lastSendTs < SEND_INTERVAL || !myF || !_roomId) return;
    _lastSendTs = ts;
    const outBtns = new Set([...inp.btns, ..._pendingOutBtns]);
    _pendingOutBtns.clear();
    socket.emit('fighting:input', { roomId: _roomId, input: { dirs: [...inp.dirs], btns: [...outBtns], x: myF.x, y: myF.y } });
  }
  function stopLoop() {
    if (_raf) { scope.cancelFrame(_raf); _raf = null; }
    _explods = [];
    _helpers = [];
    _stopBgm();
    // Reset HUD chrome offset when leaving fight screen
    const _wmWin = document.getElementById('fighting-body')?.closest('.wm-win');
    if (_wmWin && _wmWin.dataset.aspectExtra) {
      _wmWin.dataset.aspectExtra = '0';
      _wmWin._enforceAspect?.();
    }
  }

  // ── Socket events ────────────────────────────────────────────────────────
  socket.on('fighting:rooms', ({ rooms, liveRooms }) => {
    _openRooms = rooms     ?? [];
    _liveRooms = liveRooms ?? [];
    if (_stage === 'lobby') renderRoomLists();
  });

  socket.on('fighting:open', (room) => {
    if (!_openRooms.find(r => r.id === room.id)) _openRooms.push(room);
    if (_stage === 'lobby') renderRoomLists();
  });

  socket.on('fighting:closed', ({ roomId }) => {
    _openRooms = _openRooms.filter(r => r.id !== roomId);
    if (_stage === 'lobby') renderRoomLists();
  });

  socket.on('fighting:live_open', (room) => {
    if (!_liveRooms.find(r => r.id === room.id)) _liveRooms.push(room);
    if (_stage === 'lobby') renderRoomLists();
  });

  socket.on('fighting:live_closed', ({ roomId }) => {
    _liveRooms = _liveRooms.filter(r => r.id !== roomId);
    if (_stage === 'lobby') renderRoomLists();
  });

  socket.on('fighting:created', ({ roomId, room }) => {
    _roomId = roomId; _mySlot = 0;
    showRoomLobby(roomId, 0, room?.players ?? []);
  });

  socket.on('fighting:joined', ({ roomId, slot, players, bet }) => {
    _roomId = roomId; _mySlot = slot;
    if (bet !== undefined) _betAmount = bet;
    showRoomLobby(roomId, slot, players);
  });

  socket.on('fighting:char_picked', ({ slot, char, defFile }) => {
    if (_stage !== 'room_lobby') return;
    const isMe = slot === _mySlot;
    const side = isMe ? 'my' : 'opp';
    _previewRLChar(side, char, defFile);
    const charName = _chars.find(c => c.folder === char)?.name || char;
    const statusEl = document.getElementById(`fg-rl-${side}-status`);
    if (statusEl) statusEl.textContent = charName;
    // Highlight the tile in the shared charlist with that player's color
    const list = document.getElementById('fg-rl-charlist');
    if (list) {
      const color = _playerColors[slot] || (slot === 0 ? '#33ff88' : '#44aaff');
      list.querySelectorAll('[data-sel-slot]').forEach(t => {
        if (t.getAttribute('data-sel-slot') === String(slot)) {
          t.removeAttribute('data-sel-slot');
          t.style.borderColor = '';
          t.style.background  = '';
        }
      });
      const tile = list.querySelector(`[data-folder="${char}"]`);
      if (tile) {
        tile.setAttribute('data-sel-slot', slot);
        tile.style.borderColor = color;
        tile.style.background  = `color-mix(in srgb, ${color} 20%, #0d0d1a)`;
      }
    }
  });

  socket.on('fighting:cancelled', () => {
    renderLobby();
  });

  function _resetFightStartState({ roomId, slot, health, round, wins }) {
    _roomId = roomId; _mySlot = slot;
    _health = [...health]; _round = round; _wins = [...wins];
    _timer = ROUND_SEC; _timerMs = 0;
    _stageData = null; _camX = 0; _floorY = FLOOR_Y_DEFAULT;
  }

  function _assignFightPlayers(players, slot) {
    const oppSlot = slot === 0 ? 1 : 0;
    const myPlayer  = players[slot];
    const oppPlayer = players[oppSlot];
    _playerPseudos[slot]   = myPlayer?.pseudo  ?? '?';
    _playerPseudos[oppSlot] = oppPlayer?.pseudo ?? '?';
    _playerColors[slot]    = myPlayer?.color   || (slot === 0 ? '#33ff88' : '#44aaff');
    _playerColors[oppSlot] = oppPlayer?.color  || (slot === 0 ? '#44aaff' : '#33ff88');
    if (!myPlayer?.char || !oppPlayer?.char) return null;
    return { myPlayer, oppPlayer };
  }

  async function _loadFightMatchup({ myPlayer, oppPlayer }, slot) {
    try {
      const [my, opp] = await Promise.all([
        loadMugenChar(myPlayer.char,  (key, pct) => setLoadProgress('P' + (slot + 1) + ': ' + t(key), pct * 0.5),  myPlayer.defFile  || null),
        loadMugenChar(oppPlayer.char, (key, pct) => setLoadProgress('P' + (slot === 0 ? 2 : 1) + ': ' + t(key), 50 + pct * 0.5), oppPlayer.defFile || null),
      ]);
      if (!scope.active) return false;
      const chars = slot === 0 ? [my, opp] : [opp, my];
      _fighters[0] = makeFighter(0, chars[0]);
      _fighters[1] = makeFighter(1, chars[1]);
      return true;
    } catch (err) {
      if (!scope.active) return false;
      console.warn('[fighting] failed to load fight resources:', err);
      root.innerHTML = `<div class="fg-error">${t('games.fighting.loadFailed')}</div>`;
      return false;
    }
  }

  function _loadFightStage(stage) {
    if (!stage?.folder || !stage?.defFile) return;
    loadStage(stage.folder, stage.defFile, stage.sffFile || null)
      .then(_applyLoadedFightStage)
      .catch(() => {}); // non-fatal
  }

  function _applyLoadedFightStage(s) {
    if (!scope.active) return;
    _stageData = s;
    _floorY = _stageFloorY(s);
    _repositionFightersOnStage(s);
    _playBgm(s.bgMusicUrl);
  }

  function _stageFloorY(s) {
    const denom = s.floorCoordH || s.localcoord?.h || 0;
    const computed = (s.localcoord && denom > 0) ? Math.round(STAGE_H * s.zoffset / denom) : FLOOR_Y_DEFAULT;
    return (Number.isFinite(computed) && computed > 0) ? computed : FLOOR_Y_DEFAULT;
  }

  function _repositionFightersOnStage(s) {
    if (!_fighters[0] || !_fighters[1]) return;
    _fighters[0].y = _fighters[1].y = _floorY;
    if (s.p1startx == null) return;
    const csx = STAGE_W / s.localcoord.w;
    _fighters[0].x = STAGE_W / 2 + s.p1startx * csx;
    _fighters[1].x = STAGE_W / 2 + s.p2startx * csx;
  }

  function _signalFightReady(roomId) {
    _localInputBuf = []; _globalFrame = 0;
    socket.emit('fighting:ready', { roomId });
    setLoadProgress(t('games.fighting.waitingForOpponent'), 100);
  }
  socket.on('fighting:start', async (data) => {
    _resetFightStartState(data);
    const matchup = _assignFightPlayers(data.players, data.slot);
    if (!matchup) return;
    showLoading(t('games.fighting.loadingFighters'));
    if (!await _loadFightMatchup(matchup, data.slot)) return;
    _loadFightStage(data.stage);
    _signalFightReady(data.roomId);
  });

  socket.on('fighting:begin', () => {
    // Freeze timer — will be unfrozen after the overlay fades
    _roundStarting = true;
    if (_stage === 'loading') {
      showFight();
    } else if (_stage !== 'fight') return;
    _showOverlay(t('games.fighting.round', { round: _round }), t('games.fighting.fight'));
    // Play intro poses for both fighters
    if (_fighters[0]) _transition(_fighters[0], ST.INTRO);
    if (_fighters[1]) _transition(_fighters[1], ST.INTRO);
    // Unfreeze timer after overlay animation (120 frames × 16 ms + small margin)
    scope.timeout(() => { _roundStarting = false; }, 120 * 16 + 200);
    // Resume audio context if needed
    resumeSndCtx?.(); // resumes the shared snd-parser context
  });

  socket.on('fighting:input', ({ slot, input }) => {
    const f = _fighters[slot];
    if (!f) return;
    f._lastDirs = input.dirs ?? [];
    // 'block' is a held state — persist like dirs so opponent keeps showing guard anim
    // Attack buttons (j/k/i/u/...) are one-shot — apply once per received packet
    const btns = input.btns ?? [];
    f._lastBtns = btns.filter(b => b === 'block');
    const attacks = btns.filter(b => b !== 'block');
    if (attacks.length) f._pendingBtns = new Set(attacks);
    if (typeof input.x === 'number') f.x = f.x * 0.7 + input.x * 0.3;
    // Correct Y only on large drift to avoid jitter (e.g. jump desync)
    if (typeof input.y === 'number' && Math.abs(f.y - input.y) > 60) f.y = f.y * 0.5 + Math.min(input.y, _floorY) * 0.5;
  });

  socket.on('fighting:health', ({ health }) => {
    _health = [...health];
    if (_health[0] <= 0 || _health[1] <= 0) {
      const loserSlot = _health[0] <= 0 ? 0 : 1;
      if (_poseTimer === 0 && _fighters.some(f => f)) _startPose(loserSlot);
    }
  });

  function _startPose(loserSlot) {
    _poseTimer = 180;
    _projectiles.length = 0;
    _helpers.length = 0;
    if (loserSlot < 0) return;
    const loser  = _fighters[loserSlot];
    const winner = _fighters[loserSlot === 0 ? 1 : 0];
    if (loser)  _transition(loser,  ST.LOSE);
    if (winner) _transition(winner, ST.WIN);
  }

  function _doNextRound({ round, wins }) {
    _round = round; _wins = [...wins]; _timer = ROUND_SEC; _timerMs = 0;
    _poseTimer = 0; _pendingRoundResult = null; _projectiles.length = 0; _helpers.length = 0;
    if (_fighters[0]) { _fighters[0].x = STAGE_W * 0.3; _fighters[0].y = _floorY; _fighters[0].power = 0; }
    if (_fighters[1]) { _fighters[1].x = STAGE_W * 0.7; _fighters[1].y = _floorY; _fighters[1].power = 0; }
    _health = [100, 100];
    _roundStarting = true; // freeze timer — unfreezes when fighting:begin fires
    _updateHud();
    _showOverlay(t('games.fighting.round', { round }), ''); // immediate feedback while waiting for both ready
    socket.emit('fighting:ready', { roomId: _roomId });
  }

  function _doGameOver(data) {
    const me = getMe();
    _showOverlay(t(data.winner?.accountId === me?.accountId ? 'games.fighting.victory' : 'games.fighting.defeat'), '', 180);
    scope.timeout(() => showResult(data), 3000);
  }

  socket.on('fighting:next_round', ({ round, wins }) => {
    if (_poseTimer > 0 || _fighters.some(f => f && [ST.WIN, ST.LOSE].includes(f.stateId))) {
      _pendingRoundResult = { type: 'next_round', data: { round, wins } };
      return;
    }
    _doNextRound({ round, wins });
  });

  socket.on('fighting:game_over', (data) => {
    if (_poseTimer > 0) {
      _pendingRoundResult = { type: 'game_over', data };
      return;
    }
    _doGameOver(data);
  });

  socket.on('fighting:forfeit', () => {
    _showOverlay(t('games.fighting.opponentForfeited'), '', 150);
    scope.timeout(() => renderLobby(), 2500);
  });

  socket.on('fighting:spectate_start', async ({ roomId, players, health, round, wins }) => {
    _roomId = roomId; _mySlot = -1;
    _health = [...health]; _round = round; _wins = [...wins];
    _timer = ROUND_SEC; _timerMs = 0;
    _playerPseudos[0] = players[0]?.pseudo ?? '?';
    _playerPseudos[1] = players[1]?.pseudo ?? '?';
    _playerColors[0]  = players[0]?.color  || '#33ff88';
    _playerColors[1]  = players[1]?.color  || '#44aaff';
    showLoading(t('games.fighting.loadingSpectator'));
    try {
      const [c0, c1] = await Promise.all([
        loadMugenChar(players[0]?.char, null, players[0]?.defFile || null),
        loadMugenChar(players[1]?.char, null, players[1]?.defFile || null),
      ]);
      if (!scope.active) return;
      _fighters[0] = makeFighter(0, c0);
      _fighters[1] = makeFighter(1, c1);
    } catch { return; }
    showFight();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SANDBOX (SHITPOST) MODE
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Sandbox state ─────────────────────────────────────────────────────────
  let _sbActive          = false;
  let _sbFighters        = new Map();   // slot → fighter object
  let _sbMySlot          = -1;
  let _sbCount           = 0;           // live count shown in lobby / HUD
  let _sbRaf             = null;
  let _sbLastTs          = 0;
  let _sbAccumulator     = 0;
  let _sbPaused          = false;       // freeze physics while loading a new player
  let _sbCanvas          = null;
  let _sbCtx             = null;
  let _sbLastSendTs      = 0;
  let _sbPseudos         = new Map();   // slot → pseudo string
  let _sbColors          = new Map();   // slot → color string

  // ── Sandbox helpers ────────────────────────────────────────────────────────

  function _sbStopLoop() {
    if (_sbRaf) { scope.cancelFrame(_sbRaf); _sbRaf = null; }
    _sbActive   = false;
    _sbFighters.clear();
    _sbMySlot   = -1;
    _sbCanvas   = null;
    _sbCtx      = null;
    _sbPseudos.clear();
    _sbColors.clear();
    _explods.length     = 0;
    _projectiles.length = 0;
    _helpers.length     = 0;
    _stopBgm();
    _floorY = FLOOR_Y_DEFAULT;
    _stageData = null;
  }

  function _sbMakeFighter(slot, char) {
    const x = STAGE_W * 0.2 + (slot % 7) * (STAGE_W * 0.1);
    return {
      slot, char,
      x: Math.min(STAGE_W * 0.8, Math.max(STAGE_W * 0.2, x)),
      y: _floorY,
      vx: 0, vy: 0,
      facing: 1, visualFacing: 1,
      onGround: true,
      stateId: ST.IDLE, stateTimer: 0,
      animAction: ANIM.IDLE, animFrame: 0, animTimer: 0,
      isBlocking: false,
      hitstunLeft: 0, blockstunLeft: 0,
      hitLanded: false, currentMove: null, hitstopLeft: 0,
      comboCount: 0, comboTimer: 0,
      hitFlashFrames: 0,
      power: 0, maxPower: char.stats.maxPower ?? 3000,
      projSpawned: false, hFired: new Set(),
      _lastDirs: [], _lastBtns: [], _pendingBtns: new Set(),
      _spawnedPersistentHelpers: new Set(),
      vars:  new Int32Array(60),
      fvars: new Float32Array(40),
    };
  }

  /** Returns the nearest other sandbox fighter to `f`, or null. */
  function _sbNearestOpp(f) {
    let nearest = null, minDist = Infinity;
    for (const [slot, other] of _sbFighters) {
      if (slot === f.slot) continue;
      const d = Math.abs(other.x - f.x);
      if (d < minDist) { minDist = d; nearest = other; }
    }
    return nearest;
  }

  /** Run hit detection only for the LOCAL player's fighter (attacker side). */
  function _sbDetectHits() {
    const myF = _sbFighters.get(_sbMySlot);
    if (!myF) return;
    for (const [slot, def] of _sbFighters) {
      if (slot === _sbMySlot) continue;
      _sbCheckOnePair(myF, def);
    }
  }

  function _sbCheckOnePair(atk, def) {
    if (!atk || !def) return;
    if (atk.stateId !== ST.ATTACK || atk.hitLanded) return;
    if ([ST.HITSTUN, ST.BLOCKSTUN, ST.WIN, ST.LOSE, ST.INTRO].includes(def.stateId)) return;
    const frames = atk.char.anims.get(atk.animAction);
    if (!frames) return;
    const frame = frames[atk.animFrame];
    const s = atk.char.stats;
    const rawClsn1 = frame?.clsn1?.length
      ? frame.clsn1
      : [{ x1: 10, y1: -(s.height * 0.8), x2: (s.groundFront || 30) + 40, y2: -(s.height * 0.15) }];
    const c1 = _worldClsn(rawClsn1, atk);
    const c2 = _worldClsn(_hurtbox(def), def);
    for (const a of c1) for (const d of c2) {
      if (a.x1 < d.x2 && a.x2 > d.x1 && a.y1 < d.y2 && a.y2 > d.y1) {
        _sbApplyHit(atk, def); return;
      }
    }
  }

  function _sbApplyHit(atk, def) {
    const hitDef = atk.currentMove?.hitDef;
    if (!hitDef) return;
    const blocked = def.isBlocking;
    atk.hitLanded = true;
    atk.hitstopLeft = Math.round(hitDef.pauseAttacker || 4);
    def.hitstopLeft = Math.round(hitDef.pauseDefender || 8);
    _applyHitVelocity(def, hitDef, blocked);
    _gainProjectilePower(atk.slot, def);
    _playHitSound(atk.char, hitDef, blocked);
    _rememberHitStance(def);
    _transitionSandboxDefender(def, hitDef, blocked);
    _spawnHitSpark(atk, def, hitDef, blocked);
    atk.comboCount++;
    atk.comboTimer = 90;
    socket.emit('sandbox:hit', { targetSlot: def.slot, attackerX: atk.x, targetX: def.x });
  }

  function _transitionSandboxDefender(def, hitDef, blocked) {
    if (blocked) {
      def.blockstunLeft = Math.max(4, Math.round((hitDef.groundHitTime || 12) * 0.5));
      _transition(def, ST.BLOCKSTUN);
      return;
    }
    def.hitstunLeft = Math.max(4, _hitstunTime(def, hitDef));
    _transition(def, ST.HITSTUN);
    _screenShakeFrames = 8;
    _screenShakeAmp = 5;
    def.hitFlashFrames = 6;
  }
  /** Update camera to track centroid of all sandbox fighters. */
  function _sbUpdateCamera() {
    if (_sbFighters.size === 0 || !_stageData) { _camX = 0; return; }
    const { localcoord, camera } = _stageData;
    const scaleX = STAGE_W / localcoord.w;
    let sumX = 0;
    for (const f of _sbFighters.values()) sumX += f.x;
    const midX    = sumX / _sbFighters.size;
    const mugenMid = (midX - STAGE_W / 2) / scaleX;
    _camX = Math.max(camera.boundLeft, Math.min(camera.boundRight, mugenMid));
  }

  function _sbRender() {
    const ctx = _sbCtx;
    if (!ctx) return;

    const shakeSaved = _applyScreenShake(ctx);
    _drawFightBackdrop(ctx);

    for (const f of _sbFighters.values()) _drawFighter(ctx, f);
    _drawHelpers(ctx);
    _drawExplods(ctx);

    _drawProjectiles(ctx);


    if (_stageData) _drawStageBg(ctx, 1);
    if (shakeSaved) ctx.restore();

    // Combo counters
    let ci = 0;
    for (const f of _sbFighters.values()) {
      if (f.comboCount > 1 && f.comboTimer > 0) {
        ctx.globalAlpha = Math.min(1, f.comboTimer / 30);
        ctx.font = 'bold 20px monospace'; ctx.fillStyle = '#fff'; ctx.textAlign = 'center';
        ctx.fillText(f.comboCount + ' HIT', 70 + (ci % 5) * 140, 280 + Math.floor(ci / 5) * 25);
        ctx.globalAlpha = 1;
      }
      ci++;
    }

    // Pseudo tags below each fighter
    for (const [slot, f] of _sbFighters) {
      const pseudo = _sbPseudos.get(slot) ?? '?';
      const color  = _sbColors.get(slot)  || '#ffffff';
      const px = f.x;
      const py = f.y + 14;   // just below the feet
      ctx.save();
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'center';
      const tw = ctx.measureText(pseudo).width;
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      ctx.fillRect(px - tw / 2 - 5, py - 1, tw + 10, 16);
      ctx.fillStyle = color;
      ctx.fillText(pseudo, px, py + 11);
      ctx.restore();
    }
  }

  function _sbStartLoop() {
    if (_sbRaf) return;
    _sbLastTs = performance.now();
    _sbAccumulator = 0;
    const TICK = 1 / 60;
    const loop = (ts) => {
      _sbRaf = scope.frame(loop);
      _runSandboxFrame(ts, TICK);
    };
    _sbRaf = scope.frame(loop);
  }

  function _runSandboxFrame(ts, tick) {
    if (!_sbActive) return;
    const dt = Math.min((ts - _sbLastTs) / 1000, 1 / 30);
    _sbLastTs = ts;
    if (!_sbPaused) {
      const inp = _getInputSnapshot();
      _advanceSandboxTicks(inp, dt, tick);
      _sendSandboxInput(ts, inp);
    } else {
      _keyPressedThisFrame.clear();
    }
    _sbUpdateCamera();
    _sbRender();
    _tickComboTimers(_sbFighters.values());
  }

  function _advanceSandboxTicks(inp, dt, tick) {
    _sbAccumulator += dt;
    const ticks = Math.min(Math.floor(_sbAccumulator / tick), 4);
    if (ticks <= 0) return;
    _sbAccumulator -= ticks * tick;
    _keyPressedThisFrame.clear();
    for (let t = 0; t < ticks; t++) _runSandboxTick(t, inp, tick);
  }

  function _runSandboxTick(t, inp, tick) {
    for (const [slot, f] of _sbFighters) {
      tickFighter(f, _sbNearestOpp(f), _sandboxFighterInput(slot, f, t, inp), tick);
    }
    _sbDetectHits();
    _tickFightSystems(tick);
  }

  function _sandboxFighterInput(slot, f, t, inp) {
    if (slot === _sbMySlot) return { dirs: new Set(inp.dirs), btns: t === 0 ? new Set(inp.btns) : new Set() };
    const btns = t === 0
      ? new Set([...(f._lastBtns || []), ...(f._pendingBtns ?? [])])
      : new Set(f._lastBtns || []);
    if (t === 0) f._pendingBtns = new Set();
    return { dirs: new Set(f._lastDirs || []), btns };
  }

  function _sendSandboxInput(ts, inp) {
    if (ts - _sbLastSendTs < SEND_INTERVAL) return;
    _sbLastSendTs = ts;
    const myF = _sbFighters.get(_sbMySlot);
    if (!myF) return;
    const outBtns = new Set([...inp.btns, ..._pendingOutBtns]);
    _pendingOutBtns.clear();
    const sbAssert = _pendingSbAssertCmd;
    _pendingSbAssertCmd = null;
    const sbAssertPose = _pendingSbAssertPose;
    _pendingSbAssertPose = null;
    socket.emit('sandbox:input', {
      input: { dirs: [...inp.dirs], btns: [...outBtns] },
      x: myF.x, y: myF.y,
      stateId: String(myF.stateId),
      ...(sbAssert ? { assertedCmd: sbAssert } : {}),
      ...(sbAssertPose ? { assertedPose: sbAssertPose } : {}),
    });
  }
  // ── Sandbox screens ────────────────────────────────────────────────────────

  function showSandbox() {
    stopLoop();
    _sbStopLoop();
    _stage = 'sandbox_select';
    root.innerHTML = `
      <div class="fg-sb-select">
        <h2>${t('games.fighting.sandboxTitle')}</h2>
        <p class="fg-sb-select-count"><span id="fg-sb-sel-count">${_sbCount}</span> ${t('games.fighting.playersOnline')}</p>
        <div style="display:flex;gap:16px;flex:1;min-height:0;overflow:hidden">
          <div class="fg-charsel-preview" style="flex-shrink:0">
            <canvas id="fg-sb-prev" width="200" height="200"></canvas>
            <div id="fg-sb-prev-name" class="fg-charname"></div>
          </div>
          <div id="fg-sb-charlist" class="fg-charlist" style="flex:1"></div>
        </div>
        <div class="fg-sb-select-btns">
          <button class="fg-btn fg-btn-ready" id="fg-sb-join-btn" disabled>${t('games.fighting.joinChaos')}</button>
          <button class="fg-btn fg-btn-back" id="fg-sb-back-btn">${t('games.fighting.back')}</button>
        </div>
      </div>`;

    document.getElementById('fg-sb-back-btn').onclick = () => renderLobby();
    document.getElementById('fg-sb-join-btn').onclick = () => {
      if (!_pickedChar) return;
      resumeSndCtx?.(); // resume AudioContext on user gesture before joining
      socket.emit('sandbox:join', { char: _pickedChar, defFile: _pickedDefFile });
    };

    scope.fetch('/api/mugen/chars').then(r => r.json()).then(chars => {
      if (!scope.active) return;
      _chars = chars;
      const list = document.getElementById('fg-sb-charlist');
      if (!list) return;
      list.innerHTML = chars.map(c => `
        <div class="fg-char-tile" data-folder="${c.folder}" data-deffile="${c.defFile || ''}">
          <canvas class="fg-char-tile-portrait" width="100" height="108"></canvas>
          <div class="fg-char-tile-name">${c.name}</div>
        </div>`).join('');
      _loadTilePortraits(list);
      list.querySelectorAll('.fg-char-tile').forEach(tile => {
        tile.onclick = async () => {
          list.querySelectorAll('.fg-char-tile').forEach(t => t.classList.remove('selected'));
          tile.classList.add('selected');
          _pickedChar    = tile.dataset.folder;
          _pickedDefFile = tile.dataset.deffile || null;
          document.getElementById('fg-sb-prev-name').textContent = tile.querySelector('.fg-char-tile-name').textContent;
          document.getElementById('fg-sb-join-btn').removeAttribute('disabled');
          const cvs = document.getElementById('fg-sb-prev');
          if (cvs) {
            const ctx = cvs.getContext('2d');
            ctx.fillStyle = '#111'; ctx.fillRect(0, 0, 200, 200);
            try {
              const res = await loadCharPreview(_pickedChar, _pickedDefFile || null);
              if (!scope.active || !res?.sprite) return;
              ctx.clearRect(0, 0, 200, 200); ctx.fillStyle = '#111'; ctx.fillRect(0, 0, 200, 200);
              _drawSpritePreview(ctx, res.sprite, 200, 200, res.portraitscale ?? 1);
            } catch { /* a missing preview keeps the placeholder */ }
          }
        };
      });
    }).catch(() => {
      if (!scope.active) return;
      const list = document.getElementById('fg-sb-charlist');
      if (list) list.textContent = t('games.fighting.charactersLoadFailed');
    });
  }

  function showSandboxFight() {
    _stage = 'sandbox_fight';
    root.innerHTML = `
      <div class="fg-sb-wrap">
        <div class="fg-sb-hud">
          <div class="fg-sb-hud-left">
            <button class="fg-sb-btn" id="fg-sb-char-btn">${t('games.fighting.characterButton')}</button>
            <button class="fg-sb-btn" id="fg-sb-map-btn">${t('games.fighting.stageButton')}</button>
          </div>
          <div class="fg-sb-hud-center">
            <span class="fg-sb-count-txt" id="fg-sb-count">${t('games.fighting.playerCount', { count: _sbCount })}</span>
          </div>
          <div class="fg-sb-hud-right">
            <button class="fg-sb-btn fg-sb-btn-quit" id="fg-sb-quit-btn">${t('games.fighting.quit')}</button>
          </div>
        </div>
        <div class="fg-canvas-wrap">
          <canvas id="fg-sb-canvas" width="${STAGE_W}" height="${STAGE_H}"></canvas>
          <div id="fg-sb-overlay" style="display:none;position:absolute;inset:0;z-index:10;background:rgba(8,4,20,0.88);justify-content:center;align-items:center;flex-direction:column;overflow:auto"></div>
          <div class="fg-movelist" id="fg-movelist" style="display:none"></div>
        </div>
        <div class="fg-hint">${t('games.fighting.controlsHintShort', { moveKeys: _moveHintKeys() })}</div>
      </div>`;
    _sbCanvas = document.getElementById('fg-sb-canvas');
    _sbCtx    = _sbCanvas.getContext('2d');
    document.getElementById('fg-sb-char-btn').onclick  = () => _sbShowChangeChar();
    document.getElementById('fg-sb-map-btn').onclick   = () => _sbShowChangeStage();
    document.getElementById('fg-sb-quit-btn').onclick  = () => {
      socket.emit('sandbox:leave');
      _sbStopLoop();
      renderLobby();
    };
    scope.frame(() => {
      const _wmWin = document.getElementById('fighting-body')?.closest('.wm-win');
      const _hud   = document.getElementById('fighting-body')?.querySelector('.fg-sb-hud');
      if (_wmWin && _hud) {
        _wmWin.dataset.aspectExtra = String(_hud.offsetHeight || 0);
        _wmWin._enforceAspect?.();
      }
    });
  }

  async function _sbShowChangeChar() {
    const overlay = document.getElementById('fg-sb-overlay');
    if (!overlay) return;
    overlay.style.display = 'flex';
    overlay.innerHTML = `<div class="fg-sb-overlay-content"><div class="fg-loading-text">${t('games.fighting.loadingCharacters')}</div></div>`;
    let chars;
    try { chars = await scope.fetch('/api/mugen/chars').then(r => r.json()); }
    catch {
      if (!scope.active) return;
      overlay.innerHTML = `<div class="fg-sb-overlay-content"><p style="color:#f44">${t('games.fighting.loadFailedShort')}</p><button class="fg-btn" id="fg-sb-cc-err-close">${t('games.fighting.close')}</button></div>`;
      document.getElementById('fg-sb-cc-err-close')?.addEventListener('click', () => { overlay.style.display = 'none'; });
      return;
    }
    if (!scope.active) return;
    overlay.innerHTML = `
      <div class="fg-sb-overlay-content">
        <h3>${t('games.fighting.changeCharacter')}</h3>
        <div class="fg-charlist" id="fg-sb-cc-list"></div>
        <button class="fg-btn fg-btn-back" id="fg-sb-cc-close">${t('games.fighting.cancel')}</button>
      </div>`;
    document.getElementById('fg-sb-cc-close').onclick = () => { overlay.style.display = 'none'; };
    const list = document.getElementById('fg-sb-cc-list');
    list.innerHTML = chars.map(c => `
      <div class="fg-char-tile" data-folder="${c.folder}" data-deffile="${c.defFile || ''}">
        <canvas class="fg-char-tile-portrait" width="100" height="108"></canvas>
        <div class="fg-char-tile-name">${c.name}</div>
      </div>`).join('');
    _loadTilePortraits(list);
    list.querySelectorAll('.fg-char-tile').forEach(tile => {
      tile.onclick = () => {
        resumeSndCtx?.(); // resume AudioContext on user gesture
        socket.emit('sandbox:change_char', { char: tile.dataset.folder, defFile: tile.dataset.deffile || null });
        overlay.style.display = 'none';
      };
    });
  }

  async function _sbShowChangeStage() {
    const overlay = document.getElementById('fg-sb-overlay');
    if (!overlay) return;
    overlay.style.display = 'flex';
    overlay.innerHTML = `<div class="fg-sb-overlay-content"><div class="fg-loading-text">${t('games.fighting.loadingStages')}</div></div>`;
    let stages;
    try { stages = await scope.fetch('/api/mugen/stages').then(r => r.json()); }
    catch {
      if (!scope.active) return;
      overlay.innerHTML = `<div class="fg-sb-overlay-content"><p style="color:#f44">${t('games.fighting.loadFailedShort')}</p><button class="fg-btn" id="fg-sb-cs-err-close">${t('games.fighting.close')}</button></div>`;
      document.getElementById('fg-sb-cs-err-close')?.addEventListener('click', () => { overlay.style.display = 'none'; });
      return;
    }
    if (!scope.active) return;
    overlay.innerHTML = `
      <div class="fg-sb-overlay-content">
        <h3>${t('games.fighting.changeStage')}</h3>
        <div class="fg-charlist" id="fg-sb-cs-list"></div>
        <button class="fg-btn fg-btn-back" id="fg-sb-cs-close">${t('games.fighting.cancel')}</button>
      </div>`;
    document.getElementById('fg-sb-cs-close').onclick = () => { overlay.style.display = 'none'; };
    const list = document.getElementById('fg-sb-cs-list');
    list.innerHTML = stages.map(s => `
      <div class="fg-char-tile" data-folder="${s.folder}" data-deffile="${s.defFile}" data-sfffile="${s.sffFile}">
        <div class="fg-char-tile-name">${s.name}</div>
      </div>`).join('');
    list.querySelectorAll('.fg-char-tile').forEach(tile => {
      tile.onclick = () => {
        resumeSndCtx?.(); // resume AudioContext on user gesture
        socket.emit('sandbox:change_stage', {
          stage: { folder: tile.dataset.folder, defFile: tile.dataset.deffile, sffFile: tile.dataset.sfffile },
        });
        overlay.style.display = 'none';
      };
    });
  }

  // ── Sandbox socket listeners ───────────────────────────────────────────────

  socket.on('sandbox:count', ({ count }) => {
    _sbCount = count;
    const el = document.getElementById('fg-sp-count');
    if (el) el.textContent = count;
    const elSel = document.getElementById('fg-sb-sel-count');
    if (elSel) elSel.textContent = count;
    const elHud = document.getElementById('fg-sb-count');
    if (elHud) elHud.textContent = t('games.fighting.playerCount', { count });
  });

  socket.on('sandbox:state', async ({ players, stage, mySlot }) => {
    _sbMySlot  = mySlot;
    _sbActive  = true;
    _sbFighters.clear();
    _sbPseudos.clear();
    _sbColors.clear();

    showLoading(t('games.fighting.sandboxLoading'));
    setLoadProgress(t('games.fighting.loadingFightersEllipsis'), 5);

    // Load all characters in parallel
    const loadTasks = players.map(p =>
      p.char ? loadMugenChar(p.char, null, p.defFile || null).catch(() => null) : Promise.resolve(null)
    );
    let chars;
    try { chars = await Promise.all(loadTasks); }
    catch { chars = players.map(() => null); }

    if (!scope.active) return;
    setLoadProgress(t('games.fighting.loadingStage'), 60);

    // Load stage if present
    if (stage?.folder && stage?.defFile) {
      try {
        const sd = await loadStage(stage.folder, stage.defFile, stage.sffFile || null);
        if (!scope.active) return;
        _stageData = sd;
        _floorY = sd.localcoord
          ? Math.round(STAGE_H * sd.zoffset / (sd.floorCoordH || sd.localcoord.h))
          : FLOOR_Y_DEFAULT;
        _playBgm(sd.bgMusicUrl);
      } catch (error) { console.warn('[fighting] sandbox stage load failed:', error); }
    }

    if (!scope.active) return;
    // Build fighter objects
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      _sbPseudos.set(p.slot, p.pseudo);
      _sbColors.set(p.slot, p.color || '#ffffff');
      if (chars[i]) {
        const f = _sbMakeFighter(p.slot, chars[i]);
        if (p.lastX != null) f.x = p.lastX;
        if (p.lastY != null) f.y = Math.min(p.lastY, _floorY);
        _sbFighters.set(p.slot, f);
      }
    }

    setLoadProgress(t('games.fighting.ready'), 100);
    showSandboxFight();
    _sbStartLoop();
  });

  socket.on('sandbox:player_joined', async ({ slot, pseudo, color, char, defFile, x, y }) => {
    _sbPseudos.set(slot, pseudo);
    _sbColors.set(slot, color || '#ffffff');
    if (!_sbActive) return;
    _sbPaused = true;

    const overlay = document.getElementById('fg-sb-overlay');
    if (overlay) {
      overlay.style.display = 'flex';
      overlay.innerHTML = `<div class="fg-sb-loading-banner">${t('games.fighting.playerJoining', { pseudo })}</div>`;
    }

    try {
      if (char) {
        const c = await loadMugenChar(char, null, defFile || null);
        if (!scope.active) return;
        const f = _sbMakeFighter(slot, c);
        if (x != null) f.x = x;
        if (y != null) f.y = Math.min(y, _floorY);
        _sbFighters.set(slot, f);
      }
    } catch (error) { console.warn('[fighting] sandbox character load failed:', error); }

    if (overlay) overlay.style.display = 'none';
    _sbPaused = false;
  });

  socket.on('sandbox:player_left', ({ slot }) => {
    _sbFighters.delete(slot);
    _sbPseudos.delete(slot);
    _sbColors.delete(slot);
  });

  socket.on('sandbox:input', ({ slot, input, x, y, assertedCmd, assertedPose }) => {
    const f = _sbFighters.get(slot);
    if (!f) return;
    if (Array.isArray(input?.dirs)) f._lastDirs = input.dirs;
    if (Array.isArray(input?.btns)) {
      f._lastBtns   = input.btns.filter(b => b === 'block');  // persistent (held)
      f._pendingBtns = new Set(input.btns);                    // one-shot attack presses
    }
    if (assertedCmd)  f._assertedCmd  = assertedCmd;          // movelist click from remote player
    if (assertedPose) f._assertedPose = assertedPose;         // pose click from remote player
    // Soft position correction — only snap on large drift
    if (typeof x === 'number' && Math.abs(f.x - x) > 80) f.x = x;
    if (typeof y === 'number' && Math.abs(f.y - y) > 80) f.y = Math.min(y, _floorY);
  });

  socket.on('sandbox:hit', ({ fromSlot }) => {
    const myF = _sbFighters.get(_sbMySlot);
    if (!myF) return;
    if ([ST.HITSTUN, ST.BLOCKSTUN, ST.WIN, ST.LOSE, ST.INTRO].includes(myF.stateId)) return;
    const fromF = _sbFighters.get(fromSlot);
    myF.hitstopLeft = 8;
    myF.vx = (fromF && fromF.x < myF.x ? 1 : -1) * 3 * MUGEN_PX_S;
    myF._hitstunWasAir    = !myF.onGround;
    myF._hitstunWasCrouch = [ST.CROUCH, ST.CROUCH_START, ST.CROUCH_END].includes(myF.stateId);
    myF.hitstunLeft = 16;
    _transition(myF, ST.HITSTUN);
    myF.hitFlashFrames = 4;
    _screenShakeFrames = 4;
    _screenShakeAmp    = 3;
  });

  socket.on('sandbox:char_changed', async ({ slot, char, defFile }) => {
    if (!_sbActive) return;
    _sbPaused = true;
    const pseudo = _sbPseudos.get(slot) ?? '?';
    const charName = defFile ? defFile.replace(/\.def$/i, '') : char;
    const overlay = document.getElementById('fg-sb-overlay');
    if (overlay) {
      overlay.style.display = 'flex';
      overlay.innerHTML = `<div class="fg-sb-loading-banner">${t('games.fighting.playerLoadingCharacter', { pseudo, character: charName })}</div>`;
    }
    try {
      const c = await loadMugenChar(char, null, defFile || null);
      if (!scope.active) return;
      const existing = _sbFighters.get(slot);
      const newF = _sbMakeFighter(slot, c);
      if (existing) { newF.x = existing.x; newF.y = existing.y; newF.facing = existing.facing; }
      // Clear all helpers belonging to the old fighter at this slot to prevent
      // stale persistent helpers (e.g. Koishi idle clone) from accumulating.
      for (let i = _helpers.length - 1; i >= 0; i--) {
        if (_helpers[i].parentSlot === slot) _helpers.splice(i, 1);
      }
      _sbFighters.set(slot, newF);
    } catch (error) { console.warn('[fighting] sandbox character swap failed:', error); }
    if (overlay) overlay.style.display = 'none';
    _sbPaused = false;
  });

  socket.on('sandbox:stage_changed', async ({ stage }) => {
    if (!stage?.folder) return;
    const overlay = document.getElementById('fg-sb-overlay');
    if (overlay) {
      overlay.style.display = 'flex';
      overlay.innerHTML = `<div class="fg-sb-loading-banner">${t('games.fighting.loadingStage')}</div>`;
    }
    try {
      const sd = await loadStage(stage.folder, stage.defFile, stage.sffFile || null);
      if (!scope.active) return;
      _stageData = sd;
      _floorY = sd.localcoord
        ? Math.round(STAGE_H * sd.zoffset / (sd.floorCoordH || sd.localcoord.h))
        : FLOOR_Y_DEFAULT;
      for (const f of _sbFighters.values()) { if (f.onGround) f.y = _floorY; }
      _playBgm(sd.bgMusicUrl);
    } catch (error) { console.warn('[fighting] sandbox stage load failed:', error); }
    if (overlay) overlay.style.display = 'none';
  });

  function releaseInput() {
    _clearKeys(); _pendingOutBtns.clear(); _inputLocked = false; _chatFocused = false;
  }
  scope.cleanup(() => {
    releaseInput(); stopLoop(); _sbStopLoop();
    _fighters = [null, null];
    root.remove();
    if (socket_ref === socket) socket_ref = null;
  });
  // Closing/minimizing releases keys; an admitted paid game keeps running.
  // Socket disconnect/disposal is the boundary that destroys its controller.
  renderLobby();
  return { releaseInput, refresh: () => socket.emit('fighting:rooms_request'), stop: () => scope.stop() };
}

// Window open hook — refresh room list when the panel becomes visible
export function onFightingWindowOpen() {
  socket_ref?.emit('fighting:rooms_request');
}
