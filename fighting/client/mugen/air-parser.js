// ChaOS — MUGEN AIR file parser
//
// Parses the plain-text .air animation file and returns a Map of all actions.
//
// Output: Map<actionNum, Frame[]>
// Frame: {
//   g: number,        sprite group
//   i: number,        sprite image index
//   ox: number,       x draw offset
//   oy: number,       y draw offset
//   dur: number,      duration in ticks (-1 = hold until changed)
//   flipH: boolean,   H flag
//   flipV: boolean,   V flag
//   blend: null | { type:'add'|'sub'|'alpha', src:number, dst:number }
//                     null = normal draw; 'add' = additive; 'sub' = subtractive;
//                     'alpha' = AS<src>D<dst> (alpha blend)
//   clsn1: Rect[],    attack hitboxes (Clsn1) — active when present
//   clsn2: Rect[],    hurtboxes (Clsn2) — body vulnerable zones
// }
// Rect: { x1, y1, x2, y2 } — relative to character axis

export function parseAir(text) {
  const ctx = _airContext();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split(';')[0].trim();
    if (line) _parseAirLine(line, ctx);
  }
  return ctx.actions;
}

function _airContext() {
  return {
    actions: new Map(),
    currentAction: null,
    currentFrames: null,
    pendingClsn1: [],
    pendingClsn2: [],
    defaultClsn1: [],
    defaultClsn2: [],
    readingClsn: null,
    clsnCount: 0,
    clsnRead: 0,
    clsnBuf: [],
    pendingLoopStart: false,
    pendingBlend: null,
    interpolateBlend: false,
  };
}

function _parseAirLine(line, ctx) {
  if (_copyAirAction(line, ctx)) return;
  if (_readBlendDirective(line, ctx)) return;
  if (_beginAirAction(line, ctx)) return;
  if (ctx.currentAction === null) return;
  if (_beginClsnRead(line, ctx)) return;
  if (ctx.readingClsn && _readClsnBox(line, ctx)) return;
  if (ctx.readingClsn) ctx.readingClsn = null;
  if (_readLoopStart(line, ctx)) return;
  _readAirFrame(line, ctx);
}

function _copyAirAction(line, ctx) {
  const copyMatch = line.match(/^Copy\s+Action\s+(\d+)/i);
  if (!copyMatch || ctx.currentFrames === null) return false;
  const src = ctx.actions.get(parseInt(copyMatch[1], 10));
  if (src) {
    for (const f of src) ctx.currentFrames.push({ ...f, clsn1: [...f.clsn1], clsn2: [...f.clsn2] });
  }
  return true;
}

function _readBlendDirective(line, ctx) {
  if (/^Interpolate\s+Blend/i.test(line)) {
    ctx.interpolateBlend = true;
    return true;
  }
  if (/^Trans\s*=\s*Add/i.test(line)) return _setAirBlend(ctx, { type:'add', src:256, dst:256 });
  if (/^Trans\s*=\s*Sub/i.test(line)) return _setAirBlend(ctx, { type:'sub', src:256, dst:256 });
  if (/^Trans\s*=\s*None/i.test(line)) {
    ctx.pendingBlend = null;
    ctx.interpolateBlend = false;
    return true;
  }
  return false;
}

function _setAirBlend(ctx, blend) {
  ctx.pendingBlend = blend;
  return true;
}

function _beginAirAction(line, ctx) {
  const actionMatch = line.match(/^\[Begin Action\s+(\d+)\]/i);
  if (!actionMatch) return false;
  ctx.currentAction = parseInt(actionMatch[1], 10);
  ctx.currentFrames = ctx.actions.has(ctx.currentAction) ? [] : [];
  if (!ctx.actions.has(ctx.currentAction)) ctx.actions.set(ctx.currentAction, ctx.currentFrames);
  _resetActionState(ctx);
  return true;
}

function _resetActionState(ctx) {
  ctx.pendingClsn1 = [];
  ctx.pendingClsn2 = [];
  ctx.defaultClsn1 = [];
  ctx.defaultClsn2 = [];
  ctx.readingClsn = null;
  ctx.clsnCount = 0;
  ctx.clsnRead = 0;
  ctx.clsnBuf = [];
  ctx.pendingLoopStart = false;
  ctx.pendingBlend = null;
  ctx.interpolateBlend = false;
}

