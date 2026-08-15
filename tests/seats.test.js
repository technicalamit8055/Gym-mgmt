import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-seats-test-'));
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

async function shiftId(name) {
  const { body } = await call('GET', '/api/sessions');
  return body.items.find((s) => s.name === name)?.id;
}

async function createMember(firstName) {
  const res = await call('POST', '/api/members', { first_name: firstName });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.id;
}

describe('setting up a hall', () => {
  it('bulk-creates a batch of desks in one call', async () => {
    const zone = await call('POST', '/api/seats/zones', { name: 'Ground Floor' });
    assert.equal(zone.status, 201);

    const seats = Array.from({ length: 20 }, (_, i) => ({
      code: `BULK-${i + 1}`,
      row_label: 'A',
      col_index: i + 1,
    }));
    const res = await call('POST', '/api/seats/bulk', { zone_id: zone.body.id, seats });
    assert.equal(res.status, 201);
    assert.equal(res.body.created, 20);

    const list = await call('GET', '/api/seats');
    assert.equal(list.body.items.length, 20);
  });

  it('refuses a batch with a repeated code', async () => {
    const res = await call('POST', '/api/seats/bulk', {
      seats: [{ code: 'DUPE-1' }, { code: 'DUPE-1' }],
    });
    assert.equal(res.status, 400);
  });

  it('retires rather than deletes a seat that has allocation history', async () => {
    const seat = await call('POST', '/api/seats', { code: 'HIST-1' });
    const member = await createMember('History');
    const morning = await shiftId('Morning');

    await call('POST', `/api/seats/${seat.body.id}/allocate`, {
      session_id: morning,
      member_id: member,
      start_date: today(),
      end_date: addDays(today(), 30),
    });

    const del = await call('DELETE', `/api/seats/${seat.body.id}`);
    assert.equal(del.status, 200);
    assert.equal(del.body.retired, true);

    const still = await call('GET', '/api/seats');
    assert.ok(still.body.items.some((s) => s.id === seat.body.id && s.status === 'retired'));
  });

  it('bulk-deletes a batch of seats, retiring any with allocation history', async () => {
    const plain = await call('POST', '/api/seats', { code: 'BULKDEL-1' });
    const withHistory = await call('POST', '/api/seats', { code: 'BULKDEL-2' });
    const member = await createMember('BulkDel');
    const morning = await shiftId('Morning');

    await call('POST', `/api/seats/${withHistory.body.id}/allocate`, {
      session_id: morning,
      member_id: member,
      start_date: today(),
      end_date: addDays(today(), 30),
    });

    const res = await call('DELETE', '/api/seats/bulk', {
      seat_ids: [plain.body.id, withHistory.body.id],
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.deleted, 1);
    assert.equal(res.body.retired, 1);

    const list = await call('GET', '/api/seats');
    assert.ok(!list.body.items.some((s) => s.id === plain.body.id));
    assert.ok(list.body.items.some((s) => s.id === withHistory.body.id && s.status === 'retired'));
  });

  it('refuses a bulk delete with no seat ids', async () => {
    const res = await call('DELETE', '/api/seats/bulk', { seat_ids: [] });
    assert.equal(res.status, 400);
  });

  it('404s a bulk delete when none of the ids exist', async () => {
    const res = await call('DELETE', '/api/seats/bulk', { seat_ids: [999999] });
    assert.equal(res.status, 404);
  });
});

describe('one seat, many shifts', () => {
  let seatId;
  let morning;
  let evening;

  before(async () => {
    const seat = await call('POST', '/api/seats', { code: 'A-12' });
    seatId = seat.body.id;
    morning = await shiftId('Morning');
    evening = await shiftId('Evening');
  });

  it('allocates the same seat in the morning and the evening — both succeed', async () => {
    const student1 = await createMember('Rahul');
    const student2 = await createMember('Deepa');

    const am = await call('POST', `/api/seats/${seatId}/allocate`, {
      session_id: morning,
      member_id: student1,
      start_date: today(),
      end_date: addDays(today(), 30),
    });
    assert.equal(am.status, 201);

    const pm = await call('POST', `/api/seats/${seatId}/allocate`, {
      session_id: evening,
      member_id: student2,
      start_date: today(),
      end_date: addDays(today(), 30),
    });
    assert.equal(pm.status, 201);
  });

  it('409s a second student onto the same seat and shift, naming the holder', async () => {
    const student = await createMember('Vikram');
    const res = await call('POST', `/api/seats/${seatId}/allocate`, {
      session_id: morning,
      member_id: student,
      start_date: today(),
      end_date: addDays(today(), 15),
    });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /Rahul/);
    assert.match(res.body.error, /A-12/);
  });

  it('leaves exactly one live row even when two allocate calls land back to back', async () => {
    const seat = await call('POST', '/api/seats', { code: 'RACE-1' });
    const [s1, s2] = await Promise.all([createMember('Racer1'), createMember('Racer2')]);

    const payload = (memberId) => ({
      session_id: morning,
      member_id: memberId,
      start_date: today(),
      end_date: addDays(today(), 30),
    });
    const [first, second] = await Promise.all([
      call('POST', `/api/seats/${seat.body.id}/allocate`, payload(s1)),
      call('POST', `/api/seats/${seat.body.id}/allocate`, payload(s2)),
    ]);
    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, [201, 409]);

    const map = await call('GET', '/api/seats/map');
    const live = map.body.occupancy.filter((o) => o.seat_id === seat.body.id && o.session_id === morning);
    assert.equal(live.length, 1);
  });

  it('refuses one student holding two desks in the same shift', async () => {
    const seatB = await call('POST', '/api/seats', { code: 'B-1' });
    const seatC = await call('POST', '/api/seats', { code: 'C-1' });
    const student = await createMember('OneDeskOnly');

    const onB = await call('POST', `/api/seats/${seatB.body.id}/allocate`, {
      session_id: morning,
      member_id: student,
      start_date: today(),
      end_date: addDays(today(), 10),
    });
    assert.equal(onB.status, 201);

    const onC = await call('POST', `/api/seats/${seatC.body.id}/allocate`, {
      session_id: morning,
      member_id: student,
      start_date: today(),
      end_date: addDays(today(), 10),
    });
    assert.equal(onC.status, 409);
    assert.match(onC.body.error, /already holds seat/);
  });

  it('release then re-allocate succeeds', async () => {
    const seat = await call('POST', '/api/seats', { code: 'FREE-1' });
    const student1 = await createMember('First');
    const student2 = await createMember('Second');

    await call('POST', `/api/seats/${seat.body.id}/allocate`, {
      session_id: morning,
      member_id: student1,
      start_date: today(),
      end_date: addDays(today(), 30),
    });

    const released = await call('POST', `/api/seats/${seat.body.id}/release`, { session_id: morning });
    assert.equal(released.status, 200);
    assert.equal(released.body.status, 'released');

    const reallocated = await call('POST', `/api/seats/${seat.body.id}/allocate`, {
      session_id: morning,
      member_id: student2,
      start_date: today(),
      end_date: addDays(today(), 30),
    });
    assert.equal(reallocated.status, 201);
  });

  it('transfers atomically, and 409s onto an occupied target leaving the source untouched', async () => {
    const from = await call('POST', '/api/seats', { code: 'XFER-FROM' });
    const to = await call('POST', '/api/seats', { code: 'XFER-TO' });
    const occupied = await call('POST', '/api/seats', { code: 'XFER-OCCUPIED' });
    const [holder, blocker] = await Promise.all([createMember('Mover'), createMember('Blocker')]);

    await call('POST', `/api/seats/${from.body.id}/allocate`, {
      session_id: evening,
      member_id: holder,
      start_date: today(),
      end_date: addDays(today(), 30),
    });
    await call('POST', `/api/seats/${occupied.body.id}/allocate`, {
      session_id: evening,
      member_id: blocker,
      start_date: today(),
      end_date: addDays(today(), 30),
    });

    const ok = await call('POST', `/api/seats/${from.body.id}/transfer`, {
      session_id: evening,
      to_seat_id: to.body.id,
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.seat_id, to.body.id);

    // Move back onto the occupied seat: must fail, and the source (now `to`)
    // must still hold the allocation afterwards.
    const blocked = await call('POST', `/api/seats/${to.body.id}/transfer`, {
      session_id: evening,
      to_seat_id: occupied.body.id,
    });
    assert.equal(blocked.status, 409);

    const map = await call('GET', '/api/seats/map');
    const stillOnTo = map.body.occupancy.find((o) => o.seat_id === to.body.id && o.session_id === evening);
    assert.ok(stillOnTo, 'the source seat must still carry the allocation after a blocked transfer');
  });
});

