import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { all, get } from '../db.js';
import { badRequest } from '../errors.js';
import { addDays, today } from '../validate.js';

export const reportRoutes = Router();
reportRoutes.use(requireAuth);

function range(req, defaultDays = 30) {
  return {
    from: String(req.query.from || addDays(today(), -defaultDays)),
    to: String(req.query.to || today()),
  };
}

reportRoutes.get('/revenue', (req, res) => {
  const { from, to } = range(req, 180);
  const bucket = req.query.group === 'day' ? '%Y-%m-%d' : '%Y-%m';

  res.json({
    from,
    to,
    series: all(
      `SELECT strftime('${bucket}', paid_on) AS period,
              SUM(amount) AS amount, COUNT(*) AS payments
       FROM payments WHERE paid_on BETWEEN ? AND ?
       GROUP BY period ORDER BY period`,
      [from, to],
    ),
    by_method: all(
      `SELECT method, SUM(amount) AS amount, COUNT(*) AS payments
       FROM payments WHERE paid_on BETWEEN ? AND ?
       GROUP BY method ORDER BY amount DESC`,
      [from, to],
    ),
    by_plan: all(
      `SELECT COALESCE(p.name, 'Unlinked') AS plan, SUM(pay.amount) AS amount
       FROM payments pay
       LEFT JOIN subscriptions s ON s.id = pay.subscription_id
       LEFT JOIN plans p ON p.id = s.plan_id
       WHERE pay.paid_on BETWEEN ? AND ?
       GROUP BY plan ORDER BY amount DESC`,
      [from, to],
    ),
    totals: get(
      'SELECT COALESCE(SUM(amount), 0) AS amount, COUNT(*) AS payments FROM payments WHERE paid_on BETWEEN ? AND ?',
      [from, to],
    ),
  });
});

reportRoutes.get('/attendance', (req, res) => {
  const { from, to } = range(req, 30);

  res.json({
    from,
    to,
    per_day: all(
      `SELECT date(check_in) AS day, COUNT(*) AS visits, COUNT(DISTINCT member_id) AS unique_members
       FROM attendance WHERE date(check_in) BETWEEN ? AND ?
       GROUP BY day ORDER BY day`,
      [from, to],
    ),
    per_hour: all(
      `SELECT CAST(strftime('%H', check_in) AS INTEGER) AS hour, COUNT(*) AS visits
       FROM attendance WHERE date(check_in) BETWEEN ? AND ?
       GROUP BY hour ORDER BY hour`,
      [from, to],
    ),
    per_weekday: all(
      `SELECT CAST(strftime('%w', check_in) AS INTEGER) AS weekday, COUNT(*) AS visits
       FROM attendance WHERE date(check_in) BETWEEN ? AND ?
       GROUP BY weekday ORDER BY weekday`,
      [from, to],
    ),
    top_members: all(
      `SELECT m.id, m.code, m.first_name, m.last_name, COUNT(*) AS visits
       FROM attendance a JOIN members m ON m.id = a.member_id
       WHERE date(a.check_in) BETWEEN ? AND ?
       GROUP BY m.id ORDER BY visits DESC LIMIT 10`,
      [from, to],
    ),
    inactive_members: all(
      `SELECT m.id, m.code, m.first_name, m.last_name, MAX(a.check_in) AS last_visit
       FROM members m LEFT JOIN attendance a ON a.member_id = m.id
       WHERE m.status = 'active'
       GROUP BY m.id
       HAVING last_visit IS NULL OR date(last_visit) < date('now', '-14 day')
       ORDER BY last_visit LIMIT 20`,
    ),
  });
});

reportRoutes.get('/growth', (_req, res) => {
  res.json({
    joins: all(`
      SELECT strftime('%Y-%m', joined_on) AS month, COUNT(*) AS members
      FROM members WHERE joined_on >= date('now', 'start of month', '-11 month')
      GROUP BY month ORDER BY month
    `),
    renewals: all(`
      SELECT strftime('%Y-%m', start_date) AS month,
             COUNT(*) AS memberships,
             SUM(price - discount) AS value
      FROM subscriptions
      WHERE status != 'cancelled' AND start_date >= date('now', 'start of month', '-11 month')
      GROUP BY month ORDER BY month
    `),
    churn: all(`
      SELECT strftime('%Y-%m', end_date) AS month, COUNT(*) AS expired
      FROM subscriptions
      WHERE status = 'expired' AND end_date >= date('now', 'start of month', '-11 month')
        AND NOT EXISTS (
          SELECT 1 FROM subscriptions later
          WHERE later.member_id = subscriptions.member_id AND later.start_date > subscriptions.end_date
        )
      GROUP BY month ORDER BY month
    `),
  });
});

const EXPORTS = {
  members: {
    filename: 'members.csv',
    sql: `SELECT m.code, m.first_name, m.last_name, m.email, m.phone, m.gender, m.date_of_birth,
                 m.joined_on, m.status,
                 (SELECT p.name FROM subscriptions s JOIN plans p ON p.id = s.plan_id
                  WHERE s.member_id = m.id AND s.status = 'active'
                  ORDER BY s.end_date DESC LIMIT 1) AS current_plan,
                 (SELECT MAX(s.end_date) FROM subscriptions s
                  WHERE s.member_id = m.id AND s.status = 'active') AS membership_end
          FROM members m ORDER BY m.code`,
  },
  payments: {
    filename: 'payments.csv',
    sql: `SELECT pay.paid_on, m.code AS member_code, m.first_name, m.last_name,
                 pay.amount, pay.method, pay.reference, pay.note
          FROM payments pay JOIN members m ON m.id = pay.member_id
          ORDER BY pay.paid_on DESC`,
  },
  attendance: {
    filename: 'attendance.csv',
    sql: `SELECT a.check_in, a.check_out, m.code AS member_code, m.first_name, m.last_name, a.source
          FROM attendance a JOIN members m ON m.id = a.member_id
          ORDER BY a.check_in DESC`,
  },
  subscriptions: {
    filename: 'memberships.csv',
    sql: `SELECT m.code AS member_code, m.first_name, m.last_name, p.name AS plan,
                 s.start_date, s.end_date, s.price, s.discount, s.status
          FROM subscriptions s
          JOIN members m ON m.id = s.member_id
          JOIN plans p ON p.id = s.plan_id
          ORDER BY s.start_date DESC`,
  },
};

const csvCell = (value) => {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

reportRoutes.get('/export/:entity', (req, res) => {
  const spec = EXPORTS[req.params.entity];
  if (!spec) throw badRequest(`Nothing to export for "${req.params.entity}"`, { entity: `try one of: ${Object.keys(EXPORTS).join(', ')}` });

  const rows = all(spec.sql);
  const headers = rows.length ? Object.keys(rows[0]) : [];
  const csv = [headers.join(','), ...rows.map((row) => headers.map((h) => csvCell(row[h])).join(','))].join('\n');

  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${spec.filename}"`);
  res.send(`${csv}\n`);
});
