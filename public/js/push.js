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
import { api, isNativeApp, memberSession, nativeAppName, nativePushConfigured, pathPrefix } from './api.js';
import { isIos, isStandalone } from './pwa.js';

/** Which member turned notifications on in this browser. Scoped per gym like
 * the member session itself: two gyms on one origin share one subscription. */
const OWNER_KEY = `gymbook.push.owner${pathPrefix ? `.${pathPrefix.slice(3)}` : ''}`;
const PRIMER_KEY = `gymbook.push.reminder${pathPrefix ? `.${pathPrefix.slice(3)}` : ''}`;

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
  if (isNativeApp) return nativeCapability();
  if (!window.isSecureContext) return 'insecure';
  const hasApis = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (isIos() && !isStandalone()) return hasApis ? 'ready' : 'ios-install';
  if (!hasApis) return isIos() ? 'ios-version' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return 'ready';
}

export const permissionState = () =>
  isNativeApp ? nativePermissionState() : 'Notification' in window ? Notification.permission : 'default';

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
  if (isNativeApp) return nativeDevice();
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
  if (isNativeApp) return enableNativePush();
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
  try {
    const subscription = await subscribe(reg, publicKey);
    resetPrimer();
    return subscription;
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
  if (isNativeApp) {
    await disableNativePush();
    clearAppBadge();
    return;
  }
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
  if (isNativeApp) return syncNativePush();
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

/* ------------------------------------------------- the Home reminder card */

/**
 * How long "Not now" on the Home card holds it off, growing each time: back in
 * 2 days, then 5, 10, 21, and from then on once a month. Asking on every visit
 * would teach members to ignore it; asking once and never again would leave a
 * member who switched notifications off, or blocked them by accident, without
 * a single reminder that they are missing closures and renewals.
 */
const SNOOZE_DAYS = [2, 5, 10, 21, 30];
const DAY_MS = 24 * 60 * 60 * 1000;

function readPrimer() {
  try {
    const value = JSON.parse(readStore(PRIMER_KEY));
    if (value && typeof value === 'object') return { count: Number(value.count) || 0, until: Number(value.until) || 0 };
  } catch {
    // Missing or unreadable: never snoozed.
  }
  return { count: 0, until: 0 };
}

/** Whether the Home card may show now (it still checks it has something to say). */
export const primerDue = (now = Date.now()) => readPrimer().until <= now;

/** "Not now" — and also turning notifications off from Profile, so the card
 * does not pop straight back up on Home moments after a deliberate choice. */
export function snoozePrimer(now = Date.now()) {
  const { count } = readPrimer();
  const days = SNOOZE_DAYS[Math.min(count, SNOOZE_DAYS.length - 1)];
  writeStore(PRIMER_KEY, JSON.stringify({ count: count + 1, until: now + days * DAY_MS }));
}

/** Notifications are on: the next time they are switched off starts the
 * schedule over from the short end. */
const resetPrimer = () => writeStore(PRIMER_KEY, null);

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

/* ------------------------------------------- the Android app (Firebase) */

/*
 * The Capacitor app (android/) has no Web Push: its WebView offers neither
 * PushManager nor Notification. There, the functions above hand over to
 * @capacitor/push-notifications instead, called through the bridge Capacitor
 * injects (the page has no bundler to import the plugin's JS with). The
 * device registers an FCM token where a browser would send its subscription,
 * and the server pushes to it through Firebase (src/fcm.js) — so to the rest
 * of the portal, notifications on the phone work just as they do in Chrome.
 */

const PLUGIN = 'PushNotifications';
const hasNativePush = nativePushConfigured && Boolean(window.Capacitor?.isPluginAvailable?.(PLUGIN));
/** The FCM token this device registered with the server, if it did. */
const NATIVE_TOKEN_KEY = `gymbook.push.fcm-token${pathPrefix ? `.${pathPrefix.slice(3)}` : ''}`;

const nativeCall = (method, options = {}) => window.Capacitor.nativePromise(PLUGIN, method, options);

/** Android's answer — 'granted', 'denied', or a 'prompt…' still to ask —
 * read up front so pushCapability() can stay synchronous. */
let nativePermission = hasNativePush ? ((await nativeCall('checkPermissions').catch(() => ({}))).receive ?? 'prompt') : 'prompt';

const nativePermissionState = () =>
  nativePermission === 'granted' ? 'granted' : nativePermission === 'denied' ? 'denied' : 'default';

function nativeCapability() {
  if (!hasNativePush) return 'unsupported';
  return nativePermission === 'denied' ? 'denied' : 'ready';
}

const nativeDevice = () => {
  const token = readStore(NATIVE_TOKEN_KEY);
  return token ? { endpoint: `fcm:${token}` } : null;
};

/**
 * The channels src/fcm.js files messages under (FCM_CHANNELS there). On
 * Android 8+ a channel, not the message, decides sound and vibration, so the
 * member's sound/vibrate preferences pick a channel. Creating one that
 * exists is a no-op, so this runs on every registration.
 */
async function createChannels() {
  const channels = [
    { id: 'alerts', name: 'Reminders and announcements', importance: 4, vibration: true },
    { id: 'alerts-no-vibrate', name: 'Reminders and announcements (no vibration)', importance: 4, vibration: false },
    { id: 'quiet', name: 'Silent reminders and announcements', importance: 2, vibration: false },
  ];
  await Promise.all(channels.map((channel) => nativeCall('createChannel', { visibility: 1, ...channel }).catch(() => {})));
}

/** This device's FCM token, fresh from Firebase. */
function fetchNativeToken() {
  return new Promise((resolve, reject) => {
    const handles = [];
    const settle = (fn, value) => {
      clearTimeout(timer);
      for (const handle of handles) handle.remove();
      fn(value);
    };
    // Without Google Play services, or offline, Firebase may never answer.
    const timer = setTimeout(() => settle(reject, new Error('Firebase did not answer')), 20_000);
    handles.push(window.Capacitor.addListener(PLUGIN, 'registration', (token) => settle(resolve, token.value)));
    handles.push(window.Capacitor.addListener(PLUGIN, 'registrationError', (err) => settle(reject, new Error(err?.error))));
    nativeCall('register').catch((err) => settle(reject, err));
  });
}

async function registerNativeDevice() {
  await createChannels();
  let token;
  try {
    token = await fetchNativeToken();
  } catch {
    throw new PushError(
      'register',
      'This phone could not register for notifications. Check it is online and has Google Play services, then try again.',
    );
  }
  await api.portal.notifications.registerDevice({ token, path_prefix: pathPrefix });
  writeStore(NATIVE_TOKEN_KEY, token);
  writeStore(OWNER_KEY, String(memberSession.member?.id ?? ''));
}

async function enableNativePush() {
  if (!hasNativePush) throw new PushError('unavailable', 'Notifications are not available in this version of the app');
  nativePermission = (await nativeCall('requestPermissions')).receive;
  if (nativePermission === 'denied') {
    throw new PushError('denied', `Notifications are blocked — allow them in your phone’s Settings › Apps › ${nativeAppName}`);
  }
  if (nativePermission !== 'granted') throw new PushError('dismissed', 'Notifications were not turned on');
  await registerNativeDevice();
  resetPrimer();
  return nativeDevice();
}

async function disableNativePush() {
  const token = readStore(NATIVE_TOKEN_KEY);
  if (token) await api.portal.notifications.unregisterDevice(token).catch(() => {});
  // Deleting the token too, so nothing still addressed to it can arrive.
  if (hasNativePush) await nativeCall('unregister').catch(() => {});
  writeStore(NATIVE_TOKEN_KEY, null);
  writeStore(OWNER_KEY, null);
}

/** syncPushSubscription() for the app: the same ownership rule, and the token
 * re-sent because Firebase rotates it now and then. */
async function syncNativePush() {
  if (!hasNativePush || nativePermission !== 'granted') return false;
  const owner = readStore(OWNER_KEY);
  if (owner && owner !== String(memberSession.member?.id ?? '')) {
    await nativeCall('unregister').catch(() => {});
    writeStore(NATIVE_TOKEN_KEY, null);
    writeStore(OWNER_KEY, null);
    return false;
  }
  if (!owner) return false;
  try {
    await registerNativeDevice();
    return true;
  } catch {
    return Boolean(nativeDevice());
  }
}

if (hasNativePush) {
  // Only while the app is open — Android shows nothing itself then, as sw.js
  // stays silent for an open window, and the portal sounds and toasts it.
  window.Capacitor.addListener(PLUGIN, 'pushNotificationReceived', (message) => {
    const data = message?.data || {};
    const notification = {
      title: message?.title,
      body: message?.body,
      category: data.category,
      url: data.url,
      urgent: Number(data.urgent) || 0,
      unread: data.unread === '' || data.unread === undefined ? undefined : Number(data.unread),
    };
    for (const fn of listeners) fn(notification, true);
  });
  // A tap — including one that launched the app, which the plugin holds on
  // to until this listener exists. Same deep link sw.js would open.
  window.Capacitor.addListener(PLUGIN, 'pushNotificationActionPerformed', (action) => {
    const url = String(action?.notification?.data?.url || '');
    const hash = url.includes('#') ? url.slice(url.indexOf('#')) : '';
    if (/^#\/portal(\/|$)/.test(hash) && window.location.hash !== hash) window.location.hash = hash;
  });
}
