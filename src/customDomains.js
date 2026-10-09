import crypto from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import net from 'node:net';
import { domainToASCII } from 'node:url';
import { config } from './config.js';
import { badRequest, conflict, notFound } from './errors.js';
import { findTenantBySlug, getRegistryDb, isValidSlug } from './tenants.js';

/**
 * Custom domains: a gym serving this app from a hostname it owns, typically
 * app.theirgym.com, with theirgym.com left for their own marketing site.
 *
 * A domain goes live only after two DNS records check out:
 *
 *   - a routing record (CNAME for a subdomain, A/ALIAS for a root domain) that
 *     sends the traffic here at all, and
 *   - an ownership TXT record carrying a token unique to *this gym's claim*.
 *
 * The routing record alone would prove only that the domain points at this
 * platform, not which gym on it the owner meant. Without the token, anyone
 * could type a gym's domain into their own account first and have its traffic
 * delivered to them the moment the real owner set up DNS.
 */

export const VERIFY_LABEL = '_gymbook-verify';
export const VERIFY_PREFIX = 'gymbook-verify=';

export function customDomainsEnabled() {
  return Boolean(config.customDomains.target);
}

/* ── Hostnames ─────────────────────────────────────────────────────────── */

/** "app.acme.com:443" → "app.acme.com". IPv6 literals keep their brackets so
 * they can never be mistaken for a domain. */
export function hostnameOf(hostHeader) {
  if (!hostHeader) return '';
  const raw = String(hostHeader).trim().toLowerCase();
  if (raw.startsWith('[')) return raw.slice(0, raw.indexOf(']') + 1);
  return raw.replace(/:\d*$/, '').replace(/\.$/, '');
}

/**
 * Hostnames that belong to the platform itself, so are never looked up as a
 * gym's custom domain: local development, the deployment's own domain and its
 * per-gym subdomains, quick tunnels, and the CNAME target.
 *
 * This also keeps plain localhost requests from opening the registry, which
 * single-tenant development never otherwise touches.
 */
export function isPlatformHost(hostname) {
  if (!hostname || hostname.startsWith('[') || net.isIP(hostname)) return true;
  if (!hostname.includes('.')) return true;
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  if (hostname.endsWith('.trycloudflare.com')) return true;
  return [config.rootDomain.toLowerCase(), config.customDomains.target].some(
    (root) => root && (hostname === root || hostname.endsWith(`.${root}`)),
  );
}

/**
 * Two-label public suffixes common enough among this app's gyms to matter.
 *
 * Telling a root domain from a subdomain properly needs the full Public Suffix
 * List; this covers the cases that would otherwise be misread — "acme.co.in"
 * is a root domain, not the "acme" subdomain of "co.in". A miss only changes
 * which DNS record the instructions suggest, never what gets verified.
 */
const MULTI_PART_SUFFIXES = new Set([
  'co.in', 'net.in', 'org.in', 'firm.in', 'gen.in', 'ind.in', 'ac.in', 'edu.in',
  'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk',
  'com.au', 'net.au', 'org.au', 'co.nz', 'org.nz', 'co.za',
  'com.sg', 'com.my', 'com.ph', 'co.id', 'co.th', 'com.vn', 'com.hk', 'com.tw', 'co.jp', 'co.kr', 'com.cn',
  'com.pk', 'com.bd', 'com.np', 'com.lk', 'com.ng', 'co.ke', 'com.gh', 'com.eg',
  'com.sa', 'com.qa', 'com.kw', 'com.bh', 'com.om', 'com.tr', 'co.il',
  'com.br', 'com.mx', 'com.ar', 'com.co', 'com.pe',
]);

/** Names that never resolve on the public internet, so could never verify. */
const PRIVATE_TLDS = new Set([
  'localhost', 'local', 'internal', 'test', 'example', 'invalid', 'lan', 'home', 'corp', 'intranet', 'arpa',
]);

const LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const TLD_RE = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/;

/**
 * Turns whatever an owner pastes — "https://App.Acme.com/login", "acme.com." —
 * into a bare lowercase ASCII hostname, or explains why it cannot.
 *
 * @returns {{ hostname: string } | { error: string }}
 */
