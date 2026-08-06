import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-onboarding-test-'));
process.env.DB_FILE = path.join(tmpDir, 'default.db');
process.env.PLATFORM_DB_FILE = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.AUTH_SECRET = 'test-secret';
// The operator console only exists when both are set, so they must be in place
// before config.js is evaluated by the dynamic import below.
process.env.PLATFORM_ADMIN_EMAIL = 'ops@gymbook.test';
process.env.PLATFORM_ADMIN_PASSWORD = 'operator-pass-123';

const { createApp } = await import('../src/app.js');
const { closeDb } = await import('../src/db.js');
const { closeRegistryDb } = await import('../src/tenants.js');
const { takeTenantPathPrefix, tenantUrl } = await import('../src/tenant.js');

let base;
let server;

const call = async (method, urlPath, body, { token, tenant, accept } = {}) => {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(tenant ? { 'X-Tenant-Slug': tenant } : {}),
      ...(accept ? { Accept: accept } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null; // an HTML response — the tests below assert on contentType
  }
  return { status: res.status, body: parsed, text, contentType: res.headers.get('content-type') || '' };
};

const signup = (overrides = {}) =>
  call('POST', '/api/platform/signup', {
    slug: 'iron-house',
    gym_name: 'Iron House Fitness',
    admin_name: 'Amit Singh',
    admin_email: 'amit@ironhouse.test',
    admin_password: 'strongpass123',
    currency: 'INR',
    timezone: 'Asia/Kolkata',
    ...overrides,
  });

const login = async (slug, email, password) =>
  (await call('POST', `/g/${slug}/api/auth/login`, { email, password })).body.token;

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  closeDb();
  closeRegistryDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/* ── The path prefix, as a pure function ─────────────────────────────── */

describe('takeTenantPathPrefix', () => {
  const strip = (url) => {
    const req = { url };
    return { slug: takeTenantPathPrefix(req), url: req.url };
  };

  it('pulls the slug off and leaves the rest of the path behind', () => {
    assert.deepEqual(strip('/g/acme/api/members'), { slug: 'acme', url: '/api/members' });
  });

  it('keeps the query string attached to the stripped path', () => {
    assert.deepEqual(strip('/g/acme/api/members?q=raj'), { slug: 'acme', url: '/api/members?q=raj' });
  });

  it('turns a bare prefix into the document root', () => {
    assert.deepEqual(strip('/g/acme'), { slug: 'acme', url: '/' });
    assert.deepEqual(strip('/g/acme/'), { slug: 'acme', url: '/' });
  });

  it('handles a query directly on the bare prefix', () => {
    assert.deepEqual(strip('/g/acme?x=1'), { slug: 'acme', url: '/?x=1' });
  });

  it('leaves unprefixed URLs completely alone', () => {
    assert.deepEqual(strip('/api/members'), { slug: null, url: '/api/members' });
    assert.deepEqual(strip('/'), { slug: null, url: '/' });
  });

  it('ignores a prefix whose slug could never be a real gym', () => {
    // Reserved, too short, and path traversal respectively — none may resolve,
    // and none may have their prefix stripped either.
    assert.deepEqual(strip('/g/api/x'), { slug: null, url: '/g/api/x' });
    assert.deepEqual(strip('/g/ab/x'), { slug: null, url: '/g/ab/x' });
    assert.deepEqual(strip('/g/..%2F..%2Fetc/x').slug, null);
  });

  it('matches whole labels only, so /g/acmex is not /g/acme', () => {
    assert.deepEqual(strip('/g/acmex/api'), { slug: 'acmex', url: '/api' });
  });
});

describe('tenantUrl', () => {
  const req = { protocol: 'https', get: () => 'gymbook.example.com' };

  it('advertises the path form by default, which works on any hostname', () => {
    assert.equal(tenantUrl(req, 'acme'), 'https://gymbook.example.com/g/acme');
  });
});

/* ── Signing up ──────────────────────────────────────────────────────── */

