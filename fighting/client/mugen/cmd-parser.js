// ChaOS — MUGEN CMD file parser
//
// Parses the plain-text .cmd file and returns:
//   - commands: Array of parsed command definitions
//   - stateMap: Map<cmdName, stateNum> extracted from [Statedef -1] ChangeState controllers
//   - defaults: object with global CMD defaults (steptime, autogreater, buffer.*)
//
// Command: {
//   name: string,
//   steps: Step[],          parsed input sequence
//   timeWindow: number,     max ticks allowed between first and last step
//   steptime: number,       max ticks per individual step (overrides global)
//   autogreater: boolean,   if true, diagonal inputs satisfy pure cardinal requirements
//   buffer: { hitpause, pauseend, shared }
// }
// Step: {
//   type: 'dir' | 'btn' | 'simultaneous',
//   dirs: string[],   e.g. ['D','F'] for DF
//   btns: string[],   e.g. ['x'] for LP
//   held: boolean,    /$key = must be held ($)
//   released: boolean, ~key = must release (~)
//   charge: number,   minimum hold ticks for /N (charge) notation (0 = normal)
//   or: boolean,      true if this step resulted from | (OR) merging
// }

export function parseCmd(text) {
  const ctx = _cmdParseContext();
  for (const raw of text.split(/\r?\n/)) _parseCmdLine(raw, ctx);
  _pushCommand(ctx);

  // Second pass on Statedef -1: flush incomplete pendingChanges.
  _extractStateMappings(text, ctx.stateMap);
  return { commands: ctx.commands, stateMap: ctx.stateMap, defaults: ctx.defaults };
}

function _cmdParseContext() {
  return {
    commands: [],
    stateMap: new Map(),
    defaults: {
      steptime: 1,
      autogreater: false,
      bufferHitpause: 1,
      bufferPauseend: 1,
      bufferShared: false,
    },
    inStateDef1: false,
    inDefaults: false,
    pendingChange: null,
    buf: {},
  };
}

function _parseCmdLine(raw, ctx) {
  const line = _cleanCmdLine(raw);
  if (!line) return;

  const section = _sectionName(line);
  if (section !== null) return _handleCmdSection(section, ctx);
  if (ctx.inDefaults) return _readDefaultsField(line, ctx.defaults);
  if (!ctx.inStateDef1) return _readCommandField(line, ctx.buf);
  _readInlineStateMapping(line, ctx);
}

function _cleanCmdLine(raw) {
  return raw.split(';')[0].trim();
}

function _sectionName(line) {
  const match = line.match(/^\[([^\]]+)\]/);
  return match ? match[1].trim() : null;
}

function _handleCmdSection(sec, ctx) {
  if (/^Statedef\s+-1/i.test(sec)) return _enterStateDef1(ctx);
  if (/^Defaults$/i.test(sec)) return _enterDefaults(ctx);
  if (/^Command$/i.test(sec)) return _enterCommand(ctx);
  if (ctx.inStateDef1 && /^Statedef/i.test(sec)) ctx.inStateDef1 = false;
  if (ctx.inStateDef1) ctx.pendingChange = null;
  ctx.inDefaults = false;
}

function _enterStateDef1(ctx) {
  _pushCommand(ctx);
  ctx.inStateDef1 = true;
  ctx.inDefaults = false;
}

function _enterDefaults(ctx) {
  _pushCommand(ctx);
  ctx.inStateDef1 = false;
  ctx.inDefaults = true;
  ctx.buf = {};
}

function _enterCommand(ctx) {
  _pushCommand(ctx);
  ctx.inStateDef1 = false;
  ctx.inDefaults = false;
  ctx.buf = {};
}

function _pushCommand(ctx) {
  const { buf, defaults } = ctx;
  if (buf.name && buf.command !== undefined) ctx.commands.push(_commandFromBuffer(buf, defaults));
  ctx.buf = {};
}

function _commandFromBuffer(buf, defaults) {
  return {
    name: buf.name,
    steps: _parseSteps(buf.command),
    timeWindow: buf.time ?? defaults.steptime,
    steptime: buf.steptime ?? defaults.steptime,
    autogreater: buf.autogreater !== undefined ? _truthyCmdFlag(buf.autogreater) : defaults.autogreater,
    buffer: {
      hitpause: _intOrDefault(buf['buffer.hitpause'], defaults.bufferHitpause),
      pauseend: _intOrDefault(buf['buffer.pauseend'], defaults.bufferPauseend),
      shared: buf['buffer.shared'] !== undefined ? buf['buffer.shared'] !== '0' : defaults.bufferShared,
    },
  };
}

