import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hashFile } from '../engine/bundle.mjs';

test('shipped engine installs offline without Go and preserves packs; corrupt archives cannot replace it', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mugen-offline-install-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, text) => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  write('package.json', '{"type":"module"}');
  write(
    'offline.mjs',
    'globalThis.fetch = () => { throw new Error("network disabled by test"); };',
  );
  write('server/catalog.js', readFileSync(new URL('../server/catalog.js', import.meta.url)));
  cpSync(new URL('../engine/', import.meta.url), join(root, 'engine'), { recursive: true });
  copyFileSync(new URL('../install.mjs', import.meta.url), join(root, 'install.mjs'));
  write('data/Characters/hero/hero.sff', 'keep fighter');
  write('data/Stages/dojo/dojo.sff', 'keep stage');
  const run = (...args) =>
    spawnSync(
      process.execPath,
      [
        '--import',
        pathToFileURL(join(root, 'offline.mjs')).href,
        join(root, 'install.mjs'),
        ...args,
      ],
      {
        windowsHide: true,
        encoding: 'utf8',
        timeout: 30000,
        env: {
          ...process.env,
          PATH:
            process.platform === 'win32'
              ? join(process.env.SystemRoot, 'System32')
              : '/usr/bin:/bin',
        },
      },
    );
  const result = run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const stamp = JSON.parse(readFileSync(join(root, 'data/engine/engine.json'), 'utf8'));
  assert.ok(existsSync(join(root, 'data/engine', stamp.wasm)));
  assert.ok(existsSync(join(root, 'data/engine/licenses/ikemen-go.txt')));
  assert.ok(existsSync(join(root, 'data/engine/licenses/screenpack.txt')));
  const wasmHash = hashFile(join(root, 'data/engine', stamp.wasm));
  assert.equal(readFileSync(join(root, 'data/Characters/hero/hero.sff'), 'utf8'), 'keep fighter');
  assert.equal(readFileSync(join(root, 'data/Stages/dojo/dojo.sff'), 'utf8'), 'keep stage');
  write('engine/mugen-engine.tar.gz', 'corrupt archive');
  const broken = run();
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /checksum mismatch/);
  assert.equal(
    hashFile(join(root, 'data/engine', stamp.wasm)),
    wasmHash,
    'invalid bundle leaves the installed engine intact',
  );
  assert.equal(run('--build', '--bundle', root).status, 1);
  assert.match(run('--download').stderr, /unknown option --download/);
  rmSync(join(root, 'engine/mugen-engine.tar.gz'));
  const missing = run();
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /mugen-engine\.tar\.gz is missing/);
});
