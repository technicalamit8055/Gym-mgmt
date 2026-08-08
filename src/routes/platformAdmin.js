import crypto from 'node:crypto';
import fs from 'node:fs';
import { Router } from 'express';
import { issuePlatformToken, readToken } from '../auth.js';
import { archiveTenantDatabase, listBackups, runBackup } from '../backup.js';
import { config } from '../config.js';
import { all, closeDb, get, tenantStorage } from '../db.js';
import { badRequest, conflict, forbidden, notFound, tooManyRequests, unauthorized } from '../errors.js';
import { issuePasswordReset } from '../passwordReset.js';
import { createLimiter } from '../rateLimit.js';
import { s3Configured } from '../s3.js';
import { tenantUrl } from '../tenant.js';
import {
  deleteTenant,
  expireOverdueTrials,
  findTenantBySlug,
  listDevicesForTenant,
  listTenants,
  setTenantStatus,
  setTenantTrialEnd,
  tenantDbPath,
  updateTenantProfile,
  withoutLogoBytes,
} from '../tenants.js';
import { parse, startOfMonth, today } from '../validate.js';
import { getWhatsAppStatus, hasStoredCredentials } from '../whatsapp.js';

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

/**
 * Runs `fn` against one gym's own database.
 *
 * The timezone goes into the store because money and joining dates are
 * gym-local calendar facts: without it, `today()` inside would answer in the
 * server's zone and a gym in IST would see its early-morning takings land in
 * the wrong month.
 */
function inTenant(tenant, fn) {
  const slug = typeof tenant === 'string' ? tenant : tenant.slug;
  const timezone = typeof tenant === 'string' ? undefined : tenant.timezone || undefined;
  return tenantStorage.run({ slug, dbFile: tenantDbPath(slug), timezone }, fn);
}

/** Cheap per-gym numbers for the console list. Opening a gym's DB to count
 * rows is why this is opt-in (`?stats=1`): every gym touched leaves a cached
 * SQLite handle open, which is fine for a page you load on purpose and not
 * something to do on every poll. */
function tenantStats(tenant) {
  try {
    return inTenant(tenant, () => {
      const monthStart = startOfMonth(today());
      return {
        members: get("SELECT COUNT(*) AS n FROM members WHERE status = 'active'").n,
        members_total: get('SELECT COUNT(*) AS n FROM members').n,
        staff: get('SELECT COUNT(*) AS n FROM users WHERE active = 1').n,
        visits_30d: get("SELECT COUNT(*) AS n FROM attendance WHERE check_in >= datetime('now', '-30 days')").n,
        new_members_month: get('SELECT COUNT(*) AS n FROM members WHERE joined_on >= ?', [monthStart]).n,
        revenue_month: get('SELECT COALESCE(SUM(amount), 0) AS n FROM payments WHERE paid_on >= ?', [monthStart]).n,
        revenue_total: get('SELECT COALESCE(SUM(amount), 0) AS n FROM payments').n,
        last_visit_at: get('SELECT MAX(check_in) AS t FROM attendance').t ?? null,
      };
    });
  } catch {
    // A registry row whose DB file is missing or unreadable should show up in
    // the list as a problem to look at, not take the whole page down.
    return null;
  }
}

/**
 * The deeper per-gym picture behind a single row — who runs it, what it sells,
 * and whether its integrations are actually live.
 */
function tenantDetail(tenant) {
  try {
    return inTenant(tenant, () => ({
      staff: all('SELECT id, name, email, role, active, created_at FROM users ORDER BY id'),
      plans: all('SELECT name, price, duration_days, active FROM plans ORDER BY id LIMIT 20'),
      recent_payments: all(
        `SELECT pay.amount, pay.method, pay.paid_on, m.first_name, m.last_name
           FROM payments pay
           JOIN members m ON m.id = pay.member_id
          ORDER BY pay.paid_on DESC, pay.id DESC
          LIMIT 8`,
      ),
    }));
  } catch {
    return null;
  }
}

