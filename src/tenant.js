import path from 'node:path';
import { config, DEFAULT_TENANT_SLUG, ROOT } from './config.js';
import {
  customDomainsEnabled,
  findTenantByCustomDomain,
  hostnameOf,
  isPlatformHost,
  primaryDomainFor,
} from './customDomains.js';
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

  // Quick tunnels (e.g. *.trycloudflare.com) generate 3-label hostnames like
  // "front-cultural-flow-hartford.trycloudflare.com". If ROOT_DOMAIN is not explicitly set,
  // treat the quick tunnel domain as the root host so the app loads the default gym.
  if (!config.rootDomain && hostname.endsWith('.trycloudflare.com')) {
    const labels = hostname.split('.');
    if (labels.length <= 3) return null;
    const candidate = labels[0];
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
 * URL prefix that addresses a gym by path instead of by subdomain:
 * https://gymbook.example.com/g/acme/ is the same gym as https://acme.example.com/.
 *
 * Subdomains are the nicer address, but they need a domain you own plus
 * wildcard DNS and wildcard TLS — Fly's shared *.fly.dev cannot issue either,
 * so on a fresh deploy there would be no reachable gym at all. The path form
 * works on any hostname (including a throwaway tunnel URL), which keeps
 * onboarding usable from day one; the subdomain form above keeps working
 * unchanged the day a real domain is pointed at the app.
 */
export const TENANT_PATH_PREFIX = 'g';

// The lookahead keeps "/g/acme" from also matching a longer label like
// "/g/acmex", and allows the prefix to be the entire path ("/g/acme"), to
// carry a query ("/g/acme?x=1") or to continue ("/g/acme/api/members").
const PATH_PREFIX_RE = new RegExp(`^/${TENANT_PATH_PREFIX}/([^/?#]+)(?=[/?#]|$)`);

/**
 * Pulls a "/g/<slug>" prefix off req.url and returns the slug.
 *
 * The prefix is *removed* from req.url rather than merely read, so that every
 * downstream route, the static file handler and the SPA fallback all see the
 * exact same URLs they would see on a subdomain. Path-addressed and
 * subdomain-addressed requests become indistinguishable past this point,
 * which is what stops the two modes needing parallel implementations.
 */
export function takeTenantPathPrefix(req) {
  const match = PATH_PREFIX_RE.exec(req.url);
  if (!match) return null;

  const candidate = match[1].toLowerCase();
  if (!isValidSlug(candidate)) return null;

  req.tenantPathPrefix = `/${TENANT_PATH_PREFIX}/${candidate}`;
  const rest = req.url.slice(match[0].length);
  req.url = rest.startsWith('/') ? rest : `/${rest}`;
  return candidate;
}

/** An unresolvable gym should answer JSON to the API and HTML to a browser —
 * a person who mistypes a gym address deserves a page, not a JSON blob. */
function isApiRequest(req) {
  return req.path.startsWith('/api/') || req.path === '/api';
}

function sendAppShell(res) {
  return res.sendFile(path.join(ROOT, 'public', 'index.html'));
}

/**
 * Resolves which gym (tenant) this request belongs to and scopes every
 * downstream db.js call to that tenant's own SQLite file. Never calls next()
 * without either setting an explicit tenant context or returning a terminal
 * response — an unresolved tenant must not silently fall back to the
 * default database.
 */
export function resolveTenant(req, res, next) {
  // A gym's own domain outranks everything else, path prefix included: the
  // hostname alone decides which gym it is. Skipped for the platform's own
  // hostnames so local development never opens the registry for it.
  const hostname = hostnameOf(req.get('host'));
  if (customDomainsEnabled() && !isPlatformHost(hostname)) {
    expireOverdueTrials();
    const owner = findTenantByCustomDomain(hostname);
    if (owner) {
      // "/g/<slug>" on a gym's own domain is only honoured for that same gym
      // (an old bookmark). Any other gym must not render under this brand's
      // address — it would let one gym's login page be served from another's
      // domain.
      const fromPath = takeTenantPathPrefix(req);
      if (fromPath && fromPath !== owner.slug) return tenantNotFound(req, res, fromPath);
      req.customDomain = hostname;
      return enterTenant(req, res, next, owner);
    }
  }

  // Path prefix first: it is the most explicit signal, and it is the only one
  // that can address a specific gym on a hostname that has no wildcard DNS.
  const fromPath = takeTenantPathPrefix(req);
  const devOverride = process.env.NODE_ENV !== 'production' ? req.get('x-tenant-slug') : null;
  const slug = fromPath || devOverride || extractSlug(req.get('host'));

  if (!slug) {
    req.tenant = { slug: DEFAULT_TENANT_SLUG };
    return tenantStorage.run(
      {
        slug: DEFAULT_TENANT_SLUG,
        dbFile: undefined,
        businessType: 'gym',
        pathPrefix: req.tenantPathPrefix,
      },
      next,
    );
  }

  // Only once we know this is a real registry lookup — calling this any
  // earlier would force-create data/platform.db on every plain single-tenant
  // dev/test request, which never touches the registry today.
  expireOverdueTrials();

  const tenant = findTenantBySlug(slug);
  if (!tenant) return tenantNotFound(req, res, slug);
  return enterTenant(req, res, next, tenant);
}

function tenantNotFound(req, res, slug) {
  if (!isApiRequest(req)) return sendAppShell(res);
  // `code` so the front end can tell "this gym does not exist" apart from
  // any other 404 the API might produce. Matching on the status alone made
  // a plain "no such endpoint" render as a dead-end "no gym here" page.
  return res.status(404).json({ error: `No gym found for "${slug}"`, code: 'tenant_not_found', slug });
}

/** Scopes the rest of the request to one resolved gym — however it was found. */
function enterTenant(req, res, next, tenant) {
  // 'suspended' (lapsed trial/payment) is recoverable — login and billing
  // must stay reachable so the owner can pay to reactivate. 'cancelled' is a
  // deliberate platform-side action and stays a hard block on everything.
  if (tenant.status === 'cancelled') {
    if (!isApiRequest(req)) return sendAppShell(res);
    return res.status(403).json({
      error: 'This account is not currently active. Contact support.',
      code: 'tenant_cancelled',
      slug: tenant.slug,
    });
  }

  req.tenant = tenant;
  return tenantStorage.run(
    {
      slug: tenant.slug,
      dbFile: tenantDbPath(tenant.slug),
      timezone: tenant.timezone || undefined,
      businessType: tenant.business_type || 'gym',
      // Carried so anything building a URL back into this gym (member photo
      // URLs) keeps the /g/<slug> prefix the request arrived with.
      pathPrefix: req.tenantPathPrefix,
    },
    next,
  );
}

/**
 * Gates gym-operational routes behind an active trial/subscription. Mounted
 * on /api only, and after /api/platform and /api/auth in app.js, so signup,
 * login, billing *and the whole front-end* stay reachable while suspended —
 * gating the static assets too would leave a lapsed gym staring at a JSON 402
 * with no way to reach the page that takes their payment. 'cancelled' tenants
 * never reach here — resolveTenant already hard-blocked them. Dev/single-tenant
 * mode (no registry row, no status field) always passes.
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

/**
 * The absolute URL a gym is reached at, for the "your gym is ready at …"
 * hand-off after signup.
 *
 * Which form is correct is a deployment fact the server cannot infer —
 * whether wildcard DNS exists for ROOT_DOMAIN is invisible from inside the
 * process — so TENANT_URL_MODE decides, defaulting to the path form because
 * that one is always reachable.
 *
 * A gym with a live custom domain is advertised at that instead — it is the
 * address its owner chose and set up DNS for. tenantPlatformUrl() below is
 * the fallback that keeps working whatever happens to their DNS.
 */
export function tenantUrl(req, slug) {
  const domain = primaryDomainFor(slug);
  if (domain) return `https://${domain}`;
  return tenantPlatformUrl(req, slug);
}

/** The gym's address on this platform's own hostname, ignoring custom domains. */
export function tenantPlatformUrl(req, slug) {
  const proto = req.protocol;
  if (config.tenantUrlMode === 'subdomain' && config.rootDomain) {
    return `${proto}://${slug}.${config.rootDomain}`;
  }
  // Asked from the gym's own domain, the request's host *is* the custom
  // domain — the platform's address has to come from configuration instead.
  const host = req.customDomain && config.rootDomain ? config.rootDomain : req.get('host');
  return `${proto}://${host}/${TENANT_PATH_PREFIX}/${slug}`;
}
