import { createWormsSprites } from './worms-sprites.js';
import { createWormsTerrain } from './worms-terrain.js';
import { createWormsMedia } from './worms-media.js';
import { randomIndex, randomUnit } from '/core/js/secure-random.js';
import { setSafeHtml } from '/core/js/safe-dom.js';
import { createGameScope } from '/core/js/games/game-scope.js';
import { createGameInput } from '/core/js/games/ui.js';
import { createGameEvents } from '/core/js/games/game-events.js';
import { t } from '/core/js/i18n.js';
import { renderUserName, userNameHtml } from '/core/js/user-name.js';

let current = null;
export function initWorms(socket, getMe, pushSystem, scope = createGameScope()) {
  current?.stop();
  return current = createController(socket, getMe, pushSystem, scope);
}
export function activateWorms(...args) { return current?.active ? current.activateWorms(...args) : undefined; }

function createController(socket, getMe, pushSystem, scope) {
  socket = createGameEvents(socket);
  scope.signal.addEventListener('abort', () => socket.stop(), { once: true });
// ChaOS — Worms FFA — client game module
// Canvas 2D, vanilla JS, matches the existing games pattern.
//
// Exports:
//   initWorms(socket, getMe, pushSystem)   — bind socket events (games.js imports this module on demand)
//   activateWorms(root, onExit)            — show worms UI (lobby → game → results), starts the asset preload

// ── World constants (must mirror server) ─────────────────────────────────────
const WORLD_W  = 960;
const WORLD_H  = 480;
const WATER_Y  = 455;
const WORM_R   = 10;
const GRAVITY  = 400;
const WALK_SPD = 88;
// Jump physics
const JUMP_FWD_VY  = -235;  // forward hop vertical   (~69 px rise with G=400)
const JUMP_FWD_VX  =  110;  // forward hop horizontal
const BACKFLIP_VY  = -310;  // backflip vertical       (~120 px rise)
const BACKFLIP_VX  =  150;  // backflip horizontal (backward from facing)
const TURN_MS  = 30_000;

// ── Level definitions (must mirror server LEVELS order) ───────────────────────────
const LEVELS = [
  { name:'Treasure',    file:'level2',   emoji:'🏕️', skyA:'#3a6186', skyB:'#89216b', skyC:'#ffd89b', stars:false },
  { name:'Jungle',      file:'castles',  emoji:'🌿', skyA:'#134e5e', skyB:'#2b6b5b', skyC:'#71b280', stars:false },
  { name:'Ruins',       file:'level3',   emoji:'🏰', skyA:'#485563', skyB:'#29323c', skyC:'#a8c0ff', stars:false },
  { name:'Battleship',  file:'level5',   emoji:'⚓', skyA:'#1c3a5e', skyB:'#254b7a', skyC:'#4a90d9', stars:false },
  { name:'Titanic',     file:'level20',  emoji:'🛤️', skyA:'#0a0a1a', skyB:'#0d1b3e', skyC:'#1a3a6e', stars:true  },
];

const WEAPON_WORM_ANIM = {
  bazooka:      { takeOut: { img:'wbazlnk',  frames:10, ms:50 }, aim: { img:'wbaz',     frames:32, ms:60,  frameY:0.5 } },
  hand_grenade: { takeOut: { img:'wgrnlnk',  frames:10, ms:50 }, aim: { img:'wthrgrn',  frames:32, ms:100, frameY:0.5 } },
  cluster_bomb: { takeOut: { img:'whgrlnk',  frames:10, ms:50 }, aim: { img:'wthrhgr',  frames:32, ms:100, frameY:0.5 } },
  shotgun:      { takeOut: { img:'wshglnk',  frames:10, ms:60 }, aim: { img:'wshotp',   frames:32, ms:50,  frameY:0.5 } },
  minigun:      { takeOut: { img:'wmgnlnk',  frames:10, ms:60 }, aim: { img:'wmini',    frames:32, ms:60,  frameY:0.5 } },
  mortar:       { takeOut: { img:'wgrnlnk',  frames:10, ms:50 }, aim: { img:'wthrgrn',  frames:32, ms:100, frameY:0.5 } },
  airstrike:    { takeOut: { img:'wgrnlnk',  frames:10, ms:50 }, aim: { img:'wthrgrn',  frames:32, ms:100, frameY:0.5 } },
  drill:        { takeOut: { img:'wdrllnk',  frames:13, ms:60 }, aim: null },
  dynamite:     { takeOut: { img:'wdynlnk',  frames:10, ms:50 }, aim: null },
  holy_grenade: { takeOut: { img:'whgrlnk',  frames:10, ms:50 }, aim: { img:'wthrhgr',  frames:32, ms:100, frameY:0.5 } },
  banana_bomb:  { takeOut: { img:'whgrlnk',  frames:10, ms:50 }, aim: { img:'wthrhgr',  frames:32, ms:100, frameY:0.5 } },
  napalm:       { takeOut: { img:'wgrnlnk',  frames:10, ms:50 }, aim: { img:'wthrgrn',  frames:32, ms:100, frameY:0.5 } },
  land_mine:    { takeOut: { img:'wdynlnk',  frames:10, ms:50 }, aim: null },
  ninja_rope:   { takeOut: { img:'wbazlnk',  frames:13, ms:50 }, aim: null },
  jetpack:      { takeOut: { img:'wjetlnk',  frames:10, ms:50 }, aim: null },
  bat:          { takeOut: { img:'wbatlnk',  frames:13, ms:50 }, aim: { img:'wbataim', frames:10, ms:100, frameY:0 } },
  teleport:     { takeOut: { img:'wgrnlnk',  frames:10, ms:50 }, aim: null },
};

const WEAPONS = {
  bazooka:      { icon: '🚀', labelKey: 'games.worms.weapon.bazooka',      color: '#ff7700', trailColor: 'rgba(255,140,0,0.7)',   key: '1' },
  hand_grenade: { icon: '💣', labelKey: 'games.worms.weapon.handGrenade',  color: '#88cc44', trailColor: 'rgba(120,190,50,0.6)',  key: '2' },
  cluster_bomb: { icon: '🧨', labelKey: 'games.worms.weapon.clusterBomb',  color: '#ff5533', trailColor: 'rgba(255,100,50,0.6)',  key: '3' },
  shotgun:      { icon: '🔫', labelKey: 'games.worms.weapon.shotgun',      color: '#99bbdd', trailColor: 'rgba(180,210,240,0.5)', key: '4' },
  minigun:      { icon: '⚡', labelKey: 'games.worms.weapon.minigun',      color: '#dddd22', trailColor: 'rgba(240,240,50,0.5)',  key: '5' },
  mortar:       { icon: '💥', labelKey: 'games.worms.weapon.mortar',       color: '#cc8822', trailColor: 'rgba(200,140,30,0.6)',  key: '6' },
  airstrike:    { icon: '✈️', labelKey: 'games.worms.weapon.airstrike',    color: '#66ccff', trailColor: 'rgba(100,200,255,0.6)', key: '7' },
  drill:        { icon: '🔩', labelKey: 'games.worms.weapon.drill',        color: '#cc8833', trailColor: 'rgba(180,130,50,0.5)',  key: '8' },
  dynamite:     { icon: '🧱', labelKey: 'games.worms.weapon.dynamite',     color: '#ff2222', trailColor: 'rgba(255,50,0,0.6)',    key: '9' },
  holy_grenade: { icon: '✝️', labelKey: 'games.worms.weapon.holyGrenade',  color: '#ffffaa', trailColor: 'rgba(255,255,150,0.7)', key: '0' },
  banana_bomb:  { icon: '🍌', labelKey: 'games.worms.weapon.bananaBomb',   color: '#ffdd00', trailColor: 'rgba(255,220,0,0.6)',   key: 'a' },
  napalm:       { icon: '🔥', labelKey: 'games.worms.weapon.napalm',       color: '#ff6600', trailColor: 'rgba(255,100,0,0.7)',   key: 'e' },
  land_mine:    { icon: '💠', labelKey: 'games.worms.weapon.landMine',      color: '#888888', trailColor: 'rgba(150,150,150,0.5)', key: 'r' },
  ninja_rope:   { icon: '🪝', labelKey: 'games.worms.weapon.ninjaRope',     color: '#aaddaa', trailColor: 'rgba(150,220,150,0.7)', key: 't' },
  jetpack:      { icon: '🚀', labelKey: 'games.worms.weapon.jetpack',       color: '#44aaff', trailColor: 'rgba(100,200,255,0.5)', key: 'y' },
  bat:          { icon: '⚾', labelKey: 'games.worms.weapon.bat',           color: '#ffdd88', trailColor: 'rgba(255,220,100,0.6)', key: 'u' },
  teleport:     { icon: '🌀', labelKey: 'games.worms.weapon.teleport',     color: '#aa44ff', trailColor: 'rgba(170,100,255,0.6)', key: 'i' },
};
const FUSE_WEAPONS   = new Set(['hand_grenade', 'cluster_bomb', 'banana_bomb']); // holy_grenade fixed 3 s
const FUSE_SOUND_WEAPONS = new Set(['hand_grenade', 'cluster_bomb', 'holy_grenade', 'banana_bomb']);
const TARGETED_WEAPONS   = new Set(['airstrike', 'napalm']);

const WORMS_ASSETS = '/worms-assets';

function _weaponLabel(weapon) {
  const definition = WEAPONS[weapon];
  return definition ? `${definition.icon} ${t(definition.labelKey)}` : String(weapon ?? '?');
}
const WEAPON_ICONS = {
  bazooka:      'iconbazooka',
  hand_grenade: 'icongrenade',
  cluster_bomb: 'iconhgrenade',
  shotgun:      'iconshotgun',
  minigun:      'iconminigun',
  mortar:       'icongrenade',
  airstrike:    'iconbazooka',
  drill:        'drill',
  dynamite:     'icondynamite',
  holy_grenade: 'iconhgrenade',
  banana_bomb:  'iconsheep',
  napalm:       'iconblowtorch',
  land_mine:    'iconmine',
  ninja_rope:   'iconrope',
  jetpack:      'iconjetpack',
  bat:          'iconbat',
  teleport:     'iconteleport',
};

// ── Module state ──────────────────────────────────────────────────────────────
let _socket  = null;
let _getMe   = null;
let _pushSys = null;
let _root    = null;
let _onExit  = null;
// States: idle | lobby | waiting | game | results
let _state   = 'idle';

let _spectateMode = false;

let _roomId   = null;
let _myUserId = null;
let _lastBet  = 0;
const _openRooms = [];
const _liveRooms = [];

// ── Game state ────────────────────────────────────────────────────────────────
let _terrain      = null;   // Array of WORLD_W height values (pixels)
let _holes        = [];     // [{cx,cy,r}]
let _worms        = [];     // [{id,playerId,cx,cy,hp,alive,name,color}]
let _players      = [];     // [{userId,pseudo,color}]
let _currentTurn  = null;   // userId
let _activeWormId = null;
let _turnDeadline = 0;

// Active worm local physics
const _ws = { cx: 0, cy: 0, vx: 0, vy: 0, onGround: false, facing: 1, _lastSync: 0,
             walking: false, backflipping: false, backflipAngle: 0, parachute: false };
let _wsSynced    = false;

// Input
const _keys  = new Set();
const arenaInput = createGameInput(scope, () => _root, () => { _keys.clear(); _chargeStart = null; });
let _keyAbort     = null;
let _chargeStart  = null;
let _power        = 0;
let _aimAngle     = 0;
let _mouseX       = WORLD_W / 2;
let _mouseY       = WORLD_H / 2;
let _selectedWeapon = 'bazooka';
let _shotFired    = false;

// Animation
let _projectiles  = [];   // [{trajectory:[{cx,cy}], idx, done}]
let _explosions   = [];   // [{cx,cy,r,startMs,durationMs}]
let _dmgLabels    = [];   // [{cx,cy,text,alpha,vy}]
let _particles    = [];   // [{cx,cy,vx,vy,alpha,r,color}]
let _wormBumps    = new Map(); // wormId → {vx,vy,dx,dy} — visual hit-reaction
let _shakeUntil   = 0;
let _animating    = false;
let _pendingNextTurn = null;
let _dyingWorms   = new Map(); // wormId → {startMs} — playing death anim

// Camera
const _cam = { x: 0, y: 0, tx: 0, ty: 0 }; // current + target

// Aim via keyboard (W/S keys)

// Walk sound state
let _walkSoundStep = 0; // 0 or 1 — alternates WalkExpand / WalkCompress
let _walkSoundTimer = 0; // seconds since last walk sound
const _playedTimerTicks = new Set();
const WALK_SOUND_INTERVAL = 0.22; // every ~220ms one step sound

// Weapon anim state (take-out then aim)
let _weaponAnim = null; // { phase:'takeout'|'aim', img, frames, ms, frameY, startMs }
let _prevWeapon = null; // last selected weapon — triggers take-out anim on change

// Wind, retreat, round, sudden death
let _wind         = 0;
let _retreating   = false;
let _retreatEnd   = 0;
let _round        = 0;
let _suddenDeath  = false;
let _waterLevel   = WATER_Y;
let _fuseInterval = null;
let _grenadefuse  = 3;     // grenade fuse in seconds (1–5), selectable with number keys
let _muted        = false; // global sound mute
let _fuseEl       = null;  // DOM span: fuse timer indicator
let _muteBtn      = null;  // DOM button: mute toggle

// Ninja rope state
let _rope = null; // null | { state:'flying'|'attached', cx, cy, vx, vy, anchorX, anchorY, len }

// Jetpack state
let _jetpackActive = false;
let _jetpackFuel   = 0;
let _movementToolUsed = false;

// Ammo, placed objects, teleport
let _ammo           = {};   // my weapon ammo counts (Infinity = unlimited)
let _dynamites      = [];   // [{id, cx, cy, fuseMs, placedAt}] — client-side countdown
let _mines          = [];   // [{id, cx, cy}]
let _teleportTarget = null; // {x, y} — pending teleport destination

// Crates and turn announcement
let _crates           = [];    // [{id,cx,cy,type,weapon,landed,fallingCy}]
let _turnAnnouncement = null;  // {text,color,startMs}

// Collision
let _terrainMask = null;  // Server heights drive collision; image pixels never do.

// Assets — fetched lazily, only once the player opens Worms (see _ensureAssets).
const media = createWormsMedia({ levels: LEVELS, randomIndex,
  isActive: () => scope.active, isMuted: () => _muted });
const { getImage: _assetImage, ensureAssets: _ensureAssets, playSound: _playSound,
  playRandomSpeech: _playRandomSpeech, playExplosionSound: _playExplosionSound } = media;
const terrainRenderer = createWormsTerrain({
  width: WORLD_W, height: WORLD_H, getImage: _assetImage, getLevel: _levelDef,
  getState: () => ({ terrain: _terrain, holes: _holes, waterLevel: _waterLevel, suddenDeath: _suddenDeath }),
  isActive: () => scope.active,
});
const { redraw: _redrawTerrain, drawBackground: _drawWorldBackground } = terrainRenderer;
const wormRenderer = createWormsSprites({
  getState: () => ({ worms: _worms, activeWormId: _activeWormId,
    isPhysicsSynced: _wsSynced, physics: _ws, bumps: _wormBumps, dying: _dyingWorms,
    weaponAnimation: _weaponAnim, aimAngle: _aimAngle }),
  getImage: _assetImage, isActive: () => scope.active, wormRadius: WORM_R,
});
const { draw: _drawWorms } = wormRenderer;

// DOM
let _container  = null;
let _canvas     = null;
let _ctx        = null;
let _timerEl    = null;
let _turnLabel  = null;
let _windEl     = null;
let _healthEl   = null;
let _weaponBtns = Object.create(null);
let _raf        = null;
let _lastMs     = 0;

function _myTurn() { return _currentTurn === _myUserId; }

function _weaponDef(key) {
  return typeof key === 'string' && Object.hasOwn(WEAPONS, key) ? Reflect.get(WEAPONS, key) : null;
}

function _weaponAnimDef(key) {
  return typeof key === 'string' && Object.hasOwn(WEAPON_WORM_ANIM, key) ? Reflect.get(WEAPON_WORM_ANIM, key) : null;
}

function _weaponIconName(key) {
  return typeof key === 'string' && Object.hasOwn(WEAPON_ICONS, key) ? Reflect.get(WEAPON_ICONS, key) : null;
}

// JSON / Socket.IO serializes Infinity as null. Both values represent an
// unlimited weapon in the authoritative server inventory.
function _unlimitedAmmo(count) {
  return count === undefined || count === null || count === Infinity;
}

function _levelDef(index) {
  return Number.isInteger(index) && index >= 0 && index < LEVELS.length ? (LEVELS.at(index) ?? LEVELS.at(0)) : LEVELS.at(0);
}

function _activeWormPosition() {
  const active = _worms.find(w => w.id === _activeWormId);
  return {
    cx: _wsSynced ? _ws.cx : (active?.cx ?? _ws.cx),
    cy: _wsSynced ? _ws.cy : (active?.cy ?? _ws.cy),
  };
}

function _upsertRoom(list, room) {
  const idx = list.findIndex(r => r.id === room.id);
  if (idx >= 0) list.splice(idx, 1, room);
  else list.push(room);
}

function _removeRoomById(list, roomId) {
  const idx = list.findIndex(r => r.id === roomId);
  if (idx >= 0) list.splice(idx, 1);
}

function _enterWaitingRoom(roomId, room) {
  _roomId = roomId;
  _lastBet = room?.bet ?? 0;
  _state = 'waiting';
  if (_root) _renderWaiting(room);
}

function _noteRoomOpen(list, room) {
  _upsertRoom(list, room);
  if (_state === 'lobby') _renderLobby();
}

function _noteRoomClosed(list, roomId) {
  _removeRoomById(list, roomId);
  if (_state === 'lobby') _renderLobby();
}

function _projectileSpriteKey(weapon) {
  switch (weapon) {
    case 'bazooka': return 'missile';
    case 'hand_grenade':
    case 'cluster_bomb':
    case 'mortar': return 'grenade';
    case 'holy_grenade':
    case 'banana_bomb': return 'hgrenade';
    case 'dynamite': return 'dynamite';
    default: return null;
  }
}

// ── Init (called once from games.js) ─────────────────────────────────────────
function initWorms(socket, getMe, pushSystem) {
  _socket  = socket;
  _getMe   = getMe;
  _pushSys = pushSystem;
  _bindSocketEvents();
}

// ── Activate (called from games.js when user clicks Worms button) ────────────
function activateWorms(root, onExit, opts = {}) {
  _root   = root;
  _onExit = onExit;
  _ensureAssets();   // ~96 sprites/sounds (~3.7 MB) load now, never at site load
  const me = _getMe?.();
  _myUserId = me?.userId ?? null;
  if (opts.spectate && opts.roomId) {
    _spectateMode = true; _roomId = opts.roomId; _state = 'spectate_loading';
    root.textContent = t('games.worms.connectingSpectator');
    _socket.emit('worms:watch', { roomId: opts.roomId }); return;
  }
  _spectateMode = false;
  _state  = 'lobby';
  _roomId = null;
  _lastBet = 0;
  _socket.emit('worms:rooms_request');
  _renderLobby();
}

// ── Exit ──────────────────────────────────────────────────────────────────────
function _exit() {
  _stopGame();
  _state  = 'idle';
  _roomId = null;
  if (_onExit) _onExit();
}

// ── Lobby ─────────────────────────────────────────────────────────────────────
function _renderLobby() {
  if (!_root) return;
  _root.dataset.gameMode = 'worms-menu';
  _root.style.cssText = 'padding:10px;overflow:auto;background:#0f1014;color:#fff;';
  _root.replaceChildren();

  const wrap = _el('div', { style: { fontFamily: 'monospace', maxWidth: '600px', margin: '0 auto' } });

  // Header
  wrap.appendChild(_el('h3', { style: { color: '#66dd33', marginBottom: '8px', textAlign: 'center' } }, `🪱 Worms — ${t('games.type.freeForAll')}`));

  // Bet + create row
  const createRow = _el('div', { style: { display: 'flex', gap: '6px', marginBottom: '8px' } });
  const betInput  = _el('input', { type: 'number', min: '0', placeholder: t('games.worms.betPlaceholder'), 'aria-label': t('games.worms.betLabel'), style: {
    flex: '1', padding: '5px 8px', background: '#1e2028', border: '1px solid #444',
    color: '#fff', borderRadius: '4px', fontSize: '13px',
  }});
  const maxSel = _el('select', { 'aria-label': t('games.worms.maxPlayers'), style: {
    padding: '5px', background: '#1e2028', border: '1px solid #444',
    color: '#fff', borderRadius: '4px', fontSize: '13px',
  }});
  [2,3,4,5,6,7,8].forEach(n => {
    const opt = document.createElement('option');
    opt.value = n; opt.textContent = t('games.worms.playerCount', { count: n });
    if (n === 4) opt.selected = true;
    maxSel.appendChild(opt);
  });
  const createBtn = _el('button', { class: 'btn games-create-btn', style: {
    background: 'linear-gradient(135deg,#3d8a2c,#7a5230)',
    color: '#fff', padding: '5px 14px', borderRadius: '4px',
    border: 'none', cursor: 'pointer', fontSize: '13px', whiteSpace: 'nowrap',
  }}, t('games.worms.create'));
  createBtn.addEventListener('click', () => {
    const bet = Math.max(0, parseInt(betInput.value, 10) || 0);
    const me  = _getMe?.();
    if (bet > 0 && bet > (me?.points ?? 0)) { _pushSys?.(t('games.worms.insufficientBalance')); return; }
    _socket.emit('worms:create', { bet, maxPlayers: parseInt(maxSel.value, 10) });
  });
  createRow.append(betInput, maxSel, createBtn);
  wrap.appendChild(createRow);

  // Open rooms
  const roomsTitle = _el('div', {
    style: { fontSize: '12px', color: '#999', marginBottom: '4px', marginTop: '8px' },
  }, t('games.worms.openRooms', { count: _openRooms.length }));
  wrap.appendChild(roomsTitle);

  if (_openRooms.length === 0) {
    wrap.appendChild(_el('div', { style: { fontSize: '12px', color: '#555', marginBottom: '6px' }}, t('games.worms.noRooms')));
  } else {
    for (const r of _openRooms) {
      wrap.appendChild(_roomRow(r));
    }
  }

  // Live rooms
  if (_liveRooms.length > 0) {
    wrap.appendChild(_el('div', {
      style: { fontSize: '12px', color: '#999', marginTop: '8px', marginBottom: '4px' },
    }, t('games.worms.liveRooms', { count: _liveRooms.length })));
    for (const r of _liveRooms) {
      const row = _el('div', { style: {
        background: '#1a2012', border: '1px solid #2d4020', borderRadius: '4px',
        padding: '6px 8px', marginBottom: '4px', fontSize: '12px', color: '#aaa',
      }});
      const names = r.players.map(p => _colorSpan(p.pseudo, p.color)).join(', ');
      setSafeHtml(row, `<span style="color:#66dd33">▶ ${t('games.worms.live')}</span> ${names} — ${t('games.worms.betShort', { bet: r.bet })}`);
      // Spectating starts here since Worms has its own window (roadmap J5c).
      const watch = _el('button', { type: 'button', class: 'btn small', 'data-worms-watch': r.id, style: { marginLeft: '8px' } }, `👁 ${t('games.lobby.watch')}`);
      watch.addEventListener('click', () => activateWorms(_root, _onExit, { spectate: true, roomId: r.id }));
      row.appendChild(watch);
      wrap.appendChild(row);
    }
  }

  _root.appendChild(wrap);

  // Back button
  const backBtn = _el('button', { style: {
    marginTop: '10px', background: '#333', color: '#ccc',
    border: 'none', padding: '5px 14px', borderRadius: '4px',
    cursor: 'pointer', fontSize: '12px', display: 'block', marginLeft: 'auto', marginRight: 'auto',
  }}, t('games.worms.back'));
  backBtn.addEventListener('click', _exit);
  _root.appendChild(backBtn);
}

function _roomRow(r) {
  const row = _el('div', { style: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    background: '#161a1e', border: '1px solid #333', borderRadius: '4px',
    padding: '5px 8px', marginBottom: '4px', fontSize: '13px',
  }});
  const names = r.players.map(p => _colorSpan(p.pseudo, p.color)).join(', ');
  const left = _el('span', {});
  setSafeHtml(left, `${names} — <span style="color:#aaa">${r.players.length}/${r.maxPlayers}</span> — <span style="color:#f8c200">${r.bet} pts</span>`);
  const joinBtn = _el('button', { style: {
    background: '#1d4a28', color: '#66dd33', border: '1px solid #2d6a38',
    padding: '3px 10px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px',
  }}, t('games.worms.join'));
  joinBtn.setAttribute('data-game-focus', `worms:join:${r.id}`);
  joinBtn.setAttribute('aria-label', t('games.worms.joinRoom', { players: r.players.map(p=>p.pseudo).join(', ') }));
  joinBtn.addEventListener('click', () => {
    const me = _getMe?.();
    if (r.bet > 0 && r.bet > (me?.points ?? 0)) { _pushSys?.(t('games.worms.insufficientBalance')); return; }
    _socket.emit('worms:join', { roomId: r.id });
  });
  row.append(left, joinBtn);
  return row;
}

