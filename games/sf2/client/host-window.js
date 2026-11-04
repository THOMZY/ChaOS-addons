// Street Fighter II window (roadmap J5e), separate from MUGEN. Its game is
// loaded by core/js/games/mugen-entry.js, started with the chat socket.
export default {
  id: 'sf2',
  title: 'Street Fighter II',
  titleKey: 'window.sf2',
  icon: '🥊',
  geometry: { left: 30, top: 12, width: 45, height: 60 },
  dataset: {
    featureStyles: '/games/sf2/client/host-shared.css /games/sf2/client/host-style.css',
    styleState: 'idle',
    taskbar: 'open',
  },
  bodyClass: 'fg-window-body',
  template: `
    <div class="fg-panel fg-panel-sf2">
      <header class="fg-panel-header fg-panel-header-sf2">
        <span class="fg-panel-game-icon">🥊</span>
        <div>
          <div class="fg-panel-game-name" data-i18n="games.streetFighter">Street Fighter II</div>
          <div class="fg-panel-game-sub">capcom · 1991</div>
        </div>
      </header>
      <div class="sf2-body" id="sf2-body"></div>
    </div>`,
  load: (attempt = 0) =>
    import('/games/sf2/client/host-chat.js' + (attempt ? '?retry=' + attempt : '')),
};
