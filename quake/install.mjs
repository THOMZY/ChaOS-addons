#!/usr/bin/env node
/**
 * quake-install.mjs — installs a clean copy of the Quake 3 (Q3JS) client in ChaOS.
 *
 * The original client is served from q3.pieter.com under /game2/: its game page,
 * Next.js chunks, WebAssembly-compiled ioquake3 engine, and baseq3 data. Its
 * paths are absolute and ChaOS already has its own /assets/, so everything is
 * served under /quake/ with paths rewritten.
 *
 * Three paths need more than a simple prefix replacement:
 *
 *   1. `let v="/game2"` in the bundle is the engine root for loading
 *      /game2/ioquake3.js and /game2/ioquake3.wasm. It has no trailing slash, so
 *      the `/game2/` prefix rule does not match it.
 *   2. The multiplayer WebSocket URL is `${proto}//${host}:${port}` with no path.
 *      Our tunnel lives at /game/quake3/servers/<room>/ws, so append the
 *      `window.__Q3_WSPATH` constant (set by the page). Keep the host and port
 *      unchanged: the engine uses `+connect <host>:<port>` and Emscripten SOCKFS
 *      resolves the WebSocket using those same values from the URL.
 *   3. `Q3JS_Mobile*` identifiers are symbols exported by WebAssembly. No rule
 *      may change the string "Q3JS" in the bundle; brand changes apply only to
 *      visible labels.
 *
 * Usage: node games/quake/install.mjs <source-directory> [--no-copy]
 *
 * <source-directory> = client mirror (game2/game, game2/_next/, game2/ioquake3.*,
 * game2/baseq3/, assets/touch-controls.js, icons, and manifest.json). The ~82 MB
 * of assets are not versioned; they live on disk and are bind-mounted on the VPS,
 * like MUGEN and Surf.
 *
 * Idempotent: safe to rerun; it always starts from the source copy.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// This file lives in games/quake/ once installed: the add-on is its directory.
const DEST = resolve(dirname(fileURLToPath(import.meta.url)), 'data');
const PREFIX = '/quake';

/** Published room, as declared in games/quake/server/game.js. */
const ROOM = process.env.Q3_ROOM || 'q3dm';
/** Tunnel path in the host app (see games/platform/game-servers/tunnel.js). */
const WS_PATH = `/game/quake3/servers/${ROOM}/ws`;

/** Brand shown in place of the original client's brand. */
const BRAND = 'ChaOS';
const TITLE = `${BRAND} — Quake 3`;

const src = process.argv[2];
const NO_COPY = process.argv.includes('--no-copy');
if (!src) {
  console.error('usage: node games/quake/install.mjs <dossier-source> [--no-copy]');
  process.exit(1);
}
for (const need of ['game2/game', 'game2/baseq3', 'game2/ioquake3.wasm']) {
  if (!existsSync(join(src, need))) {
    console.error(`source invalide : ${src} (${need} attendu)`);
    process.exit(1);
  }
}

// Files served by the web server: the page, Next.js chunks, engine, and data.
// The external radio widget is not copied (third-party service).
const FILES = [
  ['game2/game', 'game'],
  ['game2/ioquake3.js', 'ioquake3.js'],
  ['game2/ioquake3.wasm', 'ioquake3.wasm'],
  ['assets/touch-controls.js', 'assets/touch-controls.js'],
  ['favicon.ico', 'favicon.ico'],
  ['apple-touch-icon.png', 'apple-touch-icon.png'],
  ['logo192.png', 'logo192.png'],
  ['logo512.png', 'logo512.png'],
  ['q3logo.png', 'q3logo.png'],
  ['manifest.json', 'manifest.json'],
];
const DIRS = [
  ['game2/_next', '_next'],
  ['game2/baseq3', 'baseq3'],
];

