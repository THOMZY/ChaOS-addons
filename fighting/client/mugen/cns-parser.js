// ChaOS — MUGEN CNS file parser
//
// Parses one or more plain-text .cns files and extracts:
//   - Character constants ([Data], [Size], [Velocity], [Movement], [Constants])
//   - [RemapPreset X] sprite remap presets
//   - Attack states: for each Statedef with movetype=A, captures anim number
//     and the first HitDef controller (damage, hitstop, knockback, hitstun)
//
// Usage:
//   const { stats, attacks, stateDefs, charConstants, remapPresets } =
//         parseCns([mainCnsText, attacksCnsText, specialsCnsText, ...]);
//
// Output:
//   stats          — character numeric constants
//   attacks        — Map<stateNum, AttackDef>
//   stateDefs      — Map<stateNum, StateDef>
//   charConstants  — Map<name, float>  ([Constants] block)
//   remapPresets   — Map<presetName, Map<"g_i", "g_i">>  ([RemapPreset X])
//
// AttackDef: {
//   stateNum, anim, type, hitDef, projDef, snd,
//   attr: string,      e.g. 'S,NA' — attack attribute
//   fall: boolean,     true if hitDef specifies fall=1
// }
// HitDef: {
//   damage, guardDamage,        chip damage when blocked
//   pauseAttacker, pauseDefender,
//   groundHitTime, airHitTime,
//   groundVelocity, groundVelocityY,
//   airVelocity: [vx, vy],
//   downVelocity: [vx, vy],     KO/downed knockback
//   guardVelocity: number,      knockback when blocked
//   groundType, airType,
//   guardable,
//   fall: boolean,              true = causes hard knockdown
//   hitflag: string,            e.g. 'MAFDP'
//   guardflag: string,          e.g. 'MA'
//   attr: string,               e.g. 'S,NA'
//   hitsound: [g, i],
//   guardsound: [g, i],
//   sparkno: {fromChar, id} | null,
//   guardSparkno: {fromChar, id} | null,
//   sparkxy: [x, y],
//   dizzyPointsAdd: number,     points added to opponent dizzy bar per hit
//   guardPointsAdd: number,     points removed from opponent guard bar per hit
//   redLifeAdd: number,         red life added to attacker per hit
// }
// ProjDef: { animId, hitAnimId, vx, vy, ox, oy, hitDef }

export function parseCns(texts) {
  const stats        = _defaultStats();
  const attacks      = new Map();
  const stateDefs    = new Map();
  const charConstants = new Map();   // [Constants] block
  const remapPresets  = new Map();   // [RemapPreset X] blocks

  for (const text of texts) {
    _parseText(text, stats, attacks, charConstants, remapPresets);
    _parseStateDefs(text, stateDefs);
  }

  return { stats, attacks, stateDefs, charConstants, remapPresets };
}

// ── Default stats (MUGEN baseline) ──────────────────────────────────────────
function _defaultStats() {
  return {
    // [Data]
    life:          1000,
    attack:        100,
    defence:       100,
    maxPower:      3000,
    dizzyPoints:   1000,   // Ikemen-GO dizzy meter (same as life by default)
    guardPoints:   1000,   // Ikemen-GO guard meter
    hitsoundChannel:  -1, // -1 = auto-assign
    guardsoundChannel: -1,
    // [Size]
    groundFront:   15,
    groundBack:    15,
    height:        60,
    headPos:       [0, -80],
    midPos:        [0, -45],
    drawOffset:    [0, 0],
    xscale:        1,
    yscale:        1,
    // stand/crouch/air/down sizebox — [x1,y1,x2,y2] relative to axis
    standSizebox:  null,
    crouchSizebox: null,
    airSizebox:    null,
    downSizebox:   null,
    // push / depth
    weight:        100,
    pushFactor:    1.0,
    depth:         0,
    attackDepth:   0,
    // attack.dist
    attackDistWidth:  160,
    attackDistHeight: 0,
    attackDistDepth:  0,
    // proj.attack.dist
    projAttackDistWidth:  60,
    projAttackDistHeight: 0,
    projAttackDistDepth:  0,
    // [Velocity]  (MUGEN units: pixels per tick at 60fps)
    walkFwd:       3,
    walkBack:      -2.5,
    runFwd:        6,
    jumpNeu:       [0, -9],
    jumpFwd:       3,
    jumpBack:      -3,
    // air gethit KO velocities
    airGethitKoAdd:  [0, 0],
    airGethitKoYmin: -9,
    groundGethitKoXmul: 0.68,
    groundGethitKoAdd:  [0, 0],
    groundGethitKoYmin: -9,
    // [Movement]
    yaccel:         0.44,   // gravity per tick²
    standFriction:  0.85,
    crouchFriction: 0.82,
    airJumps:       0,
    airJumpHeight:  0,
  };
}

