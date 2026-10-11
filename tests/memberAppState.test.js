import assert from 'node:assert/strict';
import { memberToken as signInMember } from './helpers/memberAuth.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-appstate-test-'));
process.env.DB_FILE = path.join(tmpDir, 'default.db');
process.env.PLATFORM_DB_FILE = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.AUTH_SECRET = 'test-secret';

const { createApp } = await import('../src/app.js');
const { closeDb } = await import('../src/db.js');
const { closeRegistryDb } = await import('../src/tenants.js');

let base;
let server;

const call = async (method, urlPath, body, { token, tenant = 'syncgym' } = {}) => {
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

describe('member app state follows the member between devices', () => {
  let memberToken;
  let otherToken;
  const cart = [{ product_id: 3, variant_id: 7, quantity: 2 }];

  it('sets up a gym with two members signed into the portal', async () => {
    await call('POST', '/api/platform/signup', {
      slug: 'syncgym',
      gym_name: 'Sync Gym',
      admin_name: 'Owner',
      admin_email: 'owner@syncgym.test',
      admin_password: 'ownerpass123',
    }, { tenant: null });
    const staffToken = (await call('POST', '/api/auth/login', { email: 'owner@syncgym.test', password: 'ownerpass123' })).body.token;

    const member = await call('POST', '/api/members', { first_name: 'Rahul', phone: '9876543210' }, { token: staffToken });
    memberToken = await signInMember(call, { staffToken: staffToken, memberId: member.body.id });
    const other = await call('POST', '/api/members', { first_name: 'Priya', phone: '9123456789' }, { token: staffToken });
    otherToken = await signInMember(call, { staffToken: staffToken, memberId: other.body.id });
    assert.ok(memberToken && otherToken);
  });

  it('reports a key that was never synced with a null updated_at', async () => {
    const res = await call('GET', '/api/portal/state/cart', undefined, { token: memberToken });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { value: null, updated_at: null });
  });

  it('hands back what one device saved, to the same member only', async () => {
    const saved = await call('PUT', '/api/portal/state/cart', { value: cart }, { token: memberToken });
    assert.equal(saved.status, 200);

    const mine = await call('GET', '/api/portal/state/cart', undefined, { token: memberToken });
    assert.deepEqual(mine.body.value, cart);
    assert.ok(mine.body.updated_at);

    const theirs = await call('GET', '/api/portal/state/cart', undefined, { token: otherToken });
    assert.deepEqual(theirs.body, { value: null, updated_at: null });
  });

  it('keeps a cleared value as cleared, so another device does not re-upload its old copy', async () => {
    await call('PUT', '/api/portal/state/cart', { value: null }, { token: memberToken });
    const res = await call('GET', '/api/portal/state/cart', undefined, { token: memberToken });
    assert.equal(res.body.value, null);
    assert.ok(res.body.updated_at);
  });

  it('syncs a workout in progress', async () => {
    const workout = { workout_name: 'Pull Day', started_at: Date.now(), exercises: [{ exercise_name: 'Deadlift', sets: [] }] };
    await call('PUT', '/api/portal/state/active_workout', { value: workout }, { token: memberToken });
    const res = await call('GET', '/api/portal/state/active_workout', undefined, { token: memberToken });
    assert.deepEqual(res.body.value, workout);
  });

  it('rejects unknown keys, a missing value, oversized values and anonymous callers', async () => {
    assert.equal((await call('GET', '/api/portal/state/anything', undefined, { token: memberToken })).status, 404);
    assert.equal((await call('PUT', '/api/portal/state/cart', {}, { token: memberToken })).status, 400);
    const huge = await call('PUT', '/api/portal/state/cart', { value: 'x'.repeat(300 * 1024) }, { token: memberToken });
    assert.equal(huge.status, 400);
    assert.equal((await call('GET', '/api/portal/state/cart')).status, 401);
  });
});
