import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it, mock } from 'node:test';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-tz-test-'));
process.env.DB_FILE = path.join(tmpDir, 'default.db');
process.env.PLATFORM_DB_FILE = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.AUTH_SECRET = 'test-secret';

const { createApp } = await import('../src/app.js');
const { gymDateOf, gymDatetimeOf, gymMonthDay, utcTimestamp } = await import('../src/clock.js');
const { closeDb, get, run, tenantStorage } = await import('../src/db.js');
const { closeRegistryDb } = await import('../src/tenants.js');
const { performCheckIn } = await import('../src/checkin.js');
const { today, startOfMonth, addDays } = await import('../src/validate.js');

/** Runs `fn` as if the request had resolved to a gym in `timezone`. */
const inZone = (timezone, fn) =>
  tenantStorage.run({ slug: 'tz-test', dbFile: process.env.DB_FILE, timezone }, fn);

let base;
let server;

const call = async (method, urlPath, body, { token } = {}) => {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
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

describe("today() is the gym's date, not UTC's", () => {
  // These two zones are 25 hours apart, so their local dates differ at every
  // instant — no clock mocking needed to prove today() actually reads the
  // gym's timezone rather than returning the same UTC date to everyone.
  it('gives two gyms on opposite sides of the date line different days', () => {
    const ahead = inZone('Pacific/Kiritimati', today); // UTC+14
    const behind = inZone('Pacific/Midway', today); // UTC-11
    assert.notEqual(ahead, behind);
  });

  it('brackets the UTC date rather than drifting off it', () => {
    const utcDate = new Date().toISOString().slice(0, 10);
    assert.ok(inZone('Pacific/Kiritimati', today) >= utcDate);
    assert.ok(inZone('Pacific/Midway', today) <= utcDate);
  });

  it('agrees with UTC for a gym that is in UTC', () => {
    assert.equal(inZone('UTC', today), new Date().toISOString().slice(0, 10));
  });

  it('falls back to the server zone when a gym has set no timezone', () => {
    const serverDate = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000)
      .toISOString()
      .slice(0, 10);
    assert.equal(inZone(undefined, today), serverDate);
  });
});

describe('a stored UTC instant reads back on the gym-local day', () => {
  let visitId;

  before(() => {
    inZone('Asia/Kolkata', () => {
      run("INSERT INTO members (code, first_name) VALUES ('TZ0001', 'Dawn')");
      const member = get("SELECT id FROM members WHERE code = 'TZ0001'");
      // 05:00 on 6 Aug, India time — the morning batch. In UTC that is still
      // 23:30 on 5 Aug, which is the whole problem.
      run("INSERT INTO attendance (member_id, check_in, source) VALUES (?, '2026-08-05 23:30:00', 'desk')", [
        member.id,
      ]);
      visitId = Number(get('SELECT MAX(id) AS id FROM attendance').id);
    });
  });

  it('attributes the visit to 6 August for a gym in India', () => {
    const row = inZone('Asia/Kolkata', () =>
      get(`SELECT ${gymDateOf('check_in')} AS day FROM attendance WHERE id = ?`, [visitId]),
    );
    assert.equal(row.day, '2026-08-06');
  });

  it('still reads 5 August for a gym actually in UTC', () => {
    const row = inZone('UTC', () =>
      get(`SELECT ${gymDateOf('check_in')} AS day FROM attendance WHERE id = ?`, [visitId]),
    );
    assert.equal(row.day, '2026-08-05');
  });

  it('buckets it at 5am for the peak-hour report, not 11pm', () => {
    const row = inZone('Asia/Kolkata', () =>
      get(
        `SELECT CAST(strftime('%H', ${gymDatetimeOf('check_in')}) AS INTEGER) AS hour
         FROM attendance WHERE id = ?`,
        [visitId],
      ),
    );
    assert.equal(row.hour, 5);
  });

  it('buckets it on Thursday, not Wednesday', () => {
    // 2026-08-06 is a Thursday (4); 2026-08-05 UTC would say Wednesday (3).
    const row = inZone('Asia/Kolkata', () =>
      get(
        `SELECT CAST(strftime('%w', ${gymDatetimeOf('check_in')}) AS INTEGER) AS weekday
         FROM attendance WHERE id = ?`,
        [visitId],
      ),
    );
    assert.equal(row.weekday, 4);
  });
});

describe('rescan after the UTC day has rolled over', () => {
  // The regression this whole sweep exists for. A member on a session-limited
  // plan checks in at 05:00 IST and rescans at 06:00 IST to leave. Those two
  // instants sit on either side of UTC midnight, so the old "same calendar
  // day" lookup did not recognise the second scan as a checkout: it opened a
  // second visit and burned a second session off the plan.
  let member;

  before(() => {
    inZone('Asia/Kolkata', () => {
      run("INSERT INTO members (code, first_name, joined_on) VALUES ('TZ0002', 'Rahul', '2026-08-01')");
      member = get("SELECT * FROM members WHERE code = 'TZ0002'");
      run(
        `INSERT INTO plans (name, price, duration_days, sessions)
         VALUES ('TZ Personal Training', 5000, 180, 12)`,
      );
      const plan = get("SELECT id FROM plans WHERE name = 'TZ Personal Training'");
      run(
        `INSERT INTO subscriptions
           (member_id, plan_id, start_date, end_date, price, sessions_total, sessions_used, status)
         VALUES (?, ?, '2026-08-01', '2026-12-31', 5000, 12, 1, 'active')`,
        [member.id, plan.id],
      );
      run("INSERT INTO attendance (member_id, check_in, source) VALUES (?, '2026-08-05 23:30:00', 'desk')", [
        member.id,
      ]);
    });
  });

  after(() => {
    mock.timers.reset();
  });

  it('checks the member out instead of opening a second visit', () => {
    // 00:30 UTC on 6 Aug = 06:00 IST, one hour after the check-in above.
    mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-08-06T00:30:00Z') });

    const result = inZone('Asia/Kolkata', () => performCheckIn(member, 'desk'));
    assert.equal(result.action, 'checked_out');

    const visits = inZone('Asia/Kolkata', () =>
      get('SELECT COUNT(*) AS n FROM attendance WHERE member_id = ?', [member.id]),
    );
    assert.equal(visits.n, 1, 'the rescan must not create a second visit');
  });

  it('does not burn a second session off the plan', () => {
    const sub = inZone('Asia/Kolkata', () =>
      get('SELECT sessions_used FROM subscriptions WHERE member_id = ?', [member.id]),
    );
    assert.equal(sub.sessions_used, 1);
  });
});