// ── Flush current attack state ───────────────────────────────────────────────
function _flushAttack(st) {
  if (st.stateNum !== null && st.stateMoveType === 'A' && st.stateAnim >= 0) {
    st.parsedAttacks.push({
      stateNum: st.stateNum, anim: st.stateAnim, type: st.stateType,
      hitDef:  { ...st.hitDefBuf },
      projDef: st.hasProjectile ? { ...st.projBuf } : null,
      snd:     st.statePlaySnd  ? { ...st.statePlaySnd } : null,
      attr:    st.stateAttr,
      fall:    st.stateFall,
    });
  }
  st.stateNum         = null;
  st.stateAnim        = -1;
  st.stateMoveType    = '';
  st.stateType        = 'S';
  st.inStateDefHeader = false;
  st.inHitDef         = false;
  st.hitDefBuf        = {};
  st.inProjectile     = false;
  st.projBuf          = {};
  st.hasProjectile    = false;
  st.inPlaySnd        = false;
  st.statePlaySnd     = null;
  st.stateAttr        = '';
  st.stateFall        = false;
}

// ── Detect controller type (type=HitDef / Projectile / PlaySnd) ─────────────
function _detectControllerType(val, st) {
  const vl = val.trim().toLowerCase();
  if (vl === 'hitdef') {
    st.inHitDef = true; st.inProjectile = false; st.inPlaySnd = false;
    st.hitDefBuf = _defaultHitDef();
  } else if (vl === 'projectile') {
    st.inProjectile = true; st.inHitDef = false; st.inPlaySnd = false;
    st.projBuf = _defaultProjBuf(); st.hasProjectile = true;
  } else if (vl === 'playsnd') {
    st.inPlaySnd = true; st.inHitDef = false; st.inProjectile = false;
  }
}

// ── Section header parser ────────────────────────────────────────────────────
function _handleSectionHeader(line, st, remapPresets) {
  const secMatch = line.match(/^\[([^\]]+)\]/);
  if (!secMatch) return false;
  const sec = secMatch[1].trim();

  // [State ...] sub-controllers within a Statedef — NOT top-level sections
  if (/^State\b/i.test(sec) && !/^Statedef/i.test(sec)) {
    st.inHitDef         = false;
    st.inProjectile     = false;
    st.inPlaySnd        = false;
    st.inStateDefHeader = false;
    return true;
  }

  // [RemapPreset X]
  if (/^RemapPreset\b/i.test(sec)) {
    if (st.inRemapPreset && st.remapPresetName) remapPresets.set(st.remapPresetName, st.remapBuf);
    _flushAttack(st);
    st.inRemapPreset   = true;
    st.inConstants     = false;
    st.remapPresetName = sec.replace(/^RemapPreset\s*/i, '').trim();
    st.remapBuf        = new Map();
    st.section         = 'remappreset';
    st.stateNum        = null;
    return true;
  }

  // Top-level section change: flush any pending attack state
  if (/^Statedef/i.test(sec)  || /^Data$/i.test(sec)   || /^Size$/i.test(sec) ||
      /^Velocity$/i.test(sec) || /^Movement$/i.test(sec) || /^Constants$/i.test(sec)) {
    if (st.inRemapPreset && st.remapPresetName) {
      remapPresets.set(st.remapPresetName, st.remapBuf);
      st.remapBuf = new Map();
    }
    st.inRemapPreset = false;
    _flushAttack(st);
  }

  if (/^Constants$/i.test(sec)) {
    st.inConstants = true;
    st.section     = 'constants';
    st.stateNum    = null;
    return true;
  }
  st.inConstants = false;

  const sdMatch = sec.match(/^Statedef\s+(-?\d+)/i);
  if (sdMatch) {
    st.stateNum         = parseInt(sdMatch[1], 10);
    st.section          = 'statedef';
    st.inStateDefHeader = true;
  } else {
    st.section  = sec.toLowerCase().replace(/\s+/g, '');
    st.stateNum = null;
  }
  st.inHitDef = false;
  return true;
}

// ── Key=value section handlers ───────────────────────────────────────────────
function _handleConstantsValue(key, val, charConstants) {
  const floatVal = parseFloat(val);
  if (!isNaN(floatVal)) charConstants.set(key, floatVal);
  return true;
}

function _handleRemapValue(rawLine, key, val, st) {
  const remapKv = rawLine.match(/^(-?\d+)\s*,\s*(-?\d+)\s*=\s*(-?\d+)\s*,\s*(-?\d+)/);
  if (remapKv) {
    st.remapBuf.set(`${remapKv[1]}_${remapKv[2]}`, `${remapKv[3]}_${remapKv[4]}`);
  }
  return true;
}

