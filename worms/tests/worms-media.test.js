import test from 'node:test';
import assert from 'node:assert/strict';
import { createWormsMedia } from '../client/worms-media.js';

function createScene(overrides = {}) {
  const images = [],
    sounds = [],
    clones = [],
    warnings = [],
    choices = [];
  let isMuted = false,
    isActive = true;
  class Media {
    constructor(src = '') {
      this.src = src;
      this.handlers = new Map();
      this.pauses = 0;
      this.loads = 0;
    }
    addEventListener(type, callback) {
      this.handlers.set(type, callback);
    }
    removeEventListener(type, callback) {
      if (this.handlers.get(type) === callback) this.handlers.delete(type);
    }
    removeAttribute(name) {
      if (name === 'src') this.src = '';
    }
    pause() {
      this.pauses++;
    }
    load() {
      this.loads++;
    }
    cloneNode() {
      const clone = new Media(this.src);
      clones.push(clone);
      overrides.onClone?.(clone);
      return clone;
    }
    play() {
      overrides.onPlay?.(this);
      return overrides.play?.(this) ?? Promise.resolve();
    }
    fire(type) {
      this.handlers.get(type)?.();
    }
  }
  const options = {
    levels: [{ file: 'level2' }, { file: 'castles' }],
    randomIndex: (count) => {
      choices.push(count);
      return count - 1;
    },
    isMuted: () => isMuted,
    isActive: () => isActive,
    createImage: () => {
      const image = new Media();
      images.push(image);
      overrides.onImage?.(image);
      return image;
    },
    createAudio: (url) => {
      const sound = new Media(url);
      sounds.push(sound);
      overrides.onAudio?.(sound);
      return sound;
    },
    logger: { warn: (...args) => warnings.push(args) },
    ...overrides.options,
  };
  const owner = createWormsMedia(options);
  return {
    owner,
    images,
    sounds,
    clones,
    warnings,
    choices,
    setMuted: (value) => {
      isMuted = value;
    },
    setActive: (value) => {
      isActive = value;
    },
  };
}

const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

test('construction and terminal pre-start calls allocate no media or random work', () => {
  const scene = createScene();
  assert.deepEqual(scene.owner.status(), {
    isStopped: false,
    hasStarted: false,
    images: 0,
    sounds: 0,
    playing: 0,
  });
  scene.owner.stop();
  scene.owner.stop();
  scene.owner.ensureAssets();
  scene.owner.playSound('fuse');
  scene.owner.playRandomSpeech('fire');
  scene.owner.playExplosionSound();
  assert.deepEqual(scene.images, []);
  assert.deepEqual(scene.sounds, []);
  assert.deepEqual(scene.choices, []);
});

test('preload is idempotent and preserves asset names, cases and template preload mode', () => {
  const scene = createScene();
  scene.owner.ensureAssets();
  scene.owner.ensureAssets();
  assert.equal(scene.images.length, 57);
  assert.equal(scene.sounds.length, 36);
  assert.equal(
    scene.owner.getImage('level_castles').src,
    '/worms-assets/images/levels/castles.png',
  );
  assert.equal(
    scene.owner.getImage('iconrope').src,
    '/worms-assets/images/weaponicons/iconrope.png',
  );
  assert.deepEqual(
    scene.sounds.filter((sound) => sound.src.endsWith('.WAV')).map((sound) => sound.src),
    ['/worms-assets/sounds/JUMP1.WAV', '/worms-assets/sounds/TIMERTICK.WAV'],
  );
  assert.ok(scene.sounds.every((sound) => sound.preload === 'auto'));
  assert.equal(scene.owner.getImage('__proto__'), null);
  assert.equal(scene.owner.getImage('constructor'), null);
  assert.equal(scene.owner.getImage(null), null);
  scene.owner.stop();
});

test('playback clones templates with the default volume and owns both completion listeners', () => {
  const scene = createScene();
  scene.owner.ensureAssets();
  scene.owner.playSound('fuse');
  const clone = scene.clones[0];
  assert.equal(clone.volume, 0.45);
  assert.equal(clone.src, '/worms-assets/sounds/fuse.wav');
  assert.equal(clone.handlers.size, 2);
  assert.equal(scene.owner.status().playing, 1);
  clone.fire('ended');
  assert.equal(scene.owner.status().playing, 0);
  assert.equal(clone.handlers.size, 0);
  assert.equal(clone.src, '');
  assert.ok(scene.sounds.find((sound) => sound.src.endsWith('/fuse.wav')));
  scene.owner.stop();
});

test('overlapping sounds retain their own volume and cleanup', () => {
  const scene = createScene();
  scene.owner.ensureAssets();
  scene.owner.playSound('fuse', 0.6);
  scene.owner.playSound('fuse', 0.2);
  assert.equal(scene.owner.status().playing, 2);
  assert.deepEqual(
    scene.clones.map((clone) => clone.volume),
    [0.6, 0.2],
  );
  scene.clones[0].fire('error');
  assert.equal(scene.owner.status().playing, 1);
  assert.ok(scene.clones[1].src);
  scene.owner.stop();
});

test('muted, inactive and unknown names do not allocate a clone', () => {
  const scene = createScene();
  scene.owner.ensureAssets();
  scene.setMuted(true);
  scene.owner.playSound('fuse');
  scene.setMuted(false);
  scene.setActive(false);
  scene.owner.playSound('fuse');
  scene.setActive(true);
  for (const name of ['missing', '__proto__', 'constructor', 'toString', null])
    scene.owner.playSound(name);
  assert.deepEqual(scene.clones, []);
  scene.owner.stop();
});

