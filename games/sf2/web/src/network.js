// ChaOS — SF2 network adapter (runs inside the /sf2/ iframe).
//
// Reads URL params: ?slot=X&roomId=Y&p0=Ryu&p1=Ken
// If those params are present → online mode is active.
//
// Online mode behaviour:
//   - Overrides gameState fighter IDs with p0/p1 URL params
//   - Sends local player's inputs to parent at 30 Hz via postMessage
//   - Receives opponent inputs from parent and injects them as synthetic
//     keyboard events using the opponent's original key layout
//   - Reports round end to parent when the game's finishRound fires

import { controls } from './config/controls.js';
import { Control }  from './constants/control.js';
import { setKeyState } from './engine/InputHandler.js';
import { gameState } from './state/gameState.js';
import { FighterId } from './constants/fighter.js';

// ── URL params ────────────────────────────────────────────────────────────────
const _params  = new URLSearchParams(window.location.search);
const _slotStr = _params.get('slot');

export const onlineSlot  = _slotStr !== null ? parseInt(_slotStr, 10) : -1;
export const onlineRoomId = _params.get('roomId') || null;
export const isOnline     = onlineSlot >= 0 && !!onlineRoomId;

if (isOnline) {
  // Apply character selection from URL params before BattleScene is constructed
  const p0 = _params.get('p0');
  const p1 = _params.get('p1');
  const validChars = Object.values(FighterId);
  if (p0 && validChars.includes(p0)) gameState.fighters[0].id = p0;
  if (p1 && validChars.includes(p1)) gameState.fighters[1].id = p1;
}

// ── Online key map — uses event.key (lowercase), works on any keyboard layout ─
// Each browser has ONE local player; opponent input is injected via setKeyState.
const ONLINE_PHYS = {
  [Control.LEFT]:         'q',
  [Control.RIGHT]:        'd',
  [Control.UP]:           'z',
  [Control.DOWN]:         's',
  [Control.LIGHT_PUNCH]:  'u',
  [Control.MEDIUM_PUNCH]: 'i',
  [Control.HEAVY_PUNCH]:  'o',
  [Control.LIGHT_KICK]:   'j',
  [Control.MEDIUM_KICK]:  'k',
  [Control.HEAVY_KICK]:   'l',
};

const CONTROL_ACTIONS = [
  Control.LEFT, Control.RIGHT, Control.UP, Control.DOWN,
  Control.LIGHT_PUNCH, Control.MEDIUM_PUNCH, Control.HEAVY_PUNCH,
  Control.LIGHT_KICK, Control.MEDIUM_KICK, Control.HEAVY_KICK,
];
const INPUT_FIELD_NAMES = ['left', 'right', 'up', 'down', 'lp', 'mp', 'hp', 'lk', 'mk', 'hk'];

// ── Local input snapshot ──────────────────────────────────────────────────────
// Tracks which ONLINE_PHYS keys are currently held by the local player.
// Also drives the game engine's heldKeys via setKeyState for the local slot.
const _heldLocal = new Set();

// Shared handler — called from both direct keydown/keyup events (when iframe is
// focused) and from sf2:key messages forwarded by the parent page (when it is not).
function _handleLocalKey(rawKey, isDown) {
  const key = rawKey?.toLowerCase();
  if (!key) return;
  const ctrl = CONTROL_ACTIONS.find(c => ONLINE_PHYS[c] === key);
  if (ctrl === undefined) return;
  if (isDown) {
    _heldLocal.add(key);
    setKeyState(controls[onlineSlot].keyboard[ctrl], true);
  } else {
    _heldLocal.delete(key);
    setKeyState(controls[onlineSlot].keyboard[ctrl], false);
  }
}

// Release all locally-held keys (call on blur/visibility-loss so nothing stays stuck).
function _releaseAllLocalKeys() {
  for (const key of _heldLocal) _handleLocalKey(key, false);
  _heldLocal.clear();
}

if (isOnline) {
  window.addEventListener('keydown', (e) => { if (!e.repeat) _handleLocalKey(e.key, true);  });
  window.addEventListener('keyup',   (e) => {                _handleLocalKey(e.key, false); });
  // Firefox (and others) may not fire keyup when focus is lost — release all held keys.
  window.addEventListener('blur', _releaseAllLocalKeys);
  document.addEventListener('visibilitychange', () => { if (document.hidden) _releaseAllLocalKeys(); });
}

function getLocalInputSnapshot() {
  const snap = {};
  CONTROL_ACTIONS.forEach((ctrl, i) => {
    snap[INPUT_FIELD_NAMES[i]] = _heldLocal.has(ONLINE_PHYS[ctrl]);
  });
  return snap;
}

// ── Remote input injection ────────────────────────────────────────────────────
// Drives the game engine's heldKeys directly for the remote slot's virtual keys.
let _prevRemote = {};

function applyRemoteInput(input) {
  if (!input || typeof input !== 'object') return;
  CONTROL_ACTIONS.forEach((ctrl, i) => {
    const field   = INPUT_FIELD_NAMES[i];
    const isDown  = !!input[field];
    const wasDown = !!_prevRemote[field];
    if (isDown !== wasDown) {
      setKeyState(controls[1 - onlineSlot].keyboard[ctrl], isDown);
    }
  });
  _prevRemote = { ...input };
}

// ── Input send loop ───────────────────────────────────────────────────────────
const SEND_INTERVAL = 1000 / 30; // 30 Hz

function sendInput() {
  if (!isOnline) return;
  const input = getLocalInputSnapshot();
  window.parent.postMessage({ type: 'sf2:input', roomId: onlineRoomId, input }, window.location.origin);
}

if (isOnline) {
  setInterval(sendInput, SEND_INTERVAL);
  // Also send immediately on local key events for snappy response
  const physKeys = new Set(CONTROL_ACTIONS.map(c => ONLINE_PHYS[c]));
  window.addEventListener('keydown', (e) => { if (physKeys.has(e.key.toLowerCase())) sendInput(); }, { passive: true });
  window.addEventListener('keyup',   (e) => { if (physKeys.has(e.key.toLowerCase())) sendInput(); }, { passive: true });
}

// ── Receive messages from parent ──────────────────────────────────────────────
window.addEventListener('message', (e) => {
  if (!e.data) return;
  if (e.origin !== window.location.origin || e.source !== window.parent) return;
  if (e.data.type === 'sf2:remote_input') {
    applyRemoteInput(e.data.input);
  } else if (e.data.type === 'sf2:key' && isOnline) {
    // Forwarded by parent page when the iframe doesn't have keyboard focus.
    _handleLocalKey(e.data.key, e.data.isDown);
    sendInput(); // send immediately so the opponent sees the change quickly
  }
});

// ── Round end hook (set by StreetFighterGame.initOnline) ──────────────────────
// Delay reporting to parent so the winner-pose animation has time to play.
let _roundEndSent = false;
window.addEventListener('sf2:round_end_internal', (e) => {
  if (!isOnline || _roundEndSent) return;
  _roundEndSent = true;
  setTimeout(() => {
    window.parent.postMessage({
      type:      'sf2:round_end',
      roomId:    onlineRoomId,
      loserSlot: e.detail.loserSlot,
    }, window.location.origin);
  }, 2500);
});

// ── Forfeit on close ─────────────────────────────────────────────────────────
window.addEventListener('beforeunload', () => {
  if (isOnline) {
    window.parent.postMessage({ type: 'sf2:forfeit', roomId: onlineRoomId }, window.location.origin);
  }
});
