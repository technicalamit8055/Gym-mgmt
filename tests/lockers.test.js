import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-lockers-test-'));
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

async function createStudent(firstName) {
  const res = await call('POST', '/api/members', { first_name: firstName });
  assert.equal(res.status, 201);
  return res.body.id;
}

describe('one locker, one holder', () => {
  it('allocates a locker and 409s a second student onto the same one', async () => {
    const locker = await call('POST', '/api/lockers', { code: 'L-1', monthly_fee: 100 });
    assert.equal(locker.status, 201);

    const first = await createStudent('First');
    const ok = await call('POST', `/api/lockers/${locker.body.id}/allocate`, {
      member_id: first,
      start_date: today(),
      end_date: addDays(today(), 30),
      fee: 100,
    });
    assert.equal(ok.status, 201);

    const second = await createStudent('Second');
    const blocked = await call('POST', `/api/lockers/${locker.body.id}/allocate`, {
      member_id: second,
      start_date: today(),
      end_date: addDays(today(), 30),
    });
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error, /L-1/);
  });

  it('release then re-allocate succeeds', async () => {
    const locker = await call('POST', '/api/lockers', { code: 'L-2' });
    const first = await createStudent('Releaser');

    await call('POST', `/api/lockers/${locker.body.id}/allocate`, {
      member_id: first,
      start_date: today(),
      end_date: addDays(today(), 30),
    });

    const released = await call('POST', `/api/lockers/${locker.body.id}/release`);
    assert.equal(released.status, 200);
    assert.equal(released.body.status, 'released');

    const second = await createStudent('Next');
    const reallocated = await call('POST', `/api/lockers/${locker.body.id}/allocate`, {
      member_id: second,
      start_date: today(),
      end_date: addDays(today(), 30),
    });
    assert.equal(reallocated.status, 201);
  });

  it('retires rather than deletes a locker with allocation history', async () => {
    const locker = await call('POST', '/api/lockers', { code: 'L-3' });
    const student = await createStudent('History');
    await call('POST', `/api/lockers/${locker.body.id}/allocate`, {
      member_id: student,
      start_date: today(),
      end_date: addDays(today(), 30),
    });

    const del = await call('DELETE', `/api/lockers/${locker.body.id}`);
    assert.equal(del.status, 200);
    assert.equal(del.body.retired, true);
  });
});

describe('the lapsed locker sweep', () => {
  it('holds a lapsed locker for seat_hold_days, releasing it the day after', async () => {
    const withinHold = await call('POST', '/api/lockers', { code: 'L-HOLD' });
    const pastHold = await call('POST', '/api/lockers', { code: 'L-EXPIRED' });
    const [s1, s2] = await Promise.all([createStudent('HeldLocker'), createStudent('FreedLocker')]);

    await call('POST', `/api/lockers/${withinHold.body.id}/allocate`, {
      member_id: s1,
      start_date: addDays(today(), -30),
      end_date: addDays(today(), -3),
    });
    await call('POST', `/api/lockers/${pastHold.body.id}/allocate`, {
      member_id: s2,
      start_date: addDays(today(), -30),
      end_date: addDays(today(), -4),
    });

    const list = await call('GET', '/api/lockers');
    const heldRow = list.body.items.find((l) => l.id === withinHold.body.id);
    const freedRow = list.body.items.find((l) => l.id === pastHold.body.id);
    assert.ok(heldRow.allocation_id, 'a locker lapsed exactly seat_hold_days ago must still be held');
    assert.equal(freedRow.allocation_id, null, 'a locker lapsed more than seat_hold_days ago must be released');
  });
});

describe('the lockers module does not leak into a gym', () => {
  it('404s /api/lockers for a gym tenant', async () => {
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
    const gymBase = base.replace('/g/focus-hall', '/g/iron-house');
    const res = await fetch(`${gymBase}/api/lockers`, { headers: { Authorization: `Bearer ${signup.body.token}` } });
    assert.equal(res.status, 404);
    const resBody = await res.json();
    assert.equal(resBody.details?.code, 'module_not_enabled');
  });
});
