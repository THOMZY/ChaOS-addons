import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const PRNG_INCREMENT = Number.parseInt('6D2B79F5', 16);
const UINT32_RANGE = 2 ** 32;
const __dir = dirname(fileURLToPath(import.meta.url));
const LUA_PATH = join(__dir, '../media/levels.lua');

const LEVEL_NAMES = {
  1: 'Ironforge',
  2: 'Orgrimmar',
  3: 'Stormwind',
  4: 'Undercity',
  5: 'Darnassus',
  6: 'Thunder Bluff',
  7: 'Dark Portal',
  8: 'Exodar',
  9: 'Silvermoon City',
  10: 'Shattrath City',
  11: 'Dalaran',
  12: 'Icecrown Citadel',
  13: 'Sulfuron Spire',
};

// Simple deterministic PRNG (Mulberry32) — shared by color assignment/tests.
export function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + PRNG_INCREMENT) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / UINT32_RANGE;
  };
}

// Assign the 25 orange, 2 green and 1 purple objects deterministically.
export function assignPegColors(pegs, seed) {
  const rng = mulberry32(seed);
  const count = pegs.length;
  const indices = Array.from({ length: count }, (_, i) => i);

  for (let i = count - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }

  const types = new Array(count).fill('blue');
  let ptr = 0;
  const orangeCount = Math.min(25, count);
  for (let i = 0; i < orangeCount; i++) types[indices[ptr++]] = 'orange';

  const minGreenDist2 = 36 ** 2;
  let greenPlaced = 0;
  let lastGreen = null;
  let scan = ptr;
  while (greenPlaced < 2 && scan < count) {
    const pegIndex = indices[scan];
    const peg = pegs[pegIndex];
    const farEnough =
      !lastGreen || (peg.x - lastGreen.x) ** 2 + (peg.y - lastGreen.y) ** 2 >= minGreenDist2;
    if (farEnough) {
      types[pegIndex] = 'green';
      lastGreen = peg;
      greenPlaced++;
      if (scan === ptr) ptr++;
    }
    scan++;
  }
  ptr = scan;
  if (ptr < count) types[indices[ptr]] = 'purple';

  return pegs.map((peg, i) => ({ ...peg, type: types[i] }));
}

function animationFromRow(nums) {
  const type = nums[1];
  if (type <= 0) return null;

  // Peggle.lua packs the active/reverse flag in the last decimal digit and
  // the starting phase in the remaining digits of animationDelay.
  const packedDelay = nums[7];
  const flag = ((packedDelay % 10) + 10) % 10;
  return {
    type,
    duration: Math.max(0.01, nums[6]),
    phase: (packedDelay - flag) / 4000,
    pingPong: flag > 1,
    active: flag === 1 || flag === 3,
    value1: nums[8],
    value2: nums[9],
    value3: nums[10],
    value4: nums[11],
  };
}

// Parse the untouched addon's 12-field rows. Coordinates intentionally stay
// Y-up here; games.js performs the single Y flip when creating the payload.
function parseLevels() {
  const raw = readFileSync(LUA_PATH, 'utf8');
  const tableStart = raw.indexOf('config.LEVELS = {');
  if (tableStart === -1) throw new Error('[peggle-levels] config.LEVELS not found');

  const content = raw.slice(tableStart);
  const result = [];
  const headerRe = /\[(\d+)\]\s*=\s*\{/g;
  let match;

  while ((match = headerRe.exec(content)) !== null) {
    const levelIndex = Number(match[1]);
    const start = match.index + match[0].length;
    let depth = 1;
    let cursor = start;
    while (cursor < content.length && depth > 0) {
      if (content[cursor] === '{') depth++;
      else if (content[cursor] === '}') depth--;
      cursor++;
    }

    const objects = [];
    const chunk = content.slice(start, cursor - 1);
    for (const row of chunk.matchAll(/\{([^}]+)\}/g)) {
      const nums = row[1].split(',').map((value) => Number(value.trim()));
      if (nums.length !== 12 || nums.some(Number.isNaN)) continue;

      const objectType = nums[2];
      const common = {
        x: nums[3],
        y: nums[4],
        animation: animationFromRow(nums),
      };

      if (objectType === 0) {
        objects.push({ ...common, shape: 'peg' });
      } else if (objectType === 1 || objectType === 2) {
        const encoded = nums[5];
        const encodedRadius = Math.floor(encoded / 1000);
        objects.push({
          ...common,
          shape: 'brick',
          rotation: encoded - encodedRadius * 1000,
          radiusKey: objectType === 1 ? Math.max(0, encodedRadius - 100) : 0,
        });
      }
    }

    result[levelIndex - 1] = {
      id: levelIndex,
      name: LEVEL_NAMES[levelIndex] ?? `Level ${levelIndex}`,
      pegs: objects, // Kept for wire compatibility; contains pegs and bricks.
    };
  }

  return result;
}

export const LEVELS = parseLevels();
