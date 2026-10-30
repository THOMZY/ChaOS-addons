const WEAPON_HOTKEYS = {
  1: 'bazooka',
  2: 'hand_grenade',
  3: 'cluster_bomb',
  4: 'shotgun',
  5: 'minigun',
  6: 'mortar',
  7: 'airstrike',
  8: 'drill',
  9: 'dynamite',
  0: 'holy_grenade',
  a: 'banana_bomb',
  e: 'napalm',
  r: 'land_mine',
  t: 'ninja_rope',
  y: 'jetpack',
  u: 'bat',
  i: 'teleport',
};
const MOVEMENT_KEYS = new Set([
  'q',
  'd',
  'z',
  's',
  ' ',
  'arrowleft',
  'arrowright',
  'arrowup',
  'arrowdown',
  'backspace',
]);

export function createWormsInput({
  getState,
  eventTarget,
  on,
  off,
  ownsInput,
  isVisible,
  fuseWeapons,
  selectWeapon,
  updateFuseDisplay,
  selectWorm,
  playSound,
  playRandomSpeech,
  fire,
  now = Date.now,
  isActive = () => true,
  logger = console,
  width = 960,
  height = 480,
}) {
  let current = null,
    isStopped = false;
  const cancelled = Symbol('retired Worms input');
  function isCurrent(session) {
    return !isStopped && current === session && isActive();
  }
  function assertCurrent(session) {
    if (!isCurrent(session)) throw cancelled;
  }
  function readState(session) {
    const state = getState();
    assertCurrent(session);
    session.state = state;
    return state;
  }
  function call(session, action, ...args) {
    const value = action(...args);
    assertCurrent(session);
    return value;
  }
  function releaseCapture(session) {
    const pointerId = session.pointerId;
    session.pointerId = null;
    if (pointerId === null) return;
    try {
      if (session.canvas.hasPointerCapture?.(pointerId) !== false)
        session.canvas.releasePointerCapture?.(pointerId);
    } catch (error) {
      logger.warn('[worms-input] pointer release failed', error);
    }
  }
  function cancelState(session) {
    if (!session.state) return;
    session.state.keys.clear();
    session.state.chargeStart = null;
  }
  function release() {
    const session = current;
    if (!session) return;
    try {
      cancelState(session);
    } finally {
      releaseCapture(session);
    }
  }
  function clean(session) {
    for (const binding of session.bindings) {
      try {
        off(binding.target, binding.type, binding.callback);
      } catch (error) {
        logger.warn('[worms-input] listener cleanup failed', error);
      }
    }
    session.bindings.clear();
    releaseCapture(session);
  }
  function reset() {
    const previous = current;
    current = null;
    if (!previous) return;
    try {
      cancelState(previous);
    } finally {
      clean(previous);
    }
  }
  function stop() {
    isStopped = true;
    reset();
  }
  function listen(session, target, type, action) {
    const binding = {
      target,
      type,
      callback: (event) => {
        if (!isCurrent(session)) return;
        try {
          if (!call(session, isVisible)) {
            release();
            return;
          }
          action(event);
        } catch (error) {
          if (error !== cancelled) {
            if (isCurrent(session)) release();
            throw error;
          }
        }
      },
    };
    session.bindings.add(binding);
    on(target, type, binding.callback);
    assertCurrent(session);
  }
  function canCharge(state) {
    return state.isMyTurn && !state.hasShotFired && !state.isAnimating;
  }
  function beginCharge(session, state) {
    state.chargeStart = call(session, now);
    call(session, playSound, 'THROWPOWERUP', 0.35);
  }
  function releaseCharge(session) {
    const state = readState(session);
    if (state.chargeStart !== null && canCharge(state)) {
      state.power = Math.max(0.08, Math.min(1, (call(session, now) - state.chargeStart) / 1500));
      state.chargeStart = null;
      call(session, playRandomSpeech, 'fire');
      call(session, fire);
    } else state.chargeStart = null;
  }
  function updateAim(session, state) {
    if (!state.isMyTurn || state.hasShotFired) return;
    if (['z', 's', 'arrowup', 'arrowdown'].some((key) => state.keys.has(key))) return;
    const active = state.worms.find((worm) => worm.id === state.activeWormId);
    if (!active) return;
    const cx = state.isPhysicsSynced ? state.physics.cx : active.cx;
    const cy = state.isPhysicsSynced ? state.physics.cy : active.cy;
    state.aimAngle = Math.atan2(state.mouseY - cy, state.mouseX - cx);
    if (Math.cos(state.aimAngle) > 0) state.physics.facing = 1;
    else if (Math.cos(state.aimAngle) < 0) state.physics.facing = -1;
    assertCurrent(session);
  }
  function updatePointer(session, event) {
    const rect = call(session, () => session.canvas.getBoundingClientRect());
    const aspect = width / height,
      rectAspect = rect.width / rect.height;
    let contentWidth, contentHeight, left, top;
    if (rectAspect > aspect) {
      contentHeight = rect.height;
      contentWidth = contentHeight * aspect;
      left = rect.left + (rect.width - contentWidth) / 2;
      top = rect.top;
    } else {
      contentWidth = rect.width;
      contentHeight = contentWidth / aspect;
      left = rect.left;
      top = rect.top + (rect.height - contentHeight) / 2;
    }
    if (contentWidth <= 0 || contentHeight <= 0) return;
    const state = readState(session);
    state.mouseX = Math.max(0, Math.min(width, (event.clientX - left) * (width / contentWidth)));
    state.mouseY = Math.max(0, Math.min(height, (event.clientY - top) * (height / contentHeight)));
    updateAim(session, state);
  }
  function handleKeyDown(session, event) {
    if (!call(session, ownsInput, event)) return;
    const state = readState(session),
      key = event.key.toLowerCase();
    if (MOVEMENT_KEYS.has(key)) event.preventDefault();
    state.keys.add(key);
    const canSetFuse = fuseWeapons.has(state.selectedWeapon) && canCharge(state);
    if (canSetFuse && ['1', '2', '3', '4', '5'].includes(key)) {
      state.grenadeFuse = parseInt(key);
      call(session, updateFuseDisplay);
    } else if (Object.hasOwn(WEAPON_HOTKEYS, key)) call(session, selectWeapon, WEAPON_HOTKEYS[key]);
    if (key === 'c' && !event.repeat && canCharge(state)) {
      event.preventDefault();
      const worms = state.worms.filter((worm) => worm.playerId === state.myUserId && worm.alive);
      if (worms.length > 1) {
        const index = worms.findIndex((worm) => worm.id === state.activeWormId);
        call(session, selectWorm, worms[(index + 1) % worms.length].id);
      }
    }
  }
  function handlePointerDown(session, event) {
    const state = readState(session);
    if (
      event.button !== 0 ||
      !canCharge(state) ||
      session.pointerId !== null ||
      state.chargeStart !== null
    )
      return;
    event.preventDefault();
    updatePointer(session, event);
    session.pointerId = event.pointerId;
    try {
      call(session, () => session.canvas.setPointerCapture?.(event.pointerId));
    } catch (error) {
      session.pointerId = event.pointerId;
      releaseCapture(session);
      throw error;
    }
    if (state.selectedWeapon === 'teleport') {
      state.teleportTarget = { x: state.mouseX, y: state.mouseY };
      state.power = 1;
      try {
        call(session, playRandomSpeech, 'fire');
        call(session, fire);
      } finally {
        releaseCapture(session);
      }
      return;
    }
    try {
      beginCharge(session, state);
    } catch (error) {
      if (isCurrent(session)) cancelState(session);
      releaseCapture(session);
      throw error;
    }
  }
  function bind(canvas) {
    reset();
    if (isStopped || !isActive() || !canvas) return false;
    const session = { canvas, pointerId: null, bindings: new Set() };
    current = session;
    try {
      readState(session);
      listen(session, eventTarget, 'keydown', (event) => handleKeyDown(session, event));
      listen(session, eventTarget, 'keyup', (event) => {
        if (call(session, ownsInput, event))
          readState(session).keys.delete(event.key.toLowerCase());
      });
      listen(session, canvas, 'pointermove', (event) => {
        if (session.pointerId === null || session.pointerId === event.pointerId)
          updatePointer(session, event);
      });
      listen(session, canvas, 'pointerdown', (event) => handlePointerDown(session, event));
      listen(session, canvas, 'pointerup', (event) => {
        if (event.button !== 0 || session.pointerId !== event.pointerId) return;
        try {
          releaseCharge(session);
        } finally {
          releaseCapture(session);
        }
      });
      listen(session, canvas, 'pointercancel', (event) => {
        if (session.pointerId === event.pointerId) release();
      });
      listen(session, canvas, 'lostpointercapture', (event) => {
        if (session.pointerId === event.pointerId) release();
      });
      listen(session, eventTarget, 'keydown', (event) => {
        if (!call(session, ownsInput, event)) return;
        const state = readState(session);
        if (event.key === 'Enter' && canCharge(state)) {
          event.preventDefault();
          if (state.chargeStart === null) beginCharge(session, state);
        }
      });
      listen(session, eventTarget, 'keyup', (event) => {
        if (
          call(session, ownsInput, event) &&
          event.key === 'Enter' &&
          session.pointerId === null &&
          readState(session).chargeStart !== null
        )
          releaseCharge(session);
      });
      return true;
    } catch (error) {
      if (current === session) {
        release();
        current = null;
      }
      clean(session);
      if (error !== cancelled) throw error;
      return false;
    }
  }
  function status() {
    return {
      isStopped,
      isBound: current !== null,
      listeners: current?.bindings.size ?? 0,
      hasPointer: current?.pointerId !== null && current !== null,
    };
  }
  return { bind, release, reset, stop, status };
}
