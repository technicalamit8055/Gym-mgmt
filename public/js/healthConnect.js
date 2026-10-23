/**
 * Health Connect — Android's on-device health store — through the GymVym
 * app's own plugin (android/…/HealthConnectPlugin.kt). Fitbit, Samsung
 * Health, Google Fit, Garmin, Pixel Watch and Strava all write to it, so one
 * connection brings in whatever watch or phone the member counts steps with.
 *
 * The phone reads daily totals and posts them to the server, which keeps them
 * for the Home card and the diet budget (src/wearables.js). The other way, it
 * writes the workouts and meals logged in the app into Health Connect, so
 * Google Fit and Samsung Health show them the way they show Hevy's. Health
 * Connect only lets an app in front read and write, so syncs happen when the
 * portal opens, when the app comes back to the foreground (at most every 15
 * minutes), on Sync now, and a few seconds after a workout or meal is saved.
 * On the web — and in an app build without the plugin —
 * `healthConnectSupported` is false and nothing here calls out.
 *
 * A finished sync raises `gymbook:wearables-synced` with the new summary.
 */
import { api, isNativeApp, memberSession } from './api.js';

const PLUGIN = 'HealthConnect';
export const HEALTH_CONNECT = 'health_connect';
export const healthConnectSupported = isNativeApp && Boolean(window.Capacitor?.isPluginAvailable?.(PLUGIN));
const call = (method, options = {}) => window.Capacitor.nativePromise(PLUGIN, method, options);

/** The read permissions, as status() names them; the rest are writes. */
const READS = ['steps', 'active_calories', 'distance', 'exercise'];

/** How many days each sync rewrites: late watch uploads still land. */
const SYNC_DAYS = 7;
const AUTO_SYNC_EVERY_MS = 15 * 60_000;

/**
 * `{ status, granted }`: status is available | not_installed |
 * update_required | unsupported, granted lists which of steps,
 * active_calories, distance, exercise (reads) and write_workouts,
 * write_meals (writes) the member allowed.
 */
export async function healthConnectStatus() {
  if (!healthConnectSupported) return { status: 'unsupported', granted: [] };
  return call('status');
}

/** Health Connect's own permission screen; resolves with what was granted. */
export const requestHealthConnectAccess = () => call('requestAccess');

/** Health Connect's settings, or its Play Store page when it is missing or
 * out of date. After two refusals Android stops showing the permission
 * screen, and this is the only way left to allow access. */
export const openHealthConnect = () => call('openSettings');

let inFlight = null;

/** Reads the last week and sends it up, then writes the app's workouts and
 * meals into Health Connect; resolves with the server's summary. */
export function syncHealthConnect() {
  inFlight ??= (async () => {
    try {
      const { granted } = await healthConnectStatus();
      let summary = null;
      // Allowed to write but not to read: nothing to bring in.
      if (granted.some((name) => READS.includes(name))) {
        const { days } = await call('readDaily', { days: SYNC_DAYS });
        summary = await api.portal.syncWearable(HEALTH_CONNECT, days);
        window.dispatchEvent(new CustomEvent('gymbook:wearables-synced', { detail: summary }));
      }
      await writeToHealthConnect().catch(() => {});
      return summary;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/* ------------------------------------------------- workouts & meals out */

// What this phone last wrote, per member: { workouts: { id: { hash, date } },
// meals: {...} }. Only what changed is written again, and an id the app no
// longer lists — a workout or meal deleted here — is deleted there too.
const SENT_KEY = 'gymbook.healthConnect.sent.';

function readSent(scope) {
  try {
    return JSON.parse(localStorage.getItem(SENT_KEY + scope)) ?? { workouts: {}, meals: {} };
  } catch {
    return { workouts: {}, meals: {} };
  }
}

function saveSent(scope, sent) {
  try {
    localStorage.setItem(SENT_KEY + scope, JSON.stringify(sent));
  } catch {
    // Storage full or blocked: the next write just sends everything again.
  }
}

/** The changes for one kind since the last write: items to (re)write, ids
 * to delete — only inside the export's window, so a record that simply aged
 * out of it is left alone — and the bookkeeping to keep if it goes through. */
function diffKind(items, previous, { from, to }) {
  const next = {};
  const write = [];
  for (const item of items) {
    const hash = JSON.stringify(item);
    next[item.id] = { hash, date: item.date };
    if (previous[item.id]?.hash !== hash) write.push(item);
  }
  const remove = Object.entries(previous)
    .filter(([id, { date }]) => !next[id] && date >= from && date <= to)
    .map(([id]) => id);
  return { write, remove, next };
}

let writing = null;

/** Brings Health Connect up to date with the last week's workouts and meals
 * from the app, for a member who allowed either. */
export function writeToHealthConnect() {
  writing ??= (async () => {
    try {
      const { granted } = await healthConnectStatus();
      if (!granted.includes('write_workouts') && !granted.includes('write_meals')) return;
      const exported = await api.portal.wearableExport(HEALTH_CONNECT);
      const sent = readSent(exported.scope);
      const workouts = diffKind(exported.workouts, sent.workouts, exported);
      const meals = diffKind(exported.meals, sent.meals, exported);
      if (!workouts.write.length && !meals.write.length && !workouts.remove.length && !meals.remove.length) return;
      const done = await call('writeRecords', {
        version: Date.now(),
        workouts: workouts.write,
        meals: meals.write,
        delete_workouts: workouts.remove,
        delete_meals: meals.remove,
      });
      // A kind the member has not allowed keeps its old bookkeeping, so
      // allowing it later sends the whole week.
      saveSent(exported.scope, {
        workouts: done.workouts ? workouts.next : sent.workouts,
        meals: done.meals ? meals.next : sent.meals,
      });
    } finally {
      writing = null;
    }
  })();
  return writing;
}

let writeTimer = null;

/** A workout saved or a meal logged: written a few seconds later, so a burst
 * of edits goes out as one write. */
function scheduleWrite() {
  if (!memberSession.token) return;
  clearTimeout(writeTimer);
  writeTimer = setTimeout(async () => {
    try {
      const { connections } = await api.portal.wearables();
      if (connections.some((c) => c.provider === HEALTH_CONNECT)) await writeToHealthConnect();
    } catch {
      // Offline or no add-on: the next sync catches up.
    }
  }, 5000);
}

let lastAutoSync = 0;

/** The quiet sync on open and on resume: only for a member who connected,
 * still allows access, and has not synced in the last 15 minutes. Never
 * throws — a failure just waits for the next chance. */
async function autoSync() {
  if (!memberSession.token || Date.now() - lastAutoSync < AUTO_SYNC_EVERY_MS) return;
  lastAutoSync = Date.now();
  try {
    const { connections } = await api.portal.wearables();
    if (!connections.some((c) => c.provider === HEALTH_CONNECT)) return;
    const { status, granted } = await healthConnectStatus();
    if (status === 'available' && granted.length) await syncHealthConnect();
  } catch {
    // Offline, no add-on (402), or Health Connect busy: try again later.
  }
}

let started = false;

/** Called once the portal is up. */
export function startHealthConnectSync() {
  if (!healthConnectSupported) return;
  autoSync();
  if (started) return;
  started = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') autoSync();
  });
  window.addEventListener('gymbook:member-signed-out', () => {
    lastAutoSync = 0;
    clearTimeout(writeTimer);
  });
  // api.js raises this after any fitness save — including a wearables sync,
  // which then finds nothing new to write.
  window.addEventListener('gymbook:fitness-changed', scheduleWrite);
}
