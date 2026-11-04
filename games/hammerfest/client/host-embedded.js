import { t } from '/core/js/localization/i18n.js';
export { startEmbeddedClient } from '/core/js/games/platform/embedded-clients.js';
// ─── Hammerfest (Flash through Ruffle, add-on page under /games/hammerfest/) ──
// About 45 MB on a cold start (two Ruffle WASM builds, the SWF and its music),
// so it waits for a local click like the other heavy games. Ruffle keeps its
// own audio clock, so freezing only the render loop would loop the last audio
// buffer: the window is left running and released after its idle timeout.
export const HAMMERFEST = {
  id: 'hammerfest',
  clickToLoad: true,
  label: 'Hammerfest',
  iframeId: 'hf-iframe',
  statusId: 'hf-loading',
  loadingCopy: () => t('games.loadingHammerfest'),
  source: () => '/games/hammerfest/client/play.html',
  unloadDelayMs: 3 * 60_000,
  freeze: false,
  preflight: true,
  rejectSelector: '#app',
};
