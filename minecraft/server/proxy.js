import net from 'node:net';
import { serverCloseHub } from '../../../server/utils/server-close.js';
import { Transform } from 'node:stream';
import {
  readTransportAccess,
  trackTransport,
  rejectUpgrade,
} from '../../../server/security/transport-access.js';

// Eagler's handshake only. Never forward ChaOS cookies, bearer credentials or
// untrusted proxy headers to a different service.
const HANDSHAKE_HEADERS = new Set([
  'host',
  'upgrade',
  'connection',
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-protocol',
  'sec-websocket-extensions',
  'origin',
  'user-agent',
]);

export function attachMinecraftProxy(
  server,
  {
    host = process.env.MC_HOST || 'minecraft',
    port = Number.parseInt(process.env.MC_PORT, 10) || 25565,
    connectTimeoutMs = 10_000,
    accepting = () => true,
  } = {},
) {
  const connections = new Set();
  const closing = new Set();
  const track = (socket) => {
    const closed = new Promise((resolve) => socket.once('close', resolve));
    closing.add(closed);
    closed.then(() => closing.delete(closed));
  };
  const closeAll = () => {
    for (const stop of [...connections]) stop();
  };
  const releaseClose = serverCloseHub(server).on('close', closeAll);
  const upgrade = (req, socket, head) => {
    if (req.url !== '/mc-ws') return;
    if (!accepting()) {
      rejectUpgrade(socket, { status: 503 });
      return;
    }
    track(socket);
    let access;
    try {
      access = readTransportAccess(req);
    } catch (error) {
      rejectUpgrade(socket, error);
      return;
    }

    let stopped = false;
    let upstream;
    let security;
    const originalDestroy = socket.destroy.bind(socket);
    const stop = () => {
      if (stopped) return;
      stopped = true;
      security?.dispose();
      connections.delete(stop);
      upstream?.destroy();
      originalDestroy();
    };
    security = trackTransport(access, stop);
    if (!security.check()) return;
    connections.add(stop);
    socket.once('close', stop);
    socket.once('end', stop);
    socket.once('error', stop);

    // Engine.IO's synchronous upgrade listener must not destroy another
    // transport. Restore immediately after dispatch, not after a remote dial.
    socket.destroy = () => socket;
    queueMicrotask(() => {
      socket.destroy = originalDestroy;
    });
    try {
      upstream = net.createConnection({ host, port });
    } catch {
      stop();
      return;
    }
    track(upstream);
    upstream.setTimeout(connectTimeoutMs, stop);
    upstream.once('error', stop);
    upstream.once('close', stop);
    upstream.once('end', stop);
    upstream.once('connect', () => {
      if (stopped || !security.check()) return;
      upstream.setTimeout(0);
      const headers = Object.entries(req.headers)
        .filter(([name]) => HANDSHAKE_HEADERS.has(name))
        .map(([name, value]) => `${name}: ${value}`);
      headers.push(`x-real-ip: ${access.ip}`);
      upstream.write(`GET / HTTP/1.1\r\n${headers.join('\r\n')}\r\n\r\n`);
      if (head?.length) upstream.write(head);
      const guard = () =>
        new Transform({
          transform(chunk, _encoding, done) {
            done(null, !stopped && security.check() ? chunk : undefined);
          },
        });
      const outgoing = guard(),
        incoming = guard();
      outgoing.on('error', stop);
      incoming.on('error', stop);
      socket.pipe(outgoing).pipe(upstream);
      upstream.pipe(incoming).pipe(socket);
      socket.once('close', () => {
        outgoing.destroy();
        incoming.destroy();
      });
    });
  };
  server.on('upgrade', upgrade);
  let stopping;
  return () => {
    if (stopping) return stopping;
    server.off('upgrade', upgrade);
    releaseClose();
    closeAll();
    stopping = Promise.all([...closing]);
    return stopping;
  };
}
