// Game Boy window: the console shell, its screen and its controls.
// The add-on owns the markup and the styles (client/); this window only carries
// the body the client renders into.
export default {
  id: 'gameboy',
  title: 'game boy',
  titleKey: 'window.gameboy',
  icon: '🕹️',
  geometry: { left: 27, top: 5, width: 40, height: 80 },
  bodyClass: 'gameboy-body',
  bodyId: 'gameboy-body',
  dataset: {
    featureStyles: '/games/gameboy/client/gameboy.css',
    styleState: 'idle',
    taskbar: 'open',
  },
  template: '',
  load: (attempt = 0) =>
    import('/games/gameboy/client/gameboy.js' + (attempt ? '?retry=' + attempt : '')),
  mount: (entry) => entry.mountWindow?.(),
  unmount: (_entry, _window, owner) => owner?.destroy(),
};