export function validateHostname(input) {
  let raw = String(input ?? '').trim().toLowerCase();
  raw = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  raw = raw.split(/[/?#]/, 1)[0];
  raw = raw.replace(/:\d+$/, '').replace(/\.$/, '');

  if (!raw) return { error: 'Enter a domain such as app.yourbrand.com' };
  if (raw.includes('@')) return { error: 'Enter a domain name, not an email address' };
  if (raw.includes('*')) return { error: 'Wildcard domains are not supported — enter one exact address' };
  if (raw.startsWith('[') || net.isIP(raw)) return { error: 'Enter a domain name, not an IP address' };

  // Punycode, so "jím.com" is stored the way DNS and the Host header spell it.
  const hostname = domainToASCII(raw);
  if (!hostname || hostname.length > 253) return { error: 'That is not a valid domain name' };

  const labels = hostname.split('.');
  if (labels.length < 2) return { error: 'Include the full domain, e.g. app.yourbrand.com' };
  if (!labels.every((label) => LABEL_RE.test(label)) || !TLD_RE.test(labels.at(-1))) {
    return { error: 'That is not a valid domain name' };
  }
  if (PRIVATE_TLDS.has(labels.at(-1))) return { error: 'That domain cannot be reached from the public internet' };
  if (MULTI_PART_SUFFIXES.has(hostname)) return { error: 'Enter your own domain, not just its ending' };
  if (isPlatformHost(hostname)) return { error: 'That address belongs to this platform — enter a domain you own' };

  return { hostname };
}

/** The domain someone actually registers: "app.acme.co.in" → "acme.co.in". */
export function registrableDomain(hostname) {
  const labels = hostname.split('.');
  const take = labels.length > 2 && MULTI_PART_SUFFIXES.has(labels.slice(-2).join('.')) ? 3 : 2;
  return labels.slice(-take).join('.');
}

/**
 * Root domain or subdomain, and the "Host"/"Name" value a registrar's DNS form
 * wants — most expect just "app" (or "@" for the root), not the full name.
 */
export function describeHostname(hostname) {
  const apex = registrableDomain(hostname);
  const kind = hostname === apex ? 'apex' : 'subdomain';
  const host = kind === 'apex' ? '@' : hostname.slice(0, -(apex.length + 1));
  return { hostname, apex, kind, host };
}

/** The exact records the owner must create, in the order to create them. */
export function dnsRecordsFor(domain) {
  const { hostname, kind, host } = describeHostname(domain.hostname);
  const { target, ipv4 } = config.customDomains;
  const records = [];

  if (kind === 'subdomain') {
    records.push({ purpose: 'routing', type: 'CNAME', host, name: hostname, value: target });
  } else if (ipv4.length) {
    for (const ip of ipv4) records.push({ purpose: 'routing', type: 'A', host, name: hostname, value: ip });
  } else {
    records.push({
      purpose: 'routing',
      type: 'ALIAS',
      host,
      name: hostname,
      value: target,
      note: 'Called ALIAS, ANAME or CNAME flattening depending on your DNS provider',
    });
  }

  records.push({
    purpose: 'ownership',
    type: 'TXT',
    host: host === '@' ? VERIFY_LABEL : `${VERIFY_LABEL}.${host}`,
    name: `${VERIFY_LABEL}.${hostname}`,
    value: `${VERIFY_PREFIX}${domain.verification_token}`,
  });
  return records;
}

/** What the Settings page needs to explain the feature before any domain exists. */
export function setupInfo() {
  return {
    enabled: customDomainsEnabled(),
    cname_target: config.customDomains.target || null,
    apex_ipv4: config.customDomains.ipv4,
    verify_label: VERIFY_LABEL,
    max_per_tenant: config.customDomains.maxPerTenant,
  };
}

/* ── DNS checks ────────────────────────────────────────────────────────── */

let resolverOverride = null;

/** Swaps in a fake resolver (tests). Returns a function restoring the last one. */
export function setDnsResolver(resolver) {
  const previous = resolverOverride;
  resolverOverride = resolver;
  return () => {
    resolverOverride = previous;
  };
}

function dnsResolver() {
  if (resolverOverride) return resolverOverride;
  const resolver = new Resolver({ timeout: 4000, tries: 2 });
  if (config.customDomains.dnsServers.length) resolver.setServers(config.customDomains.dnsServers);
  return resolver;
}

/** "No such record" is an answer, not a failure — only the rest are errors. */
const EMPTY_ANSWER = new Set(['ENODATA', 'ENOTFOUND', 'NXDOMAIN', 'ENONAME']);

async function lookup(resolver, method, name) {
  try {
    const answers = await resolver[method](name);
    return {
      values: answers.map((answer) =>
        // TXT answers arrive split into ≤255-byte chunks, and their case matters.
        Array.isArray(answer) ? answer.join('') : String(answer).toLowerCase().replace(/\.$/, ''),
      ),
      error: null,
    };
  } catch (err) {
    if (EMPTY_ANSWER.has(err.code)) return { values: [], error: null };
    return { values: [], error: err.code || err.message };
  }
}

const NONE = { values: [], error: null };

/**
 * Looks the domain up live and reports, record by record, what is right and
 * what is still missing — this is the "has it propagated yet?" button.
 */
export async function checkDomainDns(domain, resolver = dnsResolver()) {
  const { hostname, kind } = describeHostname(domain.hostname);
  const { target, ipv4 } = config.customDomains;
  const expectedTxt = `${VERIFY_PREFIX}${domain.verification_token}`;

  const [txt, cname, a, aaaa, targetA, targetAAAA] = await Promise.all([
    lookup(resolver, 'resolveTxt', `${VERIFY_LABEL}.${hostname}`),
    kind === 'subdomain' ? lookup(resolver, 'resolveCname', hostname) : NONE,
    lookup(resolver, 'resolve4', hostname),
    lookup(resolver, 'resolve6', hostname),
    lookup(resolver, 'resolve4', target),
    lookup(resolver, 'resolve6', target),
  ]);

  const ownershipOk = txt.values.some((value) => value.trim() === expectedTxt);
  let ownershipMessage;
  if (ownershipOk) ownershipMessage = 'Verification record found';
  else if (txt.error) ownershipMessage = `DNS lookup failed (${txt.error}) — try again in a minute`;
  else if (txt.values.length) ownershipMessage = 'A TXT record exists but holds a different value — copy it again exactly';
  else ownershipMessage = 'Verification TXT record not found yet';

  // A flattened CNAME or a plain A record both resolve to the target's own
  // addresses, so either is accepted, alongside any configured server IPs.
  const expectedIps = new Set([...ipv4, ...targetA.values]);
  const expectedIpv6 = new Set(targetAAAA.values);
  const cnameOk = cname.values.includes(target);
  const addressOk = a.values.length > 0 && a.values.every((ip) => expectedIps.has(ip));
  // A leftover AAAA record from the old host splits traffic: browsers on IPv6
  // follow it and land somewhere else entirely, so it fails the check outright.
  const strayIpv6 = aaaa.values.filter((ip) => !expectedIpv6.has(ip));
  const routingOk = (cnameOk || addressOk) && strayIpv6.length === 0;

  let routingMessage;
  if (routingOk) {
    routingMessage = cnameOk ? `CNAME points to ${target}` : 'Points to this platform';
  } else if ((cnameOk || addressOk) && strayIpv6.length) {
    routingMessage = `Also has AAAA (IPv6) record(s) ${strayIpv6.join(', ')} sending some visitors elsewhere — delete them`;
  } else if (cname.values.length) {
    routingMessage = `CNAME points to ${cname.values[0]} — it should point to ${target}`;
  } else if (a.values.length) {
    const wanted = expectedIps.size ? [...expectedIps].join(', ') : target;
    routingMessage = `Points to ${a.values.join(', ')}, expected ${wanted}. On Cloudflare, set the record to "DNS only" (grey cloud).`;
  } else if (cname.error || a.error) {
    routingMessage = `DNS lookup failed (${cname.error || a.error}) — try again in a minute`;
  } else {
    routingMessage = kind === 'subdomain' ? 'CNAME record not found yet' : 'A record not found yet';
  }

  return {
    checked_at: new Date().toISOString(),
    ok: ownershipOk && routingOk,
    ownership: { ok: ownershipOk, expected: expectedTxt, found: txt.values, message: ownershipMessage },
    routing: {
      ok: routingOk,
      expected: kind === 'subdomain' ? [target] : ipv4.length ? ipv4 : [target],
      found: cname.values.length ? cname.values : a.values,
      message: routingMessage,
    },
  };
}

/* ── Registry ──────────────────────────────────────────────────────────── */

const plain = (row) => (row === undefined ? undefined : { ...row });

export function findDomainById(id) {
  return plain(getRegistryDb().prepare('SELECT * FROM custom_domains WHERE id = ?').get(id));
}

export function listDomainsForTenant(slug) {
  return getRegistryDb()
    .prepare('SELECT * FROM custom_domains WHERE tenant_slug = ? ORDER BY created_at, id')
    .all(slug)
    .map(plain);
}

/** Every domain on the platform, with enough of its gym to label it. */
export function listAllDomains() {
  return getRegistryDb()
    .prepare(
      `SELECT d.*, COALESCE(t.gym_name, t.display_name) AS gym_name, t.status AS tenant_status
         FROM custom_domains d
         LEFT JOIN tenants t ON t.slug = d.tenant_slug
        ORDER BY d.created_at DESC, d.id DESC`,
    )
    .all()
    .map(plain);
}

/** The gym a request's Host header belongs to, if it is a live custom domain. */
export function findTenantByCustomDomain(hostname) {
  return plain(
    getRegistryDb()
      .prepare(
        `SELECT t.* FROM custom_domains d
           JOIN tenants t ON t.slug = d.tenant_slug
          WHERE d.hostname = ? AND d.status = 'active'`,
      )
      .get(hostname),
  );
}

/** The address to advertise for a gym: its first live custom domain, if any. */
export function primaryDomainFor(slug) {
  if (!customDomainsEnabled()) return null;
  return (
    getRegistryDb()
      .prepare(
        `SELECT hostname FROM custom_domains
          WHERE tenant_slug = ? AND status = 'active'
          ORDER BY verified_at, id LIMIT 1`,
      )
      .get(slug)?.hostname ?? null
  );
}

function activeOwnerOf(hostname, exceptId = 0) {
  return getRegistryDb()
    .prepare("SELECT tenant_slug FROM custom_domains WHERE hostname = ? AND status = 'active' AND id <> ?")
    .get(hostname, exceptId)?.tenant_slug;
}

function requireEnabled() {
  if (!customDomainsEnabled()) {
    throw badRequest('Custom domains are not enabled on this deployment yet');
  }
}

function parseHostnameOrThrow(input) {
  const result = validateHostname(input);
  if (result.error) throw badRequest('Some fields need attention', { hostname: result.error });
  return result.hostname;
}

/**
 * Starts a claim on a hostname for one gym. Pending until its DNS checks out
 * (or the operator activates it by hand with `activate`).
 */
export function addDomain(slug, input, { activate = false } = {}) {
  requireEnabled();
  const hostname = parseHostnameOrThrow(input);
  const db = getRegistryDb();

  if (db.prepare('SELECT 1 FROM custom_domains WHERE tenant_slug = ? AND hostname = ?').get(slug, hostname)) {
    throw conflict('That domain is already added to this account');
  }
  if (activeOwnerOf(hostname)) {
    throw conflict('That domain is already connected to another account. If it is yours, contact support.');
  }
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM custom_domains WHERE tenant_slug = ?').get(slug);
  if (n >= config.customDomains.maxPerTenant) {
    throw conflict(`You can connect at most ${config.customDomains.maxPerTenant} domains — remove one first`);
  }

  const { lastInsertRowid } = db
    .prepare('INSERT INTO custom_domains (tenant_slug, hostname, verification_token) VALUES (?, ?, ?)')
    .run(slug, hostname, crypto.randomBytes(16).toString('hex'));

  const id = Number(lastInsertRowid);
  return activate ? activateDomain(id) : findDomainById(id);
}

/**
 * Puts a domain live. Every other gym's pending claim on the same hostname is
 * dropped in the same transaction — they lost, and leaving them would only
 * show their owners a verification that can never succeed.
 */
export function activateDomain(id) {
  const domain = findDomainById(id);
  if (!domain) throw notFound('No such domain');
  if (activeOwnerOf(domain.hostname, domain.id)) {
    throw conflict('That domain is already connected to another account');
  }

  const db = getRegistryDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
      "UPDATE custom_domains SET status = 'active', verified_at = datetime('now') WHERE id = ? AND status <> 'active'",
    ).run(id);
    db.prepare("DELETE FROM custom_domains WHERE hostname = ? AND status = 'pending' AND id <> ?").run(
      domain.hostname,
      id,
    );
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    if (String(err.message).includes('UNIQUE')) throw conflict('That domain is already connected to another account');
    throw err;
  }
  return findDomainById(id);
}

