import crypto from 'node:crypto';
import { config } from './config.js';

/**
 * Secrets the server has to read back — a YouTube channel's refresh token,
 * a board's stream key — sealed at rest with AES-256-GCM, so a copy of a
 * tenant database (a backup, a support download) is not a copy of the keys
 * to the institute's channel.
 *
 * The key is derived from AUTH_SECRET, which production already has to keep
 * secret and stable. Changing AUTH_SECRET makes every sealed value unreadable:
 * unseal() then answers null, and the institute connects its channel again —
 * the same thing that happens to every staff session on that change.
 */

const VERSION = 'v1';
let key = null;
let keyFor = null;

function sealingKey() {
  // Re-derived if the secret changes under a test; cached otherwise.
  if (keyFor !== config.secret) {
    key = Buffer.from(crypto.hkdfSync('sha256', config.secret, Buffer.alloc(0), 'gymbook sealed secrets v1', 32));
    keyFor = config.secret;
  }
  return key;
}

/** `v1.<iv>.<tag>.<ciphertext>`, base64url — or null for nothing to seal. */
export function seal(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', sealingKey(), iv);
  const body = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return [VERSION, iv, cipher.getAuthTag(), body].map((part) => (typeof part === 'string' ? part : part.toString('base64url'))).join('.');
}

/** The plaintext, or null if it is missing, damaged or sealed under another secret. */
export function unseal(sealed) {
  const [version, iv, tag, body] = String(sealed ?? '').split('.');
  if (version !== VERSION || !iv || !tag || body === undefined) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', sealingKey(), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
