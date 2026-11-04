import { t } from '/core/js/localization/i18n.js';
export { startEmbeddedClient } from '/core/js/games/platform/embedded-clients.js';
// ─── Minecraft (EaglerCraftX 1.8.8) ─────────────────────────────────────────
// Eagler is a self-contained document with no render loop the parent can
// control, so it cannot be frozen (the hidden window keeps rendering). A
// ten-second minimize timeout cleanly closes the game-server connection,
// preserving the original behavior.
export const MINECRAFT = {
  id: 'minecraft',
  clickToLoad: true,
  label: 'Minecraft',
  iframeId: 'mc-iframe',
  statusId: 'mc-loading',
  loadingCopy: () => t('games.loadingMinecraft'),
  source: () => '/mc/eaglercraft.html',
  unloadDelayMs: 10_000,
  freeze: false,
  preflight: true,
  rejectSelector: '#app',
};
