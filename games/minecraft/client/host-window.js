// Minecraft (EaglerCraft) window (roadmap J6). Opening the window downloads
// nothing: the shared embedded-client owner waits for a local click on Play,
// and the title-bar button unloads the game for this browser only.
export default {
  id: 'minecraft',
  title: 'minecraft',
  icon: '⛏',
  geometry: { left: 22, top: 7.333333, width: 52, height: 62.222222 },
  dataset: {
    featureStyles: '/games/minecraft/client/host-style.css',
    styleState: 'idle',
    taskbar: 'open',
  },
  bodyClass: 'wm-body-mc',
  titlebarTemplate: `
    <button type="button" class="wm-btn wm-btn-unload" data-game-unload hidden
      title="Unload for me" data-i18n-attr="title:games.unloadForMe;aria-label:games.unloadForMe">⏏</button>`,
  template: `
    <iframe id="mc-iframe" src="" title="Minecraft" allowfullscreen
      allow="autoplay; fullscreen; keyboard-map; pointer-lock"></iframe>
    <div class="wm-game-status" id="mc-loading" role="status" aria-live="polite" hidden>
      <span class="wm-game-status-copy" data-status-copy></span>
    </div>
    <div class="iframe-cursor-overlay" id="mc-overlay"></div>`,
  load: (attempt = 0) =>
    import('/games/minecraft/client/host-embedded.js' + (attempt ? '?retry=' + attempt : '')),
  mount: (clients) => clients.startEmbeddedClient(clients.MINECRAFT),
};
