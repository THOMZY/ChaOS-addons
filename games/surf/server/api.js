/**
 * /api/surf — records API entry point for the Surf client.
 *
 * The client (games/surf/data, served under /surf/) calls JSON actions at
 * `/api/surf?action=...`. These server-side actions handle accounts, verified
 * times, leaderboards, and multiplayer rooms; they are not part of the imported
 * client (see games/surf/install.mjs).
 *
 * IDENTITY: the game no longer has its own accounts or guest mode. The player
 * IS the ChaOS account read from the session cookie. Since the game is served
 * from the same origin, the browser sends the cookie automatically. The
 * nickname and color come from the user's ChaOS settings and reach the room
 * through the ticket.
 *
 * CURRENT STATE: the client uses ChaOS accounts, with no third-party providers
 * or competitive validation. Its 20 maps, Source movement, and practice mode
 * remain in its bundle; the site stores only times and replays users choose to
 * share.
 *
 * TIMES ARE STORED HERE. The client exposes its timer state through
 * `window.__SURF__.snapshot()`; the site polls it and submits each completed run
 * with `action=submit-run`. Times are stored per ChaOS account even if the
 * client UI still calls them "local records". Read them with `action=times`
 * (map leaderboard) or `action=my-times` (personal records). Details and
 * limitations: games/surf/server/runs.js.
 */
import { Router, raw } from 'express';
import { gunzipSync } from 'node:zlib';
import { accountFromHeaders } from '../../../server/auth/service.js';
import { loadUserSettings } from '../../../server/chat/backlog.js';
import { chatState } from '../../../server/chat/state.js';
import { mintTicket } from '../../platform/game-servers/core.js';
import { multiplayerUrlFor } from './room.js';
import { validateRun, saveRun, mapLeaderboard, playerBests, playerRuns, BOARDS, findBoard, openAttempt, attemptById, submissionFor, saveReplay, replayForAttempt } from './runs.js';
import { toHexColorOr } from '../../platform/game-servers/color.js';
import { db } from '../../../server/db/index.js';
import { withCurrentIdentities } from '../../../server/api/score-identities.js';

const router = Router();
// The client compresses its replay before passing it to the SDK adapter.
// Keep the request body binary, separate from the API's usual JSON payloads.
router.use(raw({ type: 'application/gzip', limit: '10mb' }));

const UNAUTHENTICATED = { error: 'Sign in to use online records.' };

/**
 * Access ticket for a game room.
 *
 * The client presents it as the second WebSocket subprotocol because browsers
 * cannot set custom WebSocket headers. It carries the player's ChaOS identity
 * (nickname and color). It must remain a valid token (unpadded base64url), or
 * `new WebSocket(...)` throws on the client.
 */
function roomTicket(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const account = accountFromHeaders(req.headers);
  if (!account) {
    // There is no anonymous identity to carry into a room. Without a ChaOS
    // account, there is no player to announce to others. The client displays
    // this message in the room status line.
    return res.status(401).json({ error: 'Sign in to ChaOS to join a server.' });
  }

  // Nickname and color come from ChaOS settings, matching the identity used in
  // site chat. `loadUserSettings` returns null if the user has never opened
  // settings; in that case, fall back to the account nickname and default color.
  const settings = loadUserSettings(account.id);
  const { token } = mintTicket('surf', {
    accountId: account.id,
    sessionId: account.sessionId,
    name: settings?.pseudo || account.pseudo,
    color: toHexColorOr(settings?.color),
    // Site moderator (`chat_mods`, the same list as the chat): this flag is what
    // makes "Change map", "Kick" and "Ban" appear in the room. The game receives
    // it through the ticket and re-checks it on every action.
    moderator: chatState.modAccounts.has(account.id),
  });
  res.json({ token });
}

