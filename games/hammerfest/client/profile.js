// @ts-check
// Frigo / Mes objets / Mes quêtes, aux formats du site Eternalfest.
// Un objet est « débloqué » quand sa quantité atteint son seuil (`unlock`,
// 10 exemplaires pour la plupart, 1 pour les objets uniques) : en dessous il
// reste affiché mais grisé, et un objet jamais obtenu s'affiche « ? ».
import { applyPageLanguage, formatters, loadLanguage, modeName, translate } from './i18n.js';
const notice = /** @type {HTMLElement} */ (document.getElementById('notice'));
const sectionFrigo = /** @type {HTMLElement} */ (document.getElementById('section-frigo'));
const sectionObjets = /** @type {HTMLElement} */ (document.getElementById('section-objets'));
const sectionQuetes = /** @type {HTMLElement} */ (document.getElementById('section-quetes'));
const playerStats = /** @type {HTMLElement} */ (document.getElementById('player-stats'));
const itemsCount = /** @type {HTMLElement} */ (document.getElementById('items-count'));
const fridgeBox = /** @type {HTMLElement} */ (document.getElementById('fridge'));
const itemStats = /** @type {HTMLElement} */ (document.getElementById('item-stats'));
const familiesBox = /** @type {HTMLElement} */ (document.getElementById('families'));
const questsBox = /** @type {HTMLElement} */ (document.getElementById('quests'));

/** @type {any} */
let profile = null;
/** @type {import('./i18n.js').Language} */
let language = 'fr';
/** @type {Intl.NumberFormat} */
let nf = new Intl.NumberFormat('fr-FR');
/** @param {string} key @param {Record<string, string | number>} [values] */
const t = (key, values) => translate(key, language, values);
const STATUS_KEYS = /** @type {Record<string, string>} */ ({ started: 'stStarted', partial: 'stPartial', completed: 'stCompleted' });
/** @param {string} state */
const statusLabel = (state) => (STATUS_KEYS[state] ? t(STATUS_KEYS[state]) : state);

/** Message « connecte-toi » avec le lien de retour, sans innerHTML. */
function loginNotice(message) {
  notice.hidden = false;
  notice.replaceChildren(
    document.createTextNode(message + ' '),
    Object.assign(el('a', undefined, t('backToSite')), { href: '/' }),
  );
}

/** @param {string} tag @param {string} [className] @param {string} [text] */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** @param {string} label @param {string} value */
function statRow(label, value) {
  const row = el('div');
  row.append(el('dt', undefined, label), el('dd', undefined, value));
  return row;
}

/** @param {string} id @param {string} [className] */
function icon(id, className) {
  const img = /** @type {HTMLImageElement} */ (el('img', className));
  img.src = `items/${id}.png`;
  img.alt = '';
  img.loading = 'lazy';
  return img;
}

function renderFridge() {
  const { stats } = profile;
  playerStats.replaceChildren(
    statRow(t('pfPlayerName'), profile.account.pseudo),
    statRow(t('pfBestScore'), nf.format(stats.bestScore)),
    statRow(t('pfBestLevel'), String(stats.maxLevel)),
    statRow(t('pfQuests'), `${stats.completedQuests} / ${stats.questsTotal}`),
  );
  itemsCount.textContent = t('pfItemsOn', { unlocked: nf.format(stats.unlockedCount), total: nf.format(stats.totalItems) });

  fridgeBox.replaceChildren(
    ...profile.fridge.map((item) => {
      const cell = el('li');
      cell.title = item.state === 'unknown' ? '???' : item.name;
      if (item.state === 'unknown') {
        cell.append(el('span', 'unknown-item', '?'));
        return cell;
      }
      cell.append(icon(item.id, item.state === 'locked' ? 'not-unlocked' : undefined));
      const count = el('div', item.state === 'locked' ? 'item-count not-unlocked' : 'item-count');
      count.textContent = item.count > 0 ? nf.format(item.count) : '';
      cell.append(count);
      return cell;
    }),
  );
}

