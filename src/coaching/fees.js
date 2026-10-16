import { all, get, run, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { addDays, today } from '../validate.js';

/**
 * The installment engine.
 *
 * A student's course fee is a *plan* (what the family agreed to pay, after any
 * concession) split into *installments* (how much is due when). A payment is
 * an ordinary `payments` row — so the dashboard, the reports and the member's
 * balance count it with no special case — plus one fee_payment_items row per
 * installment it went towards.
 *
 * Nothing about "how much is paid" is stored: an installment's paid amount is
 * the sum of its items, and its status follows from that and today's date.
 * Deleting a payment (the admin's undo, or a bounced cheque) cascades its
 * items away and every figure here corrects itself.
 */

/** Plans are capped at 12 installments by the CHECK; the UI offers 1–6, the
 * spec's "milestone billing" range, but a custom schedule may use up to 12. */
export const MAX_INSTALLMENTS = 12;

/** Money is handled in the currency's minor unit while splitting, so a
 * ₹45,000 fee in three parts sums back to exactly ₹45,000. */
const toMinor = (amount) => Math.round(Number(amount) * 100);
const fromMinor = (minor) => minor / 100;
const EPSILON = 0.005;

/**
 * An even split of `total` over `installments`, due every `intervalDays` from
 * `startDate` (the first is due on the start date itself — "at admission").
 * Whole currency units where possible; whatever does not divide evenly lands
 * on the first installment, which is the one collected at the desk.
 */
export function buildSchedule({ total, installments, startDate, intervalDays = 30 }) {
  const n = Math.max(1, Math.min(MAX_INSTALLMENTS, Number(installments) || 1));
  const totalMinor = toMinor(total);
  const wholeUnits = totalMinor % 100 === 0;
  const base = wholeUnits ? Math.floor(totalMinor / 100 / n) * 100 : Math.floor(totalMinor / n);
  const first = totalMinor - base * (n - 1);
  return Array.from({ length: n }, (_, i) => ({
    installment_number: i + 1,
    label: n === 1 ? 'Full fee' : i === 0 ? 'At admission' : `Installment ${i + 1}`,
    amount_due: fromMinor(i === 0 ? first : base),
    due_date: addDays(startDate, i * intervalDays),
  }));
}

/**
 * Installments with what has been paid against them and where each stands.
 * `paid_on` is the day the last payment towards it landed — the date a fully
 * paid installment shows as cleared.
 */
export const INSTALLMENT_SELECT = `
  SELECT i.*,
         COALESCE(paid.total, 0)                AS amount_paid,
         i.amount_due - COALESCE(paid.total, 0) AS balance,
         paid.last_paid_on                      AS paid_on,
         CASE
           WHEN i.amount_due - COALESCE(paid.total, 0) <= ${EPSILON} THEN 'paid'
           WHEN i.due_date < ? THEN 'overdue'
           WHEN COALESCE(paid.total, 0) > 0 THEN 'partially_paid'
           ELSE 'pending'
         END AS status
  FROM student_fee_installments i
  LEFT JOIN (
    SELECT fi.installment_id, SUM(fi.amount) AS total, MAX(p.paid_on) AS last_paid_on
    FROM fee_payment_items fi JOIN payments p ON p.id = fi.payment_id
    GROUP BY fi.installment_id
  ) paid ON paid.installment_id = i.id
`;

/** Each plan with its course, batch and running totals. Takes today() twice. */
export const PLAN_SELECT = `
  SELECT fp.*, c.name AS course_name, c.academic_year, b.name AS batch_name, b.code AS batch_code,
         m.code AS member_code, m.first_name, m.last_name, m.phone, m.emergency_contact, m.emergency_phone,
         COALESCE(totals.paid, 0)                   AS amount_paid,
         fp.final_amount - COALESCE(totals.paid, 0) AS balance,
         totals.next_due_date, totals.overdue_amount,
         CASE
           WHEN fp.status IN ('cancelled', 'defaulted') THEN fp.status
           WHEN fp.final_amount - COALESCE(totals.paid, 0) <= ${EPSILON} THEN 'paid'
           WHEN COALESCE(totals.overdue_amount, 0) > ${EPSILON} THEN 'overdue'
           ELSE 'active'
         END AS effective_status
  FROM student_fee_plans fp
  JOIN academic_courses c ON c.id = fp.course_id
  JOIN members m ON m.id = fp.member_id
  LEFT JOIN academic_batches b ON b.id = fp.batch_id
  LEFT JOIN (
    SELECT inst.plan_id,
           SUM(inst.amount_paid) AS paid,
           MIN(CASE WHEN inst.balance > ${EPSILON} THEN inst.due_date END) AS next_due_date,
           SUM(CASE WHEN inst.balance > ${EPSILON} AND inst.due_date < ? THEN inst.balance ELSE 0 END) AS overdue_amount
    FROM (${INSTALLMENT_SELECT}) inst
    GROUP BY inst.plan_id
  ) totals ON totals.plan_id = fp.id
`;

const planParams = () => [today(), today()];

export function getPlan(planId) {
  const plan = get(`${PLAN_SELECT} WHERE fp.id = ?`, [...planParams(), planId]);
  if (!plan) return null;
  plan.components = parseComponents(plan.components);
  plan.installments = all(`${INSTALLMENT_SELECT} WHERE i.plan_id = ? ORDER BY i.installment_number`, [today(), planId]);
  plan.payments = all(
    `SELECT p.id, p.amount, p.method, p.paid_on, p.reference, p.note, p.cheque_no, p.cheque_status
     FROM payments p WHERE p.fee_plan_id = ? ORDER BY p.paid_on DESC, p.id DESC`,
    [planId],
  );
  return plan;
}

export function plansForMember(memberId) {
  return all(`${PLAN_SELECT} WHERE fp.member_id = ? ORDER BY fp.created_at DESC, fp.id DESC`, [
    ...planParams(),
    memberId,
  ]).map((plan) => ({
    ...plan,
    components: parseComponents(plan.components),
    installments: all(`${INSTALLMENT_SELECT} WHERE i.plan_id = ? ORDER BY i.installment_number`, [today(), plan.id]),
  }));
}

/** Plans for a list view, filtered by the effective status and a search. */
export function listPlans({ status, q, courseId, batchId, limit = 200 } = {}) {
  const where = [];
  const params = [...planParams()];
  if (courseId) {
    where.push('fp.course_id = ?');
    params.push(courseId);
  }
  if (batchId) {
    where.push('fp.batch_id = ?');
    params.push(batchId);
  }
  if (q) {
    where.push("(m.first_name LIKE ? OR m.last_name LIKE ? OR m.code LIKE ? OR m.phone LIKE ? OR (m.first_name || ' ' || m.last_name) LIKE ?)");
    params.push(...Array(5).fill(`%${q}%`));
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = all(`SELECT * FROM (${PLAN_SELECT} ${clause}) ${status ? 'WHERE effective_status = ?' : ''} ORDER BY next_due_date IS NULL, next_due_date, id DESC LIMIT ?`, [
    ...params,
    ...(status ? [status] : []),
    limit,
  ]);
  return rows.map((row) => ({ ...row, components: parseComponents(row.components) }));
}

/**
 * Installments still owing something, soonest first — the collections list.
 * `window` is 'overdue' (past due), 'upcoming' (due within `days`), or
 * anything else for both.
 */
export function listDues({ window = 'all', days = 7, courseId, batchId } = {}) {
  const now = today();
  const where = ["inst.balance > ?", "fp.status NOT IN ('cancelled')"];
  const params = [today(), EPSILON];
  if (window === 'overdue') {
    where.push('inst.due_date < ?');
    params.push(now);
  } else if (window === 'upcoming') {
    where.push('inst.due_date >= ? AND inst.due_date <= ?');
    params.push(now, addDays(now, days));
  }
  if (courseId) {
    where.push('fp.course_id = ?');
    params.push(courseId);
  }
  if (batchId) {
    where.push('fp.batch_id = ?');
    params.push(batchId);
  }
  return all(
    `SELECT inst.*, fp.member_id, fp.course_id, fp.batch_id, c.name AS course_name, b.name AS batch_name,
            m.code AS member_code, m.first_name, m.last_name, m.phone, m.emergency_contact, m.emergency_phone,
            CAST(julianday(?) - julianday(inst.due_date) AS INTEGER) AS days_overdue
     FROM (${INSTALLMENT_SELECT}) inst
     JOIN student_fee_plans fp ON fp.id = inst.plan_id
     JOIN academic_courses c ON c.id = fp.course_id
     JOIN members m ON m.id = fp.member_id
     LEFT JOIN academic_batches b ON b.id = fp.batch_id
     WHERE ${where.join(' AND ')}
     ORDER BY inst.due_date, m.first_name`,
    [now, ...params],
  );
}

/** Headline numbers for the fees screen and the dashboard. */
export function feeSummary() {
  const now = today();
  const monthStart = `${now.slice(0, 7)}-01`;
  const totals = get(
    `SELECT COALESCE(SUM(fp.final_amount), 0) AS billed,
            COALESCE(SUM(fp.discount_amount), 0) AS concessions,
            COUNT(*) AS plans
     FROM student_fee_plans fp WHERE fp.status != 'cancelled'`,
  );
  const collected = get(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE fee_plan_id IS NOT NULL`,
  ).total;
  const thisMonth = get(
    'SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE fee_plan_id IS NOT NULL AND paid_on >= ?',
    [monthStart],
  ).total;
  const dueRows = all(
    `SELECT inst.balance, inst.due_date FROM (${INSTALLMENT_SELECT}) inst
     JOIN student_fee_plans fp ON fp.id = inst.plan_id
     WHERE fp.status != 'cancelled' AND inst.balance > ?`,
    [now, EPSILON],
  );
  const overdue = dueRows.filter((r) => r.due_date < now);
  const week = addDays(now, 7);
  const upcoming = dueRows.filter((r) => r.due_date >= now && r.due_date <= week);
  const sum = (rows) => Math.round(rows.reduce((acc, r) => acc + r.balance, 0) * 100) / 100;
  const pendingCheques = get(
    "SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total FROM payments WHERE cheque_status = 'pending'",
  );
  return {
    billed: totals.billed,
    concessions: totals.concessions,
    plans: totals.plans,
    collected,
    collected_this_month: thisMonth,
    outstanding: sum(dueRows),
    overdue_amount: sum(overdue),
    overdue_count: overdue.length,
    due_this_week_amount: sum(upcoming),
    due_this_week_count: upcoming.length,
    pending_cheques: pendingCheques.n,
    pending_cheque_amount: pendingCheques.total,
    // Leakage, the number an owner actually loses sleep over: what fell due
    // and was not collected, as a share of everything that has fallen due.
    collection_rate: (() => {
      const fallenDue = get(
        `SELECT COALESCE(SUM(inst.amount_due), 0) AS due, COALESCE(SUM(inst.amount_paid), 0) AS paid
         FROM (${INSTALLMENT_SELECT}) inst JOIN student_fee_plans fp ON fp.id = inst.plan_id
         WHERE fp.status != 'cancelled' AND inst.due_date <= ?`,
        [now, now],
      );
      return fallenDue.due > 0 ? Math.round((Math.min(fallenDue.paid, fallenDue.due) / fallenDue.due) * 1000) / 10 : null;
    })(),
  };
}

/** { label, amount }[] from the JSON column, tolerating a hand-edited row. */
export function parseComponents(value) {
  if (!value) return [];
  try {
    const list = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(list)
      ? list
          .filter((c) => c && String(c.label || '').trim() && Number.isFinite(Number(c.amount)))
          .map((c) => ({ label: String(c.label).trim().slice(0, 60), amount: Number(c.amount) }))
      : [];
  } catch {
    return [];
  }
}

/** Validates a components list sent by a client; returns the JSON to store. */
export function componentsJson(list) {
  if (list === undefined || list === null || list === '') return null;
  if (!Array.isArray(list)) throw badRequest('Fee components must be a list', { components: 'must be a list' });
  const clean = parseComponents(list);
  if (clean.some((c) => c.amount < 0)) throw badRequest('Fee components cannot be negative', { components: 'negative amount' });
  return clean.length ? JSON.stringify(clean) : null;
}

/**
 * Checks a client-supplied schedule and normalises it: 1 to 12 rows, each a
 * positive amount on a real date, numbered in date order, summing exactly to
 * the plan's payable amount.
 */
export function normaliseSchedule(rows, finalAmount) {
  if (!Array.isArray(rows) || !rows.length) throw badRequest('Add at least one installment', { installments: 'required' });
  if (rows.length > MAX_INSTALLMENTS) {
    throw badRequest(`At most ${MAX_INSTALLMENTS} installments`, { installments: 'too many' });
  }
  const clean = rows.map((row, i) => {
    const amount = Number(row?.amount_due);
    const due = String(row?.due_date || '');
    if (!(amount > 0)) throw badRequest(`Installment ${i + 1} needs an amount above zero`, { installments: 'amount' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(due) || Number.isNaN(Date.parse(due))) {
      throw badRequest(`Installment ${i + 1} needs a due date`, { installments: 'due_date' });
    }
    return { amount_due: Math.round(amount * 100) / 100, due_date: due, label: row?.label ? String(row.label).trim().slice(0, 40) : null };
  });
  clean.sort((a, b) => a.due_date.localeCompare(b.due_date));
  const sum = clean.reduce((acc, row) => acc + toMinor(row.amount_due), 0);
  if (Math.abs(sum - toMinor(finalAmount)) > 0) {
    throw badRequest(
      `The installments add up to ${fromMinor(sum)}, but the fee after concession is ${finalAmount}`,
      { installments: 'must add up to the payable fee' },
    );
  }
  return clean.map((row, i) => ({ ...row, installment_number: i + 1, label: row.label || (i === 0 && clean.length > 1 ? 'At admission' : clean.length === 1 ? 'Full fee' : `Installment ${i + 1}`) }));
}

/**
 * Creates a student's fee plan and its installments in one transaction.
 * The schedule is either given outright (`schedule`) or built from
 * `installments` + `interval_days` starting `start_date`.
 */
export function createFeePlan(input) {
  const course = get('SELECT id FROM academic_courses WHERE id = ?', [input.course_id]);
  if (!course) throw notFound('Course not found');
  if (!get('SELECT id FROM members WHERE id = ?', [input.member_id])) throw notFound('Student not found');
  if (input.batch_id) {
    const batch = get('SELECT course_id FROM academic_batches WHERE id = ?', [input.batch_id]);
    if (!batch) throw notFound('Batch not found');
    if (batch.course_id !== input.course_id) throw badRequest('That batch belongs to a different course', { batch_id: 'mismatch' });
  }
  if (input.fee_structure_id && !get('SELECT id FROM fee_structures WHERE id = ? AND course_id = ?', [input.fee_structure_id, input.course_id])) {
    throw notFound('Fee structure not found for this course');
  }

  const total = Number(input.total_amount);
  const discount = Number(input.discount_amount || 0);
  if (discount > total + EPSILON) throw badRequest('The concession is larger than the fee', { discount_amount: 'too large' });
  const finalAmount = Math.round((total - discount) * 100) / 100;
  if (finalAmount <= 0) throw badRequest('A fully waived course needs no fee plan', { discount_amount: 'covers the whole fee' });

  const schedule = input.schedule
    ? normaliseSchedule(input.schedule, finalAmount)
    : buildSchedule({
        total: finalAmount,
        installments: input.installments || 1,
        startDate: input.start_date || today(),
        intervalDays: input.interval_days ?? 30,
      });

  return tx(() => {
    const info = run(
      `INSERT INTO student_fee_plans
         (member_id, course_id, batch_id, fee_structure_id, total_amount, discount_amount, discount_reason, final_amount, components, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.member_id,
        input.course_id,
        input.batch_id ?? null,
        input.fee_structure_id ?? null,
        total,
        discount,
        input.discount_reason || null,
        finalAmount,
        input.components ?? null,
        input.note || null,
      ],
    );
    const planId = Number(info.lastInsertRowid);
    for (const row of schedule) {
      run(
        'INSERT INTO student_fee_installments (plan_id, installment_number, label, amount_due, due_date) VALUES (?, ?, ?, ?, ?)',
        [planId, row.installment_number, row.label, row.amount_due, row.due_date],
      );
    }
    return planId;
  });
}

