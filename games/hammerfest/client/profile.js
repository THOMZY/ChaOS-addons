// @ts-check
// Frigo / Mes objets / Mes quêtes, aux formats du site Eternalfest.
// Un objet est « débloqué » quand sa quantité atteint son seuil (`unlock`,
// 10 exemplaires pour la plupart, 1 pour les objets uniques) : en dessous il
// reste affiché mais grisé, et un objet jamais obtenu s'affiche « ? ».
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
const nf = new Intl.NumberFormat('fr-FR');
const STATUS = /** @type {Record<string, string>} */ ({ started: 'Pas commencée', partial: 'En cours', completed: 'Terminée' });

/** Message « connecte-toi » avec le lien de retour, sans innerHTML. */
function loginNotice(message) {
  notice.hidden = false;
  notice.replaceChildren(
    document.createTextNode(message + ' '),
    Object.assign(el('a', undefined, 'Retour au site'), { href: '/' }),
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
    statRow('Nom du joueur', profile.account.pseudo),
    statRow('Meilleur score', nf.format(stats.bestScore)),
    statRow('Meilleur niveau', String(stats.maxLevel)),
    statRow('Quêtes', `${stats.completedQuests} / ${stats.questsTotal}`),
  );
  itemsCount.textContent = `${stats.unlockedCount} objets sur ${stats.totalItems}`;

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
    statRow("Nombre d'objets découverts", `${stats.discoveredCount} / ${stats.totalItems}`),
    statRow("Nombre d'objets débloqués", `${stats.unlockedCount} / ${stats.totalItems}`),
    statRow('Nombre de familles complétées', `${stats.completedFamilies} / ${stats.totalFamilies}`),
  );

  const blocks = [];
  for (const family of profile.families) {
    const discovered = family.items.filter((/** @type {any} */ item) => item.discovered);
    if (discovered.length === 0) continue;
    const block = el('div', 'item-family');
    const header = el('div', 'item-family-header');
    const name = el('span', 'item-family-name');
    name.append(document.createTextNode('Famille '), el('span', 'item-family-name-text', family.name));
    header.append(name);
    if (discovered.length === family.total) header.append(el('span', 'item-family-complete', '(complete !)'));
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
    questsBox.replaceChildren(el('p', 'notice', 'Aucune quête.'));
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
        el('span', 'status', STATUS[quest.state] ?? quest.state),
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
        ? `Fiche Hammerfest de ${profile.account.pseudo}`
        : 'Les Cavernes de Hammerfest';
  }
}

async function boot() {
  const response = await fetch('/api/v1/hammerfest/profile', { credentials: 'same-origin' });
  if (!response.ok) {
    loginNotice('Connecte-toi sur ChaOS website pour voir ton frigo.');
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
  notice.textContent = 'Impossible de charger le profil.';
  console.error('[hammerfest] profile', error);
});
