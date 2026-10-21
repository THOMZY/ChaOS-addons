// ChaOS — Worms Multiplayer — server-side game manager.
//
// FFA turn-based game: 2-8 players, each controls a team of worms.
// Server is authoritative for: terrain, worm positions/health, shot physics.
// Worm color = player chat color.
//
// API (used from runtime.js):
//   createRoom(player, bet, maxPlayers) → { ok, roomId?, public?, error? }
//   joinRoom(player, roomId)            → { ok, public?, error? }
//   launchRoom(accountId, roomId)      → { ok, game?, error? }
//   fire(accountId, roomId, opts)      → { ok, ...shotResult, error? }
//   updateWormPos(accountId, roomId, wormId, cx, cy) → pos | null
//   nextTurn(roomId)                    → turnState | null
//   forfeit(accountId, roomId)         → { ok, waiting, player, winner? }
//   requestRematch(accountId, roomId)  → { ok, waiting?, ready?, room?, error? }
//   reopenForRematch(roomId)            → { ok, room?, public?, error? }
//   leavePostGame(accountId, roomId)   → { ok, players?, error? }
//   closeRoom(roomId)
//   openRooms(), liveRooms(), getRoom(id), publicRoom(r)

import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import sharp from 'sharp';

import { randomIndex, randomUnit } from '../../../server/utils/secure-random.js';
import { publicGameRoom } from '../../platform/rooms.js';
import { createFFAManager } from '../../platform/ffa-rooms.js';

const LCG_INCREMENT = Number.parseInt('3C6EF35F', 16);
const UINT32_RANGE = 2 ** 32;

const __levelDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '../media/images/levels',
);

// ── Real map definitions ─────────────────────────────────────────────────────
export const LEVELS = [
  { name: 'Treasure', file: 'level2' },
  { name: 'Jungle', file: 'castles' },
  { name: 'Ruins', file: 'level3' },
  { name: 'Battleship', file: 'level5' },
  { name: 'Titanic', file: 'level20' },
];

// Preloaded per-level pixel masks (built once at startup)
const _levelData = new Map(); // levelIdx → { mask: Uint8Array(W*H), heights: number[] }

