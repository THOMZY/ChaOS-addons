export function createWormsCatalog({ translate }) {
  // ── World constants (must mirror server) ─────────────────────────────────────
  const WORLD_W = 960;
  const WORLD_H = 480;
  const WATER_Y = 455;
  const WORM_R = 10;
  const TURN_MS = 30_000;

  // ── Level definitions (must mirror server LEVELS order) ───────────────────────────
  const LEVELS = [
    {
      name: 'Treasure',
      file: 'level2',
      emoji: '🏕️',
      skyA: '#3a6186',
      skyB: '#89216b',
      skyC: '#ffd89b',
      stars: false,
    },
    {
      name: 'Jungle',
      file: 'castles',
      emoji: '🌿',
      skyA: '#134e5e',
      skyB: '#2b6b5b',
      skyC: '#71b280',
      stars: false,
    },
    {
      name: 'Ruins',
      file: 'level3',
      emoji: '🏰',
      skyA: '#485563',
      skyB: '#29323c',
      skyC: '#a8c0ff',
      stars: false,
    },
    {
      name: 'Battleship',
      file: 'level5',
      emoji: '⚓',
      skyA: '#1c3a5e',
      skyB: '#254b7a',
      skyC: '#4a90d9',
      stars: false,
    },
    {
      name: 'Titanic',
      file: 'level20',
      emoji: '🛤️',
      skyA: '#0a0a1a',
      skyB: '#0d1b3e',
      skyC: '#1a3a6e',
      stars: true,
    },
  ];

  const WEAPON_WORM_ANIM = {
    bazooka: {
      takeOut: { img: 'wbazlnk', frames: 10, ms: 50 },
      aim: { img: 'wbaz', frames: 32, ms: 60, frameY: 0.5 },
    },
    hand_grenade: {
      takeOut: { img: 'wgrnlnk', frames: 10, ms: 50 },
      aim: { img: 'wthrgrn', frames: 32, ms: 100, frameY: 0.5 },
    },
    cluster_bomb: {
      takeOut: { img: 'whgrlnk', frames: 10, ms: 50 },
      aim: { img: 'wthrhgr', frames: 32, ms: 100, frameY: 0.5 },
    },
    shotgun: {
      takeOut: { img: 'wshglnk', frames: 10, ms: 60 },
      aim: { img: 'wshotp', frames: 32, ms: 50, frameY: 0.5 },
    },
    minigun: {
      takeOut: { img: 'wmgnlnk', frames: 10, ms: 60 },
      aim: { img: 'wmini', frames: 32, ms: 60, frameY: 0.5 },
    },
    mortar: {
      takeOut: { img: 'wgrnlnk', frames: 10, ms: 50 },
      aim: { img: 'wthrgrn', frames: 32, ms: 100, frameY: 0.5 },
    },
    airstrike: {
      takeOut: { img: 'wgrnlnk', frames: 10, ms: 50 },
      aim: { img: 'wthrgrn', frames: 32, ms: 100, frameY: 0.5 },
    },
    drill: { takeOut: { img: 'wdrllnk', frames: 13, ms: 60 }, aim: null },
    dynamite: { takeOut: { img: 'wdynlnk', frames: 10, ms: 50 }, aim: null },
    holy_grenade: {
      takeOut: { img: 'whgrlnk', frames: 10, ms: 50 },
      aim: { img: 'wthrhgr', frames: 32, ms: 100, frameY: 0.5 },
    },
    banana_bomb: {
      takeOut: { img: 'whgrlnk', frames: 10, ms: 50 },
      aim: { img: 'wthrhgr', frames: 32, ms: 100, frameY: 0.5 },
    },
    napalm: {
      takeOut: { img: 'wgrnlnk', frames: 10, ms: 50 },
      aim: { img: 'wthrgrn', frames: 32, ms: 100, frameY: 0.5 },
    },
    land_mine: { takeOut: { img: 'wdynlnk', frames: 10, ms: 50 }, aim: null },
    ninja_rope: { takeOut: { img: 'wbazlnk', frames: 13, ms: 50 }, aim: null },
    jetpack: { takeOut: { img: 'wjetlnk', frames: 10, ms: 50 }, aim: null },
    bat: {
      takeOut: { img: 'wbatlnk', frames: 13, ms: 50 },
      aim: { img: 'wbataim', frames: 10, ms: 100, frameY: 0 },
    },
    teleport: { takeOut: { img: 'wgrnlnk', frames: 10, ms: 50 }, aim: null },
  };

  const WEAPONS = {
    bazooka: {
      icon: '🚀',
      labelKey: 'games.worms.weapon.bazooka',
      color: '#ff7700',
      trailColor: 'rgba(255,140,0,0.7)',
      key: '1',
    },
    hand_grenade: {
      icon: '💣',
      labelKey: 'games.worms.weapon.handGrenade',
      color: '#88cc44',
      trailColor: 'rgba(120,190,50,0.6)',
      key: '2',
    },
    cluster_bomb: {
      icon: '🧨',
      labelKey: 'games.worms.weapon.clusterBomb',
      color: '#ff5533',
      trailColor: 'rgba(255,100,50,0.6)',
      key: '3',
    },
    shotgun: {
      icon: '🔫',
      labelKey: 'games.worms.weapon.shotgun',
      color: '#99bbdd',
      trailColor: 'rgba(180,210,240,0.5)',
      key: '4',
    },
    minigun: {
      icon: '⚡',
      labelKey: 'games.worms.weapon.minigun',
      color: '#dddd22',
      trailColor: 'rgba(240,240,50,0.5)',
      key: '5',
    },
    mortar: {
      icon: '💥',
      labelKey: 'games.worms.weapon.mortar',
      color: '#cc8822',
      trailColor: 'rgba(200,140,30,0.6)',
      key: '6',
    },
    airstrike: {
      icon: '✈️',
      labelKey: 'games.worms.weapon.airstrike',
      color: '#66ccff',
      trailColor: 'rgba(100,200,255,0.6)',
      key: '7',
    },
    drill: {
      icon: '🔩',
      labelKey: 'games.worms.weapon.drill',
      color: '#cc8833',
      trailColor: 'rgba(180,130,50,0.5)',
      key: '8',
    },
    dynamite: {
      icon: '🧱',
      labelKey: 'games.worms.weapon.dynamite',
      color: '#ff2222',
      trailColor: 'rgba(255,50,0,0.6)',
      key: '9',
    },
    holy_grenade: {
      icon: '✝️',
      labelKey: 'games.worms.weapon.holyGrenade',
      color: '#ffffaa',
      trailColor: 'rgba(255,255,150,0.7)',
      key: '0',
    },
    banana_bomb: {
      icon: '🍌',
      labelKey: 'games.worms.weapon.bananaBomb',
      color: '#ffdd00',
      trailColor: 'rgba(255,220,0,0.6)',
      key: 'a',
    },
    napalm: {
      icon: '🔥',
      labelKey: 'games.worms.weapon.napalm',
      color: '#ff6600',
      trailColor: 'rgba(255,100,0,0.7)',
      key: 'e',
    },
    land_mine: {
      icon: '💠',
      labelKey: 'games.worms.weapon.landMine',
      color: '#888888',
      trailColor: 'rgba(150,150,150,0.5)',
      key: 'r',
    },
    ninja_rope: {
      icon: '🪝',
      labelKey: 'games.worms.weapon.ninjaRope',
      color: '#aaddaa',
      trailColor: 'rgba(150,220,150,0.7)',
      key: 't',
    },
    jetpack: {
      icon: '🚀',
      labelKey: 'games.worms.weapon.jetpack',
      color: '#44aaff',
      trailColor: 'rgba(100,200,255,0.5)',
      key: 'y',
    },
    bat: {
      icon: '⚾',
      labelKey: 'games.worms.weapon.bat',
      color: '#ffdd88',
      trailColor: 'rgba(255,220,100,0.6)',
      key: 'u',
    },
    teleport: {
      icon: '🌀',
      labelKey: 'games.worms.weapon.teleport',
      color: '#aa44ff',
      trailColor: 'rgba(170,100,255,0.6)',
      key: 'i',
    },
  };
  const FUSE_WEAPONS = new Set(['hand_grenade', 'cluster_bomb', 'banana_bomb']); // holy_grenade fixed 3 s
  const FUSE_SOUND_WEAPONS = new Set([
    'hand_grenade',
    'cluster_bomb',
    'holy_grenade',
    'banana_bomb',
  ]);
  const TARGETED_WEAPONS = new Set(['airstrike', 'napalm']);

  const WORMS_ASSETS = '/worms-assets';

  function getWeaponLabel(weapon) {
    const definition = WEAPONS[weapon];
    return definition
      ? `${definition.icon} ${translate(definition.labelKey)}`
      : String(weapon ?? '?');
  }
  const WEAPON_ICONS = {
    bazooka: 'iconbazooka',
    hand_grenade: 'icongrenade',
    cluster_bomb: 'iconhgrenade',
    shotgun: 'iconshotgun',
    minigun: 'iconminigun',
    mortar: 'icongrenade',
    airstrike: 'iconbazooka',
    drill: 'drill',
    dynamite: 'icondynamite',
    holy_grenade: 'iconhgrenade',
    banana_bomb: 'iconsheep',
    napalm: 'iconblowtorch',
    land_mine: 'iconmine',
    ninja_rope: 'iconrope',
    jetpack: 'iconjetpack',
    bat: 'iconbat',
    teleport: 'iconteleport',
  };

  function getWeaponDefinition(key) {
    return typeof key === 'string' && Object.hasOwn(WEAPONS, key)
      ? Reflect.get(WEAPONS, key)
      : null;
  }

  function getWeaponAnimation(key) {
    return typeof key === 'string' && Object.hasOwn(WEAPON_WORM_ANIM, key)
      ? Reflect.get(WEAPON_WORM_ANIM, key)
      : null;
  }

  function getWeaponIconName(key) {
    return typeof key === 'string' && Object.hasOwn(WEAPON_ICONS, key)
      ? Reflect.get(WEAPON_ICONS, key)
      : null;
  }

  // JSON / Socket.IO serializes Infinity as null. Both values represent an
  // unlimited weapon in the authoritative server inventory.
  function hasUnlimitedAmmo(count) {
    return count === undefined || count === null || count === Infinity;
  }

  function getLevel(index) {
    return Number.isInteger(index) && index >= 0 && index < LEVELS.length
      ? (LEVELS.at(index) ?? LEVELS.at(0))
      : LEVELS.at(0);
  }

  return {
    world: {
      width: WORLD_W,
      height: WORLD_H,
      waterY: WATER_Y,
      wormRadius: WORM_R,
      turnMs: TURN_MS,
    },
    levels: LEVELS,
    weapons: WEAPONS,
    weaponAnimations: WEAPON_WORM_ANIM,
    weaponIcons: WEAPON_ICONS,
    fuseWeapons: FUSE_WEAPONS,
    fuseSoundWeapons: FUSE_SOUND_WEAPONS,
    targetedWeapons: TARGETED_WEAPONS,
    assetsBase: WORMS_ASSETS,
    getWeaponLabel,
    getWeaponDefinition,
    getWeaponAnimation,
    getWeaponIconName,
    hasUnlimitedAmmo,
    getLevel,
  };
}
