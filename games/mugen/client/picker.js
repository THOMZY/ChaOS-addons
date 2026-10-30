// Character and stage choice for a duel or a training match.
import { t } from '/core/js/i18n.js';
import { el } from './dom.js';
import { portrait, stagePreview } from './portrait.js';

const MAX_SHOWN = 300;

/**
 * @param {object} options
 * @param {{path: string, name: string}[]} options.characters
 * @param {{path: string, name: string}[]|null} options.stages null when this player does not choose the stage
 * @param {boolean} [options.opponent] also choose the CPU's character
 * @param {(key: string, fallback: string) => string} options.tr
 * @param {string} options.confirmText
 * @param {(choice: {character, opponent, stage}) => void} options.onConfirm
 */
export function createPicker({ characters, stages, opponent = false, tr, confirmText, onConfirm }) {
  const choice = { character: null, opponent: null, stage: null };
  let target = 'character';
  const search = el('input', {
    type: 'search',
    class: 'mugen-input mugen-search',
    placeholder: tr('games.mugen.search', 'Search'),
    'aria-label': tr('games.mugen.search', 'Search'),
  });
  const list = el('div', { class: 'mugen-characters', role: 'listbox' });
  const confirm = el('button', {
    class: 'mugen-button mugen-primary',
    text: confirmText,
    disabled: true,
  });
  const targets = opponent
    ? el('div', { class: 'mugen-targets' }, [
        el('button', {
          class: 'mugen-button mugen-target',
          dataset: { target: 'character' },
          text: tr('games.mugen.you', 'You'),
        }),
        el('button', {
          class: 'mugen-button mugen-target',
          dataset: { target: 'opponent' },
          text: 'CPU',
        }),
      ])
    : null;
  const stageSelect = stages
    ? el('select', { class: 'mugen-input', 'aria-label': t('games.mugen.stageLabel') }, [
        el('option', { value: '', text: t('games.mugen.randomStage') }),
        ...stages.map((stage) => el('option', { value: stage.path, text: stage.name })),
      ])
    : null;
  const stageCards = stages
    ? el(
        'div',
        { class: 'mugen-stages' },
        stages.map((stage) =>
          el(
            'button',
            {
              type: 'button',
              class: 'mugen-stage-card',
              title: stage.name,
              'aria-pressed': 'false',
              dataset: { path: stage.path },
              onclick: () => {
                stageSelect.value = stage.path;
                stageSelect.dispatchEvent(new Event('change'));
              },
            },
            [stagePreview(stage), el('span', { text: stage.name })],
          ),
        ),
      )
    : null;
  stageSelect?.addEventListener('change', () => {
    for (const card of stageCards.children)
      card.setAttribute('aria-pressed', String(card.dataset.path === stageSelect.value));
  });

  // Packs often ship variants under one name (kfm, kfm720…): tell them apart by folder.
  const nameCount = new Map();
  for (const entry of characters) nameCount.set(entry.name, (nameCount.get(entry.name) ?? 0) + 1);
  function label(entry) {
    if (!entry) return '—';
    return nameCount.get(entry.name) > 1
      ? `${entry.name} · ${entry.path.split('/')[0]}`
      : entry.name;
  }
  // Selection only moves the highlight: rebuilding the grid would reload every portrait.
  function refreshTargets() {
    for (const button of list.children)
      button.classList?.toggle('mugen-active', button.dataset.path === choice[target]?.path);
    if (!targets) return;
    for (const button of targets.children) {
      const key = button.dataset.target;
      button.classList.toggle('mugen-active', key === target);
      button.textContent = `${key === 'character' ? tr('games.mugen.you', 'You') : 'CPU'}: ${label(choice[key])}`;
    }
  }
  function render() {
    const query = search.value.trim().toLowerCase();
    const shown = characters.filter(
      (entry) =>
        !query ||
        entry.name.toLowerCase().includes(query) ||
        entry.path.toLowerCase().includes(query),
    );
    list.replaceChildren(
      ...(shown.length
        ? shown.slice(0, MAX_SHOWN).map((entry) =>
            el(
              'button',
              {
                class:
                  'mugen-character' + (choice[target]?.path === entry.path ? ' mugen-active' : ''),
                role: 'option',
                title: entry.path,
                dataset: { path: entry.path },
                onclick: () => {
                  choice[target] = entry;
                  if (opponent && target === 'character' && !choice.opponent) target = 'opponent';
                  confirm.disabled = !choice.character;
                  refreshTargets();
                },
              },
              [portrait(entry), el('span', { class: 'mugen-character-name', text: label(entry) })],
            ),
          )
        : [el('div', { class: 'mugen-empty', text: t('games.mugen.noCharacterLoaded') })]),
    );
  }

  search.addEventListener('input', render);
  targets?.addEventListener('click', (event) => {
    const key = event.target.closest('[data-target]')?.dataset.target;
    if (!key) return;
    target = key;
    refreshTargets();
  });
  confirm.addEventListener('click', () => {
    if (!choice.character) return;
    confirm.disabled = true;
    const stage = stageSelect?.value
      ? stages.find((entry) => entry.path === stageSelect.value)
      : null;
    onConfirm({ character: choice.character, opponent: choice.opponent, stage });
  });
  refreshTargets();
  render();
  return el('div', { class: 'mugen-picker' }, [
    el('h4', { text: t('games.mugen.selectFighter') }),
    targets,
    search,
    list,
    stageCards,
    el('div', { class: 'mugen-actions' }, [
      stageSelect
        ? el('label', { class: 'mugen-field' }, [t('games.mugen.stageLabel'), stageSelect])
        : null,
      confirm,
    ]),
  ]);
}
