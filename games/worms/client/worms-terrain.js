// Collision follows server heights, independently of the loaded visual PNG.
export function buildTerrainMaskFromHeights(heights, width, height) {
  const mask = new Uint8Array(width * height);
  for (let x = 0; x < width; x++) {
    const h = Math.max(0, Math.min(height, heights.at(x) ?? height));
    for (let y = h; y < height; y++) {
      mask[y * width + x] = 1;
    }
  }
  return mask;
}

export function createWormsTerrain({
  width,
  height,
  getState,
  getImage,
  getLevel,
  createCanvas = () => document.createElement('canvas'),
  now = () => Date.now(),
  isActive = () => true,
}) {
  let isStopped = false,
    hasPrepared = false,
    generation = 0;
  let canvas = null,
    context = null,
    imageBinding = null;
  let seed = 0,
    levelIndex = 0,
    clouds = [];

  function isCurrent(revision) {
    if (isStopped || !hasPrepared || revision !== generation) return false;
    const active = isActive();
    return active && !isStopped && revision === generation;
  }

  function releaseImage() {
    if (!imageBinding) return;
    const { image, load, error } = imageBinding;
    imageBinding = null;
    image.removeEventListener('load', load);
    image.removeEventListener('error', error);
  }

  function releaseCanvas() {
    const retired = canvas;
    canvas = null;
    context = null;
    if (retired) {
      retired.width = 0;
      retired.height = 0;
    }
  }

  function reset() {
    generation++;
    hasPrepared = false;
    releaseImage();
    releaseCanvas();
    clouds = [];
    seed = 0;
    levelIndex = 0;
  }

  function prepare(data, roomId) {
    if (isStopped || !isActive()) return null;
    if (isStopped) return null;
    reset();
    const revision = generation;
    seed = roomId ? parseInt(roomId.slice(0, 8), 16) || 1337 : 1337;
    levelIndex = data.levelIndex ?? data.theme ?? 0;
    hasPrepared = true;
    const mask = data.terrain ? buildTerrainMaskFromHeights(data.terrain, width, height) : null;
    setupClouds();
    const level = getLevel(levelIndex);
    if (!isCurrent(revision)) return null;
    const image = getImage(level ? 'level_' + level.file : null);
    if (!isCurrent(revision)) return null;
    if (image && !(image.complete && image.naturalWidth > 0)) {
      const load = () => {
        if (!isCurrent(revision)) return;
        releaseImage();
        redraw();
      };
      const error = () => {
        if (isCurrent(revision)) releaseImage();
      };
      imageBinding = { image, load, error };
      image.addEventListener('load', load, { once: true });
      if (!isCurrent(revision)) return null;
      image.addEventListener('error', error, { once: true });
    }
    return mask;
  }

  function mount() {
    const revision = generation;
    if (!isCurrent(revision)) return;
    releaseCanvas();
    const nextCanvas = createCanvas();
    if (!isCurrent(revision)) {
      nextCanvas.width = 0;
      nextCanvas.height = 0;
      return;
    }
    canvas = nextCanvas;
    canvas.width = width;
    canvas.height = height;
    if (!isCurrent(revision)) return;
    const nextContext = canvas.getContext('2d');
    if (!isCurrent(revision)) return;
    context = nextContext;
    redraw();
  }

  function redraw() {
    const revision = generation;
    if (!context || !isCurrent(revision)) return;
    const state = getState();
    if (!isCurrent(revision)) return;
    const target = context;
    target.clearRect(0, 0, width, height);
    drawTerrainBase(target, state);
    if (!isCurrent(revision)) return;
    eraseTerrainHoles(target, state);
    drawWaterZone(target, state);
    if (!isCurrent(revision)) return;
    drawSuddenDeathWaterLine(target, state);
  }

  function setupClouds() {
    // Generate animated clouds — scattered randomly across sky, varied sizes & speeds
    const cr = createSeededRandom(seed + 77);
    clouds = Array.from({ length: 18 }, () => ({
      x: cr() * width,
      y: 8 + cr() * 90,
      scale: 0.35 + cr() * 0.5, // 0.35–0.85
      speed: 4 + cr() * 10,
    }));
  }

  function drawTerrainBase(ctx, state) {
    const revision = generation;
    const lvl = getLevel(levelIndex);
    if (!isCurrent(revision)) return;
    const lvlImg = getImage(`level_${lvl.file}`);
    if (!isCurrent(revision)) return;

    if (lvlImg?.complete && lvlImg.naturalWidth > 0) {
      // Draw real Worms level image stretched to fill canvas
      ctx.drawImage(lvlImg, 0, 0, width, height);
    } else if (state.terrain) {
      // Fallback: minimal procedural fill (used until image loads or if missing)
      ctx.beginPath();
      ctx.moveTo(0, height);
      for (let x = 0; x < width; x++) ctx.lineTo(x, Math.floor(state.terrain.at(x) ?? height));
      ctx.lineTo(width - 1, height);
      ctx.closePath();
      const dGrad = ctx.createLinearGradient(0, 0, 0, height);
      dGrad.addColorStop(0, '#7a5020');
      dGrad.addColorStop(0.3, '#5a3810');
      dGrad.addColorStop(1, '#3a240a');
      ctx.fillStyle = dGrad;
      ctx.fill();
      ctx.lineWidth = 5;
      ctx.strokeStyle = '#4a9a28';
      ctx.beginPath();
      ctx.moveTo(0, Math.floor(state.terrain.at(0) ?? height));
      for (let x = 1; x < width; x++) ctx.lineTo(x, Math.floor(state.terrain.at(x) ?? height));
      ctx.stroke();
    }
  }

  function eraseTerrainHoles(ctx, state) {
    // Punch out explosion holes using destination-out.
    // MUST use fully-opaque fillStyle — if the water pattern (semi-transparent) is
    // still set as fillStyle, destination-out will only partially erase terrain,
    // leaving visible "wave" traces inside every hole.
    if (state.holes.length === 0) return;
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = '#000000'; // fully opaque — erase 100% of each hole pixel
    for (const h of state.holes) {
      ctx.beginPath();
      ctx.arc(h.cx, h.cy, h.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  function drawWaterZone(ctx, state) {
    // Water zone — use dynamic state.waterLevel (rises in sudden death)
    const revision = generation;
    const waterImg = getImage('water3');
    if (!isCurrent(revision)) return;
    if (waterImg?.complete && waterImg.naturalWidth > 0) {
      const pat = ctx.createPattern(waterImg, 'repeat-x');
      if (pat) {
        ctx.globalAlpha = 0.82;
        ctx.fillStyle = pat;
        ctx.fillRect(0, state.waterLevel, width, height - state.waterLevel);
        ctx.globalAlpha = 1;
      }
    } else {
      ctx.fillStyle = 'rgba(0, 80, 200, 0.55)';
      ctx.fillRect(0, state.waterLevel, width, height - state.waterLevel);
      ctx.fillStyle = 'rgba(100,180,255,0.15)';
      ctx.fillRect(0, state.waterLevel, width, 3);
    }
  }

  function drawSuddenDeathWaterLine(ctx, state) {
    // Sudden death warning line (flashing red)
    if (!state.suddenDeath) return;
    const revision = generation;
    const alpha = 0.5 + 0.5 * Math.sin(now() / 200);
    if (!isCurrent(revision)) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = '#ff3300';
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 6]);
    ctx.beginPath();
    ctx.moveTo(0, state.waterLevel);
    ctx.lineTo(width, state.waterLevel);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  function drawBackground(ctx, dt) {
    const revision = generation;
    if (!isCurrent(revision)) return;
    const lvl = getLevel(levelIndex);
    if (!isCurrent(revision)) return;
    drawSky(ctx, lvl);
    if (lvl.stars) drawStars(ctx);
    drawClouds(ctx, dt);
    if (canvas) ctx.drawImage(canvas, 0, 0);
  }

  function drawSky(ctx, lvl) {
    const sky = ctx.createLinearGradient(0, 0, 0, height);
    sky.addColorStop(0, lvl.skyA);
    sky.addColorStop(0.45, lvl.skyB);
    sky.addColorStop(1, lvl.skyC);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, width, height);
  }

  function drawStars(ctx) {
    const starR = createSeededRandom(seed + 5);
    for (let i = 0; i < 90; i++) {
      const sx = starR() * width;
      const sy = starR() * height * 0.65;
      const sr = 0.5 + starR() * 1.2;
      const sa = 0.3 + starR() * 0.7;
      ctx.beginPath();
      ctx.arc(sx, sy, sr, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,255,255,${sa})`;
      ctx.fill();
    }
  }

  function drawClouds(ctx, dt) {
    for (const c of clouds) {
      c.x = (c.x + c.speed * dt + width) % width;
      drawCloud(ctx, c.x, c.y, c.scale);
    }
  }

  function createSeededRandom(seed) {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  // Procedural puffs avoid the sprite-sheet column artefacts.
  function drawCloud(ctx, cx, cy, sc) {
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = '#c8d8f0';
    const puffs = [
      [0, 0, 22 * sc],
      [18 * sc, -6 * sc, 18 * sc],
      [-18 * sc, -4 * sc, 16 * sc],
      [32 * sc, 4 * sc, 14 * sc],
      [-30 * sc, 4 * sc, 13 * sc],
      [8 * sc, 8 * sc, 16 * sc],
    ];
    for (const [px, py, pr] of puffs) {
      ctx.beginPath();
      ctx.arc(cx + px, cy + py, pr, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  function stop() {
    if (isStopped) return;
    isStopped = true;
    reset();
  }
  function status() {
    return {
      isStopped,
      hasPrepared,
      hasCanvas: canvas !== null,
      hasContext: context !== null,
      hasImageListener: imageBinding !== null,
      clouds: clouds.length,
    };
  }
  return { prepare, mount, redraw, drawBackground, reset, stop, status };
}
