/**
 * Procedural sound + haptic feedback for the member portal's workout and
 * diet tracking flows.
 *
 * Every sound is synthesized on the fly with Web Audio API oscillators
 * rather than shipped as an audio file: the portal is an offline-first PWA
 * behind a service worker, and a bundled .mp3/.wav is one more asset that
 * worker has to fetch, cache and version for the sake of a single beep.
 */

const ENABLED_KEY = 'gymbook.portal.soundEnabled';
const VOLUME_KEY = 'gymbook.portal.soundVolume';
const HAPTICS_KEY = 'gymbook.portal.hapticsEnabled';

export const VOLUME_PRESETS = { low: 0.35, medium: 0.8, high: 1 };

function readBool(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : raw === 'true';
  } catch {
    return fallback;
  }
}

function readNumber(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    const num = raw === null ? NaN : Number(raw);
    return Number.isFinite(num) ? num : fallback;
  } catch {
    return fallback;
  }
}

let soundEnabled = readBool(ENABLED_KEY, true);
let soundVolume = readNumber(VOLUME_KEY, VOLUME_PRESETS.medium);
let hapticsEnabled = readBool(HAPTICS_KEY, true);

const listeners = new Set();
const notify = () => listeners.forEach((fn) => fn(getSettings()));

export const getSettings = () => ({ soundEnabled, soundVolume, hapticsEnabled, restEndSound });

/** Lets the Profile settings panel repaint itself when a preference changes
 * from elsewhere (e.g. the session bar's quick mute button) without polling. */
export function onSettingsChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const getSoundEnabled = () => soundEnabled;
export function setSoundEnabled(value) {
  soundEnabled = Boolean(value);
  try {
    localStorage.setItem(ENABLED_KEY, String(soundEnabled));
  } catch {
    // Private window with storage blocked: the toggle still works for this tab.
  }
  notify();
}

export const getSoundVolume = () => soundVolume;
export function setSoundVolume(value) {
  soundVolume = Math.max(0, Math.min(1, Number(value) || 0));
  try {
    localStorage.setItem(VOLUME_KEY, String(soundVolume));
  } catch {
    // See setSoundEnabled.
  }
  notify();
}

export const getHapticsEnabled = () => hapticsEnabled;
export function setHapticsEnabled(value) {
  hapticsEnabled = Boolean(value);
  try {
    localStorage.setItem(HAPTICS_KEY, String(hapticsEnabled));
  } catch {
    // See setSoundEnabled.
  }
  notify();
}

/* ------------------------------------------------------------ audio engine */

let ctx = null;

function getContext() {
  if (ctx) return ctx;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  try {
    ctx = new Ctx();
  } catch {
    ctx = null;
  }
  return ctx;
}

/** Mobile browsers create every AudioContext suspended until a real user
 * gesture resumes it — unlocking on the first tap anywhere in the app means
 * the member's very first checkbox tap already has sound, instead of the
 * first set of the first session going silently unrewarded. */
function unlock() {
  const audioCtx = getContext();
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
}

for (const evt of ['pointerdown', 'touchstart', 'click', 'keydown']) {
  document.addEventListener(evt, unlock, { passive: true });
}

/* ------------------------------------------------------- synth primitives */

function envelopeGain(audioCtx, { gain, duration, attack = 0.006 }) {
  const node = audioCtx.createGain();
  const now = audioCtx.currentTime;
  const peak = Math.max(0.0001, gain * soundVolume);
  node.gain.setValueAtTime(0.0001, now);
  node.gain.exponentialRampToValueAtTime(peak, now + attack);
  node.gain.exponentialRampToValueAtTime(0.0001, now + duration);
  return node;
}

/** A single oscillator with a fast attack / exponential-decay envelope —
 * the building block every domain sound below is made of. */
