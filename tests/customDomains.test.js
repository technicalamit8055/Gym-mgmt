import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

/**
 * Custom domains: a gym reachable at app.theirgym.com.
 *
 * Its own file because config.js reads ROOT_DOMAIN, CUSTOM_DOMAIN_* and
 * TRUST_PROXY once at import. DNS is a fake zone held in memory — the checker
 * takes its resolver as a seam — so nothing here touches the network.
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-domains-test-'));
process.env.NODE_ENV = 'test';
process.env.DB_FILE = path.join(tmpDir, 'default.db');
process.env.PLATFORM_DB_FILE = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.BACKUP_DIR = path.join(tmpDir, 'backups');
process.env.BACKUP_INTERVAL_HOURS = '0';
process.env.AUTH_SECRET = 'test-secret';
process.env.ROOT_DOMAIN = 'gymbook.app';
process.env.TRUST_PROXY = 'true';
process.env.CUSTOM_DOMAIN_TARGET = 'domains.gymbook.app';
process.env.CUSTOM_DOMAIN_IPV4 = '203.0.113.10';
process.env.CUSTOM_DOMAIN_LIMIT = '3';
process.env.CUSTOM_DOMAIN_CHECK_COOLDOWN_MS = '0';
process.env.PLATFORM_ADMIN_EMAIL = 'ops@gymbook.test';
process.env.PLATFORM_ADMIN_PASSWORD = 'operator-pass-123';

const { createApp } = await import('../src/app.js');
const { closeDb } = await import('../src/db.js');
const { closeRegistryDb } = await import('../src/tenants.js');
const domains = await import('../src/customDomains.js');

const TARGET = 'domains.gymbook.app';
const SERVER_IP = '203.0.113.10';

/* ── A fake DNS zone ───────────────────────────────────────────────────── */

const zone = { TXT: new Map(), CNAME: new Map(), A: new Map(), AAAA: new Map() };
const failures = new Map();

function answer(type, name) {
  if (failures.has(`${type} ${name}`)) {
    const err = new Error('lookup failed');
    err.code = failures.get(`${type} ${name}`);
    throw err;
  }
  if (!zone[type].has(name)) {
    const err = new Error('no data');
    err.code = 'ENODATA';
    throw err;
  }
  return zone[type].get(name);
}

const fakeResolver = {
  resolveTxt: async (name) => answer('TXT', name).map((value) => [value]),
  resolveCname: async (name) => answer('CNAME', name),
  resolve4: async (name) => answer('A', name),
  resolve6: async (name) => answer('AAAA', name),
};

function resetZone() {
  for (const records of Object.values(zone)) records.clear();
  failures.clear();
  zone.A.set(TARGET, [SERVER_IP]);
}

/** Publishes what the gym was told to publish, the way a registrar would. */
function publish(domain) {
  for (const record of domain.dns_records) {
    if (record.type === 'CNAME') zone.CNAME.set(record.name, [`${record.value}.`]);
    if (record.type === 'A') zone.A.set(record.name, [record.value]);
    if (record.type === 'TXT') zone.TXT.set(record.name, [record.value]);
  }
}

/* ── HTTP helpers ──────────────────────────────────────────────────────── */

let server;
let port;
let ops;
const tokens = {};

