import { createWormsEvents } from './worms-events.js';
import { createWormsActions } from './worms-actions.js';
import { createWormsInput } from './worms-input.js';
import { createWormsMenuView } from './worms-menu-view.js';
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
const arenaInput = createGameInput(scope, () => _root, () => gameInput.release());
let attachedArena = null;
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

const actions = createWormsActions({
  getState: () => ({ roomId: _roomId, physics: _ws, isMyTurn: _myTurn(), isAnimating: _animating,
    selectedWeapon: _selectedWeapon, aimAngle: _aimAngle, power: _power, mouseX: _mouseX, grenadeFuse: _grenadefuse,
    get hasShotFired() { return _shotFired; }, set hasShotFired(value) { _shotFired = value; },
    get hasMovementToolUsed() { return _movementToolUsed; }, set hasMovementToolUsed(value) { _movementToolUsed = value; },
    get rope() { return _rope; }, set rope(value) { _rope = value; },
    get isJetpackActive() { return _jetpackActive; }, set isJetpackActive(value) { _jetpackActive = value; },
    get jetpackFuel() { return _jetpackFuel; }, set jetpackFuel(value) { _jetpackFuel = value; },
    get teleportTarget() { return _teleportTarget; }, set teleportTarget(value) { _teleportTarget = value; },
  }),
  sendCommand: (name, payload) => _socket.emit(name, payload), playSound: _playSound,
  targetedWeapons: TARGETED_WEAPONS, fuseWeapons: FUSE_WEAPONS, wormRadius: WORM_R,
  isActive: () => scope.active,
});

const gameInput = createWormsInput({
  getState: () => ({ keys: _keys, physics: _ws, worms: _worms, activeWormId: _activeWormId,
    myUserId: _myUserId, isMyTurn: _myTurn(), hasShotFired: _shotFired, isAnimating: _animating,
    selectedWeapon: _selectedWeapon, isPhysicsSynced: _wsSynced,
    get chargeStart() { return _chargeStart; }, set chargeStart(value) { _chargeStart = value; },
    get power() { return _power; }, set power(value) { _power = value; },
    get aimAngle() { return _aimAngle; }, set aimAngle(value) { _aimAngle = value; },
    get mouseX() { return _mouseX; }, set mouseX(value) { _mouseX = value; },
    get mouseY() { return _mouseY; }, set mouseY(value) { _mouseY = value; },
    get grenadeFuse() { return _grenadefuse; }, set grenadeFuse(value) { _grenadefuse = value; },
    get teleportTarget() { return _teleportTarget; }, set teleportTarget(value) { _teleportTarget = value; },
  }),
  eventTarget: document, on: scope.on, off: scope.off,
  ownsInput: event => arenaInput.owns(event), isVisible: () => arenaInput.visible(),
  fuseWeapons: FUSE_WEAPONS, selectWeapon: _selectWeapon, updateFuseDisplay: _updateFuseDisplay,
  selectWorm: wormId => _socket.emit('worms:select_worm', { roomId: _roomId, wormId }),
  playSound: _playSound, playRandomSpeech: _playRandomSpeech, fire: _doFire,
  isActive: () => scope.active, width: WORLD_W, height: WORLD_H,
});

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

