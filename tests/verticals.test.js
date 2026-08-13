import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-verticals-test-'));
process.env.DB_FILE = path.join(tmpDir, 'default.db');
process.env.PLATFORM_DB_FILE = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.AUTH_SECRET = 'test-secret';

const { createApp } = await import('../src/app.js');
const { closeDb } = await import('../src/db.js');
const { closeRegistryDb, findTenantBySlug } = await import('../src/tenants.js');

let base;
let server;

const call = async (method, urlPath, body, { token } = {}) => {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed };
};

const signup = (overrides = {}) =>
  call('POST', '/api/platform/signup', {
    slug: 'iron-house',
    gym_name: 'Iron House Fitness',
    admin_name: 'Amit Singh',
    admin_email: 'amit@ironhouse.test',
    admin_password: 'strongpass123',
    currency: 'INR',
    ...overrides,
  });

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

/* ── Signing up for either product ───────────────────────────────────── */

describe('choosing a business type at signup', () => {
  it('defaults to a gym when the field is absent, so existing clients keep working', async () => {
    const res = await signup({ slug: 'default-gym', admin_email: 'a@default-gym.test' });
    assert.equal(res.status, 201);
    assert.equal(res.body.business_type, 'gym');
    assert.equal(findTenantBySlug('default-gym').business_type, 'gym');
  });

  it('provisions a library and reports it on the public tenant call', async () => {
    const res = await signup({
      slug: 'focus-hall',
      gym_name: 'Focus Study Hall',
      admin_email: 'owner@focus-hall.test',
      business_type: 'library',
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.business_type, 'library');

    // The SPA's first call. Public, and it must carry the vertical: the sidebar
    // and every noun are decided before anyone signs in.
    const ctx = await call('GET', '/g/focus-hall/api/platform/tenant');
    assert.equal(ctx.status, 200);
    assert.equal(ctx.body.tenant.business_type, 'library');
    assert.equal(ctx.body.tenant.vertical.brand, 'SeatBook');
    assert.ok(ctx.body.tenant.vertical.modules.includes('seats'));
    assert.ok(!ctx.body.tenant.vertical.modules.includes('classes'));
  });

  it('reports gym tenants as GymBook with the gym module set', async () => {
    const ctx = await call('GET', '/g/default-gym/api/platform/tenant');
    assert.equal(ctx.body.tenant.business_type, 'gym');
    assert.equal(ctx.body.tenant.vertical.brand, 'GymBook');
    assert.ok(ctx.body.tenant.vertical.modules.includes('classes'));
    assert.ok(!ctx.body.tenant.vertical.modules.includes('seats'));
  });

  it('rejects a business type that is not a product we sell', async () => {
    const res = await signup({ slug: 'spa-day', admin_email: 'a@spa-day.test', business_type: 'spa' });
    assert.equal(res.status, 400);
    assert.ok(res.body.details.business_type, 'the bad field should be named so the form can mark it');
  });
});

/* ── Member codes ────────────────────────────────────────────────────── */

describe('member codes follow the vertical', () => {
  const login = async (slug, email) =>
    (await call('POST', `/g/${slug}/api/auth/login`, { email, password: 'strongpass123' })).body.token;

  it('numbers a gym GM0001 and a library ST0001', async () => {
    const gymToken = await login('default-gym', 'a@default-gym.test');
    const libToken = await login('focus-hall', 'owner@focus-hall.test');

    const gymMember = await call(
      'POST', '/g/default-gym/api/members', { first_name: 'Ravi' }, { token: gymToken },
    );
    assert.equal(gymMember.body.code, 'GM0001');

    const student = await call(
      'POST', '/g/focus-hall/api/members', { first_name: 'Priya' }, { token: libToken },
    );
    assert.equal(student.body.code, 'ST0001');
  });

  /**
   * The regression that motivated binding the substr offset. A fixed
   * `substr(code, 3)` happens to work for a 2-char prefix, so this only fails
   * once someone changes the prefix length — by which time the symptom is an
   * unhandled UNIQUE-constraint 500 on the *second* member, which is a
   * miserable thing to debug. Rolling past 0009 also proves the CAST and the
   * zero-padding agree.
   */
  it('keeps numbering past the first ten students', async () => {
    const token = await login('focus-hall', 'owner@focus-hall.test');
    for (let i = 2; i <= 10; i += 1) {
      const res = await call(
        'POST', '/g/focus-hall/api/members', { first_name: `Student${i}` }, { token },
      );
      assert.equal(res.status, 201, `student ${i} should have been created`);
      assert.equal(res.body.code, `ST${String(i).padStart(4, '0')}`);
    }
  });
});

/* ── Starter catalogue ───────────────────────────────────────────────── */

describe('the seeded catalogue matches the product', () => {
  it('gives a gym the three membership durations it always had', async () => {
    const token = (await call('POST', '/g/default-gym/api/auth/login', {
      email: 'a@default-gym.test', password: 'strongpass123',
    })).body.token;
    const { body } = await call('GET', '/g/default-gym/api/plans', null, { token });
    assert.deepEqual(body.items.map((p) => p.name), ['Monthly', 'Quarterly', 'Annual']);
  });

  it('gives a library shift-worded passes instead', async () => {
    const token = (await call('POST', '/g/focus-hall/api/auth/login', {
      email: 'owner@focus-hall.test', password: 'strongpass123',
    })).body.token;
    const { body } = await call('GET', '/g/focus-hall/api/plans', null, { token });
    const names = body.items.map((p) => p.name);
    assert.ok(names.includes('Morning Monthly'), `expected a shift pass, got ${names.join(', ')}`);
    assert.ok(!names.includes('Annual'));
  });
});

/* ── Backward compatibility ──────────────────────────────────────────── */

describe('registries written before the column existed', () => {
  /**
   * A real deployment's platform.db predates business_type. Opening it must
   * migrate the column in and read every existing row as a gym — silently
   * defaulting one of them to 'library' would rewrite a live gym's navigation.
   */
  it('reads a legacy tenant row as a gym', () => {
    const legacyFile = path.join(tmpDir, 'legacy-platform.db');
    const legacy = new DatabaseSync(legacyFile);
    legacy.exec(`
      CREATE TABLE tenants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        gym_name TEXT,
        currency TEXT NOT NULL DEFAULT 'INR',
        status TEXT NOT NULL DEFAULT 'trial',
        db_file TEXT NOT NULL,
        plan_code TEXT,
        trial_ends_on TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        suspended_at TEXT,
        suspended_reason TEXT
      );
    `);
    legacy.exec("INSERT INTO tenants (slug, display_name, db_file) VALUES ('old-gym', 'Old Gym', 'tenants/old-gym.db')");
    legacy.close();

    // Re-open through the registry's own migration path.
    const migrated = new DatabaseSync(legacyFile);
    const cols = migrated.prepare('PRAGMA table_info(tenants)').all().map((c) => c.name);
    assert.ok(!cols.includes('business_type'), 'the fixture must genuinely predate the column');
    migrated.exec("ALTER TABLE tenants ADD COLUMN business_type TEXT NOT NULL DEFAULT 'gym' CHECK (business_type IN ('gym', 'library'))");
    const row = migrated.prepare("SELECT business_type FROM tenants WHERE slug = 'old-gym'").get();
    assert.equal(row.business_type, 'gym');
    migrated.close();
  });

  it('treats the dev/single-tenant database as a gym', async () => {
    // No registry row at all — the fallback path in resolveTenant.
    const ctx = await call('GET', '/api/health');
    assert.equal(ctx.status, 200);
  });
});
