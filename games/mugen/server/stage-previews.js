// A still of the stage's background layers. Animation uses its first frame;
// parallax and controllers stay in the game engine.
import { readFileSync, statSync } from 'node:fs';
import { isUtf8 } from 'node:buffer';
import { join, posix } from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { parseSections } from './catalog.js';
import { readPortrait } from './portrait.js';

const numbers = (value, fallback = []) => (value == null ? fallback : value.split(',').map(Number));
const bounded = (value, fallback, min, max) =>
  Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;

export function createStagePreviews({ catalog }) {
  const cache = new Map();
  // Serialise image work so a grid of thumbnails cannot decode many SFFs at once.
  let queue = Promise.resolve();
  return {
    async preview(path) {
      if (!catalog.stage(path)) return null;
      try {
        const definition = join(catalog.roots.stages, path);
        const bytes = readFileSync(definition);
        const text = bytes.toString(isUtf8(bytes) ? 'utf8' : 'latin1');
        const sections = parseSections(text);
        const reference = sections.get('bgdef')?.get('spr')?.replace(/\\/g, '/');
        if (!reference) return null;
        const candidates = [
          posix.join(posix.dirname(path), reference),
          posix.join(posix.dirname(path), posix.basename(reference)),
          reference,
        ].map((value) => value.toLowerCase());
        // Only catalogued files can be read, including references to a shared SFF.
        const file = catalog
          .files()
          .stages.find(([name]) => candidates.includes(name.toLowerCase()))?.[0];
        if (!file) return null;
        const sprite = join(catalog.roots.stages, file);
        const stamp = statSync(sprite);
        const key = `${path}:${createHash('sha256').update(bytes).digest('hex')}:${stamp.mtimeMs}:${stamp.size}`;
        if (cache.has(key)) return cache.get(key);
        const job = queue.then(() => render(sections, text, sprite)).catch(() => null);
        queue = job.then(() => {});
        cache.set(key, job);
        while (cache.size > 128) cache.delete(cache.keys().next().value);
        return job;
      } catch {
        return null;
      }
    },
  };
}

async function render(sections, text, sprite) {
  const local = numbers(sections.get('info')?.get('localcoord'), [320, 240]);
  const width = bounded(local[0], 320, 160, 4096);
  const height = bounded(local[1], width * 0.75, 120, 4096);
  const color = numbers(sections.get('bgdef')?.get('bgclearcolor'), [0, 0, 0])
    .slice(0, 3)
    .map((value) => bounded(value, 0, 0, 255));
  const layers = [...sections].filter(([name]) => /^bg(?!def)/.test(name)).slice(0, 16);
  layers.sort((a, b) => (Number(a[1].get('layerno')) || 0) - (Number(b[1].get('layerno')) || 0));
  const images = [];
  const definitions = [];
  let total = 0;
  for (const [, layer] of layers) {
    let id = numbers(layer.get('spriteno'));
    if (layer.get('type')?.toLowerCase() === 'anim') {
      const action = Number(layer.get('actionno'));
      const body =
        Number.isInteger(action) &&
        new RegExp(`\\[begin action ${action}\\]([^]*?)(?=\\[|$)`, 'i').exec(text)?.[1];
      const frame = body && /^\s*(-?\d+)\s*,\s*(-?\d+)\s*,/m.exec(body);
      if (frame) id = [Number(frame[1]), Number(frame[2])];
    }
    if (id.length < 2 || !id.every(Number.isFinite)) continue;
    const image = readPortrait(sprite, { sprites: [id], metadata: true });
    if (!image) continue;
    total += image.png.length;
    if (total > 8 * 1024 * 1024) break;
    const start = numbers(layer.get('start'), [0, 0]);
    const x = bounded(start[0], 0, -8192, 8192) + width / 2 - image.x;
    const y = bounded(start[1], 0, -8192, 8192) - image.y;
    const tile = numbers(layer.get('tile'), [0, 0]);
    const spacing = numbers(layer.get('tilespacing'), [0, 0]);
    const dx = Math.max(1, image.width + (spacing[0] || 0));
    const dy = Math.max(1, image.height + (spacing[1] || 0));
    const xs = tile[0]
      ? Array.from(
          { length: Math.min(16, Math.ceil(width / dx) + 2) },
          (_, i) => x - Math.ceil(x / dx) * dx + i * dx,
        )
      : [x];
    const ys = tile[1]
      ? Array.from(
          { length: Math.min(16, Math.ceil(height / dy) + 2) },
          (_, i) => y - Math.ceil(y / dy) * dy + i * dy,
        )
      : [y];
    const elementId = `sprite${definitions.length}`;
    definitions.push(
      `<image id="${elementId}" width="${image.width}" height="${image.height}" href="data:image/png;base64,${image.png.toString('base64')}"/>`,
    );
    for (const left of xs)
      for (const top of ys) images.push(`<use href="#${elementId}" x="${left}" y="${top}"/>`);
  }
  if (!images.length) return null;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs>${definitions.join('')}</defs><rect width="100%" height="100%" fill="rgb(${color.join(',')})"/>${images.join('')}</svg>`;
  const png = await sharp(Buffer.from(svg), { limitInputPixels: 4096 * 4096 })
    .resize(320, 180, { fit: 'cover' })
    .png()
    .toBuffer();
  return { png, etag: '"' + createHash('sha256').update(png).digest('hex').slice(0, 24) + '"' };
}