test('speech groups and explosion selection retain their random bounds and volumes', () => {
  const scene = createScene();
  scene.owner.ensureAssets();
  for (const name of ['fire', 'ohdear', 'byebye', 'yessir', 'victory', 'hurry', 'traitor'])
    scene.owner.playRandomSpeech(name);
  scene.owner.playRandomSpeech('__proto__');
  scene.owner.playRandomSpeech('missing');
  scene.owner.playExplosionSound();
  assert.deepEqual(scene.choices, [4, 5, 3, 1, 1, 1, 1, 3]);
  assert.deepEqual(
    scene.clones.map((clone) => clone.src.split('/').at(-1)),
    [
      'grenade.wav',
      'youllregretthat.wav',
      'laugh.wav',
      'yessir.wav',
      'victory.wav',
      'hurry.wav',
      'traitor.wav',
      'explosion3.wav',
    ],
  );
  assert.deepEqual(
    scene.clones.map((clone) => clone.volume),
    [0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.6, 0.45],
  );
  scene.owner.stop();
});

test('rejected playback releases listeners and the clone without unhandled rejection', async () => {
  const scene = createScene({ play: () => Promise.reject(new Error('autoplay denied')) });
  scene.owner.ensureAssets();
  scene.owner.playSound('fuse');
  await settle();
  assert.equal(scene.owner.status().playing, 0);
  assert.equal(scene.clones[0].handlers.size, 0);
  assert.equal(scene.clones[0].src, '');
  scene.owner.stop();
});

test('synchronous playback failure releases the clone already allocated', () => {
  const scene = createScene({
    play: () => {
      throw new Error('interrupted');
    },
  });
  scene.owner.ensureAssets();
  scene.owner.playSound('fuse');
  assert.equal(scene.owner.status().playing, 0);
  assert.equal(scene.clones[0].handlers.size, 0);
  assert.equal(scene.clones[0].src, '');
  scene.owner.stop();
});

test('terminal stop clears every image, sound template, clone and completion listener', () => {
  const scene = createScene();
  scene.owner.ensureAssets();
  scene.owner.playSound('fuse');
  const captured = scene.clones[0].handlers.get('ended');
  scene.owner.stop();
  const pauses = scene.clones[0].pauses;
  captured();
  scene.owner.stop();
  scene.owner.ensureAssets();
  assert.deepEqual(scene.owner.status(), {
    isStopped: true,
    hasStarted: true,
    images: 0,
    sounds: 0,
    playing: 0,
  });
  assert.ok([...scene.images, ...scene.sounds, ...scene.clones].every((media) => media.src === ''));
  assert.equal(scene.clones[0].handlers.size, 0);
  assert.equal(scene.clones[0].pauses, pauses);
});

test('late playback rejection cannot release a replacement owner', async () => {
  let rejectPlay;
  const first = createScene({
    play: () =>
      new Promise((_resolve, reject) => {
        rejectPlay = reject;
      }),
  });
  const next = createScene();
  first.owner.ensureAssets();
  first.owner.playSound('fuse');
  const clone = first.clones[0];
  first.owner.stop();
  const pauses = clone.pauses;
  next.owner.ensureAssets();
  next.owner.playSound('fuse');
  rejectPlay(new Error('aborted'));
  await settle();
  assert.equal(clone.pauses, pauses);
  assert.equal(next.owner.status().playing, 1);
  assert.ok(next.clones[0].src);
  next.owner.stop();
});

test('stop during image construction releases the returned image and abandons the remaining preload', () => {
  let scene;
  scene = createScene({ onImage: () => scene.owner.stop() });
  scene.owner.ensureAssets();
  assert.equal(scene.images.length, 1);
  assert.equal(scene.images[0].src, '');
  assert.equal(scene.sounds.length, 0);
  assert.equal(scene.owner.status().images, 0);
});

test('stop during audio construction releases the returned template', () => {
  let scene;
  scene = createScene({ onAudio: () => scene.owner.stop() });
  scene.owner.ensureAssets();
  assert.equal(scene.sounds.length, 1);
  assert.equal(scene.sounds[0].src, '');
  assert.ok(scene.images.every((image) => image.src === ''));
  assert.equal(scene.owner.status().sounds, 0);
});

test('stop during clone creation cannot restart playback or retain the returned clone', () => {
  let scene;
  scene = createScene({ onClone: () => scene.owner.stop() });
  scene.owner.ensureAssets();
  scene.owner.playSound('fuse');
  assert.equal(scene.clones[0].src, '');
  assert.equal(scene.clones[0].handlers.size, 0);
  assert.equal(scene.owner.status().playing, 0);
});

test('one media cleanup failure does not prevent release of the other resources', () => {
  const scene = createScene();
  scene.owner.ensureAssets();
  scene.owner.playSound('fuse');
  scene.clones[0].pause = () => {
    throw new Error('already detached');
  };
  scene.owner.stop();
  assert.equal(scene.warnings.length, 1);
  assert.ok([...scene.images, ...scene.sounds, ...scene.clones].every((media) => media.src === ''));
  assert.equal(scene.owner.status().playing, 0);
});

test('inactive parents do not start preloading and may activate later', () => {
  const scene = createScene();
  scene.setActive(false);
  scene.owner.ensureAssets();
  assert.equal(scene.images.length, 0);
  assert.equal(scene.sounds.length, 0);
  scene.setActive(true);
  scene.owner.ensureAssets();
  assert.equal(scene.images.length, 57);
  scene.owner.stop();
});