function _readDefaultsField(line, defaults) {
  const kv = _cmdKeyValue(line);
  if (!kv) return;
  const { key, val } = kv;
  if (key === 'command.steptime') defaults.steptime = _intOrDefault(val, 1);
  if (key === 'command.time') defaults.steptime = _intOrDefault(val, 1);
  if (key === 'command.autogreater') defaults.autogreater = _truthyCmdFlag(val);
  if (key === 'command.buffer.hitpause') defaults.bufferHitpause = _intOrDefault(val, 1);
  if (key === 'command.buffer.pauseend') defaults.bufferPauseend = _intOrDefault(val, 1);
  if (key === 'command.buffer.shared') defaults.bufferShared = val !== '0';
}

function _readCommandField(line, buf) {
  const kv = _cmdKeyValue(line);
  if (!kv) return;
  const { key, val } = kv;
  if (key === 'name') buf.name = val.replace(/^"|"$/g, '');
  if (key === 'command') buf.command = val;
  if (key === 'time') buf.time = _intOrDefault(val, 1);
  if (key === 'steptime') buf.steptime = _intOrDefault(val, 1);
  if (key === 'autogreater') buf.autogreater = val;
  if (key === 'buffer.hitpause') buf['buffer.hitpause'] = val;
  if (key === 'buffer.pauseend') buf['buffer.pauseend'] = val;
  if (key === 'buffer.shared') buf['buffer.shared'] = val;
}

function _readInlineStateMapping(line, ctx) {
  const kv = _cmdKeyValue(line);
  if (!kv) return;
  const { key, val } = kv;

  if (key === 'type' && val.toLowerCase() === 'changestate') ctx.pendingChange = { value: null, cmds: [] };
  if (!ctx.pendingChange) return;
  _updatePendingChange(ctx.pendingChange, key, val);
  if (key === 'ctrl') _flushPendingChange(ctx.pendingChange, ctx.stateMap, () => { ctx.pendingChange = null; });
}

function _updatePendingChange(pendingChange, key, val) {
  if (key === 'value') {
    const num = parseInt(val, 10);
    if (!isNaN(num)) pendingChange.value = num;
  }
  if (key === 'trigger1' || key.startsWith('trigger')) {
    const cmdMatch = val.match(/command\s*=\s*"([^"]+)"/i);
    if (cmdMatch) pendingChange.cmds.push(cmdMatch[1]);
  }
}

function _flushPendingChange(pendingChange, stateMap, clear) {
  if (pendingChange.value === null || pendingChange.cmds.length === 0) return;
  for (const c of pendingChange.cmds) {
    const safeCmd = String(c);
    if (!stateMap.has(safeCmd)) stateMap.set(safeCmd, pendingChange.value);
  }
  clear();
}

function _cmdKeyValue(line) {
  const kv = line.match(/^([a-zA-Z_.]+)\s*=\s*(.+)/);
  return kv ? { key: kv[1].toLowerCase(), val: kv[2].trim() } : null;
}

function _truthyCmdFlag(value) {
  return value !== '0' && String(value).toLowerCase() !== 'false';
}

function _intOrDefault(value, fallback) {
  return parseInt(value, 10) || fallback;
}
// ── Extract command→state mappings from [Statedef -1] ────────────────────────
// Simpler dedicated pass that looks for [State -1, N] type=ChangeState blocks.
function _extractStateMappings(text, stateMap) {
  const scan = { inSd1: false, value: null, cmds: [], isChange: false };
  for (const raw of text.split(/\r?\n/)) {
    const line = _cleanCmdLine(raw);
    if (!line) continue;

    const section = _sectionName(line);
    if (section !== null) {
      if (_handleMappingSection(section, scan, stateMap)) break;
      continue;
    }
    if (scan.inSd1) _readMappingLine(line, scan);
  }
  _flushStateMapping(scan, stateMap);
}

function _handleMappingSection(sec, scan, stateMap) {
  _flushStateMapping(scan, stateMap);
  if (/^Statedef\s+-1/i.test(sec)) {
    scan.inSd1 = true;
    return false;
  }
  if (/^Statedef/i.test(sec) && scan.inSd1) {
    scan.inSd1 = false;
    return true;
  }
  return false;
}

function _readMappingLine(line, scan) {
  const kv = _cmdKeyValue(line);
  if (!kv) return;
  const { key, val } = kv;
  if (key === 'type') return _setMappingType(scan, val);
  if (key === 'value' && scan.isChange) return _setMappingValue(scan, val);
  if (scan.isChange && key.startsWith('trigger')) _addMappingTrigger(scan, val);
}

function _setMappingType(scan, val) {
  if (val.toLowerCase() === 'changestate') scan.isChange = true;
  else _resetMappingScan(scan);
}

function _setMappingValue(scan, val) {
  const n = parseInt(val, 10);
  if (!isNaN(n)) scan.value = n;
}

function _addMappingTrigger(scan, val) {
  const m = val.match(/command\s*=\s*"([^"]+)"/i);
  if (m) scan.cmds.push(m[1]);
}

function _flushStateMapping(scan, stateMap) {
  if (scan.isChange && scan.value !== null) {
    for (const c of scan.cmds) {
      const safeCmd = String(c);
      if (!stateMap.has(safeCmd)) stateMap.set(safeCmd, scan.value);
    }
  }
  _resetMappingScan(scan);
}

