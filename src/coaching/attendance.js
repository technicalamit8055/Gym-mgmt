import { all, get, run, tx } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { gymDateOf, gymDatetimeOf } from '../clock.js';
import { today } from '../validate.js';

/**
 * Lecture attendance.
 *
 * Two ways in, one table:
 *
 * - **The sheet** — a teacher opens a batch for a date (optionally one
 *   subject's lecture) and taps Present/Absent/Late/Excused per student. This
 *   is what fires absentee alerts (notify.js).
 * - **The gate scan** — a student's QR card or fingerprint at the entrance
 *   (performCheckIn in src/checkin.js) marks them present for the day in every
 *   batch they have a lecture in, as a whole-day row (subject_id NULL).
 *
 * A sheet supersedes the scan: saving a subject sheet removes that day's scan
 * rows for the batch, so a student is never counted twice for one day, and a
 * scan after a sheet was taken adds nothing. A scan cannot mark anyone absent
 * — only a person taking the sheet knows who was expected and didn't come.
 *
 * Percentage = (present + late) ÷ (present + late + absent). Excused days
 * count neither way: a parent's letter for a wedding should not drag a
 * student under the 75% line.
 */

export const STATUSES = ['present', 'absent', 'late', 'excused'];

/** 0 = Sunday, from a YYYY-MM-DD with no timezone involved. */
export const weekdayOf = (isoDate) => new Date(`${isoDate}T00:00:00Z`).getUTCDay();

/** '1,3,5' -> [1, 3, 5]; empty or missing means "no fixed days". */
export const parseWeekdays = (value) =>
  String(value ?? '')
    .split(',')
    .map((d) => Number.parseInt(d, 10))
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);

export function activeRoster(batchId) {
  return all(
    `SELECT e.id AS enrollment_id, e.roll_number, e.seat_no, e.member_id,
            m.code AS member_code, m.first_name, m.last_name, m.phone, m.emergency_contact, m.emergency_phone, m.status AS member_status
     FROM batch_enrollments e JOIN members m ON m.id = e.member_id
     WHERE e.batch_id = ? AND e.status = 'active'
     ORDER BY e.roll_number IS NULL, e.roll_number, m.first_name, m.last_name`,
    [batchId],
  );
}

/**
 * The sheet for one batch, date and (optional) subject: every active student
 * with their mark if one exists, and whether they scanned in at the gate
 * today — the teacher's hint for who is actually in the building.
 */
export function attendanceSheet({ batchId, subjectId = null, date }) {
  const batch = get('SELECT * FROM academic_batches WHERE id = ?', [batchId]);
  if (!batch) throw notFound('Batch not found');
  const roster = activeRoster(batchId);
  const marks = new Map(
    all(
      'SELECT member_id, status, source, whatsapp_sent FROM batch_attendance WHERE batch_id = ? AND attendance_date = ? AND COALESCE(subject_id, 0) = ?',
      [batchId, date, subjectId ?? 0],
    ).map((row) => [row.member_id, row]),
  );
  const scans = new Map(
    all(
      `SELECT member_id, MIN(${gymDatetimeOf('check_in')}) AS first_in
       FROM attendance WHERE ${gymDateOf('check_in')} = ? GROUP BY member_id`,
      [date],
    ).map((row) => [row.member_id, row.first_in]),
  );
  const items = roster.map((student) => {
    const mark = marks.get(student.member_id);
    return {
      ...student,
      status: mark?.status ?? null,
      source: mark?.source ?? null,
      alerted: Boolean(mark?.whatsapp_sent),
      scanned_in_at: scans.get(student.member_id) ?? null,
    };
  });
  const counts = Object.fromEntries(STATUSES.map((s) => [s, items.filter((i) => i.status === s).length]));
  return { batch, date, subject_id: subjectId, items, counts, unmarked: items.filter((i) => !i.status).length };
}

/**
 * Saves a sheet. `entries` is [{ member_id, status }] for students on the
 * batch's active roster; anyone else is refused rather than silently added.
 */
