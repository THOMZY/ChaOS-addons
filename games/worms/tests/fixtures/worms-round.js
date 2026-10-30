import { createWormsRound } from '../../client/worms-round.js';

export function createScene(options = {}) {
  let owner,
    nextFrame = 1,
    nextTimer = 1,
    isActive = true;
  const frames = new Map(),
    timers = new Map(),
    history = [],
    actions = [],
    order = [],
    warnings = [];
  const camera = { x: 99, y: 88, tx: 77, ty: 66 },
    data = { worms: [{ id: 'w', cx: 300 }], activeWormId: 'w' };
  const serviceNames = [
    'clearMenu',
    'clearSprites',
    'markGameMode',
    'resetData',
    'prepareTerrain',
    'mountView',
    'updateHealth',
    'initTurn',
    'bindInput',
    'step',
    'render',
    'tickDamage',
    'updateHUD',
    'playSound',
  ];
  const services = Object.fromEntries(
    serviceNames.map((name) => [
      name,
      (...args) => {
        order.push(name);
        actions.push([name, ...args]);
        options.onService?.(name, owner, args);
        if (name === 'mountView') return options.hasView !== false;
        if (name === 'bindInput') return options.hasInput !== false;
      },
    ]),
  );
  const frameAPI = {
    request(callback) {
      const id = options.frameId ?? nextFrame++;
      frames.set(id, callback);
      history.push({ kind: 'frame', id, callback });
      order.push('requestFrame');
      options.onFrame?.(owner);
      return id;
    },
    cancel(id) {
      frames.delete(id);
      options.onCancel?.(owner);
    },
  };
  const timerAPI = {
    setTimeout(callback, delay) {
      const id = options.timerId ?? nextTimer++;
      timers.set(id, { callback, delay });
      history.push({ kind: 'timer', id, callback, delay });
      order.push('setTimeout');
      options.onTimer?.(owner);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
      options.onClear?.(owner);
    },
  };
  owner = createWormsRound({
    services,
    camera,
    frames: frameAPI,
    timers: timerAPI,
    now() {
      options.onNow?.(owner);
      return 1000;
    },
    isActive: () => isActive,
    logger: { warn: (...args) => warnings.push(args) },
  });
  return {
    owner,
    services,
    camera,
    data,
    frames,
    timers,
    history,
    actions,
    order,
    warnings,
    frameAPI,
    timerAPI,
    deactivate() {
      isActive = false;
    },
    runFrame(time) {
      const [id, callback] = frames.entries().next().value;
      frames.delete(id);
      callback(time);
    },
    runSound() {
      const [id, entry] = timers.entries().next().value;
      timers.delete(id);
      entry.callback();
    },
  };
}
