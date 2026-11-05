import { Router } from 'express';
import { requireMemberAuth } from '../../auth.js';
import { all, get, tenantStorage } from '../../db.js';
import { conflict, notFound } from '../../errors.js';
import { addDays, parse, today } from '../../validate.js';
import { requireModule } from '../../verticals.js';
import { attendanceCalendar, studentAttendance, weekdayOf } from '../../coaching/attendance.js';
import { enrollmentsFor } from '../../coaching/enrollment.js';
import { plansForMember, receiptNumber } from '../../coaching/fees.js';
import { doubtsForStudent } from '../../coaching/liveDoubts.js';
import { issueSocketTicket } from '../../coaching/liveGateway.js';
import { feeReceiptPdf } from '../../coaching/notify.js';
import { forStudent } from '../../coaching/privateStream.js';
import { checkProcessing, lectureChapters, numbered, playUrl, RECORDING_SELECT, saveProgress, signedSource } from '../../coaching/recordings.js';
import { SLOT_SELECT } from '../../coaching/timetable.js';
import { LIVE_SELECT } from './live.js';
import { MATERIAL_SELECT, sendMaterialFile } from './materials.js';
import { reportCard } from './tests.js';
import { idParam, instituteName, monthQuery, tenantCurrency, tenantLogo } from './shared.js';

/**
 * The student & parent side of CoachBook, under /api/portal/coaching — the
 * same member sign-in as the rest of the portal (requireMemberAuth), so a
 * parent signs in with the student's ID and password.
 *
 * Everything here is scoped to the signed-in student's own active batches:
 * a timetable, material or test from another batch is not theirs to see.
 * Test results only appear once the institute has published them.
 */
export const coachingPortalRoutes = Router();
coachingPortalRoutes.use(requireMemberAuth, requireModule('batches'));

const activeBatchIds = (memberId) =>
  all("SELECT batch_id FROM batch_enrollments WHERE member_id = ? AND status = 'active'", [memberId]).map((r) => r.batch_id);

const placeholders = (list) => list.map(() => '?').join(', ') || 'NULL';

function weekSlots(batchIds) {
  if (!batchIds.length) return [];
  return all(`${SLOT_SELECT} WHERE t.active = 1 AND t.batch_id IN (${placeholders(batchIds)}) ORDER BY t.weekday, t.start_time`, batchIds);
}

function upcomingTests(batchIds, days = 30) {
  if (!batchIds.length) return [];
  return all(
    `SELECT t.id, t.title, t.test_type, t.test_date, t.max_marks, t.syllabus, b.name AS batch_name, s.name AS subject_name
     FROM academic_tests t JOIN academic_batches b ON b.id = t.batch_id LEFT JOIN academic_subjects s ON s.id = t.subject_id
     WHERE t.batch_id IN (${placeholders(batchIds)}) AND t.test_date BETWEEN ? AND ?
     ORDER BY t.test_date, t.id`,
    [...batchIds, today(), addDays(today(), days)],
  );
}

/** Home: today's classes, the next test, the latest result, this month's
 * attendance and whatever fee is due next. */
coachingPortalRoutes.get('/overview', (req, res) => {
  const memberId = req.member.id;
  const now = today();
  const batchIds = activeBatchIds(memberId);
  const weekday = weekdayOf(now);
  const todayClasses = weekSlots(batchIds).filter((slot) => slot.weekday === weekday);
  const plans = plansForMember(memberId).filter((p) => p.status !== 'cancelled');
  const nextDue = plans
    .flatMap((p) => p.installments.filter((i) => i.balance > 0.005).map((i) => ({ ...i, course_name: p.course_name })))
    .sort((a, b) => a.due_date.localeCompare(b.due_date))[0] ?? null;
  const latestResult = reportCard(memberId, { publishedOnly: true }).tests[0] ?? null;
  res.json({
    enrollments: enrollmentsFor(memberId).filter((e) => e.status === 'active'),
    today: { date: now, weekday, classes: todayClasses },
    next_test: upcomingTests(batchIds, 60)[0] ?? null,
    latest_result: latestResult,
    attendance: studentAttendance(memberId, { from: `${now.slice(0, 7)}-01`, to: now }).overall,
    fees: {
      next_due: nextDue,
      overdue_amount: plans.reduce((acc, p) => acc + (p.overdue_amount || 0), 0),
      balance: plans.reduce((acc, p) => acc + Math.max(0, p.balance), 0),
    },
  });
});