function _handleDataValue(key, val, stats) {
  if (key === 'life')                   stats.life           = _num(val);
  if (key === 'attack')                 stats.attack         = _num(val);
  if (key === 'defence')                stats.defence        = _num(val);
  if (key === 'power')                  stats.maxPower       = _num(val);
  if (key === 'dizzypoints')            stats.dizzyPoints    = _num(val);
  if (key === 'guardpoints')            stats.guardPoints    = _num(val);
  if (key === 'hitsound.channel')       stats.hitsoundChannel    = _num(val);
  if (key === 'guardsound.channel')     stats.guardsoundChannel  = _num(val);
  return true;
}

function _handleSizeValue(key, val, stats) {
  switch (key) {
    case 'ground.front':            stats.groundFront        = _num(val); break;
    case 'ground.back':             stats.groundBack         = _num(val); break;
    case 'height':                  stats.height             = _num(val); break;
    case 'head.pos':                stats.headPos            = _vec2(val); break;
    case 'mid.pos':                 stats.midPos             = _vec2(val); break;
    case 'draw.offset':             stats.drawOffset         = _vec2(val); break;
    case 'xscale':                  stats.xscale             = _num(val); break;
    case 'yscale':                  stats.yscale             = _num(val); break;
    case 'stand.sizebox':           stats.standSizebox       = _vec4(val); break;
    case 'crouch.sizebox':          stats.crouchSizebox      = _vec4(val); break;
    case 'air.sizebox':             stats.airSizebox         = _vec4(val); break;
    case 'down.sizebox':            stats.downSizebox        = _vec4(val); break;
    case 'weight':                  stats.weight             = _num(val); break;
    case 'pushfactor':              stats.pushFactor         = _num(val); break;
    case 'depth':                   stats.depth              = _num(val); break;
    case 'attack.depth':            stats.attackDepth        = _num(val); break;
    case 'attack.dist':             stats.attackDistWidth    = _num(val.split(',')[0]); break;
    case 'attack.dist.width':       stats.attackDistWidth    = _num(val); break;
    case 'attack.dist.height':      stats.attackDistHeight   = _num(val); break;
    case 'attack.dist.depth':       stats.attackDistDepth    = _num(val); break;
    case 'proj.attack.dist':        stats.projAttackDistWidth  = _num(val.split(',')[0]); break;
    case 'proj.attack.dist.width':  stats.projAttackDistWidth  = _num(val); break;
    case 'proj.attack.dist.height': stats.projAttackDistHeight = _num(val); break;
    case 'proj.attack.dist.depth':  stats.projAttackDistDepth  = _num(val); break;
  }
  return true;
}

function _handleVelocityValue(key, val, stats) {
  if (key === 'walk.fwd')                 stats.walkFwd              = _num(val.split(',')[0]);
  if (key === 'walk.back')                stats.walkBack             = _num(val.split(',')[0]);
  if (key === 'run.fwd')                  stats.runFwd               = _num(val.split(',')[0]);
  if (key === 'jump.neu')                 stats.jumpNeu              = _vec2(val);
  if (key === 'jump.fwd')                 stats.jumpFwd              = _num(val.split(',')[0]);
  if (key === 'jump.back')                stats.jumpBack             = _num(val.split(',')[0]);
  if (key === 'air.gethit.ko.add')        stats.airGethitKoAdd       = _vec2(val);
  if (key === 'air.gethit.ko.ymin')       stats.airGethitKoYmin      = _num(val);
  if (key === 'ground.gethit.ko.xmul')    stats.groundGethitKoXmul  = _num(val);
  if (key === 'ground.gethit.ko.add')     stats.groundGethitKoAdd    = _vec2(val);
  if (key === 'ground.gethit.ko.ymin')    stats.groundGethitKoYmin   = _num(val);
  return true;
}

function _handleMovementValue(key, val, stats) {
  if (key === 'yaccel')           stats.yaccel         = _num(val);
  if (key === 'stand.friction')   stats.standFriction  = _num(val);
  if (key === 'crouch.friction')  stats.crouchFriction = _num(val);
  if (key === 'airjump.num')      stats.airJumps       = _num(val);
  if (key === 'airjump.height')   stats.airJumpHeight  = _num(val);
  return true;
}

function _handleStatedefHeader(key, val, st) {
  if (key === 'anim') {
    const plain = parseInt(val, 10);
    st.stateAnim = isNaN(plain) ? _lastInt(val) : plain;
    return true;
  }
  if (key === 'movetype') { st.stateMoveType = val.trim().toUpperCase().charAt(0); return true; }
  if (key === 'type')     { st.stateType     = val.trim().toUpperCase().charAt(0); return true; }
  return false;
}

