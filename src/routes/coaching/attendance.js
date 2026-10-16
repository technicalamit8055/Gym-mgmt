import { Router } from 'express';
import { MANAGES_BILLING, requireRole } from '../../auth.js';
import { all, get } from '../../db.js';
import { badRequest, notFound } from '../../errors.js';
import { parse, today } from '../../validate.js';
import { requireModule } from '../../verticals.js';
import {
  activeRoster,
  attendanceCalendar,
  attendanceSheet,
  batchAttendanceReport,
  parseWeekdays,
  saveAttendanceSheet,
  weekdayOf,
} from '../../coaching/attendance.js';
import { coachingSettings, sendAbsenceAlerts, sendLowAttendanceAlerts } from '../../coaching/notify.js';
import { dateQuery, idParam, idQuery, instituteName, monthQuery } from './shared.js';

/**
 * The attendance desk. Any staff role can take a sheet — it is the teacher's
 * job — while the institute-wide low-attendance broadcast stays with the
 * billing roles, like every other bulk send from the institute's number.
 */
export const attendanceRoutes = Router();
attendanceRoutes.use('/attendance', requireModule('attendance'));

const monthBounds = (month) => {
  const [y, m] = month.split('-').map(Number);
  return { from: `${month}-01`, to: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) };
};

/**
 * Today's lectures (or a given date's), each with how far its sheet has got —
 * the attendance desk's landing list. A batch with no timetable yet shows
 * once, as a whole-day sheet, on its own weekdays.
 */
attendanceRoutes.get('/attendance/day', (req, res) => {
  const date = dateQuery(req, 'date', today());
  const weekday = weekdayOf(date);
  const batches = all(
    `SELECT b.*, c.name AS course_name,
            (SELECT COUNT(*) FROM batch_enrollments e WHERE e.batch_id = b.id AND e.status = 'active') AS enrolled
     FROM academic_batches b JOIN academic_courses c ON c.id = b.course_id
     WHERE b.active = 1 AND b.start_date <= ? AND (b.end_date IS NULL OR b.end_date >= ?)
     ORDER BY b.start_time IS NULL, b.start_time, b.name`,
    [date, date],
  );
  const lectures = [];
  for (const batch of batches) {
    const slots = all(
      `SELECT t.*, s.name AS subject_name, u.name AS faculty_name
       FROM academic_timetable t JOIN academic_subjects s ON s.id = t.subject_id LEFT JOIN users u ON u.id = t.faculty_id
       WHERE t.batch_id = ? AND t.active = 1 AND t.weekday = ? ORDER BY t.start_time`,
      [batch.id, weekday],
    );
    const hasTimetable = get('SELECT 1 FROM academic_timetable WHERE batch_id = ? AND active = 1', [batch.id]);
    const entries = slots.length
      ? slots.map((slot) => ({
          subject_id: slot.subject_id,
          subject_name: slot.subject_name,
          faculty_name: slot.faculty_name,
          start_time: slot.start_time,
          end_time: slot.end_time,
          room: slot.room || batch.room,
        }))
      : !hasTimetable && (!parseWeekdays(batch.weekdays).length || parseWeekdays(batch.weekdays).includes(weekday))
        ? [{ subject_id: null, subject_name: null, start_time: batch.start_time, end_time: batch.end_time, room: batch.room }]
        : [];
    for (const entry of entries) {
      const marks = get(
        `SELECT COUNT(*) AS marked,
                SUM(CASE WHEN status = 'absent' THEN 1 ELSE 0 END) AS absent,
                SUM(CASE WHEN status IN ('present', 'late') THEN 1 ELSE 0 END) AS present
         FROM batch_attendance WHERE batch_id = ? AND attendance_date = ? AND COALESCE(subject_id, 0) = ?`,
        [batch.id, date, entry.subject_id ?? 0],
      );
      lectures.push({
        ...entry,
        batch_id: batch.id,
        batch_name: batch.name,
        batch_code: batch.code,
        course_name: batch.course_name,
        enrolled: batch.enrolled,
        marked: marks.marked,
        present: marks.present ?? 0,
        absent: marks.absent ?? 0,
      });
    }
  }
  res.json({ date, weekday, lectures });
});

attendanceRoutes.get('/attendance/sheet', (req, res) => {
  const batchId = idQuery(req, 'batch_id');
  if (!batchId) throw badRequest('Choose a batch', { batch_id: 'is required' });
  res.json(attendanceSheet({ batchId, subjectId: idQuery(req, 'subject_id'), date: dateQuery(req, 'date', today()) }));
});

