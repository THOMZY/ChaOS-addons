// ChaOS — MUGEN character loader
//
// Orchestrates all parsers to load a complete MUGEN character from its folder.
// Fetches all required files from /mugen/<folder>/ served by Express.
//
// Usage:
//   const char = await loadMugenChar('GOku');
//
// Returns a Character object ready for use by the fighting engine.
//
// Character: {
//   folder:   string,
//   name:     string,          display name
//   sprites:  Map<key, SpriteEntry>,   from sff-parser
//   anims:    Map<actionNum, Frame[]>, from air-parser
//   stats:    object,                  from cns-parser
//   attacks:  Map<stateNum, AttackDef>,
//   commands: Command[],               from cmd-parser
//   stateMap: Map<cmdName, stateNum>,
//   // Derived convenience fields
//   moveMap:  Map<internalName, MoveBinding>,
// }
//
// MoveBinding: {
//   stateNum: number,
//   anim:     number,
//   hitDef:   HitDef,
//   cmdName:  string | null,   name in stateMap / null for normal moves
// }

import { parseSff, parseSffPreview, parseSffPortrait } from './sff-parser.js';
import { fetchMugenResource, safeMugenFileUrl, safeMugenUrl } from './safe-url.js';
import { parseAir }    from './air-parser.js';
import { parseCns }    from './cns-parser.js';
import { parseCmd }    from './cmd-parser.js';
import { parseSnd, resumeSndCtx, getSndAudioCtx } from './snd-parser.js';

export { resumeSndCtx, getSndAudioCtx };

// Standard MUGEN action numbers used by our engine
// Reference: https://www.elecbyte.com/mugendocs/air.html
export const ANIM = {
  IDLE:         0,
  CROUCH_START: 10,
  CROUCH:       11,
  CROUCH_END:   12,
  WALK_FWD:     20,
  WALK_BACK:    21,
  RUN_FWD:      100,  // run/dash forward (distinct from walk)
  RUN_BACK:     105,  // backdash
  JUMP_START:   40,
  JUMP_AIR:     41,
  JUMP_FWD:     42,
  JUMP_BACK:    43,
  JUMP_LAND:    47,
  INTRO:        191,
  WIN:          180,
  WIN_2:        181,
  WIN_3:        182,
  LOSE:         170,
  LOSE_KO:      5150,
  // Hitstun / KO chain
  HIT_STAND:    5000,
  HIT_CROUCH:   5010,
  HIT_AIR:      5020,
  FALL:         5030,  // hard knockdown (fall)
  FALL_RECOVER: 5040,
  FALL_LAND:    5060,  // landing on the ground while falling
  DIZZY:        5500,  // Ikemen-GO dizzy state
  // Guard
  GUARD_STAND:  130,
  GUARD_CROUCH: 131,
  GUARD_AIR:    132,   // Ikemen-GO air guard
  // KO ground sequence
  KO_SLIDE:     5100,  // sliding on ground after KO hit
  KO_BOUNCE:    5110,  // bouncing up slightly
  KO_LIE:       5120,  // lying still
};

// Internal move names → standard MUGEN state numbers (MUGEN convention: X=LP, Y=MP, Z=HP)
// Tried in order; first match found in the character's attack map wins.
const STANDARD_MOVES = {
  // Stand normals
  stand_lp:  [200, 201, 203],   // X = LP
  stand_mp:  [210, 202],        // Y = MP
  stand_hp:  [220],             // Z = HP
  // Crouch normals
  crouch_lp: [400],             // d.X = LP
  crouch_mp: [410],             // d.Y = MP
  crouch_hp: [420],             // d.Z = HP
  // Air normals
  air_lp:    [600],             // j.X = LP
  air_mp:    [610],             // j.Y = MP
  air_hp:    [620],             // j.Z = HP
};