function _handlePlaySndValue(key, val, st) {
  if (key === 'value' && !st.statePlaySnd) {
    const sndStr = val.replace(/^[Ss]/, '');
    const sndParts = sndStr.split(',');
    const sg = parseInt(sndParts[0], 10);
    const si = parseInt(sndParts[1] ?? '0', 10);
    if (!isNaN(sg)) st.statePlaySnd = { g: sg, i: isNaN(si) ? 0 : si };
  }
  return true;
}

function _handleProjectileValue(key, val, st) {
  const pb = st.projBuf;
  switch (key) {
    case 'projanim':        pb.animId    = _num(val); break;
    case 'projhitanim':     pb.hitAnimId = _num(val); break;
    case 'velocity':        { const vp = val.split(','); pb.vx = _num(vp[0]); pb.vy = _num(vp[1] ?? '0'); } break;
    case 'offset':          { const op = val.split(','); pb.ox = _num(op[0]); pb.oy = _num(op[1] ?? '0'); } break;
    case 'damage':          { const dv = val.split(','); pb.hitDef.damage = _num(dv[0]); pb.hitDef.guardDamage = _num(dv[1] ?? '0'); } break;
    case 'pausetime':       { const pts = val.split(','); pb.hitDef.pauseAttacker = _num(pts[0]); pb.hitDef.pauseDefender = _num(pts[1] ?? pts[0]); } break;
    case 'ground.hittime':  pb.hitDef.groundHitTime  = _num(val); break;
    case 'ground.velocity': { const gv = val.split(','); pb.hitDef.groundVelocity = _num(gv[0]); pb.hitDef.groundVelocityY = _num(gv[1] ?? '0'); } break;
    case 'ground.type':     pb.hitDef.groundType     = val.toLowerCase().trim(); break;
    case 'air.velocity':    { const av = val.split(','); pb.hitDef.airVelocity = [_num(av[0]), _num(av[1] ?? '0')]; } break;
    case 'guard.velocity':  pb.hitDef.guardVelocity  = _num(val.split(',')[0]); break;
    case 'guardflag':       { pb.hitDef.guardflag = val.trim().toUpperCase(); pb.hitDef.guardable = pb.hitDef.guardflag !== 'A'; } break;
    case 'fall':            pb.hitDef.fall            = _num(val) !== 0; break;
    case 'attr':            pb.hitDef.attr            = val.trim(); break;
    case 'hitsound':        { const hs = val.replace(/^[Ss]/, '').split(','); pb.hitDef.hitsound = [parseInt(hs[0], 10) || 5, parseInt(hs[1] ?? '0', 10) || 0]; } break;
    case 'guardsound':      { const gs = val.replace(/^[Ss]/, '').split(','); pb.hitDef.guardsound = [parseInt(gs[0], 10) || 6, parseInt(gs[1] ?? '0', 10) || 0]; } break;
  }
  return true;
}

function _handleHitDefValue(key, val, st) {
  const hb = st.hitDefBuf;
  switch (key) {
    case 'damage':         { const dv = val.split(','); hb.damage = _num(dv[0]); hb.guardDamage = _num(dv[1] ?? '0'); } break;
    case 'pausetime':      { const pts = val.split(','); hb.pauseAttacker = _num(pts[0]); hb.pauseDefender = _num(pts[1] ?? pts[0]); } break;
    case 'ground.type':    hb.groundType       = val.toLowerCase().trim(); break;
    case 'air.type':       hb.airType          = val.toLowerCase().trim(); break;
    case 'hitflag':        hb.hitflag          = val.trim().toUpperCase(); break;
    case 'attr':           { hb.attr = val.trim(); st.stateAttr = val.trim(); } break;
    case 'fall':           { hb.fall = _num(val) !== 0; st.stateFall = _num(val) !== 0; } break;
    case 'guardflag':      { hb.guardflag = val.trim().toUpperCase(); hb.guardable = hb.guardflag !== 'A'; } break;
    case 'dizzy.points':   hb.dizzyPointsAdd   = _num(val); break;
    case 'guard.points':   hb.guardPointsAdd   = _num(val); break;
    case 'redlife':        hb.redLifeAdd       = _num(val); break;
    case 'sparkno':        { const sv = val.trim(); const fromChar = /^[Ss]/.test(sv); const id = parseInt(sv.replace(/^[Ss]/, ''), 10); if (!isNaN(id) && id >= 0) hb.sparkno = { fromChar, id }; } break;
    case 'guard.sparkno':  { const sv = val.trim(); const fromChar = /^[Ss]/.test(sv); const id = parseInt(sv.replace(/^[Ss]/, ''), 10); if (!isNaN(id) && id >= 0) hb.guardSparkno = { fromChar, id }; } break;
    case 'sparkxy':        { const sp = val.split(','); hb.sparkxy = [_num(sp[0]), _num(sp[1] ?? '-60')]; } break;
    default:               _handleHitDefVelocity(key, val, hb); break;
  }
  return true;
}

