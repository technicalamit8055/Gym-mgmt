import { Router } from 'express';
import { MANAGES_BILLING, requireRole } from '../../auth.js';
import { all, get, run } from '../../db.js';
import { badRequest, notFound } from '../../errors.js';
import { parse, today } from '../../validate.js';
import { requireModule } from '../../verticals.js';
import { whatsappReady } from '../../whatsapp.js';
import {
  bounceCheque,
  clearCheque,
  collectPayment,
  createFeePlan,
  feeSummary,
  getPlan,
  INSTALLMENT_SELECT,
  listDues,
  listPlans,
  receiptNumber,
  rescheduleUnpaid,
} from '../../coaching/fees.js';
import { feeReceiptPdf, sendFeeReceipt, sendInstallmentReminder } from '../../coaching/notify.js';
import { parseFeeInput } from './students.js';
import { dateQuery, idParam, idQuery, instituteName, tenantCurrency, tenantLogo } from './shared.js';

/**
 * Course fees: plans, the installment schedule, collections and receipts.
 * Money, so the whole router is the billing roles' — a teacher has no reason
 * to see what a family has paid.
 */
export const feeRoutes = Router();
feeRoutes.use('/fees', requireModule('fees'), requireRole(...MANAGES_BILLING));

const receiptOptions = (req) => ({ instituteName: instituteName(req), logoBuffer: tenantLogo(req), currency: tenantCurrency(req) });

feeRoutes.get('/fees/summary', (_req, res) => {
  res.json(feeSummary());
});

feeRoutes.get('/fees/plans', (req, res) => {
  res.json({
    items: listPlans({
      status: req.query.status ? String(req.query.status) : null,
      q: String(req.query.q || '').trim(),
      courseId: idQuery(req, 'course_id'),
      batchId: idQuery(req, 'batch_id'),
    }),
  });
});

feeRoutes.get('/fees/plans/:id', (req, res) => {
  const plan = getPlan(idParam(req));
  if (!plan) throw notFound('Fee plan not found');
  res.json(plan);
});

feeRoutes.post('/fees/plans', (req, res) => {
  const ids = parse(req.body, {
    member_id: { type: 'int', required: true, min: 1 },
    course_id: { type: 'int', required: true, min: 1 },
    batch_id: { type: 'int', min: 1 },
  });
  const fee = parseFeeInput(req.body);
  const planId = createFeePlan({ ...fee, ...ids });
  res.status(201).json(getPlan(planId));
});

/** Cancelling (a student who left before paying), flagging as defaulted, or
 * re-opening. Money already collected stays collected either way. */