coachingPortalRoutes.get('/timetable', (req, res) => {
  const batchIds = activeBatchIds(req.member.id);
  res.json({ slots: weekSlots(batchIds), upcoming_tests: upcomingTests(batchIds, 45) });
});

coachingPortalRoutes.get('/attendance', (req, res) => {
  res.json(attendanceCalendar(req.member.id, monthQuery(req, 'month', today().slice(0, 7))));
});

coachingPortalRoutes.get('/tests', (req, res) => {
  res.json(reportCard(req.member.id, { publishedOnly: true }));
});

/** Material for the student's batches, their courses, or the whole institute. */
function visibleMaterials(memberId) {
  const batchIds = activeBatchIds(memberId);
  const courseIds = batchIds.length
    ? all(`SELECT DISTINCT course_id FROM academic_batches WHERE id IN (${placeholders(batchIds)})`, batchIds).map((r) => r.course_id)
    : [];
  return all(
    `${MATERIAL_SELECT}
     WHERE (ma.batch_id IN (${placeholders(batchIds)}))
        OR (ma.batch_id IS NULL AND ma.course_id IN (${placeholders(courseIds)}))
        OR (ma.batch_id IS NULL AND ma.course_id IS NULL)
     ORDER BY ma.created_at DESC, ma.id DESC LIMIT 300`,
    [...batchIds, ...courseIds],
  );
}

coachingPortalRoutes.get('/materials', (req, res) => {
  const submissions = new Map(
    all('SELECT material_id, status, submitted_on FROM assignment_submissions WHERE member_id = ?', [req.member.id]).map((s) => [s.material_id, s]),
  );
  res.json({
    items: visibleMaterials(req.member.id).map((m) => ({
      ...m,
      submission: m.kind === 'assignment' ? submissions.get(m.id) ?? { status: 'pending' } : null,
    })),
  });
});

coachingPortalRoutes.get('/materials/:id/file', (req, res) => {
  const id = idParam(req);
  if (!visibleMaterials(req.member.id).some((m) => m.id === id)) throw notFound('File not found');
  sendMaterialFile(res, id);
});

/** What is on air for the student's batches right now — at most one class
 * per batch, so a student in two batches can see two. */
coachingPortalRoutes.get('/live/active', requireModule('live'), (req, res) => {
  const batchIds = activeBatchIds(req.member.id);
  if (!batchIds.length) return res.json({ items: [] });
  const items = all(`${LIVE_SELECT} WHERE ls.status = 'live' AND ls.batch_id IN (${placeholders(batchIds)}) ORDER BY ls.started_at DESC, ls.id DESC`, batchIds);
  // A private class: this student's own signed link, never one shared by the room.
  const who = {
    slug: tenantStorage.getStore().slug,
    memberId: req.member.id,
    watchBase: `${req.protocol}://${req.get('host')}${req.tenantPathPrefix || ''}/api/live-hls`,
  };
  res.json({ items: items.map((s) => forStudent(s, get('SELECT cf_live_input_id FROM live_sessions WHERE id = ?', [s.id])?.cf_live_input_id, who)) });
});

/** A one-time pass onto a live class's socket, for its polls — only for a
 * class on air in one of the student's own batches; anything else is "not
 * found" rather than a hint that it exists. */
coachingPortalRoutes.post('/live/sessions/:id/socket-ticket', requireModule('live'), (req, res) => {
  const id = idParam(req);
  const session = get("SELECT batch_id FROM live_sessions WHERE id = ? AND status = 'live'", [id]);
  if (!session || !activeBatchIds(req.member.id).includes(session.batch_id)) throw notFound('Live class not found');
  const { first_name: first, last_name: last } = req.member;
  res.json(issueSocketTicket({ sessionId: id, role: 'student', memberId: req.member.id, name: [first, last ? `${last[0].toUpperCase()}.` : ''].filter(Boolean).join(' ') }));
});

/** The doubt pinned for the class and the student's own doubts — for a class
 * in one of their own batches, live or since ended. Other students'
 * unpinned doubts are the teacher's queue, not theirs to read. */
