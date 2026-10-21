// ChaOS — MUGEN SFF sprite file parser
//
// Supports SFF v1 (PCX sprites with palette) and SFF v2 (PNG sprites).
//
// Input:
//   sffBuffer  — ArrayBuffer of the .sff file
//   actBuffer  — ArrayBuffer of the .act palette file (for v1 only, optional)
//
// Output: Map<'group_image', SpriteEntry>
// SpriteEntry: {
//   canvas: OffscreenCanvas,   RGBA pixel data
//   width:  number,
//   height: number,
//   axisX:  number,    sprite axis / registration point
//   axisY:  number,
// }

// ── Cross-browser bitmap decode ─────────────────────────────────────────────
import { fetchMugenResource } from './safe-url.js';

const CRC32_INITIAL = Number.parseInt('FFFFFFFF', 16);
const CRC32_POLY = Number.parseInt('EDB88320', 16);

// Brave (and some strict-mode browsers) can block createImageBitmap() on Blobs
// due to fingerprinting protection. Also, blob: URLs may be blocked by CSP.
// Fallback: FileReader → data: URL (always allowed; no blob: needed in img-src).
async function _safeCreateImageBitmap(blob) {
  try {
    const bmp = await createImageBitmap(blob);
    // Some browsers silently return a 0×0 bitmap instead of throwing
    if (bmp.width > 0 && bmp.height > 0) return bmp;
    if (bmp.close) bmp.close();
  } catch { /* fall through to FileReader path */ }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload  = () => resolve(img);
      img.onerror = () => reject(new Error('SFF img load failed'));
      img.src = reader.result; // data: URL — always CSP-safe
    };
    reader.onerror = () => reject(new Error('SFF FileReader failed'));
    reader.readAsDataURL(blob);
  });
}

// ── Minimal SFF preview loader (HTTP Range requests) ─────────────────────────
// Downloads only the bytes needed to decode one sprite — no full-file load.
// For SFF v2 (large files): ~5 range requests, ~100-300 KB total.
// For SFF v1: walks the linked list with per-entry range requests.
// Returns a SpriteEntry ({canvas, width, height, axisX, axisY}) or null.

// ── Range-fetch helper (extracted from parseSffPreview closure) ─────────────
function _createRangeFetcher(sffUrl) {
  let _fullBuf = null;
  return async (start, end) => {
    if (_fullBuf) {
      const s = _fullBuf.slice(start, end + 1);
      return { b: new Uint8Array(s), v: new DataView(s) };
    }
    const r = await fetchMugenResource(sffUrl, {
      headers: { Range: `bytes=${start}-${end}` },
      cache: 'no-store',
    });
    if (r.ok || r.status === 206) {
      const buf = await r.arrayBuffer();
      return { b: new Uint8Array(buf), v: new DataView(buf) };
    }
    if (r.status === 416) {
      const full = await fetchMugenResource(sffUrl, { cache: 'reload' });
      if (!full.ok) throw new Error(`HTTP ${full.status}`);
      _fullBuf = await full.arrayBuffer();
      const s = _fullBuf.slice(start, end + 1);
      return { b: new Uint8Array(s), v: new DataView(s) };
    }
    throw new Error(`HTTP ${r.status}`);
  };
}

// Find a sprite entry in an SFF v2 sprite list by group+image.
// Returns byte offset of the entry in `sl`, or -1 if not found.
function _findSpriteInList(slv, sl, group, image, sprCount) {
  for (let i = 0; i < sprCount; i++) {
    const base = i * 28;
    if (base + 28 > sl.length) break;
    if (slv.getUint16(base, true) !== group || slv.getUint16(base + 2, true) !== image) continue;
    const dlen = slv.getUint32(base + 20, true);
    // Follow one level of linking if dataLen is zero
    return dlen === 0 ? slv.getUint16(base + 12, true) * 28 : base;
  }
  return -1;
}

// Build 256-entry RGBA palette from raw palette data (768=RGB or 1024=RGBA).
function _buildPalette(palData, stride) {
  const pal = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const s = i * stride;
    pal[i * 4]     = palData[s];
    pal[i * 4 + 1] = palData[s + 1];
    pal[i * 4 + 2] = palData[s + 2];
    pal[i * 4 + 3] = stride === 4 ? palData[s + 3] : 255;
  }
  pal[3] = 0; // index 0 transparent
  return pal;
}

export async function parseSffPreview(sffUrl, group, image) {
  const getRange = _createRangeFetcher(sffUrl);

  try {
    const { b: hdr, v: hv } = await getRange(0, 511);
    if (hdr.length < 68) return null;

    if (hdr[15] === 2) {
      return await _parseSffPreviewV2({ hv }, group, image, getRange);
    } else {
      return await _parseSffPreviewV1({ hdr, hv }, group, image, getRange);
    }
  } catch (e) {
    console.warn('[parseSffPreview]', e.message);
  }
  return null;
}

