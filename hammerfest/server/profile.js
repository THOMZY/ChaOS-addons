// @ts-check
// Everything the Hammerfest pages show, derived from the account's rows and the
// catalogue: the fridge (all 357 items with their count), the item table by
// family, the quests, the stats. Nothing is stored twice.
//
// The unlock rule is the game's: an item is unlocked when `count >= unlock`
// (10 copies for most items, 1 for unique/quest items, a few exceptions). Below
// the threshold it stays "discovered but locked", and an item never obtained is
// simply unknown ("?").
import { readFileSync } from 'node:fs';
import { FAMILIES } from './build.js';

/** @type {{ families: Record<string, { name: string }>, items: Record<string, { name: string, family: string | null, rarity: number, value: unknown, unlock?: number }>, quests: Record<string, { name: string, text: string, require: Record<string, number>, give: { type: string, id: string }[], remove: { type: string, id: string }[] }> }} */
const CATALOG = JSON.parse(readFileSync(new URL('../catalog/catalog.json', import.meta.url), 'utf8'));

const TOTAL_ITEMS = Object.keys(CATALOG.items).length;
const TOTAL_FAMILIES = Object.keys(CATALOG.families).length;

/** @param {string} id */
const familyName = (id) => CATALOG.families[id]?.name ?? `Famille ${id}`;
/** @param {string} id */
const unlockOf = (id) => CATALOG.items[id]?.unlock ?? 10;
/** @param {string} id */
const itemName = (id) => CATALOG.items[id]?.name ?? `Objet ${id}`;

/**
 * One row per item of the game, plus the per-family counters.
 *
 * @param {Record<string, number>} owned
 */
function itemView(owned) {
  /** @type {Map<string, any[]>} */
  const byFamily = new Map();
  let discoveredCount = 0;
  let unlockedCount = 0;

  for (const [id, spec] of Object.entries(CATALOG.items)) {
    const count = owned[id] ?? 0;
    const unlock = spec.unlock ?? 10;
    const discovered = count > 0;
    const unlocked = count >= unlock;
    if (discovered) discoveredCount += 1;
    if (unlocked) unlockedCount += 1;
    const key = spec.family ?? 'other';
    if (!byFamily.has(key)) byFamily.set(key, []);
    byFamily.get(key)?.push({
      id,
      name: spec.name,
      count,
      unlock,
      discovered,
      unlocked,
      rarity: spec.rarity,
      value: spec.value,
      // Sur notre site le nom est toujours affiché : la page ne liste que les
      // objets découverts, cacher leur nom n'apporte rien.
      displayName: spec.name,
      state: unlocked ? 'unlocked' : discovered ? 'locked' : 'unknown',
    });
  }

  const families = [];
  for (const key of Object.keys(CATALOG.families)) {
    const items = byFamily.get(key);
    if (!items) continue;
    items.sort((a, b) => Number(a.id) - Number(b.id));
    families.push({
      id: key,
      name: familyName(key),
      items,
      discovered: items.filter((item) => item.discovered).length,
      unlocked: items.filter((item) => item.unlocked).length,
      total: items.length,
    });
  }
  // Items outside a known family (custom families) keep their own block.
  const orphans = byFamily.get('other');
  if (orphans && orphans.length > 0) {
    families.push({ id: 'other', name: 'Divers', items: orphans, discovered: orphans.filter((i) => i.discovered).length, unlocked: orphans.filter((i) => i.unlocked).length, total: orphans.length });
  }

  return {
    families,
    stats: {
      discoveredCount,
      unlockedCount,
      completedFamilies: families.filter((family) => family.unlocked === family.total).length,
      totalItems: TOTAL_ITEMS,
      totalFamilies: TOTAL_FAMILIES,
    },
  };
}

/** @param {Record<string, number>} owned */
function fridgeOf(owned) {
  return Object.entries(CATALOG.items)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([id, spec]) => {
      const count = owned[id] ?? 0;
      const unlock = spec.unlock ?? 10;
      return {
        id,
        name: spec.name,
        count,
        state: count >= unlock ? 'unlocked' : count > 0 ? 'locked' : 'unknown',
      };
    });
}

/**
 * Quests with their per-item progress, as the game's quest page shows them.
 *
 * @param {Record<string, number>} owned
 */
function questView(owned) {
  /** @type {any[]} */
  const out = [];
  for (const [id, spec] of Object.entries(CATALOG.quests)) {
    const require = Object.entries(spec.require ?? {}).map(([itemId, quantity]) => {
      const count = owned[itemId] ?? 0;
      const unlocked = count >= unlockOf(itemId);
      return {
        id: itemId,
        name: itemName(itemId),
        // Nom réel systématiquement sur notre site (plus de « ??? » dans les quêtes).
        displayName: itemName(itemId),
        qty: quantity,
        // The game never shows more than the requirement.
        count: Math.min(count, quantity),
        owned: count > 0,
        unlocked,
      };
    });
    if (require.length === 0) continue;
    const have = require.reduce((sum, entry) => sum + entry.count, 0);
    const need = require.reduce((sum, entry) => sum + entry.qty, 0);
    // Le site d'origine ne liste que les quêtes commencées ou terminées.
    if (have === 0) continue;
    const state = have >= need ? 'completed' : 'partial';
    out.push({
      id,
      name: spec.name,
      text: spec.text,
      require,
      have,
      need,
      state,
      completed: state === 'completed',
      progress: require.filter((entry) => entry.count >= entry.qty).length,
      total: require.length,
      rewards: (spec.give ?? []).filter((entry) => entry.type === 'family').map((entry) => familyName(entry.id)),
    });
  }
  // Comme le site d'origine : quêtes en cours d'abord, terminées ensuite, puis par id.
  out.sort((a, b) => Number(a.completed) - Number(b.completed) || Number(a.id) - Number(b.id));
  return out;
}