// ── Phase 1 : copie ──────────────────────────────────────────────────────────
console.log(`source : ${src}`);
console.log(`cible  : ${DEST}`);
if (NO_COPY && existsSync(join(DEST, 'game'))) {
  // Fast iteration: the rules are not idempotent (prefixing "/quake/_next/"
  // again would produce "/quake/quake/_next/"), so restore text files from the
  // source. Reuse the baseq3 pak files as-is.
  for (const [from, to] of FILES) cpSync(join(src, from), join(DEST, to));
  cpSync(join(src, 'game2/_next'), join(DEST, '_next'), { recursive: true });
  console.log('  --no-copy : textes restaurés, baseq3 conservé');
} else {
  if (existsSync(DEST)) rmSync(DEST, { recursive: true, force: true });
  mkdirSync(DEST, { recursive: true });
  for (const [from, to] of DIRS) {
    cpSync(join(src, from), join(DEST, to), { recursive: true });
    console.log(`  copié   ${to}/`);
  }
  for (const [from, to] of FILES) {
    mkdirSync(dirname(join(DEST, to)), { recursive: true });
    cpSync(join(src, from), join(DEST, to));
    console.log(`  copié   ${to}`);
  }
}

// ── Phase 2: /quake prefix and patches ──────────────────────────────────────
// Each pattern is applied once; inserted text is never processed again.
const PREFIX_RULES = [
  // The entire Next.js bundle (page and chunk references, including inline RSC
  // payloads) lives under /game2/.
  ['/game2/', `${PREFIX}/`],
  // Engine root and Next.js basePath: "/game2" WITHOUT a trailing slash, so
  // the rule above does not catch it. This path controls /quake/ioquake3.js and
  // /quake/ioquake3.wasm and is reapplied on each Next.js navigation
  // (`addPathPrefix(e, "/game2")`).
  ['"/game2"', `"${PREFIX}"`],
  // ChaOS already has its own /assets/ path. The touch-controls script is
  // loaded dynamically by the bundle using an absolute path.
  ['"/assets/touch-controls.js', `"${PREFIX}/assets/touch-controls.js`],
  // Page resources referenced from the origin ROOT would resolve to ChaOS
  // resources (/favicon.ico, the ban page) or the SPA fallback
  // (/manifest.json → index.html, which is not a valid manifest).
  ['href="/manifest.json"', `href="${PREFIX}/manifest.json"`],
  ['href="/favicon.ico"', `href="${PREFIX}/favicon.ico"`],
  ['href="/apple-touch-icon.png"', `href="${PREFIX}/apple-touch-icon.png"`],
  // Google Analytics is bundled by the client (@next/third-parties component).
  // It does NOT disable itself, and ChaOS's CSP blocks it, causing four useless
  // console errors. Rewrite its URL to a locally served no-op script: the same
  // execution graph with no outgoing request.
  ['https://www.googletagmanager.com/gtag/js', `${PREFIX}/assets/noop.js`],
  ['https://www.googletagmanager.com/gtm.js', `${PREFIX}/assets/noop.js`],
];

/**
 * Add the tunnel path to the WebSocket URL.
 *
 * The original expression is `${proto}//${host}:${port}`; append the constant
 * set by the page. `window.__Q3_WSPATH || ""` provides a neutral fallback if
 * the page is served without that constant.
 */
const WS_FROM = '(0,u.getWsProtocol)()}//${e}:${t}`';
const WS_TO = '(0,u.getWsProtocol)()}//${e}:${t}${window.__Q3_WSPATH||""}`';

/** Tab title, rewritten by the engine at startup. */
const TITLE_FROM = 'Play Quake III Online - q3.pieter.com';
const TITLE_TO = TITLE;

/**
 * Disable the client's service worker registration.
 *
 * The client registers `/sw.js` with `scope:"/"`, giving it control over the
 * entire site for push notifications. ChaOS does not need this, and `/sw.js`
 * does not exist on our origin: the request fell through to the SPA, returned
 * HTML, and failed with an "unsupported MIME type" console error. The client
 * already wraps the call in `.catch(()=>{})`, so replacing it with a resolved
 * promise has no observable effect while removing the request and root-scope risk.
 */
const SW_FROM = 'navigator.serviceWorker.register("/sw.js",{scope:"/"})';
const SW_TO = 'Promise.resolve()';

