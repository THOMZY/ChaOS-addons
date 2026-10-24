import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { createPublicHttpClient, readLimitedBody } from '../../../server/http/public-http.js';

const API = 'https://retrobase-collection.com/api/public/v1/lookup';
const openStream = createPublicHttpClient({
  validateUrl(url) {
    if (url.protocol !== 'https:') throw new Error('artwork_requires_https');
  },
});

export function regionHint(filename = '') {
  const tags = [...String(filename).matchAll(/\(([^)]+)\)/g)].map((match) =>
    match[1].toLowerCase(),
  );
  for (const tag of tags)
    for (const [pattern, region] of [
      [/france|\bfr\b/, 'fr'],
      [/germany|\bde\b/, 'de'],
      [/spain|\bes\b/, 'es'],
      [/italy|\bit\b/, 'it'],
      [/japan|\bjp\b/, 'jp'],
      [/usa|\bus\b/, 'us'],
      [/europe|\beu\b/, 'eu'],
      [/world/, 'wor'],
    ])
      if (pattern.test(tag)) return region;
  return null;
}
function pickMedia(list, type, region) {
  const media = list.filter((entry) => entry?.type === type && typeof entry.url === 'string');
  for (const preferred of [region, 'wor', 'us', 'eu']) {
    const selected = media.find((entry) => entry.region?.toLowerCase() === preferred);
    if (selected) return selected;
  }
  return media[0];
}

export function createArtworkFetcher({ request = openStream, image = sharp } = {}) {
  async function download(url, signal, maxBytes) {
    const { response } = await request(url, {
      signal,
      timeoutMs: 15000,
      headers: { 'user-agent': 'ChaOS-gameboy/0.1', 'accept-encoding': 'identity' },
    });
    try {
      if (response.statusCode !== 200) return null;
      return await readLimitedBody(response, maxBytes);
    } finally {
      response.destroy();
    }
  }
  return async function fetchArtwork({ crc, filename, signal }, mediaDir) {
    if (!/^[a-f0-9]{8}$/i.test(crc)) throw new Error('invalid_rom_crc');
    signal?.throwIfAborted();
    const payload = await download(`${API}?crc=${crc.toUpperCase()}`, signal, 1024 * 1024);
    if (!payload) return { status: 'empty' };
    const game = JSON.parse(payload.toString('utf8'))?.data?.game;
    if (!game || !Array.isArray(game.media)) return { status: 'empty' };
    const region = regionHint(filename),
      result = { status: 'ok', source: 'retrobase', fetchedAt: Date.now() };
    const directory = join(mediaDir, crc);
    for (const [face, type] of [
      ['front', 'box-2D'],
      ['spine', 'box-2D-side'],
      ['back', 'box-2D-back'],
    ]) {
      const media = pickMedia(game.media, type, region);
      if (!media) continue;
      const input = await download(media.url, signal, 8 * 1024 * 1024);
      if (!input) continue;
      // Never persist third-party markup or undecoded bytes under an image URL.
      const { data, info } = await image(input, { limitInputPixels: 16000000, animated: false })
        .resize({ width: 1400, height: 1400, fit: 'inside', withoutEnlargement: true })
        .webp()
        .toBuffer({ resolveWithObject: true });
      signal?.throwIfAborted();
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, `${face}.webp`), data);
      result[face] = `/gameboy-media/${crc}/${face}.webp`;
      if (face === 'front') result.aspect = info.width / info.height;
    }
    if (!result.front) return { status: 'empty' };
    result.meta = Object.fromEntries(
      ['title', 'year', 'publisher', 'developer', 'genre', 'players', 'synopsis'].map((key) => [
        key,
        String(game[key === 'title' ? 'name' : key] || '').slice(
          0,
          key === 'synopsis' ? 4000 : 200,
        ),
      ]),
    );
    return result;
  };
}
export const fetchArt = createArtworkFetcher();
