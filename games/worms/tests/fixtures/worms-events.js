import { createWormsEvents } from '../../client/worms-events.js';

export function createScene(options = {}) {
  let owner,
    reads = 0,
    nextId = 1,
    isActive = true;
  const actions = [],
    sent = [],
    warnings = [],
    scheduled = new Map(),
    history = [],
    captured = new Map(),
    handlers = new Map();
  const state = {
    mode: 'game',
    roomId: 'one',
    isSpectateMode: false,
    myUserId: 'a',
    lastBet: 5,
    hasRoot: true,
    hasExit: true,
    openRooms: [],
    liveRooms: [],
    worms: [{ id: 'w', name: '<Alice>', playerId: 'a', cx: 100, cy: 200, alive: true, hp: 100 }],
    players: [{ userId: 'a', pseudo: '<Alice>' }],
    isAnimating: false,
    chargeStart: 10,
    ammo: {},
    projectiles: [],
    selectedWeapon: 'bazooka',
    activeWormId: 'w',
    dynamites: [],
    mines: [],
    wormBumps: new Map(),
    pendingNextTurn: null,
    isRetreating: false,
    retreatEnd: 0,
    hasShotFired: true,
    hasMovementToolUsed: true,
    rope: {},
    isJetpackActive: true,
    crates: [],
    holes: [],
  };
  const socket = {
    on(name, callback) {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name).add(callback);
      if (!captured.has(name)) captured.set(name, []);
      captured.get(name).push(callback);
      options.onBind?.(owner, name);
    },
    off(name, callback) {
      handlers.get(name)?.delete(callback);
      if (!handlers.get(name)?.size) handlers.delete(name);
      options.onOff?.(owner, name);
    },
    emit(...args) {
      sent.push(args);
      options.onEmit?.(owner);
    },
    fire(name, payload) {
      for (const callback of [...(handlers.get(name) ?? [])]) callback(payload);
    },
    handlers,
    captured,
  };
  function allocate(callback, delay, isInterval) {
    const id = options.reuseId ?? nextId++;
    const entry = { id, callback, delay, isInterval };
    scheduled.set(id, entry);
    history.push(entry);
    options.onTimer?.(owner, entry);
    return id;
  }
  function clear(id) {
    scheduled.delete(id);
    options.onClear?.(owner, id);
  }
  const timers = {
    setTimeout: (fn, delay) => allocate(fn, delay, false),
    clearTimeout: clear,
    setInterval: (fn, delay) => allocate(fn, delay, true),
    clearInterval: clear,
  };
  const names = [
    'noteRoomOpen',
    'noteRoomClosed',
    'upsertRoom',
    'enterWaitingRoom',
    'renderLobby',
    'renderWaiting',
    'setupGame',
    'stopGame',
    'renderResults',
    'exit',
    'updateWeaponBtns',
    'playSound',
    'playRandomSpeech',
    'applyTerrainHoles',
    'playHoleExplosions',
    'spawnParticles',
    'bumpDamagedWorms',
    'applyWormStates',
    'addDamageLabels',
    'updateHealthBar',
    'applyNextTurn',
    'weaponLabel',
    'updateHUD',
    'initWsTurn',
    'notify',
    'onExit',
    'clearSprites',
    'markRematchWaiting',
  ];
  const services = Object.fromEntries(
    names.map((name) => [
      name,
      (...args) => {
        actions.push([name, ...args]);
        options.onService?.(name, owner, state, args);
        if (name === 'stopGame' || name === 'setupGame' || name === 'exit') owner.reset();
        if (name === 'applyTerrainHoles') {
          const holes = args[0] ?? [];
          state.holes.push(...holes);
          return holes;
        }
        if (name === 'playHoleExplosions') return (args[0]?.length ?? 0) > 0;
        if (name === 'weaponLabel') return 'weapon:' + args[0];
      },
    ]),
  );
  owner = createWormsEvents({
    socket,
    getState() {
      reads++;
      options.onState?.(owner);
      return state;
    },
    services,
    timers,
    translate(key, values) {
      options.onTranslate?.(owner);
      return key + (values ? ':' + JSON.stringify(values) : '');
    },
    fuseWeapons: new Set(['hand_grenade', 'cluster_bomb', 'holy_grenade', 'banana_bomb']),
    now: () => 100,
    wallNow: () => 10000,
    isActive: () => isActive,
    logger: { warn: (...args) => warnings.push(args) },
  });
  function fireTimer(id) {
    const entry = scheduled.get(id);
    if (!entry) throw new Error('Missing timer ' + id);
    if (!entry.isInterval) scheduled.delete(id);
    entry.callback();
  }
  return {
    owner,
    state,
    socket,
    services,
    timers,
    actions,
    sent,
    warnings,
    scheduled,
    history,
    get reads() {
      return reads;
    },
    deactivate() {
      isActive = false;
    },
    fireTimer,
    runTimeout(delay) {
      const entry = [...scheduled.values()].find(
        (entry) => !entry.isInterval && entry.delay === delay,
      );
      if (!entry) throw new Error('Missing timeout ' + delay);
      fireTimer(entry.id);
    },
  };
}
