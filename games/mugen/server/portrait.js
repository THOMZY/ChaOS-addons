// Character portraits for the lobby, cut from the character's SFF on the
// server: the browser gets one small PNG instead of a sprite file that can
// weigh tens of megabytes. Formats follow Ikemen GO's reader (src/image.go):
// SFF v1 (PCX, shared or own palettes, .act) and SFF v2 (raw, RLE8, RLE5,
// LZ5 and PNG 8/24/32 bits).
import { closeSync, openSync, readSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { parseSections } from './catalog.js';
import { isUtf8 } from 'node:buffer';

const SIGNATURE = 'ElecbyteSpr\0';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_PIXELS = 2048 * 2048;
// MUGEN's select screen shows 9000,0 (small) and the VS screen 9000,1 (large).
export const PORTRAIT_SPRITES = {
  small: [
    [9000, 0],
    [9000, 1],
  ],
  large: [
    [9000, 1],
    [9000, 0],
  ],
};

class SpriteFile {
  constructor(path) {
    this.fd = openSync(path, 'r');
    this.size = statSync(path).size;
  }
  read(position, length) {
    if (position < 0 || length < 0 || position + length > this.size)
      throw new Error('sff_truncated');
    const buffer = Buffer.alloc(length);
    readSync(this.fd, buffer, 0, length, position);
    return buffer;
  }
  close() {
    closeSync(this.fd);
  }
}

/** A file next to the .def, found without regard to case like MUGEN on Windows. */
export function findPackFile(definitionPath, reference) {
  if (!reference) return null;
  const cleaned = reference.replace(/\\/g, '/').replace(/^\.\//, '').trim();
  if (!cleaned || cleaned.includes('\0')) return null;
  const directory = dirname(definitionPath);
  const candidates = [cleaned, basename(cleaned)];
  for (const candidate of candidates) {
    const parts = candidate.split('/').filter((part) => part && part !== '.');
    if (parts.includes('..')) continue;
    let current = directory;
    for (const part of parts) {
      let entries;
      try {
        entries = readdirSync(current);
      } catch {
        current = null;
        break;
      }
      const match = entries.find((entry) => entry.toLowerCase() === part.toLowerCase());
      if (!match) {
        current = null;
        break;
      }
      current = join(current, match);
    }
    if (current && statSync(current, { throwIfNoEntry: false })?.isFile()) return current;
  }
  return null;
}

/** Sprite and first palette files named by a character .def. */
export function characterFiles(definitionPath) {
  const bytes = readFileSync(definitionPath);
  const files =
    parseSections(bytes.toString(isUtf8(bytes) ? 'utf8' : 'latin1')).get('files') ?? new Map();
  return {
    sprite: findPackFile(definitionPath, files.get('sprite')),
    palette: findPackFile(definitionPath, files.get('pal1')),
  };
}

/** PNG of the first sprite found among `sprites`, or null. */
export function readPortrait(
  spritePath,
  { palettePath = null, sprites = PORTRAIT_SPRITES.small, metadata = false } = {},
) {
  const file = new SpriteFile(spritePath);
  try {
    const header = file.read(0, 64);
    if (header.toString('latin1', 0, 12) !== SIGNATURE) return null;
    const version = header[15];
    if (version === 1) return readVersion1(file, header, sprites, palettePath, metadata);
    if (version === 2) return readVersion2(file, header, sprites, metadata);
    return null;
  } finally {
    file.close();
  }
}

// ── SFF v1 ──────────────────────────────────────────────────────────────────

function readVersion1(file, header, wanted, palettePath, metadata) {
  const count = header.readUInt32LE(20);
  if (count > 100_000) return null;
  let offset = header.readUInt32LE(24);
  const entries = [];
  for (let index = 0; index < count && offset > 0 && offset + 32 <= file.size; index++) {
    const node = file.read(offset, 32);
    entries.push({
      offset,
      x: node.readInt16LE(8),
      y: node.readInt16LE(10),
      next: node.readUInt32LE(0),
      size: node.readUInt32LE(4),
      group: node.readUInt16LE(12),
      image: node.readUInt16LE(14),
      link: node.readUInt16LE(16),
      samePalette: node[18] !== 0,
    });
    if (node.readUInt32LE(0) <= offset) break;
    offset = node.readUInt32LE(0);
  }
  const target = findWanted(entries, wanted);
  if (target < 0) return null;
  let index = target;
  if (entries[index].size === 0 && entries[index].link < index) index = entries[index].link;
  const entry = entries[index];
  if (!entry.size) return null;
  const pcx = readPcx(file, entry, isCharacterFirst(entries, index));
  if (!pcx) return null;
  const palette = version1Palette(file, entries, index, palettePath);
  if (!palette) return null;
  const png = encodeIndexedPng(pcx.width, pcx.height, pcx.pixels, palette);
  return metadata
    ? { png, width: pcx.width, height: pcx.height, x: entries[target].x, y: entries[target].y }
    : png;
}

function isCharacterFirst(entries, index) {
  return index === 0 || (entries[index].group === 0 && entries[index].image === 0);
}

function version1Palette(file, entries, index, palettePath) {
  // A sprite that shares its palette uses the one of the last sprite with data
  // before it; the chain ends at a sprite carrying its own.
  let owner = index;
  while (owner > 0 && entries[owner].samePalette) {
    owner--;
    while (owner > 0 && !entries[owner].size) owner--;
  }
  // The character's shared palette is the one of sprite 0,0, replaced in game by pal1.
  if (isCharacterFirst(entries, owner) && palettePath) {
    const external = readExternalPalette(palettePath);
    if (external) return external;
  }
  return readPcxPalette(file, entries[owner], isCharacterFirst(entries, owner));
}

function blockEnd(entry) {
  const start = entry.offset + 32;
  return entry.next > start ? entry.next : start + entry.size;
}

function readPcxPalette(file, entry, characterFirst) {
  const start = entry.offset + 32;
  let position;
  if (characterFirst) position = start + entry.size - 768;
  else {
    const end = Math.min(blockEnd(entry), file.size);
    const tail = file.read(Math.max(start, end - 1024), Math.min(1024, end - start));
    const marker = tail.lastIndexOf(0x0c, tail.length - 769);
    position = marker >= 0 ? end - tail.length + marker + 1 : end - 768;
  }
  if (position < start) return null;
  const bytes = file.read(position, 768);
  return Array.from({ length: 256 }, (_, i) => [
    bytes[i * 3],
    bytes[i * 3 + 1],
    bytes[i * 3 + 2],
    i ? 255 : 0,
  ]);
}

function readPcx(file, entry, characterFirst) {
  const start = entry.offset + 32;
  const length = Math.min(characterFirst ? entry.size : blockEnd(entry) - start, file.size - start);
  if (length < 128) return null;
  const data = file.read(start, length);
  if (data[3] !== 8) return null;
  const width = data.readUInt16LE(8) - data.readUInt16LE(4) + 1;
  const height = data.readUInt16LE(10) - data.readUInt16LE(6) + 1;
  const bytesPerLine = data.readUInt16LE(66);
  if (width <= 0 || height <= 0 || width * height > MAX_PIXELS) return null;
  const pixels = Buffer.alloc(width * height);
  if (data[2] !== 1) {
    data.copy(pixels, 0, 128, 128 + pixels.length);
    return { width, height, pixels };
  }
  // RLE scanlines are bytesPerLine wide; the padding past `width` is dropped.
  let read = 128,
    written = 0,
    column = 0;
  while (written < pixels.length && read < data.length) {
    let run = 1,
      value = data[read++];
    if (value >= 0xc0) {
      run = value & 0x3f;
      value = data[read++] ?? 0;
    }
    for (; run > 0; run--) {
      if (column < width && written < pixels.length) pixels[written++] = value;
      if (++column === bytesPerLine) {
        column = 0;
        run = 1;
      }
    }
  }
  return { width, height, pixels };
}

function readExternalPalette(path) {
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch {
    return null;
  }
  if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    const plte = pngChunks(bytes).find((chunk) => chunk.type === 'PLTE');
    if (!plte) return null;
    return Array.from({ length: 256 }, (_, i) =>
      i * 3 + 2 < plte.data.length
        ? [plte.data[i * 3], plte.data[i * 3 + 1], plte.data[i * 3 + 2], i ? 255 : 0]
        : [0, 0, 0, 255],
    );
  }
  if (bytes.length < 768) return null;
  // .act colours are stored last index first.
  return Array.from({ length: 256 }, (_, i) => {
    const at = (255 - i) * 3;
    return [bytes[at], bytes[at + 1], bytes[at + 2], i ? 255 : 0];
  });
}

// ── SFF v2 ──────────────────────────────────────────────────────────────────

function readVersion2(file, header, wanted, metadata) {
  const spriteList = header.readUInt32LE(36);
  const count = header.readUInt32LE(40);
  const paletteList = header.readUInt32LE(44);
  const paletteCount = header.readUInt32LE(48);
  const literal = header.readUInt32LE(52);
  const translated = header.readUInt32LE(60);
  if (count > 100_000 || spriteList + count * 28 > file.size) return null;
  const list = file.read(spriteList, count * 28);
  const entries = Array.from({ length: count }, (_, i) => {
    const at = i * 28;
    return {
      group: list.readUInt16LE(at),
      image: list.readUInt16LE(at + 2),
      width: list.readUInt16LE(at + 4),
      height: list.readUInt16LE(at + 6),
      x: list.readInt16LE(at + 8),
      y: list.readInt16LE(at + 10),
      link: list.readUInt16LE(at + 12),
      format: list[at + 14],
      depth: list[at + 15],
      offset: list.readUInt32LE(at + 16) + (list.readUInt16LE(at + 26) & 1 ? translated : literal),
      size: list.readUInt32LE(at + 20),
      palette: list.readUInt16LE(at + 24),
    };
  });
  let index = findWanted(entries, wanted);
  if (index < 0) return null;
  const target = entries[index];
  if (entries[index].size === 0 && entries[index].link < index) index = entries[index].link;
  const entry = entries[index];
  const { width, height } = entries[index];
  if (!entry.size || !width || !height || width * height > MAX_PIXELS) return null;
  const result = (png) =>
    png && (metadata ? { png, width, height, x: target.x, y: target.y } : png);
  if (entry.format === 11 || entry.format === 12)
    return result(file.read(entry.offset + 4, entry.size - 4));
  const palette = version2Palette(file, paletteList, paletteCount, literal, entry.palette);
  if (!palette) return null;
  if (entry.format === 10)
    return result(repaletteIndexedPng(file.read(entry.offset + 4, entry.size - 4), palette));
  let pixels;
  if (entry.format === 0 && entry.depth === 8) pixels = file.read(entry.offset, entry.size);
  else if (entry.format >= 2 && entry.format <= 4) {
    const data = file.read(entry.offset + 4, Math.max(0, entry.size - 4));
    pixels = [decodeRle8, decodeRle5, decodeLz5][entry.format - 2](data, width * height);
  } else return null;
  return result(encodeIndexedPng(width, height, pixels, palette));
}

function version2Palette(file, listOffset, count, literal, index) {
  for (let hops = 0; hops < 4 && index < count; hops++) {
    const node = file.read(listOffset + index * 16, 16);
    const size = node.readUInt32LE(12);
    if (size === 0) {
      index = node.readUInt16LE(6);
      continue;
    }
    const bytes = file.read(literal + node.readUInt32LE(8), Math.min(size, 1024));
    return Array.from({ length: Math.min(256, bytes.length / 4) }, (_, i) => [
      bytes[i * 4],
      bytes[i * 4 + 1],
      bytes[i * 4 + 2],
      i ? 255 : 0,
    ]);
  }
  return null;
}

function findWanted(entries, wanted) {
  for (const [group, image] of wanted) {
    const index = entries.findIndex((entry) => entry.group === group && entry.image === image);
    if (index >= 0) return index;
  }
  return -1;
}

// Decoders transcribed from Ikemen GO (Sprite.Rle8Decode, Rle5Decode, Lz5Decode).
export function decodeRle8(rle, length) {
  const out = Buffer.alloc(length);
  let i = 0,
    j = 0;
  const next = () => {
    const value = rle[i] ?? 0;
    if (i < rle.length - 1) i++;
    return value;
  };
  while (j < length && rle.length) {
    let run = 1,
      value = next();
    if ((value & 0xc0) === 0x40) {
      run = value & 0x3f;
      value = next();
    }
    for (; run > 0 && j < length; run--) out[j++] = value;
  }
  return out;
}

export function decodeRle5(rle, length) {
  const out = Buffer.alloc(length);
  let i = 0,
    j = 0;
  const step = () => {
    if (i < rle.length - 1) i++;
  };
  while (j < length && rle.length) {
    let run = rle[i];
    step();
    let count = rle[i] & 0x7f;
    let color = 0;
    if (rle[i] >> 7) {
      step();
      color = rle[i];
    }
    step();
    for (;;) {
      if (j < length) out[j++] = color;
      run--;
      if (run < 0) {
        count--;
        if (count < 0) break;
        color = rle[i] & 0x1f;
        run = rle[i] >> 5;
        step();
      }
    }
  }
  return out;
}

export function decodeLz5(rle, length) {
  const out = Buffer.alloc(length);
  if (!rle.length) return out;
  let i = 0,
    j = 0,
    n;
  const step = () => {
    if (i < rle.length - 1) i++;
  };
  let control = rle[i],
    bit = 0,
    recycled = 0,
    recycledBits = 0;
  step();
  while (j < length) {
    let d = rle[i];
    step();
    if (control & (1 << bit)) {
      if ((d & 0x3f) === 0) {
        d = ((d << 2) | rle[i]) + 1;
        step();
        n = rle[i] + 2;
        step();
      } else {
        recycled |= (d & 0xc0) >> recycledBits;
        recycledBits += 2;
        n = d & 0x3f;
        if (recycledBits < 8) {
          d = rle[i] + 1;
          step();
        } else {
          d = recycled + 1;
          recycled = 0;
          recycledBits = 0;
        }
      }
      for (;;) {
        if (j < length) {
          out[j] = j - d >= 0 ? out[j - d] : 0;
          j++;
        }
        n--;
        if (n < 0) break;
      }
    } else {
      if ((d & 0xe0) === 0) {
        n = rle[i] + 8;
        step();
      } else {
        n = d >> 5;
        d &= 0x1f;
      }
      for (; n > 0 && j < length; n--) out[j++] = d;
    }
    bit++;
    if (bit >= 8) {
      control = rle[i];
      bit = 0;
      step();
    }
  }
  return out;
}

// ── PNG ─────────────────────────────────────────────────────────────────────

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

function paletteChunks(palette) {
  const plte = Buffer.alloc(palette.length * 3);
  palette.forEach(([r, g, b], i) => plte.set([r, g, b], i * 3));
  return [chunk('PLTE', plte), chunk('tRNS', Buffer.from(palette.map((color) => color[3])))];
}

export function encodeIndexedPng(width, height, pixels, palette) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 3; // indexed colour
  const rows = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++)
    pixels.copy(rows, y * (width + 1) + 1, y * width, (y + 1) * width);
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    ...paletteChunks(palette),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function pngChunks(bytes) {
  const chunks = [];
  for (let at = 8; at + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.toString('latin1', at + 4, at + 8);
    if (at + 12 + length > bytes.length) break;
    chunks.push({
      type,
      data: bytes.subarray(at + 8, at + 8 + length),
      raw: bytes.subarray(at, at + 12 + length),
    });
    if (type === 'IEND') break;
    at += 12 + length;
  }
  return chunks;
}

/** An SFF v2 indexed PNG carries a placeholder palette: put the sprite's own in it. */
function repaletteIndexedPng(bytes, palette) {
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  const chunks = pngChunks(bytes);
  const ihdr = chunks.find((entry) => entry.type === 'IHDR');
  if (!ihdr || ihdr.data[9] !== 3) return bytes;
  const out = [PNG_SIGNATURE];
  for (const entry of chunks) {
    if (entry.type === 'tRNS') continue;
    if (entry.type === 'PLTE') out.push(...paletteChunks(palette));
    else out.push(entry.raw);
  }
  return Buffer.concat(out);
}
