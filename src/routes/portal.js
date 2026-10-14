import { Router } from 'express';
import { issueMemberToken, requireMemberAuth } from '../auth.js';
import { config, DEFAULT_TENANT_SLUG } from '../config.js';
import { ATTENDANCE_SELECT, publicVisit } from '../checkin.js';
import { all, get, getBusinessType, run, tx } from '../db.js';
import { HttpError, badRequest, conflict, notFound, paymentRequired, tooManyRequests, unauthorized } from '../errors.js';
import {
  COACH_SCREENS,
  MAX_QUESTION_LENGTH,
  MAX_VOICE_BYTES,
  PLAN_EQUIPMENT,
  PLAN_FOCUS,
  PLAN_GOALS,
  PLAN_LEVELS,
  askCoach,
  buildCoachContext,
  cleanMealPlan,
  coachConfigured,
  contextSteps,
  generatePlan,
  libraryForPlan,
  plansToday,
  questionsToday,
  recentTurns,
  streamCoach,
  transcribeVoice,
  VOICE_MIME_TYPES,
  voiceClipsToday,
} from '../aiCoach.js';
import { attachCatalogToExercises, listMuscleGroups } from '../exerciseCatalog.js';
import {
  EQUIPMENT_TYPES,
  MEAL_TYPES,
  SET_TYPES,
  estimate1rm,
  exerciseHistory,
  fitnessAccessFor,
  fitnessSettings,
  lastSessionSetsFor,
  muscleGroupOf,
  previousSetsFor,
  reconcileEditedRecords,
  recordPersonalRecords,
  summariseSets,
} from '../fitness.js';
import { insertBarcodeFood, libraryFoodByBarcode, lookupBarcode, normaliseBarcode } from '../foodBarcode.js';
import { syncFoodCatalog } from '../foodCatalog.js';
import { externalMode, importFood, parseFoodRef, searchFoods } from '../foodSearch.js';
import { expireOverdueSubscriptions } from '../maintenance.js';
import {
  ACTIVITY_KEYS,
  ACTIVITY_LEVELS,
  ACTIVITY_TYPES,
  ADDBACK_OPTIONS,
  NUTRITION_GOALS,
  SEXES,
  TRAINING_INTENSITIES,
  activityCalories,
  ageOn,
  effectiveDietTargets,
  exerciseForDay,
  nutritionProfile,
  suggestTargets,
  weightOn,
  workoutCalories,
} from '../nutrition.js';
import { emailEnabled, sendEmail } from '../mailer.js';
import {
  assertGoodPassword,
  assertSetupCode,
  checkPassword,
  checkResetPassword,
  claimWhatsAppReset,
  generateTemporaryPassword,
  hasPassword,
  issueSetupCode,
  maskEmail,
  maskPhone,
  releaseWhatsAppReset,
  sendLoginOnWhatsApp,
  setMemberPassword,
  storeResetPassword,
  waitPhrase,
} from '../memberPasswords.js';
import { whatsappReady } from '../whatsapp.js';
import { notifyMember } from '../notifications.js';
import { setMemberPhoto } from '../photo.js';
import { MEMBER_SELECT, publicMember } from './members.js';
import { dietPlanTree } from './diets.js';
import { exercisePickerRows, parseDays, workoutPlanTree, writeDays } from './workouts.js';
import { generateReceiptPdf } from '../receiptPdf.js';
import { ensureQrToken, qrPayload, qrPngDataUrl, qrSvg } from '../qr.js';
import { createLimiter } from '../rateLimit.js';
import { addDays, parse, today, toInt } from '../validate.js';
import { moduleEnabled, requireModule } from '../verticals.js';
import { gymDateOf } from '../clock.js';
import {
  createAddonCheckout,
  createStoreCheckout,
  findAddonPayment,
  findStoreOrderByRazorpayId,
  listMemberOrders,
  portalMonetization,
  settleAddonPayment,
  settleStorePayment,
  storeOrder,
  storefront,
} from '../monetization.js';
import { portalNavBadges } from '../navBadges.js';
import { verifyPaymentSignature } from '../razorpay.js';

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

/** Asking for an email code or a WhatsApp login: per IP, so one device can't
 * walk the member list or spam inboxes. Roomy enough for a gym's shared Wi-Fi,
 * where every member behind it is one IP. */
const setupCodeLimiter = createLimiter({
  maxAttempts: 20,
  windowMs: config.loginWindowMs,
  lockoutMs: config.loginLockoutMs,
});

/** The member a sign-in or setup request names: member ID first, then phone. */
function findMemberByIdentifier(identifier) {
  return (
    get('SELECT * FROM members WHERE code = ? COLLATE NOCASE', [identifier]) ??
    get('SELECT * FROM members WHERE phone = ?', [identifier])
  );
}

function guardLimiter(limiter, key, res, message) {
  const gate = limiter.check(key);
  if (gate.locked) {
    res.set('Retry-After', String(gate.retryAfterSeconds));
    throw tooManyRequests(message);
  }
}

