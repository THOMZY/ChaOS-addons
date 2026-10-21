// ChaOS — MUGEN SND file parser
//
// Parses binary MUGEN .snd files and decodes each sample into an AudioBuffer.
// Supports:
//   - MUGEN SND v1.0  (raw 8-bit unsigned PCM mono 22050 Hz)
//   - WAV / OGG / MP3 samples embedded in newer SND files
//
// Usage:
//   const sounds = await parseSnd(arrayBuffer);
//   // sounds: Map<"group_index", AudioBuffer>

const HEADER_B_RATIO_THRESHOLD = 60 / 100;

let _audioCtx = null;

function _getSndCtx() {
  if (!_audioCtx) {
    try {
      // Request a standard sample rate; browser clamps it to a supported value.
      _audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 22050 });
    } catch {
      try { _audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch { /* no audio */ }
    }
  }
  return _audioCtx;
}

// Resume the shared audio context after a user gesture.
export function resumeSndCtx() {
  const ctx = _getSndCtx();
  if (ctx?.state === 'suspended') ctx.resume().catch(() => {});
}

// Return the shared AudioContext (needed to play back decoded AudioBuffers).
export function getSndAudioCtx() { return _getSndCtx(); }

/**
 * Parse a MUGEN SND ArrayBuffer and return a Map keyed by "group_index".
 * Non-decodable samples are silently skipped.
 *
 * When multiple entries share the same group/index, the LAST occurrence is kept
 * (matching official MUGEN and Ikemen-GO behaviour).  Resolution is deterministic —
 * it does NOT depend on which AudioBuffer finishes decoding first.
 */
export async function parseSnd(buffer) {
  const result = new Map();
  if (!buffer || buffer.byteLength < 32) return result;

  const bytes = new Uint8Array(buffer);
  const dv    = new DataView(buffer);

  // Signature: "ElecbyteSnd" (11 printable chars + null)
  const sig = String.fromCharCode(...bytes.slice(0, 11));
  if (sig !== 'ElecbyteSnd') return result;

  const numSounds  = dv.getUint32(16, true); // LE uint32
  let   offset     = dv.getUint32(20, true); // first subfile offset

  const ctx = _getSndCtx();
  if (!ctx) return result;

  // ── Pass 1: collect entries in file order; last occurrence per key wins ──
  // We store the raw ArrayBuffer slice for each key (overwriting earlier ones)
  // so that decoding is deterministic regardless of async completion order.
  const keyToRaw = new Map(); // key -> ArrayBuffer (last occurrence)

  for (let i = 0; i < numSounds; i++) {
    if (offset === 0 || offset + 16 > buffer.byteLength) break;

    const nextOffset = dv.getUint32(offset,      true);
    const dataLen    = dv.getUint32(offset +  4, true);
    const group      = dv.getUint32(offset +  8, true);  // uint32, not uint16
    const index      = dv.getUint32(offset + 12, true);  // uint32 at +12, not uint16 at +10
    const dataStart  = offset + 16;                       // 16-byte header (4+4+4+4)
    const dataEnd    = dataStart + dataLen;

    if (dataLen > 0 && dataEnd <= buffer.byteLength) {
      keyToRaw.set(`${group}_${index}`, buffer.slice(dataStart, dataEnd));
    }

    if (nextOffset === 0 || nextOffset <= offset) break;
    offset = nextOffset;
  }

  // ── Pass 2: decode the selected raw buffers in parallel ──────────────────
  const decodes = [];
  for (const [key, raw] of keyToRaw) {
    decodes.push(
      _decodeAudio(ctx, raw)
        .then(buf => { if (buf) result.set(key, buf); })
        .catch(() => {}),
    );
  }

  await Promise.allSettled(decodes);
  return result;
}

// ── Internal decode helpers ───────────────────────────────────────────────────

async function _decodeAudio(ctx, raw) {
  const bytes = new Uint8Array(raw);
  if (bytes.length < 8) return null;

  const h0 = _audioHeader(bytes, 0);
  const h4 = _audioHeader(bytes, 4);
  if (!_isAudioContainer(h0) && _isAudioContainer(h4)) return _decodeContainerAudio(ctx, raw.slice(4), h4);
  if (_isAudioContainer(h0)) return _decodeContainerAudio(ctx, raw, h0);
  return _decodeLegacyRawAudio(ctx, raw, bytes);
}

