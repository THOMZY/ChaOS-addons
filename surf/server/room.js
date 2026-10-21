/**
 * Surfd adapter for the `chaos-surf-v1` protocol.
 *
 * The binary format below was reconstructed byte by byte from the client
 * (minified bundle). The constants and field order mirror the client and must
 * not be changed:
 *
 *   mu = 1                            protocol version (URL ?v=1)
 *   Client → server (kind 1): 12-byte header + n × 32-byte samples (n = 1..2)
 *     u8 0 = mu | u8 1 = 1 | u8 2 = n | u32 4 = sequence | u32 8 = epoch
 *   Server → client (kind 2): 4-byte header + blocks
 *     u8 0 = mu | u8 1 = 2 | u16 2 = block count (≤ 100)
 *     block (14 bytes): u16 slot | u32 sequence | u32 epoch | u8 n | u8 0 | u16 0
 *     followed by n × 32 bytes
 *   Sample (32 bytes, little-endian):
 *     u32 time | f32 x | f32 y | f32 z | i16 vx | i16 vy | i16 vz
 *     | u16 yaw(0..65535→0..360°) | i16 pitch(/32767×90°) | u8 flags | u8 0 | f32 seconds
 *
 * Text messages: the client sends "ping" (→ "pong"), {type:'ack'|'refresh'
 * |'context'|'chat'|'vote'|'rtv'|'nominate'|'extend'|'report'|'reports'|
 * 'moderate'} and expects {type:'welcome'|'state'|'roster'|'result'|'context'|
 * 'chat'|'notice'|'error'|'reports'|'extend'}.
 * The server selects the map: `state.mapId` triggers the client-side load.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Room, defineGame, attachRooms } from '../../platform/game-servers/core.js';
import { toHexColor } from '../../platform/game-servers/color.js';
import { chatState } from '../../../server/chat/state.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const MU = 1;
export const KIND_BATCH = 1;
export const KIND_SNAPSHOT = 2;
const HEADER_BATCH = 12;
const HEADER_SNAPSHOT = 4;
const BLOCK_HEADER = 14;
const SAMPLE_SIZE = 32;
const MAX_BLOCKS = 100;

export const FLAG = { grounded: 1, crouched: 2, teleport: 4, practice: 8, idle: 16, finished: 32 };

const MAPS_JSON = JSON.parse(readFileSync(resolve(__dirname, 'maps.json'), 'utf8'));

// Map rotation: exact client IDs (the same ones used under /surf/packed/).
//
// GENERATED, never hand-edited: `games/surf/install.mjs` writes
// `maps.json` from the client's own catalogue after each update. A map the
// client added but the server does not rotate is invisible in multiplayer, and
// a hand-maintained list made that a silent omission on every release.
export const MAP_ROTATION = MAPS_JSON.map((m) => m.id);

// Display titles are resolved by the client through `welcome.maps`, so send
// `{ id, title }` objects rather than IDs alone.
export const MAP_TITLES = Object.fromEntries(MAPS_JSON.map((m) => [m.id, m.title]));

/** Room rotation in the format expected by the client. */
export const MAPS = MAP_ROTATION.map((id) => ({ id, title: MAP_TITLES[id] ?? id }));

const MAP_DURATION_MS = 30 * 60_000;
const EXTENSION_MS = 15 * 60_000;
const MAX_EXTENSIONS = 2;
const VOTE_DURATION_MS = 30_000;
const MAX_POSE_BATCHES_PER_SECOND = 150;

// Binary frame kinds. `1` is the regular two-sample pose batch. `3` and `4` are
// the DETAILED spectator poses the client emits only while someone watches it
// (`publishSpectator`): 56 bytes, the sender's slot at offset 2 (hardcoded to
// 0 by the client). They are dropped, never relayed: see `onBinary`.
export const KIND_SPECTATOR = 3;
export const KIND_SPECTATOR_INPUTS = 4;

// Room bans, in memory and per account: they last until the server restarts.
// The site's persistent ban (`chat_bans`) is a different matter — this only
// keeps a player a moderator just removed out of the room.
const roomBans = new Map();   // accountId → { until, reason }

