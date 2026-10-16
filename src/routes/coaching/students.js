import { Router } from 'express';
import { MANAGES_BILLING } from '../../auth.js';
import { all, get, run } from '../../db.js';
import { badRequest, conflict, forbidden, notFound } from '../../errors.js';
import { parse, today } from '../../validate.js';
import { requireModule } from '../../verticals.js';
import { studentAttendance } from '../../coaching/attendance.js';
import { ENROLLMENT_SELECT, enrollStudent, enrollmentsFor } from '../../coaching/enrollment.js';
import { componentsJson, createFeePlan, getPlan, plansForMember } from '../../coaching/fees.js';
import { idParam, optional, updateSql } from './shared.js';

/**
 * A student's academic side: which batches they are in, their fee plans,
 * attendance and test results — the panel on the student's page — and
 * enrolling them into a batch, optionally with the course fee plan in the
 * same step (the admission desk does both at once).
 */
export const studentRoutes = Router();
studentRoutes.use(['/students', '/enrollments'], requireModule('batches'));

studentRoutes.get('/students/:id/academics', (req, res) => {
  const memberId = idParam(req);
  if (!get('SELECT id FROM members WHERE id = ?', [memberId])) throw notFound('Student not found');
  const now = today();
  const monthStart = `${now.slice(0, 7)}-01`;
  const yearAgo = `${Number(now.slice(0, 4)) - 1}${now.slice(4)}`;
  res.json({
    enrollments: enrollmentsFor(memberId),
    fee_plans: plansForMember(memberId),
    attendance: {
      month: studentAttendance(memberId, { from: monthStart, to: now }).overall,
      year: studentAttendance(memberId, { from: yearAgo, to: now }),
    },
    tests: all(
      `SELECT t.id, t.title, t.test_type, t.test_date, t.max_marks, t.published_at, s.name AS subject_name, b.name AS batch_name,
              tm.marks_obtained, tm.rank, tm.percentile, tm.is_absent, tm.remarks,
              (SELECT COUNT(*) FROM academic_test_marks x WHERE x.test_id = t.id AND x.is_absent = 0) AS appeared
       FROM academic_test_marks tm
       JOIN academic_tests t ON t.id = tm.test_id
       JOIN academic_batches b ON b.id = t.batch_id
       LEFT JOIN academic_subjects s ON s.id = t.subject_id
       WHERE tm.member_id = ? ORDER BY t.test_date DESC, t.id DESC LIMIT 20`,
      [memberId],
    ),
  });
});

const FEE_INPUT = {
  fee_structure_id: { type: 'int', min: 1 },
  total_amount: { type: 'number', required: true, min: 0 },
  discount_amount: { type: 'number', min: 0, default: 0 },
  discount_reason: { type: 'string', max: 120 },
  installments: { type: 'int', min: 1, max: 12, default: 1 },
  interval_days: { type: 'int', min: 0, max: 365, default: 30 },
  start_date: { type: 'date' },
  note: { type: 'string', max: 300 },
};

/** The fee half of an admission, parsed the same way wherever it arrives. */
export function parseFeeInput(raw) {
  const fee = parse(raw, FEE_INPUT);
  fee.components = componentsJson(raw?.components);
  if (raw?.schedule !== undefined) fee.schedule = raw.schedule;
  return fee;
}

/**
 * Enrolls a student into a batch and, with `fee`, opens their course fee
 * plan in the same request. If the plan is refused (installments that don't
 * add up, say) the brand-new enrollment is taken back out, so a failed
 * admission leaves nothing half-done behind.
 */
export function enrollWithFee({ memberId, body, fee, user }) {
  if (fee && !MANAGES_BILLING.includes(user?.role)) throw forbidden('Only an admin or manager can set a fee plan');
  const before = get('SELECT id, status FROM batch_enrollments WHERE member_id = ? AND batch_id = ?', [memberId, body.batch_id]);
  const enrollmentId = enrollStudent({
    memberId,
    batchId: body.batch_id,
    rollNumber: body.roll_number,
    seatNo: body.seat_no,
    enrolledOn: body.enrolled_on,
    allowOverCapacity: Boolean(body.allow_over_capacity),
  });
  let planId = null;
  if (fee) {
    const batch = get('SELECT course_id FROM academic_batches WHERE id = ?', [body.batch_id]);
    try {
      planId = createFeePlan({ ...fee, member_id: memberId, course_id: batch.course_id, batch_id: body.batch_id });
    } catch (err) {
      if (!before) run('DELETE FROM batch_enrollments WHERE id = ?', [enrollmentId]);
      else run('UPDATE batch_enrollments SET status = ? WHERE id = ?', [before.status, enrollmentId]);
      throw err;
    }
  }
  return {
    enrollment: get(`${ENROLLMENT_SELECT} WHERE e.id = ?`, [enrollmentId]),
    fee_plan: planId ? getPlan(planId) : null,
  };
}