/**
 * Remove the embedded-mode help overlay.
 *
 * When the page is in an iframe, the client overlays the game with tips ("Set
 * name", "CLICK for sound", "Play in new tab") intended for third-party sites
 * embedding the game. In a ChaOS window, these just obstruct gameplay.
 *
 * Do NOT change iframe detection: it sizes the engine to the window
 * (`r_customwidth/height`) and keeps the canvas fitted during resizing. Only
 * overlay rendering is disabled: `V` becomes `false`, so the component is
 * never mounted.
 */
const OVERLAY_FROM = 'V=!Q&&A&&"ready"===m.stage&&O';
const OVERLAY_TO = 'V=!1';

/**
 * Reset the embedded mode's `in_nograb 1` setting to `0`.
 *
 * This directly causes the "cursor stays visible" issue: with `in_nograb 1`,
 * ioquake3 NEVER captures the mouse. That is intended on a third-party site
 * embedding the game, where the game must not take the host page's cursor. In a
 * ChaOS window the opposite is needed: without capture, the view is bounded by
 * the window width and the cursor can leave it.
 *
 * `in_nograb 0` lets the engine request pointer lock through SDL2/Emscripten.
 * The browser grants it on the first canvas click and releases it with Escape,
 * the standard FPS behavior. The ChaOS window already provides both required
 * permissions: `allow="pointer-lock"` on the iframe and
 * `Permissions-Policy: pointer-lock=*` on the `/quake` mount.
 */
const NOGRAB_FROM = '+set in_nograb 1';
const NOGRAB_TO = '+set in_nograb 0';

/**
 * Disable the client's touch detection.
 *
 * The client detects touch mode with
 * `matchMedia("(pointer: coarse)").matches || navigator.maxTouchPoints > 0` — and
 * It then listens for changes to that media query. On a desktop with a
 * touchscreen (or whose primary pointer is later reported as "coarse"), this
 * can change AFTER startup. Because the setting is part of the launch key, the
 * engine then restarts in mobile mode. Reported symptoms: the game sometimes
 * switches to touch controls, and **you must hold click to look** (trackpad-style
 * drag-to-look). The client also writes an `autoexec.cfg` that runs
 * `unbind mouse1`, disabling firing.
 *
 * Keep only the explicit `?mobileControls=1` option and remove auto-detection:
 * ChaOS is played with a mouse and keyboard. `Q` and the launch key stay
 * constant, preventing unwanted restarts. The client already removes a touch
 * `autoexec.cfg` from a previous session when touch mode is false (see the
 * `FS.unlink` branch).
 */
const TOUCH_FROM = 'let Q=q||I,';
const TOUCH_TO = 'let Q=I,';

/**
 * Request mouse capture ourselves on click.
 *
 * Measured behavior on both our client and the unmodified upstream client:
 * there is no capture. The engine relies on `SDL_SetRelativeMouseMode(SDL_TRUE)`,
 * but the call comes from the render loop, outside an event handler, so
 * `emscripten_request_pointerlock(…, deferUntilInEventHandler = 0)` rejects it
 * (`-2`). ioquake3 ignores the result, sets `mouseActive = true`, and never retries.
 *
 * Emscripten supports this (`Module.elementPointerLock` installs a canvas click
 * handler that requests the lock), but this build does not use
 * `Browser.createContext`, so that handler is NEVER installed: the canvas has
 * neither a `click` nor a `keydown` listener. Install our own on the page, where
 * the request can happen during a real user gesture as required by the browser.
 *
 * The engine handles the rest: with `in_nograb 0`, SDL uses relative mouse mode
 * and reads `movementX/movementY`, which become unbounded once the lock is held.
 */
const MOUSE_LOCK_SCRIPT = `
(function () {
  // Lock the pointer on canvas click. Without this, the cursor stays visible
  // and the view is bounded by the window width.
  document.addEventListener('click', function (ev) {
    if (document.pointerLockElement) return;
    var c = document.getElementById('canvas');
    if (!c || (ev.target !== c && !c.contains(ev.target))) return;
    if (c.requestPointerLock) { try { c.requestPointerLock(); } catch (e) { /* Request denied. */ } }
  }, true);
  // The browser releases pointer lock on Escape; the next click reacquires it.
})();`;