// ── SFF v2 preview (extracted from parseSffPreview) ──────────────────────────
async function _parseSffPreviewV2({ hv }, group, image, getRange) {
  const sprListOff = hv.getUint32(36, true);
  const sprCount   = hv.getUint32(40, true);
  const palListOff = hv.getUint32(44, true);
  const ldataOff   = hv.getUint32(52, true);
  const tdataOff   = hv.getUint32(60, true);

  const { b: sl, v: slv } = await getRange(sprListOff, sprListOff + sprCount * 28 - 1);

  const o = _findSpriteInList(slv, sl, group, image, sprCount);
  if (o < 0 || o + 28 > sl.length) return null;

  const axisX   = slv.getInt16 (o + 8,  true);
  const axisY   = slv.getInt16 (o + 10, true);
  const fmt     = sl[o + 14];
  const dataOff = slv.getUint32(o + 16, true);
  const dataLen = slv.getUint32(o + 20, true);
  const palIdx  = slv.getUint16(o + 24, true);
  const flags   = slv.getUint16(o + 26, true);

  // Fetch palette entry (16 bytes) then palette data
  const peOff = palListOff + palIdx * 16;
  const { v: pev } = await getRange(peOff, peOff + 15);
  const palRelOff = pev.getUint32(8,  true);
  const palLdLen  = pev.getUint32(12, true);
  const { b: palData } = await getRange(ldataOff + palRelOff, ldataOff + palRelOff + palLdLen - 1);

  const stride = palLdLen === 768 ? 3 : 4;
  const pal = _buildPalette(palData, stride);

  // Fetch sprite data
  const sprBase = (flags & 1) ? tdataOff : (ldataOff + 4);
  const { b: sprData } = await getRange(sprBase + dataOff, sprBase + dataOff + dataLen - 1);

  if (fmt === 10 || fmt === 1) {
    // PNG (fmt 10 = standard PNG, fmt 1 = undocumented PNG alias used by some MUGEN chars)
    const patched = _patchPngPalette(sprData, pal);
    const blob    = new Blob([patched], { type: 'image/png' });
    const bitmap  = await _safeCreateImageBitmap(blob);
    const bw = bitmap.width || bitmap.naturalWidth;
    const bh = bitmap.height || bitmap.naturalHeight;
    const canvas  = new OffscreenCanvas(bw, bh);
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    if (bitmap.close) bitmap.close();
    return { canvas, width: bw, height: bh, axisX, axisY };
  }
  if (fmt === 2) {
    // RLE8
    const w = slv.getUint16(o + 4, true), h = slv.getUint16(o + 6, true);
    if (w && h) {
      const canvas = _decodeRle8(sprData, 0, dataLen, w, h, pal);
      if (canvas) return { canvas, width: w, height: h, axisX, axisY };
    }
  }
  return null;
}

// ── SFF v1 preview (extracted from parseSffPreview) ──────────────────────────
async function _parseSffPreviewV1({ hdr, hv }, group, image, getRange) {
  const numImages = hv.getUint32(20, true);
  let offset      = hv.getUint32(24, true);
  const palState  = { shared: null, locked: false, lockAfterFirst: Boolean(hdr[32]) };
  const MAX_WALK  = 60;

  for (let idx = 0; idx < Math.min(numImages, MAX_WALK) && offset !== 0; idx++) {
    const { b: eh, v: ehv } = await getRange(offset, offset + 31);
    const nextOff    = ehv.getUint32(0,  true);
    const dataLen    = ehv.getUint32(4,  true);
    const ax         = ehv.getInt16 (8,  true);
    const ay         = ehv.getInt16 (10, true);
    const g          = ehv.getUint16(12, true);
    const img        = ehv.getUint16(14, true);
    const usePrevPal = eh[18];
    const isTarget   = g === group && img === image;

    const needPalette = dataLen > 0 && !usePrevPal;
    if ((needPalette || isTarget) && dataLen > 0) {
      const { b: pcx } = await getRange(offset + 32, offset + 32 + dataLen - 1);
      if (needPalette) _updateSffV1Palette(palState, pcx);
      if (isTarget) return _decodeSffV1Target(pcx, usePrevPal, palState.shared, ax, ay);
    } else if (isTarget) {
      break;
    }

    offset = nextOff;
  }
  return null;
}

function _updateSffV1Palette(palState, pcx) {
  const p = _extractPcxPalette(pcx);
  if (!p) return;
  // sharedPal=1 locks after first palette; sharedPal=0 keeps updating.
  if (!palState.locked || !palState.lockAfterFirst) palState.shared = p;
  if (palState.lockAfterFirst) palState.locked = true;
}

function _decodeSffV1Target(pcx, usePrevPal, sharedPal, ax, ay) {
  const pal = usePrevPal ? sharedPal : _extractPcxPalette(pcx);
  if (!pal) return null;
  const canvas = _decodePcx(pcx, pal);
  return canvas ? { canvas, width: canvas.width, height: canvas.height, axisX: ax, axisY: ay } : null;
}