/** Takes a domain out of routing without forgetting it — it can re-verify. */
export function deactivateDomain(id) {
  getRegistryDb()
    .prepare("UPDATE custom_domains SET status = 'pending', verified_at = NULL WHERE id = ?")
    .run(id);
  return findDomainById(id);
}

/** Moves a claim to a different hostname; it has to verify again from scratch. */
export function changeDomainHostname(id, input) {
  requireEnabled();
  const domain = findDomainById(id);
  if (!domain) throw notFound('No such domain');
  const hostname = parseHostnameOrThrow(input);
  if (hostname === domain.hostname) return domain;

  const db = getRegistryDb();
  if (db.prepare('SELECT 1 FROM custom_domains WHERE tenant_slug = ? AND hostname = ?').get(domain.tenant_slug, hostname)) {
    throw conflict('That domain is already added to this account');
  }
  if (activeOwnerOf(hostname)) throw conflict('That domain is already connected to another account');

  db.prepare(
    `UPDATE custom_domains
        SET hostname = ?, status = 'pending', verified_at = NULL, last_checked_at = NULL, last_check = NULL
      WHERE id = ?`,
  ).run(hostname, id);
  return findDomainById(id);
}

export function removeDomain(id) {
  return getRegistryDb().prepare('DELETE FROM custom_domains WHERE id = ?').run(id).changes;
}

