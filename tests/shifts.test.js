import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-shifts-test-'));
process.env.DB_FILE = path.join(tmpDir, 'default.db');
process.env.PLATFORM_DB_FILE = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.AUTH_SECRET = 'test-secret';

const { createApp } = await import('../src/app.js');
const { closeDb } = await import('../src/db.js');
const { closeRegistryDb } = await import('../src/tenants.js');

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

describe('shifts are seeded per vertical', () => {
  it('seeds the five library shifts, ordered, with the night shift flagged overnight', async () => {
    const res = await call('GET', '/api/sessions');
    assert.equal(res.status, 200);
    const names = res.body.items.map((s) => s.name);
    assert.deepEqual(names, ['Morning', 'Afternoon', 'Evening', 'Night', 'Full Day']);

    const night = res.body.items.find((s) => s.name === 'Night');
    assert.equal(night.overnight, 1);
    assert.equal(night.start_time, '22:00');
    assert.equal(night.end_time, '06:00');
  });

  it('locks the seeded passes to the shift named in their description', async () => {
    const res = await call('GET', '/api/plans');
    const morningPlan = res.body.items.find((p) => p.name === 'Morning Monthly');
    const sessions = await call('GET', '/api/sessions');
    const morningShift = sessions.body.items.find((s) => s.name === 'Morning');
    assert.equal(morningPlan.session_id, morningShift.id);
  });
});

describe('creating and editing shifts', () => {
  it('accepts a shift that runs past midnight and flags it overnight, without being asked to', async () => {
    const res = await call('POST', '/api/sessions', { name: 'Late Owl', start_time: '23:30', end_time: '05:00' });
    assert.equal(res.status, 201);
    assert.equal(res.body.overnight, 1);
  });

  it('flags a same-day shift as not overnight', async () => {
    const res = await call('POST', '/api/sessions', { name: 'Midday', start_time: '11:00', end_time: '15:00' });
    assert.equal(res.status, 201);
    assert.equal(res.body.overnight, 0);
  });

  it('carries price, capacity, code and sort_order through create and update', async () => {
    const created = await call('POST', '/api/sessions', {
      name: 'Weekend Special',
      start_time: '09:00',
      end_time: '13:00',
      price: 50,
      capacity: 40,
      code: 'WK',
      sort_order: 9,
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.price, 50);
    assert.equal(created.body.capacity, 40);
    assert.equal(created.body.code, 'WK');
    assert.equal(created.body.sort_order, 9);

    const updated = await call('PATCH', `/api/sessions/${created.body.id}`, { price: 75 });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.price, 75);
    // Untouched fields survive a partial PATCH.
    assert.equal(updated.body.capacity, 40);
    // Re-deriving overnight from the unchanged start/end must not flip it.
    assert.equal(updated.body.overnight, 0);
  });

  it('re-derives overnight when start/end change on a PATCH', async () => {
    const created = await call('POST', '/api/sessions', { name: 'Shifting', start_time: '08:00', end_time: '12:00' });
    assert.equal(created.body.overnight, 0);

    const updated = await call('PATCH', `/api/sessions/${created.body.id}`, { start_time: '23:00', end_time: '04:00' });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.overnight, 1);
  });

  it('orders shifts by sort_order, not start_time', async () => {
    const res = await call('GET', '/api/sessions');
    const order = res.body.items.map((s) => s.sort_order);
    const sorted = [...order].sort((a, b) => a - b);
    assert.deepEqual(order, sorted);
  });
});

describe('deleting a shift that is still in use', () => {
  it('refuses to delete a shift a plan is locked to', async () => {
    const sessions = await call('GET', '/api/sessions');
    const morning = sessions.body.items.find((s) => s.name === 'Morning');
    const res = await call('DELETE', `/api/sessions/${morning.id}`);
    assert.equal(res.status, 409);
  });
});