function signedInResponse(req, member) {
  const tenantSlug = req.tenant?.slug ?? DEFAULT_TENANT_SLUG;
  run("UPDATE members SET last_portal_login = datetime('now') WHERE id = ?", [member.id]);
  const fresh = get('SELECT portal_password_temp FROM members WHERE id = ?', [member.id]);
  return {
    token: issueMemberToken(member, tenantSlug, { userAgent: req.get('user-agent') }),
    member: publicMember(get(`${MEMBER_SELECT} WHERE m.id = ?`, [member.id])),
    must_change_password: Boolean(fresh.portal_password_temp),
  };
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

/**
 * Member ID (or phone) + password. A member with no password yet gets a 401
 * with `details.reason = 'no_password'`, so the app can offer the email code
 * or point them at the front desk instead of saying "wrong password" to
 * someone who never had one.
 */
portalRoutes.post('/login', (req, res) => {
  const tenantSlug = req.tenant?.slug ?? DEFAULT_TENANT_SLUG;
  const body = parse(req.body, {
    identifier: { type: 'string', required: true, max: 60 },
    password: { type: 'string', required: true, max: 200 },
  });

  const limiterKey = `${tenantSlug}:${req.ip}:${body.identifier.toLowerCase()}`;
  guardLimiter(portalLoginLimiter, limiterKey, res, 'Too many failed attempts. Try again later.');

  const member = findMemberByIdentifier(body.identifier);
  if (!member) {
    portalLoginLimiter.recordAttempt(limiterKey);
    throw unauthorized('We could not find a member with that phone number or member ID');
  }
  const matched = checkPassword(member, body.password);
  // The password from "Get it on WhatsApp" only takes over once it's used:
  // it becomes a temporary password, which the app has them replace now.
  if (!matched && checkResetPassword(member, body.password)) {
    setMemberPassword(member.id, body.password, { temporary: true });
  } else if (!hasPassword(member)) {
    throw new HttpError(401, "You haven't set a password yet", { reason: 'no_password' });
  } else if (!matched) {
    portalLoginLimiter.recordAttempt(limiterKey);
    throw unauthorized('Incorrect password');
  }

  portalLoginLimiter.recordSuccess(limiterKey);
  res.json(signedInResponse(req, member));
});

/**
 * "Forgot password? Get it on WhatsApp": sends the member their login with a
 * temporary password from the gym's linked WhatsApp — no one at the desk has
 * to approve it. The message only ever goes to the number on the account, and
 * their current password keeps working until they sign in with the new one,
 * so a stranger pressing the button can't lock anyone out. One send per
 * member per day; a send that fails doesn't use it up.
 */
portalRoutes.post('/password/whatsapp', async (req, res) => {
  const tenantSlug = req.tenant?.slug ?? DEFAULT_TENANT_SLUG;
  const body = parse(req.body, { identifier: { type: 'string', required: true, max: 60 } });

  const limiterKey = `${tenantSlug}:${req.ip}`;
  guardLimiter(setupCodeLimiter, limiterKey, res, 'Too many requests. Try again later.');
  setupCodeLimiter.recordAttempt(limiterKey);

  const member = findMemberByIdentifier(body.identifier);
  if (!member) throw notFound('We could not find a member with that phone number or member ID');
  if (!member.phone) {
    throw badRequest('There is no phone number on your account', { reason: 'no_phone' });
  }
  if (!whatsappReady()) {
    throw badRequest("WhatsApp messages can't be sent right now", { reason: 'whatsapp_unavailable' });
  }

  const claim = claimWhatsAppReset(member.id);
  if (claim.wait) {
    res.set('Retry-After', String(claim.wait));
    throw tooManyRequests(
      `We already sent your login details on WhatsApp. You can ask again ${waitPhrase(claim.wait)}.`,
      { reason: 'cooldown', retry_after_seconds: claim.wait },
    );
  }

  const password = generateTemporaryPassword();
  try {
    await sendLoginOnWhatsApp(req, member, password, { reason: 'reset' });
  } catch {
    releaseWhatsAppReset(member.id, claim.previous);
    throw badRequest("We couldn't send it on WhatsApp right now", { reason: 'whatsapp_unavailable' });
  }
  storeResetPassword(member.id, password);
  res.json({ sent: true, phone_hint: maskPhone(member.phone) });
});

/**
 * Step one of "email me a code": sends a 6-digit code to the email on the
 * member's account. Answers with a masked address so they know where to look,
 * or a 400 whose `details.reason` says why it can't (no email on file, or no
 * mail server) — both of which the app turns into "ask the front desk".
 */
portalRoutes.post('/password/forgot', async (req, res) => {
  const tenantSlug = req.tenant?.slug ?? DEFAULT_TENANT_SLUG;
  const body = parse(req.body, { identifier: { type: 'string', required: true, max: 60 } });

  const limiterKey = `${tenantSlug}:${req.ip}`;
  guardLimiter(setupCodeLimiter, limiterKey, res, 'Too many requests. Try again later.');
  setupCodeLimiter.recordAttempt(limiterKey);

  const member = findMemberByIdentifier(body.identifier);
  if (!member) throw notFound('We could not find a member with that phone number or member ID');
  if (!member.email) {
    throw badRequest('There is no email address on your account', { reason: 'no_email' });
  }
  if (!emailEnabled()) {
    throw badRequest('Email codes are not available right now', { reason: 'email_unavailable' });
  }

  const gymName = req.tenant?.gym_name || config.gymName || 'GymBook';
  const { code, expires_in_minutes: minutes } = issueSetupCode(member.id);
  try {
    await sendEmail({
      to: member.email,
      fromName: gymName,
      subject: `${code} is your ${gymName} app code`,
      text: [
        `Hi ${member.first_name},`,
        '',
        `Your code to set your ${gymName} app password is ${code}.`,
        `It works for ${minutes} minutes. If you didn't ask for it, you can ignore this email.`,
      ].join('\n'),
      html: setupCodeEmailHtml({ name: member.first_name, gymName, code, minutes }),
    });
  } catch (err) {
    // A code nobody received must not block asking again for a minute.
    run('DELETE FROM member_password_codes WHERE member_id = ?', [member.id]);
    throw err;
  }

  res.json({ sent: true, email_hint: maskEmail(member.email), expires_in_minutes: minutes });
});

/** Step two: the emailed code plus a new password. Signs the member in. */
portalRoutes.post('/password/reset', (req, res) => {
  const body = parse(req.body, {
    identifier: { type: 'string', required: true, max: 60 },
    code: { type: 'string', required: true, max: 12 },
    new_password: { type: 'string', required: true, max: 200 },
  });
  const member = findMemberByIdentifier(body.identifier);
  if (!member) throw notFound('We could not find a member with that phone number or member ID');

  assertSetupCode(member.id, body.code);
  assertGoodPassword(body.new_password, member);
  setMemberPassword(member.id, body.new_password);
  res.json(signedInResponse(req, member));
});

/**
 * Change password from inside the app — also how a temporary password from
 * the front desk gets replaced. Other devices are signed out; this one stays.
 */
portalRoutes.post('/password', requireMemberAuth, (req, res) => {
  const body = parse(req.body, {
    current_password: { type: 'string', required: true, max: 200 },
    new_password: { type: 'string', required: true, max: 200 },
  });
  const member = req.member;
  if (!checkPassword(member, body.current_password)) {
    throw badRequest('Current password is incorrect', { current_password: 'does not match' });
  }
  if (body.new_password === body.current_password) {
    throw badRequest('Choose a different password from the current one', { new_password: 'same as current' });
  }
  assertGoodPassword(body.new_password, member);
  setMemberPassword(member.id, body.new_password, { keepSessionId: req.memberSessionId });
  res.json({ ok: true });
});

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function setupCodeEmailHtml({ name, gymName, code, minutes }) {
  return `<!doctype html><html><body style="margin:0;background:#0b0b0c;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px"><tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background:#161618;border:1px solid #c99a12;border-radius:18px;padding:32px 28px;color:#f2f2f2">
      <tr><td style="font-size:18px;font-weight:700;padding-bottom:18px">${escapeHtml(gymName)}</td></tr>
      <tr><td style="font-size:15px;line-height:1.5;color:#cfcfd3">Hi ${escapeHtml(name)}, use this code to set your app password:</td></tr>
      <tr><td align="center" style="padding:26px 0">
        <div style="display:inline-block;font-size:34px;font-weight:800;letter-spacing:10px;color:#111;background:#ffc51f;border-radius:12px;padding:14px 22px">${code}</div>
      </td></tr>
      <tr><td style="font-size:13px;line-height:1.5;color:#9a9aa0">It works for ${minutes} minutes. If you didn't ask for it, you can ignore this email — your account is unchanged.</td></tr>
    </table>
  </td></tr></table></body></html>`;
}

/* ── Home / profile ───────────────────────────────────────────────────── */

/**
 * The few contact details a member may change themselves. Name and phone stay
 * with the front desk: the phone number is what they sign in with, and the
 * name is what the gym's records and receipts carry.
 */
portalRoutes.patch('/me', requireMemberAuth, (req, res) => {
  const body = parse(req.body, {
    email: { type: 'email' },
    emergency_contact: { type: 'string', max: 80 },
    emergency_phone: { type: 'string', max: 30 },
  });
  const columns = Object.keys(body);
  if (!columns.length) throw badRequest('Nothing to update');
  run(`UPDATE members SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [
    ...columns.map((c) => body[c] || null),
    req.member.id,
  ]);
  res.json(publicMember(get(`${MEMBER_SELECT} WHERE m.id = ?`, [req.member.id])));
});

/** `photo` is the data URL public/js/photo.js produces; an empty string removes it. */
portalRoutes.put('/photo', requireMemberAuth, (req, res) => {
  if (!req.body || typeof req.body !== 'object' || !('photo' in req.body)) {
    throw badRequest('A photo is required', { photo: 'is required' });
  }
  setMemberPhoto(req.member.id, req.body.photo);
  res.json(publicMember(get(`${MEMBER_SELECT} WHERE m.id = ?`, [req.member.id])));
});

/**
 * The app's device-side state, mirrored to the member's account so it follows
 * them to another phone (see public/js/memberSync.js). The server stores the
 * JSON as-is: the app already validates what it reads back, and none of it is
 * trusted for anything that costs money — checkout re-prices the cart, and a
 * workout is only checked when it is finished and posted to /workouts/logs.
 */
const APP_STATE_KEYS = new Set(['cart', 'wishlist', 'active_workout', 'custom_exercises', 'recent_exercises']);
const MAX_APP_STATE_BYTES = 256 * 1024;

const appStateKey = (key) => {
  if (!APP_STATE_KEYS.has(key)) throw notFound('Unknown app state');
  return key;
};

/** `updated_at` is null when this key was never synced — the app's cue to
 * upload what it already has on the device rather than drop it. */
portalRoutes.get('/state/:key', requireMemberAuth, (req, res) => {
  const row = get('SELECT value, updated_at FROM member_app_state WHERE member_id = ? AND key = ?', [
    req.member.id,
    appStateKey(req.params.key),
  ]);
  res.json({ value: row ? JSON.parse(row.value) : null, updated_at: row?.updated_at ?? null });
});

portalRoutes.put('/state/:key', requireMemberAuth, (req, res) => {
  const key = appStateKey(req.params.key);
  if (!req.body || typeof req.body !== 'object' || !('value' in req.body)) {
    throw badRequest('A value is required', { value: 'is required' });
  }
  const value = JSON.stringify(req.body.value ?? null);
  if (Buffer.byteLength(value) > MAX_APP_STATE_BYTES) throw badRequest('That is too much to save', { value: 'is too large' });
  run(
    `INSERT INTO member_app_state (member_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT (member_id, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    [req.member.id, key, value],
  );
  res.json({ ok: true });
});

/* ── Signed-in devices ─────────────────────────────────────────────────── */

/** "Chrome on Android" from a user-agent string — enough for a member to
 * recognise their own phone, which is all the Devices screen needs. Order
 * matters: Edge and Samsung Internet also say "Chrome", and Chrome "Safari". */
function describeDevice(ua = '') {
  const browser =
    [
      [/EdgA?\/|Edg\//, 'Edge'],
      [/OPR\/|Opera/, 'Opera'],
      [/SamsungBrowser/, 'Samsung Internet'],
      [/FxiOS|Firefox/, 'Firefox'],
      [/CriOS|Chrome/, 'Chrome'],
      [/Safari/, 'Safari'],
    ].find(([re]) => re.test(ua))?.[1] ?? 'Browser';
  const [os, mobile] =
    [
      [/iPhone/, 'iPhone', true],
      [/iPad/, 'iPad', true],
      [/Android/, 'Android', true],
      [/Windows/, 'Windows', false],
      [/Mac OS X|Macintosh/, 'Mac', false],
      [/CrOS/, 'Chromebook', false],
      [/Linux/, 'Linux', false],
    ]
      .find(([re]) => re.test(ua))
      ?.slice(1) ?? ['unknown device', false];
  return { device: `${browser} on ${os}`, mobile };
}

portalRoutes.get('/sessions', requireMemberAuth, (req, res) => {
  const rows = all(
    `SELECT id, user_agent, created_at, last_seen_at FROM member_sessions
     WHERE member_id = ? AND expires_at > datetime('now') ORDER BY last_seen_at DESC`,
    [req.member.id],
  );
  const sessions = rows.map((row) => ({
    id: row.id,
    ...describeDevice(row.user_agent ?? ''),
    signed_in_at: row.created_at,
    last_seen_at: row.last_seen_at,
    current: row.id === req.memberSessionId,
  }));
  // This device first, then most recently used.
  sessions.sort((a, b) => Number(b.current) - Number(a.current));
  res.json({ sessions });
});

/** Signs out every device but the one asking — and stops their reminders,
 * including phones registered for push before sign-ins were recorded. */
portalRoutes.post('/sessions/sign-out-others', requireMemberAuth, (req, res) => {
  const signedOut = tx(() => {
    run('DELETE FROM push_subscriptions WHERE member_id = ? AND session_id IS NOT ?', [req.member.id, req.memberSessionId]);
    return run('DELETE FROM member_sessions WHERE member_id = ? AND id != ?', [req.member.id, req.memberSessionId]).changes;
  });
  res.json({ signed_out: signedOut });
});

/** `current` is this device — the app's own Sign out. A lost phone signed
 * out from another one stops getting this member's reminders too. */
portalRoutes.delete('/sessions/:id', requireMemberAuth, (req, res) => {
  const id = req.params.id === 'current' ? req.memberSessionId : req.params.id;
  const changes = tx(() => {
    run('DELETE FROM push_subscriptions WHERE member_id = ? AND session_id = ?', [req.member.id, id]);
    return run('DELETE FROM member_sessions WHERE id = ? AND member_id = ?', [id, req.member.id]).changes;
  });
  if (!changes) throw notFound('That device is already signed out');
  res.json({ ok: true, current: id === req.memberSessionId });
});

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
    // Which Store screen and which add-on paywall to draw — the operator's
    // switches, already downgraded where online payments are not set up.
    monetization: portalMonetization(),
    // The operator's badges on the bottom tabs ("Offer" on Store, "New" on Diet).
    nav_badges: portalNavBadges(),
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
  res.json({ ...fitnessAccessFor(req.member.id), monetization: portalMonetization() });
});

/* ── In-app payments: the add-on and the store ─────────────────────────── */

/** What Checkout needs to prefill, read fresh rather than from the token. */
function checkoutMember(memberId) {
  return get('SELECT id, first_name, last_name, email, phone FROM members WHERE id = ?', [memberId]);
}

/**
 * Checkout's success callback, checked. The signature proves Razorpay saw the
 * payment; the ownership check stops one member settling (and so seeing)
 * another member's order by replaying its ids.
 */
function verifiedPayment(req) {
  const body = parse(req.body, {
    razorpay_order_id: { type: 'string', required: true, max: 64 },
    razorpay_payment_id: { type: 'string', required: true, max: 64 },
    razorpay_signature: { type: 'string', required: true, max: 256 },
  });
  const ok = verifyPaymentSignature({
    orderId: body.razorpay_order_id,
    paymentId: body.razorpay_payment_id,
    signature: body.razorpay_signature,
  });
  if (!ok) throw badRequest('We could not verify that payment. If money left your account, contact the gym.');
  return { razorpayOrderId: body.razorpay_order_id, paymentId: body.razorpay_payment_id };
}

const ownsPurchase = (row, req) => row && row.tenant_slug === req.tenant.slug && row.member_id === req.member.id;

portalRoutes.post('/fitness/checkout', requireMemberAuth, requireModule('fitness'), async (req, res) => {
  const body = parse(req.body, { tier: { type: 'enum', values: ['1m', '3m', '6m'], required: true } });
  res.status(201).json(
    await createAddonCheckout({ tenantSlug: req.tenant.slug, member: checkoutMember(req.member.id), tier: body.tier }),
  );
});

portalRoutes.post('/fitness/verify', requireMemberAuth, requireModule('fitness'), (req, res) => {
  const payment = verifiedPayment(req);
  if (!ownsPurchase(findAddonPayment(payment.razorpayOrderId), req)) throw notFound('No add-on purchase matches that payment');
  settleAddonPayment(payment);
  res.json(fitnessAccessFor(req.member.id));
});

/** The storefront — catalogue, banners, delivery promise — empty unless the
 * operator has opened the store. */
portalRoutes.get('/store', requireMemberAuth, (req, res) => {
  const front = storefront(req.tenant.slug);
  res.json({
    ...front,
    // The delivery form starts from what the gym already has on file.
    shipping:
      front.status === 'live'
        ? get("SELECT first_name || COALESCE(' ' || last_name, '') AS name, phone, address FROM members WHERE id = ?", [req.member.id])
        : null,
  });
});

portalRoutes.post('/store/checkout', requireMemberAuth, async (req, res) => {
  res.status(201).json(
    await createStoreCheckout({
      tenantSlug: req.tenant.slug,
      member: checkoutMember(req.member.id),
      items: req.body?.items,
      shipping: req.body?.shipping,
      method: req.body?.method ?? 'delivery',
    }),
  );
});

portalRoutes.post('/store/verify', requireMemberAuth, (req, res) => {
  const payment = verifiedPayment(req);
  const order = findStoreOrderByRazorpayId(payment.razorpayOrderId);
  if (!ownsPurchase(order, req)) throw notFound('No store order matches that payment');
  settleStorePayment(payment);
  res.json({ order: storeOrder(order.id) });
});

portalRoutes.get('/store/orders', requireMemberAuth, (req, res) => {
  res.json({ items: listMemberOrders(req.tenant.slug, req.member.id) });
});

/**
 * Today's session, plus the whole routine so the member can train out of order.
 *
 * Which day is "today" follows the routine's own rotation, not the calendar:
 * someone on Push/Pull/Legs who misses Monday wants Push on Tuesday, not to
 * have skipped it. A calendar-locked rotation would quietly delete a workout
 * from their week every time life got in the way.
 */
/**
 * Which plan drives the member's Workout tab: one of their own if they have
 * switched to it, otherwise the trainer's assignment. `assignment` is returned
 * either way, so the portal can offer the way back to the trainer's plan.
 *
 * The own-plan pointer is re-checked against ownership rather than trusted: a
 * stale pointer (a plan since deleted, or never theirs) falls back to the
 * trainer instead of serving someone else's routine.
 */
function liveWorkoutFor(memberId) {
  const assignment = get(
    `SELECT a.*, u.name AS assigned_by_name, wp.name AS plan_name
     FROM member_workout_assignments a
     JOIN workout_plans wp ON wp.id = a.plan_id
     LEFT JOIN users u ON u.id = a.assigned_by
     WHERE a.member_id = ? AND a.status = 'active'`,
    [memberId],
  );
  const own = get(
    `SELECT wp.id FROM members m JOIN workout_plans wp ON wp.id = m.own_workout_plan_id
     WHERE m.id = ? AND wp.member_id = m.id AND wp.member_created = 1`,
    [memberId],
  );
  if (own) return { assignment: assignment ?? null, source: 'own', plan_id: own.id };
  if (assignment) return { assignment, source: 'trainer', plan_id: assignment.plan_id };
  return { assignment: null, source: null, plan_id: null };
}

portalRoutes.get('/workouts/current', requireMemberAuth, requireModule('fitness'), requireFitnessAccess, (req, res) => {
  const { assignment, source, plan_id: planId } = liveWorkoutFor(req.member.id);

  if (!planId) {
    return res.json({ assignment: null, source: null, plan: null, today_day: null, previous: {}, last_session: {}, streak_days: 0 });
  }

  const plan = workoutPlanTree(planId, { withMedia: true });
  const sessionsLogged = get(
    'SELECT COUNT(*) AS n FROM workout_logs WHERE member_id = ? AND plan_id = ?',
    [req.member.id, planId],
  ).n;

  // The day after whichever one they last actually did, which also handles a
  // member who trained out of order (picked Legs on a Pull day): the next
  // session follows on from what happened rather than from a count. A
  // freestyle session, logged with no day_id, leaves the rotation where it was.
  const lastDay = get(
    `SELECT day_id FROM workout_logs
     WHERE member_id = ? AND plan_id = ? AND day_id IS NOT NULL
     ORDER BY log_date DESC, id DESC LIMIT 1`,
    [req.member.id, planId],
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
    source,
    plan,
    today_day: todayDay,
    previous: previousSetsFor(req.member.id, names),
    // The whole of last session per exercise, for the next-set suggestion.
    last_session: lastSessionSetsFor(req.member.id, names),
    sessions_logged: sessionsLogged,
    last_workout: get(
      'SELECT * FROM workout_logs WHERE member_id = ? ORDER BY log_date DESC, id DESC LIMIT 1',
      [req.member.id],
    ) ?? null,
  });
});

/* ── Member-built plans ───────────────────────────────────────────────── */

/**
 * Plans a member writes for themselves, Hevy-style: named days, each a list of
 * exercises with target sets, reps and rest. Stored as ordinary workout_plans
 * rows (member_created = 1) so the logger, the rotation and the trainer's
 * read-only view all work on them unchanged.
 */
const MAX_OWN_PLANS = 20;
const MAX_EXERCISES_PER_DAY = 30;

const OWN_PLAN_FIELDS = {
  name: { type: 'string', required: true, min: 2, max: 100 },
  description: { type: 'string', max: 1000 },
};

/** The member's own plan, or 404 — for a trainer's plan as much as for another
 * member's: neither is the member's to edit. */
function ownPlanOr404(memberId, planId) {
  const plan = get('SELECT * FROM workout_plans WHERE id = ? AND member_id = ? AND member_created = 1', [planId, memberId]);
  if (!plan) throw notFound('Plan not found');
  return plan;
}

/** parseDays, plus what a finished plan needs that a trainer's half-built
 * template does not: at least one day, and something to do on each. */
function parseOwnPlanDays(raw) {
  const days = parseDays(raw ?? []);
  if (!days.length) throw badRequest('Add at least one day to your plan', { days: 'is required' });
  const errors = {};
  days.forEach((day, index) => {
    if (!day.exercises.length) errors[`days.${index}.exercises`] = 'add at least one exercise';
    if (day.exercises.length > MAX_EXERCISES_PER_DAY) {
      errors[`days.${index}.exercises`] = `at most ${MAX_EXERCISES_PER_DAY} exercises a day`;
    }
  });
  if (Object.keys(errors).length) throw badRequest('Every day needs at least one exercise', errors);
  return days;
}

function assertRoomForAnotherPlan(memberId) {
  const count = get('SELECT COUNT(*) AS n FROM workout_plans WHERE member_id = ? AND member_created = 1', [memberId]).n;
  if (count >= MAX_OWN_PLANS) throw badRequest(`You can keep up to ${MAX_OWN_PLANS} plans — delete one you no longer use first`);
}

function insertOwnPlan(memberId, { name, description }, days) {
  const planId = run(
    `INSERT INTO workout_plans (name, description, days_per_week, is_template, member_id, member_created)
     VALUES (?, ?, ?, 0, ?, 1)`,
    [name, description ?? null, days.length, memberId],
  ).lastInsertRowid;
  writeDays(planId, days);
  return planId;
}

/** Switches to a plan when asked, or when nothing else would be live — a
 * member's first plan with no trainer behind it should not sit unused while the
 * Workout tab says "no routine". */
function maybeActivate(memberId, planId, activate) {
  if (activate || !liveWorkoutFor(memberId).plan_id) {
    run('UPDATE members SET own_workout_plan_id = ? WHERE id = ?', [planId, memberId]);
  }
}

portalRoutes.get('/workouts/routines', requireMemberAuth, requireModule('fitness'), requireFitnessAccess, (req, res) => {
  const live = liveWorkoutFor(req.member.id);
  const { assignment } = live;
  res.json({
    items: all(
      `SELECT wp.id, wp.name, wp.description, wp.days_per_week, wp.created_at, wp.updated_at,
              (SELECT COUNT(*) FROM workout_plan_days d WHERE d.plan_id = wp.id) AS day_count,
              (SELECT COUNT(*) FROM workout_plan_exercises e
                 JOIN workout_plan_days d ON d.id = e.day_id WHERE d.plan_id = wp.id) AS exercise_count
       FROM workout_plans wp
       WHERE wp.member_id = ? AND wp.member_created = 1
       ORDER BY wp.updated_at DESC, wp.id DESC`,
      [req.member.id],
    ),
    shared: incomingShares(req.member.id),
    active: { source: live.source, plan_id: live.plan_id },
    trainer: assignment
      ? {
          plan_id: assignment.plan_id,
          plan_name: assignment.plan_name,
          assigned_by_name: assignment.assigned_by_name,
          start_date: assignment.start_date,
          day_count: get('SELECT COUNT(*) AS n FROM workout_plan_days WHERE plan_id = ?', [assignment.plan_id]).n,
        }
      : null,
  });
});

portalRoutes.get('/workouts/routines/:id', requireMemberAuth, requireModule('fitness'), requireFitnessAccess, (req, res) => {
  const plan = ownPlanOr404(req.member.id, Number(req.params.id));
  res.json(workoutPlanTree(plan.id, { withMedia: true }));
});

portalRoutes.post('/workouts/routines', requireMemberAuth, requireModule('fitness'), requireFitnessAccess, (req, res) => {
  const body = parse(req.body, { ...OWN_PLAN_FIELDS, activate: { type: 'boolean', default: 0 } });
  const days = parseOwnPlanDays(req.body?.days);
  assertRoomForAnotherPlan(req.member.id);

  const planId = tx(() => {
    const id = insertOwnPlan(req.member.id, body, days);
    maybeActivate(req.member.id, id, body.activate);
    return id;
  });
  res.status(201).json({ ...workoutPlanTree(planId), active: liveWorkoutFor(req.member.id).plan_id === planId });
});

/**
 * Copies the trainer's plan (or one of the member's own) into a new plan the
 * member can edit — the way to tweak a trainer's routine without touching the
 * trainer's copy, which may be a template the whole gym trains off.
 */
portalRoutes.post('/workouts/routines/copy', requireMemberAuth, requireModule('fitness'), requireFitnessAccess, (req, res) => {
  const body = parse(req.body, {
    plan_id: { type: 'int', required: true, min: 1 },
    name: { type: 'string', min: 2, max: 100 },
  });
  const { assignment } = liveWorkoutFor(req.member.id);
  const isTrainerPlan = assignment?.plan_id === body.plan_id;
  if (!isTrainerPlan) ownPlanOr404(req.member.id, body.plan_id);
  assertRoomForAnotherPlan(req.member.id);

  const source = workoutPlanTree(body.plan_id);
  if (!source.days.length) throw badRequest('That plan has no days to copy yet');
  const name = body.name || `${source.name.slice(0, 92)} (copy)`;
  const planId = tx(() => insertOwnPlan(req.member.id, { name, description: source.description }, source.days));
  res.status(201).json(workoutPlanTree(planId, { withMedia: true }));
});

portalRoutes.put('/workouts/routines/:id', requireMemberAuth, requireModule('fitness'), requireFitnessAccess, (req, res) => {
  const plan = ownPlanOr404(req.member.id, Number(req.params.id));
  const body = parse(req.body, OWN_PLAN_FIELDS);
  const days = parseOwnPlanDays(req.body?.days);

  tx(() => {
    run(
      `UPDATE workout_plans SET name = ?, description = ?, days_per_week = ?, updated_at = datetime('now') WHERE id = ?`,
      [body.name, body.description ?? null, days.length, plan.id],
    );
    writeDays(plan.id, days);
  });
  res.json(workoutPlanTree(plan.id, { withMedia: true }));
});

portalRoutes.delete('/workouts/routines/:id', requireMemberAuth, requireModule('fitness'), requireFitnessAccess, (req, res) => {
  const plan = ownPlanOr404(req.member.id, Number(req.params.id));
  // Sessions logged against it survive (workout_logs.plan_id is SET NULL), and
  // so does the member: with the pointer cleared they fall back to the trainer.
  tx(() => {
    run('UPDATE members SET own_workout_plan_id = NULL WHERE id = ? AND own_workout_plan_id = ?', [req.member.id, plan.id]);
    run('DELETE FROM workout_plans WHERE id = ?', [plan.id]);
  });
  res.json({ ok: true });
});

/**
 * Switches the plan the Workout tab follows: `plan_id` is one of the member's
 * own, and null (or absent) goes back to the trainer's assignment.
 */
portalRoutes.put('/workouts/active', requireMemberAuth, requireModule('fitness'), requireFitnessAccess, (req, res) => {
  const body = parse(req.body, { plan_id: { type: 'int', min: 1 } });
  const planId = body.plan_id ? ownPlanOr404(req.member.id, body.plan_id).id : null;
  run('UPDATE members SET own_workout_plan_id = ? WHERE id = ?', [planId, req.member.id]);
  const live = liveWorkoutFor(req.member.id);
  res.json({ source: live.source, plan_id: live.plan_id });
});

/* ── Sharing plans between members ────────────────────────────────────── */

/**
 * A member sends one of their own plans to a gym-mate, who finds it under
 * "Shared with you" and can save a copy. The recipient is named by phone
 * number or member ID — what a friend can actually tell you — rather than
 * picked from a list, so the portal never becomes a directory of everyone
 * who trains here.
 */
const MAX_SHARES_PER_DAY = 20;

/** "Rahul V." — enough for a gym-mate to recognise, without a full name. */
const shortName = (m) => [m.first_name, m.last_name ? `${m.last_name[0].toUpperCase()}.` : ''].filter(Boolean).join(' ');

/** Phone with the punctuation people type stripped, compared on its last ten
 * digits so "+91 98765 00011" finds a member saved as "9876500011". */
const PHONE_DIGITS_SQL = "REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone, ' ', ''), '-', ''), '+', ''), '(', ''), ')', '')";

function findShareRecipient(identifier) {
  const byCode = get('SELECT id, first_name, last_name FROM members WHERE code = ? COLLATE NOCASE', [identifier]);
  if (byCode) return byCode;

  const digits = identifier.replace(/\D/g, '');
  if (digits.length < 7) return null;
  const matches = all(
    `SELECT id, first_name, last_name FROM members
     WHERE phone IS NOT NULL AND substr(${PHONE_DIGITS_SQL}, -10) = ? LIMIT 2`,
    [digits.slice(-10)],
  );
  // Families often share one number; guessing which of them was meant would
  // send someone's plan to the wrong person.
  if (matches.length > 1) throw conflict('More than one member uses that phone number — ask for their member ID instead');
  return matches[0] ?? null;
}

function pendingShareOr404(memberId, shareId) {
  const share = get("SELECT * FROM workout_plan_shares WHERE id = ? AND recipient_id = ? AND status = 'pending'", [shareId, memberId]);
  if (!share) throw notFound('That shared plan is no longer available');
  return share;
}

/** Plans waiting for this member's answer, newest first. */
function incomingShares(memberId) {
  return all(
    `SELECT s.id, s.created_at, wp.name AS plan_name, wp.description,
            (SELECT COUNT(*) FROM workout_plan_days d WHERE d.plan_id = wp.id) AS day_count,
            (SELECT COUNT(*) FROM workout_plan_exercises e
               JOIN workout_plan_days d ON d.id = e.day_id WHERE d.plan_id = wp.id) AS exercise_count,
            m.first_name, m.last_name
     FROM workout_plan_shares s
     JOIN workout_plans wp ON wp.id = s.plan_id
     JOIN members m ON m.id = s.sender_id
     WHERE s.recipient_id = ? AND s.status = 'pending'
     ORDER BY s.created_at DESC, s.id DESC`,
    [memberId],
  ).map(({ first_name, last_name, ...share }) => ({ ...share, sender_name: shortName({ first_name, last_name }) }));
}

portalRoutes.post('/workouts/routines/:id/share', requireMemberAuth, requireModule('fitness'), requireFitnessAccess, (req, res) => {
  const plan = ownPlanOr404(req.member.id, Number(req.params.id));
  const body = parse(req.body, { recipient: { type: 'string', required: true, min: 3, max: 60 } });

  const recipient = findShareRecipient(body.recipient.trim());
  if (!recipient) throw notFound('No member at this gym has that phone number or member ID');
  if (recipient.id === req.member.id) throw badRequest("That's you — share it with someone else");

  const existing = get(
    "SELECT id FROM workout_plan_shares WHERE plan_id = ? AND recipient_id = ? AND status = 'pending'",
    [plan.id, recipient.id],
  );
  if (existing) return res.json({ id: existing.id, recipient_name: shortName(recipient), already_shared: true });

  const sentToday = get(
    "SELECT COUNT(*) AS n FROM workout_plan_shares WHERE sender_id = ? AND created_at >= datetime('now', '-1 day')",
    [req.member.id],
  ).n;
  if (sentToday >= MAX_SHARES_PER_DAY) throw tooManyRequests(`You can share up to ${MAX_SHARES_PER_DAY} plans a day — try again tomorrow`);

  const shareId = Number(
    run('INSERT INTO workout_plan_shares (plan_id, sender_id, recipient_id) VALUES (?, ?, ?)', [plan.id, req.member.id, recipient.id])
      .lastInsertRowid,
  );

  // The share is saved either way; a push that fails to go out only means the
  // recipient finds it the next time they open the Workout tab.
  const sender = get('SELECT first_name, last_name FROM members WHERE id = ?', [req.member.id]);
  notifyMember(recipient.id, {
    category: 'workout',
    title: `${shortName(sender)} shared a workout plan`,
    body: `“${plan.name}” — open Workout to preview it and save a copy.`,
    screen: 'workout',
    dedupeKey: `plan-share-${shareId}`,
    ttl: 24 * 60 * 60,
  }).catch(() => {});

  res.status(201).json({ id: shareId, recipient_name: shortName(recipient), already_shared: false });
});

/** A read-only look at a shared plan before saving it. */
portalRoutes.get('/workouts/shared/:id', requireMemberAuth, requireModule('fitness'), requireFitnessAccess, (req, res) => {
  const share = pendingShareOr404(req.member.id, Number(req.params.id));
  const { member_id: _sender, created_by: _staff, ...plan } = workoutPlanTree(share.plan_id, { withMedia: true });
  const sender = get('SELECT first_name, last_name FROM members WHERE id = ?', [share.sender_id]);
  res.json({ share_id: share.id, sender_name: shortName(sender), plan });
});

/** Saves a copy of the shared plan into the member's own plans. */
portalRoutes.post('/workouts/shared/:id/accept', requireMemberAuth, requireModule('fitness'), requireFitnessAccess, (req, res) => {
  const share = pendingShareOr404(req.member.id, Number(req.params.id));
  const body = parse(req.body, { activate: { type: 'boolean', default: 0 } });
  assertRoomForAnotherPlan(req.member.id);

  const source = workoutPlanTree(share.plan_id);
  const planId = tx(() => {
    const id = insertOwnPlan(req.member.id, { name: source.name, description: source.description }, source.days);
    run("UPDATE workout_plan_shares SET status = 'accepted', responded_at = datetime('now') WHERE id = ?", [share.id]);
    maybeActivate(req.member.id, id, body.activate);
    return id;
  });
  res.status(201).json({ ...workoutPlanTree(planId, { withMedia: true }), active: liveWorkoutFor(req.member.id).plan_id === planId });
});

portalRoutes.delete('/workouts/shared/:id', requireMemberAuth, requireModule('fitness'), requireFitnessAccess, (req, res) => {
  const share = pendingShareOr404(req.member.id, Number(req.params.id));
  run("UPDATE workout_plan_shares SET status = 'declined', responded_at = datetime('now') WHERE id = ?", [share.id]);
  res.json({ ok: true });
});

/** A session's sets, checked field by field — the one shape both finishing a
 * workout and editing it afterwards accept. Errors come back under the set's
 * index ("sets.3.reps") so the client can point at the row. */
function parseLogSets(raw) {
  const rawSets = Array.isArray(raw) ? raw : [];
  if (!rawSets.length) throw badRequest('Log at least one set before finishing', { sets: 'is required' });
  if (rawSets.length > 200) throw badRequest('That is more sets than one session can hold', { sets: 'at most 200' });

  const errors = {};
  const sets = rawSets.map((set, index) => {
    const exerciseName = String(set?.exercise_name ?? '').trim();
    if (!exerciseName) errors[`sets.${index}.exercise_name`] = 'is required';

    const setType = String(set?.set_type ?? 'normal');
    if (!SET_TYPES.includes(setType)) errors[`sets.${index}.set_type`] = `must be one of: ${SET_TYPES.join(', ')}`;

    // A workout left open across the upgrade still carries the old coarse
    // groups ("legs"); muscleGroupOf re-files those by the exercise's name.
    const muscleGroup = muscleGroupOf(set?.muscle_group ?? 'full_body', exerciseName);
    if (!muscleGroup) errors[`sets.${index}.muscle_group`] = 'is not a muscle group';

    const weight = Number(set?.weight_kg ?? 0);
    if (!Number.isFinite(weight) || weight < 0 || weight > 1000) {
      errors[`sets.${index}.weight_kg`] = 'must be a weight in kg from 0 to 1000';
    }

    const reps = Number(set?.reps ?? 0);
    if (!Number.isInteger(reps) || reps < 0 || reps > 1000) {
      errors[`sets.${index}.reps`] = 'must be a whole number of reps';
    }

    // A timed hold or a cardio piece logs these instead of weight × reps.
    const seconds = Number(set?.duration_seconds ?? 0);
    if (!Number.isInteger(seconds) || seconds < 0 || seconds > 86400) {
      errors[`sets.${index}.duration_seconds`] = 'must be a whole number of seconds up to 24 hours';
    }

    const distance = Number(set?.distance_km ?? 0);
    if (!Number.isFinite(distance) || distance < 0 || distance > 1000) {
      errors[`sets.${index}.distance_km`] = 'must be a distance in km from 0 to 1000';
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
      duration_seconds: seconds,
      distance_km: Math.round(distance * 1000) / 1000,
      rpe,
      completed: set?.completed === false || set?.completed === 0 ? 0 : 1,
      notes: set?.notes ? String(set.notes).trim().slice(0, 300) : null,
    };
  });
  if (Object.keys(errors).length) throw badRequest('Some sets need attention', errors);
  return sets;
}

/** Writes `sets` under `logId` in order, with each set's estimated 1RM, and
 * returns them with their new ids for the PR pass. */
function insertLogSets(logId, sets) {
  return sets.map((set, index) => {
    const est1rm = estimate1rm(set.weight_kg, set.reps);
    const id = run(
      `INSERT INTO workout_log_sets
         (log_id, exercise_name, muscle_group, set_number, set_type, weight_kg, reps,
          duration_seconds, distance_km, rpe, est_1rm_kg, completed, notes, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        logId,
        set.exercise_name,
        set.muscle_group,
        set.set_number,
        set.set_type,
        set.weight_kg,
        set.reps,
        set.duration_seconds,
        set.distance_km,
        set.rpe,
        est1rm,
        set.completed,
        set.notes,
        index,
      ],
    ).lastInsertRowid;
    return { ...set, id, est_1rm_kg: est1rm };
  });
}

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

  const sets = parseLogSets(req.body?.sets);

  const totals = summariseSets(sets);
  // The gym's own calendar date, not UTC: a 5am session at an IST gym belongs
  // to that morning, not to the day before (see the header of src/db.js).
  const logDate = today();

  // Costed now, at today's body weight, so a later weigh-in cannot rewrite
  // what this session earned on the Diet tab (see src/nutrition.js).
  const rpes = sets.filter((s) => s.completed && s.rpe !== null).map((s) => s.rpe);
  const caloriesBurned = workoutCalories({
    duration_seconds: body.duration_seconds,
    total_sets: totals.total_sets,
    avg_rpe: rpes.length ? rpes.reduce((a, b) => a + b, 0) / rpes.length : null,
    weight_kg: weightOn(req.member.id, logDate),
    intensity: nutritionProfile(req.member.id).training_intensity,
  });

  const result = tx(() => {
    const logId = run(
      `INSERT INTO workout_logs
         (member_id, plan_id, day_id, workout_name, log_date, started_at, ended_at,
          duration_seconds, total_volume_kg, total_sets, total_reps, notes, calories_burned)
       VALUES (?, ?, ?, ?, ?, datetime('now', '-' || ? || ' seconds'), datetime('now'), ?, ?, ?, ?, ?, ?)`,
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
        caloriesBurned,
      ],
    ).lastInsertRowid;

    const stored = insertLogSets(logId, sets);

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

/** The signed-in member's own log. notFound, not forbidden, for someone
 * else's: whether a given id exists in this gym is not something a member gets
 * to probe. */
function ownWorkoutLog(req) {
  const log = get('SELECT * FROM workout_logs WHERE id = ?', [Number(req.params.id)]);
  if (!log || log.member_id !== req.member.id) throw notFound('Workout not found');
  return log;
}

/** A session with its sets, each carrying its exercise's demo so the detail
 * screen can show the same thumbnail the member trained from. */
const workoutLogDetail = (logId) => ({
  ...get('SELECT * FROM workout_logs WHERE id = ?', [logId]),
  sets: attachCatalogToExercises(all('SELECT * FROM workout_log_sets WHERE log_id = ? ORDER BY sort_order, id', [logId])),
});

portalRoutes.get('/workouts/logs/:id', requireMemberAuth, requireModule('fitness'), requireFitnessAccess, (req, res) => {
  res.json(workoutLogDetail(ownWorkoutLog(req).id));
});

/**
 * Edits a finished session: its name, length, notes and the whole set list,
 * which the client sends back in full (Hevy's "Edit Workout"). The sets are
 * replaced rather than diffed, as the routine builder does, and everything
 * derived from them — totals, calories, PR marks and the PR wall — is worked
 * out again here, for the same reason the first save does it.
 *
 * The day the session belongs to and when it started stay as logged.
 */
portalRoutes.put('/workouts/logs/:id', requireMemberAuth, requireModule('fitness'), requireFitnessAccess, (req, res) => {
  const log = ownWorkoutLog(req);
  const body = parse(req.body, {
    workout_name: { type: 'string', required: true, min: 1, max: 120 },
    duration_seconds: { type: 'int', min: 0, max: 86400, default: 0 },
    notes: { type: 'string', max: 1000 },
  });
  const sets = parseLogSets(req.body?.sets);
  const totals = summariseSets(sets);

  const rpes = sets.filter((s) => s.completed && s.rpe !== null).map((s) => s.rpe);
  const caloriesBurned = workoutCalories({
    duration_seconds: body.duration_seconds,
    total_sets: totals.total_sets,
    avg_rpe: rpes.length ? rpes.reduce((a, b) => a + b, 0) / rpes.length : null,
    weight_kg: weightOn(req.member.id, log.log_date),
    intensity: nutritionProfile(req.member.id).training_intensity,
  });

  tx(() => {
    // Read before the old rows go: deleting them nulls the record's link.
    const owned = new Set(
      all(
        `SELECT p.exercise_name FROM exercise_prs p
         JOIN workout_log_sets s ON s.id = p.log_set_id
         WHERE p.member_id = ? AND s.log_id = ?`,
        [req.member.id, log.id],
      ).map((row) => row.exercise_name),
    );
    run(
      `UPDATE workout_logs
       SET workout_name = ?, duration_seconds = ?, ended_at = datetime(started_at, '+' || ? || ' seconds'),
           total_volume_kg = ?, total_sets = ?, total_reps = ?, notes = ?, calories_burned = ?
       WHERE id = ?`,
      [
        body.workout_name,
        body.duration_seconds,
        body.duration_seconds,
        totals.total_volume_kg,
        totals.total_sets,
        totals.total_reps,
        body.notes || null,
        caloriesBurned,
        log.id,
      ],
    );
    run('DELETE FROM workout_log_sets WHERE log_id = ?', [log.id]);
    const stored = insertLogSets(log.id, sets);
    reconcileEditedRecords(req.member.id, get('SELECT * FROM workout_logs WHERE id = ?', [log.id]), stored, owned);
  });

  res.json(workoutLogDetail(log.id));
});

portalRoutes.delete('/workouts/logs/:id', requireMemberAuth, requireModule('fitness'), requireFitnessAccess, (req, res) => {
  const log = ownWorkoutLog(req);
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
 * One exercise's progress for the signed-in member: each session it appeared
 * in and the bests across them. The name rides in the query string rather than
 * the path because exercise names carry slashes and ampersands.
 */
portalRoutes.get('/workouts/exercise-history', requireMemberAuth, requireModule('fitness'), requireFitnessAccess, (req, res) => {
  const name = String(req.query.name ?? '').trim();
  if (!name || name.length > 120) throw badRequest('Choose an exercise', { name: 'required' });
  res.json(exerciseHistory(req.member.id, name));
});

/**
 * The exercise picker, with each exercise's own last set attached.
 *
 * The history is what makes the picker useful rather than a list of names: a
 * member adding "Lat Pulldown" mid-session wants to see 60 kg × 10 from last
 * week next to it, and pre-filling from it is one tap instead of remembering.
 */
portalRoutes.get('/workouts/exercises', requireMemberAuth, requireModule('fitness'), requireFitnessAccess, (req, res) => {
  const items = exercisePickerRows(req.query).slice(0, 300);
  const names = items.map((e) => e.name);
  const previous = previousSetsFor(req.member.id, names);
  const lastSession = lastSessionSetsFor(req.member.id, names);

  res.json({
    items: items.map((item) => ({ ...item, previous: previous[item.name] ?? null, last_session: lastSession[item.name] ?? null })),
    // The picker's two filter sheets: muscle groups with the operator's
    // highlighted-body pictures, and the equipment list.
    muscle_groups: listMuscleGroups(),
    equipment: EQUIPMENT_TYPES,
  });
});

/* ── Ask Coach ────────────────────────────────────────────────────────── */

/** A burst guard on top of the daily cap: a stuck button or a script should
 * not be able to spend a member's whole day — or the gym's bill — in a minute. */
const coachBurstLimiter = createLimiter({ maxAttempts: 6, windowMs: 60_000, lockoutMs: 60_000 });

/** Whether this gym's members get the coach: the platform has Vertex set up
 * and the gym has not switched it off. */
const coachEnabled = () => coachConfigured() && fitnessSettings().ai_coach_enabled !== 0;

portalRoutes.get('/coach/status', requireMemberAuth, requireModule('fitness'), requireFitnessAccess, (req, res) => {
  const enabled = coachEnabled();
  const limit = config.aiCoach.dailyLimit;
  res.json({
    enabled,
    daily_limit: limit,
    remaining_today: enabled ? Math.max(0, limit - questionsToday(req.member.id)) : 0,
    plan_daily_limit: config.aiCoach.planDailyLimit,
    plans_remaining_today: enabled ? Math.max(0, config.aiCoach.planDailyLimit - plansToday(req.member.id)) : 0,
    plan_defaults: enabled ? planDefaults(req.member.id) : null,
  });
});

/**
 * One question to the coach. The phone sends the question, which screen it was
 * asked from and — mid-workout — the live session, which exists only on the
 * phone until Finish. Everything else the coach knows is read here, for this
 * member only.
 *
 * A provider failure is a 502 and is not counted against the day's questions:
 * the member got nothing for it.
 *
 * Asked with `Accept: text/event-stream` the reply is streamed, so the sheet
 * can show the coach at work: `step` events for what it is reading, `thought`
 * for Gemini's thought summaries, `answer` for the reply as it is written, then
 * one `done` with the same body the JSON reply has — or `error`. Anything
 * refused before Gemini is called is still a plain JSON error.
 */
portalRoutes.post('/coach/ask', requireMemberAuth, requireModule('fitness'), requireFitnessAccess, async (req, res) => {
  if (!coachEnabled()) throw new HttpError(503, 'The coach is not available at this gym', { code: 'ai_disabled' });

  const question = String(req.body?.question ?? '').trim();
  const screen = String(req.body?.screen ?? 'workout');
  if (!question) throw badRequest('Ask the coach a question', { question: 'is required' });
  if (question.length > MAX_QUESTION_LENGTH) {
    throw badRequest(`Keep questions under ${MAX_QUESTION_LENGTH} characters`, { question: 'is too long' });
  }
  if (!COACH_SCREENS.includes(screen)) throw badRequest('Unknown screen', { screen: `must be one of ${COACH_SCREENS.join(', ')}` });

  const limit = config.aiCoach.dailyLimit;
  const asked = questionsToday(req.member.id);
  if (asked >= limit) {
    throw tooManyRequests(`That's your ${limit} coach questions for today — ask again tomorrow`, { code: 'coach_limit_reached' });
  }
  const burstKey = `${req.tenant?.slug ?? ''}:${req.member.id}`;
  const burst = coachBurstLimiter.check(burstKey);
  if (burst.locked) {
    throw tooManyRequests(`Slow down a little — try again in ${burst.retryAfterSeconds}s`, { code: 'coach_burst' });
  }
  coachBurstLimiter.recordAttempt(burstKey);

  const context = buildCoachContext(req.member.id, {
    screen,
    session: req.body?.session,
    unit: req.body?.unit,
    planId: liveWorkoutFor(req.member.id).plan_id,
  });
  const history = recentTurns(req.member.id, screen);
  const unavailable = 'The coach could not answer just now — try again in a moment';

  const save = (reply) => {
    run(
      `INSERT INTO ai_coach_messages (member_id, screen, question, answer, meal_plan, input_tokens, output_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        req.member.id,
        screen,
        question,
        reply.answer,
        reply.meal_plan ? JSON.stringify(reply.meal_plan) : null,
        reply.input_tokens,
        reply.output_tokens,
      ],
    );
    return {
      answer: reply.answer,
      suggestion: reply.suggestion,
      // A meal plan, which the sheet shows as a card to log or save.
      ...(reply.meal_plan && { meal_plan: reply.meal_plan }),
      remaining_today: Math.max(0, limit - asked - 1),
      // The figures the answer was worked from, for the macro rings under a
      // diet answer — the same numbers the coach was given.
      ...(screen === 'diet' && { diet: { eaten: context.diet_today.eaten, targets: context.diet_today.targets } }),
    };
  };

  if (!String(req.get('accept') ?? '').includes('text/event-stream')) {
    let reply;
    try {
      reply = await askCoach({ context, question, history });
    } catch (err) {
      console.error('Ask Coach request failed:', err?.message ?? err);
      throw new HttpError(502, unavailable, { code: 'coach_unavailable' });
    }
    return res.json(save(reply));
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    // Stop a reverse proxy holding the stream back until it ends.
    'X-Accel-Buffering': 'no',
  });
  const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  // The member closed the app mid-answer: stop paying for the rest of it.
  const gone = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) gone.abort();
  });

  for (const text of contextSteps(context)) emit('step', { text });
  try {
    const reply = await streamCoach({
      context,
      question,
      history,
      signal: gone.signal,
      onThought: (text) => emit('thought', { text }),
      onAnswer: (text) => emit('answer', { text }),
    });
    emit('done', save(reply));
  } catch (err) {
    if (!gone.signal.aborted) {
      console.error('Ask Coach request failed:', err?.message ?? err);
      emit('error', { error: unavailable, code: 'coach_unavailable' });
    }
  }
  res.end();
});

/** Voice questions get their own burst guard: a clip that came out wrong is
 * recorded again, so a few in a minute is normal — a stream of them is not. */
const voiceBurstLimiter = createLimiter({ maxAttempts: 10, windowMs: 60_000, lockoutMs: 60_000 });

/**
 * A spoken question written out for the composer, in whatever language it was
 * spoken — Hindi and Hinglish in Roman letters (src/aiCoach.js). The phone
 * sends the clip as base64 with its type. It is not a question: the member
 * checks the words and sends them, and only that counts. Each clip written
 * down is logged (size and tokens, never the audio or the words) against its
 * own daily cap. Refused once the day's questions are used up, since the
 * words could not be sent anyway.
 */
portalRoutes.post('/coach/transcribe', requireMemberAuth, requireModule('fitness'), requireFitnessAccess, async (req, res) => {
  if (!coachEnabled()) throw new HttpError(503, 'The coach is not available at this gym', { code: 'ai_disabled' });

  const mimeType = String(req.body?.mime_type ?? '').split(';')[0].trim().toLowerCase();
  const audio = String(req.body?.audio ?? '');
  const screen = String(req.body?.screen ?? 'workout');
  if (!VOICE_MIME_TYPES.includes(mimeType)) {
    throw badRequest('This phone recorded in a format the coach cannot read — type the question instead', {
      mime_type: `must be one of ${VOICE_MIME_TYPES.join(', ')}`,
    });
  }
  if (!audio || !/^[A-Za-z0-9+/]+={0,2}$/.test(audio)) throw badRequest('Record a question first', { audio: 'must be base64 audio' });
  if (audio.length * 0.75 > MAX_VOICE_BYTES) {
    throw badRequest('Keep voice questions under a minute', { audio: 'is too long' });
  }
  if (!COACH_SCREENS.includes(screen)) throw badRequest('Unknown screen', { screen: `must be one of ${COACH_SCREENS.join(', ')}` });

  const limit = config.aiCoach.dailyLimit;
  if (questionsToday(req.member.id) >= limit) {
    throw tooManyRequests(`That's your ${limit} coach questions for today — ask again tomorrow`, { code: 'coach_limit_reached' });
  }
  const voiceLimit = config.aiCoach.voiceDailyLimit;
  if (voiceClipsToday(req.member.id) >= voiceLimit) {
    throw tooManyRequests(`That's your ${voiceLimit} voice questions for today — type your question instead`, {
      code: 'voice_limit_reached',
    });
  }
  const burstKey = `${req.tenant?.slug ?? ''}:${req.member.id}`;
  const burst = voiceBurstLimiter.check(burstKey);
  if (burst.locked) {
    throw tooManyRequests(`Slow down a little — try again in ${burst.retryAfterSeconds}s`, { code: 'coach_burst' });
  }
  voiceBurstLimiter.recordAttempt(burstKey);

  let result;
  try {
    result = await transcribeVoice({ audio, mimeType, screen });
  } catch (err) {
    console.error('Coach voice transcription failed:', err?.message ?? err);
    throw new HttpError(502, 'Could not make out that recording — try again or type it', { code: 'coach_unavailable' });
  }
  const audioBytes = Math.round(audio.length * 0.75);
  run(
    `INSERT INTO ai_voice_transcriptions (member_id, screen, mime_type, audio_bytes, heard, input_tokens, output_tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [req.member.id, screen, mimeType, audioBytes, result.text ? 1 : 0, result.input_tokens, result.output_tokens],
  );
  // Only the clip's shape, never what was said: enough to tell a silent mic
  // (a tiny clip) or an unusual recorder from Gemini mishearing.
  if (!result.text) console.warn(`Coach voice: nothing heard in a ${Math.round(audioBytes / 1024)} KB ${mimeType} clip`);
  res.json({ text: result.text });
});

/** The generator sheet's starting answers, from what the member already told
 * the Diet settings: their training days and whether they want to lose or gain. */
function planDefaults(memberId) {
  const profile = nutritionProfile(memberId);
  const goal = { lose: 'fat_loss', gain: 'muscle_gain' }[profile.goal] ?? 'general_fitness';
  return { goal, days_per_week: Math.min(6, Math.max(2, Number(profile.training_days) || 3)) };
}

const PLAN_REQUEST_FIELDS = {
  goal: { type: 'enum', values: PLAN_GOALS, required: true },
  level: { type: 'enum', values: PLAN_LEVELS, required: true },
  days_per_week: { type: 'int', min: 1, max: 7, required: true },
  minutes: { type: 'int', min: 20, max: 150, default: 60 },
  equipment: { type: 'enum', values: Object.keys(PLAN_EQUIPMENT), default: 'full_gym' },
  focus: { type: 'enum', values: PLAN_FOCUS, default: 'balanced' },
  notes: { type: 'string', max: 300 },
};

/**
 * The AI workout generator. Builds a week from this gym's own exercise library
 * (catalogue plus the gym's custom moves, cut to the member's equipment) and
 * returns it as a draft — nothing is saved here. The phone opens it in the
 * plan builder, where the member edits and saves it through POST
 * /workouts/routines like any plan they wrote themselves.
 */
portalRoutes.post('/coach/plan', requireMemberAuth, requireModule('fitness'), requireFitnessAccess, async (req, res) => {
  if (!coachEnabled()) throw new HttpError(503, 'The coach is not available at this gym', { code: 'ai_disabled' });
  const request = parse(req.body, PLAN_REQUEST_FIELDS);

  const limit = config.aiCoach.planDailyLimit;
  const made = plansToday(req.member.id);
  if (made >= limit) {
    throw tooManyRequests(`That's your ${limit} AI plans for today — edit the last one, or try again tomorrow`, {
      code: 'plan_limit_reached',
    });
  }
  const burstKey = `${req.tenant?.slug ?? ''}:${req.member.id}`;
  const burst = coachBurstLimiter.check(burstKey);
  if (burst.locked) {
    throw tooManyRequests(`Slow down a little — try again in ${burst.retryAfterSeconds}s`, { code: 'coach_burst' });
  }
  coachBurstLimiter.recordAttempt(burstKey);

  const library = libraryForPlan(exercisePickerRows({}), request.equipment);
  if (library.length < 4) throw badRequest('There are not enough exercises in this gym’s library for that equipment yet');
  const context = buildCoachContext(req.member.id, {
    screen: 'workout',
    planId: liveWorkoutFor(req.member.id).plan_id,
  });

  let result;
  try {
    result = await generatePlan({ request, context, library });
  } catch (err) {
    console.error('AI plan generation failed:', err?.message ?? err);
    throw new HttpError(502, 'Could not build a plan just now — try again in a moment', { code: 'coach_unavailable' });
  }

  run(
    `INSERT INTO ai_plan_generations (member_id, request, plan, input_tokens, output_tokens)
     VALUES (?, ?, ?, ?, ?)`,
    [req.member.id, JSON.stringify(request), JSON.stringify(result.plan), result.input_tokens, result.output_tokens],
  );

  res.json({
    plan: result.plan,
    // Names the model made up and the server threw away — reported so a
    // short day is explained rather than mysterious.
    dropped: result.dropped,
    plans_remaining_today: Math.max(0, limit - made - 1),
  });
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

portalRoutes.get('/diets/current', requireMemberAuth, requireModule('fitness'), requireFitnessAccess, (req, res) => {
  const assignment = get(
    `SELECT a.*, u.name AS assigned_by_name
     FROM member_diet_assignments a
     LEFT JOIN users u ON u.id = a.assigned_by
     WHERE a.member_id = ? AND a.status = 'active'`,
    [req.member.id],
  );
  const plan = assignment ? dietPlanTree(assignment.plan_id) : null;
  const effective = effectiveDietTargets(req.member.id);

  res.json({
    assignment: assignment ?? null,
    // The trainer's plan is still sent when the member follows their own
    // targets: its meals stay useful as suggestions either way.
    plan,
    targets: effective.targets,
    target_source: effective.source,
    exercise_addback_pct: effective.exercise_addback_pct,
    using_default_targets: effective.source === 'default',
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
      fiber_g: Math.round((acc.fiber_g + entry.fiber_g) * 10) / 10,
      sugar_g: Math.round((acc.sugar_g + entry.sugar_g) * 10) / 10,
    }),
    { calories: 0, protein_g: 0, carbs_g: 0, fats_g: 0, fiber_g: 0, sugar_g: 0 },
  );

  const meals = {};
  for (const type of MEAL_TYPES) meals[type] = [];
  for (const entry of entries) meals[entry.meal_type]?.push(entry);

  // MyFitnessPal's equation: goal − food + exercise = remaining, where the
  // exercise term is only the share the member chose to eat back.
  const { targets, exercise_addback_pct: addback } = effectiveDietTargets(req.member.id);
  const exercise = exerciseForDay(req.member.id, logDate);
  const credited = Math.round((exercise.total_burned * addback) / 100);

  res.json({
    log_date: logDate,
    water_ml: log?.water_ml ?? 0,
    entries,
    meals,
    totals,
    exercise: { ...exercise, addback_pct: addback, credited },
    budget: {
      goal: targets.target_calories,
      food: totals.calories,
      exercise: credited,
      remaining: targets.target_calories - totals.calories + credited,
    },
  });
});

/**
 * Day-by-day totals for the insights screen's week view, oldest first, with
 * each day's budget (today's goal plus that day's credited exercise). Days
 * with nothing logged are included as zeros so the chart has no gaps.
 *
 * The goal is the member's current one: targets are not versioned, and a
 * week is short enough for that to be the honest comparison.
 */
portalRoutes.get('/diets/summary', requireMemberAuth, requireModule('fitness'), requireFitnessAccess, (req, res) => {
  const end = req.query.end ? String(req.query.end) : today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(end)) throw badRequest('Pick a date formatted YYYY-MM-DD', { end: 'is not a date' });
  const count = Math.min(Math.max(toInt(req.query.days, 7), 1), 31);
  const start = addDays(end, -(count - 1));

  const rows = all(
    `SELECT dl.log_date, dl.water_ml,
            COALESCE(SUM(e.calories), 0) AS calories,
            ROUND(COALESCE(SUM(e.protein_g), 0), 1) AS protein_g,
            ROUND(COALESCE(SUM(e.carbs_g), 0), 1) AS carbs_g,
            ROUND(COALESCE(SUM(e.fats_g), 0), 1) AS fats_g,
            ROUND(COALESCE(SUM(e.fiber_g), 0), 1) AS fiber_g,
            ROUND(COALESCE(SUM(e.sugar_g), 0), 1) AS sugar_g,
            COUNT(e.id) AS entry_count
     FROM diet_logs dl LEFT JOIN diet_log_entries e ON e.diet_log_id = dl.id
     WHERE dl.member_id = ? AND dl.log_date BETWEEN ? AND ?
     GROUP BY dl.id`,
    [req.member.id, start, end],
  );
  const byDate = new Map(rows.map((r) => [r.log_date, r]));
  const { targets, exercise_addback_pct: addback } = effectiveDietTargets(req.member.id);

  const days = Array.from({ length: count }, (_, i) => {
    const logDate = addDays(start, i);
    const row = byDate.get(logDate);
    const burned = exerciseForDay(req.member.id, logDate).total_burned;
    return {
      log_date: logDate,
      calories: row?.calories ?? 0,
      protein_g: row?.protein_g ?? 0,
      carbs_g: row?.carbs_g ?? 0,
      fats_g: row?.fats_g ?? 0,
      fiber_g: row?.fiber_g ?? 0,
      sugar_g: row?.sugar_g ?? 0,
      water_ml: row?.water_ml ?? 0,
      entry_count: row?.entry_count ?? 0,
      burned,
      budget: targets.target_calories + Math.round((burned * addback) / 100),
    };
  });

  res.json({ days, targets });
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
    fiber_g: { type: 'number', min: 0, max: 500 },
    sugar_g: { type: 'number', min: 0, max: 2000 },
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
      fiber_g: Math.round(food.fiber_g * body.quantity * 10) / 10,
      sugar_g: Math.round(food.sugar_g * body.quantity * 10) / 10,
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
      fiber_g: body.fiber_g ?? 0,
      sugar_g: body.sugar_g ?? 0,
    };
  }

  const log = ensureDietLog(req.member.id, body.log_date);
  const info = run(
    `INSERT INTO diet_log_entries
       (diet_log_id, meal_type, food_id, food_name, quantity, serving_unit, calories, protein_g, carbs_g, fats_g, fiber_g, sugar_g)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      log.id,
      body.meal_type,
      body.food_id ?? null,
      name,
      body.quantity,
      unit,
      macros.calories,
      macros.protein_g,
      macros.carbs_g,
      macros.fats_g,
      macros.fiber_g,
      macros.sugar_g,
    ],
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
  syncFoodCatalog();
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
  // What this member logged lately, newest first, one row per food: the
  // figures are that last entry's (SQLite takes bare columns from the MAX
  // row), so a one-tap re-log repeats exactly what they had last time.
  const recent = all(
    `SELECT e.food_id, e.food_name, e.quantity, e.serving_unit, e.calories, e.protein_g, e.carbs_g, e.fats_g,
            e.fiber_g, e.sugar_g, e.meal_type, MAX(e.logged_at) AS last_logged
     FROM diet_log_entries e JOIN diet_logs l ON l.id = e.diet_log_id
     WHERE l.member_id = ?
     GROUP BY e.food_name COLLATE NOCASE
     ORDER BY last_logged DESC LIMIT 30`,
    [req.member.id],
  );
  const favorites = memberFavorites(req.member.id);
  const library = libraryFoodsById([...recent, ...favorites].map((row) => row.food_id));
  const withFood = (row) => ({ ...row, food: library.get(row.food_id) ?? null });
  res.json({
    items: all(`SELECT * FROM food_library ${clause} ORDER BY category, name LIMIT 300`, params),
    recent: recent.map(withFood),
    favorites: favorites.map(withFood),
  });
});

/* ── Favourite foods ──────────────────────────────────────────────────── */

const memberFavorites = (memberId) =>
  all(
    `SELECT id AS favorite_id, food_id, food_name, serving_unit, calories, protein_g, carbs_g, fats_g, fiber_g, sugar_g, created_at
     FROM member_food_favorites WHERE member_id = ? ORDER BY created_at DESC, id DESC`,
    [memberId],
  );

/** The library rows behind a list of (possibly null, possibly deleted) ids. */
function libraryFoodsById(ids) {
  const wanted = [...new Set(ids.filter(Boolean))];
  if (!wanted.length) return new Map();
  const rows = all(`SELECT * FROM food_library WHERE id IN (${wanted.map(() => '?').join(', ')})`, wanted);
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * Stars a food: a library one by `food_id`, or a hand-typed one by name with
 * its figures for one `serving_unit`. Starring twice is a no-op that returns
 * the existing favourite, so a double tap cannot fail.
 */
portalRoutes.post('/diets/favorites', requireMemberAuth, requireModule('fitness'), requireFitnessAccess, (req, res) => {
  const body = parse(req.body, {
    food_id: { type: 'int', min: 1 },
    food_name: { type: 'string', max: 120 },
    serving_unit: { type: 'string', max: 60, default: 'serving' },
    calories: { type: 'int', min: 0, max: 20000, default: 0 },
    protein_g: { type: 'number', min: 0, max: 2000, default: 0 },
    carbs_g: { type: 'number', min: 0, max: 2000, default: 0 },
    fats_g: { type: 'number', min: 0, max: 2000, default: 0 },
    fiber_g: { type: 'number', min: 0, max: 500, default: 0 },
    sugar_g: { type: 'number', min: 0, max: 2000, default: 0 },
  });
  const memberId = req.member.id;
  const find = (id) => memberFavorites(memberId).find((f) => f.favorite_id === id);

  if (body.food_id) {
    const food = get('SELECT * FROM food_library WHERE id = ?', [body.food_id]);
    if (!food) throw notFound('That food is not in the library');
    const existing = get('SELECT id FROM member_food_favorites WHERE member_id = ? AND food_id = ?', [memberId, food.id]);
    if (existing) return res.json({ ...find(existing.id), food });
    const info = run(
      `INSERT INTO member_food_favorites (member_id, food_id, food_name, serving_unit) VALUES (?, ?, ?, ?)`,
      [memberId, food.id, food.name, food.serving_unit],
    );
    return res.status(201).json({ ...find(Number(info.lastInsertRowid)), food });
  }

  const name = body.food_name?.trim();
  if (!name) throw badRequest('Pick a food or name the one to save', { food_name: 'is required' });
  const existing = get(
    'SELECT id FROM member_food_favorites WHERE member_id = ? AND food_id IS NULL AND food_name = ? COLLATE NOCASE',
    [memberId, name],
  );
  if (existing) return res.json({ ...find(existing.id), food: null });
  const info = run(
    `INSERT INTO member_food_favorites
       (member_id, food_name, serving_unit, calories, protein_g, carbs_g, fats_g, fiber_g, sugar_g)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [memberId, name, body.serving_unit, body.calories, body.protein_g, body.carbs_g, body.fats_g, body.fiber_g, body.sugar_g],
  );
  return res.status(201).json({ ...find(Number(info.lastInsertRowid)), food: null });
});