const lastCheckedMs = (domain) =>
  domain.last_checked_at ? Date.parse(`${domain.last_checked_at.replace(' ', 'T')}Z`) : 0;

/**
 * Runs the DNS check and stores the outcome. A passing check puts a pending
 * domain live; a failing one never takes a live domain down — one flaky
 * lookup must not knock a gym's front desk offline. Taking a domain down is a
 * deliberate act (remove it, or the operator deactivates it).
 *
 * `cooldownMs` stops a button-masher turning this into a DNS amplifier: within
 * it, the stored result is returned instead of asking again.
 */
export async function runDomainCheck(id, { cooldownMs = config.customDomains.checkCooldownMs, resolver } = {}) {
  let domain = findDomainById(id);
  if (!domain) throw notFound('No such domain');

  if (cooldownMs > 0 && Date.now() - lastCheckedMs(domain) < cooldownMs && domain.last_check) {
    return { domain, result: JSON.parse(domain.last_check), throttled: true };
  }

  const result = await checkDomainDns(domain, resolver);
  getRegistryDb()
    .prepare("UPDATE custom_domains SET last_checked_at = datetime('now'), last_check = ? WHERE id = ?")
    .run(JSON.stringify(result), id);

  domain = findDomainById(id);
  // Removed while the lookup was in flight — nothing left to activate.
  if (!domain) throw notFound('No such domain');
  if (result.ok && domain.status !== 'active') {
    try {
      domain = activateDomain(id);
    } catch (err) {
      // Another gym went live on it first; this claim stays pending.
      if (err.status !== 409) throw err;
    }
  }
  return { domain, result, throttled: false };
}