/**
 * Moderator authority, checked on every moderation action. The ticket flag
 * (`player.moderator`) is frozen at connection time and only drives the
 * client's menus; the live `chat_mods` list decides, so a moderator removed on
 * the site loses Change map / Kick / Ban at once, not at the next reconnect.
 */
function isSiteModerator(conn) {
  return conn.player.moderator === true && chatState.modAccounts.has(conn.player.accountId);
}

export function roomBanOf(accountId) {
  const ban = roomBans.get(accountId);
  if (!ban) return null;
  if (Date.now() >= ban.until) { roomBans.delete(accountId); return null; }
  return ban;
}

// ── Codec ────────────────────────────────────────────────────────────────────
function writeSample(view, offset, s) {
  view.setUint32(offset, s.time >>> 0, true);
  view.setFloat32(offset + 4, s.x, true);
  view.setFloat32(offset + 8, s.y, true);
  view.setFloat32(offset + 12, s.z, true);
  view.setInt16(offset + 16, Math.round(s.vx) || 0, true);
  view.setInt16(offset + 18, Math.round(s.vy) || 0, true);
  view.setInt16(offset + 20, Math.round(s.vz) || 0, true);
  view.setUint16(offset + 22, Math.round((((s.yaw % 360) + 360) % 360) / 360 * 65535), true);
  view.setInt16(offset + 24, Math.round((s.pitch / 90) * 32767) || 0, true);
  view.setUint8(offset + 26, s.flags & 0xff);
  view.setUint8(offset + 27, 0);
  view.setFloat32(offset + 28, s.seconds || 0, true);
}

function readSample(view, offset) {
  const s = {
    time: view.getUint32(offset, true),
    x: view.getFloat32(offset + 4, true),
    y: view.getFloat32(offset + 8, true),
    z: view.getFloat32(offset + 12, true),
    vx: view.getInt16(offset + 16, true),
    vy: view.getInt16(offset + 18, true),
    vz: view.getInt16(offset + 20, true),
    yaw: (view.getUint16(offset + 22, true) / 65535) * 360,
    pitch: (view.getInt16(offset + 24, true) / 32767) * 90,
    flags: view.getUint8(offset + 26),
    seconds: view.getFloat32(offset + 28, true),
  };
  if (view.getUint8(offset + 27) !== 0) return null;
  if (![s.x, s.y, s.z, s.yaw, s.pitch, s.seconds].every(Number.isFinite)) return null;
  return s;
}

/** Decodes a pose batch sent by a client (kind 1). */
export function decodeBatch(buffer) {
  if (buffer.length < HEADER_BATCH || buffer.length > 64 * 1024) throw new Error('Invalid buffer length');
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (view.getUint8(0) !== MU || view.getUint8(1) !== KIND_BATCH) throw new Error('Invalid header');
  const count = view.getUint8(2);
  if (count < 1 || count > 2) throw new Error('Invalid sample count');
  if (buffer.length !== HEADER_BATCH + count * SAMPLE_SIZE) throw new Error('Inconsistent sample buffer size');
  const samples = [];
  for (let i = 0; i < count; i++) {
    const sample = readSample(view, HEADER_BATCH + i * SAMPLE_SIZE);
    if (!sample) throw new Error('Invalid pose sample');
    samples.push(sample);
  }
  return {
    sequence: view.getUint32(4, true),
    epoch: view.getUint32(8, true),
    samples,
  };
}

/**
 * Encodes a server snapshot (kind 2) from blocks shaped as
 * `{ slot, sequence, epoch, samples }`. The client rejects more than 2 samples
 * per block and more than 100 blocks.
 */
export function encodeSnapshot(blocks) {
  const kept = blocks.slice(0, MAX_BLOCKS);
  let size = HEADER_SNAPSHOT;
  for (const b of kept) size += BLOCK_HEADER + b.samples.length * SAMPLE_SIZE;

  const buffer = Buffer.allocUnsafe(size);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  view.setUint8(0, MU);
  view.setUint8(1, KIND_SNAPSHOT);
  view.setUint16(2, kept.length, true);

  let offset = HEADER_SNAPSHOT;
  for (const b of kept) {
    view.setUint16(offset, b.slot, true);
    view.setUint32(offset + 2, b.sequence >>> 0, true);
    view.setUint32(offset + 6, b.epoch >>> 0, true);
    view.setUint8(offset + 10, b.samples.length);
    view.setUint8(offset + 11, 0);
    view.setUint16(offset + 12, 0, true);
    offset += BLOCK_HEADER;
    for (const s of b.samples) { writeSample(view, offset, s); offset += SAMPLE_SIZE; }
  }
  return buffer;
}

