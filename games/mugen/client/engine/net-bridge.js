// globalThis.ikemenNet for the ChaOS relay. The browser build of Ikemen GO
// expects a page bridge with two channels (src/netplay_js.go and the GGPO
// transport webrtc_js.go):
//   - a reliable byte stream for the lobby handshake and delay netcode;
//   - whole datagrams for rollback.
// Here both go through the chat socket and the server relays them to the
// other player, so no peer-to-peer connection or TURN server is needed.
// A third control channel tells each side when the other engine is listening.

export const STREAM = 0;
export const DATAGRAM = 1;
export const CONTROL = 2;
const HELLO = 1;
const BYE = 2;
const HELLO_INTERVAL_MS = 500;

/**
 * @param {object} options
 * @param {'host'|'guest'} options.role ChaOS decides who hosts: the creator, engine side 1.
 * @param {(channel: number, bytes: Uint8Array) => void} options.send
 * @param {string[]} [options.names] display names of sides 1 and 2
 * @param {(ms: number) => void} [options.onPing]
 * @param {(line: string) => void} [options.log]
 */
export function createNetBridge({
  role,
  send,
  names = [],
  onPing = () => {},
  log = () => {},
  timers = globalThis,
}) {
  let stream = [];
  let datagrams = [];
  let started = false;
  let peerListening = false;
  let peerLeft = false;
  let closed = false;
  let helloTimer = null;

  const sayHello = () => send(CONTROL, Uint8Array.of(HELLO));

  const bridge = {
    start() {
      if (closed) return;
      started = true;
      sayHello();
      helloTimer = timers.setInterval(() => {
        if (peerListening || closed) {
          timers.clearInterval(helloTimer);
          helloTimer = null;
        } else sayHello();
      }, HELLO_INTERVAL_MS);
    },
    queueRole: () => (started ? role : ''),
    queueNames: () => names.join('\n'),
    rankStatus: () => '',
    connected: () => started && peerListening && !closed,
    failed: () => peerLeft,
    read(max) {
      if (closed) return null;
      if (!stream.length) return new Uint8Array(0);
      const first = stream[0];
      if (first.length <= max) {
        stream.shift();
        return first;
      }
      stream[0] = first.subarray(max);
      return first.subarray(0, max);
    },
    send(bytes) {
      if (closed) return false;
      send(STREAM, new Uint8Array(bytes));
      return true;
    },
    sendGGPO(bytes) {
      if (!closed) send(DATAGRAM, new Uint8Array(bytes));
    },
    readGGPO() {
      if (closed) return null;
      return datagrams.shift() ?? new Uint8Array(0);
    },
    close() {
      if (closed) return;
      closed = true;
      if (helloTimer) timers.clearInterval(helloTimer);
      send(CONTROL, Uint8Array.of(BYE));
    },
    reportResult() {
      // ChaOS reads the result from the engine's match log instead.
    },
    setPing: (ms) => onPing(ms),
    olog: (line) => log(line),
  };

  return {
    bridge,
    receive(channel, bytes) {
      if (closed) return;
      const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      if (channel === STREAM) stream.push(data);
      else if (channel === DATAGRAM) datagrams.push(data);
      else if (channel === CONTROL && data[0] === HELLO) {
        if (!peerListening) {
          peerListening = true;
          if (started) sayHello(); // the peer may have started first
        }
      } else if (channel === CONTROL && data[0] === BYE) peerLeft = true;
    },
    dispose() {
      bridge.close();
      stream = [];
      datagrams = [];
    },
  };
}