const ENROLL_FIELDS = {
  member_id: { type: 'int', required: true, min: 1 },
  batch_id: { type: 'int', required: true, min: 1 },
  roll_number: { type: 'string', max: 20 },
  seat_no: { type: 'string', max: 20 },
  enrolled_on: { type: 'date' },
  allow_over_capacity: { type: 'boolean', default: 0 },
};

studentRoutes.post('/enrollments', (req, res) => {
  const body = parse(req.body, ENROLL_FIELDS);
  const fee = req.body?.fee ? parseFeeInput(req.body.fee) : null;
  res.status(201).json(enrollWithFee({ memberId: body.member_id, body, fee, user: req.user }));
});

studentRoutes.patch('/enrollments/:id', (req, res) => {
  const id = idParam(req);
  const current = get('SELECT * FROM batch_enrollments WHERE id = ?', [id]);
  if (!current) throw notFound('Enrollment not found');
  const body = parse(req.body, optional({
    roll_number: { type: 'string', max: 20 },
    seat_no: { type: 'string', max: 20 },
    status: { type: 'enum', values: ['active', 'completed', 'dropped'] },
  }));
  if (body.roll_number && get('SELECT id FROM batch_enrollments WHERE batch_id = ? AND roll_number = ? AND id != ?', [current.batch_id, body.roll_number, id])) {
    throw conflict(`Roll number ${body.roll_number} is already taken in this batch`, { roll_number: 'taken' });
  }
  if (body.status === 'active' && current.status !== 'active') {
    const batch = get(
      `SELECT b.name, b.capacity, (SELECT COUNT(*) FROM batch_enrollments e WHERE e.batch_id = b.id AND e.status = 'active') AS enrolled
       FROM academic_batches b WHERE b.id = ?`,
      [current.batch_id],
    );
    if (batch.enrolled >= batch.capacity) throw conflict(`${batch.name} is full (${batch.enrolled}/${batch.capacity})`);
  }
  const { sql, params } = updateSql('batch_enrollments', body, id);
  run(sql, params);
  res.json(get(`${ENROLLMENT_SELECT} WHERE e.id = ?`, [id]));
});

/** Moves a student to another batch of the same course, keeping their history
 * in the old one (marked completed) — the "shift to the morning batch" case. */
studentRoutes.post('/enrollments/:id/transfer', (req, res) => {
  const id = idParam(req);
  const current = get(`${ENROLLMENT_SELECT} WHERE e.id = ?`, [id]);
  if (!current) throw notFound('Enrollment not found');
  if (current.status !== 'active') throw badRequest('Only an active enrollment can be transferred');
  const body = parse(req.body, { batch_id: { type: 'int', required: true, min: 1 }, allow_over_capacity: { type: 'boolean', default: 0 } });
  const target = get('SELECT * FROM academic_batches WHERE id = ?', [body.batch_id]);
  if (!target) throw notFound('Batch not found');
  if (target.id === current.batch_id) throw badRequest('The student is already in that batch');
  if (target.course_id !== current.course_id) throw badRequest('Transfers stay within the same course', { batch_id: 'different course' });

  const newId = enrollStudent({ memberId: current.member_id, batchId: target.id, allowOverCapacity: Boolean(body.allow_over_capacity) });
  run("UPDATE batch_enrollments SET status = 'completed' WHERE id = ?", [id]);
  run("UPDATE student_fee_plans SET batch_id = ? WHERE member_id = ? AND batch_id = ? AND status != 'cancelled'", [
    target.id,
    current.member_id,
    current.batch_id,
  ]);
  res.json(get(`${ENROLLMENT_SELECT} WHERE e.id = ?`, [newId]));
});

/** Undoing a mistaken enrollment. Once the student has attendance or marks in
 * the batch it is history, and is marked dropped instead. */
studentRoutes.delete('/enrollments/:id', (req, res) => {
  const id = idParam(req);
  const current = get('SELECT * FROM batch_enrollments WHERE id = ?', [id]);
  if (!current) throw notFound('Enrollment not found');
  const history =
    get('SELECT COUNT(*) AS n FROM batch_attendance WHERE batch_id = ? AND member_id = ?', [current.batch_id, current.member_id]).n
    + get(
      'SELECT COUNT(*) AS n FROM academic_test_marks tm JOIN academic_tests t ON t.id = tm.test_id WHERE t.batch_id = ? AND tm.member_id = ?',
      [current.batch_id, current.member_id],
    ).n;
  if (history) {
    run("UPDATE batch_enrollments SET status = 'dropped' WHERE id = ?", [id]);
    return res.json({ ok: true, dropped: true });
  }
  run('DELETE FROM batch_enrollments WHERE id = ?', [id]);
  return res.json({ ok: true, dropped: false });
});
