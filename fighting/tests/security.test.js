import test from 'node:test';
import assert from 'node:assert/strict';

import { safeMugenFileUrl, safeMugenUrl } from '../client/mugen/safe-url.js';

test('MUGEN URL helpers enforce same-origin asset roots and safe segments', () => {
  const previousWindow = globalThis.window;
  globalThis.window = { location: { origin: 'https://example.test' } };
  try {
    assert.equal(
      safeMugenFileUrl('/mugen/Ryu', 'sprites/ryu.sff').href,
      'https://example.test/mugen/Ryu/sprites/ryu.sff',
    );
    assert.equal(
      safeMugenUrl('/mugen-stages/dojo/stage.def').href,
      'https://example.test/mugen-stages/dojo/stage.def',
    );
    assert.throws(() => safeMugenUrl('https://evil.test/mugen/Ryu/ryu.sff'));
    assert.throws(() => safeMugenFileUrl('/mugen/Ryu', '../secret.def'));
  } finally {
    globalThis.window = previousWindow;
  }
});
