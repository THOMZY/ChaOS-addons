// The Quake 3 tunnel adapter (moved from the site's game-servers tunnel tests,
// roadmap J7b): the generic tunnel is tested by the site, this adapter here.
import test from 'node:test';
import assert from 'node:assert/strict';

test('l\'adaptateur Quake 3 déclare son paquet de déconnexion', async () => {
  const { quake3Game } = await import('../server/game.js');
  assert.equal(typeof quake3Game.onClose, 'function',
    'sans lui, chaque F5 laisse un joueur fantôme ~20 s dans la partie');
  // Replay the hook with a dry run to lock down the protocol bytes:
  // 0xFF 0xFF 0xFF 0xFF followed by "disconnect\n".
  const envois = [];
  quake3Game.onClose({ send: (chunk) => envois.push(Buffer.from(chunk)), done: () => {} });
  assert.equal(envois.length, 1, 'un seul paquet');
  assert.deepEqual([...envois[0]], [...Buffer.from('\xff\xff\xff\xffdisconnect\n', 'latin1')]);
});
