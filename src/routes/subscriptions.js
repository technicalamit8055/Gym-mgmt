import { Router } from 'express';
import { MANAGES_BILLING, requireAuth, requireRole } from '../auth.js';
import { all, get, run, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { expireOverdueSubscriptions } from '../maintenance.js';
import { addDays, parse, today, toInt } from '../validate.js';

export const subscriptionRoutes = Router();
subscriptionRoutes.use(requireAuth);

const SUB_SELECT = `
  SELECT s.*, p.name AS plan_name, p.duration_days,
         m.code AS member_code, m.first_name, m.last_name,
         COALESCE(pay.total, 0) AS paid,
         (s.price - s.discount) - COALESCE(pay.total, 0) AS due
  FROM subscriptions s
  JOIN plans p ON p.id = s.plan_id
  JOIN members m ON m.id = s.member_id
  LEFT JOIN (SELECT subscription_id, SUM(amount) AS total FROM payments GROUP BY subscription_id) pay
    ON pay.subscription_id = s.id
`;

subscriptionRoutes.get('/', (req, res) => {
  expireOverdueSubscriptions();
  const where = [];
  const params = [];

  if (req.query.member_id) {
    where.push('s.member_id = ?');
    params.push(Number(req.query.member_id));
  }
  if (req.query.status) {
    where.push('s.status = ?');
    params.push(String(req.query.status));
  }
  if (req.query.expiring_in) {
    where.push("s.status = 'active' AND s.end_date <= date('now', ?)");
    params.push(`+${toInt(req.query.expiring_in, 7)} day`);
  }
  if (req.query.due === 'true') {
    where.push('(s.price - s.discount) - COALESCE(pay.total, 0) > 0');
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(toInt(req.query.limit, 50), 500);
  res.json({
    items: all(`${SUB_SELECT} ${clause} ORDER BY s.end_date DESC, s.id DESC LIMIT ?`, [...params, limit]),
  });
});

subscriptionRoutes.post('/', requireRole(...MANAGES_BILLING), (req, res) => {
  const body = parse(req.body, {
    member_id: { type: 'int', required: true },
    plan_id: { type: 'int', required: true },
    start_date: { type: 'date' },
    discount: { type: 'number', min: 0, default: 0 },
    note: { type: 'string', max: 300 },
    payment_amount: { type: 'number', min: 0 },
    payment_method: { type: 'enum', values: ['cash', 'card', 'upi', 'bank', 'online'], default: 'cash' },
    reference: { type: 'string', max: 80 },
  });

  const member = get('SELECT * FROM members WHERE id = ?', [body.member_id]);
  if (!member) throw notFound('Member not found');
  const plan = get('SELECT * FROM plans WHERE id = ?', [body.plan_id]);
  if (!plan) throw notFound('Plan not found');
  if (!plan.active) throw badRequest('That plan is archived and cannot be sold');
  if (body.discount > plan.price) throw badRequest('Discount cannot exceed the plan price');

  expireOverdueSubscriptions();
  const current = get(
    "SELECT * FROM subscriptions WHERE member_id = ? AND status = 'active' ORDER BY end_date DESC LIMIT 1",
    [member.id],
  );

  // A renewal picks up the day after the current membership ends so members
  // never lose days they already paid for.
  const startDate = body.start_date || (current && current.end_date >= today() ? addDays(current.end_date, 1) : today());
  if (current && startDate <= current.end_date) {
    throw conflict(`This member already has an active membership until ${current.end_date}`);
  }

  const endDate = addDays(startDate, plan.duration_days - 1);

  const result = tx(() => {
    const info = run(
      `INSERT INTO subscriptions
         (member_id, plan_id, start_date, end_date, price, discount, sessions_total, status, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        member.id,
        plan.id,
        startDate,
        endDate,
        plan.price,
        body.discount,
        plan.sessions ?? null,
        'active',
        body.note ?? null,
      ],
    );
    const subscriptionId = Number(info.lastInsertRowid);

    if (body.payment_amount > 0) {
      run(
        'INSERT INTO payments (member_id, subscription_id, amount, method, paid_on, reference, note) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [
          member.id,
          subscriptionId,
          body.payment_amount,
          body.payment_method,
          today(),
          body.reference ?? null,
          `Payment for ${plan.name}`,
        ],
      );
    }
    if (member.status !== 'active') {
      run("UPDATE members SET status = 'active', updated_at = datetime('now') WHERE id = ?", [member.id]);
    }
    return subscriptionId;
  });

  res.status(201).json(get(`${SUB_SELECT} WHERE s.id = ?`, [result]));
});

subscriptionRoutes.post('/:id/freeze', requireRole(...MANAGES_BILLING), (req, res) => {
  const sub = loadSubscription(req.params.id);
  if (sub.status !== 'active') throw badRequest('Only an active membership can be frozen');
  run("UPDATE subscriptions SET status = 'frozen', frozen_on = ? WHERE id = ?", [today(), sub.id]);
  run("UPDATE members SET status = 'frozen', updated_at = datetime('now') WHERE id = ?", [sub.member_id]);
  res.json(get(`${SUB_SELECT} WHERE s.id = ?`, [sub.id]));
});

subscriptionRoutes.post('/:id/resume', requireRole(...MANAGES_BILLING), (req, res) => {
  const sub = loadSubscription(req.params.id);
  if (sub.status !== 'frozen') throw badRequest('Only a frozen membership can be resumed');

  // Give back the days the membership sat frozen.
  const frozenDays = sub.frozen_on
    ? Math.max(
        Math.round((Date.parse(`${today()}T00:00:00Z`) - Date.parse(`${sub.frozen_on}T00:00:00Z`)) / 86_400_000),
        0,
      )
    : 0;

  run("UPDATE subscriptions SET status = 'active', frozen_on = NULL, end_date = ? WHERE id = ?", [
    addDays(sub.end_date, frozenDays),
    sub.id,
  ]);
  run("UPDATE members SET status = 'active', updated_at = datetime('now') WHERE id = ?", [sub.member_id]);
  res.json({ ...get(`${SUB_SELECT} WHERE s.id = ?`, [sub.id]), days_credited: frozenDays });
});

subscriptionRoutes.post('/:id/cancel', requireRole(...MANAGES_BILLING), (req, res) => {
  const sub = loadSubscription(req.params.id);
  if (sub.status === 'cancelled') throw badRequest('This membership is already cancelled');
  run("UPDATE subscriptions SET status = 'cancelled' WHERE id = ?", [sub.id]);
  res.json(get(`${SUB_SELECT} WHERE s.id = ?`, [sub.id]));
});

function loadSubscription(rawId) {
  const sub = get('SELECT * FROM subscriptions WHERE id = ?', [Number(rawId)]);
  if (!sub) throw notFound('Membership not found');
  return sub;
}