// Finds the MUGEN lifebar portrait for a character: tries group 9000 image 1
// (large portrait) then image 0 (small portrait). Returns a SpriteEntry or null.
//
// SFF v2: efficient — fetches sprite list in one request then renders target.
// SFF v1: loads the full SFF file once (avoids O(N) sequential range requests).
export async function parseSffPortrait(sffUrl) {
  try {
    const hdrRes = await fetchMugenResource(sffUrl, { headers: { Range: 'bytes=0-511' }, cache: 'no-store' });
    const hdrBuf = await hdrRes.arrayBuffer();
    const hdr = new Uint8Array(hdrBuf);
    if (hdr.length < 68) return null;

    if (hdr[15] === 2) {
      const r = await parseSffPreview(sffUrl, 9000, 1);
      if (r) return r;
      return await parseSffPreview(sffUrl, 9000, 0);
    }

    return await _parseSffV1Portrait(sffUrl, hdr);
  } catch (e) {
    console.warn('[parseSffPortrait]', e.message);
  }
  return null;
}

async function _parseSffV1Portrait(sffUrl) {
  const fullRes = await fetchMugenResource(sffUrl, { cache: 'no-store' });
  if (!fullRes.ok) return null;
  const buf   = await fullRes.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const bv    = new DataView(buf);
  const numImages      = bv.getUint32(20, true);
  let   offset         = bv.getUint32(24, true);
  const sharedPalFlag  = bytes[32];
  const { found9001, found9000 } = _walkV1Portraits(bytes, bv, numImages, offset, sharedPalFlag);
  return found9001 || found9000 || null;
}

function _walkV1Portraits(bytes, bv, numImages, offset, sharedPalFlag) {
  let sharedPal   = null;
  let palLocked   = false;
  let lastPcxData = null;
  let found9001   = null;
  let found9000   = null;

  for (let idx = 0; idx < numImages && offset !== 0 && offset + 32 <= bytes.length; idx++) {
    const nextOff    = bv.getUint32(offset,      true);
    const dataLen    = bv.getUint32(offset +  4, true);
    const ax         = bv.getInt16 (offset +  8, true);
    const ay         = bv.getInt16 (offset + 10, true);
    const g          = bv.getUint16(offset + 12, true);
    const img        = bv.getUint16(offset + 14, true);
    const usePrevPal = bytes[offset + 18];

    const pcx = _readV1SpriteData(bytes, offset, dataLen, () => lastPcxData, (pcx) => { lastPcxData = pcx; });
    sharedPal = _updateV1PortraitPalette(pcx, usePrevPal, sharedPal, sharedPalFlag, palLocked, (v) => { palLocked = v; });
    const result = _decodeV1Portrait(pcx, g, img, usePrevPal, sharedPal, ax, ay, found9001, found9000);
    if (result) {
      if (result.found9001) found9001 = result.found9001;
      if (result.found9000) found9000 = result.found9000;
    }

    if (found9001) break;
    offset = nextOff;
  }

  return { found9001, found9000 };
}

function _readV1SpriteData(bytes, offset, dataLen, getLast, setLast) {
  if (dataLen > 0 && offset + 32 + dataLen <= bytes.length) {
    const pcx = new Uint8Array(bytes.buffer, offset + 32, dataLen);
    setLast(pcx);
    return pcx;
  }
  if (dataLen === 0) return getLast();
  return null;
}

function _updateV1PortraitPalette(pcx, usePrevPal, sharedPal, sharedPalFlag, palLocked, setLocked) {
  if (!pcx || usePrevPal) return sharedPal;
  const p = _extractPcxPalette(pcx);
  if (!p) return sharedPal;
  if (!palLocked || !sharedPalFlag) {
    if (sharedPalFlag) setLocked(true);
    return p;
  }
  return sharedPal;
}

function _decodeV1Portrait(pcx, g, img, usePrevPal, sharedPal, ax, ay, found9001, found9000) {
  if (!pcx || g !== 9000 || (img !== 0 && img !== 1)) return null;
  const pal = usePrevPal ? sharedPal : _extractPcxPalette(pcx);
  if (!pal) return null;
  const canvas = _decodePcx(pcx, pal);
  if (!canvas) return null;
  const spr = { canvas, width: canvas.width, height: canvas.height, axisX: ax, axisY: ay };
  return {
    found9001: img === 1 && !found9001 ? spr : null,
    found9000: img === 0 && !found9000 ? spr : null,
  };
}

export async function parseSff(sffBuffer, { isStage = false } = {}) {
  const view    = new DataView(sffBuffer);
  const bytes   = new Uint8Array(sffBuffer);
  const sprites = new Map();

  // ── Detect version ────────────────────────────────────────────────────────
  const verHi = bytes[15];   // high byte of 4-byte version field at offset 12

  if (verHi === 2) {
    await _parseSffV2(bytes, view, sprites);
  } else {
    // v1: always use the SFF-embedded palette.
    // ACT files are alternate colour schemes and do not match the sprite
    // pixel data baked into the SFF. For SharedPal=1 characters the real fix
    // is skipping the portrait sprite [9000,x] when locking the shared palette
    // (handled inside _parseSffV1).
    await _parseSffV1(bytes, view, sprites, null, isStage);
  }

  return sprites;
}

