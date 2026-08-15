import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-shifts-test-'));
process.env.DB_FILE = path.join(tmpDir, 'default.db');
process.env.PLATFORM_DB_FILE = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.AUTH_SECRET = 'test-secret';

const { createApp } = await import('../src/app.js');
const { closeDb } = await import('../src/db.js');
const { closeRegistryDb } = await import('../src/tenants.js');

let base;
let server;
let token;

const call = async (method, urlPath, body, { useToken = token } = {}) => {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(useToken ? { Authorization: `Bearer ${useToken}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  const signup = await call(
    'POST',
    '/api/platform/signup',
    {
      slug: 'focus-hall',
      gym_name: 'Focus Study Hall',
      admin_name: 'Priya Rao',
      admin_email: 'owner@focus-hall.test',
      admin_password: 'strongpass123',
      currency: 'INR',
      business_type: 'library',
    },
    { useToken: null },
  );
  assert.equal(signup.status, 201);
  token = signup.body.token;
  base = `${base}/g/focus-hall`;
});

after(() => {
  server.close();
  closeDb();
  closeRegistryDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('shifts are seeded per vertical', () => {
  it('seeds the five library shifts, ordered, with the night shift flagged overnight', async () => {
    const res = await call('GET', '/api/sessions');
    assert.equal(res.status, 200);
    const names = res.body.items.map((s) => s.name);
    assert.deepEqual(names, ['Morning', 'Afternoon', 'Evening', 'Night', 'Full Day']);

    const night = res.body.items.find((s) => s.name === 'Night');
    assert.equal(night.overnight, 1);
    assert.equal(night.start_time, '22:00');
    assert.equal(night.end_time, '06:00');
  });

  it('locks the seeded passes to the shift named in their description', async () => {
    const res = await call('GET', '/api/plans');
    const morningPlan = res.body.items.find((p) => p.name === 'Morning Monthly');
    const sessions = await call('GET', '/api/sessions');
    const morningShift = sessions.body.items.find((s) => s.name === 'Morning');
    assert.equal(morningPlan.session_id, morningShift.id);
  });
});

describe('creating and editing shifts', () => {
  it('accepts a shift that runs past midnight and flags it overnight, without being asked to', async () => {
    const res = await call('POST', '/api/sessions', { name: 'Late Owl', start_time: '23:30', end_time: '05:00' });
    assert.equal(res.status, 201);
    assert.equal(res.body.overnight, 1);
  });

  it('flags a same-day shift as not overnight', async () => {
    const res = await call('POST', '/api/sessions', { name: 'Midday', start_time: '11:00', end_time: '15:00' });
    assert.equal(res.status, 201);
    assert.equal(res.body.overnight, 0);
  });

  it('carries price, capacity, code and sort_order through create and update', async () => {
    const created = await call('POST', '/api/sessions', {
      name: 'Weekend Special',
      start_time: '09:00',
      end_time: '13:00',
      price: 50,
      capacity: 40,
      code: 'WK',
      sort_order: 9,
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.price, 50);
    assert.equal(created.body.capacity, 40);
    assert.equal(created.body.code, 'WK');
    assert.equal(created.body.sort_order, 9);

    const updated = await call('PATCH', `/api/sessions/${created.body.id}`, { price: 75 });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.price, 75);
    // Untouched fields survive a partial PATCH.
    assert.equal(updated.body.capacity, 40);
    // Re-deriving overnight from the unchanged start/end must not flip it.
    assert.equal(updated.body.overnight, 0);
  });

  it('re-derives overnight when start/end change on a PATCH', async () => {
    const created = await call('POST', '/api/sessions', { name: 'Shifting', start_time: '08:00', end_time: '12:00' });
    assert.equal(created.body.overnight, 0);

    const updated = await call('PATCH', `/api/sessions/${created.body.id}`, { start_time: '23:00', end_time: '04:00' });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.overnight, 1);
  });

  it('orders shifts by sort_order, not start_time', async () => {
    const res = await call('GET', '/api/sessions');
    const order = res.body.items.map((s) => s.sort_order);
    const sorted = [...order].sort((a, b) => a - b);
    assert.deepEqual(order, sorted);
  });
});

describe('deleting a shift that is still in use', () => {
  it('refuses to delete a shift a plan is locked to', async () => {
    const sessions = await call('GET', '/api/sessions');
    const morning = sessions.body.items.find((s) => s.name === 'Morning');
    const res = await call('DELETE', `/api/sessions/${morning.id}`);
    assert.equal(res.status, 409);
  });
});

/* ----------------------------------------------- selling passes per shift */

describe('selling a pass locks in the shift', () => {
  let morning;
  let evening;

  before(async () => {
    const sessions = await call('GET', '/api/sessions');
    morning = sessions.body.items.find((s) => s.name === 'Morning');
    evening = sessions.body.items.find((s) => s.name === 'Evening');
    // A plain plan, not locked to any shift, so these tests control the
    // shift purely through session_id in the sale.
    await call('POST', '/api/plans', { name: 'Any Shift Monthly', price: 500, duration_days: 30 });
  });

  async function createStudent(firstName) {
    const res = await call('POST', '/api/members', { first_name: firstName });
    assert.equal(res.status, 201);
    return res.body.id;
  }

  it('prices the pass as plan price plus the shift surcharge, and caps the discount at the total', async () => {
    // The seeded Morning shift carries no surcharge by default — give it one
    // so this test actually exercises the "+ shift surcharge" half of the sum.
    const surcharged = await call('PATCH', `/api/sessions/${morning.id}`, { price: 50 });
    assert.equal(surcharged.status, 200);

    const plan = await call('POST', '/api/plans', { name: 'Surcharge Test', price: 500, duration_days: 30 });
    const total = plan.body.price + surcharged.body.price;

    const tooMuch = await call('POST', '/api/subscriptions', {
      member_id: await createStudent('PricedTooMuch'),
      plan_id: plan.body.id,
      session_id: morning.id,
      discount: total + 1,
    });
    assert.equal(tooMuch.status, 400, 'discount must be capped at plan price + shift surcharge, not just plan price');

    const sub = await call('POST', '/api/subscriptions', {
      member_id: await createStudent('Priced'),
      plan_id: plan.body.id,
      session_id: morning.id,
      discount: total,
    });
    assert.equal(sub.status, 201, 'a discount exactly equal to the total must still be accepted');
    assert.equal(sub.body.price, total);

    // Reset, so shifts seeded with no surcharge stay that way for every other
    // test in this file (this describe block's `morning` is shared).
    await call('PATCH', `/api/sessions/${morning.id}`, { price: 0 });
  });

  it('rejects a session_id that does not match a shift-locked plan', async () => {
    const student = await createStudent('Locked');
    const lockedPlans = await call('GET', '/api/plans');
    const morningMonthly = lockedPlans.body.items.find((p) => p.name === 'Morning Monthly');

    const res = await call('POST', '/api/subscriptions', {
      member_id: student,
      plan_id: morningMonthly.id,
      session_id: evening.id,
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.details.session_id);
  });

  it('sells the same student Morning and Evening for the same dates — both succeed', async () => {
    const plans = await call('GET', '/api/plans');
    const anyShift = plans.body.items.find((p) => p.name === 'Any Shift Monthly');
    const student = await createStudent('FullDay');

    const am = await call('POST', '/api/subscriptions', {
      member_id: student,
      plan_id: anyShift.id,
      session_id: morning.id,
    });
    assert.equal(am.status, 201);

    const pm = await call('POST', '/api/subscriptions', {
      member_id: student,
      plan_id: anyShift.id,
      session_id: evening.id,
    });
    assert.equal(pm.status, 201);
  });

  it('409s a second Morning pass that overlaps the one a student already has', async () => {
    const plans = await call('GET', '/api/plans');
    const anyShift = plans.body.items.find((p) => p.name === 'Any Shift Monthly');
    const student = await createStudent('DoubleBooked');

    const first = await call('POST', '/api/subscriptions', {
      member_id: student,
      plan_id: anyShift.id,
      session_id: morning.id,
    });
    assert.equal(first.status, 201);

    // Selling a second Morning pass starting the same day the first one
    // starts is a genuine double-booking, unlike a plain renewal (which picks
    // up the day after the current one ends and is meant to succeed).
    const second = await call('POST', '/api/subscriptions', {
      member_id: student,
      plan_id: anyShift.id,
      session_id: morning.id,
      start_date: first.body.start_date,
    });
    assert.equal(second.status, 409);
  });

  it('assigns and renews a seat through a sale, extending rather than duplicating the allocation', async () => {
    const plans = await call('GET', '/api/plans');
    const anyShift = plans.body.items.find((p) => p.name === 'Any Shift Monthly');
    const student = await createStudent('SeatedSale');
    const seat = await call('POST', '/api/seats', { code: `SALE-${student}` });

    const sale = await call('POST', '/api/subscriptions', {
      member_id: student,
      plan_id: anyShift.id,
      session_id: morning.id,
      seat_id: seat.body.id,
    });
    assert.equal(sale.status, 201);

    const map = await call('GET', '/api/seats/map');
    const cell = map.body.occupancy.find((o) => o.seat_id === seat.body.id && o.session_id === morning.id);
    assert.ok(cell, 'the seat must be allocated as part of the sale');
    assert.equal(cell.subscription_id, sale.body.id);
  });
});

/* --------------------------------------------- the IS-vs-= regression --- */

describe('a gym tenant still guards against duplicate memberships', () => {
  let gymBase;
  let gymToken;

  before(async () => {
    const signup = await call(
      'POST',
      '/api/platform/signup',
      {
        slug: 'iron-house',
        gym_name: 'Iron House',
        admin_name: 'Amit',
        admin_email: 'owner@iron-house.test',
        admin_password: 'strongpass123',
        currency: 'INR',
      },
      { useToken: null },
    );
    assert.equal(signup.status, 201);
    gymToken = signup.body.token;
    gymBase = base.replace('/g/focus-hall', '/g/iron-house');
  });

  const gymCall = async (method, urlPath, body) => {
    const res = await fetch(`${gymBase}${urlPath}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gymToken}` },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  it('409s a second active membership for the same member — session_id is NULL on both sides, not just unequal', async () => {
    const plans = await gymCall('GET', '/api/plans');
    const plan = plans.body.items[0];
    const member = await gymCall('POST', '/api/members', { first_name: 'Regression' });

    const first = await gymCall('POST', '/api/subscriptions', { member_id: member.body.id, plan_id: plan.id });
    assert.equal(first.status, 201);
    assert.equal(first.body.session_id, null);

    // Same overlap shape as the library test above: a second membership
    // starting the same day, not a renewal after the first one ends. With
    // session_id NULL on both sides, `= NULL` would never match and this
    // would silently succeed instead of 409ing.
    const second = await gymCall('POST', '/api/subscriptions', {
      member_id: member.body.id,
      plan_id: plan.id,
      start_date: first.body.start_date,
    });
    assert.equal(second.status, 409);
  });
});

describe('a gym tenant can also enforce its batch/session window', () => {
  let gymBase;
  let gymToken;

  before(async () => {
    const signup = await call(
      'POST',
      '/api/platform/signup',
      {
        slug: 'batch-gym',
        gym_name: 'Batch Gym',
        admin_name: 'Sana',
        admin_email: 'owner@batch-gym.test',
        admin_password: 'strongpass123',
        currency: 'INR',
      },
      { useToken: null },
    );
    assert.equal(signup.status, 201);
    gymToken = signup.body.token;
    gymBase = base.replace('/g/focus-hall', '/g/batch-gym');
  });

  after(async () => {
    await gymCall('PUT', '/api/attendance/settings', { enforce_shift_window: false });
  });

  const gymCall = async (method, urlPath, body) => {
    const res = await fetch(`${gymBase}${urlPath}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gymToken}` },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  // A window that cannot possibly contain "now", whatever time the suite runs.
  const nowTime = new Date().toISOString().slice(11, 16);
  const farBatchStart = nowTime < '02:00' ? '12:00' : '01:00';
  const farBatchEnd = nowTime < '02:00' ? '12:05' : '01:05';

  it('does not gate check-in on a batch by default, even with a batch assigned', async () => {
    const batch = await gymCall('POST', '/api/sessions', { name: 'Early Batch', start_time: farBatchStart, end_time: farBatchEnd });
    assert.equal(batch.status, 201);

    const member = await gymCall('POST', '/api/members', { first_name: 'DefaultOff' });
    assert.equal((await gymCall('PATCH', `/api/members/${member.body.id}`, { session_id: batch.body.id })).status, 200);

    const plans = await gymCall('GET', '/api/plans');
    const sub = await gymCall('POST', '/api/subscriptions', { member_id: member.body.id, plan_id: plans.body.items[0].id });
    assert.equal(sub.status, 201);

    const checkedIn = await gymCall('POST', '/api/attendance/check-in', { member_id: member.body.id });
    assert.equal(checkedIn.status, 201);
    assert.equal(checkedIn.body.action, 'checked_in');
  });

  it('rejects a check-in outside the assigned batch once enforcement is turned on', async () => {
    assert.equal((await gymCall('PUT', '/api/attendance/settings', { enforce_shift_window: true })).status, 200);

    const batch = await gymCall('POST', '/api/sessions', { name: 'Early Batch Enforced', start_time: farBatchStart, end_time: farBatchEnd });
    const member = await gymCall('POST', '/api/members', { first_name: 'OutOfBatch' });
    assert.equal((await gymCall('PATCH', `/api/members/${member.body.id}`, { session_id: batch.body.id })).status, 200);

    const plans = await gymCall('GET', '/api/plans');
    const sub = await gymCall('POST', '/api/subscriptions', { member_id: member.body.id, plan_id: plans.body.items[0].id });
    assert.equal(sub.status, 201);

    const res = await gymCall('POST', '/api/attendance/check-in', { member_id: member.body.id });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /batch|shift/i);

    await gymCall('PUT', '/api/attendance/settings', { enforce_shift_window: false });
  });

  it('does not gate a member with no batch assigned, even with enforcement on', async () => {
    assert.equal((await gymCall('PUT', '/api/attendance/settings', { enforce_shift_window: true })).status, 200);

    const member = await gymCall('POST', '/api/members', { first_name: 'NoBatch' });
    const plans = await gymCall('GET', '/api/plans');
    const sub = await gymCall('POST', '/api/subscriptions', { member_id: member.body.id, plan_id: plans.body.items[0].id });
    assert.equal(sub.status, 201);

    const res = await gymCall('POST', '/api/attendance/check-in', { member_id: member.body.id });
    assert.equal(res.status, 201, 'a member with no assigned batch must never be gated by shift enforcement');

    await gymCall('PUT', '/api/attendance/settings', { enforce_shift_window: false });
  });
});

/* ------------------------------------------------ overnight auto-checkout */

describe('a night shift is not auto-closed the instant it opens', () => {
  it('accepts 22:00-06:00 and does not close a visit against it right away', async () => {
    const night = await call('POST', '/api/sessions', { name: 'Late Night Batch', start_time: '22:00', end_time: '06:00' });
    assert.equal(night.status, 201);
    assert.equal(night.body.overnight, 1);

    const student = await call('POST', '/api/members', { first_name: 'NightOwl' });
    assert.equal((await call('PATCH', `/api/members/${student.body.id}`, { session_id: night.body.id })).status, 200);

    const plans = await call('GET', '/api/plans');
    const anyPlan = plans.body.items[0];
    const sub = await call('POST', '/api/subscriptions', { member_id: student.body.id, plan_id: anyPlan.id });
    assert.equal(sub.status, 201);

    const checkedIn = await call('POST', '/api/attendance/check-in', { member_id: student.body.id });
    assert.equal(checkedIn.status, 201);
    assert.equal(checkedIn.body.action, 'checked_in');

    // Without the overnight flag, "today's 06:00" reads as already in the
    // past for anyone testing outside the 00:00-06:00 window, and the sweep
    // (which runs lazily on this very read) would have closed it on the spot.
    const open = await call('GET', `/api/attendance?member_id=${student.body.id}&open=true`);
    assert.equal(open.body.items.length, 1, 'a night-shift visit must not auto-close before its shift has actually ended');
  });
});

describe('a library sitting is never auto-checked-out, unlike a gym batch', () => {
  it('leaves a shift-locked sitting open long after the shift has ended', async () => {
    // A shift that ended a minute ago, wall-clock — the exact shape that
    // auto-closes a gym visit on the very next read (see api.test.js's
    // "auto-checks a member out once their assigned session has ended").
    // A seats-enabled tenant must never do the same: study-hall time is paid
    // for, not a shift the student is expected to leave by.
    const now = new Date();
    const endMinutes = Math.max(now.getHours() * 60 + now.getMinutes() - 1, 1);
    const endTime = `${String(Math.floor(endMinutes / 60)).padStart(2, '0')}:${String(endMinutes % 60).padStart(2, '0')}`;

    const shift = await call('POST', '/api/sessions', { name: 'Already Over (Library)', start_time: '00:00', end_time: endTime });
    assert.equal(shift.status, 201);

    const student = await call('POST', '/api/members', { first_name: 'StillSeated' });
    const plans = await call('GET', '/api/plans');
    const anyShift = plans.body.items.find((p) => p.name === 'Any Shift Monthly') ?? plans.body.items[0];
    const sub = await call('POST', '/api/subscriptions', { member_id: student.body.id, plan_id: anyShift.id, session_id: shift.body.id });
    assert.equal(sub.status, 201);

    const checkedIn = await call('POST', '/api/attendance/check-in', { member_id: student.body.id });
    assert.equal(checkedIn.status, 201);
    assert.equal(checkedIn.body.action, 'checked_in');

    // The sweep runs lazily on every read, same as the gym case — if it ran
    // here too, this would already show zero open visits.
    const open = await call('GET', `/api/attendance?member_id=${student.body.id}&open=true`);
    assert.equal(open.body.items.length, 1, 'a library sitting must stay open past its shift end — only the student checking out should close it');
  });
});

describe('checking in outside an assigned shift window', () => {
  // A window that cannot possibly contain "now", whatever time the suite runs.
  const nowTime = new Date().toISOString().slice(11, 16);
  const farShiftStart = nowTime < '02:00' ? '12:00' : '01:00';
  const farShiftEnd = nowTime < '02:00' ? '12:05' : '01:05';

  after(async () => {
    // Leave enforcement off for every other describe block in this file.
    await call('PUT', '/api/attendance/settings', { enforce_shift_window: false });
  });

  async function createStudentWithShiftPass(firstName, sessionId) {
    const student = await call('POST', '/api/members', { first_name: firstName });
    assert.equal(student.status, 201);
    const plans = await call('GET', '/api/plans');
    const anyPlan = plans.body.items.find((p) => p.name === 'Any Shift Monthly') ?? plans.body.items[0];
    // The library vertical locks a shift through the subscription's own
    // session_id (resolveShiftSubscription in src/checkin.js), not the
    // member's default batch — see "selling a pass locks in the shift" above.
    const sub = await call('POST', '/api/subscriptions', {
      member_id: student.body.id,
      plan_id: anyPlan.id,
      session_id: sessionId,
    });
    assert.equal(sub.status, 201);
    return student.body.id;
  }

  it('is off by default — a shift-locked pass still checks in any time', async () => {
    const shift = await call('POST', '/api/sessions', { name: 'Narrow Window', start_time: farShiftStart, end_time: farShiftEnd });
    assert.equal(shift.status, 201);

    const memberId = await createStudentWithShiftPass('OffByDefault', shift.body.id);

    const checkedIn = await call('POST', '/api/attendance/check-in', { member_id: memberId });
    assert.equal(checkedIn.status, 201);
    assert.equal(checkedIn.body.action, 'checked_in');
  });

  it('rejects a check-in outside the shift window once enforcement is turned on', async () => {
    const settingsOn = await call('PUT', '/api/attendance/settings', { enforce_shift_window: true });
    assert.equal(settingsOn.status, 200);
    assert.equal(settingsOn.body.enforce_shift_window, 1);

    const shift = await call('POST', '/api/sessions', { name: 'Narrow Window Enforced', start_time: farShiftStart, end_time: farShiftEnd });
    const memberId = await createStudentWithShiftPass('OutOfWindow', shift.body.id);

    const res = await call('POST', '/api/attendance/check-in', { member_id: memberId });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /shift/i);

    await call('PUT', '/api/attendance/settings', { enforce_shift_window: false });
  });

  it('still allows check-in inside the shift window with enforcement on', async () => {
    assert.equal((await call('PUT', '/api/attendance/settings', { enforce_shift_window: true })).status, 200);

    const session = await call('POST', '/api/sessions', {
      name: 'Wide Open',
      start_time: '00:00',
      end_time: '23:59',
    });
    const memberId = await createStudentWithShiftPass('InWindow', session.body.id);

    const res = await call('POST', '/api/attendance/check-in', { member_id: memberId });
    assert.equal(res.status, 201);
    assert.equal(res.body.action, 'checked_in');

    await call('PUT', '/api/attendance/settings', { enforce_shift_window: false });
  });
});
