/**
 * MUGEN Stage Loader
 * Parses a stage .def file, loads the associated .sff sprite sheet,
 * and returns a Stage object ready for rendering.
 *
 * Stage DEF format reference: https://www.elecbyte.com/mugendocs/bg-tut.html
 */

import { parseSff } from './sff-parser.js';
import { fetchMugenResource, safeMugenFileUrl } from './safe-url.js';

// Session-level cache to avoid re-fetching the same stage
const _stageCache = new Map(); // `folder:defFile` → Promise<Stage>

/**
 * Load a MUGEN stage by folder and def filename.
 * @param {string} folder    - Stage sub-folder name (e.g. "Minecraft Village")
 * @param {string} defFile   - .def filename (e.g. "NPC Village.def")
 * @param {string} [sffFile] - .sff filename (override); if omitted, taken from def
 * @returns {Promise<Stage>}
 */
export function loadStage(folder, defFile, sffFile = null) {
  const key = `${folder}:${defFile}`;
  if (_stageCache.has(key)) return _stageCache.get(key);
  const promise = _loadStage(folder, defFile, sffFile);
  _stageCache.set(key, promise);
  promise.catch(() => _stageCache.delete(key));
  return promise;
}

async function _loadStage(folder, defFile, knownSff) {
  const base = `/mugen-stages/${encodeURIComponent(folder)}`;

  // 1. Fetch and parse .def
  const defText = await fetchMugenResource(safeMugenFileUrl(base, defFile))
    .then(r => { if (!r.ok) throw new Error(`Stage def fetch failed: ${r.status}`); return r.text(); });

  const stageDef = parseStageDef(defText);

  // 2. Resolve SFF filename: prefer known (from API), else parse from def, else error
  const rawSpr = stageDef.spr ?? '';
  // spr path may be MUGEN-root-relative (e.g. "stages/NPC Village.sff"); use basename
  const sffName = knownSff ?? _basename(rawSpr) ?? null;
  if (!sffName) throw new Error('Stage SFF not found');

  const sffBuf = await fetchMugenResource(safeMugenFileUrl(base, sffName)).then(r => {
    if (!r.ok) throw new Error(`Stage SFF fetch failed: ${r.status}`);
    return r.arrayBuffer();
  });

  // 3. Decode sprites (no .act palette needed — stages typically use v2 PNG or embedded palettes)
  const sprites = await parseSff(sffBuf, { isStage: true });

  // 4. Resolve music URL: extract basename from bgmusic path (MUGEN paths use MUGEN-root conventions)
  const musicBasename = _basename(stageDef.bgmusic);
  const bgMusicUrl    = musicBasename ? `${base}/${encodeURIComponent(musicBasename)}` : null;

  return {
    folder,
    defFile,
    name:       stageDef.name,
    localcoord: stageDef.localcoord,
    // WinMUGEN hires stages (hires=1, no explicit localcoord) keep the 320×240
    // MUGEN coordinate system for zoffset/floor positioning, even though sprites
    // are 640×480 pixels.  All others: floorCoordH = localcoord.h.
    floorCoordH: stageDef._hires && !stageDef._localcoordExplicit ? 240 : stageDef.localcoord?.h ?? null,
    p1startx:   stageDef.p1startx,
    p2startx:   stageDef.p2startx,
    camera:     stageDef.camera,
    zoffset:    stageDef.zoffset,
    bgs:        stageDef.bgs,
    anims:      stageDef.anims,
    sprites,
    bgMusicUrl,
  };
}

// ── Parser ──────────────────────────────────────────────────────────────────

function _parseStageInfo(stage, key, val) {
  if (key === 'name') stage.name = _stripQuotes(val);
}

function _parseStageBgDef(stage, key, val) {
  if (key === 'spr') stage.spr = _stripQuotes(val);
}

function _parseStageMusic(stage, key, val) {
  if (key === 'bgmusic') stage.bgmusic = val.trim();
}

function _parseStageStageInfo(stage, key, val) {
  if (key === 'zoffset')    stage.zoffset    = parseInt(val, 10) || stage.zoffset;
  if (key === 'hires' && parseInt(val, 10) === 1) stage._hires = true;
  if (key === 'localcoord') {
    const [w, h] = val.split(',').map(v => parseInt(v, 10));
    if (w > 0 && h > 0) { stage.localcoord = { w, h }; stage._localcoordExplicit = true; }
  }
}

