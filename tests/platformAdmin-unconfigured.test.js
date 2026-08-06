import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

/**
 * The operator console with no credentials configured — its own file because
 * config.js reads PLATFORM_ADMIN_* once at import, so "configured" and
 * "not configured" cannot both be exercised in one process.
 *
 * The failure this guards against is the dangerous one: an unset password
 * being read as "no password required" and leaving every gym on the
 * deployment one unauthenticated request away.
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-noconsole-test-'));
process.env.NODE_ENV = 'test';
process.env.DB_FILE = path.join(tmpDir, 'default.db');
process.env.PLATFORM_DB_FILE = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.AUTH_SECRET = 'test-secret';
delete process.env.PLATFORM_ADMIN_EMAIL;
delete process.env.PLATFORM_ADMIN_PASSWORD;

const { createApp } = await import('../src/app.js');
const { closeDb } = await import('../src/db.js');
const { closeRegistryDb } = await import('../src/tenants.js');

let base;
let server;

const call = async (method, urlPath, body) => {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
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

describe('operator console with no credentials configured', () => {
  it('tells the front end not to offer the console', async () => {
    const res = await call('GET', '/api/platform/tenant');
    assert.equal(res.body.platform_admin, false);
  });

  it('does not accept an empty password as a match for an unset one', async () => {
    for (const credentials of [{ email: 'ops@gymbook.test', password: '' }, { email: '', password: '' }]) {
      const res = await call('POST', '/api/platform/admin/login', credentials);
      assert.notEqual(res.status, 200, `signed in with ${JSON.stringify(credentials)}`);
    }
  });

  it('refuses to sign anyone in at all', async () => {
    const res = await call('POST', '/api/platform/admin/login', { email: 'ops@gymbook.test', password: 'anything' });
    assert.equal(res.status, 404);
  });

  it('leaves the gym list unreachable rather than open', async () => {
    const res = await call('GET', '/api/platform/admin/tenants');
    assert.equal(res.status, 404);
  });

  it('still runs the rest of the platform normally', async () => {
    const res = await call('POST', '/api/platform/signup', {
      slug: 'still-works',
      gym_name: 'Still Works',
      admin_name: 'Owner',
      admin_email: 'owner@still.test',
      admin_password: 'ownerpass123',
    });
    assert.equal(res.status, 201);
  });
});
