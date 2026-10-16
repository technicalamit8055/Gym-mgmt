import { all, get, run } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { today } from '../validate.js';

/**
 * Putting a student into a batch.
 *
 * The student ID (CB0001) is the member code every vertical issues; a roll
 * number is the batch's own numbering on top of it — "B12A-07" is the seventh
 * student of batch B12A, the number a teacher calls out and writes on a
 * marks sheet. Issued in order and never reused within a batch, so a student
 * who drops out does not hand their roll number to the next admission.
 */

export function nextRollNumber(batchId) {
  const batch = get('SELECT code FROM academic_batches WHERE id = ?', [batchId]);
  if (!batch) throw notFound('Batch not found');
  const prefix = `${batch.code}-`;
  const row = get(
    `SELECT MAX(CAST(substr(roll_number, ?) AS INTEGER)) AS n FROM batch_enrollments
     WHERE batch_id = ? AND roll_number LIKE ?`,
    [prefix.length + 1, batchId, `${prefix}%`],
  );
  return `${prefix}${String((row?.n || 0) + 1).padStart(2, '0')}`;
}

export const ENROLLMENT_SELECT = `
  SELECT e.*, b.name AS batch_name, b.code AS batch_code, b.room, b.weekdays, b.start_time, b.end_time,
         b.start_date AS batch_start, b.end_date AS batch_end, b.course_id, c.name AS course_name, c.academic_year
  FROM batch_enrollments e
  JOIN academic_batches b ON b.id = e.batch_id
  JOIN academic_courses c ON c.id = b.course_id
`;

export const enrollmentsFor = (memberId) =>
  all(`${ENROLLMENT_SELECT} WHERE e.member_id = ? ORDER BY e.status = 'active' DESC, e.enrolled_on DESC`, [memberId]);

/**
 * Enrolls a student, refusing a full batch unless `allowOverCapacity` (the
 * desk squeezing one more in is a decision, not an accident). A student who
 * dropped out and comes back is re-activated on their old row, keeping their
 * roll number.
 */
export function enrollStudent({ memberId, batchId, rollNumber = null, seatNo = null, enrolledOn = null, allowOverCapacity = false }) {
  const member = get('SELECT id, first_name FROM members WHERE id = ?', [memberId]);
  if (!member) throw notFound('Student not found');
  const batch = get(
    `SELECT b.*, (SELECT COUNT(*) FROM batch_enrollments e WHERE e.batch_id = b.id AND e.status = 'active') AS enrolled
     FROM academic_batches b WHERE b.id = ?`,
    [batchId],
  );
  if (!batch) throw notFound('Batch not found');
  if (!batch.active) throw badRequest(`${batch.name} is archived`, { batch_id: 'archived' });

  const existing = get('SELECT * FROM batch_enrollments WHERE member_id = ? AND batch_id = ?', [memberId, batchId]);
  if (existing?.status === 'active') throw conflict(`${member.first_name} is already in ${batch.name}`);
  if (batch.enrolled >= batch.capacity && !allowOverCapacity) {
    throw conflict(`${batch.name} is full (${batch.enrolled}/${batch.capacity})`, { code: 'batch_full', capacity: batch.capacity });
  }
  if (rollNumber && get('SELECT id FROM batch_enrollments WHERE batch_id = ? AND roll_number = ? AND member_id != ?', [batchId, rollNumber, memberId])) {
    throw conflict(`Roll number ${rollNumber} is already taken in ${batch.name}`, { roll_number: 'taken' });
  }

  if (existing) {
    run(
      "UPDATE batch_enrollments SET status = 'active', roll_number = COALESCE(?, roll_number), seat_no = COALESCE(?, seat_no), enrolled_on = ? WHERE id = ?",
      [rollNumber, seatNo, enrolledOn || today(), existing.id],
    );
    return existing.id;
  }
  const info = run(
    'INSERT INTO batch_enrollments (member_id, batch_id, roll_number, seat_no, enrolled_on) VALUES (?, ?, ?, ?, ?)',
    [memberId, batchId, rollNumber || nextRollNumber(batchId), seatNo, enrolledOn || today()],
  );
  return Number(info.lastInsertRowid);
}

/**
 * Whether a student may come through the gate today: any active enrollment in
 * a live batch counts. Returned in the shape performCheckIn reports a gym
 * membership in, so the kiosk can show "Batch 12-A · until 31/03/2027".
 */
export function activeEnrollmentToday(memberId) {
  const now = today();
  return get(
    `${ENROLLMENT_SELECT}
     WHERE e.member_id = ? AND e.status = 'active' AND b.active = 1
       AND b.start_date <= ? AND (b.end_date IS NULL OR b.end_date >= ?)
     ORDER BY b.end_date IS NULL, b.end_date DESC LIMIT 1`,
    [memberId, now, now],
  );
}