function _beginClsnRead(line, ctx) {
  const clsnHeader = line.match(/^Clsn([12])Default\s*:\s*(\d+)/i)
    || line.match(/^Clsn([12])\s*:\s*(\d+)/i);
  if (!clsnHeader) return false;

  const isDefault = /Default/i.test(clsnHeader[0]);
  const clsnKind = clsnHeader[1] === '1' ? 'clsn1' : 'clsn2';
  ctx.readingClsn = isDefault ? `${clsnKind}_default` : clsnKind;
  ctx.clsnCount = parseInt(clsnHeader[2], 10);
  ctx.clsnRead = 0;
  ctx.clsnBuf = [];
  return true;
}

function _readClsnBox(line, ctx) {
  const boxMatch = line.match(/^Clsn[12]\s*\[\s*\d+\s*\]\s*=\s*([-\d]+)\s*,\s*([-\d]+)\s*,\s*([-\d]+)\s*,\s*([-\d]+)/i);
  if (!boxMatch) return false;
  ctx.clsnBuf.push(_clsnRect(boxMatch));
  ctx.clsnRead++;
  if (ctx.clsnRead >= ctx.clsnCount) _commitClsnRead(ctx);
  return true;
}

function _clsnRect(match) {
  return {
    x1: parseInt(match[1], 10),
    y1: parseInt(match[2], 10),
    x2: parseInt(match[3], 10),
    y2: parseInt(match[4], 10),
  };
}

function _commitClsnRead(ctx) {
  const boxes = [...ctx.clsnBuf];
  if (ctx.readingClsn === 'clsn1_default') ctx.defaultClsn1 = boxes;
  else if (ctx.readingClsn === 'clsn2_default') ctx.defaultClsn2 = boxes;
  else if (ctx.readingClsn === 'clsn1') ctx.pendingClsn1 = boxes;
  else ctx.pendingClsn2 = boxes;
  ctx.readingClsn = null;
}

function _readLoopStart(line, ctx) {
  if (!/^loopstart$/i.test(line)) return false;
  ctx.pendingLoopStart = true;
  return true;
}

function _readAirFrame(line, ctx) {
  const frameMatch = line.match(/^(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)(?:\s*,\s*([HVhv]*)(?:\s*,\s*([A-Za-z0-9]+))?)?/);
  if (!frameMatch) return false;
  const frame = _airFrameFromMatch(frameMatch, ctx);
  if (ctx.pendingLoopStart) {
    ctx.currentFrames._loopStart = ctx.currentFrames.length;
    ctx.pendingLoopStart = false;
  }
  ctx.currentFrames.push(frame);
  ctx.pendingClsn1 = [];
  ctx.pendingClsn2 = [];
  return true;
}

function _airFrameFromMatch(match, ctx) {
  const flags = match[6] || '';
  const frameBlend = _frameBlend((match[7] || '').trim().toUpperCase(), ctx);
  return {
    g: parseInt(match[1], 10),
    i: parseInt(match[2], 10),
    ox: parseInt(match[3], 10),
    oy: parseInt(match[4], 10),
    dur: parseInt(match[5], 10),
    flipH: /H/i.test(flags),
    flipV: /V/i.test(flags),
    blend: frameBlend ?? null,
    clsn1: ctx.pendingClsn1.length ? ctx.pendingClsn1 : (ctx.defaultClsn1.length ? ctx.defaultClsn1 : []),
    clsn2: ctx.pendingClsn2.length ? ctx.pendingClsn2 : (ctx.defaultClsn2.length ? ctx.defaultClsn2 : []),
  };
}

function _frameBlend(blendStr, ctx) {
  let frameBlend = ctx.pendingBlend;
  if (blendStr) frameBlend = _parseBlendString(blendStr, frameBlend);
  if (blendStr && ctx.interpolateBlend) ctx.pendingBlend = frameBlend;
  return frameBlend;
}

function _parseBlendString(blendStr, fallback) {
  if (blendStr === 'A') return { type:'add', src:256, dst:256 };
  if (blendStr === 'S') return { type:'sub', src:256, dst:256 };
  if (/^A[0-9]/.test(blendStr)) return _numberedBlend(blendStr, /^A[S]?(\d*)D(\d*)/i, 'add');
  if (/^S[S]?/.test(blendStr)) return _numberedBlend(blendStr, /^SS?(\d*)D(\d*)/i, 'sub');
  if (/^AS/.test(blendStr) || /^AD/.test(blendStr)) {
    const m = blendStr.match(/^A[S]?(\d*)D?(\d*)/i);
    if (m) return { type:'alpha', src:parseInt(m[1] || '256', 10), dst:parseInt(m[2] || '256', 10) };
  }
  return fallback;
}

function _numberedBlend(blendStr, regex, type) {
  const m = blendStr.match(regex);
  return m
    ? { type, src:parseInt(m[1] || '256', 10), dst:parseInt(m[2] || '256', 10) }
    : { type, src:256, dst:256 };
}