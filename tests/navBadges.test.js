import assert from 'node:assert/strict';
import { memberToken as signInMember } from './helpers/memberAuth.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

/**
 * Menu badges: the operator pins "Offer" / "New" on a member-app tab from the
 * console, and every gym's members get it on /portal/me until it is removed
 * or its last day passes.
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-navbadges-test-'));
process.env.NODE_ENV = 'test';
process.env.DB_FILE = path.join(tmpDir, 'default.db');
process.env.PLATFORM_DB_FILE = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.BACKUP_INTERVAL_HOURS = '0';
process.env.AUTH_SECRET = 'test-secret';
process.env.PLATFORM_ADMIN_EMAIL = 'ops@gymbook.test';
process.env.PLATFORM_ADMIN_PASSWORD = 'operator-pass-123';

const { createApp } = await import('../src/app.js');
const { closeDb } = await import('../src/db.js');
const { closeRegistryDb } = await import('../src/tenants.js');

let base;
let server;
let ops;
let staff;
let member;
const TENANT = 'ironworks';

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

const opsCall = (method, urlPath, body) => call(method, `/api/platform/admin${urlPath}`, body, { token: ops, tenant: null });
const memberBadges = async () => (await call('GET', '/api/portal/me', null, { token: member })).body.nav_badges;

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  const signup = await call(
    'POST',
    '/api/platform/signup',
    { slug: TENANT, gym_name: 'Iron Works', admin_name: 'Owner', admin_email: 'owner@iron.test', admin_password: 'ownerpass123' },
    { tenant: null },
  );
  assert.equal(signup.status, 201);
  staff = (await call('POST', '/api/auth/login', { email: 'owner@iron.test', password: 'ownerpass123' })).body.token;
  ops = (await call('POST', '/api/platform/admin/login', { email: 'ops@gymbook.test', password: 'operator-pass-123' }, { tenant: null }))
    .body.token;
  const created = await call('POST', '/api/members', { first_name: 'Asha', last_name: 'K', phone: '9990001111' }, { token: staff });
  assert.equal(created.status, 201);
  member = await signInMember(call, { staffToken: staff, memberId: created.body.id });
});

after(() => {
  server?.close();
  closeDb();
  closeRegistryDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('menu badges', () => {
  it('starts with none', async () => {
    const res = await opsCall('GET', '/nav-badges');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.items, []);
    assert.ok(res.body.tabs.includes('store') && res.body.tabs.includes('diet'));
    assert.deepEqual(await memberBadges(), {});
  });

  it('is closed to a gym admin token', async () => {
    assert.equal((await call('GET', '/api/platform/admin/nav-badges', null, { token: staff, tenant: null })).status, 403);
    assert.equal((await call('PUT', '/api/platform/admin/nav-badges/store', { label: 'Offer' }, { token: staff, tenant: null })).status, 403);
  });

  it('pins a badge that members see', async () => {
    const res = await opsCall('PUT', '/nav-badges/store', { label: 'Offer', tone: 'red' });
    assert.equal(res.status, 200);
    assert.equal(res.body.items.length, 1);
    const badges = await memberBadges();
    assert.equal(badges.store.label, 'Offer');
    assert.equal(badges.store.tone, 'red');
    assert.equal(badges.store.hide_when_seen, false);
    assert.ok(badges.store.version);
  });

  it('replaces the badge on a tab rather than stacking a second', async () => {
    await opsCall('PUT', '/nav-badges/store', { label: 'Sale', tone: 'green' });
    const res = await opsCall('PUT', '/nav-badges/diet', { label: 'New', hide_when_seen: true });
    assert.equal(res.body.items.length, 2);
    const badges = await memberBadges();
    assert.equal(badges.store.label, 'Sale');
    assert.deepEqual([badges.diet.label, badges.diet.tone, badges.diet.hide_when_seen], ['New', 'brand', true]);
  });

  it('drops a badge from the app after its last day', async () => {
    await opsCall('PUT', '/nav-badges/workout', { label: 'Hot', expires_on: '2020-01-01' });
    await opsCall('PUT', '/nav-badges/home', { label: 'New', expires_on: '2999-12-31' });
    const badges = await memberBadges();
    assert.equal(badges.workout, undefined);
    assert.equal(badges.home.label, 'New');
    // Still listed for the operator, who sees it as ended.
    assert.ok((await opsCall('GET', '/nav-badges')).body.items.some((b) => b.tab_key === 'workout'));
  });

  it('rejects an unknown tab, a missing or long label and an unknown colour', async () => {
    assert.equal((await opsCall('PUT', '/nav-badges/nowhere', { label: 'New' })).status, 404);
    assert.equal((await opsCall('PUT', '/nav-badges/store', { label: '' })).status, 400);
    assert.equal((await opsCall('PUT', '/nav-badges/store', { label: 'Way too long!' })).status, 400);
    assert.equal((await opsCall('PUT', '/nav-badges/store', { label: 'New', tone: 'pink' })).status, 400);
  });

  it('turns a badge into an uploaded sticker image, served publicly', async () => {
    // A 1x1 transparent PNG.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    );
    const upload = async (tab, bytes) =>
      fetch(`${base}/api/platform/admin/nav-badges/${tab}/image`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${ops}`, 'Content-Type': 'image/png' },
        body: bytes,
      });

    // No badge on Profile yet, so there is nothing to attach an image to.
    assert.equal((await upload('profile', png)).status, 404);
    assert.equal((await upload('store', Buffer.from('not an image'))).status, 400);

    const res = await upload('store', png);
    assert.equal(res.status, 200);
    const store = (await res.json()).items.find((b) => b.tab_key === 'store');
    assert.match(store.image_url, /^\/api\/store-media\/nbstore-[a-f0-9]{10}\.png$/);
    assert.equal(store.label, 'Sale');

    const badges = await memberBadges();
    assert.match(badges.store.image_url, /nbstore-/);
    const served = await fetch(`${base}${store.image_url}`);
    assert.equal(served.status, 200);
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), png);

    // Back to a text pill: the image goes, and so does its file.
    const cleared = await opsCall('DELETE', '/nav-badges/store/image');
    assert.equal(cleared.body.items.find((b) => b.tab_key === 'store').image_url, null);
    assert.equal((await fetch(`${base}${store.image_url}`)).status, 404);
  });

  it('removes a badge', async () => {
    const res = await opsCall('DELETE', '/nav-badges/store');
    assert.equal(res.status, 200);
    assert.equal((await memberBadges()).store, undefined);
  });
});
