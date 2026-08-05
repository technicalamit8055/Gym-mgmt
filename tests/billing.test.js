import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-billing-test-'));
process.env.DB_FILE = path.join(tmpDir, 'default.db');
process.env.PLATFORM_DB_FILE = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.AUTH_SECRET = 'test-secret';
process.env.RAZORPAY_KEY_ID = 'rzp_test_dummy';
process.env.RAZORPAY_KEY_SECRET = 'dummy_secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'whsec_dummy';
process.env.RAZORPAY_PLAN_ID = 'plan_test123';

const { createApp } = await import('../src/app.js');
const { closeDb } = await import('../src/db.js');
const { closeRegistryDb, setTenantStatus } = await import('../src/tenants.js');
const { verifyWebhookSignature } = await import('../src/razorpay.js');
const { addDays, today } = await import('../src/validate.js');

let base;
let server;
const realFetch = globalThis.fetch;

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

/** Mocks only calls bound for Razorpay's API; everything else (our own test
 * server) falls through to the real fetch. */
function mockRazorpay(t, impl) {
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    if (String(url).startsWith('https://api.razorpay.com')) return impl(url, opts);
    return realFetch(url, opts);
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

const login = (slug, email = `owner@${slug}.test`, password = 'ownerpass123') =>
  call('POST', '/api/auth/login', { email, password }, { tenant: slug });

const signWebhook = (event) => {
  const raw = Buffer.from(JSON.stringify(event));
  const signature = crypto.createHmac('sha256', 'whsec_dummy').update(raw).digest('hex');
  return { raw, signature };
};

const postWebhook = (raw, signature) =>
  fetch(`${base}/api/platform/webhooks/razorpay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Razorpay-Signature': signature ?? '' },
    body: raw,
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

describe('trial and billing lifecycle', () => {
  let token;

  it('starts a 7-day trial on signup', async () => {
    const su = await signup('acme', 'Acme Gym');
    assert.equal(su.status, 201);
    token = (await login('acme')).body.token;

    const status = await call('GET', '/api/platform/billing/status', null, { token, tenant: 'acme' });
    assert.equal(status.body.status, 'trial');
    assert.equal(status.body.trial_ends_on, addDays(today(), 7));
  });

  it('creates a Razorpay subscription and returns a checkout link', async (t) => {
    mockRazorpay(t, async (url, opts) => {
      assert.equal(url, 'https://api.razorpay.com/v1/subscriptions');
      const body = JSON.parse(opts.body);
      assert.equal(body.plan_id, 'plan_test123');
      return new Response(
        JSON.stringify({ id: 'sub_test1', short_url: 'https://rzp.io/i/test', status: 'created' }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const res = await call('POST', '/api/platform/billing/subscribe', {}, { token, tenant: 'acme' });
    assert.equal(res.status, 201);
    assert.equal(res.body.checkout_url, 'https://rzp.io/i/test');
    assert.equal(res.body.subscription_id, 'sub_test1');
  });

  it('returns the same checkout link on a repeat call instead of minting a new one', async (t) => {
    mockRazorpay(t, () => {
      throw new Error('Razorpay should not be called again before the first subscription activates');
    });

    const res = await call('POST', '/api/platform/billing/subscribe', {}, { token, tenant: 'acme' });
    assert.equal(res.status, 200);
    assert.equal(res.body.checkout_url, 'https://rzp.io/i/test');
    assert.equal(res.body.subscription_id, 'sub_test1');
  });

  it('blocks non-admin staff from subscribing', async () => {
    const staffRes = await call(
      'POST',
      '/api/staff',
      { name: 'Manager Mia', email: 'manager@acme.test', password: 'managerpass123', role: 'manager' },
      { token, tenant: 'acme' },
    );
    assert.equal(staffRes.status, 201);

    const managerToken = (await login('acme', 'manager@acme.test', 'managerpass123')).body.token;
    const res = await call('POST', '/api/platform/billing/subscribe', {}, { token: managerToken, tenant: 'acme' });
    assert.equal(res.status, 403);
  });

  it('activates the tenant on a correctly-signed webhook', async () => {
    const { raw, signature } = signWebhook({
      event: 'subscription.activated',
      created_at: Math.floor(Date.now() / 1000),
      payload: { subscription: { entity: { id: 'sub_test1', status: 'active' } } },
    });
    const res = await postWebhook(raw, signature);
    assert.equal(res.status, 200);

    const status = await call('GET', '/api/platform/billing/status', null, { token, tenant: 'acme' });
    assert.equal(status.body.status, 'active');
  });

  it('is a safe no-op on duplicate webhook delivery', async () => {
    const { raw, signature } = signWebhook({
      event: 'subscription.activated',
      created_at: Math.floor(Date.now() / 1000),
      payload: { subscription: { entity: { id: 'sub_test1', status: 'active' } } },
    });
    assert.equal((await postWebhook(raw, signature)).status, 200);
    assert.equal((await postWebhook(raw, signature)).status, 200);

    const status = await call('GET', '/api/platform/billing/status', null, { token, tenant: 'acme' });
    assert.equal(status.body.status, 'active');
  });

  it('rejects a badly signed webhook without changing status', async () => {
    const { raw } = signWebhook({
      event: 'subscription.halted',
      created_at: Math.floor(Date.now() / 1000),
      payload: { subscription: { entity: { id: 'sub_test1' } } },
    });
    const res = await postWebhook(raw, 'not-a-real-signature');
    assert.equal(res.status, 400);

    const status = await call('GET', '/api/platform/billing/status', null, { token, tenant: 'acme' });
    assert.equal(status.body.status, 'active');
  });

  it('acks a well-signed webhook for an unknown subscription without erroring', async () => {
    const { raw, signature } = signWebhook({
      event: 'subscription.activated',
      created_at: Math.floor(Date.now() / 1000),
      payload: { subscription: { entity: { id: 'sub_does_not_exist' } } },
    });
    const res = await postWebhook(raw, signature);
    assert.equal(res.status, 200);
  });

  it('ignores an out-of-order webhook that predates the last applied event', async () => {
    const now = Math.floor(Date.now() / 1000);
    const { raw, signature } = signWebhook({
      event: 'subscription.halted',
      created_at: now - 3600, // earlier than the 'activated' event already applied above
      payload: { subscription: { entity: { id: 'sub_test1' } } },
    });
    assert.equal((await postWebhook(raw, signature)).status, 200);

    const status = await call('GET', '/api/platform/billing/status', null, { token, tenant: 'acme' });
    assert.equal(status.body.status, 'active'); // unchanged — the stale halted event must not regress it
  });

  it('suspends access on a newer halted event, but keeps login and billing reachable', async () => {
    const { raw, signature } = signWebhook({
      event: 'subscription.halted',
      created_at: Math.floor(Date.now() / 1000) + 60,
      payload: { subscription: { entity: { id: 'sub_test1' } } },
    });
    assert.equal((await postWebhook(raw, signature)).status, 200);

    const members = await call('GET', '/api/members', null, { token, tenant: 'acme' });
    assert.equal(members.status, 402);

    const loginRes = await login('acme');
    assert.equal(loginRes.status, 200);

    const status = await call('GET', '/api/platform/billing/status', null, { token, tenant: 'acme' });
    assert.equal(status.status, 200);
    assert.equal(status.body.status, 'suspended');
  });

  it('still hard-blocks a cancelled tenant, including login', async () => {
    setTenantStatus('acme', 'cancelled', 'manual test cancellation');
    const res = await login('acme');
    assert.equal(res.status, 403);
  });
});

describe('lazy trial expiry', () => {
  it('flips an overdue trial to suspended on the next request', async () => {
    await signup('trialexpiry', 'Trial Expiry Gym');

    const registry = new DatabaseSync(process.env.PLATFORM_DB_FILE);
    registry.exec("UPDATE tenants SET trial_ends_on = '2000-01-01' WHERE slug = 'trialexpiry'");
    registry.close();

    const loginRes = await login('trialexpiry');
    assert.equal(loginRes.status, 200); // suspension never blocks login

    const status = await call('GET', '/api/platform/billing/status', null, {
      token: loginRes.body.token,
      tenant: 'trialexpiry',
    });
    assert.equal(status.body.status, 'suspended');
  });
});

describe('webhook signature verification', () => {
  it('accepts a correctly computed signature', () => {
    const body = Buffer.from(JSON.stringify({ foo: 'bar' }));
    const signature = crypto.createHmac('sha256', 'shhh').update(body).digest('hex');
    assert.equal(verifyWebhookSignature(body, signature, 'shhh'), true);
  });

  it('rejects a tampered signature', () => {
    const body = Buffer.from(JSON.stringify({ foo: 'bar' }));
    const signature = crypto.createHmac('sha256', 'shhh').update(body).digest('hex');
    const tampered = `0${signature.slice(1)}`;
    assert.equal(verifyWebhookSignature(body, tampered, 'shhh'), false);
  });

  it('rejects when the signature or secret is missing', () => {
    assert.equal(verifyWebhookSignature(Buffer.from('x'), null, 'shhh'), false);
    assert.equal(verifyWebhookSignature(Buffer.from('x'), 'abc', ''), false);
  });
});
