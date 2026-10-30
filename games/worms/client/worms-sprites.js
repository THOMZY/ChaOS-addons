export function createWormsSprites({
  getState,
  getImage,
  createCanvas = () => document.createElement('canvas'),
  clock = () => Date.now(),
  isActive = () => true,
  wormRadius = 10,
}) {
  const bitmaps = new Map();
  const cancelled = Symbol('retired sprite render');
  let isStopped = false,
    revision = 0;
  function assertCurrent(state) {
    if (isStopped || revision !== state.revision || !isActive()) throw cancelled;
  }
  function readImage(state, key) {
    const image = getImage(key);
    assertCurrent(state);
    return image;
  }
  function readClock(state) {
    const value = clock();
    assertCurrent(state);
    return value;
  }
  function release(canvas) {
    canvas.width = 0;
    canvas.height = 0;
  }
  function clear() {
    revision++;
    for (const entry of bitmaps.values()) release(entry.canvas);
    bitmaps.clear();
  }
  function stop() {
    if (isStopped) return;
    isStopped = true;
    clear();
  }
  function status() {
    return { isStopped, bitmaps: bitmaps.size };
  }
  function draw(ctx, now, dt) {
    if (isStopped || !isActive()) return;
    const currentRevision = revision;
    const snapshot = getState();
    const state = { ...snapshot, revision: currentRevision };
    try {
      assertCurrent(state);
      drawWorms(state, ctx, now, dt);
    } catch (error) {
      if (error !== cancelled) throw error;
    }
  }
  function wormSpriteCacheEntry(
    state,
    wormId,
    image,
    spriteKey,
    frame,
    frameHeight,
    width,
    height,
  ) {
    const cacheKey = spriteKey + ':' + frame;
    let entry = bitmaps.get(wormId);
    if (!entry) {
      const canvas = createCanvas();
      try {
        assertCurrent(state);
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        assertCurrent(state);
        if (!context) {
          release(canvas);
          return null;
        }
        entry = { canvas, context };
        bitmaps.set(wormId, entry);
      } catch (error) {
        release(canvas);
        throw error;
      }
    }
    if (
      entry.cacheKey === cacheKey &&
      entry.image === image &&
      entry.frameHeight === frameHeight &&
      entry.width === width &&
      entry.height === height
    )
      return entry;
    if (entry.canvas.width !== width || entry.canvas.height !== height) {
      entry.canvas.width = width;
      entry.canvas.height = height;
    }
    entry.context.clearRect(0, 0, width, height);
    entry.context.drawImage(
      image,
      0,
      frame * frameHeight,
      image.naturalWidth,
      frameHeight,
      0,
      0,
      width,
      height,
    );
    Object.assign(entry, { cacheKey, image, frameHeight, width, height });
    return entry;
  }
  function drawWorms(state, ctx, now, dt) {
    for (const w of state.worms) {
      if (!drawDeadWorm(state, ctx, w, now)) drawLiveWorm(state, ctx, w, now, dt);
    }
  }

  function drawDeadWorm(state, ctx, w, now) {
    if (w.alive) return false;
    const dying = state.dying.get(w.id);
    if (dying && drawDyingWorm(state, ctx, w, dying, now)) return true;
    drawGrave(state, ctx, w);
    return true;
  }

  function drawDyingWorm(state, ctx, w, dying, now) {
    const dieImg = readImage(state, 'wdie');
    if (!(dieImg?.complete && dieImg.naturalWidth > 0)) return false;
    const DFRAMES = 60,
      DMS = 5;
    const dframe = Math.min(DFRAMES - 1, Math.floor((now - dying.startMs) / DMS));
    const dfh = Math.floor(dieImg.naturalHeight / DFRAMES);
    const dsc = (wormRadius * 1.9) / dieImg.naturalWidth;
    const ddW = Math.ceil(dieImg.naturalWidth * dsc);
    const ddH = Math.ceil(dfh * dsc);
    ctx.save();
    if (w._facing < 0) {
      ctx.translate(w.cx, w.cy);
      ctx.scale(-1, 1);
      ctx.translate(-w.cx, -w.cy);
    }
    ctx.drawImage(
      dieImg,
      0,
      dframe * dfh,
      dieImg.naturalWidth,
      dfh,
      w.cx - ddW / 2,
      w.cy - ddH,
      ddW,
      ddH,
    );
    ctx.restore();
    if (now - dying.startMs > DFRAMES * DMS + 500) state.dying.delete(w.id);
    return true;
  }

  function drawLiveWorm(state, ctx, w, now, dt) {
    const pose = wormDrawPose(state, w, dt);
    drawWormChar(
      state,
      ctx,
      { ...w, cx: pose.cx, cy: pose.cy },
      pose.facing,
      pose.active,
      pose.falling,
      pose.walking,
      pose.backflipAngle,
      pose.jumping,
      now,
    );
    if (pose.active) drawBounceArrow(state, ctx, pose.cx, pose.cy, now);
  }

  function wormDrawPose(state, w, dt) {
    const active = w.id === state.activeWormId;
    const synced = active && state.isPhysicsSynced;
    const bump = state.bumps.get(w.id);
    let cx = synced ? state.physics.cx : w.cx;
    let cy = synced ? state.physics.cy : w.cy;
    if (bump) {
      bump.vx *= Math.exp(-4 * dt);
      bump.vy += 350 * dt;
      bump.dx += bump.vx * dt;
      bump.dy += bump.vy * dt;
      if (bump.vy > 0 && Math.abs(bump.dx) < 1 && bump.dy > 0) state.bumps.delete(w.id);
      else {
        cx += bump.dx;
        cy += bump.dy;
      }
    }
    return {
      active,
      cx,
      cy,
      facing: synced ? state.physics.facing : (w._facing ?? 1),
      falling: synced && !state.physics.onGround && state.physics.vy > 80,
      jumping: synced && !state.physics.onGround && state.physics.vy < 0,
      walking: synced && state.physics.walking,
      backflipAngle: synced ? state.physics.backflipAngle : 0,
    };
  }

  function drawWormChar(
    state,
    ctx,
    w,
    facing,
    isActive,
    isFalling = false,
    isWalking = false,
    backflipAngle = 0,
    isJumping = false,
    now = 0,
  ) {
    const anim = wormSpriteAnim(
      state,
      isActive,
      isFalling,
      isWalking,
      backflipAngle,
      isJumping,
      w.hp,
    );
    const drawn = drawWormSprite(
      state,
      ctx,
      w,
      facing,
      isActive,
      isFalling,
      backflipAngle,
      anim,
      now,
    );
    if (!drawn) drawProceduralWorm(ctx, w, facing, isActive);
    drawWormNameHp(ctx, w, isActive);
  }

  function wormSpriteAnim(state, isActive, isFalling, isWalking, backflipAngle, isJumping, hp) {
    if (backflipAngle !== 0) return { key: 'wbackflp', frames: 22, ms: 50, frameY: 0 };
    if (isJumping) return { key: 'wflyup', frames: 2, ms: 100, frameY: 0 };
    if (isFalling) return { key: 'wfall', frames: 2, ms: 100, frameY: 0 };
    if (isWalking) return { key: 'wwalk', frames: 15, ms: 50, frameY: 0 };
    if (isActive && state.weaponAnimation) {
      return {
        key: state.weaponAnimation.img,
        frames: state.weaponAnimation.frames,
        ms: state.weaponAnimation.ms,
        frameY: state.weaponAnimation.frameY ?? 0,
      };
    }
    if (hp < 30) return { key: 'wbrth2', frames: 13, ms: 150, frameY: 0 };
    return { key: 'wselbak', frames: 12, ms: 200, frameY: 0 };
  }

  function drawWormSprite(state, ctx, w, facing, isActive, isFalling, backflipAngle, anim, now) {
    const img = readImage(state, anim.key) || readImage(state, 'wselbak');
    if (!(img?.complete && img.naturalWidth > 0)) return false;
    const frame = wormSpriteFrame(state, anim, isActive, now);
    const frameH = Math.floor(img.naturalHeight / anim.frames);
    const tgtH = wormRadius * 2 + 2; // 22px — consistent worm body height for all sprites
    const sc = tgtH / frameH;
    const dW = Math.ceil(img.naturalWidth * sc);
    const dH = tgtH;
    const entry = wormSpriteCacheEntry(state, w.id, img, anim.key, frame, frameH, dW, dH);
    if (!entry) return false;
    paintWormSprite(ctx, w, facing, isActive, isFalling, backflipAngle, entry, dW, dH);
    return true;
  }

  function wormSpriteFrame(state, anim, isActive, now) {
    const t = now || readClock(state);
    const phase = isActive && state.weaponAnimation ? state.weaponAnimation.phase : null;
    if (phase === 'aim') {
      // Map aim angle to sprite frame: -π/2 (up) → last frame, +π/2 (down) → frame 0
      return Math.max(
        0,
        Math.min(
          anim.frames - 1,
          Math.round(((-state.aimAngle + Math.PI / 2) / Math.PI) * (anim.frames - 1)),
        ),
      );
    }
    if (anim.frames > 1 && isActive) return Math.floor(t / anim.ms) % anim.frames;
    return 0;
  }

  function paintWormSprite(ctx, w, facing, isActive, isFalling, backflipAngle, entry, dW, dH) {
    ctx.save();
    ctx.translate(w.cx, w.cy);
    if (backflipAngle !== 0) ctx.rotate(backflipAngle);
    if (isActive) {
      ctx.shadowBlur = 14;
      ctx.shadowColor = '#fff';
    } else {
      ctx.shadowBlur = 5;
      ctx.shadowColor = w.color ?? '#44cc44';
    }
    ctx.scale(-facing, 1); // wselbak / most sprites face left — flip to match facing
    if (!backflipAngle && isFalling) ctx.rotate(facing * 0.38);
    ctx.drawImage(entry.canvas, -dW / 2, wormRadius - dH);
    ctx.restore();
  }

  function drawProceduralWorm(ctx, w, facing, isActive) {
    const { cx, cy, color } = w;
    ctx.save();
    ctx.translate(cx, cy);
    if (isActive) {
      ctx.shadowBlur = 12;
      ctx.shadowColor = '#ffffff';
    }
    ctx.save();
    ctx.scale(facing, 1);
    ctx.beginPath();
    ctx.ellipse(0, 3, 6.5, 9, 0, 0, Math.PI * 2);
    ctx.fillStyle = color ?? '#44cc44';
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.65)';
    ctx.lineWidth = 1.8;
    ctx.stroke();
    for (let sy = -2; sy <= 8; sy += 4) {
      ctx.beginPath();
      ctx.ellipse(0, sy, 5.5, 1.2, 0, Math.PI * 0.05, Math.PI * 0.95);
      ctx.strokeStyle = 'rgba(0,0,0,0.2)';
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.arc(1, -7, 7.5, 0, Math.PI * 2);
    ctx.fillStyle = color ?? '#44cc44';
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.65)';
    ctx.lineWidth = 1.8;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(5, -8, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(5.8, -8, 2.2, 0, Math.PI * 2);
    ctx.fillStyle = '#1166cc';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(6.2, -8, 1.1, 0, Math.PI * 2);
    ctx.fillStyle = '#000';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(5.5, -9, 0.8, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(2, -13.5);
    ctx.quadraticCurveTo(5, -14.5, 9, -12.5);
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.lineWidth = 1.8;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(4, -4.5, 2, 0.2, Math.PI - 0.2);
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.fillStyle = '#1a1a2a';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.ellipse(1, -16, 7.5, 2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.rect(-3.5, -26, 9, 11);
    ctx.fillStyle = '#1a1a2a';
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#cc2222';
    ctx.fillRect(-3.5, -17, 9, 2.5);
    ctx.restore();
    ctx.restore();
  }

  function drawWormNameHp(ctx, w, isActive) {
    const { cx, cy, name, hp } = w;
    ctx.save();
    ctx.translate(cx, cy);
    drawWormHpBar(ctx, hp);
    if (isActive) drawActiveWormLabel(ctx, name, hp);
    else drawInactiveWormLabel(ctx, name);
    ctx.restore();
  }

  function drawWormHpBar(ctx, hp) {
    const hpFrac = hp / 80;
    const bW = 26,
      bH = 5;
    const bx = -bW / 2,
      by = -22;
    ctx.fillStyle = '#000';
    ctx.fillRect(bx - 1, by - 1, bW + 2, bH + 2);
    ctx.fillStyle = hpFrac > 0.5 ? '#22dd22' : hpFrac > 0.25 ? '#ffcc00' : '#ff2222';
    ctx.fillRect(bx, by, bW * hpFrac, bH);
  }

  function drawActiveWormLabel(ctx, name, hp) {
    const bH = 5,
      by = -22;
    ctx.shadowBlur = 0;
    ctx.font = 'bold 9px monospace';
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.strokeStyle = 'rgba(0,0,0,0.9)';
    ctx.lineWidth = 2.5;
    ctx.strokeText(name ?? '?', 0, by - 3);
    ctx.fillText(name ?? '?', 0, by - 3);
    ctx.font = 'bold 8px monospace';
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 1.5;
    const hpTxt = `${hp}`;
    ctx.strokeText(hpTxt, 0, by + bH - 0.5);
    ctx.fillText(hpTxt, 0, by + bH - 0.5);
    ctx.textAlign = 'left';
  }

  function drawInactiveWormLabel(ctx, name) {
    const by = -22;
    ctx.shadowBlur = 0;
    ctx.font = '8px monospace';
    ctx.fillStyle = 'rgba(220,220,220,0.8)';
    ctx.textAlign = 'center';
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.lineWidth = 2;
    ctx.strokeText(name ?? '?', 0, by - 2);
    ctx.fillText(name ?? '?', 0, by - 2);
    ctx.textAlign = 'left';
  }

  function drawBounceArrow(state, ctx, cx, cy, now) {
    const img = readImage(state, 'arrowdnb');
    if (img?.complete && img.naturalWidth > 0) {
      const AF = 30,
        AMS = 10;
      const af = Math.floor(now / AMS) % AF;
      const afh = Math.floor(img.naturalHeight / AF);
      const asc = 20 / Math.max(img.naturalWidth, 1);
      const aw2 = img.naturalWidth * asc,
        ah2 = afh * asc;
      ctx.drawImage(
        img,
        0,
        af * afh,
        img.naturalWidth,
        afh,
        cx - aw2 / 2,
        cy - wormRadius - ah2 - 28,
        aw2,
        ah2,
      );
    } else {
      // Procedural arrow fallback
      const bob = Math.sin(now / 200) * 3;
      const ay = cy - wormRadius - 26 + bob;
      ctx.save();
      ctx.fillStyle = '#ffff00';
      ctx.beginPath();
      ctx.moveTo(cx, ay + 10);
      ctx.lineTo(cx - 6, ay);
      ctx.lineTo(cx + 6, ay);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  function drawGrave(state, ctx, w) {
    const { cx, cy } = w;
    const graveKeys = ['grave1', 'grave2', 'grave3', 'grave4', 'grave5', 'grave6'];
    const idx = w.id ? w.id.charCodeAt(0) % 6 : 0;
    const img = readImage(state, graveKeys.at(idx));
    if (img?.complete && img.naturalWidth > 0) {
      // Graves are sprite sheets: 20 frames stacked vertically
      // Show the last frame (fully revealed gravestone)
      const GRAVE_FRAMES = 20;
      const frameH = Math.floor(img.naturalHeight / GRAVE_FRAMES);
      const lastFrameY = (GRAVE_FRAMES - 1) * frameH;
      const targetH = 34;
      const scale = targetH / Math.max(frameH, 1);
      const gw = Math.ceil(img.naturalWidth * scale);
      const gh = Math.ceil(frameH * scale);
      ctx.drawImage(img, 0, lastFrameY, img.naturalWidth, frameH, cx - gw / 2, cy - gh, gw, gh);
    } else {
      ctx.fillStyle = '#888';
      ctx.fillRect(cx - 2, cy - 20, 4, 16);
      ctx.fillRect(cx - 8, cy - 15, 16, 4);
    }
  }
  return { draw, clear, stop, status };
}
