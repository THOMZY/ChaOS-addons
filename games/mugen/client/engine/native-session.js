// Per-match callbacks around one long-lived native Go training engine.
export function createNativeSession({
  outcome,
  onReady,
  onFinished = () => {},
  setVolume,
  timers = globalThis,
}) {
  let active = null,
    idle = Promise.resolve(),
    release = null,
    closed = false,
    presentation = 0,
    presentationTimer = null;
  function clearPresentation() {
    presentation++;
    if (presentationTimer !== null) timers.clearTimeout(presentationTimer);
    presentationTimer = null;
  }
  const bridge = {
    pending: '',
    stop: false,
    presented: false,
    loads: 0,
    reuses: 0,
    ticks: 0,
    polls: 0,
    trace: [],
    phase(name) {
      bridge.trace.push({ name, at: performance.now() });
      if (bridge.trace.length > 40) bridge.trace.shift();
    },
    present() {
      clearPresentation();
      const version = presentation;
      const acknowledge = () => {
        if (version !== presentation) return;
        clearPresentation();
        bridge.presented = true;
      };
      bridge.phase('paint');
      active?.onStatus({ phase: 'running' });
      // Background tabs suspend animation frames: an online peer must not
      // wait indefinitely for this browser to paint its first fight frame.
      if (active?.net) presentationTimer = timers.setTimeout(acknowledge, 1000);
      requestAnimationFrame(() => requestAnimationFrame(acknowledge));
    },
    finished() {
      clearPresentation();
      bridge.phase('finished');
      const match = active;
      const result = outcome();
      onFinished();
      active = null;
      bridge.stop = false;
      release?.();
      release = null;
      match?.onExit(result);
    },
  };
  return {
    bridge,
    async launch(options, initial = false) {
      bridge.phase('requested');
      await idle;
      bridge.phase('begin');
      if (closed) throw new Error('engine_stopped');
      active = options;
      clearPresentation();
      idle = new Promise((resolve) => {
        release = resolve;
      });
      bridge.stop = false;
      bridge.presented = false;
      await onReady(options);
      setVolume(options.audio);
      options.onStatus({ phase: 'starting' });
      if (!initial) bridge.pending = JSON.stringify(options.args);
    },
    cancel() {
      bridge.phase('cancel');
      if (active) bridge.stop = true;
    },
    fail(value) {
      clearPresentation();
      closed = true;
      onFinished();
      const match = active;
      active = null;
      release?.();
      release = null;
      match?.onExit(value);
    },
  };
}