function _handleHitDefVelocity(key, val, hb) {
  switch (key) {
    case 'ground.hittime': hb.groundHitTime    = _num(val); break;
    case 'ground.velocity':{ const gv = val.split(','); hb.groundVelocity = _num(gv[0]); hb.groundVelocityY = _num(gv[1] ?? '0'); } break;
    case 'air.hittime':    hb.airHitTime       = _num(val); break;
    case 'air.velocity':   { const av = val.split(','); hb.airVelocity = [_num(av[0]), _num(av[1] ?? '0')]; } break;
    case 'down.hittime':   hb.downHitTime      = _num(val); break;
    case 'down.velocity':  { const dv = val.split(','); hb.downVelocity = [_num(dv[0]), _num(dv[1] ?? '0')]; } break;
    case 'guard.velocity': hb.guardVelocity    = _num(val.split(',')[0]); break;
    case 'fall.velocity':  { const fv = val.split(','); hb.fallVelocity = [_num(fv[0]), _num(fv[1] ?? '0')]; } break;
    case 'hitsound':       { const hs = val.replace(/^[Ss]/, '').split(','); hb.hitsound = [parseInt(hs[0], 10) || 5, parseInt(hs[1] ?? '0', 10) || 0]; } break;
    case 'guardsound':     { const gs = val.replace(/^[Ss]/, '').split(','); hb.guardsound = [parseInt(gs[0], 10) || 6, parseInt(gs[1] ?? '0', 10) || 0]; } break;
  }
}

// ── Key=value dispatcher ─────────────────────────────────────────────────────
function _handleKeyValue(line, st, stats, charConstants) {
  const kv = line.match(/^([a-zA-Z_.]+)\s*=\s*(.+)/);
  if (!kv) return false;
  const key = kv[1].toLowerCase().trim();
  const val = kv[2].trim();

  if (st.section === 'constants')  return _handleConstantsValue(key, val, charConstants);
  if (st.section === 'remappreset') return _handleRemapValue(kv[0], key, val, st);
  if (st.section === 'data')       return _handleDataValue(key, val, stats);
  if (st.section === 'size')       return _handleSizeValue(key, val, stats);
  if (st.section === 'velocity')   return _handleVelocityValue(key, val, stats);
  if (st.section === 'movement')   return _handleMovementValue(key, val, stats);
  if (st.section === 'statedef' && st.stateNum !== null && st.inStateDefHeader)
    return _handleStatedefHeader(key, val, st);
  if (key === 'type') { _detectControllerType(val, st); return true; }
  if (st.inPlaySnd)    return _handlePlaySndValue(key, val, st);
  if (st.inProjectile) return _handleProjectileValue(key, val, st);
  if (st.inHitDef)     return _handleHitDefValue(key, val, st);
  return false;
}

// ── Main parser ──────────────────────────────────────────────────────────────
function _parseText(text, stats, attacks, charConstants, remapPresets) {
  const lines = text.split(/\r?\n/);
  const st = {
    section:           null,
    stateNum:          null,
    stateAnim:         -1,
    stateMoveType:     '',
    stateType:         'S',
    inStateDefHeader:  false,
    inHitDef:          false,
    hitDefBuf:         {},
    inProjectile:      false,
    projBuf:           {},
    hasProjectile:     false,
    inPlaySnd:         false,
    statePlaySnd:      null,
    stateAttr:         '',
    stateFall:         false,
    inConstants:       false,
    inRemapPreset:     false,
    remapPresetName:   '',
    remapBuf:          new Map(),
    parsedAttacks:     [],
  };

  for (const raw of lines) {
    const line = raw.split(';')[0].trim();
    if (!line) continue;
    if (_handleSectionHeader(line, st, remapPresets)) continue;
    _handleKeyValue(line, st, stats, charConstants);
  }

  _flushAttack(st);

  for (const atk of st.parsedAttacks) {
    if (!attacks.has(atk.stateNum)) {
      attacks.set(atk.stateNum, atk);
    }
  }
}

