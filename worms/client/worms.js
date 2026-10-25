import { createWormsGameView } from './worms-game-view.js';
import { createWormsHud } from './worms-hud.js';
import { createWormsTurnAnimations } from './worms-turn-animations.js';
import { createWormsPhysics } from './worms-physics.js';
import { createWormsOverlays } from './worms-overlays.js';
import { createWormsEffects } from './worms-effects.js';
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
let attachedArena = null;
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
let _wormBumps    = new Map(); // wormId → {vx,vy,dx,dy} — visual hit-reaction
let _shakeUntil   = 0;
let _animating    = false;
let _pendingNextTurn = null;
let _dyingWorms   = new Map(); // wormId → {startMs} — playing death anim

// Camera
const _cam = { x: 0, y: 0, tx: 0, ty: 0 }; // current + target

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

// Crates
let _crates           = [];    // [{id,cx,cy,type,weapon,landed,fallingCy}]

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
    weaponAnimation: turnAnimations.getWeaponAnimation(), aimAngle: _aimAngle }),
  getImage: _assetImage, isActive: () => scope.active, wormRadius: WORM_R,
});
const { draw: _drawWorms } = wormRenderer;
const effectsRenderer = createWormsEffects({
  getState: () => ({ projectiles: _projectiles, selectedWeapon: _selectedWeapon }),
  getImage: _assetImage, getWeaponDefinition: _weaponDef, randomUnit,
  isActive: () => scope.active,
});
const { drawProjectiles: _drawProjectiles, drawExplosions: _drawExplosions,
  drawParticles: _drawParticles, drawDamageLabels: _drawDamageLabels,
  drawFuseCountdowns: _drawFuseCountdowns, tickDamageLabels: _tickDmgLabels,
  spawnParticles: _spawnParticles } = effectsRenderer;
const overlaysRenderer = createWormsOverlays({
  getState: () => ({ isMyTurn: _myTurn(), worms: _worms, activeWormId: _activeWormId,
    isPhysicsSynced: _wsSynced, physics: _ws, rope: _rope,
    isJetpackActive: _jetpackActive, jetpackFuel: _jetpackFuel,
    hasShotFired: _shotFired, isAnimating: _animating, selectedWeapon: _selectedWeapon,
    mouseX: _mouseX, mouseY: _mouseY, aimAngle: _aimAngle, chargeStart: _chargeStart,
    crates: _crates, dynamites: _dynamites, mines: _mines }),
  getImage: _assetImage, getWeaponDefinition: _weaponDef, playSound: _playSound,
  translate: t, isActive: () => scope.active, targetedWeapons: TARGETED_WEAPONS,
  width: WORLD_W, height: WORLD_H, wormRadius: WORM_R,
});
const { drawRope: _drawRope, drawJetpackFuel: _drawJetpackFuel,
  drawAimAndTargeting: _drawAimAndTargeting, drawCratesFrame: _drawCratesFrame,
  drawDynamites: _drawDynamites, drawMines: _drawMines,
  drawTeleportPreview: _drawTeleportPreview, drawParachute: _drawParachute,
  drawChargeBar: _drawChargeBar } = overlaysRenderer;
const wormPhysics = createWormsPhysics({
  getState: () => ({
    isMyTurn: _myTurn(), physics: _ws, worms: _worms, activeWormId: _activeWormId,
    terrain: _terrain, terrainMask: _terrainMask, holes: _holes, waterLevel: _waterLevel,
    keys: _keys, hasShotFired: _shotFired, hasMovementToolUsed: _movementToolUsed,
    isRetreating: _retreating, isAnimating: _animating,
    get rope() { return _rope; }, set rope(value) { _rope = value; },
    get isJetpackActive() { return _jetpackActive; }, set isJetpackActive(value) { _jetpackActive = value; },
    get jetpackFuel() { return _jetpackFuel; }, set jetpackFuel(value) { _jetpackFuel = value; },
    get aimAngle() { return _aimAngle; }, set aimAngle(value) { _aimAngle = value; },
    get isPhysicsSynced() { return _wsSynced; }, set isPhysicsSynced(value) { _wsSynced = value; },
  }),
  playSound: _playSound, spawnParticles: _spawnParticles, randomUnit,
  isActive: () => scope.active, width: WORLD_W, height: WORLD_H, wormRadius: WORM_R,
});
const { initTurn: _initWsTurn } = wormPhysics;
const turnAnimations = createWormsTurnAnimations({
  getState: () => ({ isMyTurn: _myTurn(), physics: _ws, selectedWeapon: _selectedWeapon, turnDeadline: _turnDeadline }),
  getWeaponDefinition: _weaponAnimDef, playSound: _playSound,
  timers: { setTimeout: scope.timeout, clearTimeout: scope.clearTimeout },
  isActive: () => scope.active,
});
const { updateWalkSounds: _updateWalkSounds, updateWeaponTakeoutAnim: _updateWeaponTakeoutAnim,
  playTimerTickIfNeeded: _playTimerTickIfNeeded } = turnAnimations;