/**
 * Audio bridge from the ChaOS window to the Quake client.
 *
 * The SDL game feeds audio from its render loop. When the parent window is
 * minimized, that loop freezes; unless the context is suspended, Chromium
 * repeats the last PCM block. Wrap the constructor early (including the
 * constructor already wrapped by the source client), then expose a same-origin
 * function that the parent can call.
 */
const AUDIO_LIFECYCLE_SCRIPT = `
(function () {
  try {
    var contexts = [];
    var NativeAudioContext = window.AudioContext || window.webkitAudioContext;
    if (!NativeAudioContext) return;
    var suspended = false;
    var revision = 0;
    function apply(context, shouldSuspend, version) {
      Promise.resolve().then(function () {
        if (version !== revision) return;
        return shouldSuspend ? context.suspend() : context.resume();
      }).catch(function () {});
    }
    function WrappedAudioContext() {
      var context = new NativeAudioContext(arguments[0]);
      contexts.push(context);
      if (suspended) apply(context, true, revision);
      return context;
    }
    WrappedAudioContext.prototype = NativeAudioContext.prototype;
    window.AudioContext = WrappedAudioContext;
    if (window.webkitAudioContext) window.webkitAudioContext = WrappedAudioContext;
    window.__CHAOS_SET_AUDIO_SUSPENDED = function (value) {
      suspended = !!value;
      var version = ++revision;
      contexts.forEach(function (context) { apply(context, suspended, version); });
    };
  } catch (e) {}
})();`;

const apply = (text, rules) => {
  let out = text, hits = 0;
  for (const [from, to] of rules) {
    const n = out.split(from).length - 1;
    if (n) { out = out.split(from).join(to); hits += n; }
  }
  return { out, hits };
};

const textFiles = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(js|mjs|css|html?)$/i.test(entry) || entry === 'game') textFiles.push(p);
  }
};
walk(DEST);

let prefixHits = 0, wsHits = 0, titleHits = 0, swHits = 0, embedHits = 0, nograbHits = 0, touchHits = 0;
for (const p of textFiles) {
  const before = readFileSync(p, 'utf8');
  let { out, hits } = apply(before, PREFIX_RULES);
  const ws = apply(out, [[WS_FROM, WS_TO]]);
  out = ws.out; wsHits += ws.hits;
  const sw = apply(out, [[SW_FROM, SW_TO]]);
  out = sw.out; swHits += sw.hits;
  const em = apply(out, [[OVERLAY_FROM, OVERLAY_TO]]);
  out = em.out; embedHits += em.hits;
  const ng = apply(out, [[NOGRAB_FROM, NOGRAB_TO]]);
  out = ng.out; nograbHits += ng.hits;
  const tc = apply(out, [[TOUCH_FROM, TOUCH_TO]]);
  out = tc.out; touchHits += tc.hits;
  const t = apply(out, [[TITLE_FROM, TITLE_TO]]);
  out = t.out; titleHits += t.hits;
  if (out !== before) { writeFileSync(p, out); prefixHits += hits; }
}
console.log(`\npréfixe : ${prefixHits} chemins ; greffe WS : ${wsHits} ; titre moteur : ${titleHits}`)
console.log(`service worker neutralisé : ${swHits} ; overlay embarqué supprimé : ${embedHits}`);
console.log(`capture souris : in_nograb ${nograbHits} remplacement(s) — verrou au clic posé dans la page`);
console.log(`touch controls: removed auto-detection ${touchHits} time(s); only ?mobileControls=1 remains`);
if (wsHits === 0) console.error('  ⚠ no WebSocket patch applied; multiplayer will not connect to our tunnel.');
if (nograbHits !== 1) console.error(`  ⚠ mouse capture: expected 1 in_nograb replacement, found ${nograbHits}`);
if (touchHits !== 1) console.error(`  ⚠ touch controls: expected 1 detection replacement, found ${touchHits}`);