describe('gym onboarding', () => {
  let created;

  it('reports whether a gym address can be claimed', async () => {
    const free = await call('GET', '/api/platform/slug-available?slug=iron-house');
    assert.equal(free.body.available, true);

    const reserved = await call('GET', '/api/platform/slug-available?slug=admin');
    assert.equal(reserved.body.available, false);
    assert.ok(reserved.body.reason, 'says why it cannot be used');

    const malformed = await call('GET', '/api/platform/slug-available?slug=9lives');
    assert.equal(malformed.body.available, false);
  });

  it('tells the root domain there is no gym here, so it can show the landing page', async () => {
    const res = await call('GET', '/api/platform/tenant');
    assert.equal(res.status, 200);
    assert.equal(res.body.tenant, null);
    assert.equal(res.body.platform_admin, true);
    assert.equal(res.body.url_mode, 'path');
    assert.ok(res.body.trial_days > 0);
  });

  it('provisions a gym, its owner, and plans it can start selling today', async () => {
    const res = await signup();
    assert.equal(res.status, 201);
    created = res.body;

    assert.equal(created.slug, 'iron-house');
    assert.equal(created.admin_email, 'amit@ironhouse.test');
    assert.equal(created.starter_plans, 3);
    assert.equal(created.app_url, `${base}/g/iron-house`);
    assert.ok(created.trial_ends_on, 'starts a trial');
  });

  it('signs the owner straight in rather than making them retype the password', async () => {
    assert.ok(created.token, 'returns a session token');
    assert.equal(created.user.role, 'admin');

    const me = await call('GET', '/g/iron-house/api/auth/me', null, { token: created.token });
    assert.equal(me.status, 200);
    assert.equal(me.body.user.email, 'amit@ironhouse.test');
  });

  it('leaves the new gym able to sell a membership immediately', async () => {
    const plans = await call('GET', '/g/iron-house/api/plans', null, { token: created.token });
    assert.equal(plans.status, 200);
    assert.deepEqual(
      plans.body.items.map((plan) => plan.name),
      ['Monthly', 'Quarterly', 'Annual'],
    );
    assert.ok(plans.body.items.every((plan) => plan.price > 0 && plan.duration_days > 0));
  });

  it('scales the starter prices to the currency chosen at signup', async () => {
    await signup({ slug: 'pulse-fit', gym_name: 'Pulse', admin_email: 'p@pulse.test', currency: 'USD' });
    const token = await login('pulse-fit', 'p@pulse.test', 'strongpass123');
    const plans = await call('GET', '/g/pulse-fit/api/plans', null, { token });
    // A monthly fee of 1500 is sane in rupees and absurd in dollars.
    assert.ok(plans.body.items[0].price < 100, 'USD gym did not get rupee prices');
  });

  it('refuses a gym address that is already taken', async () => {
    const res = await signup({ admin_email: 'someone@else.test' });
    assert.equal(res.status, 409);
  });

  it('refuses a reserved gym address', async () => {
    const res = await signup({ slug: 'admin', admin_email: 'a@b.test' });
    assert.equal(res.status, 400);
  });

  it('reports field errors the signup form can attach to inputs', async () => {
    const res = await call('POST', '/api/platform/signup', {
      slug: 'ok-gym',
      gym_name: 'X',
      admin_name: 'Y',
      admin_email: 'not-an-email',
      admin_password: 'short',
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.details.gym_name);
    assert.ok(res.body.details.admin_email);
    assert.ok(res.body.details.admin_password);
  });
});

/* ── Reaching a gym by path ──────────────────────────────────────────── */

describe('addressing a gym by path', () => {
  let token;

  before(async () => {
    token = await login('iron-house', 'amit@ironhouse.test', 'strongpass123');
  });

  it('resolves the gym from the URL with no subdomain in play', async () => {
    const res = await call('GET', '/g/iron-house/api/platform/tenant');
    assert.equal(res.status, 200);
    assert.equal(res.body.tenant.slug, 'iron-house');
    assert.equal(res.body.tenant.gym_name, 'Iron House Fitness');
    assert.equal(res.body.tenant.timezone, 'Asia/Kolkata');
  });

  it('keeps each gym on its own data', async () => {
    await call('POST', '/g/iron-house/api/members', { first_name: 'Rahul' }, { token });

    const mine = await call('GET', '/g/iron-house/api/members', null, { token });
    assert.equal(mine.body.items.length, 1);

    const otherToken = await login('pulse-fit', 'p@pulse.test', 'strongpass123');
    const theirs = await call('GET', '/g/pulse-fit/api/members', null, { token: otherToken });
    assert.equal(theirs.body.items.length, 0, "the other gym cannot see this gym's member");
  });

  it('rejects one gym’s token when it is replayed at another gym’s path', async () => {
    const res = await call('GET', '/g/pulse-fit/api/members', null, { token });
    assert.equal(res.status, 401);
  });

  it('rejects a token used with no gym in the URL at all', async () => {
    // Without the prefix the request resolves to the default database, where
    // this token's tenant claim matches nothing.
    const res = await call('GET', '/api/members', null, { token });
    assert.equal(res.status, 401);
  });

  it('serves the app shell for an unknown gym, and JSON only to the API', async () => {
    const page = await call('GET', '/g/nowhere/');
    assert.equal(page.status, 200);
    assert.match(page.contentType, /text\/html/, 'a mistyped address gets a page, not a JSON blob');
    assert.match(page.text, /<div id="app"/);

    const api = await call('GET', '/g/nowhere/api/platform/tenant');
    assert.equal(api.status, 404);
    assert.match(api.body.error, /No gym found/);
  });
});

/* ── The gym's own settings ──────────────────────────────────────────── */

describe('gym settings', () => {
  let adminToken;
  let staffToken;

  before(async () => {
    adminToken = await login('iron-house', 'amit@ironhouse.test', 'strongpass123');
    await call(
      'POST',
      '/g/iron-house/api/staff',
      { name: 'Desk', email: 'desk@ironhouse.test', password: 'deskpass123', role: 'staff' },
      { token: adminToken },
    );
    staffToken = await login('iron-house', 'desk@ironhouse.test', 'deskpass123');
  });

  it('lets an admin rename the gym and change its currency and timezone', async () => {
    const res = await call(
      'PATCH',
      '/g/iron-house/api/platform/tenant',
      { gym_name: 'Iron House Gym', currency: 'usd', timezone: 'Asia/Dubai' },
      { token: adminToken },
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.tenant.gym_name, 'Iron House Gym');
    assert.equal(res.body.tenant.currency, 'USD', 'normalises the currency code');
    assert.equal(res.body.tenant.timezone, 'Asia/Dubai');
  });

  it('makes the new name reach the things that print it', async () => {
    const context = await call('GET', '/g/iron-house/api/platform/tenant');
    assert.equal(context.body.tenant.gym_name, 'Iron House Gym');

    const member = await call('GET', '/g/iron-house/api/members', null, { token: adminToken });
    const card = await call('GET', `/g/iron-house/api/qr/member/${member.body.items[0].id}`, null, {
      token: adminToken,
    });
    assert.equal(card.body.gym_name, 'Iron House Gym', 'printed ID cards follow the rename');
  });

  it('leaves settings alone that were not sent', async () => {
    const res = await call('PATCH', '/g/iron-house/api/platform/tenant', { gym_name: 'Iron House' }, { token: adminToken });
    assert.equal(res.body.tenant.currency, 'USD');
    assert.equal(res.body.tenant.timezone, 'Asia/Dubai');
  });

  it('refuses a timezone no clock could use', async () => {
    const res = await call('PATCH', '/g/iron-house/api/platform/tenant', { timezone: 'Mars/Olympus' }, { token: adminToken });
    assert.equal(res.status, 400);
    assert.ok(res.body.details.timezone);
  });

  it('is closed to non-admin staff', async () => {
    const res = await call('PATCH', '/g/iron-house/api/platform/tenant', { gym_name: 'Nope' }, { token: staffToken });
    assert.equal(res.status, 403);
  });

  it('is closed to anyone signed out', async () => {
    const res = await call('PATCH', '/g/iron-house/api/platform/tenant', { gym_name: 'Nope' });
    assert.equal(res.status, 401);
  });

  it('cannot be aimed at another gym by putting a slug in the body', async () => {
    await call(
      'PATCH',
      '/g/iron-house/api/platform/tenant',
      { slug: 'pulse-fit', gym_name: 'Hijacked' },
      { token: adminToken },
    );
    const victim = await call('GET', '/g/pulse-fit/api/platform/tenant');
    assert.equal(victim.body.tenant.gym_name, 'Pulse');
  });
});

/* ── Operator console ────────────────────────────────────────────────── */

describe('operator console', () => {
  let ops;

  it('refuses the configured operator’s email with the wrong password', async () => {
    const res = await call('POST', '/api/platform/admin/login', {
      email: 'ops@gymbook.test',
      password: 'wrong-password',
    });
    assert.equal(res.status, 401);
  });

  it('signs the operator in with their own credentials', async () => {
    const res = await call('POST', '/api/platform/admin/login', {
      email: 'ops@gymbook.test',
      password: 'operator-pass-123',
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.token);
    ops = res.body.token;
  });

  it('is closed to a gym admin, however privileged inside their own gym', async () => {
    const gymAdmin = await login('iron-house', 'amit@ironhouse.test', 'strongpass123');
    const res = await call('GET', '/api/platform/admin/tenants', null, { token: gymAdmin });
    assert.equal(res.status, 403, 'a gym token carries no platform scope');
  });

  it('is closed to nobody at all', async () => {
    const res = await call('GET', '/api/platform/admin/tenants');
    assert.equal(res.status, 401);
  });

  it('will not let an operator token act as a gym login', async () => {
    const res = await call('GET', '/g/iron-house/api/members', null, { token: ops });
    assert.equal(res.status, 401, 'the console token is not a staff account anywhere');
  });

  it('lists every gym on the platform', async () => {
    const res = await call('GET', '/api/platform/admin/tenants', null, { token: ops });
    assert.equal(res.status, 200);
    const slugs = res.body.items.map((t) => t.slug).sort();
    assert.deepEqual(slugs, ['iron-house', 'pulse-fit']);
  });

  it('reports per-gym numbers on request, and not otherwise', async () => {
    const plain = await call('GET', '/api/platform/admin/tenants', null, { token: ops });
    assert.equal(plain.body.items[0].stats, undefined, 'opening every gym DB is opt-in');

    const withStats = await call('GET', '/api/platform/admin/tenants?stats=1', null, { token: ops });
    const iron = withStats.body.items.find((t) => t.slug === 'iron-house');
    assert.equal(iron.stats.members, 1);
    assert.equal(iron.stats.staff, 2);
  });

  it('suspends a gym without touching its data', async () => {
    const res = await call(
      'POST',
      '/api/platform/admin/tenants/iron-house/status',
      { status: 'suspended', reason: 'non-payment' },
      { token: ops },
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.tenant.status, 'suspended');
    assert.equal(res.body.tenant.suspended_reason, 'non-payment');
  });

  it('leaves a suspended gym able to load the page that takes its payment', async () => {
    const page = await call('GET', '/g/iron-house/');
    assert.equal(page.status, 200);
    assert.match(page.contentType, /text\/html/, 'the front end must load or there is no way to subscribe');

    const token = await login('iron-house', 'amit@ironhouse.test', 'strongpass123');
    assert.ok(token, 'signing in still works while suspended');

    const context = await call('GET', '/g/iron-house/api/platform/tenant');
    assert.equal(context.body.tenant.status, 'suspended');

    const gated = await call('GET', '/g/iron-house/api/members', null, { token });
    assert.equal(gated.status, 402, 'but the gym itself is closed until they pay');
  });

  it('reactivates a gym, and its data is exactly where it was', async () => {
    await call('POST', '/api/platform/admin/tenants/iron-house/status', { status: 'active' }, { token: ops });

    const token = await login('iron-house', 'amit@ironhouse.test', 'strongpass123');
    const members = await call('GET', '/g/iron-house/api/members', null, { token });
    assert.equal(members.status, 200);
    assert.equal(members.body.items.length, 1);
  });

  it('grants a trial extension', async () => {
    const res = await call(
      'POST',
      '/api/platform/admin/tenants/pulse-fit/status',
      { status: 'trial', trial_ends_on: '2099-01-01', reason: 'goodwill' },
      { token: ops },
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.tenant.status, 'trial');
    assert.equal(res.body.tenant.trial_ends_on, '2099-01-01');
  });

  it('rejects a status that is not one of the four', async () => {
    const res = await call(
      'POST',
      '/api/platform/admin/tenants/pulse-fit/status',
      { status: 'vibes' },
      { token: ops },
    );
    assert.equal(res.status, 400);
  });

  it('404s a gym that does not exist', async () => {
    const res = await call('POST', '/api/platform/admin/tenants/nowhere/status', { status: 'active' }, { token: ops });
    assert.equal(res.status, 404);
  });

  it('hard-blocks a cancelled gym everywhere', async () => {
    await call('POST', '/api/platform/admin/tenants/pulse-fit/status', { status: 'cancelled' }, { token: ops });

    const page = await call('GET', '/g/pulse-fit/');
    assert.match(page.contentType, /text\/html/, 'still a page, so it can explain itself');

    const api = await call('GET', '/g/pulse-fit/api/platform/tenant');
    assert.equal(api.status, 403);

    const signIn = await call('POST', '/g/pulse-fit/api/auth/login', {
      email: 'p@pulse.test',
      password: 'strongpass123',
    });
    assert.equal(signIn.status, 403, 'unlike suspended, cancelled closes the door completely');
  });
});