// ── Room ─────────────────────────────────────────────────────────────────────
export class SurfRoom extends Room {
  constructor(options) {
    super(options);
    this.mapIndex = 0;
    this.epoch = 1;
    this.endsAt = Date.now() + MAP_DURATION_MS;
    this.extensions = 0;
    this.vote = null;
    this.poses = new Map();   // connectionId → most recently received batch
  }

  get mapId() { return MAP_ROTATION[this.mapIndex % MAP_ROTATION.length]; }

  state() {
    return {
      epoch: this.epoch,
      mapId: this.mapId,
      endsAt: this.endsAt,
      extensions: this.extensions,
      vote: this.vote
        ? {
            id: this.vote.id,
            // `kind: 'extend'` changes the panel heading on the client
            // ("Extend map by 15 minutes?") and how choices are rendered.
            kind: this.vote.kind,
            runoff: this.vote.runoff,
            choices: this.vote.choices,
            endsAt: this.vote.endsAt,
            ballots: this.vote.ballots,
          }
        : null,
    };
  }

  /** Entry displayed in the site's server list. */
  describe() {
    return {
      id: this.id,
      name: this.name,
      region: this.region,
      players: this.playerCount,
      capacity: this.capacity,
      mapId: this.mapId,
      online: true,
      endsAt: this.endsAt,
    };
  }

  welcome(conn) {
    return {
      type: 'welcome',
      state: this.state(),
      // Use `wirePlayer`, not the raw player: the client reads `points` from
      // `welcome.player`; the extend button checks `player.points > 1000`.
      player: this.wirePlayer(conn.player),
      players: this.roster(),
      maps: MAPS,
      serverTime: Date.now(),
      recentResults: [],
      // Spectator capability flag. The client gates `watch()` on it: without
      // `spectatorStream: true` it never sends a `spectate` message and the
      // Watch buttons do nothing. Poses need no extra work — every batch is
      // already broadcast to everyone, and the client routes the watched
      // player's slot into its spectator buffer.
      spectatorStream: true,
    };
  }

  /**
   * Spectator mode: `{type:'spectate', connectionId, request}` starts watching a
   * player, `connectionId: null` stops. The watched player is told how many
   * people watch him (`{type:'spectator-demand', active, count}`), which drives
   * the "N spectating you" badge.
   */
  setSpectator(conn, msg) {
    this.watchers ??= new Map();   // watcher connectionId → watched connectionId
    const wanted = msg.connectionId ?? null;
    const target = wanted ? [...this.connections.values()].find((c) => c.player.connectionId === wanted) : null;

    if (wanted && (!target || target === conn)) {
      this.send(conn, {
        type: 'error',
        spectatorRequest: msg.request,
        reason: 'That player is no longer in the room.',
      });
      return;
    }

    const previous = this.watchers.get(conn.player.connectionId) ?? null;
    if (target) this.watchers.set(conn.player.connectionId, target.player.connectionId);
    else this.watchers.delete(conn.player.connectionId);

    // Refresh the badge for the player we stopped watching too.
    if (previous && previous !== target?.player.connectionId) this.notifySpectators(previous);
    if (target) this.notifySpectators(target.player.connectionId);
  }

  /** Tell one player how many spectators he currently has. */
  notifySpectators(connectionId) {
    const conn = this.connections.get(connectionId);
    if (!conn) return;
    let count = 0;
    for (const watched of this.watchers?.values() ?? []) if (watched === connectionId) count += 1;
    this.send(conn, { type: 'spectator-demand', active: count > 0, count });
  }

  /** A connection leaving must stop being watched and stop watching. */
  onLeave(conn) {
    this.watchers ??= new Map();
    const id = conn.player.connectionId;
    const wasWatching = this.watchers.get(id) ?? null;
    this.watchers.delete(id);
    // Players who watched him will see the roster update and stop by themselves.
    if (wasWatching) this.notifySpectators(wasWatching);
  }

