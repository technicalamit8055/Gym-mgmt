import { config, DEFAULT_TENANT_SLUG } from './config.js';
import { tenantStorage } from './db.js';
import { paymentRequired } from './errors.js';
import { expireOverdueTrials, findTenantBySlug, isValidSlug, tenantDbPath, RESERVED_SLUGS } from './tenants.js';

/** Exported for direct unit testing — no server/network needed to verify
 * the root-domain-matching logic. */
export function extractSlug(hostHeader) {
  if (!hostHeader) return null;
  const hostname = hostHeader.split(':')[0].toLowerCase();

  // Once deployed, the production hostname is known exactly (e.g.
  // "yourapp.fly.dev") — match against it directly rather than inferring
  // from label count, since a host like "<app>.fly.dev" has the same shape
  // (3 labels) as a real "<slug>.yourdomain.com" tenant subdomain would.
  if (config.rootDomain) {
    const root = config.rootDomain.toLowerCase();
    if (hostname === root) return null;
    if (!hostname.endsWith(`.${root}`)) return null;
    const candidate = hostname.slice(0, -(root.length + 1));
    if (candidate.includes('.')) return null; // only one label deep
    if (!isValidSlug(candidate) || RESERVED_SLUGS.has(candidate)) return null;
    return candidate;
  }

  // No ROOT_DOMAIN configured (local dev, tests): fall back to inferring
  // from label count, so "<slug>.localhost" dev-testing keeps working.
  const labels = hostname.split('.');
  if (labels.length < 2) return null; // "localhost", "127.0.0.1"-ish bare hosts
  if (labels.length === 2 && labels[1] !== 'localhost') return null; // bare root domain
  const candidate = labels[0];
  if (!isValidSlug(candidate) || RESERVED_SLUGS.has(candidate)) return null;
  return candidate;
}

/**
 * Resolves which gym (tenant) this request belongs to and scopes every
 * downstream db.js call to that tenant's own SQLite file. Never calls next()
 * without either setting an explicit tenant context or returning a terminal
 * response — an unresolved tenant must not silently fall back to the
 * default database.
 */
export function resolveTenant(req, res, next) {
  const devOverride = process.env.NODE_ENV !== 'production' ? req.get('x-tenant-slug') : null;
  const slug = devOverride || extractSlug(req.get('host'));

  if (!slug) {
    req.tenant = { slug: DEFAULT_TENANT_SLUG };
    return tenantStorage.run({ slug: DEFAULT_TENANT_SLUG, dbFile: undefined }, next);
  }

  // Only once we know this is a real registry lookup — calling this any
  // earlier would force-create data/platform.db on every plain single-tenant
  // dev/test request, which never touches the registry today.
  expireOverdueTrials();

  const tenant = findTenantBySlug(slug);
  if (!tenant) {
    return res.status(404).json({ error: `No gym found for "${slug}"` });
  }
  // 'suspended' (lapsed trial/payment) is recoverable — login and billing
  // must stay reachable so the owner can pay to reactivate. 'cancelled' is a
  // deliberate platform-side action and stays a hard block on everything.
  if (tenant.status === 'cancelled') {
    return res.status(403).json({ error: 'This account is not currently active. Contact support.' });
  }

  req.tenant = tenant;
  return tenantStorage.run({ slug: tenant.slug, dbFile: tenantDbPath(tenant.slug) }, next);
}

/**
 * Gates gym-operational routes behind an active trial/subscription. Mounted
 * after /api/platform and /api/auth in app.js so signup, login, and billing
 * stay reachable while suspended. 'cancelled' tenants never reach here —
 * resolveTenant already hard-blocked them. Dev/single-tenant mode (no
 * registry row, no status field) always passes.
 */
export function requireActiveSubscription(req, _res, next) {
  if (req.tenant?.slug === DEFAULT_TENANT_SLUG) return next();
  if (req.tenant?.status === 'trial' || req.tenant?.status === 'active') return next();
  return next(
    paymentRequired("This gym's subscription is not active. Sign in and subscribe to restore access.", {
      status: req.tenant?.status ?? null,
    }),
  );
}