export function saveAttendanceSheet({ batchId, subjectId = null, date, entries, userId = null }) {
  if (!Array.isArray(entries) || !entries.length) throw badRequest('Mark at least one student', { entries: 'required' });
  if (date > today()) throw badRequest('Attendance cannot be marked for a future date', { date: 'in the future' });
  if (subjectId && !get(
    'SELECT 1 FROM academic_subjects s JOIN academic_batches b ON b.course_id = s.course_id WHERE s.id = ? AND b.id = ?',
    [subjectId, batchId],
  )) {
    throw badRequest('That subject is not part of this batch’s course', { subject_id: 'mismatch' });
  }
  const enrolled = new Set(activeRoster(batchId).map((r) => r.member_id));
  for (const entry of entries) {
    if (!STATUSES.includes(entry?.status)) throw badRequest(`"${entry?.status}" is not an attendance status`, { entries: 'status' });
    if (!enrolled.has(Number(entry.member_id))) {
      throw badRequest('One of those students is not enrolled in this batch', { entries: 'not enrolled' });
    }
  }

  return tx(() => {
    let saved = 0;
    for (const entry of entries) {
      const memberId = Number(entry.member_id);
      // A subject sheet replaces the gate's whole-day mark for this student.
      if (subjectId) {
        run(
          "DELETE FROM batch_attendance WHERE batch_id = ? AND member_id = ? AND attendance_date = ? AND subject_id IS NULL AND source = 'scan'",
          [batchId, memberId, date],
        );
      }
      const existing = get(
        'SELECT id FROM batch_attendance WHERE batch_id = ? AND member_id = ? AND attendance_date = ? AND COALESCE(subject_id, 0) = ?',
        [batchId, memberId, date, subjectId ?? 0],
      );
      if (existing) {
        run(
          "UPDATE batch_attendance SET status = ?, source = 'sheet', marked_by = ?, updated_at = datetime('now') WHERE id = ?",
          [entry.status, userId, existing.id],
        );
      } else {
        run(
          `INSERT INTO batch_attendance (batch_id, subject_id, member_id, attendance_date, status, source, marked_by)
           VALUES (?, ?, ?, ?, ?, 'sheet', ?)`,
          [batchId, subjectId, memberId, date, entry.status, userId],
        );
      }
      saved += 1;
    }
    return saved;
  });
}

/**
 * The gate scan's half of attendance: present for today in every batch the
 * student has a lecture in today (by the timetable, or the batch's own days
 * when it has no timetable yet). Returns the batches marked.
 */
export function markPresentFromScan(memberId) {
  const date = today();
  const weekday = weekdayOf(date);
  const batches = all(
    `SELECT b.id, b.name, b.weekdays,
            (SELECT COUNT(*) FROM academic_timetable t WHERE t.batch_id = b.id AND t.active = 1) AS slots,
            (SELECT COUNT(*) FROM academic_timetable t WHERE t.batch_id = b.id AND t.active = 1 AND t.weekday = ?) AS slots_today
     FROM batch_enrollments e JOIN academic_batches b ON b.id = e.batch_id
     WHERE e.member_id = ? AND e.status = 'active' AND b.active = 1
       AND b.start_date <= ? AND (b.end_date IS NULL OR b.end_date >= ?)`,
    [weekday, memberId, date, date],
  );
  const marked = [];
  for (const batch of batches) {
    const days = parseWeekdays(batch.weekdays);
    const hasLecture = batch.slots ? batch.slots_today > 0 : !days.length || days.includes(weekday);
    if (!hasLecture) continue;
    const already = get('SELECT 1 FROM batch_attendance WHERE batch_id = ? AND member_id = ? AND attendance_date = ?', [
      batch.id,
      memberId,
      date,
    ]);
    if (already) continue;
    run(
      `INSERT INTO batch_attendance (batch_id, subject_id, member_id, attendance_date, status, source)
       VALUES (?, NULL, ?, ?, 'present', 'scan')`,
      [batch.id, memberId, date],
    );
    marked.push({ batch_id: batch.id, batch_name: batch.name });
  }
  return marked;
}

