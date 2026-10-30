// One native engine can serve successive local, versus and spectator matches.
import { createBrowserFileSystem } from './vfs.js';
import { createNetBridge } from './net-bridge.js';
import { createLiveReplay, createReplaySender, REPLAY_PATH } from './live-replay.js';
import { createAudioControl } from '../volume.js';
import { createEngineResources } from './resources.js';
import { createNativeSession } from './native-session.js';

const ENGINE_BASE = '/games/mugen/engine/';
const MATCH_LOG = 'save/chaos-match.log';
let audioControl = null;
let resident = null;
const heldKeys = new Set();
globalThis.document?.addEventListener('keydown', (event) => heldKeys.add(event.code));
globalThis.document?.addEventListener('keyup', (event) => heldKeys.delete(event.code));
function releaseKeys() {
  for (const code of [...heldKeys]) document.dispatchEvent(new KeyboardEvent('keyup', { code }));
  heldKeys.clear();
}

function loadScript(url) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = url;
    script.onload = resolve;
    script.onerror = () => reject(new Error('engine loader unavailable'));
    document.head.appendChild(script);
  });
}

/** winSide (0 or 1) from the engine's -log dump of the match statistics, or null. */
export function readWinSide(log) {
  if (!log) return null;
  // main.f_printTable indents the match's own fields by two spaces.
  const match = /^ {2}\["WinSide"\] => (-?\d+)\s*$/im.exec(log);
  if (!match) return null;
  const side = Number(match[1]);
  return side === 0 || side === 1 ? side : null;
}

// Each launch owns fresh transports and replay state, while the Go VM and its
// decoded assets stay resident until the MUGEN window closes.
async function start({
  manifestUrl,
  args,
  config,
  net = null,
  replay = null,
  audio = {},
  resources = null,
  persistent = false,
  onStatus = () => {},
  onExit = () => {},
}) {
  const sessionOptions = {
    args: [...args, ...(replay ? ['-chaos-replay', REPLAY_PATH] : []), '-log', MATCH_LOG],
    net,
    replay,
    audio,
    onStatus,
    onExit,
  };
  if (persistent && resident) {
    await resident.session.launch(sessionOptions);
    return resident.handle();
  }
  const errors = [];
  onStatus({ phase: 'files' });
  const cache = resources ?? createEngineResources();
  const readManifest = async () => {
    if (resources) return resources.manifest();
    const response = await fetch(manifestUrl, { cache: 'no-store' });
    if (!response.ok)
      throw new Error(response.status === 503 ? 'engine_missing' : 'files_unavailable');
    return response.json();
  };
  const manifest = await readManifest();
  if (
    manifest.engine.audioProtocol !== 1 ||
    manifest.engine.startupProtocol !== 1 ||
    (persistent && manifest.engine.sessionProtocol !== 2) ||
    ((net || replay) && manifest.engine.replayProtocol !== 1)
  )
    throw new Error('engine_rebuild_required');
  let io = null,
    session = null;
  const files = createBrowserFileSystem(manifest, {
    fetchFile: (url) => cache.fetchFile(url),
    onWrite: (path, position, bytes) => {
      if (path === 'save/chaos-ready' && bytes.length) {
        if (session) session.bridge.phase('loaded');
        else onStatus({ phase: 'running' });
      }
      io?.sender?.write(path, position, bytes);
    },
    log(line, isError) {
      if (isError) {
        errors.push(line);
        if (errors.length > 40) errors.shift();
      }
      (isError ? console.warn : console.info)('[ikemen] ' + line);
    },
  });
  files.writeText('save/config.ini', config);
  globalThis.fs = files.fs;
  globalThis.process = files.process;
  globalThis.path = files.path;
  audioControl = createAudioControl(audio);
  globalThis.chaosAudio = audioControl.state;
  const outcome = () => ({
    code: 0,
    winSide: readWinSide(files.readText(MATCH_LOG)),
    errors: [...errors],
  });
  const disposeMatch = () => {
    io?.sender?.dispose();
    io?.relay?.dispose();
    io?.live?.dispose();
    io = null;
  };
  let first = true;
  const prepare = async (options) => {
    releaseKeys();
    if (!first) {
      const updated = await readManifest();
      if (updated.engine.version !== manifest.engine.version)
        throw new Error('engine_rebuild_required');
      files.mount(updated);
    }
    first = false;
    errors.length = 0;
    files.writeText(MATCH_LOG, '');
    files.writeText(REPLAY_PATH, '');
    const live = options.replay
      ? createLiveReplay(files, { onProgress: options.replay.onProgress })
      : null;
    const relay = options.net ? createNetBridge(options.net) : null;
    const sender = options.net?.role === 'host' ? createReplaySender(options.net.sendReplay) : null;
    io = { live, relay, sender };
    globalThis.ikemenNet = relay?.bridge ?? null;
    globalThis.chaosReplay = { speed: () => live?.speed() ?? 1 };
  };
  const handle = () => {
    const current = io;
    return {
      receive: (channel, bytes) => current?.relay?.receive(channel, bytes),
      receiveReplay: (chunk) => current?.live?.push(chunk),
      endReplay: () => current?.live?.end(),
    };
  };
  if (persistent) {
    session = createNativeSession({
      outcome,
      onReady: prepare,
      onFinished: disposeMatch,
      setVolume: (values) => audioControl.setVolume(values),
    });
    resident = {
      session,
      handle,
      cancel: () => {
        session.cancel();
        io?.live?.end();
        io?.relay?.dispose();
      },
    };
    globalThis.chaosSession = session.bridge;
    await session.launch(sessionOptions, true);
  } else await prepare(sessionOptions);
  await loadScript(ENGINE_BASE + manifest.engine.loader);
  const module = await cache.engine(manifest.engine, (progress) =>
    onStatus({ phase: 'engine', progress }),
  );
  onStatus({ phase: 'starting' });
  const go = new globalThis.Go();
  go.argv = ['ikemen', ...sessionOptions.args, ...(persistent ? ['-chaos-session'] : [])];
  go.env = { GOGC: '200' };
  let exitCode = 0;
  go.exit = (code) => {
    exitCode = code;
  };
  const instance = await WebAssembly.instantiate(module, go.importObject);
  document.getElementById('ikemen-canvas')?.focus();
  const finish = (result) => {
    disposeMatch();
    if (!resources) void cache.dispose();
    if (session) session.fail(result);
    else onExit(result);
  };
  go.run(instance).then(
    () => finish({ ...outcome(), code: exitCode }),
    (error) => {
      errors.push(String(error?.message ?? error));
      finish({ code: 2, winSide: null, errors: [...errors] });
    },
  );
  return handle();
}

globalThis.mugenEngine = {
  start,
  cancelMatch: () => {
    releaseKeys();
    resident?.cancel();
  },
  setVolume: (values) => audioControl?.setVolume(values),
};
