import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/**
 * public/js/sound.js is a browser module — it touches `document`, `window`
 * and `navigator` at import time and on every play call. There is no jsdom
 * in this project, so the minimum viable browser is stubbed by hand here:
 * just enough surface for the module to load and run its real logic, with
 * a fake AudioContext standing in for the one this Node process doesn't have.
 */

class MemoryStorage {
  constructor() {
    this.store = new Map();
  }
  getItem(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }
  setItem(key, value) {
    this.store.set(key, String(value));
  }
  removeItem(key) {
    this.store.delete(key);
  }
}

class MockParam {
  setValueAtTime() {}
  exponentialRampToValueAtTime() {}
}

class MockOscillator {
  constructor() {
    this.frequency = new MockParam();
    this.type = 'sine';
  }
  connect(dest) {
    return dest;
  }
  start() {}
  stop() {}
}

class MockGain {
  constructor() {
    this.gain = new MockParam();
  }
  connect(dest) {
    return dest;
  }
}

class MockFilter {
  constructor() {
    this.frequency = { value: 0 };
    this.type = '';
  }
  connect(dest) {
    return dest;
  }
}

class MockAudioContext {
  constructor() {
    this.currentTime = 0;
    this.destination = {};
    this.state = 'running';
    this.oscillatorsCreated = 0;
    // The module keeps its AudioContext singleton private — this is the only
    // way a test can get a handle on the instance it lazily creates.
    globalThis.__mockAudioContext = this;
  }
  createOscillator() {
    this.oscillatorsCreated += 1;
    return new MockOscillator();
  }
  createGain() {
    return new MockGain();
  }
  createBiquadFilter() {
    return new MockFilter();
  }
  resume() {
    this.state = 'running';
    return Promise.resolve();
  }
}

globalThis.document = { addEventListener() {}, removeEventListener() {} };
// Starts with no AudioContext at all, so the very first import exercises the
// "WebAudio unavailable" fallback path every real headless test runner hits.
globalThis.window = { AudioContext: undefined, webkitAudioContext: undefined };
globalThis.localStorage = new MemoryStorage();

// Node 21+ already defines a read-only `navigator` getter of its own, so
// replacing it needs defineProperty rather than a plain assignment.
const setNavigator = (value) =>
  Object.defineProperty(globalThis, 'navigator', { value, writable: true, configurable: true, enumerable: true });

let vibrateCalls = [];
setNavigator({ vibrate: (pattern) => vibrateCalls.push(pattern) });

// Seeds a corrupted stored volume before the module's one-time read at import,
// so the fallback-to-default branch of readNumber() is exercised for real
// rather than only through the "key absent" path the other two settings take.
globalThis.localStorage.setItem('gymbook.portal.soundVolume', 'not-a-number');

const sound = await import('../public/js/sound.js');

describe('preference storage', () => {
  it('defaults sound on, volume at 0.8 and haptics on when nothing is stored', () => {
    assert.equal(sound.getSoundEnabled(), true);
    assert.equal(sound.getSoundVolume(), 0.8);
    assert.equal(sound.getHapticsEnabled(), true);
  });

  it('falls back to the default volume when the stored value is corrupted', () => {
    // Seeded above, before import — a bad localStorage value must never
    // surface as NaN or crash the module that reads it at load time.
    assert.equal(sound.getSoundVolume(), sound.VOLUME_PRESETS.medium);
  });

  it('persists a sound-enabled change to localStorage', () => {
    sound.setSoundEnabled(false);
    assert.equal(sound.getSoundEnabled(), false);
    assert.equal(globalThis.localStorage.getItem('gymbook.portal.soundEnabled'), 'false');
    sound.setSoundEnabled(true);
    assert.equal(globalThis.localStorage.getItem('gymbook.portal.soundEnabled'), 'true');
  });

  it('clamps volume to [0, 1] and persists it', () => {
    sound.setSoundVolume(1.4);
    assert.equal(sound.getSoundVolume(), 1);
    sound.setSoundVolume(-0.3);
    assert.equal(sound.getSoundVolume(), 0);
    sound.setSoundVolume(0.5);
    assert.equal(sound.getSoundVolume(), 0.5);
    assert.equal(globalThis.localStorage.getItem('gymbook.portal.soundVolume'), '0.5');
    sound.setSoundVolume(sound.VOLUME_PRESETS.medium);
  });

  it('persists a haptics-enabled change to localStorage', () => {
    sound.setHapticsEnabled(false);
    assert.equal(sound.getHapticsEnabled(), false);
    assert.equal(globalThis.localStorage.getItem('gymbook.portal.hapticsEnabled'), 'false');
    sound.setHapticsEnabled(true);
  });

  it('notifies subscribers on change, and stops once unsubscribed', () => {
    const seen = [];
    const unsubscribe = sound.onSettingsChange((settings) => seen.push(settings));

    sound.setSoundEnabled(false);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].soundEnabled, false);

    unsubscribe();
    sound.setSoundEnabled(true);
    assert.equal(seen.length, 1, 'unsubscribed listener must not be notified again');
  });
});

