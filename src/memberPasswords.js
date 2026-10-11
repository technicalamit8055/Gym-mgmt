import crypto from 'node:crypto';
import { hashPassword, verifyPassword } from './auth.js';
import { config, DEFAULT_TENANT_SLUG } from './config.js';
import { get, run, tx } from './db.js';
import { badRequest, tooManyRequests } from './errors.js';
import { tenantUrl } from './tenant.js';
import { currentVertical } from './verticals.js';
import { sendWhatsAppMessage } from './whatsapp.js';

/**
 * Member-app passwords: the rules, the front desk's temporary passwords, and
 * the emailed 6-digit setup codes.
 *
 * A member gets a password one of three ways — the front desk issues a
 * temporary one (usually sent on WhatsApp) that must be replaced at first
 * sign-in; the member asks for a code at the email on their account and picks
 * their own; or the member asks for a temporary one on WhatsApp themselves
 * (once a day). Setting one signs out every other device.
 */

export const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;

const CODE_TTL_MINUTES = 15;
const CODE_MAX_ATTEMPTS = 5;
const CODE_RESEND_SECONDS = 60;

/**
 * Temporary passwords are one of these plus four digits — "tiger4821" — so a
 * member can read it once and type it from memory. All lowercase, everyday,
 * easy to spell. That's ~1.3M combinations: fine for a password that must be
 * replaced at first sign-in, behind a login limit of a few tries per window.
 */
const TEMP_WORDS = [
  'apple', 'arrow', 'beach', 'bear', 'bird', 'blue', 'boat', 'brave', 'bread', 'brick',
  'cake', 'candy', 'chair', 'chess', 'cloud', 'coin', 'coral', 'crown', 'dance', 'delta',
  'dream', 'drum', 'eagle', 'earth', 'falcon', 'field', 'fire', 'flame', 'flash', 'flower',
  'forest', 'fox', 'fresh', 'frog', 'fruit', 'garden', 'giant', 'gold', 'grape', 'green',
  'happy', 'hawk', 'heart', 'hero', 'hill', 'honey', 'horse', 'iron', 'island', 'jungle',
  'kite', 'lake', 'lemon', 'light', 'lion', 'lotus', 'lucky', 'magic', 'mango', 'maple',
  'metal', 'moon', 'mountain', 'music', 'ocean', 'olive', 'orange', 'panda', 'paper', 'peach',
  'pearl', 'pepper', 'piano', 'pilot', 'planet', 'power', 'queen', 'rain', 'river', 'robin',
  'rock', 'rocket', 'rose', 'royal', 'ruby', 'sail', 'shark', 'silver', 'sky', 'smile',
  'snow', 'speed', 'spark', 'spring', 'star', 'steel', 'stone', 'storm', 'strong', 'sugar',
  'summer', 'sun', 'swift', 'tea', 'thunder', 'tiger', 'tower', 'train', 'tree', 'tulip',
  'wave', 'whale', 'wind', 'winter', 'wolf', 'zebra',
];

/** Throws a 400 naming `field` when a new password breaks the rules. */
export function assertGoodPassword(password, member, field = 'new_password') {
  const value = String(password ?? '');
  const fail = (message) => {
    throw badRequest(message, { [field]: message });
  };
  if (value.length < PASSWORD_MIN) fail(`Use at least ${PASSWORD_MIN} characters`);
  if (value.length > PASSWORD_MAX) fail(`Use at most ${PASSWORD_MAX} characters`);
  const phoneDigits = String(member.phone || '').replace(/\D/g, '');
  const isMemberCode = value.toLowerCase() === String(member.code || '').toLowerCase();
  const isPhone = phoneDigits.length >= 6 && /^[\d\s()+-]+$/.test(value) && value.replace(/\D/g, '') === phoneDigits;
  if (isMemberCode || isPhone) fail('Pick something other than your member ID or phone number');
}

export function hasPassword(member) {
  return Boolean(member.portal_password_hash);
}

export function checkPassword(member, password) {
  return hasPassword(member) && verifyPassword(String(password ?? ''), member.portal_password_hash);
}

