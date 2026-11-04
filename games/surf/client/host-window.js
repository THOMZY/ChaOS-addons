// Surf window (roadmap J6). Opening the window downloads nothing: the shared
// embedded-client owner waits for a local click on Play, and the
// title-bar button unloads the game for this browser only.
export default {
  id: 'surf',
  title: 'surf',
  icon: '🏄',
  geometry: { left: 18, top: 5.555556, width: 64, height: 69.444444 },
  dataset: {
    featureStyles: '/games/surf/client/host-style.css',
    styleState: 'idle',
    taskbar: 'open',
  },
  bodyClass: 'wm-body-surf',
  titlebarTemplate: `
    <button type="button" class="wm-btn wm-btn-unload" data-game-unload hidden
      title="Unload for me" data-i18n-attr="title:games.unloadForMe;aria-label:games.unloadForMe">⏏</button>`,
  template: `
    <iframe id="surf-iframe" src="" title="Surf game" data-i18n-attr="title:games.surfFrameTitle"
      allowfullscreen allow="autoplay; fullscreen; keyboard-map; pointer-lock"></iframe>
    <div class="wm-game-status" id="surf-loading" role="status" aria-live="polite" hidden>
      <span class="wm-game-status-copy" data-status-copy></span>
    </div>
    <div class="iframe-cursor-overlay" id="surf-overlay"></div>`,
  load: (attempt = 0) =>
    import('/games/surf/client/host-embedded.js' + (attempt ? '?retry=' + attempt : '')),
  mount: (clients) => clients.startEmbeddedClient(clients.SURF),
};
