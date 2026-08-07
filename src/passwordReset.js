import crypto from 'node:crypto';
import { hashPassword } from './auth.js';
import { get, run, tx } from './db.js';
import { badRequest, notFound } from './errors.js';

/**
 * Recovering a gym whose owner has lost their password.
 *
 * There was previously no way to do this at all: the signup page told owners to
 * write the password down because "there is no email reset yet", and a forgotten
 * one meant the gym's members, payments and history were unreachable forever.
 *
 * This deliberately does not depend on email, which the app cannot send. A reset
 * is *issued* by someone who already has out-of-band authority over the gym —
 * the platform operator through the console, or whoever has shell access through
 * scripts/reset-password.js — and hands back a single-use link to pass to the
 * owner over whatever channel they are already talking on.
 */

const TOKEN_BYTES = 32;
const TTL_MINUTES = 60;

/** Stored as a digest, not the token: a leaked database must not hand over
 * working reset links. Plain SHA-256 is right here where scrypt is not — the
 * input is 256 bits of CSPRNG output, so there is nothing to brute force. */
const digest = (token) => crypto.createHash('sha256').update(token).digest('hex');

/** The account a reset should target when nobody names one: the gym's owner.
 * Oldest admin, because that is the account signup created. */
export function defaultResetTarget() {
  return get("SELECT id, name, email FROM users WHERE role = 'admin' AND active = 1 ORDER BY id LIMIT 1");
}

/**
 * Issues a single-use reset token for one staff account.
 *
 * Any outstanding tokens for that account are dropped first, so re-issuing
 * after a link goes astray leaves exactly one live link — the newest.
 */
export function issuePasswordReset(email) {
  const user = email
    ? get('SELECT id, name, email FROM users WHERE email = ? AND active = 1', [String(email).toLowerCase()])
    : defaultResetTarget();
  if (!user) throw notFound('No active staff account to reset');

  const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  const expiresAt = new Date(Date.now() + TTL_MINUTES * 60_000).toISOString().slice(0, 19).replace('T', ' ');

  tx(() => {
    run('DELETE FROM password_resets WHERE user_id = ?', [user.id]);
    run('INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, ?)', [
      user.id,
      digest(token),
      expiresAt,
    ]);
  });

  return { token, email: user.email, name: user.name, expires_at: expiresAt, expires_in_minutes: TTL_MINUTES };
}

/**
 * Spends a reset token and sets the new password.
 *
 * The lookup is by digest and the row is deleted in the same transaction as the
 * password write, so a token cannot be replayed even if two requests arrive at
 * once. Expired rows are cleared on the way past rather than by a scheduler.
 */
export function redeemPasswordReset(token, newPassword) {
  run("DELETE FROM password_resets WHERE expires_at < datetime('now')");

  const row = get(
    `SELECT pr.id, pr.user_id, u.email
     FROM password_resets pr JOIN users u ON u.id = pr.user_id
     WHERE pr.token_hash = ? AND u.active = 1`,
    [digest(String(token))],
  );
  if (!row) throw badRequest('That reset link is not valid any more — ask for a new one');

  return tx(() => {
    const deleted = run('DELETE FROM password_resets WHERE id = ?', [row.id]);
    // Zero rows means another request spent it between the read and here.
    if (!deleted.changes) throw badRequest('That reset link has already been used');

    run("UPDATE users SET password_hash = ? WHERE id = ?", [hashPassword(newPassword), row.user_id]);
    return { email: row.email };
  });
}

/** Whether a token would work, without spending it — so the reset page can say
 * "this link has expired" before asking someone to type a new password twice. */
export function passwordResetIsValid(token) {
  const row = get(
    `SELECT pr.id FROM password_resets pr JOIN users u ON u.id = pr.user_id
     WHERE pr.token_hash = ? AND u.active = 1 AND pr.expires_at >= datetime('now')`,
    [digest(String(token))],
  );
  return Boolean(row);
}