portalRoutes.delete('/diets/favorites/:id', requireMemberAuth, requireModule('fitness'), requireFitnessAccess, (req, res) => {
  const info = run('DELETE FROM member_food_favorites WHERE id = ? AND member_id = ?', [Number(req.params.id), req.member.id]);
  if (!info.changes) throw notFound('That food is not in your favourites');
  res.json({ ok: true });
});

/* ── Meal plans ───────────────────────────────────────────────────────── */

const MAX_SAVED_MEAL_PLANS = 50;

const savedMealPlan = (row) => ({ id: row.id, created_at: row.created_at, ...JSON.parse(row.plan), name: row.name });

/** The member's saved meal plans, newest first. */
portalRoutes.get('/diets/meal-plans', requireMemberAuth, requireModule('fitness'), requireFitnessAccess, (req, res) => {
  const rows = all('SELECT * FROM member_meal_plans WHERE member_id = ? ORDER BY id DESC', [req.member.id]);
  res.json({ items: rows.map(savedMealPlan) });
});

/** Keeps a plan — usually one the coach made — to log again on another day. */
portalRoutes.post('/diets/meal-plans', requireMemberAuth, requireModule('fitness'), requireFitnessAccess, (req, res) => {
  const plan = cleanMealPlan(req.body);
  if (!plan) throw badRequest('That plan has no food in it to save', { meals: 'is required' });
  const count = get('SELECT COUNT(*) AS n FROM member_meal_plans WHERE member_id = ?', [req.member.id]).n;
  if (count >= MAX_SAVED_MEAL_PLANS) {
    throw conflict(`You have ${MAX_SAVED_MEAL_PLANS} saved meal plans — delete one to save another`);
  }
  const info = run('INSERT INTO member_meal_plans (member_id, name, plan) VALUES (?, ?, ?)', [
    req.member.id,
    plan.name,
    JSON.stringify({ meals: plan.meals, totals: plan.totals }),
  ]);
  res.status(201).json(savedMealPlan(get('SELECT * FROM member_meal_plans WHERE id = ?', [info.lastInsertRowid])));
});