function _defaultHitDef() {
  return {
    damage:           50,
    guardDamage:      0,        // chip damage when blocked
    pauseAttacker:    8,
    pauseDefender:    8,
    groundHitTime:    12,
    airHitTime:       0,        // falls back to groundHitTime when 0
    groundVelocity:  -4,
    groundVelocityY:  0,
    groundType:       'high',
    airType:          'high',
    airVelocity:      [-2, -3],
    downVelocity:     [0, 0],   // KO/knocked-down phase velocity
    downHitTime:      0,
    guardVelocity:    -2,       // knockback X when hit is blocked
    fall:             false,    // hard knockdown
    fallVelocity:     [0, 0],
    hitflag:          'MAFDP',  // what states can be hit: M=stand A=air F=fall D=down P=projectile
    guardflag:        'MA',     // what stances can guard: M=stand A=air (L=low, O=overhead)
    attr:             '',
    guardable:        true,
    hitsound:         [5, 0],   // group 5 = standard hit sounds
    guardsound:       [6, 0],   // group 6 = guard sounds
    sparkno:          null,     // {fromChar, id} — null = procedural fallback
    guardSparkno:     null,
    sparkxy:          [0, -60],
    dizzyPointsAdd:   0,        // Ikemen-GO: dizzy pts removed from defender per hit
    guardPointsAdd:   0,        // Ikemen-GO: guard pts removed per blocked hit
    redLifeAdd:       0,        // Ikemen-GO: red life added to attacker per hit
  };
}

function _defaultProjBuf() {
  return {
    animId:   -1,
    hitAnimId: -1,
    vx: 3, vy: 0,
    ox: 30, oy: -50,
    hitDef: _defaultHitDef(),
  };
}

function _num(s) {
  return parseFloat(s) || 0;
}

// Extract the last integer from a MUGEN expression string.
// e.g. "ifelse(prevstateno=[100,105],201,200)" → 200
function _lastInt(s) {
  const m = s.match(/\d+/g);
  return m ? parseInt(m[m.length - 1], 10) : -1;
}

function _vec2(s) {
  const parts = s.split(',');
  return [_num(parts[0]), _num(parts[1] ?? '0')];
}

function _vec4(s) {
  const parts = s.split(',');
  return [_num(parts[0]), _num(parts[1] ?? '0'), _num(parts[2] ?? '0'), _num(parts[3] ?? '0')];
}

// ── StateDef / Controller parser ─────────────────────────────────────────────
// Parses ALL statedefs from every CNS text into a shared Map<stateNum, StateDef>.
// StateDef: { num, anim, type, movetype, physics, ctrl, velset:[vx,vy], controllers:[] }
// Controller: { type, triggerall:[], triggers:string[][], ...params }
// triggers is an array of trigger GROUPS: triggers[i] is one group (AND-within, OR-between groups).

function _parseCtrlVec2(s, def = 0) {
  const p = String(s ?? '0,0').split(',');
  const v0 = parseFloat(p[0]);
  const v1 = parseFloat(p[1] ?? String(def));
  return [isNaN(v0) ? def : v0, isNaN(v1) ? def : v1];
}

// ── Controller builder helpers (one per controller type) ────────────────────

function _ctrlHelper(raw, base) {
  return { ...base,
    stateno:     parseInt(raw.stateno,     10) || 0,
    id:          parseInt(raw.id,          10) || 0,
    name:        (raw.name ?? '').replace(/^"|"$/g, ''),
    pos:         _parseCtrlVec2(raw.pos),
    postype:     (raw.postype ?? 'p1').toLowerCase().trim(),
    facing:      parseInt(raw.facing,      10) || 1,
    ownpal:      (raw.ownpal ?? '0') !== '0',
    removetime:  raw.removetime  != null ? (parseInt(raw.removetime,  10) || 0) : -2,
    sprpriority: parseInt(raw.sprpriority, 10) || 0,
    scale:       _parseCtrlVec2(raw.scale ?? '1,1', 1),
    bindtime:    raw.bindtime    != null ? (parseInt(raw.bindtime,    10) || 0) : 0,
  };
}

function _ctrlChangeAnim(raw, base) {
  return { ...base,
    value:     parseInt(raw.value, 10) || 0,
    valueExpr: (raw.value ?? '0').trim(),
    elem:      parseInt(raw.elem,  10) || 1,
  };
}

function _ctrlVelSet(raw, base) {
  return { ...base,
    x: raw.x !== undefined ? parseFloat(raw.x) : null,
    y: raw.y !== undefined ? parseFloat(raw.y) : null,
  };
}

function _ctrlDestroySelf(raw, base) {
  return { ...base };
}

function _ctrlExplod(raw, base) {
  return { ...base,
    anim:       parseInt(raw.anim,       10) || 0,
    id:         parseInt(raw.id,         10) || 0,
    pos:        _parseCtrlVec2(raw.pos),
    postype:    (raw.postype ?? 'p1').toLowerCase().trim(),
    facing:     parseInt(raw.facing,     10) || 1,
    vfacing:    parseInt(raw.vfacing,    10) || 1,
    bindtime:   raw.bindtime   != null ? (parseInt(raw.bindtime,   10) || 0) : 1,
    removetime: raw.removetime != null ? (parseInt(raw.removetime, 10) || 0) : -2,
    scale:      _parseCtrlVec2(raw.scale ?? '1,1', 1),
  };
}