function playTone({ freq, type = 'sine', duration = 0.2, gain = 0.2, startTime = 0 }) {
  if (!soundEnabled) return;
  const audioCtx = getContext();
  if (!audioCtx) return;
  try {
    const osc = audioCtx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const env = envelopeGain(audioCtx, { gain, duration });
    osc.connect(env).connect(audioCtx.destination);
    const at = audioCtx.currentTime + startTime;
    osc.start(at);
    osc.stop(at + duration + 0.05);
  } catch {
    // Silent device, autoplay policy, exhausted node budget — the UI already
    // reflected the action, so a lost sound is not worth surfacing.
  }
}

function playFrequencySweep({ startFreq, endFreq, type = 'sine', duration = 0.15, gain = 0.2, filterType = null, filterFreq = null, startTime = 0 }) {
  if (!soundEnabled) return;
  const audioCtx = getContext();
  if (!audioCtx) return;
  try {
    const osc = audioCtx.createOscillator();
    osc.type = type;
    const at = audioCtx.currentTime + startTime;
    osc.frequency.setValueAtTime(startFreq, at);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, endFreq), at + duration);
    const env = envelopeGain(audioCtx, { gain, duration });
    let source = osc;
    if (filterType) {
      const filter = audioCtx.createBiquadFilter();
      filter.type = filterType;
      filter.frequency.value = filterFreq || Math.max(startFreq, endFreq);
      osc.connect(filter);
      source = filter;
    }
    source.connect(env).connect(audioCtx.destination);
    osc.start(at);
    osc.stop(at + duration + 0.05);
  } catch {
    // See playTone.
  }
}

/** Several notes played together (staggerMs: 0) or as an arpeggio
 * (staggerMs > 0), each with its own envelope. */
function playChord(notes, { duration = 0.3, staggerMs = 0, type = 'sine', gain = 0.2, startOffset = 0 } = {}) {
  notes.forEach((freq, i) => playTone({ freq, type, duration, gain, startTime: startOffset + (i * staggerMs) / 1000 }));
}

function triggerHaptic(pattern) {
  if (!hapticsEnabled) return;
  if (!('vibrate' in navigator)) return;
  try {
    navigator.vibrate(pattern);
  } catch {
    // No-op device, or a page not currently visible to vibrate from.
  }
}

/** The faint tick of a tab-bar tap — haptic only, since a sound on every
 * navigation would wear thin fast. */
export function tapHaptic() {
  triggerHaptic(8);
}

/* --------------------------------------------------------- domain sounds */

export function playSetComplete() {
  playChord([587.3, 880], { duration: 0.18, staggerMs: 55, type: 'triangle', gain: 0.24 });
  triggerHaptic([40]);
}

export function playSetUncheck() {
  playFrequencySweep({ startFreq: 600, endFreq: 350, duration: 0.1, gain: 0.14 });
  triggerHaptic([20]);
}

export function playRestStart() {
  playTone({ freq: 440, type: 'sine', duration: 0.22, gain: 0.18 });
  triggerHaptic([30]);
}

export function playRestTick() {
  playTone({ freq: 750, type: 'triangle', duration: 0.06, gain: 0.2 });
  triggerHaptic([25]);
}

/** A referee's whistle: a high tone warbled fast by a second oscillator,
 * which is what makes a real pea whistle cut through a noisy gym. */
function playWhistle({ startTime = 0, duration = 0.45, gain = 0.3 } = {}) {
  if (!soundEnabled) return;
  const audioCtx = getContext();
  if (!audioCtx) return;
  try {
    const at = audioCtx.currentTime + startTime;
    const osc = audioCtx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 2600;
    const lfo = audioCtx.createOscillator();
    lfo.frequency.value = 28;
    const depth = audioCtx.createGain();
    depth.gain.value = 140;
    lfo.connect(depth).connect(osc.frequency);
    // Held flat rather than envelopeGain's decay: a whistle blast is loud for
    // its whole length, then stops.
    const env = audioCtx.createGain();
    const peak = Math.max(0.0001, gain * soundVolume);
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(peak, at + 0.02);
    env.gain.setValueAtTime(peak, at + duration - 0.05);
    env.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    osc.connect(env).connect(audioCtx.destination);
    osc.start(at);
    lfo.start(at);
    osc.stop(at + duration + 0.05);
    lfo.stop(at + duration + 0.05);
  } catch {
    // See playTone.
  }
}

