// @ts-check
// Names shown on the Hammerfest pages, in the player's language.
//  - items come from the build's own locale patch (`<items>` section);
//  - families and quests have no translation in the build, so `catalog/labels.en.json`
//    carries the English wording;
//  - anything missing falls back to the catalogue, which speaks French.
import { readFileSync } from 'node:fs';

const ENTITIES = /** @type {Record<string, string>} */ ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" });

/** @param {string} value */
function decodeXml(value) {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (whole, entity) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) return String.fromCodePoint(parseInt(entity.slice(2), 16));
    if (entity.startsWith('#')) return String.fromCodePoint(parseInt(entity.slice(1), 10));
    return ENTITIES[entity] ?? whole;
  });
}

/**
 * @typedef {object} Labels
 * @property {Map<string, string>} items
 * @property {Map<string, string>} families
 * @property {Map<string, { name: string, text?: string }>} quests
 * @property {string | null} otherFamily Name of the block holding items outside a known family.
 */

/** @type {Labels} */
const NONE = { items: new Map(), families: new Map(), quests: new Map(), otherFamily: null };

/** @type {Labels | null} */
let english = null;

function englishLabels() {
  if (english) return english;
  try {
    const raw = JSON.parse(readFileSync(new URL('../catalog/labels.en.json', import.meta.url), 'utf8'));
    english = {
      items: new Map(),
      families: new Map(Object.entries(raw.families ?? {})),
      quests: new Map(Object.entries(raw.quests ?? {})),
      otherFamily: raw.otherFamily ?? null,
    };
  } catch {
    // Translation file missing: the catalogue names stay in place.
    english = NONE;
  }
  return english;
}

/** @type {Map<string, Labels>} */
const CACHE = new Map();

/**
 * Labels for this locale. French needs nothing: the catalogue already speaks it.
 * @param {string} locale
 * @returns {Labels}
 */
export function labelsFor(locale) {
  if (!locale || locale === 'fr-FR') return NONE;
  const cached = CACHE.get(locale);
  if (cached) return cached;

  /** @type {Labels} */
  const labels = { items: new Map(), families: new Map(), quests: new Map(), otherFamily: null };
  if (locale.startsWith('en')) {
    const source = englishLabels();
    labels.families = source.families;
    labels.quests = source.quests;
    labels.otherFamily = source.otherFamily;
  }
  try {
    const xml = readFileSync(new URL(`../game/locales.${locale}.xml`, import.meta.url), 'utf8');
    for (const match of xml.matchAll(/<item id="(\d+)" name="([^"]*)"/g)) {
      labels.items.set(match[1], decodeXml(match[2]));
    }
  } catch {
    // Locale not shipped with the build: keep the catalogue item names.
  }
  CACHE.set(locale, labels);
  return labels;
}