function _parseStageCamera(stage, key, val) {
  if (key === 'startx')     stage.camera.startX     = _flt(val);
  if (key === 'starty')     stage.camera.startY     = _flt(val);
  if (key === 'boundleft')  stage.camera.boundLeft  = _flt(val);
  if (key === 'boundright') stage.camera.boundRight = _flt(val);
  if (key === 'boundhigh')  stage.camera.boundHigh  = _flt(val);
  if (key === 'boundlow')   stage.camera.boundLow   = _flt(val);
}

function _parseStagePlayerInfo(stage, key, val) {
  if (key === 'p1startx') stage.p1startx = _flt(val);
  if (key === 'p2startx') stage.p2startx = _flt(val);
}

/**
 * Parse a stage .def file text into a structured object.
 * @param {string} text
 */
export function parseStageDef(text) {
  const result = _newStageDefResult();
  const ctx = { section: '', currentBg: null, currentAction: null };
  for (const line of _stageDefLines(text)) _parseStageDefLine(line, result, ctx);
  _finalizeStageDef(result, ctx);
  return result;
}

function _newStageDefResult() {
  return {
    name:        '',
    spr:         null,
    bgmusic:     null,
    localcoord:  { w: 320, h: 240 },
    _localcoordExplicit: false,
    _hires:      false,
    zoffset:     200,
    p1startx:    null,
    p2startx:    null,
    camera: { startX: 0, startY: 0, boundLeft: 0, boundRight: 0, boundHigh: 0, boundLow: 0 },
    bgs:   [],
    anims: new Map(),
  };
}

function _stageDefLines(text) {
  return text.replace(/\r\n/g, '\n').split('\n').map(l => l.replace(/;.*/g, '').trim());
}

function _parseStageDefLine(line, result, ctx) {
  if (!line) return;
  if (line.startsWith('[')) {
    _parseStageSectionHeader(line, result, ctx);
    return;
  }
  const eqIdx = line.indexOf('=');
  if (eqIdx === -1) {
    _parseStageActionLine(line, ctx);
    return;
  }
  const key = line.slice(0, eqIdx).trim().toLowerCase();
  const val = line.slice(eqIdx + 1).trim();
  _parseStageKeyValue(result, ctx, key, val, line);
}

function _parseStageSectionHeader(line, result, ctx) {
  const header = line.slice(1, line.indexOf(']')).trim().toLowerCase();
  _flushStageBg(result, ctx);
  if (header.startsWith('begin action')) {
    _beginStageAction(header, result, ctx);
    return;
  }
  if (header === 'end action') {
    ctx.section = '';
    ctx.currentAction = null;
    return;
  }
  if (header.startsWith('bg ') || header === 'bg') {
    ctx.currentBg = _defaultBg(header.slice(2).trim());
    ctx.section = 'bg';
    return;
  }
  ctx.section = header;
}

function _beginStageAction(header, result, ctx) {
  const actionNo = parseInt(header.split(' ')[2], 10) || 0;
  ctx.currentAction = [];
  result.anims.set(actionNo, ctx.currentAction);
  ctx.section = 'action';
}

function _parseStageActionLine(line, ctx) {
  if (ctx.section !== 'action' || ctx.currentAction === null) return;
  const frame = _parseAirFrame(line);
  if (frame) ctx.currentAction.push(frame);
}

function _parseStageKeyValue(result, ctx, key, val, line) {
  switch (ctx.section) {
    case 'info':       _parseStageInfo(result, key, val); break;
    case 'bgdef':      _parseStageBgDef(result, key, val); break;
    case 'music':      _parseStageMusic(result, key, val); break;
    case 'stageinfo':  _parseStageStageInfo(result, key, val); break;
    case 'camera':     _parseStageCamera(result, key, val); break;
    case 'playerinfo': _parseStagePlayerInfo(result, key, val); break;
    case 'bg':         if (ctx.currentBg) _parseBgKey(ctx.currentBg, key, val); break;
    case 'action':     _parseStageActionLine(line, ctx); break;
  }
}

function _flushStageBg(result, ctx) {
  if (ctx.currentBg === null) return;
  result.bgs.push(ctx.currentBg);
  ctx.currentBg = null;
}