// Lightweight preview loader — downloads only the idle frame sprite via HTTP Range
// requests instead of the entire SFF. Returns a SpriteEntry or null.
export async function loadCharPreview(folder, knownDefFile = null) {
  const base = `/mugen/${encodeURIComponent(folder)}`;

  const defCandidates = knownDefFile ? [`${base}/${knownDefFile}`] : [];
  defCandidates.push(
    `${base}/${folder.toLowerCase()}.def`,
    `${base}/${folder}.def`,
    `${base}/${folder.toLowerCase().replace(/[_\s]/g, '')}.def`,
  );
  let defText = null;
  for (const url of defCandidates) { defText = await _fetchText(url); if (defText) break; }
  if (!defText) defText = await _fetchFirstDef(base);
  if (!defText) return null;

  const fileRefs = _parseDef(defText);

  // Get the idle animation's first frame group/image from the AIR file
  let group = 0, image = 0;
  if (fileRefs.anim) {
    const airText = await _fetchText(`${base}/${fileRefs.anim}`);
    if (airText) {
      const anims = parseAir(airText);
      const idleFrames = anims.get(ANIM.IDLE);
      if (idleFrames?.length) { group = idleFrames[0].g; image = idleFrames[0].i; }
    }
  }

  return { sprite: await parseSffPreview(`${base}/${fileRefs.sprite}`, group, image), portraitscale: fileRefs.portraitscale ?? 1 };
}

// Portrait cache: avoids re-fetching SFF on repeated char-select opens.
const _portraitCache = new Map(); // key → Promise<{sprite,isPortrait}|null>

// Loads the MUGEN lifebar portrait (group 9000 image 1, or image 0 as fallback).
// Falls back to idle frame if no portrait sprite exists.
export async function loadCharPortrait(folder, knownDefFile = null) {
  const cacheKey = `${folder}:${knownDefFile ?? ''}`;
  if (_portraitCache.has(cacheKey)) return _portraitCache.get(cacheKey);
  const promise = _loadCharPortrait(folder, knownDefFile);
  _portraitCache.set(cacheKey, promise);
  promise.catch(() => _portraitCache.delete(cacheKey));
  return promise;
}

async function _loadCharPortrait(folder, knownDefFile = null) {
  const base = `/mugen/${encodeURIComponent(folder)}`;

  const defCandidates = knownDefFile ? [`${base}/${knownDefFile}`] : [];
  defCandidates.push(
    `${base}/${folder.toLowerCase()}.def`,
    `${base}/${folder}.def`,
    `${base}/${folder.toLowerCase().replace(/[_\s]/g, '')}.def`,
  );
  let defText = null;
  for (const url of defCandidates) { defText = await _fetchText(url); if (defText) break; }
  if (!defText) defText = await _fetchFirstDef(base);
  if (!defText) return null;

  const fileRefs = _parseDef(defText);
  const sffUrl   = `${base}/${fileRefs.sprite}`;

  // Try proper portrait first, fall back to idle frame
  const portrait = await parseSffPortrait(sffUrl);
  if (portrait) return { sprite: portrait, isPortrait: true };

  // Idle-frame fallback (same logic as loadCharPreview)
  let group = 0, image = 0;
  if (fileRefs.anim) {
    const airText = await _fetchText(`${base}/${fileRefs.anim}`);
    if (airText) {
      const anims = parseAir(airText);
      const idleFrames = anims.get(ANIM.IDLE);
      if (idleFrames?.length) { group = idleFrames[0].g; image = idleFrames[0].i; }
    }
  }
  const sprite = await parseSffPreview(sffUrl, group, image);
  return sprite ? { sprite, isPortrait: false } : null;
}

// Session-level cache: avoids decoding the same SFF twice when both players
// pick the same character. Key = "folder:defFile". The character object (sprites,
// anims, etc.) is read-only after loading, so sharing between fighters is safe.
const _charCache = new Map(); // key → Promise<Character>

export async function loadMugenChar(folder, onProgress, knownDefFile = null) {
  const cacheKey = `${folder}:${knownDefFile ?? ''}`;
  if (_charCache.has(cacheKey)) return _charCache.get(cacheKey);
  const promise = _loadMugenChar(folder, onProgress, knownDefFile);
  _charCache.set(cacheKey, promise);
  // Remove from cache on error so a retry can re-attempt
  promise.catch(() => _charCache.delete(cacheKey));
  return promise;
}