portalRoutes.delete('/diets/meal-plans/:id', requireMemberAuth, requireModule('fitness'), requireFitnessAccess, (req, res) => {
  const info = run('DELETE FROM member_meal_plans WHERE id = ? AND member_id = ?', [Number(req.params.id), req.member.id]);
  if (!info.changes) throw notFound('That meal plan is not in your saved plans');
  res.json({ ok: true });
});

/* ── Own nutrition targets ────────────────────────────────────────────── */

const fitnessGate = [requireMemberAuth, requireModule('fitness'), requireFitnessAccess];

/* ── Food search ──────────────────────────────────────────────────────── */

/** The gym's library plus, when it has little, USDA and Open Food Facts —
 * see src/foodSearch.js. Online results carry a `ref` to pick them by. */
portalRoutes.get('/diets/food-search', ...fitnessGate, async (req, res) => {
  res.json(await searchFoods({ q: req.query.q, external: externalMode(req.query.external), limit: toInt(req.query.limit, 30) }));
});

/** A picked online food joins the gym's library — the next member searching
 * for it finds it there — and comes back as a row to log by food_id. */
portalRoutes.post('/diets/food-search/select', ...fitnessGate, async (req, res) => {
  const { food, created } = await importFood(parseFoodRef(req.body));
  res.status(created ? 201 : 200).json(food);
});