/**
 * The sounds a member can pick for "rest over", quietest first. Chime is the
 * original; the rest exist because a soft chord is easy to miss over gym
 * music, so the loud ones are built from square waves and high pitches that
 * small phone speakers carry best.
 */
const REST_END_SOUNDS = {
  chime: {
    label: 'Chime',
    sub: 'Soft rising notes',
    play() {
      playChord([659.25, 830.6, 987.77, 1318.5], { duration: 0.6, staggerMs: 70, type: 'sawtooth', gain: 0.15 });
      triggerHaptic([120, 60, 120, 60, 200]);
    },
  },
  bell: {
    label: 'Boxing bell',
    sub: 'Three ringing strikes',
    play() {
      // A bell's partials are not whole multiples of each other — that is
      // what makes it read as metal rather than as a chord.
      for (const strike of [0, 0.32, 0.64]) {
        playTone({ freq: 830, type: 'sine', duration: 1.1, gain: 0.32, startTime: strike });
        playTone({ freq: 1318, type: 'sine', duration: 0.8, gain: 0.16, startTime: strike });
        playTone({ freq: 2237, type: 'sine', duration: 0.5, gain: 0.1, startTime: strike });
      }
      triggerHaptic([150, 170, 150, 170, 150]);
    },
  },
  digital: {
    label: 'Digital watch',
    sub: 'Beep-beep-beep-beep, twice',
    play() {
      for (const burst of [0, 0.75]) {
        for (let i = 0; i < 4; i += 1) {
          playTone({ freq: 2048, type: 'square', duration: 0.07, gain: 0.2, startTime: burst + i * 0.12 });
        }
      }
      triggerHaptic([70, 50, 70, 50, 70, 50, 70, 300, 70, 50, 70, 50, 70, 50, 70]);
    },
  },
  whistle: {
    label: 'Whistle',
    sub: "Two sharp referee's blasts",
    play() {
      playWhistle({ startTime: 0, duration: 0.3 });
      playWhistle({ startTime: 0.42, duration: 0.6 });
      triggerHaptic([300, 120, 600]);
    },
  },
  alarm: {
    label: 'Alarm',
    sub: 'Loudest — a two-second siren',
    play() {
      for (let i = 0; i < 14; i += 1) {
        playTone({ freq: i % 2 ? 1320 : 990, type: 'square', duration: 0.13, gain: 0.32, startTime: i * 0.14 });
      }
      triggerHaptic([400, 100, 400, 100, 400, 100, 600]);
    },
  },
};

const REST_SOUND_KEY = 'gymbook.portal.restEndSound';
let restEndSound = (() => {
  try {
    const saved = localStorage.getItem(REST_SOUND_KEY);
    return saved in REST_END_SOUNDS ? saved : 'chime';
  } catch {
    return 'chime';
  }
})();

/** [{ key, label, sub }] in the order the settings picker lists them. */
export const restEndSoundOptions = () =>
  Object.entries(REST_END_SOUNDS).map(([key, { label, sub }]) => ({ key, label, sub }));
export const getRestEndSound = () => restEndSound;
export const restEndSoundLabel = () => REST_END_SOUNDS[restEndSound].label;
export function setRestEndSound(key) {
  if (!(key in REST_END_SOUNDS)) return;
  restEndSound = key;
  try {
    localStorage.setItem(REST_SOUND_KEY, key);
  } catch {
    // See setSoundEnabled.
  }
  notify();
}

