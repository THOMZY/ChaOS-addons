import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCatalog } from '../server/catalog.js';
import { parseMoveList, readMoveList } from '../server/move-list.js';
import { formatMoveInput } from '../client/move-input.js';

test('move notation accepts localized keyboard and controller button labels', () => {
  assert.equal(formatMoveInput('x+a', { x: 'Q', a: 'W' }), 'Q + W');
  assert.equal(formatMoveInput('D,DF,F,x', { x: 'X / □' }), '↓  ›  ↘  ›  →  ›  X / □');
});

test('move list preserves alternatives, charge inputs and combinations while excluding AI and held directions', () => {
  const command = (name, input) => `[Command]\nname = "${name}"\ncommand = ${input}\n`;
  const moves = parseMoveList(
    [
      command('Fireball', '~D, DF, F, x'),
      command('Fireball', '~D, DF, F, y'),
      command('Fireball', '~D, DF, F, x'),
      command('Charge', '~30$B, F, a+b'),
      command('AI1', 'U,D,U,D'),
      command('AI_2', 'a,b'),
      command('holdfwd', '/$F'),
      command('Invalid', 'not a command'),
      '[Statedef -1]\ntype=S',
    ].join('\n'),
  );
  assert.deepEqual(moves, [
    { name: 'Fireball', input: '~D, DF, F, x' },
    { name: 'Fireball', input: '~D, DF, F, y' },
    { name: 'Charge', input: '~30$B, F, a+b' },
  ]);
  assert.equal(formatMoveInput('~D, DF, F, x+y'), '↥↓  ›  ↘  ›  →  ›  A + S');
  assert.equal(formatMoveInput('/$B, b'), '[←]  ›  X');
  assert.equal(formatMoveInput('~30$B, F, a+b'), '↥← (30f)  ›  →  ›  Z + X');
});

test('move list reads only catalogued command files with case-insensitive pack references', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mugen-moves-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'Characters/Ryu'), { recursive: true });
  writeFileSync(
    join(root, 'Characters/Ryu/ryu.def'),
    '[Info]\nname=Ryu\n[Files]\nsprite=ryu.sff\ncmd=RYU.CMD',
  );
  writeFileSync(
    join(root, 'Characters/Ryu/ryu.cmd'),
    '[Command]\nname="Hadouken"\ncommand=~D,DF,F,x ; attack\n',
  );
  const catalog = createCatalog({ dataRoot: root });
  assert.deepEqual(readMoveList(catalog, 'Ryu/ryu.def').moves, [
    { name: 'Hadouken', input: '~D,DF,F,x' },
  ]);
  assert.equal(readMoveList(catalog, '../../private.def'), null);
  writeFileSync(
    join(root, 'Characters/Ryu/ryu.def'),
    '[Files]\nsprite=ryu.sff\ncmd=../../private.cmd',
  );
  writeFileSync(join(root, 'private.cmd'), '[Command]\nname=Secret\ncommand=x');
  assert.deepEqual(readMoveList(catalog, 'Ryu/ryu.def').moves, []);
});