/**
 * Saves a sheet and, unless `notify` is off, queues the absentee alerts for
 * it straight away — the whole point of the feature is that a parent hears
 * within minutes, not at the next parent-teacher meeting.
 */
attendanceRoutes.put('/attendance/sheet', (req, res) => {
  const body = parse(req.body, {
    batch_id: { type: 'int', required: true, min: 1 },
    subject_id: { type: 'int', min: 1 },
    date: { type: 'date' },
    notify: { type: 'boolean', default: 1 },
  });
  const date = body.date || today();
  const saved = saveAttendanceSheet({
    batchId: body.batch_id,
    subjectId: body.subject_id ?? null,
    date,
    entries: req.body?.entries,
    userId: req.user?.id ?? null,
  });
  // Only a sheet for today alerts by default: correcting last week's register
  // should not message parents about a day long past.
  const alerts =
    body.notify && date === today()
      ? sendAbsenceAlerts({ batchId: body.batch_id, subjectId: body.subject_id ?? null, date, instituteName: instituteName(req) })
      : { queued: 0, skipped: 0, connected: null, not_today: date !== today() };
  res.json({ saved, alerts, sheet: attendanceSheet({ batchId: body.batch_id, subjectId: body.subject_id ?? null, date }) });
});

/** Re-sends the alerts a sheet still owes — e.g. WhatsApp was unlinked when
 * it was saved. Skips anyone already alerted. */
attendanceRoutes.post('/attendance/sheet/alerts', (req, res) => {
  const body = parse(req.body, {
    batch_id: { type: 'int', required: true, min: 1 },
    subject_id: { type: 'int', min: 1 },
    date: { type: 'date' },
  });
  const result = sendAbsenceAlerts({
    batchId: body.batch_id,
    subjectId: body.subject_id ?? null,
    date: body.date || today(),
    instituteName: instituteName(req),
  });
  if (result.connected === false) throw badRequest('WhatsApp is not connected. Link it on the WhatsApp page first.');
  res.json(result);
});

attendanceRoutes.get('/attendance/report', (req, res) => {
  const batchId = idQuery(req, 'batch_id');
  if (!batchId) throw badRequest('Choose a batch', { batch_id: 'is required' });
  const batch = get('SELECT * FROM academic_batches WHERE id = ?', [batchId]);
  if (!batch) throw notFound('Batch not found');
  const month = monthQuery(req, 'month', null);
  const bounds = month ? monthBounds(month) : { from: dateQuery(req, 'from', `${today().slice(0, 7)}-01`), to: dateQuery(req, 'to', today()) };
  const threshold = coachingSettings().low_attendance_threshold ?? 75;
  const report = batchAttendanceReport({ batchId, ...bounds });
  res.json({
    batch,
    ...bounds,
    threshold,
    ...report,
    below_threshold: report.items.filter((r) => r.percentage !== null && r.percentage < threshold).length,
  });
});

/** Warns the parents of every student under the threshold for the month. */
attendanceRoutes.post('/attendance/low-alerts', requireRole(...MANAGES_BILLING), (req, res) => {
  const body = parse(req.body, {
    batch_id: { type: 'int', required: true, min: 1 },
    month: { type: 'string', min: 7, max: 7 },
  });
  const batch = get('SELECT * FROM academic_batches WHERE id = ?', [body.batch_id]);
  if (!batch) throw notFound('Batch not found');
  const month = body.month && /^\d{4}-\d{2}$/.test(body.month) ? body.month : today().slice(0, 7);
  const threshold = coachingSettings().low_attendance_threshold ?? 75;
  const low = batchAttendanceReport({ batchId: body.batch_id, ...monthBounds(month) }).items.filter(
    (r) => r.percentage !== null && r.percentage < threshold,
  );
  const result = sendLowAttendanceAlerts({ rows: low, batchName: batch.name, instituteName: instituteName(req) });
  if (result.connected === false) throw badRequest('WhatsApp is not connected. Link it on the WhatsApp page first.');
  res.json({ ...result, students: low.length });
});

attendanceRoutes.get('/attendance/students/:id/calendar', (req, res) => {
  const memberId = idParam(req);
  if (!get('SELECT id FROM members WHERE id = ?', [memberId])) throw notFound('Student not found');
  res.json(attendanceCalendar(memberId, monthQuery(req, 'month', today().slice(0, 7))));
});

/** Roster only — for screens that need the batch's students without marks. */
attendanceRoutes.get('/attendance/roster/:id', (req, res) => {
  res.json({ items: activeRoster(idParam(req)) });
});
