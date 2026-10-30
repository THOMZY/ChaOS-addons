export function createWormsRound({
  services,
  camera,
  frames,
  timers,
  now = () => performance.now(),
  isActive = () => true,
  logger = console,
  width = 960,
}) {
  let current = null,
    isStopped = false,
    startRevision = 0;
  const cancelled = Symbol('retired Worms round');
  function isCurrent(session) {
    return !isStopped && current === session && isActive();
  }
  function assertCurrent(session) {
    if (!isCurrent(session)) throw cancelled;
  }
  function invoke(session, name, ...args) {
    assertCurrent(session);
    const result = services[name](...args);
    assertCurrent(session);
    return result;
  }
  function readNow(session) {
    const value = now();
    assertCurrent(session);
    return value;
  }
  function runCleanup(action) {
    try {
      action();
    } catch (error) {
      logger.warn('[worms-round] cleanup failed', error);
    }
  }
  function cancelEntry(session, entry) {
    if (entry.phase !== 'pending') return;
    entry.phase = 'cancelled';
    session[entry.kind].delete(entry);
    if (entry.id !== null)
      runCleanup(() =>
        entry.kind === 'frames' ? frames.cancel(entry.id) : timers.clearTimeout(entry.id),
      );
  }
  function releaseSession(session) {
    for (const entry of [...session.frames, ...session.timeouts]) cancelEntry(session, entry);
  }
  function reset() {
    const previous = current;
    current = null;
    if (previous) releaseSession(previous);
  }
  function stop() {
    isStopped = true;
    startRevision++;
    reset();
  }
  function runRound(session, action) {
    if (!isCurrent(session)) return;
    try {
      action();
    } catch (error) {
      if (error !== cancelled) {
        if (current === session) current = null;
        releaseSession(session);
        throw error;
      }
    }
  }
  function allocate(session, kind, callback, delay) {
    assertCurrent(session);
    const entry = { id: null, kind, phase: 'pending' };
    session[kind].add(entry);
    try {
      const receive = (value) => {
        if (entry.phase !== 'pending' || !isCurrent(session)) return;
        entry.phase = 'completed';
        session[kind].delete(entry);
        runRound(session, () => callback(value));
      };
      entry.id = kind === 'frames' ? frames.request(receive) : timers.setTimeout(receive, delay);
      if (entry.phase === 'cancelled')
        runCleanup(() =>
          kind === 'frames' ? frames.cancel(entry.id) : timers.clearTimeout(entry.id),
        );
      assertCurrent(session);
      return entry;
    } catch (error) {
      cancelEntry(session, entry);
      throw error;
    }
  }
  function scheduleFrame(session) {
    allocate(session, 'frames', (time) => {
      scheduleFrame(session);
      const dt = Math.min((time - session.lastTime) / 1000, 0.05);
      session.lastTime = time;
      invoke(session, 'step', dt);
      invoke(session, 'render', time, dt);
      invoke(session, 'tickDamage', dt);
    });
  }
  function centerCamera(session, data) {
    const active = data.worms.find((worm) => worm.id === data.activeWormId);
    assertCurrent(session);
    if (!active) return;
    camera.x = Math.max(0, Math.min(width - width, active.cx - width / 2));
    camera.y = 0;
    camera.tx = camera.x;
    camera.ty = camera.y;
  }
  function start(data) {
    const attempt = ++startRevision;
    reset();
    if (isStopped || !isActive() || attempt !== startRevision) return false;
    const session = { frames: new Set(), timeouts: new Set(), lastTime: 0 };
    current = session;
    try {
      invoke(session, 'clearMenu');
      invoke(session, 'clearSprites');
      invoke(session, 'markGameMode');
      invoke(session, 'resetData', data);
      invoke(session, 'prepareTerrain', data);
      if (!invoke(session, 'mountView')) {
        if (current === session) current = null;
        releaseSession(session);
        return false;
      }
      invoke(session, 'updateHealth');
      centerCamera(session, data);
      invoke(session, 'initTurn');
      if (!invoke(session, 'bindInput')) {
        if (current === session) current = null;
        releaseSession(session);
        return false;
      }
      session.lastTime = readNow(session);
      scheduleFrame(session);
      invoke(session, 'updateHUD');
      allocate(session, 'timeouts', () => invoke(session, 'playSound', 'StartRound', 0.5), 200);
      return true;
    } catch (error) {
      if (current === session) current = null;
      releaseSession(session);
      if (error !== cancelled) throw error;
      return false;
    }
  }
  function status() {
    return {
      isStopped,
      isRunning: current !== null,
      frames: current?.frames.size ?? 0,
      timeouts: current?.timeouts.size ?? 0,
    };
  }
  return { start, reset, stop, status };
}
