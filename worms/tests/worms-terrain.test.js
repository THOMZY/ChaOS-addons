import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTerrainMaskFromHeights, createWormsTerrain } from '../client/worms-terrain.js';

function createScene(overrides = {}) {
  const calls = [],
    canvases = [],
    images = new Map();
  let isActive = true,
    stateReads = 0;
  const state = { terrain: [1, 2, 4, 0], holes: [], waterLevel: 3, suddenDeath: false };
  const levels = [
    { file: 'first', skyA: '#112233', skyB: '#445566', skyC: '#778899', stars: false },
    { file: 'second', skyA: '#112233', skyB: '#445566', skyC: '#778899', stars: true },
  ];
  function addImage(name, complete = false) {
    const handlers = new Map(),
      captured = [];
    const image = {
      name,
      complete,
      naturalWidth: complete ? 4 : 0,
      handlers,
      captured,
      onload: () => {},
      addEventListener(type, callback) {
        handlers.set(type, callback);
        captured.push([type, callback]);
      },
      removeEventListener(type, callback) {
        if (handlers.get(type) === callback) handlers.delete(type);
      },
      fire(type) {
        handlers.get(type)?.();
      },
    };
    images.set(name, image);
    return image;
  }
  addImage('level_first');
  addImage('level_second');
  function makeContext() {
    const properties = { globalAlpha: 1, globalCompositeOperation: 'source-over' },
      stack = [];
    const methods = {
      createLinearGradient(...args) {
        const gradient = {
          stops: [],
          addColorStop(...stop) {
            gradient.stops.push(stop);
          },
        };
        calls.push(['gradient', ...args, gradient]);
        return gradient;
      },
      createPattern(image, repeat) {
        calls.push(['pattern', image.name, repeat]);
        return overrides.pattern === undefined ? 'water-pattern' : overrides.pattern;
      },
      save() {
        stack.push({ ...properties });
        calls.push(['save']);
      },
      restore() {
        Object.assign(properties, stack.pop());
        calls.push(['restore']);
      },
      fill() {
        calls.push([
          'fill',
          properties.fillStyle,
          properties.globalCompositeOperation,
          properties.globalAlpha,
        ]);
      },
      drawImage(image, ...args) {
        calls.push(['drawImage', image.name ?? image.id, ...args]);
      },
    };
    for (const name of [
      'clearRect',
      'beginPath',
      'moveTo',
      'lineTo',
      'closePath',
      'stroke',
      'fillRect',
      'setLineDash',
      'arc',
    ])
      methods[name] = (...args) => calls.push([name, ...args]);
    return new Proxy(methods, {
      get(target, key) {
        return Object.hasOwn(target, key) ? target[key] : properties[key];
      },
      set(_target, key, value) {
        properties[key] = value;
        calls.push(['set', key, value]);
        return true;
      },
    });
  }
  const options = {
    width: 4,
    height: 4,
    getState: () => {
      stateReads++;
      overrides.onRead?.();
      return state;
    },
    getImage: (name) => {
      overrides.onImage?.(name);
      return images.get(name) ?? null;
    },
    getLevel: (index) => levels[index] ?? levels[0],
    isActive: () => isActive,
    now: () => Math.PI * 100,
    createCanvas: () => {
      const context = makeContext(),
        canvas = {
          id: 'canvas-' + canvases.length,
          width: 300,
          height: 150,
          getContext: () => context,
          context,
        };
      canvases.push(canvas);
      overrides.onCanvas?.(canvas);
      return canvas;
    },
    ...overrides.options,
  };
  const owner = createWormsTerrain(options);
  const prepare = (data = {}) => owner.prepare({ terrain: state.terrain, ...data }, '00000001');
  return {
    owner,
    state,
    images,
    calls,
    canvases,
    addImage,
    makeContext,
    prepare,
    stateReads: () => stateReads,
    setActive: (value) => {
      isActive = value;
    },
  };
}