function _resetMappingScan(scan) {
  scan.value = null;
  scan.cmds = [];
  scan.isChange = false;
}
// ── Parse a command string into Step[] ───────────────────────────────────────
// Supported syntax:
//   "~D, DF, F, x"     quarter-circle forward + LP
//   "/$F"              hold forward
//   "x+a"             LP + LK simultaneously
//   "F, F"             double-tap forward (dash)
//   "x|y"             OR: either x or y button counts
//   "L" / "R"          absolute left / absolute right direction
//   "N"                neutral (no directional input)
//   "/30B"             hold back for 30 ticks then release (charge)
//   "~30B"             release back (used after charge)
function _parseSteps(cmdStr) {
  return cmdStr
    .split(',')
    .map(t => t.trim())
    .filter(Boolean)
    .map(_parseStepToken)
    .filter(Boolean);
}

function _parseStepToken(token) {
  if (token.includes('|')) return _parseOrStep(token);
  if (token.includes('+')) return _parseSimultaneousStep(token);
  return _parseChargeStep(token) || _parseSimpleStep(token);
}

function _parseOrStep(token) {
  const mergedDirs = new Set();
  const mergedBtns = new Set();
  let held = false;
  let released = false;

  for (const alt of token.split('|').map(t => t.trim())) {
    const flags = _tokenFlags(alt);
    held = held || flags.held;
    released = released || flags.released;
    _addCleanToken(flags.clean, mergedDirs, mergedBtns);
  }
  if (!mergedDirs.size && !mergedBtns.size) return null;
  return _stepFromParts([...mergedDirs], [...mergedBtns], held, released, 0, true);
}

function _parseSimultaneousStep(token) {
  const dirs = [];
  const btns = [];
  let held = false;
  let released = false;

  for (const part of token.split('+').map(t => t.trim())) {
    const flags = _tokenFlags(part);
    held = held || flags.held;
    released = released || flags.released;
    _addCleanToken(flags.clean, dirs, btns);
  }
  return { type: 'simultaneous', dirs, btns, held, released, charge: 0, or: false };
}

function _parseChargeStep(token) {
  const match = token.match(/^([/~])(\d+)([A-Za-z]+)$/);
  if (!match) return null;
  const raw = match[3].toUpperCase();
  const charge = parseInt(match[2], 10);
  const held = match[1] === '/';
  return _stepForCleanToken(raw, held, !held, charge, false);
}

function _parseSimpleStep(token) {
  const { clean, held, released } = _tokenFlags(token);
  if (clean === 'L' || clean === 'R') return _dirStep([clean], held, released, 0, false);
  if (clean === 'N') return { type: 'neutral', dirs: [], btns: [], held: false, released: false, charge: 0, or: false };
  return _stepForCleanToken(clean, held, released, 0, false);
}

function _tokenFlags(token) {
  return {
    held: token.startsWith('/$') || token.startsWith('$'),
    released: token.startsWith('~'),
    clean: token.replace(/^[~/$]+/, '').toUpperCase(),
  };
}

function _addCleanToken(clean, dirs, btns) {
  if (_isDir(clean)) {
    for (const d of _expandDir(clean)) dirs.add ? dirs.add(d) : dirs.push(d);
  } else if (_isBtn(clean.toLowerCase())) {
    btns.add ? btns.add(clean.toLowerCase()) : btns.push(clean.toLowerCase());
  }
}

function _stepForCleanToken(clean, held, released, charge, or) {
  if (_isDir(clean)) return _dirStep(_expandDir(clean), held, released, charge, or);
  if (_isBtn(clean.toLowerCase())) return _btnStep([clean.toLowerCase()], held, released, charge, or);
  return null;
}

function _stepFromParts(dirs, btns, held, released, charge, or) {
  const type = btns.length && dirs.length ? 'simultaneous' : btns.length ? 'btn' : 'dir';
  return { type, dirs, btns, held, released, charge, or };
}

function _dirStep(dirs, held, released, charge, or) {
  return { type: 'dir', dirs, btns: [], held, released, charge, or };
}

function _btnStep(btns, held, released, charge, or) {
  return { type: 'btn', dirs: [], btns, held, released, charge, or };
}

// Expand a compound direction like "DF" into its canonical dirs array.
// For absolute directions L/R, return as-is.
function _expandDir(s) {
  if (s === 'L' || s === 'R' || s === 'N') return [s];
  const map = { 'UF':['U','F'], 'UB':['U','B'], 'DF':['D','F'], 'DB':['D','B'] };
  return map[s] ? map[s] : [s];
}

const DIRS = new Set(['U','D','F','B','UF','UB','DF','DB','L','R','N']);
const BTNS = new Set(['a','b','c','x','y','z','s']);

function _isDir(s) { return DIRS.has(s.toUpperCase()); }
function _isBtn(s) { return BTNS.has(s.toLowerCase()); }
