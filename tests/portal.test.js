import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { memberToken as signInMember } from './helpers/memberAuth.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-portal-test-'));
process.env.DB_FILE = path.join(tmpDir, 'default.db');
process.env.PLATFORM_DB_FILE = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.AUTH_SECRET = 'test-secret';
process.env.MAIL_TRANSPORT = 'memory';

const { createApp } = await import('../src/app.js');
const { closeDb, run, tenantStorage } = await import('../src/db.js');
const { closeRegistryDb, tenantDbPath } = await import('../src/tenants.js');
const { outbox } = await import('../src/mailer.js');
const { sentInMemory } = await import('../src/whatsapp.js');

const inGym = (fn) =>
  tenantStorage.run({ slug: 'portalgym', dbFile: tenantDbPath('portalgym'), timezone: 'UTC', businessType: 'gym' }, fn);

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

  it('tells a member with no password yet to set one up, rather than "wrong password"', async () => {
    const res = await call('POST', '/api/portal/login', { identifier: memberCode, password: '3210' }, { tenant: 'portalgym' });
    assert.equal(res.status, 401);
    assert.equal(res.body.details.reason, 'no_password');
  });

  it('no longer accepts the old last-4-digits-of-phone PIN', async () => {
    const res = await call('POST', '/api/portal/login', { identifier: '9876543210', password: '3210' }, { tenant: 'portalgym' });
    assert.equal(res.status, 401);
  });

  it('never sends a password hash to staff or the member', async () => {
    const res = await call('GET', `/api/members/${memberId}`, null, { token: staffToken, tenant: 'portalgym' });
    assert.equal(res.body.portal_access, 'none');
    assert.ok(!('portal_password_hash' in res.body) && !('portal_pin_hash' in res.body));
  });

  let memberToken;
  let tempPassword;

  it('lets the desk issue a temporary password, shown once', async () => {
    const res = await call('POST', `/api/members/${memberId}/app-login`, { deliver: 'show' }, { token: staffToken, tenant: 'portalgym' });
    assert.equal(res.status, 200);
    assert.match(res.body.password, /^[a-z]+\d{4}$/, 'a word and four digits, like tiger4821');
    assert.equal(res.body.member.portal_access, 'temporary');
    tempPassword = res.body.password;
  });

  it('will not send a WhatsApp login while WhatsApp is not linked', async () => {
    const res = await call('POST', `/api/members/${memberId}/app-login`, { deliver: 'whatsapp' }, { token: staffToken, tenant: 'portalgym' });
    assert.equal(res.status, 400);
    // The failed send left the temporary password from the desk working.
    const login = await call('POST', '/api/portal/login', { identifier: memberCode, password: tempPassword }, { tenant: 'portalgym' });
    assert.equal(login.status, 200);
  });

  it('signs in with the temporary password and asks for a new one', async () => {
    const res = await call('POST', '/api/portal/login', { identifier: memberCode, password: tempPassword }, { tenant: 'portalgym' });
    assert.equal(res.status, 200);
    assert.equal(res.body.must_change_password, true);
    assert.equal(res.body.member.id, memberId);
    memberToken = res.body.token;
  });

  it('rejects a wrong password', async () => {
    const res = await call('POST', '/api/portal/login', { identifier: memberCode, password: 'nope-nope' }, { tenant: 'portalgym' });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'Incorrect password');
  });

  it('rejects a member token on the staff API', async () => {
    const res = await call('GET', '/api/members', null, { token: memberToken, tenant: 'portalgym' });
    assert.equal(res.status, 401);
  });

  it('rejects a staff token on the portal API', async () => {
    const res = await call('GET', '/api/portal/me', null, { token: staffToken, tenant: 'portalgym' });
    assert.equal(res.status, 401);
  });

  it('rejects a weak new password, or a wrong current one', async () => {
    const weak = async (new_password) =>
      call('POST', '/api/portal/password', { current_password: tempPassword, new_password }, { token: memberToken, tenant: 'portalgym' });
    assert.equal((await weak('short')).status, 400);
    assert.equal((await weak(memberCode)).status, 400);
    assert.equal((await weak('9876543210')).status, 400);
    const wrong = await call(
      'POST',
      '/api/portal/password',
      { current_password: 'not-it-at-all', new_password: 'strong-pass-1' },
      { token: memberToken, tenant: 'portalgym' },
    );
    assert.equal(wrong.status, 400);
  });

  it('replaces the temporary password, keeping this device signed in', async () => {
    const other = (await call('POST', '/api/portal/login', { identifier: memberCode, password: tempPassword }, { tenant: 'portalgym' })).body.token;
    const res = await call(
      'POST',
      '/api/portal/password',
      { current_password: tempPassword, new_password: 'strong-pass-1' },
      { token: memberToken, tenant: 'portalgym' },
    );
    assert.equal(res.status, 200);
    assert.equal((await call('GET', '/api/portal/me', null, { token: memberToken, tenant: 'portalgym' })).status, 200);
    assert.equal((await call('GET', '/api/portal/me', null, { token: other, tenant: 'portalgym' })).status, 401, 'other devices are signed out');
  });

  it('signs in by member code or phone with the new password, no longer temporary', async () => {
    const byCode = await call('POST', '/api/portal/login', { identifier: memberCode, password: 'strong-pass-1' }, { tenant: 'portalgym' });
    assert.equal(byCode.status, 200);
    assert.equal(byCode.body.must_change_password, false);
    const byPhone = await call('POST', '/api/portal/login', { identifier: '9876543210', password: 'strong-pass-1' }, { tenant: 'portalgym' });
    assert.equal(byPhone.status, 200);
    assert.equal(
      (await call('POST', '/api/portal/login', { identifier: memberCode, password: tempPassword }, { tenant: 'portalgym' })).status,
      401,
    );
    memberToken = byCode.body.token;
  });

  it('says so when there is no email to send a setup code to', async () => {
    const res = await call('POST', '/api/portal/password/forgot', { identifier: memberCode }, { tenant: 'portalgym' });
    assert.equal(res.status, 400);
    assert.equal(res.body.details.reason, 'no_email');
  });

  it('resets a forgotten password with an emailed code', async () => {
    await call('PATCH', `/api/members/${memberId}`, { email: 'rahul@example.test' }, { token: staffToken, tenant: 'portalgym' });

    const sent = await call('POST', '/api/portal/password/forgot', { identifier: '9876543210' }, { tenant: 'portalgym' });
    assert.equal(sent.status, 200);
    assert.equal(sent.body.email_hint, 'ra•••@example.test');
    const mail = outbox.at(-1);
    assert.equal(mail.to, 'rahul@example.test');
    assert.equal(mail.from.name, 'Portal Gym');
    const code = mail.subject.match(/^(\d{6}) /)[1];
    assert.ok(mail.text.includes(code));

    const again = await call('POST', '/api/portal/password/forgot', { identifier: memberCode }, { tenant: 'portalgym' });
    assert.equal(again.status, 429, 'one code a minute');

    const wrongCode = code === '000000' ? '111111' : '000000';
    const bad = await call(
      'POST',
      '/api/portal/password/reset',
      { identifier: memberCode, code: wrongCode, new_password: 'brand-new-pass' },
      { tenant: 'portalgym' },
    );
    assert.equal(bad.status, 400);

    const reset = await call(
      'POST',
      '/api/portal/password/reset',
      { identifier: memberCode, code, new_password: 'brand-new-pass' },
      { tenant: 'portalgym' },
    );
    assert.equal(reset.status, 200);
    assert.ok(reset.body.token, 'a reset signs the member straight in');
    assert.equal(reset.body.must_change_password, false);

    const reused = await call(
      'POST',
      '/api/portal/password/reset',
      { identifier: memberCode, code, new_password: 'another-pass-1' },
      { tenant: 'portalgym' },
    );
    assert.equal(reused.status, 400, 'a code works once');
    assert.equal((await call('GET', '/api/portal/me', null, { token: memberToken, tenant: 'portalgym' })).status, 401, 'old sessions end');
    memberToken = reset.body.token;
  });

  it('burns a setup code after five wrong guesses', async () => {
    const other = await call('POST', '/api/members', { first_name: 'Guess', phone: '9000000005', email: 'guess@example.test' }, { token: staffToken, tenant: 'portalgym' });
    assert.equal((await call('POST', '/api/portal/password/forgot', { identifier: other.body.code }, { tenant: 'portalgym' })).status, 200);
    const code = outbox.at(-1).subject.slice(0, 6);
    const wrongCode = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i += 1) {
      await call('POST', '/api/portal/password/reset', { identifier: other.body.code, code: wrongCode, new_password: 'brand-new-pass' }, { tenant: 'portalgym' });
    }
    const late = await call('POST', '/api/portal/password/reset', { identifier: other.body.code, code, new_password: 'brand-new-pass' }, { tenant: 'portalgym' });
    assert.equal(late.status, 400, 'even the right code is dead now');
  });

  it('will not offer a WhatsApp reset while the gym has no WhatsApp linked, or the member no phone', async () => {
    const off = await call('POST', '/api/portal/password/whatsapp', { identifier: memberCode }, { tenant: 'portalgym' });
    assert.equal(off.status, 400);
    assert.equal(off.body.details.reason, 'whatsapp_unavailable');

    const noPhone = await call('POST', '/api/members', { first_name: 'Nophone' }, { token: staffToken, tenant: 'portalgym' });
    const res = await call('POST', '/api/portal/password/whatsapp', { identifier: noPhone.body.code }, { tenant: 'portalgym' });
    assert.equal(res.status, 400);
    assert.equal(res.body.details.reason, 'no_phone');
  });

  it('sends a forgotten login on WhatsApp once a day, without locking the member out', async () => {
    process.env.WHATSAPP_TRANSPORT = 'memory';
    try {
      const sent = await call('POST', '/api/portal/password/whatsapp', { identifier: '9876543210' }, { tenant: 'portalgym' });
      assert.equal(sent.status, 200);
      assert.equal(sent.body.phone_hint, '••••••3210');

      const message = sentInMemory.at(-1);
      assert.equal(message.phone, '9876543210');
      assert.ok(message.message.includes(memberCode) && message.message.includes('/#/portal'));
      const waPassword = message.message.match(/Password: (\S+)/)[1];

      const logs = await call('GET', '/api/whatsapp/logs', null, { token: staffToken, tenant: 'portalgym' });
      assert.ok(!logs.body.items[0].message.includes(waPassword), 'the delivery log masks the password');

      // Asking doesn't change anything until the new password is used.
      const stillMine = await call('POST', '/api/portal/login', { identifier: memberCode, password: 'brand-new-pass' }, { tenant: 'portalgym' });
      assert.equal(stillMine.status, 200);

      const again = await call('POST', '/api/portal/password/whatsapp', { identifier: memberCode }, { tenant: 'portalgym' });
      assert.equal(again.status, 429);
      assert.equal(again.body.details.reason, 'cooldown');
      assert.match(again.body.error, /in 2[34] hours/);
      assert.equal(sentInMemory.filter((m) => m.phone === '9876543210').length, 1, 'only one message went out');

      const viaWhatsApp = await call('POST', '/api/portal/login', { identifier: memberCode, password: waPassword }, { tenant: 'portalgym' });
      assert.equal(viaWhatsApp.status, 200);
      assert.equal(viaWhatsApp.body.must_change_password, true, 'they pick their own straight away');
      const old = await call('POST', '/api/portal/login', { identifier: memberCode, password: 'brand-new-pass' }, { tenant: 'portalgym' });
      assert.equal(old.status, 401, 'using the WhatsApp password replaces the old one');
      memberToken = viaWhatsApp.body.token;
    } finally {
      delete process.env.WHATSAPP_TRANSPORT;
    }
  });

  it('keeps the WhatsApp password working past a day, until a new one replaces it', async () => {
    process.env.WHATSAPP_TRANSPORT = 'memory';
    try {
      const other = await call('POST', '/api/members', { first_name: 'Late', phone: '9000000006' }, { token: staffToken, tenant: 'portalgym' });
      const ask = () => call('POST', '/api/portal/password/whatsapp', { identifier: other.body.code }, { tenant: 'portalgym' });
      const signIn = (password) => call('POST', '/api/portal/login', { identifier: other.body.code, password }, { tenant: 'portalgym' });
      assert.equal((await ask()).status, 200);
      const first = sentInMemory.at(-1).message.match(/Password: (\S+)/)[1];
      assert.match(first, /^[a-z]+\d{4}$/);

      // Two days on, the password still works, and they may ask again.
      inGym(() => run("UPDATE members SET portal_reset_sent_at = datetime('now', '-2 days') WHERE id = ?", [other.body.id]));
      assert.equal((await ask()).status, 200);
      const second = sentInMemory.at(-1).message.match(/Password: (\S+)/)[1];
      if (second !== first) assert.equal((await signIn(first)).status, 401, 'the new one replaces the old one');
      assert.equal((await signIn(second)).status, 200);
    } finally {
      delete process.env.WHATSAPP_TRANSPORT;
    }
  });

  it('limits issuing logins to admins and managers', async () => {
    await call('POST', '/api/staff', { name: 'Desk', email: 'desk@portalgym.test', password: 'deskpass123', role: 'staff' }, { token: staffToken, tenant: 'portalgym' });
    const desk = (await call('POST', '/api/auth/login', { email: 'desk@portalgym.test', password: 'deskpass123' }, { tenant: 'portalgym' })).body.token;
    const res = await call('POST', `/api/members/${memberId}/app-login`, { deliver: 'show' }, { token: desk, tenant: 'portalgym' });
    assert.equal(res.status, 403);
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

  it('lets the member edit their own contact details, but not their name or phone', async () => {
    const res = await call(
      'PATCH',
      '/api/portal/me',
      { email: 'rahul@portalgym.test', emergency_contact: 'Asha Verma', first_name: 'Hacked', phone: '0000000000' },
      { token: memberToken, tenant: 'portalgym' },
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.email, 'rahul@portalgym.test');
    assert.equal(res.body.emergency_contact, 'Asha Verma');
    assert.equal(res.body.first_name, 'Rahul');
    assert.equal(res.body.phone, '9876543210');

    const bad = await call('PATCH', '/api/portal/me', { email: 'not-an-email' }, { token: memberToken, tenant: 'portalgym' });
    assert.equal(bad.status, 400);
  });

  it('lets the member set and then remove their own photo', async () => {
    const jpeg =
      'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=';
    const set = await call('PUT', '/api/portal/photo', { photo: jpeg }, { token: memberToken, tenant: 'portalgym' });
    assert.equal(set.status, 200);
    assert.ok(set.body.photo_url);

    const svg = `data:image/svg+xml;base64,${Buffer.from('<svg onload="alert(1)"></svg>').toString('base64')}`;
    const rejected = await call('PUT', '/api/portal/photo', { photo: svg }, { token: memberToken, tenant: 'portalgym' });
    assert.equal(rejected.status, 400);

    const cleared = await call('PUT', '/api/portal/photo', { photo: '' }, { token: memberToken, tenant: 'portalgym' });
    assert.equal(cleared.status, 200);
    assert.ok(!cleared.body.photo_url);
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
    const otherToken = await signInMember(call, { staffToken, memberId: other.body.id, tenant: 'portalgym' });
    const rebook = await call(
      'POST',
      `/api/portal/classes/${classId}/book`,
      { class_date: classDate },
      { token: memberToken, tenant: 'portalgym' },
    );
    assert.equal(rebook.status, 201);

    const res = await call('DELETE', `/api/portal/classes/bookings/${rebook.body.id}`, null, {
      token: otherToken,
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