/**
 * Whether this gym's WhatsApp is linked — deliberately without the pairing QR.
 *
 * The QR *is* the credential: anyone who scans it links their own phone to the
 * gym's number and can message its members as the gym. The operator has no
 * reason to hold that, so only the state crosses this boundary.
 */
function whatsappSummary(slug) {
  const status = getWhatsAppStatus(slug);
  return {
    state: status.state,
    connected: status.connected,
    error: status.error ?? null,
    has_credentials: hasStoredCredentials(slug),
  };
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
    stats: withStats ? tenantStats(tenant) : undefined,
  }));
  res.json({ items, total: items.length });
});

/**
 * Platform growth, straight off the registry.
 *
 * Deliberately touches no gym's database: `/tenants?stats=1` already opens
 * every one of them and carries per-gym revenue back, so the console rolls the
 * money up from rows it has already been given rather than paying for a second
 * pass over every SQLite file on the deployment.
 */
platformAdminRoutes.get('/analytics', (_req, res) => {
  expireOverdueTrials();
  const tenants = listTenants();

  // Last 12 months, pre-seeded so a month nobody signed up in reads as a zero
  // rather than dropping out of the series and distorting its shape.
  const months = new Map();
  const now = new Date();
  for (let back = 11; back >= 0; back -= 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    months.set(d.toISOString().slice(0, 7), 0);
  }
  for (const tenant of tenants) {
    const key = String(tenant.created_at || '').slice(0, 7);
    if (months.has(key)) months.set(key, months.get(key) + 1);
  }

  const byStatus = {};
  for (const tenant of tenants) byStatus[tenant.status] = (byStatus[tenant.status] || 0) + 1;

  res.json({
    total: tenants.length,
    by_status: byStatus,
    signups_by_month: [...months].map(([month, count]) => ({ month, count })),
  });
});

platformAdminRoutes.get('/tenants/:slug', (req, res) => {
  const tenant = findTenantBySlug(req.params.slug);
  if (!tenant) throw notFound('No gym with that address');
  res.json({
    // Without this the logo BLOB would be serialised into the response as a
    // byte-per-array-entry JSON object — megabytes of noise nobody reads.
    tenant: withoutLogoBytes(tenant),
    stats: tenantStats(tenant),
    detail: tenantDetail(tenant),
    devices: listDevicesForTenant(tenant.slug),
    whatsapp: whatsappSummary(tenant.slug),
    url: tenantUrl(req, tenant.slug),
  });
});

/**
 * Edits a gym's identity on its owner's behalf — the support case where
 * someone typed their gym's name wrong at signup, or moved cities and needs
 * their timezone corrected.
 *
 * Billing status is not reachable here; that has its own route, so a rename
 * can never silently change what a gym is paying.
 */
platformAdminRoutes.patch('/tenants/:slug', (req, res) => {
  const tenant = findTenantBySlug(req.params.slug);
  if (!tenant) throw notFound('No gym with that address');

  const body = parse(req.body, {
    gym_name: { type: 'string', min: 2, max: 120 },
    currency: { type: 'string', min: 1, max: 8 },
    timezone: { type: 'string', max: 64 },
  });

  if (body.timezone) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: body.timezone });
    } catch {
      throw badRequest('Some fields need attention', { timezone: 'is not a recognised timezone' });
    }
  }

  const updated = updateTenantProfile(tenant.slug, {
    gymName: body.gym_name,
    currency: body.currency ? body.currency.toUpperCase() : undefined,
    timezone: body.timezone,
  });
  console.warn(`[platform] gym "${tenant.slug}" profile edited by ${req.platformAdmin.email}`);
  res.json({ tenant: withoutLogoBytes(updated) });
});

/**
 * Permanently deletes a gym: its registry row, its devices and its database.
 *
 * The only irreversible thing this console can do, so it is guarded three ways
 * — the gym must already be cancelled (so a live gym cannot be destroyed by a
 * misclick), the caller must echo its slug back, and a verified snapshot is
 * written first and the delete abandoned if that snapshot cannot be taken.
 */