// ── SFF v1 ────────────────────────────────────────────────────────────────────
// Header: 512 bytes
//   [0-11]  signature "ElecbyteSpr\0"
//   [12-15] version
//   [16-19] numGroups
//   [20-23] numImages
//   [24-27] firstSpriteOffset
//   [28-31] subfileSize (always 32 for v1)
//   [32]    sharedPalette flag
async function _parseSffV1(bytes, view, sprites, defaultPalette, isStage = false) {
  const numImages    = view.getUint32(20, true);
  const firstOffset  = view.getUint32(24, true);
  const sffSharedPal = bytes[32];

  // ── Palette strategy ─────────────────────────────────────────────────────
  // Follow the SFF linked-list order naturally: each usePrevPal=0 (uPP=0) sprite
  // carries its own embedded PCX palette and updates prevPalette for all subsequent
  // uPP=1 sprites.  This is identical for sharedPal=0 and sharedPal=1 characters.
  //
  // Why no special pre-scan for sharedPal=1:
  //   The SFF linked list is already ordered so that each sprite group's uPP=0 sprite
  //   appears before the uPP=1 sprites in that same group.  For Koishi: [9000,0] then
  //   [9000,1] then [0,0] (body) then [0,1+] then [10001,0] (FX) then [10001,1-11+].
  //   A merged-palette approach caused [9000,1] (215 non-black entries) to crowd out
  //   the FX palettes entirely, making FX sprites render with large-portrait colors.
  //
  // ACT files are NOT applied here — parseSff() always passes null for defaultPalette.
  let prevPalette = defaultPalette; // null in practice; non-null only if caller provides one

  // SFF v1: dataLen=0 means "reuse last compressed data" (shared sprite data).
  let lastPcxData = null;
  let offset      = firstOffset;

  for (let idx = 0; idx < numImages && offset !== 0; idx++) {
    if (offset + 32 > bytes.length) break;

    const nextOffset  = view.getUint32(offset,      true);
    const dataLen     = view.getUint32(offset + 4,  true);
    const axisX       = view.getInt16 (offset + 8,  true);
    const axisY       = view.getInt16 (offset + 10, true);
    const group       = view.getUint16(offset + 12, true);
    const image       = view.getUint16(offset + 14, true);
    const usePrevPal  = bytes[offset + 18];

    const dataOffset  = offset + 32;
    const key         = `${group}_${image}`;

    let pcxData = null;
    if (dataLen > 0 && dataOffset + dataLen <= bytes.length) {
      pcxData = bytes.slice(dataOffset, dataOffset + dataLen);
      lastPcxData = pcxData; // remember for subsequent dlen=0 sprites
    } else if (dataLen === 0) {
      // SFF v1 shared data: reuse the last sprite's compressed image data.
      // The axis coords in this sprite's header are still its own.
      pcxData = lastPcxData;
    }

    // uPP=0: sprite carries its own palette → use it and update prevPalette.
    // uPP=1: use prevPalette (set by the most recent uPP=0 in file order).
    //
    // Exception for sharedPal=1: portrait sub-images (group 9000, image ≥ 1) must NOT
    // update prevPalette.  Their embedded PCX palette only contains the few colors needed
    // to draw the portrait bitmap; all other palette slots are pure-black (0,0,0).
    // If [9000,1] were allowed to overwrite prevPalette, every subsequent uPP=1 body
    // sprite would use that near-all-black palette (e.g. Goku renders entirely black).
    // [9000,0] is still allowed through — it establishes the shared base palette so
    // uPP=1 body sprites that come before any uPP=0 body sprite have a valid fallback.
    let palette = prevPalette;
    if (pcxData && !usePrevPal) {
      const pcxPal = _extractPcxPalette(pcxData);
      if (pcxPal) {
        palette = pcxPal;
        const isPortraitSub = sffSharedPal && !isStage && group === 9000 && image > 0;
        if (!isPortraitSub) prevPalette = pcxPal;
      }
    }

    if (pcxData && palette) {
      try {
        const canvas = _decodePcx(pcxData, palette);
        if (canvas) sprites.set(key, { canvas, width: canvas.width, height: canvas.height, axisX, axisY });
      } catch { /* skip corrupt sprites */ }
    }

    offset = nextOffset;
  }
}

// Extract 256-color VGA palette from end of PCX file (last 769 bytes)
function _extractPcxPalette(pcxData) {
  if (pcxData.length < 769) return null;
  const paletteStart = pcxData.length - 769;
  if (pcxData[paletteStart] !== 0x0C) return null; // magic byte
  const pal = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const base = paletteStart + 1 + i * 3;
    pal[i * 4 + 0] = pcxData[base];
    pal[i * 4 + 1] = pcxData[base + 1];
    pal[i * 4 + 2] = pcxData[base + 2];
    pal[i * 4 + 3] = i === 0 ? 0 : 255; // index 0 transparent in MUGEN
  }
  return pal;
}