/* ── Barcode foods ────────────────────────────────────────────────────── */

/** A scanned (or typed) barcode → a library food the sheet can log by id, or
 * found: false with whatever the database knew, to prefill "add it". */
portalRoutes.get('/diets/barcode/:code', ...fitnessGate, async (req, res) => {
  res.json(await lookupBarcode(req.params.code));
});

/**
 * A product nobody has scanned before and Open Food Facts does not know,
 * typed off the label per 100 g / 100 ml. It joins the gym's library — the
 * next member with the same pack finds it — and staff can delete it there.
 */
portalRoutes.post('/diets/barcode-foods', ...fitnessGate, (req, res) => {
  const body = parse(req.body, {
    barcode: { type: 'string', required: true, max: 20 },
    name: { type: 'string', required: true, min: 2, max: 100 },
    brand: { type: 'string', max: 80 },
    basis: { type: 'enum', values: ['100g', '100ml'], default: '100g' },
    calories: { type: 'int', required: true, min: 0, max: 900 },
    protein_g: { type: 'number', min: 0, max: 100, default: 0 },
    carbs_g: { type: 'number', min: 0, max: 100, default: 0 },
    fats_g: { type: 'number', min: 0, max: 100, default: 0 },
    fiber_g: { type: 'number', min: 0, max: 100, default: 0 },
    sugar_g: { type: 'number', min: 0, max: 100, default: 0 },
    serving_size_g: { type: 'number', min: 1, max: 2000 },
  });
  const barcode = normaliseBarcode(body.barcode);
  // Two members adding the same pack at once: the first one wins.
  const existing = libraryFoodByBarcode(barcode);
  if (existing) return res.json(existing);

  const brand = body.brand?.trim() || null;
  const name = brand && !body.name.toLowerCase().includes(brand.toLowerCase()) ? `${brand} ${body.name}` : body.name;
  const round1 = (n) => Math.round(n * 10) / 10;
  const food = insertBarcodeFood(
    {
      name: name.slice(0, 120),
      brand,
      serving_unit: body.basis,
      calories: body.calories,
      protein_g: round1(body.protein_g),
      carbs_g: round1(body.carbs_g),
      fats_g: round1(body.fats_g),
      fiber_g: round1(body.fiber_g),
      sugar_g: round1(body.sugar_g),
      serving_size_g: body.serving_size_g ? round1(body.serving_size_g) : null,
      serving_label: body.serving_size_g ? `${round1(body.serving_size_g)} ${body.basis === '100ml' ? 'ml' : 'g'}` : null,
    },
    { barcode, source: 'member' },
  );
  return res.status(201).json(food);
});

