/**
 * The Android app's "workout in progress" notification — Hevy's: the exercise
 * up next, its set ("Set 1/3 - 37 kg x 11 reps"), a round picture of it, the
 * session stopwatch and a Complete Set button; while resting, "Next: Set 2 of
 * 3 (…)" over a "Rest 1:03" bar with Skip, -15s and +15s.
 *
 * What it says is the portal's business (liveNotificationContent in
 * views/portal.js); this module carries it across the bridge to the app's own
 * WorkoutNotification plugin (android/…/WorkoutNotifier.java) and brings the
 * button taps back. On the web — and in an app build without the plugin —
 * every export is a no-op.
 */
import { isNativeApp } from './api.js';
import { loadStill } from './ui.js';

const PLUGIN = 'WorkoutNotification';
const available = isNativeApp && Boolean(window.Capacitor?.isPluginAvailable?.(PLUGIN));
const call = (method, options = {}) => window.Capacitor.nativePromise(PLUGIN, method, options);

/** A tap kept while the app was closed is still applied this long after. */
const PENDING_MAX_AGE_MS = 30 * 60_000;

/* ------------------------------------------------------------ the taps */

let handler = null;
const queued = [];

function dispatch(event) {
  if (handler) handler(event);
  else queued.push(event);
}

/**
 * Who handles `{ type: 'action', id }` (a button: complete | rest_skip |
 * rest_sub | rest_add) and `{ type: 'open' }` (the notification itself). The portal
 * sets this when it mounts; anything that arrived before that — a tap that
 * launched the app — is handed over then.
 */
export function setLiveWorkoutHandler(fn) {
  handler = fn;
  while (handler && queued.length) handler(queued.shift());
}

if (available) {
  window.Capacitor.addListener(PLUGIN, 'action', (event) => dispatch({ type: 'action', id: event?.id }));
  window.Capacitor.addListener(PLUGIN, 'open', () => dispatch({ type: 'open' }));
  // Taps on a notification left behind by a closed app (WorkoutNotifier.queueAction).
  call('takePendingActions')
    .then(({ actions = [] } = {}) => {
      for (const action of actions) {
        if (Date.now() - Number(action.at) < PENDING_MAX_AGE_MS) dispatch({ type: 'action', id: action.id });
      }
    })
    .catch(() => {});
}

/* ---------------------------------------------------------- the picture */

const SIZE = 192;
const images = new Map();

/** The exercise's picture as Hevy shows it, on a white disc: a frame of an
 * uploaded demo filling it, or a bundled drawing (a wide strip) whole inside
 * it. Resolves to base64 PNG, or null when there is nothing to draw. */
function roundImage({ url, type }) {
  if (!images.has(url)) {
    images.set(
      url,
      loadStill(url, type, SIZE).then((source) => {
        if (!source) return null;
        try {
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = SIZE;
          const g = canvas.getContext('2d');
          g.beginPath();
          g.arc(SIZE / 2, SIZE / 2, SIZE / 2, 0, Math.PI * 2);
          g.fillStyle = '#fff';
          g.fill();
          g.clip();
          const bundled = url.startsWith('/images/');
          const scale = bundled
            ? Math.min((SIZE * 0.8) / source.width, (SIZE * 0.8) / source.height)
            : Math.max(SIZE / source.width, SIZE / source.height);
          const w = source.width * scale;
          const h = source.height * scale;
          g.drawImage(source, (SIZE - w) / 2, (SIZE - h) / 2, w, h);
          return canvas.toDataURL('image/png').split(',')[1];
        } catch {
          // A cross-origin picture the server sent without CORS taints the canvas.
          return null;
        }
      }),
    );
  }
  return images.get(url);
}

/* ------------------------------------------------------------ the sync */

let timer = null;
let pending = null;
let lastSent = null;

async function send() {
  timer = null;
  const content = pending;
  if (!content) {
    if (lastSent !== 'clear') {
      lastSent = 'clear';
      call('clear').catch(() => {});
    }
    return;
  }
  const { picture, ...payload } = content;
  const image = picture ? await roundImage(picture) : null;
  if (pending !== content) return; // Superseded while the picture loaded.
  if (image) payload.image = image;
  const key = JSON.stringify(payload);
  if (key === lastSent) return;
  lastSent = key;
  call('show', payload).catch(() => {});
}

/**
 * Shows, updates or (with null) removes the notification. Batched, because a
 * weight typed into a set writes the session on every keystroke and Android
 * drops a notification updated more than a few times a second.
 */
export function syncLiveWorkout(content) {
  if (!available) return;
  pending = content;
  clearTimeout(timer);
  timer = setTimeout(send, 250);
}

/** Android 13+ asks before an app may post anything. Asked once, from the tap
 * that starts a workout — the moment the notification's use is obvious. */
const ASKED_KEY = 'gymbook.liveWorkout.asked';

export async function askLiveWorkoutPermission() {
  if (!available) return;
  const { display } = await call('checkPermissions').catch(() => ({}));
  if (display === 'granted' || display === 'denied') return;
  try {
    if (localStorage.getItem(ASKED_KEY)) return;
    localStorage.setItem(ASKED_KEY, '1');
  } catch {
    // Storage blocked: ask anyway; Android itself stops asking after two refusals.
  }
  const result = await call('requestPermissions').catch(() => ({}));
  if (result?.display === 'granted') {
    // Whatever was sent before the answer went nowhere.
    lastSent = null;
    syncLiveWorkout(pending);
  }
}
