// A character's select-screen portrait, cut from its sprite file by the server
// (/api/mugen/portrait). A character without one simply shows no image.
import { el } from './dom.js';

export function stagePreview(stage) {
  if (!stage?.path) return null;
  const image = el('img', {
    class: 'mugen-stage-preview',
    src: `/api/mugen/stage-preview?path=${encodeURIComponent(stage.path)}`,
    alt: '',
    loading: 'lazy',
    decoding: 'async',
  });
  image.addEventListener('error', () => image.remove(), { once: true });
  return image;
}

export function portraitUrl(character, size = 'large') {
  return `/api/mugen/portrait?path=${encodeURIComponent(character.path)}&size=${size}`;
}

export function portrait(character, { size = 'large', className = 'mugen-portrait' } = {}) {
  if (!character?.path) return null;
  const image = el('img', {
    class: className,
    src: portraitUrl(character, size),
    alt: '',
    loading: 'lazy',
    decoding: 'async',
    draggable: 'false',
  });
  image.addEventListener('error', () => image.remove(), { once: true });
  return image;
}