/** One weigh-in per day: a second one that day replaces the first. */
function recordWeight(memberId, weightKg, logDate) {
  run(
    `INSERT INTO body_weight_logs (member_id, log_date, weight_kg) VALUES (?, ?, ?)
     ON CONFLICT (member_id, log_date) DO UPDATE SET weight_kg = excluded.weight_kg, created_at = datetime('now')`,
    [memberId, logDate, Math.round(weightKg * 10) / 10],
  );
  return get('SELECT id, log_date, weight_kg FROM body_weight_logs WHERE member_id = ? AND log_date = ?', [
    memberId,
    logDate,
  ]);
}

const latestWeighIn = (memberId) =>
  get('SELECT id, log_date, weight_kg FROM body_weight_logs WHERE member_id = ? ORDER BY log_date DESC LIMIT 1', [
    memberId,
  ]) ?? null;

function nutritionState(memberId) {
  const profile = nutritionProfile(memberId);
  const plan = get(
    `SELECT p.id, p.name, p.target_calories, p.target_protein_g, p.target_carbs_g, p.target_fats_g, p.target_water_ml
     FROM member_diet_assignments a JOIN diet_plans p ON p.id = a.plan_id
     WHERE a.member_id = ? AND a.status = 'active'`,
    [memberId],
  );
  return {
    profile,
    age: ageOn(profile.birth_date),
    latest_weight: latestWeighIn(memberId),
    trainer_plan: plan ?? null,
    effective: effectiveDietTargets(memberId),
  };
}