  /**
   * Player appearance in the only format accepted by the client.
   *
   * The client validates this with `tf()` and rejects the ENTIRE object unless
   * `nameColor` matches `/^#[0-9a-f]{6}$/i`. ChaOS colors are stored as `hsl(...)`,
   * so `toHexColor` must convert them before they reach this point. Empty `title`
   * and `rank` values reflect that ChaOS has neither; the client then displays
   * nothing, not even the word "Guest".
   */
  appearanceOf(player) {
    return {
      title: '',
      titleColor: null,
      nameColor: toHexColor(player?.color),
      revision: 1,
    };
  }

  /**
   * Fields the Surf client reads from each roster player. `points` must be a
   * number: rendering calls `player.points.toLocaleString()` and throws a
   * TypeError if the field is missing. Verified points and leaderboards do not
   * exist yet, so the value is 0; this is accurate, not a placeholder.
   */
  describePlayer(player) {
    return { points: 0, appearance: this.appearanceOf(player) };
  }

  /** Map change: a new `epoch` makes the client reload the map. */
  setMap(index, reason) {
    this.mapIndex = ((index % MAP_ROTATION.length) + MAP_ROTATION.length) % MAP_ROTATION.length;
    this.epoch = (this.epoch + 1) >>> 0;
    this.endsAt = Date.now() + MAP_DURATION_MS;
    this.extensions = 0;
    this.vote = null;
    this.poses.clear();
    this.broadcast({ type: 'state', state: this.state(), serverTime: Date.now() });
    this.broadcast({ type: 'notice', text: `${this.mapId} — ${reason}` });
  }

  tick() {
    const now = Date.now();
    if (this.vote && now >= this.vote.endsAt) this.closeVote('expired');
    if (now >= this.endsAt) this.setMap(this.mapIndex + 1, 'map completed');
  }

  onMessage(conn, msg) {
    switch (msg.type) {
      case 'chat': {
        const text = String(msg.text ?? '').slice(0, 200).trim();
        if (!text) return;
        this.broadcast({
          type: 'chat',
          playerId: conn.player.id,
          text,
          name: conn.player.name,
          rank: conn.player.rank,
          // Chat carries its own appearance, which colors the name in the feed
          // (`style.color = appearance.nameColor` on the client).
          appearance: this.appearanceOf(conn.player),
        });
        return;
      }
      // Next-map vote. `nominate` proposes a specific map (the client sends its
      // ID), `rtv` opens the vote on the rotation alone.
      case 'rtv':
        this.openVote();
        return;
      case 'nominate':
        this.openVote(MAP_ROTATION.includes(msg.mapId) ? msg.mapId : null);
        return;
      case 'vote':
        this.castVote(conn, msg);
        return;
      // `extend` OPENS an extension vote (choices "@extend" / "@continue"):
      // it does not extend directly, the client renders that vote.
      case 'extend':
        this.openVote(null, 'extend');
        return;
      // Room moderation, restricted to the site's moderators (`chat_mods`).
      case 'moderate':
        this.moderate(conn, msg);
        return;
      case 'change-map':
        this.changeMap(conn, msg);
        return;
      // Spectator mode: watch a player, or `connectionId: null` to stop.
      case 'spectate':
        this.setSpectator(conn, msg);
        return;
      case 'ack':
        return;                       // Acknowledgment for "check": nothing to do.
      case 'report':
        this.send(conn, { type: 'notice', text: 'Report received.' });
        return;
      default:
        return;                       // Other site-level messages are ignored here.
    }
  }