function _audioHeader(bytes, offset) {
  return bytes.length >= offset + 4
    ? String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3])
    : '';
}

function _isAudioContainer(h) {
  return h === 'RIFF' || h === 'OggS' || h.startsWith('ID3') ||
    (h.charCodeAt(0) === 0xFF && (h.charCodeAt(1) & 0xE0) === 0xE0);
}

async function _decodeContainerAudio(ctx, raw, header) {
  try { return await ctx.decodeAudioData(raw.slice(0)); } catch { /* try the 8-bit RIFF conversion */ }
  if (header === 'RIFF') {
    try {
      const wav16 = _riff8to16(raw);
      if (wav16) return await ctx.decodeAudioData(wav16);
    } catch { /* not an 8-bit RIFF either */ }
  }
  return null;
}

async function _decodeLegacyRawAudio(ctx, raw, bytes) {
  if (_looksLike16bitPCM(bytes)) {
    const buf16 = _manualPcm16Buffer(ctx, raw);
    if (buf16) return buf16;
  }
  try {
    const wavBuf = _wrapRawPcm8(raw);
    return await ctx.decodeAudioData(wavBuf);
  } catch { /* fall through */ }
  return _manualPcm8Buffer(ctx, raw);
}

/**
 * Convert an 8-bit unsigned mono/stereo PCM RIFF WAV to 16-bit signed so that
 * browsers which reject 8-bit WAVs (some Chromium versions) can decode it.
 * Scans for both the fmt chunk and the data chunk rather than using hardcoded offsets.
 */
function _riff8to16(raw) {
  if (raw.byteLength < 12) return null;
  const dv = new DataView(raw);

  // Walk RIFF chunks starting after the "RIFF....WAVE" header (byte 12)
  let audioFmt = 0, numCh = 1, sampleRate = 22050, bitsIn = 0;
  let dataOffset = -1, dataLen = 0;
  let pos = 12;
  while (pos + 8 <= raw.byteLength) {
    const id   = String.fromCharCode(dv.getUint8(pos), dv.getUint8(pos+1), dv.getUint8(pos+2), dv.getUint8(pos+3));
    const size = dv.getUint32(pos + 4, true);
    if (id === 'fmt ') {
      audioFmt   = dv.getUint16(pos + 8,  true);
      numCh      = dv.getUint16(pos + 10, true);
      sampleRate = dv.getUint32(pos + 12, true);
      bitsIn     = dv.getUint16(pos + 22, true);
    }
    if (id === 'data') { dataOffset = pos + 8; dataLen = size; break; }
    pos += 8 + size + (size & 1);
  }
  if (audioFmt !== 1 || bitsIn !== 8 || dataOffset < 0) return null;

  const src        = new Uint8Array(raw, dataOffset, Math.min(dataLen, raw.byteLength - dataOffset));
  const numSamples = src.length;
  const dataLen16  = numSamples * 2;
  const wav16      = new ArrayBuffer(44 + dataLen16);
  const dv16       = new DataView(wav16);
  const u8out      = new Uint8Array(wav16);

  // Write clean 44-byte PCM WAV header
  u8out[0]=0x52;u8out[1]=0x49;u8out[2]=0x46;u8out[3]=0x46; // "RIFF"
  dv16.setUint32(4, 36 + dataLen16, true);
  u8out[8]=0x57;u8out[9]=0x41;u8out[10]=0x56;u8out[11]=0x45; // "WAVE"
  u8out[12]=0x66;u8out[13]=0x6D;u8out[14]=0x74;u8out[15]=0x20; // "fmt "
  dv16.setUint32(16, 16, true);
  dv16.setUint16(20, 1, true);                          // PCM
  dv16.setUint16(22, numCh, true);
  dv16.setUint32(24, sampleRate, true);
  dv16.setUint32(28, sampleRate * numCh * 2, true);     // byte rate
  dv16.setUint16(32, numCh * 2, true);                  // block align
  dv16.setUint16(34, 16, true);                         // bits per sample
  u8out[36]=0x64;u8out[37]=0x61;u8out[38]=0x74;u8out[39]=0x61; // "data"
  dv16.setUint32(40, dataLen16, true);

  const out = new Int16Array(wav16, 44);
  for (let i = 0; i < numSamples; i++) out[i] = (src[i] - 128) << 8;
  return wav16;
}