test('the collision mask preserves authoritative heights, missing columns and clamping', () => {
  assert.deepEqual(
    [...buildTerrainMaskFromHeights([1, 2, 4, 0], 4, 4)],
    [0, 0, 0, 1, 1, 0, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1],
  );
  assert.deepEqual([...buildTerrainMaskFromHeights([-1, 9], 3, 2)], [1, 0, 0, 1, 0, 0]);
});

test('construction and terminal pre-start operations read no state and allocate no canvas', () => {
  const scene = createScene();
  scene.owner.redraw();
  scene.owner.drawBackground(scene.makeContext(), 0.1);
  scene.owner.stop();
  scene.owner.stop();
  scene.prepare();
  scene.owner.mount();
  assert.equal(scene.stateReads(), 0);
  assert.equal(scene.canvases.length, 0);
  assert.equal(scene.images.get('level_first').handlers.size, 0);
  assert.deepEqual(scene.owner.status(), {
    isStopped: true,
    hasPrepared: false,
    hasCanvas: false,
    hasContext: false,
    hasImageListener: false,
    clouds: 0,
  });
});

test('preparing a round returns the mask and owns image events without allocating a canvas', () => {
  const scene = createScene(),
    image = scene.images.get('level_first'),
    foreign = image.onload;
  assert.deepEqual([...scene.prepare()], [0, 0, 0, 1, 1, 0, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1]);
  assert.equal(scene.canvases.length, 0);
  assert.equal(scene.owner.status().clouds, 18);
  assert.equal(image.handlers.size, 2);
  assert.equal(image.onload, foreign);
  scene.owner.stop();
  assert.equal(image.onload, foreign);
});

test('missing terrain keeps the collision mask absent and an already-loaded image needs no listener', () => {
  const scene = createScene();
  const image = scene.images.get('level_first');
  image.complete = true;
  image.naturalWidth = 4;
  assert.equal(scene.prepare({ terrain: null }), null);
  assert.equal(image.handlers.size, 0);
  scene.owner.mount();
  assert.ok(scene.calls.some((call) => call[0] === 'drawImage' && call[1] === 'level_first'));
  scene.owner.stop();
});

test('mount paints the procedural fallback with the original gradient and water geometry', () => {
  const scene = createScene();
  scene.prepare();
  scene.owner.mount();
  const canvas = scene.canvases[0];
  assert.equal(canvas.width, 4);
  assert.equal(canvas.height, 4);
  assert.deepEqual(scene.calls.find((call) => call[0] === 'gradient').at(-1).stops, [
    [0, '#7a5020'],
    [0.3, '#5a3810'],
    [1, '#3a240a'],
  ]);
  assert.ok(
    scene.calls.some((call) => JSON.stringify(call) === JSON.stringify(['fillRect', 0, 3, 4, 1])),
  );
  assert.ok(scene.calls.some((call) => JSON.stringify(call) === JSON.stringify(['lineTo', 1, 2])));
  scene.owner.stop();
});

test('a level image load replaces the fallback and releases only owned callbacks', () => {
  const scene = createScene();
  scene.prepare();
  scene.owner.mount();
  scene.calls.length = 0;
  const image = scene.images.get('level_first');
  image.complete = true;
  image.naturalWidth = 4;
  image.fire('load');
  assert.ok(scene.calls.some((call) => call[0] === 'drawImage' && call[1] === 'level_first'));
  assert.equal(image.handlers.size, 0);
  assert.equal(scene.owner.status().hasImageListener, false);
  scene.owner.stop();
});

test('holes are erased opaquely after the base and before the water pattern', () => {
  const scene = createScene();
  scene.state.holes = [{ cx: 2, cy: 2, r: 1 }];
  scene.addImage('water3', true);
  scene.prepare();
  scene.owner.mount();
  const erased = scene.calls.findIndex(
    (call) => call[0] === 'fill' && call[2] === 'destination-out',
  );
  assert.ok(erased >= 0);
  assert.equal(scene.calls[erased][1], '#000000');
  assert.ok(scene.calls.findIndex((call) => call[0] === 'pattern') > erased);
  assert.ok(
    scene.calls.some(
      (call) => JSON.stringify(call) === JSON.stringify(['set', 'globalAlpha', 0.82]),
    ),
  );
  assert.equal(scene.canvases[0].context.globalAlpha, 1);
  assert.equal(scene.canvases[0].context.globalCompositeOperation, 'source-over');
  scene.owner.stop();
});

