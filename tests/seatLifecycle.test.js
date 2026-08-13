import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-seatlifecycle-test-'));
process.env.DB_FILE = path.join(tmpDir, 'default.db');
process.env.PLATFORM_DB_FILE = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.AUTH_SECRET = 'test-secret';

const { createApp } = await import('../src/app.js');
const { closeDb } = await import('../src/db.js');
const { closeRegistryDb } = await import('../src/tenants.js');
const { addDays, today } = await import('../src/validate.js');

let base;
let server;
let token;
let morningId;

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

  const sessions = await call('GET', '/api/sessions');
  morningId = sessions.body.items.find((s) => s.name === 'Morning').id;

  await call('POST', '/api/plans', { name: 'Seat Lifecycle Monthly', price: 500, duration_days: 30 });
});

after(() => {
  server.close();
  closeDb();
  closeRegistryDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function planId() {
  const { body } = await call('GET', '/api/plans');
  return body.items.find((p) => p.name === 'Seat Lifecycle Monthly').id;
}

async function createStudent(firstName) {
  const res = await call('POST', '/api/members', { first_name: firstName });
  assert.equal(res.status, 201);
  return res.body.id;
}

async function seatCell(seatId) {
  const map = await call('GET', '/api/seats/map');
  return map.body.occupancy.find((o) => o.seat_id === seatId && o.session_id === morningId);
}

describe('renewal extends the seat, it does not duplicate it', () => {
  it('keeps one allocation row, with a later end_date and the new subscription id', async () => {
    const plan = await planId();
    const student = await createStudent('Renewer');
    const seat = await call('POST', '/api/seats', { code: `RENEW-${student}` });

    const first = await call('POST', '/api/subscriptions', {
      member_id: student,
      plan_id: plan,
      session_id: morningId,
      seat_id: seat.body.id,
    });
    assert.equal(first.status, 201);

    const cellAfterFirst = await seatCell(seat.body.id);
    assert.equal(cellAfterFirst.subscription_id, first.body.id);
    assert.equal(cellAfterFirst.end_date, first.body.end_date);

    // Renewal, same seat, no seat_id needed — allocateOrExtend finds the
    // student's existing desk in this shift on its own.
    const renewal = await call('POST', '/api/subscriptions', {
      member_id: student,
      plan_id: plan,
      session_id: morningId,
      start_date: addDays(first.body.end_date, 1),
    });
    assert.equal(renewal.status, 201);

    const map = await call('GET', '/api/seats/map');
    const cellsForSeat = map.body.occupancy.filter((o) => o.seat_id === seat.body.id && o.session_id === morningId);
    assert.equal(cellsForSeat.length, 1, 'renewal must extend the row, not add a second one');
    assert.equal(cellsForSeat[0].subscription_id, renewal.body.id);
    assert.equal(cellsForSeat[0].end_date, renewal.body.end_date);
    assert.ok(renewal.body.end_date > first.body.end_date);
  });
});

describe('freeze and resume', () => {
  it('a frozen pass keeps its desk, and resume bumps the allocation to exactly the new end_date', async () => {
    const plan = await planId();
    const student = await createStudent('Freezer');
    const seat = await call('POST', '/api/seats', { code: `FREEZE-${student}` });

    const sub = await call('POST', '/api/subscriptions', {
      member_id: student,
      plan_id: plan,
      session_id: morningId,
      seat_id: seat.body.id,
    });
    assert.equal(sub.status, 201);

    const frozen = await call('POST', `/api/subscriptions/${sub.body.id}/freeze`);
    assert.equal(frozen.status, 200);

    // Still on the map, still active, and its state reads as held rather
    // than an ordinary occupied tile.
    const heldCell = await seatCell(seat.body.id);
    assert.ok(heldCell, 'a frozen pass must not lose its desk');
    assert.equal(heldCell.state, 'frozen');

    const resumed = await call('POST', `/api/subscriptions/${sub.body.id}/resume`);
    assert.equal(resumed.status, 200);

    const cellAfterResume = await seatCell(seat.body.id);
    assert.equal(
      cellAfterResume.end_date,
      resumed.body.end_date,
      'the allocation must move in lockstep with the subscription it belongs to',
    );
  });

  it('a frozen pass keeps its desk even once its original end_date has passed', async () => {
    const student = await createStudent('LongFrozen');
    const seat = await call('POST', '/api/seats', { code: `LONGFREEZE-${student}` });

    // A short pass, frozen immediately, so "today" can plausibly be past its
    // original end_date without waiting in real time for it to lapse.
    const shortPlan = await call('POST', '/api/plans', { name: 'One Day Pass', price: 50, duration_days: 1 });
    const sub = await call('POST', '/api/subscriptions', {
      member_id: student,
      plan_id: shortPlan.body.id,
      session_id: morningId,
      seat_id: seat.body.id,
      start_date: today(),
    });
    assert.equal(sub.status, 201);
    assert.equal(sub.body.end_date, today());

    const frozen = await call('POST', `/api/subscriptions/${sub.body.id}/freeze`);
    assert.equal(frozen.status, 200);

    // The original end_date (today) has not moved, so by tomorrow the pass's
    // stored end_date is already in the past — yet it must still hold the desk.
    const stillHeld = await seatCell(seat.body.id);
    assert.ok(stillHeld, 'a frozen pass must keep its desk regardless of its stored end_date');
  });
});

describe('cancelling releases the desk', () => {
  it('vacates the seat when the subscription is cancelled', async () => {
    const plan = await planId();
    const student = await createStudent('Canceller');
    const seat = await call('POST', '/api/seats', { code: `CANCEL-${student}` });

    const sub = await call('POST', '/api/subscriptions', {
      member_id: student,
      plan_id: plan,
      session_id: morningId,
      seat_id: seat.body.id,
    });
    assert.equal(sub.status, 201);
    assert.ok(await seatCell(seat.body.id));

    const cancelled = await call('POST', `/api/subscriptions/${sub.body.id}/cancel`);
    assert.equal(cancelled.status, 200);

    assert.equal(await seatCell(seat.body.id), undefined, 'cancelling must release the desk');

    // And it can be sold to someone else immediately.
    const other = await createStudent('NextInLine');
    const reassigned = await call('POST', `/api/seats/${seat.body.id}/allocate`, {
      session_id: morningId,
      member_id: other,
      start_date: today(),
      end_date: addDays(today(), 10),
    });
    assert.equal(reassigned.status, 201);
  });
});

describe('a failed sale leaves no orphan allocation', () => {
  it('rolls back the seat allocation when the sale itself fails inside the same transaction', async () => {
    const plan = await planId();
    const holder = await createStudent('Holder');
    const blocked = await createStudent('BlockedBuyer');
    const seat = await call('POST', '/api/seats', { code: `ORPHAN-${holder}` });

    // Occupy the seat first, so the second sale's seat allocation is
    // guaranteed to fail inside the transaction.
    await call('POST', '/api/subscriptions', {
      member_id: holder,
      plan_id: plan,
      session_id: morningId,
      seat_id: seat.body.id,
    });

    const before = await call('GET', '/api/subscriptions');
    const beforeCount = before.body.items.length;

    const failedSale = await call('POST', '/api/subscriptions', {
      member_id: blocked,
      plan_id: plan,
      session_id: morningId,
      seat_id: seat.body.id,
    });
    assert.equal(failedSale.status, 409);

    const after = await call('GET', '/api/subscriptions');
    assert.equal(after.body.items.length, beforeCount, 'the failed sale must not have created a subscription row either');

    const map = await call('GET', '/api/seats/map');
    const cells = map.body.occupancy.filter((o) => o.seat_id === seat.body.id && o.session_id === morningId);
    assert.equal(cells.length, 1);
    assert.equal(cells[0].member_id, holder);
  });
});

describe('the lazy release sweep', () => {
  it('holds a lapsed seat for exactly seat_hold_days, then releases it on the following day', async () => {
    const withinHold = await call('POST', '/api/seats', { code: 'HOLD-WITHIN' });
    const pastHold = await call('POST', '/api/seats', { code: 'HOLD-PAST' });
    const [s1, s2] = await Promise.all([createStudent('StillHeld'), createStudent('NowReleased')]);

    // library_settings.seat_hold_days defaults to 3.
    await call('POST', `/api/seats/${withinHold.body.id}/allocate`, {
      session_id: morningId,
      member_id: s1,
      start_date: addDays(today(), -30),
      end_date: addDays(today(), -3),
    });
    await call('POST', `/api/seats/${pastHold.body.id}/allocate`, {
      session_id: morningId,
      member_id: s2,
      start_date: addDays(today(), -30),
      end_date: addDays(today(), -4),
    });

    // The map read is what drives the sweep — see releaseLapsedSeatAllocations()
    // in maintenance.js and its call site in seats.js.
    const map = await call('GET', '/api/seats/map');
    assert.ok(
      map.body.occupancy.some((o) => o.seat_id === withinHold.body.id),
      'a seat lapsed exactly seat_hold_days ago must still be held',
    );
    assert.ok(
      !map.body.occupancy.some((o) => o.seat_id === pastHold.body.id),
      'a seat lapsed more than seat_hold_days ago must be released',
    );

    // And the released one is immediately sellable again.
    const resold = await call('POST', `/api/seats/${pastHold.body.id}/allocate`, {
      session_id: morningId,
      member_id: await createStudent('Resold'),
      start_date: today(),
      end_date: addDays(today(), 30),
    });
    assert.equal(resold.status, 201);
  });

  it('never releases a frozen pass, however long its end_date has passed', async () => {
    const shortPlan = await call('POST', '/api/plans', { name: 'One Day Frozen', price: 50, duration_days: 1 });
    const student = await createStudent('FrozenAndLapsed');
    const seat = await call('POST', '/api/seats', { code: `FROZENLAPSE-${student}` });

    // Backdated far enough that end_date is well past both today and the
    // hold window — freezing has to happen before any read flips it to
    // 'expired' out from under this test, so no other subscriptions call
    // runs in between.
    const sub = await call('POST', '/api/subscriptions', {
      member_id: student,
      plan_id: shortPlan.body.id,
      session_id: morningId,
      seat_id: seat.body.id,
      start_date: addDays(today(), -10),
    });
    assert.equal(sub.status, 201);
    assert.ok(sub.body.end_date < addDays(today(), -3));

    const frozen = await call('POST', `/api/subscriptions/${sub.body.id}/freeze`);
    assert.equal(frozen.status, 200);

    const map = await call('GET', '/api/seats/map');
    assert.ok(
      map.body.occupancy.some((o) => o.seat_id === seat.body.id),
      'a frozen pass must keep its desk no matter how long it has been "lapsed"',
    );
  });
});