// ── Phase 3: clean clone ───────────────────────────────────────────────────
const htmlPath = join(DEST, 'game');
let html = readFileSync(htmlPath, 'utf8');

// a) Static third-party blocks (external services and source social cards).
const HTML_REMOVE = [
  // Radio widget (third-party service loaded from radio.pieter.com).
  /<script src=['"]\/assets\/radio-widget\.js[^'"]*['"][^>]*><\/script>/g,
  // Google Analytics preload; the script itself comes from the bundle.
  /<link rel="preload"[^>]*googletagmanager[^>]*>/g,
  // Social and canonical metadata that points to the original publisher.
  /<link rel="canonical"[^>]*>/g,
  /<meta property="og:[^>]*>/g,
  /<meta name="twitter:[^>]*>/g,
];
let removed = 0;
for (const re of HTML_REMOVE) {
  const before = html;
  html = html.replace(re, '');
  if (html !== before) removed++;
}

// b) Inject the tunnel constant and browser hooks BEFORE the chunks, so they
// exist before the engine builds its WebSocket URL.
const HEAD_INJECT = `<script>window.__Q3_WSPATH=${JSON.stringify(WS_PATH)};${AUDIO_LIFECYCLE_SCRIPT}${MOUSE_LOCK_SCRIPT}</script>`;
html = html
  .replace(/<title>[^<]*<\/title>/, `<title>${TITLE}</title>`)
  .replace(/(<meta name="application-name" content=")[^"]*(")/, `$1${BRAND}$2`)
  // Run before the clone's async scripts so the first AudioContext created by
  // the engine can be observed, even on a fast machine.
  .replace('<head>', `<head>${HEAD_INJECT}`);

// c) The original PWA manifest starts at the site root and uses root-relative
// icon paths.
const manifestPath = join(DEST, 'manifest.json');
if (existsSync(manifestPath)) {
  const man = readFileSync(manifestPath, 'utf8');
  writeFileSync(manifestPath, man
    .replace(/"start_url"\s*:\s*"[^"]*"/, `"start_url": "${PREFIX}/game"`)
    .replace(/"name"\s*:\s*"[^"]*"/, `"name": "${TITLE}"`)
    .replace(/"short_name"\s*:\s*"[^"]*"/, `"short_name": "${BRAND}"`)
    .replace(/"src"\s*:\s*"\//g, `"src": "${PREFIX}/`));
}

// d) Empty script targeted by the Google Analytics rewrite above. It is only
// loaded if the client's analytics component runs, so it has no effect; without
// this file, however, the browser would log a 404.
writeFileSync(join(DEST, 'assets', 'noop.js'),
  "// Loaded by the original client in place of Google Analytics.\n"
  + "// See games/quake/install.mjs: no requests should leave ChaOS.\n");

// e) Extract the page's RSC payload from its own HTML.
//    The embedded Next.js router requests its route again as a "flight" payload
//    (`?…&_rsc=…`) and accepts only `text/x-component`; otherwise, it falls back
//    to a full-page navigation and reloads the game (requesting chunks twice).
//    The HTML already contains this payload in `self.__next_f.push([1,…])` calls,
//    so copy it unchanged to serve it as RSC.
const flight = [];
const flightRe = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;
for (const match of html.matchAll(flightRe)) {
  try { flight.push(JSON.parse(match[1])); } catch { /* Unexpected payload: ignore it. */ }
}
const rsc = flight.join('');
writeFileSync(join(DEST, 'game.rsc'), rsc);
console.log(`RSC payload: ${flight.length} segment(s), ${rsc.length} bytes`);
if (flight.length === 0) console.error('  ⚠ empty RSC payload: the router will reload the page.');

writeFileSync(htmlPath, html);
console.log(`clean clone: removed ${removed} HTML blocks and injected the WebSocket constant`);

// ── Marker ──────────────────────────────────────────────────────────────────
writeFileSync(join(DEST, 'INSTALL.json'), JSON.stringify({
  installedAt: new Date().toISOString(),
  prefix: PREFIX, brand: BRAND, room: ROOM, wsPath: WS_PATH,
  prefixesRewritten: prefixHits, wsGrafts: wsHits, titleRewrites: titleHits,
  htmlBlocksRemoved: removed,
  source: src,
  note: 'Local clone of the Q3JS client (ioquake3 WebAssembly), served under /quake/. See games/quake/install.mjs.',
}, null, 2) + '\n');

// ── Validation ──────────────────────────────────────────────────────────────
const problems = [];
for (const p of textFiles) {
  const t = readFileSync(p, 'utf8');
  const rel = p.slice(DEST.length + 1);
  // Broad check: any remaining `game2` text indicates an incomplete rewrite
  // (Next.js basePath, engine root, preload prefix, and so on).
  if (t.includes('game2')) problems.push(`${rel}: remaining "game2" reference`);
  // No requests should leave ChaOS: the client's analytics is rewritten to a
  // local script (see PREFIX_RULES).
  if (t.includes('googletagmanager')) problems.push(`${rel}: external analytics was not rewritten`);
  // A remaining service worker would register at the site root or fail with a
  // MIME error (see SW_FROM).
  if (t.includes('serviceWorker.register')) problems.push(`${rel}: service worker registration remains`);
  // The embedded-mode tips overlay must not reappear.
  if (t.includes(OVERLAY_FROM)) problems.push(`${rel}: embedded overlay was not removed`);
  // Without mouse capture, the cursor remains visible and view movement is
  // constrained by the window; this is a visible usability issue.
  if (t.includes(NOGRAB_FROM)) problems.push(`${rel}: in_nograb 1 remains (mouse is not captured)`);
  // Disable touch detection so the client cannot switch to touch mode mid-game
  // (touch look, held mouse input, and `unbind mouse1` in autoexec would prevent firing).
  if (t.includes(TOUCH_FROM)) problems.push(`${rel}: automatic touch detection remains`);
  // Without this handler, clicks cannot acquire pointer lock.
  if (rel === 'game' && !html.includes('requestPointerLock')) {
    problems.push('game: gestionnaire de verrou souris absent');
  }
  // WebAssembly mobile exports use the `Q3JS` prefix. They must not be renamed,
  // or touch controls will silently stop working.
  if (rel === 'ioquake3.js' && !t.includes('Q3JS_MobileInitBindings')) {
    problems.push('ioquake3.js: symboles Q3JS_Mobile* introuvables (renommage accidentel ?)');
  }
}
if (!html.includes(WS_PATH)) problems.push(`game: constante WS ${WS_PATH} absente`);
const bareGame2 = html.match(/["'(]\/game2[/"']/g);
if (bareGame2) problems.push(`game: ${bareGame2.length} référence(s) /game2 restante(s)`);
// Root-origin references would point to ChaOS files or hit the SPA catch-all
// (invalid manifest).
for (const root of ['href="/manifest.json"', 'href="/favicon.ico"', 'href="/apple-touch-icon.png"']) {
  if (html.includes(root)) problems.push(`game: référence racine restante ${root}`);
}
if (!existsSync(join(DEST, 'assets', 'noop.js'))) problems.push('assets/noop.js absent');
if (!existsSync(join(DEST, 'ioquake3.wasm'))) problems.push('ioquake3.wasm absent');
if (!existsSync(join(DEST, 'baseq3', 'pak0.pk3'))) problems.push('baseq3/pak0.pk3 absent');
// The patch must match the WebSocket URL expression exactly once.
if (wsHits !== 1) problems.push(`greffe WS attendue 1 fois, vue ${wsHits} fois`);

console.log(problems.length
  ? `\n⚠ ${problems.length} point(s) à traiter :\n  ${problems.join('\n  ')}`
  : '\n✓ clone propre : chemins préfixés, greffe WS en place, symboles mobiles intacts');
if (problems.length) process.exitCode = 1;
