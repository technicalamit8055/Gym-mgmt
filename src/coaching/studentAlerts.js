import { all, get } from '../db.js';
import { notifyMember } from '../notifications.js';
import { activeRoster } from './attendance.js';
import { feeReceipt } from './fees.js';
import { formatAmount, formatDay } from './notify.js';

/**
 * CoachBook's pushes to the students themselves — in the app's notification
 * centre and on every phone they turned notifications on for (src/fcm.js for
 * the Android app, Web Push for a browser). The parents' side of the same
 * events goes over WhatsApp (notify.js); this file is the student's.
 *
 *   a class going live          → Live
 *   notes, DPPs, assignments    → Notes & DPPs
 *   a test opened in the app    → Tests
 *   results published           → Tests
 *   a lecture recording ready   → Batches
 *   marked absent today         → Attendance
 *   fee received / fee due      → Fees
 *
 * Every alert carries a dedupe key, so saving a sheet twice, republishing a
 * result after a correction or the fee sweep running again never pushes the
 * same thing twice. None is awaited: a teacher going live must not wait on a
 * phone that is switched off, and a failed push never fails the request.
 *
 * The categories are the notification centre's existing ones (its table has
 * a CHECK on them): class and test news is an `announcement`, fees are
 * `membership` — so a student's existing switches silence them as expected.
 */

/** Sends `n` to each member once, ignoring delivery failures. Returns how many it went to. */
function notifyAll(memberIds, n) {
  const ids = [...new Set(memberIds)];
  for (const memberId of ids) {
    const alert = typeof n === 'function' ? n(memberId) : n;
    if (!alert) continue;
    try {
      notifyMember(memberId, alert).catch((err) => console.error(`[coaching] push to student ${memberId} failed:`, err.message));
    } catch (err) {
      console.error(`[coaching] could not notify student ${memberId}:`, err.message);
    }
  }
  return ids.length;
}

const rosterIds = (batchId) => activeRoster(batchId).map((s) => s.member_id);

/**
 * Who something scoped like a study material reaches: one batch, every
 * active batch of a course, or — scoped to neither — every active batch.
 */
export function studentsFor({ batchId = null, courseId = null } = {}) {
  if (batchId) return rosterIds(batchId);
  const batches = all('SELECT id FROM academic_batches WHERE active = 1 AND (? IS NULL OR course_id = ?)', [courseId, courseId]);
  return batches.flatMap((b) => rosterIds(b.id));
}

const joinParts = (...parts) => parts.filter(Boolean).join(' · ');

/* ── Live classes ────────────────────────────────────────────────────── */

/**
 * "Physics class is live now" to every student on the batch, as soon as the
 * teacher (or the smartboard) puts it on air. High priority, so a phone in
 * Doze still shows it at once, and short-lived: a class that ended an hour
 * ago is not worth delivering to a phone that just came back on.
 *
 * @param {object} session A LIVE_SELECT row (routes/coaching/live.js).
 */
export function announceLiveClass(session) {
  if (!session?.id || !session.batch_id) return 0;
  const subject = session.subject_name || 'Your';
  const what = session.title ? `“${session.title}”` : 'the class';
  return notifyAll(rosterIds(session.batch_id), {
    category: 'announcement',
    title: `${subject} class is live now`,
    body: `${session.faculty_name || 'Your teacher'} has started ${what} for ${session.batch_name}. Tap to join.`,
    screen: 'live',
    dedupeKey: `live:${session.id}`,
    tag: `live-${session.id}`,
    ttl: 60 * 60,
    urgency: 'high',
  });
}

/* ── Study material ──────────────────────────────────────────────────── */

const MATERIAL_LABELS = {
  notes: 'Notes',
  dpp: 'DPP',
  pyq: 'Previous-year paper',
  assignment: 'Assignment',
  syllabus: 'Syllabus',
  solution: 'Solutions',
};

/**
 * A new note, DPP or assignment, to everyone it is for. The key is the one
 * the live class's own "notes are ready" push uses, so a smartboard export
 * is never announced twice.
 */
export function announceMaterial(materialId) {
  const m = get(
    `SELECT ma.id, ma.title, ma.kind, ma.batch_id, ma.course_id, ma.due_date, s.name AS subject_name
     FROM academic_materials ma LEFT JOIN academic_subjects s ON s.id = ma.subject_id WHERE ma.id = ?`,
    [materialId],
  );
  if (!m) return 0;
  const noun = m.kind === 'dpp' ? 'DPP' : (MATERIAL_LABELS[m.kind] || 'Study material').toLowerCase();
  return notifyAll(studentsFor({ batchId: m.batch_id, courseId: m.course_id }), {
    category: 'announcement',
    title: `New ${noun}${m.subject_name ? ` in ${m.subject_name}` : ''}`,
    body: joinParts(m.title, m.due_date ? `due ${formatDay(m.due_date)}` : null) + ' — open it in Notes & DPPs.',
    screen: 'materials',
    dedupeKey: `material:${m.id}`,
    tag: `material-${m.id}`,
    ttl: 24 * 60 * 60,
  });
}

/* ── Tests ───────────────────────────────────────────────────────────── */

const TEST_SELECT = `
  SELECT t.id, t.title, t.batch_id, t.test_date, t.max_marks, t.duration_min, t.online, t.published_at, s.name AS subject_name
  FROM academic_tests t LEFT JOIN academic_subjects s ON s.id = t.subject_id WHERE t.id = ?`;

