/**
 * Web Push on the member's device: can this browser receive notifications,
 * turning them on and off, and keeping the server's copy of the subscription
 * current. What gets sent and when is the server's business — see
 * src/notifications.js; how a push is shown is sw.js's.
 *
 * Platform rules that shape everything here:
 *
 *   - iOS/iPadOS only offers Web Push to a site added to the Home Screen, on
 *     16.4 or later. In Safari proper there is no PushManager at all, so the
 *     honest answer there is "install first", not a broken Enable button.
 *   - Notification.requestPermission() must run inside a tap on iOS (and is
 *     quietly ignored outside one by most browsers), so enablePush() is only
 *     ever called straight from a click handler — never on page load.
 *   - A denied permission cannot be re-asked from script; only the browser's
 *     own site settings can undo it.
 */
import { api, memberSession, pathPrefix } from './api.js';
import { isIos, isStandalone } from './pwa.js';

/** Which member turned notifications on in this browser. Scoped per gym like
 * the member session itself: two gyms on one origin share one subscription. */
const OWNER_KEY = `gymbook.push.owner${pathPrefix ? `.${pathPrefix.slice(3)}` : ''}`;
const PRIMER_KEY = `gymbook.push.primerDismissed${pathPrefix ? `.${pathPrefix.slice(3)}` : ''}`;

const readStore = (key) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const writeStore = (key, value) => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage blocked: the worst case is re-asking a question next visit.
  }
};

export class PushError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * What this browser can do, as one of:
 *   ready        — can subscribe (permission not yet decided, or granted)
 *   denied       — the member blocked notifications for this site
 *   ios-install  — iPhone/iPad in Safari: add to Home Screen first
 *   ios-version  — installed on iOS, but older than 16.4
 *   insecure     — plain http on a LAN address; push needs HTTPS
 *   unsupported  — this browser has no Web Push
 */
export function pushCapability() {
  if (!window.isSecureContext) return 'insecure';
  const hasApis = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (isIos() && !isStandalone()) return hasApis ? 'ready' : 'ios-install';
  if (!hasApis) return isIos() ? 'ios-version' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return 'ready';
}

export const permissionState = () => ('Notification' in window ? Notification.permission : 'default');

export function platformName() {
  const ua = navigator.userAgent;
  if (isIos()) return 'ios';
  if (/android/i.test(ua)) return 'android';
  if (/mobi/i.test(ua)) return 'other';
  return 'desktop';
}

/** The service worker registration, or null if none comes up in time (a
 * worker that failed to install would otherwise hang `ready` forever). */
async function registration() {
  if (!('serviceWorker' in navigator)) return null;
  return Promise.race([navigator.serviceWorker.ready, new Promise((resolve) => setTimeout(() => resolve(null), 8000))]);
}

export async function currentSubscription() {
  const reg = await registration();
  return reg ? reg.pushManager.getSubscription() : null;
}

