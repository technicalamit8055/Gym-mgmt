import { Router } from 'express';
import { hashPassword, issueMemberToken, requireMemberAuth, verifyPassword } from '../auth.js';
import { config, DEFAULT_TENANT_SLUG } from '../config.js';
import { ATTENDANCE_SELECT, publicVisit } from '../checkin.js';
import { all, get, getBusinessType, run, tx } from '../db.js';
import { badRequest, conflict, notFound, paymentRequired, tooManyRequests, unauthorized } from '../errors.js';
import {
  MEAL_TYPES,
  MUSCLE_GROUPS,
  SET_TYPES,
  estimate1rm,
  fitnessAccessFor,
  previousSetsFor,
  recordPersonalRecords,
  summariseSets,
} from '../fitness.js';
import { expireOverdueSubscriptions } from '../maintenance.js';
import { MEMBER_SELECT, publicMember } from './members.js';
import { dietPlanTree } from './diets.js';
import { workoutPlanTree } from './workouts.js';
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

/* ── Diet & workout tracking ──────────────────────────────────────────── */

/**
 * The paywall, as one middleware.
 *
 * 402 rather than 403: the member is not forbidden, they simply have not paid,
 * and the two want different screens. `code` lets the portal tell this apart
 * from the tenant-level 402 requireActiveSubscription raises (a lapsed *gym*,
 * which is nothing the member can fix) and show the upgrade sheet instead of
 * an error.
 *
 * Every fitness route below carries it, not just the writes: a member without
 * the add-on must not be able to read their plan either, or the paywall is
 * decoration.
 */
function requireFitnessAccess(req, _res, next) {
  const access = fitnessAccessFor(req.member.id);
  if (!access.has_access) {
    return next(
      paymentRequired('Diet & Workout tracking is a paid add-on at this gym', {
        code: 'fitness_addon_required',
        monthly_price: access.settings.monthly_price,
      }),
    );
  }
  req.fitnessAccess = access;
  return next();
}

portalRoutes.get('/fitness/status', requireMemberAuth, requireModule('fitness'), (req, res) => {
  res.json(fitnessAccessFor(req.member.id));
});

/**
 * Today's session, plus the whole routine so the member can train out of order.
 *
 * Which day is "today" follows the routine's own rotation, not the calendar:
 * someone on Push/Pull/Legs who misses Monday wants Push on Tuesday, not to
 * have skipped it. A calendar-locked rotation would quietly delete a workout
 * from their week every time life got in the way.
 */
portalRoutes.get('/workouts/current', requireMemberAuth, requireModule('fitness'), requireFitnessAccess, (req, res) => {
  const assignment = get(
    `SELECT a.*, u.name AS assigned_by_name
     FROM member_workout_assignments a
     LEFT JOIN users u ON u.id = a.assigned_by
     WHERE a.member_id = ? AND a.status = 'active'`,
    [req.member.id],
  );

  if (!assignment) {
    return res.json({ assignment: null, plan: null, today_day: null, previous: {}, streak_days: 0 });
  }

  const plan = workoutPlanTree(assignment.plan_id);
  const sessionsLogged = get(
    'SELECT COUNT(*) AS n FROM workout_logs WHERE member_id = ? AND plan_id = ?',
    [req.member.id, assignment.plan_id],
  ).n;

  // The day after whichever one they last actually did, which also handles a
  // member who trained out of order (picked Legs on a Pull day): the next
  // session follows on from what happened rather than from a count. A
  // freestyle session, logged with no day_id, leaves the rotation where it was.
  const lastDay = get(
    `SELECT day_id FROM workout_logs
     WHERE member_id = ? AND plan_id = ? AND day_id IS NOT NULL
     ORDER BY log_date DESC, id DESC LIMIT 1`,
    [req.member.id, assignment.plan_id],
  );
  // -1 covers both a fresh plan and a day_id whose row is gone (the trainer
  // rebuilt the routine), and either way lands on day one.
  const lastIndex = lastDay ? plan.days.findIndex((d) => d.id === lastDay.day_id) : -1;
  const todayDay = plan.days.length ? plan.days[(lastIndex + 1) % plan.days.length] : null;

  // Pre-fill the "Previous" column for today's exercises in one query, so the
  // logger opens with every row already showing what there is to beat.
  const names = todayDay ? todayDay.exercises.map((e) => e.exercise_name) : [];

  return res.json({
    assignment,
    plan,
    today_day: todayDay,
    previous: previousSetsFor(req.member.id, names),
    sessions_logged: sessionsLogged,
    last_workout: get(
      'SELECT * FROM workout_logs WHERE member_id = ? ORDER BY log_date DESC, id DESC LIMIT 1',
      [req.member.id],
    ) ?? null,
  });
});

