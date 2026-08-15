import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-test-'));
process.env.DB_FILE = path.join(tmpDir, 'test.db');
process.env.AUTH_SECRET = 'test-secret';
process.env.ADMIN_EMAIL = 'owner@test.local';
process.env.ADMIN_PASSWORD = 'ownerpass123';

const { createApp } = await import('../src/app.js');
const { ensureAdminAccount } = await import('../src/bootstrap.js');
const { closeDb } = await import('../src/db.js');
const { addDays, today } = await import('../src/validate.js');

let base;
let server;
let token;

const call = async (method, path, body, useToken = token) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(useToken ? { Authorization: `Bearer ${useToken}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

before(async () => {
  ensureAdminAccount();
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  const login = await call('POST', '/api/auth/login', {
    email: 'owner@test.local',
    password: 'ownerpass123',
  });
  assert.equal(login.status, 200);
  token = login.body.token;
});

after(() => {
  server.close();
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('authentication', () => {
  it('rejects a wrong password', async () => {
    const res = await call('POST', '/api/auth/login', { email: 'owner@test.local', password: 'nope' });
    assert.equal(res.status, 401);
  });

  it('requires a token on protected routes', async () => {
    const res = await call('GET', '/api/members', undefined, null);
    assert.equal(res.status, 401);
  });

  it('rejects a tampered token', async () => {
    const res = await call('GET', '/api/members', undefined, `${token}x`);
    assert.equal(res.status, 401);
  });

  it('returns the signed-in user', async () => {
    const res = await call('GET', '/api/auth/me');
    assert.equal(res.body.user.email, 'owner@test.local');
    assert.equal(res.body.user.role, 'admin');
  });
});

describe('members', () => {
  it('validates required fields', async () => {
    const res = await call('POST', '/api/members', { last_name: 'Solo' });
    assert.equal(res.status, 400);
    assert.equal(res.body.details.first_name, 'is required');
  });

  it('creates a member with a generated code', async () => {
    const res = await call('POST', '/api/members', {
      first_name: 'Asha',
      last_name: 'Menon',
      email: 'asha@test.local',
      phone: '9990001111',
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.code, 'GM0001');
    assert.equal(res.body.balance_due, 0);
  });

  it('refuses a duplicate email', async () => {
    const res = await call('POST', '/api/members', { first_name: 'Copy', email: 'asha@test.local' });
    assert.equal(res.status, 409);
  });

  it('finds members by search term', async () => {
    const res = await call('GET', '/api/members?q=menon');
    assert.equal(res.body.total, 1);
    assert.equal(res.body.items[0].first_name, 'Asha');
  });

  it('updates a member', async () => {
    const res = await call('PATCH', '/api/members/1', { phone: '8887776666', status: 'active' });
    assert.equal(res.body.phone, '8887776666');
  });
});

describe('plans and memberships', () => {
  it('creates a plan', async () => {
    const res = await call('POST', '/api/plans', { name: 'Monthly', price: 1500, duration_days: 30 });
    assert.equal(res.status, 201);
    assert.equal(res.body.id, 1);
  });

  it('sells a membership and derives the end date', async () => {
    const res = await call('POST', '/api/subscriptions', {
      member_id: 1,
      plan_id: 1,
      start_date: today(),
      payment_amount: 1000,
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.end_date, addDays(today(), 29));
    assert.equal(res.body.paid, 1000);
    assert.equal(res.body.due, 500);
  });

  it('blocks an overlapping membership', async () => {
    const res = await call('POST', '/api/subscriptions', { member_id: 1, plan_id: 1, start_date: today() });
    assert.equal(res.status, 409);
  });

  it('starts a renewal the day after the current one ends', async () => {
    const res = await call('POST', '/api/subscriptions', { member_id: 1, plan_id: 1 });
    assert.equal(res.status, 201);
    assert.equal(res.body.start_date, addDays(today(), 30));
  });

  it('shows the outstanding balance on the member record', async () => {
    const res = await call('GET', '/api/members/1');
    // Two memberships at 1500 with a single 1000 payment recorded.
    assert.equal(res.body.balance_due, 2000);
  });

  it('records a payment and clears the balance', async () => {
    const created = await call('POST', '/api/payments', { member_id: 1, amount: 2000, method: 'upi' });
    assert.equal(created.status, 201);
    const member = await call('GET', '/api/members/1');
    assert.equal(member.body.balance_due, 0);
  });

  it('rejects a payment against another member\'s membership', async () => {
    await call('POST', '/api/members', { first_name: 'Other', last_name: 'Person' });
    const res = await call('POST', '/api/payments', { member_id: 2, amount: 100, subscription_id: 1 });
    assert.equal(res.status, 400);
  });
});

describe('check-in', () => {
  it('checks a member in by code and reports the membership', async () => {
    const res = await call('POST', '/api/attendance/check-in', { code: 'GM0001' });
    assert.equal(res.status, 201);
    assert.equal(res.body.action, 'checked_in');
    assert.equal(res.body.membership.end_date, addDays(today(), 29));
  });

  it('toggles to checked-out on a rescan the same day', async () => {
    const res = await call('POST', '/api/attendance/check-in', { code: 'gm0001' });
    assert.equal(res.status, 200);
    assert.equal(res.body.action, 'checked_out');
    assert.ok(res.body.visit.check_out);
  });

  it('starts a fresh visit on a further scan', async () => {
    const res = await call('POST', '/api/attendance/check-in', { code: 'GM0001' });
    assert.equal(res.status, 201);
    assert.equal(res.body.action, 'checked_in');
  });

  it('refuses a member with no active membership', async () => {
    const res = await call('POST', '/api/attendance/check-in', { member_id: 2 });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /no active membership/);
  });

  it('checks out an open visit via the explicit endpoint', async () => {
    const res = await call('POST', '/api/attendance/check-out', { member_id: 1 });
    assert.equal(res.status, 200);
    assert.ok(res.body.check_out);
  });

  it('lets a member check out on rescan even while frozen', async () => {
    const checkedIn = await call('POST', '/api/attendance/check-in', { code: 'GM0001' });
    assert.equal(checkedIn.status, 201);

    assert.equal((await call('PATCH', '/api/members/1', { status: 'frozen' })).status, 200);

    const res = await call('POST', '/api/attendance/check-in', { code: 'GM0001' });
    assert.equal(res.status, 200);
    assert.equal(res.body.action, 'checked_out');

    // Restore, so later tests checking GM0001 in again aren't blocked.
    assert.equal((await call('PATCH', '/api/members/1', { status: 'active' })).status, 200);
  });
});

describe('gym sessions', () => {
  it('seeds a default morning and evening session on first boot', async () => {
    const res = await call('GET', '/api/sessions');
    assert.equal(res.status, 200);
    const names = res.body.items.map((s) => s.name);
    assert.ok(names.includes('Morning'));
    assert.ok(names.includes('Evening'));
  });

  it('creates, updates and deletes a session', async () => {
    const created = await call('POST', '/api/sessions', { name: 'Late Night', start_time: '21:00', end_time: '23:00' });
    assert.equal(created.status, 201);

    const updated = await call('PATCH', `/api/sessions/${created.body.id}`, { name: 'Night Shift' });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.name, 'Night Shift');

    assert.equal((await call('DELETE', `/api/sessions/${created.body.id}`)).status, 200);
  });

  it('treats a session whose end time is not after its start time as overnight', async () => {
    // 22:00-06:00 is a real shift (a library's night batch), indistinguishable
    // from a plain input typo by the clock alone — so this is accepted and
    // flagged, not rejected. See the auto-checkout fix this flag exists for
    // in maintenance.js.
    const res = await call('POST', '/api/sessions', { name: 'Night', start_time: '22:00', end_time: '06:00' });
    assert.equal(res.status, 201);
    assert.equal(res.body.overnight, 1);
  });

  it('rejects assigning a member to a session that does not exist', async () => {
    const res = await call('PATCH', '/api/members/2', { session_id: 999999 });
    assert.equal(res.status, 404);
  });

  it('refuses to delete a session members are still assigned to', async () => {
    const created = await call('POST', '/api/sessions', { name: 'Assigned', start_time: '06:00', end_time: '08:00' });
    assert.equal((await call('PATCH', '/api/members/2', { session_id: created.body.id })).status, 200);

    const res = await call('DELETE', `/api/sessions/${created.body.id}`);
    assert.equal(res.status, 409);

    assert.equal((await call('PATCH', '/api/members/2', { session_id: '' })).status, 200);
  });

  it('leaves a member checked in past their assigned session end by default', async () => {
    // A session that ended earlier *today, in local wall-clock terms* — see
    // the "auto-checks a member out" test below for why the clamping.
    const now = new Date();
    const endMinutes = Math.max(now.getHours() * 60 + now.getMinutes() - 1, 1);
    const endTime = `${String(Math.floor(endMinutes / 60)).padStart(2, '0')}:${String(endMinutes % 60).padStart(2, '0')}`;

    const session = await call('POST', '/api/sessions', { name: 'Already Over (Default)', start_time: '00:00', end_time: endTime });
    assert.equal(session.status, 201);

    assert.equal((await call('POST', '/api/subscriptions', { member_id: 2, plan_id: 1 })).status, 201);
    assert.equal((await call('PATCH', '/api/members/2', { session_id: session.body.id })).status, 200);

    const checkedIn = await call('POST', '/api/attendance/check-in', { member_id: 2 });
    assert.equal(checkedIn.status, 201);
    assert.equal(checkedIn.body.action, 'checked_in');

    // auto_close_shift_visits is off by default — the sweep must not close
    // this visit even though the session ended and the sweep runs lazily on
    // this very read.
    const open = await call('GET', '/api/attendance?member_id=2&open=true');
    assert.equal(open.body.items.length, 1, 'a visit must stay open past shift end unless auto-close is turned on');

    await call('POST', '/api/attendance/check-out', { member_id: 2 });
  });

  it('auto-checks a member out once their assigned session has ended, when auto-close is turned on', async () => {
    assert.equal((await call('PUT', '/api/attendance/settings', { auto_close_shift_visits: true })).status, 200);

    // A session that ended earlier *today, in local wall-clock terms*.
    //
    // Naively subtracting five minutes from now breaks in the first few minutes
    // after local midnight: it wraps to yesterday's 23:5x, which as "today's"
    // session end is 24 hours in the future, and at exactly 00:05 it produces
    // "00:00" — equal to start_time, which the API rightly rejects. Clamping
    // inside the current local day fixes both. A session's end_time has only
    // minute precision, so the one case still not expressible is the first
    // minute of the day, where no earlier minute exists to have ended.
    const now = new Date();
    const endMinutes = Math.max(now.getHours() * 60 + now.getMinutes() - 1, 1);
    const endTime = `${String(Math.floor(endMinutes / 60)).padStart(2, '0')}:${String(endMinutes % 60).padStart(2, '0')}`;

    const session = await call('POST', '/api/sessions', { name: 'Already Over', start_time: '00:00', end_time: endTime });
    assert.equal(session.status, 201);

    assert.equal((await call('PATCH', '/api/members/2', { session_id: session.body.id })).status, 200);

    const checkedIn = await call('POST', '/api/attendance/check-in', { member_id: 2 });
    assert.equal(checkedIn.status, 201);
    assert.equal(checkedIn.body.action, 'checked_in');

    // The sweep runs lazily on the next read, not inside the same call that
    // just opened the visit.
    const open = await call('GET', '/api/attendance?member_id=2&open=true');
    assert.equal(open.body.items.length, 0);

    const latest = await call('GET', '/api/attendance?member_id=2&limit=1');
    assert.ok(latest.body.items[0].check_out);
    // check_out is stored in UTC but the API renders it in the gym's own
    // wall clock (ATTENDANCE_SELECT converts it), so it should read back as
    // the plain local HH:MM the session ended at — with slack for the
    // minute-level (no seconds) precision of a session's end_time.
    const expectedClose = new Date(now);
    expectedClose.setHours(Math.floor(endMinutes / 60), endMinutes % 60, 0, 0);
    const closedAt = new Date(`${latest.body.items[0].check_out.replace(' ', 'T')}`);
    assert.ok(
      Math.abs(closedAt.getTime() - expectedClose.getTime()) < 65_000,
      `expected check_out near ${expectedClose.toISOString()}, got ${closedAt.toISOString()}`,
    );

    // Leave auto-close off for every other test in this file.
    await call('PUT', '/api/attendance/settings', { auto_close_shift_visits: false });
  });
});

describe('freeze and resume', () => {
  it('freezes, then credits the frozen days back', async () => {
    const frozen = await call('POST', '/api/subscriptions/1/freeze');
    assert.equal(frozen.status, 200);
    assert.equal(frozen.body.status, 'frozen');

    const resumed = await call('POST', '/api/subscriptions/1/resume');
    assert.equal(resumed.status, 200);
    assert.equal(resumed.body.status, 'active');
    // Frozen and resumed the same day, so no days are lost.
    assert.equal(resumed.body.end_date, addDays(today(), 29));
  });
});

describe('classes and bookings', () => {
  const nextMonday = () => {
    let candidate = today();
    while (new Date(`${candidate}T00:00:00Z`).getUTCDay() !== 1) candidate = addDays(candidate, 1);
    return candidate;
  };

  it('creates a class', async () => {
    const res = await call('POST', '/api/classes', {
      name: 'Sunrise Yoga',
      weekday: 1,
      start_time: '06:30',
      capacity: 1,
    });
    assert.equal(res.status, 201);
  });

  it('rejects a booking on the wrong weekday', async () => {
    const res = await call('POST', '/api/bookings', {
      class_id: 1,
      member_id: 1,
      class_date: addDays(nextMonday(), 1),
    });
    assert.equal(res.status, 400);
  });

  it('books a seat then reports the class as full', async () => {
    const first = await call('POST', '/api/bookings', { class_id: 1, member_id: 1, class_date: nextMonday() });
    assert.equal(first.status, 201);

    const second = await call('POST', '/api/bookings', { class_id: 1, member_id: 2, class_date: nextMonday() });
    assert.equal(second.status, 409);
  });

  it('includes booking counts in the weekly schedule', async () => {
    const res = await call('GET', `/api/classes/schedule?week_start=${nextMonday()}`);
    const slot = res.body.items.find((item) => item.name === 'Sunrise Yoga');
    assert.equal(slot.booked, 1);
    assert.equal(slot.seats_left, 0);
  });
});

describe('role permissions', () => {
  let deskToken;

  before(async () => {
    await call('POST', '/api/staff', {
      name: 'Desk',
      email: 'desk@test.local',
      password: 'deskpass123',
      role: 'staff',
    });
    const login = await call('POST', '/api/auth/login', { email: 'desk@test.local', password: 'deskpass123' });
    deskToken = login.body.token;
  });

  it('lets front-desk staff check members in', async () => {
    const res = await call('POST', '/api/attendance/check-in', { code: 'GM0001' }, deskToken);
    assert.ok([200, 201].includes(res.status));
  });

  it('stops front-desk staff from selling memberships', async () => {
    const res = await call('POST', '/api/subscriptions', { member_id: 2, plan_id: 1 }, deskToken);
    assert.equal(res.status, 403);
  });

  it('stops non-admins from creating staff accounts', async () => {
    const res = await call('POST', '/api/staff', { name: 'X', email: 'x@t.local', password: 'password1' }, deskToken);
    assert.equal(res.status, 403);
  });
});

describe('dashboard and reports', () => {
  it('summarises the gym', async () => {
    const res = await call('GET', '/api/dashboard');
    assert.equal(res.status, 200);
    assert.equal(res.body.members.total, 2);
    assert.ok(res.body.revenue.this_month >= 3000);
    assert.ok(Array.isArray(res.body.revenueTrend));
  });

  it('exports members as CSV', async () => {
    const res = await fetch(`${base}/api/reports/export/members`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/csv/);
    const csv = await res.text();
    assert.match(csv.split('\n')[0], /^code,first_name/);
    assert.match(csv, /GM0001/);
  });

  it('rejects an unknown export', async () => {
    const res = await call('GET', '/api/reports/export/nope');
    assert.equal(res.status, 400);
  });
});