const TARGET_FIELDS = {
  target_calories: { type: 'int', min: 800, max: 10000 },
  target_protein_g: { type: 'int', min: 0, max: 1000 },
  target_carbs_g: { type: 'int', min: 0, max: 2000 },
  target_fats_g: { type: 'int', min: 0, max: 1000 },
  target_fiber_g: { type: 'int', min: 0, max: 200 },
  target_sugar_g: { type: 'int', min: 0, max: 1000 },
  target_water_ml: { type: 'int', min: 0, max: 15000 },
};

/** Body stats, shared by saving the profile and by asking for a suggestion —
 * a member can try numbers in the calculator without committing them. */
const BODY_FIELDS = {
  height_cm: { type: 'number', min: 100, max: 250 },
  sex: { type: 'enum', values: SEXES },
  birth_date: { type: 'date' },
  activity_level: { type: 'enum', values: Object.keys(ACTIVITY_LEVELS) },
  training_days: { type: 'int', min: 0, max: 7 },
  training_intensity: { type: 'enum', values: Object.keys(TRAINING_INTENSITIES) },
  goal: { type: 'enum', values: NUTRITION_GOALS },
  goal_rate_kg: { type: 'number', min: 0.1, max: 1 },
  goal_weight_kg: { type: 'number', min: 30, max: 350 },
  exercise_addback_pct: { type: 'int' },
  weight_kg: { type: 'number', min: 25, max: 350 },
};