test('a null water pattern does not add a procedural fallback behind the loaded image', () => {
  const scene = createScene({ pattern: null });
  scene.addImage('water3', true);
  scene.prepare();
  scene.owner.mount();
  assert.equal(scene.calls.filter((call) => call[0] === 'fillRect').length, 0);
  scene.owner.stop();
});

test('rising water and sudden-death dash, color and phase remain unchanged', () => {
  const scene = createScene();
  scene.state.waterLevel = 2;
  scene.state.suddenDeath = true;
  scene.prepare();
  scene.owner.mount();
  assert.ok(
    scene.calls.some((call) => JSON.stringify(call) === JSON.stringify(['fillRect', 0, 2, 4, 2])),
  );
  assert.ok(
    scene.calls.some((call) => JSON.stringify(call) === JSON.stringify(['setLineDash', [8, 6]])),
  );
  assert.ok(
    scene.calls.some(
      (call) => JSON.stringify(call) === JSON.stringify(['set', 'strokeStyle', '#ff3300']),
    ),
  );
  assert.ok(
    scene.calls.some(
      (call) => call[0] === 'set' && call[1] === 'globalAlpha' && Math.abs(call[2] - 1) < 1e-10,
    ),
  );
  scene.owner.stop();
});

test('the same room seed preserves sky, stars, cloud geometry and their progression', () => {
  const first = createScene(),
    second = createScene();
  first.prepare({ levelIndex: 1 });
  second.prepare({ levelIndex: 1 });
  first.owner.mount();
  second.owner.mount();
  first.calls.length = 0;
  second.calls.length = 0;
  first.owner.drawBackground(first.makeContext(), 0.25);
  second.owner.drawBackground(second.makeContext(), 0.25);
  assert.deepEqual(
    JSON.parse(JSON.stringify(first.calls)),
    JSON.parse(JSON.stringify(second.calls)),
  );
  assert.equal(first.calls.filter((call) => call[0] === 'arc').length, 90 + 18 * 6);
  const arcs = first.calls.filter((call) => call[0] === 'arc');
  for (const [actual, expected] of [
    [arcs[0].slice(1, 4), [0.9535731496289372, 2.1392526987940075, 1.613340072799474]],
    [arcs[90].slice(1, 4), [3.453046845505014, 39.811453215777874, 10.194569027097895]],
  ])
    actual.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 1e-12));
  assert.deepEqual(first.calls.find((call) => call[0] === 'gradient').at(-1).stops, [
    [0, '#112233'],
    [0.45, '#445566'],
    [1, '#778899'],
  ]);
  const before = first.calls.filter((call) => call[0] === 'arc').map((call) => call[1]);
  first.calls.length = 0;
  first.owner.drawBackground(first.makeContext(), 0.25);
  assert.notDeepEqual(
    first.calls.filter((call) => call[0] === 'arc').map((call) => call[1]),
    before,
  );
  first.owner.stop();
  second.owner.stop();
});

test('the retained level callback cannot repaint the following round', () => {
  const scene = createScene();
  scene.prepare();
  scene.owner.mount();
  const old = scene.images.get('level_first').handlers.get('load'),
    oldCanvas = scene.canvases[0];
  scene.prepare({ levelIndex: 1 });
  scene.owner.mount();
  scene.calls.length = 0;
  old();
  assert.equal(scene.calls.length, 0);
  assert.equal(oldCanvas.width, 0);
  assert.equal(oldCanvas.height, 0);
  assert.equal(scene.images.get('level_first').handlers.size, 0);
  assert.equal(scene.images.get('level_second').handlers.size, 2);
  scene.owner.stop();
});

