import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-mt-test-'));
process.env.DB_FILE = path.join(tmpDir, 'default.db');
process.env.PLATFORM_DB_FILE = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.AUTH_SECRET = 'test-secret';

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

const signup = (slug, gymName) =>
  call('POST', '/api/platform/signup', {
    slug,
    gym_name: gymName,
    admin_name: 'Owner',
    admin_email: `owner@${slug}.test`,
    admin_password: 'ownerpass123',
  });

const login = (slug) =>
  call(
    'POST',
    '/api/auth/login',
    { email: `owner@${slug}.test`, password: 'ownerpass123' },
    { tenant: slug },
  );

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

describe('multi-tenancy', () => {
  it('provisions independent tenants on signup', async () => {
    const a = await signup('acme-gym', 'Acme Gym');
    const b = await signup('iron-fitness', 'Iron Fitness');
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.ok(fs.existsSync(path.join(tmpDir, 'tenants', 'acme-gym.db')));
    assert.ok(fs.existsSync(path.join(tmpDir, 'tenants', 'iron-fitness.db')));
  });

  it('refuses to reuse an already-taken slug', async () => {
    const res = await signup('acme-gym', 'Acme Gym Again');
    assert.equal(res.status, 409);
  });

  it('keeps each tenant\'s members completely separate', async () => {
    const tokenA = (await login('acme-gym')).body.token;
    const tokenB = (await login('iron-fitness')).body.token;

    const created = await call(
      'POST',
      '/api/members',
      { first_name: 'Alice', last_name: 'Acme' },
      { token: tokenA, tenant: 'acme-gym' },
    );
    assert.equal(created.status, 201);

    const membersA = await call('GET', '/api/members', null, { token: tokenA, tenant: 'acme-gym' });
    const membersB = await call('GET', '/api/members', null, { token: tokenB, tenant: 'iron-fitness' });

    assert.equal(membersA.body.items.length, 1);
    assert.equal(membersB.body.items.length, 0);
  });

  it('rejects a token from one tenant when replayed against another', async () => {
    const tokenA = (await login('acme-gym')).body.token;

    const res = await call('GET', '/api/members', null, { token: tokenA, tenant: 'iron-fitness' });
    assert.equal(res.status, 401);
  });

  it('returns 404 for an unknown gym slug', async () => {
    const res = await login('does-not-exist');
    assert.equal(res.status, 404);
  });
});
