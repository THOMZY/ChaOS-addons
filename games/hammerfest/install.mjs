// @ts-check
// Installs the game data (never versioned: ~6.6 MB of SWF and XML) into
// `games/hammerfest/data/`. Run from the site root, after `games-install.mjs`:
//
//   node games/hammerfest/install.mjs <dossier-source>
//
// The source folder holds the build output: game.swf, patchman.swf, content.xml,
// locales.*.xml and loader.swf (see the add-on README).
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { inflateSync, deflateSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The loader switches to its debug console when its own URL is on `localhost`
 * (`Main.IS_DEBUG = hostname == "localhost"`): the end of a run then shows a raw
 * dump instead of opening the result page. The literal is rewritten in place
 * (same length, inside the compressed body) so a local install behaves exactly
 * like production. The uncompressed length does not change, so the SWF header
 * stays valid.
 *
 * @param {string} path
 */
function patchLoaderHost(path) {
  const bytes = readFileSync(path);
  if (bytes.subarray(0, 3).toString('latin1') !== 'CWS') {
    console.warn(`  loader.swf: format inattendu (${path})`);
    return;
  }
  const body = inflateSync(bytes.subarray(8));
  const marker = Buffer.from('localhost', 'latin1');
  const at = body.indexOf(marker);
  if (at === -1) return;
  Buffer.from('l0calho5t', 'latin1').copy(body, at);
  writeFileSync(path, Buffer.concat([bytes.subarray(0, 8), deflateSync(body)]));
  console.info('  loader.swf: mode debug localhost neutralisé');
}

const DATA_DIR = fileURLToPath(new URL('./data/', import.meta.url));

/** Source name -> installed name. */
const FILES = Object.freeze({
  'game.swf': 'game.swf',
  'patchman.swf': 'patchman.swf',
  'content.xml': 'content.xml',
  'locales.fr-FR.xml': 'locales.fr-FR.xml',
  'locales.en-US.xml': 'locales.en-US.xml',
  'locales.es-SP.xml': 'locales.es-SP.xml',
  'loader.swf': 'loader.swf',
  'musics/music-01.mp3': 'musics/music-01.mp3',
  'musics/music-02.mp3': 'musics/music-02.mp3',
  'musics/music-03.mp3': 'musics/music-03.mp3',
  'musics/music-04.mp3': 'musics/music-04.mp3',
  'musics/music-05.mp3': 'musics/music-05.mp3',
  'musics/music-06.mp3': 'musics/music-06.mp3',
});

const source = process.argv[2];
if (!source) {
  console.error('usage: node games/hammerfest/install.mjs <dossier-source>');
  process.exit(2);
}
const sourceDir = resolve(source);
if (!existsSync(sourceDir)) {
  console.error(`hammerfest: source introuvable: ${sourceDir}`);
  process.exit(2);
}
mkdirSync(DATA_DIR, { recursive: true });

let copied = 0;
for (const [from, to] of Object.entries(FILES)) {
  const origin = resolve(sourceDir, from);
  if (!existsSync(origin)) {
    console.error(`hammerfest: fichier manquant dans la source: ${from}`);
    process.exit(1);
  }
  const target = resolve(DATA_DIR, to);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(origin, target);
  copied += 1;
  console.info(`  ${to}  ${statSync(target).size} o`);
}
// The Flash reader, served from our origin (no CDN, works offline).
const ruffle = resolve(sourceDir, 'ruffle');
if (existsSync(ruffle)) {
  cpSync(ruffle, resolve(DATA_DIR, 'ruffle'), { recursive: true });
  copied += 1;
  console.info('  ruffle/  (lecteur Flash)');
}

patchLoaderHost(resolve(DATA_DIR, 'loader.swf'));

console.info(`hammerfest: ${copied} fichiers installés dans ${DATA_DIR}`);
