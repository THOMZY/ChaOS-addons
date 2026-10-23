#!/usr/bin/env node
/**
 * install.mjs — installs the Surf client in ChaOS as a clean clone (Surf add-on,
 * ChaOS-games). Runs from the site once the add-on code is installed:
 *   node games/surf/install.mjs <source-directory>
 *
 * The original client expects to be served from a domain root, uses ABSOLUTE
 * paths (/assets/, /packed/, /previews/, /brand/), and includes its own account,
 * leaderboards, servers, and Discord integration. ChaOS already uses /assets/,
 * so this game is served under /surf/ and those prefixes are rewritten.
 *
 * Three phases:
 *   1. copy          — useful files from the mirror to games/surf/data
 *   2. prefix        — rewrite absolute paths (/packed/ -> /surf/packed/)
 *   3. clean clone   — remove original branding, account/online UI, Discord,
 *                      external credits, storage keys, Vercel analytics, and
 *                      Cloudflare Turnstile
 *
 * Usage: node games/surf/install.mjs <source-directory>
 *
 * <source-directory> = client mirror (index.html, assets/, packed/, previews/,
 * brand/). The ~850 MB of assets are NOT versioned; they stay on disk and are
 * bind-mounted on the VPS (games/surf/data).
 *
 * Idempotent: safe to rerun; every run starts from the source.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// This file lives in games/surf/ once installed: the add-on is its directory.
const ADDON = dirname(fileURLToPath(import.meta.url));
const DEST = resolve(ADDON, 'data');
const PREFIX = '/surf';

// Brand shown in place of the original client branding.
// ← CHANGE THIS LINE ONLY to rename the game.
const BRAND = 'ChaOS';
const WORDMARK = 'surf';       // Menu logo, first segment.
const WORDMARK_TLD = 'chaos';  // Muted second segment (<i>), shown as "surf.chaos".

const src = process.argv[2];
// --no-copy: quick iteration. Rewrite rules are NOT idempotent (prefixing
// "/surf/packed/" again would produce "/surf/surf/packed/"), so restore text
// files (index.html and assets/) from source and reuse unchanged binary folders.
const NO_COPY = process.argv.includes('--no-copy');
if (!src) {
  console.error('Usage: node games/surf/install.mjs <source-directory> [--no-copy]');
  process.exit(1);
}
if (!existsSync(join(src, 'index.html')) || !existsSync(join(src, 'packed')) || !existsSync(join(src, 'assets'))) {
  console.error(`Invalid source: ${src} (expected index.html, assets/, and packed/)`);
  process.exit(1);
}

// Only the original client's main page is included; its legal pages and social
// card belong to the original project and are not copied.
const DIRS  = ['assets', 'packed', 'previews', 'brand', 'menu'];
const PAGES = ['index.html'];

// ── Phase 1: copy ────────────────────────────────────────────────────────────
console.info(`source: ${src}`);
console.info(`target: ${DEST}`);
if (NO_COPY && existsSync(join(DEST, 'index.html'))) {
  // packed/ manifests are recompressed on each pass, so restore them from the
  // source too; otherwise pack URLs would be prefixed a second time.
  mkdirSync(DEST, { recursive: true });
  cpSync(join(src, 'index.html'), join(DEST, 'index.html'));
  cpSync(join(src, 'assets'), join(DEST, 'assets'), { recursive: true });
  cpSync(join(src, 'menu'), join(DEST, 'menu'), { recursive: true });
  // Restore all 20 manifests (~700 KB) from source on each pass to avoid
  // prefixing their pack URLs a second time.
  mkdirSync(join(DEST, 'packed'), { recursive: true });
  for (const f of readdirSync(join(src, 'packed'))) {
    if (f.endsWith('.visual-manifest.gz')) cpSync(join(src, 'packed', f), join(DEST, 'packed', f));
  }
  console.info('  --no-copy: restored index.html, assets, and manifests; kept binaries');
} else {
  // Wipe the CONTENTS, not the folder: on Windows a handle on the directory
  // itself (a terminal sitting in it, an editor, the indexer) makes `rm` fail
  // with EPERM while every child remains removable.
  if (existsSync(DEST)) {
    for (const entry of readdirSync(DEST)) {
      rmSync(join(DEST, entry), { recursive: true, force: true, maxRetries: 6, retryDelay: 250 });
    }
  }
  mkdirSync(DEST, { recursive: true });

  for (const d of DIRS) {
    const s = join(src, d);
    if (!existsSync(s)) { console.info(`  (missing) ${d}/`); continue; }
    cpSync(s, join(DEST, d), { recursive: true });
    console.info(`  copied  ${d}/`);
  }
  for (const p of PAGES) {
    cpSync(join(src, p), join(DEST, p));
    console.info(`  copied  ${p}`);
  }
}

// ── Phase 2: /surf prefix ────────────────────────────────────────────────────
// Apply each pattern once; inserted text is never processed again.
const PREFIX_RULES = [
  ['/packed/',        `${PREFIX}/packed/`],
  ['/previews/',      `${PREFIX}/previews/`],
  ['/assets/',        `${PREFIX}/assets/`],
  ['/brand/',         `${PREFIX}/brand/`],
  // Cosmetics art (`/menu/cosmetics/{store,render}`) and the menu flythrough
  // clips (`/menu/flythrough/*`) are fetched by the client from the origin
  // root. Unprefixed, they 404: the loadout shows no outfit and the menu is
  // static.
  ['/menu/',          `${PREFIX}/menu/`],
  // Vite's lazy-chunk preloader hardcodes the deployment base: it turns the
  // `__vite__mapDeps` entries ("assets/moderation-*.js") into a ROOT-absolute
  // `/assets/…`. On ChaOS that is the SITE's /assets, so the moderation chunk
  // 404s and its panel refuses to open ("Couldn't open Moderation"). The
  // parameter name is minified and drifts, so the rule matches the generated
  // body, not the identifier.
  ['){return"/"+',    `){return"${PREFIX}/"+`],
  ['`/maps/',         `\`${PREFIX}/maps/`],
  ['`/replays/',      `\`${PREFIX}/replays/`],
  // The client VALIDATES visual pack URLs with a regex requiring "/packed/"
  // (see I8(): throw "Invalid visual pack"). This is the bundle's only path
  // validation, so allow the prefixed path too.
  ['\\/packed\\/', `\\${PREFIX}\\/packed\\/`],
];
// Unchanged: "/servers/", "/ping" (multiplayer), "/index.html", and "/_vercel/…".

const apply = (text, rules) => {
  let out = text, hits = 0;
  for (const [from, to] of rules) {
    const n = out.split(from).length - 1;
    if (n) { out = out.split(from).join(to); hits += n; }
  }
  return { out, hits };
};

const assetsDir = join(DEST, 'assets');
let prefixHits = 0;
for (const f of readdirSync(assetsDir)) {
  if (!f.endsWith('.js') && !f.endsWith('.css')) continue;
  const p = join(assetsDir, f);
  const { out, hits } = apply(readFileSync(p, 'utf8'), PREFIX_RULES);
  if (hits) { writeFileSync(p, out); prefixHits += hits; }
}

const idxPath = join(DEST, 'index.html');
let html = readFileSync(idxPath, 'utf8');
({ out: html } = apply(html, [
  ['/assets/', `${PREFIX}/assets/`],
  ['/previews/', `${PREFIX}/previews/`],
  ['/brand/', `${PREFIX}/brand/`],
]));
prefixHits += 7;

// Visual pack URLs live IN the served manifest, not in the bundle. The
// `entries[].url` (/maps/<slug>/…) values are internal keys that the bundle
// never reconstructs, so leave them unchanged.
const packedDir = join(DEST, 'packed');
let manifests = 0, packUrls = 0;
for (const f of readdirSync(packedDir)) {
  if (!f.endsWith('.visual-manifest.gz')) continue;
  const p = join(packedDir, f);
  const txt = gunzipSync(readFileSync(p)).toString('utf8');
  const out = txt.split('"/packed/').join(`"${PREFIX}/packed/`);
  if (out !== txt) {
    writeFileSync(p, gzipSync(Buffer.from(out, 'utf8')));
    manifests++; packUrls += txt.split('"/packed/').length - 1;
  }
}
console.info(`\nprefix: bundle/html=${prefixHits} paths, ${manifests} manifests (${packUrls} URLs)`);

// ── Phase 3: clean clone ─────────────────────────────────────────────────────
// a) Bundle: branding, UI text, storage keys, and external references.
//    Order matters: lowercase storage keys first, then longer phrases, then
//    remaining capitalized names.
const CLEAN_RULES = [
  // Clear the embedded Vercel analytics host allowlist so analytics cannot be
  // enabled, even if the host changes. Apply FIRST because it contains strings
  // that resemble the storage keys below.
  ['["surfd.net","www.surfd.net","surfd-five.vercel.app"]', '[]'],
  // Lowercase storage keys and technical identifiers.
  ['"surfd.',                      '"chaos.surf.'],
  // Remove the guest concept from local browser keys as well.
  ['chaos.surf.guest-room.v1',     'chaos.surf.room.v1'],
  ['chaos.surf.guest-run.v1',      'chaos.surf.run.v1'],
  ['surfd-retained-replays',       'chaos-surf-retained-replays'],
  ['surfd_signup_username',        'chaos_surf_signup_username'],
  ['"surfd-v1"',                   '"chaos-surf-v1"'],   // Multiplayer subprotocol.
  // Forms the `"surfd.` rule does not cover: a key template (backtick), a
  // download filename (backtick too), an internal error domain, and a DOM
  // event name.
  ['`surfd-${',                    '`chaos-surf-${'],
  ['surfd.start-position.v1',      'chaos.surf.start-position.v1'],
  ['surfd.invalid',                'chaos.invalid'],
  ['surfd-moderate',               'chaos-surf-moderate'],
  // textes d'interface (phrases longues d'abord)
  ['Close other Surfd tabs and try again.',  'Close other tabs and try again.'],
  ['Another Surfd tab is blocking run storage.', 'Another tab is blocking run storage.'],
  ['Close other Surfd tabs and retry.',      'Close other tabs and retry.'],
  ['Your Surfd account',                     'Your account'],
  ['to a Surfd account.',                    'to an account.'],
  ['New Surfd record!',                      'New record!'],
  ['Records — Surfd',                        'Records'],
  ['Replay — Surfd',                         'Replay'],
  ['Surfd — Classic surf',                   `${BRAND} — Surf`],
  ['Surfd — Surf the web',                   `${BRAND} — Surf`],
  ['Surfd Timer',                            'Run timer'],
  ['Surfd players',                          'Players'],
  ['Surfd ranks',                            'Ranks'],
  [' · Surfd',                               ` · ${BRAND}`],
  [' in Surfd.',                             ` on ${BRAND}.`],
  [' on Surfd ',                             ` on ${BRAND} `],
  ['Connected to Surfd ',                    `Connected to ${BRAND} `],
  ['"Surfd "+',                              `"${BRAND} "+`],
  ['q="Surfd"',                              `q="${BRAND}"`],
  ['Reload Surfd.',                          'Reload the page.'],
  ['[Surfd]',                                '[surf]'],
  // Share-card wordmark drawn on a canvas, and the invite link the client
  // builds when a room is shared (a template literal, so ${…} is interpolated).
  ['SURFD.NET',                              BRAND.toUpperCase()],
  ['SURFD',                                  BRAND.toUpperCase()],
  ['Invite link: surfd.net/?join=',          'Invite link: ${location.origin}/surf/?join='],
  // Fallback: replace any remaining capitalized occurrence.
  ['Surfd',                                  BRAND],
];
// b) Original logo classes.
const CLASS_RULES = [['surfd-mark', 'surf-mark']];

const cleanBundle = (text) => {
  const { out, hits } = apply(text, CLEAN_RULES);
  const cls = apply(out, CLASS_RULES);
  return { out: cls.out, hits: hits + cls.hits };
};

let cleanHits = 0;
for (const f of readdirSync(assetsDir)) {
  const p = join(assetsDir, f);
  if (f.endsWith('.js') || f.endsWith('.css')) {
    const { out, hits } = cleanBundle(readFileSync(p, 'utf8'));
    if (hits) { writeFileSync(p, out); cleanHits += hits; }
  }
}
({ out: html, hits: cleanHits } = cleanBundle(html));

// c) HTML: remove static third-party blocks.
//
// The menu footer is rebuilt rather than dropped: its legal pages are not
// copied (their links would 404), but the author credit stays — it is the
// attribution of an imported client.
html = html.replace(/\s*<nav class="menu-legal"[^>]*>([\s\S]*?)<\/nav>/g, (_match, inner) => {
  const credit = inner.match(/<a href="https:\/\/x\.com\/[^"]*"[\s\S]*?<\/a>/);
  return credit ? `\n    <nav class="menu-legal" aria-label="Credits">${credit[0]}</nav>` : '';
});

const HTML_REMOVE = [
  // Original client's Discord invitation.
  /\s*<a id="discord"[\s\S]*?<\/a>/g,
  // Map selector "made by" credit.
  /\s*<a class="creator-credit"[\s\S]*?<\/a>/g,
  // Social cards (original branding assets).
  /\s*<meta property="og:[^>]*>/g,
  /\s*<meta name="twitter:[^>]*>/g,
  /\s*<link rel="canonical"[^>]*>/g,
];
let removed = 0;
for (const re of HTML_REMOVE) {
  const before = html;
  html = html.replace(re, '');
  if (html !== before) removed++;
}
console.info(`clean clone: bundle=${cleanHits} strings, ${removed} HTML blocks removed`);

// d) Chrome: tab title, logo, window titles, and badge.
//
// The wordmark markup drifts between client generations (`surfd.` with a
// classed period, then `surfd<i>.net</i>`), so the whole span is rewritten
// instead of matching its inner markup.
html = html
  .replace(/<title>[^<]*<\/title>/, `<title>${BRAND} — Surf</title>`)
  .replace(/(<span id="brand-title">)[\s\S]*?(<\/span>)/, `$1${WORDMARK}<i>.${WORDMARK_TLD}</i>$2`)
  .replace(/Settings — Surfd/, 'Settings')
  .replace(/Play — Surfd/, 'Play');

const brandSpan = html.match(/<span id="brand-title">[\s\S]*?<\/span>/);
if (!brandSpan) console.info('⚠ brand wordmark not found — check the menu markup');

// e) Clone styles: hide original UI that the bundle rebuilds at runtime and
//    cannot have removed from the DOM without breaking it. !important overrides
//    inline styles applied by the bundle.
//
//    The account page is reduced to the ChaOS identity. Signing out of the site,
//    renaming and deleting the account all belong to ChaOS, not to the game.
//    Everything here is HIDDEN, never removed: the bundle attaches listeners to
//    those nodes and a missing element makes the whole page throw.
const HIDE_CSS = `
  <style id="chaos-clean-clone">
    /* Global ranks/points make no sense for a small group of friends; the useful
       leaderboard is the per-map one (time + replay). */
    #leaderboard,
    /* Account page: identity is the ChaOS account, so there is nothing to manage
       here — no sign-out, no public username, no account deletion. */
    #online-signout, #online-name-form, #online-name-policy, #online-name-locked,
    #online-moderate-names, #online-delete-section,
    /* Provider sign-in, guest onboarding and email registration are unused. */
    #online-guest, #online-providers, #online-provider-note, #online-footnote,
    #finish-email, #finish-save-guest, #finish-discard-guest,
    .finish-share-actions, .finish-providers,
    /* Original project's monetisation: a store and a supporter subscription. */
    #support-button, #store, .store-pack,
    .discord-link, .creator-credit, .reference-link { display: none !important; }
  </style>
