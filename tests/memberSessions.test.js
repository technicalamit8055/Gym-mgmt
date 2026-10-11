import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { giveMemberPassword } from './helpers/memberAuth.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-sessions-test-'));
process.env.DB_FILE = path.join(tmpDir, 'default.db');
process.env.PLATFORM_DB_FILE = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.AUTH_SECRET = 'test-secret';

const { createApp } = await import('../src/app.js');
const { closeDb, get, run, tenantStorage } = await import('../src/db.js');
const { closeRegistryDb, tenantDbPath } = await import('../src/tenants.js');

let base;
let server;

const call = async (method, urlPath, body, { token, tenant = 'sessgym', ua } = {}) => {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(tenant ? { 'X-Tenant-Slug': tenant } : {}),
      ...(ua ? { 'User-Agent': ua } : {}),
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

const PHONE = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const LAPTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 Edg/129.0';

const sidOf = (token) => JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8')).sid;

const inGym = (fn) =>
  tenantStorage.run({ slug: 'sessgym', dbFile: tenantDbPath('sessgym'), timezone: 'UTC', businessType: 'gym' }, fn);

describe('member devices', () => {
  let code;
  let otherCode;
  let memberId;
  const signIn = async (ua, identifier = code, password = 'member-pass-123') =>
    (await call('POST', '/api/portal/login', { identifier, password }, { ua })).body.token;

  it('sets up a gym with two members', async () => {
    await call('POST', '/api/platform/signup', {
      slug: 'sessgym',
      gym_name: 'Session Gym',
      admin_name: 'Owner',
      admin_email: 'owner@sessgym.test',
      admin_password: 'ownerpass123',
    }, { tenant: null });
    const staffToken = (await call('POST', '/api/auth/login', { email: 'owner@sessgym.test', password: 'ownerpass123' })).body.token;
    const member = await call('POST', '/api/members', { first_name: 'Rahul', phone: '9876543210' }, { token: staffToken });
    const other = await call('POST', '/api/members', { first_name: 'Priya', phone: '9123456789' }, { token: staffToken });
    code = member.body.code;
    otherCode = other.body.code;
    memberId = member.body.id;
    await giveMemberPassword(call, { staffToken, memberId });
    await giveMemberPassword(call, { staffToken, memberId: other.body.id, password: 'other-pass-123' });
  });

  it('lists every sign-in with a readable device name, this one first', async () => {
    const phone = await signIn(PHONE);
    await signIn(LAPTOP);
    const res = await call('GET', '/api/portal/sessions', undefined, { token: phone });
    assert.equal(res.status, 200);
    assert.equal(res.body.sessions.length, 2);
    const [first, second] = res.body.sessions;
    assert.equal(first.current, true);
    assert.equal(first.device, 'Chrome on Android');
    assert.equal(first.mobile, true);
    assert.equal(second.current, false);
    assert.equal(second.device, 'Edge on Windows');
    assert.equal(second.mobile, false);
  });

  it("never shows or signs out another member's devices", async () => {
    const theirs = await signIn(PHONE, otherCode, 'other-pass-123');
    const mine = await signIn(IPHONE);
    const theirList = (await call('GET', '/api/portal/sessions', undefined, { token: theirs })).body.sessions;
    assert.equal(theirList.length, 1);
    assert.equal((await call('DELETE', `/api/portal/sessions/${theirList[0].id}`, undefined, { token: mine })).status, 404);
    assert.equal((await call('GET', '/api/portal/me', undefined, { token: theirs })).status, 200);
  });

  it('signs a lost phone out from another device, and stops its reminders', async () => {
    const lost = await signIn(IPHONE);
    const here = await signIn(LAPTOP);
    await call('POST', '/api/portal/notifications/subscriptions', {
      endpoint: 'https://push.example.test/send/lost-phone',
      keys: { p256dh: Buffer.alloc(65, 4).toString('base64url'), auth: Buffer.alloc(16, 1).toString('base64url') },
      platform: 'ios',
    }, { token: lost });
    assert.equal(inGym(() => get("SELECT COUNT(*) AS n FROM push_subscriptions WHERE endpoint LIKE '%lost-phone'")).n, 1);

    const list = (await call('GET', '/api/portal/sessions', undefined, { token: here })).body.sessions;
    const target = list.find((s) => s.id === sidOf(lost));
    assert.equal(target.device, 'Safari on iPhone');
    assert.equal(target.current, false);
    const res = await call('DELETE', `/api/portal/sessions/${target.id}`, undefined, { token: here });
    assert.equal(res.status, 200);

    const locked = await call('GET', '/api/portal/me', undefined, { token: lost });
    assert.equal(locked.status, 401);
    assert.equal(inGym(() => get("SELECT COUNT(*) AS n FROM push_subscriptions WHERE endpoint LIKE '%lost-phone'")).n, 0);
    assert.equal((await call('GET', '/api/portal/me', undefined, { token: here })).status, 200);
  });

  it('signs out every other device but keeps this one', async () => {
    const a = await signIn(PHONE);
    const b = await signIn(IPHONE);
    const here = await signIn(LAPTOP);
    // A phone registered for push before sign-ins were recorded has no session.
    inGym(() =>
      run(
        `INSERT INTO push_subscriptions (member_id, endpoint, p256dh, auth) VALUES (?, 'https://push.example.test/send/old', 'x', 'y')`,
        [memberId],
      ),
    );
    const res = await call('POST', '/api/portal/sessions/sign-out-others', {}, { token: here });
    assert.equal(res.status, 200);
    assert.ok(res.body.signed_out >= 2);
    assert.equal((await call('GET', '/api/portal/me', undefined, { token: a })).status, 401);
    assert.equal((await call('GET', '/api/portal/me', undefined, { token: b })).status, 401);
    const left = (await call('GET', '/api/portal/sessions', undefined, { token: here })).body.sessions;
    assert.deepEqual(left.map((s) => s.current), [true]);
    assert.equal(inGym(() => get('SELECT COUNT(*) AS n FROM push_subscriptions WHERE member_id = ?', [memberId])).n, 0);
  });

  it("signing out here ends this device's session on the server", async () => {
    const here = await signIn(PHONE);
    const res = await call('DELETE', '/api/portal/sessions/current', undefined, { token: here });
    assert.equal(res.status, 200);
    assert.equal(res.body.current, true);
    assert.equal((await call('GET', '/api/portal/me', undefined, { token: here })).status, 401);
  });

  it('turns away a token from before sessions were recorded', async () => {
    // Same signing key and shape as an old member token, minus `sid`.
    const crypto = await import('node:crypto');
    const payload = Buffer.from(
      JSON.stringify({ scope: 'member', sub: memberId, member_id: memberId, code, tenant: 'sessgym', exp: Math.floor(Date.now() / 1000) + 3600 }),
    ).toString('base64url');
    const sig = crypto.createHmac('sha256', 'test-secret').update(payload).digest('base64url');
    assert.equal((await call('GET', '/api/portal/me', undefined, { token: `${payload}.${sig}` })).status, 401);
  });
});
