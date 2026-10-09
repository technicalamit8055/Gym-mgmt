import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

/**
 * Web Push, end to end, on node:crypto alone.
 *
 * Two standards do all the work, and both are small enough that a dependency
 * would mostly be packaging:
 *
 *   - RFC 8292 (VAPID): every request to a push service carries a short ES256
 *     JWT signed with this server's key, so the push service can tell our
 *     sends apart from anyone else's. The browser bound each subscription to
 *     our public key when the member subscribed, which is why the key pair
 *     must survive restarts — rotate it and every subscription goes dead.
 *   - RFC 8291 (Message Encryption, `aes128gcm`): the payload is encrypted to
 *     the subscription's own P-256 key and auth secret, so the push service
 *     (Google's FCM, Apple's, Mozilla's) relays bytes it cannot read.
 *
 * One key pair for the whole platform, not one per gym: gyms addressed by path
 * (/g/acme, /g/pulse) share an origin and so share one service worker
 * registration, and a registration can only be subscribed under one key.
 */

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const fromB64url = (value) => Buffer.from(String(value), 'base64url');

/* ------------------------------------------------------------------ keys */

/** Fresh P-256 pair in the shape VAPID wants: the public key as a raw
 * uncompressed point (what the browser's applicationServerKey takes) and the
 * private key as its bare 32-byte scalar. */
export function generateVapidKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = publicKey.export({ format: 'jwk' });
  const priv = privateKey.export({ format: 'jwk' });
  return {
    publicKey: b64url(Buffer.concat([Buffer.from([0x04]), fromB64url(pub.x), fromB64url(pub.y)])),
    privateKey: priv.d,
  };
}

let cachedKeys = null;

/**
 * This server's VAPID key pair: from the environment when set, otherwise
 * generated once and kept in a file beside the platform database, so a single
 * `fly deploy` or restart cannot quietly unsubscribe every member.
 */
export function vapidKeys() {
  if (cachedKeys) return cachedKeys;
  const { publicKey, privateKey, keyFile } = config.push;
  if (publicKey && privateKey) {
    cachedKeys = { publicKey, privateKey };
    return cachedKeys;
  }

  try {
    const stored = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
    if (stored.publicKey && stored.privateKey) {
      cachedKeys = { publicKey: stored.publicKey, privateKey: stored.privateKey };
      return cachedKeys;
    }
  } catch {
    // No file yet (first boot) or an unreadable one — generate below.
  }

  const fresh = generateVapidKeys();
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  // Owner-only: the private key is what lets anyone push to every member.
  fs.writeFileSync(keyFile, JSON.stringify({ ...fresh, created_at: new Date().toISOString() }, null, 2), {
    mode: 0o600,
  });
  cachedKeys = fresh;
  return cachedKeys;
}

/** For tests that swap the key file between runs. */
export function resetVapidKeyCache() {
  cachedKeys = null;
}

function privateKeyObject({ publicKey, privateKey }) {
  const point = fromB64url(publicKey);
  return crypto.createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: b64url(point.subarray(1, 33)),
      y: b64url(point.subarray(33, 65)),
      d: privateKey,
    },
    format: 'jwk',
  });
}

/* ----------------------------------------------------------------- VAPID */

/**
 * The `Authorization: vapid t=…, k=…` header for one push-service origin.
 *
 * `aud` is the push service's origin, not ours — that is what scopes a token
 * to the service it was minted for. Twelve hours is comfortably inside the
 * 24h ceiling the spec allows; Apple in particular rejects anything longer.
 */
export function vapidAuthorization(endpoint, { keys = vapidKeys(), subject = config.push.subject, now = Date.now() } = {}) {
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64url(
    JSON.stringify({
      aud: new URL(endpoint).origin,
      exp: Math.floor(now / 1000) + 12 * 60 * 60,
      sub: subject,
    }),
  );
  const unsigned = `${header}.${claims}`;
  // ieee-p1363: JWS wants the raw r||s signature, not node's default DER.
  const signature = crypto.sign('sha256', Buffer.from(unsigned), {
    key: privateKeyObject(keys),
    dsaEncoding: 'ieee-p1363',
  });
  return `vapid t=${unsigned}.${b64url(signature)}, k=${keys.publicKey}`;
}

/* ------------------------------------------------------------ encryption */

const RECORD_SIZE = 4096;