coachingPortalRoutes.get('/live/sessions/:id/doubts', requireModule('live'), (req, res) => {
  const id = idParam(req);
  const session = get('SELECT batch_id FROM live_sessions WHERE id = ?', [id]);
  if (!session || !activeBatchIds(req.member.id).includes(session.batch_id)) throw notFound('Live class not found');
  res.json(doubtsForStudent(id, req.member.id));
});

/* ── My Batches: each batch's subjects, and their lectures and notes ── */

const BATCH_SELECT = `
  SELECT b.id, b.name, b.code, b.room, b.weekdays, b.start_time, b.end_time, b.start_date, b.end_date,
         c.id AS course_id, c.name AS course_name, c.target_exam, c.academic_year, e.roll_number
  FROM batch_enrollments e
  JOIN academic_batches b ON b.id = e.batch_id
  JOIN academic_courses c ON c.id = b.course_id
  WHERE e.member_id = ? AND e.status = 'active'
`;

/** A batch the student is in, or "not found" — never a hint that it exists. */
function myBatch(memberId, batchId) {
  const batch = get(`${BATCH_SELECT} AND b.id = ?`, [memberId, batchId]);
  if (!batch) throw notFound('Batch not found');
  return batch;
}

/** What students see of a batch's lectures: published, and not failed. */
const SHOWN = "r.published = 1 AND r.status IN ('ready', 'processing')";

/** Who teaches a subject to a batch: allocated, or on its timetable. */
function teachersOf(batchId, subjectId = null) {
  const scope = subjectId ? 'AND subject_id = ?' : '';
  const params = subjectId ? [batchId, subjectId] : [batchId];
  return all(
    `SELECT DISTINCT u.name FROM users u WHERE u.id IN (
       SELECT faculty_id FROM faculty_allocations WHERE batch_id = ? ${scope}
       UNION SELECT faculty_id FROM academic_timetable WHERE active = 1 AND batch_id = ? ${scope}
     ) ORDER BY u.name`,
    [...params, ...params],
  ).map((r) => r.name);
}

/** Recordings with this student's progress on each. */
function withProgress(recordings, memberId) {
  if (!recordings.length) return recordings;
  const progress = new Map(
    all(
      `SELECT recording_id, position_sec, completed FROM recording_progress WHERE member_id = ? AND recording_id IN (${placeholders(recordings)})`,
      [memberId, ...recordings.map((r) => r.id)],
    ).map((p) => [p.recording_id, p]),
  );
  return recordings.map((r) => ({ ...r, position_sec: progress.get(r.id)?.position_sec ?? 0, completed: progress.get(r.id)?.completed ?? 0 }));
}

/** The material a batch's subject page lists; subject 0 is the batch's general material. */
function subjectMaterials(memberId, batch, subjectId) {
  return visibleMaterials(memberId).filter((m) =>
    (subjectId ? m.subject_id === subjectId : m.subject_id === null)
    && (m.batch_id === batch.id || (m.batch_id === null && (m.course_id === batch.course_id || m.course_id === null))));
}

/** A recording this student may watch: in one of their batches and published. */
function myRecording(memberId, id) {
  const recording = get(`${RECORDING_SELECT} WHERE r.id = ? AND ${SHOWN}`, [id]);
  if (!recording || !activeBatchIds(memberId).includes(recording.batch_id)) throw notFound('Lecture not found');
  return recording;
}

/** My Batches: each batch the student is in, and the lecture they were last part-way through. */
coachingPortalRoutes.get('/batches', (req, res) => {
  const memberId = req.member.id;
  const batches = all(`${BATCH_SELECT} ORDER BY b.start_date DESC, b.id DESC`, [memberId]);
  checkProcessing(batches.map((b) => b.id));
  const items = batches.map((b) => ({
    ...b,
    subjects: get('SELECT COUNT(*) AS n FROM academic_subjects WHERE course_id = ?', [b.course_id]).n,
    lectures: get(`SELECT COUNT(*) AS n FROM class_recordings r WHERE r.batch_id = ? AND ${SHOWN}`, [b.id]).n,
    watched: get(
      `SELECT COUNT(*) AS n FROM recording_progress p JOIN class_recordings r ON r.id = p.recording_id
       WHERE p.member_id = ? AND p.completed = 1 AND r.batch_id = ? AND ${SHOWN}`,
      [memberId, b.id],
    ).n,
    teachers: teachersOf(b.id),
    live_session_id: get("SELECT id FROM live_sessions WHERE batch_id = ? AND status = 'live'", [b.id])?.id ?? null,
  }));
  const batchIds = batches.map((b) => b.id);
  const resume = batchIds.length
    ? get(
      `${RECORDING_SELECT} JOIN recording_progress p ON p.recording_id = r.id AND p.member_id = ?
       WHERE r.batch_id IN (${placeholders(batchIds)}) AND r.published = 1 AND r.status = 'ready' AND p.completed = 0 AND p.position_sec > 0
       ORDER BY p.updated_at DESC LIMIT 1`,
      [memberId, ...batchIds],
    )
    : null;
  res.json({ items, continue_watching: resume ? withProgress([resume], memberId)[0] : null });
});

