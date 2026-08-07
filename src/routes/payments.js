import { Router } from 'express';
import { MANAGES_BILLING, requireAuth, requireRole } from '../auth.js';
import { all, get, run } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { parse, today, toInt } from '../validate.js';

export const paymentRoutes = Router();
paymentRoutes.use(requireAuth);

const PAYMENT_SELECT = `
  SELECT pay.*, m.code AS member_code, m.first_name, m.last_name, m.phone,
         p.name AS plan_name, s.start_date, s.end_date, s.price, s.discount
  FROM payments pay
  JOIN members m ON m.id = pay.member_id
  LEFT JOIN subscriptions s ON s.id = pay.subscription_id
  LEFT JOIN plans p ON p.id = s.plan_id
`;

paymentRoutes.get('/', (req, res) => {
  const where = [];
  const params = [];
  if (req.query.member_id) {
    where.push('pay.member_id = ?');
    params.push(Number(req.query.member_id));
  }
  if (req.query.method) {
    where.push('pay.method = ?');
    params.push(String(req.query.method));
  }
  if (req.query.from) {
    where.push('pay.paid_on >= ?');
    params.push(String(req.query.from));
  }
  if (req.query.to) {
    where.push('pay.paid_on <= ?');
    params.push(String(req.query.to));
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(toInt(req.query.limit, 50), 500);
  const items = all(`${PAYMENT_SELECT} ${clause} ORDER BY pay.paid_on DESC, pay.id DESC LIMIT ?`, [
    ...params,
    limit,
  ]);
  const totals = get(
    `SELECT COUNT(*) AS count, COALESCE(SUM(pay.amount), 0) AS amount FROM payments pay ${clause}`,
    params,
  );
  res.json({ items, totals });
});

paymentRoutes.post('/', requireRole(...MANAGES_BILLING), (req, res) => {
  const body = parse(req.body, {
    member_id: { type: 'int', required: true },
    subscription_id: { type: 'int' },
    amount: { type: 'number', required: true, min: 0.01 },
    method: { type: 'enum', values: ['cash', 'card', 'upi', 'bank', 'online'], default: 'cash' },
    // Defaulted here rather than left to the column's own DEFAULT (date('now')),
    // which is UTC — a 5am cash payment at an IST gym would land on yesterday's
    // takings and never appear in "collected today".
    paid_on: { type: 'date', default: today() },
    reference: { type: 'string', max: 80 },
    note: { type: 'string', max: 300 },
  });

  if (!get('SELECT id FROM members WHERE id = ?', [body.member_id])) throw notFound('Member not found');
  if (body.subscription_id) {
    const sub = get('SELECT member_id FROM subscriptions WHERE id = ?', [body.subscription_id]);
    if (!sub) throw notFound('Membership not found');
    if (sub.member_id !== body.member_id) {
      throw badRequest('That membership belongs to a different member', { subscription_id: 'mismatch' });
    }
  }

  const columns = Object.keys(body).filter((k) => body[k] !== null);
  const info = run(
    `INSERT INTO payments (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    columns.map((c) => body[c]),
  );
  res.status(201).json(get(`${PAYMENT_SELECT} WHERE pay.id = ?`, [info.lastInsertRowid]));
});

paymentRoutes.get('/:id/receipt', (req, res) => {
  const payment = get(`${PAYMENT_SELECT} WHERE pay.id = ?`, [Number(req.params.id)]);
  if (!payment) throw notFound('Payment not found');
  res.json(payment);
});

paymentRoutes.delete('/:id', requireRole('admin'), (req, res) => {
  const info = run('DELETE FROM payments WHERE id = ?', [Number(req.params.id)]);
  if (!info.changes) throw notFound('Payment not found');
  res.json({ ok: true });
});
