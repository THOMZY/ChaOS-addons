// Explicit palettes avoid Lua's unordered flag traversal assigning different
// colors to the same fighter on players' engines and a spectator's replay.
export function duelArgs({ p1, p2, stage }) {
  return [
    '-p1',
    p1.path,
    '-p2',
    p2.path,
    '-p1.pal',
    '1',
    '-p2.pal',
    p1.path === p2.path ? '2' : '1',
    '-s',
    'stages/' + stage.path,
  ];
}
