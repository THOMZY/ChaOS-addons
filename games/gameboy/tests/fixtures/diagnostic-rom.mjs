// Authored diagnostic loops; no game, firmware or third-party ROM is embedded.
export function buildDiagnosticRom(model = 'DMG') {
  const buffer = Buffer.alloc(32768);
  if (model === 'AGB') {
    buffer.writeUInt32LE(0xea00002e, 0);
    buffer.writeUInt32LE(0xeafffffe, 0xc0);
    buffer[0xb2] = 0x96;
    buffer.write('AUDIT GBA', 0xa0);
    let checksum = 0;
    for (let index = 0xa0; index <= 0xbc; index++) checksum -= buffer[index];
    buffer[0xbd] = (checksum - 0x19) & 255;
  } else {
    buffer.set([0xc3, 0x50, 0x01], 0x100);
    const program = [0xf3, 0x3e, 0, 0xe0, 0x40, 0x21, 0, 0x80];
    for (let row = 0; row < 8; row++) program.push(0x3e, 0xaa, 0x22, 0x3e, 0x55, 0x22);
    for (const [address, value] of [
      [0x47, 0xe4],
      [0x40, 0x91],
      [0x26, 0x80],
      [0x24, 0x77],
      [0x25, 0x11],
      [0x11, 0x80],
      [0x12, 0xf3],
      [0x13, 0xd6],
      [0x14, 0x86],
    ])
      program.push(0x3e, value, 0xe0, address);
    program.push(0x18, 0xfe);
    buffer.set(program, 0x150);
    // The hardware-identification header is required by the cartridge loader.
    buffer.set(
      Buffer.from(
        'ceed6666cc0d000b03730083000c000d0008111f8889000edccc6e6ddddd999bbbb67636e0eecccdddc999fbbb9333e',
        'hex',
      ),
      0x104,
    );
    buffer[0x143] = model === 'CGB' ? 0x80 : 0;
    buffer.write('AUDIT', 0x134);
    let checksum = 0;
    for (let index = 0x134; index <= 0x14c; index++) checksum = checksum - buffer[index] - 1;
    buffer[0x14d] = checksum & 255;
  }
  return buffer;
}