/** One batch: its subjects with how much is in each, what is live, and the latest lectures. */
coachingPortalRoutes.get('/batches/:id', (req, res) => {
  const memberId = req.member.id;
  const batch = myBatch(memberId, idParam(req));
  checkProcessing([batch.id]);
  const counts = (subjectClause, params) => ({
    lectures: get(`SELECT COUNT(*) AS n FROM class_recordings r WHERE r.batch_id = ? AND ${subjectClause} AND ${SHOWN}`, [batch.id, ...params]).n,
    watched: get(
      `SELECT COUNT(*) AS n FROM recording_progress p JOIN class_recordings r ON r.id = p.recording_id
       WHERE p.member_id = ? AND p.completed = 1 AND r.batch_id = ? AND ${subjectClause} AND ${SHOWN}`,
      [memberId, batch.id, ...params],
    ).n,
    last_lecture_at: get(`SELECT MAX(r.recorded_at) AS at FROM class_recordings r WHERE r.batch_id = ? AND ${subjectClause} AND ${SHOWN}`, [batch.id, ...params]).at,
  });
  const subjects = all('SELECT id, name, code FROM academic_subjects WHERE course_id = ? ORDER BY sort_order, name', [batch.course_id]).map((s) => ({
    ...s,
    ...counts('r.subject_id = ?', [s.id]),
    materials: subjectMaterials(memberId, batch, s.id).length,
    teachers: teachersOf(batch.id, s.id),
  }));
  // Lectures and material filed under no subject get a card of their own.
  const general = { id: 0, name: 'General', code: null, ...counts('r.subject_id IS NULL', []), materials: subjectMaterials(memberId, batch, 0).length, teachers: [] };
  if (general.lectures || general.materials) subjects.push(general);

  const recent = all(`${RECORDING_SELECT} WHERE r.batch_id = ? AND r.published = 1 AND r.status = 'ready' ORDER BY r.recorded_at DESC, r.id DESC LIMIT 6`, [batch.id]);
  res.json({
    batch: { ...batch, teachers: teachersOf(batch.id) },
    subjects,
    live: get(`${LIVE_SELECT} WHERE ls.batch_id = ? AND ls.status = 'live'`, [batch.id]) ?? null,
    recent: withProgress(recent, memberId),
  });
});

/** One subject of a batch: its lectures, numbered, by chapter on the app, and its notes and DPPs. */
coachingPortalRoutes.get('/batches/:id/subjects/:subjectId', (req, res) => {
  const memberId = req.member.id;
  const batch = myBatch(memberId, idParam(req));
  const subjectId = Number(req.params.subjectId);
  if (!Number.isInteger(subjectId) || subjectId < 0) throw notFound('Subject not found');
  const subject = subjectId
    ? get('SELECT id, name, code FROM academic_subjects WHERE id = ? AND course_id = ?', [subjectId, batch.course_id])
    : { id: 0, name: 'General', code: null };
  if (!subject) throw notFound('Subject not found');
  checkProcessing([batch.id]);
  const lectures = all(
    `${RECORDING_SELECT} WHERE r.batch_id = ? AND ${subjectId ? 'r.subject_id = ?' : 'r.subject_id IS NULL'} AND ${SHOWN}
     ORDER BY r.recorded_at DESC, r.id DESC`,
    subjectId ? [batch.id, subjectId] : [batch.id],
  );
  const submissions = new Map(
    all('SELECT material_id, status, submitted_on FROM assignment_submissions WHERE member_id = ?', [memberId]).map((s) => [s.material_id, s]),
  );
  res.json({
    batch: { id: batch.id, name: batch.name, course_name: batch.course_name },
    subject: { ...subject, teachers: subjectId ? teachersOf(batch.id, subjectId) : [] },
    lectures: withProgress(numbered(lectures), memberId),
    materials: subjectMaterials(memberId, batch, subjectId).map((m) => ({
      ...m,
      submission: m.kind === 'assignment' ? submissions.get(m.id) ?? { status: 'pending' } : null,
    })),
  });
});

