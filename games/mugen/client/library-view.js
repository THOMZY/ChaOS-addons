// The MUGEN library: the packs installed on this server, plus ZIP imports.
// The MUGEN window mounts this view in place and the standalone /mugen-library
// page mounts the same one, so browsing and importing stay identical.
import { el } from './dom.js';
import { portrait, stagePreview } from './portrait.js';

const API = '/api/mugen/packs';
const DEFAULT_MAX_UPLOAD = 128 * 1024 * 1024;

/**
 * @param {object} options
 * @param {(key: string, values?: object) => string} options.text
 *   library translations, keyed under `games.mugen.`
 * @param {boolean} [options.compact] tighter layout for the MUGEN window
 * @param {string} [options.backText] set to show a back button above the tabs
 * @param {() => void} [options.onBack]
 * @param {() => void} [options.onCatalogChanged] a pack was imported
 */
export function createLibraryView({
  text,
  compact = false,
  backText = null,
  onBack = null,
  onCatalogChanged = null,
}) {
  const controller = new AbortController();
  const state = {
    catalog: { characters: [], stages: [], maxUploadBytes: DEFAULT_MAX_UPLOAD },
    kind: 'characters',
    canUpload: false,
    busy: false,
    sequence: 0,
  };

  const status = el('p', { class: 'status', role: 'status', 'aria-live': 'polite' });
  const grid = el('div', { class: 'grid', 'aria-busy': 'true' });
  const empty = el('p', { class: 'empty', hidden: true, text: text('noPacks') });
  const search = el('input', {
    class: 'search-input',
    type: 'search',
    placeholder: text('searchPack'),
    'aria-label': text('searchPack'),
  });
  const collectionTitle = el('h2', { text: text('characters') });
  const counts = {
    characters: el('span', { class: 'tab-count', text: '—' }),
    stages: el('span', { class: 'tab-count', text: '—' }),
  };
  const tabs = {};
  for (const kind of ['characters', 'stages']) {
    const button = el(
      'button',
      { class: 'tab', type: 'button', dataset: { kind }, 'aria-pressed': 'false' },
      [el('span', { text: text(kind) }), counts[kind]],
    );
    button.addEventListener('click', () => {
      state.kind = kind;
      render();
    });
    tabs[kind] = button;
  }

  const input = el('input', {
    class: 'pack-input',
    type: 'file',
    accept: '.zip,application/zip',
    hidden: true,
  });
  const uploadButton = el('button', {
    class: 'upload-button',
    type: 'button',
    text: text('chooseZip'),
    disabled: true,
  });
  const importTitle = el('h2', { text: text('importCharacter') });
  const uploadLimit = el('p', {
    class: 'limit',
    text: text('zipLimit', { size: Math.round(DEFAULT_MAX_UPLOAD / 1024 / 1024) }),
  });
  const accountNote = el('p', { class: 'account-note', text: text('checkingAccount') });
  const drop = el('div', { class: 'import-box' }, [
    el('span', { class: 'import-symbol', 'aria-hidden': 'true', text: '↗' }),
    importTitle,
    el('p', { text: text('zipHint') }),
    input,
    uploadButton,
    uploadLimit,
    accountNote,
  ]);

  function announce(message, error = false) {
    status.textContent = message;
    status.classList.toggle('error', error);
  }

  function renderAccount() {
    uploadButton.disabled = state.busy || !state.canUpload;
    accountNote.textContent = text(state.canUpload ? 'libraryAccountReady' : 'libraryLogin');
  }

  function render() {
    counts.characters.textContent = String(state.catalog.characters.length);
    counts.stages.textContent = String(state.catalog.stages.length);
    collectionTitle.textContent = text(state.kind);
    importTitle.textContent = text(state.kind === 'characters' ? 'importCharacter' : 'importStage');
    uploadLimit.textContent = text('zipLimit', {
      size: Math.round(state.catalog.maxUploadBytes / 1024 / 1024),
    });
    const query = search.value.trim().toLocaleLowerCase();
    const entries = state.catalog[state.kind].filter((entry) =>
      (entry.name + ' ' + entry.path).toLocaleLowerCase().includes(query),
    );
    grid.replaceChildren(
      ...entries.map((entry, index) =>
        el('article', { class: 'pack' }, [
          el('div', { class: 'pack-art' }, [
            el('span', { class: 'pack-index', text: String(index + 1).padStart(2, '0') }),
            state.kind === 'characters' ? portrait(entry) : stagePreview(entry),
          ]),
          el('div', { class: 'pack-info' }, [
            el('h3', { text: entry.name }),
            el('p', { class: 'pack-path', text: entry.path }),
          ]),
        ]),
      ),
    );
    empty.hidden = entries.length > 0;
    grid.setAttribute('aria-busy', 'false');
    for (const [kind, button] of Object.entries(tabs)) {
      const active = kind === state.kind;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    }
    renderAccount();
  }

  async function refresh() {
    const version = ++state.sequence;
    const response = await fetch(API, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error('catalog_unavailable');
    const value = await response.json();
    if (version !== state.sequence || controller.signal.aborted) return;
    state.catalog = {
      characters: value?.characters ?? [],
      stages: value?.stages ?? [],
      maxUploadBytes: Number(value?.maxUploadBytes) || DEFAULT_MAX_UPLOAD,
    };
    render();
  }

  async function upload(file) {
    if (!file || state.busy) return;
    if (!state.canUpload) return announce(text('libraryLogin'), true);
    if (!/\.zip$/i.test(file.name)) return announce(text('error.zip_required'), true);
    if (file.size > state.catalog.maxUploadBytes)
      return announce(text('error.pack_too_large'), true);
    state.busy = true;
    const kind = state.kind;
    renderAccount();
    announce(text('uploadingPack', { name: file.name }));
    try {
      const response = await fetch(`${API}/${kind}?name=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
        signal: controller.signal,
      });
      const payload = await response.json();
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) state.canUpload = false;
        const key = 'error.' + payload.error;
        const message = text(key);
        announce(message === 'games.mugen.' + key ? text('packUploadFailed') : message, true);
        return;
      }
      onCatalogChanged?.();
      await refresh();
      announce(text('packAdded', { name: payload.pack.name }));
    } catch (error) {
      if (!controller.signal.aborted) announce(text('packUploadFailed'), true);
    } finally {
      state.busy = false;
      input.value = '';
      if (!controller.signal.aborted) renderAccount();
    }
  }

  search.addEventListener('input', render);
  uploadButton.addEventListener('click', () => input.click());
  input.addEventListener('change', () => void upload(input.files?.[0]));
  drop.addEventListener('dragover', (event) => {
    event.preventDefault();
    drop.classList.add('dragging');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragging'));
  drop.addEventListener('drop', (event) => {
    event.preventDefault();
    drop.classList.remove('dragging');
    void upload(event.dataTransfer?.files?.[0]);
  });

  const back = backText
    ? el('button', {
        class: 'library-back',
        type: 'button',
        text: '← ' + backText,
        onclick: () => onBack?.(),
      })
    : null;

  const element = el('div', { class: 'mugen-library' + (compact ? ' is-compact' : '') }, [
    el('aside', { class: 'sidebar' }, [
      back,
      el('p', { class: 'eyebrow', text: text('libraryEyebrow') }),
      el('h1', { text: text('libraryTitle') }),
      el('p', { class: 'intro', text: text('libraryIntro') }),
      el('nav', { 'aria-label': text('library') }, [tabs.characters, tabs.stages]),
      drop,
      el('p', { class: 'local-note', text: text('sharedLibrary') }),
    ]),
    el('section', { class: 'collection' }, [
      el('div', { class: 'collection-header' }, [
        el('div', {}, [el('p', { class: 'eyebrow', text: text('readyToFight') }), collectionTitle]),
        el('label', { class: 'search' }, [
          el('span', { 'aria-hidden': 'true', text: '⌕' }),
          search,
        ]),
      ]),
      status,
      grid,
      empty,
    ]),
  ]);

  async function start() {
    try {
      const account = await fetch('/api/auth/me', { cache: 'no-store', signal: controller.signal });
      if (controller.signal.aborted) return;
      state.canUpload = account.ok;
      renderAccount();
      await refresh();
    } catch {
      if (!controller.signal.aborted) announce(text('catalogUnavailable'), true);
    }
  }
  void start();

  return {
    element,
    refresh,
    destroy: () => controller.abort(),
  };
}
