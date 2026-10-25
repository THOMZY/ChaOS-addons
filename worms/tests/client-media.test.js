import './site-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

async function createControllerScene(context) {
  const saved = new Map(),
    images = [],
    sounds = [],
    owners = [];
  function setGlobal(name, value) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  class Media extends EventTarget {
    src = '';
    paused = false;
    reloads = 0;
    constructor(url = '') {
      super();
      this.src = url;
    }
    pause() {
      this.paused = true;
    }
    load() {
      this.reloads++;
    }
    removeAttribute(name) {
      if (name === 'src') this.src = '';
    }
  }
  class Image extends Media {
    constructor() {
      super();
      images.push(this);
    }
  }
  class Audio extends Media {
    constructor(url) {
      super(url);
      sounds.push(this);
    }
  }
  const document = new EventTarget();
  document.getElementById = () => null;
  document.querySelector = () => null;
  setGlobal('document', document);
  setGlobal('window', new EventTarget());
  setGlobal('Image', Image);
  setGlobal('Audio', Audio);
  context.after(() => {
    for (const owner of owners) owner.stop();
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  const { initWorms } = await import('../client/worms.js');
  const create = () => {
    const socket = { connected: true, on() {}, off() {}, emit() {} };
    const owner = initWorms(
      socket,
      () => ({ userId: 'viewer' }),
      () => {},
    );
    owners.push(owner);
    return owner;
  };
  const activate = (owner) =>
    owner.activateWorms({ dataset: {}, textContent: '' }, () => {}, {
      spectate: true,
      roomId: 'room',
    });
  return { create, activate, images, sounds };
}

test('controller media stays lazy and retains the exact Worms asset routes', async (context) => {
  const scene = await createControllerScene(context),
    owner = scene.create();
  assert.equal(scene.images.length, 0);
  assert.equal(scene.sounds.length, 0);
  scene.activate(owner);
  assert.equal(scene.images.length, 60);
  assert.equal(scene.sounds.length, 36);
  assert.equal(scene.images.filter((image) => image.src.includes('/images/levels/')).length, 5);
  assert.ok(scene.images.some((image) => image.src === '/worms-assets/images/levels/level20.png'));
  assert.ok(scene.sounds.some((sound) => sound.src === '/worms-assets/sounds/JUMP1.WAV'));
  assert.ok(scene.sounds.some((sound) => sound.src === '/worms-assets/sounds/TIMERTICK.WAV'));
  assert.ok(
    scene.sounds.some((sound) => sound.src === '/worms-assets/sounds/Speech/Irish/traitor.wav'),
  );
  scene.activate(owner);
  assert.equal(scene.images.length, 60);
  assert.equal(scene.sounds.length, 36);
});

test('controller stop releases image and audio preloads', async (context) => {
  const scene = await createControllerScene(context),
    owner = scene.create();
  scene.activate(owner);
  owner.stop();
  owner.stop();
  assert.ok(
    scene.images.every((image) => image.src === ''),
    'retired images must no longer retain their source',
  );
  assert.ok(
    scene.sounds.every((sound) => sound.src === '' && sound.paused),
    'retired sound templates must release their source',
  );
});

test('controller replacement releases only its own preloads', async (context) => {
  const scene = await createControllerScene(context),
    first = scene.create();
  scene.activate(first);
  const retiredImages = [...scene.images],
    next = scene.create();
  scene.activate(next);
  assert.ok(
    retiredImages.every((image) => image.src === ''),
    'replacement must release old images',
  );
  first.stop();
  assert.ok(
    scene.images
      .slice(retiredImages.length)
      .every((image) => image.src.startsWith('/worms-assets/')),
  );
  next.stop();
  assert.ok(scene.images.every((image) => image.src === ''));
});
