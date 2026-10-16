import { all, get, run, tenantStorage } from '../db.js';
import { generateReceiptPdf } from '../receiptPdf.js';
import { renderTemplate, sendWhatsAppMessage, whatsappReady } from '../whatsapp.js';
import { feeReceipt, receiptNumber } from './fees.js';

/**
 * CoachBook's parent messages, sent through the institute's own linked
 * WhatsApp (src/whatsapp.js): absentee alerts, fee reminders, fee receipts
 * and test scorecards.
 *
 * Every send is queued, never awaited by the caller — sendWhatsAppMessage
 * paces sends itself (a whole batch's absentees at once is exactly the burst
 * WhatsApp flags) and writes the delivery log either way. What each function
 * returns is what it *queued*, so the screen can say "Alerts going out to 4
 * parents" straight away.
 *
 * The flags that stop a second send (batch_attendance.whatsapp_sent,
 * academic_test_marks.whatsapp_sent, an installment's reminder_sent_at) are
 * set when the message is queued and put back if it fails, so re-saving an
 * attendance sheet never alerts a parent twice, and a failure is retried the
 * next time instead of being lost.
 */

export function coachingSettings() {
  return get('SELECT * FROM coaching_settings WHERE id = 1') ?? {};
}

/** The number a parent message goes to: the guardian's, else the student's own. */
export const guardianPhone = (row) => {
  const guardian = String(row?.emergency_phone ?? '').trim();
  return guardian || String(row?.phone ?? '').trim() || null;
};

const studentName = (row) => `${row.first_name || ''} ${row.last_name || ''}`.trim();

export function formatAmount(amount, currency = 'INR') {
  const value = Number(amount || 0);
  try {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency,
      maximumFractionDigits: value % 1 === 0 ? 0 : 2,
    }).format(value);
  } catch {
    return `${currency} ${value.toFixed(0)}`;
  }
}

