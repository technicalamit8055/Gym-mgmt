import { Router } from 'express';
import { ensureAdminAccount, seedStarterPlans } from '../bootstrap.js';
import { issueToken, requireAuth, requireRole } from '../auth.js';
import { config, DEFAULT_TENANT_SLUG } from '../config.js';
import { get, tenantStorage } from '../db.js';
import { badRequest, conflict, notFound, tooManyRequests } from '../errors.js';
import { createLimiter } from '../rateLimit.js';
import { tenantUrl } from '../tenant.js';
import {
  createTenant,
  findTenantBySlug,
  isValidSlug,
  tenantDbPath,
  updateTenantProfile,
  RESERVED_SLUGS,
} from '../tenants.js';
import { addDays, parse, today } from '../validate.js';
import { billingRoutes } from './billing.js';
import { platformAdminRoutes, isPlatformAdminConfigured } from './platformAdmin.js';

export const platformRoutes = Router();
platformRoutes.use('/billing', billingRoutes);
platformRoutes.use('/admin', platformAdminRoutes);

// IP-keyed, not per-slug: each signup provisions a real SQLite file, so this
// guards against spam-tenant creation, not credential guessing.
const signupLimiter = createLimiter({
  maxAttempts: config.signupMaxAttempts,
  windowMs: config.signupWindowMs,
  lockoutMs: config.signupLockoutMs,
});

/** The gym-owned fields of a registry row. Deliberately omits db_file and
 * every razorpay_* column — the front end never needs them and this response
 * is public. */
function publicTenant(tenant) {
  return {
    slug: tenant.slug,
    gym_name: tenant.gym_name ?? tenant.display_name,
    currency: tenant.currency,
    timezone: tenant.timezone ?? null,
    status: tenant.status,
    trial_ends_on: tenant.trial_ends_on ?? null,
  };
}

/**
 * Tells the front end which gym it is looking at, before anyone signs in.
 *
 * Public on purpose: the login screen needs the gym's name and currency to
 * brand itself, and a browser sitting on the root domain needs to know there
 * is no gym here so it can show the landing page instead. Everything returned
 * is already visible to anyone who can reach the address.
 */
platformRoutes.get('/tenant', (req, res) => {
  const slug = req.tenant?.slug ?? DEFAULT_TENANT_SLUG;

  if (slug === DEFAULT_TENANT_SLUG) {
    return res.json({
      tenant: null,
      trial_days: config.trialDays,
      url_mode: config.tenantUrlMode,
      platform_admin: isPlatformAdminConfigured(),
    });
  }

  res.json({
    tenant: publicTenant(req.tenant),
    trial_days: config.trialDays,
    url_mode: config.tenantUrlMode,
    platform_admin: isPlatformAdminConfigured(),
  });
});

/** Live feedback while the owner types their gym address, so they find out a
 * slug is taken before they have filled in the rest of the form. */
platformRoutes.get('/slug-available', (req, res) => {
  const slug = String(req.query.slug || '').trim().toLowerCase();
  if (!slug) return res.json({ slug, available: false, reason: 'Pick a gym address' });
  if (!isValidSlug(slug) || RESERVED_SLUGS.has(slug)) {
    return res.json({
      slug,
      available: false,
      reason: '3–40 characters, lowercase letters, numbers and dashes, starting with a letter',
    });
  }
  if (findTenantBySlug(slug)) return res.json({ slug, available: false, reason: 'That address is already taken' });
  res.json({ slug, available: true, reason: null });
});

platformRoutes.post('/signup', (req, res) => {
  const gate = signupLimiter.check(req.ip);
  if (gate.locked) {
    res.set('Retry-After', String(gate.retryAfterSeconds));
    throw tooManyRequests('Too many signups from this address. Try again later.');
  }
  signupLimiter.recordAttempt(req.ip);

  const body = parse(req.body, {
    slug: { type: 'string', required: true, min: 3, max: 40 },
    gym_name: { type: 'string', required: true, min: 2, max: 120 },
    admin_name: { type: 'string', required: true, min: 2, max: 80 },
    admin_email: { type: 'email', required: true },
    admin_password: { type: 'string', required: true, min: 8 },
    currency: { type: 'string', max: 8, default: 'INR' },
    timezone: { type: 'string', max: 64 },
  });

  const slug = body.slug.toLowerCase();
  if (!isValidSlug(slug) || RESERVED_SLUGS.has(slug)) {
    throw badRequest('Choose a different gym address', { slug: 'not available' });
  }
  if (findTenantBySlug(slug)) throw conflict('That gym address is already taken');

  const tenant = createTenant({
    slug,
    displayName: body.gym_name,
    currency: body.currency,
    timezone: body.timezone || null,
    trialEndsOn: addDays(today(), config.trialDays),
  });

  // One scope for the whole of the new gym's provisioning: opening its DB file
  // is what creates it (schema + migrations run on first open), so the admin
  // account and the starter plans have to be written from inside it.
  const provisioned = tenantStorage.run(
    { slug: tenant.slug, dbFile: tenantDbPath(tenant.slug), timezone: tenant.timezone || undefined },
    () => {
      ensureAdminAccount({ email: body.admin_email, password: body.admin_password, name: body.admin_name });
      const plans = seedStarterPlans(tenant.currency);
      // Read the row back rather than trusting ensureAdminAccount's return: it
      // answers null when a user already exists, and the token needs a real id.
      const admin = get('SELECT id, name, email, role FROM users WHERE email = ?', [body.admin_email.toLowerCase()]);
      return { admin, plans };
    },
  );

  res.status(201).json({
    slug: tenant.slug,
    admin_email: provisioned.admin?.email ?? body.admin_email,
    starter_plans: provisioned.plans,
    app_url: tenantUrl(req, tenant.slug),
    trial_ends_on: tenant.trial_ends_on,
    // Signing the owner straight in: they just proved they own this account by
    // choosing its password thirty milliseconds ago, and bouncing them to a
    // login form to retype it is friction with no security value.
    token: provisioned.admin ? issueToken(provisioned.admin, tenant.slug) : null,
    user: provisioned.admin ?? null,
  });
});

/** The gym's own settings. Admin-only, and only ever touches the row for the
 * tenant this request already resolved to — a slug is never taken from the body. */
platformRoutes.patch('/tenant', requireAuth, requireRole('admin'), (req, res) => {
  const slug = req.tenant?.slug;
  if (!slug || slug === DEFAULT_TENANT_SLUG) {
    throw notFound('This login is not attached to a gym account');
  }

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

  const updated = updateTenantProfile(slug, {
    gymName: body.gym_name,
    currency: body.currency ? body.currency.toUpperCase() : undefined,
    timezone: body.timezone,
  });
  res.json({ tenant: publicTenant(updated) });
});
