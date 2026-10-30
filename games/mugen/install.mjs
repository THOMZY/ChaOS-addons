#!/usr/bin/env node
// Installs the MUGEN engine into games/mugen/data/engine/ and prepares the pack folders.
//
//   node games/mugen/install.mjs                  install the engine shipped with the add-on
//   node games/mugen/install.mjs --download       download the release built for engine/engine.json
//   node games/mugen/install.mjs --bundle <dir>   install a bundle made by engine/build.mjs
//   node games/mugen/install.mjs --build          clone the pinned commits and build (git and Go)
//
// Characters go in games/mugen/data/Characters/<folder>/, stages in
// games/mugen/data/Stages/<folder>/. Packs are never touched by this script.
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEngine } from './engine/build.mjs';
import { readPins, releaseUrl } from './engine/pins.mjs';
import { BUNDLED_ARCHIVE, unpackBundledEngine, validateBundle } from './engine/bundle.mjs';

const DATA = fileURLToPath(new URL('./data/', import.meta.url));
const ENGINE = join(DATA, 'engine');

function parse(argv) {
  const options = { bundle: null, build: false, download: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--bundle') options.bundle = argv[++index];
    else if (arg === '--build') options.build = true;
    else if (arg === '--download') options.download = true;
    else throw new Error(`unknown option ${arg}`);
  }
  if (options.bundle === undefined) throw new Error('--bundle requires a directory');
  if (Number(Boolean(options.bundle)) + Number(options.build) + Number(options.download) > 1)
    throw new Error('choose only one of --bundle, --build or --download');
  return options;
}

/** Replaces data/engine/ in two renames, so the site never serves half an engine. */
function installBundle(directory) {
  const stamp = validateBundle(directory);
  const next = ENGINE + '.next',
    old = ENGINE + '.old';
  rmSync(next, { recursive: true, force: true });
  rmSync(old, { recursive: true, force: true });
  cpSync(directory, next, { recursive: true });
  if (existsSync(ENGINE)) renameSync(ENGINE, old);
  renameSync(next, ENGINE);
  rmSync(old, { recursive: true, force: true });
  return stamp;
}

async function download(work) {
  const url = releaseUrl(readPins());
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status} (try --build)`);
  const archive = join(work, 'engine.tar.gz');
  writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
  const bundle = join(work, 'bundle');
  mkdirSync(bundle);
  execFileSync('tar', ['-xzf', archive, '-C', bundle], { windowsHide: true });
  return bundle;
}

function buildFromSource(work) {
  const pins = readPins();
  const checkouts = {};
  for (const key of ['ikemen', 'screenpack']) {
    const directory = join(work, key);
    execFileSync('git', ['init', '-q', directory], { windowsHide: true });
    execFileSync(
      'git',
      ['-C', directory, 'fetch', '-q', '--depth', '1', pins[key].repository, pins[key].commit],
      { windowsHide: true, stdio: 'inherit' },
    );
    execFileSync('git', ['-C', directory, 'checkout', '-q', 'FETCH_HEAD'], {
      windowsHide: true,
    });
    checkouts[key] = directory;
  }
  const bundle = join(work, 'bundle');
  buildEngine({ ...checkouts, out: bundle });
  return bundle;
}

try {
  const options = parse(process.argv.slice(2));
  mkdirSync(join(DATA, 'Characters'), { recursive: true });
  mkdirSync(join(DATA, 'Stages'), { recursive: true });
  const work = mkdtempSync(join(tmpdir(), 'mugen-engine-'));
  try {
    const bundle =
      options.bundle ??
      (options.build
        ? buildFromSource(work)
        : !options.download && existsSync(BUNDLED_ARCHIVE)
          ? unpackBundledEngine(work)
          : await download(work));
    const stamp = installBundle(bundle);
    console.info(`[mugen] engine ${stamp.version} installed in ${ENGINE}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
} catch (error) {
  console.error(`[mugen] install: ${error.message}`);
  process.exitCode = 1;
}
