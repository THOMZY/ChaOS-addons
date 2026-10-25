import { decodeRle, renderIndexedFrame, tintMonochromePalette } from './gameboy-frame-codec.js';
// Game Boy window client (ChaOS-games add-on).
//
// The window manifest gives us an empty body (#gameboy-body); this module
// builds the console there, connects to /gameboy-ws and renders the stream.
// Everything the user controls (power, volume) is local: turning the console
// off only stops *our* stream, the shared game keeps running for others.

const WS_PATH = '/gameboy-ws';
const PROTO = 4;

const SHELL = `
<div class="gb-shell">
  <div class="gb-top">
    <div class="gb-powerslot">
      <span class="gb-plabel">ON/OFF</span>
      <div class="gb-power" id="gb-power" role="switch" aria-checked="true" tabindex="0" title="Marche / arrêt"><i></i></div>
    </div>
    <div class="gb-volume">
      <span class="gb-vlbl">VOL</span>
      <input id="gb-vol" type="range" min="0" max="100" value="75" aria-label="Volume">
      <span class="gb-vpct" id="gb-volpct">75</span>
    </div>
    <div class="gb-ledrow"><span class="gb-led" id="gb-led"></span></div>
    <button class="gb-cart" id="gb-lib" title="Bibliothèque de ROMs" aria-label="Bibliothèque">
      <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
        <path d="M5 3.5h10.5L19 7v13.5H5z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
        <rect x="8" y="7" width="8" height="4.5" rx="1" fill="none" stroke="currentColor" stroke-width="1.4"/>
      </svg>
    </button>
  </div>

  <div class="gb-bezel">
    <div class="gb-brand"><span>DOT MATRIX WITH STEREO SOUND</span><em>GAME BOY</em></div>
    <div class="gb-screen" id="gb-screen">
      <canvas id="gb-canvas" width="160" height="144"></canvas>
      <div class="gb-start" id="gb-start" hidden>
        <button type="button" class="gb-startbtn" id="gb-startbtn" aria-label="Allumer la console">▶</button>
        <span class="gb-starttxt">JOUER</span>
      </div>
      <div class="gb-wait" id="gb-wait">CONNEXION…</div>
    </div>
  </div>

  <div class="gb-controls">
    <div class="gb-dpad">
      <button class="gb-up"    data-btn="up"    aria-label="Haut"></button>
      <button class="gb-left"  data-btn="left"  aria-label="Gauche"></button>
      <span class="gb-hub"></span>
      <button class="gb-right" data-btn="right" aria-label="Droite"></button>
      <button class="gb-down"  data-btn="down"  aria-label="Bas"></button>
    </div>
    <div class="gb-ab">
      <button type="button" class="gb-key gb-b" data-btn="b">B</button>
      <button type="button" class="gb-key gb-a" data-btn="a">A</button>
    </div>
  </div>

  <div class="gb-bottom">
    <div class="gb-startsel">
      <div class="gb-pill"><button type="button" class="gb-cap" data-btn="select" aria-label="select"></button><div class="gb-lbl">SELECT</div></div>
      <div class="gb-pill"><button type="button" class="gb-cap" data-btn="start" aria-label="start"></button><div class="gb-lbl">START</div></div>
    </div>
    <div class="gb-speaker"></div>
  </div>

  <div class="gb-hud"><span id="gb-state">…</span> · <span id="gb-rate">–</span> · <span id="gb-count">–</span> joueur(s)</div>
</div>`;