function _ctrlRemoveExplod(raw, base) {
  return { ...base,
    id: raw.id != null ? parseInt(raw.id, 10) : -1,
  };
}

function _ctrlAngleDraw(raw, base) {
  const rawScale = (raw.scale ?? '').trim();
  const ci       = rawScale.indexOf(',');
  const sxStr    = ci >= 0 ? rawScale.slice(0, ci).trim() : (rawScale || '1');
  const syStr    = ci >= 0 ? rawScale.slice(ci + 1).trim() : (rawScale || '1');
  return { ...base,
    angleExpr:  (raw.value ?? '0').trim(),
    scaleXExpr: sxStr || '1',
    scaleYExpr: syStr || '1',
  };
}

function _ctrlPlaySnd(raw, base) {
  const sv = (raw.value ?? '0,0').replace(/^[Ss]/, '');
  const sp = sv.split(',');
  return { ...base,
    g:       parseInt(sp[0],        10) || 0,
    i:       parseInt(sp[1] ?? '0', 10) || 0,
    channel: parseInt(raw.channel,  10) || -1,
    volume:  parseInt(raw.volume,   10) || 100,
  };
}

function _ctrlChangeState(raw, base) {
  return { ...base,
    value:     parseInt(raw.value, 10) || 0,
    valueExpr: (raw.value ?? '0').trim(),
    ctrl:  raw.ctrl !== undefined ? parseInt(raw.ctrl, 10) : -1,
  };
}

function _ctrlVarSet(raw, base) {
  const isFloat  = raw._varIsFloat ?? (base.type === 'fvarset');
  const idx      = raw._varIdx != null ? raw._varIdx : (parseInt(raw.v ?? raw.value ?? '0', 10) || 0);
  const valueStr = (raw._varValue ?? raw.value ?? '0').trim();
  return { ...base, isFloat, idx, value: parseFloat(valueStr) || 0, valueExpr: valueStr };
}

function _ctrlParentVarSet(raw, base) {
  const isFloat  = base.type === 'parentfvarset';
  const idx      = raw._varIdx != null ? raw._varIdx : (parseInt(raw.v ?? raw.value ?? '0', 10) || 0);
  const valueStr = (raw._varValue ?? raw.value ?? '0').trim();
  return { ...base, isFloat, idx, value: parseFloat(valueStr) || 0, valueExpr: valueStr };
}

function _ctrlTrans(raw, base) {
  return { ...base,
    trans:  (raw.trans  ?? 'addalpha').toLowerCase().trim(),
    // alpha = sourceAlpha, destAlpha  (0–256 each; 256 = opaque/full)
    alpha:  _parseCtrlVec2(raw.alpha ?? '256,256').map(v => Math.round(v)),
  };
}

function _ctrlAssertSpecial(raw, base) {
  return { ...base,
    flag:  (raw.flag  ?? '').toLowerCase().trim(),
    flag2: (raw.flag2 ?? '').toLowerCase().trim(),
  };
}

function _ctrlBindTo(raw, base) {
  return { ...base,
    pos: _parseCtrlVec2(raw.pos ?? '0,0'),
  };
}

function _buildCtrl(raw) {
  const type = raw.type?.toLowerCase().trim();
  if (!type) return null;
  // Convert triggerGroups object {1:[...], 2:[...]} → sorted array of groups string[][]
  const groups = raw.triggerGroups ?? {};
  const triggers = Object.keys(groups).sort((a,b) => +a - +b).map(k => groups[k]);
  const base = { type, triggerall: raw.triggerall ?? [], triggers };
  return _dispatchCtrlBuilder(type, raw, base) ?? null;
}

function _dispatchCtrlBuilder(type, raw, base) {
  switch (type) {
    case 'helper':        return _ctrlHelper(raw, base);
    case 'changeanim':    return _ctrlChangeAnim(raw, base);
    case 'changeanim2':   return _ctrlChangeAnim(raw, base);
    case 'velset':        return _ctrlVelSet(raw, base);
    case 'veladd':        return _ctrlVelSet(raw, base);
    case 'posadd':        return _ctrlVelSet(raw, base);
    case 'posset':        return _ctrlVelSet(raw, base);
    case 'destroyself':   return _ctrlDestroySelf(raw, base);
    case 'explod':        return _ctrlExplod(raw, base);
    case 'removeexplod':  return _ctrlRemoveExplod(raw, base);
    case 'angledraw':     return _ctrlAngleDraw(raw, base);
    case 'playsnd':       return _ctrlPlaySnd(raw, base);
    case 'changestate':   return _ctrlChangeState(raw, base);
    case 'varset':        return _ctrlVarSet(raw, base);
    case 'fvarset':       return _ctrlVarSet(raw, base);
    case 'parentvarset':  return _ctrlParentVarSet(raw, base);
    case 'parentfvarset': return _ctrlParentVarSet(raw, base);
    case 'trans':         return _ctrlTrans(raw, base);
    case 'assertspecial': return _ctrlAssertSpecial(raw, base);
    case 'bindtoroot':    return _ctrlBindTo(raw, base);
    case 'bindtoparent':  return _ctrlBindTo(raw, base);
    default:              return null;
  }
}

