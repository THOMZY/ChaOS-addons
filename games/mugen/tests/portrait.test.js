import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { inflateSync } from 'node:zlib';
import {
  PORTRAIT_SPRITES,
  characterFiles,
  decodeRle8,
  findPackFile,
  readPortrait,
} from '../server/portrait.js';
import { createCatalog } from '../server/catalog.js';
import { createPortraits } from '../server/portraits.js';
import { createStagePreviews } from '../server/stage-previews.js';
import sharp from 'sharp';

test('MUGEN stage preview composes actual background sprites and caches only listed stages', async (t) => {
  const { root, write } = packDirectory(t);
  write('Stages/dojo/dojo.sff', sffVersion1());
  const def =
    '[Info]\nname = Dojo\nlocalcoord = 320,180\n[BGdef]\nspr = dojo.sff\n[BG sky]\ntype = normal\nspriteno = 0,0\nstart = -160,0\n';
  write('Stages/dojo/dojo.def', def);
  const catalog = createCatalog({ dataRoot: root });
  const previews = createStagePreviews({ catalog });
  const first = await previews.preview('dojo/dojo.def');
  assert.ok(first?.png);
  const { data, info } = await sharp(first.png)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 320);
  assert.equal(info.height, 180);
  assert.deepEqual([...data.subarray(0, 4)], [255, 0, 0, 255]);
  assert.equal(await previews.preview('dojo/dojo.def'), first);
  assert.equal(await previews.preview('../dojo/dojo.def'), null);
  write('Stages/dojo/dojo.def', def.replace('start = -160,0', 'start = -150,0'));
  assert.notEqual((await previews.preview('dojo/dojo.def')).etag, first.etag);
});

/** Width, height, palette and pixel indices of an indexed PNG made by encodeIndexedPng. */
function decodePng(png) {
  const chunks = {};
  let idat = Buffer.alloc(0);
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at),
      type = png.toString('latin1', at + 4, at + 8),
      data = png.subarray(at + 8, at + 8 + length);
    if (type === 'IDAT') idat = Buffer.concat([idat, data]);
    else chunks[type] = data;
    at += 12 + length;
  }
  const width = chunks.IHDR.readUInt32BE(0),
    height = chunks.IHDR.readUInt32BE(4);
  const rows = inflateSync(idat);
  const pixels = [];
  for (let y = 0; y < height; y++)
    pixels.push(...rows.subarray(y * (width + 1) + 1, (y + 1) * (width + 1)));
  const color = (index) => [...chunks.PLTE.subarray(index * 3, index * 3 + 3), chunks.tRNS[index]];
  return { width, height, pixels, color };
}

function pcx(width, height, pixels, palette) {
  const header = Buffer.alloc(128);
  header[0] = 10;
  header[1] = 5;
  header[2] = 1; // RLE
  header[3] = 8;
  header.writeUInt16LE(width - 1, 8);
  header.writeUInt16LE(height - 1, 10);
  header[65] = 1;
  header.writeUInt16LE(width, 66);
  const body = [];
  for (const value of pixels) body.push(0xc1, value); // runs of one
  const tail = palette ? [0x0c, ...palette.flat()] : [];
  return Buffer.concat([header, Buffer.from(body), Buffer.from(tail)]);
}

const red = Array.from({ length: 256 }, (_, i) => (i === 1 ? [255, 0, 0] : [0, 0, i]));
const green = Array.from({ length: 256 }, (_, i) => (i === 1 ? [0, 255, 0] : [0, 0, i]));

/** SFF v1 with 0,0 (own palette), 9000,0 (shares it) and 9000,1 (own palette). */
function sffVersion1() {
  const sprites = [
    { group: 0, image: 0, data: pcx(2, 1, [1, 1], red), same: 0 },
    { group: 9000, image: 0, data: pcx(1, 2, [1, 0], null), same: 1 },
    { group: 9000, image: 1, data: pcx(2, 2, [0, 1, 1, 0], green), same: 0 },
  ];
  const header = Buffer.alloc(512);
  header.write('ElecbyteSpr\0', 0, 'latin1');
  header.set([0, 1, 0, 1], 12); // version 1.01 stored lowest byte first
  header.writeUInt32LE(sprites.length, 20);
  header.writeUInt32LE(512, 24);
  const parts = [header];
  let offset = 512;
  sprites.forEach((sprite, index) => {
    const node = Buffer.alloc(32);
    const next = offset + 32 + sprite.data.length;
    node.writeUInt32LE(index === sprites.length - 1 ? 0 : next, 0);
    node.writeUInt32LE(sprite.data.length, 4);
    node.writeUInt16LE(sprite.group, 12);
    node.writeUInt16LE(sprite.image, 14);
    node[18] = sprite.same;
    parts.push(node, sprite.data);
    offset = next;
  });
  return Buffer.concat(parts);
}