/**
 * Saves a finished session.
 *
 * The active workout lives in the browser until the member taps Finish — a
 * running set table is a scratchpad, and round-tripping every checkbox to the
 * server would put a spinner between the member and their next set. The cost is
 * that a closed tab loses the session, which is why the client also keeps it in
 * localStorage.
 *
 * Totals and PRs are recomputed here from the sets rather than trusted from the
 * client: the volume on a PR wall has to be arithmetic on stored rows, not
 * whatever a request said it was.
 */
portalRoutes.post('/workouts/logs', requireMemberAuth, requireModule('fitness'), requireFitnessAccess, (req, res) => {
  const body = parse(req.body, {
    workout_name: { type: 'string', required: true, min: 1, max: 120 },
    plan_id: { type: 'int', min: 1 },
    day_id: { type: 'int', min: 1 },
    duration_seconds: { type: 'int', min: 0, max: 86400, default: 0 },
    notes: { type: 'string', max: 1000 },
  });

  const rawSets = Array.isArray(req.body?.sets) ? req.body.sets : [];
  if (!rawSets.length) throw badRequest('Log at least one set before finishing', { sets: 'is required' });
  if (rawSets.length > 200) throw badRequest('That is more sets than one session can hold', { sets: 'at most 200' });

  const errors = {};
  const sets = rawSets.map((set, index) => {
    const exerciseName = String(set?.exercise_name ?? '').trim();
    if (!exerciseName) errors[`sets.${index}.exercise_name`] = 'is required';

    const setType = String(set?.set_type ?? 'normal');
    if (!SET_TYPES.includes(setType)) errors[`sets.${index}.set_type`] = `must be one of: ${SET_TYPES.join(', ')}`;

    const muscleGroup = String(set?.muscle_group ?? 'full_body');
    if (!MUSCLE_GROUPS.includes(muscleGroup)) errors[`sets.${index}.muscle_group`] = 'is not a muscle group';

    const weight = Number(set?.weight_kg ?? 0);
    if (!Number.isFinite(weight) || weight < 0 || weight > 1000) {
      errors[`sets.${index}.weight_kg`] = 'must be a weight in kg from 0 to 1000';
    }

    const reps = Number(set?.reps ?? 0);
    if (!Number.isInteger(reps) || reps < 0 || reps > 1000) {
      errors[`sets.${index}.reps`] = 'must be a whole number of reps';
    }

    const rpe = set?.rpe === undefined || set?.rpe === null || set?.rpe === '' ? null : Number(set.rpe);
    if (rpe !== null && (!Number.isFinite(rpe) || rpe < 1 || rpe > 10)) {
      errors[`sets.${index}.rpe`] = 'must be between 1 and 10';
    }

    return {
      exercise_name: exerciseName.slice(0, 120),
      muscle_group: muscleGroup,
      set_number: Number.isInteger(set?.set_number) && set.set_number > 0 ? set.set_number : index + 1,
      set_type: setType,
      weight_kg: Math.round(weight * 100) / 100,
      reps,
      rpe,
      completed: set?.completed === false || set?.completed === 0 ? 0 : 1,
      notes: set?.notes ? String(set.notes).trim().slice(0, 300) : null,
    };
  });
  if (Object.keys(errors).length) throw badRequest('Some sets need attention', errors);

  const totals = summariseSets(sets);
  // The gym's own calendar date, not UTC: a 5am session at an IST gym belongs
  // to that morning, not to the day before (see the header of src/db.js).
  const logDate = today();

  const result = tx(() => {
    const logId = run(
      `INSERT INTO workout_logs
         (member_id, plan_id, day_id, workout_name, log_date, started_at, ended_at,
          duration_seconds, total_volume_kg, total_sets, total_reps, notes)
       VALUES (?, ?, ?, ?, ?, datetime('now', '-' || ? || ' seconds'), datetime('now'), ?, ?, ?, ?, ?)`,
      [
        req.member.id,
        body.plan_id ?? null,
        body.day_id ?? null,
        body.workout_name,
        logDate,
        body.duration_seconds,
        body.duration_seconds,
        totals.total_volume_kg,
        totals.total_sets,
        totals.total_reps,
        body.notes ?? null,
      ],
    ).lastInsertRowid;

    const stored = sets.map((set, index) => {
      const est1rm = estimate1rm(set.weight_kg, set.reps);
      const id = run(
        `INSERT INTO workout_log_sets
           (log_id, exercise_name, muscle_group, set_number, set_type, weight_kg, reps, rpe, est_1rm_kg, completed, notes, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          logId,
          set.exercise_name,
          set.muscle_group,
          set.set_number,
          set.set_type,
          set.weight_kg,
          set.reps,
          set.rpe,
          est1rm,
          set.completed,
          set.notes,
          index,
        ],
      ).lastInsertRowid;
      return { ...set, id, est_1rm_kg: est1rm };
    });

    // Inside the transaction: a session that rolls back must not leave a PR
    // pointing at a set that no longer exists.
    return { logId, prs: recordPersonalRecords(req.member.id, stored) };
  });

  res.status(201).json({
    log: get('SELECT * FROM workout_logs WHERE id = ?', [result.logId]),
    sets: all('SELECT * FROM workout_log_sets WHERE log_id = ? ORDER BY sort_order, id', [result.logId]),
    prs: result.prs,
    summary: totals,
  });
});

portalRoutes.get('/workouts/logs', requireMemberAuth, requireModule('fitness'), requireFitnessAccess, (req, res) => {
  const limit = Math.min(toInt(req.query.limit, 30), 200);
  res.json({
    items: all(
      `SELECT l.*, (SELECT COUNT(*) FROM workout_log_sets s WHERE s.log_id = l.id AND s.is_pr = 1) AS pr_count
       FROM workout_logs l WHERE l.member_id = ?
       ORDER BY l.log_date DESC, l.id DESC LIMIT ?`,
      [req.member.id, limit],
    ),
    stats: get(
      `SELECT COUNT(*) AS total_workouts,
              COALESCE(SUM(total_volume_kg), 0) AS lifetime_volume_kg,
              COALESCE(SUM(duration_seconds), 0) AS lifetime_seconds
       FROM workout_logs WHERE member_id = ?`,
      [req.member.id],
    ),
  });
});

portalRoutes.get('/workouts/logs/:id', requireMemberAuth, requireModule('fitness'), requireFitnessAccess, (req, res) => {
  const log = get('SELECT * FROM workout_logs WHERE id = ?', [Number(req.params.id)]);
  // notFound, not forbidden, for someone else's log: whether a given id exists
  // in this gym is not something a member gets to probe.
  if (!log || log.member_id !== req.member.id) throw notFound('Workout not found');
  res.json({
    ...log,
    sets: all('SELECT * FROM workout_log_sets WHERE log_id = ? ORDER BY sort_order, id', [log.id]),
  });
});

portalRoutes.delete('/workouts/logs/:id', requireMemberAuth, requireModule('fitness'), requireFitnessAccess, (req, res) => {
  const log = get('SELECT * FROM workout_logs WHERE id = ?', [Number(req.params.id)]);
  if (!log || log.member_id !== req.member.id) throw notFound('Workout not found');
  // The PR row survives on purpose: it records that the member once lifted it,
  // and deleting a mis-tapped session should not erase their best-ever bench.
  run('DELETE FROM workout_logs WHERE id = ?', [log.id]);
  res.json({ ok: true });
});

portalRoutes.get('/workouts/prs', requireMemberAuth, requireModule('fitness'), requireFitnessAccess, (req, res) => {
  res.json({
    items: all(
      `SELECT p.*, e.muscle_group
       FROM exercise_prs p
       LEFT JOIN exercise_library e ON e.name = p.exercise_name COLLATE NOCASE
       WHERE p.member_id = ? ORDER BY p.est_1rm_kg DESC`,
      [req.member.id],
    ),
  });
});

/**
 * The exercise picker, with each exercise's own last set attached.
 *
 * The history is what makes the picker useful rather than a list of names: a
 * member adding "Lat Pulldown" mid-session wants to see 60 kg × 10 from last
 * week next to it, and pre-filling from it is one tap instead of remembering.
 */
portalRoutes.get('/workouts/exercises', requireMemberAuth, requireModule('fitness'), requireFitnessAccess, (req, res) => {
  const where = [];
  const params = [];
  if (req.query.muscle_group) {
    where.push('muscle_group = ?');
    params.push(String(req.query.muscle_group));
  }
  if (req.query.q) {
    where.push('name LIKE ?');
    params.push(`%${String(req.query.q)}%`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const items = all(`SELECT * FROM exercise_library ${clause} ORDER BY muscle_group, name LIMIT 300`, params);
  const previous = previousSetsFor(req.member.id, items.map((e) => e.name));

  res.json({ items: items.map((item) => ({ ...item, previous: previous[item.name] ?? null })) });
});

/* ── Diet tracking ────────────────────────────────────────────────────── */

/** Today's row, created on demand — a member who has not eaten yet still needs
 * somewhere to put their first glass of water. */
function ensureDietLog(memberId, logDate) {
  const existing = get('SELECT * FROM diet_logs WHERE member_id = ? AND log_date = ?', [memberId, logDate]);
  if (existing) return existing;
  run('INSERT INTO diet_logs (member_id, log_date) VALUES (?, ?)', [memberId, logDate]);
  return get('SELECT * FROM diet_logs WHERE member_id = ? AND log_date = ?', [memberId, logDate]);
}

/** The default targets a member sees before a trainer has assigned them
 * anything: enough to make the rings mean something on day one, deliberately
 * middle-of-the-road rather than a guess dressed up as a prescription. */
const FALLBACK_DIET_TARGETS = {
  target_calories: 2000,
  target_protein_g: 120,
  target_carbs_g: 220,
  target_fats_g: 65,
  target_water_ml: 3000,
};

portalRoutes.get('/diets/current', requireMemberAuth, requireModule('fitness'), requireFitnessAccess, (req, res) => {
  const assignment = get(
    `SELECT a.*, u.name AS assigned_by_name
     FROM member_diet_assignments a
     LEFT JOIN users u ON u.id = a.assigned_by
     WHERE a.member_id = ? AND a.status = 'active'`,
    [req.member.id],
  );
  const plan = assignment ? dietPlanTree(assignment.plan_id) : null;

  res.json({
    assignment: assignment ?? null,
    plan,
    targets: plan
      ? {
          target_calories: plan.target_calories,
          target_protein_g: plan.target_protein_g,
          target_carbs_g: plan.target_carbs_g,
          target_fats_g: plan.target_fats_g,
          target_water_ml: plan.target_water_ml,
        }
      : FALLBACK_DIET_TARGETS,
    using_default_targets: !plan,
  });
});

/**
 * One day's food and water, totalled and split by meal.
 *
 * Totals are summed here rather than in the client because the same numbers
 * feed the trainer's adherence view (diets.js), and two places computing
 * "calories today" is one place too many.
 */
portalRoutes.get('/diets/daily', requireMemberAuth, requireModule('fitness'), requireFitnessAccess, (req, res) => {
  const logDate = req.query.date ? String(req.query.date) : today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(logDate)) {
    throw badRequest('Pick a date formatted YYYY-MM-DD', { date: 'is not a date' });
  }

  const log = get('SELECT * FROM diet_logs WHERE member_id = ? AND log_date = ?', [req.member.id, logDate]);
  const entries = log
    ? all('SELECT * FROM diet_log_entries WHERE diet_log_id = ? ORDER BY logged_at, id', [log.id])
    : [];

  const totals = entries.reduce(
    (acc, entry) => ({
      calories: acc.calories + entry.calories,
      protein_g: Math.round((acc.protein_g + entry.protein_g) * 10) / 10,
      carbs_g: Math.round((acc.carbs_g + entry.carbs_g) * 10) / 10,
      fats_g: Math.round((acc.fats_g + entry.fats_g) * 10) / 10,
    }),
    { calories: 0, protein_g: 0, carbs_g: 0, fats_g: 0 },
  );

  const meals = {};
  for (const type of MEAL_TYPES) meals[type] = [];
  for (const entry of entries) meals[entry.meal_type]?.push(entry);

  res.json({ log_date: logDate, water_ml: log?.water_ml ?? 0, entries, meals, totals });
});

portalRoutes.post('/diets/entries', requireMemberAuth, requireModule('fitness'), requireFitnessAccess, (req, res) => {
  const body = parse(req.body, {
    meal_type: { type: 'enum', values: MEAL_TYPES, required: true },
    food_id: { type: 'int', min: 1 },
    food_name: { type: 'string', max: 120 },
    quantity: { type: 'number', min: 0.05, max: 100, default: 1 },
    serving_unit: { type: 'string', max: 60 },
    calories: { type: 'int', min: 0, max: 20000 },
    protein_g: { type: 'number', min: 0, max: 2000 },
    carbs_g: { type: 'number', min: 0, max: 2000 },
    fats_g: { type: 'number', min: 0, max: 2000 },
    log_date: { type: 'date', default: today() },
  });

  // Two ways in: pick from the library and let the server do the serving
  // arithmetic, or type the numbers off a packet. The library path is
  // authoritative when both arrive, so a stale client cannot log 10 kcal of
  // chicken by sending its own figures alongside a food_id.
  let macros;
  let name;
  let unit;
  if (body.food_id) {
    const food = get('SELECT * FROM food_library WHERE id = ?', [body.food_id]);
    if (!food) throw notFound('That food is not in the library');
    name = food.name;
    unit = food.serving_unit;
    macros = {
      calories: Math.round(food.calories * body.quantity),
      protein_g: Math.round(food.protein_g * body.quantity * 10) / 10,
      carbs_g: Math.round(food.carbs_g * body.quantity * 10) / 10,
      fats_g: Math.round(food.fats_g * body.quantity * 10) / 10,
    };
  } else {
    if (!body.food_name) throw badRequest('Name the food or pick one from the library', { food_name: 'is required' });
    name = body.food_name;
    unit = body.serving_unit || 'serving';
    // Hand-entered figures are the total for what was eaten, not a per-serving
    // rate — the member typed what is on the packet in front of them.
    macros = {
      calories: body.calories ?? 0,
      protein_g: body.protein_g ?? 0,
      carbs_g: body.carbs_g ?? 0,
      fats_g: body.fats_g ?? 0,
    };
  }

  const log = ensureDietLog(req.member.id, body.log_date);
  const info = run(
    `INSERT INTO diet_log_entries
       (diet_log_id, meal_type, food_name, quantity, serving_unit, calories, protein_g, carbs_g, fats_g)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [log.id, body.meal_type, name, body.quantity, unit, macros.calories, macros.protein_g, macros.carbs_g, macros.fats_g],
  );

  res.status(201).json(get('SELECT * FROM diet_log_entries WHERE id = ?', [info.lastInsertRowid]));
});

portalRoutes.delete('/diets/entries/:id', requireMemberAuth, requireModule('fitness'), requireFitnessAccess, (req, res) => {
  const entry = get(
    `SELECT e.id FROM diet_log_entries e JOIN diet_logs l ON l.id = e.diet_log_id
     WHERE e.id = ? AND l.member_id = ?`,
    [Number(req.params.id), req.member.id],
  );
  if (!entry) throw notFound('That entry is not in your food log');
  run('DELETE FROM diet_log_entries WHERE id = ?', [entry.id]);
  res.json({ ok: true });
});

/**
 * Water, either as a nudge (`add_ml`, what the +250 ml button sends) or as an
 * absolute (`water_ml`, what the "set total" field sends).
 *
 * A nudge rather than a client-computed total, because two taps in quick
 * succession from a phone on a bad connection would otherwise race and lose a
 * glass — the increment is applied by the database.
 */
portalRoutes.post('/diets/water', requireMemberAuth, requireModule('fitness'), requireFitnessAccess, (req, res) => {
  const body = parse(req.body, {
    add_ml: { type: 'int', min: -5000, max: 5000 },
    water_ml: { type: 'int', min: 0, max: 20000 },
    log_date: { type: 'date', default: today() },
  });
  if (body.add_ml === undefined && body.water_ml === undefined) {
    throw badRequest('Send how much water to add, or the new total', { add_ml: 'is required' });
  }

  const log = ensureDietLog(req.member.id, body.log_date);
  if (body.water_ml !== undefined && body.water_ml !== null) {
    run('UPDATE diet_logs SET water_ml = ? WHERE id = ?', [body.water_ml, log.id]);
  } else {
    // MAX(0, …) so tapping undo past zero cannot drive the column negative and
    // trip its CHECK constraint.
    run('UPDATE diet_logs SET water_ml = MAX(0, water_ml + ?) WHERE id = ?', [body.add_ml, log.id]);
  }

  res.json(get('SELECT log_date, water_ml FROM diet_logs WHERE id = ?', [log.id]));
});

portalRoutes.get('/diets/foods', requireMemberAuth, requireModule('fitness'), requireFitnessAccess, (req, res) => {
  const where = [];
  const params = [];
  if (req.query.category) {
    where.push('category = ?');
    params.push(String(req.query.category));
  }
  if (req.query.q) {
    where.push('name LIKE ?');
    params.push(`%${String(req.query.q)}%`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  res.json({
    items: all(`SELECT * FROM food_library ${clause} ORDER BY category, name LIMIT 300`, params),
    // What this member logs most, so the search box opens on their own food
    // rather than on whatever happens to sort first alphabetically.
    recent: all(
      `SELECT e.food_name, e.serving_unit, e.calories, e.protein_g, e.carbs_g, e.fats_g, MAX(e.logged_at) AS last_logged
       FROM diet_log_entries e JOIN diet_logs l ON l.id = e.diet_log_id
       WHERE l.member_id = ?
       GROUP BY e.food_name COLLATE NOCASE
       ORDER BY last_logged DESC LIMIT 12`,
      [req.member.id],
    ),
  });
});