/** A lecture to watch: where to play it from (signed for this student, when
 * private), where they got to, its class notes, and the next lecture. */
coachingPortalRoutes.get('/recordings/:id', requireModule('live'), (req, res) => {
  const memberId = req.member.id;
  const recording = myRecording(memberId, idParam(req));
  if (recording.status !== 'ready') throw conflict('This lecture is still being processed. Try again in a few minutes.', { code: 'recording_processing' });
  const sameSubject = recording.subject_id ? 'r.subject_id = ?' : 'r.subject_id IS NULL';
  const subjectParams = recording.subject_id ? [recording.subject_id] : [];
  const next = get(
    `${RECORDING_SELECT} WHERE r.batch_id = ? AND ${sameSubject} AND r.published = 1 AND r.status = 'ready'
       AND (r.recorded_at > ? OR (r.recorded_at = ? AND r.id > ?))
     ORDER BY r.recorded_at, r.id LIMIT 1`,
    [recording.batch_id, ...subjectParams, recording.recorded_at, recording.recorded_at, recording.id],
  );
  const number = get(
    `SELECT COUNT(*) AS n FROM class_recordings r WHERE r.batch_id = ? AND ${sameSubject} AND ${SHOWN}
       AND (r.recorded_at < ? OR (r.recorded_at = ? AND r.id <= ?))`,
    [recording.batch_id, ...subjectParams, recording.recorded_at, recording.recorded_at, recording.id],
  ).n;
  res.json({
    ...withProgress([recording], memberId)[0],
    number,
    play_url: playUrl(recording.id, { viewerId: memberId, base: `${req.protocol}://${req.get('host')}${req.tenantPathPrefix || ''}/api/recording-hls` }),
    private_stream: signedSource(recording.source),
    chapters: lectureChapters(recording.live_session_id),
    notes: recording.live_session_id
      ? all(`${MATERIAL_SELECT} WHERE ma.live_session_id = ? ORDER BY ma.id`, [recording.live_session_id])
      : [],
    next: next ? withProgress([next], memberId)[0] : null,
  });
});

/** Where the student got to in a lecture — sent every little while, and when they leave it. */
coachingPortalRoutes.put('/recordings/:id/progress', requireModule('live'), (req, res) => {
  const recording = myRecording(req.member.id, idParam(req));
  const body = parse(req.body, {
    position_sec: { type: 'number', required: true, min: 0, max: 24 * 3600 },
    duration_sec: { type: 'number', min: 0, max: 24 * 3600 },
  });
  res.json(saveProgress(recording.id, req.member.id, { position: body.position_sec, duration: body.duration_sec ?? recording.duration_sec ?? 0 }));
});

coachingPortalRoutes.get('/fees', (req, res) => {
  const plans = plansForMember(req.member.id).filter((p) => p.status !== 'cancelled');
  const payments = all(
    `SELECT p.id, p.amount, p.method, p.paid_on, p.reference, p.cheque_no, p.cheque_status, p.fee_plan_id
     FROM payments p WHERE p.member_id = ? AND p.fee_plan_id IS NOT NULL ORDER BY p.paid_on DESC, p.id DESC`,
    [req.member.id],
  ).map((p) => ({ ...p, receipt_no: receiptNumber(p.id), method: p.cheque_no ? 'cheque' : p.method }));
  res.json({ plans, payments });
});

coachingPortalRoutes.get('/fees/payments/:id/receipt', async (req, res) => {
  const id = idParam(req);
  if (!get('SELECT id FROM payments WHERE id = ? AND member_id = ? AND fee_plan_id IS NOT NULL', [id, req.member.id])) {
    throw notFound('Receipt not found');
  }
  const built = await feeReceiptPdf(id, { instituteName: instituteName(req), logoBuffer: tenantLogo(req), currency: tenantCurrency(req) });
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `attachment; filename="Fee_Receipt_${receiptNumber(id)}.pdf"`);
  res.send(built.pdf);
});
