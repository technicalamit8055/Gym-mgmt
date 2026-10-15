import { Router } from 'express';
import { config } from '../config.js';
import { findTenantByCustomDomain, hostnameOf, isPlatformHost } from '../customDomains.js';
import { badRequest, HttpError, tooManyRequests } from '../errors.js';
import { QR_PREFIX } from '../qr.js';
import { createLimiter } from '../rateLimit.js';
import { extractSlug, TENANT_PATH_PREFIX, tenantUrl } from '../tenant.js';
import {
  findTenantByGymCode,
  findTenantBySlug,
  isValidSlug,
  normalizeGymCode,
  searchDirectory,
} from '../tenants.js';
import { BUSINESS_TYPES } from '../verticals.js';

/**
 * "Find your gym" for the store-listed member app, which serves every gym on
 * the platform and so has to ask which one before anyone can sign in. Three
 * ways in, all public: the gym code off the desk poster, the desk poster's QR,
 * or a name/city search.
 *
 * Mounted under /api/platform, ahead of the subscription gate, and called on
 * the root address — the app has no gym yet. Every answer carries only what a
 * signed-out visitor to the gym's own login page could already see.
 */
export const directoryRoutes = Router();

const limiter = createLimiter({
  maxAttempts: config.directoryMaxRequests,
  windowMs: config.directoryWindowMs,
  lockoutMs: config.directoryLockoutMs,
});

directoryRoutes.use((req, res, next) => {
  const gate = limiter.check(req.ip);
  if (gate.locked) {
    res.set('Retry-After', String(gate.retryAfterSeconds));
    return next(tooManyRequests('Too many searches — wait a minute and try again.'));
  }
  limiter.recordAttempt(req.ip);
  next();
});

/** A cancelled account is gone as far as members are concerned. */
const findable = (tenant) => Boolean(tenant) && tenant.status !== 'cancelled';

const gymNotFound = (message) => new HttpError(404, message, { code: 'gym_not_found' });

/**
 * One gym as the finder shows it. The logo URL is root-relative with no
 * /g/<slug> prefix: the app asks from the root address, and the logo route
 * takes the slug from its own path.
 */
function directoryEntry(req, tenant) {
  const parts = [tenant.address_line, tenant.city, tenant.state, tenant.pincode].map((p) => (p || '').trim());
  const hasLogo = Boolean(tenant.logo_bytes && tenant.logo_mime);
  return {
    slug: tenant.slug,
    gym_name: tenant.gym_name ?? tenant.display_name,
    gym_code: tenant.gym_code,
    business_type: tenant.business_type || 'gym',
    logo_url: hasLogo ? `/api/platform/tenant-logo/${tenant.slug}?v=${tenant.logo_version || 1}` : null,
    address: {
      line: parts[0] || null,
      city: parts[1] || null,
      state: parts[2] || null,
      pincode: parts[3] || null,
    },
    address_text: parts.filter(Boolean).join(', ') || null,
    // For the web, where choosing a gym means going to its address.
    url: tenantUrl(req, tenant.slug),
  };
}

directoryRoutes.get('/code/:code', (req, res) => {
  if (!normalizeGymCode(req.params.code)) {
    throw badRequest('A gym code is 6 letters and numbers, like IRN482', { code: 'invalid_code' });
  }
  const tenant = findTenantByGymCode(req.params.code);
  if (!findable(tenant)) throw gymNotFound('No gym has that code — check it against the poster at your gym');
  res.json({ gym: directoryEntry(req, tenant) });
});

directoryRoutes.get('/search', (req, res) => {
  const q = String(req.query.q ?? '').trim().slice(0, 80);
  if (q.length < 2) return res.json({ items: [] });
  const type = BUSINESS_TYPES.includes(req.query.type) ? req.query.type : undefined;
  const items = searchDirectory(q, { businessType: type }).map((tenant) => directoryEntry(req, tenant));
  res.json({ items });
});

const PATH_SLUG_RE = new RegExp(`^/${TENANT_PATH_PREFIX}/([a-z][a-z0-9-]{2,39})(?=[/?#]|$)`);

/**
 * Which gym a scanned QR (or pasted link) points at. Accepts every address a
 * gym's desk poster has ever printed — "/g/<slug>" on the platform's host, a
 * "<slug>." subdomain, the gym's own custom domain — plus a bare gym code or
 * slug, so a code typed into the scanner's text box works too.
 */
function resolveScan(req, text) {
  const code = normalizeGymCode(text);
  if (code) return findTenantByGymCode(code);

  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    url = null;
  }
  if (url && url.hostname.includes('.')) {
    const hostname = hostnameOf(url.host);
    // A /g/<slug> or subdomain link only means *this* platform's gym when it
    // is on this platform's host; another deployment's "/g/acme" is not ours.
    const ours = isPlatformHost(hostname) || hostname === hostnameOf(req.get('host'));
    const fromPath = PATH_SLUG_RE.exec(url.pathname)?.[1];
    if (ours && fromPath) return findTenantBySlug(fromPath);
    if (!ours) return findTenantByCustomDomain(hostname);
    const fromHost = extractSlug(url.host);
    if (fromHost) return findTenantBySlug(fromHost);
    return undefined;
  }

  const slug = text.toLowerCase();
  return isValidSlug(slug) ? findTenantBySlug(slug) : undefined;
}

directoryRoutes.get('/resolve', (req, res) => {
  const text = String(req.query.text ?? '').trim().slice(0, 500);
  if (!text) throw badRequest('Nothing was scanned');
  if (text.toUpperCase().startsWith(`${QR_PREFIX}:`)) {
    throw badRequest("That's a member card, not your gym's QR — scan the poster at the front desk", {
      code: 'member_card',
    });
  }
  const tenant = resolveScan(req, text);
  if (!findable(tenant)) throw gymNotFound('This QR code is not a GymBook gym — scan the poster at your gym’s front desk');
  res.json({ gym: directoryEntry(req, tenant) });
});