// Decode PCX → OffscreenCanvas using the given RGBA palette
function _decodePcx(pcxData, palette) {
  // PCX header
  if (pcxData[0] !== 10) return null; // manufacturer must be ZSoft (10)
  const xmin = pcxData[4]  | (pcxData[5]  << 8);
  const ymin = pcxData[6]  | (pcxData[7]  << 8);
  const xmax = pcxData[8]  | (pcxData[9]  << 8);
  const ymax = pcxData[10] | (pcxData[11] << 8);
  const bytesPerLine = pcxData[66] | (pcxData[67] << 8);
  const planes       = pcxData[65] || 1;

  const width  = xmax - xmin + 1;
  const height = ymax - ymin + 1;
  if (width <= 0 || height <= 0 || width > 4096 || height > 4096) return null;

  // Decode RLE pixel data (starts at byte 128)
  const indices = new Uint8Array(height * bytesPerLine * planes);
  let src = 128;
  let dst = 0;
  // Only exclude the trailing palette if it actually exists (magic byte 0x0C).
  // Sprites with usePrevPal=1 are stored without a trailing palette, so limiting
  // to pcxData.length - 769 would cut off real pixel rows for those sprites.
  const hasPalette = pcxData.length >= 769 && pcxData[pcxData.length - 769] === 0x0C;
  const limit = hasPalette ? pcxData.length - 769 : pcxData.length;

  while (src < limit && dst < indices.length) {
    const b = pcxData[src++];
    if ((b & 0xC0) === 0xC0) {
      const count = b & 0x3F;
      const val   = src < limit ? pcxData[src++] : 0;
      for (let c = 0; c < count && dst < indices.length; c++) {
        indices[dst++] = val;
      }
    } else {
      indices[dst++] = b;
    }
  }

  // Build RGBA pixels
  const canvas  = new OffscreenCanvas(width, height);
  const ctx     = canvas.getContext('2d');
  const imgData = ctx.createImageData(width, height);
  const pixels  = imgData.data;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const srcIdx = y * bytesPerLine + x;
      const palIdx = indices[srcIdx];
      const dstOff = (y * width + x) * 4;
      pixels[dstOff]     = palette[palIdx * 4];
      pixels[dstOff + 1] = palette[palIdx * 4 + 1];
      pixels[dstOff + 2] = palette[palIdx * 4 + 2];
      pixels[dstOff + 3] = palette[palIdx * 4 + 3];
    }
  }

  ctx.putImageData(imgData, 0, 0);
  return canvas;
}

// ── SFF v2 RLE8 decoder ───────────────────────────────────────────────────────
// Format 2: run-length encoded 8-bit indexed color.
// Each row is independently encoded. Row data starts with a 2-byte LE row length,
// followed by alternating (count, value) pairs where:
//   if count & 0x01 → transparent run of (count >> 1) pixels
//   else            → literal run of (count >> 1) pixels, each 1 byte index follows
// (This is MUGEN's specific RLE8 variant, not PCX RLE)
function _decodeRle8(bytes, dataStart, dataLen, width, height, palette) {
  const canvas  = new OffscreenCanvas(width, height);
  const ctx     = canvas.getContext('2d');
  const imgData = ctx.createImageData(width, height);
  const pix     = imgData.data;
  const end     = dataStart + dataLen;

  let src = dataStart;
  for (let y = 0; y < height && src + 2 <= end; y++) {
    const rowLen = bytes[src] | (bytes[src + 1] << 8);
    const rowEnd = Math.min(src + 2 + rowLen, end);
    src += 2;
    let x = 0;
    while (src < rowEnd && x < width) {
      const ctrl  = bytes[src++];
      const count = ctrl >> 1;
      if (ctrl & 1) {
        // transparent run
        x += count;
      } else {
        // literal pixels
        for (let k = 0; k < count && x < width && src < rowEnd; k++, x++) {
          const c   = bytes[src++];
          const dst = (y * width + x) * 4;
          pix[dst]     = palette[c * 4];
          pix[dst + 1] = palette[c * 4 + 1];
          pix[dst + 2] = palette[c * 4 + 2];
          pix[dst + 3] = palette[c * 4 + 3];
        }
      }
    }
    // Next row starts at rowEnd, even if this row was empty or not fully consumed.
    src = rowEnd;
  }
  ctx.putImageData(imgData, 0, 0);
  return canvas;
}

