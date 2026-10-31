export const BUTTON_KEYS = { a: 'Z', b: 'X', c: 'C', x: 'A', y: 'S', z: 'D', s: 'Enter' };
const DIRECTIONS = { F: '→', B: '←', U: '↑', D: '↓', DF: '↘', DB: '↙', UF: '↗', UB: '↖' };

export function formatMoveInput(input) {
  return input
    .split(',')
    .map((step) =>
      step
        .trim()
        .split('+')
        .map((value) => {
          const match = /^([~/$>\d]*)([A-Za-z]+)$/.exec(value.trim());
          if (!match) return value.trim();
          const [, modifiers, key] = match;
          const frames = modifiers.match(/\d+/)?.[0] ?? '';
          const label = DIRECTIONS[key] ?? BUTTON_KEYS[key] ?? key;
          return (
            (modifiers.includes('/')
              ? '[' + label + ']'
              : modifiers.includes('~')
                ? '↥' + label
                : label) + (frames ? ` (${frames}f)` : '')
          );
        })
        .join(' + '),
    )
    .join('  ›  ');
}
