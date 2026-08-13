import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

/**
 * The operator console's management surface: per-gym drill-down, profile
 * edits, deletion, platform analytics and backups.
 *
 * Its own file because config.js reads PLATFORM_ADMIN_* and BACKUP_DIR once at
 * import — a console that is configured cannot share a process with one that
 * is not, and backups must be aimed at a temp folder rather than the repo's.
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-console-test-'));
process.env.NODE_ENV = 'test';
process.env.DB_FILE = path.join(tmpDir, 'default.db');
process.env.PLATFORM_DB_FILE = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.BACKUP_DIR = path.join(tmpDir, 'backups');
process.env.BACKUP_INTERVAL_HOURS = '0';
process.env.AUTH_SECRET = 'test-secret';
process.env.PLATFORM_ADMIN_EMAIL = 'ops@gymbook.test';
process.env.PLATFORM_ADMIN_PASSWORD = 'operator-pass-123';

const { createApp } = await import('../src/app.js');
const { closeDb } = await import('../src/db.js');
const { closeRegistryDb } = await import('../src/tenants.js');
const { today } = await import('../src/validate.js');

let base;
let server;
let ops;

const call = async (method, urlPath, body, { token, tenant } = {}) => {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(tenant ? { 'X-Tenant-Slug': tenant } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

const signup = (slug, gymName) =>
  call('POST', '/api/platform/signup', {
    slug,
    gym_name: gymName,
    admin_name: 'Owner',
    admin_email: `owner@${slug}.test`,
    admin_password: 'ownerpass123',
  });

const loginGym = async (slug) =>
  (await call('POST', '/api/auth/login', { email: `owner@${slug}.test`, password: 'ownerpass123' }, { tenant: slug }))
    .body.token;

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  assert.equal((await signup('ironworks', 'Iron Works Gym')).status, 201);
  assert.equal((await signup('pulsefit', 'Pulse Fit')).status, 201);

  ops = (
    await call('POST', '/api/platform/admin/login', {
      email: 'ops@gymbook.test',
      password: 'operator-pass-123',
    })
  ).body.token;

  // Give one gym real data so the numbers below are not all zero.
  const token = await loginGym('ironworks');
  const ctx = { token, tenant: 'ironworks' };
  await call('POST', '/api/members', { first_name: 'Asha', last_name: 'Menon', phone: '9990001111' }, ctx);
  await call('POST', '/api/plans', { name: 'Monthly', price: 1500, duration_days: 30 }, ctx);
  await call(
    'POST',
    '/api/subscriptions',
    { member_id: 1, plan_id: 1, start_date: today(), payment_amount: 1500 },
    ctx,
  );
});

after(() => {
  server.close();
  closeDb();
  closeRegistryDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('console access control on the new endpoints', () => {
  const guarded = [
    ['GET', '/api/platform/admin/tenants/ironworks'],
    ['PATCH', '/api/platform/admin/tenants/ironworks'],
    ['DELETE', '/api/platform/admin/tenants/ironworks'],
    ['GET', '/api/platform/admin/analytics'],
    ['GET', '/api/platform/admin/backups'],
    ['POST', '/api/platform/admin/backups/run'],
  ];

  it('refuses anyone signed out', async () => {
    for (const [method, url] of guarded) {
      const res = await call(method, url, method === 'GET' ? null : {});
      assert.equal(res.status, 401, `${method} ${url} should need a token`);
    }
  });

  it('refuses a gym admin, however privileged inside their own gym', async () => {
    const gymToken = await loginGym('ironworks');
    for (const [method, url] of guarded) {
      const res = await call(method, url, method === 'GET' ? null : {}, { token: gymToken });
      assert.equal(res.status, 403, `${method} ${url} must reject a gym token`);
    }
  });
});

describe('per-gym detail', () => {
  it('returns the account, its numbers, its staff and what it sells', async () => {
    const res = await call('GET', '/api/platform/admin/tenants/ironworks', null, { token: ops });
    assert.equal(res.status, 200);

    assert.equal(res.body.tenant.slug, 'ironworks');
    assert.equal(res.body.stats.members, 1);
    assert.equal(res.body.stats.revenue_month, 1500);
    assert.equal(res.body.stats.revenue_total, 1500);
    assert.equal(res.body.detail.staff.length, 1);
    assert.equal(res.body.detail.staff[0].email, 'owner@ironworks.test');
    assert.equal(res.body.detail.plans[0].name, 'Monthly');
    assert.equal(res.body.detail.recent_payments[0].amount, 1500);
    assert.deepEqual(res.body.devices, []);
  });

  it('never serialises the logo blob into the response', async () => {
    const tinyPng =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const token = await loginGym('ironworks');
    const saved = await call('PATCH', '/api/platform/tenant', { logo_data: tinyPng }, { token, tenant: 'ironworks' });
    assert.equal(saved.status, 200);

    const res = await call('GET', '/api/platform/admin/tenants/ironworks', null, { token: ops });
    assert.equal(res.body.tenant.logo_bytes, undefined, 'the raw BLOB must not cross the wire');
    assert.equal(res.body.tenant.has_logo, true, 'but the operator can still see that one is set');
  });

  it('reports WhatsApp state without ever handing over the pairing QR', async () => {
    const res = await call('GET', '/api/platform/admin/tenants/ironworks', null, { token: ops });
    assert.equal(res.body.whatsapp.connected, false);
    assert.equal(res.body.whatsapp.has_credentials, false);
    assert.equal(res.body.whatsapp.qr, undefined, 'the QR is the credential — it stays with the gym');
  });

  it('404s a gym that does not exist', async () => {
    const res = await call('GET', '/api/platform/admin/tenants/nowhere', null, { token: ops });
    assert.equal(res.status, 404);
  });
});

describe('editing a gym on its owner’s behalf', () => {
  it('renames a gym and sets its timezone', async () => {
    const res = await call(
      'PATCH',
      '/api/platform/admin/tenants/pulsefit',
      { gym_name: 'Pulse Fitness Club', timezone: 'Asia/Kolkata', currency: 'inr' },
      { token: ops },
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.tenant.gym_name, 'Pulse Fitness Club');
    assert.equal(res.body.tenant.timezone, 'Asia/Kolkata');
    assert.equal(res.body.tenant.currency, 'INR', 'currency is normalised to upper case');

    const reread = await call('GET', '/api/platform/admin/tenants/pulsefit', null, { token: ops });
    assert.equal(reread.body.tenant.gym_name, 'Pulse Fitness Club');
  });

  it('rejects a timezone that is not a real IANA name', async () => {
    const res = await call(
      'PATCH',
      '/api/platform/admin/tenants/pulsefit',
      { timezone: 'Mars/Olympus_Mons' },
      { token: ops },
    );
    assert.equal(res.status, 400);
    assert.match(res.body.details.timezone, /not a recognised timezone/);
  });

  it('leaves the gym’s billing status alone', async () => {
    const before = await call('GET', '/api/platform/admin/tenants/pulsefit', null, { token: ops });
    await call('PATCH', '/api/platform/admin/tenants/pulsefit', { gym_name: 'Pulse Again' }, { token: ops });
    const after = await call('GET', '/api/platform/admin/tenants/pulsefit', null, { token: ops });
    assert.equal(after.body.tenant.status, before.body.tenant.status);
  });
});

describe('platform analytics', () => {
  it('reports signups per month and a status breakdown off the registry', async () => {
    const res = await call('GET', '/api/platform/admin/analytics', null, { token: ops });
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 2);
    assert.equal(res.body.signups_by_month.length, 12, 'a full year, zero-filled');

    const thisMonth = new Date().toISOString().slice(0, 7);
    const bucket = res.body.signups_by_month.find((p) => p.month === thisMonth);
    assert.equal(bucket.count, 2, 'both gyms signed up this month');
    assert.equal(Object.values(res.body.by_status).reduce((a, b) => a + b, 0), 2);
  });
});

describe('backups from the console', () => {
  it('starts with nothing taken', async () => {
    const res = await call('GET', '/api/platform/admin/backups', null, { token: ops });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.items, []);
    assert.equal(res.body.offsite, false, 'no S3 configured in tests');
  });

  it('runs one on demand, verifying every database it snapshots', async () => {
    const res = await call('POST', '/api/platform/admin/backups/run', {}, { token: ops });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.errors, []);
    // platform + default + the two gyms
    assert.ok(res.body.databases >= 3, `expected several databases, got ${res.body.databases}`);
  });

  it('lists what it just took', async () => {
    const res = await call('GET', '/api/platform/admin/backups', null, { token: ops });
    assert.equal(res.body.items.length, 1);
    assert.ok(res.body.items[0].bytes > 0);
    assert.ok(res.body.items[0].databases >= 3);
    assert.ok(Date.parse(res.body.items[0].taken_at), 'taken_at is a real timestamp');
  });
});

describe('deleting a gym', () => {
  it('refuses while the gym is not cancelled', async () => {
    const res = await call(
      'DELETE',
      '/api/platform/admin/tenants/pulsefit',
      { confirm_slug: 'pulsefit' },
      { token: ops },
    );
    assert.equal(res.status, 400);
    assert.match(res.body.error, /cancelled/i);

    const still = await call('GET', '/api/platform/admin/tenants/pulsefit', null, { token: ops });
    assert.equal(still.status, 200, 'the gym is untouched');
  });

  it('refuses when the typed confirmation does not match', async () => {
    await call('POST', '/api/platform/admin/tenants/pulsefit/status', { status: 'cancelled' }, { token: ops });

    const res = await call(
      'DELETE',
      '/api/platform/admin/tenants/pulsefit',
      { confirm_slug: 'pulse-fit' },
      { token: ops },
    );
    assert.equal(res.status, 400);
    assert.equal(res.body.details.confirm_slug, 'does not match');

    const still = await call('GET', '/api/platform/admin/tenants/pulsefit', null, { token: ops });
    assert.equal(still.status, 200);
  });

  it('archives a verified snapshot, then removes the gym and its database', async () => {
    const dbFile = path.join(tmpDir, 'tenants', 'pulsefit.db');
    assert.ok(fs.existsSync(dbFile), 'precondition: the gym has a database file');

    const res = await call(
      'DELETE',
      '/api/platform/admin/tenants/pulsefit',
      { confirm_slug: 'pulsefit' },
      { token: ops },
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.slug, 'pulsefit');

    // The safety net has to exist before anything else is asserted — it is the
    // only remaining copy of this gym.
    assert.ok(res.body.archived_to, 'a snapshot path comes back');
    assert.ok(fs.existsSync(res.body.archived_to), 'and the snapshot is really on disk');
    assert.ok(res.body.archived_rows > 0, 'holding actual rows, not an empty shell');

    assert.equal(fs.existsSync(dbFile), false, 'the live database is gone');
    assert.equal(
      (await call('GET', '/api/platform/admin/tenants/pulsefit', null, { token: ops })).status,
      404,
      'and so is the registry row',
    );

    const list = await call('GET', '/api/platform/admin/tenants', null, { token: ops });
    assert.deepEqual(list.body.items.map((t) => t.slug), ['ironworks']);
  });

  it('leaves the other gym completely intact', async () => {
    const res = await call('GET', '/api/platform/admin/tenants/ironworks', null, { token: ops });
    assert.equal(res.status, 200);
    assert.equal(res.body.stats.members, 1);
    assert.equal(res.body.stats.revenue_total, 1500);

    const token = await loginGym('ironworks');
    const members = await call('GET', '/api/members', null, { token, tenant: 'ironworks' });
    assert.equal(members.status, 200);
    assert.equal(members.body.items.length, 1);
  });

  it('keeps the deleted gym’s archive out of the backup rotation', async () => {
    const res = await call('GET', '/api/platform/admin/backups', null, { token: ops });
    assert.ok(
      res.body.items.every((b) => b.stamp !== 'deleted'),
      'the deleted/ folder is a vault, not a backup to be pruned',
    );
  });

  it('404s deleting a gym that does not exist', async () => {
    const res = await call('DELETE', '/api/platform/admin/tenants/nowhere', { confirm_slug: 'nowhere' }, { token: ops });
    assert.equal(res.status, 404);
  });
});

// Last on purpose: every describe block above this one asserts exact tenant
// counts/lists off the shared registry (analytics totals, "only ironworks
// remains" after the delete block), so the extra tenants this block signs up
// must not exist until those assertions have already run.
describe('business type on the console', () => {
  before(async () => {
    const res = await call('POST', '/api/platform/signup', {
      slug: 'focus-hall',
      gym_name: 'Focus Study Hall',
      admin_name: 'Priya Rao',
      admin_email: 'owner@focus-hall.test',
      admin_password: 'strongpass123',
      business_type: 'library',
    });
    assert.equal(res.status, 201);
  });

  it('reports each tenant’s business type in the list, and filters by it', async () => {
    const all = await call('GET', '/api/platform/admin/tenants', null, { token: ops });
    const focusHall = all.body.items.find((t) => t.slug === 'focus-hall');
    assert.equal(focusHall.business_type, 'library');
    const ironworks = all.body.items.find((t) => t.slug === 'ironworks');
    assert.equal(ironworks.business_type, 'gym');

    const libraries = await call('GET', '/api/platform/admin/tenants?business_type=library', null, { token: ops });
    assert.ok(libraries.body.items.every((t) => t.business_type === 'library'));
    assert.ok(libraries.body.items.some((t) => t.slug === 'focus-hall'));
  });

  it('repairs a mis-selected-at-signup type from the console', async () => {
    const signup = await call('POST', '/api/platform/signup', {
      slug: 'oops-gym',
      gym_name: 'Meant To Be A Library',
      admin_name: 'Owner',
      admin_email: 'owner@oops-gym.test',
      admin_password: 'strongpass123',
    });
    assert.equal(signup.status, 201);
    assert.equal(signup.body.business_type, 'gym');

    const fixed = await call(
      'POST',
      '/api/platform/admin/tenants/oops-gym/business-type',
      { business_type: 'library' },
      { token: ops },
    );
    assert.equal(fixed.status, 200);
    assert.equal(fixed.body.tenant.business_type, 'library');

    const reread = await call('GET', '/g/oops-gym/api/platform/tenant');
    assert.equal(reread.body.tenant.business_type, 'library');
    assert.equal(reread.body.tenant.vertical.brand, 'SeatBook');
  });

  it('rejects a business type that is not a product this platform sells', async () => {
    const res = await call(
      'POST',
      '/api/platform/admin/tenants/oops-gym/business-type',
      { business_type: 'spa' },
      { token: ops },
    );
    assert.equal(res.status, 400);
  });

  it('is not reachable without the operator token', async () => {
    const res = await call('POST', '/api/platform/admin/tenants/oops-gym/business-type', { business_type: 'gym' });
    assert.equal(res.status, 401);
  });
});
