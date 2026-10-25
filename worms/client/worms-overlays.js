export function createWormsOverlays({
  getState,
  getImage,
  getWeaponDefinition,
  playSound,
  translate,
  clock = () => Date.now(),
  now = () => performance.now(),
  isActive = () => true,
  width = 960,
  height = 480,
  wormRadius = 10,
  targetedWeapons,
}) {
  let isStopped = false,
    revision = 0;
  const cancelled = Symbol('retired overlay render');
  function assertCurrent(state) {
    if (isStopped || revision !== state.revision || !isActive()) throw cancelled;
  }
  function readImage(state, key) {
    const image = getImage(key);
    assertCurrent(state);
    return image;
  }
  function readWeaponDefinition(state, key) {
    const definition = getWeaponDefinition(key);
    assertCurrent(state);
    return definition;
  }
  function readClock(state) {
    const value = clock();
    assertCurrent(state);
    return value;
  }
  function readNow(state) {
    const value = now();
    assertCurrent(state);
    return value;
  }
  function translateLabel(state, key) {
    const label = translate(key);
    assertCurrent(state);
    return label;
  }
  function playLandingSound(state, ...args) {
    playSound(...args);
    assertCurrent(state);
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
      snapshot = getState(),
      state = { ...snapshot, revision: currentRevision };
    try {
      assertCurrent(state);
      return action(state, ...args);
    } catch (error) {
      if (error !== cancelled) throw error;
    }
  }
  function getActiveWormPosition(state) {
    const active = state.worms.find((w) => w.id === state.activeWormId);
    return {
      cx: state.isPhysicsSynced ? state.physics.cx : (active?.cx ?? state.physics.cx),
      cy: state.isPhysicsSynced ? state.physics.cy : (active?.cy ?? state.physics.cy),
    };
  }

  function drawRope(state, ctx) {
    if (!state.rope || !state.isMyTurn) return;
    const { cx: wCx, cy: wCy } = getActiveWormPosition(state);
    const tipCx = state.rope.state === 'attached' ? state.rope.anchorX : state.rope.cx;
    const tipCy = state.rope.state === 'attached' ? state.rope.anchorY : state.rope.cy;
    ctx.save();
    ctx.strokeStyle = '#aaddaa';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(wCx, wCy);
    ctx.lineTo(tipCx, tipCy);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(tipCx, tipCy, 4, 0, Math.PI * 2);
    ctx.fillStyle = state.rope.state === 'attached' ? '#ffdd44' : '#aaddaa';
    ctx.fill();
    ctx.restore();
  }

  function drawJetpackFuel(state, ctx) {
    if (!state.isJetpackActive || !state.isMyTurn) return;
    const { cx: wCx, cy: wCy } = getActiveWormPosition(state);
    const barW = 30,
      barH = 4;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(wCx - barW / 2, wCy + wormRadius + 5, barW, barH);
    ctx.fillStyle = `hsl(${state.jetpackFuel * 120},90%,55%)`;
    ctx.fillRect(wCx - barW / 2, wCy + wormRadius + 5, barW * state.jetpackFuel, barH);
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 1;
    ctx.strokeRect(wCx - barW / 2, wCy + wormRadius + 5, barW, barH);
  }

  function drawAimAndTargeting(state, ctx, now) {
    if (!state.isMyTurn || state.hasShotFired || state.isAnimating) return;
    drawAimCrosshair(state, ctx, now);
    if (targetedWeapons.has(state.selectedWeapon)) drawAirstrikeTargeting(state, ctx);
  }

  function drawAirstrikeTargeting(state, ctx) {
    const targetX = Math.max(24, Math.min(width - 24, state.mouseX));
    ctx.save();
    ctx.setLineDash([6, 5]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(255,80,80,0.75)';
    for (const ox of [-30, 0, 30]) {
      ctx.beginPath();
      ctx.moveTo(targetX + ox, 0);
      ctx.lineTo(targetX + ox, height);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.restore();
  }

  function drawCratesFrame(state, ctx, dt, now) {
    for (const crate of state.crates) {
      updateFallingCrate(state, crate, dt);
      drawCrate(
        state,
        ctx,
        crate.cx,
        crate.landed ? crate.cy : crate.fallingCy,
        crate.type,
        crate.weapon,
        !crate.landed,
        now,
      );
    }
  }

  function updateFallingCrate(state, crate, dt) {
    if (crate.landed) return;
    crate.fallingCy = (crate.fallingCy ?? -30) + 38 * dt;
    if (crate.fallingCy < crate.cy) return;
    crate.fallingCy = crate.cy;
    crate.landed = true;
    playLandingSound(state, 'GRENADEIMPACT', 0.35);
  }

  function drawDynamites(state, ctx) {
    for (const dyn of state.dynamites) drawDynamite(state, ctx, dyn);
  }

  function drawDynamite(state, ctx, dyn) {
    const elapsedS = (readNow(state) - dyn.placedAt) / 1000;
    const remaining = Math.max(0, dyn.fuseMs / 1000 - elapsedS);
    const flash = remaining < 2 && Math.floor(elapsedS * 5) % 2 === 0;
    ctx.save();
    ctx.fillStyle = flash ? '#ff5555' : '#cc2222';
    ctx.fillRect(dyn.cx - 4, dyn.cy - 10, 8, 16);
    ctx.fillStyle = '#333';
    ctx.fillRect(dyn.cx - 2, dyn.cy - 13, 4, 4);
    if (Math.floor(elapsedS * 8) % 2 === 0) {
      ctx.fillStyle = '#ffdd00';
      ctx.beginPath();
      ctx.arc(dyn.cx, dyn.cy - 13, 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 9px monospace';
    ctx.textAlign = 'center';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.strokeText(remaining.toFixed(1), dyn.cx, dyn.cy - 17);
    ctx.fillText(remaining.toFixed(1), dyn.cx, dyn.cy - 17);
    ctx.restore();
  }

  function drawMines(state, ctx) {
    for (const mine of state.mines) drawMine(ctx, mine);
  }

  function drawMine(ctx, mine) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(mine.cx, mine.cy, 8, 0, Math.PI * 2);
    ctx.fillStyle = '#556655';
    ctx.fill();
    ctx.strokeStyle = '#cc3300';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#ff4444';
    ctx.font = 'bold 8px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('!', mine.cx, mine.cy + 3);
    ctx.restore();
  }

  function drawTeleportPreview(state, ctx) {
    if (
      state.selectedWeapon !== 'teleport' ||
      !state.isMyTurn ||
      state.hasShotFired ||
      state.isAnimating
    )
      return;
    ctx.save();
    ctx.strokeStyle = '#aa44ff';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.arc(state.mouseX, state.mouseY, wormRadius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    const s = 14;
    ctx.beginPath();
    ctx.moveTo(state.mouseX - s, state.mouseY);
    ctx.lineTo(state.mouseX + s, state.mouseY);
    ctx.moveTo(state.mouseX, state.mouseY - s);
    ctx.lineTo(state.mouseX, state.mouseY + s);
    ctx.stroke();
    ctx.restore();
  }

  function drawParachute(state, ctx) {
    if (!state.isMyTurn || !state.physics.parachute || state.physics.onGround) return;
    const aw = state.worms.find((w) => w.id === state.activeWormId);
    if (!aw) return;
    const px = state.physics.cx,
      py = state.physics.cy;
    ctx.save();
    ctx.strokeStyle = '#fff';
    ctx.fillStyle = 'rgba(220,220,255,0.75)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(px, py - wormRadius - 22, 18, Math.PI, 0);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = 'rgba(200,200,200,0.8)';
    ctx.lineWidth = 0.8;
    for (const [ox, oy] of [
      [-18, 0],
      [0, 0],
      [18, 0],
      [-10, -16],
      [10, -16],
    ]) {
      ctx.beginPath();
      ctx.moveTo(px + ox, py - wormRadius - 22 + oy);
      ctx.lineTo(px, py - wormRadius);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawChargeBar(state, ctx) {
    if (state.chargeStart === null || !state.isMyTurn || state.hasShotFired) return;
    const aw = state.worms.find((w) => w.id === state.activeWormId);
    if (!aw) return;
    const powerLabel = translateLabel(state, 'games.worms.power');
    const chargePct = Math.min(1, (readClock(state) - state.chargeStart) / 1500);
    const barW = 90,
      barH = 10;
    const wCx = state.isPhysicsSynced ? state.physics.cx : aw.cx;
    const wCy = state.isPhysicsSynced ? state.physics.cy : aw.cy;
    const bx = wCx - barW / 2,
      by = wCy - wormRadius - 26;
    ctx.fillStyle = '#000';
    ctx.fillRect(bx - 1, by - 1, barW + 2, barH + 2);
    ctx.fillStyle = chargePct < 0.5 ? '#44ee44' : chargePct < 0.8 ? '#ffcc00' : '#ff4400';
    ctx.fillRect(bx, by, barW * chargePct, barH);
    ctx.strokeStyle = '#888';
    ctx.lineWidth = 1;
    ctx.strokeRect(bx, by, barW, barH);
    ctx.font = 'bold 8px monospace';
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.fillText(`${powerLabel} ${Math.round(chargePct * 100)}%`, wCx, by - 3);
    ctx.textAlign = 'left';
  }

  function drawAimCrosshair(state, ctx, now) {
    const aw = state.worms.find((w) => w.id === state.activeWormId);
    if (!aw) return;
    const wCx = state.isPhysicsSynced ? state.physics.cx : aw.cx;
    const wCy = state.isPhysicsSynced ? state.physics.cy : aw.cy;
    // Dashed aim line
    const len = 44;
    const tx = wCx + Math.cos(state.aimAngle) * len;
    const ty = wCy + Math.sin(state.aimAngle) * len;
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(wCx, wCy);
    ctx.lineTo(tx, ty);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    // Animated crosshair sprite (crshairr — 32 frames, 50ms)
    const chImg = readImage(state, 'crshairr');
    if (chImg?.complete && chImg.naturalWidth > 0) {
      const CF = 32,
        CMS = 50;
      const cf = Math.floor(now / CMS) % CF;
      const cfh = Math.floor(chImg.naturalHeight / CF);
      const csz = 24;
      ctx.drawImage(
        chImg,
        0,
        cf * cfh,
        chImg.naturalWidth,
        cfh,
        tx - csz / 2,
        ty - csz / 2,
        csz,
        csz,
      );
    } else {
      ctx.beginPath();
      ctx.arc(tx, ty, 4, 0, Math.PI * 2);
      ctx.fillStyle = readWeaponDefinition(state, state.selectedWeapon)?.color ?? '#ff7700';
      ctx.fill();
    }
  }

  function drawCrate(state, ctx, cx, cy, type, weapon, falling, now) {
    const sz = 14;
    ctx.save();
    try {
      // Parachute when falling
      if (falling) {
        ctx.strokeStyle = '#ddd';
        ctx.fillStyle = 'rgba(200,200,255,0.7)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(cx, cy - sz - 14, 12, Math.PI, 0);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        // Cords
        ctx.strokeStyle = 'rgba(180,180,180,0.8)';
        ctx.lineWidth = 0.7;
        [
          [-12, 0],
          [0, 0],
          [12, 0],
        ].forEach(([ox]) => {
          ctx.beginPath();
          ctx.moveTo(cx + ox, cy - sz - 14);
          ctx.lineTo(cx, cy - sz / 2);
          ctx.stroke();
        });
      }
      // Crate box
      const col = type === 'health' ? '#e8e8e8' : '#8b6914';
      ctx.fillStyle = col;
      ctx.strokeStyle = '#222';
      ctx.lineWidth = 1.5;
      ctx.fillRect(cx - sz / 2, cy - sz, sz, sz);
      ctx.strokeRect(cx - sz / 2, cy - sz, sz, sz);
      // Cross straps
      ctx.strokeStyle = type === 'health' ? '#888' : '#5a4010';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx, cy - sz);
      ctx.lineTo(cx, cy);
      ctx.moveTo(cx - sz / 2, cy - sz / 2);
      ctx.lineTo(cx + sz / 2, cy - sz / 2);
      ctx.stroke();
      if (type === 'health') {
        ctx.strokeStyle = '#cc0000';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(cx, cy - sz + 3);
        ctx.lineTo(cx, cy - 3);
        ctx.moveTo(cx - sz / 2 + 3, cy - sz / 2);
        ctx.lineTo(cx + sz / 2 - 3, cy - sz / 2);
        ctx.stroke();
      } else if (weapon) {
        const icon = readWeaponDefinition(state, weapon)?.icon ?? '?';
        ctx.font = 'bold 7px monospace';
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.fillText(icon, cx, cy - sz / 2 + 3);
        ctx.textAlign = 'left';
      }
      // Pulse glow when landed
      if (!falling) {
        const pulse = 0.3 + 0.2 * Math.sin(now / 400);
        ctx.strokeStyle =
          type === 'health' ? `rgba(255,80,80,${pulse})` : `rgba(255,200,50,${pulse})`;
        ctx.lineWidth = 2;
        ctx.strokeRect(cx - sz / 2 - 2, cy - sz - 2, sz + 4, sz + 4);
      }
    } finally {
      ctx.restore();
    }
  }
  return {
    reset,
    stop,
    status,
    drawRope: (...args) => run(drawRope, args),
    drawJetpackFuel: (...args) => run(drawJetpackFuel, args),
    drawAimAndTargeting: (...args) => run(drawAimAndTargeting, args),
    drawCratesFrame: (...args) => run(drawCratesFrame, args),
    drawDynamites: (...args) => run(drawDynamites, args),
    drawMines: (...args) => run(drawMines, args),
    drawTeleportPreview: (...args) => run(drawTeleportPreview, args),
    drawParachute: (...args) => run(drawParachute, args),
    drawChargeBar: (...args) => run(drawChargeBar, args),
  };
}