function _finalizeStageDef(result, ctx) {
  _flushStageBg(result, ctx);
  if (result._hires && !result._localcoordExplicit) {
    result.localcoord = { w: 640, h: 480 };
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _defaultBg(name) {
  return {
    name,
    type:        'normal',
    spriteno:    [0, 0],
    actionno:    -1,
    layerno:     0,
    start:       [0, 0],
    delta:       [1, 1],
    velocity:    [0, 0],
    trans:       'none',
    alpha:       null,      // [src, dst] for addalpha (0-256 range)
    mask:        0,
    tile:        [0, 0],
    tilespacing: [0, 0],
    window:      null,      // null = no clipping
    xscale:      null,      // parallax only
    yscalestart: 100,
    yscaledelta: 0,
    // Animation state (runtime)
    _animTick:   0,
    _animFrame:  0,
  };
}

function _parseBgKey(bg, key, val) {
  switch (key) {
    case 'type':        bg.type = val.trim().toLowerCase(); break;
    case 'layerno':     bg.layerno = parseInt(val, 10) || 0; break;
    case 'actionno':    bg.actionno = parseInt(val, 10); break;
    case 'mask':        bg.mask = parseInt(val, 10) || 0; break;
    case 'trans':       bg.trans = val.trim().toLowerCase(); break;
    case 'yscalestart': bg.yscalestart = _flt(val); break;
    case 'yscaledelta': bg.yscaledelta = _flt(val); break;
    default:            _parseBgVecKey(bg, key, val); break;
  }
}

function _parseBgVecKey(bg, key, val) {
  switch (key) {
    case 'alpha':       _bgParseAlpha(bg, val); break;
    case 'spriteno':    _bgParseSpriteNo(bg, val); break;
    case 'start':       bg.start = val.split(',').map(v => _flt(v)); break;
    case 'delta':       _bgParseDelta(bg, val); break;
    case 'velocity':    _bgParseVelocity(bg, val); break;
    case 'tile':        _bgParseTile(bg, val); break;
    case 'tilespacing': _bgParseTileSpacing(bg, val); break;
    case 'window':      _bgParseWindow(bg, val); break;
    case 'xscale':      _bgParseXscale(bg, val); break;
  }
}

function _bgParseAlpha(bg, val) {
  const [src, dst] = val.split(',').map(v => parseInt(v.trim(), 10));
  bg.alpha = [isNaN(src) ? 256 : src, isNaN(dst) ? 256 : dst];
}

function _bgParseSpriteNo(bg, val) {
  const [g, i] = val.split(',').map(v => parseInt(v.trim(), 10));
  bg.spriteno = [isNaN(g) ? 0 : g, isNaN(i) ? 0 : i];
}

function _bgParseDelta(bg, val) {
  const [dx, dy] = val.split(',').map(v => _flt(v));
  bg.delta = [isNaN(dx) ? 1 : dx, isNaN(dy) ? 1 : dy];
}

function _bgParseVelocity(bg, val) {
  const [vx, vy] = val.split(',').map(v => _flt(v));
  bg.velocity = [isNaN(vx) ? 0 : vx, isNaN(vy) ? 0 : vy];
}

function _bgParseTile(bg, val) {
  const [tx, ty] = val.split(',').map(v => parseInt(v.trim(), 10));
  bg.tile = [isNaN(tx) ? 0 : tx, isNaN(ty) ? 0 : ty];
}

function _bgParseTileSpacing(bg, val) {
  const [tsx, tsy] = val.split(',').map(v => parseInt(v.trim(), 10));
  bg.tilespacing = [isNaN(tsx) ? 0 : tsx, isNaN(tsy) ? 0 : tsy];
}

function _bgParseWindow(bg, val) {
  const parts = val.split(',').map(v => _flt(v));
  if (parts.length === 4) bg.window = parts;
}

function _bgParseXscale(bg, val) {
  const [top, bot] = val.split(',').map(v => _flt(v));
  bg.xscale = [isNaN(top) ? 100 : top, isNaN(bot) ? 100 : bot];
}

/** Parse a single AIR frame line: `g,i, ox,oy, ticks[, flipH[, flipV]]` */
function _parseAirFrame(line) {
  const parts = line.split(',').map(v => v.trim());
  if (parts.length < 5) return null;
  const [g, i, ox, oy, ticks] = parts.map(v => parseInt(v, 10));
  if (isNaN(g) || isNaN(i) || isNaN(ticks)) return null;
  const flipH = parts[5]?.includes('H') ?? false;
  const flipV = parts[5]?.includes('V') ?? false;
  return { g, i, ox: isNaN(ox) ? 0 : ox, oy: isNaN(oy) ? 0 : oy, ticks: Math.max(1, ticks), flipH, flipV };
}

function _stripQuotes(s) {
  return s.replace(/^["']|["']$/g, '').trim();
}

function _basename(p) {
  if (!p) return null;
  const parts = p.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || null;
}

function _flt(s) {
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}