test('round reset releases the bitmap, image listeners and clouds but permits a fresh round', () => {
  const scene = createScene();
  scene.prepare();
  scene.owner.mount();
  const image = scene.images.get('level_first'),
    callback = image.handlers.get('load'),
    canvas = scene.canvases[0];
  scene.owner.reset();
  scene.calls.length = 0;
  callback();
  scene.owner.redraw();
  assert.equal(scene.calls.length, 0);
  assert.equal(canvas.width, 0);
  assert.equal(canvas.height, 0);
  assert.equal(image.handlers.size, 0);
  assert.equal(scene.owner.status().clouds, 0);
  scene.prepare({ theme: 1 });
  scene.owner.mount();
  assert.equal(scene.canvases.length, 2);
  assert.equal(scene.owner.status().hasCanvas, true);
  scene.owner.stop();
});

test('an image error releases listeners and keeps the height-based fallback', () => {
  const scene = createScene();
  scene.prepare();
  scene.owner.mount();
  scene.images.get('level_first').fire('error');
  assert.equal(scene.owner.status().hasImageListener, false);
  assert.equal(scene.images.get('level_first').handlers.size, 0);
  scene.owner.redraw();
  assert.ok(scene.calls.some((call) => call[0] === 'lineTo'));
  scene.owner.stop();
});

test('stop is terminal and old callbacks cannot paint or allocate a new bitmap', () => {
  const scene = createScene();
  scene.prepare();
  scene.owner.mount();
  const old = scene.images.get('level_first').handlers.get('load');
  scene.owner.stop();
  scene.calls.length = 0;
  old();
  scene.prepare();
  scene.owner.mount();
  scene.owner.redraw();
  scene.owner.drawBackground(scene.makeContext(), 0.1);
  assert.equal(scene.calls.length, 0);
  assert.equal(scene.canvases.length, 1);
  assert.equal(scene.owner.status().hasPrepared, false);
});

test('stop during state access prevents drawing into the retired context', () => {
  let scene;
  scene = createScene({ onRead: () => scene.owner.stop() });
  scene.prepare();
  scene.owner.mount();
  assert.equal(scene.calls.length, 0);
  assert.equal(scene.canvases[0].width, 0);
  assert.equal(scene.owner.status().hasContext, false);
});

test('stop during canvas allocation releases its returned bitmap', () => {
  let scene;
  scene = createScene({ onCanvas: () => scene.owner.stop() });
  scene.prepare();
  scene.owner.mount();
  assert.equal(scene.canvases[0].width, 0);
  assert.equal(scene.canvases[0].height, 0);
  assert.equal(scene.owner.status().hasCanvas, false);
});

test('separate terrain owners do not release or invalidate each other', () => {
  const first = createScene(),
    second = createScene();
  first.prepare();
  second.prepare();
  first.owner.mount();
  second.owner.mount();
  first.owner.stop();
  const count = second.calls.length;
  second.owner.redraw();
  assert.ok(second.calls.length > count);
  assert.equal(second.canvases[0].width, 4);
  assert.equal(second.images.get('level_first').handlers.size, 2);
  second.owner.stop();
});

test('a stopped parent guard cannot revive a prepared round', () => {
  let scene;
  scene = createScene({
    options: {
      isActive: () => {
        scene.owner.stop();
        return true;
      },
    },
  });
  assert.equal(scene.prepare(), null);
  assert.equal(scene.owner.status().hasPrepared, false);
  assert.equal(scene.owner.status().clouds, 0);
});

test('stop during image lookup cannot draw into the retired bitmap', () => {
  let scene,
    retiredAt = 0;
  scene = createScene({
    onImage: () => {
      if (scene.owner.status().hasCanvas) {
        scene.owner.stop();
        retiredAt = scene.calls.length;
      }
    },
  });
  scene.prepare();
  scene.owner.mount();
  assert.equal(scene.calls.length, retiredAt);
  assert.equal(scene.owner.status().hasCanvas, false);
});

test('stop during water lookup prevents the remaining water and warning strokes', () => {
  let scene,
    retiredAt = 0;
  scene = createScene({
    onImage: (name) => {
      if (name === 'water3') {
        scene.owner.stop();
        retiredAt = scene.calls.length;
      }
    },
  });
  scene.state.suddenDeath = true;
  scene.prepare();
  scene.owner.mount();
  assert.equal(scene.calls.length, retiredAt);
  assert.equal(scene.owner.status().hasCanvas, false);
});