feeRoutes.patch('/fees/plans/:id', (req, res) => {
  const id = idParam(req);
  if (!get('SELECT id FROM student_fee_plans WHERE id = ?', [id])) throw notFound('Fee plan not found');
  const body = parse(req.body, {
    status: { type: 'enum', values: ['active', 'defaulted', 'cancelled'] },
    note: { type: 'string', max: 300 },
    discount_reason: { type: 'string', max: 120 },
  });
  const columns = Object.keys(body);
  if (!columns.length) throw badRequest('Nothing to update');
  run(`UPDATE student_fee_plans SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [...columns.map((c) => body[c]), id]);
  res.json(getPlan(id));
});

feeRoutes.put('/fees/plans/:id/schedule', (req, res) => {
  res.json(rescheduleUnpaid(idParam(req), req.body?.installments));
});

feeRoutes.post('/fees/plans/:id/payments', async (req, res) => {
  const planId = idParam(req);
  const body = parse(req.body, {
    amount: { type: 'number', required: true, min: 0.01 },
    method: { type: 'enum', values: ['cash', 'upi', 'card', 'bank', 'online', 'cheque'], default: 'cash' },
    paid_on: { type: 'date' },
    reference: { type: 'string', max: 80 },
    cheque_no: { type: 'string', max: 30 },
    note: { type: 'string', max: 300 },
    installment_id: { type: 'int', min: 1 },
    send_receipt: { type: 'boolean', default: 1 },
  });
  if (body.method === 'cheque' && !body.cheque_no) throw badRequest('Enter the cheque number', { cheque_no: 'is required' });
  if (body.paid_on && body.paid_on > today()) throw badRequest('A payment cannot be dated in the future', { paid_on: 'in the future' });

  const { payment_id: paymentId, items } = collectPayment(planId, body);
  let whatsapp = { queued: 0 };
  if (body.send_receipt) {
    whatsapp = await sendFeeReceipt(paymentId, receiptOptions(req)).catch((err) => {
      console.error('[coaching] fee receipt failed:', err.message);
      return { queued: 0, error: err.message };
    });
  }
  res.status(201).json({
    payment_id: paymentId,
    receipt_no: receiptNumber(paymentId),
    items,
    plan: getPlan(planId),
    whatsapp,
  });
});

feeRoutes.get('/fees/dues', (req, res) => {
  const window = ['overdue', 'upcoming', 'all'].includes(req.query.window) ? req.query.window : 'all';
  const days = Math.min(Math.max(Number.parseInt(req.query.days, 10) || 7, 1), 90);
  res.json({ items: listDues({ window, days, courseId: idQuery(req, 'course_id'), batchId: idQuery(req, 'batch_id') }) });
});

function installmentForReminder(id) {
  return get(
    `SELECT inst.*, fp.member_id, c.name AS course_name, m.first_name, m.last_name, m.phone, m.emergency_phone
     FROM (${INSTALLMENT_SELECT}) inst
     JOIN student_fee_plans fp ON fp.id = inst.plan_id
     JOIN academic_courses c ON c.id = fp.course_id
     JOIN members m ON m.id = fp.member_id
     WHERE inst.id = ?`,
    [today(), id],
  );
}

feeRoutes.post('/fees/installments/:id/remind', (req, res) => {
  const installment = installmentForReminder(idParam(req));
  if (!installment) throw notFound('Installment not found');
  if (installment.balance <= 0.005) throw badRequest('That installment is already paid');
  if (!whatsappReady()) throw badRequest('WhatsApp is not connected. Link it on the WhatsApp page first.');
  const sent = sendInstallmentReminder(installment, { instituteName: instituteName(req), currency: tenantCurrency(req), now: today() });
  if (!sent) throw badRequest('No guardian or student phone number on file');
  res.json({ ok: true, queued: 1 });
});

/** "Remind every defaulter now": each overdue installment not already
 * reminded today. */
feeRoutes.post('/fees/remind-overdue', (req, res) => {
  if (!whatsappReady()) throw badRequest('WhatsApp is not connected. Link it on the WhatsApp page first.');
  const now = today();
  let queued = 0;
  let skipped = 0;
  for (const due of listDues({ window: 'overdue' })) {
    if (due.reminder_sent_at && due.reminder_sent_at.slice(0, 10) === new Date().toISOString().slice(0, 10)) continue;
    const installment = installmentForReminder(due.id);
    if (sendInstallmentReminder(installment, { instituteName: instituteName(req), currency: tenantCurrency(req), now })) queued += 1;
    else skipped += 1;
  }
  res.json({ queued, skipped });
});

/** The collections register: every fee payment in a date range. */
feeRoutes.get('/fees/payments', (req, res) => {
  const from = dateQuery(req, 'from', `${today().slice(0, 7)}-01`);
  const to = dateQuery(req, 'to', today());
  const where = ['p.fee_plan_id IS NOT NULL', 'p.paid_on BETWEEN ? AND ?'];
  const params = [from, to];
  if (req.query.cheque === 'pending') where.push("p.cheque_status = 'pending'");
  const items = all(
    `SELECT p.*, m.code AS member_code, m.first_name, m.last_name, c.name AS course_name, b.name AS batch_name
     FROM payments p
     JOIN members m ON m.id = p.member_id
     JOIN student_fee_plans fp ON fp.id = p.fee_plan_id
     JOIN academic_courses c ON c.id = fp.course_id
     LEFT JOIN academic_batches b ON b.id = fp.batch_id
     WHERE ${where.join(' AND ')}
     ORDER BY p.paid_on DESC, p.id DESC LIMIT 1000`,
    params,
  ).map((row) => ({ ...row, receipt_no: receiptNumber(row.id), method: row.cheque_no ? 'cheque' : row.method }));
  const byMethod = {};
  for (const row of items) byMethod[row.method] = (byMethod[row.method] || 0) + row.amount;
  res.json({ from, to, items, total: items.reduce((acc, r) => acc + r.amount, 0), by_method: byMethod });
});

feeRoutes.get('/fees/payments/:id/receipt', async (req, res) => {
  const built = await feeReceiptPdf(idParam(req), receiptOptions(req));
  if (!built) throw notFound('Fee payment not found');
  const receiptNo = receiptNumber(built.receipt.id);
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `attachment; filename="Fee_Receipt_${receiptNo}.pdf"`);
  res.send(built.pdf);
});

feeRoutes.post('/fees/payments/:id/send-receipt', async (req, res) => {
  const id = idParam(req);
  if (!get('SELECT id FROM payments WHERE id = ? AND fee_plan_id IS NOT NULL', [id])) throw notFound('Fee payment not found');
  if (!whatsappReady()) throw badRequest('WhatsApp is not connected. Link it on the WhatsApp page first.');
  const result = await sendFeeReceipt(id, { ...receiptOptions(req), force: true });
  if (!result.queued) throw badRequest('No guardian or student phone number on file');
  res.json({ ok: true, ...result });
});

feeRoutes.post('/fees/payments/:id/cheque', (req, res) => {
  const id = idParam(req);
  const body = parse(req.body, { action: { type: 'enum', values: ['clear', 'bounce'], required: true } });
  if (body.action === 'clear') {
    clearCheque(id);
    return res.json({ ok: true, cleared: true });
  }
  const bounced = bounceCheque(id);
  return res.json({ ok: true, bounced: true, amount: bounced.amount, plan: bounced.fee_plan_id ? getPlan(bounced.fee_plan_id) : null });
});

/** The admin's undo for a payment entered by mistake. Its installment items
 * cascade away and the plan's balance corrects itself. */
feeRoutes.delete('/fees/payments/:id', requireRole('admin'), (req, res) => {
  const id = idParam(req);
  const payment = get('SELECT fee_plan_id FROM payments WHERE id = ? AND fee_plan_id IS NOT NULL', [id]);
  if (!payment) throw notFound('Fee payment not found');
  run('DELETE FROM payments WHERE id = ?', [id]);
  res.json({ ok: true, plan: getPlan(payment.fee_plan_id) });
});
