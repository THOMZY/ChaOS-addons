import { el } from './dom.js';
import { BUTTON_KEYS, formatMoveInput } from './move-input.js';

export function createMoveList({
  root,
  scope,
  tr,
  releaseInput,
  focusEngine,
  fetch = globalThis.fetch,
}) {
  const text = (key, fallback) => tr('games.mugen.' + key, fallback);
  if (!document.getElementById('mugen-move-list-style'))
    document.head.append(
      el('link', {
        id: 'mugen-move-list-style',
        rel: 'stylesheet',
        href: '/games/mugen/client/move-list.css',
      }),
    );
  let characters = [],
    selected = 0,
    overlay = null,
    controller = null,
    behind = [],
    version = 0;
  const cache = new Map();

  function close(restoreFocus = true) {
    version++;
    controller?.abort();
    controller = null;
    if (!overlay) return;
    overlay.remove();
    overlay = null;
    for (const [node, wasInert] of behind) node.inert = wasInert;
    behind = [];
    if (restoreFocus) focusEngine();
  }

  async function loadMoves(content, character) {
    controller?.abort();
    controller = new AbortController();
    const current = ++version;
    content.replaceChildren(
      el('p', {
        class: 'mugen-empty',
        role: 'status',
        text: text('movesLoading', 'Loading moves…'),
      }),
    );
    try {
      let result = cache.get(character.path);
      if (!result) {
        const response = await fetch(
          '/api/mugen/moves?path=' + encodeURIComponent(character.path),
          { signal: controller.signal },
        );
        if (!response.ok) throw new Error('moves_unavailable');
        result = await response.json();
      }
      if (!overlay || current !== version) return;
      cache.set(character.path, result);
      content.replaceChildren(
        ...(result.moves.length
          ? result.moves.map((move) =>
              el('div', { class: 'mugen-move-row' }, [
                el('span', { class: 'mugen-move-name', text: move.name.replaceAll('_', ' ') }),
                el('kbd', { text: formatMoveInput(move.input), title: move.input }),
              ]),
            )
          : [
              el('p', {
                class: 'mugen-empty',
                text: text('movesEmpty', 'No commands are available for this character.'),
              }),
            ]),
      );
    } catch (error) {
      if (!overlay || current !== version || error.name === 'AbortError') return;
      content.replaceChildren(
        el('p', { role: 'alert', text: text('movesFailed', 'Unable to load the moves.') }),
        el('button', {
          class: 'mugen-button',
          text: text('movesRetry', 'Retry'),
          onclick: () => void loadMoves(content, character),
        }),
      );
    }
  }

  function open() {
    if (overlay || !characters.length) return;
    releaseInput();
    const closeButton = el('button', {
      class: 'mugen-button',
      text: text('movesClose', 'Close · Esc'),
      onclick: () => close(),
    });
    const tabs = el('div', {
      class: 'mugen-move-tabs',
      role: 'tablist',
      'aria-label': text('movesCharacters', 'Characters'),
    });
    const content = el('div', {
      class: 'mugen-move-rows',
      role: 'tabpanel',
      id: 'mugen-move-rows',
      tabindex: 0,
    });
    const select = (index) => {
      selected = index;
      for (const [slot, tab] of [...tabs.children].entries()) {
        tab.setAttribute('aria-selected', String(slot === index));
        tab.tabIndex = slot === index ? 0 : -1;
      }
      content.setAttribute('aria-labelledby', 'mugen-move-tab-' + index);
      void loadMoves(content, characters[index]);
    };
    characters.forEach((character, index) =>
      tabs.append(
        el('button', {
          class: 'mugen-move-tab',
          role: 'tab',
          id: 'mugen-move-tab-' + index,
          'aria-controls': content.id,
          text: `${index + 1} · ${character.name}`,
          onclick: () => select(index),
          onkeydown: (event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const next =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? characters.length - 1
                  : (index + (event.key === 'ArrowRight' ? 1 : -1) + characters.length) %
                    characters.length;
            select(next);
            tabs.children[next].focus();
          },
        }),
      ),
    );
    overlay = el(
      'section',
      {
        class: 'mugen-move-list',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': 'mugen-move-title',
      },
      [
        el('div', { class: 'mugen-move-header' }, [
          el('h2', { id: 'mugen-move-title', text: text('movesTitle', 'Move list') }),
          closeButton,
        ]),
        tabs,
        el('p', {
          class: 'mugen-move-note',
          text: text(
            'movesDirections',
            'Directions assume you face right. Reverse left/right when facing left.',
          ),
        }),
        el(
          'div',
          { class: 'mugen-move-legend' },
          Object.entries(BUTTON_KEYS).map(([button, key]) =>
            el('span', {}, [el('kbd', { text: key }), ` = ${button}`]),
          ),
        ),
        el('p', {
          class: 'mugen-move-note',
          text: text(
            'movesNotation',
            '› next input · + together · [key] hold · ↥ release · f = frames',
          ),
        }),
        content,
        el('p', {
          class: 'mugen-move-footer',
          text: text('movesLive', 'The fight keeps running while this list is open.'),
        }),
      ],
    );
    behind = [...root.children].map((node) => [node, node.inert]);
    for (const [node] of behind) node.inert = true;
    root.append(overlay);
    closeButton.focus();
    select(selected);
  }

  const toggle = () => (overlay ? close() : open());
  scope.on(
    document,
    'keydown',
    (event) => {
      if (event.key === 'Escape' && characters.length) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!event.repeat) toggle();
      } else if (overlay && event.key === 'Tab') {
        const targets = [
          ...overlay.querySelectorAll('button:not([tabindex="-1"]), [tabindex="0"]'),
        ];
        const first = targets[0],
          last = targets.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    },
    { capture: true },
  );
  scope.cleanup(() => close(false));
  return {
    toggle,
    isOpen: () => overlay !== null,
    setCharacters(next, slot = 0) {
      close(false);
      characters = next.filter(Boolean);
      selected = slot < characters.length ? slot : 0;
      cache.clear();
    },
  };
}