const events = createWormsEvents({
  socket, getState: () => ({
    openRooms: _openRooms,
    liveRooms: _liveRooms,
    get mode() { return _state; }, set mode(value) { _state = value; },
    get roomId() { return _roomId; }, set roomId(value) { _roomId = value; },
    get isSpectateMode() { return _spectateMode; }, set isSpectateMode(value) { _spectateMode = value; },
    get myUserId() { return _myUserId; }, set myUserId(value) { _myUserId = value; },
    get lastBet() { return _lastBet; }, set lastBet(value) { _lastBet = value; },
    get worms() { return _worms; }, set worms(value) { _worms = value; },
    get players() { return _players; }, set players(value) { _players = value; },
    get isAnimating() { return _animating; }, set isAnimating(value) { _animating = value; },
    get chargeStart() { return _chargeStart; }, set chargeStart(value) { _chargeStart = value; },
    get ammo() { return _ammo; }, set ammo(value) { _ammo = value; },
    get projectiles() { return _projectiles; }, set projectiles(value) { _projectiles = value; },
    get selectedWeapon() { return _selectedWeapon; }, set selectedWeapon(value) { _selectedWeapon = value; },
    get activeWormId() { return _activeWormId; }, set activeWormId(value) { _activeWormId = value; },
    get dynamites() { return _dynamites; }, set dynamites(value) { _dynamites = value; },
    get mines() { return _mines; }, set mines(value) { _mines = value; },
    wormBumps: _wormBumps,
    get pendingNextTurn() { return _pendingNextTurn; }, set pendingNextTurn(value) { _pendingNextTurn = value; },
    get isRetreating() { return _retreating; }, set isRetreating(value) { _retreating = value; },
    get retreatEnd() { return _retreatEnd; }, set retreatEnd(value) { _retreatEnd = value; },
    get hasShotFired() { return _shotFired; }, set hasShotFired(value) { _shotFired = value; },
    get hasMovementToolUsed() { return _movementToolUsed; }, set hasMovementToolUsed(value) { _movementToolUsed = value; },
    get rope() { return _rope; }, set rope(value) { _rope = value; },
    get isJetpackActive() { return _jetpackActive; }, set isJetpackActive(value) { _jetpackActive = value; },
    get crates() { return _crates; }, set crates(value) { _crates = value; },
    get hasRoot() { return !!_root; },
    get hasExit() { return !!_onExit; },
  }),
  services: {
    noteRoomOpen: _noteRoomOpen,
    noteRoomClosed: _noteRoomClosed,
    upsertRoom: _upsertRoom,
    enterWaitingRoom: _enterWaitingRoom,
    renderLobby: _renderLobby,
    renderWaiting: _renderWaiting,
    setupGame: _setupGame,
    stopGame: _stopGame,
    renderResults: _renderResults,
    exit: _exit,
    updateWeaponBtns: _updateWeaponBtns,
    playSound: _playSound,
    playRandomSpeech: _playRandomSpeech,
    applyTerrainHoles: _applyTerrainHoles,
    playHoleExplosions: _playHoleExplosions,
    spawnParticles: _spawnParticles,
    bumpDamagedWorms: _bumpDamagedWorms,
    applyWormStates: _applyWormStates,
    addDamageLabels: _addDamageLabels,
    updateHealthBar: _updateHealthBar,
    applyNextTurn: _applyNextTurn,
    weaponLabel: _weaponLabel,
    updateHUD: _updateHUD,
    initWsTurn: _initWsTurn,
    notify: message => _pushSys?.(message), onExit: () => _onExit?.(),
    clearSprites: () => wormRenderer.clear(), markRematchWaiting: () => menuView.markRematchWaiting(),
  },
  translate: t, fuseWeapons: FUSE_SOUND_WEAPONS, isActive: () => scope.active,
  timers: { setTimeout: scope.timeout, clearTimeout: scope.clearTimeout, setInterval: scope.interval, clearInterval: scope.clearInterval },
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
  menuView.reset();
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
  menuView.reset();
  _stopGame();
  _state  = 'idle';
  _roomId = null;
  if (_onExit) _onExit();
}

// ── Lobby ─────────────────────────────────────────────────────────────────────
let _selectedTheme = 0;
function _canAffordBet(bet) {
  if (bet > 0 && bet > (_getMe?.()?.points ?? 0)) {
    _pushSys?.(t('games.worms.insufficientBalance'));
    return false;
  }
  return true;
}
const menuView = createWormsMenuView({
  getState: () => ({ openRooms: _openRooms, liveRooms: _liveRooms, myUserId: _myUserId, selectedTheme: _selectedTheme }),
  createElement: _el, translate: t, setSafeHtml, colorSpan: _colorSpan, levels: LEVELS,
  isActive: () => scope.active,
  actions: {
    create: (bet, maxPlayers) => { if (_canAffordBet(bet)) _socket.emit('worms:create', { bet, maxPlayers }); },
    join: room => { if (_canAffordBet(room.bet)) _socket.emit('worms:join', { roomId: room.id }); },
    watch: roomId => activateWorms(_root, _onExit, { spectate: true, roomId }),
    exit: _exit,
    selectTheme: (index, room) => { _selectedTheme = index; _renderWaiting(room); },
    launch: () => _socket.emit('worms:launch', { roomId: _roomId, theme: _selectedTheme }),
    leaveWaiting: () => {
      _socket.emit('worms:forfeit', { roomId: _roomId });
      _state = 'lobby'; _roomId = null;
      _socket.emit('worms:rooms_request'); _renderLobby();
    },
    canRematch: () => !!_roomId && _canAffordBet(_lastBet),
    rematch: () => _socket.emit('worms:rematch', { roomId: _roomId }),
    leaveResults: () => { if (_roomId) _socket.emit('worms:post_exit', { roomId: _roomId }); else _exit(); },
  },
});
function _renderLobby() { if (_root) menuView.mount(_root, 'lobby'); }
function _renderWaiting(room) {
  if (!_root) return;
  _lastBet = room?.bet ?? _lastBet;
  menuView.mount(_root, 'waiting', room);
}

// ── Game canvas setup ─────────────────────────────────────────────────────────

function _setupGame(data) {
  menuView.reset();
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
  events.reset();
  actions.reset();
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
  if (!_bindGameInput()) return;
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
  events.reset();
  actions.reset();
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
function _bindGameInput() { return gameInput.bind(_canvas); }
function _unbindGameInput() { gameInput.reset(); }

function _doFire() { return actions.fire(); }

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
  actions.reset();
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
function _bindSocketEvents() { events.bind(); }

// ── Results screen ────────────────────────────────────────────────────────────
function _renderResults(data) { if (_root) menuView.mount(_root, 'results', data); }

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

  scope.cleanup(() => { _stopGame(); terrainRenderer.stop(); wormRenderer.stop(); effectsRenderer.stop(); overlaysRenderer.stop(); wormPhysics.stop(); hud.stop(); turnAnimations.stop(); gameView.stop(); gameInput.stop(); actions.stop(); events.stop(); menuView.stop(); media.stop(); _root = null; });
  initWorms(socket, getMe, pushSystem);
  const instance = { get active() { return scope.active; }, activateWorms, releaseInput() { gameInput.release(); }, stop: () => scope.stop() };
  scope.cleanup(() => { if (current === instance) current = null; });
  return instance;
}
