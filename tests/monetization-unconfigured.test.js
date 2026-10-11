import assert from 'node:assert/strict';
import { memberToken as signInMember } from './helpers/memberAuth.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

/**
 * The store and paywall on a deployment with no Razorpay keys. Its own file
 * because config.js reads the keys once at import.
 *
 * A store the operator set live must show as live to members — not silently
 * fall back to "coming soon" — with only its checkout held closed.
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-monetization-nokeys-'));
process.env.NODE_ENV = 'test';
process.env.DB_FILE = path.join(tmpDir, 'default.db');
process.env.PLATFORM_DB_FILE = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.BACKUP_INTERVAL_HOURS = '0';
process.env.AUTH_SECRET = 'test-secret';
process.env.PLATFORM_ADMIN_EMAIL = 'ops@gymbook.test';
process.env.PLATFORM_ADMIN_PASSWORD = 'operator-pass-123';
delete process.env.RAZORPAY_KEY_ID;
delete process.env.RAZORPAY_KEY_SECRET;

const { createApp } = await import('../src/app.js');
const { closeDb } = await import('../src/db.js');
const { closeRegistryDb } = await import('../src/tenants.js');

let base;
let server;
let ops;
let member;
const TENANT = 'nokeys';

const call = async (method, urlPath, body, { token, tenant = TENANT } = {}) => {
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

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  await call(
    'POST',
    '/api/platform/signup',
    { slug: TENANT, gym_name: 'No Keys Gym', admin_name: 'Owner', admin_email: 'owner@nokeys.test', admin_password: 'ownerpass123' },
    { tenant: null },
  );
  const staff = (await call('POST', '/api/auth/login', { email: 'owner@nokeys.test', password: 'ownerpass123' })).body.token;
  const asha = await call('POST', '/api/members', { first_name: 'Asha', phone: '9990001111' }, { token: staff });
  member = await signInMember(call, { staffToken: staff, memberId: asha.body.id });
  ops = (await call('POST', '/api/platform/admin/login', { email: 'ops@gymbook.test', password: 'operator-pass-123' }, { tenant: null }))
    .body.token;

  const opsCall = (method, p, body) => call(method, `/api/platform/admin${p}`, body, { token: ops, tenant: null });
  assert.equal((await opsCall('POST', '/store/products', { title: 'Whey', brand: 'ON', mrp: 3000, price: 2500 })).status, 201);
  assert.equal((await opsCall('PUT', '/monetization', { store_status: 'live', fitness_addon_collection_mode: 'both' })).status, 200);
});

after(() => {
  server?.close();
  closeDb();
  closeRegistryDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('store live without Razorpay keys', () => {
  it('shows the live store and its products, with checkout marked unavailable', async () => {
    const me = await call('GET', '/api/portal/me', null, { token: member });
    assert.equal(me.body.monetization.store_status, 'live');
    assert.equal(me.body.monetization.online_payments, false);

    const store = await call('GET', '/api/portal/store', null, { token: member });
    assert.equal(store.body.status, 'live');
    assert.equal(store.body.payments_ready, false);
    assert.equal(store.body.products.length, 1);
  });

  it('refuses checkout with a clear 503 rather than a broken Razorpay call', async () => {
    const product = (await call('GET', '/api/portal/store', null, { token: member })).body.products[0];
    const res = await call(
      'POST',
      '/api/portal/store/checkout',
      {
        items: [{ product_id: product.id, quantity: 1 }],
        shipping: { name: 'Asha', phone: '9990001111', address: '12 MG Road', city: 'Pune', pincode: '411001' },
      },
      { token: member },
    );
    assert.equal(res.status, 503);
  });

  it('keeps the add-on paywall on the front desk', async () => {
    const status = await call('GET', '/api/portal/fitness/status', null, { token: member });
    assert.equal(status.body.monetization.addon_collection_mode, 'desk');
  });
});
