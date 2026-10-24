/**
 * Bibliothèque de ROM : scan du dossier, ajout, identification.
 *
 * L'identité d'une ROM se lit dans son en-tête, pas dans son nom de fichier :
 * un utilisateur qui uploade "mario (1).gb" doit quand même être reconnu.
 */
import { readFile, writeFile, readdir, lstat, mkdir, rename } from 'node:fs/promises';
import { existsSync, readFileSync, lstatSync } from 'node:fs';
import { join, extname, basename } from 'node:path';

const ROM_EXT = new Set(['.gb', '.gbc', '.gba']);
const MAX_BYTES = 32 * 1024 * 1024; // garde-fou upload (GBA max = 32 Mo)

/* ------------------------------------------------------------------ */
/* CRC32                                                               */
/* ------------------------------------------------------------------ */
const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ((c ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}

/* ------------------------------------------------------------------ */
/* En-tête Game Boy                                                    */
/* ------------------------------------------------------------------ */
/** Titre, modèle et système à partir des octets de la cartouche. */
export function readHeader(buf, filename = '') {
  const ext = extname(filename).toLowerCase();
  const out = { title: '', model: 'DMG', system: 'Game Boy', color: false };

  if (ext === '.gba' || (buf.length > 0xc0 && buf[0xb2] === 0x96)) {
    // GBA : titre en 0xA0..0xAB, code jeu en 0xAC..0xAF
    let t = buf.toString('latin1', 0xa0, 0xac).replace(/\0.*$/, '').trim();
    out.title = t || basename(filename, extname(filename));
    out.model = 'AGB';
    out.system = 'Game Boy Advance';
    out.color = true;
    return out;
  }

  // 15 octets seulement : le 16e (0x143) est le drapeau CGB sur une cartouche couleur
  let title = buf
    .toString('latin1', 0x134, 0x143)
    // eslint-disable-next-line no-control-regex -- Non-text header bytes terminate the cartridge title.
    .replace(/[\x00-\x1f\x7f-\xff].*$/, '')
    .trim();
  const cgb = buf.length > 0x143 ? buf[0x143] : 0;
  const color = cgb === 0x80 || cgb === 0xc0;
  out.title = title || basename(filename, extname(filename));
  out.model = color ? 'CGB' : 'DMG';
  out.system = color ? 'Game Boy Color' : 'Game Boy';
  out.color = color;
  out.cartType = buf.length > 0x147 ? buf[0x147] : null;
  return out;
}

/** Un fichier ressemble-t-il à une ROM Game Boy ? */
export function looksLikeRom(buf, filename = '') {
  if (buf.length < 0x150 || buf.length > MAX_BYTES) return false;
  const ext = extname(filename).toLowerCase();
  if (!ROM_EXT.has(ext)) return false;
  // le logo Nintendo commence à 0x104 ; on se contente d'un contrôle souple
  const nintendo = buf[0x104] === 0xce && buf[0x105] === 0xed;
  return ext === '.gba' ? buf[0xb2] === 0x96 : nintendo;
}

/* ------------------------------------------------------------------ */
/* Bibliothèque                                                        */
/* ------------------------------------------------------------------ */
export class RomLibrary {
  constructor(root, indexFile = undefined) {
    this.root = root;
    this.indexFile = indexFile || join(root, 'roms.index.json');
    this.index = new Map(); // filename -> { crc, title, model, system, size, addedAt }
    this.mediaDir = join(root, 'media');
  }

  async init() {
    if (!existsSync(this.mediaDir)) await mkdir(this.mediaDir, { recursive: true });
    try {
      const raw = JSON.parse(await readFile(this.indexFile, 'utf8'));
      for (const [k, v] of Object.entries(raw)) this.index.set(k, v);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await this.scan();
  }

  /** Parcourt le dossier et complète l'index (sans relire les fichiers déjà connus). */
  async scan() {
    const files = await readdir(this.root);
    for (const f of files) {
      const ext = extname(f).toLowerCase();
      if (!ROM_EXT.has(ext)) continue;
      const full = join(this.root, f);
      const s = await lstat(full);
      if (!s.isFile() || s.size > MAX_BYTES) {
        this.index.delete(f);
        continue;
      }
      const known = this.index.get(f);

      // l'en-tête est relu à chaque scan (350 octets) : corriger le parseur ne doit pas
      // laisser un vieux titre en cache
      const buf = await readFile(full);
      if (!looksLikeRom(buf, f)) {
        this.index.delete(f);
        continue;
      }
      const parsed = readHeader(buf, f);
      this.index.set(f, {
        crc: crc32(buf),
        ...parsed,
        size: s.size,
        addedAt: known?.addedAt || Date.now(),
      });
    }
    // purge des entrées dont le fichier a disparu
    for (const f of [...this.index.keys()]) {
      if (!files.includes(f)) this.index.delete(f);
    }
    await this.save();
    return this.list();
  }

  async save() {
    const pending = this.indexFile + '.pending';
    await writeFile(pending, JSON.stringify(Object.fromEntries(this.index), null, 2));
    await rename(pending, this.indexFile);
  }

  list() {
    return [...this.index.entries()]
      .map(([file, v]) => ({ file, ...v, media: this.cachedMedia(v.crc) }))
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  /** Un sous-dossier par jeu : media/<crc>/ (visuels + meta.json). */
  mediaFolder(crc) {
    if (!/^[a-f0-9]{8}$/i.test(String(crc))) throw new Error('invalid_rom_crc');
    return join(this.mediaDir, String(crc));
  }

  cachedMedia(crc) {
    const p = join(this.mediaFolder(crc), 'meta.json');
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, 'utf8'));
    } catch {
      return null;
    }
  }

  async writeMedia(crc, data) {
    const dir = this.mediaFolder(crc);
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'meta.json'), JSON.stringify(data, null, 2));
  }

  /** Ajoute une ROM uploadée. Renvoie l'entrée créée. */
  async add(filename, buf) {
    const safe = basename(filename)
      .replace(/[^\w.\-() ]+/g, '_')
      .slice(-120);
    if (!looksLikeRom(buf, safe)) {
      throw Object.assign(new Error('invalid_rom'), { status: 400 });
    }
    const full = join(this.root, safe);
    try {
      await writeFile(full, buf, { flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = this.index.get(safe);
      if (existing?.crc === crc32(buf)) return { file: safe, ...existing };
      throw Object.assign(new Error('rom_already_exists'), { status: 409 });
    }
    const head = readHeader(buf, safe);
    const entry = { crc: crc32(buf), ...head, size: buf.length, addedAt: Date.now() };
    this.index.set(safe, entry);
    await this.save();
    return { file: safe, ...entry };
  }

  path(file) {
    if (typeof file !== 'string' || /[\\/]/.test(file) || !this.index.has(file)) return null;
    const p = join(this.root, file);
    try {
      return lstatSync(p).isFile() ? p : null;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }
}