/**
 * Replaces the unpaid part of a plan's schedule — moving a due date, or
 * re-splitting what is left into more installments. Installments that have
 * money against them stay as they are; the new rows must add up to what the
 * plan still has to collect beyond those.
 */
export function rescheduleUnpaid(planId, rows) {
  const plan = getPlan(planId);
  if (!plan) throw notFound('Fee plan not found');
  if (plan.status === 'cancelled') throw badRequest('This fee plan is cancelled');
  const kept = plan.installments.filter((i) => i.amount_paid > EPSILON);
  // A part-paid installment is closed off at what was actually paid, so the
  // remainder can be rescheduled with everything else.
  const keptTotal = kept.reduce((acc, i) => acc + i.amount_paid, 0);
  const remaining = Math.round((plan.final_amount - keptTotal) * 100) / 100;
  if (remaining <= EPSILON) throw badRequest('Nothing is left to reschedule on this plan');
  const schedule = normaliseSchedule(rows, remaining);
  if (kept.length + schedule.length > MAX_INSTALLMENTS) {
    throw badRequest(`At most ${MAX_INSTALLMENTS} installments in all`, { installments: 'too many' });
  }

  tx(() => {
    for (const inst of plan.installments) {
      if (inst.amount_paid > EPSILON) {
        if (inst.balance > EPSILON) run('UPDATE student_fee_installments SET amount_due = ? WHERE id = ?', [inst.amount_paid, inst.id]);
      } else {
        run('DELETE FROM student_fee_installments WHERE id = ?', [inst.id]);
      }
    }
    // Renumber kept rows out of the way first, so the UNIQUE (plan, number)
    // never trips while the new rows go in.
    const keptIds = kept.map((i) => i.id);
    keptIds.forEach((id, i) => run('UPDATE student_fee_installments SET installment_number = ? WHERE id = ?', [1000 + i, id]));
    keptIds.forEach((id, i) => run('UPDATE student_fee_installments SET installment_number = ? WHERE id = ?', [i + 1, id]));
    schedule.forEach((row, i) => {
      run(
        'INSERT INTO student_fee_installments (plan_id, installment_number, label, amount_due, due_date) VALUES (?, ?, ?, ?, ?)',
        [planId, kept.length + i + 1, row.label, row.amount_due, row.due_date],
      );
    });
  });
  return getPlan(planId);
}