// ── LZ5 decoder (SFF v2 format 4) ────────────────────────────────────────────
// MUGEN's LZ5 is an LZ77 variant with 4-KB sliding window.
// The compressed stream starts 4 bytes into the sprite data (skip the w/h header
// that the caller already extracted from the sprite list entry).
// Stream structure: alternating control byte + 8 payload items.
//   Control bit = 0 → next byte is a literal pixel index.
//   Control bit = 1 → next 2 bytes encode a back-reference:
//       lo = src[0], hi = src[1]
//       distance = ((hi & 0xF0) << 4) | lo + 1        (1..4096)
//       length   = (hi & 0x0F) + 3                     (3..18)
// Decompressed output is width×height indexed bytes; render with palette.
function _decodeLz5(bytes, dataStart, dataLen, width, height, palette) {
  const total   = width * height;
  const out     = new Uint8Array(total);
  const end     = dataStart + dataLen;
  // Skip the 4-byte w/h header already decoded from the sprite entry
  let src = dataStart + 4;
  let dst = 0;

  while (src < end && dst < total) {
    const ctrl = bytes[src++];
    for (let bit = 0; bit < 8 && src < end && dst < total; bit++) {
      if ((ctrl >> (7 - bit)) & 1) {
        // Back-reference
        if (src + 1 >= end) break;
        const lo   = bytes[src++];
        const hi   = bytes[src++];
        const dist = ((hi & 0xF0) << 4) | lo;   // 0..4095; add 1 for actual distance
        const len  = (hi & 0x0F) + 3;           // 3..18
        const back = dst - (dist + 1);
        for (let k = 0; k < len && dst < total; k++) {
          out[dst] = back + k >= 0 ? out[back + k] : 0;
          dst++;
        }
      } else {
        // Literal
        out[dst++] = bytes[src++];
      }
    }
  }

  const canvas  = new OffscreenCanvas(width, height);
  const ctx     = canvas.getContext('2d');
  const imgData = ctx.createImageData(width, height);
  const pix     = imgData.data;
  for (let p = 0; p < total; p++) {
    const c = out[p];
    pix[p * 4]     = palette[c * 4];
    pix[p * 4 + 1] = palette[c * 4 + 1];
    pix[p * 4 + 2] = palette[c * 4 + 2];
    pix[p * 4 + 3] = palette[c * 4 + 3];
  }
  ctx.putImageData(imgData, 0, 0);
  return canvas;
}

// ── CRC-32 (used for PNG chunk integrity) ────────────────────────────────────
function _crc32(data) {
  let crc = CRC32_INITIAL;
  for (let i = 0; i < data.length; i++) {
    let b = (crc ^ data[i]) & 0xFF;
    for (let j = 0; j < 8; j++) b = (b & 1) ? (CRC32_POLY ^ (b >>> 1)) : (b >>> 1);
    crc = (crc >>> 8) ^ b;
  }
  return (~crc) >>> 0;
}

// ── Patch an indexed-color PNG's PLTE + tRNS chunks ──────────────────────────
// Replaces the PNG's placeholder all-black PLTE with colors from the SFF palette,
// and adds/replaces a tRNS chunk so palette index 0 renders as transparent.
// palette256rgba: Uint8Array of 256×4 RGBA values sourced from the SFF.
function _patchPngPalette(pngU8, palette256rgba) {
  let pos = 8; // skip 8-byte PNG signature
  let plteStart = -1, plteLen = 0;
  let trnsStart = -1, trnsLen = 0;

  while (pos + 12 <= pngU8.length) {
    const len  = ((pngU8[pos]<<24)|(pngU8[pos+1]<<16)|(pngU8[pos+2]<<8)|pngU8[pos+3]) >>> 0;
    const type = String.fromCharCode(pngU8[pos+4], pngU8[pos+5], pngU8[pos+6], pngU8[pos+7]);
    if (type === 'PLTE') { plteStart = pos; plteLen = len; }
    if (type === 'tRNS') { trnsStart = pos; trnsLen = len; }
    if (type === 'IDAT') break;
    pos += 12 + len;
  }
  if (plteStart === -1) return pngU8; // no PLTE — not an indexed PNG, leave as-is

  const numEntries = Math.min(plteLen / 3, 256);

  // Build new PLTE data (numEntries × RGB)
  const newPlteData = new Uint8Array(plteLen);
  for (let i = 0; i < numEntries; i++) {
    newPlteData[i*3]   = palette256rgba[i*4];
    newPlteData[i*3+1] = palette256rgba[i*4+1];
    newPlteData[i*3+2] = palette256rgba[i*4+2];
  }

  // Build tRNS data: alpha values; find highest non-opaque entry
  let maxTrnsIdx = 0;
  for (let i = 1; i < numEntries; i++) {
    if (palette256rgba[i*4+3] !== 255) maxTrnsIdx = i;
  }
  const newTrnsData = new Uint8Array(maxTrnsIdx + 1);
  newTrnsData[0] = 0; // index 0 always transparent in MUGEN
  for (let i = 1; i <= maxTrnsIdx; i++) newTrnsData[i] = palette256rgba[i*4+3];

  // Compute chunk CRCs
  const plteCrcBuf = new Uint8Array(4 + plteLen);
  plteCrcBuf.set([80,76,84,69]); plteCrcBuf.set(newPlteData, 4);
  const plteCrc = _crc32(plteCrcBuf);

  const trnsCrcBuf = new Uint8Array(4 + newTrnsData.length);
  trnsCrcBuf.set([116,82,78,83]); trnsCrcBuf.set(newTrnsData, 4);
  const trnsCrc = _crc32(trnsCrcBuf);

  // Assemble new PLTE chunk (same byte length as original)
  const newPlteChunk = new Uint8Array(12 + plteLen);
  const dpv = new DataView(newPlteChunk.buffer);
  dpv.setUint32(0, plteLen, false);
  newPlteChunk.set([80,76,84,69], 4);
  newPlteChunk.set(newPlteData, 8);
  dpv.setUint32(8 + plteLen, plteCrc, false);

  // Assemble new tRNS chunk
  const newTrnsChunk = new Uint8Array(12 + newTrnsData.length);
  const dtv = new DataView(newTrnsChunk.buffer);
  dtv.setUint32(0, newTrnsData.length, false);
  newTrnsChunk.set([116,82,78,83], 4);
  newTrnsChunk.set(newTrnsData, 8);
  dtv.setUint32(8 + newTrnsData.length, trnsCrc, false);

  // Assemble patched PNG:
  // [before PLTE] + [new PLTE] + [new tRNS] + [after old PLTE, skipping old tRNS if present]
  const plteEnd = plteStart + 12 + plteLen;
  if (trnsStart !== -1 && trnsStart >= plteEnd) {
    // Skip old tRNS and the gap between PLTE end and tRNS
    // Include bytes between PLTE end and old tRNS, then skip old tRNS
    const gap = pngU8.subarray(plteEnd, trnsStart);
    const afterTrns = pngU8.subarray(trnsStart + 12 + trnsLen);
    const parts = [pngU8.subarray(0, plteStart), newPlteChunk, newTrnsChunk, gap, afterTrns];
    const total = parts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(total);
    let off = 0; for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  }
  const parts = [pngU8.subarray(0, plteStart), newPlteChunk, newTrnsChunk, pngU8.subarray(plteEnd)];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0; for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

// ── SFF v2 helpers ─────────────────────────────────────────────────────────────
async function _loadSffV2Palettes(bytes, view, palListOffset, palCount, ldataOffset) {
  const palettes = [];
  for (let p = 0; p < palCount; p++) {
    const pOff = palListOffset + p * 16;
    if (pOff + 16 > bytes.length) break;
    const relDataOff = view.getUint32(pOff + 8,  true);
    const dataLen    = view.getUint32(pOff + 12, true);
    if (dataLen === 0) { palettes.push(null); continue; }
    const absDataOff = ldataOffset + relDataOff;
    if (absDataOff + dataLen > bytes.length) { palettes.push(null); continue; }
    const stride = dataLen === 768 ? 3 : 4;
    const pal = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) {
      const s = absDataOff + i * stride;
      if (s + stride > bytes.length) break;
      pal[i * 4]     = bytes[s];
      pal[i * 4 + 1] = bytes[s + 1];
      pal[i * 4 + 2] = bytes[s + 2];
      pal[i * 4 + 3] = stride === 4 ? bytes[s + 3] : 255;
    }
    pal[3] = 0;
    palettes.push(pal);
  }
  return palettes;
}