/** SFF v2 with an RLE8 9000,0 and a raw 9000,1 linked to it, one 4-color palette. */
function sffVersion2() {
  const rle = Buffer.from([0, 0, 0, 0, 0x43, 2, 3]); // size prefix, then 2,2,2,3
  const palette = Buffer.from([0, 0, 0, 0, 10, 20, 30, 0, 40, 50, 60, 0, 70, 80, 90, 0]);
  const header = Buffer.alloc(64);
  header.write('ElecbyteSpr\0', 0, 'latin1');
  header.set([0, 1, 0, 2], 12);
  const spriteList = 64,
    paletteList = spriteList + 2 * 28,
    literal = paletteList + 16;
  header.writeUInt32LE(spriteList, 36);
  header.writeUInt32LE(2, 40);
  header.writeUInt32LE(paletteList, 44);
  header.writeUInt32LE(1, 48);
  header.writeUInt32LE(literal, 52);
  const sprites = Buffer.alloc(56);
  sprites.writeUInt16LE(9000, 0);
  sprites.writeUInt16LE(0, 2);
  sprites.writeUInt16LE(2, 4);
  sprites.writeUInt16LE(2, 6);
  sprites[14] = 2; // RLE8
  sprites[15] = 8;
  sprites.writeUInt32LE(palette.length, 16);
  sprites.writeUInt32LE(rle.length, 20);
  sprites.writeUInt16LE(9000, 28);
  sprites.writeUInt16LE(1, 30);
  sprites.writeUInt16LE(0, 40); // linked to sprite 0, no data of its own
  const palettes = Buffer.alloc(16);
  palettes.writeUInt16LE(1, 0);
  palettes.writeUInt16LE(1, 2);
  palettes.writeUInt16LE(4, 4);
  palettes.writeUInt32LE(0, 8);
  palettes.writeUInt32LE(palette.length, 12);
  return Buffer.concat([header, sprites, palettes, palette, rle]);
}

function packDirectory(t) {
  const root = mkdtempSync(join(tmpdir(), 'mugen-portrait-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, content) => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  return { root, write };
}

test('MUGEN portrait reads SFF v1 PCX sprites with own and shared palettes', (t) => {
  const { root, write } = packDirectory(t);
  write('Ryu/Sprites/RYU.SFF', sffVersion1());
  write('Ryu/ryu.def', '[Files]\nsprite = sprites\\ryu.sff\n');
  const files = characterFiles(join(root, 'Ryu/ryu.def'));
  assert.equal(files.sprite, join(root, 'Ryu/Sprites/RYU.SFF'), 'found without regard to case');
  const large = decodePng(readPortrait(files.sprite, { sprites: PORTRAIT_SPRITES.large }));
  assert.deepEqual([large.width, large.height, large.pixels], [2, 2, [0, 1, 1, 0]]);
  assert.deepEqual(large.color(1), [0, 255, 0, 255]);
  assert.equal(large.color(0)[3], 0, 'colour 0 is transparent');
  const small = decodePng(readPortrait(files.sprite, { sprites: PORTRAIT_SPRITES.small }));
  assert.deepEqual([small.width, small.height, small.pixels], [1, 2, [1, 0]]);
  assert.deepEqual(small.color(1), [255, 0, 0, 255], 'shared palette of the sprite before it');
});

test('MUGEN portrait prefers pal1 for the shared character palette', (t) => {
  const { root, write } = packDirectory(t);
  write('Ryu/ryu.sff', sffVersion1());
  const act = Buffer.alloc(768);
  act.set([1, 2, 3], (255 - 1) * 3); // .act colours are stored last index first
  write('Ryu/ryu.act', act);
  write('Ryu/ryu.def', '[Files]\nsprite = ryu.sff\npal1 = ryu.act\n');
  const files = characterFiles(join(root, 'Ryu/ryu.def'));
  const small = decodePng(readPortrait(files.sprite, { palettePath: files.palette }));
  assert.deepEqual(small.color(1), [1, 2, 3, 255]);
});

test('MUGEN portrait reads SFF v2 RLE8 sprites, links and palettes', (t) => {
  const { root, write } = packDirectory(t);
  write('Ken/ken.sff', sffVersion2());
  const path = join(root, 'Ken/ken.sff');
  for (const sprites of [PORTRAIT_SPRITES.small, PORTRAIT_SPRITES.large]) {
    const image = decodePng(readPortrait(path, { sprites }));
    assert.deepEqual([image.width, image.height, image.pixels], [2, 2, [2, 2, 2, 3]]);
    assert.deepEqual(image.color(3), [70, 80, 90, 255]);
  }
  assert.equal(readPortrait(path, { sprites: [[9000, 7]] }), null);
  // Like Ikemen GO, a short stream repeats its last byte.
  assert.deepEqual([...decodeRle8(Buffer.from([0x43, 5, 7]), 5)], [5, 5, 5, 7, 7]);
  assert.equal(findPackFile(join(root, 'Ken/ken.def'), '../secret.sff'), null);
});

test('MUGEN portrait service caches by file and only serves listed characters', (t) => {
  const { root, write } = packDirectory(t);
  write('Characters/Ryu/ryu.sff', sffVersion1());
  write('Characters/Ryu/ryu.def', '[Info]\nname = Ryu\n[Files]\nsprite = ryu.sff\n');
  write('Characters/Bare/bare.def', '[Files]\nsprite = missing.sff\n');
  let reads = 0;
  const portraits = createPortraits({
    catalog: createCatalog({ dataRoot: root }),
    read: (...args) => {
      reads++;
      return readPortrait(...args);
    },
  });
  const first = portraits.portrait('Ryu/ryu.def', 'large');
  assert.ok(first.png.length > 0);
  assert.match(first.etag, /^"[\w-]{20}"$/);
  assert.strictEqual(portraits.portrait('Ryu/ryu.def', 'large'), first);
  assert.equal(reads, 1);
  assert.equal(portraits.portrait('Bare/bare.def').png, null);
  assert.equal(portraits.portrait('../Ryu/ryu.def'), null);
  assert.equal(portraits.portrait('Ryu/ryu.def', 'huge'), null);
});