/** The picker's audition: plays `key` without choosing it. */
export const previewRestEndSound = (key) => REST_END_SOUNDS[key]?.play();

export function playRestEnd() {
  REST_END_SOUNDS[restEndSound].play();
}

function playPrBurst() {
  playChord([523.25, 659.25, 783.99, 1046.5], { duration: 1.2, staggerMs: 80, type: 'triangle', gain: 0.22 });
  // A sparkling overtone layered a beat after the main triad — the "shimmer"
  // the plain arpeggio below can't give on its own.
  playChord([1567.98, 2093], { duration: 0.9, staggerMs: 90, type: 'sine', gain: 0.09, startOffset: 0.22 });
  triggerHaptic([100, 50, 100, 50, 250]);
}

export function playWorkoutComplete(hasPrs = false) {
  if (hasPrs) {
    playPrBurst();
    return;
  }
  playChord([523.25, 659.25, 783.99, 1046.5], { duration: 0.8, staggerMs: 90, type: 'triangle', gain: 0.2 });
  triggerHaptic([80, 40, 80, 40, 150]);
}

export function playFoodLogged() {
  playFrequencySweep({ startFreq: 320, endFreq: 720, duration: 0.12, gain: 0.2, filterType: 'lowpass', filterFreq: 1800 });
  triggerHaptic([35]);
}

export function playFoodRemoved() {
  playFrequencySweep({ startFreq: 320, endFreq: 180, duration: 0.08, gain: 0.13 });
  triggerHaptic([20]);
}

export function playWaterLogged() {
  playFrequencySweep({ startFreq: 500, endFreq: 1100, duration: 0.16, gain: 0.16, filterType: 'bandpass', filterFreq: 800 });
  triggerHaptic([30]);
}

export function playTargetReached() {
  playChord([1046.5, 1318.5, 1567.98], { duration: 0.5, gain: 0.18, type: 'sine' });
  triggerHaptic([60, 40, 60]);
}

/** A push that arrives while the app is open on screen — sw.js keeps the
 * system notification silent then, so this is the one sound the member hears.
 * Urgent gym announcements get a longer, more insistent pattern. */
export function playNotification({ urgent = false } = {}) {
  if (urgent) {
    playChord([880, 1174.66, 880, 1174.66], { duration: 0.22, staggerMs: 140, type: 'square', gain: 0.12 });
    triggerHaptic([250, 100, 250, 100, 400]);
    return;
  }
  playChord([783.99, 1174.66], { duration: 0.35, staggerMs: 110, type: 'sine', gain: 0.2 });
  triggerHaptic([120, 60, 120]);
}

/* ---------------------------------------------------------------- preview */

const SOUND_LIBRARY = {
  setComplete: { label: 'Set complete', play: playSetComplete },
  setUncheck: { label: 'Set undo', play: playSetUncheck },
  restStart: { label: 'Rest start', play: playRestStart },
  restTick: { label: 'Rest countdown', play: playRestTick },
  restEnd: { label: 'Rest finished', play: playRestEnd },
  workoutComplete: { label: 'Workout finished', play: () => playWorkoutComplete(false) },
  prBurst: { label: 'New personal record', play: () => playWorkoutComplete(true) },
  foodLogged: { label: 'Food logged', play: playFoodLogged },
  foodRemoved: { label: 'Food removed', play: playFoodRemoved },
  waterLogged: { label: 'Water logged', play: playWaterLogged },
  targetReached: { label: 'Target reached', play: playTargetReached },
  notification: { label: 'Notification', play: () => playNotification() },
};

export const SOUND_PREVIEW_ORDER = Object.keys(SOUND_LIBRARY);

/** Plays one cataloged sound by key, for the Profile settings audition
 * button, and returns its display label — or null for an unknown key. */
export function previewSound(key) {
  const entry = SOUND_LIBRARY[key];
  if (!entry) return null;
  entry.play();
  return entry.label;
}
