// A catalog with two fighters and one stage, for runtime tests that never read disk.
export function fakeCatalog({ stages = [{ path: 'dojo/dojo.def', name: 'Dojo' }] } = {}) {
  const characters = [
    { path: 'kfm/kfm.def', name: 'Kung Fu Man' },
    { path: 'Ryu/wrapped/ryu.def', name: 'Ryu' },
  ];
  return {
    roots: {},
    characters: () => characters,
    stages: () => stages,
    character: (path) => characters.find((entry) => entry.path === path) ?? null,
    stage: (path) => stages.find((entry) => entry.path === path) ?? null,
    files: () => ({ characters: [], stages: [] }),
    engine: () => null,
    invalidate() {},
  };
}