async function _loadMugenChar(folder, onProgress, knownDefFile = null) {
  const base = `/mugen/${encodeURIComponent(folder)}`;
  const prog = onProgress ?? (() => {});

  prog('games.fighting.progress.loadingDefinition', 0);
  const fileRefs = await _loadMugenDef(base, folder, knownDefFile);
  const sprites  = await _loadMugenSprites(base, fileRefs, prog);
  const anims    = await _loadMugenAnimations(base, fileRefs, prog);
  const cns      = await _loadMugenCns(base, fileRefs, prog);
  const cmd      = await _loadMugenCommands(base, fileRefs, prog);
  const sounds   = await _loadMugenSounds(base, fileRefs, prog);
  const movelistTexts = await _loadMugenMovelists(base, fileRefs, prog);

  prog('games.fighting.progress.buildingMoveMap', 97);
  const moveMap = _buildMoveMap(cns.attacks, cmd.stateMap, anims, cns.stateDefs);

  prog('games.fighting.progress.ready', 100);

  return {
    folder,
    name:          fileRefs.name,
    lifebarname:   fileRefs.lifebarname || fileRefs.name,
    portraitscale: fileRefs.portraitscale,
    ikemenversion: fileRefs.ikemenversion,
    fightfxPrefix: fileRefs.fightfxPrefix,
    charMap:       fileRefs.charMap,   // Map<string, number> from [Map] section
    sprites,
    anims,
    stats:         cns.stats,
    attacks:       cns.attacks,
    stateDefs:     cns.stateDefs,
    commands:      cmd.commands,
    stateMap:      cmd.stateMap,
    cmdDefaults:   cmd.defaults,
    moveMap,
    sounds,
    charConstants: cns.charConstants,
    remapPresets:  cns.remapPresets,
    movelists:     movelistTexts,
    fonts:         fileRefs.fonts,   // Map<index, path>
  };
}

async function _loadMugenDef(base, folder, knownDefFile) {
  const defText = await _findMugenDefText(base, folder, knownDefFile);
  if (!defText) throw new Error(`No .def file found in MUGEN/${folder}`);
  return _parseDef(defText);
}

async function _findMugenDefText(base, folder, knownDefFile) {
  const defCandidates = knownDefFile ? [`${base}/${knownDefFile}`] : [];
  defCandidates.push(
    `${base}/${folder.toLowerCase()}.def`,
    `${base}/${folder}.def`,
    `${base}/${folder.toLowerCase().replace(/[_\s]/g, '')}.def`,
  );
  for (const url of defCandidates) {
    const defText = await _fetchText(url);
    if (defText) return defText;
  }
  return _fetchFirstDef(base);
}

async function _loadMugenSprites(base, fileRefs, prog) {
  prog('games.fighting.progress.loadingSprites', 10);
  const sffBuf = await _fetchBinary(`${base}/${fileRefs.sprite}`);
  prog('games.fighting.progress.decodingSprites', 30);
  return parseSff(sffBuf);
}

async function _loadMugenAnimations(base, fileRefs, prog) {
  prog('games.fighting.progress.loadingAnimations', 60);
  const airText = await _fetchText(`${base}/${fileRefs.anim}`);
  return parseAir(airText ?? '');
}

async function _loadMugenCns(base, fileRefs, prog) {
  prog('games.fighting.progress.loadingCharacterData', 70);
  const cnsFiles = [fileRefs.cns, ...(fileRefs.extraCns ?? [])].filter(Boolean);
  const cnsTexts = await Promise.all(cnsFiles.map(f => _fetchText(`${base}/${f}`)));
  return parseCns(cnsTexts.filter(Boolean));
}

async function _loadMugenCommands(base, fileRefs, prog) {
  prog('games.fighting.progress.loadingCommands', 85);
  const cmdText = await _fetchText(`${base}/${fileRefs.cmd}`);
  return parseCmd(cmdText ?? '');
}

