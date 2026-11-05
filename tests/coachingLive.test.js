import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { memberToken } from './helpers/memberAuth.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-coaching-live-test-'));
process.env.DB_FILE = path.join(tmpDir, 'default.db');
process.env.PLATFORM_DB_FILE = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.AUTH_SECRET = 'test-secret';

const { createApp } = await import('../src/app.js');
const { closeDb, get, run, tenantStorage } = await import('../src/db.js');
const { closeRegistryDb, tenantDbPath } = await import('../src/tenants.js');
const { today } = await import('../src/validate.js');

let root;
let server;
let admin;
const SLUG = 'vidya-live';
const OTHER = 'shiksha-live';

const call = async (method, urlPath, body, { useToken = admin, slug = SLUG } = {}) => {
  const res = await fetch(`${root}/g/${slug}${urlPath}`, {
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

const signup = async (slug, name, email, businessType = 'coaching') => {
  const res = await fetch(`${root}/api/platform/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      slug, gym_name: name, admin_name: 'Director', admin_email: email, admin_password: 'strongpass123', currency: 'INR', business_type: businessType,
    }),
  });
  const body = await res.json();
  assert.equal(res.status, 201, JSON.stringify(body));
  return body.token;
};

/** Runs `fn` against a tenant's own database, as a request would. */
const inTenant = (slug, fn) => tenantStorage.run({ slug, dbFile: tenantDbPath(slug), businessType: 'coaching' }, fn);

async function staffMember(name, email, role) {
  const created = await call('POST', '/api/staff', { name, email, password: 'staffpass123', role });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const login = await call('POST', '/api/auth/login', { email, password: 'staffpass123' }, { useToken: null });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return { id: login.body.user.id, token: login.body.token };
}

async function student(firstName, batches) {
  const created = await call('POST', '/api/members', { first_name: firstName, last_name: 'Sharma', phone: '9800000002' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const enrollments = [];
  for (const b of batches) {
    const res = await call('POST', '/api/coaching/enrollments', { member_id: created.body.id, batch_id: b.id });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    enrollments.push(res.body.enrollment);
  }
  const memberCall = (method, urlPath, body, opts = {}) => call(method, urlPath, body, { useToken: opts.token });
  return { id: created.body.id, enrollments, token: await memberToken(memberCall, { staffToken: admin, memberId: created.body.id }) };
}

const goLive = (body, useToken = admin) => call('POST', '/api/coaching/live/sessions', body, { useToken });
const endClass = (id, useToken = admin) => call('PATCH', `/api/coaching/live/sessions/${id}/end`, undefined, { useToken });
const activeFor = (who, slug = SLUG) => call('GET', '/api/portal/coaching/live/active', undefined, { useToken: who.token, slug });

let physics;
let chemistry;
let biology;
let batchA;
let batchB;
let batchC;
let verma; // allocated to batch A for Physics
let rao; // timetabled for batch B Chemistry
let iyer; // teaches nothing yet
let desk; // front desk
let aarav; // batch A
let diya; // batch B
let kabir; // batches A and B
let meera; // dropped out of batch A

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  root = `http://127.0.0.1:${server.address().port}`;
  admin = await signup(SLUG, 'Vidya Classes', 'director@vidya.test');

  const course = (await call('GET', '/api/coaching/courses')).body.items[0];
  [physics, chemistry] = course.subjects;
  batchA = (await call('GET', '/api/coaching/batches')).body.items.find((b) => b.code === 'B12A');
  batchB = (await call('POST', '/api/coaching/batches', { course_id: course.id, name: 'Batch 12-B', code: 'B12B', start_date: today() })).body;
  batchC = (await call('POST', '/api/coaching/batches', { course_id: course.id, name: 'Batch 12-C', code: 'B12C', start_date: today() })).body;
  const neet = await call('POST', '/api/coaching/courses', { name: 'NEET 2027', academic_year: '2026-2027', subjects: [{ name: 'Biology' }] });
  biology = neet.body.subjects[0];

  verma = await staffMember('Prof Verma', 'verma@vidya.test', 'trainer');
  rao = await staffMember('Prof Rao', 'rao@vidya.test', 'trainer');
  iyer = await staffMember('Prof Iyer', 'iyer@vidya.test', 'trainer');
  desk = await staffMember('Front Desk', 'desk@vidya.test', 'staff');
  const allocated = await call('POST', `/api/coaching/batches/${batchA.id}/faculty`, { faculty_id: verma.id, subject_id: physics.id });
  assert.equal(allocated.status, 201, JSON.stringify(allocated.body));
  const slot = await call('POST', '/api/coaching/timetable', {
    batch_id: batchB.id, subject_id: chemistry.id, faculty_id: rao.id, weekday: 2, start_time: '10:00', end_time: '11:00',
  });
  assert.equal(slot.status, 201, JSON.stringify(slot.body));

  aarav = await student('Aarav', [batchA]);
  diya = await student('Diya', [batchB]);
  kabir = await student('Kabir', [batchA, batchB]);
  meera = await student('Meera', [batchA]);
  const dropped = await call('PATCH', `/api/coaching/enrollments/${meera.enrollments[0].id}`, { status: 'dropped' });
  assert.equal(dropped.status, 200, JSON.stringify(dropped.body));
});

after(() => {
  server.close();
  closeDb();
  closeRegistryDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/* ── The tables ──────────────────────────────────────────────────────── */

describe('the live-class tables', () => {
  it('holds one live class per batch and per teacher in the database itself', () => {
    inTenant(SLUG, () => {
      const insert = (batchId, facultyId, status = 'live') => run(
        `INSERT INTO live_sessions (batch_id, subject_id, faculty_id, status, started_at, ended_at)
         VALUES (?, ?, ?, ?, datetime('now'), CASE WHEN ? = 'ended' THEN datetime('now') END)`,
        [batchId, physics.id, facultyId, status, status],
      );
      const first = insert(batchC.id, iyer.id).lastInsertRowid;
      assert.throws(() => insert(batchC.id, verma.id), /UNIQUE/, 'a second live class on the batch');
      assert.throws(() => insert(batchB.id, iyer.id), /UNIQUE/, 'the same teacher live twice');
      insert(batchC.id, verma.id, 'ended'); // ended classes are history, any number of them
      assert.throws(() => run("INSERT INTO live_sessions (batch_id, status) VALUES (?, 'live')", [batchB.id]), /CHECK/, 'live needs started_at');
      assert.throws(() => run("INSERT INTO live_sessions (batch_id, status) VALUES (?, 'ended')", [batchB.id]), /CHECK/, 'ended needs ended_at');
      run('DELETE FROM live_sessions WHERE batch_id = ?', [batchC.id]);
      assert.equal(get('SELECT id FROM live_sessions WHERE id = ?', [first]), undefined);
    });
  });

  it('keeps a poll’s answer among its options, one vote per student, and cascades with the session', () => {
    inTenant(SLUG, () => {
      const session = run(
        "INSERT INTO live_sessions (batch_id, subject_id, status, started_at, ended_at) VALUES (?, ?, 'ended', datetime('now'), datetime('now'))",
        [batchC.id, physics.id],
      ).lastInsertRowid;
      assert.throws(() => run("INSERT INTO live_polls (session_id, option_count, correct_option) VALUES (?, 2, 'C')", [session]), /CHECK/);
      assert.throws(() => run("INSERT INTO live_polls (session_id, correct_option) VALUES (?, 'E')", [session]), /CHECK/);
      assert.throws(() => run('INSERT INTO live_polls (session_id, duration_sec) VALUES (?, 2)', [session]), /CHECK/);
      const poll = run("INSERT INTO live_polls (session_id, correct_option) VALUES (?, 'B')", [session]).lastInsertRowid;
      run("INSERT INTO live_poll_votes (poll_id, member_id, choice, response_ms) VALUES (?, ?, 'B', 4210)", [poll, aarav.id]);
      assert.throws(() => run("INSERT INTO live_poll_votes (poll_id, member_id, choice, response_ms) VALUES (?, ?, 'A', 5000)", [poll, aarav.id]), /UNIQUE/);
      assert.throws(() => run("INSERT INTO live_poll_votes (poll_id, member_id, choice, response_ms) VALUES (?, ?, 'A', -1)", [poll, diya.id]), /CHECK/);
      run("INSERT INTO live_doubts (session_id, member_id, body) VALUES (?, ?, 'Why is g negative here?')", [session, diya.id]);
      assert.throws(() => run("INSERT INTO live_doubts (session_id, member_id, body) VALUES (?, ?, '')", [session, diya.id]), /CHECK/);
      const doubt = get('SELECT pinned, resolved FROM live_doubts WHERE session_id = ?', [session]);
      assert.deepEqual({ ...doubt }, { pinned: 0, resolved: 0 });

      run('DELETE FROM live_sessions WHERE id = ?', [session]);
      assert.equal(get('SELECT COUNT(*) AS n FROM live_polls WHERE session_id = ?', [session]).n, 0);
      assert.equal(get('SELECT COUNT(*) AS n FROM live_poll_votes WHERE poll_id = ?', [poll]).n, 0);
      assert.equal(get('SELECT COUNT(*) AS n FROM live_doubts WHERE session_id = ?', [session]).n, 0);
    });
  });
});

/* ── Going live ──────────────────────────────────────────────────────── */

let sessionA;
let sessionB;

describe('starting a live class', () => {
  it('lets a teacher allocated to the batch go live', async () => {
    const res = await goLive({ batch_id: batchA.id, subject_id: physics.id, title: 'Rotational motion', stream_url: 'https://live.vidya.test/b12a' }, verma.token);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    sessionA = res.body;
    assert.equal(sessionA.status, 'live');
    assert.equal(sessionA.faculty_id, verma.id);
    assert.equal(sessionA.faculty_name, 'Prof Verma');
    assert.equal(sessionA.batch_code, 'B12A');
    assert.equal(sessionA.subject_name, 'Physics');
    assert.match(sessionA.started_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.equal(sessionA.ended_at, null);
    assert.equal(sessionA.created_by, undefined, 'who pressed the button is not part of the session payload');
  });

  it('lets a teacher timetabled for the batch go live', async () => {
    const res = await goLive({ batch_id: batchB.id, subject_id: chemistry.id }, rao.token);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    sessionB = res.body;
    assert.equal(sessionB.stream_url, null);
  });

  it('refuses a second class on a batch that is already live', async () => {
    const res = await goLive({ batch_id: batchA.id, subject_id: chemistry.id, faculty_id: iyer.id });
    assert.equal(res.status, 409);
    assert.equal(res.body.details.code, 'batch_already_live');
    assert.equal(res.body.details.session_id, sessionA.id);
  });

  it('refuses a teacher who is already live with another batch', async () => {
    const res = await goLive({ batch_id: batchC.id, subject_id: physics.id, faculty_id: verma.id });
    assert.equal(res.status, 409);
    assert.equal(res.body.details.code, 'faculty_already_live');
    assert.equal(res.body.details.session_id, sessionA.id);
  });

  it('refuses a teacher who does not teach that subject to that batch', async () => {
    const unassigned = await goLive({ batch_id: batchC.id, subject_id: physics.id }, iyer.token);
    assert.equal(unassigned.status, 403);
    const otherBatch = await goLive({ batch_id: batchC.id, subject_id: physics.id }, rao.token);
    assert.equal(otherBatch.status, 403, 'timetabled for batch B is not batch C');
    const otherSubject = await goLive({ batch_id: batchB.id, subject_id: physics.id }, rao.token);
    assert.equal(otherSubject.status, 403, 'timetabled for Chemistry is not Physics');
  });

  it('refuses a teacher starting a class in someone else’s name', async () => {
    const res = await goLive({ batch_id: batchC.id, subject_id: physics.id, faculty_id: iyer.id }, verma.token);
    assert.equal(res.status, 403);
  });

  it('keeps the front desk and anonymous callers out', async () => {
    assert.equal((await goLive({ batch_id: batchC.id, subject_id: physics.id }, desk.token)).status, 403);
    assert.equal((await goLive({ batch_id: batchC.id, subject_id: physics.id }, null)).status, 401);
    assert.equal((await goLive({ batch_id: batchC.id, subject_id: physics.id }, aarav.token)).status, 401, 'a student token is not a staff token');
  });

  it('validates the batch, the subject and the stream link', async () => {
    assert.equal((await goLive({ batch_id: 9999, subject_id: physics.id })).status, 404);
    const mismatch = await goLive({ batch_id: batchC.id, subject_id: biology.id });
    assert.equal(mismatch.status, 400);
    assert.equal(mismatch.body.details.subject_id, 'mismatch');
    const missing = await goLive({ batch_id: batchC.id });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.details.subject_id, 'is required');
    for (const bad of ['javascript:alert(1)', 'not a url', 'data:text/html,hi']) {
      const res = await goLive({ batch_id: batchC.id, subject_id: physics.id, faculty_id: iyer.id, stream_url: bad });
      assert.equal(res.status, 400, bad);
      assert.ok(res.body.details.stream_url);
    }
    const teacherNotFound = await goLive({ batch_id: batchC.id, subject_id: physics.id, faculty_id: 9999 });
    assert.equal(teacherNotFound.status, 404);
  });

  it('lets a manager start a class for any teacher', async () => {
    const res = await goLive({ batch_id: batchC.id, subject_id: physics.id, faculty_id: iyer.id });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.faculty_id, iyer.id);
    assert.equal((await endClass(res.body.id)).status, 200);
  });
});

/* ── The student app ─────────────────────────────────────────────────── */

describe('the student’s live lecture', () => {
  it('shows a student their own batch’s class and nobody else’s', async () => {
    const a = await activeFor(aarav);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.deepEqual(a.body.items.map((s) => s.id), [sessionA.id]);
    assert.equal(a.body.items[0].stream_url, 'https://live.vidya.test/b12a');
    assert.equal(a.body.items[0].faculty_name, 'Prof Verma');

    const b = await activeFor(diya);
    assert.deepEqual(b.body.items.map((s) => s.id), [sessionB.id]);
  });

  it('shows a student in two batches both classes', async () => {
    const res = await activeFor(kabir);
    assert.deepEqual(res.body.items.map((s) => s.id).sort(), [sessionA.id, sessionB.id].sort());
  });

  it('shows nothing to a student who dropped out of the batch', async () => {
    const res = await activeFor(meera);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.items, []);
  });

  it('is closed to staff tokens and anonymous callers', async () => {
    assert.equal((await activeFor({ token: admin })).status, 401);
    assert.equal((await activeFor({ token: null })).status, 401);
  });
});

/* ── Ending ──────────────────────────────────────────────────────────── */

describe('ending a live class', () => {
  it('only lets the teacher taking it, or a manager, end it', async () => {
    assert.equal((await endClass(sessionA.id, rao.token)).status, 403);
    assert.equal((await endClass(sessionA.id, iyer.token)).status, 403);
    assert.equal((await endClass(sessionA.id, desk.token)).status, 403);
    assert.equal((await endClass(sessionA.id, aarav.token)).status, 401);
    const still = await activeFor(aarav);
    assert.deepEqual(still.body.items.map((s) => s.id), [sessionA.id], 'a refused end leaves the class on air');
  });

  it('takes the class off the batch’s student app, and only that batch’s', async () => {
    const res = await endClass(sessionA.id, verma.token);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.status, 'ended');
    assert.match(res.body.ended_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.ok(res.body.ended_at >= res.body.started_at);

    assert.deepEqual((await activeFor(aarav)).body.items, []);
    assert.deepEqual((await activeFor(kabir)).body.items.map((s) => s.id), [sessionB.id]);
    assert.deepEqual((await activeFor(diya)).body.items.map((s) => s.id), [sessionB.id]);
  });

  it('refuses to end a class twice, or one that does not exist', async () => {
    const again = await endClass(sessionA.id, verma.token);
    assert.equal(again.status, 409);
    assert.match(again.body.error, /already ended/);
    assert.equal((await endClass(9999)).status, 404);
    assert.equal((await call('PATCH', '/api/coaching/live/sessions/abc/end')).status, 400);
  });

  it('frees the batch and the teacher for the next class', async () => {
    const next = await goLive({ batch_id: batchA.id, subject_id: physics.id }, verma.token);
    assert.equal(next.status, 201, JSON.stringify(next.body));
    assert.notEqual(next.body.id, sessionA.id);
    assert.equal((await endClass(next.body.id)).status, 200, 'a manager can end a teacher’s class');
    assert.equal((await endClass(sessionB.id, rao.token)).status, 200);
    assert.deepEqual((await activeFor(kabir)).body.items, []);
  });
});

/* ── Other accounts ──────────────────────────────────────────────────── */

describe('isolation between accounts', () => {
  let otherAdmin;
  let otherStudent;
  let gymAdmin;

  before(async () => {
    otherAdmin = await signup(OTHER, 'Shiksha Academy', 'director@shiksha.test');
    gymAdmin = await signup('iron-live', 'Iron Gym', 'owner@iron.test', 'gym');
    const live = await goLive({ batch_id: batchA.id, subject_id: physics.id }, verma.token);
    assert.equal(live.status, 201);
    sessionA = live.body;

    const otherBatch = (await call('GET', '/api/coaching/batches', undefined, { useToken: otherAdmin, slug: OTHER })).body.items[0];
    const member = await call('POST', '/api/members', { first_name: 'Ishaan', phone: '9800000003' }, { useToken: otherAdmin, slug: OTHER });
    await call('POST', '/api/coaching/enrollments', { member_id: member.body.id, batch_id: otherBatch.id }, { useToken: otherAdmin, slug: OTHER });
    const memberCall = (method, urlPath, body, opts = {}) => call(method, urlPath, body, { useToken: opts.token, slug: OTHER });
    otherStudent = { token: await memberToken(memberCall, { staffToken: otherAdmin, memberId: member.body.id }) };
  });

  it('never shows one institute’s live class to another’s students', async () => {
    const res = await activeFor(otherStudent, OTHER);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.items, []);
  });

  it('cannot end another institute’s class by its id', async () => {
    const res = await call('PATCH', `/api/coaching/live/sessions/${sessionA.id}/end`, undefined, { useToken: otherAdmin, slug: OTHER });
    assert.equal(res.status, 404);
    assert.deepEqual((await activeFor(aarav)).body.items.map((s) => s.id), [sessionA.id], 'still live at home');
  });

  it('rejects one institute’s token at another institute', async () => {
    const res = await call('PATCH', `/api/coaching/live/sessions/${sessionA.id}/end`, undefined, { useToken: verma.token, slug: OTHER });
    assert.equal(res.status, 401);
    const peek = await call('GET', '/api/portal/coaching/live/active', undefined, { useToken: aarav.token, slug: OTHER });
    assert.equal(peek.status, 401);
  });

  it('is not part of a gym account', async () => {
    const res = await call('POST', '/api/coaching/live/sessions', { batch_id: 1, subject_id: 1 }, { useToken: gymAdmin, slug: 'iron-live' });
    assert.equal(res.status, 404);
    assert.equal(res.body.details.code, 'module_not_enabled');
  });
});
