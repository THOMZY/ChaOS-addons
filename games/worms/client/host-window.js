// The chat integration owns the deferred controller; the window keeps its styled body.
export default {
  id: 'worms',
  title: 'Worms',
  titleKey: 'window.worms',
  icon: '🪱',
  geometry: { left: 15, top: 8, width: 60, height: 72 },
  dataset: { taskbar: 'open', gamepadFallback: '1', featureStyles: '/games/worms/client/style.css', styleState: 'idle' },
  bodyClass: 'games-body',
  bodyId: 'worms-body',
  template: '',
  load: (attempt = 0) =>
    import('/games/worms/client/host-chat.js' + (attempt ? '?retry=' + attempt : '')),
};