const hud = createWormsHud({
  getState: () => ({ isMyTurn: _myTurn(), players: _players, worms: _worms,
    currentTurn: _currentTurn, myUserId: _myUserId, activeWormId: _activeWormId,
    round: _round, wind: _wind, isSuddenDeath: _suddenDeath, selectedWeapon: _selectedWeapon,
    ammo: _ammo, hasShotFired: _shotFired, grenadeFuse: _grenadefuse,
    turnDeadline: _turnDeadline, isRetreating: _retreating, retreatEnd: _retreatEnd }),
  getView: () => ({ turnLabel: _turnLabel, wind: _windEl, health: _healthEl,
    weaponButtons: _weaponBtns, fuse: _fuseEl, timer: _timerEl }),
  createElement: _el, renderUserName, setSafeHtml, translate: t, unlimitedAmmo: _unlimitedAmmo,
  fuseWeapons: FUSE_WEAPONS, isActive: () => scope.active, width: WORLD_W, height: WORLD_H,
});
const { updateHUD: _updateHUD, updateTimerDisplay: _updateTimerDisplay,
  updateHealthBar: _updateHealthBar, updateWeaponBtns: _updateWeaponBtns,
  updateFuseDisplay: _updateFuseDisplay, showTurnAnnouncement: _showTurnAnnouncement,
  drawTurnAnnouncement: _drawTurnAnnouncement } = hud;

const gameView = createWormsGameView({
  getState: () => ({ selectedWeapon: _selectedWeapon, isSpectateMode: _spectateMode,
    get isMuted() { return _muted; }, set isMuted(value) { _muted = value; } }),
  createElement: _el, weapons: WEAPONS, getWeaponLabel: _weaponLabel,
  getWeaponIconName: _weaponIconName, translate: t, isActive: () => scope.active,
  attachInput: (canvas, ...args) => { attachedArena = canvas; arenaInput.attach(canvas, ...args); },
  detachInput: canvas => { if (attachedArena === canvas) { _unbindGameInput(); attachedArena = null; arenaInput.attach(null); } },
  mountTerrain: () => terrainRenderer.mount(), onSelectWeapon: _selectWeapon,
  onQuitSpectating: _quitSpectating,
  onEndTurn: () => { if (_myTurn()) _socket.emit('worms:end_turn', { roomId: _roomId }); },
  onForfeit: () => _socket.emit('worms:forfeit', { roomId: _roomId }),
  width: WORLD_W, height: WORLD_H, assetsBase: WORMS_ASSETS,
});

// DOM
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
  if (!_buildGameLayout()) return;
  _updateHealthBar();
  _centerCameraOnActive(data.worms, data.activeWormId);
  _finishGameSetup();
}

function _resetGameData(data) {
  turnAnimations.reset();
  wormPhysics.reset();
  overlaysRenderer.reset();
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
  effectsRenderer.reset();
  _wormBumps.clear();
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
  hud.reset();
}

function _buildGameLayout() {
  const view = gameView.mount(_root);
  if (!view) return false;
  _canvas = view.canvas;
  _ctx = view.context;
  _turnLabel = view.turnLabel;
  _timerEl = view.timer;
  _windEl = view.wind;
  _healthEl = view.health;
  _weaponBtns = view.weaponButtons;
  _fuseEl = view.fuse;
  return true;
}

function _quitSpectating() {
  _socket.emit('worms:unwatch', { roomId: _roomId });
  _spectateMode = false; _state = 'idle'; _roomId = null;
  _stopGame();
  if (_onExit) _onExit();
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
  wormPhysics.reset();
  overlaysRenderer.reset();
  if (_raf) { scope.cancelFrame(_raf); _raf = null; }
  _unbindGameInput();
  gameView.reset();
  _canvas = null; _ctx = null;
  _turnLabel = null; _timerEl = null; _windEl = null; _healthEl = null;
  _weaponBtns = Object.create(null);
  wormRenderer.clear();
  effectsRenderer.reset();
  _wormBumps.clear();
  _dyingWorms.clear();
  turnAnimations.reset();
  _terrainMask = null;
  terrainRenderer.reset();
  _crates = [];
  hud.reset();
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

// ── Physics (active worm, my turn only) ─────────────────────────────────────
function _physicsStep(dt) {
  if (!wormPhysics.step(dt)) return;
  _updateWalkSounds(dt);
  _updateWeaponTakeoutAnim();
  _playTimerTickIfNeeded();
  _ws.cx = Math.max(WORM_R, Math.min(WORLD_W - WORM_R, _ws.cx));
  _collectNearbyCrate();
  _mirrorActiveWormPosition();
  _syncActiveWormPosition();
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
    effectsRenderer.addExplosion({ cx: h.cx, cy: h.cy, r: Math.max(30, h.r), startMs: performance.now(), durationMs: 520 });
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
    if (w) effectsRenderer.addDamageLabel({ cx: w.cx, cy: w.cy - 15, text: `-${d.damage}`, alpha: 1, killed: d.killed });
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
  turnAnimations.reset();
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

  scope.cleanup(() => { _stopGame(); terrainRenderer.stop(); wormRenderer.stop(); effectsRenderer.stop(); overlaysRenderer.stop(); wormPhysics.stop(); hud.stop(); turnAnimations.stop(); gameView.stop(); media.stop(); _root = null; });
  initWorms(socket, getMe, pushSystem);
  const instance = { get active() { return scope.active; }, activateWorms, releaseInput() { _keys.clear(); _chargeStart = null; }, stop: () => scope.stop() };
  scope.cleanup(() => { if (current === instance) current = null; });
  return instance;
}