async function _loadMugenSounds(base, fileRefs, prog) {
  prog('games.fighting.progress.loadingSounds', 90);
  if (!fileRefs.sound) return new Map();
  try {
    const sndBuf = await _fetchBinary(`${base}/${fileRefs.sound}`);
    return sndBuf ? await parseSnd(sndBuf) : new Map();
  } catch {
    return new Map();
  }
}

async function _loadMugenMovelists(base, fileRefs, prog) {
  prog('games.fighting.progress.loadingMovelist', 93);
  const movelistTexts = [];
  for (const mlFile of fileRefs.movelists) {
    const t = await _fetchText(`${base}/${mlFile}`);
    if (t) movelistTexts.push(t);
  }
  return movelistTexts;
}

// ── Parse .def file for file references ──────────────────────────────────────
function _parseDef(text) {
  const refs = {
    name:          '',
    lifebarname:   '',
    portraitscale: 1,
    ikemenversion: '',
    fightfxPrefix: '',
    sprite:        '',
    anim:          '',
    cns:           '',
    cmd:           '',
    sound:         '',
    defaultPal:    '',
    extraCns:      [],
    movelists:     [],         // movelist, movelist0..N
    fonts:         new Map(),  // index → filename
    charMap:       new Map(),  // [Map] key → float
    _palDefaults:  [],         // palette defaults from [Info]
  };

  let inInfo  = false;
  let inFiles = false;
  let inMap   = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split(';')[0].trim();

    const sec = line.match(/^\[([^\]]+)\]/);
    if (sec) {
      const s = sec[1].toLowerCase().trim();
      inInfo  = s === 'info';
      inFiles = s === 'files';
      inMap   = s === 'map';
      continue;
    }

    const kv = line.match(/^([a-zA-Z_.0-9]+)\s*=\s*(.+)/);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const val = kv[2].replace(/;.*$/, '').trim().replace(/^"|"$/g, '').replace(/\\\\/g, '/');

    if (inMap) {
      _parseDefMap(key, val, refs);
    } else if (inInfo) {
      _parseDefInfo(key, val, refs);
    } else if (inFiles) {
      _parseDefFiles(key, val, refs);
    }
    // Other sections are ignored
  }

  if (!refs.name) refs.name = 'Unknown';
  return refs;
}

/** Parse a [Map] section key=value pair — stores float in charMap. */
function _parseDefMap(key, val, refs) {
  const fv = parseFloat(val);
  if (!isNaN(fv)) refs.charMap.set(key, fv);
}

/** Parse a [Info] section key=value pair. */
function _parseDefInfo(key, val, refs) {
  if (key === 'displayname' || key === 'name') refs.name = refs.name || val;
  if (key === 'lifebarname')    refs.lifebarname   = val;
  if (key === 'portraitscale')  refs.portraitscale = parseFloat(val) || 1;
  if (key === 'ikemenversion')  refs.ikemenversion  = val;
  if (key === 'fightfx.prefix') refs.fightfxPrefix = val;
  if (key === 'pal.defaults') {
    refs._palDefaults = val.split(',').map(n => parseInt(n.trim(), 10)).filter(n => !isNaN(n));
  }
}

/** Parse a [Files] section key=value pair. */
function _parseDefFiles(key, val, refs) {
  const directRefs = { sprite: 'sprite', anim: 'anim', cmd: 'cmd', sound: 'sound' };
  if (directRefs[key]) refs[directRefs[key]] = val;
  else if (key === 'cns') _addPrimaryCns(refs, val, 'push');
  else if (key === 'st') _addPrimaryCns(refs, val, 'unshift');
  else if (_isExtraStateFile(key)) refs.extraCns.push(val);
  else if (_isMovelistKey(key)) refs.movelists.push(val);
  else _parseDefSpecialFile(key, val, refs);
}

function _addPrimaryCns(refs, val, extraMode) {
  if (!refs.cns) refs.cns = val;
  else if (extraMode === 'push') refs.extraCns.push(val);
  else if (extraMode === 'unshift') refs.extraCns.unshift(val);
}

function _isExtraStateFile(key) {
  return key.startsWith('st') && key !== 'st' && key !== 'stcommon';
}

