/**
 * /api/quake — Quake 3 server status and player identity.
 *
 * The Q3JS client is a standalone WebAssembly client: it requests NOTHING from
 * the web server (its page reads parameters from the URL and downloads its own
 * assets). This route serves only the ChaOS window, which needs to:
 *
 *   - check whether the game server responds, so it can show the status instead
 *     of a black screen when the `quake` container is stopped;
 *   - get the connected player's ChaOS nickname for the engine (Quake 3 has no
 *     account system of its own);
 *   - get the tunnel path to announce without duplicating it in the client.
 *
 * `getstatus` is Quake 3's status query: four 0xFF bytes followed by
 * "getstatus\n", sent over UDP. The response contains the server infostring
 * (`\key\value…`) followed by one line per player (`score ping "name"`).
 * No session or ticket is needed; this is the same query a game browser sends.
 * Quake 3 servers.
 */
import { Router } from 'express';
import dgram from 'node:dgram';
import { accountFromHeaders } from '../../../server/auth/service.js';
import { loadUserSettings } from '../../../server/chat/backlog.js';
import { Q3_ROOM_ID, Q3_WS_PATH, q3Upstream } from './game.js';

const router = Router();

/** An unreachable game server must respond quickly: an offline state is better
 *  than leaving the window stuck on "checking…". */
const STATUS_TIMEOUT_MS = 900;

/**
 * Optional origin used only by the Quake iframe. It must be reverse-proxied to
 * this same application (including /game/quake3/) so the large WASM runtime
 * no longer shares ChaOS's desktop renderer. Invalid values are ignored: the
 * game remains playable on the primary origin instead of navigating to an
 * arbitrary URL.
 */
function quakeOrigin() {
  const value = String(process.env.QUAKE_ORIGIN || '').trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

const GETSTATUS = Buffer.concat([
  Buffer.from([0xff, 0xff, 0xff, 0xff]),
  Buffer.from('getstatus\n', 'latin1'),
]);

/**
 * Query `ioq3ded` over UDP and return a normalized server record, or `null`.
 * Never throws: a missing server is a normal state, not an error.
 */
function queryServer() {
  const upstream = q3Upstream();
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* Already closed. */ }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), STATUS_TIMEOUT_MS);
    timer.unref?.();

    socket.on('error', () => finish(null));
    socket.on('message', (message) => {
      const text = message.toString('latin1');
      if (!text.includes('statusResponse')) return finish(null);
      // Response: line 0 is the `statusResponse` header, line 1 is the server
      // infostring (`\key\value…`), and each later line represents one player.
      // Detect it by its first character rather than its index: it is the only
      // line that starts with a backslash.
      const lines = text.split('\n');
      const infoLine = lines.find((line) => line.startsWith('\\')) ?? '';
      const info = {};
      const parts = infoLine.split('\\');
      for (let i = 1; i + 1 < parts.length; i += 2) info[parts[i]] = parts[i + 1];
      const players = lines
        .filter((line) => line !== 'statusResponse' && !line.startsWith('\\'))
        .map((line) => /^(-?\d+)\s+(\d+)\s+"(.*)"$/.exec(line.trim()))
        .filter(Boolean)
        .map((m) => ({ score: Number(m[1]), ping: Number(m[2]), name: m[3] }));
      finish({
        name: info.sv_hostname || 'Quake 3',
        map: info.mapname || null,
        gameType: info.g_gametype ?? null,
        players: players.length,
        maxPlayers: Number(info.sv_maxclients) || null,
        playerList: players.map((p) => p.name),
        protocol: info.com_protocol || null,
      });
    });

    socket.send(GETSTATUS, upstream.port, upstream.host, (error) => {
      if (error) finish(null);
    });
  });
}

/** ChaOS username to pass to the engine. Q3 limits names to 32 bytes. */
function playerName(req) {
  const account = accountFromHeaders(req.headers);
  if (!account) return null;
  const settings = loadUserSettings(account.id);
  const name = String(settings?.pseudo || account.pseudo || '').trim();
  if (!name) return null;
  // The engine receives this name in its command line (`+set name "…"`), so
  // remove characters that could break argument parsing, as the base layer does.
  return name.replace(/["\\\r\n\t]/g, '').slice(0, 32);
}

router.all('/', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const action = String(req.query.action || 'config');
  if (action !== 'config') return res.status(404).json({ error: 'not_found' });

  // The game remains playable without a ChaOS account because it requires no
  // identity; the engine simply uses its default username.
  const name = playerName(req);
  const server = await queryServer().catch(() => null);

  return res.json({
    enabled: true,
    protocol: 'quake3-tunnel-v1',
    gameOrigin: quakeOrigin(),
    room: Q3_ROOM_ID,
    wsPath: Q3_WS_PATH,
    online: server !== null,
    server,
    player: { name: name || 'Player', named: name !== null },
  });
});

export default router;