/** A registry row as the API returns it, with the records to create. */
export function serializeDomain(domain) {
  const { kind, apex, host } = describeHostname(domain.hostname);
  let lastCheck = null;
  try {
    lastCheck = domain.last_check ? JSON.parse(domain.last_check) : null;
  } catch {
    lastCheck = null;
  }
  return {
    id: domain.id,
    tenant_slug: domain.tenant_slug,
    hostname: domain.hostname,
    kind,
    apex,
    host,
    status: domain.status,
    created_at: domain.created_at,
    verified_at: domain.verified_at ?? null,
    last_checked_at: domain.last_checked_at ?? null,
    last_check: lastCheck,
    url: `https://${domain.hostname}`,
    dns_records: dnsRecordsFor(domain),
    ...(domain.gym_name !== undefined ? { gym_name: domain.gym_name, tenant_status: domain.tenant_status } : {}),
  };
}

/**
 * Whether a TLS certificate may be issued for this hostname — the answer to
 * Caddy's on-demand TLS `ask` (see docs/CUSTOM_DOMAINS.md). Without this gate
 * anyone could point junk hostnames at the server and burn through the ACME
 * rate limit, so only names that actually reach a gym say yes.
 */
export function mayIssueCertificate(hostname) {
  if (!hostname) return false;
  if (customDomainsEnabled() && findTenantByCustomDomain(hostname)) return true;

  const root = config.rootDomain.toLowerCase();
  if (!root) return false;
  if (hostname === root || hostname === `www.${root}`) return true;
  if (!hostname.endsWith(`.${root}`)) return false;
  const slug = hostname.slice(0, -(root.length + 1));
  return isValidSlug(slug) && Boolean(findTenantBySlug(slug));
}
