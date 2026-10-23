/**
 * Health Connect — Android's on-device health store — through the GymVym
 * app's own plugin (android/…/HealthConnectPlugin.kt). Fitbit, Samsung
 * Health, Google Fit, Garmin, Pixel Watch and Strava all write to it, so one
 * connection brings in whatever watch or phone the member counts steps with.
 *
 * The phone reads daily totals and posts them to the server, which keeps them
 * for the Home card and the diet budget (src/wearables.js). Health Connect
 * only lets an app read while it is in front, so syncs happen when the portal
 * opens, when the app comes back to the foreground (at most every 15
 * minutes), and on Sync now. On the web — and in an app build without the
 * plugin — `healthConnectSupported` is false and nothing here calls out.
 *
 * A finished sync raises `gymbook:wearables-synced` with the new summary.
 */
import { api, isNativeApp, memberSession } from './api.js';

const PLUGIN = 'HealthConnect';
export const HEALTH_CONNECT = 'health_connect';
export const healthConnectSupported = isNativeApp && Boolean(window.Capacitor?.isPluginAvailable?.(PLUGIN));
const call = (method, options = {}) => window.Capacitor.nativePromise(PLUGIN, method, options);

/** How many days each sync rewrites: late watch uploads still land. */
const SYNC_DAYS = 7;
const AUTO_SYNC_EVERY_MS = 15 * 60_000;

/**
 * `{ status, granted }`: status is available | not_installed |
 * update_required | unsupported, granted lists which of steps,
 * active_calories, distance and exercise the member allowed.
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

/** Reads the last week and sends it up; resolves with the server's summary. */
export function syncHealthConnect() {
  inFlight ??= (async () => {
    try {
      const { days } = await call('readDaily', { days: SYNC_DAYS });
      const summary = await api.portal.syncWearable(HEALTH_CONNECT, days);
      window.dispatchEvent(new CustomEvent('gymbook:wearables-synced', { detail: summary }));
      return summary;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
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
  });
}