// ── Waiting room ──────────────────────────────────────────────────────────────
const MAP_NAMES = LEVELS.map(l => `${l.emoji} ${l.name}`);
let _selectedTheme = 0;

function _renderWaiting(room) {
  if (!_root) return;
  _root.dataset.gameMode = 'worms-menu';
  _lastBet = room?.bet ?? _lastBet;
  _root.replaceChildren();
  _root.style.cssText = 'padding:10px;overflow:auto;background:#0f1014;color:#fff;';

  const wrap = _el('div', { style: { fontFamily: 'monospace', maxWidth: '500px', margin: '0 auto', textAlign: 'center' } });
  wrap.appendChild(_el('h3', { style: { color: '#66dd33', marginBottom: '10px' }}, t('games.worms.waitingRoom')));

  const betInfo = _el('div', { style: { color: '#f8c200', marginBottom: '8px', fontSize: '13px' }},
    t('games.worms.roomSummary', { bet: room.bet, players: room.players.length, maxPlayers: room.maxPlayers }));
  wrap.appendChild(betInfo);

  const list = _el('div', { style: { marginBottom: '12px' }});
  for (const p of room.players) {
    const row = _el('div', { style: { padding: '3px 0', fontSize: '13px' }});
    setSafeHtml(row, _colorSpan(p.pseudo, p.color));
    list.appendChild(row);
  }
  wrap.appendChild(list);

  const waiting = _el('div', { style: { color: '#888', fontSize: '12px', marginBottom: '12px' }},
    t('games.worms.waitingForPlayers'));
  wrap.appendChild(waiting);

  const btnRow = _el('div', { style: { display: 'flex', gap: '8px', justifyContent: 'center' }});
  const isCreator = room.players.length > 0 && room.players[0].userId === _myUserId;

  // Map selector — only the creator can change it
  const mapSection = _el('div', { style: { marginBottom: '12px' }});
  mapSection.appendChild(_el('div', { style: { fontSize: '11px', color: '#888', marginBottom: '5px' }}, t('games.worms.map')));
  const mapRow = _el('div', { style: { display: 'flex', gap: '5px', justifyContent: 'center', flexWrap: 'wrap' }});
  MAP_NAMES.forEach((name, i) => {
    const btn = _el('button', { style: {
      background: _selectedTheme === i ? _levelDef(i).skyB : '#1a1a1a',
      color: _selectedTheme === i ? '#fff' : '#888',
      border: `1px solid ${_selectedTheme === i ? '#aaa' : '#333'}`,
      padding: '4px 8px', borderRadius: '4px', cursor: isCreator ? 'pointer' : 'default',
      fontSize: '11px', opacity: isCreator ? '1' : '0.6',
    }}, name);
    if (isCreator) {
      btn.addEventListener('click', () => {
        _selectedTheme = i;
        _renderWaiting(room);  // re-render to update selection
      });
    }
    mapRow.appendChild(btn);
  });
  mapSection.appendChild(mapRow);
  wrap.appendChild(mapSection);

  if (isCreator) {
    const launchBtn = _el('button', { style: {
      background: room.players.length < 2 ? '#2a3a2a' : 'linear-gradient(135deg,#3d8a2c,#7a5230)',
      color: '#fff', border: 'none', padding: '7px 18px', borderRadius: '4px',
      cursor: room.players.length < 2 ? 'not-allowed' : 'pointer', fontSize: '13px',
    }}, t('games.worms.launch'));
    if (room.players.length >= 2) {
      launchBtn.addEventListener('click', () => _socket.emit('worms:launch', { roomId: _roomId, theme: _selectedTheme }));
    }
    btnRow.appendChild(launchBtn);
  }

  const leaveBtn = _el('button', { style: {
    background: '#3a1414', color: '#ff7777', border: '1px solid #5a2020',
    padding: '7px 14px', borderRadius: '4px', cursor: 'pointer', fontSize: '13px',
  }}, t('games.worms.leave'));
  leaveBtn.addEventListener('click', () => {
    _socket.emit('worms:forfeit', { roomId: _roomId });
    _state = 'lobby';
    _roomId = null;
    _socket.emit('worms:rooms_request');
    _renderLobby();
  });
  btnRow.appendChild(leaveBtn);
  wrap.appendChild(btnRow);
  _root.appendChild(wrap);
}