function _resolveLinkedSffV2Sprite(sprListOffset, ENTRY_SIZE, bytes, view, linkedIndex, sprites, key) {
  const linkedEOff = sprListOffset + linkedIndex * ENTRY_SIZE;
  if (linkedEOff + ENTRY_SIZE <= bytes.length) {
    const lGroup = view.getUint16(linkedEOff,     true);
    const lImage = view.getUint16(linkedEOff + 2, true);
    const lKey   = `${lGroup}_${lImage}`;
    if (sprites.has(lKey)) {
      sprites.set(key, sprites.get(lKey));
      return true;
    }
  }
  return false;
}

async function _decodeSffV2Png(bytes, absOff, dataLength, palettes, palIdx) {
  try {
    let pngBytes = bytes.slice(absOff, absOff + dataLength);
    const pal = palettes[palIdx] ?? palettes[0];
    if (pal) pngBytes = _patchPngPalette(pngBytes, pal);
    const blob   = new Blob([pngBytes], { type: 'image/png' });
    const bitmap = await _safeCreateImageBitmap(blob);
    const width  = bitmap.width || bitmap.naturalWidth;
    const height = bitmap.height || bitmap.naturalHeight;
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    if (bitmap.close) bitmap.close();
    return { canvas, width, height };
  } catch {
    return null;
  }
}

function _decodeSffV2Rle8(bytes, eOff, absOff, dataLength, view, palettes, palIdx) {
  const width  = view.getUint16(eOff + 4, true);
  const height = view.getUint16(eOff + 6, true);
  if (width === 0 || height === 0) return null;
  const palette = palettes[palIdx] ?? palettes[0];
  if (!palette) return null;
  try {
    const canvas = _decodeRle8(bytes, absOff, dataLength, width, height, palette);
    if (canvas) return { canvas, width, height };
  } catch { /* skip */ }
  return null;
}

function _decodeSffV2Lz5(bytes, eOff, absOff, dataLength, view, palettes, palIdx) {
  const width  = view.getUint16(eOff + 4, true);
  const height = view.getUint16(eOff + 6, true);
  if (width === 0 || height === 0) return null;
  const palette = palettes[palIdx] ?? palettes[0];
  if (!palette) return null;
  try {
    const canvas = _decodeLz5(bytes, absOff, dataLength, width, height, palette);
    if (canvas) return { canvas, width, height };
  } catch { /* skip */ }
  return null;
}