function renderItems() {
  const { stats } = profile;
  itemStats.replaceChildren(
    statRow(t('pfDiscovered'), `${stats.discoveredCount} / ${stats.totalItems}`),
    statRow(t('pfUnlocked'), `${stats.unlockedCount} / ${stats.totalItems}`),
    statRow(t('pfFamilies'), `${stats.completedFamilies} / ${stats.totalFamilies}`),
  );

  const blocks = [];
  for (const family of profile.families) {
    const discovered = family.items.filter((/** @type {any} */ item) => item.discovered);
    if (discovered.length === 0) continue;
    const block = el('div', 'item-family');
    const header = el('div', 'item-family-header');
    const name = el('span', 'item-family-name');
    name.append(document.createTextNode(t('pfFamily')), el('span', 'item-family-name-text', family.name));
    header.append(name);
    if (discovered.length === family.total) header.append(el('span', 'item-family-complete', t('pfComplete')));
    else header.append(el('span', 'item-family-progress', `(${discovered.length} / ${family.total})`));
    block.append(header);

    for (const item of discovered) {
      const row = el('div', item.unlocked ? 'item-row' : 'item-row locked');
      const cellIcon = el('div', 'icon');
      cellIcon.append(icon(item.id));
      cellIcon.title = item.name;
      row.append(cellIcon, el('span', 'count', `x${nf.format(item.count)}`), el('span', 'name', item.displayName));
      block.append(row);
    }
    blocks.push(block);
  }
  familiesBox.replaceChildren(...blocks);
}

function renderQuests() {
  const quests = profile.quests;
  if (quests.length === 0) {
    questsBox.replaceChildren(el('p', 'notice', t('pfNoQuests')));
    return;
  }
  questsBox.replaceChildren(
    ...quests.map((quest) => {
      const card = el('div', quest.completed ? 'quest completed' : 'quest');
      const table = el('table');

      const head = el('thead');
      const headRow = el('tr');
      const th = el('th');
      th.colSpan = 3; // l'en-tête occupe les trois colonnes (icône, quantité, nom)
      // Comme la page d'origine : statut flottant à droite, puis le nom.
      th.append(
        el('span', 'status', statusLabel(quest.state)),
        el('span', 'name', quest.name),
      );
      if (quest.completed && quest.text) th.append(el('p', 'description', quest.text));
      headRow.append(th);
      head.append(headRow);

      const body = el('tbody');
      for (const entry of quest.require) {
        const row = el('tr');
        const cellIcon = el('td', 'icon');
        cellIcon.append(icon(entry.id, entry.owned ? undefined : 'locked'));
        cellIcon.title = entry.name;
        row.append(cellIcon, el('td', 'count', `${entry.count} / ${entry.qty}`), el('td', 'name', entry.displayName));
        body.append(row);
      }
      table.append(head, body);
      card.append(table);
      return card;
    }),
  );
}

const PAGES = /** @type {const} */ ({ frigo: sectionFrigo, objets: sectionObjets, quetes: sectionQuetes });
const TAB_OF = /** @type {Record<string, string>} */ ({ frigo: 'tab-frigo', objets: 'tab-objets', quetes: 'tab-quetes' });

function route() {
  const wanted = location.hash.replace('#', '');
  const page = /** @type {keyof typeof PAGES} */ (wanted in PAGES ? wanted : 'frigo');
  for (const [key, section] of Object.entries(PAGES)) section.hidden = key !== page;
  for (const [key, id] of Object.entries(TAB_OF)) {
    const tab = document.getElementById(id);
    if (!tab) continue;
    // Le site d'origine met l'onglet courant en gras et laisse les autres « blurred ».
    tab.classList.toggle('blurred', key !== page);
    if (key === page) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  const title = document.getElementById('page-title');
  if (title) {
    title.textContent =
      page === 'frigo' && profile
        ? t('pfFridgeTitle', { pseudo: profile.account.pseudo })
        : translate('gameTitle', language);
  }
  const TITLE_KEYS = /** @type {Record<string, string>} */ ({ frigo: 'pageTitleFridge', objets: 'pageTitleItems', quetes: 'pageTitleQuests' });
  document.title = translate(TITLE_KEYS[page], language);
}

async function boot() {
  language = await loadLanguage();
  ({ nf } = formatters(language));
  applyPageLanguage(language);
  const response = await fetch('/api/v1/hammerfest/profile', { credentials: 'same-origin' });
  if (!response.ok) {
    loginNotice(t('loginProfile'));
    return;
  }
  profile = await response.json();
  notice.hidden = true;
  renderFridge();
  renderItems();
  renderQuests();
  route();
}

window.addEventListener('hashchange', route);
boot().catch((error) => {
  notice.textContent = t('pfError');
  console.error('[hammerfest] profile', error);
});