/**
 * Stores a new password and signs out every device except `keepSessionId`
 * (the one making the change, if any) — a reset is exactly when an old,
 * possibly stolen sign-in should stop working.
 */
export function setMemberPassword(memberId, password, { temporary = false, keepSessionId = null } = {}) {
  tx(() => {
    run(
      `UPDATE members SET portal_password_hash = ?, portal_password_temp = ?, portal_password_set_at = datetime('now'),
         portal_reset_hash = NULL
       WHERE id = ?`,
      [hashPassword(password), temporary ? 1 : 0, memberId],
    );
    run('DELETE FROM member_password_codes WHERE member_id = ?', [memberId]);
    run('DELETE FROM push_subscriptions WHERE member_id = ? AND session_id IS NOT ?', [memberId, keepSessionId]);
    run('DELETE FROM member_sessions WHERE member_id = ? AND id IS NOT ?', [memberId, keepSessionId]);
  });
}

/** A word and four digits, e.g. "tiger4821" — always 8+ characters. */
export function generateTemporaryPassword() {
  const word = TEMP_WORDS[crypto.randomInt(TEMP_WORDS.length)];
  const digits = String(crypto.randomInt(0, 10_000)).padStart(4, '0');
  return `${word}${digits}`;
}

/* ── "Forgot password? Get it on WhatsApp" ── */

const RESET_COOLDOWN_HOURS = 24;

/**
 * Reserves this member's one self-service WhatsApp send for the next
 * RESET_COOLDOWN_HOURS, in a single UPDATE so two taps at once can't both
 * send. Returns the seconds left to wait when it's already been used, or 0
 * with the previous timestamp for releaseWhatsAppReset if the send fails.
 */
export function claimWhatsAppReset(memberId) {
  const before = get('SELECT portal_reset_sent_at FROM members WHERE id = ?', [memberId]);
  const claimed = run(
    `UPDATE members SET portal_reset_sent_at = datetime('now')
     WHERE id = ? AND (portal_reset_sent_at IS NULL OR portal_reset_sent_at <= datetime('now', ?))`,
    [memberId, `-${RESET_COOLDOWN_HOURS} hours`],
  ).changes;
  if (claimed) return { wait: 0, previous: before?.portal_reset_sent_at ?? null };
  const row = get(
    `SELECT CAST(strftime('%s', portal_reset_sent_at, ?) - strftime('%s', 'now') AS INTEGER) AS wait
     FROM members WHERE id = ?`,
    [`+${RESET_COOLDOWN_HOURS} hours`, memberId],
  );
  return { wait: Math.max(1, row?.wait ?? 1) };
}

/** Gives the day's send back after it failed to go out. */
export function releaseWhatsAppReset(memberId, previous) {
  run('UPDATE members SET portal_reset_sent_at = ? WHERE id = ?', [previous, memberId]);
}

/**
 * Keeps the sent password beside the real one. It has no expiry: it works
 * until the member signs in with it, sets a password some other way, or asks
 * again (a day later at the soonest) and gets a new one in its place.
 */
export function storeResetPassword(memberId, password) {
  run('UPDATE members SET portal_reset_hash = ? WHERE id = ?', [hashPassword(password), memberId]);
}

export function checkResetPassword(member, password) {
  return Boolean(member.portal_reset_hash) && verifyPassword(String(password ?? ''), member.portal_reset_hash);
}

