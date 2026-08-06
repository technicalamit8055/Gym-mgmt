import crypto from 'node:crypto';
import { Router } from 'express';
import { issuePlatformToken, readToken } from '../auth.js';
import { config } from '../config.js';
import { get, tenantStorage } from '../db.js';
import { badRequest, forbidden, notFound, tooManyRequests, unauthorized } from '../errors.js';
import { createLimiter } from '../rateLimit.js';
import {
  expireOverdueTrials,
  findTenantBySlug,
  listTenants,
  setTenantStatus,
  setTenantTrialEnd,
  tenantDbPath,
} from '../tenants.js';
import { parse } from '../validate.js';

export const platformAdminRoutes = Router();

/**
 * The console exists only when BOTH credentials are configured.
 *
 * The failure mode this guards against is the obvious one: an unset password
 * must never be read as "no password needed". Every route below re-checks
 * this rather than relying on the mount being skipped, so there is no ordering
 * in which the console can come up unguarded.
 */
export function isPlatformAdminConfigured() {
  return Boolean(config.platformAdminEmail && config.platformAdminPassword);
}

/** Constant-time comparison over fixed-length digests, so neither the length
 * nor the content of the configured credentials leaks through timing. */
function matches(supplied, expected) {
  const a = crypto.createHash('sha256').update(String(supplied)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

const loginLimiter = createLimiter({
  maxAttempts: config.loginMaxAttempts,
  windowMs: config.loginWindowMs,
  lockoutMs: config.loginLockoutMs,
});

platformAdminRoutes.post('/login', (req, res) => {
  if (!isPlatformAdminConfigured()) {
    throw notFound('The operator console is not enabled on this deployment');
  }

  const gate = loginLimiter.check(req.ip);
  if (gate.locked) {
    res.set('Retry-After', String(gate.retryAfterSeconds));
    throw tooManyRequests('Too many failed attempts. Try again later.');
  }
  loginLimiter.recordAttempt(req.ip);

  const body = parse(req.body, {
    email: { type: 'email', required: true },
    password: { type: 'string', required: true },
  });

  // Both comparisons always run — short-circuiting on a wrong email would make
  // "is this address the operator's?" measurable.
  const emailOk = matches(body.email, config.platformAdminEmail);
  const passwordOk = matches(body.password, config.platformAdminPassword);
  if (!emailOk || !passwordOk) throw unauthorized('Those credentials did not work');

  loginLimiter.recordSuccess(req.ip);
  res.json({ token: issuePlatformToken(config.platformAdminEmail), email: config.platformAdminEmail });
});

function requirePlatformAdmin(req, _res, next) {
  if (!isPlatformAdminConfigured()) return next(notFound('The operator console is not enabled on this deployment'));

  const header = req.get('authorization') || '';
  const claims = readToken(header.startsWith('Bearer ') ? header.slice(7) : header);
  if (!claims) return next(unauthorized('Your session has expired, please sign in again'));
  // A gym's own admin token has no scope and must not reach the console, no
  // matter how privileged that admin is inside their own gym.
  if (claims.scope !== 'platform') return next(forbidden('This area is limited to platform operators'));
  if (claims.email !== config.platformAdminEmail) {
    // The configured operator changed since this token was issued.
    return next(unauthorized('Your session has expired, please sign in again'));
  }

  req.platformAdmin = { email: claims.email };
  return next();
}

platformAdminRoutes.use(requirePlatformAdmin);

/** Cheap per-gym numbers for the console list. Opening a gym's DB to count
 * rows is why this is opt-in (`?stats=1`): every gym touched leaves a cached
 * SQLite handle open, which is fine for a page you load on purpose and not
 * something to do on every poll. */
function tenantStats(slug) {
  try {
    return tenantStorage.run({ slug, dbFile: tenantDbPath(slug) }, () => ({
      members: get("SELECT COUNT(*) AS n FROM members WHERE status = 'active'").n,
      staff: get('SELECT COUNT(*) AS n FROM users WHERE active = 1').n,
      visits_30d: get("SELECT COUNT(*) AS n FROM attendance WHERE check_in >= datetime('now', '-30 days')").n,
    }));
  } catch {
    // A registry row whose DB file is missing or unreadable should show up in
    // the list as a problem to look at, not take the whole page down.
    return null;
  }
}

platformAdminRoutes.get('/tenants', (req, res) => {
  // resolveTenant only sweeps lapsed trials when a request resolves to a real
  // gym, and console requests never do — so without this the list would keep
  // showing 'trial' for gyms whose trial ran out days ago.
  expireOverdueTrials();

  const withStats = req.query.stats === '1' || req.query.stats === 'true';
  const items = listTenants().map((tenant) => ({
    slug: tenant.slug,
    gym_name: tenant.gym_name ?? tenant.display_name,
    currency: tenant.currency,
    timezone: tenant.timezone ?? null,
    status: tenant.status,
    trial_ends_on: tenant.trial_ends_on ?? null,
    created_at: tenant.created_at,
    suspended_at: tenant.suspended_at ?? null,
    suspended_reason: tenant.suspended_reason ?? null,
    razorpay_subscription_id: tenant.razorpay_subscription_id ?? null,
    stats: withStats ? tenantStats(tenant.slug) : undefined,
  }));
  res.json({ items, total: items.length });
});

platformAdminRoutes.get('/tenants/:slug', (req, res) => {
  const tenant = findTenantBySlug(req.params.slug);
  if (!tenant) throw notFound('No gym with that address');
  res.json({ tenant, stats: tenantStats(tenant.slug) });
});

const STATUSES = ['trial', 'active', 'suspended', 'cancelled'];

platformAdminRoutes.post('/tenants/:slug/status', (req, res) => {
  const tenant = findTenantBySlug(req.params.slug);
  if (!tenant) throw notFound('No gym with that address');

  const body = parse(req.body, {
    status: { type: 'enum', values: STATUSES, required: true },
    reason: { type: 'string', max: 200 },
    trial_ends_on: { type: 'date' },
  });

  if (body.status === 'trial' && !body.trial_ends_on && !tenant.trial_ends_on) {
    throw badRequest('Some fields need attention', { trial_ends_on: 'is required to start a trial' });
  }

  setTenantStatus(tenant.slug, body.status, body.reason || `set to ${body.status} by operator`);
  if (body.trial_ends_on) setTenantTrialEnd(tenant.slug, body.trial_ends_on);

  res.json({ tenant: findTenantBySlug(tenant.slug) });
});