  /**
   * Binary frames from a player. Pose batches are relayed: the client remains
   * authoritative, the server only labels the batch with the sender's slot and
   * broadcasts it to the others (it does not simulate the game again).
   *
   * TOLERANCE IS DELIBERATE: a frame this server does not understand is
   * DROPPED, never punished. The client's binary format is versioned by kind
   * and changes between releases — closing the socket (4002/4008) on a frame
   * we did not expect disconnects a player in the middle of a run. That is
   * exactly what happened when the new client started sending detailed
   * spectator poses (kinds 3/4) to whoever watched it: the watched player was
   * kicked off the server as soon as a spectator arrived.
   */
  onBinary(conn, buffer) {
    const now = Date.now();
    if (!conn.poseWindowStartedAt || now - conn.poseWindowStartedAt >= 1_000) {
      conn.poseWindowStartedAt = now;
      conn.poseBatches = 0;
    }
    conn.poseBatches = (conn.poseBatches ?? 0) + 1;
    if (conn.poseBatches > MAX_POSE_BATCHES_PER_SECOND) return;   // drop, do not close

    if (!buffer || buffer.length < 2) return;
    const kind = buffer[1];

    if (kind === KIND_SPECTATOR || kind === KIND_SPECTATOR_INPUTS) {
      // Detailed spectator poses: DROPPED on purpose.
      //
      // The client decodes the detailed pose only for kind 4 (`kb(e, true)`);
      // kind 3 falls through to the snapshot decoder, which requires byte 1 to
      // be 2 and throws "Invalid snapshot header". The wrapper then closes the
      // socket with 4002 "Invalid room data; reload" — relaying these frames
      // disconnects the SPECTATOR, not the watched player.
      //
      // Nothing is lost visually: the watched player is already rendered from
      // the regular kind-2 snapshots broadcast to everyone (`acceptPose`), and
      // the spectator falls back to that pose (`detailed:false`).
      return;
    }
    if (kind !== KIND_BATCH) return;   // unknown kind: ignore (future client)

    let batch;
    try { batch = decodeBatch(buffer); } catch { return; }
    if (batch.epoch !== this.epoch) return;
    if (conn.player.slot === null) return;

    this.poses.set(conn.player.connectionId, { ...batch, at: now });
    const snapshot = encodeSnapshot([
      { slot: conn.player.slot, sequence: batch.sequence, epoch: batch.epoch, samples: batch.samples },
    ]);
    this.broadcastBinary(snapshot, conn.player.connectionId);
  }

  // ── Votes ──────────────────────────────────────────────────────────────────
  /**
   * Opens a vote. `nominated` is the map proposed by `/nominate` (it goes
   * first), `kind:'extend'` is an extension vote with the two special choices
   * the client knows how to render (`@extend` / `@continue`).
   */
  openVote(nominated = null, kind = 'next') {
    if (this.vote) return;

    let choices;
    if (kind === 'extend') {
      choices = ['@extend', '@continue'];
    } else {
      const upcoming = [1, 2, 3].map((n) => MAP_ROTATION[(this.mapIndex + n) % MAP_ROTATION.length]);
      // The nominated map goes first, without duplicates, four choices at most.
      choices = [...new Set([nominated, ...upcoming])].filter(Boolean).slice(0, 4);
    }

    this.vote = {
      id: `v${Date.now().toString(36)}`,
      kind,
      runoff: false,
      choices,
      endsAt: Date.now() + VOTE_DURATION_MS,
      ballots: {},
      openedAt: Date.now(),
    };
    this.broadcast({ type: 'state', state: this.state(), serverTime: Date.now() });
  }

  castVote(conn, msg) {
    if (!this.vote || msg.voteId !== this.vote.id) return;
    if (!this.vote.choices.includes(msg.choice)) return;
    // The client reads `state.vote.ballots[player.id]` to show the selected
    // choice: the key must be the roster player id (`p_<connection>`), not the
    // account id.
    this.vote.ballots[conn.player.id] = msg.choice;
    this.broadcast({ type: 'state', state: this.state(), serverTime: Date.now() });

    const needed = Math.floor(this.playerCount / 2) + 1;
    const tally = {};
    for (const choice of Object.values(this.vote.ballots)) tally[choice] = (tally[choice] ?? 0) + 1;
    const winner = Object.entries(tally).find(([, n]) => n >= needed);
    if (!winner) return;

    const [choice] = winner;
    if (this.vote.kind === 'extend') {
      this.vote = null;
      if (choice === '@extend') {
        this.extendMap();
      } else {
        this.broadcast({ type: 'notice', text: 'Extension declined.' });
        this.broadcast({ type: 'state', state: this.state(), serverTime: Date.now() });
      }
      return;
    }

    this.broadcast({ type: 'notice', text: `Vote passed: ${MAP_TITLES[choice] ?? choice}` });
    this.setMap(MAP_ROTATION.indexOf(choice), 'vote');
  }