function keyBytes(base64url) {
  const padded = `${base64url}${'='.repeat((4 - (base64url.length % 4)) % 4)}`.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

/** Whether `subscription` was made under `publicKey` — after the server's
 * VAPID keys change, an old subscription can never be pushed to again. */
function sameKey(subscription, publicKey) {
  const current = subscription.options?.applicationServerKey;
  if (!current) return true; // Older browsers do not expose it; assume it matches.
  const a = new Uint8Array(current);
  const b = keyBytes(publicKey);
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

async function subscribe(reg, publicKey) {
  let subscription = await reg.pushManager.getSubscription();
  if (subscription && !sameKey(subscription, publicKey)) {
    await subscription.unsubscribe().catch(() => {});
    subscription = null;
  }
  if (!subscription) {
    subscription = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  }
  await api.portal.notifications.subscribe({
    ...subscription.toJSON(),
    platform: platformName(),
    path_prefix: pathPrefix,
  });
  writeStore(OWNER_KEY, String(memberSession.member?.id ?? ''));
  return subscription;
}

/**
 * Asks for permission and registers this device. Call directly from a tap.
 * @throws {PushError} `denied` / `dismissed` / `unavailable`.
 */
export async function enablePush(publicKey) {
  if (pushCapability() !== 'ready') throw new PushError('unavailable', 'Notifications are not available in this browser');
  // First thing, before any other await, so iOS still counts it as part of
  // the tap that triggered it.
  const permission = await Notification.requestPermission();
  if (permission === 'denied') {
    throw new PushError('denied', 'Notifications are blocked — allow them in your browser’s site settings');
  }
  if (permission !== 'granted') throw new PushError('dismissed', 'Notifications were not turned on');

  const reg = await registration();
  if (!reg) throw new PushError('unavailable', 'The app is still installing — try again in a moment');
  writeStore(PRIMER_KEY, '1');
  try {
    return await subscribe(reg, publicKey);
  } catch (err) {
    if (err?.status) throw err; // The server's own answer already says why.
    // The browser's own reason ("Registration failed - …") means nothing to
    // a member. The usual causes are a private window (Chrome refuses push
    // there, undetectably) or a browser with its push service turned off.
    throw new PushError(
      'register',
      'This browser could not register for notifications. Private or incognito windows cannot receive them — try a normal window.',
    );
  }
}

/** Stops notifications to this device, on both ends. */
export async function disablePush() {
  const subscription = await currentSubscription().catch(() => null);
  if (subscription) {
    await api.portal.notifications.unsubscribe(subscription.endpoint).catch(() => {});
    await subscription.unsubscribe().catch(() => {});
  }
  writeStore(OWNER_KEY, null);
  clearAppBadge();
}

/**
 * Run on every portal open. Re-sends a live subscription so the server keeps
 * up with key refreshes and with pushsubscriptionchange rotations that
 * happened while the app was closed (sw.js cannot reach the API itself).
 *
 * Only for the member who turned it on: someone else signing in on this phone
 * after a session simply expired must not inherit notifications they never
 * asked for — that device is unsubscribed instead.
 *
 * @returns {Promise<boolean>} Whether this device is subscribed afterwards.
 */
export async function syncPushSubscription(publicKey) {
  if (pushCapability() !== 'ready' || permissionState() !== 'granted') return false;
  const reg = await registration();
  if (!reg) return false;
  const existing = await reg.pushManager.getSubscription();
  const owner = readStore(OWNER_KEY);
  const me = String(memberSession.member?.id ?? '');

  if (owner && owner !== me) {
    if (existing) await existing.unsubscribe().catch(() => {});
    writeStore(OWNER_KEY, null);
    return false;
  }
  // Permission granted but never subscribed by this member: nothing to sync.
  if (!owner) return false;
  try {
    await subscribe(reg, publicKey);
    return true;
  } catch {
    return Boolean(existing);
  }
}

export const primerDismissed = () => Boolean(readStore(PRIMER_KEY));
export const dismissPrimer = () => writeStore(PRIMER_KEY, '1');

export function setAppBadge(count) {
  try {
    if (count > 0) navigator.setAppBadge?.(count)?.catch?.(() => {});
    else navigator.clearAppBadge?.()?.catch?.(() => {});
  } catch {
    // Badging API absent or refused — purely cosmetic.
  }
}
const clearAppBadge = () => setAppBadge(0);

/* -------------------------------------------------- messages from sw.js */

const listeners = new Set();

/** Called with (notification, foreground) for every push that arrives while
 * an app window is open. Returns an unsubscribe function. */
export function onPushMessage(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || typeof data !== 'object') return;

    if (data.type === 'gymbook:navigate' && typeof data.url === 'string') {
      const target = new URL(data.url, window.location.href);
      if (target.origin !== window.location.origin) return;
      // Same app document: a hash change is enough, and keeps whatever state
      // the shell holds. Anything else is a real navigation.
      if (target.pathname.replace(/\/$/, '') === window.location.pathname.replace(/\/$/, '')) {
        if (window.location.hash !== target.hash) window.location.hash = target.hash;
      } else {
        window.location.href = target.href;
      }
    }

    if (data.type === 'gymbook:push') {
      for (const fn of listeners) fn(data.notification || {}, Boolean(data.foreground));
    }
  });
}
