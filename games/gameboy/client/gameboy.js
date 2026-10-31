import { decodeRle, renderIndexedFrame, tintMonochromePalette } from './gameboy-frame-codec.js';
import { shouldStream } from './stream-state.js';
import { gainFromVolume } from './volume.js';
import { getLanguage } from '/core/js/i18n.js';
import { getKeyboardLabel } from '/core/js/games/input/keyboard-layout.js';
// Game Boy window client (ChaOS-addons add-on).
//
// The window manifest gives us an empty body (#gameboy-body); this module
// builds the console there, connects to /gameboy-ws and renders the stream.
// Everything the user controls (power, volume) is local: turning the console
// off only stops *our* stream, the shared game keeps running for others.

const WS_PATH = '/gameboy-ws';
const PROTO = 4;

const SHELL = `
<div class="gb-shell" data-model="DMG">
  <div class="gb-case">
    <div class="gb-art-host"></div>
    <div class="gb-screen" id="gb-screen">
      <canvas id="gb-canvas" width="160" height="144"></canvas>
      <div class="gb-start" id="gb-start" hidden>
        <button type="button" class="gb-startbtn" id="gb-startbtn" aria-label="Allumer la console">▶</button>
        <span class="gb-starttxt">JOUER</span>
      </div>
      <div class="gb-wait" id="gb-wait">CONNEXION…</div>
    </div>
    <div class="gb-utils">
      <div class="gb-power" id="gb-power" role="switch" aria-checked="true" tabindex="0" title="Marche / arrêt"><i></i></div>
      <span class="gb-led" id="gb-led"></span>
      <input class="gb-vol" id="gb-vol" type="range" min="0" max="100" value="75" aria-label="Volume" />
      <span class="gb-vpct" id="gb-volpct">75</span>
      <button class="gb-cart" id="gb-lib" title="Bibliothèque de ROMs" aria-label="Bibliothèque">
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
          <path d="M5 3.5h10.5L19 7v13.5H5z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
          <rect x="8" y="7" width="8" height="4.5" rx="1" fill="none" stroke="currentColor" stroke-width="1.4" />
        </svg>
      </button>
    </div>
  </div>

  <div class="gb-hud"><span id="gb-state">…</span> · <span id="gb-rate">–</span> · <span id="gb-count">–</span> joueur(s)</div>
  <div class="gb-keyboard" aria-label="Commandes clavier">
    <span><kbd>↑ ↓ ← →</kbd> Croix</span>
    <span><kbd data-key-code="KeyX">X</kbd> / <kbd data-key-code="KeyW">W</kbd> A · <kbd data-key-code="KeyZ">Z</kbd> B</span>
    <span><kbd data-key-code="Enter">Enter</kbd> Start · <kbd data-key-code="ShiftLeft">Shift</kbd> Select</span>
    <span class="gb-advance-controls"><kbd data-key-code="KeyQ">Q</kbd> L · <kbd data-key-code="KeyE">E</kbd> R</span>
  </div>
</div>`;

// The controls themselves form the case: no painted controls underneath them.
function caseMarkup(advance) {
  const key = (name, label, className, text = '') =>
    `<button type="button" class="gb-key ${className}" data-btn="${name}" aria-label="${label}">${text}</button>`;
  return `<div class="gb-art" data-case="${advance ? 'AGB' : 'DMG'}">
    ${advance ? key('l', 'Gâchette L', 'gb-shoulder gb-l', 'L') + key('r', 'Gâchette R', 'gb-shoulder gb-r', 'R') : ''}
    <div class="gb-plastic"></div>
    <div class="gb-bezel"><span class="gb-dotmatrix">DOT MATRIX WITH STEREO SOUND</span>
      <span class="gb-battery">BATTERY</span><span class="gb-advance-logo">GAME BOY <b>ADVANCE</b></span>
    </div>
    ${advance ? '' : '<div class="gb-brand"><span>Nintendo</span> <b>GAME BOY</b><sup>™</sup></div>'}
    <div class="gb-dpad">
      ${key('up', 'Haut', 'gb-up', '▲')}${key('left', 'Gauche', 'gb-left', '◀')}
      ${key('right', 'Droite', 'gb-right', '▶')}${key('down', 'Bas', 'gb-down', '▼')}
      <span class="gb-dpad-hub"></span>
    </div>
    <div class="gb-ab-well"></div>
    ${key('b', 'B', 'gb-b', 'B')}${key('a', 'A', 'gb-a', 'A')}
    <span class="gb-ab-label gb-label-b">B</span><span class="gb-ab-label gb-label-a">A</span>
    ${key('select', 'Select', 'gb-select', '<span>SELECT</span>')}
    ${key('start', 'Start', 'gb-start-key', '<span>START</span>')}
    <div class="gb-speaker" aria-hidden="true">${'<i></i>'.repeat(6)}</div>
    <span class="gb-phones" aria-hidden="true">PHONES</span>
  </div>`;
}

