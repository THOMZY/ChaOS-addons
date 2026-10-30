/**
 * Quake 3 adapter — "tunnel" type.
 *
 * ── Why a "tunnel" instead of a "room" ─────────────────────────────────────
 * Surf and Quake 3 have nothing in common at the protocol level:
 *
 *   Surf   we own the game logic — roster, map rotation, votes, and pose relay.
 *          Hence the "room" type.
 *   Quake 3 all game logic lives in `ioq3ded`, a native server with its own UDP
 *          protocol (delta-compressed snapshots, etc.). The adapter does not
 *          interpret it; it relays bytes between the browser WebSocket and the
 *          server's UDP socket.
 *
 * ── What the foundation replaces ───────────────────────────────────────────
 * The mirror (`workspace/q3-mirror`) used a third-party Docker image
 * (`lukaklacar/q3js-server`) that includes its OWN WS↔UDP gateway on port 27961.
 * Our `tunnel.js` does the same work inside the already-deployed Node process,
 * making the image's gateway redundant. Only `ioq3ded` itself is still needed.
 *
 * ── The client constrains the WebSocket path ─────────────────────────────────
 * `ioquake3.wasm` builds its WebSocket URL as `${proto}//${host}:${port}` with
 * NO path, and cannot use a different path without changing the bundle. The
 * installed client (`scripts/quake-install.mjs`) therefore appends
 * `window.__Q3_WSPATH` to this expression; the game page provides that constant
 * at installation time. `Q3_WS_PATH` below is its source of truth: the install
 * script READS this file to verify it installs the declared path, so the two
 * cannot silently diverge.
 *
 * ── Verified ───────────────────────────────────────────────────────────────
 * The tunnel was validated against a real `ioq3ded`: two simultaneous browser
 * clients, roster read through UDP `getstatus`, and no JS exceptions. Opening
 * requires no special packet, so `onOpen` is unnecessary (the client's first
 * datagram is the first one sent, as in ioquake3).
 */
import { defineGame } from '../../platform/game-servers/core.js';

/** Published room. Quake 3 is joined by address; there is no room list. */
export const Q3_ROOM_ID = 'q3dm';
/** Game URL prefix under ChaOS. */
export const Q3_BASE_PATH = '/game/quake3';
/** Tunnel WebSocket path, appended to the client by the install script. */
export const Q3_WS_PATH = `${Q3_BASE_PATH}/servers/${Q3_ROOM_ID}/ws`;

/**
 * Quake 3 disconnect packet: four 0xFF bytes followed by "disconnect\n".
 *
 * Without it, `ioq3ded` notices a player disconnect only after its own timeout
 * (~20 seconds), causing a duplicate player after a simple page reload. This is
 * the same packet the official gateway sends when the WebSocket closes.
 */
const DISCONNECT_PACKET = Buffer.concat([
  Buffer.from([0xff, 0xff, 0xff, 0xff]),
  Buffer.from('disconnect\n', 'latin1'),
]);

/**
 * Game server target. By default, local `ioq3ded` on its standard port; in
 * deployment, use the Docker service name on the internal network (`quake`).
 */
export function q3Upstream() {
  return {
    protocol: 'udp',
    host: process.env.Q3_HOST || '127.0.0.1',
    port: Number(process.env.Q3_PORT) || 27960,
  };
}

/**
 * Game descriptor.
 *
 * `ticket: 'optional'` — the WebAssembly client cannot carry a ticket (it does
 * not choose WebSocket subprotocols, and Emscripten SOCKFS builds its URL).
 * The player's ChaOS identity therefore does not travel over WebSocket: it is
 * read by `/api/quake` and added to the game page URL, where the engine uses it
 * as the nickname. As in the original game, the room is open without access
 * control; this is intentional.
 */
export const quake3Game = defineGame({
  id: 'quake3',
  title: 'Quake 3',
  kind: 'tunnel',
  basePath: Q3_BASE_PATH,
  ticket: 'optional',
  upstreamFor(roomId) {
    return roomId === Q3_ROOM_ID ? q3Upstream() : null;
  },
  /**
   * The engine does not notify the server when the tab disappears (F5 or close):
   * the socket shuts down and `ioq3ded` waits for its timeout. Notify the server
   * ourselves; this is the only way to prevent ghost players.
   */
  onClose({ send, done }) {
    send(DISCONNECT_PACKET, done);
  },
  servers: () => [{ id: Q3_ROOM_ID, name: 'ChaOS Q3', players: null, capacity: null, online: true }],
});
