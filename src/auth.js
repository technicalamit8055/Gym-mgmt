import crypto from 'node:crypto';
import { config, DEFAULT_TENANT_SLUG } from './config.js';
import { get, run } from './db.js';
import { forbidden, unauthorized } from './errors.js';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, salt, key] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length, SCRYPT);
  return crypto.timingSafeEqual(expected, actual);
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function sign(data) {
  return crypto.createHmac('sha256', config.secret).update(data).digest('base64url');
}

/** Compact signed token: <payload>.<hmac>. No third-party JWT dependency needed. */
export function issueToken(user, tenantSlug) {
  const payload = b64url(
    JSON.stringify({
      sub: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
      tenant: tenantSlug ?? DEFAULT_TENANT_SLUG,
      exp: Math.floor(Date.now() / 1000) + config.tokenTtlSeconds,
    }),
  );
  return `${payload}.${sign(payload)}`;
}

/**
 * Operator-console token, for the person who runs the platform rather than
 * any one gym.
 *
 * Deliberately a different shape from a gym token: it carries `scope` and no
 * `tenant`. requireAuth rejects it everywhere in the gym API (its tenant check
 * compares against a real slug, and undefined never matches), and
 * requirePlatformAdmin rejects every gym token in return (they carry no
 * scope). Neither can be mistaken for the other, in either direction.
 */
export function issuePlatformToken(email) {
  const payload = b64url(
    JSON.stringify({
      scope: 'platform',
      email,
      exp: Math.floor(Date.now() / 1000) + config.tokenTtlSeconds,
    }),
  );
  return `${payload}.${sign(payload)}`;
}

export function readToken(token) {
  const [payload, signature] = String(token || '').split('.');
  if (!payload || !signature) return null;
  const expected = sign(payload);
  if (
    expected.length !== signature.length ||
    !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
  ) {
    return null;
  }
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!claims.exp || claims.exp < Math.floor(Date.now() / 1000)) return null;
    return claims;
  } catch {
    return null;
  }
}

/**
 * Member-portal token, for the self-service app a member/student signs into
 * directly — a different person from any `users` row, and a different shape
 * of token again: `scope: 'member'` (vs. a staff token's bare `role`, and a
 * platform token's `scope: 'platform'`), so a token lifted from any one of
 * the three surfaces is inert on the other two in both directions.
 *
 * Each one is also a row in member_sessions, named by the token's `sid`: the
 * member's Devices screen lists those rows, and deleting one signs that
 * device out at its next request instead of at the token's expiry.
 */
export function issueMemberToken(member, tenantSlug, { userAgent = null } = {}) {
  const sid = crypto.randomBytes(18).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + config.tokenTtlSeconds;
  run("DELETE FROM member_sessions WHERE expires_at < datetime('now')");
  run(
    `INSERT INTO member_sessions (id, member_id, user_agent, expires_at)
     VALUES (?, ?, ?, datetime(?, 'unixepoch'))`,
    [sid, member.id, userAgent ? String(userAgent).slice(0, 400) : null, exp],
  );
  const payload = b64url(
    JSON.stringify({
      scope: 'member',
      sub: member.id,
      member_id: member.id,
      code: member.code,
      sid,
      tenant: tenantSlug ?? DEFAULT_TENANT_SLUG,
      exp,
    }),
  );
  return `${payload}.${sign(payload)}`;
}

export function requireMemberAuth(req, _res, next) {
  const header = req.get('authorization') || '';
  const claims = readToken(header.startsWith('Bearer ') ? header.slice(7) : header);
  if (!claims || claims.scope !== 'member') {
    return next(unauthorized('Your session has expired, please sign in again'));
  }

  const currentTenant = req.tenant?.slug ?? DEFAULT_TENANT_SLUG;
  if (claims.tenant !== currentTenant) {
    return next(unauthorized('Your session has expired, please sign in again'));
  }

  const member = get('SELECT * FROM members WHERE id = ?', [claims.sub]);
  if (!member) return next(unauthorized('This account no longer exists'));

  // A token from before sessions were recorded has no `sid`, and is simply
  // signed in again — they only ever lasted tokenTtlSeconds anyway.
  const session = claims.sid
    ? get('SELECT id FROM member_sessions WHERE id = ? AND member_id = ?', [claims.sid, member.id])
    : null;
  if (!session) return next(unauthorized('You were signed out of this device, please sign in again'));
  // "Active now" on the Devices screen; at most one write a minute per device.
  run(
    `UPDATE member_sessions SET last_seen_at = datetime('now'), user_agent = COALESCE(?, user_agent)
     WHERE id = ? AND last_seen_at < datetime('now', '-60 seconds')`,
    [req.get('user-agent')?.slice(0, 400) ?? null, session.id],
  );

  req.member = member;
  req.memberSessionId = session.id;
  return next();
}

export function requireAuth(req, _res, next) {
  const header = req.get('authorization') || '';
  const claims = readToken(header.startsWith('Bearer ') ? header.slice(7) : header);
  // A staff token carries no `scope` at all — only a member token (`'member'`)
  // and a platform token (`'platform'`) do. Without this check, a member
  // token's `sub` (a members.id) would be looked up against `users.id` below,
  // and the two ID spaces both start at 1 and collide constantly.
  if (!claims || claims.scope) return next(unauthorized('Your session has expired, please sign in again'));

  const currentTenant = req.tenant?.slug ?? DEFAULT_TENANT_SLUG;
  if (claims.tenant !== currentTenant) {
    return next(unauthorized('Your session has expired, please sign in again'));
  }

  const user = get('SELECT id, name, email, role, active FROM users WHERE id = ?', [claims.sub]);
  if (!user || !user.active) return next(unauthorized('This account is no longer active'));

  req.user = user;
  return next();
}

export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) {
      return next(forbidden(`This action is limited to: ${roles.join(', ')}`));
    }
    return next();
  };
}

/** Roles allowed to change money/membership records. */
export const MANAGES_BILLING = ['admin', 'manager'];
