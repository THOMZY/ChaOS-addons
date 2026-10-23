// @ts-check
// Page de lancement (style Eternalfest) : mode de jeu, paramètres, options du
// mode, puis la partie. Le loader Flash fait le reste ; il attend un clic dans
// la zone de jeu pour démarrer.
/** @type {{ gameId: string, locale: string, options: Record<string, {key: string, display_name: string, checked: boolean}[]>, modes: {id: string, display_name: string}[] } | null} */
let config = null;
let selectedMode = 'solo';
/** @type {Set<string>} */
let selectedOptions = new Set();
let busy = false;

const notice = /** @type {HTMLElement} */ (document.getElementById('notice'));
const form = /** @type {HTMLFormElement} */ (document.getElementById('run-form'));
const modesBox = /** @type {HTMLElement} */ (document.getElementById('modes'));
const optionsBox = /** @type {HTMLElement} */ (document.getElementById('options'));
const optionsTitle = /** @type {HTMLElement} */ (document.getElementById('options-title'));
const stage = /** @type {HTMLElement} */ (document.getElementById('stage'));
const playButton = /** @type {HTMLButtonElement} */ (document.getElementById('play'));

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

function settings() {
  /** @param {string} id */
  const on = (id) => /** @type {HTMLInputElement} */ (document.getElementById(id)).checked;
  return { detail: on('set-detail'), shake: on('set-shake'), sound: on('set-sound'), music: on('set-music') };
}

/** @param {string} tag @param {Node} child */
function wrap(tag, child) {
  const node = el(tag);
  node.append(child);
  return node;
}

function renderModes() {
  if (!config) return;
  modesBox.replaceChildren(
    ...config.modes.map((mode) => {
      const label = el('label', 'choice');
      label.dataset.mode = mode.id;
      label.classList.toggle('selected', mode.id === selectedMode);
      const input = /** @type {HTMLInputElement} */ (el('input'));
      input.type = 'radio';
      input.name = 'game_mode';
      input.checked = mode.id === selectedMode;
      label.append(input, document.createTextNode(mode.display_name));
      label.addEventListener('click', (event) => {
        event.preventDefault();
        if (busy) return;
        selectedMode = mode.id;
        selectedOptions = new Set();
        renderModes();
        renderOptions();
      });
      return wrap('li', label);
    }),
  );
}

function renderOptions() {
  if (!config) return;
  const mode = config.modes.find((entry) => entry.id === selectedMode);
  optionsTitle.textContent = mode?.display_name ?? selectedMode;
  const options = config.options[selectedMode] ?? [];
  if (options.length === 0) {
    optionsBox.replaceChildren(wrap('li', el('span', 'no-options', 'Aucune option disponible')));
    return;
  }
  optionsBox.replaceChildren(
    ...options.map((option) => {
      const label = el('label');
      const input = /** @type {HTMLInputElement} */ (el('input'));
      input.type = 'checkbox';
      input.value = option.key;
      input.checked = selectedOptions.has(option.key) || option.checked;
      if (option.checked) selectedOptions.add(option.key);
      input.addEventListener('change', () => {
        if (input.checked) selectedOptions.add(option.key);
        else selectedOptions.delete(option.key);
      });
      label.append(input, document.createTextNode(' ' + option.display_name));
      return wrap('li', label);
    }),
  );
}

function quit() {
  document.body.classList.remove('playing');
  stage.replaceChildren();
  notice.hidden = false;
  notice.textContent = 'Partie terminée. Choisis un mode pour rejouer.';
  form.hidden = false;
}

/** @param {any} run */
function mount(run) {
  if (!config) return;
  document.body.classList.add('playing');
  stage.replaceChildren();
  const quitButton = el('button', undefined, 'Quitter');
  quitButton.id = 'quit';
  quitButton.type = 'button';
  quitButton.addEventListener('click', quit);
  stage.append(quitButton);

  const ruffle = /** @type {any} */ (window).RufflePlayer?.newest?.();
  if (!ruffle) {
    notice.hidden = false;
    notice.textContent = 'Lecteur Flash indisponible (Ruffle).';
    return;
  }
  const player = ruffle.createPlayer();
  // Le lecteur doit remplir la zone et centrer le film : configuré avant load(),
  // sinon Ruffle garde sa taille par défaut et colle le film à gauche.
  player.config = { ...player.config, scale: 'showAll', letterbox: 'on', autoplay: 'on', splashScreen: false };
  stage.append(player);
  player
    .load({
      url: '/hammerfest/data/loader.swf',
      autoplay: 'on',
      unmuteOverlay: 'hidden',
      letterbox: 'on',
      scale: 'showAll',
      splashScreen: false,
      allowScriptAccess: true,
      quality: 'high',
      parameters: {
        game: config.gameId,
        run: JSON.stringify(run),
        options: JSON.stringify({
          mode: run.game_mode,
          options: run.game_options,
          settings: settings(),
          locale: config.locale,
        }),
      },
    })
    .catch((error) => {
      console.error('[hammerfest] load', error);
      notice.hidden = false;
      notice.textContent = 'Le jeu n’a pas pu démarrer.';
    });
}

async function play() {
  if (busy || !config) return;
  busy = true;
  playButton.disabled = true;
  notice.hidden = false;
  notice.textContent = 'Préparation de la partie…';
  try {
    const response = await fetch('/api/v1/runs', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: selectedMode,
        options: [...selectedOptions],
        settings: settings(),
        locale: config.locale,
      }),
    });
    if (!response.ok) throw new Error(`runs -> ${response.status}`);
    mount(await response.json());
  } catch (error) {
    notice.textContent = 'Impossible de créer la partie.';
    console.error('[hammerfest] run', error);
  } finally {
    busy = false;
    playButton.disabled = false;
  }
}

async function boot() {
  const session = await fetch('/api/auth/me', { credentials: 'same-origin' });
  if (!session.ok) {
    loginNotice('Connecte-toi sur THOMZY.com pour jouer.');
    return;
  }
  const response = await fetch('/api/v1/hammerfest/config');
  if (!response.ok) throw new Error(`config -> ${response.status}`);
  config = await response.json();
  const wanted = new URLSearchParams(location.search).get('mode');
  if (wanted && config?.modes.some((mode) => mode.id === wanted)) selectedMode = wanted;
  notice.hidden = true;
  form.hidden = false;
  renderModes();
  renderOptions();
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  play();
});

boot().catch((error) => {
  notice.textContent = 'Erreur de chargement.';
  console.error('[hammerfest] boot', error);
});