/** DD/MM/YYYY, the way an Indian parent reads a date. */
export function formatDay(iso) {
  if (!iso) return '';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

const formatTime = (hhmm) => {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};

/**
 * Queues one message and returns whether it was queued. `onFailed` runs
 * inside the tenant's context, which the queued send has long left by the
 * time WhatsApp answers.
 */
function queue({ phone, message, type, memberId, document = null, onFailed }) {
  const store = tenantStorage.getStore();
  sendWhatsAppMessage({ phone, message, type, memberId, document }).catch((err) => {
    console.error(`[coaching] ${type} message failed:`, err.message);
    if (!onFailed) return;
    try {
      if (store) tenantStorage.run(store, onFailed);
      else onFailed();
    } catch (undoErr) {
      console.error(`[coaching] could not re-arm the ${type} message:`, undoErr.message);
    }
  });
}

const notLinked = () => ({ queued: 0, skipped: 0, connected: false });

/* ── Absentee alerts ─────────────────────────────────────────────────── */

/**
 * Alerts the guardian of every student marked absent (and late, if the
 * institute turned that on) on one attendance sheet who has not been alerted
 * for it yet.
 */
export function sendAbsenceAlerts({ batchId, subjectId = null, date, instituteName }) {
  const settings = coachingSettings();
  if (!settings.absence_alerts && !settings.late_alerts) return { queued: 0, skipped: 0, connected: whatsappReady(), disabled: true };
  if (!whatsappReady()) return notLinked();

  const statuses = [settings.absence_alerts ? 'absent' : null, settings.late_alerts ? 'late' : null].filter(Boolean);
  const rows = all(
    `SELECT a.id, a.status, a.member_id, m.first_name, m.last_name, m.phone, m.emergency_phone,
            b.name AS batch_name, s.name AS subject_name
     FROM batch_attendance a
     JOIN members m ON m.id = a.member_id
     JOIN academic_batches b ON b.id = a.batch_id
     LEFT JOIN academic_subjects s ON s.id = a.subject_id
     WHERE a.batch_id = ? AND a.attendance_date = ? AND COALESCE(a.subject_id, 0) = ?
       AND a.whatsapp_sent = 0 AND a.status IN (${statuses.map(() => '?').join(', ')})`,
    [batchId, date, subjectId ?? 0, ...statuses],
  );

  const lecture = subjectId ? lectureTiming(batchId, subjectId, date) : null;
  let queued = 0;
  let skipped = 0;
  for (const row of rows) {
    const phone = guardianPhone(row);
    if (!phone) {
      skipped += 1;
      continue;
    }
    const template = row.status === 'late' ? settings.late_template : settings.absence_template;
    const message = renderTemplate(template, {
      student_name: studentName(row),
      first_name: row.first_name,
      date: formatDay(date),
      subject_name: row.subject_name
        ? `${row.subject_name}${lecture ? `, ${formatTime(lecture.start_time)} – ${formatTime(lecture.end_time)}` : ''}`
        : 'class',
      batch_name: row.batch_name,
      institute_name: instituteName,
      phone: settings.institute_phone || 'the office',
    });
    run('UPDATE batch_attendance SET whatsapp_sent = 1 WHERE id = ?', [row.id]);
    queue({
      phone,
      message,
      type: 'absence',
      memberId: row.member_id,
      onFailed: () => run('UPDATE batch_attendance SET whatsapp_sent = 0 WHERE id = ?', [row.id]),
    });
    queued += 1;
  }
  return { queued, skipped, connected: true };
}

/** The timetabled lecture for this batch and subject on that weekday, if any. */
function lectureTiming(batchId, subjectId, date) {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return get(
    'SELECT start_time, end_time FROM academic_timetable WHERE batch_id = ? AND subject_id = ? AND weekday = ? AND active = 1 ORDER BY start_time LIMIT 1',
    [batchId, subjectId, weekday],
  );
}

/* ── Low-attendance warnings ─────────────────────────────────────────── */

/** Warns the guardians of students below the threshold for `from`..`to`. */
export function sendLowAttendanceAlerts({ rows, batchName, instituteName }) {
  if (!whatsappReady()) return notLinked();
  const settings = coachingSettings();
  let queued = 0;
  let skipped = 0;
  for (const row of rows) {
    const phone = guardianPhone(row);
    if (!phone) {
      skipped += 1;
      continue;
    }
    queue({
      phone,
      type: 'attendance_low',
      memberId: row.member_id,
      message: renderTemplate(settings.low_attendance_template, {
        student_name: studentName(row),
        batch_name: batchName,
        percentage: row.percentage,
        threshold: settings.low_attendance_threshold,
        institute_name: instituteName,
      }),
    });
    queued += 1;
  }
  return { queued, skipped, connected: true };
}

/* ── Fee receipts ────────────────────────────────────────────────────── */

export async function feeReceiptPdf(paymentId, { instituteName, logoBuffer = null, currency = 'INR' } = {}) {
  const receipt = feeReceipt(paymentId);
  if (!receipt) return null;
  const settings = coachingSettings();
  const pdf = await generateReceiptPdf(
    { ...receipt, receipt_no: receiptNumber(paymentId), person_label: 'Student' },
    { gymName: instituteName, logoBuffer, currency, gstin: settings.gstin || null, title: 'FEE RECEIPT' },
  );
  return { receipt, pdf };
}

/** The receipt, PDF attached, to the guardian — sent as soon as a fee is collected. */
export async function sendFeeReceipt(paymentId, { instituteName, logoBuffer = null, currency = 'INR', force = false } = {}) {
  const settings = coachingSettings();
  if (!force && !settings.fee_receipts) return { queued: 0, disabled: true };
  if (!whatsappReady()) return notLinked();
  const built = await feeReceiptPdf(paymentId, { instituteName, logoBuffer, currency });
  if (!built) return { queued: 0 };
  const { receipt, pdf } = built;
  const phone = guardianPhone(receipt);
  if (!phone) return { queued: 0, skipped: 1, connected: true };
  queue({
    phone,
    type: 'fee_receipt',
    memberId: receipt.member_id,
    document: { buffer: pdf, fileName: `Fee_Receipt_${receiptNumber(paymentId)}.pdf`, mimetype: 'application/pdf' },
    message: renderTemplate(settings.fee_receipt_template, {
      student_name: studentName(receipt),
      amount: formatAmount(receipt.amount, currency),
      receipt_no: receiptNumber(paymentId),
      balance_amount: formatAmount(receipt.balance_after, currency),
      course_name: receipt.course_name,
      institute_name: instituteName,
    }),
  });
  return { queued: 1, connected: true };
}

/* ── Fee reminders ───────────────────────────────────────────────────── */

/** One installment's reminder: "due on" before the date, "still pending" after. */
export function sendInstallmentReminder(installment, { instituteName, currency = 'INR', now }) {
  const settings = coachingSettings();
  const phone = guardianPhone(installment);
  if (!phone) return false;
  const overdue = installment.due_date < now;
  const sentBefore = installment.reminder_sent_at;
  run("UPDATE student_fee_installments SET reminder_sent_at = datetime('now') WHERE id = ?", [installment.id]);
  queue({
    phone,
    type: 'fee_due',
    memberId: installment.member_id,
    message: renderTemplate(overdue ? settings.fee_overdue_template : settings.fee_due_template, {
      student_name: studentName(installment),
      installment_no: installment.installment_number,
      amount: formatAmount(installment.balance, currency),
      due_date: formatDay(installment.due_date),
      course_name: installment.course_name,
      institute_name: instituteName,
    }),
    onFailed: () => run('UPDATE student_fee_installments SET reminder_sent_at = ? WHERE id = ?', [sentBefore ?? null, installment.id]),
  });
  return true;
}

/* ── Test scorecards ─────────────────────────────────────────────────── */

/**
 * "Dear Parent, Aarav scored 88/100 (Rank 3 of 42)…" to every guardian of a
 * student who sat the test and has not had this scorecard yet. Absent
 * students are skipped — there is no score to send.
 */
export function sendScorecards(testId, { instituteName, stats }) {
  if (!whatsappReady()) return notLinked();
  const settings = coachingSettings();
  const test = get(
    `SELECT t.*, s.name AS subject_name FROM academic_tests t
     LEFT JOIN academic_subjects s ON s.id = t.subject_id WHERE t.id = ?`,
    [testId],
  );
  if (!test) return { queued: 0 };
  const rows = all(
    `SELECT tm.*, m.first_name, m.last_name, m.phone, m.emergency_phone
     FROM academic_test_marks tm JOIN members m ON m.id = tm.member_id
     WHERE tm.test_id = ? AND tm.is_absent = 0 AND tm.whatsapp_sent = 0`,
    [testId],
  );
  const fmt = (v) => (v === null || v === undefined ? '—' : Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100));
  let queued = 0;
  let skipped = 0;
  for (const row of rows) {
    const phone = guardianPhone(row);
    if (!phone) {
      skipped += 1;
      continue;
    }
    run('UPDATE academic_test_marks SET whatsapp_sent = 1 WHERE id = ?', [row.id]);
    queue({
      phone,
      type: 'scorecard',
      memberId: row.member_id,
      message: renderTemplate(settings.scorecard_template, {
        student_name: studentName(row),
        marks_obtained: fmt(row.marks_obtained),
        max_marks: fmt(test.max_marks),
        percentage: fmt((row.marks_obtained / test.max_marks) * 100),
        rank: row.rank ?? '—',
        total_students: stats.appeared,
        highest: fmt(stats.highest),
        average: fmt(stats.average),
        test_title: test.title,
        subject_name: test.subject_name || '',
        institute_name: instituteName,
      }),
      onFailed: () => run('UPDATE academic_test_marks SET whatsapp_sent = 0 WHERE id = ?', [row.id]),
    });
    queued += 1;
  }
  return { queued, skipped, connected: true };
}
