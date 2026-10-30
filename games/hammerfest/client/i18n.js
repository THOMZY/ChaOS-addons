// @ts-check
// Strings of the Hammerfest pages. The game window follows the account language
// on its own (the loader gets `locale`); this module covers what the site
// renders around it — launch page, ranking, fridge/items/quests, result — plus
// the English names of the build's modes and options.

/** @typedef {'fr' | 'en'} Language */

/** @type {Record<string, string>} */
const FR = {
  // Shared chrome.
  pageTitle: 'Les Cavernes de Hammerfest — ChaOS website',
  gameTitle: 'Les Cavernes de Hammerfest',
  tabPlay: 'Jeu',
  tabRanking: 'Classement',
  tabFridge: 'Frigo',
  tabItems: 'Mes objets',
  tabQuests: 'Mes quêtes',
  loading: 'Chargement…',
  backToSite: 'Retour au site',
  footer:
    'Hammerfest © Motion Twin — corrections et contenu : Eternalfest — lecteur : Ruffle. Version non officielle hébergée sur ChaOS website.',
  loginRequired: 'Connecte-toi sur ChaOS website pour jouer.',
  loginProfile: 'Connecte-toi sur ChaOS website pour voir ton frigo.',
  loginResult: 'Connecte-toi sur ChaOS website pour voir cette partie.',

  // Launch page.
  description:
    'Le jeu officiel Hammerfest, par Motion-Twin. Contient également des niveaux inédits et de nouvelles options loufoques !',
  owner: 'Propriétaire :',
  build: 'Build :',
  player: 'Lecteur :',
  gameMode: 'Mode de jeu',
  settings: 'Paramètres',
  setDetail: 'Détails graphiques élevés',
  setShake: 'Vibrations fréquentes',
  setSound: 'Son',
  setMusic: 'Musique',
  optionsSuffix: '— Options',
  play: 'Jouer',
  noOptions: 'Aucune option disponible',
  gameOver: 'Partie terminée. Choisis un mode pour rejouer.',
  quit: 'Quitter',
  noRuffle: 'Lecteur Flash indisponible (Ruffle).',
  loadFailed: 'Le jeu n’a pas pu démarrer.',
  preparing: 'Préparation de la partie…',
  createFailed: 'Impossible de créer la partie.',
  bootFailed: 'Erreur de chargement.',
  debugMode: 'Mode debug',

  // Ranking.
  pageTitleRanking: 'Classement — Les Cavernes de Hammerfest',
  lbRank: 'Rang',
  lbPlayer: 'Joueur',
  lbScore: 'Score',
  lbLevel: 'Niveau',
  lbDate: 'Date',
  lbEmpty: 'Aucune partie terminée pour le moment. Sois le premier !',
  lbError: 'Impossible de charger le classement.',

  // Fridge / items / quests.
  pageTitleFridge: 'Frigo — Les Cavernes de Hammerfest',
  pageTitleItems: 'Mes objets — Les Cavernes de Hammerfest',
  pageTitleQuests: 'Mes quêtes — Les Cavernes de Hammerfest',
  pfFridgeTitle: 'Fiche Hammerfest de {pseudo}',
  pfPlayerName: 'Nom du joueur',
  pfBestScore: 'Meilleur score',
  pfBestLevel: 'Meilleur niveau',
  pfQuests: 'Quêtes',
  pfItemsOn: '{unlocked} objets sur {total}',
  pfDiscovered: "Nombre d'objets découverts",
  pfUnlocked: "Nombre d'objets débloqués",
  pfFamilies: 'Nombre de familles complétées',
  pfFamily: 'Famille ',
  pfComplete: '(complete !)',
  pfNoQuests: 'Aucune quête.',
  pfError: 'Impossible de charger le profil.',
  stStarted: 'Pas commencée',
  stPartial: 'En cours',
  stCompleted: 'Terminée',

  // Result.
  pageTitleResult: 'Résultat — Les Cavernes de Hammerfest',
  resultTitle: 'Résultat',
  rsPoints: 'Points',
  rsLevel: 'Niveau atteint',
  rsMode: 'Mode',
  rsEnded: 'Terminée',
  rsVictory: 'victoire !',
  rsItems: 'Objets ramassés',
  rsQuests: 'Quêtes',
  rsReplay: 'Rejouer',
  rsNoItems: 'Aucun objet ramassé pendant cette partie.',
  rsNoQuests: 'Aucune quête n’a progressé pendant cette partie.',
  rsThreshold: 'seuil {n} atteint',
  rsUnlocked: 'Débloqué',
  rsNew: 'Nouveau',
  rsItemsCount: '{total} objet(s) · {fresh} nouveau(x) · {unlocked} débloqué(s)',
  rsQuestsCount: '{total} quête(s)',
  rsQuestsCountDone: ' · {done} terminée(s)',
  rsQuestDone: 'Quête terminée',
  rsNotFound: 'Partie introuvable.',
  rsError: 'Impossible de charger le résultat.',
};

