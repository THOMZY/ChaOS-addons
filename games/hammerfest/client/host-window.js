// Hammerfest window (add-on ChaOS-addons). The page itself lives in the add-on
// (`client/play.html`) and is served under /games/hammerfest/client/. Opening
// the window downloads nothing: the shared embedded-client owner waits for a
// local click on Play, and the title-bar button unloads the game for this
// browser only.
export default {
  id: 'hammerfest',
  title: 'Hammerfest',
  icon: '⛏',
  geometry: { left: 15, top: 4.5, width: 64, height: 72 },
  dataset: {
    featureStyles: '/games/hammerfest/client/host-style.css',
    styleState: 'idle',
    taskbar: 'open',
  },
  bodyClass: 'wm-body-hf',
  titlebarTemplate: `
    <button type="button" class="wm-btn wm-btn-unload" data-game-unload hidden
      title="Unload for me" data-i18n-attr="title:games.unloadForMe;aria-label:games.unloadForMe">⏏</button>`,
  template: `
    <iframe id="hf-iframe" src="" title="Hammerfest" allow="autoplay; fullscreen"></iframe>
    <div class="wm-game-status" id="hf-loading" role="status" aria-live="polite" hidden>
      <span class="wm-game-status-copy" data-status-copy></span>
    </div>
    <div class="iframe-cursor-overlay" id="hf-overlay"></div>`,
  load: (attempt = 0) =>
    import('/games/hammerfest/client/host-embedded.js' + (attempt ? '?retry=' + attempt : '')),
  mount: (clients) => clients.startEmbeddedClient(clients.HAMMERFEST),
};