let _preloadPromise;
export function preloadLevels() {
  return (_preloadPromise ??= loadLevels());
}
async function loadLevels() {
  for (let i = 0; i < LEVELS.length; i++) {
    const file = join(__levelDir, `small${LEVELS[i].file}.png`);
    try {
      const { data } = await sharp(file)
        .resize(WORLD_W, WORLD_H, { fit: 'fill', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const mask = new Uint8Array(WORLD_W * WORLD_H);
      const heights = new Array(WORLD_W).fill(WORLD_H);
      for (let x = 0; x < WORLD_W; x++) {
        for (let y = 0; y < WORLD_H; y++) {
          if (data[(y * WORLD_W + x) * 4 + 3] > 64) {
            mask[y * WORLD_W + x] = 1;
            if (heights[x] === WORLD_H) heights[x] = y;
          }
        }
      }
      _levelData.set(i, { mask, heights });
    } catch {
      console.warn(`[worms] level ${i} unavailable; procedural terrain fallback`);
    }
  }
}

// ── World constants ─────────────────────────────────────────────────────────
const WORLD_W = 960;
const WORLD_H = 480;
const WATER_Y = 455; // worm cy >= WATER_Y → instant death
const WORM_R = 10; // worm radius in world pixels
const GRAVITY = 400; // px/s² (for post-shot drop simulation)
const TURN_MS = 30_000;
const WAIT_TTL = 5 * 60_000;
const POST_MATCH_TTL = 2 * 60_000;
const MAX_PLAYERS = 8;

// ── Weapon definitions ──────────────────────────────────────────────────────
const WEAPONS = {
  bazooka: { damage: 55, radius: 58, speed: 1.0, pellets: 1, spread: 0 },
  hand_grenade: { damage: 65, radius: 70, speed: 0.58, pellets: 1, spread: 0 },
  cluster_bomb: { damage: 38, radius: 44, speed: 0.78, pellets: 1, spread: 0, cluster: 5 },
  shotgun: { damage: 20, radius: 22, speed: 1.3, pellets: 5, spread: 0.22 },
  minigun: { damage: 12, radius: 16, speed: 1.55, pellets: 9, spread: 0.16 },
  mortar: { damage: 72, radius: 78, speed: 0.48, pellets: 1, spread: 0 },
  airstrike: { damage: 52, radius: 56, speed: 0, pellets: 3, spread: 0, vertical: true },
  drill: { damage: 45, radius: 26, speed: 0.55, pellets: 1, spread: 0 },
  dynamite: { damage: 95, radius: 90, speed: 0.02, pellets: 1, spread: 0 },
  holy_grenade: { damage: 75, radius: 85, speed: 0.55, pellets: 1, spread: 0 },
  banana_bomb: { damage: 48, radius: 52, speed: 0.72, pellets: 1, spread: 0, cluster: 6 },
  napalm: { damage: 38, radius: 46, speed: 0, pellets: 6, spread: 0, vertical: true },
  land_mine: { damage: 70, radius: 62, speed: 0.01, pellets: 1, spread: 0 },
  ninja_rope: { damage: 0, radius: 0, speed: 0, pellets: 0, spread: 0 },
  jetpack: { damage: 0, radius: 0, speed: 0, pellets: 0, spread: 0 },
  bat: { damage: 35, radius: 0, speed: 0, pellets: 0, spread: 0, melee: true },
  teleport: { damage: 0, radius: 0, speed: 0, pellets: 0, spread: 0, tool: true },
};

const INITIAL_AMMO = {
  bazooka: Infinity,
  hand_grenade: 3,
  cluster_bomb: 2,
  shotgun: 3,
  minigun: 2,
  mortar: 2,
  airstrike: 1,
  drill: 3,
  dynamite: 2,
  holy_grenade: 1,
  banana_bomb: 2,
  napalm: 1,
  land_mine: 3,
  ninja_rope: Infinity,
  jetpack: Infinity,
  bat: Infinity,
  teleport: 1,
};
const MAX_PROJ_SPEED = 640; // px/s at power=1.0
const SIM_DT = 1 / 60;
const SIM_STEPS = 700;
const TRAJ_SAMPLE = 4; // keep 1 point every N sim steps

// ── New gameplay constants ──────────────────────────────────────────────────
const SUDDEN_DEATH_ROUND = 15;
const WIND_ACCEL = 28; // px/s² per wind unit
const BOUNCE_COEFF = 0.52; // speed retained on terrain bounce
const MAX_BOUNCES = 3;
const BOUNCE_WEAPONS = new Set(['hand_grenade', 'cluster_bomb', 'holy_grenade', 'banana_bomb']); // mortar explodes on first hit
const WIND_WEAPONS = new Set([
  'bazooka',
  'hand_grenade',
  'cluster_bomb',
  'mortar',
  'holy_grenade',
  'banana_bomb',
]);
const GRENADE_FUSE_WEAPONS = new Set([
  'hand_grenade',
  'cluster_bomb',
  'holy_grenade',
  'banana_bomb',
]);
const DEFAULT_FUSE_MS = {
  hand_grenade: 3000,
  cluster_bomb: 3000,
  holy_grenade: 3000,
  banana_bomb: 4000,
};
const MOVEMENT_TOOLS = new Set(['ninja_rope', 'jetpack']);
const DIRECT_FIRE_WEAPONS = new Set(['shotgun', 'minigun']);
const MAX_MOVE_SPEED = 950; // generous ceiling for rope / jetpack movement
const MOVE_GRACE_PX = 28; // absorbs jitter and delayed position packets

const WORM_NAMES = [
  'Barry',
  'Kevin',
  'Clive',
  'Norman',
  'Pete',
  'Archie',
  'Stuart',
  'Gary',
  'Bruce',
  'Phil',
  'Reg',
  'Terry',
  'Daz',
  'Ron',
  'Mick',
];

// ── Helpers ─────────────────────────────────────────────────────────────────
function genId() {
  return randomBytes(5).toString('hex');
}
function rng(s) {
  return () => {
    s = (Math.imul(s, 1664525) + LCG_INCREMENT) >>> 0;
    return s / UINT32_RANGE;
  };
}

function wormsPerPlayer(n) {
  if (n <= 2) return 4;
  if (n <= 3) return 3;
  if (n <= 5) return 2;
  return 1;
}

// ── Terrain generation ───────────────────────────────────────────────────────
function generateTerrain(seed) {
  const r = rng(seed >>> 0);
  const heights = new Array(WORLD_W);

  // Multi-octave noise — large amplitudes for dramatic silhouettes
  const phases = Array.from({ length: 8 }, () => r() * Math.PI * 2);
  for (let x = 0; x < WORLD_W; x++) {
    const t = x / WORLD_W;
    let h = 0.5;
    h += Math.sin(t * Math.PI * 2 + phases[0]) * 0.2; // broad hills
    h += Math.sin(t * Math.PI * 4 + phases[1]) * 0.13; // mid bumps
    h += Math.sin(t * Math.PI * 8 + phases[2]) * 0.08; // rocky detail
    h += Math.sin(t * Math.PI * 18 + phases[3]) * 0.045; // small lumps
    h += Math.sin(t * Math.PI * 36 + phases[4]) * 0.022; // fine texture
    h += Math.sin(t * Math.PI * 72 + phases[5]) * 0.012; // micro detail
    h += Math.sin(t * Math.PI * 128 + phases[6]) * 0.007; // rough edge
    heights[x] = h;
  }

  // Tall mountain peaks — more numerous and more dramatic
  const nPeaks = 4 + Math.floor(r() * 5);
  for (let p = 0; p < nPeaks; p++) {
    const px = 0.06 + r() * 0.88;
    const pw = 0.03 + r() * 0.09; // narrower = sharper peaks
    const ph = 0.14 + r() * 0.3; // taller
    for (let x = 0; x < WORLD_W; x++) {
      const u = 1 - Math.abs(x / WORLD_W - px) / pw;
      if (u > 0) heights[x] -= ph * (3 * u * u - 2 * u * u * u);
    }
  }

  // Deep valleys — carve troughs between peaks
  const nValleys = 2 + Math.floor(r() * 3);
  for (let v = 0; v < nValleys; v++) {
    const vx = 0.1 + r() * 0.8;
    const vw = 0.04 + r() * 0.09;
    const vh = 0.08 + r() * 0.16;
    for (let x = 0; x < WORLD_W; x++) {
      const u = 1 - Math.abs(x / WORLD_W - vx) / vw;
      if (u > 0) heights[x] += vh * (3 * u * u - 2 * u * u * u);
    }
  }

  // Light smoothing (2 passes) — keep rocky jaggedness
  for (let pass = 0; pass < 2; pass++) {
    const s = [...heights];
    for (let x = 2; x < WORLD_W - 2; x++) {
      s[x] = (heights[x - 2] + heights[x - 1] + heights[x] + heights[x + 1] + heights[x + 2]) / 5;
    }
    heights.splice(0, WORLD_W, ...s);
  }

  // Clamp — allow full dramatic range
  for (let x = 0; x < WORLD_W; x++) {
    heights[x] = Math.max(0.06, Math.min(0.87, heights[x])) * WORLD_H;
  }
  // Tall containment walls on map edges
  for (let x = 0; x < 40; x++) {
    const cap = (0.06 + (1 - x / 40) * 0.44) * WORLD_H;
    heights[x] = Math.min(heights[x], cap);
    heights[WORLD_W - 1 - x] = Math.min(heights[WORLD_W - 1 - x], cap);
  }
  return heights;
}

function isSolid(heights, holes, x, y, mask = null) {
  if (x < 0 || x >= WORLD_W || y < 0 || y >= WORLD_H) return false;
  const xi = Math.max(0, Math.min(WORLD_W - 1, Math.floor(x)));
  const yi = Math.max(0, Math.min(WORLD_H - 1, Math.floor(y)));
  for (const h of holes) {
    const dx = x - h.cx,
      dy = y - h.cy;
    if (dx * dx + dy * dy <= h.r * h.r) return false;
  }
  if (mask) return mask[yi * WORLD_W + xi] === 1;
  return y >= heights[xi];
}

// ── Worm spawning ────────────────────────────────────────────────────────────
function spawnWorms(heights, players, seed) {
  const r = rng((seed + 1337) >>> 0);
  const n = players.length;
  const wpc = wormsPerPlayer(n);
  const worms = [];
  for (let pi = 0; pi < n; pi++) {
    const p = players[pi];
    const segW = WORLD_W / n;
    const segL = segW * pi + 25;
    const segR = segW * (pi + 1) - 25;
    for (let wi = 0; wi < wpc; wi++) {
      // Pick a random x within this player's segment, on valid ground
      let cx = 0,
        cy = 0,
        found = false;
      for (let attempt = 0; attempt < 60; attempt++) {
        const tx = Math.round(segL + r() * (segR - segL));
        const tx2 = Math.max(WORM_R + 5, Math.min(WORLD_W - WORM_R - 5, tx));
        const th = heights[tx2] ?? WORLD_H;
        if (th < WATER_Y - 30 && th > WORM_R * 3) {
          cx = tx2;
          cy = Math.max(WORM_R + 5, th - WORM_R - 2);
          found = true;
          break;
        }
      }
      if (!found) {
        // fallback: deterministic center of segment
        cx = Math.max(
          WORM_R + 5,
          Math.min(WORLD_W - WORM_R - 5, Math.round(segW * pi + (segW * (wi + 1)) / (wpc + 1))),
        );
        cy = Math.max(WORM_R + 5, (heights[cx] ?? WORLD_H * 0.6) - WORM_R - 2);
      }
      worms.push({
        id: genId(),
        playerId: p.userId,
        color: p.color,
        name: WORM_NAMES[Math.floor(r() * WORM_NAMES.length)],
        cx,
        cy,
        hp: 80,
        alive: true,
      });
    }
  }
  return worms;
}

// ── Post-explosion gravity drop ───────────────────────────────────────────────
function dropWorm(worm, heights, holes, mask = null) {
  let cy = worm.cy;
  const cx = Math.round(worm.cx);
  while (cy + WORM_R < WORLD_H && !isSolid(heights, holes, cx, cy + WORM_R + 1, mask)) cy++;
  const fallDist = Math.max(0, cy - worm.cy);
  const fallDmg = fallDist > 50 ? Math.floor((fallDist - 50) / 4) : 0;
  // Keep the real landing position so callers can detect a fall into water.
  return { cy: Math.min(cy, WORLD_H - 1), fallDmg };
}

// ── WormGameManager ───────────────────────────────────────────────────────────
export class WormGameManager extends EventEmitter {
  constructor({
    timers = { setTimeout, clearTimeout, clearInterval },
    now = Date.now,
    beforeLaunch = () => true,
    settlementReady = () => true,
  } = {}) {
    super();
    this._timers = timers;
    this._now = now;
    this._beforeLaunch = beforeLaunch;
    this._settlementReady = settlementReady;
    this.accepting = true;
    const ffa = createFFAManager({
      timers,
      waitTimeoutMs: WAIT_TTL,
      defaultMax: MAX_PLAYERS,
      timerKeys: ['_turnTimer', '_waitTimer', '_retreatTimer', '_postTimer', '_expireTimer'],
      _publicRoom: (r) => publicGameRoom(r),
      mkRoom: (id, player, bet, maxPlayers) => ({
        id,
        bet,
        maxPlayers,
        players: [{ ...player }],
        state: 'waiting',
        theme: 0,
        terrain: null,
        mask: null,
        holes: [],
        worms: [],
        turnOrder: [],
        turnIdx: 0,
        currentTurn: null,
        activeWormId: null,
        _turnTimer: null,
        _waitTimer: null,
        _retreatTimer: null,
        _postTimer: null,
        _expireTimer: null,
        _rematchVotes: null,
        round: 0,
        wind: 0,
        waterLevel: WATER_Y,
        suddenDeath: false,
        crates: [],
        dynamites: [],
        mines: [],
        playerAmmo: null,
        turnActionTaken: false,
        activeTool: null,
        retreating: false,
        _moveAudit: new Map(),
      }),
    });

    ffa.on('room:expired', (payload) => this.emit('room:expired', payload));
    this._rooms = ffa._rooms;
    this._wormTurn = new Map();
    this.ffa = ffa;
    const busy = (accountId) =>
      ffa.findPlayerRoom(accountId) ||
      [...ffa._rooms.values()].some(
        (room) =>
          room._settlementPending && room.players.some((player) => player.accountId === accountId),
      );
    this.createRoom = (player, bet, max = 8) => {
      if (!this.accepting) return { ok: false, error: 'unavailable' };
      if (!Number.isSafeInteger(bet) || bet < 0 || bet > Math.floor(Number.MAX_SAFE_INTEGER / 8))
        return { ok: false, error: 'invalid_bet' };
      if (busy(player.accountId)) return { ok: false, error: 'already_in_room' };
      return ffa.createRoom(player, bet, Math.max(2, Math.min(8, Math.floor(max) || 8)));
    };
    this.joinRoom = (player, id) => {
      if (!this.accepting) return { ok: false, error: 'unavailable' };
      if (busy(player.accountId)) return { ok: false, error: 'already_in_room' };
      return ffa.joinRoom(player, id);
    };
    this.closeRoom = (id) => {
      const room = ffa.getRoom(id);
      for (const timer of room?._wireTimers ?? []) this._timers.clearTimeout(timer);
      for (const timer of room?._dynTimers?.values() ?? []) this._timers.clearTimeout(timer);
      room?._wireTimers?.clear();
      room?._dynTimers?.clear();
      ffa.closeRoom(id);
    };
    this.openRooms = ffa.openRooms;
    this.liveRooms = ffa.liveRooms;
    this.getRoom = ffa.getRoom;
    this.publicRoom = ffa._pub;
  }

  quiesce() {
    this.accepting = false;
  }

  // Override launchRoom (worms calls it launchRoom not startRoom)
  launchRoom(accountId, roomId, theme = 0) {
    const room = this._rooms.get(roomId);
    if (!room) return { ok: false, error: 'not_found' };
    if (room.state !== 'waiting') return { ok: false, error: 'already_started' };
    if (room.players[0].accountId !== accountId) return { ok: false, error: 'not_creator' };
    if (room.players.length < 2) return { ok: false, error: 'need_more_players' };

    if (!this._beforeLaunch(room)) return { ok: false, error: 'settlement_pending' };
    this._timers.clearTimeout(room._waitTimer);
    this._timers.clearTimeout(room._expireTimer);
    room._waitTimer = room._expireTimer = null;
    room._generation = (room._generation ?? 0) + 1;
    room.theme = Math.max(0, Math.min(4, Math.round(+theme || 0)));

    const seed = parseInt(roomId.slice(0, 8), 16) || this._now();
    const lvl = _levelData.get(room.theme);
    if (lvl) {
      // Real map — use pixel mask + pre-computed heights
      room.terrain = lvl.heights;
      room.mask = lvl.mask;
    } else {
      // Fallback: procedural terrain
      room.terrain = generateTerrain(seed);
      room.mask = null;
    }
    room.holes = [];
    room.crates = [];
    room.dynamites = []; // [{id, cx, cy, placedBy, fuseMs}]
    room.mines = []; // [{id, cx, cy, placedBy, armedAt}]
    room.round = 0;
    room.wind = Math.round(randomUnit() * 10 - 5); // -5 to +5
    room.waterLevel = WATER_Y;
    room.suddenDeath = false;
    room.worms = spawnWorms(room.terrain, room.players, seed);
    room.turnOrder = room.players.map((p) => p.userId);
    room.turnIdx = 0;
    room.currentTurn = room.turnOrder[0];
    room.activeWormId = this._pickWorm(room);
    room.state = 'playing';
    room.playerAmmo = {};
    for (const p of room.players) room.playerAmmo[p.userId] = { ...INITIAL_AMMO };
    room.turnActionTaken = false;
    room.activeTool = null;
    room.retreating = false;
    room._moveAudit = new Map();
    this._startTurnTimer(roomId);

    return { ok: true, game: this._snap(room) };
  }

  // ── Post-match ───────────────────────────────────────────────────────────
  markSettled(roomId) {
    const room = this.getRoom(roomId);
    if (room && !this._settlementReady(room)) throw new Error('WORMS_SETTLEMENT_PENDING');
    if (room) room._settlementPending = false;
    return this.ffa.markSettled(roomId, POST_MATCH_TTL);
  }

  requestRematch(accountId, roomId) {
    if (!this.accepting) return { ok: false, error: 'unavailable' };
    if (this.getRoom(roomId)?._settlementPending) return { ok: false, error: 'settlement_pending' };
    return this.ffa.requestRoomRematch(accountId, roomId);
  }

  reopenForRematch(roomId) {
    if (!this.accepting) return { ok: false, error: 'unavailable' };
    if (this.getRoom(roomId)?._settlementPending) return { ok: false, error: 'settlement_pending' };
    return this.ffa.reopenForRematch(roomId);
  }

  leavePostGame(accountId, roomId) {
    const room = this._rooms.get(roomId);
    if (room?._settlementPending) return { ok: false, error: 'settlement_pending' };
    return this.ffa.leavePostGameRoom(accountId, roomId, 'not_done', {
      players: room ? [...room.players] : [],
    });
  }

  // Helper: build the common return shape for worm actions with no damage
  _noDamageReturn(room, extra = {}) {
    return {
      trajectories: [],
      newHoles: [],
      wormDamages: [],
      dropResults: [],
      worms: room.worms.map(({ id, cx, cy, hp, alive }) => ({ id, cx, cy, hp, alive })),
      gameOver: false,
      winner: null,
      ...extra,
    };
  }

  _validateFire(room, accountId, weapon) {
    if (!room || room.state !== 'playing') return { error: 'not_playing' };
    const player = room.players.find((p) => p.accountId === accountId);
    if (!player) return { error: 'not_in_room' };
    if (player.userId !== room.currentTurn) return { error: 'not_your_turn' };
    if (!Object.hasOwn(WEAPONS, weapon)) return { error: 'invalid_weapon' };
    if (room.turnActionTaken) return { error: 'action_taken' };
    const wDef = WEAPONS[weapon] ?? WEAPONS.bazooka;
    const fromW = room.worms.find((w) => w.id === room.activeWormId);
    if (!fromW || !fromW.alive) return { error: 'no_active_worm' };
    return { ok: true, player, wDef, fromW };
  }

  _hasAmmo(room, player, weapon) {
    const ammo = room.playerAmmo?.[player.userId];
    if (!ammo) return true;
    const count = Object.hasOwn(ammo, weapon) ? Reflect.get(ammo, weapon) : 0;
    return count === Infinity || count > 0;
  }

  _consumeAmmo(room, player, weapon) {
    const ammo = room.playerAmmo?.[player.userId];
    if (!ammo) return;
    const count = Object.hasOwn(ammo, weapon) ? Reflect.get(ammo, weapon) : 0;
    if (count !== Infinity) Reflect.set(ammo, weapon, Math.max(0, count - 1));
  }

  _completeAction(room, player, weapon, result) {
    if (!result?.ok) return result;
    this._consumeAmmo(room, player, weapon);
    room.turnActionTaken = true;
    room.activeTool = MOVEMENT_TOOLS.has(weapon) ? weapon : null;
    return {
      ...result,
      playerId: player.userId,
      ammo: { ...(room.playerAmmo?.[player.userId] ?? {}) },
    };
  }

  // ── Firing ─────────────────────────────────────────────────────────────────
  fire(accountId, roomId, { angle, power, weapon, targetX, targetY, fuseMs }) {
    const room = this._rooms.get(roomId);
    const valid = this._validateFire(room, accountId, weapon);
    if (valid.error) return { ok: false, error: valid.error };
    const { player, wDef, fromW } = valid;

    const a = parseFloat(angle);
    const rawPower = parseFloat(power);
    const p = Math.max(0.05, Math.min(1.0, Number.isFinite(rawPower) ? rawPower : 0.7));
    if (!Number.isFinite(a) && weapon !== 'teleport') return { ok: false, error: 'invalid_angle' };

    // Validate first and consume only once the weapon action succeeds.
    if (!this._hasAmmo(room, player, weapon)) return { ok: false, error: 'no_ammo' };

    // ── Movement tools: no projectile, no damage
    const moveResult = this._handleMovementTools(room, weapon, fromW, a, p, targetX, targetY);
    if (moveResult) return this._completeAction(room, player, weapon, moveResult);

    // Fuse timer for grenade-type weapons
    let resolvedFuseMs = null;
    if (GRENADE_FUSE_WEAPONS.has(weapon)) {
      resolvedFuseMs = Math.max(
        1000,
        Math.min(5000, Math.round(+fuseMs || DEFAULT_FUSE_MS[weapon] || 3000)),
      );
    }

    // Simulate all pellets
    const { trajectories, impacts } = this._simulateProjectiles(
      room,
      fromW,
      a,
      p,
      wDef,
      weapon,
      resolvedFuseMs,
      targetX,
    );

    // Cluster bomb: add sub-impacts around main impact
    if (wDef.cluster) this._addClusterImpacts(impacts, wDef, room);

    // Apply holes, damage, gravity drop, water deaths
    const { newHoles, wormDamages, dropResults } = this._applyExplosionEffects(room, impacts, wDef);

    const check = this._checkWinner(room);
    if (check.gameOver) {
      this._timers.clearTimeout(room._turnTimer);
      room.state = 'done';
      room._settlementPending = true;
    }

    return this._completeAction(room, player, weapon, {
      ok: true,
      trajectories,
      newHoles,
      wormDamages,
      dropResults,
      fuseMs: resolvedFuseMs,
      worms: room.worms.map(({ id, cx, cy, hp, alive }) => ({ id, cx, cy, hp, alive })),
      gameOver: check.gameOver,
      winner: check.winner,
    });
  }

  useMovementTool(accountId, roomId, weapon) {
    const room = this._rooms.get(roomId);
    const valid = this._validateFire(room, accountId, weapon);
    if (valid.error) return { ok: false, error: valid.error };
    if (!MOVEMENT_TOOLS.has(weapon)) return { ok: false, error: 'invalid_weapon' };
    if (!this._hasAmmo(room, valid.player, weapon)) return { ok: false, error: 'no_ammo' };
    return this._completeAction(room, valid.player, weapon, {
      ok: true,
      weapon,
      ...this._noDamageReturn(room),
    });
  }

  _handleMovementTools(room, weapon, fromW, a, p, targetX, targetY) {
    // Ninja rope / Jetpack: no projectile, no damage
    if (weapon === 'ninja_rope' || weapon === 'jetpack') {
      return { ok: true, weapon, ...this._noDamageReturn(room) };
    }

    // Teleport: move worm to clicked position
    if (weapon === 'teleport') {
      const tx = parseFloat(targetX),
        ty = parseFloat(targetY);
      if (!Number.isFinite(tx) || !Number.isFinite(ty))
        return { ok: false, error: 'invalid_target' };
      const clampX = Math.max(WORM_R, Math.min(WORLD_W - WORM_R, tx));
      const waterY = room.waterLevel ?? WATER_Y;
      let clampY = Math.max(WORM_R, Math.min(waterY - WORM_R - 1, ty));
      while (clampY > WORM_R && isSolid(room.terrain, room.holes, clampX, clampY, room.mask))
        clampY--;
      while (
        clampY + WORM_R < waterY &&
        !isSolid(room.terrain, room.holes, clampX, clampY + WORM_R + 1, room.mask)
      )
        clampY++;
      if (clampY <= WORM_R || clampY + WORM_R >= waterY)
        return { ok: false, error: 'invalid_target' };
      fromW.cx = clampX;
      fromW.cy = clampY;
      room._moveAudit?.set(fromW.id, { cx: clampX, cy: clampY, at: this._now() });
      return {
        ok: true,
        weapon,
        teleported: true,
        cx: clampX,
        cy: clampY,
        ...this._noDamageReturn(room),
      };
    }

    // Dynamite: plant at worm's position with a 5s fuse
    if (weapon === 'dynamite') {
      const dynId = genId();
      const now = this._now();
      room.dynamites.push({
        id: dynId,
        cx: fromW.cx,
        cy: fromW.cy,
        placedBy: fromW.id,
        fuseMs: 5000,
        fuseStarted: now,
      });
      return {
        ok: true,
        weapon,
        planted: true,
        dynId,
        cx: fromW.cx,
        cy: fromW.cy,
        fuseMs: 5000,
        fuseStarted: now,
        ...this._noDamageReturn(room),
      };
    }

    // Land mine: plant at worm's position (arms after 1s)
    if (weapon === 'land_mine') {
      const mineId = genId();
      room.mines.push({
        id: mineId,
        cx: fromW.cx,
        cy: fromW.cy,
        placedBy: fromW.id,
        armedAt: this._now() + 1200,
      });
      return {
        ok: true,
        weapon,
        planted: true,
        mineId,
        cx: fromW.cx,
        cy: fromW.cy,
        ...this._noDamageReturn(room),
      };
    }

    if (weapon === 'drill') return this._handleDrill(room, fromW, a, WEAPONS.drill);

    // Bat: melee hit in aimed direction
    if (WEAPONS[weapon]?.melee) {
      const wDef = WEAPONS[weapon] ?? WEAPONS.bazooka;
      return this._handleMelee(room, weapon, fromW, a, wDef);
    }

    return null; // not a movement tool
  }

  _handleDrill(room, fromW, angle, wDef) {
    const points = [];
    const newHoles = [];
    for (let step = 1; step <= 8; step++) {
      const cx = fromW.cx + Math.cos(angle) * step * 17;
      const cy = fromW.cy + Math.sin(angle) * step * 17;
      if (cx < 2 || cx >= WORLD_W - 2 || cy < 2 || cy >= WORLD_H - 2) break;
      points.push({ cx, cy });
      const hole = { cx, cy, r: 15 };
      room.holes.push(hole);
      newHoles.push(hole);
    }

    const wormDamages = [];
    for (const worm of room.worms) {
      if (!worm.alive || worm.id === fromW.id) continue;
      if (points.some((pt) => Math.hypot(worm.cx - pt.cx, worm.cy - pt.cy) <= WORM_R + 8)) {
        this._damageWorm(worm, wDef.damage, wormDamages);
      }
    }
    const dropResults = this._applyExplosionDrops(room, wormDamages);
    this._applyWaterDeaths(room, wormDamages);
    const check = this._checkWinner(room);
    if (check.gameOver) {
      this._timers.clearTimeout(room._turnTimer);
      room.state = 'done';
      room._settlementPending = true;
    }
    return {
      ok: true,
      weapon: 'drill',
      trajectories: [points],
      newHoles,
      wormDamages,
      dropResults,
      worms: room.worms.map(({ id, cx, cy, hp, alive }) => ({ id, cx, cy, hp, alive })),
      gameOver: check.gameOver,
      winner: check.winner,
    };
  }

  _handleMelee(room, weapon, fromW, a, wDef) {
    const batRange = 52;
    const wormDamages = [];
    for (const worm of room.worms) {
      if (!worm.alive || worm.id === fromW.id) continue;
      const dx = worm.cx - fromW.cx,
        dy = worm.cy - fromW.cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= batRange && dx * Math.cos(a) >= -12) {
        worm.hp = Math.max(0, worm.hp - wDef.damage);
        if (worm.hp === 0) worm.alive = false;
        wormDamages.push({
          wormId: worm.id,
          damage: wDef.damage,
          hp: worm.hp,
          killed: !worm.alive,
        });
      }
    }
    for (const d of wormDamages) {
      const w = room.worms.find((x) => x.id === d.wormId);
      if (w) {
        const { cy } = dropWorm(w, room.terrain, room.holes, room.mask);
        w.cy = cy;
      }
    }
    const check = this._checkWinner(room);
    if (check.gameOver) {
      this._timers.clearTimeout(room._turnTimer);
      room.state = 'done';
      room._settlementPending = true;
    }
    return {
      ok: true,
      weapon,
      trajectories: [],
      newHoles: [],
      wormDamages,
      dropResults: [],
      worms: room.worms.map(({ id, cx, cy, hp, alive }) => ({ id, cx, cy, hp, alive })),
      gameOver: check.gameOver,
      winner: check.winner,
    };
  }

  _simulateProjectiles(room, fromW, a, p, wDef, weapon, resolvedFuseMs, targetX) {
    const trajectories = [];
    const impacts = [];

    if (wDef.vertical) {
      // Airstrike: bombs fall straight down at target x position
      const requestedX = parseFloat(targetX);
      const strikeX = Number.isFinite(requestedX)
        ? Math.max(24, Math.min(WORLD_W - 24, requestedX))
        : Math.max(24, Math.min(WORLD_W - 24, fromW.cx + Math.cos(a) * 180));
      const halfN = Math.floor(wDef.pellets / 2);
      for (let i = 0; i < wDef.pellets; i++) {
        const bx = Math.max(1, Math.min(WORLD_W - 2, strikeX + (i - halfN) * 38));
        const traj = [];
        let cy = -30;
        for (let step = 0; step < SIM_STEPS; step++) {
          cy += 12;
          if (step % TRAJ_SAMPLE === 0) traj.push({ cx: bx, cy });
          if (cy >= 0 && isSolid(room.terrain, room.holes, bx, cy, room.mask)) {
            impacts.push({ cx: bx, cy, r: wDef.radius });
            traj.push({ cx: bx, cy });
            break;
          }
          if (cy >= WORLD_H) {
            impacts.push({ cx: bx, cy: WORLD_H - 1, r: wDef.radius });
            traj.push({ cx: bx, cy: WORLD_H - 1 });
            break;
          }
        }
        trajectories.push(traj);
      }
    } else {
      for (let i = 0; i < wDef.pellets; i++) {
        const pelletAngle =
          wDef.pellets > 1
            ? a + (i - Math.floor(wDef.pellets / 2)) * (wDef.spread / wDef.pellets)
            : a;
        const { trajectory, impact } = this._simProjectile(
          room,
          fromW,
          pelletAngle,
          p * wDef.speed,
          weapon,
          resolvedFuseMs,
        );
        trajectories.push(trajectory);
        if (impact) impacts.push({ cx: impact.cx, cy: impact.cy, r: wDef.radius });
      }
    }

    return { trajectories, impacts };
  }

  _addClusterImpacts(impacts, wDef, room) {
    const clR = rng((this._now() ^ parseInt(room.id.slice(0, 8), 16)) >>> 0);
    const mainImpacts = [...impacts];
    for (const imp of mainImpacts) {
      for (let c = 0; c < wDef.cluster; c++) {
        const ang = clR() * Math.PI * 2;
        const dist = wDef.radius * (0.8 + clR() * 1.2);
        const cx2 = imp.cx + Math.cos(ang) * dist;
        const cy2 = imp.cy + Math.sin(ang) * dist;
        impacts.push({ cx: cx2, cy: cy2, r: Math.round(wDef.radius * 0.6) });
      }
    }
  }

  _applyExplosionEffects(room, impacts, wDef) {
    const newHoles = this._applyExplosionHoles(room, impacts);
    const wormDamages = [];
    this._applyBlastDamage(room, impacts, wDef, wormDamages);
    const dropResults = this._applyExplosionDrops(room, wormDamages);
    this._applyWaterDeaths(room, wormDamages);
    return { newHoles, wormDamages, dropResults };
  }

  _applyExplosionHoles(room, impacts) {
    const newHoles = [];
    for (const imp of impacts) {
      room.holes.push(imp);
      newHoles.push(imp);
    }
    return newHoles;
  }

  _applyBlastDamage(room, impacts, wDef, wormDamages) {
    for (const imp of impacts) {
      for (const worm of room.worms) this._damageWormFromImpact(worm, imp, wDef, wormDamages);
    }
  }

  _damageWormFromImpact(worm, imp, wDef, wormDamages) {
    if (!worm.alive) return;
    const dx = worm.cx - imp.cx,
      dy = worm.cy - imp.cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const maxD = imp.r * 2.2;
    if (dist > maxD) return;
    const dmg = Math.round(wDef.damage * Math.max(0, 1 - dist / maxD));
    if (dmg <= 0) return;
    this._damageWorm(worm, dmg, wormDamages);
  }

  _applyExplosionDrops(room, wormDamages) {
    const dropResults = [];
    for (const worm of room.worms) {
      if (!worm.alive) continue;
      const { cy: newCy, fallDmg } = dropWorm(worm, room.terrain, room.holes, room.mask);
      if (newCy === worm.cy && fallDmg <= 0) continue;
      worm.cy = newCy;
      if (fallDmg > 0) this._damageWorm(worm, fallDmg, wormDamages);
      dropResults.push({ wormId: worm.id, cy: worm.cy });
    }
    return dropResults;
  }

  _applyWaterDeaths(room, wormDamages) {
    const waterY = room.waterLevel ?? WATER_Y;
    for (const worm of room.worms) {
      if (!worm.alive || worm.cy < waterY) continue;
      worm.alive = false;
      worm.hp = 0;
      wormDamages.push({ wormId: worm.id, damage: 999, hp: 0, killed: true });
    }
  }

  _damageWorm(worm, damage, wormDamages) {
    worm.hp = Math.max(0, worm.hp - damage);
    if (worm.hp === 0) worm.alive = false;
    wormDamages.push({ wormId: worm.id, damage, hp: worm.hp, killed: !worm.alive });
  }

  // ── Projectile simulation helpers ─────────────────────────────────────

  _simCheckWormHit(room, fromWorm, cx, cy) {
    for (const w of room.worms) {
      if (!w.alive || w.id === fromWorm.id) continue;
      const dx = cx - w.cx,
        dy = cy - w.cy;
      if (dx * dx + dy * dy <= WORM_R * WORM_R) {
        return { cx, cy };
      }
    }
    return null;
  }

  _simBounce(cx, cy, vx, vy, prevCx, prevCy, doBounce, bounces, room, trajectory, i) {
    if (!doBounce || bounces >= MAX_BOUNCES) return null;
    cx = prevCx;
    cy = prevCy;
    const hitY = isSolid(room.terrain, room.holes, cx, cy + Math.sign(vy || 1), room.mask);
    const hitX = isSolid(room.terrain, room.holes, cx + Math.sign(vx || 1), cy, room.mask);
    if (hitY) vy = -vy * BOUNCE_COEFF;
    else vy *= BOUNCE_COEFF;
    if (hitX) vx = -vx * BOUNCE_COEFF;
    else vx *= BOUNCE_COEFF;
    if (!hitY && !hitX) {
      vy = -vy * BOUNCE_COEFF;
      vx = -vx * BOUNCE_COEFF;
    }
    bounces++;
    if (i % TRAJ_SAMPLE === 0) trajectory.push({ cx, cy });
    return { bounced: true, cx, cy, vx, vy, bounces };
  }

  _simProjectile(room, fromWorm, angle, powerFactor, weapon = 'bazooka', fuseMs = null) {
    const speed = MAX_PROJ_SPEED * powerFactor;
    const windAcc = WIND_WEAPONS.has(weapon) ? (room.wind ?? 0) * WIND_ACCEL : 0;
    const doBounce = BOUNCE_WEAPONS.has(weapon);
    // Pre-compute fuse expiry step (null = no fuse limit)
    const fuseStep = fuseMs != null ? Math.round(fuseMs / 1000 / SIM_DT) : null;
    let bounces = 0;
    let vx = Math.cos(angle) * speed;
    let vy = Math.sin(angle) * speed;
    let cx = fromWorm.cx + Math.cos(angle) * (WORM_R + 8);
    let cy = fromWorm.cy + Math.sin(angle) * (WORM_R + 8);

    const trajectory = [{ cx, cy }];
    let impact = null;

    for (let i = 0; i < SIM_STEPS; i++) {
      const prevCx = cx,
        prevCy = cy;
      cx += vx * SIM_DT;
      cy += vy * SIM_DT;
      if (!DIRECT_FIRE_WEAPONS.has(weapon)) vy += GRAVITY * SIM_DT;
      vx += windAcc * SIM_DT;

      if (cx < 0 || cx >= WORLD_W || cy >= WORLD_H) {
        impact = { cx: Math.max(0, Math.min(WORLD_W - 1, cx)), cy: Math.min(WORLD_H - 1, cy) };
        break;
      }
      if (cy < -200) {
        if (i % TRAJ_SAMPLE === 0) trajectory.push({ cx, cy });
        continue;
      }

      // Fuse expiry: detonate wherever the projectile is right now
      if (fuseStep != null && i >= fuseStep) {
        impact = { cx, cy };
        break;
      }

      // Check direct worm-body hit (not the firing worm)
      const wormHit = this._simCheckWormHit(room, fromWorm, cx, cy);
      if (wormHit) {
        impact = wormHit;
        break;
      }

      // Terrain collision with optional bouncing
      if (isSolid(room.terrain, room.holes, cx, cy, room.mask)) {
        const bounceResult = this._simBounce(
          cx,
          cy,
          vx,
          vy,
          prevCx,
          prevCy,
          doBounce,
          bounces,
          room,
          trajectory,
          i,
        );
        if (bounceResult) {
          cx = bounceResult.cx;
          cy = bounceResult.cy;
          vx = bounceResult.vx;
          vy = bounceResult.vy;
          bounces = bounceResult.bounces;
          continue;
        }
        impact = { cx, cy };
        break;
      }
      if (i % TRAJ_SAMPLE === 0) trajectory.push({ cx, cy });
    }

    if (!impact) impact = { cx, cy };
    const last = trajectory.at(-1);
    if (!last || Math.hypot(last.cx - impact.cx, last.cy - impact.cy) > 0.5) {
      trajectory.push({ cx: impact.cx, cy: impact.cy });
    }
    return { trajectory, impact };
  }

  _checkWinner(room) {
    const alive = room.players.filter((p) =>
      room.worms.some((w) => w.playerId === p.userId && w.alive),
    );
    if (alive.length === 0) return { gameOver: true, winner: null };
    if (alive.length === 1) return { gameOver: true, winner: alive[0] };
    return { gameOver: false, winner: null };
  }

  // ── Advance to next alive player in turn order ─────────────────────────────
  _advanceTurnOrder(room) {
    const prevIdx = room.turnIdx;
    let tries = 0;
    do {
      room.turnIdx = (room.turnIdx + 1) % room.turnOrder.length;
      room.currentTurn = room.turnOrder[room.turnIdx];
      tries++;
    } while (
      !room.worms.some((w) => w.playerId === room.currentTurn && w.alive) &&
      tries <= room.turnOrder.length
    );
    return prevIdx;
  }

  // ── Handle round increment, sudden death, rising water ──────────────────
  _handleRoundIncrement(room, prevIdx) {
    if (room.turnIdx <= prevIdx) {
      room.round = (room.round ?? 0) + 1;
      // Sudden death: reduce all worms to 1 HP
      if (!room.suddenDeath && room.round >= SUDDEN_DEATH_ROUND) {
        room.suddenDeath = true;
        for (const w of room.worms) {
          if (w.alive) w.hp = Math.min(w.hp, 1);
        }
      }
      // Rising water in sudden death
      if (room.suddenDeath) {
        room.waterLevel = Math.max(100, room.waterLevel - 8);
        for (const w of room.worms) {
          if (w.alive && w.cy >= room.waterLevel) {
            w.hp = 0;
            w.alive = false;
          }
        }
      }
      // Change wind each round
      this._rollWind(room);
    }
  }

  // ── Roll wind for a new round ───────────────────────────────────────────
  _rollWind(room) {
    room.wind = Math.round(randomUnit() * 10 - 5);
  }

  // ── Turn management ────────────────────────────────────────────────────────
  nextTurn(roomId) {
    const room = this._rooms.get(roomId);
    if (!room || room.state !== 'playing') return null;
    this._timers.clearTimeout(room._turnTimer);
    room._wireTimers?.delete(room._retreatTimer);
    this._timers.clearTimeout(room._retreatTimer);
    room._retreatTimer = null;

    const prevIdx = this._advanceTurnOrder(room);
    this._handleRoundIncrement(room, prevIdx);

    const roundCheck = this._checkWinner(room);
    if (roundCheck.gameOver) {
      room.state = 'done';
      room._settlementPending = true;
      return {
        gameOver: true,
        winner: roundCheck.winner,
        worms: room.worms.map(({ id, cx, cy, hp, alive }) => ({ id, cx, cy, hp, alive })),
      };
    }

    room.activeWormId = this._pickWorm(room);
    room.turnActionTaken = false;
    room.activeTool = null;
    room.retreating = false;
    room._moveAudit = new Map();
    this._startTurnTimer(roomId);
    const mineResults = this.checkMines(roomId);
    return {
      currentTurn: room.currentTurn,
      activeWormId: room.activeWormId,
      turnMs: TURN_MS,
      round: room.round ?? 0,
      wind: room.wind ?? 0,
      suddenDeath: room.suddenDeath ?? false,
      waterLevel: room.waterLevel ?? WATER_Y,
      worms: room.worms.map(({ id, cx, cy, hp, alive }) => ({ id, cx, cy, hp, alive })),
      crates: room.crates ?? [],
      dynamites: room.dynamites ?? [],
      mines: room.mines ?? [],
      mineResults,
      ammo: room.playerAmmo?.[room.currentTurn] ?? {},
    };
  }

  // ── Dynamite detonation (called by wire after 5s fuse) ──────────────────
  detonateDynamite(roomId, dynId) {
    const room = this._rooms.get(roomId);
    if (!room) return null;
    const dynIdx = room.dynamites.findIndex((d) => d.id === dynId);
    if (dynIdx === -1) return null;
    const [dyn] = room.dynamites.splice(dynIdx, 1);
    return this._applyExplosion(room, dyn.cx, dyn.cy, WEAPONS.dynamite, { dynId });
  }

  // ── Mine proximity check (called on pos update & turn start) ────────────
  checkMines(roomId) {
    const room = this._rooms.get(roomId);
    if (!room || room.state !== 'playing') return [];
    const MINE_R = 18;
    const now = this._now();
    const results = [];
    for (const mine of room.mines.slice()) {
      if (now < mine.armedAt) continue;
      for (const worm of room.worms) {
        if (!worm.alive) continue;
        const dx = worm.cx - mine.cx,
          dy = worm.cy - mine.cy;
        if (dx * dx + dy * dy <= MINE_R * MINE_R) {
          const idx = room.mines.indexOf(mine);
          if (idx >= 0) room.mines.splice(idx, 1);
          const res = this._applyExplosion(room, mine.cx, mine.cy, WEAPONS.land_mine, {
            mineId: mine.id,
          });
          if (res) results.push(res);
          break;
        }
      }
    }
    return results;
  }

  // ── Shared explosion helper ──────────────────────────────────────────────
  _applyExplosion(room, cx, cy, wDef, extra = {}) {
    const imp = { cx, cy, r: wDef.radius };
    room.holes.push(imp);
    const wormDamages = [];
    for (const worm of room.worms) {
      if (!worm.alive) continue;
      const dx = worm.cx - cx,
        dy = worm.cy - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const maxD = wDef.radius * 2.2;
      if (dist <= maxD) {
        const dmg = Math.round(wDef.damage * Math.max(0, 1 - dist / maxD));
        if (dmg <= 0) continue;
        worm.hp = Math.max(0, worm.hp - dmg);
        if (worm.hp === 0) worm.alive = false;
        wormDamages.push({ wormId: worm.id, damage: dmg, hp: worm.hp, killed: !worm.alive });
      }
    }
    for (const worm of room.worms) {
      if (!worm.alive) continue;
      const { cy: newCy } = dropWorm(worm, room.terrain, room.holes, room.mask);
      worm.cy = newCy;
    }
    for (const worm of room.worms) {
      if (!worm.alive) continue;
      if (worm.cy >= (room.waterLevel ?? WATER_Y)) {
        worm.alive = false;
        worm.hp = 0;
        wormDamages.push({ wormId: worm.id, damage: 999, hp: 0, killed: true });
      }
    }
    const check = this._checkWinner(room);
    if (check.gameOver) {
      this._timers.clearTimeout(room._turnTimer);
      room.state = 'done';
      room._settlementPending = true;
    }
    return {
      ...extra,
      cx,
      cy,
      newHoles: [imp],
      wormDamages,
      worms: room.worms.map(({ id, cx, cy, hp, alive }) => ({ id, cx, cy, hp, alive })),
      gameOver: check.gameOver,
      winner: check.winner,
    };
  }

  spawnCrate(roomId) {
    const room = this._rooms.get(roomId);
    if (!room || room.state !== 'playing') return null;
    const cx = Math.round(40 + randomUnit() * (WORLD_W - 80));
    const xi = Math.max(0, Math.min(WORLD_W - 1, cx));
    const cy = Math.max(10, (room.terrain[xi] ?? WORLD_H * 0.6) - 12);
    const types = ['weapon', 'weapon', 'weapon', 'health'];
    const type = types[randomIndex(types.length)];
    const safeWeapons = Object.keys(WEAPONS).filter((k) => !['dynamite', 'land_mine'].includes(k));
    const weapon = type === 'weapon' ? safeWeapons[randomIndex(safeWeapons.length)] : null;
    const id = genId();
    const crate = { id, cx, cy, type, weapon };
    room.crates.push(crate);
    return crate;
  }

  collectCrate(accountId, roomId, crateId) {
    const room = this._rooms.get(roomId);
    if (!room || room.state !== 'playing') return null;
    const player = room.players.find((p) => p.accountId === accountId);
    if (!player || player.userId !== room.currentTurn) return null;
    const crateIdx = room.crates.findIndex((c) => c.id === crateId);
    if (crateIdx === -1) return null;
    const crate = room.crates[crateIdx];
    const worm = room.worms.find(
      (w) => w.id === room.activeWormId && w.playerId === player.userId && w.alive,
    );
    if (!worm) return null;
    const dx = worm.cx - crate.cx,
      dy = worm.cy - crate.cy;
    if (dx * dx + dy * dy > (WORM_R + 18) ** 2) return null;
    room.crates.splice(crateIdx, 1);
    if (crate.type === 'health') worm.hp = Math.min(100, worm.hp + 25);
    if (crate.type === 'weapon' && crate.weapon && Object.hasOwn(WEAPONS, crate.weapon)) {
      const ammo = room.playerAmmo?.[player.userId];
      if (ammo) {
        const cur = ammo[crate.weapon] ?? 0;
        if (cur !== Infinity) Reflect.set(ammo, crate.weapon, cur + 1);
      }
    }
    return {
      crateId,
      type: crate.type,
      weapon: crate.weapon,
      wormId: worm.id,
      hp: worm.hp,
      ammo: room.playerAmmo?.[player.userId] ?? {},
    };
  }

  selectWorm(accountId, roomId, wormId) {
    const room = this._rooms.get(roomId);
    if (!room || room.state !== 'playing') return null;
    const player = room.players.find((p) => p.accountId === accountId);
    if (!player || player.userId !== room.currentTurn || room.turnActionTaken) return null;
    const worm = room.worms.find((w) => w.id === wormId && w.playerId === player.userId && w.alive);
    if (!worm) return null;
    room.activeWormId = wormId;
    return { activeWormId: wormId };
  }

  _pickWorm(room) {
    const mine = room.worms.filter((w) => w.playerId === room.currentTurn && w.alive);
    if (!mine.length) return null;
    const key = room.currentTurn;
    const idx = (this._wormTurn.get(key) ?? 0) % mine.length;
    this._wormTurn.set(key, idx + 1);
    return mine[idx].id;
  }

  _startTurnTimer(roomId) {
    const room = this._rooms.get(roomId);
    if (!room) return;
    this._timers.clearTimeout(room._turnTimer);
    room._turnSerial = (room._turnSerial ?? 0) + 1;
    const generation = room._generation,
      serial = room._turnSerial;
    const timer = this._timers.setTimeout(() => {
      if (
        this._rooms.get(roomId) !== room ||
        room.state !== 'playing' ||
        room._turnTimer !== timer ||
        room._generation !== generation ||
        room._turnSerial !== serial
      )
        return;
      room._turnTimer = null;
      this.emit('turn:timeout', { roomId });
    }, TURN_MS);
    room._turnTimer = timer;
  }

  // ── Position sync (movement during turn) ──────────────────────────────────
  updateWormPos(accountId, roomId, wormId, cx, cy) {
    const room = this._rooms.get(roomId);
    if (!room || room.state !== 'playing') return null;
    const player = room.players.find((p) => p.accountId === accountId);
    if (!player || player.userId !== room.currentTurn) return null;
    if (wormId !== room.activeWormId) return null;
    const worm = room.worms.find((w) => w.id === wormId && w.alive);
    if (!worm) return null;

    // After firing, movement is accepted only for a movement tool or the
    // explicit retreat phase. This keeps the client responsive without making
    // arbitrary post-shot teleport packets authoritative.
    if (room.turnActionTaken && !room.activeTool && !room.retreating) return null;

    const rawX = Number(cx),
      rawY = Number(cy);
    if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) return null;
    const nextX = Math.max(WORM_R, Math.min(WORLD_W - WORM_R, rawX));
    const nextY = Math.max(WORM_R, Math.min(WORLD_H - 1, rawY));
    const now = this._now();
    const previous = room._moveAudit?.get(worm.id) ?? { cx: worm.cx, cy: worm.cy, at: now - 100 };
    const elapsed = Math.max(0.04, Math.min(0.25, (now - previous.at) / 1000));
    const maxDistance = MOVE_GRACE_PX + MAX_MOVE_SPEED * elapsed;
    if (Math.hypot(nextX - previous.cx, nextY - previous.cy) > maxDistance) return null;

    // Reject positions buried well inside intact terrain, while tolerating the
    // pixel rounding that naturally occurs when standing on a slope.
    if (
      isSolid(room.terrain, room.holes, nextX, nextY, room.mask) &&
      isSolid(room.terrain, room.holes, nextX, nextY - WORM_R * 0.7, room.mask)
    )
      return null;

    worm.cx = nextX;
    worm.cy = nextY;
    room._moveAudit ??= new Map();
    room._moveAudit.set(worm.id, { cx: nextX, cy: nextY, at: now });

    let drowned = null;
    if (worm.cy >= (room.waterLevel ?? WATER_Y)) {
      worm.hp = 0;
      worm.alive = false;
      const check = this._checkWinner(room);
      if (check.gameOver) {
        this._timers.clearTimeout(room._turnTimer);
        room.state = 'done';
        room._settlementPending = true;
      }
      drowned = {
        wormDamages: [{ wormId: worm.id, damage: 999, hp: 0, killed: true }],
        worms: room.worms.map(({ id, cx: wx, cy: wy, hp, alive }) => ({
          id,
          cx: wx,
          cy: wy,
          hp,
          alive,
        })),
        gameOver: check.gameOver,
        winner: check.winner,
      };
    }
    const mineResults = this.checkMines(roomId);
    return { wormId, cx: worm.cx, cy: worm.cy, mineResults, drowned };
  }

  // ── Forfeit ────────────────────────────────────────────────────────────────
  forfeit(accountId, roomId) {
    const room = this._rooms.get(roomId);
    if (!room) return { ok: false, error: 'not_found' };
    const player = room.players.find((p) => p.accountId === accountId);
    if (!player) return { ok: false, error: 'not_in_room' };

    if (room.state === 'waiting') {
      const players = [...room.players];
      this.closeRoom(roomId);
      this.emit('room:expired', { roomId, players, bet: room.bet });
      return { ok: true, waiting: true, player };
    }

    if (room.state === 'playing') {
      if (room.currentTurn === player.userId) {
        this._timers.clearTimeout(room._turnTimer);
        room._turnTimer = null;
      }
      for (const w of room.worms) {
        if (w.playerId === player.userId) {
          w.hp = 0;
          w.alive = false;
        }
      }
      const check = this._checkWinner(room);
      if (check.gameOver) {
        room.state = 'done';
        room._settlementPending = true;
      }
      return { ok: true, waiting: false, player, winner: check.winner, gameOver: check.gameOver };
    }

    return { ok: false, error: 'invalid_state' };
  }

  // ── Snapshot ───────────────────────────────────────────────────────────────
  _snap(room) {
    return {
      roomId: room.id,
      bet: room.bet,
      levelIndex: room.theme ?? 0,
      theme: room.theme ?? 0,
      terrain: room.terrain,
      holes: room.holes,
      worms: room.worms.map((w) => ({ ...w })),
      players: room.players.map((p) => ({ userId: p.userId, pseudo: p.pseudo, color: p.color })),
      currentTurn: room.currentTurn,
      activeWormId: room.activeWormId,
      turnMs: TURN_MS,
      wind: room.wind ?? 0,
      round: room.round ?? 0,
      suddenDeath: room.suddenDeath ?? false,
      waterLevel: room.waterLevel ?? WATER_Y,
      crates: room.crates ?? [],
      dynamites: room.dynamites ?? [],
      mines: room.mines ?? [],
      playerAmmo: room.playerAmmo ?? {},
      turnActionTaken: room.turnActionTaken ?? false,
    };
  }
}
