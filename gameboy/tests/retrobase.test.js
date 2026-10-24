import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createArtworkFetcher, regionHint } from '../server/retrobase.mjs';

test('artwork is decoded, bounded and stored as a local WebP instead of upstream bytes', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'chaos-gameboy-art-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const png = await sharp({ create: { width: 4, height: 6, channels: 3, background: '#badbad' } })
    .png()
    .toBuffer();
  const request = async (url) => {
    const body = url.includes('/lookup?')
      ? Buffer.from(
          JSON.stringify({
            data: {
              game: {
                name: 'Fixture',
                media: [{ type: 'box-2D', url: 'https://images.example/cover' }],
              },
            },
          }),
        )
      : png;
    const response = Readable.from([body]);
    response.statusCode = 200;
    response.headers = {};
    return { response };
  };
  const fetchArtwork = createArtworkFetcher({ request });
  const result = await fetchArtwork({ crc: '1234abcd', filename: 'game (France).gb' }, directory);
  assert.equal(result.front, '/gameboy-media/1234abcd/front.webp');
  assert.equal(
    (await sharp(await readFile(join(directory, '1234abcd/front.webp'))).metadata()).format,
    'webp',
  );
  assert.equal(result.aspect, 4 / 6);
  assert.equal(regionHint('game (Rev 1) (France).gb'), 'fr');
});

test('artwork cancellation and an oversized lookup cannot create files', async () => {
  const controller = new AbortController();
  controller.abort();
  const fetchArtwork = createArtworkFetcher({
    request: async () => {
      throw new Error('must not fetch');
    },
  });
  await assert.rejects(fetchArtwork({ crc: '1234abcd', signal: controller.signal }, 'unused'), {
    name: 'AbortError',
  });
  const huge = createArtworkFetcher({
    request: async () => {
      const response = Readable.from([Buffer.alloc(1024 * 1024 + 1)]);
      response.statusCode = 200;
      response.headers = {};
      return { response };
    },
  });
  await assert.rejects(huge({ crc: '1234abcd' }, 'unused'), /response_too_large/);
});
