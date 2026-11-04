// The chat integration owns the deferred controller for this window.
export default {
  id: 'mugen',
  title: 'MUGEN',
  titleKey: 'window.mugen',
  icon: '⚔',
  geometry: { left: 10, top: 10, width: 55, height: 44.444444 },
  dataset: {
    featureStyles: '/games/mugen/client/host-shared.css /games/mugen/client/host-style.css',
    styleState: 'idle',
    taskbar: 'open',
  },
  bodyClass: 'fg-window-body',
  titlebarTemplate: `
    <label class="fg-vol-label" title="BGM volume" data-i18n-attr="title:dj.backgroundMusicVolume">
      <span class="fg-vol-icon">🎵</span>
      <input type="range" id="fg-bgm-slider" class="fg-vol-slider" min="0" max="100" value="50" step="1">
    </label>
    <label class="fg-vol-label" title="SFX volume" data-i18n-attr="title:dj.soundEffectsVolume">
      <span class="fg-vol-icon">🔊</span>
      <input type="range" id="fg-sfx-slider" class="fg-vol-slider" min="0" max="100" value="50" step="1">
    </label>`,
  template: `
    <div class="fg-panel fg-panel-mugen">
      <header class="fg-panel-header fg-panel-header-mugen">
        <span class="fg-panel-game-icon">⚔</span>
        <div>
          <div class="fg-panel-game-name">MUGEN</div>
          <div class="fg-panel-game-sub" data-i18n="games.customMugenEngine">custom MUGEN engine</div>
        </div>
      </header>
      <div class="mugen-body" id="mugen-body"></div>
    </div>`,
  load: (attempt = 0) =>
    import('/games/mugen/client/host-chat.js' + (attempt ? '?retry=' + attempt : '')),
};