describe('the seat map and vacancy screens', () => {
  it('/map returns zones, seats, shifts and a state per occupied cell in one call', async () => {
    const res = await call('GET', '/api/seats/map');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.shifts));
    assert.ok(Array.isArray(res.body.zones));
    assert.ok(Array.isArray(res.body.seats));
    assert.ok(Array.isArray(res.body.occupancy));
    assert.ok(res.body.occupancy.length > 0);
    for (const cell of res.body.occupancy) {
      assert.ok(['occupied', 'expiring', 'expired', 'dues', 'frozen'].includes(cell.state));
    }
  });

  it('/vacancy in the future lists desks freeing up', async () => {
    const seat = await call('POST', '/api/seats', { code: 'VAC-1' });
    const morning = await shiftId('Morning');
    const student = await createMember('SoonGone');

    await call('POST', `/api/seats/${seat.body.id}/allocate`, {
      session_id: morning,
      member_id: student,
      start_date: today(),
      end_date: addDays(today(), 3),
    });

    const res = await call('GET', `/api/seats/vacancy?on=${addDays(today(), 10)}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.freeing_up.some((f) => f.seat_id === seat.body.id));
  });
});

describe('a two-desk student does not break the roster', () => {
  it('does not inflate the member list total or duplicate the row', async () => {
    const morning = await shiftId('Morning');
    const evening = await shiftId('Evening');
    const student = await createMember('TwoDesks');
    const seatA = await call('POST', '/api/seats', { code: 'ROSTER-A' });
    const seatB = await call('POST', '/api/seats', { code: 'ROSTER-B' });

    await call('POST', `/api/seats/${seatA.body.id}/allocate`, {
      session_id: morning,
      member_id: student,
      start_date: today(),
      end_date: addDays(today(), 30),
    });
    await call('POST', `/api/seats/${seatB.body.id}/allocate`, {
      session_id: evening,
      member_id: student,
      start_date: today(),
      end_date: addDays(today(), 30),
    });

    const before = await call('GET', '/api/members?limit=200');
    const rows = before.body.items.filter((m) => m.id === student);
    assert.equal(rows.length, 1, 'a student holding two desks must appear once in the roster, not twice');
    assert.equal(before.body.total, before.body.items.length, 'the aggregated total must match the row count, not double it');
  });
});

describe('the seats module does not leak into a gym', () => {
  let gymToken;
  let gymBase;

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

  it('404s /api/seats for a gym tenant', async () => {
    const res = await fetch(`${gymBase}/api/seats`, { headers: { Authorization: `Bearer ${gymToken}` } });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.details?.code, 'module_not_enabled');
  });
});
