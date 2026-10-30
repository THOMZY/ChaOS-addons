import { crc32, deflateRawSync } from 'node:zlib';

export function zipFixture(files) {
  const local = [],
    central = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name);
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data ?? '');
    const compressed = deflateRawSync(data);
    const checksum = file.crc ?? crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6); // file names are UTF-8
    header.writeUInt16LE(8, 8);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(file.size ?? data.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, compressed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(0x0314, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(checksum, 16);
    entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(file.size ?? data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(((file.mode ?? 0x81a4) << 16) >>> 0, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += header.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

export const spriteFixture = Buffer.concat([Buffer.from('ElecbyteSpr\0'), Buffer.alloc(20)]);
// A real single-sprite SFF v1 for thumbnail HTTP/browser checks.
export function stageSpriteFixture() {
  const header = Buffer.alloc(512),
    node = Buffer.alloc(32),
    pcx = Buffer.alloc(128);
  header.write('ElecbyteSpr\0');
  header[15] = 1;
  header.writeUInt32LE(1, 20);
  header.writeUInt32LE(512, 24);
  pcx[0] = 10;
  pcx[3] = 8;
  pcx[65] = 1;
  pcx.writeUInt16LE(1, 8);
  pcx.writeUInt16LE(1, 10);
  pcx.writeUInt16LE(2, 66);
  const palette = Buffer.alloc(768);
  palette[3] = 255;
  const data = Buffer.concat([pcx, Buffer.from([1, 1, 1, 1, 12]), palette]);
  node.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, node, data]);
}
export const characterPack = () =>
  zipFixture([
    {
      name: 'archive/chars/hero/hero.def',
      data: '[Info]\nname = Hero\n[Files]\nsprite = HERO.SFF\nanim = hero.air\n',
    },
    { name: 'archive/chars/hero/hero.sff', data: spriteFixture },
    { name: 'archive/chars/hero/hero.air', data: '[Begin Action 0]\n0,0,0,0,-1\n' },
  ]);
