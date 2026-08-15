import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { gymDateOf, gymDatetimeOf, gymMonthDay } from '../clock.js';
import { all, get } from '../db.js';
import { autoCloseFinishedVisits, expireOverdueSubscriptions } from '../maintenance.js';
import { PHOTO_JOIN, PHOTO_PRESENT_COL, withPhotoUrl } from '../photo.js';
import { config } from '../config.js';
import { seatMap } from '../seats.js';
import { addDays, startOfMonth, today } from '../validate.js';
import { moduleEnabled } from '../verticals.js';

export const dashboardRoutes = Router();
dashboardRoutes.use(requireAuth);

/**
 * Every window on this page is bounded by a *gym-local* calendar date computed
 * here in JS and passed as a parameter, rather than by SQLite's `date('now',
 * …)` — which is UTC, and would put a 5am payment on yesterday's takings and
 * split the morning batch across two days for any gym east of Greenwich.
 * Stored instants (`check_in`) still need converting at the point of use, which
 * is what gymDateOf() is for.
 */
dashboardRoutes.get('/', (req, res) => {
  expireOverdueSubscriptions();
  autoCloseFinishedVisits();

  const now = today();
  const monthStart = startOfMonth(now);
  const day = gymDateOf('check_in');

  const members = get(
    `
    SELECT
      COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END), 0) AS active,
      COALESCE(SUM(CASE WHEN status = 'frozen' THEN 1 ELSE 0 END), 0) AS frozen,
      COALESCE(SUM(CASE WHEN status = 'inactive' THEN 1 ELSE 0 END), 0) AS inactive,
      COALESCE(SUM(CASE WHEN joined_on >= ? THEN 1 ELSE 0 END), 0) AS joined_this_month
    FROM members
  `,
    [monthStart],
  );

  const memberships = get(
    `
    SELECT
      COALESCE(SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END), 0) AS active,
      COALESCE(SUM(CASE WHEN status = 'active' AND end_date <= ? THEN 1 ELSE 0 END), 0) AS expiring_soon,
      COALESCE(SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END), 0) AS expired,
      COALESCE(SUM(CASE WHEN status = 'frozen' THEN 1 ELSE 0 END), 0) AS frozen
    FROM subscriptions
  `,
    [addDays(now, 7)],
  );

  const revenue = get(
    `
    SELECT
      COALESCE(SUM(CASE WHEN paid_on = ? THEN amount END), 0) AS today,
      COALESCE(SUM(CASE WHEN paid_on >= ? THEN amount END), 0) AS this_month,
      COALESCE(SUM(CASE WHEN paid_on >= ? AND paid_on < ? THEN amount END), 0) AS last_month,
      COALESCE(SUM(amount), 0) AS all_time
    FROM payments
  `,
    [now, monthStart, startOfMonth(now, 1), monthStart],
  );

  const billed = get(
    "SELECT COALESCE(SUM(price - discount + addon_total), 0) AS total FROM subscriptions WHERE status != 'cancelled'",
  );
  const collected = get('SELECT COALESCE(SUM(amount), 0) AS total FROM payments');
  revenue.outstanding = Math.max(billed.total - collected.total, 0);

  const attendance = get(
    `
    SELECT
      COALESCE(SUM(CASE WHEN ${day} = ? THEN 1 ELSE 0 END), 0) AS today,
      COALESCE(SUM(CASE WHEN ${day} >= ? THEN 1 ELSE 0 END), 0) AS last_7_days,
      COALESCE(SUM(CASE WHEN check_out IS NULL AND ${day} = ? THEN 1 ELSE 0 END), 0) AS currently_in
    FROM attendance
  `,
    [now, addDays(now, -6), now],
  );

  const revenueTrend = all(
    `
    SELECT strftime('%Y-%m', paid_on) AS month, SUM(amount) AS amount
    FROM payments
    WHERE paid_on >= ?
    GROUP BY month ORDER BY month
  `,
    [startOfMonth(now, 5)],
  );

  const attendanceTrend = all(
    `
    SELECT ${day} AS day, COUNT(*) AS visits
    FROM attendance
    WHERE ${day} >= ?
    GROUP BY day ORDER BY day
  `,
    [addDays(now, -13)],
  );

  const expiringSoon = all(
    `
    SELECT s.id, s.end_date, p.name AS plan_name,
           m.id AS member_id, m.code, m.first_name, m.last_name, m.phone
    FROM subscriptions s
    JOIN members m ON m.id = s.member_id
    JOIN plans p ON p.id = s.plan_id
    WHERE s.status = 'active' AND s.end_date <= ?
    ORDER BY s.end_date LIMIT 10
  `,
    [addDays(now, 10)],
  );

  const recentPayments = all(`
    SELECT pay.id, pay.amount, pay.method, pay.paid_on, m.first_name, m.last_name, m.code
    FROM payments pay JOIN members m ON m.id = pay.member_id
    ORDER BY pay.paid_on DESC, pay.id DESC LIMIT 8
  `);

  const checkedInNow = all(
    `
    SELECT a.id, ${gymDatetimeOf('a.check_in')} AS check_in, m.id AS member_id, m.code, m.first_name, m.last_name,
           m.photo_version, ${PHOTO_PRESENT_COL}
    FROM attendance a
    JOIN members m ON m.id = a.member_id
    ${PHOTO_JOIN}
    WHERE a.check_out IS NULL AND ${gymDateOf('a.check_in')} = ?
    ORDER BY a.check_in DESC LIMIT 12
  `,
    [now],
  ).map((row) => withPhotoUrl(row, 'member_id'));

  // A 14-day birthday window is compared month-day against month-day so it
  // ignores the birth year, which means late December wraps past '12-31' into
  // January: "between 12-25 and 01-08" is empty under a plain BETWEEN, and
  // ordering by month-day would put January's birthdays first. Both cases are
  // handled by rotating the comparison around the start of the window.
  const from = gymMonthDay();
  const to = addDays(now, 14).slice(5);
  const wraps = from > to;
  const birthdays = all(
    `
    SELECT id, code, first_name, last_name, phone, date_of_birth
    FROM members
    WHERE date_of_birth IS NOT NULL
      AND ${wraps
        ? "(strftime('%m-%d', date_of_birth) >= ? OR strftime('%m-%d', date_of_birth) <= ?)"
        : "strftime('%m-%d', date_of_birth) BETWEEN ? AND ?"}
    ORDER BY CASE WHEN strftime('%m-%d', date_of_birth) >= ? THEN 0 ELSE 1 END,
             strftime('%m-%d', date_of_birth)
    LIMIT 10
  `,
    [from, to, from],
  );

  const planMix = all(`
    SELECT p.name, COUNT(s.id) AS members
    FROM plans p LEFT JOIN subscriptions s ON s.plan_id = p.id AND s.status = 'active'
    GROUP BY p.id HAVING members > 0 ORDER BY members DESC
  `);

  const equipmentAlerts = all(
    `
    SELECT id, name, status, next_service_on FROM equipment
    WHERE status = 'maintenance' OR (next_service_on IS NOT NULL AND next_service_on <= ?)
    ORDER BY next_service_on LIMIT 8
  `,
    [addDays(now, 14)],
  );

  // Occupancy by shift and vacant-by-shift replace "Plan mix" and "Equipment"
  // for a library — a seat map is the one thing a gym dashboard has no
  // equivalent of. Reuses seatMap() rather than re-deriving state here, so
  // the tile colour on the map and the number on this card can never drift
  // apart.
  let seats = null;
  if (moduleEnabled('seats')) {
    const map = seatMap({ on: now });
    const totalSeats = map.seats.filter((s) => s.status === 'available').length;
    const totalCells = totalSeats * map.shifts.length;
    seats = {
      occupancy_pct: totalCells ? Math.round((map.occupancy.length / totalCells) * 100) : 0,
      total_seats: totalSeats,
      occupied: map.occupancy.length,
      expiring: map.occupancy.filter((o) => o.state === 'expiring').length,
      dues: map.occupancy.filter((o) => o.state === 'dues').length,
      by_shift: map.shifts.map((shift) => ({
        session_id: shift.id,
        name: shift.name,
        occupied: map.occupancy.filter((o) => o.session_id === shift.id).length,
        capacity: shift.capacity ?? totalSeats,
      })),
    };
  }

  // Collected / spent / net — the strip expenses.js's own summary computes,
  // surfaced here too so it doesn't need its own dashboard visit.
  let expenses = null;
  if (moduleEnabled('expenses')) {
    const spent = get('SELECT COALESCE(SUM(amount), 0) AS total FROM expenses WHERE spent_on >= ? AND spent_on <= ?', [
      monthStart,
      now,
    ]);
    expenses = { spent_this_month: spent.total, net_this_month: revenue.this_month - spent.total };
  }

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
    seats,
    expenses,
  });
});