const PERCENT_SQL = `
  CASE WHEN SUM(CASE WHEN status IN ('present', 'late', 'absent') THEN 1 ELSE 0 END) = 0 THEN NULL
       ELSE ROUND(100.0 * SUM(CASE WHEN status IN ('present', 'late') THEN 1 ELSE 0 END)
                  / SUM(CASE WHEN status IN ('present', 'late', 'absent') THEN 1 ELSE 0 END), 1)
  END
`;

const COUNT_COLUMNS = `
  SUM(CASE WHEN a.status = 'present' THEN 1 ELSE 0 END) AS present,
  SUM(CASE WHEN a.status = 'late' THEN 1 ELSE 0 END) AS late,
  SUM(CASE WHEN a.status = 'absent' THEN 1 ELSE 0 END) AS absent,
  SUM(CASE WHEN a.status = 'excused' THEN 1 ELSE 0 END) AS excused,
  COUNT(*) AS marked,
  ${PERCENT_SQL.replace(/status/g, 'a.status')} AS percentage
`;

/** Per-student totals for one batch over a date range. */
export function batchAttendanceReport({ batchId, from, to }) {
  const roster = activeRoster(batchId);
  const totals = new Map(
    all(
      `SELECT a.member_id, ${COUNT_COLUMNS}
       FROM batch_attendance a
       WHERE a.batch_id = ? AND a.attendance_date BETWEEN ? AND ?
       GROUP BY a.member_id`,
      [batchId, from, to],
    ).map((row) => [row.member_id, row]),
  );
  const lectures = get(
    `SELECT COUNT(*) AS n FROM (
       SELECT DISTINCT attendance_date, COALESCE(subject_id, 0) FROM batch_attendance
       WHERE batch_id = ? AND attendance_date BETWEEN ? AND ?
     )`,
    [batchId, from, to],
  ).n;
  return {
    lectures,
    items: roster.map((student) => {
      const t = totals.get(student.member_id);
      return {
        ...student,
        present: t?.present ?? 0,
        late: t?.late ?? 0,
        absent: t?.absent ?? 0,
        excused: t?.excused ?? 0,
        marked: t?.marked ?? 0,
        percentage: t?.percentage ?? null,
      };
    }),
  };
}

/** A student's totals, overall and per batch, between two dates. */
export function studentAttendance(memberId, { from, to }) {
  const overall = get(
    `SELECT ${COUNT_COLUMNS} FROM batch_attendance a WHERE a.member_id = ? AND a.attendance_date BETWEEN ? AND ?`,
    [memberId, from, to],
  );
  const byBatch = all(
    `SELECT a.batch_id, b.name AS batch_name, ${COUNT_COLUMNS}
     FROM batch_attendance a JOIN academic_batches b ON b.id = a.batch_id
     WHERE a.member_id = ? AND a.attendance_date BETWEEN ? AND ?
     GROUP BY a.batch_id ORDER BY b.name`,
    [memberId, from, to],
  );
  return { overall, by_batch: byBatch };
}

/**
 * One student's month as a calendar: per day, the worst mark that day
 * (absent beats late beats excused beats present), plus every lecture's mark
 * for the day's detail sheet.
 */
export function attendanceCalendar(memberId, month) {
  const from = `${month}-01`;
  const [y, m] = month.split('-').map(Number);
  const to = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const rows = all(
    `SELECT a.attendance_date, a.status, a.source, b.name AS batch_name, s.name AS subject_name
     FROM batch_attendance a
     JOIN academic_batches b ON b.id = a.batch_id
     LEFT JOIN academic_subjects s ON s.id = a.subject_id
     WHERE a.member_id = ? AND a.attendance_date BETWEEN ? AND ?
     ORDER BY a.attendance_date, b.name, s.name`,
    [memberId, from, to],
  );
  const severity = { absent: 3, late: 2, excused: 1, present: 0 };
  const days = {};
  for (const row of rows) {
    const day = (days[row.attendance_date] ??= { date: row.attendance_date, status: row.status, lectures: [] });
    if (severity[row.status] > severity[day.status]) day.status = row.status;
    day.lectures.push({ batch_name: row.batch_name, subject_name: row.subject_name, status: row.status, source: row.source });
  }
  return { month, from, to, days: Object.values(days), summary: studentAttendance(memberId, { from, to }).overall };
}
