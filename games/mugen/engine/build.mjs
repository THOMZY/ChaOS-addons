#!/usr/bin/env node
// Builds the MUGEN engine bundle from checkouts of the pinned commits:
//
//   node mugen/engine/build.mjs --ikemen <ikemen-go-web> --screenpack <screenpack> --out <dir>
//
// <dir> receives what games/mugen/data/engine/ must contain:
//   ikemen.<hash>.wasm     the engine (GOOS=js GOARCH=wasm)
//   wasm_exec.<hash>.js    Go's loader, from the same Go toolchain
//   fs/                    engine scripts and data, screenpack data and fonts
//   engine.json            pins, file names and the list of fs/ files
// The checkouts must sit at the commits of engine.json (--any-commit to try others).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { applyPatches } from './patches.mjs';
import { applySourcePatches } from './source-patches.mjs';
import { readPins } from './pins.mjs';
import { walk } from '../server/catalog.js';

// Taken from each checkout into fs/. Characters, stages, videos and the
// screenpack's sources are left out: ChaOS serves its own packs.
const ENGINE_TREES = ['data', 'font', 'external/script', 'external/icons'];
const SCREENPACK_TREES = ['data', 'font'];

function parse(argv) {
  const options = { anyCommit: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--any-commit') options.anyCommit = true;
    else if (['--ikemen', '--screenpack', '--out'].includes(arg))
      options[arg.slice(2)] = argv[++index];
    else throw new Error(`unknown option ${arg}`);
  }
  for (const key of ['ikemen', 'screenpack', 'out'])
    if (!options[key]) throw new Error(`--${key} <directory> is required`);
  return options;
}

const run = (command, args, options = {}) =>
  execFileSync(command, args, {
    encoding: 'utf8',
    ...options,
    windowsHide: true,
  }).trim();
const hashOf = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

function checkCommit(directory, expected, name, anyCommit) {
  const head = run('git', ['-C', directory, 'rev-parse', 'HEAD']);
  if (head !== expected && !anyCommit)
    throw new Error(`${name} is at ${head}, engine.json pins ${expected}`);
  return head;
}

export function buildEngine({ ikemen, screenpack, out, anyCommit = false }) {
  const pins = readPins();
  const ikemenDir = resolve(ikemen),
    screenpackDir = resolve(screenpack),
    outDir = resolve(out);
  const ikemenCommit = checkCommit(ikemenDir, pins.ikemen.commit, 'ikemen-go-web', anyCommit);
  const screenpackCommit = checkCommit(
    screenpackDir,
    pins.screenpack.commit,
    'screenpack',
    anyCommit,
  );
  const goVersion = run('go', ['env', 'GOVERSION']);
  if (!goVersion.startsWith('go' + pins.go) && !anyCommit)
    throw new Error(`Go ${pins.go} expected, found ${goVersion}`);

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, 'fs'), { recursive: true });
  const sources = join(outDir, '.source');
  cpSync(ikemenDir, sources, {
    recursive: true,
    filter: (path) => !path.replaceAll('\\', '/').split('/').includes('.git'),
  });
  applySourcePatches(sources);
  const wasmTemp = join(outDir, 'ikemen.wasm');
  run('go', ['build', '-trimpath', '-buildvcs=false', '-o', wasmTemp, './src'], {
    cwd: sources,
    env: {
      ...process.env,
      GOOS: 'js',
      GOARCH: 'wasm',
      CGO_ENABLED: '0',
      GOEXPERIMENT: 'arenas',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const goRoot = run('go', ['env', 'GOROOT']);
  const loaderSource = [
    join(goRoot, 'lib/wasm/wasm_exec.js'),
    join(goRoot, 'misc/wasm/wasm_exec.js'),
  ].find(existsSync);
  if (!loaderSource) throw new Error('wasm_exec.js not found in GOROOT');

  const wasm = `ikemen.${hashOf(wasmTemp).slice(0, 12)}.wasm`;
  const loader = `wasm_exec.${hashOf(loaderSource).slice(0, 12)}.js`;
  copyFileSync(wasmTemp, join(outDir, wasm));
  rmSync(wasmTemp);
  rmSync(sources, { recursive: true, force: true });
  copyFileSync(loaderSource, join(outDir, loader));

  for (const tree of ENGINE_TREES)
    cpSync(join(ikemenDir, tree), join(outDir, 'fs', tree), {
      recursive: true,
    });
  for (const tree of SCREENPACK_TREES)
    cpSync(join(screenpackDir, tree), join(outDir, 'fs', tree), {
      recursive: true,
      force: false,
    });
  applyPatches(join(outDir, 'fs'));
  mkdirSync(join(outDir, 'fs/external/mods'), { recursive: true });
  mkdirSync(join(outDir, 'fs/save'), { recursive: true });

  const stamp = {
    version: `${ikemenCommit.slice(0, 10)}-${screenpackCommit.slice(0, 10)}-${goVersion}-r${pins.revision}`,
    replayProtocol: 1,
    audioProtocol: 1,
    startupProtocol: 1,
    sessionProtocol: 2,
    ikemen: { repository: pins.ikemen.repository, commit: ikemenCommit },
    screenpack: {
      repository: pins.screenpack.repository,
      commit: screenpackCommit,
    },
    go: goVersion,
    wasm,
    loader,
    files: walk(join(outDir, 'fs')),
  };
  writeFileSync(join(outDir, 'engine.json'), JSON.stringify(stamp, null, 2) + '\n');
  return stamp;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const stamp = buildEngine(parse(process.argv.slice(2)));
    console.info(`mugen engine ${stamp.version}: ${stamp.wasm}, ${stamp.files.length} files`);
  } catch (error) {
    console.error(`mugen engine build: ${error.message}`);
    process.exitCode = 1;
  }
}
