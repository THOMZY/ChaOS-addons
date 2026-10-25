export function createWormsActions({
  getState,
  sendCommand,
  playSound,
  targetedWeapons,
  fuseWeapons,
  isActive = () => true,
  wormRadius = 10,
}) {
  let current = null,
    isStopped = false;
  const cancelled = Symbol('retired Worms action');
  function isCurrent(action) {
    return !isStopped && current === action && isActive();
  }
  function assertCurrent(action) {
    if (!isCurrent(action)) throw cancelled;
  }
  function send(action, name, payload) {
    sendCommand(name, payload);
    assertCurrent(action);
  }
  function play(action, volume) {
    playSound('THROWRELEASE', volume);
    assertCurrent(action);
  }
  function useRope(action, state) {
    if (state.rope) {
      state.rope = null;
      return;
    }
    send(action, 'worms:use_tool', { roomId: state.roomId, weapon: 'ninja_rope' });
    const speed = 530;
    state.rope = {
      state: 'flying',
      cx: state.physics.cx + Math.cos(state.aimAngle) * (wormRadius + 6),
      cy: state.physics.cy + Math.sin(state.aimAngle) * (wormRadius + 6),
      vx: Math.cos(state.aimAngle) * speed,
      vy: Math.sin(state.aimAngle) * speed,
      anchorX: 0,
      anchorY: 0,
      len: 0,
    };
    state.hasShotFired = true;
    state.hasMovementToolUsed = true;
    play(action, 0.4);
  }
  function useJetpack(action, state) {
    if (state.isJetpackActive) return;
    send(action, 'worms:use_tool', { roomId: state.roomId, weapon: 'jetpack' });
    state.isJetpackActive = true;
    state.jetpackFuel = 1;
    state.physics.onGround = false;
    state.physics.vy = -40;
    state.hasShotFired = true;
    state.hasMovementToolUsed = true;
    play(action, 0.45);
  }
  function teleport(action, state) {
    if (!state.teleportTarget) return;
    state.hasShotFired = true;
    send(action, 'worms:fire', {
      roomId: state.roomId,
      angle: 0,
      power: 1,
      weapon: 'teleport',
      targetX: state.teleportTarget.x,
      targetY: state.teleportTarget.y,
    });
    state.teleportTarget = null;
  }
  function shoot(action, state) {
    state.hasShotFired = true;
    send(action, 'worms:fire', {
      roomId: state.roomId,
      angle: state.aimAngle,
      power: state.power,
      weapon: state.selectedWeapon,
      targetX: targetedWeapons.has(state.selectedWeapon) ? state.mouseX : undefined,
      fuseMs: fuseWeapons.has(state.selectedWeapon)
        ? state.grenadeFuse * 1000
        : state.selectedWeapon === 'holy_grenade'
          ? 3000
          : undefined,
    });
  }
  function fire() {
    if (isStopped || !isActive() || current) return false;
    const action = {};
    current = action;
    try {
      const state = getState();
      assertCurrent(action);
      if (!state.isMyTurn || state.hasShotFired || state.isAnimating) return false;
      if (state.selectedWeapon === 'ninja_rope') useRope(action, state);
      else if (state.selectedWeapon === 'jetpack') useJetpack(action, state);
      else if (state.selectedWeapon === 'teleport') teleport(action, state);
      else shoot(action, state);
      return true;
    } catch (error) {
      if (error !== cancelled) throw error;
      return false;
    } finally {
      if (current === action) current = null;
    }
  }
  function reset() {
    current = null;
  }
  function stop() {
    isStopped = true;
    reset();
  }
  function status() {
    return { isStopped, isFiring: current !== null };
  }
  return { fire, reset, stop, status };
}
