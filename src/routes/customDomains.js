import { Router } from 'express';
import { requireAuth, requireRole } from '../auth.js';
import { DEFAULT_TENANT_SLUG } from '../config.js';
import {
  addDomain,
  describeHostname,
  findDomainById,
  hostnameOf,
  listDomainsForTenant,
  mayIssueCertificate,
  removeDomain,
  runDomainCheck,
  serializeDomain,
  setupInfo,
  validateHostname,
} from '../customDomains.js';
import { notFound } from '../errors.js';
import { tenantPlatformUrl } from '../tenant.js';

/**
 * A gym connecting its own domain, from Gym settings.
 *
 * Like the rest of /api/platform, only ever acts on the gym this request
 * resolved to — a slug is never taken from the body — and stays reachable
 * while the gym is suspended, the same as the settings page it sits on.
 * Anyone on staff can see the domains; only an admin can change them.
 */
export const tenantDomainRoutes = Router();
tenantDomainRoutes.use(requireAuth);

function gymSlug(req) {
  const slug = req.tenant?.slug;
  if (!slug || slug === DEFAULT_TENANT_SLUG) throw notFound('This login is not attached to a gym account');
  return slug;
}

function ownDomain(req) {
  const slug = gymSlug(req);
  const domain = findDomainById(Number(req.params.id));
  // Someone else's id answers exactly like a missing one.
  if (!domain || domain.tenant_slug !== slug) throw notFound('No such domain on this account');
  return domain;
}

tenantDomainRoutes.get('/', (req, res) => {
  const slug = gymSlug(req);
  res.json({
    ...setupInfo(),
    // The address that keeps working whatever happens to the custom domain's
    // DNS — the one to fall back to, and to use while setting it up.
    platform_url: tenantPlatformUrl(req, slug),
    // Which domain this page is being viewed on, so the UI can warn before
    // someone removes the address they are standing on.
    current_host: req.customDomain ?? null,
    items: listDomainsForTenant(slug).map(serializeDomain),
  });
});

/** Live feedback while the owner types: is it valid, and root or subdomain? */
tenantDomainRoutes.get('/inspect', (req, res) => {
  gymSlug(req);
  const result = validateHostname(req.query.hostname);
  if (result.error) return res.json({ valid: false, error: result.error });
  res.json({ valid: true, ...describeHostname(result.hostname) });
});

tenantDomainRoutes.post('/', requireRole('admin'), (req, res) => {
  const domain = addDomain(gymSlug(req), req.body?.hostname);
  console.warn(`[domains] "${domain.hostname}" added to gym "${domain.tenant_slug}" by ${req.user.email}`);
  res.status(201).json({ domain: serializeDomain(domain) });
});

tenantDomainRoutes.post('/:id/check', requireRole('admin'), async (req, res) => {
  const { domain, result, throttled } = await runDomainCheck(ownDomain(req).id);
  res.json({ domain: serializeDomain(domain), result, throttled });
});

tenantDomainRoutes.delete('/:id', requireRole('admin'), (req, res) => {
  const domain = ownDomain(req);
  removeDomain(domain.id);
  console.warn(`[domains] "${domain.hostname}" removed from gym "${domain.tenant_slug}" by ${req.user.email}`);
  res.json({ ok: true });
});

/**
 * Caddy's on-demand TLS `ask` hook: 200 means "go ahead and get a certificate
 * for ?domain=", anything else means no. Mounted ahead of resolveTenant — Caddy
 * calls it on its own behalf, with no gym in the Host header.
 */
export function handleTlsAsk(req, res) {
  const hostname = hostnameOf(String(req.query.domain || ''));
  res.status(mayIssueCertificate(hostname) ? 200 : 404).json({ hostname });
}
