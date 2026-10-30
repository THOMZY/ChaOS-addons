import { duelArgs } from '/games/mugen/client/match-options.js';
import { createEngineResources } from '/games/mugen/client/engine/resources.js';

const result = (window.replayTest = {
  bytes: 0,
  history: [],
  caughtUp: false,
  phases: {},
});
const resources = createEngineResources({
  fetch: (...args) => {
    if (String(args[0]).endsWith('.wasm')) result.wasmDownloads = (result.wasmDownloads || 0) + 1;
    return fetch(...args);
  },
});
const args = [
  ...duelArgs({
    p1: { path: 'kfm/kfm.def' },
    p2: { path: 'kfm/kfm.def' },
    stage: { path: 'kfm.def' },
  }),
  '-time',
  '8',
  '-rounds',
  '1',
  '-p1.life',
  '500',
];
const config =
  '[Netplay]\nRollbackNetcode = 1\nRollback.DisconnectTimeout = 30000\n[Sound]\nBGMVolume = 0\nWavVolume = 0\n';
const frames = [];
let datagram = 0;

async function checkLiveAudio() {
  const until = async (check) => {
    for (let i = 0; i < 1000; i++) {
      if (check()) return;
      await new Promise((done) => setTimeout(done, 20));
    }
    throw new Error('live audio setting was not applied by the Go mixer');
  };
  frames[0].mugenEngine.setVolume({ bgm: 0, sfx: 67 });
  await until(
    () => frames[0].chaosAudio?.appliedBgm === 0 && frames[0].chaosAudio?.appliedSfx === 67,
  );
  frames[0].mugenEngine.setVolume({ bgm: 23, sfx: 0 });
  await until(
    () => frames[0].chaosAudio?.appliedBgm === 23 && frames[0].chaosAudio?.appliedSfx === 0,
  );
  if (frames[1].chaosAudio.bgm === 23 || frames[1].chaosAudio.sfx === 67)
    throw new Error('local volume leaked to the other player');
  frames[0].mugenEngine.setVolume({ bgm: 0, sfx: 0 });
  result.audioControls = true;
}

async function frame() {
  const element = document.createElement('iframe');
  element.src = '/games/mugen/client/engine/host.html';
  document.body.append(element);
  frames.push(element.contentWindow);
  await new Promise((done) => (element.onload = done));
  return element.contentWindow.mugenEngine;
}
async function stats(index) {
  const fs = frames[index].fs;
  const call = (method, ...values) =>
    new Promise((done, reject) =>
      fs[method](...values, (error, value) => (error ? reject(error) : done(value))),
    );
  const handle = await call('open', 'save/chaos-match.log', 0, 0);
  const { size } = await call('fstat', handle);
  const bytes = new Uint8Array(size);
  await call('read', handle, bytes, 0, size, 0);
  await call('close', handle);
  return new TextDecoder().decode(bytes);
}

