// One native Ikemen session in an iframe. A resident owner leases this frame
// across matches; removing it releases the Go VM, its decoded assets and audio.
import { readVolumes } from './volume.js';
const HOST_URL = '/games/mugen/client/engine/host.html';

/** save/config.ini overrides: the window's volume sliders and ChaOS defaults. */
export function engineConfig() {
  const { bgm, sfx } = readVolumes();
  return [
    '[Sound]',
    `BGMVolume = ${bgm}`,
    `WavVolume = ${sfx}`,
    'BGMRAMBuffer = false',
    '[Netplay]',
    'RollbackNetcode = 1',
    // The relay through the chat server adds a hop: give a stalled peer time.
    'Rollback.DisconnectNotifyStart = 3000',
    'Rollback.DisconnectTimeout = 10000',
    '',
  ].join('\n');
}

export function createEngineFrame({ container, scope, resources }) {
  const frame = document.createElement('iframe');
  frame.className = 'mugen-engine-frame';
  frame.title = 'MUGEN';
  frame.setAttribute('allow', 'autoplay; fullscreen; gamepad');
  frame.src = HOST_URL;
  container.append(frame);
  let destroyed = false;
  let onEscape = null;
  let canFocus = () => true;
  const focus = () => {
    if (canFocus()) frame.contentWindow?.document.getElementById('ikemen-canvas')?.focus();
  };
  scope.on(frame, 'mouseenter', focus);

  const ready = new Promise((resolve, reject) => {
    frame.addEventListener('load', () => {
      const interceptEscape = (event) => {
        if (event.key !== 'Escape' || !onEscape) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.type === 'keydown' && !event.repeat) onEscape();
      };
      scope.on(frame.contentWindow?.document, 'keydown', interceptEscape, { capture: true });
      scope.on(frame.contentWindow?.document, 'keyup', interceptEscape, { capture: true });
      const engine = frame.contentWindow?.mugenEngine;
      if (engine) resolve(engine);
      else reject(new Error('engine_frame_failed'));
    });
    frame.addEventListener('error', () => reject(new Error('engine_frame_failed')));
  });

  return {
    element: frame,
    focus,
    cancelMatch: () => {
      onEscape = null;
      frame.contentWindow?.mugenEngine?.cancelMatch();
    },
    releaseInput: () => frame.contentWindow?.mugenEngine?.releaseInput(),
    setVolume: (values) => {
      if (!destroyed) frame.contentWindow?.mugenEngine?.setVolume(values);
    },
    /** Starts the match; resolves with { receive } once the engine runs. */
    async start(options) {
      onEscape = options.onEscape ?? null;
      canFocus = options.canFocus ?? (() => true);
      const engine = await scope.wait(ready, 30_000);
      if (destroyed) throw new Error('engine_stopped');
      const handle = await engine.start({
        manifestUrl: '/api/mugen/fs',
        config: engineConfig(),
        audio: readVolumes(),
        resources,
        ...options,
      });
      if (destroyed) throw new Error('engine_stopped');
      engine.setVolume(readVolumes()); // Sliders may have moved during loading.
      focus();
      return handle;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      frame.src = 'about:blank';
      frame.remove();
    },
  };
}
