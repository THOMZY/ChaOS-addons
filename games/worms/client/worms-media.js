const IMAGE_NAMES = [
  'wselbak',
  'wwalk',
  'wfall',
  'wflyup',
  'wbackflp',
  'wdie',
  'wbrth2',
  'wwinner',
  'wthrgrn',
  'wthrhgr',
  'wshotp',
  'wmini',
  'wminif',
  'wshotf',
  'wshotg',
  'wgrnlnk',
  'whgrlnk',
  'wshglnk',
  'wmgnlnk',
  'wdrllnk',
  'wdynlnk',
  'wjetlnk',
  'wbazlnk',
  'wbatlnk',
  'wbaz',
  'wbataim',
  'wjetbak',
  'arrowdnb',
  'crshairr',
  'missile',
  'grenade',
  'hgrenade',
  'dynamite',
  'cloudl',
  'cloudm',
  'clouds',
  'water3',
  'grave1',
  'grave2',
  'grave3',
  'grave4',
  'grave5',
  'grave6',
];
const ICON_NAMES = [
  'iconbazooka',
  'icongrenade',
  'iconhgrenade',
  'icondynamite',
  'iconminigun',
  'iconshotgun',
  'drill',
  'iconrope',
  'iconjetpack',
  'iconmine',
  'iconblowtorch',
  'iconsheep',
];
const SOUND_NAMES = [
  'explosion1',
  'explosion2',
  'explosion3',
  'ShotGunFire',
  'MiniGunFire',
  'drill',
  'THROWPOWERUP',
  'THROWRELEASE',
  'ROCKETPOWERUP',
  'WormLanding',
  'GRENADEIMPACT',
  'HOLYGRENADEIMPACT',
  'StartRound',
  'fuse',
  'JUMP1',
  'WalkExpand',
  'WalkCompress',
  'TIMERTICK',
  'SHOTGUNRELOAD',
];
const SPEECH_NAMES = [
  'byebye',
  'fatality',
  'fire',
  'grenade',
  'hurry',
  'incoming',
  'justyouwait',
  'laugh',
  'ohdear',
  'ow1',
  'ow2',
  'ow3',
  'traitor',
  'victory',
  'watchthis',
  'yessir',
  'youllregretthat',
];
const SPEECH_GROUPS = {
  fire: ['watchthis', 'fire', 'incoming', 'grenade'],
  ohdear: ['ohdear', 'ow1', 'ow2', 'ow3', 'youllregretthat'],
  byebye: ['byebye', 'fatality', 'laugh'],
  yessir: ['yessir'],
  victory: ['victory'],
  hurry: ['hurry'],
  traitor: ['traitor'],
};

export function createWormsMedia({
  levels = [],
  randomIndex,
  isActive = () => true,
  isMuted = () => false,
  createImage = () => new Image(),
  createAudio = (url) => new Audio(url),
  assetBase = '/worms-assets',
  logger = console,
}) {
  const images = Object.create(null),
    sounds = Object.create(null),
    playing = new Map();
  let isStopped = false,
    hasStarted = false;

  function releaseMedia(media) {
    for (const release of [
      () => media.pause?.(),
      () => media.removeAttribute('src'),
      () => media.load?.(),
    ]) {
      try {
        release();
      } catch (error) {
        logger.warn('[worms-media] release failed', error);
      }
    }
  }

  function addImage(name, url) {
    if (isStopped) return;
    const image = createImage();
    if (isStopped) {
      releaseMedia(image);
      return;
    }
    images[name] = image;
    image.src = url;
  }

  function addSound(name, url) {
    if (isStopped) return;
    const sound = createAudio(url);
    if (isStopped) {
      releaseMedia(sound);
      return;
    }
    sounds[name] = sound;
    sound.preload = 'auto';
  }

  function ensureAssets() {
    if (isStopped || hasStarted || !isActive()) return;
    if (isStopped) return;
    hasStarted = true;
    for (const name of IMAGE_NAMES) addImage(name, `${assetBase}/images/${name}.png`);
    for (const level of levels) {
      if (isStopped) return;
      addImage(`level_${level.file}`, `${assetBase}/images/levels/${level.file}.png`);
    }
    for (const name of ICON_NAMES) addImage(name, `${assetBase}/images/weaponicons/${name}.png`);
    for (const name of SOUND_NAMES) {
      const extension = name === 'JUMP1' || name === 'TIMERTICK' ? '.WAV' : '.wav';
      addSound(name, `${assetBase}/sounds/${name}${extension}`);
    }
    for (const name of SPEECH_NAMES)
      addSound(`speech_${name}`, `${assetBase}/sounds/Speech/Irish/${name}.wav`);
  }

  function getImage(name) {
    if (typeof name !== 'string') return null;
    return Object.prototype.hasOwnProperty.call(images, name) ? Reflect.get(images, name) : null;
  }

  function releasePlayback(sound) {
    const release = playing.get(sound);
    if (!release) return;
    playing.delete(sound);
    sound.removeEventListener('ended', release);
    sound.removeEventListener('error', release);
    releaseMedia(sound);
  }

  function playSound(name, volume = 0.45) {
    if (isStopped || !isActive() || isMuted()) return;
    if (isStopped) return;
    const sound = typeof name === 'string' && Object.hasOwn(sounds, name) ? sounds[name] : null;
    if (!sound) return;
    let clone;
    try {
      clone = sound.cloneNode(true);
      if (isStopped) {
        releaseMedia(clone);
        return;
      }
      const release = () => releasePlayback(clone);
      playing.set(clone, release);
      clone.addEventListener('ended', release, { once: true });
      if (isStopped) return;
      clone.addEventListener('error', release, { once: true });
      clone.volume = volume;
      if (isStopped) return;
      Promise.resolve(clone.play()).catch(release);
    } catch {
      // Playback can be denied or interrupted; a failed clone still belongs here.
      if (clone) releasePlayback(clone);
    }
  }

  function playRandomSpeech(type) {
    if (isStopped) return;
    const names = Object.hasOwn(SPEECH_GROUPS, type) ? SPEECH_GROUPS[type] : [];
    if (names.length) playSound(`speech_${names.at(randomIndex(names.length))}`, 0.6);
  }

  function playExplosionSound() {
    if (!isStopped) playSound(`explosion${randomIndex(3) + 1}`);
  }

  function stop() {
    if (isStopped) return;
    isStopped = true;
    for (const sound of playing.keys()) releasePlayback(sound);
    for (const collection of [images, sounds]) {
      for (const name of Object.keys(collection)) {
        const media = collection[name];
        delete collection[name];
        releaseMedia(media);
      }
    }
  }

  function status() {
    return {
      isStopped,
      hasStarted,
      images: Object.keys(images).length,
      sounds: Object.keys(sounds).length,
      playing: playing.size,
    };
  }

  return { getImage, ensureAssets, playSound, playRandomSpeech, playExplosionSound, stop, status };
}