function _isMovelistKey(key) {
  return key === 'movelist' || /^movelist\d+$/.test(key);
}

function _parseDefSpecialFile(key, val, refs) {
  const fontMatch = key.match(/^font(\d)$/);
  if (fontMatch) refs.fonts.set(parseInt(fontMatch[1], 10), val);
  if (key === 'fx') refs.extraCns.push(val);
  _parseDefPaletteFile(key, val, refs);
}

function _parseDefPaletteFile(key, val, refs) {
  const palMatch = key.match(/^pal(\d+)$/);
  if (!palMatch) return;
  const palNum = parseInt(palMatch[1], 10);
  const preferred = refs._palDefaults[0] ?? 1;
  if (palNum === preferred) refs.defaultPal = val;
  if (!refs.defaultPal && palNum === 1) refs.defaultPal = val;
}

// ── Build the moveMap from attacks + stateMap + anims ────────────────────────
// Maps internal names (stand_lp, stand_hp, etc.) to actual move data.
// Also maps special move names from CMD stateMap.
// Falls back to dynamic assignment by attack type if standard state numbers
// don't match (characters with non-conventional state numbering).

// ── Refactored from a single complexity-36 function into focused helpers ──────
// Each helper handles one phase of the move-map building pipeline:

/**
 * Phase 1: Normal moves — try standard MUGEN state numbers first
 * (stand_lp→200, stand_mp→210, stand_hp→220, etc.)
 */
function _processStandardMoves(attacks, anims, moveMap) {
  for (const [internalName, candidates] of Object.entries(STANDARD_MOVES)) {
    for (const stateNum of candidates) {
      const atk = attacks.get(stateNum);
      if (atk && anims.has(atk.anim)) {
        moveMap.set(internalName, {
          stateNum, anim: atk.anim, hitDef: atk.hitDef, cmdName: null,
          projDef: atk.projDef ?? null, snd: atk.snd ?? null, powerCost: 0,
        });
        break;
      }
    }
  }
}

/**
 * Phase 2: Dynamic fallback — if standard numbers found nothing, assign the first
 * available S/C/A-type attacks sorted by stateNum.
 */
function _processDynamicFallback(attacks, anims, moveMap) {
  const SLOTS = [
    ['S', ['stand_lp',  'stand_mp',  'stand_hp' ]],
    ['C', ['crouch_lp', 'crouch_mp', 'crouch_hp']],
    ['A', ['air_lp',    'air_mp',    'air_hp'   ]],
  ];

  const byType = { S: [], C: [], A: [] };
  for (const atk of attacks.values()) {
    const t = atk.type ?? 'S';
    if (anims.has(atk.anim) && (t === 'S' || t === 'C' || t === 'A')) {
      byType[t].push(atk);
    }
  }
  for (const g of ['S', 'C', 'A']) byType[g].sort((a, b) => a.stateNum - b.stateNum);

  for (const [typeKey, names] of SLOTS) {
    const pool = byType[typeKey].length ? byType[typeKey] : byType['S'];
    for (let i = 0; i < names.length; i++) {
      if (moveMap.has(names[i])) continue;
      if (i >= pool.length) break;
      const atk = pool[i];
      moveMap.set(names[i], {
        stateNum: atk.stateNum, anim: atk.anim, hitDef: atk.hitDef, cmdName: null,
        projDef: atk.projDef ?? null, snd: atk.snd ?? null, powerCost: 0,
      });
    }
  }
}

/**
 * Phase 3: Special + super moves — from CMD stateMap.
 * Each entry goes through three fallback strategies in order.
 */
function _processStateMapMoves(stateMap, attacks, anims, stateDefs, moveMap) {
  for (const [cmdName, stateNum] of stateMap) {
    if (cmdName.startsWith('AI')) continue;
    if (cmdName.startsWith('hold') || cmdName === 'recovery') continue;

    const entry = _processAttackAtk(attacks, stateNum, anims, cmdName)
      ?? _processStateDefsForMoveMap(stateNum, stateDefs, anims, cmdName)
      ?? _processHelperFallback(stateNum, attacks, anims, cmdName);

    if (entry) moveMap.set(cmdName, entry);
  }
}