/** @type {Record<string, string>} */
const EN = {
  // Shared chrome.
  pageTitle: 'Hammerfest — ChaOS website',
  gameTitle: 'Hammerfest',
  tabPlay: 'Play',
  tabRanking: 'Ranking',
  tabFridge: 'Fridge',
  tabItems: 'My items',
  tabQuests: 'My quests',
  loading: 'Loading…',
  backToSite: 'Back to the site',
  footer:
    'Hammerfest © Motion Twin — fixes and content: Eternalfest — player: Ruffle. Unofficial version hosted on ChaOS website.',
  loginRequired: 'Log in on ChaOS website to play.',
  loginProfile: 'Log in on ChaOS website to see your fridge.',
  loginResult: 'Log in on ChaOS website to see this game.',

  // Launch page.
  description:
    'The official Hammerfest game, by Motion-Twin. Also includes brand-new levels and wacky new options!',
  owner: 'Owner:',
  build: 'Build:',
  player: 'Player:',
  gameMode: 'Game mode',
  settings: 'Settings',
  setDetail: 'High graphics detail',
  setShake: 'Frequent screen shake',
  setSound: 'Sound',
  setMusic: 'Music',
  optionsSuffix: '— Options',
  play: 'Play',
  noOptions: 'No option available',
  gameOver: 'Game over. Pick a mode to play again.',
  quit: 'Quit',
  noRuffle: 'Flash player unavailable (Ruffle).',
  loadFailed: 'The game could not start.',
  preparing: 'Preparing the game…',
  createFailed: 'Could not create the game.',
  bootFailed: 'Loading error.',
  debugMode: 'Debug mode',

  // Ranking.
  pageTitleRanking: 'Ranking — Hammerfest',
  lbRank: 'Rank',
  lbPlayer: 'Player',
  lbScore: 'Score',
  lbLevel: 'Level',
  lbDate: 'Date',
  lbEmpty: 'No finished game yet. Be the first!',
  lbError: 'Could not load the ranking.',

  // Fridge / items / quests.
  pageTitleFridge: 'Fridge — Hammerfest',
  pageTitleItems: 'My items — Hammerfest',
  pageTitleQuests: 'My quests — Hammerfest',
  pfFridgeTitle: 'Hammerfest profile of {pseudo}',
  pfPlayerName: 'Player name',
  pfBestScore: 'Best score',
  pfBestLevel: 'Best level',
  pfQuests: 'Quests',
  pfItemsOn: '{unlocked} of {total} items',
  pfDiscovered: 'Items discovered',
  pfUnlocked: 'Items unlocked',
  pfFamilies: 'Families completed',
  pfFamily: 'Family ',
  pfComplete: '(complete!)',
  pfNoQuests: 'No quest.',
  pfError: 'Could not load the profile.',
  stStarted: 'Not started',
  stPartial: 'In progress',
  stCompleted: 'Completed',

  // Result.
  pageTitleResult: 'Result — Hammerfest',
  resultTitle: 'Result',
  rsPoints: 'Points',
  rsLevel: 'Level reached',
  rsMode: 'Mode',
  rsEnded: 'Finished',
  rsVictory: 'victory!',
  rsItems: 'Items collected',
  rsQuests: 'Quests',
  rsReplay: 'Play again',
  rsNoItems: 'No item collected during this game.',
  rsNoQuests: 'No quest progressed during this game.',
  rsThreshold: 'threshold {n} reached',
  rsUnlocked: 'Unlocked',
  rsNew: 'New',
  rsItemsCount: '{total} item(s) · {fresh} new · {unlocked} unlocked',
  rsQuestsCount: '{total} quest(s)',
  rsQuestsCountDone: ' · {done} completed',
  rsQuestDone: 'Quest completed',
  rsNotFound: 'Game not found.',
  rsError: 'Could not load the result.',
};

/** @type {Record<Language, Record<string, string>>} */
export const MESSAGES = { fr: FR, en: EN };

/** English names only: French comes from the build, which already speaks it. */
const MODE_NAMES_EN = {
  solo: 'Adventure',
  multicoop: 'Co-op',
  deluxe: 'Deluxe Edition',
  deluxemulti: 'Deluxe Edition - Multi',
  bossrush: 'Boss Rush',
  tutorial: 'Tutorial',
  timeattack: 'Time Attack',
  multitime: 'Time Attack - Multi',
  soccer: 'Soccerfest',
};