  /** A player banned from the room must not get back in. */
  onJoin(conn) {
    const ban = roomBanOf(conn.player.accountId);
    if (!ban) return;
    const minutes = Math.max(1, Math.ceil((ban.until - Date.now()) / 60_000));
    this.send(conn, { type: 'notice', text: `You are banned from this server (${minutes} min left).` });
    conn.socket.close(4009, 'Banned by a moderator');
  }

  /**
   * Kick / ban — restricted to the site's moderators.
   *
   * The client sends `{type:'moderate', playerId, action:'kick'|'ban', minutes}`
   * with the player id **as it appears in the roster**. Closing with 4009 puts
   * the client in its "offline" state with the reason, which is what an
   * exclusion should do (4008 means "room full").
   */
  moderate(conn, msg) {
    if (!isSiteModerator(conn)) {
      this.send(conn, { type: 'notice', text: 'Moderator only.' });
      return;
    }
    const target = [...this.connections.values()].find((c) => c.player.id === msg.playerId);
    if (!target || target === conn) return;

    const action = msg.action === 'ban' ? 'ban' : 'kick';
    const minutes = Math.min(24 * 60, Math.max(1, Number(msg.minutes) || 60));
    if (action === 'ban') {
      const reason = typeof msg.reason === 'string' && msg.reason.trim() ? msg.reason.trim().slice(0, 200) : 'moderation';
      roomBans.set(target.player.accountId, { until: Date.now() + minutes * 60_000, reason });
    }
    this.broadcast({
      type: 'notice',
      text: `${target.player.name} ${action === 'ban' ? `banned for ${minutes} min` : 'kicked'} by ${conn.player.name}.`,
    });
    this.send(target, {
      type: 'notice',
      text: action === 'ban' ? `Banned from this server for ${minutes} min.` : 'Kicked by a moderator.',
    });
    target.socket.close(4009, action === 'ban' ? 'Banned by a moderator' : 'Kicked by a moderator');
  }

  /** Immediate map change — restricted to the site's moderators. */
  changeMap(conn, msg) {
    if (!isSiteModerator(conn)) {
      this.send(conn, { type: 'notice', text: 'Moderator only.' });
      return;
    }
    const index = MAP_ROTATION.indexOf(msg.mapId);
    if (index < 0) return;
    this.setMap(index, `changed by ${conn.player.name}`);
  }

  closeVote(reason) {
    this.vote = null;
    this.broadcast({ type: 'state', state: this.state(), serverTime: Date.now(), notice: reason });
  }

  extendMap() {
    if (this.extensions >= MAX_EXTENSIONS) return;
    this.extensions++;
    this.endsAt += EXTENSION_MS;
    this.broadcast({ type: 'state', state: this.state(), serverTime: Date.now() });
    this.broadcast({ type: 'notice', text: `Map extended (${this.extensions}/${MAX_EXTENSIONS}).` });
  }
}

// ── Game descriptor ──────────────────────────────────────────────────────────
/**
 * URL prefix. Intentionally EMPTY (site root): the client builds its WebSocket
 * URL with `new URL('/servers/<room>/ws', baseUrl)`, and an absolute path always
 * resolves from the origin root. The list, ping, and WebSocket must therefore
 * use the root; see `basePathOf` in core.js.
 */
const BASE_PATH = '';

export const surfGame = attachRooms(
  defineGame({
    id: 'surf',
    title: 'Surf',
    protocol: 'chaos-surf-v1',
    basePath: BASE_PATH,
    createRoom: (opts) => new SurfRoom(opts),
  }),
  [new SurfRoom({ id: 'eu', name: 'ChaOS EU', region: 'eu', capacity: 20 })],
);

/**
 * URL advertised to the client in `action=config`. The client requests
 * `baseUrl + '/servers'` (discovery), then `new URL('/servers/<room>/ws', baseUrl)`
 * (connection): the URL must be ABSOLUTE and consistent with BASE_PATH.
 */
export function multiplayerUrlFor(req) {
  const host = req.get('host');
  const scheme = req.protocol === 'https' ? 'https' : 'http';
  return `${scheme}://${host}${BASE_PATH}`;
}
