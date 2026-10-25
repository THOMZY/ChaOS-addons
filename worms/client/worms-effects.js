export function createWormsEffects({
  getState,
  getImage,
  getWeaponDefinition,
  clock = () => Date.now(),
  randomUnit,
  isActive = () => true,
}) {
  let explosions = [],
    particles = [],
    damageLabels = [],
    isStopped = false,
    revision = 0;
  const cancelled = Symbol('retired effect render');
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
    if (definition) return definition;
    const fallback = getWeaponDefinition('bazooka');
    assertCurrent(state);
    return fallback;
  }
  function readClock(state) {
    const value = clock();
    assertCurrent(state);
    return value;
  }
  function readRandom(state) {
    const value = randomUnit();
    assertCurrent(state);
    return value;
  }
  function reset() {
    revision++;
    explosions = [];
    particles = [];
    damageLabels = [];
  }
  function stop() {
    if (isStopped) return;
    isStopped = true;
    reset();
  }
  function status() {
    return {
      isStopped,
      explosions: explosions.length,
      particles: particles.length,
      damageLabels: damageLabels.length,
    };
  }
  function addExplosion(explosion) {
    if (!isStopped && isActive()) explosions.push(explosion);
  }
  function addDamageLabel(label) {
    if (!isStopped && isActive()) damageLabels.push(label);
  }
  function run(action, args, hasState = true) {
    if (isStopped || !isActive()) return;
    const currentRevision = revision,
      snapshot = getState(),
      state = { ...snapshot, revision: currentRevision };
    try {
      assertCurrent(state);
      return hasState ? action(state, ...args) : action(...args);
    } catch (error) {
      if (error !== cancelled) throw error;
    }
  }
  function getProjectileSpriteKey(weapon) {
    switch (weapon) {
      case 'bazooka':
        return 'missile';
      case 'hand_grenade':
      case 'cluster_bomb':
      case 'mortar':
        return 'grenade';
      case 'holy_grenade':
      case 'banana_bomb':
        return 'hgrenade';
      case 'dynamite':
        return 'dynamite';
      default:
        return null;
    }
  }

  function drawProjectiles(state, ctx, dt) {
    const PROJ_PTS_PER_SEC = 20;
    for (const proj of state.projectiles) {
      if (proj.done) continue;
      advanceProjectileFrame(proj, dt, PROJ_PTS_PER_SEC);
      drawProjectileTrail(state, ctx, proj);
      drawProjectileHead(state, ctx, proj);
    }
  }

  function advanceProjectileFrame(proj, dt, ptsPerSec) {
    proj.fidx = (proj.fidx ?? 0) + dt * ptsPerSec;
    proj.idx = Math.min(proj.trajectory.length - 1, Math.floor(proj.fidx));
    if (proj.idx >= proj.trajectory.length - 1) proj.done = true;
  }

  function drawProjectileTrail(state, ctx, proj) {
    const pw = proj.weapon ?? state.selectedWeapon;
    const wdef = readWeaponDefinition(state, pw);
    ctx.lineWidth = 4;
    ctx.strokeStyle = wdef.trailColor;
    ctx.beginPath();
    let drawn = 0;
    for (let k = proj.idx; k >= 0 && drawn < 14; k -= 2, drawn++) {
      const pt = proj.trajectory.at(k);
      if (!pt) continue;
      if (drawn === 0) ctx.moveTo(pt.cx, pt.cy);
      else ctx.lineTo(pt.cx, pt.cy);
    }
    ctx.stroke();
  }

  function drawProjectileHead(state, ctx, proj) {
    const head = proj.trajectory.at(proj.idx);
    const prev = proj.idx > 0 ? (proj.trajectory.at(proj.idx - 1) ?? head) : head;
    if (!head || !prev) return;
    const pw = proj.weapon ?? state.selectedWeapon;
    const spriteKey = getProjectileSpriteKey(pw);
    const img = readImage(state, spriteKey);
    if (img?.complete && img.naturalWidth > 0)
      drawProjectileSprite(state, ctx, img, spriteKey, head, prev);
    else drawProjectileFallback(state, ctx, head, pw);
  }

  function drawProjectileSprite(state, ctx, img, spriteKey, head, prev) {
    const angle = Math.atan2(head.cy - prev.cy, head.cx - prev.cx);
    const fCount = spriteKey === 'dynamite' ? 129 : 32;
    const frameH = Math.floor(img.naturalHeight / fCount);
    const frame =
      spriteKey === 'missile'
        ? Math.round((((angle + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2)) * 32) % 32
        : Math.floor(readClock(state) / 50) % fCount;
    const scale = 16 / Math.max(img.naturalWidth, frameH);
    const pW = img.naturalWidth * scale,
      pH = frameH * scale;
    ctx.save();
    ctx.translate(head.cx, head.cy);
    ctx.drawImage(img, 0, frame * frameH, img.naturalWidth, frameH, -pW / 2, -pH / 2, pW, pH);
    ctx.restore();
  }

  function drawProjectileFallback(state, ctx, head, weapon) {
    const wdef = readWeaponDefinition(state, weapon);
    ctx.beginPath();
    ctx.arc(head.cx, head.cy, 10, 0, Math.PI * 2);
    ctx.fillStyle = wdef.color;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(head.cx, head.cy, 10, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  function drawExplosions(ctx, now) {
    explosions = explosions.filter((ex) => drawExplosion(ctx, ex, now));
  }

  function drawExplosion(ctx, ex, now) {
    const t = (now - ex.startMs) / ex.durationMs;
    if (t >= 1) return false;
    const maxR = ex.r;
    const curR = maxR * Math.min(1, t * 3);
    const alpha = t < 0.4 ? 1 : 1 - (t - 0.4) / 0.6;
    const ringR = maxR * (0.8 + t * 0.8);
    ctx.beginPath();
    ctx.arc(ex.cx, ex.cy, ringR, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(180,100,30,${alpha * 0.3})`;
    ctx.lineWidth = 5 * (1 - t);
    ctx.stroke();
    const fg = ctx.createRadialGradient(ex.cx, ex.cy, 0, ex.cx, ex.cy, curR);
    fg.addColorStop(0, `rgba(255,255,200,${alpha})`);
    fg.addColorStop(0.25, `rgba(255,200,50,${alpha * 0.95})`);
    fg.addColorStop(0.55, `rgba(255,100,10,${alpha * 0.7})`);
    fg.addColorStop(0.8, `rgba(150,40,0,${alpha * 0.4})`);
    fg.addColorStop(1, `rgba(80,20,0,0)`);
    ctx.beginPath();
    ctx.arc(ex.cx, ex.cy, curR, 0, Math.PI * 2);
    ctx.fillStyle = fg;
    ctx.fill();
    return true;
  }

  function drawParticles(ctx, dt) {
    particles = particles.filter((p) => drawParticle(ctx, p, dt));
  }

  function drawParticle(ctx, p, dt) {
    p.cx += p.vx * dt;
    p.cy += p.vy * dt;
    p.vy += 220 * dt;
    p.alpha -= 1.8 * dt;
    if (p.alpha <= 0) return false;
    ctx.beginPath();
    ctx.arc(p.cx, p.cy, p.r, 0, Math.PI * 2);
    ctx.fillStyle = p.color.replace('1)', `${p.alpha.toFixed(2)})`);
    ctx.fill();
    return true;
  }

  function drawDamageLabels(ctx) {
    for (const lb of damageLabels) {
      if (lb.alpha <= 0) continue;
      ctx.globalAlpha = lb.alpha;
      ctx.font = 'bold 15px monospace';
      ctx.fillStyle = lb.killed ? '#ff4400' : '#ffee00';
      ctx.textAlign = 'center';
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.lineWidth = 3;
      ctx.strokeText(lb.text, lb.cx, lb.cy);
      ctx.fillText(lb.text, lb.cx, lb.cy);
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';
  }

  function drawFuseCountdowns(state, ctx, now) {
    for (const proj of state.projectiles) {
      if (proj.done || proj.fuseMs == null) continue;
      const timeLeft = projectileFuseSeconds(proj, now);
      if (timeLeft <= 0) continue;
      const head = proj.trajectory.at(proj.idx) ?? proj.trajectory.at(-1);
      if (head) drawFuseCountdown(ctx, head, timeLeft);
    }
  }

  function projectileFuseSeconds(proj, now) {
    const elapsed = (now - (proj.startMs ?? now)) / 1000;
    return Math.ceil(Math.max(0, proj.fuseMs / 1000 - elapsed));
  }

  function drawFuseCountdown(ctx, head, timeLeft) {
    ctx.save();
    ctx.font = `bold ${10 + timeLeft * 3}px monospace`;
    ctx.textAlign = 'center';
    ctx.strokeStyle = 'rgba(0,0,0,0.9)';
    ctx.lineWidth = 3;
    ctx.fillStyle = timeLeft === 1 ? '#ff4400' : timeLeft === 2 ? '#ffcc00' : '#ffffff';
    ctx.strokeText(String(timeLeft), head.cx, head.cy - 14);
    ctx.fillText(String(timeLeft), head.cx, head.cy - 14);
    ctx.restore();
  }

  function tickDamageLabels(dt) {
    for (const lb of damageLabels) {
      lb.cy -= 30 * dt;
      lb.alpha -= 0.6 * dt;
    }
    damageLabels = damageLabels.filter((lb) => lb.alpha > 0);
  }

  function spawnParticles(state, cx, cy, n) {
    for (let i = 0; i < n; i++) {
      const ang = readRandom(state) * Math.PI * 2;
      const spd = 60 + readRandom(state) * 200;
      const col = readRandom(state) < 0.5 ? 'rgba(255,150,30,1)' : 'rgba(200,80,10,1)';
      particles.push({
        cx,
        cy,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd - 60,
        alpha: 0.9 + readRandom(state) * 0.1,
        r: 2 + readRandom(state) * 3,
        color: col,
      });
    }
  }
  return {
    reset,
    stop,
    status,
    addExplosion,
    addDamageLabel,
    drawProjectiles: (...args) => run(drawProjectiles, args),
    drawExplosions: (...args) => run(drawExplosions, args, false),
    drawParticles: (...args) => run(drawParticles, args, false),
    drawDamageLabels: (...args) => run(drawDamageLabels, args, false),
    drawFuseCountdowns: (...args) => run(drawFuseCountdowns, args),
    tickDamageLabels: (...args) => run(tickDamageLabels, args, false),
    spawnParticles: (...args) => run(spawnParticles, args),
  };
}