/** A test opened in the student app: the batch hears it is there to attempt. */
export function announceOnlineTest(testId) {
  const t = get(TEST_SELECT, [testId]);
  if (!t?.online) return 0;
  return notifyAll(rosterIds(t.batch_id), {
    category: 'announcement',
    title: `New test: ${t.title}`,
    body: `${joinParts(t.subject_name, formatDay(t.test_date), t.duration_min ? `${t.duration_min} min` : null, `${t.max_marks} marks`)}. Attempt it in the Tests tab.`,
    screen: 'tests',
    dedupeKey: `test-open:${t.id}`,
    tag: `test-${t.id}`,
    ttl: 24 * 60 * 60,
  });
}

const fmtMarks = (v) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100));

/**
 * Results are out: each student who sat the test hears their own score and
 * rank; one marked absent hears the results are up. Once per test — a
 * republish after corrections updates the app, not the lock screen.
 */
export function announceResults(testId) {
  const t = get(TEST_SELECT, [testId]);
  if (!t?.published_at) return 0;
  const marks = all('SELECT member_id, marks_obtained, is_absent, rank FROM academic_test_marks WHERE test_id = ?', [testId]);
  const byMember = new Map(marks.map((m) => [m.member_id, m]));
  return notifyAll(marks.map((m) => m.member_id), (memberId) => {
    const m = byMember.get(memberId);
    const score = m.is_absent || m.marks_obtained === null
      ? 'You were marked absent for it.'
      : `You scored ${fmtMarks(m.marks_obtained)}/${fmtMarks(t.max_marks)}${m.rank ? ` (rank ${m.rank})` : ''}.`;
    return {
      category: 'announcement',
      title: `Result out: ${t.title}`,
      body: `${score} See the full result in the Tests tab.`,
      screen: 'tests',
      dedupeKey: `test-result:${t.id}`,
      tag: `test-${t.id}`,
      ttl: 3 * 24 * 60 * 60,
    };
  });
}

/* ── Lecture recordings ──────────────────────────────────────────────── */

/** A lecture the batch can now watch — once it is both ready and published. */
export function announceRecording(recordingId) {
  const r = get(
    `SELECT r.id, r.title, r.batch_id, r.status, r.published, s.name AS subject_name
     FROM class_recordings r LEFT JOIN academic_subjects s ON s.id = r.subject_id WHERE r.id = ?`,
    [recordingId],
  );
  if (!r || r.status !== 'ready' || !r.published) return 0;
  return notifyAll(rosterIds(r.batch_id), {
    category: 'announcement',
    title: `${r.subject_name || 'Lecture'} recording is ready`,
    body: `${r.title} — watch it any time from your batch.`,
    screen: 'batches',
    dedupeKey: `recording:${r.id}`,
    tag: `recording-${r.id}`,
    ttl: 24 * 60 * 60,
  });
}

/* ── Attendance ──────────────────────────────────────────────────────── */

/** Each student marked absent on today's sheet, so a wrong mark is caught the same day. */
export function alertAbsentStudents({ batchId, subjectId = null, date }) {
  const rows = all(
    `SELECT a.member_id, b.name AS batch_name, s.name AS subject_name
     FROM batch_attendance a
     JOIN academic_batches b ON b.id = a.batch_id
     LEFT JOIN academic_subjects s ON s.id = a.subject_id
     WHERE a.batch_id = ? AND a.attendance_date = ? AND COALESCE(a.subject_id, 0) = ? AND a.status = 'absent'`,
    [batchId, date, subjectId ?? 0],
  );
  if (!rows.length) return 0;
  const { batch_name: batch, subject_name: subject } = rows[0];
  return notifyAll(rows.map((r) => r.member_id), {
    category: 'announcement',
    title: 'Marked absent today',
    body: `You were marked absent for ${subject ? `${subject} (${batch})` : batch} on ${formatDay(date)}. If that is a mistake, tell your teacher or the office.`,
    screen: 'attendance',
    dedupeKey: `absent:${batchId}:${subjectId ?? 0}:${date}`,
    tag: `absent-${batchId}-${date}`,
    ttl: 12 * 60 * 60,
  });
}

/* ── Fees ────────────────────────────────────────────────────────────── */

/** "Fee received" with the receipt number, as soon as the office records it. */
export function alertFeeReceived(paymentId, { currency = 'INR', receiptNo } = {}) {
  const receipt = feeReceipt(paymentId);
  if (!receipt) return 0;
  const balance = Number(receipt.balance_after || 0);
  return notifyAll([receipt.member_id], {
    category: 'membership',
    title: `Fee received: ${formatAmount(receipt.amount, currency)}`,
    body: `${receiptNo ? `Receipt ${receiptNo}. ` : ''}${balance > 0.005 ? `Balance ${formatAmount(balance, currency)}.` : 'Your fees are fully paid.'} Download the receipt from Fees.`,
    screen: 'fees',
    dedupeKey: `fee-paid:${paymentId}`,
    tag: `fee-paid-${paymentId}`,
    ttl: 3 * 24 * 60 * 60,
  });
}

/**
 * The student's own copy of a fee reminder — the parent's goes on WhatsApp.
 * At most once a day per installment, however often the office presses Remind.
 *
 * @param {object} installment A row as notify.js's sendInstallmentReminder takes it.
 */
export function alertFeeDue(installment, { currency = 'INR', now }) {
  if (!installment?.member_id || !(installment.balance > 0.005)) return 0;
  const overdue = installment.due_date < now;
  return notifyAll([installment.member_id], {
    category: 'membership',
    title: overdue ? 'Fee overdue' : 'Fee due soon',
    body: `Installment ${installment.installment_number}${installment.course_name ? ` for ${installment.course_name}` : ''}: ${formatAmount(installment.balance, currency)} ${overdue ? 'was due' : 'is due'} on ${formatDay(installment.due_date)}. Pay from the Fees tab.`,
    screen: 'fees',
    dedupeKey: `fee-due:${installment.id}:${now}`,
    tag: `fee-due-${installment.id}`,
    ttl: 24 * 60 * 60,
  });
}
