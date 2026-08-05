import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-security-test-'));
process.env.DB_FILE = path.join(tmpDir, 'default.db');
process.env.PLATFORM_DB_FILE = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.AUTH_SECRET = 'test-secret';
process.env.LOGIN_MAX_ATTEMPTS = '3';
process.env.LOGIN_WINDOW_MS = '10000';
process.env.LOGIN_LOCKOUT_MS = '300';
process.env.SIGNUP_MAX_ATTEMPTS = '3';
process.env.SIGNUP_WINDOW_MS = '10000';
process.env.SIGNUP_LOCKOUT_MS = '5000';

const { createApp } = await import('../src/app.js');
const { closeDb } = await import('../src/db.js');
const { closeRegistryDb } = await import('../src/tenants.js');
const { assertProductionReady } = await import('../src/config.js');

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
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
};

const signup = (slug) =>
  call('POST', '/api/platform/signup', {
    slug,
    gym_name: `${slug} Gym`,
    admin_name: 'Owner',
    admin_email: `owner@${slug}.test`,
    admin_password: 'ownerpass123',
  });

const login = (slug, password) => call('POST', '/api/auth/login', { email: `owner@${slug}.test`, password }, { tenant: slug });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

describe('login lockout', () => {
  it('locks out after repeated failures, then recovers after the window', async () => {
    await signup('locka');
    await signup('lockb');

    assert.equal((await login('locka', 'wrong1')).status, 401);
    assert.equal((await login('locka', 'wrong2')).status, 401);
    assert.equal((await login('locka', 'wrong3')).status, 401);

    // Even the correct password is rejected once locked out.
    const lockedOut = await login('locka', 'ownerpass123');
    assert.equal(lockedOut.status, 429);
    assert.ok(lockedOut.headers.get('retry-after'));

    // A different tenant sharing the same client IP is unaffected.
    assert.equal((await login('lockb', 'ownerpass123')).status, 200);

    await sleep(350);
    assert.equal((await login('locka', 'ownerpass123')).status, 200);
  });
});

describe('signup rate limit', () => {
  it('blocks further signups from the same address past the threshold', async () => {
    await call('POST', '/api/platform/signup', {});
    await call('POST', '/api/platform/signup', {});
    await call('POST', '/api/platform/signup', {});

    const res = await call('POST', '/api/platform/signup', {});
    assert.equal(res.status, 429);
  });
});

describe('security response headers', () => {
  it('sets baseline headers on every response', async () => {
    const res = await call('GET', '/api/health');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  });
});

describe('assertProductionReady', () => {
  it('throws in production with no AUTH_SECRET', () => {
    assert.throws(() => assertProductionReady({ NODE_ENV: 'production' }));
  });

  it('does not throw once AUTH_SECRET is set', () => {
    assert.doesNotThrow(() => assertProductionReady({ NODE_ENV: 'production', AUTH_SECRET: 'a-real-secret' }));
  });

  it('does not throw outside production', () => {
    assert.doesNotThrow(() => assertProductionReady({ NODE_ENV: 'development' }));
  });
});