/** "in 5 hours" / "in 40 minutes" for a wait in seconds. */
export function waitPhrase(seconds) {
  const hours = Math.floor(seconds / 3600);
  if (hours >= 1) return `in ${hours} hour${hours === 1 ? '' : 's'}`;
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return `in ${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/**
 * Sends a member their app link, ID and a temporary password from the gym's
 * linked WhatsApp. `reason: 'reset'` is the member's own "forgot password"
 * request; anything else is the front desk issuing a login. The delivery log
 * keeps the message with the password masked.
 */
export async function sendLoginOnWhatsApp(req, member, password, { reason = 'issued' } = {}) {
  const slug = req.tenant?.slug;
  const base = slug && slug !== DEFAULT_TENANT_SLUG ? tenantUrl(req, slug) : `${req.protocol}://${req.get('host')}`;
  const gymName = req.tenant?.gym_name || config.gymName || 'GymBook';
  const reset = reason === 'reset';
  const lines = (secret) =>
    [
      `Hi ${member.first_name} 👋`,
      '',
      reset
        ? `You asked to reset your app password for *${gymName}* 🔐`
        : `Here's your app login for *${gymName}* 💪`,
      '',
      `🌐 App: ${base}/#/portal`,
      `🆔 ${currentVertical().key === 'library' ? 'Student' : 'Member'} ID: ${member.code}`,
      `🔑 Password: ${secret}`,
      '',
      '✅ Sign in with these, then choose your own password.',
      reset
        ? "🙅 Didn't ask for this? Just ignore this message — your current password still works."
        : "🔒 Please don't share this message with anyone.",
    ].join('\n');
  return sendWhatsAppMessage({ phone: member.phone, message: lines(password), logMessage: lines('••••••••'), memberId: member.id });
}

/** "••••••3210" — enough for the member to recognise their number. */
export function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return `••••••${digits.slice(-4)}`;
}

/** "ra•••@gmail.com" — enough for the member to recognise their address. */
export function maskEmail(email) {
  const [user, domain] = String(email).split('@');
  if (!domain) return '•••';
  return `${user.slice(0, Math.min(2, user.length))}•••@${domain}`;
}

/** Keyed by member, so a code digest is useless against any other account;
 * HMAC rather than scrypt because the code lives fifteen minutes at most. */
const codeDigest = (memberId, code) =>
  crypto.createHmac('sha256', config.secret).update(`${memberId}:${code}`).digest('hex');

/**
 * Creates the member's 6-digit setup code, replacing any earlier one. Refuses
 * a second code inside CODE_RESEND_SECONDS so the button can't be used to
 * flood someone's inbox.
 */
export function issueSetupCode(memberId) {
  const recent = get(
    `SELECT CAST(strftime('%s', 'now') - strftime('%s', created_at) AS INTEGER) AS age
     FROM member_password_codes WHERE member_id = ?`,
    [memberId],
  );
  if (recent && recent.age < CODE_RESEND_SECONDS) {
    throw tooManyRequests(`Wait ${CODE_RESEND_SECONDS - recent.age}s before asking for another code`);
  }
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  run(
    `INSERT INTO member_password_codes (member_id, code_hash, attempts, created_at, expires_at)
     VALUES (?, ?, 0, datetime('now'), datetime('now', ?))
     ON CONFLICT(member_id) DO UPDATE SET
       code_hash = excluded.code_hash, attempts = 0, created_at = excluded.created_at, expires_at = excluded.expires_at`,
    [memberId, codeDigest(memberId, code), `+${CODE_TTL_MINUTES} minutes`],
  );
  return { code, expires_in_minutes: CODE_TTL_MINUTES };
}

/**
 * Checks a setup code without spending it — the caller spends it by setting
 * the password (setMemberPassword deletes the row). Five wrong guesses burn
 * the code, so the million-code space can't be walked.
 */
export function assertSetupCode(memberId, code) {
  const row = get(
    "SELECT code_hash, attempts, expires_at < datetime('now') AS expired FROM member_password_codes WHERE member_id = ?",
    [memberId],
  );
  const invalid = (message) => badRequest(message, { code: message });
  if (!row || row.expired) {
    if (row) run('DELETE FROM member_password_codes WHERE member_id = ?', [memberId]);
    throw invalid('That code has expired. Ask for a new one.');
  }
  const given = codeDigest(memberId, String(code ?? '').replace(/\D/g, ''));
  if (!crypto.timingSafeEqual(Buffer.from(given), Buffer.from(row.code_hash))) {
    if (row.attempts + 1 >= CODE_MAX_ATTEMPTS) {
      run('DELETE FROM member_password_codes WHERE member_id = ?', [memberId]);
      throw invalid('Too many wrong codes. Ask for a new one.');
    }
    run('UPDATE member_password_codes SET attempts = attempts + 1 WHERE member_id = ?', [memberId]);
    throw invalid('That code is not right. Check the email and try again.');
  }
}