platformAdminRoutes.delete('/tenants/:slug', (req, res) => {
  const tenant = findTenantBySlug(req.params.slug);
  if (!tenant) throw notFound('No gym with that address');

  if (tenant.status !== 'cancelled') {
    throw badRequest('Only a cancelled gym can be deleted — set its status to Cancelled first', {
      status: `is "${tenant.status}"`,
    });
  }
  if (String(req.body?.confirm_slug ?? '') !== tenant.slug) {
    throw badRequest('Type the gym’s address exactly to confirm', { confirm_slug: 'does not match' });
  }

  const dbFile = tenantDbPath(tenant.slug);

  let archive;
  try {
    archive = archiveTenantDatabase(tenant.slug, dbFile);
  } catch (err) {
    throw conflict(`Refusing to delete: could not archive this gym first (${err.message})`);
  }

  // Close before unlinking. An open handle would keep writing its WAL back out
  // after the delete, and on Windows the unlink simply fails.
  closeDb(dbFile);
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(`${dbFile}${suffix}`, { force: true });
    } catch (err) {
      console.error(`[platform] could not remove ${dbFile}${suffix}: ${err.message}`);
    }
  }

  deleteTenant(tenant.slug);
  console.warn(
    `[platform] gym "${tenant.slug}" DELETED by ${req.platformAdmin.email}; archived to ${archive.file ?? 'nothing (no database file)'}`,
  );

  res.json({
    ok: true,
    slug: tenant.slug,
    archived_to: archive.file ?? null,
    archived_rows: archive.rows ?? null,
  });
});

/* ── Backups ─────────────────────────────────────────────────────────── */

/** One backup at a time per process: two concurrent VACUUM INTO runs would
 * race on the same destination folder and each report the other's files. */
let backupInFlight = false;

platformAdminRoutes.get('/backups', (_req, res) => {
  res.json({
    items: listBackups({ limit: 20 }),
    running: backupInFlight,
    offsite: s3Configured(),
    dir: config.backup.dir,
    interval_hours: config.backup.intervalHours,
    keep: config.backup.keep,
  });
});

platformAdminRoutes.post('/backups/run', async (req, res) => {
  if (backupInFlight) throw conflict('A backup is already running');
  backupInFlight = true;
  try {
    const summary = await runBackup({ quiet: true });
    console.warn(`[platform] manual backup ${summary.stamp} run by ${req.platformAdmin.email}`);
    res.json(summary);
  } finally {
    backupInFlight = false;
  }
});

/**
 * Issues a password reset link for a gym whose owner is locked out.
 *
 * The operator is the out-of-band authority here — they already control every
 * gym's status and billing from this console, so being able to hand back a
 * one-hour single-use link grants nothing they could not already do. The link
 * is returned to the operator to pass on, never emailed, because this app has
 * no mail transport.
 *
 * Available whatever the tenant's status: a suspended gym is exactly the case
 * where someone needs to get back in to pay.
 */
platformAdminRoutes.post('/tenants/:slug/password-reset', (req, res) => {
  const tenant = findTenantBySlug(req.params.slug);
  if (!tenant) throw notFound('No gym with that address');

  const body = parse(req.body, { email: { type: 'email' } });

  const issued = tenantStorage.run(
    { slug: tenant.slug, dbFile: tenantDbPath(tenant.slug), timezone: tenant.timezone || undefined },
    () => issuePasswordReset(body.email),
  );

  console.warn(
    `[platform] password reset issued for ${issued.email} at gym "${tenant.slug}" by ${req.platformAdmin.email}`,
  );

  res.json({
    slug: tenant.slug,
    email: issued.email,
    name: issued.name,
    expires_at: issued.expires_at,
    expires_in_minutes: issued.expires_in_minutes,
    // Both forms, because which one reaches this gym depends on whether the
    // deployment has wildcard DNS — see tenantUrl() in tenant.js.
    reset_path: `/g/${tenant.slug}/#/reset?token=${issued.token}`,
    url: `${tenantUrl(req, tenant.slug)}/#/reset?token=${issued.token}`,
  });
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