const KEYMAP = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  KeyX: 'a',
  KeyW: 'a',
  KeyZ: 'b',
  KeyQ: 'l',
  KeyE: 'r',
  Enter: 'start',
  ShiftRight: 'select',
  ShiftLeft: 'select',
};
const CONTROL_BUTTONS = new Set(Object.values(KEYMAP));

let mounted = null;
/** The user pressed ▶ at least once: the console may connect. */
let started = false;

export function mountWindow() {
  const host = document.getElementById('gameboy-body');
  if (!host) return null;
  if (mounted && mounted.host === host && host.dataset.gbMounted === '1') {
    mounted.reconnect();
    return mounted;
  }
  // a single live console: otherwise the previous socket would stay open
  // and the room would keep running after the window closes
  if (mounted) {
    try {
      mounted.destroy();
    } catch {
      /* ignore */
    }
  }
  mounted = create(host);
  return mounted;
}

function create(host) {
  host.innerHTML = `<div class="gb-fit">${SHELL}</div>`;
  host.dataset.gbMounted = '1';
  const scope = new AbortController();
  const observers = [];
  const sources = new Set();
  const heldButtons = new Set();
  const remoteButtons = new Set();
  const inputSources = new Map();
  let localPlayerId = null;
  let reconnectTimer = null,
    resizeFrame = null,
    canControl = false,
    libraryWindow = null;
  const listen = (target, type, callback, options = {}) =>
    target.addEventListener(type, callback, {
      ...options,
      signal: scope.signal,
    });
  const observe = (Observer, target, options, callback) => {
    const observer = new Observer(callback);
    observer.observe(target, options);
    observers.push(observer);
    return observer;
  };
  const renderKeyboardHints = () => {
    for (const key of host.querySelectorAll('[data-key-code]'))
      key.textContent = getKeyboardLabel(key.dataset.keyCode, getLanguage());
  };
  listen(document, 'chaos:language:changed', renderKeyboardHints);
  renderKeyboardHints();

  /**
   * The shell has a fixed size (430 px classic, 620 px Advance). In a small
   * window it would be clipped: we scale it down and reserve the matching
   * height.
   */
  const fit = host.querySelector('.gb-fit');
  const artHost = host.querySelector('.gb-art-host');
  let shell = null,
    canvas = null,
    ctx2d = null,
    scrEl = null,
    startEl = null,
    startBtn = null,
    powerEl = null,
    ledEl = null,
    volEl = null,
    volPct = null;
  let model = null;

  /** Acquire the elements of whichever console body is currently mounted. */
  function grab() {
    shell = host.querySelector('.gb-shell');
    canvas = host.querySelector('#gb-canvas');
    ctx2d = canvas.getContext('2d', { alpha: false });
    canvas.tabIndex = 0;
    scrEl = $('gb-screen');
    startEl = $('gb-start');
    startBtn = $('gb-startbtn');
    powerEl = $('gb-power');
    ledEl = $('gb-led');
    volEl = $('gb-vol');
    volPct = $('gb-volpct');
  }

  // Only the case and its game controls change. Screen, utility controls,
  // audio and socket retain their nodes and listeners across cartridge changes.
  function buildShell(next) {
    const wanted = next === 'AGB' ? 'AGB' : 'DMG';
    if (wanted === model && artHost.firstElementChild) return;
    releaseInputs();
    model = wanted;
    artHost.innerHTML = caseMarkup(wanted === 'AGB');
    shell.dataset.model = wanted;
    bindButtons();
    applyVolume();
    applyPower();
    if (startEl) startEl.hidden = started;
    if (started) showOverlay('CONNEXION…');
    else hideOverlay();
    resizeScreen(wanted === 'AGB' ? 240 : 160, wanted === 'AGB' ? 160 : 144);
    rescale();
  }

  function rescale() {
    // The shell has a fixed natural width (430 px portrait, 620 px landscape).
    // We scale it both ways: down to fit a small window, up (to 1.6x) when the
    // window is large — the artwork, the screen and the overlays scale together.
    const w = shell.offsetWidth,
      h = shell.offsetHeight;
    if (!w || !h) return;
    const availW = host.clientWidth - 16;
    const availH = host.clientHeight - 16;
    const scale = Math.min(1.6, availW / w, availH / h);
    const use = Math.abs(scale - 1) > 0.004;
    shell.style.transform = use ? `scale(${scale})` : '';
    shell.style.transformOrigin = 'top center';
    fit.style.height = use ? `${h * scale}px` : '';
    host.dataset.gbScale = scale.toFixed(3);
  }
  observe(ResizeObserver, host, {}, rescale);
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = null;
    rescale();
  });

  const $ = (id) => host.querySelector('#' + id);
  // The frame buffers belong to the canvas of the mounted body: buildShell()
  // re-creates them through resizeScreen().
  let img = null,
    packed = null,
    tmp = null;
  let lastFrameNumber = null;
  function resizeScreen(width = 160, height = 144) {
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > 240 ||
      height > 160
    )
      return;
    canvas.width = width;
    canvas.height = height;
    img = ctx2d.createImageData(width, height);
    packed = new Uint8Array(width * height);
    tmp = new Uint8Array(width * height);
    lastFrameNumber = null;
  }

  let ws = null;
  let palette = null;
  let monoGame = true;
  let powerOn = true;
  let overlayVisible = true;
  let destroyed = false; // A closed owner must never reconnect.
  let roomGeneration = null;
  let closing = false; // Intentional closes must not schedule reconnection.
  let stopped = true; // An intentional disconnect waits for an explicit restore.
  let lastFrameAt = 0;
  let bytes = 0;

  /* ---------------- audio ---------------- */
  let actx = null,
    master = null,
    nextTime = 0,
    audioRate = 48000;
  let volume = 75;
  try {
    const saved = Number(localStorage.getItem('gb.vol') ?? 75);
    volume = Number.isFinite(saved) ? Math.max(0, Math.min(100, saved)) : 75;
  } catch {
    /* Storage can be disabled. */
  }
  let adec = null,
    opusTs = 0;

  function applyVolume() {
    if (master) {
      // Short ramp: a step on gain would click on big moves.
      const g = gainFromVolume(volume);
      if (actx && actx.state === 'running') master.gain.setTargetAtTime(g, actx.currentTime, 0.01);
      else master.gain.value = g;
    }
    if (volEl) volEl.value = String(volume);
    if (volPct) volPct.textContent = String(volume);
  }

  function ensureAudio() {
    if (actx) {
      applyVolume();
      return;
    }
    try {
      actx = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: audioRate,
        latencyHint: 'interactive',
      });
      master = actx.createGain();
      master.gain.value = gainFromVolume(volume);
      master.connect(actx.destination);
    } catch {
      actx = null;
    }
  }

  function scheduleBlock(f) {
    if (!powerOn) return;
    ensureAudio();
    if (!actx || actx.state !== 'running') return;
    const buf = actx.createBuffer(1, f.length, audioRate);
    buf.copyToChannel(f, 0);
    const now = actx.currentTime;
    if (nextTime < now + 0.02) nextTime = now + 0.08;
    else if (nextTime - now > 0.25) nextTime = now + 0.1;
    const src = actx.createBufferSource();
    src.buffer = buf;
    src.connect(master || actx.destination);
    sources.add(src);
    src.onended = () => {
      sources.delete(src);
      src.disconnect();
    };
    src.start(nextTime);
    nextTime += buf.duration;
  }

  function playPcm(pcm) {
    if (!powerOn) return;
    ensureAudio();
    if (!actx || actx.state !== 'running') return;
    const f = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) f[i] = pcm[i] / 32768;
    scheduleBlock(f);
  }

  function initOpus() {
    if (!('AudioDecoder' in window)) return false;
    try {
      const decoder = new AudioDecoder({
        output: (d) => {
          if (adec !== decoder || destroyed || stopped) {
            d.close();
            return;
          }
          const f = new Float32Array(d.numberOfFrames);
          d.copyTo(f, { planeIndex: 0, format: 'f32-planar' });
          d.close();
          scheduleBlock(f);
        },
        error: () => {
          if (adec !== decoder) return;
          adec = null;
          try {
            decoder.close();
          } catch {
            /* The decoder may already be closed. */
          }
          if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'caps', opus: false }));
        },
      });
      adec = decoder;
      adec.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1 });
      return true;
    } catch {
      adec = null;
      return false;
    }
  }

  /* ---------------- image ---------------- */
  function showOverlay(text) {
    const w = $('gb-wait');
    if (!w) return;
    w.style.display = 'grid';
    w.textContent = text;
    overlayVisible = true;
  }
  function hideOverlay() {
    const w = $('gb-wait');
    if (w) w.style.display = 'none';
    overlayVisible = false;
  }

  function applyPower() {
    powerEl.classList.toggle('off', !powerOn);
    powerEl.setAttribute('aria-checked', String(powerOn));
    scrEl.classList.toggle('off', !powerOn);
    ledEl.classList.toggle('off', !powerOn);
    syncButtonVisuals();
    if (!powerOn) {
      releaseInputs();
      hideOverlay();
    }
    if (actx) {
      if (powerOn) actx.resume().catch(() => {});
      else actx.suspend().catch(() => {});
    }
    try {
      if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'sleep', on: !powerOn }));
    } catch {
      /* ignore */
    }
    if (powerOn) {
      lastFrameAt = performance.now();
      palette = null;
    }
  }

  function paint() {
    if (palette && powerOn && renderIndexedFrame(packed, palette, img.data))
      ctx2d.putImageData(img, 0, 0);
  }

  /* ---------------- network ---------------- */
  function connect(canStart = false) {
    if (destroyed || !started || !isVisible()) return;
    // a single live socket: otherwise the room keeps a ghost player
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    closing = false;
    stopped = false;

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    ws = new WebSocket(`${proto}://${location.host}${WS_PATH}${canStart ? '?start=1' : ''}`);
    const connection = ws;
    lastFrameNumber = null;
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      if (ws === connection && !destroyed) $('gb-state').textContent = 'connecté';
    };
    ws.onclose = () => {
      if (ws !== connection || destroyed) return;
      ws = null;
      releaseInputs();
      remoteButtons.clear();
      syncButtonVisuals();
      $('gb-state').textContent = 'coupé';
      if (destroyed || closing) return; // Intentional disconnects must not reconnect.
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (!destroyed && !stopped && isVisible()) connect();
      }, 1500);
    };
    ws.onerror = () => {
      if (ws === connection && !destroyed) $('gb-state').textContent = 'erreur';
    };

    ws.onmessage = (ev) => {
      if (ws !== connection || destroyed || stopped) return;
      if (typeof ev.data === 'string') {
        let m;
        try {
          m = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (m.type === 'hello') {
          localPlayerId = m.id;
          roomGeneration = m.generation;
          canControl = m.canControl === true;
          buildShell(m.model);
          resizeScreen(m.width, m.height);
          applyControls(m.controls);
          try {
            adec?.close();
          } catch {
            /* Reconnect replaces the decoder. */
          }
          adec = null;
          opusTs = 0;
          if (m.proto !== PROTO) {
            showOverlay(`Version périmée (${m.proto ?? '?'} ≠ ${PROTO}). Recharge la page.`);
            try {
              ws.close();
            } catch {
              /* ignore */
            }
            return;
          }
          if (typeof m.mono === 'boolean') monoGame = m.mono;
          if (m.audioRate) audioRate = m.audioRate;
          if (m.palette) {
            palette = monoGame ? tintMonochromePalette(m.palette) : m.palette;
          }
          if (m.audioCodec === 'opus' && !initOpus()) {
            try {
              ws.send(JSON.stringify({ type: 'caps', opus: false }));
            } catch {
              /* ignore */
            }
          }
          if (!powerOn) {
            try {
              ws.send(JSON.stringify({ type: 'sleep', on: true }));
            } catch {
              /* ignore */
            }
          }
          lastFrameAt = performance.now();
          return;
        }
        if (m.type === 'unloaded' || (m.type === 'error' && m.reason === 'rom-unloaded')) {
          started = false;
          stopStream();
          ctx2d.clearRect(0, 0, canvas.width, canvas.height);
          if (startEl) startEl.hidden = false;
          hideOverlay();
          return;
        }
        if (m.type === 'roster') {
          $('gb-count').textContent = m.players.length;
          return;
        }
        if (m.type === 'controls') {
          applyControls(m.players);
          return;
        }
        if (m.type === 'rom') {
          remoteButtons.clear();
          releaseInputs();
          roomGeneration = m.generation ?? roomGeneration;
          buildShell(m.model);
          resizeScreen(m.width, m.height);
          nextTime = 0;
          opusTs = 0;
          try {
            adec?.close();
          } catch {
            /* The previous ROM owns this decoder. */
          }
          adec = null;
          if (!initOpus() && ws?.readyState === 1)
            ws.send(JSON.stringify({ type: 'caps', opus: false }));
          if (typeof m.mono === 'boolean') monoGame = m.mono;
          palette = null;
          lastFrameAt = performance.now();
          if (powerOn) showOverlay(`Chargement de ${m.title}…`);
          return;
        }
        if (m.type === 'power') return; // l'interrupteur est local
        if (m.type === 'error' && m.reason === 'no-rom') {
          stopped = true;
          showOverlay('Aucune ROM installée — ouvre la bibliothèque (bouton cartouche).');
          return;
        }
        return;
      }

      const buf = new Uint8Array(ev.data);
      if (buf.length === 0) return;
      if (buf[0] === 0x4f) {
        // 'O' Opus
        if (!adec || buf.length < 2) return;
        try {
          adec.decode(
            new EncodedAudioChunk({
              type: 'key',
              timestamp: opusTs,
              duration: 20000,
              data: ev.data.slice(1),
            }),
          );
          opusTs += 20000;
        } catch {
          /* ignore */
        }
        return;
      }
      if (buf[0] === 0x41) {
        // 'A' PCM de repli
        if (buf.length < 5 || (buf.length - 5) % 2) return;
        playPcm(new Int16Array(ev.data.slice(5)));
        return;
      }
      if (buf[0] === 0x46) {
        // 'F' image
        if (buf.length < 6) return;
        const frameNumber = new DataView(ev.data).getUint32(1, true);
        if (
          !(buf[5] & 1) &&
          (lastFrameNumber === null || frameNumber !== (lastFrameNumber + 1) >>> 0)
        ) {
          if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'resync' }));
          return;
        }
        bytes += buf.length;
        const flags = buf[5];
        const isKey = (flags & 1) !== 0;
        let o = 6;
        if (flags & 2) {
          const n = buf[o++];
          if (!n || o + n * 3 > buf.length) return;
          const pal = [];
          for (let i = 0; i < n; i++) {
            pal.push([buf[o], buf[o + 1], buf[o + 2]]);
            o += 3;
          }
          palette = monoGame ? tintMonochromePalette(pal) : pal;
        }
        if (isKey) {
          if (!decodeRle(buf.subarray(o), packed)) return;
        } else {
          if (!decodeRle(buf.subarray(o), tmp)) return;
          for (let i = 0; i < packed.length; i++) packed[i] ^= tmp[i];
        }
        lastFrameNumber = frameNumber;
        paint();
        lastFrameAt = performance.now();
        if (overlayVisible) hideOverlay();
        const s = $('gb-state');
        if (s.textContent !== 'connecté') s.textContent = 'connecté';
      }
    };
  }

  /* ---------------- volume / power / library ---------------- */
  function onPower() {
    if (!started) {
      begin();
      return;
    }
    ensureAudio();
    if (actx?.state === 'suspended') actx.resume().catch(() => {});
    powerOn = !powerOn;
    applyPower();
  }

  function begin() {
    if (started) return;
    started = true;
    if (startEl) startEl.hidden = true;
    ensureAudio();
    if (actx?.state === 'suspended') actx.resume().catch(() => {});
    powerOn = true;
    applyPower();
    showOverlay('CONNEXION…');
    connect(true);
  }

  function openLibrary() {
    const w = 980,
      h = 760;
    const left = Math.max(0, Math.round((screen.width - w) / 2));
    const top = Math.max(0, Math.round((screen.height - h) / 2));
    libraryWindow = window.open(
      '/gameboy-library',
      'chaos-gameboy-library',
      `width=${w},height=${h},left=${left},top=${top}`,
    );
  }

  /**
   * The utility controls are mounted and wired once.
   */
  function wireShell() {
    if (volEl) {
      volEl.value = String(volume);
      listen(volEl, 'input', () => {
        volume = Number(volEl.value);
        try {
          localStorage.setItem('gb.vol', String(volume));
        } catch {
          /* Storage can be disabled. */
        }
        applyVolume();
      });
      applyVolume();
    }

    if (powerEl) {
      listen(powerEl, 'click', onPower);
      listen(powerEl, 'keydown', (event) => {
        if (!['Enter', ' '].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        powerEl.click();
      });
    }

    if (startBtn) listen(startBtn, 'click', begin);
    if (startEl) listen(startEl, 'click', begin);
    listen($('gb-lib'), 'click', openLibrary);
    bindButtons();
  }

  /* ---------------- input ---------------- */
  function syncButtonVisuals() {
    for (const node of host.querySelectorAll('[data-btn]')) {
      node.classList.toggle(
        'active',
        powerOn && (heldButtons.has(node.dataset.btn) || remoteButtons.has(node.dataset.btn)),
      );
    }
  }

  function applyControls(players) {
    remoteButtons.clear();
    if (Array.isArray(players)) {
      for (const player of players) {
        // Own input renders immediately; a delayed echo must not re-press it.
        if (player?.id === localPlayerId || !Array.isArray(player?.buttons)) continue;
        for (const button of player.buttons) {
          if (CONTROL_BUTTONS.has(button)) remoteButtons.add(button);
        }
      }
    }
    syncButtonVisuals();
  }

  function send(btn, down, source = 'pointer') {
    if (!canControl || (down && (!powerOn || stopped))) return;
    const sources = inputSources.get(btn) || new Set();
    if (down) sources.add(source);
    else if (source === 'all') sources.clear();
    else sources.delete(source);
    inputSources.set(btn, sources);
    down = sources.size > 0;
    if (heldButtons.has(btn) === down) {
      syncButtonVisuals();
      return;
    }
    if (down) heldButtons.add(btn);
    else heldButtons.delete(btn);
    syncButtonVisuals();
    try {
      if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'input', btn, down }));
    } catch {
      /* ignore */
    }
  }

  function releaseInputs() {
    for (const button of [...heldButtons]) {
      send(button, false, 'all');
    }
    heldButtons.clear();
    inputSources.clear();
    syncButtonVisuals();
  }
  function ownsKeyboard(event) {
    if (!canControl || !powerOn || stopped || destroyed) return false;
    if (event.target?.closest?.('input, textarea, select, [contenteditable]')) return false;
    return host.contains(document.activeElement) || document.activeElement === winEl;
  }
  /**
   * Bind fresh HTML buttons after a model change. Each pointer and keyboard
   * source holds its own press, so releasing one cannot release another.
   */
  function bindButtons() {
    for (const node of host.querySelectorAll('[data-btn]')) {
      const btn = node.dataset.btn;
      listen(node, 'pointerdown', (e) => {
        if (e.button !== 0) return;
        if (!canControl || !powerOn || stopped) return;
        e.preventDefault();
        node.setPointerCapture?.(e.pointerId);
        canvas.focus();
        send(btn, true, `pointer:${e.pointerId}`);
      });
      const up = (e) => {
        send(btn, false, `pointer:${e.pointerId}`);
      };
      listen(node, 'pointerup', up);
      listen(node, 'pointercancel', up);
      listen(node, 'lostpointercapture', up);
      listen(node, 'keydown', (event) => {
        if (!['Enter', ' '].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat || !canControl || !powerOn || stopped) return;
        send(btn, true, `control:${event.code}`);
      });
      listen(node, 'keyup', (event) => {
        if (!['Enter', ' '].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        send(btn, false, `control:${event.code}`);
      });
      listen(node, 'blur', () => {
        send(btn, false, 'control:Space');
        send(btn, false, 'control:Enter');
      });
    }
  }

  const onKey = (e) => {
    if (e.repeat || !ownsKeyboard(e)) return;
    const btn = KEYMAP[e.code];
    if (!btn) return;
    // L and R only exist on the Advance shell.
    if ((btn === 'l' || btn === 'r') && model !== 'AGB') return;
    e.preventDefault();
    send(btn, true, e.code);
  };
  const offKey = (e) => {
    const btn = KEYMAP[e.code];
    if (!heldButtons.has(btn)) return;
    if (!btn) return;
    e.preventDefault();
    send(btn, false, e.code);
  };
  listen(window, 'keydown', onKey);
  listen(window, 'keyup', offKey);

  /* ---------------- status ---------------- */
  let lastBytes = 0,
    lastAt = performance.now();
  const statusTimer = setInterval(() => {
    if (destroyed) return;
    const now = performance.now();
    const dt = (now - lastAt) / 1000;
    if (dt > 0.5) {
      const kbs = (bytes - lastBytes) / 1024 / dt;
      $('gb-rate').textContent = kbs > 0.5 ? `${kbs.toFixed(0)} Ko/s` : '—';
      lastBytes = bytes;
      lastAt = now;
    }
    if (!powerOn || !ws || ws.readyState !== 1) return;
    if (lastFrameAt && now - lastFrameAt > 2000) {
      try {
        ws.send(JSON.stringify({ type: 'resync' }));
      } catch {
        /* ignore */
      }
      lastFrameAt = now;
    }
  }, 1000);

  function stopStream() {
    releaseInputs();
    remoteButtons.clear();
    syncButtonVisuals();
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    for (const source of sources) {
      try {
        source.stop();
      } catch {
        /* The source may have ended. */
      }
      source.disconnect();
    }
    sources.clear();
    closing = true;
    stopped = true;
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    ws = null;
    try {
      adec?.close();
    } catch {
      /* ignore */
    }
    adec = null;
    if (actx)
      void actx.close().catch(() => {
        /* The document may already be shutting down. */
      });
    actx = null;
    master = null;
    nextTime = 0;
    const el = $('gb-state');
    if (el) el.textContent = 'en veille';
  }

  /* The desktop "closes" a window by hiding it, so we watch the real
     visibility. A background browser tab is NOT a closed window: the audio has
     to keep playing, so the stream stays open there (see stream-state.js). */
  const isVisible = () => {
    const box = host.closest('.wm-win') || host;
    const style = getComputedStyle(box);
    const rect = box.getBoundingClientRect();
    return shouldStream({
      minimized: box.dataset?.minimized === '1',
      display: style.display,
      visibility: style.visibility,
      width: rect.width,
      height: rect.height,
    });
  };
  const watchdog = setInterval(() => {
    if (destroyed || !started) return;
    if (!isVisible()) {
      if (ws) stopStream();
      return;
    }
    if (!ws && stopped && !closing) return;
    if (!ws) {
      stopped = false;
      showOverlay('CONNEXION…');
      connect();
    }
  }, 700);

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    started = false;
    scope.abort();
    for (const observer of observers) observer.disconnect();
    if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
    clearInterval(statusTimer);
    clearInterval(watchdog);
    // closing the window must cut the stream: otherwise the room keeps running
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('keyup', offKey);
    stopStream();
    host.dataset.gbMounted = '0';
    host.replaceChildren();
    if (mounted?.host === host) mounted = null;
  }

  // Close is terminal for this local owner; minimize only suspends its stream.
  const winEl = host.closest('.wm-win');
  if (winEl) {
    // Capture runs before the registry's unmount hook aborts this owner's listeners.
    listen(
      winEl,
      'wm:close',
      () => {
        const body = Number.isSafeInteger(roomGeneration) ? { generation: roomGeneration } : {};
        void fetch('/gameboy-api/unload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          keepalive: true,
        })
          .then((response) => {
            if (!response.ok && response.status !== 401 && response.status !== 403)
              throw new Error(`gameboy_unload_failed: ${response.status}`);
          })
          .catch((error) => console.warn('[gameboy] shared ROM unload failed:', error));
        destroy();
      },
      { capture: true },
    );
    observe(
      MutationObserver,
      winEl,
      { attributes: true, attributeFilter: ['data-minimized'] },
      () => {
        if (destroyed) return;
        if (winEl.dataset.minimized === '1') {
          stopStream();
          return;
        }
        if (started && !ws) {
          closing = false;
          stopped = false;
          showOverlay('CONNEXION…');
          connect();
        }
      },
    );
  }
  const watcher = observe(
    MutationObserver,
    document.body,
    { childList: true, subtree: true },
    () => {
      if (!document.contains(host)) {
        watcher.disconnect();
        destroy();
      }
    },
  );
  listen(window, 'pagehide', (event) => {
    if (!event.persisted) destroy();
  });
  listen(window, 'blur', releaseInputs);
  listen(window, 'message', (event) => {
    if (
      event.origin !== location.origin ||
      event.source !== libraryWindow ||
      event.data?.type !== 'gameboy:rom-loaded'
    )
      return;
    if (!destroyed) {
      // loading a ROM from the library counts as an explicit start
      started = true;
      if (startEl) startEl.hidden = true;
      if (isVisible()) {
        closing = false;
        stopped = false;
        showOverlay('CONNEXION…');
        connect();
      }
    }
  });
  listen(document, 'visibilitychange', () => {
    // A hidden tab keeps playing: the audio must go on, and Chrome keeps the
    // timers of an audible tab at full rate. Coming back, we only repair what
    // the browser may have broken: a suspended context or a dead socket.
    if (document.hidden) return;
    if (actx && actx.state === 'suspended') actx.resume().catch(() => {});
    if (started && !destroyed && isVisible() && (!ws || ws.readyState > 1)) {
      stopped = false;
      connect();
    }
  });
  // Mount the console: the overlay layer exists once, then the cartridge decides
  // which case is injected into it (buildShell). The status route primes the
  // choice so an Advance game already running does not appear on a Game Boy.
  grab();
  wireShell();
  buildShell('DMG');
  void fetch('/gameboy-api/status')
    .then((response) => (response.ok ? response.json() : null))
    .then((status) => {
      // A WebSocket handshake is newer than this initial HTTP snapshot.
      if (!destroyed && !ws && status?.model) buildShell(status.model);
    })
    .catch(() => {
      /* No status route (static preview, add-on absent): the handshake decides. */
    });

  // The console no longer connects on its own: we show the start screen and
  // the ▶ button launches the game (the ROM is already picked server-side).
  if (started) {
    showOverlay('CONNEXION…');
    connect();
  } else if (startEl) {
    startEl.hidden = false;
    hideOverlay();
  }

  return {
    host,
    reconnect: () => {
      if (!destroyed && started && isVisible()) {
        stopped = false;
        connect();
      }
    },
    dispose: destroy,
    status: () => ({
      isStopped: destroyed,
      hasSocket: !!ws,
      sources: sources.size,
      observers: destroyed ? 0 : observers.length,
    }),
    destroy,
  };
}