// ── Game canvas setup ─────────────────────────────────────────────────────────

function _setupGame(data) {
  wormRenderer.clear();
  if (_root) _root.dataset.gameMode = 'worms-game';
  _resetGameData(data);
  _terrainMask = terrainRenderer.prepare(data, _roomId);
  _buildGameLayout();
  _updateHealthBar();
  _centerCameraOnActive(data.worms, data.activeWormId);
  _finishGameSetup();
}

function _resetGameData(data) {
  _terrain      = data.terrain;
  _holes        = data.holes  ?? [];
  _worms        = data.worms.map(w => ({ ...w, _facing: 1 }));
  _players      = data.players;
  _currentTurn  = data.currentTurn;
  _activeWormId = data.activeWormId;
  _turnDeadline = Date.now() + (data.turnMs ?? TURN_MS);
  _shotFired    = false;
  _movementToolUsed = false;
  _animating    = false;
  _pendingNextTurn = null;
  _projectiles  = [];
  _explosions   = [];
  _dmgLabels    = [];
  _wormBumps.clear();
  _particles    = [];
  _shakeUntil   = 0;
  _retreating   = false;
  _retreatEnd   = 0;
  _wind         = data.wind        ?? 0;
  _round        = data.round       ?? 0;
  _suddenDeath  = data.suddenDeath ?? false;
  _waterLevel   = data.waterLevel  ?? WATER_Y;
  _crates       = (data.crates ?? []).map(c => ({ ...c, landed: true, fallingCy: c.cy }));
  _dynamites    = (data.dynamites ?? []).map(d => ({
    ...d,
    placedAt: d.fuseStarted ? performance.now() - (Date.now() - d.fuseStarted) : performance.now(),
  }));
  _mines        = (data.mines ?? []).map(m => ({ ...m }));
  const myAmmo = _myUserId ? Reflect.get(data.playerAmmo || {}, _myUserId) : null;
  _ammo         = myAmmo ? { ...myAmmo } : {};
  _teleportTarget = null;
  _turnAnnouncement = null;
}

function _buildGameLayout() {
  _root.replaceChildren();
  _root.style.cssText = 'padding:0;overflow:hidden;background:#0a0a0f;position:relative;display:flex;flex-direction:column;';
  _root.appendChild(_buildTopBar());
  _root.appendChild(_buildCanvasArea());
  _root.appendChild(_buildBottomControls());
  _healthEl = _buildHealthList();
  _root.appendChild(_healthEl);
}

function _buildTopBar() {
  const topBar = _el('div', { class: 'worms-topbar', style: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    background: '#111', padding: '4px 10px', height: '28px', flexShrink: '0',
    fontFamily: 'monospace', fontSize: '13px', color: '#fff', boxSizing: 'border-box',
  }});
  _turnLabel = _el('span', { style: { color: '#66dd33' }}, '');
  _turnLabel.setAttribute('data-game-status', '');
  _timerEl   = _el('span', { style: { color: '#ffcc00', fontWeight: 'bold' }}, '');
  _windEl    = _el('span', { style: { color: '#aaddff', fontSize: '12px' }}, '');
  _muteBtn = _buildMuteButton();
  topBar.append(_turnLabel, _windEl, _timerEl, _muteBtn);
  return topBar;
}

function _buildMuteButton() {
  const btn = _el('button', { style: {
    background: 'none', border: '1px solid #333', color: '#aaa',
    padding: '2px 5px', borderRadius: '3px', cursor: 'pointer',
    fontSize: '13px', lineHeight: '1', marginLeft: '4px', flexShrink: '0',
  }}, '🔊');
  btn.title = t('games.worms.soundToggle');
  btn.setAttribute('aria-label', t('games.worms.sound')); btn.setAttribute('aria-pressed', String(!_muted));
  btn.addEventListener('click', () => {
    _muted = !_muted;
    btn.textContent = _muted ? '🔇' : '🔊';
    btn.setAttribute('aria-pressed', String(!_muted));
  });
  return btn;
}

function _buildCanvasArea() {
  _container = _el('div', { class: 'worms-stage', style: {
    flex: '1', overflow: 'hidden', position: 'relative', lineHeight: '0',
  }});
  _canvas = document.createElement('canvas');
  _canvas.width  = WORLD_W;
  arenaInput.attach(_canvas, 'Worms', t('games.worms.controls'));
  _canvas.height = WORLD_H;
  _canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;object-fit:contain;cursor:crosshair;touch-action:none;display:block;';
  _container.appendChild(_canvas);
  _ctx = _canvas.getContext('2d');

  terrainRenderer.mount();
  return _container;
}

function _buildBottomControls() {
  const bottomBar = _el('div', { class: 'worms-toolbar', style: {
    display: 'flex', alignItems: 'center', gap: '6px',
    background: '#111', padding: '4px 8px', flexShrink: '0',
    fontFamily: 'monospace', fontSize: '12px', boxSizing: 'border-box',
  }});
  _buildWeaponButtons(bottomBar);
  bottomBar.appendChild(_el('div', { style: { flex: '1' }}));
  if (_spectateMode) _buildSpectateControls(bottomBar);
  else _buildPlayerControls(bottomBar);
  bottomBar.appendChild(_buildFuseIndicator());
  return bottomBar;
}

function _buildWeaponButtons(bottomBar) {
  _weaponBtns = Object.create(null);
  for (const [key, def] of Object.entries(WEAPONS)) {
    const btn = _buildWeaponButton(key, def);
    Reflect.set(_weaponBtns, key, btn);
    bottomBar.appendChild(btn);
  }
}

function _buildWeaponButton(key, def) {
  const isActive = key === _selectedWeapon;
  const btn = _el('button', { class: 'worms-weapon-btn', style: {
    background: isActive ? '#2a4a1a' : '#1a1a1a',
    color: isActive ? '#66dd33' : '#888',
    border: `1px solid ${isActive ? '#66dd33' : '#333'}`,
    padding: '2px 3px', borderRadius: '4px', cursor: 'pointer',
    transition: 'background 0.15s', display: 'flex', flexDirection: 'column',
    alignItems: 'center', gap: '1px', minWidth: '32px', lineHeight: '1',
    boxSizing: 'border-box',
  }});
  const label = _weaponLabel(key);
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.setAttribute('aria-pressed', String(isActive));
  const lbl = _buildWeaponKeyLabel(def.key);
  btn.appendChild(_buildWeaponIcon(key, def, btn, lbl));
  btn.appendChild(lbl);
  btn.appendChild(_buildAmmoLabel(key));
  btn.addEventListener('click', () => _selectWeapon(key));
  return btn;
}

function _buildWeaponIcon(key, def, btn, lbl) {
  const iconImg = document.createElement('img');
  const iconName = _weaponIconName(key);
  iconImg.src = `${WORMS_ASSETS}/images/weaponicons/${iconName ?? 'iconbazooka'}.png`;
  iconImg.style.cssText = 'width:22px;height:22px;image-rendering:pixelated;display:block;';
  iconImg.onerror = () => {
    iconImg.style.display = 'none';
    const em = document.createElement('span');
    em.style.cssText = 'font-size:15px;line-height:22px;display:block;width:22px;text-align:center;';
    em.textContent = def.icon;
    btn.insertBefore(em, lbl);
  };
  return iconImg;
}

function _buildWeaponKeyLabel(key) {
  const lbl = document.createElement('span');
  lbl.style.cssText = 'font-size:8px;font-family:monospace;opacity:0.7;';
  lbl.textContent = key;
  return lbl;
}

function _buildAmmoLabel(key) {
  const ammoEl = document.createElement('span');
  ammoEl.dataset.ammo = key;
  ammoEl.style.cssText = 'font-size:7px;font-family:monospace;color:#ffcc44;min-height:8px;';
  return ammoEl;
}

function _buildSpectateControls(bottomBar) {
  const quitBtn = _el('button', { style: {
    background: '#2a1818', color: '#ff8888', border: '1px solid #5a2828',
    padding: '3px 12px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px',
  }}, t('games.worms.leaveSpectator'));
  quitBtn.addEventListener('click', _quitSpectating);
  bottomBar.appendChild(quitBtn);
}

function _quitSpectating() {
  _socket.emit('worms:unwatch', { roomId: _roomId });
  _spectateMode = false; _state = 'idle'; _roomId = null;
  _stopGame();
  if (_onExit) _onExit();
}

function _buildPlayerControls(bottomBar) {
  bottomBar.appendChild(_buildEndTurnButton());
  bottomBar.appendChild(_buildForfeitButton());
}

function _buildEndTurnButton() {
  const endTurnBtn = _el('button', { style: {
    background: '#2a1818', color: '#ff8888', border: '1px solid #5a2828',
    padding: '3px 10px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px',
  }}, t('games.worms.endTurn'));
  endTurnBtn.addEventListener('click', () => {
    if (_myTurn()) _socket.emit('worms:end_turn', { roomId: _roomId });
  });
  return endTurnBtn;
}

function _buildForfeitButton() {
  const forfeitBtn = _el('button', { style: {
    background: '#1a1a1a', color: '#888', border: '1px solid #333',
    padding: '3px 8px', borderRadius: '4px', cursor: 'pointer', fontSize: '11px',
  }}, '✗');
  forfeitBtn.title = t('games.forfeit');
  forfeitBtn.addEventListener('click', () => {
    if (confirm(t('games.confirmForfeit'))) _socket.emit('worms:forfeit', { roomId: _roomId });
  });
  return forfeitBtn;
}

function _buildFuseIndicator() {
  _fuseEl = _el('span', { style: {
    color: '#ffcc44', fontFamily: 'monospace', fontSize: '11px',
    padding: '2px 6px', borderRadius: '3px', background: 'rgba(255,200,50,0.1)',
    border: '1px solid rgba(255,200,50,0.3)', marginLeft: '4px', display: 'none',
  }}, '');
  _fuseEl.title = t('games.worms.grenadeTimerHelp');
  return _fuseEl;
}

function _buildHealthList() {
  return _el('div', { class: 'worms-healthbar', style: {
    display: 'flex', flexWrap: 'wrap', gap: '4px',
    background: '#0d0d0d', padding: '3px 8px', flexShrink: '0',
    fontFamily: 'monospace', fontSize: '11px',
  }});
}

function _centerCameraOnActive(worms, activeWormId) {
  const awInit = worms.find(w => w.id === activeWormId);
  if (!awInit) return;
  _cam.x = Math.max(0, Math.min(WORLD_W - WORLD_W, awInit.cx - WORLD_W / 2));
  _cam.y = 0;
  _cam.tx = _cam.x; _cam.ty = _cam.y;
}

function _finishGameSetup() {
  _initWsTurn();
  _bindGameInput();
  _startRaf();
  _updateHUD();
  scope.timeout(() => _playSound('StartRound', 0.5), 200);
}
// ── Main render loop ──────────────────────────────────────────────────────────
function _startRaf() {
  if (_raf) scope.cancelFrame(_raf);
  _lastMs = performance.now();
  const loop = (now) => {
    _raf = scope.frame(loop);
    const dt = Math.min((now - _lastMs) / 1000, 0.05);
    _lastMs  = now;
    _physicsStep(dt);
    _renderFrame(now, dt);
    _tickDmgLabels(dt);
  };
  _raf = scope.frame(loop);
}

function _stopGame() {
  if (_raf) { scope.cancelFrame(_raf); _raf = null; }
  _unbindGameInput();
  wormRenderer.clear();
  _wormBumps.clear();
  _dyingWorms.clear();
  _weaponAnim = null;
  _prevWeapon = null;
  _terrainMask = null;
  terrainRenderer.reset();
  _crates = [];
  _turnAnnouncement = null;
  if (_fuseInterval) { scope.clearInterval(_fuseInterval); _fuseInterval = null; }
  _rope          = null;
  _jetpackActive = false;
  _jetpackFuel   = 0;
  _movementToolUsed = false;
  _dynamites     = [];
  _mines         = [];
  _teleportTarget = null;
  _ammo          = {};
  _fuseEl  = null;
  _muteBtn = null;
  if (_root && _root.dataset.gameMode === 'worms-game') _root.dataset.gameMode = 'worms-menu';
}

function _renderFrame(now, dt = 0.016) {
  if (!_ctx) return;
  const ctx = _ctx;
  _updateCamera(dt);
  ctx.save();
  _applyScreenShake(ctx, now);
  _drawWorldBackground(ctx, dt);
  _drawWorms(ctx, now, dt);
  _drawRope(ctx);
  _drawJetpackFuel(ctx);
  _drawAimAndTargeting(ctx, now);
  _drawProjectiles(ctx, dt);
  _drawExplosions(ctx, now);
  _drawParticles(ctx, dt);
  _drawDamageLabels(ctx);
  _drawFuseCountdowns(ctx, now);
  _drawCratesFrame(ctx, dt, now);
  _drawDynamites(ctx);
  _drawMines(ctx);
  _drawTeleportPreview(ctx);
  _drawParachute(ctx);
  _drawChargeBar(ctx);
  _drawTurnAnnouncement(ctx, now);
  ctx.restore();
  _updateTimerDisplay();
}

function _updateCamera(dt) {
  const aw = _worms.find(w => w.id === _activeWormId);
  if (aw && aw.alive) {
    const camCx = (_wsSynced && _myTurn()) ? _ws.cx : aw.cx;
    _cam.tx = Math.max(0, Math.min(WORLD_W - WORLD_W, camCx - WORLD_W / 2));
    _cam.ty = 0;
  }
  _cam.x += (_cam.tx - _cam.x) * Math.min(1, 5 * dt);
  _cam.y += (_cam.ty - _cam.y) * Math.min(1, 5 * dt);
}

function _applyScreenShake(ctx, now) {
  if (now >= _shakeUntil) return;
  const mag = 5 * Math.max(0, 1 - (now - (_shakeUntil - 300)) / 300);
  ctx.translate((randomUnit() - 0.5) * mag, (randomUnit() - 0.5) * mag);
}

function _drawRope(ctx) {
  if (!_rope || !_myTurn()) return;
  const { cx: wCx, cy: wCy } = _activeWormPosition();
  const tipCx = _rope.state === 'attached' ? _rope.anchorX : _rope.cx;
  const tipCy = _rope.state === 'attached' ? _rope.anchorY : _rope.cy;
  ctx.save();
  ctx.strokeStyle = '#aaddaa';
  ctx.lineWidth   = 2;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(wCx, wCy);
  ctx.lineTo(tipCx, tipCy);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(tipCx, tipCy, 4, 0, Math.PI * 2);
  ctx.fillStyle = _rope.state === 'attached' ? '#ffdd44' : '#aaddaa';
  ctx.fill();
  ctx.restore();
}

