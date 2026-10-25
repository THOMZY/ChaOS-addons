export function createWormsTurnAnimations({
  getState,
  getWeaponDefinition,
  playSound,
  timers = {
    setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
    clearTimeout: (id) => globalThis.clearTimeout(id),
  },
  clock = () => Date.now(),
  now = () => performance.now(),
  isActive = () => true,
}) {
  let isStopped = false,
    revision = 0,
    weaponRequest = 0,
    previousWeapon = null,
    weaponAnimation = null,
    weaponTimer = null,
    walkSoundTimer = 0,
    walkSoundStep = 0;
  const pending = new Set(),
    playedTicks = new Set(),
    cancelled = Symbol('retired turn animation');
  function isCurrent(value) {
    return !isStopped && revision === value && isActive();
  }
  function assertCurrent(state) {
    if (!isCurrent(state.revision)) throw cancelled;
  }
  function readNow(state) {
    const value = now();
    assertCurrent(state);
    return value;
  }
  function readClock(state) {
    const value = clock();
    assertCurrent(state);
    return value;
  }
  function play(state, ...args) {
    playSound(...args);
    assertCurrent(state);
  }
  function cancel(token) {
    if (!token || token.phase !== 'pending') return;
    token.phase = 'cancelled';
    pending.delete(token);
    if (token.id !== null) timers.clearTimeout(token.id);
  }
  function schedule(state, callback, delay) {
    const token = { id: null, revision: state.revision, phase: 'pending' };
    pending.add(token);
    try {
      token.id = timers.setTimeout(() => {
        if (!pending.delete(token)) return;
        token.phase = 'fired';
        if (isCurrent(token.revision)) callback();
      }, delay);
      if (token.phase === 'cancelled') {
        if (token.id !== null) timers.clearTimeout(token.id);
        assertCurrent(state);
      } else if (!isCurrent(token.revision)) {
        cancel(token);
        assertCurrent(state);
      }
      return token;
    } catch (error) {
      cancel(token);
      throw error;
    }
  }
  function reset() {
    revision++;
    weaponRequest++;
    previousWeapon = null;
    weaponAnimation = null;
    weaponTimer = null;
    for (const token of pending) cancel(token);
    playedTicks.clear();
  }
  function stop() {
    if (isStopped) return;
    isStopped = true;
    reset();
  }
  function status() {
    return {
      isStopped,
      timers: pending.size,
      timerTicks: playedTicks.size,
      hasWeaponAnimation: weaponAnimation !== null,
    };
  }
  function run(action, args = []) {
    if (isStopped || !isActive()) return;
    const currentRevision = revision,
      snapshot = getState(),
      state = { ...snapshot, revision: currentRevision };
    try {
      assertCurrent(state);
      return action(state, ...args);
    } catch (error) {
      if (error !== cancelled) throw error;
    }
  }
  function updateWalkSounds(state, dt) {
    if (!state.physics.walking) {
      walkSoundTimer = 0;
      return;
    }
    walkSoundTimer -= dt;
    if (walkSoundTimer > 0) return;
    walkSoundTimer = 0.22;
    play(state, walkSoundStep % 2 === 0 ? 'WalkExpand' : 'WalkCompress', 0.25);
    walkSoundStep++;
  }
  function updateWeaponTakeoutAnim(state) {
    if (!state.isMyTurn || previousWeapon === state.selectedWeapon) return;
    previousWeapon = state.selectedWeapon;
    const key = state.selectedWeapon,
      request = ++weaponRequest;
    cancel(weaponTimer);
    weaponTimer = null;
    const definition = getWeaponDefinition(key);
    assertCurrent(state);
    if (!definition?.takeOut) return;
    weaponAnimation = { ...definition.takeOut, phase: 'takeout', startMs: readNow(state) };
    weaponTimer = schedule(
      state,
      () =>
        run((current) => {
          if (weaponRequest !== request || current.selectedWeapon !== key || !current.isMyTurn)
            return;
          weaponTimer = null;
          weaponAnimation = definition.aim
            ? { ...definition.aim, phase: 'aim', startMs: readNow(current) }
            : null;
        }),
      definition.takeOut.frames * definition.takeOut.ms,
    );
  }
  function playTimerTickIfNeeded(state) {
    if (state.turnDeadline <= 0) return;
    const seconds = Math.ceil((state.turnDeadline - readClock(state)) / 1000);
    if (seconds > 5 || seconds <= 0 || !state.isMyTurn || playedTicks.has(seconds)) return;
    playedTicks.add(seconds);
    play(state, 'TIMERTICK', 0.6);
    schedule(
      state,
      () => {
        playedTicks.delete(seconds);
      },
      950,
    );
  }
  return {
    reset,
    stop,
    status,
    getWeaponAnimation: () => (!isStopped && isActive() ? weaponAnimation : null),
    updateWalkSounds: (...args) => run(updateWalkSounds, args),
    updateWeaponTakeoutAnim: () => run(updateWeaponTakeoutAnim),
    playTimerTickIfNeeded: () => run(playTimerTickIfNeeded),
  };
}
