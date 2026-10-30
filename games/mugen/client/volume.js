const DEFAULT_VOLUME = 20;
const SLIDERS = { bgm: 'fg-bgm-slider', sfx: 'fg-sfx-slider' };

export function clampVolume(value, fallback = DEFAULT_VOLUME) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number))) : fallback;
}

export function readVolumes(document = globalThis.document) {
  return Object.fromEntries(
    Object.entries(SLIDERS).map(([key, id]) => [
      key,
      clampVolume(document.getElementById(id)?.value),
    ]),
  );
}

export function bindVolumeControls(
  scope,
  apply,
  { document = globalThis.document, storage = globalThis.localStorage } = {},
) {
  for (const [key, id] of Object.entries(SLIDERS)) {
    const slider = document.getElementById(id);
    if (!slider) continue;
    try {
      const saved = storage?.getItem('mugen.volume.' + key);
      if (saved !== null && saved !== undefined) slider.value = String(clampVolume(saved));
    } catch {
      /* Storage may be disabled; audio controls still work. */
    }
    const update = () => {
      try {
        storage?.setItem('mugen.volume.' + key, String(clampVolume(slider.value)));
      } catch {
        /* A local preference must not prevent live volume updates. */
      }
      apply(readVolumes(document));
    };
    scope.on(slider, 'input', update);
    scope.on(slider, 'change', update);
  }
}

/** Shared with the Go audio poller: settings stay local to this engine. */
export function createAudioControl(initial = {}) {
  const state = { bgm: clampVolume(initial.bgm), sfx: clampVolume(initial.sfx), revision: 0 };
  return {
    state,
    setVolume(values = {}) {
      const bgm = clampVolume(values.bgm, state.bgm),
        sfx = clampVolume(values.sfx, state.sfx);
      if (bgm === state.bgm && sfx === state.sfx) return;
      state.bgm = bgm;
      state.sfx = sfx;
      state.revision++;
    },
  };
}
