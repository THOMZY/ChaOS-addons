import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// No Minecraft startup or downloads: execute ONLY the production configuration
// script against temporary properties. Git's POSIX shell is used on Windows.
const shell =
  process.platform === 'win32'
    ? join(process.env.ProgramFiles || 'C:/Program Files', 'Git', 'bin', 'bash.exe')
    : '/bin/sh';
const source = readFileSync(
  new URL('../../docker/configure-rcon.sh', import.meta.url),
  'utf8',
).replace(/\r/g, '');
const password = 'isolated-minecraft-startup-secret-12345678';
function fixture(t, initial = 'motd=fixture') {
  const directory = mkdtempSync(join(tmpdir(), 'chaos-rcon-config-'));
  const path = join(directory, 'server.properties');
  writeFileSync(path, initial);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return {
    read: () => readFileSync(path, 'utf8'),
    run: (password, port = '25575') =>
      spawnSync(shell, ['-s'], {
        input: source,
        cwd: directory,
        encoding: 'utf8',
        timeout: 5000,
        env: { ...process.env, MC_RCON_PASSWORD: password, MC_RCON_PORT: port },
      }),
  };
}

test('Minecraft config enables RCON idempotently with a private credential, preserving other properties', (t) => {
  const config = fixture(t);
  const result = config.run(password);
  assert.equal(result.status, 0, result.stderr || String(result.error));
  const first = config.read();
  assert.match(first, /^motd=fixture\n/m);
  assert.match(first, /^enable-rcon=true$/m);
  assert.match(first, /^rcon.port=25575$/m);
  assert.ok(first.includes(`rcon.password=${password}`));
  assert.ok(!result.stdout.includes(password));
  assert.equal(config.run(password).status, 0);
  assert.equal(config.read(), first);
});

test('empty Minecraft configuration disables a previously enabled persistent console and removes its old password', (t) => {
  const config = fixture(t, `enable-rcon=true\nrcon.password=${password}\nmotd=fixture\n`);
  assert.equal(config.run('').status, 0);
  assert.match(config.read(), /^enable-rcon=false$/m);
  assert.match(config.read(), /^rcon.password=$/m);
  assert.ok(!config.read().includes(password));
});

test('unsafe/placeholder Minecraft credentials and invalid ports fail before touching properties', (t) => {
  const config = fixture(t),
    initial = config.read();
  for (const value of [
    'chaos-mc-rcon',
    'short',
    'a'.repeat(129),
    `${password}\nmalicious=true`,
    password + '&',
  ]) {
    const result = config.run(value);
    assert.equal(result.status, 1, String(result.error));
    assert.equal(config.read(), initial);
    assert.ok(!(result.stdout + result.stderr).includes(value));
  }
  for (const port of ['0', '65536', '99999999999999999999999', '25575\nmalicious=true']) {
    assert.equal(config.run(password, port).status, 1);
    assert.equal(config.read(), initial);
  }
});
