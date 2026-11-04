import { t } from '/core/js/localization/i18n.js';
export { startEmbeddedClient } from '/core/js/games/platform/embedded-clients.js';
// ─── Surf ───────────────────────────────────────────────────────────────────
// This client is expensive to build (about seven seconds on the main thread to
// create the scene and upload ~52 MB of textures to the GPU), so keep the scene
// in memory and freeze its loop whenever the window is hidden.
//
// Timing: the original "records" layer relied on Supabase, which is unavailable
// here. The client deliberately publishes its timer state
// (`window.__SURF__.snapshot()`); the site polls it and submits each run
// when complete to `action=submit-run`, which attaches it to the ChaOS account.
// This is the only way to save times without modifying the client.
const VEILLE_MS = 1000;
const RETRY_MIN_MS = 5000;
const RETRY_MAX_MS = 60_000;

function createRunSubmitter({ now = () => Date.now() } = {}) {
  let done = ''; // Run already submitted or permanently rejected.
  let sending = false;
  let attempts = 0;
  let nextAttempt = 0;

  return function submitRuns({ iframe, fetch: fetchFn }) {
    let snap;
    try {
      snap = iframe.contentWindow?.__SURF__?.snapshot?.();
    } catch (_) {
      return;
    }
    const run = snap?.run;
    // Only completed AND valid runs count: `invalidReason` marks a tainted run
    // (missed checkpoint, start-line cheating, and so on).
    if (!run || run.phase !== 'finished' || run.invalidReason) return;
    if (!Number.isFinite(run.elapsed) || run.elapsed <= 0) return;
    // Submit each run once. Its start and finish ticks provide a stable ID that
    // does not depend on the submission time.
    const cle = `${snap.map}|${run.startTick}|${run.endTick}`;
    if (cle === done || sending) return;
    const stamp = now();
    if (stamp < nextAttempt) return;
    sending = true;
    fetchFn('/api/surf?action=submit-run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mapId: snap.map,
        mapVersion: snap.mapVersion ?? null,
        timeMs: Math.round(run.elapsed * 1000),
        splitsMs: (run.splits || []).map((s) => Math.round(s * 1000)),
      }),
    })
      .then((res) => {
        if (res?.ok) {
          done = cle;
          attempts = 0;
          nextAttempt = 0;
          return;
        }
        // 5xx/429: keep the submission and retry it. Do not retry authentication
        // failures or invalid requests.
        if (!res || res.status >= 500 || res.status === 429) return backoff(stamp);
        done = cle;
        return undefined;
      })
      .catch(() => backoff(stamp))
      .finally(() => {
        sending = false;
      });
  };

  function backoff(stamp) {
    attempts += 1;
    nextAttempt = stamp + Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** (attempts - 1));
  }
}

export { createRunSubmitter };

export const SURF = {
  id: 'surf',
  clickToLoad: true,
  label: 'Surf',
  iframeId: 'surf-iframe',
  statusId: 'surf-loading',
  loadingCopy: () => t('games.loadingSurf'),
  source: () => '/surf/',
  unloadDelayMs: 3 * 60_000,
  freeze: true,
  preflight: true,
  rejectSelector: '#app',
  poll: { everyMs: VEILLE_MS, tick: createRunSubmitter() },
};