function _decodeSffV2Raw8(bytes, eOff, absOff, dataLength, view, palettes, palIdx) {
  const width  = view.getUint16(eOff + 4, true);
  const height = view.getUint16(eOff + 6, true);
  if (width === 0 || height === 0) return null;
  const palette = palettes[palIdx] ?? palettes[0];
  if (!palette) return null;
  try {
    const canvas  = new OffscreenCanvas(width, height);
    const ctx     = canvas.getContext('2d');
    const imgData = ctx.createImageData(width, height);
    const pix     = imgData.data;
    const src     = bytes.subarray(absOff, absOff + Math.min(dataLength, width * height));
    for (let p = 0; p < src.length; p++) {
      const c = src[p];
      pix[p * 4]     = palette[c * 4];
      pix[p * 4 + 1] = palette[c * 4 + 1];
      pix[p * 4 + 2] = palette[c * 4 + 2];
      pix[p * 4 + 3] = palette[c * 4 + 3];
    }
    ctx.putImageData(imgData, 0, 0);
    return { canvas, width, height };
  } catch { /* skip */ }
  return null;
}

// ── SFF v2 ────────────────────────────────────────────────────────────────────
// Standard MUGEN 1.0/1.1 SFF v2 header layout:
//   [0-11]  signature "ElecbyteSpr\0"
//   [12-15] version bytes (0,1,0,2 = v2.1)
//   [16-35] reserved
//   [36-39] sprListOffset
//   [40-43] sprCount
//   [44-47] palListOffset
//   [48-51] palCount
//   [52-55] ldataOffset  (lossless data section; palette+sprite data offsets are relative here)
//   [56-59] ldataLength
//   [60-63] tdataOffset
//   [64-67] tdataLength
// Sprite entry: 28 bytes each
//   [0-1]  group, [2-3] image, [4-5] width, [6-7] height
//   [8-9]  axisX, [10-11] axisY, [12-13] linkedIndex
//   [14]   format (10=PNG, 2=RLE8, 4=LZ5, 0=raw), [15] colorDepth
//   [16-19] dataOffset (relative to ldataOffset or tdataOffset), [20-23] dataLength
//   [24-25] paletteIndex, [26-27] flags (bit0: 0=ldata, 1=tdata)
// Palette list entry: 16 bytes each
//   [0-1]  palGroup, [2-3] palNo, [4-5] numColors, [6-7] link
//   [8-11] ldataOffset (relative to file's ldataOffset), [12-15] ldataLength
async function _parseSffV2(bytes, view, sprites) {
  const sprListOffset = view.getUint32(36, true);
  const sprCount      = view.getUint32(40, true);
  const palListOffset = view.getUint32(44, true);
  const palCount      = view.getUint32(48, true);
  const ldataOffset   = view.getUint32(52, true);
  const tdataOffset   = view.getUint32(60, true);

  const palettes = await _loadSffV2Palettes(bytes, view, palListOffset, palCount, ldataOffset);

  const ENTRY_SIZE = 28;

  for (let i = 0; i < sprCount; i++) {
    const eOff = sprListOffset + i * ENTRY_SIZE;
    if (eOff + ENTRY_SIZE > bytes.length) break;

    const group       = view.getUint16(eOff,      true);
    const image       = view.getUint16(eOff + 2,  true);
    const axisX       = view.getInt16 (eOff + 8,  true);
    const axisY       = view.getInt16 (eOff + 10, true);
    const linkedIndex = view.getUint16(eOff + 12, true);
    const fmt         = bytes[eOff + 14];
    const dataOffset  = view.getUint32(eOff + 16, true);
    const dataLength  = view.getUint32(eOff + 20, true);
    const palIdx      = view.getUint16(eOff + 24, true);
    const flags       = view.getUint16(eOff + 26, true);

    const key = `${group}_${image}`;
    if (sprites.has(key)) continue;

    // Linked sprite — copy from the linked entry
    if (dataLength === 0 && linkedIndex > 0) {
      _resolveLinkedSffV2Sprite(sprListOffset, ENTRY_SIZE, bytes, view, linkedIndex, sprites, key);
      continue;
    }

    if (dataLength === 0) continue;

    // Sprite dataOffset values are relative to ldataOffset+4 (the ldata section has a
    // 4-byte internal header that is NOT included in the per-sprite offset values).
    // Palette relDataOff values however use ldataOffset directly as their base.
    const base   = (flags & 1) ? tdataOffset : (ldataOffset + 4);
    const absOff = base + dataOffset;
    if (absOff + dataLength > bytes.length) continue;

    let result = null;
    if (fmt === 10 || fmt === 1) {
      result = await _decodeSffV2Png(bytes, absOff, dataLength, palettes, palIdx);
    } else if (fmt === 2) {
      result = _decodeSffV2Rle8(bytes, eOff, absOff, dataLength, view, palettes, palIdx);
    } else if (fmt === 4) {
      result = _decodeSffV2Lz5(bytes, eOff, absOff, dataLength, view, palettes, palIdx);
    } else if (fmt === 0) {
      result = _decodeSffV2Raw8(bytes, eOff, absOff, dataLength, view, palettes, palIdx);
    }

    if (result) {
      sprites.set(key, { canvas: result.canvas, width: result.width, height: result.height, axisX, axisY });
    }
  }
}
