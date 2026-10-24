// @ts-check
const DMG = [
  [15, 56, 15],
  [48, 98, 72],
  [139, 172, 15],
  [155, 188, 15],
];

/** @param {Uint8Array} source @param {Uint8Array} target */
export function decodeRle(source, target) {
  if (source.length % 2) return false;
  let size = 0;
  for (let index = 0; index < source.length; index += 2) {
    if (!source[index]) return false;
    size += source[index];
    if (size > target.length) return false;
  }
  if (size !== target.length) return false;
  let offset = 0;
  for (let index = 0; index < source.length; index += 2) {
    target.fill(source[index + 1], offset, offset + source[index]);
    offset += source[index];
  }
  return true;
}

/** @param {number[][] | null} palette */
export function tintMonochromePalette(palette) {
  if (!palette?.length || palette.length > 4) return palette;
  if (
    !palette.every(
      (color) => Math.abs(color[0] - color[1]) < 3 && Math.abs(color[1] - color[2]) < 3,
    )
  )
    return palette;
  const order = palette
    .map((color, index) => [color[0] * 0.299 + color[1] * 0.587 + color[2] * 0.114, index])
    .sort((first, second) => first[0] - second[0]);
  const result = palette.slice();
  order.forEach(([, index], rank) => {
    result[index] =
      DMG[order.length >= 4 ? rank : Math.round((rank * 3) / Math.max(1, order.length - 1))];
  });
  return result;
}

/** @param {Uint8Array} pixels @param {number[][]} palette @param {Uint8ClampedArray} output */
export function renderIndexedFrame(pixels, palette, output) {
  if (!palette.length || output.length !== pixels.length * 4) return false;
  for (let index = 0; index < pixels.length; index++) {
    const color = palette[pixels[index] < palette.length ? pixels[index] : 0];
    output.set([color[0], color[1], color[2], 255], index * 4);
  }
  return true;
}
