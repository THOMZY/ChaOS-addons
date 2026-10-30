// The engine release this add-on runs: one commit of the Ikemen GO browser
// fork, one commit of the default screenpack, one Go version. The release tag
// is derived from them, so the build and the installer agree on it.
import { readFileSync } from 'node:fs';

export const PINS_URL = new URL('./engine.json', import.meta.url);
export const BUNDLE_NAME = 'mugen-engine.tar.gz';

export function readPins() {
  const pins = JSON.parse(readFileSync(PINS_URL, 'utf8'));
  for (const key of ['ikemen', 'screenpack'])
    if (!/^[0-9a-f]{40}$/.test(pins[key]?.commit ?? ''))
      throw new Error(`engine.json: ${key}.commit`);
  if (!/^\d+\.\d+$/.test(pins.go ?? '')) throw new Error('engine.json: go');
  if (!Number.isSafeInteger(pins.revision) || pins.revision < 1)
    throw new Error('engine.json: revision');
  return pins;
}

export function releaseTag(pins) {
  return `mugen-engine-${pins.ikemen.commit.slice(0, 10)}-${pins.screenpack.commit.slice(0, 10)}-go${pins.go}-r${pins.revision}`;
}

export function releaseUrl(pins) {
  return `https://github.com/${pins.releaseRepository}/releases/download/${releaseTag(pins)}/${BUNDLE_NAME}`;
}
