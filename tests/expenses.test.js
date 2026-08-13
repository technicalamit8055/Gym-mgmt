import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-expenses-test-'));
process.env.DB_FILE = path.join(tmpDir, 'default.db');
process.env.PLATFORM_DB_FILE = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.AUTH_SECRET = 'test-secret';

const { createApp } = await import('../src/app.js');
const { closeDb } = await import('../src/db.js');
const { closeRegistryDb } = await import('../src/tenants.js');
const { today } = await import('../src/validate.js');

let base;
let server;
let token;

const call = async (method, urlPath, body, { useToken = token } = {}) => {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(useToken ? { Authorization: `Bearer ${useToken}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  const signup = await call(
    'POST',
    '/api/platform/signup',
    {
      slug: 'focus-hall',
      gym_name: 'Focus Study Hall',
      admin_name: 'Priya Rao',
      admin_email: 'owner@focus-hall.test',
      admin_password: 'strongpass123',
      currency: 'INR',
      business_type: 'library',
    },
    { useToken: null },
  );
  assert.equal(signup.status, 201);
  token = signup.body.token;
  base = `${base}/g/focus-hall`;
});

after(() => {
  server.close();
  closeDb();
  closeRegistryDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('logging expenses', () => {
  it('defaults spent_on to today and requires a category and a positive amount', async () => {
    const missing = await call('POST', '/api/expenses', { amount: 500 });
    assert.equal(missing.status, 400);
    assert.ok(missing.body.details.category);

    const zero = await call('POST', '/api/expenses', { category: 'Rent', amount: 0 });
    assert.equal(zero.status, 400);

    const ok = await call('POST', '/api/expenses', { category: 'Rent', amount: 15000 });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.spent_on, today());
    assert.equal(ok.body.method, 'cash');
  });

  it('updates and deletes an expense', async () => {
    const created = await call('POST', '/api/expenses', { category: 'Electricity', amount: 2000 });
    const updated = await call('PATCH', `/api/expenses/${created.body.id}`, { amount: 2200 });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.amount, 2200);

    const deleted = await call('DELETE', `/api/expenses/${created.body.id}`);
    assert.equal(deleted.status, 200);

    const gone = await call('PATCH', `/api/expenses/${created.body.id}`, { amount: 1 });
    assert.equal(gone.status, 404);
  });

  it('lists distinct categories and a running total', async () => {
    await call('POST', '/api/expenses', { category: 'Wifi', amount: 1200 });
    const res = await call('GET', '/api/expenses');
    assert.equal(res.status, 200);
    assert.ok(res.body.categories.includes('Wifi'));
    assert.ok(res.body.totals.total > 0);
  });
});

describe('collected vs spent', () => {
  it('summarises collected, spent and net for the period, defaulting to this month', async () => {
    await call('POST', '/api/expenses', { category: 'Staff', amount: 5000, spent_on: today() });

    const student = await call('POST', '/api/members', { first_name: 'Payer' });
    const plans = await call('GET', '/api/plans');
    await call('POST', '/api/subscriptions', {
      member_id: student.body.id,
      plan_id: plans.body.items[0].id,
      payment_amount: 600,
    });

    const summary = await call('GET', '/api/expenses/summary');
    assert.equal(summary.status, 200);
    assert.ok(summary.body.spent >= 5000);
    assert.ok(summary.body.collected >= 600);
    assert.equal(summary.body.net, summary.body.collected - summary.body.spent);
    assert.ok(Array.isArray(summary.body.by_category));
  });
});

describe('library-specific reports', () => {
  it('reports revenue by shift and a bounded daily occupancy series', async () => {
    const res = await call('GET', '/api/reports/occupancy');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.by_shift));
    assert.ok(Array.isArray(res.body.daily));
    assert.ok(res.body.daily.length <= 401);
  });

  it('reports collected vs spent over time', async () => {
    const res = await call('GET', '/api/reports/pnl');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.series));
    assert.ok(Array.isArray(res.body.by_category));
  });

  it('exports seats, lockers and expenses as CSV', async () => {
    for (const entity of ['seats', 'lockers', 'expenses']) {
      const res = await fetch(`${base}/api/reports/export/${entity}`, { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(res.status, 200, entity);
      assert.match(res.headers.get('content-type'), /text\/csv/);
    }
  });
});

describe('the expenses module does not leak into a gym', () => {
  it('404s /api/expenses for a gym tenant', async () => {
    const signup = await call(
      'POST',
      '/api/platform/signup',
      {
        slug: 'iron-house',
        gym_name: 'Iron House',
        admin_name: 'Amit',
        admin_email: 'owner@iron-house.test',
        admin_password: 'strongpass123',
        currency: 'INR',
      },
      { useToken: null },
    );
    const gymBase = base.replace('/g/focus-hall', '/g/iron-house');
    const res = await fetch(`${gymBase}/api/expenses`, { headers: { Authorization: `Bearer ${signup.body.token}` } });
    assert.equal(res.status, 404);
  });
});