/** node:http rather than fetch: fetch silently replaces a custom Host header. */
function call(method, urlPath, body, { token, tenant, host, headers = {} } = {}) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: urlPath,
        headers: {
          host: host ?? `127.0.0.1:${port}`,
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(tenant ? { 'x-tenant-slug': tenant } : {}),
          ...headers,
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () => {
          let parsed = text;
          if ((res.headers['content-type'] || '').includes('json')) parsed = text ? JSON.parse(text) : null;
          resolve({ status: res.statusCode, headers: res.headers, body: parsed });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const signup = (slug, gymName) =>
  call('POST', '/api/platform/signup', {
    slug,
    gym_name: gymName,
    admin_name: 'Owner',
    admin_email: `owner@${slug}.test`,
    admin_password: 'ownerpass123',
  });

const login = async (slug, email = `owner@${slug}.test`, password = 'ownerpass123') =>
  (await call('POST', '/api/auth/login', { email, password }, { tenant: slug })).body.token;

/** A gym's own domain API, as that gym's admin. */
const gym = (slug) => ({
  list: () => call('GET', '/api/platform/domains', undefined, { token: tokens[slug], tenant: slug }),
  add: (hostname) => call('POST', '/api/platform/domains', { hostname }, { token: tokens[slug], tenant: slug }),
  check: (id) => call('POST', `/api/platform/domains/${id}/check`, {}, { token: tokens[slug], tenant: slug }),
  remove: (id) => call('DELETE', `/api/platform/domains/${id}`, undefined, { token: tokens[slug], tenant: slug }),
});

/** Which gym a browser on `host` would be looking at (null = the landing page). */
const tenantAt = async (host, urlPath = '/api/platform/tenant') => {
  const res = await call('GET', urlPath, undefined, { host });
  return res.status === 200 ? res.body.tenant?.slug ?? null : res;
};

before(async () => {
  domains.setDnsResolver(fakeResolver);
  resetZone();

  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  port = server.address().port;

  for (const [slug, name] of [['ironworks', 'Iron Works Gym'], ['pulsefit', 'Pulse Fit'], ['corefit', 'Core Fit']]) {
    assert.equal((await signup(slug, name)).status, 201);
    tokens[slug] = await login(slug);
  }
  ops = (
    await call('POST', '/api/platform/admin/login', { email: 'ops@gymbook.test', password: 'operator-pass-123' })
  ).body.token;
});

after(() => {
  server.close();
  closeDb();
  closeRegistryDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/* ── Unit: hostnames ───────────────────────────────────────────────────── */

describe('validateHostname', () => {
  it('normalises whatever an owner pastes into a bare hostname', () => {
    assert.deepEqual(domains.validateHostname('https://App.IronWorks.com/login?x=1'), { hostname: 'app.ironworks.com' });
    assert.deepEqual(domains.validateHostname('  portal.acme.com.  '), { hostname: 'portal.acme.com' });
    assert.deepEqual(domains.validateHostname('portal.acme.com:443'), { hostname: 'portal.acme.com' });
  });

  it('stores internationalised names the way DNS spells them', () => {
    assert.match(domains.validateHostname('app.jím.com').hostname, /^app\.xn--/);
  });

  it('rejects things that are not a public domain someone could own', () => {
    for (const input of [
      '',
      'localhost',
      'intranet',
      '203.0.113.10',
      '[::1]',
      '*.acme.com',
      'owner@acme.com',
      'acme.test',
      'gym.local',
      'co.uk',
      '-bad.acme.com',
      'bad_label.acme.com',
      `${'a'.repeat(64)}.com`,
    ]) {
      assert.ok(domains.validateHostname(input).error, `expected "${input}" to be rejected`);
    }
  });

  it("refuses the platform's own hostnames", () => {
    for (const input of ['gymbook.app', 'ironworks.gymbook.app', TARGET, 'x.trycloudflare.com']) {
      assert.match(domains.validateHostname(input).error, /belongs to this platform/);
    }
  });
});

describe('describeHostname', () => {
  it('tells a root domain from a subdomain, including two-part endings', () => {
    assert.deepEqual(domains.describeHostname('app.acme.co.in'), {
      hostname: 'app.acme.co.in',
      apex: 'acme.co.in',
      kind: 'subdomain',
      host: 'app',
    });
    assert.equal(domains.describeHostname('acme.co.in').kind, 'apex');
    assert.equal(domains.describeHostname('acme.co.in').host, '@');
    assert.equal(domains.describeHostname('acme.com').kind, 'apex');
    assert.equal(domains.describeHostname('portal.members.acme.com').host, 'portal.members');
  });
});

describe('isPlatformHost', () => {
  it('covers local development, the platform domain and its tenants', () => {
    for (const host of ['', 'localhost', 'acme.localhost', '127.0.0.1', '[::1]', 'gymbook.app', 'acme.gymbook.app', TARGET]) {
      assert.equal(domains.isPlatformHost(host), true, host);
    }
    assert.equal(domains.isPlatformHost('app.ironworks.com'), false);
  });
});

describe('dnsRecordsFor', () => {
  it('asks a subdomain for a CNAME plus the ownership TXT, with registrar-style host names', () => {
    const records = domains.dnsRecordsFor({ hostname: 'app.acme.com', verification_token: 'abc' });
    assert.deepEqual(
      records.map(({ type, host, value }) => ({ type, host, value })),
      [
        { type: 'CNAME', host: 'app', value: TARGET },
        { type: 'TXT', host: '_gymbook-verify.app', value: 'gymbook-verify=abc' },
      ],
    );
  });

  it('asks a root domain for an A record, since a root cannot carry a CNAME', () => {
    const records = domains.dnsRecordsFor({ hostname: 'acme.com', verification_token: 'abc' });
    assert.deepEqual(
      records.map(({ type, host, value }) => ({ type, host, value })),
      [
        { type: 'A', host: '@', value: SERVER_IP },
        { type: 'TXT', host: '_gymbook-verify', value: 'gymbook-verify=abc' },
      ],
    );
  });
});

/* ── Unit: the DNS check ───────────────────────────────────────────────── */

describe('checkDomainDns', () => {
  beforeEach(resetZone);
  const sub = { hostname: 'app.acme.com', verification_token: 'tok123' };
  const apex = { hostname: 'acme.com', verification_token: 'tok123' };

  it('reports both records missing before anything is published', async () => {
    const result = await domains.checkDomainDns(sub, fakeResolver);
    assert.equal(result.ok, false);
    assert.match(result.ownership.message, /not found yet/);
    assert.match(result.routing.message, /CNAME record not found yet/);
  });

  it('passes a subdomain once both the CNAME and the TXT are in place', async () => {
    zone.CNAME.set('app.acme.com', [`${TARGET}.`]);
    let result = await domains.checkDomainDns(sub, fakeResolver);
    assert.equal(result.routing.ok, true);
    assert.equal(result.ownership.ok, false, 'routing alone must not prove which gym owns the domain');

    zone.TXT.set('_gymbook-verify.app.acme.com', ['gymbook-verify=tok123']);
    result = await domains.checkDomainDns(sub, fakeResolver);
    assert.equal(result.ok, true);
  });

  it("says where a CNAME points when it isn't here", async () => {
    zone.CNAME.set('app.acme.com', ['old-host.example.net']);
    const result = await domains.checkDomainDns(sub, fakeResolver);
    assert.equal(result.routing.ok, false);
    assert.match(result.routing.message, /points to old-host\.example\.net — it should point to domains\.gymbook\.app/);
  });

  it("rejects a TXT that holds another claim's token", async () => {
    zone.TXT.set('_gymbook-verify.app.acme.com', ['gymbook-verify=someone-else']);
    const result = await domains.checkDomainDns(sub, fakeResolver);
    assert.equal(result.ownership.ok, false);
    assert.match(result.ownership.message, /different value/);
  });

  it('accepts a root domain whose A record is this server', async () => {
    zone.A.set('acme.com', [SERVER_IP]);
    zone.TXT.set('_gymbook-verify.acme.com', ['gymbook-verify=tok123']);
    assert.equal((await domains.checkDomainDns(apex, fakeResolver)).ok, true);
  });

  it('hints at a proxy when a root domain resolves somewhere else', async () => {
    zone.A.set('acme.com', ['104.16.0.1']);
    const result = await domains.checkDomainDns(apex, fakeResolver);
    assert.equal(result.routing.ok, false);
    assert.match(result.routing.message, /expected 203\.0\.113\.10.*DNS only/);
  });

  it('fails on a leftover AAAA record that would send IPv6 visitors elsewhere', async () => {
    zone.A.set('acme.com', [SERVER_IP]);
    zone.AAAA.set('acme.com', ['2001:db8::1']);
    const result = await domains.checkDomainDns(apex, fakeResolver);
    assert.equal(result.routing.ok, false);
    assert.match(result.routing.message, /AAAA/);
  });

  it('reports a resolver failure as a failure, not as a missing record', async () => {
    failures.set('TXT _gymbook-verify.app.acme.com', 'ESERVFAIL');
    const result = await domains.checkDomainDns(sub, fakeResolver);
    assert.match(result.ownership.message, /DNS lookup failed \(ESERVFAIL\)/);
  });
});

/* ── The gym's own settings API ───────────────────────────────────────── */

describe('connecting a domain from Gym settings', () => {
  let ironDomain;

  before(resetZone);

  it('explains the setup before any domain exists', async () => {
    const res = await gym('ironworks').list();
    assert.equal(res.status, 200);
    assert.equal(res.body.enabled, true);
    assert.equal(res.body.cname_target, TARGET);
    assert.deepEqual(res.body.apex_ipv4, [SERVER_IP]);
    assert.deepEqual(res.body.items, []);
    assert.match(res.body.platform_url, /\/g\/ironworks$/);
  });

  it('previews whether a typed address is a root domain or a subdomain', async () => {
    const inspect = (hostname) =>
      call('GET', `/api/platform/domains/inspect?hostname=${encodeURIComponent(hostname)}`, undefined, {
        token: tokens.ironworks,
        tenant: 'ironworks',
      });
    assert.equal((await inspect('acme.co.in')).body.kind, 'apex');
    assert.equal((await inspect('app.acme.co.in')).body.kind, 'subdomain');
    assert.equal((await inspect('localhost')).body.valid, false);
  });

  it('adds a pending domain with the exact records to create', async () => {
    const res = await gym('ironworks').add('https://App.IronWorks.com/');
    assert.equal(res.status, 201);
    ironDomain = res.body.domain;
    assert.equal(ironDomain.hostname, 'app.ironworks.com');
    assert.equal(ironDomain.status, 'pending');
    assert.equal(ironDomain.kind, 'subdomain');
    assert.deepEqual(
      ironDomain.dns_records.map((r) => [r.type, r.host]),
      [['CNAME', 'app'], ['TXT', '_gymbook-verify.app']],
    );
  });

  it('rejects an invalid hostname with a field-level reason', async () => {
    const res = await gym('ironworks').add('localhost');
    assert.equal(res.status, 400);
    assert.ok(res.body.details.hostname);
  });

  it('refuses the same domain twice on one gym', async () => {
    assert.equal((await gym('ironworks').add('app.ironworks.com')).status, 409);
  });

  it('only lets an admin change domains', async () => {
    const created = await call(
      'POST',
      '/api/staff',
      { name: 'Desk Person', email: 'desk@ironworks.test', password: 'deskpass123', role: 'staff' },
      { token: tokens.ironworks, tenant: 'ironworks' },
    );
    assert.equal(created.status, 201);
    const desk = await login('ironworks', 'desk@ironworks.test', 'deskpass123');

    const listed = await call('GET', '/api/platform/domains', undefined, { token: desk, tenant: 'ironworks' });
    assert.equal(listed.status, 200, 'staff can still see the setup');
    const added = await call('POST', '/api/platform/domains', { hostname: 'x.ironworks.com' }, { token: desk, tenant: 'ironworks' });
    assert.equal(added.status, 403);
  });

  it('does not route a pending domain to the gym', async () => {
    assert.equal(await tenantAt('app.ironworks.com'), null);
  });

  it('stays pending while DNS has not propagated, and says why', async () => {
    const res = await gym('ironworks').check(ironDomain.id);
    assert.equal(res.status, 200);
    assert.equal(res.body.result.ok, false);
    assert.equal(res.body.domain.status, 'pending');
    assert.ok(res.body.domain.last_checked_at);
  });

  it('goes live once both records are published', async () => {
    publish(ironDomain);
    const res = await gym('ironworks').check(ironDomain.id);
    assert.equal(res.body.result.ok, true);
    assert.equal(res.body.domain.status, 'active');
    assert.ok(res.body.domain.verified_at);
  });

  it('keeps another gym from touching a domain it does not own', async () => {
    assert.equal((await gym('pulsefit').check(ironDomain.id)).status, 404);
    assert.equal((await gym('pulsefit').remove(ironDomain.id)).status, 404);
  });

  it('refuses a domain already live on another gym', async () => {
    const res = await gym('pulsefit').add('app.ironworks.com');
    assert.equal(res.status, 409);
    assert.match(res.body.error, /another account/);
  });

  it('caps how many domains one gym can connect', async () => {
    assert.equal((await gym('corefit').add('a.corefit.com')).status, 201);
    assert.equal((await gym('corefit').add('b.corefit.com')).status, 201);
    assert.equal((await gym('corefit').add('c.corefit.com')).status, 201);
    const res = await gym('corefit').add('d.corefit.com');
    assert.equal(res.status, 409);
    assert.match(res.body.error, /at most 3/);
  });
});

/* ── Request routing ───────────────────────────────────────────────────── */

describe('routing a live custom domain', () => {
  it("loads the gym straight from its domain, without a /g/ prefix", async () => {
    assert.equal(await tenantAt('app.ironworks.com'), 'ironworks');
    assert.equal(await tenantAt('APP.IronWorks.com:443'), 'ironworks', 'case and port are ignored');
  });

  it('serves the app shell for page loads', async () => {
    const res = await call('GET', '/', undefined, { host: 'app.ironworks.com' });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/html/);
  });

  it("accepts the gym's own staff token there", async () => {
    const res = await call('GET', '/api/auth/me', undefined, { host: 'app.ironworks.com', token: tokens.ironworks });
    assert.equal(res.status, 200);
  });

  it("rejects another gym's token on it", async () => {
    const res = await call('GET', '/api/auth/me', undefined, { host: 'app.ironworks.com', token: tokens.pulsefit });
    assert.equal(res.status, 401);
  });

  it("honours /g/<own-slug> but never renders another gym under this gym's domain", async () => {
    assert.equal(await tenantAt('app.ironworks.com', '/g/ironworks/api/platform/tenant'), 'ironworks');
    const other = await tenantAt('app.ironworks.com', '/g/pulsefit/api/platform/tenant');
    assert.equal(other.status, 404);
    assert.equal(other.body.code, 'tenant_not_found');
  });

  it('ignores the dev-only tenant header on a custom domain', async () => {
    const res = await call('GET', '/api/platform/tenant', undefined, { host: 'app.ironworks.com', tenant: 'pulsefit' });
    assert.equal(res.body.tenant.slug, 'ironworks');
  });

  it('leaves unknown hostnames on the landing page as before', async () => {
    assert.equal(await tenantAt('www.unrelated-site.com'), null);
    assert.equal(await tenantAt('gymbook.app'), null);
    assert.equal(await tenantAt('pulsefit.gymbook.app'), 'pulsefit');
  });

  it('advertises the custom domain as the gym address, with the platform address as fallback', async () => {
    const res = await call('GET', '/api/platform/admin/tenants/ironworks', undefined, { token: ops });
    assert.equal(res.body.url, 'https://app.ironworks.com');
    assert.match(res.body.platform_url, /\/g\/ironworks$/);
  });

  it("builds the fallback address from the platform's domain when asked from the custom one", async () => {
    const res = await call('GET', '/api/platform/domains', undefined, { host: 'app.ironworks.com', token: tokens.ironworks });
    assert.equal(res.body.platform_url, 'http://gymbook.app/g/ironworks');
    assert.equal(res.body.current_host, 'app.ironworks.com');
  });
});

describe('HSTS on custom domains', () => {
  const hsts = async (host) =>
    (await call('GET', '/api/health', undefined, { host, headers: { 'x-forwarded-proto': 'https' } })).headers[
      'strict-transport-security'
    ];

  it("keeps includeSubDomains on the platform's own hosts", async () => {
    assert.match(await hsts('gymbook.app'), /includeSubDomains/);
  });

  it("drops it on a gym's domain so their other sites are not forced onto HTTPS", async () => {
    const value = await hsts('app.ironworks.com');
    assert.ok(value);
    assert.doesNotMatch(value, /includeSubDomains/);
  });
});

describe('TLS certificate gate', () => {
  const ask = (domain) => call('GET', `/api/custom-domains/tls-check?domain=${encodeURIComponent(domain)}`);

  it('allows live custom domains, the platform domain and real gym subdomains', async () => {
    assert.equal((await ask('app.ironworks.com')).status, 200);
    assert.equal((await ask('gymbook.app')).status, 200);
    assert.equal((await ask('ironworks.gymbook.app')).status, 200);
  });

  it('refuses everything else, pending domains included', async () => {
    assert.equal((await ask('a.corefit.com')).status, 404);
    assert.equal((await ask('random.example.org')).status, 404);
    assert.equal((await ask('nosuchgym.gymbook.app')).status, 404);
    assert.equal((await ask('')).status, 404);
  });
});

/* ── Contested claims ──────────────────────────────────────────────────── */

describe('two gyms claiming the same hostname', () => {
  it('goes to whichever gym proves ownership, and clears the losing claim', async () => {
    resetZone();
    const squatter = (await gym('pulsefit').add('portal.contested.com')).body.domain;
    const owner = (await gym('ironworks').add('portal.contested.com')).body.domain;
    assert.equal(owner.status, 'pending', 'a pending claim elsewhere must not block the real owner');

    // DNS is set up by the real owner, with *their* token.
    publish(owner);

    const squatterCheck = await gym('pulsefit').check(squatter.id);
    assert.equal(squatterCheck.body.result.routing.ok, true);
    assert.equal(squatterCheck.body.result.ownership.ok, false);
    assert.equal(squatterCheck.body.domain.status, 'pending');

    const ownerCheck = await gym('ironworks').check(owner.id);
    assert.equal(ownerCheck.body.domain.status, 'active');

    const left = (await gym('pulsefit').list()).body.items.map((d) => d.hostname);
    assert.ok(!left.includes('portal.contested.com'));
    assert.equal(await tenantAt('portal.contested.com'), 'ironworks');
  });
});

describe('check cooldown', () => {
  it('reuses a fresh result instead of querying DNS again', async () => {
    const domain = (await gym('pulsefit').add('cooldown.pulsefit.com')).body.domain;
    let lookups = 0;
    const counting = Object.fromEntries(
      Object.entries(fakeResolver).map(([name, fn]) => [name, (...args) => ((lookups += 1), fn(...args))]),
    );

    const first = await domains.runDomainCheck(domain.id, { cooldownMs: 60_000, resolver: counting });
    assert.equal(first.throttled, false);
    const used = lookups;
    const second = await domains.runDomainCheck(domain.id, { cooldownMs: 60_000, resolver: counting });
    assert.equal(second.throttled, true);
    assert.equal(lookups, used);

    assert.equal((await gym('pulsefit').remove(domain.id)).status, 200);
  });
});

/* ── Operator console ──────────────────────────────────────────────────── */

describe('operator console', () => {
  let domainId;

  it('lists every gym’s domains, and shows them on the gym rows', async () => {
    const res = await call('GET', '/api/platform/admin/domains', undefined, { token: ops });
    assert.equal(res.status, 200);
    const iron = res.body.items.find((d) => d.hostname === 'app.ironworks.com');
    assert.equal(iron.tenant_slug, 'ironworks');
    assert.equal(iron.gym_name, 'Iron Works Gym');

    const tenants = await call('GET', '/api/platform/admin/tenants', undefined, { token: ops });
    const row = tenants.body.items.find((t) => t.slug === 'ironworks');
    assert.ok(row.custom_domains.some((d) => d.hostname === 'app.ironworks.com' && d.status === 'active'));
  });

  it('is closed to gym tokens', async () => {
    const res = await call('GET', '/api/platform/admin/domains', undefined, { token: tokens.ironworks });
    assert.equal(res.status, 403);
  });

  it('can connect a domain on a gym’s behalf and put it straight live', async () => {
    const res = await call(
      'POST',
      '/api/platform/admin/tenants/pulsefit/domains',
      { hostname: 'members.pulsefit.com', activate: true },
      { token: ops },
    );
    assert.equal(res.status, 201);
    assert.equal(res.body.domain.status, 'active');
    domainId = res.body.domain.id;
    assert.equal(await tenantAt('members.pulsefit.com'), 'pulsefit');
  });

  it('can re-run a check with no cooldown', async () => {
    const res = await call('POST', `/api/platform/admin/domains/${domainId}/check`, {}, { token: ops });
    assert.equal(res.status, 200);
    assert.equal(res.body.result.ok, false);
    assert.equal(res.body.domain.status, 'active', 'a failing check never takes a live domain down');
  });

  it('can take a domain out of routing and back', async () => {
    let res = await call('PATCH', `/api/platform/admin/domains/${domainId}`, { status: 'pending' }, { token: ops });
    assert.equal(res.body.domain.status, 'pending');
    assert.equal(await tenantAt('members.pulsefit.com'), null);

    res = await call('PATCH', `/api/platform/admin/domains/${domainId}`, { status: 'active' }, { token: ops });
    assert.equal(res.body.domain.status, 'active');
    assert.equal(await tenantAt('members.pulsefit.com'), 'pulsefit');
  });

  it('can correct a hostname, which then has to verify again', async () => {
    const res = await call(
      'PATCH',
      `/api/platform/admin/domains/${domainId}`,
      { hostname: 'portal.pulsefit.com' },
      { token: ops },
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.domain.hostname, 'portal.pulsefit.com');
    assert.equal(res.body.domain.status, 'pending');
    assert.equal(await tenantAt('members.pulsefit.com'), null);
  });

  it('refuses to move a domain onto a hostname live on another gym', async () => {
    const res = await call(
      'PATCH',
      `/api/platform/admin/domains/${domainId}`,
      { hostname: 'app.ironworks.com' },
      { token: ops },
    );
    assert.equal(res.status, 409);
  });

  it('can disconnect a domain', async () => {
    const res = await call('DELETE', `/api/platform/admin/domains/${domainId}`, undefined, { token: ops });
    assert.equal(res.status, 200);
    assert.equal((await call('DELETE', `/api/platform/admin/domains/${domainId}`, undefined, { token: ops })).status, 404);
  });
});

/* ── Lifecycle ─────────────────────────────────────────────────────────── */

describe('a gym leaving the platform', () => {
  it('stops serving a removed domain', async () => {
    const live = (await gym('ironworks').list()).body.items.find((d) => d.hostname === 'portal.contested.com');
    assert.equal((await gym('ironworks').remove(live.id)).status, 200);
    assert.equal(await tenantAt('portal.contested.com'), null);
  });

  it('blocks a cancelled gym on its own domain too, then frees the domain when deleted', async () => {
    const live = await call(
      'POST',
      '/api/platform/admin/tenants/ironworks/domains',
      { hostname: 'ironworks.net', activate: true },
      { token: ops },
    );
    assert.equal(live.status, 201);
    assert.equal(live.body.domain.kind, 'apex');

    await call('POST', '/api/platform/admin/tenants/ironworks/status', { status: 'cancelled' }, { token: ops });
    const blocked = await call('GET', '/api/platform/tenant', undefined, { host: 'ironworks.net' });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.code, 'tenant_cancelled');

    const deleted = await call(
      'DELETE',
      '/api/platform/admin/tenants/ironworks',
      { confirm_slug: 'ironworks' },
      { token: ops },
    );
    assert.equal(deleted.status, 200);

    const remaining = (await call('GET', '/api/platform/admin/domains', undefined, { token: ops })).body.items;
    assert.ok(!remaining.some((d) => d.tenant_slug === 'ironworks'));
    assert.equal((await call('GET', '/api/custom-domains/tls-check?domain=app.ironworks.com')).status, 404);
  });
});
