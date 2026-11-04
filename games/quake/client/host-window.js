// Quake III window (roadmap J6). Opening the window downloads nothing: the
// shared embedded-client owner waits for a local click on Play, and the
// title-bar button unloads the game for this browser only.
export default {
  id: 'quake3',
  title: 'quake 3',
  icon: '💥',
  geometry: { left: 15, top: 4.5, width: 64, height: 69.444444 },
  dataset: {
    featureStyles: '/games/quake/client/host-style.css',
    styleState: 'idle',
    taskbar: 'open',
  },
  bodyClass: 'wm-body-quake3',
  titlebarTemplate: `
    <button type="button" class="wm-btn wm-btn-unload" data-game-unload hidden
      title="Unload for me" data-i18n-attr="title:games.unloadForMe;aria-label:games.unloadForMe">⏏</button>`,
  template: `
    <iframe id="quake3-iframe" src="about:blank" title="Quake 3 game"
      data-i18n-attr="title:games.quakeFrameTitle" allowfullscreen
      allow="autoplay; fullscreen; keyboard-map; pointer-lock"></iframe>
    <div class="quake3-loading" id="quake3-loading" role="status" aria-live="polite" hidden>
      <span class="quake3-loading-mark" aria-hidden="true">%</span>
      <span class="quake3-loading-copy" data-status-copy></span>
    </div>
    <div class="iframe-cursor-overlay" id="quake3-overlay"></div>`,
  load: (attempt = 0) =>
    import('/games/quake/client/host-embedded.js' + (attempt ? '?retry=' + attempt : '')),
  mount: (clients) => clients.startEmbeddedClient(clients.QUAKE),
};
