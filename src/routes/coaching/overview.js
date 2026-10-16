import { Router } from 'express';
import { MANAGES_BILLING, requireRole } from '../../auth.js';
import { all, get, run } from '../../db.js';
import { badRequest } from '../../errors.js';
import { parse, today } from '../../validate.js';
import { requireModule } from '../../verticals.js';
import { whatsappReady } from '../../whatsapp.js';
import { weekdayOf } from '../../coaching/attendance.js';
import { feeSummary, listDues } from '../../coaching/fees.js';
import { DEFAULT_TEMPLATES, TEMPLATE_PLACEHOLDERS } from '../../coaching/templates.js';

/**
 * The CoachBook dashboard and the parent-alert settings.
 */
export const overviewRoutes = Router();
overviewRoutes.use(['/dashboard', '/settings'], requireModule('batches'));

/**
 * One call for the director's first screen: today's lectures and how far
 * attendance has got, fee money in and still out, the admissions funnel,
 * upcoming tests, and who is under the attendance line this month. Money is
 * left out for roles that cannot see the fees screen.
 */
overviewRoutes.get('/dashboard', (req, res) => {
  const now = today();
  const monthStart = `${now.slice(0, 7)}-01`;
  const weekday = weekdayOf(now);
  const canSeeMoney = MANAGES_BILLING.includes(req.user?.role);

  const students = get(
    `SELECT COUNT(DISTINCT e.member_id) AS active
     FROM batch_enrollments e JOIN academic_batches b ON b.id = e.batch_id
     WHERE e.status = 'active' AND b.active = 1`,
  ).active;
  const newThisMonth = get(
    'SELECT COUNT(*) AS n FROM batch_enrollments WHERE enrolled_on >= ?',
    [monthStart],
  ).n;
  const batches = all(
    `SELECT b.id, b.name, b.code, b.capacity, c.name AS course_name,
            (SELECT COUNT(*) FROM batch_enrollments e WHERE e.batch_id = b.id AND e.status = 'active') AS enrolled
     FROM academic_batches b JOIN academic_courses c ON c.id = b.course_id
     WHERE b.active = 1 ORDER BY c.name, b.name`,
  );

  const lectures = all(
    `SELECT t.id, t.batch_id, t.subject_id, t.start_time, t.end_time, COALESCE(t.room, b.room) AS room,
            b.name AS batch_name, s.name AS subject_name, u.name AS faculty_name,
            (SELECT COUNT(*) FROM batch_enrollments e WHERE e.batch_id = b.id AND e.status = 'active') AS enrolled,
            (SELECT COUNT(*) FROM batch_attendance a WHERE a.batch_id = t.batch_id AND a.attendance_date = ? AND a.subject_id = t.subject_id) AS marked,
            (SELECT COUNT(*) FROM batch_attendance a WHERE a.batch_id = t.batch_id AND a.attendance_date = ? AND a.subject_id = t.subject_id AND a.status = 'absent') AS absent
     FROM academic_timetable t
     JOIN academic_batches b ON b.id = t.batch_id
     JOIN academic_subjects s ON s.id = t.subject_id
     LEFT JOIN users u ON u.id = t.faculty_id
     WHERE t.active = 1 AND b.active = 1 AND t.weekday = ?
     ORDER BY t.start_time, b.name`,
    [now, now, weekday],
  );

  const todayMarks = get(
    `SELECT SUM(CASE WHEN status IN ('present', 'late') THEN 1 ELSE 0 END) AS present,
            SUM(CASE WHEN status = 'absent' THEN 1 ELSE 0 END) AS absent,
            SUM(CASE WHEN status = 'absent' AND whatsapp_sent = 1 THEN 1 ELSE 0 END) AS alerted
     FROM batch_attendance WHERE attendance_date = ?`,
    [now],
  );
  const monthPct = get(
    `SELECT CASE WHEN SUM(CASE WHEN status IN ('present', 'late', 'absent') THEN 1 ELSE 0 END) = 0 THEN NULL
                 ELSE ROUND(100.0 * SUM(CASE WHEN status IN ('present', 'late') THEN 1 ELSE 0 END)
                            / SUM(CASE WHEN status IN ('present', 'late', 'absent') THEN 1 ELSE 0 END), 1) END AS pct
     FROM batch_attendance WHERE attendance_date >= ?`,
    [monthStart],
  ).pct;
  const threshold = get('SELECT low_attendance_threshold AS t FROM coaching_settings WHERE id = 1')?.t ?? 75;
  const lowAttendance = all(
    `SELECT a.member_id, m.code AS member_code, m.first_name, m.last_name,
            ROUND(100.0 * SUM(CASE WHEN a.status IN ('present', 'late') THEN 1 ELSE 0 END)
                  / SUM(CASE WHEN a.status IN ('present', 'late', 'absent') THEN 1 ELSE 0 END), 1) AS percentage
     FROM batch_attendance a JOIN members m ON m.id = a.member_id
     WHERE a.attendance_date >= ?
     GROUP BY a.member_id
     HAVING SUM(CASE WHEN a.status IN ('present', 'late', 'absent') THEN 1 ELSE 0 END) >= 3 AND percentage < ?
     ORDER BY percentage LIMIT 10`,
    [monthStart, threshold],
  );

  const upcomingTests = all(
    `SELECT t.id, t.title, t.test_type, t.test_date, t.max_marks, b.name AS batch_name, s.name AS subject_name
     FROM academic_tests t JOIN academic_batches b ON b.id = t.batch_id LEFT JOIN academic_subjects s ON s.id = t.subject_id
     WHERE t.test_date >= ? ORDER BY t.test_date, t.id LIMIT 6`,
    [now],
  );
  const awaitingResults = all(
    `SELECT t.id, t.title, t.test_date, b.name AS batch_name,
            (SELECT COUNT(*) FROM academic_test_marks tm WHERE tm.test_id = t.id) AS marks_entered
     FROM academic_tests t JOIN academic_batches b ON b.id = t.batch_id
     WHERE t.test_date < ? AND t.published_at IS NULL ORDER BY t.test_date DESC LIMIT 6`,
    [now],
  );

  const funnel = Object.fromEntries(
    all('SELECT status, COUNT(*) AS n FROM student_inquiries WHERE created_at >= ? GROUP BY status', [monthStart]).map((r) => [r.status, r.n]),
  );
  const followUps = all(
    `SELECT i.id, i.student_name, i.phone, i.status, i.follow_up_on, i.demo_on, c.name AS course_name
     FROM student_inquiries i LEFT JOIN academic_courses c ON c.id = i.course_id
     WHERE i.status NOT IN ('admitted', 'declined') AND (i.follow_up_on <= ? OR i.demo_on = ?)
     ORDER BY COALESCE(i.follow_up_on, i.demo_on) LIMIT 8`,
    [now, now],
  );

  res.json({
    date: now,
    whatsapp_connected: whatsappReady(),
    students: { active: students, new_this_month: newThisMonth },
    batches,
    lectures,
    attendance: {
      today_present: todayMarks.present ?? 0,
      today_absent: todayMarks.absent ?? 0,
      today_alerted: todayMarks.alerted ?? 0,
      month_percentage: monthPct,
      threshold,
      low: lowAttendance,
    },
    tests: { upcoming: upcomingTests, awaiting_results: awaitingResults },
    admissions: {
      month: funnel,
      month_leads: Object.values(funnel).reduce((a, b) => a + b, 0),
      follow_ups: followUps,
    },
    fees: canSeeMoney
      ? { ...feeSummary(), overdue: listDues({ window: 'overdue' }).slice(0, 8), upcoming: listDues({ window: 'upcoming', days: 7 }).slice(0, 8) }
      : null,
  });
});