/**
 * Records a fee payment against a plan and spreads it over the installments,
 * earliest due first — or, when `installment_id` is given, that one first and
 * any excess onward from there. Refuses more than the plan still owes: an
 * overpayment is a refund waiting to happen, and the desk should see it now.
 */
export function collectPayment(planId, input) {
  const plan = getPlan(planId);
  if (!plan) throw notFound('Fee plan not found');
  if (plan.status === 'cancelled') throw badRequest('This fee plan is cancelled');
  const amount = Math.round(Number(input.amount) * 100) / 100;
  if (!(amount > 0)) throw badRequest('Enter an amount above zero', { amount: 'must be above zero' });
  if (amount - plan.balance > EPSILON) {
    throw conflict(`Only ${plan.balance} is left to pay on this plan`, { amount: 'more than the balance' });
  }

  let order = plan.installments.filter((i) => i.balance > EPSILON);
  if (input.installment_id) {
    const target = order.find((i) => i.id === input.installment_id);
    if (!target) throw badRequest('That installment is already paid or is not on this plan', { installment_id: 'not payable' });
    order = [target, ...order.filter((i) => i.id !== target.id)];
  }

  const isCheque = input.method === 'cheque';
  return tx(() => {
    const info = run(
      `INSERT INTO payments (member_id, amount, method, paid_on, reference, note, fee_plan_id, cheque_no, cheque_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        plan.member_id,
        amount,
        isCheque ? 'bank' : input.method || 'cash',
        input.paid_on || today(),
        input.reference || (isCheque && input.cheque_no ? `Cheque ${input.cheque_no}` : null),
        input.note || null,
        planId,
        isCheque ? input.cheque_no || null : null,
        isCheque ? 'pending' : null,
      ],
    );
    const paymentId = Number(info.lastInsertRowid);
    let left = toMinor(amount);
    const items = [];
    for (const inst of order) {
      if (left <= 0) break;
      const take = Math.min(left, toMinor(inst.balance));
      if (take <= 0) continue;
      run('INSERT INTO fee_payment_items (payment_id, installment_id, amount) VALUES (?, ?, ?)', [paymentId, inst.id, fromMinor(take)]);
      items.push({ installment_id: inst.id, installment_number: inst.installment_number, amount: fromMinor(take) });
      left -= take;
    }
    return { payment_id: paymentId, items };
  });
}

/** A cheque that has cleared stops showing as "pending" on the fees screen. */
export function clearCheque(paymentId) {
  const info = run("UPDATE payments SET cheque_status = 'cleared' WHERE id = ? AND cheque_status = 'pending'", [paymentId]);
  if (!info.changes) throw notFound('No pending cheque with that receipt number');
}

/**
 * A bounced cheque was never money: the payment is removed, its
 * installment items cascade with it, and those installments fall due again.
 * Returns what the payment had been, for the confirmation message.
 */
export function bounceCheque(paymentId) {
  const payment = get("SELECT id, amount, fee_plan_id, cheque_no FROM payments WHERE id = ? AND cheque_status = 'pending'", [paymentId]);
  if (!payment) throw notFound('No pending cheque with that receipt number');
  run('DELETE FROM payments WHERE id = ?', [paymentId]);
  return payment;
}

/** Everything the receipt PDF and the WhatsApp receipt need about one payment. */
export function feeReceipt(paymentId) {
  const payment = get(
    `SELECT p.*, m.code AS member_code, m.first_name, m.last_name, m.phone, m.emergency_contact, m.emergency_phone
     FROM payments p JOIN members m ON m.id = p.member_id
     WHERE p.id = ? AND p.fee_plan_id IS NOT NULL`,
    [paymentId],
  );
  if (!payment) return null;
  const plan = getPlan(payment.fee_plan_id);
  const items = all(
    `SELECT fi.amount, i.installment_number, i.label, i.due_date
     FROM fee_payment_items fi JOIN student_fee_installments i ON i.id = fi.installment_id
     WHERE fi.payment_id = ? ORDER BY i.installment_number`,
    [paymentId],
  );
  // The balance as it stood once this payment landed — a reprint of an old
  // receipt must not show today's balance.
  const paidThrough = get(
    `SELECT COALESCE(SUM(amount), 0) AS total FROM payments
     WHERE fee_plan_id = ? AND (paid_on < ? OR (paid_on = ? AND id <= ?))`,
    [payment.fee_plan_id, payment.paid_on, payment.paid_on, payment.id],
  ).total;
  return {
    ...payment,
    method: payment.cheque_no ? 'cheque' : payment.method,
    course_name: plan?.course_name,
    batch_name: plan?.batch_name,
    academic_year: plan?.academic_year,
    plan_total: plan?.total_amount,
    plan_discount: plan?.discount_amount,
    plan_final: plan?.final_amount,
    components: plan?.components ?? [],
    fee_items: items,
    balance_after: Math.max(0, Math.round(((plan?.final_amount ?? 0) - paidThrough) * 100) / 100),
  };
}

export const receiptNumber = (paymentId) => `FEE-${String(paymentId).padStart(5, '0')}`;