/**
 * Familles débloquées pour ce compte, dans le format que le jeu attend
 * (`$families`). C'est la base du build, plus les familles offertes par les
 * quêtes terminées, moins celles qu'elles retirent. Sans ça le jeu considère
 * tout comme verrouillé et masque les descriptions de quêtes (« ??? »).
 *
 * @param {Record<string, number>} owned
 */
export function unlockedFamilies(owned) {
  const unlocked = new Set(String(FAMILIES).split(',').filter(Boolean));
  for (const spec of Object.values(CATALOG.quests)) {
    const required = Object.entries(spec.require ?? {});
    if (required.length === 0) continue;
    const completed = required.every(([itemId, quantity]) => (owned[itemId] ?? 0) >= quantity);
    if (!completed) continue;
    for (const entry of spec.give ?? []) if (entry.type === 'family') unlocked.add(entry.id);
    for (const entry of spec.remove ?? []) if (entry.type === 'family') unlocked.delete(entry.id);
  }
  return [...unlocked].sort((a, b) => Number(a) - Number(b)).join(',');
}

/**
 * Ce qu'une partie a changé, calculé **avant** la fusion dans l'inventaire :
 * les objets ramassés (nouveaux ou franchissant leur seuil) et les quêtes dont
 * la progression bouge.
 *
 * @param {Record<string, number>} ownedBefore
 * @param {Record<string, number>} gained
 */
export function computeHighlights(ownedBefore, gained) {
  /** @type {Record<string, number>} */
  const ownedAfter = { ...ownedBefore };
  /** @type {any[]} */
  const items = [];

  for (const [id, quantity] of Object.entries(gained ?? {})) {
    const count = Math.trunc(Number(quantity));
    if (!Number.isFinite(count) || count <= 0) continue;
    const before = ownedBefore[id] ?? 0;
    // Les compteurs s'additionnent d'une partie à l'autre.
    const after = before + count;
    const unlock = unlockOf(id);
    items.push({
      id,
      name: itemName(id),
      gained: count,
      before,
      after,
      unlock,
      isNew: before === 0,
      unlockedNow: before < unlock && after >= unlock,
    });
    ownedAfter[id] = after;
  }
  items.sort((a, b) => Number(b.unlockedNow) - Number(a.unlockedNow) || Number(b.isNew) - Number(a.isNew) || b.gained - a.gained);

  /** @type {any[]} */
  const quests = [];
  for (const [id, spec] of Object.entries(CATALOG.quests)) {
    const required = Object.entries(spec.require ?? {});
    if (required.length === 0) continue;
    const need = required.reduce((sum, [, quantity]) => sum + quantity, 0);
    /** @param {Record<string, number>} owned */
    const progress = (owned) =>
      required.reduce((sum, [itemId, quantity]) => sum + Math.min(owned[itemId] ?? 0, quantity), 0);
    const before = progress(ownedBefore);
    const after = progress(ownedAfter);
    if (after === before) continue;
    quests.push({
      id,
      name: spec.name,
      before,
      after,
      need,
      completedNow: before < need && after >= need,
    });
  }
  quests.sort((a, b) => Number(b.completedNow) - Number(a.completedNow) || b.after / b.need - a.after / a.need);

  return { items, quests };
}

/**
 * Le contenu de la page de résultat d'une partie.
 *
 * @param {any} run
 * @param {(mode: string) => string} modeLabel
 */
export function describeRun(run, modeLabel) {
  const highlights = run.highlights ? JSON.parse(run.highlights) : { items: [], quests: [] };
  const scores = JSON.parse(run.scores ?? '[]');
  return {
    id: run.id,
    mode: run.game_mode,
    modeLabel: modeLabel(run.game_mode),
    endedAt: run.ended_at,
    isVictory: run.is_victory === 1,
    maxLevel: run.max_level ?? 0,
    scores,
    totalScore: scores.reduce((sum, score) => sum + (Number(score) || 0), 0),
    items: highlights.items ?? [],
    quests: highlights.quests ?? [],
  };
}

/**
 * @param {{ id: string, pseudo: string }} account
 * @param {Record<string, number>} owned
 * @param {any[]} runs
 * @param {(mode: string) => string} modeLabel
 */
export function buildProfile(account, owned, runs, modeLabel) {
  const { families, stats } = itemView(owned);
  const quests = questView(owned);

  let bestScore = 0;
  let maxLevel = 0;
  let victories = 0;
  const history = runs.map((run) => {
    const scores = JSON.parse(run.scores ?? '[]');
    const score = Math.max(0, ...scores.map(Number).filter(Number.isFinite));
    bestScore = Math.max(bestScore, score);
    maxLevel = Math.max(maxLevel, run.max_level ?? 0);
    if (run.is_victory === 1) victories += 1;
    return {
      id: run.id,
      mode: run.game_mode,
      modeLabel: modeLabel(run.game_mode),
      endedAt: run.ended_at,
      score,
      maxLevel: run.max_level ?? 0,
      isVictory: run.is_victory === 1,
    };
  });

  return {
    account: { id: account.id, pseudo: account.pseudo },
    stats: {
      ...stats,
      itemsOwned: stats.unlockedCount,
      itemsTotal: stats.totalItems,
      completedQuests: quests.filter((quest) => quest.completed).length,
      questsTotal: quests.length,
      bestScore,
      maxLevel,
      runs: history.length,
      victories,
    },
    families,
    fridge: fridgeOf(owned),
    quests,
    history,
  };
}
