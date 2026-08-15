import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

/**
 * GET /api/seats/live — the dashboard's "Seated now" map.
 *
 * The endpoint's whole job is to say which of three things a desk is right
 * now: someone is sitting in it, it is rented but empty, or it is nobody's.
 * These tests drive that through the real check-in endpoint rather than
 * writing attendance rows directly, because the seat_id a visit carries is
 * assigned by performCheckIn() — faking the row would test nothing.
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-liveseat-test-'));
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
      slug: 'live-hall',
      gym_name: 'Live Study Hall',
      admin_name: 'Priya Rao',
      admin_email: 'owner@live-hall.test',
      admin_password: 'strongpass123',
      currency: 'INR',
      business_type: 'library',
    },
    { useToken: null },
  );
  assert.equal(signup.status, 201);
  token = signup.body.token;
  base = `${base}/g/live-hall`;

  const sessions = await call('GET', '/api/sessions');
  morningId = sessions.body.items.find((s) => s.name === 'Morning').id;

  await call('POST', '/api/plans', { name: 'Live Monthly', price: 500, duration_days: 30 });
});

after(() => {
  server.close();
  closeDb();
  closeRegistryDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function planId() {
  const { body } = await call('GET', '/api/plans');
  return body.items.find((p) => p.name === 'Live Monthly').id;
}

async function createStudent(firstName) {
  const res = await call('POST', '/api/members', { first_name: firstName, last_name: 'Test' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.id;
}

/** A student with a pass, a seat in the Morning shift, and nothing else. */
async function seatedStudent(name, seatCode) {
  const student = await createStudent(name);
  const seat = await call('POST', '/api/seats', { code: seatCode });
  assert.equal(seat.status, 201, JSON.stringify(seat.body));
  const sub = await call('POST', '/api/subscriptions', {
    member_id: student,
    plan_id: await planId(),
    session_id: morningId,
    seat_id: seat.body.id,
  });
  assert.equal(sub.status, 201, JSON.stringify(sub.body));
  return { student, seatId: seat.body.id };
}

const live = async () => {
  const res = await call('GET', '/api/seats/live');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
};

const cellFor = (map, seatId) => map.occupancy.find((o) => o.seat_id === seatId && o.session_id === morningId);

describe('live seat map states', () => {
  it('marks an allocated seat with nobody checked in as "assigned"', async () => {
    const { seatId } = await seatedStudent('Assigned', 'LIVE-A1');

    const cell = cellFor(await live(), seatId);
    assert.equal(cell.live_state, 'assigned');
    assert.equal(cell.checked_in_at, null);
    assert.equal(cell.attendance_id, null);
  });

  it('flips that seat to "present" once the student checks in', async () => {
    const { student, seatId } = await seatedStudent('Present', 'LIVE-A2');

    const checkIn = await call('POST', '/api/attendance/check-in', { member_id: student });
    assert.equal(checkIn.status, 201, JSON.stringify(checkIn.body));
    assert.equal(checkIn.body.action, 'checked_in');

    const map = await live();
    const cell = cellFor(map, seatId);
    assert.equal(cell.live_state, 'present');
    assert.ok(cell.checked_in_at, 'a present cell carries the check-in time');
    assert.equal(cell.attendance_id, checkIn.body.visit.id);

    // …and the same student shows up in the flat present list, seat and all.
    const entry = map.present.find((p) => p.member_id === student);
    assert.ok(entry, 'the student appears in present[]');
    assert.equal(entry.seat_id, seatId);
    assert.equal(entry.member_name, 'Present Test');
  });

  it('drops the seat back to "assigned" when they check out', async () => {
    const { student, seatId } = await seatedStudent('Leaver', 'LIVE-A3');

    await call('POST', '/api/attendance/check-in', { member_id: student });
    assert.equal(cellFor(await live(), seatId).live_state, 'present');

    // A rescan is the checkout — same endpoint, see performCheckIn().
    const out = await call('POST', '/api/attendance/check-in', { member_id: student });
    assert.equal(out.body.action, 'checked_out');

    const cell = cellFor(await live(), seatId);
    assert.equal(cell.live_state, 'assigned');
    assert.equal(cell.attendance_id, null);
  });

  it('leaves an unallocated seat out of occupancy entirely', async () => {
    const spare = await call('POST', '/api/seats', { code: 'LIVE-SPARE' });
    assert.equal(spare.status, 201);

    const map = await live();
    assert.equal(cellFor(map, spare.body.id), undefined, 'a vacant seat has no occupancy row');
    assert.ok(map.seats.some((s) => s.id === spare.body.id), 'but the seat itself is still on the map');
  });
});

describe('people the grid cannot place', () => {
  it('lists a checked-in student who holds no seat under unseated', async () => {
    const student = await createStudent('Deskless');
    const sub = await call('POST', '/api/subscriptions', {
      member_id: student,
      plan_id: await planId(),
      session_id: morningId,
    });
    assert.equal(sub.status, 201, JSON.stringify(sub.body));

    const checkIn = await call('POST', '/api/attendance/check-in', { member_id: student });
    assert.equal(checkIn.status, 201, JSON.stringify(checkIn.body));

    const map = await live();
    const entry = map.unseated.find((p) => p.member_id === student);
    assert.ok(entry, 'a seatless student is surfaced rather than dropped');
    assert.equal(entry.seat_id, null);
    assert.ok(map.live_totals.unseated >= 1);
  });

  it('counts everyone in the hall exactly once across seated and unseated', async () => {
    const map = await live();
    assert.equal(map.live_totals.present, map.present.length);
    assert.equal(map.live_totals.present_seated + map.live_totals.unseated, map.live_totals.present);
  });

  it('keeps a released seat lit while its occupant is still sitting there', async () => {
    const { student, seatId } = await seatedStudent('Stayer', 'LIVE-A4');
    await call('POST', '/api/attendance/check-in', { member_id: student });
    assert.equal(cellFor(await live(), seatId).live_state, 'present');

    // The hold is vacated mid-visit — the allocation is gone, but the student
    // is demonstrably still in the chair.
    const release = await call('POST', `/api/seats/${seatId}/release`, { session_id: morningId });
    assert.equal(release.status, 200, JSON.stringify(release.body));

    const map = await live();
    assert.equal(cellFor(map, seatId), undefined, 'the allocation really is gone');
    const walkIn = map.walk_ins.find((p) => p.seat_id === seatId);
    assert.ok(walkIn, 'and the occupant lands in walk_ins instead of vanishing');
    assert.equal(walkIn.member_id, student);
    assert.equal(walkIn.seat_code, 'LIVE-A4');
  });
});

describe('the endpoint is guarded like the rest of the seats module', () => {
  it('rejects an unauthenticated read', async () => {
    const res = await call('GET', '/api/seats/live', undefined, { useToken: null });
    assert.equal(res.status, 401);
  });

  it('is not shadowed by the /:id seat routes', async () => {
    const map = await live();
    assert.ok(Array.isArray(map.shifts), 'GET /seats/live returns the map, not a seat lookup');
    assert.ok(Array.isArray(map.present));
  });
});
