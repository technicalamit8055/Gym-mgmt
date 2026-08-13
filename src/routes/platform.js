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
import { parsePhotoDataUrl } from '../photo.js';
import { BUSINESS_TYPES, verticalFor } from '../verticals.js';
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

export function tenantLogoUrl(slug, version = 1) {
  const store = tenantStorage.getStore();
  const prefix = store?.pathPrefix ?? '';
  return `${prefix}/api/platform/tenant-logo/${slug}?v=${version}`;
}

/** The logo redrawn as a square home-screen icon. Shares logo_version, so a
 * new logo is a new URL for both and no cache needs invalidating. */
export function tenantIconUrl(slug, version = 1) {
  const store = tenantStorage.getStore();
  const prefix = store?.pathPrefix ?? '';
  return `${prefix}/api/platform/tenant-icon/${slug}?v=${version}`;
}

export const hasTenantLogo = (tenant) => Boolean(tenant?.logo_bytes && tenant?.logo_mime);
export const hasTenantIcon = (tenant) => Boolean(tenant?.icon_bytes && tenant?.icon_mime);

/** The gym-owned fields of a registry row. Deliberately omits db_file and
 * every razorpay_* column — the front end never needs them and this response
 * is public. */
function publicTenant(tenant) {
  const version = tenant.logo_version || 1;
  const vertical = verticalFor(tenant.business_type);
  return {
    slug: tenant.slug,
    gym_name: tenant.gym_name ?? tenant.display_name,
    currency: tenant.currency,
    timezone: tenant.timezone ?? null,
    status: tenant.status,
    // Which product this account runs. The SPA reads this before it renders
    // anything — the sidebar, every page title and every noun follow from it —
    // which is why it rides on this already-first, already-public call rather
    // than needing one of its own.
    business_type: vertical.key,
    vertical: {
      key: vertical.key,
      brand: vertical.brand,
      tagline: vertical.tagline,
      modules: [...vertical.modules],
    },
    trial_ends_on: tenant.trial_ends_on ?? null,
    logo_url: hasTenantLogo(tenant) ? tenantLogoUrl(tenant.slug, version) : null,
    // What the browser tab and an iOS home screen should show. The purpose-
    // built icon when there is one; otherwise the logo itself, which still
    // beats falling back to the generic GymBook barbell. Null means this gym
    // has uploaded nothing and the app's own icons stand.
    app_icon_url: hasTenantIcon(tenant)
      ? tenantIconUrl(tenant.slug, version)
      : hasTenantLogo(tenant)
        ? tenantLogoUrl(tenant.slug, version)
        : null,
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
    // Decided here and only here. There is no self-service switch afterwards:
    // the nav, the seeded catalogue and the member-code prefix all follow from
    // it, so changing it mid-life is an operator-console repair, not a setting.
    business_type: { type: 'enum', values: BUSINESS_TYPES, default: 'gym' },
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
    businessType: body.business_type,
  });

  // One scope for the whole of the new gym's provisioning: opening its DB file
  // is what creates it (schema + migrations run on first open), so the admin
  // account and the starter plans have to be written from inside it.
  //
  // businessType has to be in this store, not just on the registry row: the
  // seeders below read it to decide which catalogue to write.
  const provisioned = tenantStorage.run(
    {
      slug: tenant.slug,
      dbFile: tenantDbPath(tenant.slug),
      timezone: tenant.timezone || undefined,
      businessType: tenant.business_type || 'gym',
    },
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
    business_type: tenant.business_type,
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

/** Serve gym logo publicly so browser and login page can display it. */
platformRoutes.get('/tenant-logo/:slug', (req, res) => {
  const slug = req.params.slug;
  if (!slug || !isValidSlug(slug)) {
    throw notFound('Gym not found');
  }
  const tenant = findTenantBySlug(slug);
  if (!tenant || !tenant.logo_bytes || !tenant.logo_mime) {
    throw notFound('No logo found for this gym');
  }
  res.setHeader('Content-Type', tenant.logo_mime);
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(Buffer.from(tenant.logo_bytes));
});

/**
 * The gym's home-screen icon, referenced by the web app manifest.
 *
 * Public and unauthenticated like the logo above: a browser fetches manifest
 * icons with no credentials, and an install would simply fail if this needed a
 * session. Nothing here is more secret than the logo on the login page.
 */
platformRoutes.get('/tenant-icon/:slug', (req, res) => {
  const slug = req.params.slug;
  if (!slug || !isValidSlug(slug)) {
    throw notFound('Gym not found');
  }
  const tenant = findTenantBySlug(slug);
  if (!hasTenantIcon(tenant)) {
    throw notFound('No app icon found for this gym');
  }
  res.setHeader('Content-Type', tenant.icon_mime);
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(Buffer.from(tenant.icon_bytes));
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
    clear_logo: { type: 'boolean' },
  });

  if (body.timezone) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: body.timezone });
    } catch {
      throw badRequest('Some fields need attention', { timezone: 'is not a recognised timezone' });
    }
  }

  let logoMime;
  let logoBytes;
  let iconMime;
  let iconBytes;
  let clearLogo = Boolean(body.clear_logo);

  if (!clearLogo && typeof req.body.logo_data === 'string' && req.body.logo_data.startsWith('data:image/')) {
    const parsed = parsePhotoDataUrl(req.body.logo_data);
    logoMime = parsed.mime;
    logoBytes = parsed.bytes;

    // Drawn from the same file by the browser, and only meaningful alongside a
    // logo — an icon on its own is ignored rather than stored orphaned.
    if (typeof req.body.icon_data === 'string' && req.body.icon_data.startsWith('data:image/')) {
      const icon = parsePhotoDataUrl(req.body.icon_data);
      iconMime = icon.mime;
      iconBytes = icon.bytes;
    }
  } else if (req.body.logo_data === null || req.body.logo_data === '') {
    clearLogo = true;
  }

  const updated = updateTenantProfile(slug, {
    gymName: body.gym_name,
    currency: body.currency ? body.currency.toUpperCase() : undefined,
    timezone: body.timezone,
    logoMime,
    logoBytes,
    iconMime,
    iconBytes,
    clearLogo,
  });
  res.json({ tenant: publicTenant(updated) });
});
