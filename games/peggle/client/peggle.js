// ChaOS — Peggle Classic Web Engine v3
// Faithfully ported from the WoW Peggle Classic addon (MIT).
//
// Physics constants extracted verbatim from Peggle.lua:
//   GRAVITY      = 2.48/step      (be=-248, dt=0.01 → −2.48, flipped for Canvas Y-down)
//   LAUNCH_SPEED = 260 px/s       (se=260)
//   BOUNCE       = 0.68           (Ee=0.68)
//   BALL_R       = 6              (e.ballRadius=6)
//   PEG_R        = 8.5            (10 * 0.85)
//   BRICK_W/H    = 28.9           (34 * 0.85)
//
// Objects in the `pegs` array have shape in 'peg'|'brick'
// Brick objects have extra fields: rotation (degrees), radiusKey (0-180)

(function (global) {
  'use strict';
  const UINT32_RANGE = 2 ** 32;
  const PRNG_INCREMENT = Number.parseInt('6D2B79F5', 16);
  const LIGHT_OFFSET_RATIO = 8 / 25;

  function secureRandomInt(maxExclusive) {
    const max = Math.floor(Number(maxExclusive));
    if (!Number.isSafeInteger(max) || max <= 0) return 0;
    const range = UINT32_RANGE;
    const limit = range - (range % max);
    const buf = new Uint32Array(1);
    do { globalThis.crypto.getRandomValues(buf); } while (buf[0] >= limit);
    return buf[0] % max;
  }

  // ── Physics constants ─────────────────────────────────────────────────────
  const BOARD_W      = 554;
  const BOARD_H      = 464;
  const BALL_R       = 6;
  const PEG_R        = 8.5;
  const BRICK_W      = 28.9;
  const BRICK_H      = 28.9;
  const GRAVITY      = 2.48;
  const LAUNCH_SPEED = 260;
  const BOUNCE       = 0.68;
  const DT           = 0.01;
  const CATCHER_W    = 96;     // catch zone width (top opening)
  const CATCHER_H    = 28;     // bucket height (trapezoid)
  const CATCHER_LOOP = 6;
  const LAUNCH_X     = BOARD_W / 2 + 1;
  const LAUNCH_Y     = 36;
  const BORDER_L     = 10;
  const BORDER_R     = BOARD_W - 10;
  const BORDER_T     = 2;
  const BLAST_R      = 40;
  const TRAIL_LEN    = 10;
  const MAX_HIT_NOTE = 18;
  const DEFAULT_ART_BASE = '/peggle-images';

  // Top of the catcher opening — ball is caught only when entering from above.
  const CATCHER_TOP_Y = BOARD_H - CATCHER_H - 8;

  // ── Scoring ──────────────────────────────────────────────────────────────
  const BASE_PTS = { blue: 10, orange: 100, green: 10, purple: 500 };

  // ── Palette ──────────────────────────────────────────────────────────────
  const COL = {
    blue:   { fill: '#1a44cc', glow: '#4477ff', hi: '#88aaff', dark: '#0d2266' },
    orange: { fill: '#cc5500', glow: '#ff8800', hi: '#ffbb44', dark: '#662200' },
    green:  { fill: '#0d7a22', glow: '#33dd55', hi: '#88ff99', dark: '#063d11' },
    purple: { fill: '#7a12aa', glow: '#cc44ff', hi: '#ee99ff', dark: '#3d0655' },
  };

  const TYPE_SPRITE_ROW = { blue: 0, orange: 1, purple: 2, green: 3 };
  const RADIUS_SPRITE = { 0: 12, 10: 1, 20: 2, 30: 3, 40: 4, 60: 5, 80: 6, 100: 7, 120: 8, 140: 9, 160: 10, 180: 11 };

  // Convex brick polygons copied from Peggle.lua and scaled by the addon's .85.
  // They are authored Y-up. _updateBrickPolygon flips Y/rotation for Canvas.
  const BRICK_POLYGONS = [
    [7,-11,9,-4,9,3,7,10,-10,3,-10,-4],
    [7,-15,10,-1,7,14,-10,7,-9,0,-10,-8],
    [7,-13,9,-6,9,5,7,12,-10,7,-10,-8],
    [8,-12,9,-4,9,3,8,12,-9,9,-8,0,-9,-9],
    [9,-14,10,-6,10,5,9,14,-10,11,-10,-11],
    [8,-13,9,-8,9,6,8,12,-10,10,-10,-11],
    [8,-15,9,-7,9,6,8,15,-10,13,-10,-13],
    [8,-15,9,-9,9,7,8,14,-9,12,-9,6,-9,-8,-9,-13],
    [8,-15,9,-6,9,5,8,13,-10,11,-10,6,-10,-7,-10,-13],
    [8,-15,9,-8,9,7,8,14,-10,13,-10,-14],
    [8,-15,9,-8,9,7,8,15,-10,14,-10,-14],
    [9,-15,9,14,-9,14,-9,-15],
  ];

  function loadImage(src) {
    const image = new Image();
    image.decoding = 'async';
    image.src = src;
    return image;
  }

  function pointInPolygon(x, y, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const a = polygon[i], b = polygon[j];
      if (((a.y > y) !== (b.y > y))
          && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  }

  function circlePolygonCollision(ball, polygon) {
    let bestX = 0, bestY = 0, bestD2 = Infinity;
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i], b = polygon[(i + 1) % polygon.length];
      const abx = b.x - a.x, aby = b.y - a.y;
      const length2 = abx * abx + aby * aby;
      const t = length2 > 0
        ? Math.max(0, Math.min(1, ((ball.x - a.x) * abx + (ball.y - a.y) * aby) / length2))
        : 0;
      const qx = a.x + abx * t, qy = a.y + aby * t;
      const dx = ball.x - qx, dy = ball.y - qy;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) { bestD2 = d2; bestX = qx; bestY = qy; }
    }

    const inside = pointInPolygon(ball.x, ball.y, polygon);
    if (!inside && bestD2 >= BALL_R * BALL_R) return null;
    const dist = Math.sqrt(bestD2);
    let nx = dist > 0 ? (ball.x - bestX) / dist : 0;
    let ny = dist > 0 ? (ball.y - bestY) / dist : -1;
    if (inside) { nx = -nx; ny = -ny; }
    return { nx, ny, overlap: inside ? BALL_R + dist : BALL_R - dist };
  }

  // ── Static star field ─────────────────────────────────────────────────────
  function rng32(seed) {
    return function () {
      seed |= 0; seed = (seed + PRNG_INCREMENT) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / UINT32_RANGE;
    };
  }
  const _stars = (() => {
    const r = rng32(0xDEAD_BEEF);
    return Array.from({ length: 80 }, () => ({
      x: r() * BOARD_W, y: r() * BOARD_H,
      rad: r() * 1.5 + 0.3, a: r() * 0.7 + 0.2,
    }));
  })();

  // ── PeggleEngine ─────────────────────────────────────────────────────────
  class PeggleEngine {
    constructor(canvas, objects, opts = {}) {
      this.canvas      = canvas;
      this.ctx         = canvas.getContext('2d');
      this.soundBase   = opts.soundBase   ?? '/peggle-sounds';
      this.artBase     = opts.artBase     ?? DEFAULT_ART_BASE;
      this.levelId     = Math.max(1, Math.min(13, Number(opts.levelId) || 1));
      this.levelName   = String(opts.levelName ?? 'Peggle');
      this.translate   = opts.translate ?? (key => key);
      this.locale      = opts.locale ?? 'fr-FR';
      this.targetScore = opts.targetScore ?? null;
      this.totalBalls  = opts.balls       ?? 10;
      this.onScore     = opts.onScore     ?? (() => {});
      this.onBallLost  = opts.onBallLost  ?? (() => {});
      this.onGameOver  = opts.onGameOver  ?? (() => {});
      this.onControlState = opts.onControlState ?? (() => {});

      this.state         = 'aim';
      this.balls         = this.totalBalls;
      this.score         = 0;
      this.gameTime      = 0;
      this.aimAngle      = Math.PI * 0.7;
      this.feverMode     = false;
      this.hitSoundIdx   = 0;
      this.scorePopups   = [];
      this.blastRings    = [];
      this.ball          = null;
      this.catcher       = { t: 0 };
      this.clearTimer    = 0;
      this._rafId        = null;
      this._lastTs       = null;
      this._sounds       = {};
      this._playing = new Set();
      this._destroyed = false;
      this._victoryTimer = null;
      this._bgFlash      = 0;
      this.ctx.setTransform(canvas.width / BOARD_W, 0, 0, canvas.height / BOARD_H, 0, 0);
      this.ctx.imageSmoothingEnabled = true;
      this.ctx.imageSmoothingQuality = 'high';
      this.art = {
        background: loadImage(`${this.artBase}/bg${this.levelId}.webp`),
        pegs: loadImage(`${this.artBase}/pegs.webp`),
        bricks: loadImage(`${this.artBase}/bricks.webp`),
        ball: loadImage(`${this.artBase}/ball.webp`),
        shooter: loadImage(`${this.artBase}/shooter.webp`),
        catcher: loadImage(`${this.artBase}/catcher.webp`),
      };

      this.objects = objects.map(o => ({
        ...o,
        _baseX:          o.x,
        _baseY:          o.y,
        _baseRotation:   o.rotation ?? 0,
        hit:             false,
        alpha:           1.0,
        _scoredThisShot: false,
      }));
      for (const object of this.objects) {
        if (object.shape === 'brick') this._updateBrickPolygon(object);
      }
      this.orangeTotal   = this.objects.filter(o => o.type === 'orange').length;
      this.orangeCleared = 0;

      this._onPointerMove = this._pointerMove.bind(this);
      this._onPointerDown = this._pointerDown.bind(this);
      this._onContextMenu = (e) => e.preventDefault();
      canvas.addEventListener('pointermove',  this._onPointerMove);
      canvas.addEventListener('pointerdown',  this._onPointerDown);
      canvas.addEventListener('contextmenu',  this._onContextMenu);

      this._rafId = requestAnimationFrame(ts => this._loop(ts));
    }

    destroy() {
      if (this._destroyed) return;
      this._destroyed = true;
      if (this._rafId != null) cancelAnimationFrame(this._rafId);
      clearTimeout(this._victoryTimer); this._victoryTimer = null;
      for (const sound of [...Object.values(this._sounds), ...this._playing]) {
        sound.onended = sound.onerror = null; sound.pause(); sound.removeAttribute('src'); sound.load();
      }
      this._playing.clear(); this._sounds = {};
      this._rafId = null;
      this.canvas.removeEventListener('pointermove',  this._onPointerMove);
      this.canvas.removeEventListener('pointerdown',  this._onPointerDown);
      this.canvas.removeEventListener('contextmenu',  this._onContextMenu);
    }

    // ── Input ─────────────────────────────────────────────────────────────
    aimAt(degrees) {
      if (this._destroyed || this.state !== 'aim' || !Number.isFinite(degrees)) return false;
      this.aimAngle = Math.max(0.04, Math.min(Math.PI - 0.04, degrees * Math.PI / 180));
      this.onControlState(this);
      return true;
    }
    shoot() { if (!this._destroyed) this._shoot(); }
    _canvasXY(cx, cy) {
      const r = this.canvas.getBoundingClientRect();
      return {
        x: (cx - r.left) * (BOARD_W / r.width),
        y: (cy - r.top)  * (BOARD_H / r.height),
      };
    }
    _pointerMove(e) {
      if (this._destroyed) return;
      const p = this._canvasXY(e.clientX, e.clientY);
      this._updateAim(p.x, p.y);
    }
    _pointerDown(e) {
      if (this._destroyed) return;
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      e.preventDefault();
      const p = this._canvasXY(e.clientX, e.clientY);
      this._updateAim(p.x, p.y);
      if (this.state === 'aim') this._shoot();
    }
    _updateAim(mx, my) {
      if (this.state !== 'aim') return;
      const dx = mx - LAUNCH_X, dy = my - LAUNCH_Y;
      if (dy < 8 && Math.abs(dx) < 30) return;
      this.aimAngle = Math.max(0.04, Math.min(Math.PI - 0.04, Math.atan2(dy, dx)));
      this.onControlState(this);
    }

    // ── Loop ──────────────────────────────────────────────────────────────
    _loop(ts) {
      this._rafId = null;
      if (this._destroyed) return;
      if (this._lastTs === null) this._lastTs = ts;
      const dt = Math.min(ts - this._lastTs, 50) / 1000;
      this._lastTs = ts;
      this.gameTime += dt;
      this._update(dt);
      if (this._destroyed) return;
      this._render();
      if (this.state !== 'done') this._rafId = requestAnimationFrame(t => this._loop(t));
    }

    // ── Update ────────────────────────────────────────────────────────────
    _update(dt) {
      this.catcher.t += dt;

      this.scorePopups = this.scorePopups.filter(p => {
        p.elapsed += dt; p.y -= dt * 40;
        p.alpha = Math.max(0, 1 - p.elapsed / 1.5);
        return p.alpha > 0;
      });
      this.blastRings = this.blastRings.filter(f => { f.elapsed += dt; return f.elapsed < 0.6; });
      if (this._bgFlash > 0) this._bgFlash = Math.max(0, this._bgFlash - dt * 2.5);
      this._updateObjects();

      if (this.state === 'shooting' && this.ball) {
        this._physics(dt);
      } else if (this.state === 'clearing') {
        this.clearTimer += dt;
        let anyVisible = false;
        for (const o of this.objects) {
          if (o.hit && o.alpha > 0) {
            o.alpha = Math.max(0, o.alpha - dt * 4);
            if (o.alpha > 0) anyVisible = true;
          }
        }
        if (this.clearTimer > 0.3 && !anyVisible) {
          this.objects = this.objects.filter(o => !o.hit);
          this._endShot();
        }
      }
    }

    _updateObjects() {
      for (const object of this.objects) {
        const animation = object.animation;
        object.x = object._baseX;
        object.y = object._baseY;
        object.rotation = object._baseRotation;

        if (animation) {
          const duration = animation.duration;
          const runningTime = animation.active ? this.gameTime : 0;
          const elapsed = ((runningTime + duration * animation.phase) % duration + duration) % duration;
          const cycle = elapsed / duration;

          if (animation.type === 1 || animation.type === 4) {
            const progress = animation.pingPong
              ? (1 - Math.cos(Math.PI * 2 * cycle)) / 2
              : cycle;
            if (animation.value4 > 0) {
              const angle = animation.value3 * Math.PI / 180;
              object.x += progress * animation.value4 * Math.cos(angle);
              object.y -= progress * animation.value4 * Math.sin(angle);
            } else {
              object.x += progress * (animation.value1 - object._baseX);
              object.y += progress * ((BOARD_H - animation.value2) - object._baseY);
            }
          } else if (animation.type === 2 || animation.type === 5) {
            const angle = Math.PI * 2 * cycle;
            object.x += Math.cos(angle) * (animation.value1 + 8.5) * 0.85;
            object.y -= Math.sin(angle) * (animation.value2 + 8.5) * 0.85;
          }

          if (animation.type === 3 || animation.type === 4 || animation.type === 5) {
            object.rotation = cycle * 360;
          }
        }

        if (object.shape === 'brick') this._updateBrickPolygon(object);
      }
    }

    _updateBrickPolygon(object) {
      const sprite = RADIUS_SPRITE[object.radiusKey] ?? 12;
      const source = BRICK_POLYGONS[sprite - 1];
      const angle = -(object.rotation ?? 0) * Math.PI / 180;
      const cos = Math.cos(angle), sin = Math.sin(angle);
      const polygon = [];
      for (let i = 0; i < source.length; i += 2) {
        const x = source[i] * 0.85;
        const y = -source[i + 1] * 0.85;
        polygon.push({
          x: object.x + cos * x - sin * y,
          y: object.y + sin * x + cos * y,
        });
      }
      object._polygon = polygon;
    }

    // ── Physics ───────────────────────────────────────────────────────────
    _physics(dt) {
      const steps = Math.max(1, Math.round(dt / DT));
      for (let s = 0; s < steps; s++) {
        this.ball.vy += GRAVITY;
        this.ball.x  += this.ball.vx * DT;
        this.ball.y  += this.ball.vy * DT;

        // Wall bounces
        if (this.ball.x - BALL_R < BORDER_L)  { this.ball.x = BORDER_L + BALL_R; this.ball.vx =  Math.abs(this.ball.vx); }
        if (this.ball.x + BALL_R > BORDER_R)  { this.ball.x = BORDER_R - BALL_R; this.ball.vx = -Math.abs(this.ball.vx); }
        if (this.ball.y - BALL_R < BORDER_T)  { this.ball.y = BORDER_T + BALL_R; this.ball.vy =  Math.abs(this.ball.vy); }

        // Object collisions
        for (const obj of this.objects) {
          if (obj.hit) continue;
          let collision;
          if (obj.shape === 'brick') {
            collision = circlePolygonCollision(this.ball, obj._polygon);
          } else {
            const dx = this.ball.x - obj.x;
            const dy = this.ball.y - obj.y;
            const d2 = dx * dx + dy * dy;
            const minD = BALL_R + PEG_R;
            if (d2 < minD * minD) {
              const dist = Math.sqrt(d2);
              collision = {
                nx: dist > 0 ? dx / dist : 0,
                ny: dist > 0 ? dy / dist : -1,
                overlap: minD - dist,
              };
            }
          }
          if (!collision) continue;

          const { nx, ny, overlap } = collision;
          const vDotN = this.ball.vx * nx + this.ball.vy * ny;
          if (vDotN < 0) {
            const j = -(1 + BOUNCE) * vDotN;
            this.ball.vx += j * nx;
            this.ball.vy += j * ny;
            this.ball.x += nx * overlap;
            this.ball.y += ny * overlap;
            if (!obj._scoredThisShot) { obj._scoredThisShot = true; this._scoreObj(obj); }
          }
        }

        // ── Catcher collision ─────────────────────────────────────────────
        // Ball caught when: falling down, center crosses the opening, within the scoop width.
        const cx     = this._catcherX();
        const innerL = cx - CATCHER_W / 2;
        const innerR = cx + CATCHER_W / 2;

        if (this.ball.vy > 0
            && this.ball.y + BALL_R >= CATCHER_TOP_Y
            && this.ball.y - BALL_R <= CATCHER_TOP_Y + CATCHER_H + 6
            && this.ball.x >= innerL + BALL_R
            && this.ball.x <= innerR - BALL_R) {
          this._ballCaught(); return;
        }

        if (this.ball.y > BOARD_H + 30) { this._ballLost(); return; }
      }

      this.ball.trail.push({ x: this.ball.x, y: this.ball.y });
      if (this.ball.trail.length > TRAIL_LEN) this.ball.trail.shift();
    }

    _catcherX() {
      const amp = (BOARD_W - CATCHER_W) / 2 - 20;
      return BOARD_W / 2 + amp * Math.cos(2 * Math.PI * this.catcher.t / CATCHER_LOOP);
    }

    // ── Shooting ──────────────────────────────────────────────────────────
    _shoot() {
      if (this.balls <= 0 || this.state !== 'aim') return;
      this.balls--;
      this.hitSoundIdx = 0;
      for (const o of this.objects) o._scoredThisShot = false;
      this.ball = {
        x: LAUNCH_X, y: LAUNCH_Y,
        vx: Math.cos(this.aimAngle) * LAUNCH_SPEED,
        vy: Math.sin(this.aimAngle) * LAUNCH_SPEED,
        trail: [],
      };
      this.state = 'shooting';
      this.onControlState(this);
      this._playSound('cannonshot');
    }

    // ── Scoring ──────────────────────────────────────────────────────────
    _scoreObj(obj) {
      obj.hit = true;
      this.hitSoundIdx = Math.min(MAX_HIT_NOTE, this.hitSoundIdx + 1);
      this._playSound(`peghitx${this.hitSoundIdx}`);

      const mult = this._feverMult();
      let pts;
      switch (obj.type) {
        case 'orange':
          pts = BASE_PTS.orange * mult;
          this.orangeCleared++;
          if (!this.feverMode && this.orangeCleared >= this.orangeTotal) {
            this.feverMode = true; this._bgFlash = 1;
            this._playSound('extremefever2');
          }
          break;
        case 'purple': pts = BASE_PTS.purple; break;
        case 'green':  pts = BASE_PTS.green * mult; this._spaceBlast(obj); break;
        default:       pts = BASE_PTS.blue * mult;
      }
      this.score += pts;
      this.onScore(pts, obj.type);
      this.scorePopups.push({ x: obj.x, y: obj.y, text: `+${pts}`, color: COL[obj.type]?.glow ?? '#fff', elapsed: 0, alpha: 1 });
    }

    _spaceBlast(greenObj) {
      let hit = 0;
      for (const o of this.objects) {
        if (o.hit) continue;
        const dx = o.x - greenObj.x, dy = o.y - greenObj.y;
        if (dx * dx + dy * dy <= BLAST_R * BLAST_R) { this._scoreObj(o); hit++; }
      }
      if (hit > 0) { this._playSound('powerup_spaceblast'); this.blastRings.push({ x: greenObj.x, y: greenObj.y, elapsed: 0 }); }
    }

    _feverMult() {
      if (!this.orangeTotal) return 1;
      const r = this.orangeCleared / this.orangeTotal;
      if (r >= 1) return 10; if (r >= 0.75) return 5; if (r >= 0.5) return 3; if (r >= 0.25) return 2;
      return 1;
    }

    // ── Ball fate ─────────────────────────────────────────────────────────
    _ballCaught() {
      this.balls++;
      this._playSound(['extraball','extraball2','extraball3'][secureRandomInt(3)]);
      this.scorePopups.push({ x: LAUNCH_X, y: BOARD_H - 60, text: this.translate('games.peggle.freeBall'), color: '#ffff00', elapsed: 0, alpha: 1 });
      this.ball = null; this.state = 'clearing'; this.clearTimer = 0;
    }
    _ballLost() {
      this.onBallLost(this.balls);
      this.ball = null; this.state = 'clearing'; this.clearTimer = 0;
    }
    _endShot() {
      const remainOrange = this.objects.filter(o => o.type === 'orange').length;
      if (remainOrange === 0) {
        const bonus = this.balls * 10000;
        if (bonus) {
          this.score += bonus;
          this.scorePopups.push({ x: BOARD_W/2, y: BOARD_H/2, text: this.translate('games.peggle.bonus', { value: bonus.toLocaleString(this.locale) }), color: '#ffee00', elapsed: 0, alpha: 1 });
          this.onScore(bonus, 'bonus');
        }
        this._playSound('applause');
        this._victoryTimer = setTimeout(() => { this._victoryTimer = null; this._playSound('odetojoy'); }, 700);
        this.state = 'done'; this.onGameOver(this.score, 'cleared'); return;
      }
      if (this.balls <= 0) {
        this._playSound('sigh');
        this.state = 'done'; this.onGameOver(this.score, 'no_balls'); return;
      }
      this.hitSoundIdx = 0; this.state = 'aim';
      this.onControlState(this);
    }

    // ── Rendering ─────────────────────────────────────────────────────────
    _render() {
      const ctx = this.ctx;
      const fr  = Math.round(this._bgFlash * 35);
      ctx.fillStyle = `rgb(${7+fr},${10+fr},${24+fr*2})`;
      ctx.fillRect(0, 0, BOARD_W, BOARD_H);

      // The addon displays each 512×512 level painting on a 554×554 square,
      // centered behind the shorter board. Reproduce that crop exactly.
      if (this.art.background.naturalWidth > 0) {
        ctx.save();
        ctx.globalAlpha = 0.82;
        ctx.filter = `brightness(${0.58 + this._bgFlash * 0.12}) saturate(.82)`;
        ctx.drawImage(this.art.background, 0, -45, BOARD_W, BOARD_W);
        ctx.restore();
        const shade = ctx.createLinearGradient(0, 0, 0, BOARD_H);
        shade.addColorStop(0, 'rgba(2,5,15,.38)');
        shade.addColorStop(.48, 'rgba(2,5,15,.15)');
        shade.addColorStop(1, 'rgba(2,5,15,.48)');
        ctx.fillStyle = shade;
        ctx.fillRect(0, 0, BOARD_W, BOARD_H);
      } else {
        for (const s of _stars) {
          ctx.beginPath(); ctx.arc(s.x, s.y, s.rad, 0, Math.PI*2);
          ctx.fillStyle = `rgba(255,255,255,${s.a})`; ctx.fill();
        }
      }

      // Board border
      ctx.strokeStyle = '#1a3070'; ctx.lineWidth = 2;
      ctx.strokeRect(1, 1, BOARD_W-2, BOARD_H-2);

      // Blast rings
      for (const f of this.blastRings) {
        const p = f.elapsed / 0.6;
        ctx.save(); ctx.globalAlpha = (1-p)*0.6;
        ctx.beginPath(); ctx.arc(f.x, f.y, BLAST_R*(0.3+p*0.7), 0, Math.PI*2);
        ctx.strokeStyle = '#88ffaa'; ctx.lineWidth = 3; ctx.stroke();
        ctx.restore();
      }

      // Objects: bricks first (background), then pegs on top
      for (const o of this.objects) {
        if (o.alpha <= 0) continue;
        if (o.shape === 'brick') this._drawBrick(ctx, o);
      }
      for (const o of this.objects) {
        if (o.alpha <= 0) continue;
        if (o.shape !== 'brick') this._drawPeg(ctx, o);
      }

      // Aim line
      if (this.state === 'aim') this._drawAimLine(ctx);

      // Launcher
      this._drawLauncher(ctx);

      // Ball (under catcher)
      if (this.ball) this._drawBall(ctx);

      // Catcher drawn on top so rims feel solid
      this._drawCatcher(ctx);

      // Score popups
      ctx.save(); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (const pop of this.scorePopups) {
        if (pop.alpha <= 0) continue;
        ctx.globalAlpha = pop.alpha;
        ctx.font = `bold ${pop.text.length > 6 ? 11 : 13}px "Segoe UI",sans-serif`;
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.9)'; ctx.strokeText(pop.text, pop.x, pop.y);
        ctx.fillStyle = pop.color; ctx.fillText(pop.text, pop.x, pop.y);
      }
      ctx.restore();

      this._drawHUD(ctx);
    }

    _drawPeg(ctx, o) {
      const col = COL[o.type] ?? COL.blue;
      const r   = PEG_R;
      ctx.save();
      ctx.globalAlpha = o.alpha;
      ctx.shadowColor = o.hit ? '#ffffff' : col.glow;
      ctx.shadowBlur  = o.hit ? 17 : 7;
      if (this.art.pegs.naturalWidth > 0) {
        const column = TYPE_SPRITE_ROW[o.type] ?? 0;
        const row = o.hit ? 1 : 0;
        const size = 23.8;
        ctx.drawImage(this.art.pegs, column * 32, row * 32, 32, 32,
          o.x - size / 2, o.y - size / 2, size, size);
        ctx.restore();
        return;
      }
      const grd = ctx.createRadialGradient(o.x - r * LIGHT_OFFSET_RATIO, o.y - r * LIGHT_OFFSET_RATIO, r * 0.07, o.x, o.y, r);
      grd.addColorStop(0, o.hit ? '#ffffff' : col.hi);
      grd.addColorStop(0.5, o.hit ? col.glow : col.fill);
      grd.addColorStop(1, col.dark + 'cc');
      ctx.beginPath(); ctx.arc(o.x, o.y, r, 0, Math.PI*2);
      ctx.fillStyle = grd; ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = o.hit ? '#ffffffaa' : col.hi + '88';
      ctx.lineWidth = 0.7; ctx.stroke();
      ctx.restore();
    }

    _drawBrick(ctx, o) {
      const col = COL[o.type] ?? COL.blue;
      ctx.save();
      ctx.globalAlpha = o.alpha;
      ctx.translate(o.x, o.y);
      // Levels.lua is Y-up. Flipping the board also reverses every angle.
      ctx.rotate(-(o.rotation ?? 0) * Math.PI / 180);
      ctx.shadowColor = o.hit ? '#ffffff' : col.glow;
      ctx.shadowBlur  = o.hit ? 15 : 5;

      if (this.art.bricks.naturalWidth > 0) {
        const sprite = RADIUS_SPRITE[o.radiusKey] ?? 12;
        const colorRow = TYPE_SPRITE_ROW[o.type] ?? 0;
        const row = colorRow + (o.hit ? 4 : 0);
        ctx.drawImage(this.art.bricks, (sprite - 1) * 32, row * 32, 32, 32,
          -BRICK_W / 2, -BRICK_H / 2, BRICK_W, BRICK_H);
        ctx.restore();
        return;
      }

      // Asset fallback: a vertical beveled capsule (radius 0's base shape).
      const vw = 14, vh = 30, hw = vw / 2, hh = vh / 2, rnd = 3;
      const body = ctx.createLinearGradient(0, -hh, 0, hh);
      body.addColorStop(0,   o.hit ? '#ffffff'   : col.hi);
      body.addColorStop(0.45, o.hit ? col.glow   : col.fill);
      body.addColorStop(1,   col.dark);
      ctx.fillStyle = body;
      ctx.beginPath(); ctx.roundRect(-hw, -hh, vw, vh, rnd); ctx.fill();
      ctx.shadowBlur = 0;
      // Top highlight strip (glass sheen)
      ctx.fillStyle = `rgba(255,255,255,${o.hit ? 0.7 : 0.28})`;
      ctx.beginPath(); ctx.roundRect(-hw + 2, -hh + 1, vw - 4, vh * 0.38, [rnd, rnd, 0, 0]); ctx.fill();
      // Outline
      ctx.strokeStyle = o.hit ? '#ffffffbb' : col.hi + '88';
      ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.roundRect(-hw, -hh, vw, vh, rnd); ctx.stroke();
      ctx.restore();
    }

    _drawBall(ctx) {
      const b = this.ball;
      for (let i = 0; i < b.trail.length; i++) {
        const t = b.trail[i], fac = (i+1)/b.trail.length;
        ctx.beginPath(); ctx.arc(t.x, t.y, BALL_R*fac*0.7, 0, Math.PI*2);
        ctx.fillStyle = `rgba(140,190,255,${fac*0.3})`; ctx.fill();
      }
      ctx.save();
      ctx.shadowColor = '#aacfff'; ctx.shadowBlur = 14;
      if (this.art.ball.naturalWidth > 0) {
        ctx.drawImage(this.art.ball, b.x - BALL_R, b.y - BALL_R, BALL_R * 2, BALL_R * 2);
        ctx.restore();
        return;
      }
      const grd = ctx.createRadialGradient(b.x-2, b.y-2, 0.5, b.x, b.y, BALL_R);
      grd.addColorStop(0, '#ffffff'); grd.addColorStop(0.4, '#ddeeff'); grd.addColorStop(1, '#6688bb');
      ctx.beginPath(); ctx.arc(b.x, b.y, BALL_R, 0, Math.PI*2);
      ctx.fillStyle = grd; ctx.fill();
      ctx.restore();
    }

    _drawAimLine(ctx) {
      let x = LAUNCH_X, y = LAUNCH_Y;
      let vx = Math.cos(this.aimAngle) * LAUNCH_SPEED;
      let vy = Math.sin(this.aimAngle) * LAUNCH_SPEED;
      ctx.save();
      for (let step = 0; step < 240; step++) {
        vy += GRAVITY; x += vx*DT; y += vy*DT;
        if (x - BALL_R < BORDER_L) { x = BORDER_L+BALL_R; vx = Math.abs(vx); }
        if (x + BALL_R > BORDER_R) { x = BORDER_R-BALL_R; vx = -Math.abs(vx); }
        if (y - BALL_R < BORDER_T) { y = BORDER_T+BALL_R; vy = Math.abs(vy); }
        let hit = false;
        for (const o of this.objects) {
          if (o.hit) continue;
          if (o.shape === 'brick') {
            if (circlePolygonCollision({ x, y }, o._polygon)) { hit = true; break; }
          } else {
            const dx = x-o.x, dy = y-o.y;
            if (dx*dx+dy*dy < (BALL_R+PEG_R)**2) { hit = true; break; }
          }
        }
        if (step % 5 === 0) {
          const a = (1 - step/240)*0.6;
          ctx.beginPath(); ctx.arc(x, y, 1.8, 0, Math.PI*2);
          ctx.fillStyle = `rgba(255,255,255,${a})`; ctx.fill();
        }
        if (hit || y > BOARD_H+10) break;
      }
      ctx.restore();
    }

    _drawLauncher(ctx) {
      ctx.save();
      ctx.translate(LAUNCH_X, LAUNCH_Y);
      ctx.rotate(this.aimAngle - Math.PI / 2);
      ctx.shadowColor = '#aaccff'; ctx.shadowBlur = 8;
      if (this.art.shooter.naturalWidth > 0) {
        ctx.drawImage(this.art.shooter, -17.5, -14, 35, 28);
        ctx.restore();
        return;
      }
      ctx.fillStyle = '#ccdeff'; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0,-12); ctx.lineTo(-7,5); ctx.lineTo(7,5); ctx.closePath();
      ctx.fill(); ctx.stroke();
      ctx.restore();
    }

    // ── Catcher: trapezoid bucket (wide top opening, narrow bottom) ────────
    _drawCatcher(ctx) {
      const cx    = this._catcherX();
      const topHW = CATCHER_W / 2;      // half-width at top (= 48)
      const botHW = 28;                  // half-width at bottom (narrower)
      const topY  = CATCHER_TOP_Y;
      const botY  = topY + CATCHER_H;   // bottom of bucket
      const lTop  = cx - topHW, rTop = cx + topHW;
      const lBot  = cx - botHW, rBot  = cx + botHW;

      ctx.save();

      if (this.art.catcher.naturalWidth > 0) {
        ctx.shadowColor = 'rgba(255,190,75,.45)';
        ctx.shadowBlur = 8;
        ctx.drawImage(this.art.catcher, cx - 68.5, topY - 4, 137, 26);
        ctx.restore();
        return;
      }

      // Inner fill — gradient top→bottom
      const fillG = ctx.createLinearGradient(cx, topY, cx, botY);
      fillG.addColorStop(0,   'rgba(50,220,100,0.04)');
      fillG.addColorStop(1,   'rgba(50,220,100,0.13)');
      ctx.fillStyle = fillG;
      ctx.beginPath();
      ctx.moveTo(lTop, topY);
      ctx.lineTo(lBot, botY);
      ctx.quadraticCurveTo(cx, botY + 5, rBot, botY); // slight bottom arc
      ctx.lineTo(rTop, topY);
      ctx.closePath();
      ctx.fill();

      // Bucket outline: two angled walls + bottom arc (top is open)
      ctx.strokeStyle = '#55ee88';
      ctx.lineWidth   = 2.5;
      ctx.lineCap     = 'round';
      ctx.lineJoin    = 'round';
      ctx.shadowColor = '#33ff77';
      ctx.shadowBlur  = 10;
      ctx.beginPath();
      ctx.moveTo(lTop, topY);                              // left rim
      ctx.lineTo(lBot, botY);                              // left wall (angles inward)
      ctx.quadraticCurveTo(cx, botY + 5, rBot, botY);     // curved bottom
      ctx.lineTo(rTop, topY);                              // right wall (angles inward)
      ctx.stroke();

      // Bright end-caps at the rim tips
      ctx.shadowBlur = 14;
      ctx.fillStyle  = '#aaffc8';
      ctx.beginPath(); ctx.arc(lTop, topY, 3, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(rTop, topY, 3, 0, Math.PI * 2); ctx.fill();

      ctx.restore();
    }

    _drawHUD(ctx) {
      const mult  = this._feverMult();
      const ratio = this.orangeTotal ? Math.min(1, this.orangeCleared / this.orangeTotal) : 0;

      ctx.save(); ctx.textBaseline = 'alphabetic';

      // Fever bar (left strip)
      const fbX=4, fbY=44, fbW=9, fbH=BOARD_H-96;
      ctx.fillStyle='rgba(0,0,0,.6)'; ctx.fillRect(fbX,fbY,fbW,fbH);
      if (ratio > 0) {
        const fH = fbH * ratio;
        const fC = ['#3a6bff','#3a6bff','#30b0ff','#ff9900','#ff5500'][Math.min(4,mult-1)];
        ctx.fillStyle = fC; ctx.fillRect(fbX, fbY+fbH-fH, fbW, fH);
      }
      ctx.strokeStyle='#334466'; ctx.lineWidth=1; ctx.strokeRect(fbX,fbY,fbW,fbH);
      if (mult > 1) {
        ctx.font='bold 8px monospace'; ctx.fillStyle='#ffcc00';
        ctx.textAlign='center'; ctx.fillText(`${mult}x`, fbX+fbW/2, fbY-3);
      }

      // Score
      ctx.textAlign='right';
      ctx.font='9px "Segoe UI",sans-serif'; ctx.fillStyle='#7799aa';
      ctx.fillText(this.translate('games.peggle.scoreUpper'), BOARD_W-8, 11);
      ctx.font='bold 20px "Segoe UI",sans-serif'; ctx.fillStyle='#ffffff';
      ctx.shadowColor='#5577bb'; ctx.shadowBlur=8;
      ctx.fillText(this.score.toLocaleString(this.locale), BOARD_W-8, 29);
      ctx.shadowBlur=0;

      // Balls
      ctx.textAlign='left';
      ctx.font='bold 12px "Segoe UI",sans-serif'; ctx.fillStyle='#aabbcc';
      ctx.fillText(`o x${this.balls}`, 16, 15);

      // Orange counter
      ctx.font='10px "Segoe UI",sans-serif'; ctx.fillStyle='#ff8800';
      ctx.fillText(this.translate('games.peggle.orangeCounter', { cleared: this.orangeCleared, total: this.orangeTotal }), 16, 29);

      if (!this.feverMode) {
        ctx.textAlign='center';
        ctx.font='bold 9px Georgia,serif';
        ctx.fillStyle='rgba(238,218,178,.9)';
        ctx.shadowColor='rgba(0,0,0,.95)'; ctx.shadowBlur=4;
        ctx.fillText(this.levelName.toUpperCase(), BOARD_W/2, 14);
        ctx.shadowBlur=0;
      }

      // Fever
      if (this.feverMode) {
        const pulse = 0.82 + Math.sin(this.gameTime*7)*0.18;
        ctx.textAlign='center';
        ctx.font=`bold ${Math.round(15*pulse)}px "Segoe UI",sans-serif`;
        ctx.fillStyle='#ffdd00'; ctx.shadowColor='#ff8800'; ctx.shadowBlur=14;
        ctx.fillText(this.translate('games.peggle.fever'), BOARD_W/2, 20);
        ctx.shadowBlur=0;
      }

      // Versus target
      if (this.targetScore !== null && this.state !== 'done') {
        const diff = this.score - this.targetScore;
        ctx.textAlign='center';
        ctx.font='10px "Segoe UI",sans-serif'; ctx.fillStyle='#ff9944';
        ctx.fillText(this.translate('games.peggle.targetScore', { score: this.targetScore.toLocaleString(this.locale) }), BOARD_W/2, BOARD_H-18);
        ctx.font='bold 11px "Segoe UI",sans-serif';
        ctx.fillStyle = diff >= 0 ? '#44ff88' : '#ff4444';
        ctx.fillText(diff >= 0 ? this.translate('games.peggle.scoreAhead', { score: diff.toLocaleString(this.locale) }) : this.translate('games.peggle.scoreBehind', { score: Math.abs(diff).toLocaleString(this.locale) }), BOARD_W/2, BOARD_H-5);
      }

      // Game over overlay
      if (this.state === 'done') {
        ctx.fillStyle='rgba(0,0,0,.75)'; ctx.fillRect(0, BOARD_H/2-60, BOARD_W, 122);
        ctx.textAlign='center';
        ctx.font='bold 13px "Segoe UI",sans-serif'; ctx.fillStyle='#7799bb';
        ctx.fillText(this.translate('games.peggle.finalScore'), BOARD_W/2, BOARD_H/2-38);
        ctx.font='bold 36px "Segoe UI",sans-serif'; ctx.fillStyle='#ffdd00';
        ctx.shadowColor='#ff8800'; ctx.shadowBlur=16;
        ctx.fillText(this.score.toLocaleString(this.locale), BOARD_W/2, BOARD_H/2+6);
        ctx.shadowBlur=0;
        ctx.font='11px "Segoe UI",sans-serif'; ctx.fillStyle='#7799aa';
        ctx.fillText(this.translate('games.peggle.waitingForResult'), BOARD_W/2, BOARD_H/2+30);
      }
      ctx.restore();
    }

    // ── Audio ─────────────────────────────────────────────────────────────
    _playSound(name) {
      if (this._destroyed) return;
      try {
        if (!this._sounds[name]) {
          const a = new Audio(`${this.soundBase}/${name}.ogg`);
          a.volume = 0.45; a.preload = 'auto';
          this._sounds[name] = a;
        }
        const a = this._sounds[name].cloneNode();
        const release = () => { this._playing.delete(a); a.onended = a.onerror = null; };
        a.onended = a.onerror = release; this._playing.add(a);
        a.volume = 0.45; a.play().catch(release);
      } catch (_) { /* sound is optional (autoplay policy, closed context) */ }
    }
  }

  global.PeggleEngine = PeggleEngine;
})(typeof window !== 'undefined' ? window : globalThis);
