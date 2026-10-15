import crypto from 'node:crypto';
import fs from 'node:fs';
import { config } from './config.js';

/**
 * Firebase Cloud Messaging (HTTP v1 API), for the Android member app.
 *
 * The app's WebView has no Web Push, so a phone running it registers an FCM
 * token instead (public/js/push.js), stored as a push_subscriptions row whose
 * endpoint is "fcm:<token>". notifications.js sends to those rows through
 * sendFcm() and to every other row through webPush.sendPush(); both take the
 * same payload and answer in the same shape, so preferences, dedupe and
 * dead-device pruning work the same either way.
 *
 * Auth is a service account's OAuth2 token, minted from a signed JWT
 * (RFC 7523) with node:crypto alone, like webPush.js's VAPID tokens.
 */

export const FCM_PREFIX = 'fcm:';

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

/**
 * Android notification channels, created by the app (public/js/push.js) and
 * picked here per message. A channel fixes sound and vibration on Android 8+,
 * so the member's sound/vibrate preferences choose between channels rather
 * than travelling with the message. Silent means silent: Android cannot
 * vibrate a channel that makes no sound.
 */
export const FCM_CHANNELS = { alerts: 'alerts', noVibrate: 'alerts-no-vibrate', quiet: 'quiet' };

/* ----------------------------------------------------------- credentials */

let credentials; // undefined: not read yet; null: not configured

/** The service account to send as, or null when FCM is not set up. */
export function fcmCredentials() {
  if (credentials !== undefined) return credentials;
  credentials = null;
  if (!config.fcm.credentialsFile) return null;
  try {
    const key = JSON.parse(fs.readFileSync(config.fcm.credentialsFile, 'utf8'));
    if (!key.client_email || !key.private_key) throw new Error('not a service-account key (no client_email/private_key)');
    const projectId = config.fcm.projectId || key.project_id;
    if (!projectId) throw new Error('no project id — set FCM_PROJECT_ID');
    credentials = {
      clientEmail: key.client_email,
      privateKey: crypto.createPrivateKey(key.private_key),
      tokenUri: key.token_uri || 'https://oauth2.googleapis.com/token',
      projectId,
    };
  } catch (err) {
    // Logged, not thrown: a bad key must not take the whole server down, and
    // web push does not depend on it.
    console.error(`FCM disabled — could not use ${config.fcm.credentialsFile}: ${err.message}`);
  }
  return credentials;
}

export const fcmConfigured = () => Boolean(fcmCredentials());

/** Forgets loaded credentials and tokens (tests point FCM_CREDENTIALS elsewhere). */
export function resetFcm() {
  credentials = undefined;
  accessToken = null;
}

/* ------------------------------------------------------------- transport */

/** The network call, swappable so tests never reach Google. */
let transport = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });

export function setFcmTransport(fn) {
  const previous = transport;
  transport = fn;
  return previous;
}

/* ------------------------------------------------------------ OAuth token */

/** In flight or settled: {promise, expiresAt}. Shared, so a sweep sending to
 * a hundred phones at once signs in to Google once, not a hundred times. */
let accessToken = null;

function fetchAccessToken({ clientEmail, privateKey, tokenUri }) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iss: clientEmail, scope: SCOPE, aud: tokenUri, iat: now, exp: now + 3600 })}`;
  const assertion = `${unsigned}.${crypto.sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url')}`;
  return (async () => {
    const res = await transport(tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
    });
    const text = await res.text();
    if (res.status < 200 || res.status >= 300) throw new Error(`Google sign-in for FCM answered ${res.status}: ${text.slice(0, 200)}`);
    const { access_token: token, expires_in: expiresIn } = JSON.parse(text);
    return { token, expiresIn: Number(expiresIn) || 3600 };
  })();
}

async function bearer(creds) {
  // Renewed a minute early, so no request goes out on a token about to lapse.
  if (!accessToken || accessToken.expiresAt < Date.now() + 60_000) {
    const entry = { expiresAt: Infinity };
    entry.promise = fetchAccessToken(creds).then(
      ({ token, expiresIn }) => {
        entry.expiresAt = Date.now() + expiresIn * 1000;
        return token;
      },
      (err) => {
        if (accessToken === entry) accessToken = null;
        throw err;
      },
    );
    accessToken = entry;
  }
  return accessToken.promise;
}

/* --------------------------------------------------------------- message */

/**
 * The FCM message for one device, from the payload sw.js would have got.
 *
 * A "notification" message, so Android shows it itself while the app is
 * closed; the data fields are what the app reads when it is open or tapped.
 * `origin` makes the payload's origin-relative image URL absolute — unlike a
 * browser, the phone's notification service has no page to resolve it against.
 */
export function fcmMessage(token, payload, { ttl = 60 * 60, urgency = 'normal', topic, origin } = {}) {
  const image = payload.image && origin ? new URL(payload.image, origin).href : undefined;
  const channel = !payload.sound ? FCM_CHANNELS.quiet : payload.vibrate ? FCM_CHANNELS.alerts : FCM_CHANNELS.noVibrate;
  return {
    token,
    notification: { title: payload.title, body: payload.body, ...(image ? { image } : {}) },
    // FCM takes strings only here.
    data: {
      id: String(payload.id ?? ''),
      category: String(payload.category ?? ''),
      url: String(payload.url ?? ''),
      urgent: String(payload.urgent ?? 0),
      unread: String(payload.unread ?? ''),
    },
    android: {
      ttl: `${Math.max(0, Math.round(ttl))}s`,
      priority: urgency === 'high' || payload.urgent ? 'HIGH' : 'NORMAL',
      // Like Web Push's Topic: an undelivered older message with the same key
      // is replaced, so a phone that was off wakes to one hydration nudge.
      ...(topic ? { collapse_key: String(topic).slice(0, 64) } : {}),
      notification: {
        channel_id: channel,
        // Replaces a shown notification with the same tag rather than stacking.
        ...(payload.tag ? { tag: String(payload.tag) } : {}),
        ...(Number.isFinite(payload.unread) ? { notification_count: payload.unread } : {}),
      },
    },
  };
}

/**
 * Sends one message to one "fcm:<token>" subscription. Same contract as
 * webPush.sendPush(): never throws for a delivery problem, and `gone` means
 * the token is dead (app uninstalled, data cleared, or minted for another
 * Firebase project) and its row should be deleted.
 */
export async function sendFcm(subscription, payload, opts = {}) {
  try {
    const creds = fcmCredentials();
    if (!creds) return { ok: false, status: 0, gone: false, error: 'FCM is not configured on this server' };
    const token = subscription.endpoint.slice(FCM_PREFIX.length);
    const message = fcmMessage(token, payload, { ...opts, origin: subscription.origin });
    const res = await transport(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(creds.projectId)}/messages:send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await bearer(creds)}` },
      body: JSON.stringify({ message }),
    });
    const status = res.status;
    if (status >= 200 && status < 300) return { ok: true, status };
    const detail = await res.text().catch(() => '');
    if (status === 401) accessToken = null;
    return {
      ok: false,
      status,
      gone: status === 404 || /UNREGISTERED|SENDER_ID_MISMATCH/.test(detail),
      error: `FCM answered ${status}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
    };
  } catch (err) {
    return { ok: false, status: 0, gone: false, error: err.message || 'FCM delivery failed' };
  }
}
