// @ts-check
// Page de fin de partie : score, niveau, objets ramassés (avec les badges
// « nouveau » et « débloqué ») et les quêtes qui ont progressé pendant la partie.
import { applyPageLanguage, formatters, loadLanguage, modeName, translate } from './i18n.js';
const notice = /** @type {HTMLElement} */ (document.getElementById('notice'));
const resultBox = /** @type {HTMLElement} */ (document.getElementById('result'));
const summary = /** @type {HTMLElement} */ (document.getElementById('summary'));
const itemsBox = /** @type {HTMLElement} */ (document.getElementById('items'));
const itemsCount = /** @type {HTMLElement} */ (document.getElementById('items-count'));
const questsBox = /** @type {HTMLElement} */ (document.getElementById('quests'));
const questsCount = /** @type {HTMLElement} */ (document.getElementById('quests-count'));
const subtitle = /** @type {HTMLElement} */ (document.getElementById('subtitle'));

/** @type {import('./i18n.js').Language} */
let language = 'fr';
/** @type {Intl.NumberFormat} */
let nf = new Intl.NumberFormat('fr-FR');
/** @type {Intl.DateTimeFormat} */
let df = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeStyle: 'short' });
/** @param {string} key @param {Record<string, string | number>} [values] */
const t = (key, values) => translate(key, language, values);

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
  const modeLabel = modeName({ id: run.mode, display_name: run.modeLabel }, language);
  /** @type {[string, string, string?][]} */
  const boxes = [
    [t('rsPoints'), nf.format(run.totalScore)],
    [t('rsLevel'), String(run.maxLevel), run.isVictory ? 'victory' : undefined],
    [t('rsMode'), modeLabel],
    [t('rsEnded'), run.endedAt ? df.format(new Date(run.endedAt)) : '—'],
  ];
  summary.replaceChildren(
    ...boxes.map(([label, value, extra]) => {
      const box = el('div', extra ? `box ${extra}` : 'box');
      box.append(el('span', undefined, label), el('b', undefined, value));
      return box;
    }),
  );
  subtitle.textContent = `${modeLabel}${run.isVictory ? ' — ' + t('rsVictory') : ''}`;
}

/** @param {any[]} items */
function renderItems(items) {
  if (items.length === 0) {
    itemsBox.replaceChildren(el('p', 'empty', t('rsNoItems')));
    itemsCount.textContent = '';
    return;
  }
  const unlocked = items.filter((item) => item.unlockedNow).length;
  const fresh = items.filter((item) => item.isNew).length;
  itemsCount.textContent = t('rsItemsCount', { total: items.length, fresh, unlocked });

  itemsBox.replaceChildren(
    ...items.map((item) => {
      const card = el('div', 'loot');
      const name = el('div');
      name.append(
        el('div', 'name', item.name),
        el('div', 'sub', item.unlockedNow ? t('rsThreshold', { n: item.unlock }) : `${item.after} / ${item.unlock}`),
      );
      card.append(icon(item.id), name, el('span', 'count', `×${nf.format(item.gained)}`));
      const tags = el('div', 'tags');
      if (item.unlockedNow) tags.append(el('span', 'tag unlock', t('rsUnlocked')));
      if (item.isNew) tags.append(el('span', 'tag new', t('rsNew')));
      card.append(tags);
      return card;
    }),
  );
}

/** @param {any[]} quests */
function renderQuests(quests) {
  if (quests.length === 0) {
    questsBox.replaceChildren(el('p', 'empty', t('rsNoQuests')));
    questsCount.textContent = '';
    return;
  }
  const done = quests.filter((quest) => quest.completedNow).length;
  questsCount.textContent = t('rsQuestsCount', { total: quests.length }) + (done ? t('rsQuestsCountDone', { done }) : '');

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
        tags.append(el('span', 'tag unlock', t('rsQuestDone')));
        row.append(tags);
      }
      return row;
    }),
  );
}

async function boot() {
  language = await loadLanguage();
  ({ nf, df } = formatters(language));
  applyPageLanguage(language);
  const id = runId();
  if (!/^[0-9a-f-]{36}$/.test(id)) {
    notice.textContent = t('rsNotFound');
    return;
  }
  const response = await fetch(`/api/v1/hammerfest/runs/${id}`, { credentials: 'same-origin' });
  if (!response.ok) {
    loginNotice(t('loginResult'));
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
  notice.textContent = t('rsError');
  console.error('[hammerfest] result', error);
});
