#!/usr/bin/env node
/**
 * ChaOS — Minecraft client setup script
 *
 * Installs the EaglerCraft 1.8 standalone web client so the Minecraft WM
 * window can serve it from games/minecraft/web/eaglercraft.html.
 *
 * Usage (from project root):
 *   node scripts/games/setup-minecraft-client.mjs
 *
 * What it does:
 *   1. Looks for an existing offline client file in the project (games/minecraft/data/).
 *   2. Copies it to games/minecraft/web/eaglercraft.html.
 *   3. The window manager's iframe (/mc/) auto-redirects to it on next open.
 *
 * The client connects to ws(s)://<hostname>:25565 — the same port the
 * Minecraft server listens on.  EaglerXServer's dual_stack mode (default)
 * handles both vanilla TCP and browser WebSocket on port 25565.
 *
 * NOTE: As of mid-2025 there is no longer a canonical official download URL
 * for the standalone EaglerCraft client.  Each server hosts its own build.
 * Use the WASM-GC version (preferred) obtained from your server's Discord/site
 * and place it in games/minecraft/data/ before running this script.
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../../..');
const OUT_DIR = resolve(ROOT, 'games', 'minecraft', 'web');
const OUT_FILE = resolve(OUT_DIR, 'eaglercraft.html');

// ── Local search paths (checked in order) ─────────────────────────────────
// Place any of these files in your project to let this script auto-install.
const LOCAL_CANDIDATES = [
  resolve(ROOT, 'games', 'minecraft', 'data', 'EaglercraftX_1.8.html'),
  resolve(ROOT, 'games', 'minecraft', 'data', 'EaglercraftX_1.8_Offline_Download_WASM.html'),
  resolve(ROOT, 'games', 'minecraft', 'data', 'EaglercraftX_1.8_Offline_Download_JS.html'),
  resolve(ROOT, 'EaglercraftX_1.8.html'),
];

// ── Main ──────────────────────────────────────────────────────────────────
if (!existsSync(OUT_DIR)) {
  mkdirSync(OUT_DIR, { recursive: true });
}

if (existsSync(OUT_FILE)) {
  const { size } = (await import('node:fs')).statSync(OUT_FILE);
  // If it's a tiny file it's probably the placeholder page, not the real client
  if (size > 1_000_000) {
    console.info(
      `✓ Already installed: games/minecraft/web/eaglercraft.html (${(size / 1_048_576).toFixed(1)} MB)`,
    );
    console.info('  Delete the file and re-run to reinstall.');
    process.exit(0);
  }
  console.info(
    `  Found games/minecraft/web/eaglercraft.html but it looks like a placeholder (${size} bytes) — overwriting.`,
  );
}

// 1. Try local candidates
const found = LOCAL_CANDIDATES.find((p) => existsSync(p));
if (found) {
  copyFileSync(found, OUT_FILE);
  const { size } = (await import('node:fs')).statSync(OUT_FILE);
  console.info(
    `✓ Installed from ${basename(found)} → games/minecraft/web/eaglercraft.html (${(size / 1_048_576).toFixed(1)} MB)`,
  );
  console.info(`
Next steps:
  1. Start the Minecraft server:
       docker compose up minecraft

  2. Open the Minecraft window in the ChaOS UI.
     The iframe loads /mc/ which auto-redirects to the client.

  3. In the EaglerCraft client → Multiplayer → the server address is
     pre-filled as ws(s)://<hostname>:25565.
`);
  process.exit(0);
}

// 2. Nothing found — print instructions
console.error(`
✗ No EaglerCraft offline client found.

There is no longer a single official download URL for the standalone client.
Obtain the WASM-GC version from your preferred EaglerCraft server's website
or Discord, then:

  Option A — place the file in games/minecraft/data/ and re-run this script:
    games/minecraft/data/EaglercraftX_1.8.html  ← rename to this

  Option B — place it directly (skip this script):
    games/minecraft/web/eaglercraft.html              ← copy/rename to this

The WASM-GC version is recommended over the legacy JS version.
`);
process.exit(1);