const KEYMAP = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  KeyX: 'a',
  KeyW: 'a',
  KeyZ: 'b',
  Enter: 'start',
  ShiftRight: 'select',
  ShiftLeft: 'select',
};

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
  const inputSources = new Map();
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

  /**
   * The shell has a fixed size (430 px). In a small window it would be
   * clipped: we scale it down and reserve the matching height.
   */
  const fit = host.querySelector('.gb-fit');
  const shell = host.querySelector('.gb-shell');
  function rescale() {
    // The shell has a natural size of 430 px. We scale it both ways: down to
    // fit a small window, up (to 1.6x) when the window is large — the game and
    // the SVG scale together.
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
  const canvas = $('gb-canvas');
  const ctx2d = canvas.getContext('2d', { alpha: false });
  let img = ctx2d.createImageData(160, 144);
  let packed = new Uint8Array(160 * 144),
    tmp = new Uint8Array(160 * 144);
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
  canvas.tabIndex = 0;

  let ws = null;
  let palette = null;
  let monoGame = true;
  let powerOn = true;
  let overlayVisible = true;
  let destroyed = false; // la fenêtre est fermée : plus aucune reconnexion
  let closing = false; // fermeture volontaire : le onclose ne doit pas relancer
  let stopped = true; // coupé à la demande : on attend de revoir la fenêtre
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

  const volEl = $('gb-vol'),
    volPct = $('gb-volpct');

  function applyVolume() {
    if (master) master.gain.value = volume / 100;
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
      master.gain.value = volume / 100;
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

  const scrEl = $('gb-screen');
  const startEl = $('gb-start');
  const startBtn = $('gb-startbtn');
  const powerEl = $('gb-power');
  const ledEl = $('gb-led');

  function applyPower() {
    powerEl.classList.toggle('off', !powerOn);
    powerEl.setAttribute('aria-checked', String(powerOn));
    scrEl.classList.toggle('off', !powerOn);
    ledEl.classList.toggle('off', !powerOn);
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
  function connect() {
    if (destroyed) return;
    // a single live socket: otherwise the room keeps a ghost player
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    closing = false;
    stopped = false;

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    ws = new WebSocket(`${proto}://${location.host}${WS_PATH}`);
    const connection = ws;
    lastFrameNumber = null;
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      if (ws === connection && !destroyed) $('gb-state').textContent = 'connecté';
    };
    ws.onclose = () => {
      if (ws !== connection || destroyed) return;
      ws = null;
      $('gb-state').textContent = 'coupé';
      if (destroyed || closing) return; // coupure volontaire
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
          canControl = m.canControl === true;
          resizeScreen(m.width, m.height);
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
        if (m.type === 'roster') {
          $('gb-count').textContent = m.players.length;
          return;
        }
        if (m.type === 'rom') {
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

  listen(powerEl, 'click', () => {
    if (!started) {
      begin();
      return;
    }
    ensureAudio();
    if (actx?.state === 'suspended') actx.resume().catch(() => {});
    powerOn = !powerOn;
    applyPower();
  });

  function begin() {
    if (started) return;
    started = true;
    if (startEl) startEl.hidden = true;
    ensureAudio();
    if (actx?.state === 'suspended') actx.resume().catch(() => {});
    powerOn = true;
    applyPower();
    showOverlay('CONNEXION…');
    connect();
  }

  if (startBtn) listen(startBtn, 'click', begin);
  if (startEl) listen(startEl, 'click', begin);

  listen($('gb-lib'), 'click', () => {
    const w = 980,
      h = 760;
    const left = Math.max(0, Math.round((screen.width - w) / 2));
    const top = Math.max(0, Math.round((screen.height - h) / 2));
    libraryWindow = window.open(
      '/gameboy-library',
      'chaos-gameboy-library',
      `width=${w},height=${h},left=${left},top=${top}`,
    );
  });

  /* ---------------- input ---------------- */
  function send(btn, down, source = 'pointer') {
    if (!canControl || (down && (!powerOn || stopped))) return;
    const sources = inputSources.get(btn) || new Set();
    if (down) sources.add(source);
    else if (source === 'all') sources.clear();
    else sources.delete(source);
    inputSources.set(btn, sources);
    down = sources.size > 0;
    if (heldButtons.has(btn) === down) return;
    if (down) heldButtons.add(btn);
    else heldButtons.delete(btn);
    try {
      if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'input', btn, down }));
    } catch {
      /* ignore */
    }
  }

  function releaseInputs() {
    for (const button of [...heldButtons]) {
      send(button, false, 'all');
      host.querySelector(`[data-btn="${button}"]`)?.classList.remove('active');
    }
  }
  function ownsKeyboard(event) {
    if (!canControl || !powerOn || stopped || destroyed) return false;
    if (event.target?.closest?.('input, textarea, select, [contenteditable]')) return false;
    return host.contains(document.activeElement) || document.activeElement === winEl;
  }
  host.querySelectorAll('[data-btn]').forEach((node) => {
    const btn = node.dataset.btn;
    listen(node, 'pointerdown', (e) => {
      if (!canControl || !powerOn || stopped) return;
      e.preventDefault();
      node.setPointerCapture?.(e.pointerId);
      canvas.focus();
      node.classList.add('active');
      send(btn, true);
    });
    const up = () => {
      node.classList.remove('active');
      send(btn, false);
    };
    listen(node, 'pointerup', up);
    listen(node, 'pointercancel', up);
    listen(node, 'pointerleave', (e) => {
      if (e.buttons) up();
    });
    listen(node, 'keydown', (event) => {
      if (!['Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat || !canControl || !powerOn || stopped) return;
      node.classList.add('active');
      send(btn, true, event.code);
    });
    listen(node, 'keyup', (event) => {
      if (!['Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      node.classList.remove('active');
      send(btn, false, event.code);
    });
  });

  const onKey = (e) => {
    if (e.repeat || !ownsKeyboard(e)) return;
    const btn = KEYMAP[e.code];
    if (!btn) return;
    e.preventDefault();
    host.querySelector(`[data-btn="${btn}"]`)?.classList.add('active');
    send(btn, true, e.code);
  };
  const offKey = (e) => {
    const btn = KEYMAP[e.code];
    if (!heldButtons.has(btn)) return;
    if (!btn) return;
    e.preventDefault();
    host.querySelector(`[data-btn="${btn}"]`)?.classList.remove('active');
    send(btn, false, e.code);
  };
  listen(window, 'keydown', onKey);
  listen(window, 'keyup', offKey);

  /* ---------------- indicateurs ---------------- */
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
     visibility (hidden window, minimized, or background tab) to cut the
     network stream. Reopening starts the console again. */
  const isVisible = () => {
    if (document.hidden || host.closest('.wm-win')?.dataset.minimized === '1') return false;
    const box = host.closest('.wm-win') || host;
    const style = getComputedStyle(box);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const r = box.getBoundingClientRect();
    return r.width > 4 && r.height > 4;
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
  }

  /* Close / reopen: the desktop fires "wm:close" then marks the window
     data-minimized="1". We cut the stream on both signals and start it again
     when the window comes back. */
  const winEl = host.closest('.wm-win');
  if (winEl) {
    listen(winEl, 'wm:close', () => {
      try {
        stopStream();
      } catch {
        /* ignore */
      }
    });
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
        if (!ws) {
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
    if (document.hidden) stopStream();
    else if (started && isVisible() && !destroyed) {
      stopped = false;
      connect();
    }
  });
  listen(powerEl, 'keydown', (event) => {
    if (['Enter', ' '].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      powerEl.click();
    }
  });

  // The console no longer connects on its own: we show the start screen and
  // the ▶ button launches the game (the ROM is already picked server-side).
  applyPower();
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