describe('rescan window boundaries', () => {
  const openVisitAt = (code, checkIn) =>
    inZone('Asia/Kolkata', () => {
      run('INSERT INTO members (code, first_name, joined_on) VALUES (?, ?, ?)', [code, code, '2026-08-01']);
      const member = get('SELECT * FROM members WHERE code = ?', [code]);
      const plan = get("SELECT id FROM plans WHERE name = 'TZ Personal Training'");
      run(
        `INSERT INTO subscriptions (member_id, plan_id, start_date, end_date, price, status)
         VALUES (?, ?, ?, ?, 1000, 'active')`,
        [member.id, plan.id, addDays(today(), -30), addDays(today(), 300)],
      );
      run('INSERT INTO attendance (member_id, check_in, source) VALUES (?, ?, ?)', [
        member.id,
        checkIn,
        'desk',
      ]);
      return member;
    });

  it('closes a visit opened two hours ago', () => {
    const member = openVisitAt('TZ0003', utcTimestamp(-2 * 3_600_000));
    const result = inZone('Asia/Kolkata', () => performCheckIn(member, 'desk'));
    assert.equal(result.action, 'checked_out');
  });

  it('treats a visit left open 30 hours ago as abandoned and checks in fresh', () => {
    const member = openVisitAt('TZ0004', utcTimestamp(-30 * 3_600_000));
    const result = inZone('Asia/Kolkata', () => performCheckIn(member, 'desk'));
    assert.equal(result.action, 'checked_in');
  });
});

describe('gym-local date arithmetic', () => {
  it('startOfMonth walks back across a year boundary', () => {
    assert.equal(startOfMonth('2026-08-06'), '2026-08-01');
    assert.equal(startOfMonth('2026-08-06', 5), '2026-03-01');
    assert.equal(startOfMonth('2026-01-15', 1), '2025-12-01');
    assert.equal(startOfMonth('2026-01-15', 11), '2025-02-01');
  });

  it('gymMonthDay tracks the gym, not UTC', () => {
    assert.equal(gymMonthDay.call(null) === undefined, false);
    const ahead = inZone('Pacific/Kiritimati', gymMonthDay);
    const behind = inZone('Pacific/Midway', gymMonthDay);
    assert.notEqual(ahead, behind);
  });
});

describe('attendance and reports run on the gym clock end to end', () => {
  let token;
  let prefix;

  before(async () => {
    const signup = await call('POST', '/api/platform/signup', {
      slug: 'dawn-fitness',
      gym_name: 'Dawn Fitness',
      admin_name: 'Owner',
      admin_email: 'owner@dawn.test',
      admin_password: 'dawn12345',
      currency: 'INR',
      timezone: 'Asia/Kolkata',
    });
    assert.equal(signup.status, 201);
    token = signup.body.token;
    prefix = '/g/dawn-fitness';

    // A 05:00 IST visit, stored as the UTC instant it really is.
    tenantStorage.run(
      {
        slug: 'dawn-fitness',
        dbFile: path.join(process.env.TENANTS_DIR, 'dawn-fitness.db'),
        timezone: 'Asia/Kolkata',
      },
      () => {
        run("INSERT INTO members (code, first_name, joined_on) VALUES ('GM9001', 'Dawn', '2026-08-01')");
        const member = get("SELECT id FROM members WHERE code = 'GM9001'");
        run(
          "INSERT INTO attendance (member_id, check_in, check_out, source) VALUES (?, '2026-08-05 23:30:00', '2026-08-06 01:00:00', 'desk')",
          [member.id],
        );
      },
    );
  });

  it('finds the visit by the gym-local date the member would name', async () => {
    const res = await call('GET', `${prefix}/api/attendance?date=2026-08-06`, null, { token });
    assert.equal(res.status, 200);
    assert.equal(res.body.items.length, 1);
    assert.equal(res.body.items[0].member_code, 'GM9001');
  });

  it('does not find it under the UTC date', async () => {
    const res = await call('GET', `${prefix}/api/attendance?date=2026-08-05`, null, { token });
    assert.equal(res.body.items.length, 0);
  });

  it('reports it in the 5am slot of the peak-hour histogram', async () => {
    const res = await call(
      'GET',
      `${prefix}/api/reports/attendance?from=2026-08-01&to=2026-08-31`,
      null,
      { token },
    );
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.per_hour.map((r) => r.hour),
      [5],
    );
    assert.deepEqual(
      res.body.per_day.map((r) => r.day),
      ['2026-08-06'],
    );
  });

  it('exports the visit in gym-local wall-clock time', async () => {
    const res = await fetch(`${base}${prefix}/api/reports/export/attendance`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const csv = await res.text();
    assert.match(csv, /2026-08-06 05:00:00/);
    assert.match(csv, /2026-08-06 06:30:00/);
    assert.doesNotMatch(csv, /2026-08-05 23:30:00/);
  });
});
