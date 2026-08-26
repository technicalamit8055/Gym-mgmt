import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-portal-test-'));
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

describe('member self-service portal', () => {
  let staffToken;
  let memberId;
  let memberCode;
  let planId;
  let classId;

  it('sets up a gym, a member, a plan and a subscription', async () => {
    await call('POST', '/api/platform/signup', {
      slug: 'portalgym',
      gym_name: 'Portal Gym',
      admin_name: 'Owner',
      admin_email: 'owner@portalgym.test',
      admin_password: 'ownerpass123',
    });
    staffToken = (
      await call(
        'POST',
        '/api/auth/login',
        { email: 'owner@portalgym.test', password: 'ownerpass123' },
        { tenant: 'portalgym' },
      )
    ).body.token;

    const member = await call(
      'POST',
      '/api/members',
      { first_name: 'Rahul', last_name: 'Verma', phone: '9876543210' },
      { token: staffToken, tenant: 'portalgym' },
    );
    assert.equal(member.status, 201);
    memberId = member.body.id;
    memberCode = member.body.code;

    const plan = await call(
      'POST',
      '/api/plans',
      { name: 'Portal Monthly', price: 1000, duration_days: 30 },
      { token: staffToken, tenant: 'portalgym' },
    );
    planId = plan.body.id;

    const sub = await call(
      'POST',
      '/api/subscriptions',
      { member_id: memberId, plan_id: planId },
      { token: staffToken, tenant: 'portalgym' },
    );
    assert.equal(sub.status, 201);

    const klass = await call(
      'POST',
      '/api/classes',
      { name: 'Morning Yoga', weekday: new Date().getUTCDay(), start_time: '07:00', capacity: 2 },
      { token: staffToken, tenant: 'portalgym' },
    );
    assert.equal(klass.status, 201);
    classId = klass.body.id;
  });

  it('rejects login with the wrong bootstrap PIN', async () => {
    const res = await call(
      'POST',
      '/api/portal/login',
      { identifier: memberCode, pin: '0000' },
      { tenant: 'portalgym' },
    );
    assert.equal(res.status, 401);
  });

  let memberToken;

  it('logs in with the member code and the bootstrap PIN (last 4 digits of phone)', async () => {
    const res = await call(
      'POST',
      '/api/portal/login',
      { identifier: memberCode, pin: '3210' },
      { tenant: 'portalgym' },
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.must_set_pin, true);
    assert.equal(res.body.member.id, memberId);
    memberToken = res.body.token;
  });

  it('also logs in by phone number', async () => {
    const res = await call(
      'POST',
      '/api/portal/login',
      { identifier: '9876543210', pin: '3210' },
      { tenant: 'portalgym' },
    );
    assert.equal(res.status, 200);
  });

  it('rejects a member token on the staff API', async () => {
    const res = await call('GET', '/api/members', null, { token: memberToken, tenant: 'portalgym' });
    assert.equal(res.status, 401);
  });

  it('rejects a staff token on the portal API', async () => {
    const res = await call('GET', '/api/portal/me', null, { token: staffToken, tenant: 'portalgym' });
    assert.equal(res.status, 401);
  });

  it('rejects setting a new PIN with the wrong current PIN', async () => {
    const res = await call(
      'POST',
      '/api/portal/pin',
      { current_pin: '1111', new_pin: '4321' },
      { token: memberToken, tenant: 'portalgym' },
    );
    assert.equal(res.status, 400);
  });

  it('sets a custom PIN using the bootstrap PIN as proof of identity', async () => {
    const res = await call(
      'POST',
      '/api/portal/pin',
      { current_pin: '3210', new_pin: '4321' },
      { token: memberToken, tenant: 'portalgym' },
    );
    assert.equal(res.status, 200);
  });

  it('no longer accepts the bootstrap PIN once a custom PIN is set', async () => {
    const res = await call(
      'POST',
      '/api/portal/login',
      { identifier: memberCode, pin: '3210' },
      { tenant: 'portalgym' },
    );
    assert.equal(res.status, 401);
  });

  it('logs in with the new custom PIN', async () => {
    const res = await call(
      'POST',
      '/api/portal/login',
      { identifier: memberCode, pin: '4321' },
      { tenant: 'portalgym' },
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.must_set_pin, false);
    memberToken = res.body.token;
  });

  it('returns the member summary with the active plan and stats', async () => {
    const res = await call('GET', '/api/portal/me', null, { token: memberToken, tenant: 'portalgym' });
    assert.equal(res.status, 200);
    assert.equal(res.body.member.id, memberId);
    assert.equal(res.body.subscription.plan_name, 'Portal Monthly');
    assert.equal(res.body.days_left, 29);
    assert.ok(res.body.stats);
    assert.equal(res.body.vertical, 'gym');
    // No payment recorded yet against this subscription — paid/due must reflect
    // that (a plain SELECT with no payments join would leave both undefined,
    // which the front end's `sub.due > 0` check would then silently treat as
    // "nothing owed" no matter what the plan actually costs).
    assert.equal(res.body.subscription.paid, 0);
    assert.equal(res.body.subscription.due, 1000);
  });

  it('returns a scannable digital pass', async () => {
    const res = await call('GET', '/api/portal/pass', null, { token: memberToken, tenant: 'portalgym' });
    assert.equal(res.status, 200);
    assert.match(res.body.svg, /^<svg/);
    assert.match(res.body.png, /^data:image\/png;base64,/);
    assert.ok(res.body.payload);
  });

  it('lists the week schedule with this member booking status', async () => {
    const res = await call('GET', '/api/portal/classes', null, { token: memberToken, tenant: 'portalgym' });
    assert.equal(res.status, 200);
    const todayClass = res.body.items.find((c) => c.id === classId);
    assert.ok(todayClass);
    assert.equal(todayClass.my_booking_id, null);
  });

  let bookingId;
  let classDate;

  it('books a class for the member', async () => {
    const schedule = await call('GET', '/api/portal/classes', null, { token: memberToken, tenant: 'portalgym' });
    const todayClass = schedule.body.items.find((c) => c.id === classId);
    classDate = todayClass.class_date;

    const res = await call(
      'POST',
      `/api/portal/classes/${classId}/book`,
      { class_date: classDate },
      { token: memberToken, tenant: 'portalgym' },
    );
    assert.equal(res.status, 201);
    bookingId = res.body.id;
  });

  it('shows the booking on the schedule now', async () => {
    const res = await call('GET', '/api/portal/classes', null, { token: memberToken, tenant: 'portalgym' });
    const todayClass = res.body.items.find((c) => c.id === classId);
    assert.equal(todayClass.my_booking_id, bookingId);
    assert.equal(todayClass.booked, 1);
  });

  it('cancels the booking', async () => {
    const res = await call('DELETE', `/api/portal/classes/bookings/${bookingId}`, null, {
      token: memberToken,
      tenant: 'portalgym',
    });
    assert.equal(res.status, 200);

    const schedule = await call('GET', '/api/portal/classes', null, { token: memberToken, tenant: 'portalgym' });
    const todayClass = schedule.body.items.find((c) => c.id === classId);
    assert.equal(todayClass.my_booking_id, null);
    assert.equal(todayClass.booked, 0);
  });

  it('will not cancel another member booking', async () => {
    const other = await call(
      'POST',
      '/api/members',
      { first_name: 'Other', phone: '9998887771' },
      { token: staffToken, tenant: 'portalgym' },
    );
    const otherLogin = await call(
      'POST',
      '/api/portal/login',
      { identifier: other.body.code, pin: '7771' },
      { tenant: 'portalgym' },
    );
    const rebook = await call(
      'POST',
      `/api/portal/classes/${classId}/book`,
      { class_date: classDate },
      { token: memberToken, tenant: 'portalgym' },
    );
    assert.equal(rebook.status, 201);

    const res = await call('DELETE', `/api/portal/classes/bookings/${rebook.body.id}`, null, {
      token: otherLogin.body.token,
      tenant: 'portalgym',
    });
    assert.equal(res.status, 404);
  });

  it('lists payments and generates a PDF receipt', async () => {
    const payment = await call(
      'POST',
      '/api/payments',
      { member_id: memberId, amount: 1000, method: 'cash' },
      { token: staffToken, tenant: 'portalgym' },
    );
    assert.equal(payment.status, 201);

    const list = await call('GET', '/api/portal/payments', null, { token: memberToken, tenant: 'portalgym' });
    assert.equal(list.status, 200);
    assert.equal(list.body.items.length, 1);

    const res = await fetch(`${base}/api/portal/payments/${payment.body.id}/receipt`, {
      headers: { Authorization: `Bearer ${memberToken}`, 'X-Tenant-Slug': 'portalgym' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/pdf');
  });

  it('will not serve another member payment receipt', async () => {
    const otherMember = await call(
      'POST',
      '/api/members',
      { first_name: 'ThirdParty', phone: '9112233440' },
      { token: staffToken, tenant: 'portalgym' },
    );
    const otherPayment = await call(
      'POST',
      '/api/payments',
      { member_id: otherMember.body.id, amount: 500, method: 'cash' },
      { token: staffToken, tenant: 'portalgym' },
    );
    const res = await call('GET', `/api/portal/payments/${otherPayment.body.id}/receipt`, null, {
      token: memberToken,
      tenant: 'portalgym',
    });
    assert.equal(res.status, 404);
  });

  it('lists attendance history and available renewal plans', async () => {
    await call('POST', '/api/attendance/check-in', { member_id: memberId }, { token: staffToken, tenant: 'portalgym' });

    const attendance = await call('GET', '/api/portal/attendance', null, { token: memberToken, tenant: 'portalgym' });
    assert.equal(attendance.status, 200);
    assert.equal(attendance.body.items.length, 1);
    assert.equal(attendance.body.streak_days, 1);

    const plans = await call('GET', '/api/portal/plans', null, { token: memberToken, tenant: 'portalgym' });
    assert.equal(plans.status, 200);
    assert.ok(plans.body.items.some((p) => p.id === planId));
  });

  it("will not resolve one gym's member token against another gym", async () => {
    await call('POST', '/api/platform/signup', {
      slug: 'portalgym2',
      gym_name: 'Portal Gym Two',
      admin_name: 'Owner Two',
      admin_email: 'owner@portalgym2.test',
      admin_password: 'ownerpass123',
    });
    const res = await call('GET', '/api/portal/me', null, { token: memberToken, tenant: 'portalgym2' });
    assert.equal(res.status, 401);
  });
});