router.all('/', (req, res) => {
  const action = String(req.query.action || '');

  if (action === 'room-ticket') return roomTicket(req, res);

  // ── Game times ────────────────────────────────────────────────────────────
  // The SITE submits times here, not the client. The client exposes its timer
  // through `window.__SURF__.snapshot()`; the site polls it and submits each
  // completed run (see website/core/js/games/embedded-clients.js). Without a
  // ChaOS account, there is no player to credit: no guest or anonymous times.
  if (action === 'submit-run') {
    res.setHeader('Cache-Control', 'no-store');
    const account = accountFromHeaders(req.headers);
    if (!account) return res.status(401).json({ error: 'Sign in to ChaOS to save a time.' });

    const controle = validateRun({
      mapId: req.body?.mapId,
      timeMs: req.body?.timeMs,
      splitsMs: req.body?.splitsMs,
      mapVersion: req.body?.mapVersion,
      physics: req.body?.physics,
    });
    if (!controle.ok) return res.status(400).json({ error: controle.error });

    const resultat = saveRun({
      accountId: account.id,
      run: controle.value,
      roomId: typeof req.body?.roomId === 'string' ? req.body.roomId.slice(0, 32) : null,
    });
    return res.json({ ok: true, mapId: controle.value.mapId, timeMs: controle.value.timeMs, ...resultat });
  }

  // ── Client online workflow ────────────────────────────────────────────────
  // The client has its own workflow: it opens an ATTEMPT before play and tracks
  // it, but never submits a time through this path. Preserve this workflow so
  // the client stays online (otherwise it falls back to local play and labels
  // everything "local"). The site's polling submits the time separately and
  // matches it to the recorded run.
  if (action === 'attempt') {
    res.setHeader('Cache-Control', 'no-store');
    const account = accountFromHeaders(req.headers);
    if (!account) return res.status(401).json({ error: 'Sign in to ChaOS to start a ranked run.' });
    const board = findBoard(String(req.body?.boardId || ''));
    if (!board) return res.status(400).json({ error: 'unknown_board' });
    return res.json(openAttempt({ accountId: account.id, board, roomId: req.body?.roomId ?? null }));
  }

  if (action === 'upload') {
    // The client arrives here after `submission` matches a time to an attempt
    // and responds with "issued". Return a same-origin URL so the SDK adapter
    // can upload the gzip replay blob.
    res.setHeader('Cache-Control', 'no-store');
    const account = accountFromHeaders(req.headers);
    if (!account) return res.status(401).json({ error: 'Sign in to ChaOS.' });
    const attempt = attemptById(String(req.body?.attemptId || ''), account.id);
    if (!attempt?.run_id) return res.status(409).json({ error: 'run_not_ready' });
    return res.json({
      uploadPath: `/api/surf?action=upload-data&attemptId=${encodeURIComponent(attempt.id)}`,
      uploadToken: 'chaos',
    });
  }

  if (action === 'upload-data') {
    const account = accountFromHeaders(req.headers);
    if (!account) return res.status(401).json({ error: 'Sign in to ChaOS.' });
    const attempt = attemptById(String(req.query.attemptId || ''), account.id);
    if (!attempt?.run_id) return res.status(409).json({ error: 'run_not_ready' });
    if (!saveReplay(attempt, req.body)) return res.status(400).json({ error: 'invalid_replay' });
    return res.json({ ok: true });
  }

  if (action === 'submit') {
    const account = accountFromHeaders(req.headers);
    if (!account) return res.status(401).json({ error: 'Sign in to ChaOS.' });
    return res.json(submissionFor(attemptById(String(req.body?.attemptId || ''), account.id), account));
  }

  // Other write actions are not implemented yet.
  if (req.method !== 'GET') return res.status(401).json(UNAUTHENTICATED);

  switch (action) {
    case 'config':
      // enabled:true initializes the client's online layer so it stops treating
      // itself as local. It then creates its "SDK": OUR adapter, written over
      // the bundled Supabase SDK during installation (see
      // games/surf/server/client-adapter.js). supabaseUrl and
      // publishableKey only satisfy its initialization check. An empty providers
      // list removes Google/X buttons; emailAuth:false prevents account creation
      // because the ChaOS account provides identity.
      return res.json({
        enabled: true,
        providers: [],
        maps: BOARDS,
        // The client validates this value with `new URL()` before loading our
        // adapter; a relative URL (`/surf`) would prevent it from initializing.
        supabaseUrl: multiplayerUrlFor(req),
        publishableKey: 'chaos-account',
        // Room discovery: the client derives <url>/servers and
        // <url>/servers/<room>/ws. This URL MUST be absolute because the client
        // passes it to `new URL()`, which rejects a relative base.
        multiplayer: { url: multiplayerUrlFor(req) },
        guestRuns: false,
        cachedReads: true,
        emailAuth: false,
      });

    // Identity for the SDK replacement adapter. Same origin: the site's session
    // cookie is enough; no token needs to be created.
    case 'session': {
      res.setHeader('Cache-Control', 'no-store');
      const account = accountFromHeaders(req.headers);
      if (!account) return res.status(401).json({ error: 'no_session' });
      const reglages = loadUserSettings(account.id);
      return res.json({ id: account.id, pseudo: reglages?.pseudo || account.pseudo, createdAt: account.createdAt ?? null });
    }

    // Profile: use the site's nickname and color from chat.
    case 'profile': {
      res.setHeader('Cache-Control', 'no-store');
      const account = accountFromHeaders(req.headers);
      if (!account) return res.status(401).json({ error: 'Sign in to ChaOS to see your profile.' });
      const reglages = loadUserSettings(account.id);
      return res.json({
        id: account.id,
        username: reglages?.pseudo || account.pseudo,
        nameRevision: 1,
        nameLocked: false,
        // The client gates its moderator tools (change map, kick, ban) on THIS
        // flag, not on the room roster: `client.profile?.moderator`. Same list
        // as the site chat (`chat_mods`); the room re-checks it on every action.
        moderator: chatState.modAccounts.has(account.id),
        // Display-only fields the profile page reads; absent, it renders blanks
        // instead of hiding the blocks it is supposed to hide.
        chatMute: null,
        rankedStatus: null,
        appearance: { title: '', titleColor: null, nameColor: toHexColorOr(reglages?.color), revision: 1 },
      });
    }

    // Attempt status: `verifying` until the run time arrives, then the verified
    // result. The client can query both states.
    case 'submission': {
      res.setHeader('Cache-Control', 'no-store');
      const account = accountFromHeaders(req.headers);
      if (!account) return res.status(401).json({ error: 'Sign in to ChaOS.' });
      return res.json(submissionFor(attemptById(String(req.query.id || ''), account.id), account));
    }

    // The player's personal record on a leaderboard. The client uses the
    // response itself as `own`, not a wrapped field, so return the entry directly
    // or null.
    case 'personal-best': {
      res.setHeader('Cache-Control', 'no-store');
      const account = accountFromHeaders(req.headers);
      if (!account) return res.status(401).json({ error: 'Sign in to ChaOS.' });
      const board = findBoard(typeof req.query.boardId === 'string' ? req.query.boardId : '');
      if (!board) return res.json(null);
      const entry = mapLeaderboard(board.id, 1000).entries.find((e) => e.accountId === account.id) ?? null;
      if (!entry) return res.json(null);
      return res.json({
        ...entry,
        userId: account.id,
        name: entry.pseudo,
        username: entry.pseudo,
        position: entry.rank,
        points: 0,
        completions: entry.runs,
        timeUs: entry.timeMs * 1000,
        player: { id: account.id, userId: account.id, username: entry.pseudo, name: entry.pseudo, color: entry.color },
      });
    }

    // Leaderboards. The original client read these from Supabase, which is
    // offline here. Return the same shape, now populated with our own times, so
    // switching clients requires no server-side changes.
    case 'leaderboard':
    case 'leaderboard-public': {
      const boardId = typeof req.query.boardId === 'string' ? req.query.boardId : '';
      const board = boardId ? findBoard(boardId) : null;
      const classement = board ? mapLeaderboard(board.id, 100) : { total: 0, entries: [] };
      const account = accountFromHeaders(req.headers);
      const own = account
        ? classement.entries.find((e) => e.accountId === account.id) ?? null
        : null;
      // Include `timeUs` alongside `timeMs`: the client uses microseconds.
      // Other fields (username, position, points, completions, player) follow its
      // leaderboard vocabulary: it reads `username` on rank boards and a player
      // object on map boards.
      const enrichir = (e) => ({
        ...e,
        timeUs: e.timeMs * 1000,
        userId: e.accountId,
        name: e.pseudo,
        username: e.pseudo,
        position: e.rank,
        points: 0,
        completions: e.runs,
        player: { id: e.accountId, userId: e.accountId, username: e.pseudo, name: e.pseudo, color: e.color },
      });
      const entries = classement.entries.map(enrichir);
      return res.json({
        own: own ? enrichir(own) : null,
        total: classement.total,
        boardId: boardId || null,
        board: board ? { id: board.id, slug: board.slug, name: board.name, version: board.version } : null,
        entries,
      });
    }

    // Map leaderboard in the shape displayed by the site.
    case 'times': {
      const mapId = typeof req.query.mapId === 'string' ? req.query.mapId : '';
      if (!mapId) return res.status(400).json({ error: 'map_required' });
      return res.json({ mapId, ...mapLeaderboard(mapId, 50) });
    }

    // "Map times": the client asks for `map-ranks` with a boardId. Same data as
    // our leaderboard, served under both field names.
    case 'map-ranks': {
      const board = findBoard(typeof req.query.boardId === 'string' ? req.query.boardId : '');
      const leaderboard = board ? mapLeaderboard(board.id, 100) : { total: 0, entries: [] };
      const toRankEntry = (e) => ({
        ...e, timeUs: e.timeMs * 1000, userId: e.accountId, name: e.pseudo,
        username: e.pseudo, position: e.rank, points: 0, completions: e.runs,
        player: { id: e.accountId, userId: e.accountId, username: e.pseudo, name: e.pseudo, color: e.color },
      });
      return res.json({
        mapId: board?.id ?? null,
        boardId: board?.boardId ?? null,
        total: leaderboard.total,
        entries: leaderboard.entries.map(toRankEntry),
      });
    }

    // ── Staged boards ────────────────────────────────────────────────────────
    // Newer upstream boards are played in order (Staged · N stages). The client
    // then reads per-stage records, a per-stage leaderboard and the viewer's
    // stage bests. ChaOS stores whole-run times only, so these are valid EMPTY
    // shapes: without them the client shows "Stage records are unavailable
    // right now." on every staged map and the board panel reads as broken.
    case 'stage-records':
      return res.json({ records: [] });
    case 'stage-leaderboard-public':
      return res.json({ entries: [] });
    case 'stage-bests':
      return res.json({ bests: [] });

    // ── Site moderation: valid shapes, empty data ────────────────────────────
    // The new client can display reports, chat mutes and ranked suspensions. We
    // store none of that: the REAL moderation is the room one (`moderate` /
    // `change-map`), where a site moderator changes the map and removes a
    // player. These empty lists keep the panel from showing an error (the site
    // actions themselves remain unimplemented).
    case 'moderation-rooms':
      return res.json({ rooms: [{ roomId: 'eu', available: true, reports: [], localMute: null }] });
    case 'moderation-search':
      return res.json({ players: [] });
    case 'moderation-chat':
      return res.json({ status: { synced: true, revision: 1, muted: null, until: null }, history: [] });
    case 'moderation-ranked':
      return res.json({ status: { suspended: false, revision: 1 }, history: [] });

    // ── Progression (points, rank, per-map records) ──────────────────────────
    // The client asks for it on load, for the player list and for a profile.
    // The site awards no Surf points: answer with the guest-equivalent zero
    // record instead of 401, which the client renders as "Rankings could not
    // load" and logs as an error.
    case 'progression': {
      res.setHeader('Cache-Control', 'no-store');
      const account = accountFromHeaders(req.headers);
      const id = String(req.query.userId || '') || account?.id || null;
      // `userId` is often SOMEONE ELSE (player list, profile card): the name is
      // that account's current chat pseudo, never the viewer's.
      const [identity] = id ? withCurrentIdentities(db, [{ accountId: id, pseudo: null }]) : [];
      return res.json({
        kind: id ? 'player' : 'guest',
        userId: id,
        name: identity?.pseudo || 'Guest',
        rank: 'Unranked',
        points: 0,
        position: null,
        completions: 0,
        records: 0,
        persona: 'default',
        supporter: false,
        maps: [],
        entries: [],
      });
    }

    // Personal records and recent runs for the connected player.
    case 'my-times': {
      res.setHeader('Cache-Control', 'no-store');
      const account = accountFromHeaders(req.headers);
      if (!account) return res.status(401).json({ error: 'Sign in to ChaOS to see your times.' });
      return res.json({ bests: playerBests(account.id), runs: playerRuns(account.id, 25) });
    }

    // A replay is a shareable souvenir, not an anti-cheat proof. The client can
    // play it back, so return exactly the object it sent.
    case 'replay': {
      const replay = replayForAttempt(String(req.query.runId || ''));
      if (!replay) return res.status(404).json({ error: 'replay_not_found' });
      try {
        return res.json({ replay: JSON.parse(gunzipSync(replay.data).toString('utf8')) });
      } catch {
        return res.status(500).json({ error: 'replay_unreadable' });
      }
    }

    case 'run': {
      const replay = replayForAttempt(String(req.query.runId || ''));
      if (!replay) return res.status(404).json({ error: 'run_not_found' });
      return res.json({ run: { id: String(req.query.runId), mapId: replay.mapId, timeUs: replay.timeMs * 1000 } });
    }

    default:
      return res.status(401).json(UNAUTHENTICATED);
  }
});

export default router;
