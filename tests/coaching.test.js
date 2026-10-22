import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { memberToken } from './helpers/memberAuth.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-coaching-test-'));
process.env.DB_FILE = path.join(tmpDir, 'default.db');
process.env.PLATFORM_DB_FILE = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.AUTH_SECRET = 'test-secret';
process.env.WHATSAPP_MESSAGE_GAP_MS = '0';

const { createApp } = await import('../src/app.js');
const { closeDb, tenantStorage } = await import('../src/db.js');
const { closeRegistryDb, findTenantBySlug, tenantDbPath } = await import('../src/tenants.js');
const { addDays, today } = await import('../src/validate.js');
const { sentInMemory } = await import('../src/whatsapp.js');
const { rankMarks, testStats } = await import('../src/coaching/ranks.js');
const { buildSchedule } = await import('../src/coaching/fees.js');
const { sendCoachingFeeReminders } = await import('../src/coaching/sweep.js');

let root;
let server;
let token;
const SLUG = 'apex-institute';

const call = async (method, urlPath, body, { useToken = token, slug = SLUG, raw = null, contentType = null } = {}) => {
  const res = await fetch(`${root}${slug ? `/g/${slug}` : ''}${urlPath}`, {
    method,
    headers: {
      ...(raw ? { 'Content-Type': contentType } : body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(useToken ? { Authorization: `Bearer ${useToken}` } : {}),
    },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const type = res.headers.get('content-type') || '';
  if (!type.includes('json')) return { status: res.status, body: null, bytes: Buffer.from(await res.arrayBuffer()), type };
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

/** The member-auth helper's call shape: (method, path, body, { token }). */
const memberCall = (method, urlPath, body, opts = {}) => call(method, urlPath, body, { useToken: opts.token });

const signup = (overrides) =>
  call(
    'POST',
    '/api/platform/signup',
    {
      admin_name: 'Rakesh Sharma',
      admin_password: 'strongpass123',
      currency: 'INR',
      ...overrides,
    },
    { useToken: null, slug: null },
  );

const withWhatsApp = async (fn) => {
  process.env.WHATSAPP_TRANSPORT = 'memory';
  try {
    return await fn();
  } finally {
    delete process.env.WHATSAPP_TRANSPORT;
  }
};

/** Lets queued sends (and their delivery-log writes) settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  root = `http://127.0.0.1:${server.address().port}`;

  const res = await signup({ slug: SLUG, gym_name: 'Apex Institute', admin_email: 'director@apex.test', business_type: 'coaching' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  token = res.body.token;
});

after(() => {
  server.close();
  closeDb();
  closeRegistryDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

let course;
let batch;
let physics;
let chemistry;

async function createStudent(first, extra = {}) {
  const res = await call('POST', '/api/members', { first_name: first, last_name: 'Kumar', phone: '9800000001', ...extra });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

/* ── The vertical itself ─────────────────────────────────────────────── */

describe('CoachBook as the third vertical', () => {
  it('signs up as coaching and reports CoachBook on the public tenant call', async () => {
    assert.equal(findTenantBySlug(SLUG).business_type, 'coaching');
    const ctx = await call('GET', '/api/platform/tenant', undefined, { useToken: null });
    assert.equal(ctx.status, 200);
    assert.equal(ctx.body.tenant.business_type, 'coaching');
    assert.equal(ctx.body.tenant.vertical.brand, 'CoachBook');
    assert.equal(ctx.body.tenant.vertical.tagline, 'Coaching & Institute Management');
    for (const module of ['batches', 'admissions', 'fees', 'installments', 'attendance', 'timetable', 'tests', 'materials', 'whatsapp']) {
      assert.ok(ctx.body.tenant.vertical.modules.includes(module), `${module} should be enabled`);
    }
    assert.ok(!ctx.body.tenant.vertical.modules.includes('seats'));
    assert.ok(!ctx.body.tenant.vertical.modules.includes('fitness'));
    assert.equal(ctx.body.tenant.theme, 'indigo');
  });

  it('numbers students CB0001 and seeds a starter course, batch and fee structure', async () => {
    const first = await createStudent('Aarav');
    assert.equal(first.code, 'CB0001');
    const courses = await call('GET', '/api/coaching/courses');
    assert.equal(courses.status, 200);
    assert.equal(courses.body.items.length, 1);
    course = courses.body.items[0];
    assert.deepEqual(course.subjects.map((s) => s.name), ['Physics', 'Chemistry', 'Mathematics']);
    assert.equal(course.fee_structures[0].total_fee, 45000);
    assert.equal(course.fee_structures[0].installments, 3);
    [physics, chemistry] = course.subjects;
    const batches = await call('GET', '/api/coaching/batches');
    batch = batches.body.items[0];
    assert.equal(batch.code, 'B12A');
    assert.equal(batch.enrolled, 0);
  });

  it('keeps CoachBook out of gym and library accounts', async () => {
    const gym = await signup({ slug: 'iron-gym', gym_name: 'Iron Gym', admin_email: 'a@iron.test' });
    const lib = await signup({ slug: 'quiet-hall', gym_name: 'Quiet Hall', admin_email: 'a@quiet.test', business_type: 'library' });
    for (const [slug, t] of [['iron-gym', gym.body.token], ['quiet-hall', lib.body.token]]) {
      const res = await call('GET', '/api/coaching/dashboard', undefined, { slug, useToken: t });
      assert.equal(res.status, 404);
      assert.equal(res.body.details.code, 'module_not_enabled');
      const portal = await call('GET', '/api/coaching/courses', undefined, { slug, useToken: t });
      assert.equal(portal.status, 404);
    }
    // And the gym's own world is untouched: plans seeded, GM codes, no course.
    const plans = await call('GET', '/api/plans', undefined, { slug: 'iron-gym', useToken: gym.body.token });
    assert.equal(plans.body.items?.length ?? plans.body.length, 3);
    const member = await call('POST', '/api/members', { first_name: 'Ravi' }, { slug: 'iron-gym', useToken: gym.body.token });
    assert.equal(member.body.code, 'GM0001');
  });

  it('refuses anonymous callers before revealing anything', async () => {
    const res = await call('GET', '/api/coaching/courses', undefined, { useToken: null });
    assert.equal(res.status, 401);
  });
});

/* ── Academic structure ──────────────────────────────────────────────── */

describe('courses, subjects and batches', () => {
  it('creates a course with subjects and a batch, refusing a duplicate batch code', async () => {
    const created = await call('POST', '/api/coaching/courses', {
      name: 'NEET Dropper 2027',
      academic_year: '2026-2027',
      target_exam: 'NEET-UG',
      subjects: [{ name: 'Biology' }, { name: 'Physics' }],
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.subjects.length, 2);

    const dup = await call('POST', '/api/coaching/batches', {
      course_id: created.body.id, name: 'Clash', code: 'b12a', start_date: today(),
    });
    assert.equal(dup.status, 409);

    const neet = await call('POST', '/api/coaching/batches', {
      course_id: created.body.id, name: 'NEET Super-30', code: 'NS30', capacity: 1, start_date: today(), weekdays: [6, 0],
    });
    assert.equal(neet.status, 201);
    assert.equal(neet.body.weekdays, '0,6');
  });

  it('archives rather than deletes a course somebody is enrolled in', async () => {
    const tmp = await call('POST', '/api/coaching/courses', { name: 'Empty course', academic_year: '2026-2027' });
    const del = await call('DELETE', `/api/coaching/courses/${tmp.body.id}`);
    assert.equal(del.body.archived, false);
  });
});

/* ── Enrollment and the installment engine ───────────────────────────── */

describe('admission with an installment fee plan', () => {
  let student;
  let plan;

  it('splits a fee evenly with the remainder on the first installment', () => {
    const schedule = buildSchedule({ total: 45001, installments: 3, startDate: '2026-04-01', intervalDays: 60 });
    assert.deepEqual(schedule.map((s) => s.amount_due), [15001, 15000, 15000]);
    assert.deepEqual(schedule.map((s) => s.due_date), ['2026-04-01', '2026-05-31', '2026-07-30']);
    assert.equal(schedule[0].label, 'At admission');
  });

  it('enrolls with a roll number and opens a 3-installment plan after a concession', async () => {
    student = await createStudent('Priya', { emergency_contact: 'Suresh Kumar', emergency_phone: '9811111111' });
    const res = await call('POST', '/api/coaching/enrollments', {
      member_id: student.id,
      batch_id: batch.id,
      fee: {
        fee_structure_id: course.fee_structures[0].id,
        total_amount: 48000,
        discount_amount: 3000,
        discount_reason: 'Sibling concession',
        installments: 3,
        interval_days: 60,
        components: [{ label: 'Tuition', amount: 42000 }, { label: 'Study material', amount: 6000 }],
      },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.enrollment.roll_number, 'B12A-01');
    plan = res.body.fee_plan;
    assert.equal(plan.final_amount, 45000);
    assert.deepEqual(plan.installments.map((i) => i.amount_due), [15000, 15000, 15000]);
    assert.equal(plan.installments[0].due_date, today());
    assert.equal(plan.balance, 45000);
  });

  it('counts the fee plan in the student balance', async () => {
    const member = await call('GET', `/api/members/${student.id}`);
    assert.equal(member.body.balance_due, 45000);
  });

  it('spreads a part payment across installments, oldest first, and refuses an overpayment', async () => {
    const paid = await call('POST', `/api/coaching/fees/plans/${plan.id}/payments`, { amount: 20000, method: 'upi', send_receipt: false });
    assert.equal(paid.status, 201, JSON.stringify(paid.body));
    assert.deepEqual(paid.body.items.map((i) => [i.installment_number, i.amount]), [[1, 15000], [2, 5000]]);
    const [first, second, third] = paid.body.plan.installments;
    assert.equal(first.status, 'paid');
    assert.equal(second.status, 'partially_paid');
    assert.equal(second.balance, 10000);
    assert.equal(third.status, 'pending');
    assert.equal(paid.body.plan.balance, 25000);
    assert.equal(paid.body.receipt_no, `FEE-${String(paid.body.payment_id).padStart(5, '0')}`);

    const member = await call('GET', `/api/members/${student.id}`);
    assert.equal(member.body.balance_due, 25000, 'payments net off against the fee plan, not into credit');

    const over = await call('POST', `/api/coaching/fees/plans/${plan.id}/payments`, { amount: 25001 });
    assert.equal(over.status, 409);
  });

  it('serves a PDF fee receipt and undoes a payment cleanly', async () => {
    const extra = await call('POST', `/api/coaching/fees/plans/${plan.id}/payments`, { amount: 1000, send_receipt: false });
    const pdf = await call('GET', `/api/coaching/fees/payments/${extra.body.payment_id}/receipt`);
    assert.equal(pdf.status, 200);
    assert.equal(pdf.type, 'application/pdf');
    assert.equal(pdf.bytes.subarray(0, 4).toString(), '%PDF');

    const del = await call('DELETE', `/api/coaching/fees/payments/${extra.body.payment_id}`);
    assert.equal(del.status, 200);
    assert.equal(del.body.plan.balance, 25000);
  });

  it('holds a cheque as pending, and a bounce puts the installment back', async () => {
    const cheque = await call('POST', `/api/coaching/fees/plans/${plan.id}/payments`, {
      amount: 10000, method: 'cheque', cheque_no: '004512', send_receipt: false,
    });
    assert.equal(cheque.status, 201);
    assert.equal(cheque.body.plan.installments[1].status, 'paid');
    const summary = await call('GET', '/api/coaching/fees/summary');
    assert.equal(summary.body.pending_cheques, 1);

    const bounced = await call('POST', `/api/coaching/fees/payments/${cheque.body.payment_id}/cheque`, { action: 'bounce' });
    assert.equal(bounced.body.bounced, true);
    assert.equal(bounced.body.plan.installments[1].balance, 10000);
  });

  it('flags an installment past its date as overdue and lists it in dues', async () => {
    const late = await createStudent('Kabir');
    const res = await call('POST', '/api/coaching/fees/plans', {
      member_id: late.id,
      course_id: course.id,
      batch_id: batch.id,
      total_amount: 10000,
      schedule: [
        { amount_due: 4000, due_date: addDays(today(), -10) },
        { amount_due: 6000, due_date: addDays(today(), 3) },
      ],
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.effective_status, 'overdue');
    assert.equal(res.body.overdue_amount, 4000);
    const dues = await call('GET', '/api/coaching/fees/dues?window=overdue');
    assert.ok(dues.body.items.some((d) => d.member_id === late.id && d.days_overdue === 10));

    const mismatch = await call('POST', '/api/coaching/fees/plans', {
      member_id: late.id, course_id: course.id, total_amount: 10000, schedule: [{ amount_due: 9000, due_date: today() }],
    });
    assert.equal(mismatch.status, 400, 'a schedule that does not add up is refused');
  });

  it('sends the due-soon reminder once and the overdue one to the guardian', async () => {
    await withWhatsApp(async () => {
      const store = { slug: SLUG, dbFile: tenantDbPath(SLUG), businessType: 'coaching' };
      const before = sentInMemory.length;
      const queued = tenantStorage.run(store, () => sendCoachingFeeReminders({ gymName: 'Apex Institute' }));
      assert.ok(queued >= 2, `expected the overdue and the due-in-3-days installments, got ${queued}`);
      const again = tenantStorage.run(store, () => sendCoachingFeeReminders({ gymName: 'Apex Institute' }));
      assert.equal(again, 0, 're-running the hourly sweep sends nothing new');
      const messages = sentInMemory.slice(before);
      assert.ok(messages.some((m) => m.type === 'fee_due' && /still pending/.test(m.message)));
      assert.ok(messages.some((m) => m.type === 'fee_due' && /is due on/.test(m.message)));
    });
  });

  it('refuses a full batch unless told to squeeze one in', async () => {
    const neet = (await call('GET', '/api/coaching/batches')).body.items.find((b) => b.code === 'NS30');
    const a = await createStudent('Isha');
    const b = await createStudent('Dev');
    assert.equal((await call('POST', '/api/coaching/enrollments', { member_id: a.id, batch_id: neet.id })).status, 201);
    const full = await call('POST', '/api/coaching/enrollments', { member_id: b.id, batch_id: neet.id });
    assert.equal(full.status, 409);
    assert.equal(full.body.details.code, 'batch_full');
    const forced = await call('POST', '/api/coaching/enrollments', { member_id: b.id, batch_id: neet.id, allow_over_capacity: true });
    assert.equal(forced.status, 201);
  });

  it('rolls an enrollment back when its fee plan is refused', async () => {
    const s = await createStudent('Meera');
    const res = await call('POST', '/api/coaching/enrollments', {
      member_id: s.id, batch_id: batch.id, fee: { total_amount: 1000, discount_amount: 2000 },
    });
    assert.equal(res.status, 400);
    const academics = await call('GET', `/api/coaching/students/${s.id}/academics`);
    assert.equal(academics.body.enrollments.length, 0);
  });
});

/* ── Attendance & absentee alerts ────────────────────────────────────── */

describe('batch attendance with parent alerts', () => {
  let present;
  let absent;

  before(async () => {
    present = await createStudent('Rohan');
    absent = await createStudent('Sneha', { emergency_phone: '9822222222' });
    for (const s of [present, absent]) {
      assert.equal((await call('POST', '/api/coaching/enrollments', { member_id: s.id, batch_id: batch.id })).status, 201);
    }
  });

  it('alerts the guardian of an absent student exactly once', async () => {
    await withWhatsApp(async () => {
      const before = sentInMemory.length;
      const res = await call('PUT', '/api/coaching/attendance/sheet', {
        batch_id: batch.id,
        subject_id: physics.id,
        entries: [
          { member_id: present.id, status: 'present' },
          { member_id: absent.id, status: 'absent' },
        ],
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.alerts.queued, 1);
      await settle();
      const alerts = sentInMemory.slice(before);
      assert.equal(alerts.length, 1);
      assert.equal(alerts[0].phone, '9822222222', 'goes to the guardian, not the student');
      assert.equal(alerts[0].type, 'absence');
      assert.match(alerts[0].message, /Sneha Kumar was marked ABSENT today/);
      assert.match(alerts[0].message, /Physics/);

      const again = await call('PUT', '/api/coaching/attendance/sheet', {
        batch_id: batch.id, subject_id: physics.id, entries: [{ member_id: absent.id, status: 'absent' }],
      });
      assert.equal(again.body.alerts.queued, 0, 're-saving the sheet does not message the parent twice');
      assert.equal(sentInMemory.length, before + 1);
    });
  });

  it('logs the alert under its own WhatsApp type', async () => {
    const logs = await call('GET', '/api/whatsapp/logs');
    assert.ok(logs.body.items.some((l) => l.type === 'absence'));
  });

  it('refuses a student who is not on the roster and a future date', async () => {
    const outsider = await createStudent('Outsider');
    const res = await call('PUT', '/api/coaching/attendance/sheet', {
      batch_id: batch.id, entries: [{ member_id: outsider.id, status: 'present' }],
    });
    assert.equal(res.status, 400);
    const future = await call('PUT', '/api/coaching/attendance/sheet', {
      batch_id: batch.id, date: addDays(today(), 1), entries: [{ member_id: present.id, status: 'present' }],
    });
    assert.equal(future.status, 400);
  });

  it('computes percentages with excused days left out', async () => {
    await call('PUT', '/api/coaching/attendance/sheet', {
      batch_id: batch.id, subject_id: chemistry.id, notify: false,
      entries: [{ member_id: present.id, status: 'excused' }, { member_id: absent.id, status: 'late' }],
    });
    const report = await call('GET', `/api/coaching/attendance/report?batch_id=${batch.id}`);
    const rowFor = (id) => report.body.items.find((r) => r.member_id === id);
    assert.equal(rowFor(present.id).percentage, 100);
    assert.equal(rowFor(absent.id).percentage, 50);
    assert.equal(report.body.lectures, 2);
  });

  it('marks a student present for the day when they scan in at the gate', async () => {
    const scanner = await createStudent('Gate');
    await call('POST', '/api/coaching/enrollments', { member_id: scanner.id, batch_id: batch.id });
    // The scan only marks a batch that has a lecture today, and the starter
    // batch meets Mon/Wed/Fri — so meet today, whatever day the suite runs.
    const todayWeekday = new Date(`${today()}T00:00:00Z`).getUTCDay();
    const weekdays = String(batch.weekdays).split(',').map(Number);
    assert.equal((await call('PATCH', `/api/coaching/batches/${batch.id}`, { weekdays: [...weekdays, todayWeekday] })).status, 200);
    try {
      const res = await call('POST', '/api/attendance/check-in', { member_id: scanner.id });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.membership.session_name, batch.name);
      const sheet = await call('GET', `/api/coaching/attendance/sheet?batch_id=${batch.id}`);
      const row = sheet.body.items.find((i) => i.member_id === scanner.id);
      assert.equal(row.status, 'present');
      assert.equal(row.source, 'scan');
    } finally {
      await call('PATCH', `/api/coaching/batches/${batch.id}`, { weekdays });
    }

    const stranger = await createStudent('NotEnrolled');
    const refused = await call('POST', '/api/attendance/check-in', { member_id: stranger.id });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /not enrolled/);
  });

  it('lets a teacher take attendance but keeps the fees from them', async () => {
    const created = await call('POST', '/api/staff', { name: 'Prof Sharma', email: 'sharma@apex.test', password: 'teacherpass1', role: 'trainer' });
    assert.equal(created.status, 201);
    const login = await call('POST', '/api/auth/login', { email: 'sharma@apex.test', password: 'teacherpass1' }, { useToken: null });
    const teacher = login.body.token;
    const sheet = await call('PUT', '/api/coaching/attendance/sheet', {
      batch_id: batch.id, subject_id: physics.id, notify: false, entries: [{ member_id: present.id, status: 'present' }],
    }, { useToken: teacher });
    assert.equal(sheet.status, 200);
    const fees = await call('GET', '/api/coaching/fees/summary', undefined, { useToken: teacher });
    assert.equal(fees.status, 403);
    const dash = await call('GET', '/api/coaching/dashboard', undefined, { useToken: teacher });
    assert.equal(dash.status, 200);
    assert.equal(dash.body.fees, null, 'no money on a teacher’s dashboard');
  });
});

/* ── Timetable collisions ────────────────────────────────────────────── */

describe('timetable collision detection', () => {
  let teacherId;
  let otherBatch;

  before(async () => {
    teacherId = (await call('GET', '/api/staff')).body.items.find((u) => u.email === 'sharma@apex.test').id;
    otherBatch = (
      await call('POST', '/api/coaching/batches', { course_id: course.id, name: 'Batch 12-B', code: 'B12B', start_date: today(), room: 'Room 202' })
    ).body;
  });

  it('refuses a teacher in two rooms at once, unless overridden', async () => {
    const first = await call('POST', '/api/coaching/timetable', {
      batch_id: batch.id, subject_id: physics.id, faculty_id: teacherId, weekday: 1, start_time: '16:00', end_time: '17:30',
    });
    assert.equal(first.status, 201, JSON.stringify(first.body));

    const clash = await call('POST', '/api/coaching/timetable', {
      batch_id: otherBatch.id, subject_id: physics.id, faculty_id: teacherId, weekday: 1, start_time: '17:00', end_time: '18:00',
    });
    assert.equal(clash.status, 409);
    assert.equal(clash.body.details.code, 'timetable_conflict');
    assert.deepEqual(clash.body.details.conflicts[0].reasons, ['faculty']);

    const backToBack = await call('POST', '/api/coaching/timetable', {
      batch_id: otherBatch.id, subject_id: physics.id, faculty_id: teacherId, weekday: 1, start_time: '17:30', end_time: '18:30',
    });
    assert.equal(backToBack.status, 201, 'a lecture that starts as the last one ends is fine');

    const forced = await call('POST', '/api/coaching/timetable', {
      batch_id: otherBatch.id, subject_id: chemistry.id, faculty_id: teacherId, weekday: 1, start_time: '16:30', end_time: '17:00', override: true,
    });
    assert.equal(forced.status, 201);
    assert.ok(forced.body.overridden_conflicts.length >= 1);
    const week = await call('GET', '/api/coaching/timetable');
    assert.ok(week.body.conflicts.length >= 1, 'an overridden clash stays on the week’s clash list');
  });

  it('refuses the same room for two batches, matching names loosely', async () => {
    const res = await call('POST', '/api/coaching/timetable', {
      batch_id: batch.id, subject_id: chemistry.id, weekday: 2, start_time: '10:00', end_time: '11:00', room: 'Room 202',
    });
    assert.equal(res.status, 201);
    const clash = await call('POST', '/api/coaching/timetable', {
      batch_id: otherBatch.id, subject_id: chemistry.id, weekday: 2, start_time: '10:30', end_time: '11:30', room: ' room 202 ',
    });
    assert.equal(clash.status, 409);
    assert.ok(clash.body.details.conflicts[0].reasons.includes('room'));
  });

  it('warns when the room is smaller than the batch', async () => {
    await call('POST', '/api/coaching/classrooms', { name: 'Cabin 1', capacity: 2 });
    const res = await call('POST', '/api/coaching/timetable', {
      batch_id: batch.id, subject_id: physics.id, weekday: 4, start_time: '09:00', end_time: '10:00', room: 'Cabin 1',
    });
    assert.equal(res.status, 201);
    assert.match(res.body.warnings[0], /Cabin 1 seats 2/);
  });

  it('logs a lecture with its timetabled length for the teacher’s workload', async () => {
    const monday = (() => {
      let d = today();
      while (new Date(`${d}T00:00:00Z`).getUTCDay() !== 1) d = addDays(d, -1);
      return d;
    })();
    const log = await call('POST', '/api/coaching/lecture-logs', {
      batch_id: batch.id, subject_id: physics.id, lecture_date: monday, topic: 'Kinematics: projectile motion',
    });
    assert.equal(log.status, 201, JSON.stringify(log.body));
    assert.equal(log.body.duration_min, 90);
    assert.equal(log.body.faculty_id, teacherId);
  });
});

/* ── Tests, ranks and scorecards ─────────────────────────────────────── */

describe('ranking', () => {
  it('ranks ties together and skips the next place, leaving absentees out', () => {
    const rows = rankMarks([
      { id: 1, marks_obtained: 88, is_absent: 0 },
      { id: 2, marks_obtained: 94, is_absent: 0 },
      { id: 3, marks_obtained: 88, is_absent: 0 },
      { id: 4, marks_obtained: 60, is_absent: 0 },
      { id: 5, marks_obtained: 0, is_absent: 1 },
    ]);
    assert.deepEqual(rows.map((r) => r.rank), [2, 1, 2, 4, null]);
    assert.equal(rows[1].percentile, 100);
    assert.equal(rows[3].percentile, 25);
    const stats = testStats(rows, { maxMarks: 100 });
    assert.equal(stats.appeared, 4);
    assert.equal(stats.highest, 94);
    assert.equal(stats.average, 82.5);
  });
});

describe('test series and scorecards', () => {
  let test;
  let students;

  before(async () => {
    const sheet = await call('GET', `/api/coaching/attendance/sheet?batch_id=${batch.id}`);
    students = sheet.body.items;
  });

  it('enters marks fast, ranks as it goes, and bounds marks by the paper', async () => {
    const created = await call('POST', '/api/coaching/tests', {
      batch_id: batch.id, subject_id: physics.id, title: 'Weekly Test 3: Electrostatics', test_type: 'weekly', test_date: today(), max_marks: 100,
    });
    assert.equal(created.status, 201);
    test = created.body;

    const tooHigh = await call('PUT', `/api/coaching/tests/${test.id}/marks`, { entries: [{ member_id: students[0].member_id, marks_obtained: 101 }] });
    assert.equal(tooHigh.status, 400);

    const entries = students.map((s, i) => (i === students.length - 1 ? { member_id: s.member_id, is_absent: true } : { member_id: s.member_id, marks_obtained: 90 - i * 10 }));
    const saved = await call('PUT', `/api/coaching/tests/${test.id}/marks`, { entries });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.items.find((i) => i.member_id === students[0].member_id).rank, 1);
    assert.equal(saved.body.stats.absent, 1);
    assert.equal(saved.body.stats.highest, 90);
  });

  it('keeps an unpublished result out of the student app', async () => {
    const t = await memberToken(memberCall, { staffToken: token, memberId: students[0].member_id });
    const res = await call('GET', '/api/portal/coaching/tests', undefined, { useToken: t });
    assert.equal(res.status, 200);
    assert.equal(res.body.tests.length, 0);
  });

  it('publishes and sends each parent a scorecard with rank and batch figures, once', async () => {
    await withWhatsApp(async () => {
      const before = sentInMemory.length;
      const res = await call('POST', `/api/coaching/tests/${test.id}/publish`, {});
      assert.equal(res.status, 200);
      assert.equal(res.body.whatsapp.queued, students.length - 1, 'every student who sat it, none who were absent');
      await settle();
      const cards = sentInMemory.slice(before).filter((m) => m.type === 'scorecard');
      assert.match(cards[0].message, /scored 90\/100 \(Rank: 1 of \d+\) in Weekly Test 3: Electrostatics at Apex Institute/);
      const again = await call('POST', `/api/coaching/tests/${test.id}/publish`, {});
      assert.equal(again.body.whatsapp.queued, 0);
    });
  });

  it('builds a report card with subject averages', async () => {
    const card = await call('GET', `/api/coaching/tests/students/${students[0].member_id}/report-card`);
    assert.equal(card.status, 200);
    assert.equal(card.body.tests[0].rank, 1);
    assert.equal(card.body.subjects[0].subject_name, 'Physics');
    assert.equal(card.body.overall_percentage, 90);
  });
});

/* ── Admissions CRM ──────────────────────────────────────────────────── */

describe('admissions pipeline', () => {
  it('moves a lead through the funnel and admits them as a student', async () => {
    const lead = await call('POST', '/api/coaching/inquiries', {
      student_name: 'Ananya Gupta', guardian_name: 'Rajesh Gupta', phone: '9833333333', course_id: course.id, source: 'referral',
    });
    assert.equal(lead.status, 201);
    const demo = await call('PATCH', `/api/coaching/inquiries/${lead.body.id}`, { status: 'demo_scheduled', demo_on: today() });
    assert.equal(demo.body.status, 'demo_scheduled');
    const noShortcut = await call('PATCH', `/api/coaching/inquiries/${lead.body.id}`, { status: 'admitted' });
    assert.equal(noShortcut.status, 400);

    const admitted = await call('POST', `/api/coaching/inquiries/${lead.body.id}/admit`, {
      batch_id: batch.id, fee: { total_amount: 45000, installments: 3, interval_days: 60 },
    });
    assert.equal(admitted.status, 201, JSON.stringify(admitted.body));
    assert.match(admitted.body.member.code, /^CB\d{4}$/);
    assert.equal(admitted.body.member.first_name, 'Ananya');
    assert.equal(admitted.body.member.last_name, 'Gupta');
    assert.equal(admitted.body.inquiry.status, 'admitted');
    assert.equal(admitted.body.fee_plan.installments.length, 3);
    const student = await call('GET', `/api/members/${admitted.body.member.id}`);
    assert.equal(student.body.emergency_contact, 'Rajesh Gupta');
    assert.equal(student.body.emergency_phone, '9833333333');

    const pipeline = await call('GET', '/api/coaching/inquiries');
    assert.equal(pipeline.body.counts.admitted, 1);
  });
});

/* ── Student & parent portal ─────────────────────────────────────────── */

describe('the student app', () => {
  let memberId;
  let studentToken;

  before(async () => {
    const sheet = await call('GET', `/api/coaching/attendance/sheet?batch_id=${batch.id}`);
    memberId = sheet.body.items.find((i) => i.first_name === 'Priya').member_id;
    studentToken = await memberToken(memberCall, { staffToken: token, memberId });
  });

  it('shows the student their timetable, attendance and fees', async () => {
    const overview = await call('GET', '/api/portal/coaching/overview', undefined, { useToken: studentToken });
    assert.equal(overview.status, 200, JSON.stringify(overview.body));
    assert.equal(overview.body.enrollments[0].batch_code, 'B12A');
    assert.ok(overview.body.fees.balance > 0);

    const timetable = await call('GET', '/api/portal/coaching/timetable', undefined, { useToken: studentToken });
    assert.ok(timetable.body.slots.every((s) => s.batch_id === batch.id), 'only their own batch’s lectures');

    const calendar = await call('GET', '/api/portal/coaching/attendance', undefined, { useToken: studentToken });
    assert.equal(calendar.status, 200);
    assert.equal(calendar.body.month, today().slice(0, 7));

    const fees = await call('GET', '/api/portal/coaching/fees', undefined, { useToken: studentToken });
    assert.equal(fees.body.plans[0].final_amount, 45000);
    const receipt = await call('GET', `/api/portal/coaching/fees/payments/${fees.body.payments[0].id}/receipt`, undefined, { useToken: studentToken });
    assert.equal(receipt.type, 'application/pdf');
  });

  it('serves study material for their batch only', async () => {
    const mine = await call('POST', `/api/coaching/materials/upload?title=Electrostatics+notes&kind=notes&batch_id=${batch.id}&file_name=notes.pdf`, undefined, {
      raw: Buffer.from('%PDF-1.4 test'), contentType: 'application/pdf',
    });
    assert.equal(mine.status, 201, JSON.stringify(mine.body));
    const neet = (await call('GET', '/api/coaching/batches')).body.items.find((b) => b.code === 'NS30');
    const theirs = await call('POST', '/api/coaching/materials', {
      title: 'NEET PYQs', kind: 'pyq', batch_id: neet.id, file_url: 'https://drive.example.com/pyq',
    });
    assert.equal(theirs.status, 201);
    const refused = await call('POST', `/api/coaching/materials/upload?title=Bad&file_name=x.exe`, undefined, {
      raw: Buffer.from('MZ'), contentType: 'application/x-msdownload',
    });
    assert.equal(refused.status, 400);

    const list = await call('GET', '/api/portal/coaching/materials', undefined, { useToken: studentToken });
    assert.deepEqual(list.body.items.map((m) => m.title), ['Electrostatics notes']);
    const file = await call('GET', `/api/portal/coaching/materials/${mine.body.id}/file`, undefined, { useToken: studentToken });
    assert.equal(file.status, 200);
    assert.equal(file.bytes.toString(), '%PDF-1.4 test');
    const blocked = await call('GET', `/api/portal/coaching/materials/${theirs.body.id}/file`, undefined, { useToken: studentToken });
    assert.equal(blocked.status, 404);
  });

  it('is closed to a gym member', async () => {
    const gymLogin = await call('POST', '/api/auth/login', { email: 'a@iron.test', password: 'strongpass123' }, { slug: 'iron-gym', useToken: null });
    const gymMember = (await call('GET', '/api/members', undefined, { slug: 'iron-gym', useToken: gymLogin.body.token })).body.items[0];
    const gymCall = (method, urlPath, body, opts = {}) => call(method, urlPath, body, { slug: 'iron-gym', useToken: opts.token });
    const t = await memberToken(gymCall, { staffToken: gymLogin.body.token, memberId: gymMember.id });
    const res = await call('GET', '/api/portal/coaching/overview', undefined, { slug: 'iron-gym', useToken: t });
    assert.equal(res.status, 404);
  });
});

describe('the dashboard', () => {
  it('summarises the institute in one call', async () => {
    const res = await call('GET', '/api/coaching/dashboard');
    assert.equal(res.status, 200);
    assert.ok(res.body.students.active >= 5);
    assert.ok(res.body.fees.collected > 0);
    assert.ok(res.body.fees.overdue_amount >= 4000);
    assert.equal(typeof res.body.attendance.threshold, 'number');
  });
});