function checkBodyFields(body) {
  if (body.exercise_addback_pct != null && !ADDBACK_OPTIONS.includes(body.exercise_addback_pct)) {
    throw badRequest('Add back 0%, 50% or 100% of exercise', { exercise_addback_pct: 'must be 0, 50 or 100' });
  }
  if (body.birth_date) {
    const age = ageOn(body.birth_date);
    if (age < 13 || age > 100) throw badRequest('Check your date of birth', { birth_date: 'must give an age from 13 to 100' });
  }
}

portalRoutes.get('/nutrition', ...fitnessGate, (req, res) => {
  res.json(nutritionState(req.member.id));
});

portalRoutes.put('/nutrition', ...fitnessGate, (req, res) => {
  const body = parse(req.body, {
    use_own_targets: { type: 'boolean' },
    ...TARGET_FIELDS,
    ...BODY_FIELDS,
  });
  checkBodyFields(body);

  const memberId = req.member.id;
  const { weight_kg: weightKg, ...columns } = body;
  // NOT NULL columns: a cleared field means "leave it", not "store nothing".
  for (const key of ['use_own_targets', 'exercise_addback_pct', 'activity_level', 'training_days', 'training_intensity', 'goal', 'goal_rate_kg']) {
    if (columns[key] === null) delete columns[key];
  }

  // Switching to "my own" with nothing to switch to would silently show the
  // defaults under a label that says otherwise.
  const ownCalories = 'target_calories' in columns ? columns.target_calories : nutritionProfile(memberId).target_calories;
  if (columns.use_own_targets && !ownCalories) {
    throw badRequest('Set a daily calorie target before switching to your own', { target_calories: 'is required' });
  }

  tx(() => {
    // Explicit rather than the column default: a database created while the
    // default was still 100 must not hand new members a different setting.
    run('INSERT OR IGNORE INTO member_nutrition_profiles (member_id, exercise_addback_pct) VALUES (?, 0)', [memberId]);
    const keys = Object.keys(columns);
    if (keys.length) {
      run(
        `UPDATE member_nutrition_profiles SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now')
         WHERE member_id = ?`,
        [...keys.map((k) => columns[k]), memberId],
      );
    }
    if (weightKg) recordWeight(memberId, weightKg, today());
  });

  res.json(nutritionState(memberId));
});

/**
 * The calculator. Anything sent overrides what is stored, so the settings
 * screen can preview a suggestion from unsaved fields; whatever is missing
 * from both is reported per field.
 */
portalRoutes.post('/nutrition/suggest', ...fitnessGate, (req, res) => {
  const body = parse(req.body, BODY_FIELDS);
  checkBodyFields(body);

  const stored = nutritionProfile(req.member.id);
  const pick = (key) => body[key] ?? stored[key];
  const input = {
    weight_kg: body.weight_kg ?? latestWeighIn(req.member.id)?.weight_kg ?? null,
    height_cm: pick('height_cm'),
    sex: pick('sex'),
    age: ageOn(pick('birth_date')),
    activity_level: pick('activity_level'),
    training_days: pick('training_days'),
    training_intensity: pick('training_intensity'),
    goal: pick('goal'),
    goal_rate_kg: pick('goal_rate_kg'),
    exercise_addback_pct: pick('exercise_addback_pct'),
  };

  const missing = {};
  if (!input.weight_kg) missing.weight_kg = 'is required';
  if (!input.height_cm) missing.height_cm = 'is required';
  if (!input.sex) missing.sex = 'is required';
  if (input.age === null) missing.birth_date = 'is required';
  if (Object.keys(missing).length) throw badRequest('A few details are needed to work out your targets', missing);

  const result = suggestTargets(input);
  const goalWeight = body.goal_weight_kg ?? stored.goal_weight_kg;
  const rate = input.goal === 'maintain' ? 0 : input.goal_rate_kg;
  const towardsGoal = goalWeight && rate
    && (input.goal === 'lose' ? goalWeight < input.weight_kg : goalWeight > input.weight_kg);

  res.json({
    ...result,
    input,
    weeks_to_goal: towardsGoal ? Math.ceil(Math.abs(input.weight_kg - goalWeight) / rate) : null,
  });
});

/* ── Weigh-ins ────────────────────────────────────────────────────────── */

portalRoutes.get('/weight', ...fitnessGate, (req, res) => {
  const days = Math.min(Math.max(toInt(req.query.days, 180), 7), 730);
  res.json({
    items: all(
      'SELECT id, log_date, weight_kg FROM body_weight_logs WHERE member_id = ? AND log_date >= ? ORDER BY log_date',
      [req.member.id, addDays(today(), -days)],
    ),
    latest: latestWeighIn(req.member.id),
    goal_weight_kg: nutritionProfile(req.member.id).goal_weight_kg,
  });
});

portalRoutes.post('/weight', ...fitnessGate, (req, res) => {
  const body = parse(req.body, {
    weight_kg: { type: 'number', required: true, min: 25, max: 350 },
    log_date: { type: 'date', default: today() },
  });
  if (body.log_date > today()) throw badRequest('That date has not happened yet', { log_date: 'is in the future' });
  res.status(201).json(recordWeight(req.member.id, body.weight_kg, body.log_date));
});

portalRoutes.delete('/weight/:id', ...fitnessGate, (req, res) => {
  const info = run('DELETE FROM body_weight_logs WHERE id = ? AND member_id = ?', [Number(req.params.id), req.member.id]);
  if (!info.changes) throw notFound('That weigh-in is not in your log');
  res.json({ ok: true });
});

/* ── Activities ───────────────────────────────────────────────────────── */

portalRoutes.get('/activities/types', ...fitnessGate, (req, res) => {
  res.json({ items: ACTIVITY_TYPES, weight_kg: weightOn(req.member.id) });
});

portalRoutes.post('/activities', ...fitnessGate, (req, res) => {
  const body = parse(req.body, {
    activity: { type: 'enum', values: ACTIVITY_KEYS, required: true },
    name: { type: 'string', max: 80 },
    duration_minutes: { type: 'int', required: true, min: 1, max: 600 },
    calories: { type: 'int', min: 0, max: 5000 },
    log_date: { type: 'date', default: today() },
  });
  if (body.log_date > today()) throw badRequest('That date has not happened yet', { log_date: 'is in the future' });

  const type = ACTIVITY_TYPES.find((a) => a.key === body.activity);
  // A number the member typed (off a watch, say) beats the estimate.
  const calories = body.calories ?? activityCalories(body.activity, body.duration_minutes, weightOn(req.member.id, body.log_date));
  const info = run(
    'INSERT INTO activity_logs (member_id, log_date, activity, name, duration_minutes, calories) VALUES (?, ?, ?, ?, ?, ?)',
    [req.member.id, body.log_date, body.activity, body.name || type.label, body.duration_minutes, calories],
  );
  res.status(201).json(get('SELECT * FROM activity_logs WHERE id = ?', [info.lastInsertRowid]));
});

portalRoutes.delete('/activities/:id', ...fitnessGate, (req, res) => {
  const info = run('DELETE FROM activity_logs WHERE id = ? AND member_id = ?', [Number(req.params.id), req.member.id]);
  if (!info.changes) throw notFound('That activity is not in your log');
  res.json({ ok: true });
});