describe('haptics — independent of the sound-enabled toggle', () => {
  it('vibrates with the catalog pattern when haptics are on, even with WebAudio unavailable', () => {
    sound.setSoundEnabled(true);
    sound.setHapticsEnabled(true);
    vibrateCalls = [];

    sound.playSetComplete();

    assert.deepEqual(vibrateCalls, [[40]]);
  });

  it('does not vibrate once haptics are switched off', () => {
    sound.setHapticsEnabled(false);
    vibrateCalls = [];

    sound.playSetComplete();

    assert.deepEqual(vibrateCalls, []);
    sound.setHapticsEnabled(true);
  });

  it('never throws when the device has no vibrate API at all', () => {
    const withVibrate = globalThis.navigator;
    setNavigator({});
    try {
      assert.doesNotThrow(() => sound.playRestEnd());
    } finally {
      setNavigator(withVibrate);
    }
  });
});

describe('sound trigger API integrity', () => {
  it('never throws while WebAudio is unavailable (still no AudioContext at this point)', () => {
    for (const key of sound.SOUND_PREVIEW_ORDER) {
      assert.doesNotThrow(() => sound.previewSound(key), `previewSound('${key}') threw with no AudioContext`);
    }
  });

  it('synthesizes the expected number of oscillator voices per cataloged sound, once WebAudio is available', () => {
    globalThis.window.AudioContext = MockAudioContext;
    sound.setSoundEnabled(true);

    // getContext() is a singleton, lazily created on the first call that
    // needs it — this warm-up call forces that creation so the mock instance
    // it stashes on globalThis is ready before any deltas are measured.
    sound.playRestTick();
    const ctx = globalThis.__mockAudioContext;
    assert.ok(ctx, 'MockAudioContext should have been instantiated');

    const cases = [
      ['playSetComplete', () => sound.playSetComplete(), 2],
      ['playSetUncheck', () => sound.playSetUncheck(), 1],
      ['playRestStart', () => sound.playRestStart(), 1],
      ['playRestTick', () => sound.playRestTick(), 1],
      ['playRestEnd', () => sound.playRestEnd(), 4],
      ['playWorkoutComplete(false)', () => sound.playWorkoutComplete(false), 4],
      ['playWorkoutComplete(true) [prBurst]', () => sound.playWorkoutComplete(true), 6],
      ['playFoodLogged', () => sound.playFoodLogged(), 1],
      ['playFoodRemoved', () => sound.playFoodRemoved(), 1],
      ['playWaterLogged', () => sound.playWaterLogged(), 1],
      ['playTargetReached', () => sound.playTargetReached(), 3],
    ];

    for (const [label, fn, expected] of cases) {
      const before = ctx.oscillatorsCreated;
      fn();
      const after = ctx.oscillatorsCreated;
      assert.equal(after - before, expected, `${label} should create ${expected} oscillator(s)`);
    }
  });

  it('creates no audio nodes while sound is muted, regardless of AudioContext availability', () => {
    const ctx = globalThis.__mockAudioContext;
    sound.setSoundEnabled(false);
    const before = ctx.oscillatorsCreated;
    sound.playWorkoutComplete(true);
    assert.equal(ctx.oscillatorsCreated, before);
    sound.setSoundEnabled(true);
  });

  it('previewSound() returns the label for a known key and null for an unknown one', () => {
    const label = sound.previewSound('targetReached');
    assert.equal(label, 'Target reached');
    assert.equal(sound.previewSound('not-a-real-sound'), null);
  });

  it('SOUND_PREVIEW_ORDER covers exactly the sound catalog', () => {
    assert.deepEqual(
      new Set(sound.SOUND_PREVIEW_ORDER),
      new Set([
        'setComplete',
        'setUncheck',
        'restStart',
        'restTick',
        'restEnd',
        'workoutComplete',
        'prBurst',
        'foodLogged',
        'foodRemoved',
        'waterLogged',
        'targetReached',
      ]),
    );
  });
});
