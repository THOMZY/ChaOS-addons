// @ts-check
// Classement : un tableau par mode, meilleur score de chaque joueur.
const notice = /** @type {HTMLElement} */ (document.getElementById('notice'));
const modesBox = /** @type {HTMLElement} */ (document.getElementById('modes'));

const nf = new Intl.NumberFormat('fr-FR');
const df = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short' });

/** @param {string} tag @param {string} [className] @param {string} [text] */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** @param {string} selector */
const me = async () => {
  try {
    const response = await fetch('/api/auth/me', { credentials: 'same-origin' });
    if (!response.ok) return null;
    const data = await response.json();
    return data?.account?.pseudo ?? data?.pseudo ?? null;
  } catch {
    return null;
  }
};

/** @param {{ modeLabel: string, entries: any[] }} mode @param {string | null} pseudo */
function block(mode, pseudo) {
  const section = el('div', 'mode-block');
  section.append(el('h3', undefined, mode.modeLabel));

  const table = el('table');
  const head = el('thead');
  const headRow = el('tr');
  for (const label of ['Rang', 'Joueur', 'Score', 'Niveau', 'Date']) headRow.append(el('th', undefined, label));
  head.append(headRow);

  const body = el('tbody');
  for (const entry of mode.entries) {
    const row = el('tr');
    if (pseudo && entry.pseudo === pseudo) row.className = 'me';
    const ended = entry.endedAt ? df.format(new Date(entry.endedAt)) : '—';
    row.append(
      el('td', 'rank', String(entry.rank)),
      el('td', 'player', entry.pseudo),
      el('td', 'score', nf.format(entry.score)),
      el('td', undefined, String(entry.maxLevel)),
      el('td', undefined, ended),
    );
    body.append(row);
  }
  table.append(head, body);
  section.append(table);
  return section;
}

async function boot() {
  const [response, pseudo] = await Promise.all([
    fetch('/api/v1/hammerfest/leaderboard', { credentials: 'same-origin' }),
    me(),
  ]);
  if (!response.ok) throw new Error(`leaderboard -> ${response.status}`);
  const { modes } = await response.json();
  notice.hidden = true;
  const withEntries = (modes ?? []).filter((/** @type {any} */ mode) => mode.entries.length > 0);
  if (withEntries.length === 0) {
    modesBox.replaceChildren(el('p', 'empty', 'Aucune partie terminée pour le moment. Sois le premier !'));
    return;
  }
  modesBox.replaceChildren(...withEntries.map((/** @type {any} */ mode) => block(mode, pseudo)));
}

boot().catch((error) => {
  notice.textContent = 'Impossible de charger le classement.';
  console.error('[hammerfest] leaderboard', error);
});
