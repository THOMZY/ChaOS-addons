import { createGameResourceLoader } from '/core/js/games/platform/game-resource-loader.js';
export const loadGameResources = createGameResourceLoader({definitions: {peggle: {
  styles: ['/games/peggle/client/peggle.css'],
  scripts: [{ src: '/games/peggle/client/peggle.js', ready: () => typeof globalThis.PeggleEngine === 'function' }],
  module: attempt => import('/games/peggle/client/peggle-ui.js' + (attempt ? '?retry=' + attempt : '')),
}}});