/* ── Parent alert settings ───────────────────────────────────────────── */

const SETTINGS_FIELDS = {
  absence_alerts: { type: 'boolean' },
  late_alerts: { type: 'boolean' },
  absence_template: { type: 'string', min: 10, max: 1000 },
  late_template: { type: 'string', min: 10, max: 1000 },
  fee_reminders: { type: 'boolean' },
  fee_reminder_days_before: { type: 'int', min: 0, max: 30 },
  overdue_reminder_days: { type: 'int', min: 1, max: 60 },
  fee_due_template: { type: 'string', min: 10, max: 1000 },
  fee_overdue_template: { type: 'string', min: 10, max: 1000 },
  fee_receipts: { type: 'boolean' },
  fee_receipt_template: { type: 'string', min: 10, max: 1000 },
  scorecard_template: { type: 'string', min: 10, max: 1000 },
  low_attendance_threshold: { type: 'int', min: 1, max: 100 },
  low_attendance_template: { type: 'string', min: 10, max: 1000 },
  institute_phone: { type: 'string', max: 30 },
  gstin: { type: 'string', max: 20 },
};

const settingsPayload = () => ({
  settings: get('SELECT * FROM coaching_settings WHERE id = 1'),
  defaults: DEFAULT_TEMPLATES,
  placeholders: TEMPLATE_PLACEHOLDERS,
  whatsapp_connected: whatsappReady(),
});

overviewRoutes.get('/settings', (_req, res) => {
  res.json(settingsPayload());
});

overviewRoutes.patch('/settings', requireRole(...MANAGES_BILLING), (req, res) => {
  const body = parse(req.body, SETTINGS_FIELDS);
  const columns = Object.keys(body).filter((c) => body[c] !== null || c === 'institute_phone' || c === 'gstin');
  if (!columns.length) throw badRequest('Nothing to update');
  if (body.gstin && !/^[0-9A-Z]{15}$/i.test(body.gstin)) throw badRequest('A GSTIN is 15 letters and digits', { gstin: 'invalid' });
  run(
    `UPDATE coaching_settings SET ${columns.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = 1`,
    columns.map((c) => (c === 'gstin' && body[c] ? body[c].toUpperCase() : body[c])),
  );
  res.json(settingsPayload());
});
