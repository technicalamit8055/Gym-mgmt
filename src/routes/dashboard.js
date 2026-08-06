import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { all, get } from '../db.js';
import { autoCloseFinishedVisits, expireOverdueSubscriptions } from '../maintenance.js';
import { config } from '../config.js';

export const dashboardRoutes = Router();
dashboardRoutes.use(requireAuth);

dashboardRoutes.get('/', (req, res) => {
  expireOverdueSubscriptions();
  autoCloseFinishedVisits();

  const members = get(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN status = 'frozen' THEN 1 ELSE 0 END) AS frozen,
      SUM(CASE WHEN status = 'inactive' THEN 1 ELSE 0 END) AS inactive,
      SUM(CASE WHEN joined_on >= date('now', 'start of month') THEN 1 ELSE 0 END) AS joined_this_month
    FROM members
  `);

  const memberships = get(`
    SELECT
      SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN status = 'active' AND end_date <= date('now', '+7 day') THEN 1 ELSE 0 END) AS expiring_soon,
      SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END) AS expired,
      SUM(CASE WHEN status = 'frozen' THEN 1 ELSE 0 END) AS frozen
    FROM subscriptions
  `);

  const revenue = get(`
    SELECT
      COALESCE(SUM(CASE WHEN paid_on = date('now') THEN amount END), 0) AS today,
      COALESCE(SUM(CASE WHEN paid_on >= date('now', 'start of month') THEN amount END), 0) AS this_month,
      COALESCE(SUM(CASE WHEN paid_on >= date('now', 'start of month', '-1 month')
                         AND paid_on < date('now', 'start of month') THEN amount END), 0) AS last_month,
      COALESCE(SUM(amount), 0) AS all_time
    FROM payments
  `);

  const billed = get(
    "SELECT COALESCE(SUM(price - discount), 0) AS total FROM subscriptions WHERE status != 'cancelled'",
  );
  const collected = get('SELECT COALESCE(SUM(amount), 0) AS total FROM payments');
  revenue.outstanding = Math.max(billed.total - collected.total, 0);

  const attendance = get(`
    SELECT
      SUM(CASE WHEN date(check_in) = date('now') THEN 1 ELSE 0 END) AS today,
      SUM(CASE WHEN date(check_in) >= date('now', '-6 day') THEN 1 ELSE 0 END) AS last_7_days,
      SUM(CASE WHEN check_out IS NULL AND date(check_in) = date('now') THEN 1 ELSE 0 END) AS currently_in
    FROM attendance
  `);

  const revenueTrend = all(`
    SELECT strftime('%Y-%m', paid_on) AS month, SUM(amount) AS amount
    FROM payments
    WHERE paid_on >= date('now', 'start of month', '-5 month')
    GROUP BY month ORDER BY month
  `);

  const attendanceTrend = all(`
    SELECT date(check_in) AS day, COUNT(*) AS visits
    FROM attendance
    WHERE date(check_in) >= date('now', '-13 day')
    GROUP BY day ORDER BY day
  `);

  const expiringSoon = all(`
    SELECT s.id, s.end_date, p.name AS plan_name,
           m.id AS member_id, m.code, m.first_name, m.last_name, m.phone
    FROM subscriptions s
    JOIN members m ON m.id = s.member_id
    JOIN plans p ON p.id = s.plan_id
    WHERE s.status = 'active' AND s.end_date <= date('now', '+10 day')
    ORDER BY s.end_date LIMIT 10
  `);

  const recentPayments = all(`
    SELECT pay.id, pay.amount, pay.method, pay.paid_on, m.first_name, m.last_name, m.code
    FROM payments pay JOIN members m ON m.id = pay.member_id
    ORDER BY pay.paid_on DESC, pay.id DESC LIMIT 8
  `);

  const checkedInNow = all(`
    SELECT a.id, a.check_in, m.id AS member_id, m.code, m.first_name, m.last_name, m.photo_url
    FROM attendance a JOIN members m ON m.id = a.member_id
    WHERE a.check_out IS NULL AND date(a.check_in) = date('now')
    ORDER BY a.check_in DESC LIMIT 12
  `);

  const birthdays = all(`
    SELECT id, code, first_name, last_name, date_of_birth
    FROM members
    WHERE date_of_birth IS NOT NULL
      AND strftime('%m-%d', date_of_birth) BETWEEN strftime('%m-%d', 'now')
      AND strftime('%m-%d', 'now', '+14 day')
    ORDER BY strftime('%m-%d', date_of_birth) LIMIT 10
  `);

  const planMix = all(`
    SELECT p.name, COUNT(s.id) AS members
    FROM plans p LEFT JOIN subscriptions s ON s.plan_id = p.id AND s.status = 'active'
    GROUP BY p.id HAVING members > 0 ORDER BY members DESC
  `);

  const equipmentAlerts = all(`
    SELECT id, name, status, next_service_on FROM equipment
    WHERE status = 'maintenance' OR (next_service_on IS NOT NULL AND next_service_on <= date('now', '+14 day'))
    ORDER BY next_service_on LIMIT 8
  `);

  res.json({
    gym: { name: req.tenant?.gym_name ?? config.gymName, currency: req.tenant?.currency ?? config.currency },
    members,
    memberships,
    revenue,
    attendance,
    revenueTrend,
    attendanceTrend,
    expiringSoon,
    recentPayments,
    checkedInNow,
    birthdays,
    planMix,
    equipmentAlerts,
  });
});
