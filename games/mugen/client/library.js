// Standalone /mugen-library page: the same shelf the MUGEN window shows, for a
// direct link. The window itself mounts the library in place (client/index.js).
import { t, getLanguage, loadLanguage } from '/core/js/i18n.js';
import { createLibraryView } from './library-view.js';

const text = (key, values) => t('games.mugen.' + key, values);

async function start() {
  await loadLanguage(getLanguage());
  document.documentElement.lang = getLanguage();
  document.title = 'MUGEN · ' + text('library');
  for (const element of document.querySelectorAll('[data-copy]'))
    element.textContent = text(element.dataset.copy);
  const view = createLibraryView({
    text,
    onCatalogChanged: () =>
      window.opener?.postMessage({ type: 'mugen:catalog-changed' }, location.origin),
  });
  document.querySelector('.library-mount')?.replaceChildren(view.element);
  window.addEventListener('pagehide', () => view.destroy(), { once: true });
}

void start();
