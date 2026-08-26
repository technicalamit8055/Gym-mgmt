import { Router } from 'express';
import { hashPassword, issueMemberToken, requireMemberAuth, verifyPassword } from '../auth.js';
import { config, DEFAULT_TENANT_SLUG } from '../config.js';
import { ATTENDANCE_SELECT, publicVisit } from '../checkin.js';
import { all, get, getBusinessType, run, tx } from '../db.js';
import { badRequest, conflict, notFound, tooManyRequests, unauthorized } from '../errors.js';
import { expireOverdueSubscriptions } from '../maintenance.js';
import { MEMBER_SELECT, publicMember } from './members.js';
import { generateReceiptPdf } from '../receiptPdf.js';
import { ensureQrToken, qrPayload, qrPngDataUrl, qrSvg } from '../qr.js';
import { createLimiter } from '../rateLimit.js';
import { addDays, parse, today, toInt } from '../validate.js';
import { moduleEnabled, requireModule } from '../verticals.js';
import { gymDateOf } from '../clock.js';

/**
 * Member self-service portal: the app a member/student signs into directly,
 * as opposed to every other route in src/routes/, which a staff account
 * drives on their behalf. Auth is requireMemberAuth (a distinct token scope —
 * see auth.js), not requireAuth, so a staff session cannot reach these and a
 * member session cannot reach the staff API.
 */
export const portalRoutes = Router();

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const portalLoginLimiter = createLimiter({
  maxAttempts: config.loginMaxAttempts,
  windowMs: config.loginWindowMs,
  lockoutMs: config.loginLockoutMs,
});

/**
 * The one-time bootstrap PIN a member who has never set a real one can sign
 * in with: the last 4 digits of their phone, or the last 4 characters of
 * their member code when there's no phone (or too few digits) on file.
 * Never stored anywhere — checked fresh against the live member row every
 * time, so editing a member's phone number changes their bootstrap PIN too.
 */
function defaultPin(member) {
  const phoneDigits = String(member.phone || '').replace(/\D/g, '');
  const source = phoneDigits.length >= 4 ? phoneDigits : member.code;
  return source.slice(-4).toUpperCase();
}

/** Consecutive gym-local days (ending today or yesterday) with at least one
 * check-in — capped to a 60-day lookback, which is far more than any real
 * streak, so this stays a cheap indexed scan rather than a full table read. */