let round = 0;
async function runRound(isRematch = false) {
  const generation = ++round;
  const pending = [[], []],
    peers = [],
    engines = [];
  const roundArgs = [
    ...args,
    '-p1.life',
    isRematch ? '1000' : '10',
    '-p2.life',
    isRematch ? '10' : '1000',
  ];
  Object.assign(result, {
    bytes: 0,
    history: [],
    caughtUp: false,
    phases: {},
    done: false,
    joining: false,
    liveSpectator: false,
  });
  delete result.host;
  delete result.guest;
  delete result.spectator;
  delete result.failure;
  delete result.hostStats;
  delete result.spectatorStats;
  const finish = () => {
    if (
      !result.host ||
      !result.guest ||
      !result.spectator ||
      !result.hostStats ||
      !result.spectatorStats
    )
      return;
    result.done = true;
    if (isRematch) result.restart = { code: 0 };
  };
  const watch = async () => {
    result.joining = true;
    const api = frames[2]?.mugenEngine ?? (await frame());
    engines[2] = await api.start({
      persistent: true,
      resources,
      manifestUrl: '/api/mugen/fs',
      args: roundArgs,
      config,
      replay: {
        onProgress: ({ behindBytes }) => {
          if (behindBytes > 64 * 120) result.caughtUp = true;
        },
      },
      onStatus: (status) => (result.phases.spectator = status),
      onExit: async (outcome) => {
        result.spectator = outcome;
        if (outcome.code) result.failure = JSON.stringify(outcome);
        result.spectatorStats = await stats(2);
        finish();
      },
    });
    for (const chunk of result.history) engines[2].receiveReplay(chunk);
    result.liveSpectator = true;
    if (result.host && result.guest) engines[2].endReplay();
  };
  for (let slot = 0; slot < 2; slot++) peers.push(frames[slot]?.mugenEngine ?? (await frame()));
  await Promise.all(
    peers.map(async (api, slot) => {
      const role = (isRematch ? slot === 1 : slot === 0) ? 'host' : 'guest';
      engines[slot] = await api.start({
        persistent: true,
        resources,
        manifestUrl: '/api/mugen/fs',
        args: [...roundArgs, '-ip', 'webrtc-casual'],
        config,
        net: {
          role,
          names: ['A', 'B'],
          send(channel, bytes) {
            const data = new Uint8Array(bytes),
              other = 1 - slot;
            const deliver = () => {
              if (round !== generation) return;
              if (engines[other]) engines[other].receive(channel, data);
              else pending[other].push([channel, data]);
            };
            if (channel === 1) setTimeout(deliver, 20 + (datagram++ % 4) * 15);
            else deliver();
          },
          sendReplay(chunk) {
            result.history.push(chunk);
            result.bytes += chunk.data.length;
            if (result.liveSpectator) engines[2].receiveReplay(chunk);
            if (result.bytes > 16000 && !result.joining)
              void watch().catch((error) => (result.failure = String(error.stack ?? error)));
          },
        },
        onStatus: (status) => {
          result.phases[slot] = status;
          if (isRematch) result.restartPhase = status.phase;
        },
        onExit: async (outcome) => {
          result[role] = outcome;
          if (role === 'host') result.hostStats = await stats(slot);
          if (outcome.code) result.failure = JSON.stringify(outcome);
          if (result.host && result.guest) engines[2]?.endReplay();
          finish();
        },
      });
      for (const [channel, data] of pending[slot]) engines[slot].receive(channel, data);
    }),
  );
  void checkLiveAudio().catch((error) => (result.failure = String(error.stack ?? error)));
  let down = false;
  const hostSlot = isRematch ? 1 : 0;
  const timer = setInterval(() => {
    if (result.host || round !== generation) {
      clearInterval(timer);
      return;
    }
    down = !down;
    for (const code of ['ArrowRight', 'KeyZ', 'KeyX'])
      frames[hostSlot].document.dispatchEvent(
        new frames[hostSlot].KeyboardEvent(down ? 'keydown' : 'keyup', {
          code,
          key: code === 'ArrowRight' ? 'ArrowRight' : code.slice(-1).toLowerCase(),
        }),
      );
  }, 150);
}
window.replayRestart = () => runRound(true);
window.replayOffline = async () => {
  const play = (p2) =>
    new Promise((resolve, reject) => {
      frames[0].mugenEngine
        .start({
          persistent: true,
          resources,
          manifestUrl: '/api/mugen/fs',
          args: [...args, '-p2', p2, '-time', '1', '-rounds', '1'],
          config,
          onExit: (outcome) =>
            outcome.code ? reject(new Error(JSON.stringify(outcome))) : resolve(outcome),
        })
        .catch(reject);
    });
  await play('kfm720/kfm720.def');
  result.offline = await play('kfm/kfm.def');
};
try {
  await runRound();
} catch (error) {
  result.failure = String(error.stack ?? error);
}
