// @ts-check
// Page de fin de partie : score, niveau, objets ramassés (avec les badges
// « nouveau » et « débloqué ») et les quêtes qui ont progressé pendant la partie.
const notice = /** @type {HTMLElement} */ (document.getElementById('notice'));
const resultBox = /** @type {HTMLElement} */ (document.getElementById('result'));
const summary = /** @type {HTMLElement} */ (document.getElementById('summary'));
const itemsBox = /** @type {HTMLElement} */ (document.getElementById('items'));
const itemsCount = /** @type {HTMLElement} */ (document.getElementById('items-count'));
const questsBox = /** @type {HTMLElement} */ (document.getElementById('quests'));
const questsCount = /** @type {HTMLElement} */ (document.getElementById('quests-count'));
const subtitle = /** @type {HTMLElement} */ (document.getElementById('subtitle'));

const nf = new Intl.NumberFormat('fr-FR');
const df = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeStyle: 'short' });

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

/** @param {string} id @param {string} [className] */
function icon(id, className) {
  const img = /** @type {HTMLImageElement} */ (el('img', className));
  img.src = `/games/hammerfest/client/items/${id}.png`;
  img.alt = '';
  return img;
}

/** @param {string} value */
const runId = () => location.pathname.split('/').filter(Boolean).pop() ?? '';

/** @param {any} run */
function renderSummary(run) {
  /** @type {[string, string, string?][]} */
  const boxes = [
    ['Points', nf.format(run.totalScore)],
    ['Niveau atteint', String(run.maxLevel), run.isVictory ? 'victory' : undefined],
    ['Mode', run.modeLabel],
    ['Terminée', run.endedAt ? df.format(new Date(run.endedAt)) : '—'],
  ];
  summary.replaceChildren(
    ...boxes.map(([label, value, extra]) => {
      const box = el('div', extra ? `box ${extra}` : 'box');
      box.append(el('span', undefined, label), el('b', undefined, value));
      return box;
    }),
  );
  subtitle.textContent = `${run.modeLabel}${run.isVictory ? ' — victoire !' : ''}`;
}

/** @param {any[]} items */
function renderItems(items) {
  if (items.length === 0) {
    itemsBox.replaceChildren(el('p', 'empty', 'Aucun objet ramassé pendant cette partie.'));
    itemsCount.textContent = '';
    return;
  }
  const unlocked = items.filter((item) => item.unlockedNow).length;
  const fresh = items.filter((item) => item.isNew).length;
  itemsCount.textContent = `${items.length} objet(s) · ${fresh} nouveau(x) · ${unlocked} débloqué(s)`;

  itemsBox.replaceChildren(
    ...items.map((item) => {
      const card = el('div', 'loot');
      const name = el('div');
      name.append(
        el('div', 'name', item.name),
        el('div', 'sub', item.unlockedNow ? `seuil ${item.unlock} atteint` : `${item.after} / ${item.unlock}`),
      );
      card.append(icon(item.id), name, el('span', 'count', `×${nf.format(item.gained)}`));
      const tags = el('div', 'tags');
      if (item.unlockedNow) tags.append(el('span', 'tag unlock', 'Débloqué'));
      if (item.isNew) tags.append(el('span', 'tag new', 'Nouveau'));
      card.append(tags);
      return card;
    }),
  );
}

/** @param {any[]} quests */
function renderQuests(quests) {
  if (quests.length === 0) {
    questsBox.replaceChildren(el('p', 'empty', 'Aucune quête n’a progressé pendant cette partie.'));
    questsCount.textContent = '';
    return;
  }
  const done = quests.filter((quest) => quest.completedNow).length;
  questsCount.textContent = `${quests.length} quête(s)${done ? ` · ${done} terminée(s)` : ''}`;

  questsBox.replaceChildren(
    ...quests.map((quest) => {
      const row = el('div', quest.completedNow ? 'quest-row done' : 'quest-row');
      const head = el('div', 'head');
      head.append(el('b', undefined, quest.name), el('span', undefined, `${quest.before} → ${quest.after} / ${quest.need}`));
      const bar = el('div', 'bar');
      const fill = el('i');
      fill.style.width = `${Math.round((quest.after / quest.need) * 100)}%`;
      bar.append(fill);
      row.append(head, bar);
      if (quest.completedNow) {
        const tags = el('div', 'tags');
        tags.append(el('span', 'tag unlock', 'Quête terminée'));
        row.append(tags);
      }
      return row;
    }),
  );
}

async function boot() {
  const id = runId();
  if (!/^[0-9a-f-]{36}$/.test(id)) {
    notice.textContent = 'Partie introuvable.';
    return;
  }
  const response = await fetch(`/api/v1/hammerfest/runs/${id}`, { credentials: 'same-origin' });
  if (!response.ok) {
    loginNotice('Connecte-toi sur ChaOS website pour voir cette partie.');
    return;
  }
  const { run } = await response.json();
  notice.hidden = true;
  resultBox.hidden = false;
  renderSummary(run);
  renderItems(run.items ?? []);
  renderQuests(run.quests ?? []);
}

boot().catch((error) => {
  notice.textContent = 'Impossible de charger le résultat.';
  console.error('[hammerfest] result', error);
});