/**
 * Encrypts `plaintext` to one subscription (RFC 8291 §3–4, single record).
 *
 * `salt` and `serverKeys` are parameters only so a test can reproduce the
 * RFC's worked example; in production both are fresh per message, and reusing
 * either would be a real weakness.
 *
 * @param {{p256dh: string, auth: string}} keys The subscription's keys.
 * @param {Buffer|string} plaintext
 */
export function encryptPayload(keys, plaintext, { salt = crypto.randomBytes(16), serverKeys } = {}) {
  const uaPublic = fromB64url(keys.p256dh);
  const authSecret = fromB64url(keys.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new Error('Subscription p256dh key is not a P-256 point');
  if (authSecret.length < 16) throw new Error('Subscription auth secret is too short');

  const ecdh = crypto.createECDH('prime256v1');
  if (serverKeys) ecdh.setPrivateKey(fromB64url(serverKeys.privateKey));
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const sharedSecret = ecdh.computeSecret(uaPublic);

  // IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info" || 0 || ua_public || as_public)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', sharedSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  // 0x02 marks the last (and only) record; no further padding.
  const body = Buffer.concat([Buffer.from(plaintext), Buffer.from([0x02])]);
  if (body.length + 16 > RECORD_SIZE - 86) throw new Error('Push payload is too large');

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(body), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, ciphertext]);
}

/**
 * The receiving side of encryptPayload(). The server never needs it — only
 * the browser decrypts — but it is what lets the tests prove a payload is
 * readable by the subscription it was sent to and nobody else.
 */
export function decryptPayload({ privateKey, auth }, encrypted) {
  const salt = encrypted.subarray(0, 16);
  const idLength = encrypted.readUInt8(20);
  const asPublic = encrypted.subarray(21, 21 + idLength);
  const ciphertext = encrypted.subarray(21 + idLength);

  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(fromB64url(privateKey));
  const uaPublic = ecdh.getPublicKey();
  const sharedSecret = ecdh.computeSecret(asPublic);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', sharedSecret, fromB64url(auth), keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(-16));
  const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
  // Strip the 0x02 delimiter and any zero padding after the content.
  let end = padded.length - 1;
  while (end > 0 && padded[end] === 0) end -= 1;
  return padded.subarray(0, end);
}

/* -------------------------------------------------------------- delivery */

/** The network call, swappable so tests never reach a real push service. */
let transport = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });

export function setPushTransport(fn) {
  const previous = transport;
  transport = fn;
  return previous;
}

/**
 * Sends one encrypted message to one subscription.
 *
 * Never throws for a delivery problem — the caller is a sweep walking many
 * members, and one dead phone must not stop the rest. The result says what
 * happened instead, and `gone` is the one outcome that needs acting on: the
 * push service has forgotten this subscription (uninstalled app, revoked
 * permission, cleared site data), so it should be deleted rather than retried
 * forever.
 *
 * @param {{endpoint: string, p256dh: string, auth: string}} subscription
 * @param {object} payload JSON-serialisable; read by the push handler in sw.js.
 * @param {object} [opts]
 * @param {number} [opts.ttl] Seconds the push service may hold the message
 *   for an offline device. A water reminder is worthless three hours late; a
 *   gym-closure notice is not.
 * @param {'very-low'|'low'|'normal'|'high'} [opts.urgency]
 * @param {string} [opts.topic] Replaces any undelivered message with the same
 *   topic, so a phone that was off all afternoon wakes to one hydration nudge,
 *   not three.
 */
export async function sendPush(subscription, payload, { ttl = 60 * 60, urgency = 'normal', topic } = {}) {
  try {
    const body = encryptPayload(subscription, JSON.stringify(payload));
    const headers = {
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      TTL: String(Math.max(0, Math.round(ttl))),
      Urgency: urgency,
      Authorization: vapidAuthorization(subscription.endpoint),
    };
    // Topic is limited to 32 URL-safe base64 characters.
    if (topic) headers.Topic = String(topic).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);

    const res = await transport(subscription.endpoint, { method: 'POST', headers, body });
    const status = res.status;
    if (status >= 200 && status < 300) return { ok: true, status };
    const detail = typeof res.text === 'function' ? await res.text().catch(() => '') : '';
    return {
      ok: false,
      status,
      gone: status === 404 || status === 410,
      error: `Push service answered ${status}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
    };
  } catch (err) {
    return { ok: false, status: 0, gone: false, error: err.message || 'Push delivery failed' };
  }
}

/** Push services only ever hand out https endpoints; anything else is a
 * forged subscription trying to make this server POST somewhere it chose. */
export function isValidEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    return url.protocol === 'https:' && endpoint.length <= 1024;
  } catch {
    return false;
  }
}