</head>`;
html = html.replace('</head>', HIDE_CSS);

// f) Account adapter. The client dynamically imports a bundled Supabase SDK
//    (`assets/index-<hash>.js`) to check for a session and upload replays. Without
//    a Supabase server, it thinks it is signed out, labels everything "local",
//    and stores nothing server-side. Replace the SDK with our adapter, which
//    reads the ChaOS account through the site API. See
//    games/surf/server/client-adapter.js.
const sdkFile = readdirSync(assetsDir).find((f) => /^index-[A-Za-z0-9_-]+\.js$/.test(f));
if (sdkFile) {
  const adaptateur = readFileSync(resolve(ADDON, 'server', 'client-adapter.js'), 'utf8');
  writeFileSync(join(assetsDir, sdkFile), adaptateur);
  console.info(`Account adapter written to ${sdkFile}`);
} else {
  console.info('Account adapter: SDK not found; client will remain local');
}

// g) Keep only the asset generation actually served. The mirror keeps every
//    generation (useful for comparing), the installation does not: a previous
//    `game-*.js`/`game-*.css` is ~1 MB of dead weight, and its workers,
//    `email-auth` and moderation chunks are just as stale.
//
//    The test is "does this filename appear in the page or in the entry bundle",
//    not a path prefix: chunks are referenced in several shapes
//    (`/surf/assets/x.js`, `./x.js`, `new URL(…)`) and a prefix rule silently
//    deletes the Supabase SDK that the account adapter replaces.
const entryTxt = readFileSync(join(assetsDir, html.match(/assets\/(game-[A-Za-z0-9_-]+\.js)/)[1]), 'utf8');
for (const f of readdirSync(assetsDir)) {
  if (!/\.(?:js|css)$/.test(f)) continue;
  if (!html.includes(f) && !entryTxt.includes(f)) {
    rmSync(join(assetsDir, f));
    console.info(`  previous generation removed: ${f}`);
  }
}

writeFileSync(idxPath, html);

// ── Menu flythrough manifest ─────────────────────────────────────────────────
// The clips are DATA, not bundle code: `menu/flythrough/manifest.json` carries
// its own `src`/`poster`/`thumb` paths, so the prefix rules above never reach
// them. Left untouched, the client fetches `/menu/flythrough/<map>.webm` at the
// SITE root (404) and the menu falls back to a static backdrop — the animation
// silently disappears while every file is present on disk.
const flythroughManifest = join(DEST, 'menu', 'flythrough', 'manifest.json');
if (existsSync(flythroughManifest)) {
  const clips = JSON.parse(readFileSync(flythroughManifest, 'utf8'));
  let rewritten = 0;
  const withPrefix = (value) => {
    if (typeof value !== 'string' || !value.startsWith('/menu/')) return value;
    rewritten++;
    return `${PREFIX}${value}`;
  };
  const patched = clips.map((clip) => Object.fromEntries(
    Object.entries(clip).map(([key, value]) => [key, withPrefix(value)]),
  ));
  writeFileSync(flythroughManifest, JSON.stringify(patched, null, 2) + '\n');
  console.info(`flythrough: ${patched.length} clips, ${rewritten} prefixed paths`);
}

// ── Server catalogue ─────────────────────────────────────────────────────────
// The client compares its embedded catalogue (six fields per map: id, slug,
// version, boardId, geometrySha256, physicsSha256 + the physics config) with
// what the server announces in `config.maps`. A stale copy does not break the
// game or multiplayer: it only refuses RANKED play with "This game version is
// out of date", which blames the player and cannot be fixed by reloading.
//
// Both server files are therefore GENERATED from the installed bundle, never
// hand-edited:
//   games/surf/server/boards.json  → catalogue, verbatim
//   games/surf/server/maps.json    → rotation ids + display titles
const SERVER_GAMES_DIR = resolve(ADDON, 'server');
const TITLE_OVERRIDES = { sandtrap2: 'Sandtrap 2' };

function extractCatalogue(text) {
  const marker = 'JSON.parse(\'[{"id":"surf_';
  const at = text.indexOf(marker);
  if (at < 0) return null;
  let i = at + 'JSON.parse(\''.length;
  const out = [];
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') { out.push(text[i], text[i + 1]); i++; continue; }
    if (c === "'") break;
    out.push(c);
  }
  return JSON.parse(out.join(''));
}

const entryBundle = readdirSync(assetsDir).find((f) => /^game-[A-Za-z0-9_-]+\.js$/.test(f));
const catalogue = entryBundle ? extractCatalogue(readFileSync(join(assetsDir, entryBundle), 'utf8')) : null;
if (!catalogue?.length) {
  console.info('⚠ map catalogue not found in the installed bundle — server catalogue left untouched');
} else {
  // The mirror writes the same catalogue next to the source: a mismatch means
  // the install ran on a partially synced mirror, which is worth knowing.
  const fromSource = existsSync(join(src, 'catalogue.json'))
    ? JSON.parse(readFileSync(join(src, 'catalogue.json'), 'utf8'))
    : null;
  if (fromSource && fromSource.length !== catalogue.length) {
    console.info(`⚠ source catalogue has ${fromSource.length} maps, bundle has ${catalogue.length} — bundle wins`);
  }

  const title = (slug) => TITLE_OVERRIDES[slug]
    ?? slug.split('-').filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

  writeFileSync(join(SERVER_GAMES_DIR, 'boards.json'), JSON.stringify(catalogue, null, 1) + '\n');
  writeFileSync(join(SERVER_GAMES_DIR, 'maps.json'),
    JSON.stringify(catalogue.map((m) => ({ id: m.id, slug: m.slug, title: title(m.slug) })), null, 1) + '\n');
  console.info(`server catalogue: ${catalogue.length} maps written to boards.json + maps.json`);
}

// ── Installation marker ─────────────────────────────────────────────────────────────────
writeFileSync(join(DEST, 'INSTALL.json'), JSON.stringify({
  installedAt: new Date().toISOString(),
  prefix: PREFIX, brand: BRAND, wordmark: WORDMARK,
  bundlePathsRewritten: prefixHits, manifestsPatched: manifests, packUrlsRewritten: packUrls,
  cleanCloneStrings: cleanHits, htmlBlocksRemoved: removed,
  maps: catalogue?.length ?? null,
  source: src,
  note: 'Local clone of the Surf client served under /surf/. See games/surf/install.mjs.',
}, null, 2) + '\n');

// ── Checks ──────────────────────────────────────────────────────────────────
const problems = [];
for (const f of readdirSync(assetsDir)) {
  const p = join(assetsDir, f);
  if (!f.endsWith('.js') && !f.endsWith('.css')) continue;
  const t = readFileSync(p, 'utf8');
  for (const root of ['/packed/', '/previews/', '/brand/', '/menu/']) {
    if (t.split('"').some(s => s.startsWith(root))) problems.push(`${f}: chemin nu ${root}`);
  }
  // Lazy chunks: the Vite preloader must not build root-absolute URLs.
  if (t.includes('__vite__mapDeps') && t.includes('){return"/"+')) {
    problems.push(`${f}: Vite preloader still rooted at / (deferred chunk returns 404)`);
  }
  // Any remaining traces of the original brand.
  for (const m of new Set((t.match(/surfd/gi) || []))) {
    const ctx = t.slice(Math.max(0, t.search(/surfd/i) - 40), t.search(/surfd/i) + 40).replace(/\s+/g, ' ');
    problems.push(`${f}: « ${m} » restant … ${ctx} …`);
  }
}
// ── Phase 4: prune the visual data down to what the served client uses ───────
// The mirror keeps every generation (useful for comparing). The installation
// must keep only one: the manifests the entry bundle references, and the packs
// those manifests announce. Otherwise the mirror's previous generation is
// restored by --no-copy and the verification reports its 312 missing packs.
const entryJs = readdirSync(assetsDir).find((f) => /^game-[A-Za-z0-9_-]+\.js$/.test(f));
if (entryJs) {
  const bundleTxt = readFileSync(join(assetsDir, entryJs), 'utf8');
  const manifestRefs = new Set(
    [...bundleTxt.matchAll(/([a-f0-9]{64})\.visual-manifest\.gz/g)].map((m) => `${m[1]}.visual-manifest.gz`),
  );
  if (manifestRefs.size) {
    // Manifests the client does not reference: drop them and remember the packs
    // the surviving ones need.
    const packsVoulus = new Set();
    for (const f of readdirSync(packedDir)) {
      if (!f.endsWith('.visual-manifest.gz')) continue;
      if (!manifestRefs.has(f)) { rmSync(join(packedDir, f)); continue; }
      const man = JSON.parse(gunzipSync(readFileSync(join(packedDir, f))).toString('utf8'));
      for (const pack of man.packs) packsVoulus.add(pack.url.slice(`${PREFIX}/packed/`.length));
    }
    let orphelins = 0;
    for (const f of readdirSync(packedDir)) {
      if (f.endsWith('.visual-assets.gz') && !packsVoulus.has(f)) { rmSync(join(packedDir, f)); orphelins++; }
    }
    console.info(`visual data: ${manifestRefs.size} manifest(s) kept, ${packsVoulus.size} pack(s) kept, ${orphelins} orphan(s) removed`);
  }
}

let packs = 0;
for (const f of readdirSync(packedDir)) {
  if (!f.endsWith('.visual-manifest.gz')) continue;
  const man = JSON.parse(gunzipSync(readFileSync(join(packedDir, f))).toString('utf8'));
  for (const pack of man.packs) {
    packs++;
    if (!pack.url.startsWith(`${PREFIX}/packed/`)) problems.push(`unprefixed pack: ${pack.url}`);
    if (!existsSync(join(DEST, pack.url.slice(PREFIX.length)))) problems.push(`pack absent : ${pack.url}`);
    if (!pack.entries.every(e => e.url.startsWith('/maps/'))) problems.push('altered /maps/ entry');
  }
}
if (existsSync(flythroughManifest)) {
  const raw = readFileSync(flythroughManifest, 'utf8');
  for (const m of raw.matchAll(/"(\/menu\/[^"]*)"/g)) problems.push(`flythrough: unprefixed path ${m[1]}`);
}
const leftInHtml = html.match(/surfd/gi);
console.info(`Verified packs: ${packs}`);
if (leftInHtml) problems.push(`index.html : ${leftInHtml.length} « surfd » restant`);
console.info(problems.length ? `\n⚠ ${problems.length} issue(s) to resolve:\n  ${problems.slice(0, 12).join('\n  ')}`
                            : '\n✓ clean clone: no unprefixed paths or remaining "surfd" references');
if (problems.length) process.exitCode = 1;