function _parseStateDefSection(line, curSD) {
  const sec = line.match(/^\[([^\]]+)\]/);
  if (!sec) return null;
  const s = sec[1].trim();
  if (/^Statedef\s+-?\d+/i.test(s)) {
    const m = s.match(/-?\d+/);
    return {
      type: 'statedef',
      sd: {
        num: parseInt(m[0], 10),
        anim: -1, type: 'S', movetype: 'I', physics: 'N', ctrl: 1,
        velset: [0, 0], controllers: [],
      },
    };
  }
  if (/^State\b/i.test(s) && !/^Statedef/i.test(s)) {
    return { type: 'state', inSD: curSD !== null };
  }
  return { type: 'other' };
}

function _parseStateDefHeaderParam(key, val, curSD) {
  if (key === 'anim')     { const n = parseInt(val, 10); curSD.anim = isNaN(n) ? _lastInt(val) : n; return true; }
  if (key === 'type')     { curSD.type     = (val.trim().toUpperCase()[0] ?? 'S'); return true; }
  if (key === 'movetype') { curSD.movetype = (val.trim().toUpperCase()[0] ?? 'I'); return true; }
  if (key === 'physics')  { curSD.physics  = (val.trim().toUpperCase()[0] ?? 'N'); return true; }
  if (key === 'ctrl')     { curSD.ctrl     = parseInt(val, 10) || 0; return true; }
  if (key === 'velset')   { const p = val.split(','); curSD.velset = [parseFloat(p[0]) || 0, parseFloat(p[1] ?? '0') || 0]; return true; }
  return false;
}

function _parseControllerParam(key, val, rawBlk) {
  if (key === 'triggerall')            { rawBlk.triggerall.push(val); return; }
  if (/^trigger(\d+)$/.test(key))      { const n = +key.slice(7); (rawBlk.triggerGroups[n] ??= []).push(val); return; }
  rawBlk[key] = val;
}

function _parseVarAltLine(line, curSD, rawBlk) {
  if (!curSD || rawBlk === null) return false;
  const varAlt = line.match(/^(f?var)\s*\(\s*(\d+)\s*\)\s*=\s*(.+)/i);
  if (!varAlt) return false;
  rawBlk._varIsFloat = varAlt[1].toLowerCase() === 'fvar';
  rawBlk._varIdx     = parseInt(varAlt[2], 10);
  rawBlk._varValue   = varAlt[3].trim();
  return true;
}

function _parseStateDefs(text, stateDefs) {
  if (!text) return;
  const lines = text.split(/\r?\n/);
  let curSD  = null;
  let rawBlk = null;

  function flushBlock() {
    if (!curSD || rawBlk === null) return;
    const ctrl = _buildCtrl(rawBlk);
    if (ctrl) curSD.controllers.push(ctrl);
    rawBlk = null;
  }
  function flushSD() {
    flushBlock();
    if (curSD) stateDefs.set(curSD.num, curSD);  // last-wins: st1-st9 override cns= statedefs
    curSD = null;
  }

  for (const raw of lines) {
    const line = raw.split(';')[0].trim();
    if (!line) continue;

    const sec = _parseStateDefSection(line, curSD);
    if (sec) {
      if (sec.type === 'other' || sec.type === 'statedef') flushSD();
      if (sec.type === 'state') flushBlock();
      if (sec.type === 'statedef') { curSD = sec.sd; rawBlk = null; }
      if (sec.type === 'state' && sec.inSD) rawBlk = { triggerall: [], triggerGroups: {} };
      continue;
    }

    const kv = line.match(/^([a-zA-Z_.0-9]+)\s*=\s*(.+)/);
    if (!kv) {
      _parseVarAltLine(line, curSD, rawBlk);
      continue;
    }

    const key = kv[1].toLowerCase().trim();
    const val = kv[2].trim();

    if (curSD && rawBlk === null) {
      _parseStateDefHeaderParam(key, val, curSD);
    } else if (curSD && rawBlk !== null) {
      _parseControllerParam(key, val, rawBlk);
    }
  }
  flushSD();
}
