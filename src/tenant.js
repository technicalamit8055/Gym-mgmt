import { DEFAULT_TENANT_SLUG } from './config.js';
import { tenantStorage } from './db.js';
import { findTenantBySlug, isValidSlug, tenantDbPath, RESERVED_SLUGS } from './tenants.js';

function extractSlug(hostHeader) {
  if (!hostHeader) return null;
  const hostname = hostHeader.split(':')[0].toLowerCase();
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

  const tenant = findTenantBySlug(slug);
  if (!tenant) {
    return res.status(404).json({ error: `No gym found for "${slug}"` });
  }
  if (tenant.status === 'suspended' || tenant.status === 'cancelled') {
    return res.status(403).json({ error: 'This account is not currently active. Contact support.' });
  }

  req.tenant = tenant;
  return tenantStorage.run({ slug: tenant.slug, dbFile: tenantDbPath(tenant.slug) }, next);
}
