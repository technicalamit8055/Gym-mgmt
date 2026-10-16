import { Router } from 'express';
import { requireMemberAuth } from '../../auth.js';
import { all, get } from '../../db.js';
import { notFound } from '../../errors.js';
import { addDays, today } from '../../validate.js';
import { requireModule } from '../../verticals.js';
import { attendanceCalendar, studentAttendance, weekdayOf } from '../../coaching/attendance.js';
import { enrollmentsFor } from '../../coaching/enrollment.js';
import { plansForMember, receiptNumber } from '../../coaching/fees.js';
import { feeReceiptPdf } from '../../coaching/notify.js';
import { SLOT_SELECT } from '../../coaching/timetable.js';
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
