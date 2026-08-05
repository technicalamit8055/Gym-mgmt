import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-billing-unconfigured-test-'));
process.env.DB_FILE = path.join(tmpDir, 'default.db');
process.env.PLATFORM_DB_FILE = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.AUTH_SECRET = 'test-secret';
// Deliberately no RAZORPAY_* env vars — the realistic starting state before
// a Razorpay account is set up.
delete process.env.RAZORPAY_KEY_ID;
delete process.env.RAZORPAY_KEY_SECRET;
delete process.env.RAZORPAY_WEBHOOK_SECRET;
delete process.env.RAZORPAY_PLAN_ID;

const { createApp } = await import('../src/app.js');
const { closeDb } = await import('../src/db.js');
const { closeRegistryDb } = await import('../src/tenants.js');

let base;
let server;

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

describe('billing without Razorpay configured', () => {
  it('fails clearly instead of crashing when /subscribe is called', async () => {
    await call('POST', '/api/platform/signup', {
      slug: 'noconfig',
      gym_name: 'No Config Gym',
      admin_name: 'Owner',
      admin_email: 'owner@noconfig.test',
      admin_password: 'ownerpass123',
    });
    const token = (
      await call('POST', '/api/auth/login', { email: 'owner@noconfig.test', password: 'ownerpass123' }, { tenant: 'noconfig' })
    ).body.token;

    const res = await call('POST', '/api/platform/billing/subscribe', {}, { token, tenant: 'noconfig' });
    assert.equal(res.status, 500);
    assert.equal(res.body.error, 'Billing is not configured');
  });
});
