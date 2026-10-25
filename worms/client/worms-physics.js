const GRAVITY = 400;
const WALK_SPD = 88;
// Jump physics
const JUMP_FWD_VY = -235; // forward hop vertical   (~69 px rise with G=400)
const JUMP_FWD_VX = 110; // forward hop horizontal
const BACKFLIP_VY = -310; // backflip vertical       (~120 px rise)
const BACKFLIP_VX = 150; // backflip horizontal (backward from facing)

export function createWormsPhysics({
  getState,
  playSound,
  spawnParticles,
  randomUnit,
  isActive = () => true,
  width = 960,
  height = 480,
  wormRadius = 10,
}) {
  let isStopped = false,
    revision = 0;
  const cancelled = Symbol('retired physics step');
  function assertCurrent(execution) {
    if (isStopped || execution.revision !== revision || !isActive()) throw cancelled;
  }
  function playSoundGuard(execution, ...args) {
    playSound(...args);
    assertCurrent(execution);
  }
  function spawnParticlesGuard(execution, ...args) {
    spawnParticles(...args);
    assertCurrent(execution);
  }
  function readRandom(execution) {
    const value = randomUnit();
    assertCurrent(execution);
    return value;
  }
  function reset() {
    revision++;
  }
  function stop() {
    if (isStopped) return;
    isStopped = true;
    reset();
  }
  function status() {
    return { isStopped };
  }
  function run(action, args) {
    if (isStopped || !isActive()) return;
    const currentRevision = revision,
      state = getState(),
      execution = { state, revision: currentRevision };
    try {
      assertCurrent(execution);
      return action(execution, ...args);
    } catch (error) {
      if (error !== cancelled) throw error;
    }
  }
  function stepRopeAttached(execution, dt, movingL, movingR) {
    const ax = execution.state.rope.anchorX,
      ay = execution.state.rope.anchorY;
    // Reel in / out
    if (execution.state.keys.has('z') || execution.state.keys.has('arrowup'))
      execution.state.rope.len = Math.max(25, execution.state.rope.len - 80 * dt);
    if (execution.state.keys.has('s') || execution.state.keys.has('arrowdown'))
      execution.state.rope.len = Math.min(260, execution.state.rope.len + 80 * dt);
    // Gravity on worm
    execution.state.physics.vy += GRAVITY * dt;
    // L/R apply tangential swing force
    if (movingL) execution.state.physics.vx -= 150 * dt;
    if (movingR) execution.state.physics.vx += 150 * dt;
    // Light air friction
    execution.state.physics.vx *= Math.exp(-0.6 * dt);
    // Integrate
    execution.state.physics.cx += execution.state.physics.vx * dt;
    execution.state.physics.cy += execution.state.physics.vy * dt;
    // Radial constraint: keep worm on circle of radius _rope.len
    const dx = execution.state.physics.cx - ax,
      dy = execution.state.physics.cy - ay;
    const dist = Math.sqrt(dx * dx + dy * dy) || 0.001;
    if (dist > execution.state.rope.len) {
      const nx = dx / dist,
        ny = dy / dist;
      const radV = execution.state.physics.vx * nx + execution.state.physics.vy * ny;
      if (radV > 0) {
        execution.state.physics.vx -= radV * nx;
        execution.state.physics.vy -= radV * ny;
      } // cancel outward velocity
      execution.state.physics.cx = ax + nx * execution.state.rope.len;
      execution.state.physics.cy = ay + ny * execution.state.rope.len;
    }
    // Terrain wall bounce while swinging
    if (
      execution.state.terrain &&
      isSolid(execution, execution.state.physics.cx, execution.state.physics.cy)
    ) {
      execution.state.physics.vx *= -0.35;
      execution.state.physics.vy *= -0.35;
    }
    // Landing: auto-detach rope when worm touches ground
    if (execution.state.physics.vy > 0 && execution.state.terrain) {
      const surY = getSurfaceAt(execution, execution.state.physics.cx);
      if (execution.state.physics.cy >= surY) {
        execution.state.physics.cy = surY;
        execution.state.physics.vy = 0;
        execution.state.physics.vx *= 0.35;
        execution.state.physics.onGround = true;
        execution.state.rope = null;
        playSoundGuard(execution, 'WormLanding', 0.4);
      }
    }
    // Water: fall through, rope detaches
    if (execution.state.physics.cy >= execution.state.waterLevel) execution.state.rope = null;
    // Bounds
    execution.state.physics.cx = Math.max(
      wormRadius,
      Math.min(width - wormRadius, execution.state.physics.cx),
    );
  }

  function stepJetpackPhysics(execution, dt, movingL, movingR) {
    const thrusting = isJetpackThrusting(execution);
    applyJetpackVertical(execution, dt, thrusting);
    applyJetpackHorizontal(execution, dt, movingL, movingR);
    moveJetpackWorm(execution, dt);
    landJetpackWorm(execution);
    if (execution.state.jetpackFuel <= 0 && !thrusting) execution.state.isJetpackActive = false;
    execution.state.physics.cx = Math.max(
      wormRadius,
      Math.min(width - wormRadius, execution.state.physics.cx),
    );
  }

  function isJetpackThrusting(execution) {
    return (
      execution.state.jetpackFuel > 0 &&
      (execution.state.keys.has('z') ||
        execution.state.keys.has('arrowup') ||
        execution.state.keys.has(' '))
    );
  }

  function applyJetpackVertical(execution, dt, thrusting) {
    const THRUST = 340;
    const DRAIN = 0.22; // ~4.5 s to empty tank
    if (thrusting) {
      execution.state.physics.vy = Math.max(execution.state.physics.vy - THRUST * dt, -220);
      execution.state.jetpackFuel = Math.max(0, execution.state.jetpackFuel - DRAIN * dt);
      if (readRandom(execution) < 0.5)
        spawnParticlesGuard(
          execution,
          execution.state.physics.cx,
          execution.state.physics.cy + wormRadius,
          1,
        );
    } else {
      execution.state.physics.vy += GRAVITY * 0.65 * dt; // partial gravity without thrust
    }
    execution.state.physics.vy = Math.min(execution.state.physics.vy, 400);
  }

  function applyJetpackHorizontal(execution, dt, movingL, movingR) {
    const H_THRUST = 200;
    if (movingL) {
      execution.state.physics.vx -= H_THRUST * dt;
      execution.state.physics.facing = -1;
    }
    if (movingR) {
      execution.state.physics.vx += H_THRUST * dt;
      execution.state.physics.facing = 1;
    }
    execution.state.physics.vx *= Math.exp(-1.5 * dt);
  }

  function moveJetpackWorm(execution, dt) {
    const newCx = Math.max(
      wormRadius,
      Math.min(width - wormRadius, execution.state.physics.cx + execution.state.physics.vx * dt),
    );
    const leadX = newCx + Math.sign(execution.state.physics.vx || 1) * wormRadius;
    if (!execution.state.terrain || !isSolid(execution, leadX, execution.state.physics.cy))
      execution.state.physics.cx = newCx;
    else execution.state.physics.vx = 0;
    execution.state.physics.cy += execution.state.physics.vy * dt;
    if (execution.state.physics.cy < wormRadius) {
      execution.state.physics.cy = wormRadius;
      execution.state.physics.vy = 0;
    }
  }

  function landJetpackWorm(execution) {
    if (!execution.state.terrain || execution.state.physics.vy < 0) return;
    const surY = getSurfaceAt(execution, execution.state.physics.cx);
    if (execution.state.physics.cy < surY) return;
    execution.state.physics.cy = surY;
    execution.state.physics.vy = 0;
    execution.state.physics.vx = 0;
    execution.state.physics.onGround = true;
    execution.state.isJetpackActive = false;
    playSoundGuard(execution, 'WormLanding', 0.45);
  }

  function initTurn(execution) {
    if (!execution.state.isMyTurn) return;
    const aw = execution.state.worms.find((w) => w.id === execution.state.activeWormId);
    if (!aw) return;
    execution.state.physics.cx = aw.cx;
    execution.state.physics.cy = aw.cy;
    execution.state.physics.vx = 0;
    execution.state.physics.vy = 0;
    execution.state.physics.onGround = true;
    execution.state.physics.facing = 1;
    execution.state.physics.walking = false;
    execution.state.physics.backflipping = false;
    execution.state.physics.backflipAngle = 0;
    execution.state.isPhysicsSynced = true;
    execution.state.rope = null;
    execution.state.isJetpackActive = false;
    execution.state.jetpackFuel = 0;
  }

  function canStepActiveWorm(execution) {
    // Allow physics to keep running when rope/jetpack is active (even though _shotFired=true)
    const canMoveAfterAction =
      execution.state.rope !== null ||
      execution.state.isJetpackActive ||
      execution.state.hasMovementToolUsed ||
      execution.state.isRetreating;
    return (
      execution.state.isMyTurn &&
      execution.state.isPhysicsSynced &&
      (!execution.state.hasShotFired || canMoveAfterAction) &&
      !execution.state.isAnimating
    );
  }

  function readWormPhysicsInput(execution, dt) {
    const input = {
      movingL: execution.state.keys.has('q') || execution.state.keys.has('arrowleft'),
      movingR: execution.state.keys.has('d') || execution.state.keys.has('arrowright'),
      jumpKey: execution.state.keys.has(' '),
      bfKey: execution.state.keys.has('backspace'),
    };
    if (execution.state.keys.has('z') || execution.state.keys.has('arrowup'))
      execution.state.aimAngle -= 1.8 * dt;
    if (execution.state.keys.has('s') || execution.state.keys.has('arrowdown'))
      execution.state.aimAngle += 1.8 * dt;
    return input;
  }

  function updateGroundFacing(execution, { movingL, movingR }) {
    if (!execution.state.physics.onGround) return;
    if (movingL && !movingR) execution.state.physics.facing = -1;
    if (movingR && !movingL) execution.state.physics.facing = 1;
  }

  function tryForwardHop(execution, { jumpKey }) {
    if (!jumpKey || !execution.state.physics.onGround || execution.state.physics.backflipping)
      return;
    execution.state.physics.vy = JUMP_FWD_VY;
    execution.state.physics.vx = execution.state.physics.facing * JUMP_FWD_VX;
    execution.state.physics.onGround = false;
    execution.state.physics.walking = false;
    execution.state.keys.delete(' ');
    playSoundGuard(execution, 'JUMP1', 0.5);
  }

  function tryBackflip(execution, { bfKey }) {
    if (!bfKey || !execution.state.physics.onGround || execution.state.physics.backflipping) return;
    execution.state.physics.vy = BACKFLIP_VY;
    execution.state.physics.vx = -execution.state.physics.facing * BACKFLIP_VX; // opposite = backward
    execution.state.physics.onGround = false;
    execution.state.physics.backflipping = true;
    execution.state.physics.backflipAngle = 0;
    execution.state.physics.walking = false;
    execution.state.keys.delete('backspace');
    playSoundGuard(execution, 'JUMP1', 0.5);
  }

  function stepBackflipSpin(execution, dt) {
    if (execution.state.physics.backflipping) execution.state.physics.backflipAngle -= 5 * dt; // ~286°/s — one full rotation per flight
  }

  function stepRopeHookFlight(execution, dt) {
    if (execution.state.rope?.state !== 'flying') return;
    execution.state.rope.vy += GRAVITY * dt;
    execution.state.rope.cx += execution.state.rope.vx * dt;
    execution.state.rope.cy += execution.state.rope.vy * dt;
    if (
      execution.state.terrain &&
      isSolid(execution, execution.state.rope.cx, execution.state.rope.cy)
    )
      attachRopeHook(execution);
    if (
      execution.state.rope &&
      (execution.state.rope.cx < 0 ||
        execution.state.rope.cx > width ||
        execution.state.rope.cy > execution.state.waterLevel)
    )
      execution.state.rope = null;
  }

  function attachRopeHook(execution) {
    execution.state.rope.state = 'attached';
    execution.state.rope.anchorX = execution.state.rope.cx;
    execution.state.rope.anchorY = execution.state.rope.cy;
    execution.state.rope.len = Math.hypot(
      execution.state.physics.cx - execution.state.rope.anchorX,
      execution.state.physics.cy - execution.state.rope.anchorY,
    );
    execution.state.physics.onGround = false; // launch worm off ground to start swinging
    playSoundGuard(execution, 'GRENADEIMPACT', 0.25);
  }

  function stepToolOverridePhysics(execution, dt, { movingL, movingR }) {
    const overridePhys =
      execution.state.rope?.state === 'attached' || execution.state.isJetpackActive;
    if (execution.state.rope?.state === 'attached')
      stepRopeAttached(execution, dt, movingL, movingR);
    if (execution.state.isJetpackActive) stepJetpackPhysics(execution, dt, movingL, movingR);
    return overridePhys;
  }

  function stepNormalWormPhysics(execution, dt, input) {
    applyWormGravity(execution, dt);
    walkGroundWorm(execution, dt, input);
    driftAirborneWorm(execution, dt);
    settleVerticalWorm(execution, dt);
  }

  function applyWormGravity(execution, dt) {
    if (execution.state.physics.onGround) return;
    execution.state.physics.vy += GRAVITY * dt;
    if (execution.state.physics.vy > 260 && !execution.state.physics.parachute) {
      execution.state.physics.parachute = true;
      playSoundGuard(execution, 'ParachuteOpen', 0.55);
    }
    if (execution.state.physics.parachute) {
      execution.state.physics.vy = Math.min(execution.state.physics.vy, 65); // gentle terminal velocity
      execution.state.physics.vx *= Math.exp(-1.5 * dt); // extra air resistance
    } else {
      execution.state.physics.vy = Math.min(execution.state.physics.vy, 600);
    }
  }

  function walkGroundWorm(execution, dt, { movingL, movingR }) {
    execution.state.physics.walking = false;
    if (!execution.state.physics.onGround || (!movingL && !movingR) || !execution.state.terrain)
      return;
    execution.state.physics.walking = true;
    const dir = movingL ? -1 : 1;
    const newX = Math.max(
      wormRadius,
      Math.min(width - wormRadius, execution.state.physics.cx + dir * WALK_SPD * dt),
    );
    const surY = getSurfaceAt(execution, newX);
    const step = execution.state.physics.cy - surY; // >0 = slope up, <0 = slope down
    if (walkBlockedByWorm(execution, newX) || step > 15) return;
    if (step < -18) {
      execution.state.physics.cx = newX;
      execution.state.physics.onGround = false;
      execution.state.physics.vy = 0;
      return;
    }
    execution.state.physics.cx = newX;
    execution.state.physics.cy = surY;
  }

  function walkBlockedByWorm(execution, newX) {
    for (const w of execution.state.worms) {
      if (w.id === execution.state.activeWormId || !w.alive) continue;
      const dx = newX - w.cx,
        dy = execution.state.physics.cy - w.cy;
      if (Math.abs(dx) < wormRadius * 2 && Math.abs(dy) < wormRadius * 1.5) return true;
    }
    return false;
  }

  function driftAirborneWorm(execution, dt) {
    if (execution.state.physics.onGround) return;
    execution.state.physics.vx *= Math.exp(-1.8 * dt);
    const newCx = Math.max(
      wormRadius,
      Math.min(width - wormRadius, execution.state.physics.cx + execution.state.physics.vx * dt),
    );
    const leadX = newCx + Math.sign(execution.state.physics.vx) * wormRadius * 0.8;
    if (execution.state.terrain && airWallAt(execution, leadX)) execution.state.physics.vx = 0;
    else execution.state.physics.cx = newCx;
  }

  function airWallAt(execution, leadX) {
    return (
      isSolid(execution, leadX, execution.state.physics.cy - wormRadius * 0.8) ||
      isSolid(execution, leadX, execution.state.physics.cy) ||
      isSolid(execution, leadX, execution.state.physics.cy + wormRadius * 0.5)
    );
  }

  function settleVerticalWorm(execution, dt) {
    if (execution.state.physics.onGround || !execution.state.terrain) return;
    const prevCy = execution.state.physics.cy;
    execution.state.physics.cy += execution.state.physics.vy * dt;
    const surY = getSurfaceAt(execution, execution.state.physics.cx);
    if (execution.state.physics.vy >= 0 && execution.state.physics.cy >= surY)
      tryLandActiveWorm(execution, prevCy, surY);
    if (
      execution.state.physics.vy < 0 &&
      isSolid(execution, execution.state.physics.cx, execution.state.physics.cy - wormRadius)
    )
      execution.state.physics.vy = 0;
  }

  function tryLandActiveWorm(execution, prevCy, surY) {
    if (prevCy < surY + wormRadius || execution.state.physics.cy - surY < wormRadius * 3)
      landActiveWorm(execution, surY, execution.state.physics.vy);
  }

  function landActiveWorm(execution, surY, speed) {
    execution.state.physics.cy = surY;
    execution.state.physics.vy = 0;
    execution.state.physics.vx = 0;
    execution.state.physics.onGround = true;
    execution.state.physics.backflipping = false;
    execution.state.physics.backflipAngle = 0;
    execution.state.physics.parachute = false;
    if (speed > 150) playSoundGuard(execution, 'WormLanding', 0.55);
  }

  function getTerrainIndexAt(x, y) {
    if (x < 0 || x >= width || y < 0 || y >= height) return null;
    const xi = Math.max(0, Math.min(width - 1, Math.floor(x)));
    const yi = Math.max(0, Math.min(height - 1, Math.floor(y)));
    return { xi, yi, maskIndex: yi * width + xi };
  }

  function isPointCarvedByHole(execution, x, y) {
    return execution.state.holes.some((h) => {
      const dx = x - h.cx,
        dy = y - h.cy;
      return dx * dx + dy * dy <= h.r * h.r;
    });
  }

  function isSolid(execution, x, y) {
    const pos = getTerrainIndexAt(x, y);
    if (!pos || isPointCarvedByHole(execution, x, y)) return false;
    if (execution.state.terrainMask) return execution.state.terrainMask.at(pos.maskIndex) === 1;
    return execution.state.terrain ? y >= (execution.state.terrain.at(pos.xi) ?? height) : false;
  }

  function getSurfaceAt(execution, cx) {
    if (!execution.state.terrain) return height / 2;
    const xi = Math.max(0, Math.min(width - 1, Math.round(cx)));
    let y = execution.state.terrain.at(xi) ?? height;
    if (execution.state.holes.length === 0) return Math.max(0, y - wormRadius);
    // Scan down from terrain base to find solid Y through holes
    while (y < execution.state.waterLevel) {
      if (isSolid(execution, xi, y)) return Math.max(0, y - wormRadius);
      y++;
    }
    return execution.state.waterLevel;
  }
  function stepMotion(execution, dt) {
    if (!canStepActiveWorm(execution)) return false;
    const input = readWormPhysicsInput(execution, dt);
    updateGroundFacing(execution, input);
    tryForwardHop(execution, input);
    tryBackflip(execution, input);
    stepBackflipSpin(execution, dt);
    stepRopeHookFlight(execution, dt);
    const hasOverride = stepToolOverridePhysics(execution, dt, input);
    if (!hasOverride) stepNormalWormPhysics(execution, dt, input);
    return true;
  }

  return {
    reset,
    stop,
    status,
    step: (...args) => run(stepMotion, args),
    initTurn: (...args) => run(initTurn, args),
    isSolid: (...args) => run(isSolid, args),
    getSurfaceAt: (...args) => run(getSurfaceAt, args),
  };
}