function attendanceStreak(memberId) {
  const rows = all(
    `SELECT DISTINCT ${gymDateOf('check_in')} AS d FROM attendance WHERE member_id = ? ORDER BY d DESC LIMIT 60`,
    [memberId],
  );
  const days = new Set(rows.map((r) => r.d));
  let cursor = today();
  if (!days.has(cursor)) cursor = addDays(cursor, -1);
  let streak = 0;
  while (days.has(cursor)) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

/* ── Sign in ───────────────────────────────────────────────────────────── */

portalRoutes.post('/login', (req, res) => {
  const tenantSlug = req.tenant?.slug ?? DEFAULT_TENANT_SLUG;
  const body = parse(req.body, {
    identifier: { type: 'string', required: true, max: 60 },
    pin: { type: 'string', required: true, max: 10 },
  });

  const limiterKey = `${tenantSlug}:${req.ip}:${body.identifier.toLowerCase()}`;
  const gate = portalLoginLimiter.check(limiterKey);
  if (gate.locked) {
    res.set('Retry-After', String(gate.retryAfterSeconds));
    throw tooManyRequests('Too many failed attempts. Try again later.');
  }

  const member =
    get('SELECT * FROM members WHERE code = ? COLLATE NOCASE', [body.identifier]) ??
    get('SELECT * FROM members WHERE phone = ?', [body.identifier]);

  if (!member) {
    portalLoginLimiter.recordAttempt(limiterKey);
    throw unauthorized('We could not find a member with that phone number or member ID');
  }

  const usingBootstrapPin = !member.portal_pin_hash;
  const valid = usingBootstrapPin
    ? body.pin.toUpperCase() === defaultPin(member)
    : verifyPassword(body.pin, member.portal_pin_hash);

  if (!valid) {
    portalLoginLimiter.recordAttempt(limiterKey);
    throw unauthorized('Incorrect PIN');
  }

  portalLoginLimiter.recordSuccess(limiterKey);
  run("UPDATE members SET last_portal_login = datetime('now') WHERE id = ?", [member.id]);

  res.json({
    token: issueMemberToken(member, tenantSlug),
    member: publicMember(get(`${MEMBER_SELECT} WHERE m.id = ?`, [member.id])),
    must_set_pin: usingBootstrapPin,
  });
});

portalRoutes.post('/pin', requireMemberAuth, (req, res) => {
  const body = parse(req.body, {
    current_pin: { type: 'string', max: 10 },
    new_pin: { type: 'string', required: true, min: 4, max: 6 },
  });
  if (!/^\d{4,6}$/.test(body.new_pin)) {
    throw badRequest('PIN must be 4 to 6 digits', { new_pin: 'must be 4-6 digits' });
  }

  const member = req.member;
  const usingBootstrapPin = !member.portal_pin_hash;
  const currentValid = usingBootstrapPin
    ? String(body.current_pin || '').toUpperCase() === defaultPin(member)
    : Boolean(body.current_pin) && verifyPassword(body.current_pin, member.portal_pin_hash);
  if (!currentValid) throw badRequest('Current PIN is incorrect', { current_pin: 'does not match' });

  run('UPDATE members SET portal_pin_hash = ? WHERE id = ?', [hashPassword(body.new_pin), member.id]);
  res.json({ ok: true });
});

/* ── Home / profile ───────────────────────────────────────────────────── */

portalRoutes.get('/me', requireMemberAuth, (req, res) => {
  expireOverdueSubscriptions();
  const member = publicMember(get(`${MEMBER_SELECT} WHERE m.id = ?`, [req.member.id]));

  const subscription = get(
    `SELECT s.*, p.name AS plan_name, p.duration_days, sess.name AS session_name,
            COALESCE(pay.total, 0) AS paid,
            (s.price - s.discount + s.addon_total) - COALESCE(pay.total, 0) AS due
     FROM subscriptions s JOIN plans p ON p.id = s.plan_id
     LEFT JOIN sessions sess ON sess.id = s.session_id
     LEFT JOIN (SELECT subscription_id, SUM(amount) AS total FROM payments GROUP BY subscription_id) pay
       ON pay.subscription_id = s.id
     WHERE s.member_id = ? AND s.status = 'active' ORDER BY s.end_date DESC LIMIT 1`,
    [member.id],
  );

  let locker = null;
  if (moduleEnabled('lockers')) {
    locker = get(
      `SELECT lk.code, la.end_date AS held_until, la.key_issued
       FROM locker_allocations la JOIN lockers lk ON lk.id = la.locker_id
       WHERE la.member_id = ? AND la.status = 'active'`,
      [member.id],
    );
  }

  const visitsThisMonth = get(
    `SELECT COUNT(*) AS n FROM attendance WHERE member_id = ? AND ${gymDateOf('check_in')} >= date(?, 'start of month')`,
    [member.id, today()],
  ).n;

  res.json({
    member,
    subscription: subscription ?? null,
    days_left: subscription
      ? Math.round((Date.parse(`${subscription.end_date}T00:00:00Z`) - Date.parse(`${today()}T00:00:00Z`)) / 86_400_000)
      : null,
    sessions_left:
      subscription && subscription.sessions_total !== null
        ? subscription.sessions_total - subscription.sessions_used
        : null,
    locker,
    stats: {
      visits_this_month: visitsThisMonth,
      total_visits: member.visit_count,
      streak_days: attendanceStreak(member.id),
    },
    vertical: getBusinessType(),
  });
});

/** SeatBook's assigned-seat + shift card — every seat this student currently
 * holds (a student can hold Morning and Evening at once). */
portalRoutes.get('/seat', requireMemberAuth, requireModule('seats'), (req, res) => {
  res.json({
    items: all(
      `SELECT sa.id AS allocation_id, sa.start_date, sa.end_date, sa.session_id,
              se.code AS seat_code, se.row_label, se.seat_type, z.name AS zone_name,
              sess.name AS session_name, sess.start_time, sess.end_time
       FROM seat_allocations sa
       JOIN seats se ON se.id = sa.seat_id
       LEFT JOIN seat_zones z ON z.id = se.zone_id
       JOIN sessions sess ON sess.id = sa.session_id
       WHERE sa.member_id = ? AND sa.status = 'active'
       ORDER BY sess.sort_order`,
      [req.member.id],
    ),
  });
});

/* ── Digital pass ──────────────────────────────────────────────────────── */

portalRoutes.get('/pass', requireMemberAuth, async (req, res) => {
  const token = ensureQrToken(req.member.id);
  const [svg, png] = await Promise.all([qrSvg(token), qrPngDataUrl(token)]);
  res.json({
    payload: qrPayload(token),
    svg,
    png,
    issued_at: get('SELECT qr_issued_at FROM members WHERE id = ?', [req.member.id])?.qr_issued_at ?? null,
    server_time: new Date().toISOString(),
  });
});

/* ── Classes (GymBook) ────────────────────────────────────────────────── */

portalRoutes.get('/classes', requireMemberAuth, requireModule('classes'), (req, res) => {
  const start = String(req.query.week_start || today());
  const rows = all(
    `SELECT c.*, u.name AS trainer_name,
            date(?, '+' || ((c.weekday - CAST(strftime('%w', ?) AS INTEGER) + 7) % 7) || ' day') AS class_date
     FROM classes c LEFT JOIN users u ON u.id = c.trainer_id
     WHERE c.active = 1
     ORDER BY class_date, c.start_time`,
    [start, start],
  );

  const items = rows.map((row) => {
    const booked = get(
      "SELECT COUNT(*) AS n FROM bookings WHERE class_id = ? AND class_date = ? AND status != 'cancelled'",
      [row.id, row.class_date],
    ).n;
    const mine = get(
      "SELECT id FROM bookings WHERE class_id = ? AND class_date = ? AND member_id = ? AND status != 'cancelled'",
      [row.id, row.class_date, req.member.id],
    );
    return {
      ...row,
      weekday_name: WEEKDAYS[row.weekday],
      booked,
      seats_left: row.capacity - booked,
      my_booking_id: mine?.id ?? null,
    };
  });

  res.json({ week_start: start, items });
});

portalRoutes.post('/classes/:id/book', requireMemberAuth, requireModule('classes'), (req, res) => {
  const body = parse(req.body, { class_date: { type: 'date', required: true } });
  const klass = get('SELECT * FROM classes WHERE id = ?', [Number(req.params.id)]);
  if (!klass) throw notFound('Class not found');
  if (!klass.active) throw badRequest('That class is not running');

  const dayOfWeek = new Date(`${body.class_date}T00:00:00Z`).getUTCDay();
  if (dayOfWeek !== klass.weekday) {
    throw badRequest(`${klass.name} runs on ${WEEKDAYS[klass.weekday]}`, { class_date: 'wrong weekday' });
  }
  if (body.class_date < today()) throw badRequest('Pick a date that has not passed yet');

  const bookingId = tx(() => {
    const booked = get(
      "SELECT COUNT(*) AS n FROM bookings WHERE class_id = ? AND class_date = ? AND status != 'cancelled'",
      [klass.id, body.class_date],
    ).n;
    if (booked >= klass.capacity) throw conflict(`${klass.name} on ${body.class_date} is full`);

    const existing = get('SELECT * FROM bookings WHERE class_id = ? AND member_id = ? AND class_date = ?', [
      klass.id,
      req.member.id,
      body.class_date,
    ]);
    if (existing) {
      if (existing.status !== 'cancelled') throw conflict('You are already booked into this class');
      run("UPDATE bookings SET status = 'booked' WHERE id = ?", [existing.id]);
      return existing.id;
    }

    return run('INSERT INTO bookings (class_id, member_id, class_date) VALUES (?, ?, ?)', [
      klass.id,
      req.member.id,
      body.class_date,
    ]).lastInsertRowid;
  });

  res.status(201).json(
    get(
      `SELECT b.*, c.name AS class_name, c.start_time, c.room
       FROM bookings b JOIN classes c ON c.id = b.class_id WHERE b.id = ?`,
      [bookingId],
    ),
  );
});

portalRoutes.delete('/classes/bookings/:bookingId', requireMemberAuth, requireModule('classes'), (req, res) => {
  const booking = get('SELECT * FROM bookings WHERE id = ?', [Number(req.params.bookingId)]);
  if (!booking || booking.member_id !== req.member.id) throw notFound('Booking not found');
  run("UPDATE bookings SET status = 'cancelled' WHERE id = ?", [booking.id]);
  res.json({ ok: true });
});

/* ── Payments & invoices ──────────────────────────────────────────────── */

portalRoutes.get('/payments', requireMemberAuth, (req, res) => {
  const limit = Math.min(toInt(req.query.limit, 50), 200);
  res.json({
    items: all(
      `SELECT pay.id, pay.amount, pay.method, pay.paid_on, pay.reference, pay.note, p.name AS plan_name
       FROM payments pay
       LEFT JOIN subscriptions s ON s.id = pay.subscription_id
       LEFT JOIN plans p ON p.id = s.plan_id
       WHERE pay.member_id = ?
       ORDER BY pay.paid_on DESC, pay.id DESC LIMIT ?`,
      [req.member.id, limit],
    ),
  });
});

portalRoutes.get('/payments/:id/receipt', requireMemberAuth, async (req, res) => {
  const payment = get(
    `SELECT pay.*, m.code AS member_code, m.first_name, m.last_name, m.phone,
            p.name AS plan_name, s.start_date, s.end_date, s.price, s.discount
     FROM payments pay
     JOIN members m ON m.id = pay.member_id
     LEFT JOIN subscriptions s ON s.id = pay.subscription_id
     LEFT JOIN plans p ON p.id = s.plan_id
     WHERE pay.id = ?`,
    [Number(req.params.id)],
  );
  if (!payment || payment.member_id !== req.member.id) throw notFound('Payment not found');

  const gymName = req.tenant?.gym_name || config.gymName || 'GymBook';
  const pdfBuffer = await generateReceiptPdf(payment, {
    gymName,
    logoBuffer: req.tenant?.logo_bytes ? Buffer.from(req.tenant.logo_bytes) : null,
  });
  const receiptNo = `PAY-${String(payment.id).padStart(5, '0')}`;
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `attachment; filename="Receipt_${receiptNo}.pdf"`);
  res.send(pdfBuffer);
});

/* ── Attendance ────────────────────────────────────────────────────────── */

portalRoutes.get('/attendance', requireMemberAuth, (req, res) => {
  const limit = Math.min(toInt(req.query.limit, 30), 200);
  res.json({
    items: all(`${ATTENDANCE_SELECT} WHERE a.member_id = ? ORDER BY a.check_in DESC LIMIT ?`, [
      req.member.id,
      limit,
    ]).map(publicVisit),
    streak_days: attendanceStreak(req.member.id),
  });
});

/* ── Renewal plans ─────────────────────────────────────────────────────── */

portalRoutes.get('/plans', requireMemberAuth, (_req, res) => {
  res.json({
    items: all(
      'SELECT id, name, description, price, duration_days, sessions, session_id FROM plans WHERE active = 1 ORDER BY price',
    ),
  });
});
