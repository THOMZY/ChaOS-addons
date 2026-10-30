import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'thomzy-game-wire-')), 'hub.db');

const mugenWire = await import('../server/index.js');

class FakeSocket {
  constructor() {
    this.handlers = new Map();
    this.events = [];
  }

  on(event, handler) {
    this.handlers.set(event, handler);
  }
  off(event, handler) {
    if (this.handlers.get(event) === handler) this.handlers.delete(event);
  }
  emit(event, payload) {
    this.events.push({ event, payload });
  }
  join() {}
  leave() {}
  to() {
    return this;
  }
}

test('MUGEN disconnect closes the player room', () => {
  const namespace = new FakeSocket();
  mugenWire.init(namespace);
  const created = mugenWire.fightMgr.createRoom(
    { accountId: 'fight-a', userId: 'fight-a-id', pseudo: 'A', color: '#112233' },
    0,
  );

  mugenWire.onUserDisconnect('fight-a');

  assert.equal(mugenWire.fightMgr.getRoom(created.roomId), null);
  assert.equal(
    namespace.events.some(
      (event) => event.event === 'mugen:closed' && event.payload.roomId === created.roomId,
    ),
    true,
  );
});

// Games moved to server/features/<id>/ (roadmap A2, A5): their runtime, and
// once their facade is gone, the feature module that exports the manager.
const FEATURE_RUNTIMES = new Set(['mugen']);
const FEATURE_MODULES = new Set(['mugen']);

test('every game wire manager member exists on its manager instance', async () => {
  const specs = [['mugen', 'fightMgr']];

  for (const [file, exportName, referenceName = exportName] of specs) {
    const moduleUrl = FEATURE_MODULES.has(file)
      ? new URL(`../../../games/${file}/server/index.js`, import.meta.url)
      : new URL(`../../../server/chat/wire/${file}.js`, import.meta.url);
    const module = await import(moduleUrl);
    // Compatibility facades must not hide manager calls from this contract.
    const runtimeUrl = FEATURE_RUNTIMES.has(file)
      ? new URL(`../../../games/${file}/server/runtime.js`, import.meta.url)
      : new URL(`./${file}-runtime.js`, moduleUrl);
    const sourceUrls = ['roulette', 'blackjack', 'mugen', 'sf2'].includes(file)
      ? [moduleUrl, runtimeUrl]
      : [moduleUrl];
    const source = sourceUrls.map((url) => readFileSync(url, 'utf8')).join('\n');
    const memberPattern = new RegExp(`\\b${referenceName}\\.([A-Za-z_$][\\w$]*)`, 'g');
    const members = new Set([...source.matchAll(memberPattern)].map((match) => match[1]));
    assert.ok(members.size > 0, `${exportName} references must remain covered after extraction`);
    for (const member of members) {
      assert.equal(
        member in module[exportName],
        true,
        `${exportName}.${member} is referenced but missing`,
      );
    }
  }
});