function _drawJetpackFuel(ctx) {
  if (!_jetpackActive || !_myTurn()) return;
  const { cx: wCx, cy: wCy } = _activeWormPosition();
  const barW = 30, barH = 4;
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(wCx - barW / 2, wCy + WORM_R + 5, barW, barH);
  ctx.fillStyle = `hsl(${_jetpackFuel * 120},90%,55%)`;
  ctx.fillRect(wCx - barW / 2, wCy + WORM_R + 5, barW * _jetpackFuel, barH);
  ctx.strokeStyle = 'rgba(255,255,255,0.3)';
  ctx.lineWidth = 1;
  ctx.strokeRect(wCx - barW / 2, wCy + WORM_R + 5, barW, barH);
}

function _drawAimAndTargeting(ctx, now) {
  if (!_myTurn() || _shotFired || _animating) return;
  _drawAimCrosshair(ctx, now);
  if (TARGETED_WEAPONS.has(_selectedWeapon)) _drawAirstrikeTargeting(ctx);
}

function _drawAirstrikeTargeting(ctx) {
  const targetX = Math.max(24, Math.min(WORLD_W - 24, _mouseX));
  ctx.save();
  ctx.setLineDash([6, 5]);
  ctx.lineWidth   = 1.5;
  ctx.strokeStyle = 'rgba(255,80,80,0.75)';
  for (const ox of [-30, 0, 30]) {
    ctx.beginPath();
    ctx.moveTo(targetX + ox, 0);
    ctx.lineTo(targetX + ox, WORLD_H);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.restore();
}

function _drawProjectiles(ctx, dt) {
  const PROJ_PTS_PER_SEC = 20;
  for (const proj of _projectiles) {
    if (proj.done) continue;
    _advanceProjectileFrame(proj, dt, PROJ_PTS_PER_SEC);
    _drawProjectileTrail(ctx, proj);
    _drawProjectileHead(ctx, proj);
  }
}

function _advanceProjectileFrame(proj, dt, ptsPerSec) {
  proj.fidx = (proj.fidx ?? 0) + dt * ptsPerSec;
  proj.idx  = Math.min(proj.trajectory.length - 1, Math.floor(proj.fidx));
  if (proj.idx >= proj.trajectory.length - 1) proj.done = true;
}

function _drawProjectileTrail(ctx, proj) {
  const pw = proj.weapon ?? _selectedWeapon;
  const wdef = _weaponDef(pw) ?? WEAPONS.bazooka;
  ctx.lineWidth   = 4;
  ctx.strokeStyle = wdef.trailColor;
  ctx.beginPath();
  let drawn = 0;
  for (let k = proj.idx; k >= 0 && drawn < 14; k -= 2, drawn++) {
    const pt = proj.trajectory.at(k);
    if (!pt) continue;
    if (drawn === 0) ctx.moveTo(pt.cx, pt.cy); else ctx.lineTo(pt.cx, pt.cy);
  }
  ctx.stroke();
}

function _drawProjectileHead(ctx, proj) {
  const head = proj.trajectory.at(proj.idx);
  const prev = proj.idx > 0 ? (proj.trajectory.at(proj.idx - 1) ?? head) : head;
  if (!head || !prev) return;
  const pw = proj.weapon ?? _selectedWeapon;
  const spriteKey = _projectileSpriteKey(pw);
  const img = _assetImage(spriteKey);
  if (img?.complete && img.naturalWidth > 0) _drawProjectileSprite(ctx, img, spriteKey, head, prev);
  else _drawProjectileFallback(ctx, head, pw);
}

function _drawProjectileSprite(ctx, img, spriteKey, head, prev) {
  const angle = Math.atan2(head.cy - prev.cy, head.cx - prev.cx);
  const fCount = spriteKey === 'dynamite' ? 129 : 32;
  const frameH = Math.floor(img.naturalHeight / fCount);
  const frame = spriteKey === 'missile'
    ? Math.round(((angle + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2) * 32) % 32
    : Math.floor(Date.now() / 50) % fCount;
  const scale = 16 / Math.max(img.naturalWidth, frameH);
  const pW = img.naturalWidth * scale, pH = frameH * scale;
  ctx.save();
  ctx.translate(head.cx, head.cy);
  ctx.drawImage(img, 0, frame * frameH, img.naturalWidth, frameH, -pW/2, -pH/2, pW, pH);
  ctx.restore();
}

function _drawProjectileFallback(ctx, head, weapon) {
  const wdef = _weaponDef(weapon) ?? WEAPONS.bazooka;
  ctx.beginPath();
  ctx.arc(head.cx, head.cy, 10, 0, Math.PI * 2);
  ctx.fillStyle = wdef.color;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(head.cx, head.cy, 10, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.lineWidth = 2;
  ctx.stroke();
}

function _drawExplosions(ctx, now) {
  _explosions = _explosions.filter(ex => _drawExplosion(ctx, ex, now));
}

function _drawExplosion(ctx, ex, now) {
  const t = (now - ex.startMs) / ex.durationMs;
  if (t >= 1) return false;
  const maxR  = ex.r;
  const curR  = maxR * Math.min(1, t * 3);
  const alpha = t < 0.4 ? 1 : 1 - (t - 0.4) / 0.6;
  const ringR = maxR * (0.8 + t * 0.8);
  ctx.beginPath();
  ctx.arc(ex.cx, ex.cy, ringR, 0, Math.PI * 2);
  ctx.strokeStyle = `rgba(180,100,30,${alpha * 0.3})`;
  ctx.lineWidth   = 5 * (1 - t);
  ctx.stroke();
  const fg = ctx.createRadialGradient(ex.cx, ex.cy, 0, ex.cx, ex.cy, curR);
  fg.addColorStop(0,   `rgba(255,255,200,${alpha})`);
  fg.addColorStop(0.25,`rgba(255,200,50,${alpha * 0.95})`);
  fg.addColorStop(0.55,`rgba(255,100,10,${alpha * 0.7})`);
  fg.addColorStop(0.8, `rgba(150,40,0,${alpha * 0.4})`);
  fg.addColorStop(1,   `rgba(80,20,0,0)`);
  ctx.beginPath();
  ctx.arc(ex.cx, ex.cy, curR, 0, Math.PI * 2);
  ctx.fillStyle = fg;
  ctx.fill();
  return true;
}

function _drawParticles(ctx, dt) {
  _particles = _particles.filter(p => _drawParticle(ctx, p, dt));
}

function _drawParticle(ctx, p, dt) {
  p.cx    += p.vx * dt;
  p.cy    += p.vy * dt;
  p.vy    += 220 * dt;
  p.alpha -= 1.8 * dt;
  if (p.alpha <= 0) return false;
  ctx.beginPath();
  ctx.arc(p.cx, p.cy, p.r, 0, Math.PI * 2);
  ctx.fillStyle = p.color.replace('1)', `${p.alpha.toFixed(2)})`);
  ctx.fill();
  return true;
}

function _drawDamageLabels(ctx) {
  for (const lb of _dmgLabels) {
    if (lb.alpha <= 0) continue;
    ctx.globalAlpha = lb.alpha;
    ctx.font        = 'bold 15px monospace';
    ctx.fillStyle   = lb.killed ? '#ff4400' : '#ffee00';
    ctx.textAlign   = 'center';
    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    ctx.lineWidth   = 3;
    ctx.strokeText(lb.text, lb.cx, lb.cy);
    ctx.fillText(lb.text, lb.cx, lb.cy);
  }
  ctx.globalAlpha = 1;
  ctx.textAlign   = 'left';
}

function _drawFuseCountdowns(ctx, now) {
  for (const proj of _projectiles) {
    if (proj.done || proj.fuseMs == null) continue;
    const timeLeft = _projectileFuseSeconds(proj, now);
    if (timeLeft <= 0) continue;
    const head = proj.trajectory.at(proj.idx) ?? proj.trajectory.at(-1);
    if (head) _drawFuseCountdown(ctx, head, timeLeft);
  }
}

function _projectileFuseSeconds(proj, now) {
  const elapsed = (now - (proj.startMs ?? now)) / 1000;
  return Math.ceil(Math.max(0, proj.fuseMs / 1000 - elapsed));
}

function _drawFuseCountdown(ctx, head, timeLeft) {
  ctx.save();
  ctx.font        = `bold ${10 + timeLeft * 3}px monospace`;
  ctx.textAlign   = 'center';
  ctx.strokeStyle = 'rgba(0,0,0,0.9)';
  ctx.lineWidth   = 3;
  ctx.fillStyle   = timeLeft === 1 ? '#ff4400' : timeLeft === 2 ? '#ffcc00' : '#ffffff';
  ctx.strokeText(String(timeLeft), head.cx, head.cy - 14);
  ctx.fillText(String(timeLeft), head.cx, head.cy - 14);
  ctx.restore();
}

function _drawCratesFrame(ctx, dt, now) {
  for (const crate of _crates) {
    _updateFallingCrate(crate, dt);
    _drawCrate(ctx, crate.cx, crate.landed ? crate.cy : crate.fallingCy, crate.type, crate.weapon, !crate.landed, now);
  }
}

function _updateFallingCrate(crate, dt) {
  if (crate.landed) return;
  crate.fallingCy = (crate.fallingCy ?? -30) + 38 * dt;
  if (crate.fallingCy < crate.cy) return;
  crate.fallingCy = crate.cy;
  crate.landed = true;
  _playSound('GRENADEIMPACT', 0.35);
}

function _drawDynamites(ctx) {
  for (const dyn of _dynamites) _drawDynamite(ctx, dyn);
}

function _drawDynamite(ctx, dyn) {
  const elapsedS  = (performance.now() - dyn.placedAt) / 1000;
  const remaining = Math.max(0, dyn.fuseMs / 1000 - elapsedS);
  const flash     = remaining < 2 && Math.floor(elapsedS * 5) % 2 === 0;
  ctx.save();
  ctx.fillStyle = flash ? '#ff5555' : '#cc2222';
  ctx.fillRect(dyn.cx - 4, dyn.cy - 10, 8, 16);
  ctx.fillStyle = '#333';
  ctx.fillRect(dyn.cx - 2, dyn.cy - 13, 4, 4);
  if (Math.floor(elapsedS * 8) % 2 === 0) {
    ctx.fillStyle = '#ffdd00';
    ctx.beginPath();
    ctx.arc(dyn.cx, dyn.cy - 13, 2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle   = '#ffffff';
  ctx.font        = 'bold 9px monospace';
  ctx.textAlign   = 'center';
  ctx.strokeStyle = '#000';
  ctx.lineWidth   = 2;
  ctx.strokeText(remaining.toFixed(1), dyn.cx, dyn.cy - 17);
  ctx.fillText(remaining.toFixed(1), dyn.cx, dyn.cy - 17);
  ctx.restore();
}

function _drawMines(ctx) {
  for (const mine of _mines) _drawMine(ctx, mine);
}

function _drawMine(ctx, mine) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(mine.cx, mine.cy, 8, 0, Math.PI * 2);
  ctx.fillStyle   = '#556655';
  ctx.fill();
  ctx.strokeStyle = '#cc3300';
  ctx.lineWidth   = 2;
  ctx.stroke();
  ctx.fillStyle   = '#ff4444';
  ctx.font        = 'bold 8px monospace';
  ctx.textAlign   = 'center';
  ctx.fillText('!', mine.cx, mine.cy + 3);
  ctx.restore();
}

function _drawTeleportPreview(ctx) {
  if (_selectedWeapon !== 'teleport' || !_myTurn() || _shotFired || _animating) return;
  ctx.save();
  ctx.strokeStyle = '#aa44ff';
  ctx.lineWidth   = 1.5;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.arc(_mouseX, _mouseY, WORM_R, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
  const s = 14;
  ctx.beginPath();
  ctx.moveTo(_mouseX - s, _mouseY); ctx.lineTo(_mouseX + s, _mouseY);
  ctx.moveTo(_mouseX, _mouseY - s); ctx.lineTo(_mouseX, _mouseY + s);
  ctx.stroke();
  ctx.restore();
}

function _drawParachute(ctx) {
  if (!_myTurn() || !_ws.parachute || _ws.onGround) return;
  const aw = _worms.find(w => w.id === _activeWormId);
  if (!aw) return;
  const px = _ws.cx, py = _ws.cy;
  ctx.save();
  ctx.strokeStyle = '#fff';
  ctx.fillStyle   = 'rgba(220,220,255,0.75)';
  ctx.lineWidth   = 1.5;
  ctx.beginPath();
  ctx.arc(px, py - WORM_R - 22, 18, Math.PI, 0);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.strokeStyle = 'rgba(200,200,200,0.8)';
  ctx.lineWidth   = 0.8;
  for (const [ox, oy] of [[-18,0],[0,0],[18,0],[-10,-16],[10,-16]]) {
    ctx.beginPath();
    ctx.moveTo(px + ox, py - WORM_R - 22 + oy);
    ctx.lineTo(px, py - WORM_R);
    ctx.stroke();
  }
  ctx.restore();
}

function _drawChargeBar(ctx) {
  if (_chargeStart === null || !_myTurn() || _shotFired) return;
  const aw = _worms.find(w => w.id === _activeWormId);
  if (!aw) return;
  const chargePct = Math.min(1, (Date.now() - _chargeStart) / 1500);
  const barW = 90, barH = 10;
  const wCx  = _wsSynced ? _ws.cx : aw.cx;
  const wCy  = _wsSynced ? _ws.cy : aw.cy;
  const bx = wCx - barW / 2, by = wCy - WORM_R - 26;
  ctx.fillStyle = '#000';
  ctx.fillRect(bx - 1, by - 1, barW + 2, barH + 2);
  ctx.fillStyle = chargePct < 0.5 ? '#44ee44' : chargePct < 0.8 ? '#ffcc00' : '#ff4400';
  ctx.fillRect(bx, by, barW * chargePct, barH);
  ctx.strokeStyle = '#888';
  ctx.lineWidth = 1;
  ctx.strokeRect(bx, by, barW, barH);
  ctx.font      = 'bold 8px monospace';
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.fillText(`${t('games.worms.power')} ${Math.round(chargePct * 100)}%`, wCx, by - 3);
  ctx.textAlign = 'left';
}

function _drawTurnAnnouncement(ctx, now) {
  if (!_turnAnnouncement) return;
  const elapsed = now - _turnAnnouncement.startMs;
  if (elapsed >= 2400) {
    _turnAnnouncement = null;
    return;
  }
  const alpha = elapsed < 1600 ? 1 : 1 - (elapsed - 1600) / 800;
  const cy    = WORLD_H * 0.38;
  ctx.save();
  ctx.globalAlpha = alpha;
  const pad = 22, tw = ctx.measureText(_turnAnnouncement.text).width + pad * 2;
  ctx.fillStyle = 'rgba(0,0,0,0.62)';
  _roundRect(ctx, WORLD_W / 2 - tw / 2, cy - 18, tw, 34, 8);
  ctx.fill();
  ctx.font      = 'bold 16px monospace';
  ctx.textAlign = 'center';
  ctx.fillStyle = _turnAnnouncement.color;
  ctx.strokeStyle = 'rgba(0,0,0,0.7)';
  ctx.lineWidth   = 3;
  ctx.strokeText(_turnAnnouncement.text, WORLD_W / 2, cy + 4);
  ctx.fillText(_turnAnnouncement.text, WORLD_W / 2, cy + 4);
  ctx.globalAlpha = 1;
  ctx.textAlign   = 'left';
  ctx.restore();
}

function _updateTimerDisplay() {
  if (!_timerEl || _turnDeadline <= 0) return;
  if (_retreating) {
    const s = Math.max(0, Math.ceil((_retreatEnd - Date.now()) / 1000));
    _timerEl.textContent = t('games.worms.retreatTimer', { seconds: String(s).padStart(2, '0') });
    _timerEl.style.color = '#88ddff';
    return;
  }
  const s = Math.max(0, Math.ceil((_turnDeadline - Date.now()) / 1000));
  _timerEl.textContent = `⏱ ${String(s).padStart(2, '0')}s`;
  _timerEl.style.color = s <= 5 ? '#ff2222' : s <= 8 ? '#ff8844' : '#ffcc00';
}

function _drawAimCrosshair(ctx, now) {
  const aw = _worms.find(w => w.id === _activeWormId);
  if (!aw) return;
  const wCx = _wsSynced ? _ws.cx : aw.cx;
  const wCy = _wsSynced ? _ws.cy : aw.cy;
  // Dashed aim line
  const len = 44;
  const tx  = wCx + Math.cos(_aimAngle) * len;
  const ty  = wCy + Math.sin(_aimAngle) * len;
  ctx.save();
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = 'rgba(255,255,255,0.45)';
  ctx.lineWidth   = 1.5;
  ctx.beginPath();
  ctx.moveTo(wCx, wCy);
  ctx.lineTo(tx, ty);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();

  // Animated crosshair sprite (crshairr — 32 frames, 50ms)
  const chImg = _assetImage('crshairr');
  if (chImg?.complete && chImg.naturalWidth > 0) {
    const CF = 32, CMS = 50;
    const cf = Math.floor(now / CMS) % CF;
    const cfh = Math.floor(chImg.naturalHeight / CF);
    const csz = 24;
    ctx.drawImage(chImg, 0, cf * cfh, chImg.naturalWidth, cfh, tx - csz/2, ty - csz/2, csz, csz);
  } else {
    ctx.beginPath();
    ctx.arc(tx, ty, 4, 0, Math.PI * 2);
    ctx.fillStyle = _weaponDef(_selectedWeapon)?.color ?? '#ff7700';
    ctx.fill();
  }
}

function _tickDmgLabels(dt) {
  for (const lb of _dmgLabels) {
    lb.cy  -= 30 * dt;
    lb.alpha -= 0.6 * dt;
  }
  _dmgLabels = _dmgLabels.filter(lb => lb.alpha > 0);
}

// ── HUD updates ────────────────────────────────────────────────────────────────
function _updateHUD() {
  if (!_turnLabel) return;
  const pl  = _players.find(p => p.userId === _currentTurn);
  const aw  = _worms.find(w => w.id === _activeWormId);
  const rnd = _round ?? 1;
  if (pl && aw) {
    const nameEl = renderUserName(pl, { fallbackPseudo: '?' });
    const wormEl = _el('span', { style: { color: '#ccc' }}, aw.name);
  _turnLabel.replaceChildren(`${t('games.worms.turnOf')} `, nameEl, ' — ', wormEl);
    if (_currentTurn === _myUserId) _turnLabel.append(' ', _el('span', { style: { color: '#ff0' }}, t('games.worms.you')));
  }
  if (_windEl) {
    const arrow = _wind > 0 ? '→' : _wind < 0 ? '←' : '·';
    const str   = Math.abs(_wind);
    const roundLabel = _suddenDeath ? `<span style="color:#f44">💀R${rnd}</span>` : `<span style="color:#aaa">R${rnd}</span>`;
    setSafeHtml(_windEl, (str === 0 ? `💨 ${t('games.worms.calmWind')}` : `💨 ${arrow} ${str}`) + ' ' + roundLabel);
  }
  _updateHealthBar();
  _updateWeaponBtns();
  _updateFuseDisplay();
}

function _updateHealthBar() {
  if (!_healthEl) return;
  _healthEl.replaceChildren();
  for (const p of _players) {
    const mine = _worms.filter(w => w.playerId === p.userId);
    const row  = _el('div', { style: { display: 'flex', alignItems: 'center', gap: '3px', marginRight: '10px', flexWrap: 'wrap' }});
    const nameSpan = _el('span', { style: { fontSize: '11px', marginRight: '2px' }});
    nameSpan.append(renderUserName(p, { fallbackPseudo: '?' }), ':');
    row.appendChild(nameSpan);
    for (const w of mine) {
      const chip = _el('span', { style: {
        fontSize: '10px', padding: '1px 4px', borderRadius: '3px', marginRight: '2px',
        background: w.alive ? (w.id === _activeWormId ? 'rgba(255,255,100,0.18)' : 'rgba(0,0,0,0.3)') : '#1a1a1a',
        color: w.alive ? (w.id === _activeWormId ? '#ffff88' : '#ccc') : '#555',
        border: w.id === _activeWormId ? '1px solid rgba(255,255,100,0.5)' : '1px solid rgba(255,255,255,0.08)',
        textDecoration: w.alive ? 'none' : 'line-through',
      }});
      chip.textContent = `${w.name ?? '?'} ${w.alive ? w.hp : '☠'}`;
      row.appendChild(chip);
    }
    _healthEl.appendChild(row);
  }
}

function _updateWeaponBtns() {
  for (const [key, btn] of Object.entries(_weaponBtns)) {
    const active  = key === _selectedWeapon && _myTurn();
    const count   = Object.hasOwn(_ammo, key) ? Reflect.get(_ammo, key) : undefined;
    const noAmmo  = !_unlimitedAmmo(count) && count <= 0;
    btn.style.background = active ? '#2a4a1a' : '#1a1a1a';
    btn.style.border = `1px solid ${active ? '#66dd33' : '#333'}`;
    btn.style.color  = noAmmo ? '#444' : (active ? '#66dd33' : '#888');
    btn.style.opacity = noAmmo ? '0.45' : '1';
    btn.disabled = noAmmo;
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    // Update ammo badge
    const ammoEl = btn.querySelector('[data-ammo]');
    if (ammoEl) {
      ammoEl.textContent = _unlimitedAmmo(count) ? '∞' : `×${count}`;
      ammoEl.style.color = !_unlimitedAmmo(count) && count <= 1 ? '#ff6644' : '#ffcc44';
    }
  }
}

function _updateFuseDisplay() {
  if (!_fuseEl) return;
  const isFuse = FUSE_WEAPONS.has(_selectedWeapon) && _myTurn() && !_shotFired;
  if (isFuse) {
    _fuseEl.textContent = `⏱ ${_grenadefuse}s`;
    _fuseEl.style.display = '';
  } else {
    _fuseEl.style.display = 'none';
  }
}

function _selectWeapon(key) {
  if (!_weaponDef(key)) return;
  const count = Object.hasOwn(_ammo, key) ? Reflect.get(_ammo, key) : Infinity;
  if (!_unlimitedAmmo(count) && count <= 0) {
    _pushSys?.(t('games.worms.noAmmoForWeapon'));
    return;
  }
  _selectedWeapon = key;
  _updateWeaponBtns();
  _updateFuseDisplay();
}

// ── Rope pendulum physics (called when _rope.state === 'attached') ─────────
function _stepRopeAttached(dt, movingL, movingR) {
  const ax = _rope.anchorX, ay = _rope.anchorY;
  // Reel in / out
  if (_keys.has('z') || _keys.has('arrowup'))   _rope.len = Math.max(25,  _rope.len - 80 * dt);
  if (_keys.has('s') || _keys.has('arrowdown')) _rope.len = Math.min(260, _rope.len + 80 * dt);
  // Gravity on worm
  _ws.vy += GRAVITY * dt;
  // L/R apply tangential swing force
  if (movingL) _ws.vx -= 150 * dt;
  if (movingR) _ws.vx += 150 * dt;
  // Light air friction
  _ws.vx *= Math.exp(-0.6 * dt);
  // Integrate
  _ws.cx += _ws.vx * dt;
  _ws.cy += _ws.vy * dt;
  // Radial constraint: keep worm on circle of radius _rope.len
  const dx = _ws.cx - ax, dy = _ws.cy - ay;
  const dist = Math.sqrt(dx * dx + dy * dy) || 0.001;
  if (dist > _rope.len) {
    const nx = dx / dist, ny = dy / dist;
    const radV = _ws.vx * nx + _ws.vy * ny;
    if (radV > 0) { _ws.vx -= radV * nx; _ws.vy -= radV * ny; }  // cancel outward velocity
    _ws.cx = ax + nx * _rope.len;
    _ws.cy = ay + ny * _rope.len;
  }
  // Terrain wall bounce while swinging
  if (_terrain && _clientSolid(_ws.cx, _ws.cy)) {
    _ws.vx *= -0.35; _ws.vy *= -0.35;
  }
  // Landing: auto-detach rope when worm touches ground
  if (_ws.vy > 0 && _terrain) {
    const surY = _surfaceAt(_ws.cx);
    if (_ws.cy >= surY) {
      _ws.cy      = surY; _ws.vy = 0; _ws.vx *= 0.35;
      _ws.onGround = true;
      _rope        = null;
      _playSound('WormLanding', 0.4);
    }
  }
  // Water: fall through, rope detaches
  if (_ws.cy >= _waterLevel) _rope = null;
  // Bounds
  _ws.cx = Math.max(WORM_R, Math.min(WORLD_W - WORM_R, _ws.cx));
}

// ── Jetpack thrust physics ───────────────────────────────────────────────
function _stepJetpackPhysics(dt, movingL, movingR) {
  const thrusting = _jetpackThrusting();
  _applyJetpackVertical(dt, thrusting);
  _applyJetpackHorizontal(dt, movingL, movingR);
  _moveJetpackWorm(dt);
  _landJetpackWorm();
  if (_jetpackFuel <= 0 && !thrusting) _jetpackActive = false;
  _ws.cx = Math.max(WORM_R, Math.min(WORLD_W - WORM_R, _ws.cx));
}

function _jetpackThrusting() {
  return _jetpackFuel > 0 && (_keys.has('z') || _keys.has('arrowup') || _keys.has(' '));
}

function _applyJetpackVertical(dt, thrusting) {
  const THRUST = 340;
  const DRAIN  = 0.22;  // ~4.5 s to empty tank
  if (thrusting) {
    _ws.vy = Math.max(_ws.vy - THRUST * dt, -220);
    _jetpackFuel = Math.max(0, _jetpackFuel - DRAIN * dt);
    if (randomUnit() < 0.5) _spawnParticles(_ws.cx, _ws.cy + WORM_R, 1);
  } else {
    _ws.vy += GRAVITY * 0.65 * dt;  // partial gravity without thrust
  }
  _ws.vy = Math.min(_ws.vy, 400);
}

function _applyJetpackHorizontal(dt, movingL, movingR) {
  const H_THRUST = 200;
  if (movingL) { _ws.vx -= H_THRUST * dt; _ws.facing = -1; }
  if (movingR) { _ws.vx += H_THRUST * dt; _ws.facing =  1; }
  _ws.vx *= Math.exp(-1.5 * dt);
}

function _moveJetpackWorm(dt) {
  const newCx = Math.max(WORM_R, Math.min(WORLD_W - WORM_R, _ws.cx + _ws.vx * dt));
  const leadX = newCx + Math.sign(_ws.vx || 1) * WORM_R;
  if (!_terrain || !_clientSolid(leadX, _ws.cy)) _ws.cx = newCx;
  else _ws.vx = 0;
  _ws.cy += _ws.vy * dt;
  if (_ws.cy < WORM_R) { _ws.cy = WORM_R; _ws.vy = 0; }
}

function _landJetpackWorm() {
  if (!_terrain || _ws.vy < 0) return;
  const surY = _surfaceAt(_ws.cx);
  if (_ws.cy < surY) return;
  _ws.cy = surY; _ws.vy = 0; _ws.vx = 0;
  _ws.onGround   = true;
  _jetpackActive = false;
  _playSound('WormLanding', 0.45);
}

// ── Physics (active worm, my turn only) ─────────────────────────────────────
function _initWsTurn() {
  if (!_myTurn()) return;
  const aw = _worms.find(w => w.id === _activeWormId);
  if (!aw) return;
  _ws.cx = aw.cx;
  _ws.cy = aw.cy;
  _ws.vx = 0;
  _ws.vy = 0;
  _ws.onGround      = true;
  _ws.facing        = 1;
  _ws.walking       = false;
  _ws.backflipping  = false;
  _ws.backflipAngle = 0;
  _wsSynced         = true;
  _rope             = null;
  _jetpackActive    = false;
  _jetpackFuel      = 0;
}

function _physicsStep(dt) {
  if (!_canStepActiveWorm()) return;
  const input = _readWormPhysicsInput(dt);
  _updateGroundFacing(input);
  _tryForwardHop(input);
  _tryBackflip(input);
  _stepBackflipSpin(dt);
  _stepRopeHookFlight(dt);

  const overridePhys = _stepToolOverridePhysics(dt, input);
  if (!overridePhys) _stepNormalWormPhysics(dt, input);

  _updateWalkSounds(dt);
  _updateWeaponTakeoutAnim();
  _playTimerTickIfNeeded();
  _ws.cx = Math.max(WORM_R, Math.min(WORLD_W - WORM_R, _ws.cx));
  _collectNearbyCrate();
  _mirrorActiveWormPosition();
  _syncActiveWormPosition();
}

function _canStepActiveWorm() {
  // Allow physics to keep running when rope/jetpack is active (even though _shotFired=true)
  const canMoveAfterAction = _rope !== null || _jetpackActive || _movementToolUsed || _retreating;
  return _myTurn() && _wsSynced && (!_shotFired || canMoveAfterAction) && !_animating;
}

function _readWormPhysicsInput(dt) {
  const input = {
    movingL: _keys.has('q') || _keys.has('arrowleft'),
    movingR: _keys.has('d') || _keys.has('arrowright'),
    jumpKey: _keys.has(' '),
    bfKey:   _keys.has('backspace'),
  };
  if (_keys.has('z') || _keys.has('arrowup'))   _aimAngle -= 1.8 * dt;
  if (_keys.has('s') || _keys.has('arrowdown')) _aimAngle += 1.8 * dt;
  return input;
}

function _updateGroundFacing({ movingL, movingR }) {
  if (!_ws.onGround) return;
  if (movingL && !movingR) _ws.facing = -1;
  if (movingR && !movingL) _ws.facing =  1;
}

function _tryForwardHop({ jumpKey }) {
  if (!jumpKey || !_ws.onGround || _ws.backflipping) return;
  _ws.vy       = JUMP_FWD_VY;
  _ws.vx       = _ws.facing * JUMP_FWD_VX;
  _ws.onGround = false;
  _ws.walking  = false;
  _keys.delete(' ');
  _playSound('JUMP1', 0.5);
}

function _tryBackflip({ bfKey }) {
  if (!bfKey || !_ws.onGround || _ws.backflipping) return;
  _ws.vy            = BACKFLIP_VY;
  _ws.vx            = -_ws.facing * BACKFLIP_VX;  // opposite = backward
  _ws.onGround      = false;
  _ws.backflipping  = true;
  _ws.backflipAngle = 0;
  _ws.walking       = false;
  _keys.delete('backspace');
  _playSound('JUMP1', 0.5);
}

function _stepBackflipSpin(dt) {
  if (_ws.backflipping) _ws.backflipAngle -= 5 * dt;  // ~286°/s — one full rotation per flight
}

function _stepRopeHookFlight(dt) {
  if (_rope?.state !== 'flying') return;
  _rope.vy += GRAVITY * dt;
  _rope.cx += _rope.vx * dt;
  _rope.cy += _rope.vy * dt;
  if (_terrain && _clientSolid(_rope.cx, _rope.cy)) _attachRopeHook();
  if (_rope && (_rope.cx < 0 || _rope.cx > WORLD_W || _rope.cy > _waterLevel)) _rope = null;
}

function _attachRopeHook() {
  _rope.state   = 'attached';
  _rope.anchorX = _rope.cx;
  _rope.anchorY = _rope.cy;
  _rope.len     = Math.hypot(_ws.cx - _rope.anchorX, _ws.cy - _rope.anchorY);
  _ws.onGround  = false;  // launch worm off ground to start swinging
  _playSound('GRENADEIMPACT', 0.25);
}

function _stepToolOverridePhysics(dt, { movingL, movingR }) {
  const overridePhys = _rope?.state === 'attached' || _jetpackActive;
  if (_rope?.state === 'attached') _stepRopeAttached(dt, movingL, movingR);
  if (_jetpackActive)              _stepJetpackPhysics(dt, movingL, movingR);
  return overridePhys;
}

function _stepNormalWormPhysics(dt, input) {
  _applyWormGravity(dt);
  _walkGroundWorm(dt, input);
  _driftAirborneWorm(dt);
  _settleVerticalWorm(dt);
}

function _applyWormGravity(dt) {
  if (_ws.onGround) return;
  _ws.vy += GRAVITY * dt;
  if (_ws.vy > 260 && !_ws.parachute) {
    _ws.parachute = true;
    _playSound('ParachuteOpen', 0.55);
  }
  if (_ws.parachute) {
    _ws.vy = Math.min(_ws.vy, 65);   // gentle terminal velocity
    _ws.vx *= Math.exp(-1.5 * dt);   // extra air resistance
  } else {
    _ws.vy = Math.min(_ws.vy, 600);
  }
}

function _walkGroundWorm(dt, { movingL, movingR }) {
  _ws.walking = false;
  if (!_ws.onGround || (!movingL && !movingR) || !_terrain) return;
  _ws.walking = true;
  const dir  = movingL ? -1 : 1;
  const newX = Math.max(WORM_R, Math.min(WORLD_W - WORM_R, _ws.cx + dir * WALK_SPD * dt));
  const surY = _surfaceAt(newX);
  const step = _ws.cy - surY;  // >0 = slope up, <0 = slope down
  if (_walkBlockedByWorm(newX) || step > 15) return;
  if (step < -18) {
    _ws.cx = newX;
    _ws.onGround = false;
    _ws.vy = 0;
    return;
  }
  _ws.cx = newX;
  _ws.cy = surY;
}

function _walkBlockedByWorm(newX) {
  for (const w of _worms) {
    if (w.id === _activeWormId || !w.alive) continue;
    const dx = newX - w.cx, dy = _ws.cy - w.cy;
    if (Math.abs(dx) < WORM_R * 2 && Math.abs(dy) < WORM_R * 1.5) return true;
  }
  return false;
}

function _driftAirborneWorm(dt) {
  if (_ws.onGround) return;
  _ws.vx *= Math.exp(-1.8 * dt);
  const newCx = Math.max(WORM_R, Math.min(WORLD_W - WORM_R, _ws.cx + _ws.vx * dt));
  const leadX = newCx + (Math.sign(_ws.vx) * WORM_R * 0.8);
  if (_terrain && _airWallAt(leadX)) _ws.vx = 0;
  else _ws.cx = newCx;
}

function _airWallAt(leadX) {
  return _clientSolid(leadX, _ws.cy - WORM_R * 0.8) ||
    _clientSolid(leadX, _ws.cy) ||
    _clientSolid(leadX, _ws.cy + WORM_R * 0.5);
}

function _settleVerticalWorm(dt) {
  if (_ws.onGround || !_terrain) return;
  const prevCy = _ws.cy;
  _ws.cy += _ws.vy * dt;
  const surY = _surfaceAt(_ws.cx);
  if (_ws.vy >= 0 && _ws.cy >= surY) _tryLandActiveWorm(prevCy, surY);
  if (_ws.vy < 0 && _clientSolid(_ws.cx, _ws.cy - WORM_R)) _ws.vy = 0;
}

function _tryLandActiveWorm(prevCy, surY) {
  if (prevCy < surY + WORM_R || _ws.cy - surY < WORM_R * 3) _landActiveWorm(surY, _ws.vy);
}

function _landActiveWorm(surY, speed) {
  _ws.cy            = surY;
  _ws.vy            = 0;
  _ws.vx            = 0;
  _ws.onGround      = true;
  _ws.backflipping  = false;
  _ws.backflipAngle = 0;
  _ws.parachute     = false;
  if (speed > 150) _playSound('WormLanding', 0.55);
}

function _updateWalkSounds(dt) {
  if (!_ws.walking) {
    _walkSoundTimer = 0;
    return;
  }
  _walkSoundTimer -= dt;
  if (_walkSoundTimer > 0) return;
  _walkSoundTimer = WALK_SOUND_INTERVAL;
  _playSound(_walkSoundStep % 2 === 0 ? 'WalkExpand' : 'WalkCompress', 0.25);
  _walkSoundStep++;
}

function _updateWeaponTakeoutAnim() {
  if (!_myTurn() || _prevWeapon === _selectedWeapon) return;
  _prevWeapon = _selectedWeapon;
  const wdef = _weaponAnimDef(_selectedWeapon);
  if (!wdef?.takeOut) return;
  _weaponAnim = { ...wdef.takeOut, phase: 'takeout', startMs: performance.now() };
  const takeoutDur = wdef.takeOut.frames * wdef.takeOut.ms;
  scope.timeout(() => {
    if (_prevWeapon !== _selectedWeapon) return;
    if (wdef.aim) _weaponAnim = { ...wdef.aim, phase: 'aim', startMs: performance.now() };
    else _weaponAnim = null;
  }, takeoutDur);
}

function _playTimerTickIfNeeded() {
  if (_turnDeadline <= 0) return;
  const msLeft = _turnDeadline - Date.now();
  const sLeft  = Math.ceil(msLeft / 1000);
  if (sLeft > 5 || sLeft <= 0 || !_myTurn() || _playedTimerTicks.has(sLeft)) return;
  _playedTimerTicks.add(sLeft);
  _playSound('TIMERTICK', 0.6);
  scope.timeout(() => { _playedTimerTicks.delete(sLeft); }, 950);
}

function _collectNearbyCrate() {
  if (!_ws.onGround) return;
  for (const crate of _crates) {
    if (!crate.landed) continue;
    const dx = _ws.cx - crate.cx, dy = _ws.cy - crate.cy;
    if (dx * dx + dy * dy >= (WORM_R + 14) * (WORM_R + 14)) continue;
    _socket.emit('worms:collect_crate', { roomId: _roomId, crateId: crate.id });
    _crates = _crates.filter(c => c.id !== crate.id);
    break;
  }
}

function _mirrorActiveWormPosition() {
  const lw = _worms.find(w => w.id === _activeWormId);
  if (lw) { lw.cx = Math.round(_ws.cx); lw.cy = Math.round(_ws.cy); }
}

function _syncActiveWormPosition() {
  if (Date.now() - _ws._lastSync <= 80) return;
  _ws._lastSync = Date.now();
  _socket.emit('worms:pos', { roomId: _roomId, wormId: _activeWormId, cx: _ws.cx, cy: _ws.cy });
}
function _terrainIndexAt(x, y) {
  if (x < 0 || x >= WORLD_W || y < 0 || y >= WORLD_H) return null;
  const xi = Math.max(0, Math.min(WORLD_W - 1, Math.floor(x)));
  const yi = Math.max(0, Math.min(WORLD_H - 1, Math.floor(y)));
  return { xi, yi, maskIndex: yi * WORLD_W + xi };
}

function _pointCarvedByHole(x, y) {
  return _holes.some(h => {
    const dx = x - h.cx, dy = y - h.cy;
    return dx * dx + dy * dy <= h.r * h.r;
  });
}

function _clientSolid(x, y) {
  const pos = _terrainIndexAt(x, y);
  if (!pos || _pointCarvedByHole(x, y)) return false;
  if (_terrainMask) return _terrainMask.at(pos.maskIndex) === 1;
  return _terrain ? y >= (_terrain.at(pos.xi) ?? WORLD_H) : false;
}

function _surfaceAt(cx) {
  if (!_terrain) return WORLD_H / 2;
  const xi = Math.max(0, Math.min(WORLD_W - 1, Math.round(cx)));
  let y = _terrain.at(xi) ?? WORLD_H;
  if (_holes.length === 0) return Math.max(0, y - WORM_R);
  // Scan down from terrain base to find solid Y through holes
  while (y < _waterLevel) {
    if (_clientSolid(xi, y)) return Math.max(0, y - WORM_R);
    y++;
  }
  return _waterLevel;
}

function _updateAim() {
  if (!_myTurn() || _shotFired) return;
  // Don't override keyboard aim if W/S is currently held
  if (_keys.has('z') || _keys.has('s') || _keys.has('arrowup') || _keys.has('arrowdown')) return;
  const aw = _worms.find(w => w.id === _activeWormId);
  if (!aw) return;
  const awCx = _wsSynced ? _ws.cx : aw.cx;
  const awCy = _wsSynced ? _ws.cy : aw.cy;
  _aimAngle = Math.atan2(_mouseY - awCy, _mouseX - awCx);
  if (Math.cos(_aimAngle) > 0) _ws.facing = 1;
  else if (Math.cos(_aimAngle) < 0) _ws.facing = -1;
}

function _canChargeShot() {
  return _myTurn() && !_shotFired && !_animating;
}

function _beginCharge() {
  _chargeStart = Date.now();
  _playSound('THROWPOWERUP', 0.35);
}

function _releaseCharge() {
  if (_chargeStart !== null && _canChargeShot()) {
    _power = Math.max(0.08, Math.min(1, (Date.now() - _chargeStart) / 1500));
    _chargeStart = null;
    _playRandomSpeech('fire');
    _doFire();
  } else {
    _chargeStart = null;
  }
}

function _updatePointerWorld(e) {
  if (!_canvas) return;
  const rect = _canvas.getBoundingClientRect();
  const aspect = WORLD_W / WORLD_H;
  const rAspect = rect.width / rect.height;
  let cw, ch, cx0, cy0;
  if (rAspect > aspect) {
    ch = rect.height; cw = ch * aspect;
    cx0 = rect.left + (rect.width - cw) / 2; cy0 = rect.top;
  } else {
    cw = rect.width; ch = cw / aspect;
    cx0 = rect.left; cy0 = rect.top + (rect.height - ch) / 2;
  }
  if (cw <= 0 || ch <= 0) return;
  _mouseX = Math.max(0, Math.min(WORLD_W, (e.clientX - cx0) * (WORLD_W / cw)));
  _mouseY = Math.max(0, Math.min(WORLD_H, (e.clientY - cy0) * (WORLD_H / ch)));
  _updateAim();
}

// ── Input binding ────────────────────────────────────────────────────────────
function _bindGameInput() {
  _keyAbort = new AbortController();
  const sig = { signal: _keyAbort.signal };

  const stop = (e) => {
    const k = e.key.toLowerCase();
    if (['q','d','z','s',' ','arrowleft','arrowright','arrowup','arrowdown','backspace'].includes(k)) {
      e.preventDefault();
    }
  };

  scope.on(document, 'keydown', (e) => {
    if (!arenaInput.owns(e)) return;
    stop(e);
    const k = e.key.toLowerCase();
    _keys.add(k);
    if (!_handleFuseKey(k)) _handleWeaponHotkey(k);
    _handleWormCycleKey(e, k);
  }, sig);

  scope.on(document, 'keyup', (e) => {
    if (!arenaInput.owns(e)) return;
    _keys.delete(e.key.toLowerCase());
  }, sig);

  _canvas?.addEventListener('pointermove', (e) => {
    _updatePointerWorld(e);
  }, sig);

  _canvas?.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !_myTurn() || _shotFired || _animating) return;
    e.preventDefault();
    _updatePointerWorld(e);
    _canvas.setPointerCapture?.(e.pointerId);
    // Teleport: single click = set target + fire immediately
    if (_selectedWeapon === 'teleport') {
      _teleportTarget = { x: _mouseX, y: _mouseY };
      _power = 1;
      _playRandomSpeech('fire');
      _doFire();
      return;
    }
    _beginCharge();
  }, sig);

  _canvas?.addEventListener('pointerup', (e) => {
    if (e.button !== 0) return;
    _releaseCharge();
  }, sig);

  _canvas?.addEventListener('pointercancel', () => {
    _chargeStart = null;
  }, sig);

  // Enter key = fire (like original)
  scope.on(document, 'keydown', (e) => {
    if (!arenaInput.owns(e)) return;
    if (e.key === 'Enter' && _canChargeShot()) {
      e.preventDefault();
      if (_chargeStart === null) _beginCharge();
    }
  }, sig);
  scope.on(document, 'keyup', (e) => {
    if (!arenaInput.owns(e)) return;
    if (e.key === 'Enter' && _chargeStart !== null) _releaseCharge();
  }, sig);
}

const WORM_WEAPON_HOTKEYS = {
  '1': 'bazooka',
  '2': 'hand_grenade',
  '3': 'cluster_bomb',
  '4': 'shotgun',
  '5': 'minigun',
  '6': 'mortar',
  '7': 'airstrike',
  '8': 'drill',
  '9': 'dynamite',
  '0': 'holy_grenade',
  a: 'banana_bomb',
  e: 'napalm',
  r: 'land_mine',
  t: 'ninja_rope',
  y: 'jetpack',
  u: 'bat',
  i: 'teleport',
};

function _handleFuseKey(k) {
  const canSetFuse = FUSE_WEAPONS.has(_selectedWeapon) && _myTurn() && !_shotFired && !_animating;
  if (!canSetFuse || !['1', '2', '3', '4', '5'].includes(k)) return false;
  _grenadefuse = parseInt(k);
  _updateFuseDisplay();
  return true;
}

function _handleWeaponHotkey(k) {
  const weapon = WORM_WEAPON_HOTKEYS[String(k)];
  if (weapon) _selectWeapon(weapon);
}

function _handleWormCycleKey(e, k) {
  if (k !== 'c' || e.repeat || !_myTurn() || _shotFired || _animating) return;
  e.preventDefault();
  const myWorms = _worms.filter(w => w.playerId === _myUserId && w.alive);
  if (myWorms.length <= 1) return;
  const cur = myWorms.findIndex(w => w.id === _activeWormId);
  const next = myWorms[(cur + 1) % myWorms.length];
  _socket.emit('worms:select_worm', { roomId: _roomId, wormId: next.id });
}
function _unbindGameInput() {
  if (_keyAbort) { _keyAbort.abort(); _keyAbort = null; }
  _keys.clear();
  _chargeStart = null;
}

function _doFire() {
  if (!_myTurn() || _shotFired || _animating) return;

  // ── Ninja rope: fire hook or release
  if (_selectedWeapon === 'ninja_rope') {
    if (!_rope) {
      _socket.emit('worms:use_tool', { roomId: _roomId, weapon: 'ninja_rope' });
      const hookSpd = 530;
      _rope = {
        state: 'flying',
        cx: _ws.cx + Math.cos(_aimAngle) * (WORM_R + 6),
        cy: _ws.cy + Math.sin(_aimAngle) * (WORM_R + 6),
        vx: Math.cos(_aimAngle) * hookSpd,
        vy: Math.sin(_aimAngle) * hookSpd,
        anchorX: 0, anchorY: 0, len: 0,
      };
      _shotFired = true;  // one rope use per turn
      _movementToolUsed = true;
      _playSound('THROWRELEASE', 0.4);
    } else {
      _rope = null;  // second press = release rope
    }
    return;
  }

  // ── Jetpack: activate thrusters
  if (_selectedWeapon === 'jetpack') {
    if (!_jetpackActive) {
      _socket.emit('worms:use_tool', { roomId: _roomId, weapon: 'jetpack' });
      _jetpackActive = true;
      _jetpackFuel   = 1.0;
      _ws.onGround   = false;
      _ws.vy         = -40;  // small liftoff nudge
      _shotFired     = true;
      _movementToolUsed = true;
      _playSound('THROWRELEASE', 0.45);
    }
    return;
  }

  // ── Teleport: fire immediately to clicked position
  if (_selectedWeapon === 'teleport') {
    if (_teleportTarget) {
      _shotFired = true;
      _socket.emit('worms:fire', {
        roomId: _roomId, angle: 0, power: 1, weapon: 'teleport',
        targetX: _teleportTarget.x, targetY: _teleportTarget.y,
      });
      _teleportTarget = null;
    }
    return;
  }

  // ── Normal weapon fire
  _shotFired = true;
  _socket.emit('worms:fire', {
    roomId: _roomId,
    angle:  _aimAngle,
    power:  _power,
    weapon: _selectedWeapon,
    targetX: TARGETED_WEAPONS.has(_selectedWeapon) ? _mouseX : undefined,
    fuseMs: FUSE_WEAPONS.has(_selectedWeapon) ? _grenadefuse * 1000
           : _selectedWeapon === 'holy_grenade' ? 3000 : undefined,
  });
}

function _applyTerrainHoles(newHoles) {
  const holes = newHoles ?? [];
  for (const h of holes) _holes.push(h);
  if (holes.length > 0) _redrawTerrain();
  return holes;
}

function _playHoleExplosions(newHoles, particleCount, shakeMs) {
  const holes = newHoles ?? [];
  if (holes.length === 0) return false;
  for (const h of holes) {
    _explosions.push({ cx: h.cx, cy: h.cy, r: Math.max(30, h.r), startMs: performance.now(), durationMs: 520 });
    _spawnParticles(h.cx, h.cy, particleCount);
  }
  _shakeUntil = performance.now() + shakeMs;
  _playExplosionSound();
  return true;
}

function _nearestExplosionHole(worm, holes) {
  let bestHole = null, bestDist2 = Infinity;
  for (const h of holes ?? []) {
    const dist2 = (worm.cx - h.cx) ** 2 + (worm.cy - h.cy) ** 2;
    if (dist2 < bestDist2) { bestDist2 = dist2; bestHole = h; }
  }
  return { hole: bestHole, dist2: bestDist2 };
}

function _bumpDamagedWorms(wormDamages, newHoles, options = {}) {
  for (const d of wormDamages ?? []) {
    const tw = _worms.find(w => w.id === d.wormId);
    if (!tw || !tw.alive) continue;
    const nearest = _nearestExplosionHole(tw, newHoles);
    if (nearest.hole) {
      const dist = Math.sqrt(nearest.dist2) || 1;
      const nx = (tw.cx - nearest.hole.cx) / dist, ny = (tw.cy - nearest.hole.cy) / dist;
      const str = Math.min(1, nearest.hole.r / Math.max(dist, 1)) * (60 + d.damage * 0.9);
      _wormBumps.set(tw.id, { vx: nx * str, vy: ny * str - 55, dx: 0, dy: 0 });
    } else if (options.bat) {
      const str = 75;
      _wormBumps.set(tw.id, {
        vx: Math.cos(_aimAngle) * str,
        vy: -Math.abs(Math.sin(_aimAngle)) * str - 35,
        dx: 0, dy: 0,
      });
    }
  }
}

function _applyWormStates(worms, options = {}) {
  for (const uw of worms ?? []) {
    const lw = _worms.find(w => w.id === uw.id);
    if (!lw) continue;
    const wasAlive = lw.alive;
    lw.hp = uw.hp; lw.alive = uw.alive; lw.cx = uw.cx; lw.cy = uw.cy;
    if (wasAlive && !lw.alive) _dyingWorms.set(lw.id, { startMs: performance.now() });
    if (options.teleported && lw.id === _activeWormId && _wsSynced) {
      _ws.cx = uw.cx; _ws.cy = uw.cy; _ws.vx = 0; _ws.vy = 0;
    }
  }
}

function _addDamageLabels(wormDamages) {
  for (const d of wormDamages ?? []) {
    const w = _worms.find(w => w.id === d.wormId);
    if (w) _dmgLabels.push({ cx: w.cx, cy: w.cy - 15, text: `-${d.damage}`, alpha: 1, killed: d.killed });
  }
}

function _showResultsAfter(data, delayMs = 900) {
  scope.timeout(() => {
    _stopGame();
    _state = 'results';
    if (_root) _renderResults({ winner: data.winner, draw: !data.winner, payout: 0 });
  }, delayMs);
}

// ── Apply delayed explosion (dynamite detonation or mine trigger) ─────────────
function _applyDelayedExplosion(data) {
  // data: { weapon, newHoles, wormDamages, worms, gameOver, winner, cx?, cy? }
  const holes = _applyTerrainHoles(data.newHoles);

  if (_fuseInterval) { scope.clearInterval(_fuseInterval); _fuseInterval = null; }

  _playHoleExplosions(holes, 16, 400);
  _bumpDamagedWorms(data.wormDamages, holes);

  scope.timeout(() => {
    _applyWormStates(data.worms);
    _addDamageLabels(data.wormDamages);
    _updateHealthBar();
    _wormBumps.clear();
    if (data.gameOver) _showResultsAfter(data);
  }, 560);
}

// ── Apply next turn ───────────────────────────────────────────────────────────
function _applyNextTurn(turn) {
  _resetTurnState(turn);
  _applyTurnMeta(turn);
  _syncTurnObjects(turn);
  _updateTurnAmmo(turn);
  if (turn.worms) _applyWormStates(turn.worms);
  _showTurnAnnouncement(turn);
  wormRenderer.clear(); // clear sprite cache so new weapon anim picks correct img
  _initWsTurn();
  _updateHUD();
  if (_myTurn()) _playRandomSpeech('yessir');
}

function _resetTurnState({ currentTurn, activeWormId, turnMs }) {
  _currentTurn  = currentTurn;
  _activeWormId = activeWormId;
  _turnDeadline = Date.now() + (turnMs ?? TURN_MS);
  _shotFired    = false;
  _chargeStart  = null;
  _wsSynced     = false;
  _weaponAnim   = null;
  _prevWeapon   = null;
  _retreating   = false;
  _retreatEnd   = 0;
  _movementToolUsed = false;
}

function _applyTurnMeta({ wind, round, suddenDeath, waterLevel }) {
  if (wind        !== undefined) _wind        = wind;
  if (round       !== undefined) _round       = round;
  if (suddenDeath !== undefined) _suddenDeath = suddenDeath;
  if (waterLevel  !== undefined) _waterLevel  = waterLevel;
}

function _syncTurnObjects({ crates, dynamites, mines }) {
  if (crates) _crates = crates.map(c => ({ ...c, landed: true, fallingCy: c.cy }));
  if (dynamites) _dynamites = dynamites.map(d => ({
    ...d,
    placedAt: d.fuseStarted ? performance.now() - (Date.now() - d.fuseStarted) : performance.now(),
  }));
  if (mines) _mines = mines.map(m => ({ ...m }));
}

function _updateTurnAmmo({ currentTurn, ammo }) {
  if (!ammo || currentTurn !== _myUserId) return;
  _ammo = { ...ammo };
  _updateWeaponBtns();
}

function _showTurnAnnouncement({ currentTurn, activeWormId, worms }) {
  const pl = _players.find(p => p.userId === currentTurn);
  if (!pl) return;
  const aw = _worms.find(w => w.id === activeWormId) ?? (worms ?? []).find(w => w.id === activeWormId);
  _turnAnnouncement = {
    text:    `${pl.pseudo}  —  ${aw?.name ?? '?'}`,
    color:   pl.color ?? '#66dd33',
    startMs: performance.now(),
  };
}

// ── Socket events ─────────────────────────────────────────────────────────────
function _bindSocketEvents() {
  _socket.on('worms:rooms', ({ rooms, liveRooms }) => {
    _openRooms.length = 0; _openRooms.push(...rooms);
    _liveRooms.length = 0; _liveRooms.push(...liveRooms);
    if (_state === 'lobby') _renderLobby();
  });

  _socket.on('worms:open', (room) => _noteRoomOpen(_openRooms, room));

  _socket.on('worms:closed', ({ roomId }) => {
    _noteRoomClosed(_openRooms, roomId);
    if (_roomId === roomId && _state === 'waiting') {
      _pushSys?.(t('games.worms.roomCancelled'));
      _state = 'lobby';
      _roomId = null;
      _socket.emit('worms:rooms_request');
      if (_root) _renderLobby();
    }
  });

  _socket.on('worms:live_open', (room) => _noteRoomOpen(_liveRooms, room));

  _socket.on('worms:live_closed', ({ roomId }) => {
    _noteRoomClosed(_liveRooms, roomId);
    // Force-exit spectate if the room we were watching closed
    if (_spectateMode && _roomId === roomId) {
      _spectateMode = false; _state = 'idle'; _roomId = null;
      _stopGame();
      if (_onExit) _onExit();
    }
  });

  // Spectate: receive full game snapshot and render read-only game view
  _socket.on('worms:spectate_start', (data) => {
    if (!_spectateMode || !_root) return;
    _roomId = data.roomId ?? _roomId;
    _state  = 'game';
    _myUserId = null; // never our turn
    _setupGame(data);
  });

  _socket.on('worms:lobby_update', (room) => {
    _upsertRoom(_openRooms, room);
    if (_state === 'waiting' && _roomId === room.id) _renderWaiting(room);
    else if (_state === 'lobby') _renderLobby();
  });

  ['worms:created', 'worms:joined'].forEach(eventName => {
    _socket.on(eventName, ({ roomId, room }) => _enterWaitingRoom(roomId, room));
  });

  _socket.on('worms:start', (data) => {
    if (!_root) return;
    _lastBet = data.bet ?? _lastBet;
    _state = 'game';
    _setupGame(data);
  });

  _socket.on('worms:pos_update', ({ wormId, cx, cy }) => {
    if (_state !== 'game') return;
    const w = _worms.find(w => w.id === wormId);
    // Update any worm that's not the local player's (includes spectate where _myUserId = null)
    if (w) { w.cx = cx; w.cy = cy; }
  });

  _socket.on('worms:fire_result', (data) => {
    if (_state !== 'game') return;
    _animating   = true;
    // NOTE: do NOT reset _shotFired here — keep it true until _applyNextTurn
    // to prevent the player from firing a second shot in the 2600ms window
    _chargeStart = null;
    if (data.playerId === _myUserId && data.ammo) {
      _ammo = { ...data.ammo };
      _updateWeaponBtns();
    }

    // Fuse sound for thrown grenades
    if (FUSE_SOUND_WEAPONS.has(data.weapon)) {
      _playSound('fuse', 0.5);
      if (_fuseInterval) scope.clearInterval(_fuseInterval);
      _fuseInterval = scope.interval(() => _playSound('fuse', 0.5), 900);
    }

    // Start projectile animations — terrain stays intact until impact
    const _projStartMs = performance.now();
    _projectiles = (data.trajectories ?? []).map(traj => ({
      trajectory: traj, idx: 0, done: false, weapon: data.weapon ?? _selectedWeapon,
      startMs: _projStartMs,
      fuseMs:  data.fuseMs ?? null,
    }));

    // Calculate how long projecting takes
    // Minimum 500ms so even short-trajectory shots show the explosion
    const maxLen = Math.max(1, ...(_projectiles.map(p => p.trajectory.length)));
    // At PROJ_PTS_PER_SEC=20, animation takes maxLen/20 seconds. Add 200ms buffer.
    const projMs = Math.max(500, Math.ceil(maxLen * 1000 / 20) + 200);

    scope.timeout(() => {
      // Apply terrain holes at impact moment (synchronized with explosion FX)
      const impactHoles = _applyTerrainHoles(data.newHoles);

      // Stop fuse sound
      if (_fuseInterval) { scope.clearInterval(_fuseInterval); _fuseInterval = null; }

      // Explosions at impact points (skip for planted / teleport)
      if (_playHoleExplosions(impactHoles, 14, 320)) {
        // Explosion handled by shared VFX helper.
      } else if (data.teleported) {
        // Small teleport pop FX at landing position
        const lw = _worms.find(w => w.id === _activeWormId);
        if (lw) _spawnParticles(data.cx ?? lw.cx, data.cy ?? lw.cy, 7);
        _playSound('TELEPORT', 0.5);
      } else if (data.planted) {
        // Placement sound
        _playSound('PLACE', 0.4);
        // Store dynamite/mine client-side
        if (data.planted && data.weapon === 'dynamite' && data.dynId) {
          // placedAt derived from server fuseStarted so countdown stays in sync across clients
          const elapsedMs = data.fuseStarted ? (Date.now() - data.fuseStarted) : 0;
          _dynamites.push({ id: data.dynId, cx: data.cx, cy: data.cy, fuseMs: data.fuseMs ?? 5000,
            placedAt: performance.now() - elapsedMs });
        }
        if (data.planted && data.weapon === 'land_mine' && data.mineId) {
          _mines.push({ id: data.mineId, cx: data.cx, cy: data.cy });
        }
      }

      // ── Visual hit-reaction: push damaged worms away from nearest explosion
      _bumpDamagedWorms(data.wormDamages, impactHoles, { bat: data.weapon === 'bat' });

      scope.timeout(() => {
        // Apply worm states and damage labels
        _applyWormStates(data.worms, { teleported: data.teleported });
        _addDamageLabels(data.wormDamages);
        _updateHealthBar();
        _projectiles = [];
        _wormBumps.clear();  // snap to final server positions
        _animating   = false;

        if (data.gameOver) {
          _showResultsAfter(data);
        } else if (_pendingNextTurn) {
          _applyNextTurn(_pendingNextTurn);
          _pendingNextTurn = null;
        }
      }, 560);
    }, projMs);
  });

  _socket.on('worms:tool_used', ({ playerId, ammo }) => {
    if (_state !== 'game' || playerId !== _myUserId || !ammo) return;
    _ammo = { ...ammo };
    _updateWeaponBtns();
  });

  _socket.on('worms:drowned', (data) => {
    if (_state !== 'game') return;
    _applyWormStates(data.worms);
    _addDamageLabels(data.wormDamages);
    _updateHealthBar();
    _playRandomSpeech('byebye');
  });

  _socket.on('worms:next_turn', (data) => {
    if (_state !== 'game') return;
    if (_animating) {
      _pendingNextTurn = data;
    } else {
      _applyNextTurn(data);
    }
  });

  _socket.on('worms:delayed_explosion', (data) => {
    if (_state !== 'game') return;
    // Remove from local lists
    if (data.weapon === 'dynamite' && data.dynId) {
      _dynamites = _dynamites.filter(d => d.id !== data.dynId);
    }
    if (data.weapon === 'land_mine' && data.mineId) {
      _mines = _mines.filter(m => m.id !== data.mineId);
    }
    _applyDelayedExplosion(data);
  });

  _socket.on('worms:game_over', (data) => {
    if (_state !== 'game' && _state !== 'results') return;
    if (_spectateMode) {
      const winner = data.winner?.pseudo;
      _spectateMode = false; _state = 'idle'; _roomId = null;
      _stopGame();
      if (_onExit) _onExit();
      if (winner) _pushSys?.(t('games.worms.spectatorWinner', { player: winner }));
      return;
    }
    _stopGame();
    _state = 'results';
    if (_root) _renderResults(data);
  });

  _socket.on('worms:rematch_waiting', ({ roomId }) => {
    if (_roomId !== roomId) return;
    const btn = document.getElementById('worms-rematch-btn');
    if (btn) {
      btn.disabled = true;
      btn.style.opacity = '0.65';
      btn.textContent = t('games.worms.waiting');
    }
  });

  _socket.on('worms:rematch_lobby', ({ roomId, room }) => {
    _roomId = roomId;
    _lastBet = room?.bet ?? _lastBet;
    _state = 'waiting';
    _renderWaiting(room);
  });

  _socket.on('worms:post_exit', ({ roomId, reason }) => {
    if (_roomId && roomId !== _roomId) return;
    if (reason === 'insufficient_balance') _pushSys?.(t('games.worms.rematchInsufficientBalance'));
    _exit();
  });

  _socket.on('worms:forfeit_player', ({ userId, pseudo }) => {
    if (_state !== 'game') return;
    const p = _players.find(p => p.userId === userId);
    _pushSys?.(t('games.worms.playerForfeited', { player: p?.pseudo ?? pseudo }));
  });

  _socket.on('worms:retreat', ({ retreatMs }) => {
    if (_state !== 'game') return;
    _retreating = true;
    _retreatEnd = Date.now() + (retreatMs ?? 5000);
    // Allow movement but no firing during retreat
    _shotFired = true;
  });

  _socket.on('worms:worm_selected', ({ activeWormId }) => {
    if (_state !== 'game') return;
    _activeWormId = activeWormId;
    wormRenderer.clear();
    _initWsTurn();
    _updateHUD();
  });

  _socket.on('worms:crate_spawn', ({ crate }) => {
    if (_state !== 'game' || !crate) return;
    // Crate starts at top of screen and falls down to its landing y
    _crates.push({ ...crate, landed: false, fallingCy: -30 });
    _playSound('CrateOpen', 0.4);
  });

  _socket.on('worms:crate_collected', ({ crateId, type, weapon, wormId, hp, ammo }) => {
    if (_state !== 'game') return;
    _crates = _crates.filter(c => c.id !== crateId);
    const worm = _worms.find(w => w.id === wormId);
    if (worm && hp !== undefined) worm.hp = hp;
    // Apply updated ammo if this worm belongs to us
    if (ammo && wormId === _activeWormId) {
      _ammo = ammo;
      _updateWeaponBtns();
    }
    if (type === 'health') {
      _pushSys?.(t('games.worms.healthPickup', { worm: worm?.name ?? '?' }));
      if (wormId === _activeWormId) _playRandomSpeech('yessir');
    } else if (weapon) {
      _pushSys?.(t('games.worms.weaponPickup', { worm: worm?.name ?? '?', weapon: _weaponLabel(weapon) }));
      if (wormId === _activeWormId) _playRandomSpeech('yessir');
    }
    _updateHealthBar();
  });

  _socket.on('worms:error', ({ error }) => {
    const msgs = {
      insufficient_balance: t('games.worms.error.insufficientBalance'),
      already_in_room:      t('games.worms.error.alreadyInRoom'),
      not_found:            t('games.worms.error.notFound'),
      room_full:            t('games.worms.error.roomFull'),
      already_started:      t('games.worms.error.alreadyStarted'),
      not_your_turn:        t('games.worms.error.notYourTurn'),
      need_more_players:    t('games.worms.error.needMorePlayers'),
      no_ammo:              t('games.worms.error.noAmmo'),
      invalid_target:       t('games.worms.error.invalidTarget'),
      invalid_angle:        t('games.worms.error.invalidAngle'),
      action_taken:         t('games.worms.error.actionTaken'),
    };
    if (['no_ammo', 'invalid_target', 'invalid_angle'].includes(error)) {
      _shotFired = false;
      _movementToolUsed = false;
      _rope = null;
      _jetpackActive = false;
      _chargeStart = null;
      _updateHUD();
    }
    _pushSys?.(Object.hasOwn(msgs, error) ? Reflect.get(msgs, error) : `❌ Worms: ${t('games.unknownError')}`);
  });
}

// ── Results screen ────────────────────────────────────────────────────────────
function _renderResults(data) {
  if (!_root) return;
  _root.dataset.gameMode = 'worms-menu';
  _root.replaceChildren();
  _root.style.cssText = 'padding:14px;overflow:auto;background:#0f1014;color:#fff;text-align:center;';

  const wrap = _el('div', { style: { fontFamily: 'monospace', maxWidth: '500px', margin: '0 auto' }});

  if (data.draw || !data.winner) {
    wrap.appendChild(_el('h2', { style: { color: '#ffcc00' }}, t('games.worms.draw')));
    wrap.appendChild(_el('p', { style: { color: '#aaa' }}, t('games.worms.everyoneDied')));
  } else {
    const w = data.winner;
    const h2 = _el('h2', { style: { color: w.color ?? '#66dd33' }});
    h2.textContent = t('games.worms.winner', { player: w.pseudo });
    wrap.appendChild(h2);
    if (data.payout > 0) {
      wrap.appendChild(_el('p', { style: { color: '#f8c200', fontSize: '15px' }},
        `+${data.payout} pts`));
    }
  }

  const btnRow = _el('div', { style: { marginTop: '16px', display: 'flex', gap: '10px', justifyContent: 'center' }});

  const replayBtn = _el('button', { id: 'worms-rematch-btn', style: {
    background: 'linear-gradient(135deg,#3d8a2c,#7a5230)',
    color: '#fff', border: 'none', padding: '8px 18px',
    borderRadius: '4px', cursor: 'pointer', fontSize: '14px',
  }}, t('games.worms.playAgain'));
  replayBtn.addEventListener('click', () => {
    if (!_roomId) return;
    const me = _getMe?.();
    if (_lastBet > 0 && _lastBet > (me?.points ?? 0)) { _pushSys?.(t('games.worms.insufficientBalance')); return; }
    replayBtn.disabled = true;
    replayBtn.style.opacity = '0.65';
    replayBtn.textContent = t('games.worms.rematchSent');
    _socket.emit('worms:rematch', { roomId: _roomId });
  });

  const quitBtn = _el('button', { style: {
    background: '#2a1818', color: '#ff7777', border: '1px solid #5a2828',
    padding: '8px 18px', borderRadius: '4px', cursor: 'pointer', fontSize: '14px',
  }}, t('games.worms.leave'));
  quitBtn.addEventListener('click', () => {
    if (_roomId) _socket.emit('worms:post_exit', { roomId: _roomId });
    else _exit();
  });

  btnRow.append(replayBtn, quitBtn);
  wrap.appendChild(btnRow);
  _root.appendChild(wrap);
}

// ── Utility ──────────────────────────────────────────────────────────────────

// Rounded rectangle helper (polyfill for older browsers)
function _roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// Draw a crate at (cx, cy) — weapon (brown) or health (white cross)
function _drawCrate(ctx, cx, cy, type, weapon, falling, now) {
  const sz = 14;
  ctx.save();
  // Parachute when falling
  if (falling) {
    ctx.strokeStyle = '#ddd';
    ctx.fillStyle   = 'rgba(200,200,255,0.7)';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.arc(cx, cy - sz - 14, 12, Math.PI, 0);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    // Cords
    ctx.strokeStyle = 'rgba(180,180,180,0.8)';
    ctx.lineWidth   = 0.7;
    [[-12, 0], [0, 0], [12, 0]].forEach(([ox]) => {
      ctx.beginPath();
      ctx.moveTo(cx + ox, cy - sz - 14);
      ctx.lineTo(cx, cy - sz / 2);
      ctx.stroke();
    });
  }
  // Crate box
  const col = type === 'health' ? '#e8e8e8' : '#8b6914';
  ctx.fillStyle   = col;
  ctx.strokeStyle = '#222';
  ctx.lineWidth   = 1.5;
  ctx.fillRect(cx - sz / 2, cy - sz, sz, sz);
  ctx.strokeRect(cx - sz / 2, cy - sz, sz, sz);
  // Cross straps
  ctx.strokeStyle = type === 'health' ? '#888' : '#5a4010';
  ctx.lineWidth   = 1;
  ctx.beginPath();
  ctx.moveTo(cx, cy - sz); ctx.lineTo(cx, cy);
  ctx.moveTo(cx - sz / 2, cy - sz / 2); ctx.lineTo(cx + sz / 2, cy - sz / 2);
  ctx.stroke();
  if (type === 'health') {
    ctx.strokeStyle = '#cc0000'; ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(cx, cy - sz + 3); ctx.lineTo(cx, cy - 3);
    ctx.moveTo(cx - sz / 2 + 3, cy - sz / 2); ctx.lineTo(cx + sz / 2 - 3, cy - sz / 2);
    ctx.stroke();
  } else if (weapon) {
    const icon = _weaponDef(weapon)?.icon ?? '?';
    ctx.font      = 'bold 7px monospace';
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.fillText(icon, cx, cy - sz / 2 + 3);
    ctx.textAlign = 'left';
  }
  // Pulse glow when landed
  if (!falling) {
    const pulse = 0.3 + 0.2 * Math.sin(now / 400);
    ctx.strokeStyle = type === 'health' ? `rgba(255,80,80,${pulse})` : `rgba(255,200,50,${pulse})`;
    ctx.lineWidth = 2;
    ctx.strokeRect(cx - sz / 2 - 2, cy - sz - 2, sz + 4, sz + 4);
  }
  ctx.restore();
}

// Spawn debris particles at an explosion origin
function _spawnParticles(cx, cy, n) {
  for (let i = 0; i < n; i++) {
    const ang = randomUnit() * Math.PI * 2;
    const spd = 60 + randomUnit() * 200;
    const col = randomUnit() < 0.5 ? 'rgba(255,150,30,1)' : 'rgba(200,80,10,1)';
    _particles.push({
      cx, cy,
      vx: Math.cos(ang) * spd,
      vy: Math.sin(ang) * spd - 60,
      alpha: 0.9 + randomUnit() * 0.1,
      r:   2 + randomUnit() * 3,
      color: col,
    });
  }
}

function _el(tag, attrs = {}, text = null) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'style' && typeof v === 'object') {
      Object.assign(el.style, v);
    } else if (k === 'class') {
      el.className = v;
    } else {
      el.setAttribute(k, v);
    }
  }
  if (text !== null) el.textContent = text;
  return el;
}

function _colorSpan(pseudo, color) {
  return userNameHtml({ pseudo, color }, { fallbackPseudo: '?' });
}

  scope.cleanup(() => { _stopGame(); terrainRenderer.stop(); wormRenderer.stop(); media.stop(); _root = null; });
  initWorms(socket, getMe, pushSystem);
  const instance = { get active() { return scope.active; }, activateWorms, releaseInput() { _keys.clear(); _chargeStart = null; }, stop: () => scope.stop() };
  scope.cleanup(() => { if (current === instance) current = null; });
  return instance;
}
