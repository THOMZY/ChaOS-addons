// Package the compiled engine for shipping with the add-on, independently of
// a GitHub release or a Go installation on the destination server.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readPins, BUNDLE_NAME } from './pins.mjs';

export const BUNDLED_ARCHIVE = fileURLToPath(new URL('./' + BUNDLE_NAME, import.meta.url));
export const BUNDLED_METADATA = fileURLToPath(
  new URL('./mugen-engine.bundle.json', import.meta.url),
);
export const hashFile = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

export function validateBundle(directory) {
  const stamp = JSON.parse(readFileSync(join(directory, 'engine.json'), 'utf8'));
  const pins = readPins();
  if (
    stamp.ikemen?.commit !== pins.ikemen.commit ||
    stamp.screenpack?.commit !== pins.screenpack.commit ||
    !stamp.go?.startsWith('go' + pins.go + '.') ||
    !stamp.version?.endsWith('-r' + pins.revision)
  )
    throw new Error('engine bundle does not match engine/engine.json; rebuild the bundled engine');
  for (const protocol of ['replayProtocol', 'audioProtocol', 'startupProtocol', 'sessionProtocol'])
    if (stamp[protocol] !== (protocol === 'sessionProtocol' ? 2 : 1))
      throw new Error('engine bundle needs a rebuild: ' + protocol);
  for (const [key, extension] of [
    ['wasm', 'wasm'],
    ['loader', 'js'],
  ]) {
    const name = stamp[key];
    const digest =
      typeof name === 'string' &&
      new RegExp(`^[\\w-]+\\.([0-9a-f]{12})\\.${extension}$`).exec(name)?.[1];
    if (!digest || !hashFile(join(directory, name)).startsWith(digest))
      throw new Error('engine bundle has invalid ' + key);
  }
  if (
    !Array.isArray(stamp.files) ||
    !stamp.files.some(([path]) => path === 'external/script/main.lua')
  )
    throw new Error('engine bundle is missing its scripts');
  for (const [path, size] of stamp.files) {
    if (
      typeof path !== 'string' ||
      path.includes('\\') ||
      path.includes(':') ||
      path.startsWith('/') ||
      path.split('/').some((part) => !part || part === '.' || part === '..')
    )
      throw new Error('invalid engine file path');
    const file = statSync(join(directory, 'fs', path));
    if (!file.isFile() || file.size !== size)
      throw new Error('engine bundle has missing or changed file: ' + path);
  }
  return stamp;
}

export function packageEngine(directory) {
  const stamp = validateBundle(directory);
  const work = mkdtempSync(join(tmpdir(), 'mugen-bundle-'));
  try {
    // Include the manifest's files only: runtime logs and installed packs never ship.
    for (const file of [
      'engine.json',
      stamp.wasm,
      stamp.loader,
      ...stamp.files.map(([path]) => 'fs/' + path),
    ]) {
      mkdirSync(dirname(join(work, file)), { recursive: true });
      copyFileSync(join(directory, file), join(work, file));
    }
    mkdirSync(join(work, 'licenses'));
    for (const name of ['ikemen-go.txt', 'screenpack.txt'])
      copyFileSync(
        fileURLToPath(new URL('./licenses/' + name, import.meta.url)),
        join(work, 'licenses', name),
      );
    execFileSync('tar', ['-czf', BUNDLED_ARCHIVE, '-C', work, '.'], { windowsHide: true });
    const metadata = {
      archive: BUNDLE_NAME,
      version: stamp.version,
      sha256: hashFile(BUNDLED_ARCHIVE),
      bytes: statSync(BUNDLED_ARCHIVE).size,
    };
    writeFileSync(BUNDLED_METADATA, JSON.stringify(metadata, null, 2) + '\n');
    return metadata;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export function unpackBundledEngine(work) {
  const metadata = JSON.parse(readFileSync(BUNDLED_METADATA, 'utf8'));
  if (metadata.archive !== BUNDLE_NAME || metadata.sha256 !== hashFile(BUNDLED_ARCHIVE))
    throw new Error('bundled engine checksum mismatch');
  const directory = join(work, 'bundled');
  mkdirSync(directory);
  execFileSync('tar', ['-xzf', BUNDLED_ARCHIVE, '-C', directory], { windowsHide: true });
  const stamp = validateBundle(directory);
  if (stamp.version !== metadata.version) throw new Error('bundled engine version mismatch');
  return directory;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (!process.argv[2])
      throw new Error('usage: node mugen/engine/bundle.mjs <compiled-engine-directory>');
    console.info(JSON.stringify(packageEngine(resolve(process.argv[2]))));
  } catch (error) {
    console.error('[mugen] package: ' + error.message);
    process.exitCode = 1;
  }
}