/**
 * Strategy A: Try to use the attack's own animation.
 * Returns a move entry with power-cost gating (super ≥ 2000, special 1000-1999),
 * or null if no valid attack/animation exists.
 */
function _processAttackAtk(attacks, stateNum, anims, cmdName) {
  const atk = attacks.get(stateNum);
  if (!atk || !anims.has(atk.anim)) return null;
  const frames = anims.get(atk.anim);
  if (frames?.length && frames.every(fr => fr.g < 0)) return null;
  const powerCost = stateNum >= 2000 ? 2000 : stateNum >= 1000 ? 1000 : 0;
  return {
    stateNum, anim: atk.anim, hitDef: atk.hitDef, cmdName,
    projDef: atk.projDef ?? null, snd: atk.snd ?? null, powerCost,
  };
}

/**
 * Strategy B: Fall back to the stateDef's animation (handles movetype=I states
 * like Jotaro's stand-on activation state 10820).
 */
function _processStateDefsForMoveMap(stateNum, stateDefs, anims, cmdName) {
  const sd = stateDefs?.get(stateNum);
  if (sd?.anim == null || !anims.has(sd.anim)) return null;
  const frames = anims.get(sd.anim);
  if (frames?.length && frames.every(fr => fr.g < 0)) return null;
  return {
    stateNum, anim: sd.anim, hitDef: null, cmdName,
    projDef: null, snd: null, powerCost: 0,
  };
}

/**
 * Strategy C: Try the +10000 companion state (MUGEN convention for stand-mode
 * moves that redirect to helper states, e.g. StandOut: state 840 → helper 10840).
 */
function _processHelperFallback(stateNum, attacks, anims, cmdName) {
  const helperAtk = attacks.get(stateNum + 10000);
  if (!helperAtk || !anims.has(helperAtk.anim)) return null;
  const frames = anims.get(helperAtk.anim);
  if (frames?.length && frames.every(fr => fr.g < 0)) return null;
  return {
    stateNum: stateNum + 10000, anim: helperAtk.anim, hitDef: null, cmdName,
    projDef: null, snd: null, powerCost: 0,
  };
}

function _buildMoveMap(attacks, stateMap, anims, stateDefs) {
  const moveMap = new Map();
  _processStandardMoves(attacks, anims, moveMap);
  _processDynamicFallback(attacks, anims, moveMap);
  _processStateMapMoves(stateMap, attacks, anims, stateDefs, moveMap);
  return moveMap;
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────
async function _fetchText(url) {
  try {
    const r = await fetchMugenResource(url);
    if (!r.ok) return null;
    const buf = await r.arrayBuffer();
    // Try UTF-8 first; if replacement chars appear the file is likely Shift-JIS
    let text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
    if (text.includes('\uFFFD')) {
      try { text = new TextDecoder('shift-jis').decode(buf); } catch { /* no Shift-JIS decoder: keep the UTF-8 text */ }
    }
    return text;
  } catch { return null; }
}

async function _fetchBinary(url) {
  // cache:'reload' bypasses any stale/partial cache entries (prevents Brave from
  // serving a cached 206 partial response in place of the full file).
  const r = await fetchMugenResource(url, { cache: 'reload' });
  if (!r.ok) throw new Error(`Failed to fetch ${url}: ${r.status}`);
  return await r.arrayBuffer();
}

async function _fetchFirstDef(base) {
  try {
    // Try to get directory listing (won't work if no index, but worth trying)
    const directory = safeMugenUrl(`${base}/`);
    const r = await fetchMugenResource(directory, { credentials: 'same-origin' });
    const html = await r.text();
    const match = html.match(/href="([^"]+\.def)"/i);
    if (match) {
      const fileName = match[1];
      if (!/^[^/\\?#]+\.def$/i.test(fileName)) return null;
      return _fetchText(safeMugenFileUrl(directory, fileName));
    }
  } catch { /* no directory listing: no fallback .def */ }
  return null;
}