const OPTION_NAMES_EN = {
  mirror: 'Mirror',
  mirrormulti: 'Mirror',
  nightmare: 'Nightmare',
  nightmaremulti: 'Nightmare',
  ninja: 'Ninjutsu',
  bombexpert: 'Unstable Explosives',
  boost: 'Tornado',
  insight: 'Insight',
  lifesharing: 'Life Sharing',
  firstrun: 'First Run',
  randomfest: 'Randomfest',
  shadowclones: 'Shadow Clones',
  noeffect: 'No Help Items',
  ice: 'Ice Age',
  hfest_ii: 'Hammerfest II',
  instant_bad: 'Fast & Furious',
  framboisefest: 'Framboisefest',
  autorun: 'Speed',
  lastigor: 'The Last Igor',
  bombcontrol: 'Bombotopia',
  kickcontrol: 'Advanced Ball Control',
  soccerbomb: 'Bombs',
  soccerparty: 'Two vs Two',
  set_soctime_short: 'Short match',
  set_soctime_normal: 'Normal match',
  set_soctime_long: 'Long match',
  prolongation: 'Overtime',
  set_soc_alea: 'Random field',
  set_ta_0: 'Green Hill',
  set_ta_1: 'Orange Temple',
  set_mta_0: 'Green Hill',
  set_mta_1: 'Orange Temple',
  set_soc_0: 'Cursed Lawn',
  set_soc_1: 'Ball Temple',
  set_soc_2: 'Volleyfest',
  set_soc_3: 'Aerial Mastery',
  set_soc_4: 'Unused Prototype 1',
  set_soc_5: 'Unused Prototype 2',
  set_soc_6: 'Unused Prototype 3',
  set_soc_7: 'Unused Prototype 4',
  set_soc_8: 'Timeline Track',
  set_soc_9: 'Basalt Stadium',
  set_soc_10: 'Ice Cup',
  set_soc_11: 'Black Card',
  set_soc_12: 'Forgotten Field',
  set_soc_13: 'Orange Keeper',
  set_soc_14: 'Spitting Cauldron',
  set_soc_15: 'Spike Room',
  set_soc_16: 'Kiwi Arena',
  set_soc_17: 'Unbroken Cages',
  set_soc_18: 'Fulguro Dojo',
  set_soc_19: 'Macabre Tree',
  set_soc_20: 'Zen Garden',
  set_soc_21: 'Bloody Field',
  set_soc_22: 'Sporio',
  set_soc_23: 'Sky Temple',
};

/**
 * Language the page speaks, derived from the locale the game plays in.
 * @param {string | null | undefined} locale
 * @returns {Language}
 */
export function languageOf(locale) {
  return String(locale ?? '').toLowerCase().startsWith('en') ? 'en' : 'fr';
}

/**
 * @param {string} key
 * @param {Language} language
 * @param {Record<string, string | number>} [values] `{name}` placeholders.
 */
export function translate(key, language, values) {
  const template = MESSAGES[language][key] ?? MESSAGES.fr[key] ?? key;
  if (!values) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name) => (name in values ? String(values[name]) : whole));
}

/**
 * Name shown for a mode: the build's own name, translated when English is on.
 * @param {{ id: string, display_name: string }} mode
 * @param {Language} language
 */
export function modeName(mode, language) {
  return (language === 'en' ? MODE_NAMES_EN[mode.id] : undefined) ?? mode.display_name;
}

/**
 * @param {{ key: string, display_name: string }} option
 * @param {Language} language
 */
export function optionName(option, language) {
  return (language === 'en' ? OPTION_NAMES_EN[option.key] : undefined) ?? option.display_name;
}

/**
 * Language of the signed-in account, from the config endpoint the pages already
 * rely on. Falls back to French so a network hiccup never blanks a page.
 * @returns {Promise<Language>}
 */
export async function loadLanguage() {
  try {
    const response = await fetch('/api/v1/hammerfest/config', { credentials: 'same-origin' });
    if (!response.ok) return 'fr';
    const { locale } = await response.json();
    return languageOf(locale);
  } catch {
    return 'fr';
  }
}

/**
 * Number and date formatters matching the page language.
 * @param {Language} language
 */
export function formatters(language) {
  const tag = language === 'en' ? 'en-GB' : 'fr-FR';
  return {
    nf: new Intl.NumberFormat(tag),
    df: new Intl.DateTimeFormat(tag, { dateStyle: 'short' }),
    dfLong: new Intl.DateTimeFormat(tag, { dateStyle: 'long', timeStyle: 'short' }),
  };
}

/**
 * Fill every `data-i18n` element of the document, then the title (from
 * `data-title` on `<html>`, else the generic one) and the `lang` attribute.
 * @param {Language} language
 * @param {Document} [doc]
 */
export function applyPageLanguage(language, doc = document) {
  for (const node of doc.querySelectorAll('[data-i18n]')) {
    const key = /** @type {HTMLElement} */ (node).dataset.i18n;
    if (key) node.textContent = translate(key, language);
  }
  doc.documentElement.lang = language;
  doc.title = translate(doc.documentElement.dataset.title || 'pageTitle', language);
}