/** Wrap raw 8-bit unsigned mono PCM in a minimal 44-byte WAV header at 22050 Hz. */
function _wrapRawPcm8(raw) {
  const pcmLen = raw.byteLength;
  const wavLen = 44 + pcmLen;
  const wav    = new ArrayBuffer(wavLen);
  const dv     = new DataView(wav);
  const u8     = new Uint8Array(wav);

  // RIFF header
  u8[0]=0x52; u8[1]=0x49; u8[2]=0x46; u8[3]=0x46; // "RIFF"
  dv.setUint32(4, wavLen - 8, true);
  u8[8]=0x57; u8[9]=0x41; u8[10]=0x56; u8[11]=0x45; // "WAVE"
  // fmt chunk
  u8[12]=0x66; u8[13]=0x6D; u8[14]=0x74; u8[15]=0x20; // "fmt "
  dv.setUint32(16, 16,    true); // chunk size
  dv.setUint16(20,  1,    true); // PCM
  dv.setUint16(22,  1,    true); // mono
  dv.setUint32(24, 22050, true); // sample rate
  dv.setUint32(28, 22050, true); // byte rate
  dv.setUint16(32,  1,    true); // block align
  dv.setUint16(34,  8,    true); // 8-bit
  // data chunk
  u8[36]=0x64; u8[37]=0x61; u8[38]=0x74; u8[39]=0x61; // "data"
  dv.setUint32(40, pcmLen, true);
  u8.set(new Uint8Array(raw), 44);

  return wav;
}

/** Manually decode raw 8-bit unsigned PCM into a float32 AudioBuffer. */
function _manualPcm8Buffer(ctx, raw) {
  const pcm = new Uint8Array(raw);
  try {
    const buf  = ctx.createBuffer(1, pcm.length, 22050);
    const data = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) data[i] = (pcm[i] - 128) / 128.0;
    return buf;
  } catch { return null; }
}

/**
 * Heuristic: return true if the raw bytes look like 16-bit signed little-endian PCM
 * rather than 8-bit unsigned PCM.
 *
 * Two complementary signals:
 *
 * B-score: for 16-bit LE, odd-indexed bytes are MSBs. At any normal amplitude,
 *   MSBs cluster near 0 (positive samples) and near 255 (negative samples), so
 *   the vast majority fall OUTSIDE the mid-range [64..191].
 *   For 8-bit PCM, all bytes are audio samples distributed around 128; their
 *   mid-range presence is much higher → B-score stays well below 0.75.
 *
 * Smoothness ratio: consecutive odd-indexed bytes (MSBs) of 16-bit LE audio
 *   follow the smooth audio waveform, while even-indexed bytes (LSBs) are noisy.
 *   For 8-bit PCM, both even and odd bytes are consecutive samples with similar
 *   smoothness → ratio ≈ 1.
 */
function _looksLike16bitPCM(bytes) {
  if (bytes.length < 64) return false;
  const check = Math.min(bytes.length & ~1, 4000);

  let suspB = 0;
  let dOdd = 0, dEven = 0, nOdd = 0, nEven = 0;
  for (let i = 1; i < check; i++) {
    if (i % 2 === 1) {                                   // odd index = potential MSB
      if (bytes[i] < 64 || bytes[i] > 191) suspB++;
      if (i >= 3) { dOdd += Math.abs(bytes[i] - bytes[i - 2]); nOdd++; }
    } else {                                             // even index = potential LSB
      if (i >= 2) { dEven += Math.abs(bytes[i] - bytes[i - 2]); nEven++; }
    }
  }
  const pctB   = suspB / (check / 2);
  const smooth = nEven > 0 && dEven > 0 ? (dOdd / nOdd) / (dEven / nEven) : 1;

  // Primary: >75% of potential MSBs outside mid-range → clearly 16-bit
  // Secondary: borderline B-score + MSBs conspicuously smoother than LSBs
  return pctB > 0.75 || (pctB > HEADER_B_RATIO_THRESHOLD && smooth < 0.3);
}

/** Decode raw 16-bit signed little-endian mono PCM into a float32 AudioBuffer at 22050 Hz. */
function _manualPcm16Buffer(ctx, raw) {
  // Ensure even length (16-bit samples are 2 bytes each)
  const len = raw.byteLength & ~1;
  const pcm = new Int16Array(raw.slice(0, len));
  try {
    const buf  = ctx.createBuffer(1, pcm.length, 22050);
    const data = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) data[i] = pcm[i] / 32768.0;
    return buf;
  } catch { return null; }
}
