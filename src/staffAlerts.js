import { MANAGES_BILLING } from './auth.js';
import { all, get, getBusinessType, run, tx } from './db.js';
import { branding, gymClock, pushToSubscriptions, track } from './notifications.js';
import { addDays } from './validate.js';
import { say } from './verticals.js';

/**
 * Staff alerts: the bell in the staff app, for the things someone at the gym
 * has to act on — a member paid online and the money needs checking, last
 * night's expiries, a trial the WhatsApp assistant booked, a chat it handed
 * over.
 *
 * Each alert is a row in the person's inbox (staff_notifications) and, if they
 * turned it on, a Web Push to their browsers (staff_push_subscriptions). Who
 * gets one is decided by alert type: a payment to confirm goes only to the
 * roles that can confirm it, an expiry digest to everyone at the desk and on
 * the floor. Each person can switch any type they get off for themselves.
 *
 * Like src/notifications.js, everything here runs against the current gym's
 * database: routes inherit it from resolveTenant, the sweep from server.js.
 */

const ALL_ROLES = ['admin', 'manager', 'staff', 'trainer'];
const DESK_ROLES = ['admin', 'manager', 'staff'];

/** The morning digests go out once the gym's day has started, not at 00:05. */
const DIGEST_AFTER_MINUTES = 8 * 60;
/** "Ending soon" looks this many days ahead — enough time to call them. */
export const EXPIRING_DAYS = 3;
/** Names spelled out in a digest before it says "and N more". */
const DIGEST_NAMES = 3;

const capitalise = (text) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * Every alert type this gym's staff can get, with who may get it. Depends on
 * the vertical: a coaching institute bills by installment, not by membership,
 * and a library has no WhatsApp front desk booking trials.
 */
export function alertCatalog() {
  const type = getBusinessType();
  const coaching = type === 'coaching';
  const library = type === 'library';
  const plan = say('subscription');
  const member = say('member');
  return [
    {
      key: 'payment_claim',
      label: 'Payments to confirm',
      hint: `A ${member} paid online and is waiting for you to confirm it`,
      roles: MANAGES_BILLING,
    },
    !coaching && {
      key: 'membership_expired',
      label: `Expired ${plan}s`,
      hint: "Each morning: who ran out yesterday and hasn't renewed",
      roles: ALL_ROLES,
    },
    !coaching && {
      key: 'membership_expiring',
      label: `${capitalise(plan)}s ending soon`,
      hint: `Each morning: who ends in ${EXPIRING_DAYS} days and hasn't renewed`,
      roles: ALL_ROLES,
    },
    coaching && {
      key: 'fees_overdue',
      label: 'Overdue fees',
      hint: 'Each morning: installments that fell due yesterday and are still unpaid',
      roles: MANAGES_BILLING,
    },
    !library && {
      key: 'trial_booked',
      label: coaching ? 'Demo classes booked' : 'Free trials booked',
      hint: 'When the WhatsApp assistant books one',
      roles: ALL_ROLES,
    },
    !library && {
      key: 'chat_handoff',
      label: 'WhatsApp chats needing a reply',
      hint: 'When the WhatsApp assistant hands a chat over to the team',
      roles: DESK_ROLES,
    },
  ].filter(Boolean);
}

const kindFor = (key) => alertCatalog().find((kind) => kind.key === key) ?? null;

/** The alert types `role` can get here — what that person's settings list. */
export const kindsForRole = (role) => alertCatalog().filter((kind) => kind.roles.includes(role));

/* ---------------------------------------------------------- preferences */

/** `{ payment_claim: true, … }` for every type this person can get. */
export function preferencesForUser(user) {
  const saved = new Map(
    all('SELECT kind, enabled FROM staff_notification_prefs WHERE user_id = ?', [user.id]).map((row) => [row.kind, row.enabled]),
  );
  return Object.fromEntries(kindsForRole(user.role).map((kind) => [kind.key, saved.has(kind.key) ? Boolean(saved.get(kind.key)) : true]));
}

/** Saves the switches in `patch` that this person's role can actually get. */
export function savePreferencesForUser(user, patch) {
  const allowed = new Set(kindsForRole(user.role).map((kind) => kind.key));
  tx(() => {
    for (const [key, value] of Object.entries(patch ?? {})) {
      if (!allowed.has(key) || typeof value !== 'boolean') continue;
      run(
        `INSERT INTO staff_notification_prefs (user_id, kind, enabled) VALUES (?, ?, ?)
         ON CONFLICT (user_id, kind) DO UPDATE SET enabled = excluded.enabled, updated_at = datetime('now')`,
        [user.id, key, value ? 1 : 0],
      );
    }
  });
  return preferencesForUser(user);
}

/* -------------------------------------------------------------- devices */

const MAX_DEVICES_PER_USER = 10;

/** Stores (or moves onto this person) one browser's push subscription. */
export function saveStaffSubscription(userId, { endpoint, p256dh, auth, platform, userAgent, pathPrefix }) {
  run(
    `INSERT INTO staff_push_subscriptions (user_id, endpoint, p256dh, auth, platform, user_agent, path_prefix)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET
       user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
       platform = excluded.platform, user_agent = excluded.user_agent, path_prefix = excluded.path_prefix,
       failure_count = 0, last_error = NULL, updated_at = datetime('now')`,
    [userId, endpoint, p256dh, auth, platform, userAgent, pathPrefix],
  );
  run(
    `DELETE FROM staff_push_subscriptions WHERE user_id = ? AND id NOT IN (
       SELECT id FROM staff_push_subscriptions WHERE user_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?
     )`,
    [userId, userId, MAX_DEVICES_PER_USER],
  );
  return get('SELECT id, platform, created_at, updated_at FROM staff_push_subscriptions WHERE endpoint = ?', [endpoint]);
}

/**
 * Stops alerts to one browser, whichever member of staff it was registered to.
 * The endpoint is an unguessable URL only that browser holds, so presenting it
 * proves it is this browser — which is what lets the next person on a shared
 * desk PC stop the previous person's alerts arriving on it.
 */
export function removeStaffSubscription(endpoint) {
  return run('DELETE FROM staff_push_subscriptions WHERE endpoint = ?', [endpoint]).changes;
}

export const staffDeviceCount = (userId) =>
  get('SELECT COUNT(*) AS n FROM staff_push_subscriptions WHERE user_id = ?', [userId]).n;

/* ---------------------------------------------------------------- inbox */

export const staffUnreadCount = (userId) =>
  get('SELECT COUNT(*) AS n FROM staff_notifications WHERE user_id = ? AND read_at IS NULL', [userId]).n;

export function listStaffNotifications(userId, { limit = 30 } = {}) {
  return all(
    `SELECT id, kind, title, body, link, created_at, read_at FROM staff_notifications
     WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
    [userId, limit],
  );
}

export function markStaffRead(userId, ids) {
  if (Array.isArray(ids) && ids.length) {
    return run(
      `UPDATE staff_notifications SET read_at = datetime('now')
       WHERE user_id = ? AND read_at IS NULL AND id IN (${ids.map(() => '?').join(', ')})`,
      [userId, ...ids],
    ).changes;
  }
  return run("UPDATE staff_notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL", [userId]).changes;
}

/* ------------------------------------------------------------- delivery */

/** Where a tapped push opens: the staff app's screen, at this device's address for the gym. */
const staffUrl = (prefix, link) => `${prefix || ''}/#${link || '/dashboard'}`;

/**
 * Writes one alert to `userIds`' inboxes and pushes it to their devices.
 * Rows are written synchronously; the returned promise settles once every
 * device has been tried.
 */
function deliver(userIds, { kind, title, body = '', link = null, dedupeKey = null, ttl = 6 * 60 * 60, urgency = 'normal' }) {
  const inserted = tx(() =>
    userIds
      .map((userId) => {
        const info = run(
          `INSERT OR IGNORE INTO staff_notifications (user_id, kind, title, body, link, dedupe_key)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [userId, kind, title, body, link, dedupeKey],
        );
        return info.changes ? { userId, id: Number(info.lastInsertRowid) } : null;
      })
      .filter(Boolean),
  );
  if (!inserted.length) return Promise.resolve({ recipients: 0, devices: 0, delivered: 0, failed: 0 });

  const idFor = new Map(inserted.map((row) => [row.userId, row.id]));
  const subs = all(
    `SELECT * FROM staff_push_subscriptions WHERE user_id IN (${inserted.map(() => '?').join(', ')})`,
    inserted.map((row) => row.userId),
  );
  if (!subs.length) return Promise.resolve({ recipients: inserted.length, devices: 0, delivered: 0, failed: 0 });

  const unread = new Map(inserted.map((row) => [row.userId, staffUnreadCount(row.userId)]));
  const brand = branding();
  return track(
    (async () => {
      const result = await pushToSubscriptions(
        subs,
        (sub) => ({
          v: 1,
          id: idFor.get(sub.user_id),
          category: `staff:${kind}`,
          // Staff often have more than one gym; the name says which one.
          title: `${brand.name}: ${title}`,
          body,
          url: staffUrl(sub.path_prefix, link),
          icon: brand.icon,
          badge: brand.badge,
          tag: dedupeKey ? `staff-${dedupeKey}` : `staff-${kind}-${idFor.get(sub.user_id)}`,
          urgent: 0,
          sound: 1,
          vibrate: 1,
          unread: unread.get(sub.user_id),
          ts: Date.now(),
        }),
        () => ({ ttl, urgency }),
        { table: 'staff_push_subscriptions' },
      );
      run(
        `UPDATE staff_notifications SET pushed = 1 WHERE id IN (${inserted.map(() => '?').join(', ')})
           AND user_id IN (SELECT user_id FROM staff_push_subscriptions WHERE last_success_at IS NOT NULL)`,
        inserted.map((row) => row.id),
      );
      return { recipients: inserted.length, devices: subs.length, ...result };
    })(),
  );
}

/** Active staff whose role gets `kind` and who have not switched it off. */
function recipientsFor(kind) {
  const def = kindFor(kind);
  if (!def) return [];
  return all(
    `SELECT u.id FROM users u
     LEFT JOIN staff_notification_prefs p ON p.user_id = u.id AND p.kind = ?
     WHERE u.active = 1 AND u.role IN (${def.roles.map(() => '?').join(', ')}) AND COALESCE(p.enabled, 1) = 1`,
    [kind, ...def.roles],
  ).map((row) => row.id);
}

/**
 * Alerts every member of staff who gets `kind`.
 *
 * @param {string} kind One of alertCatalog()'s keys; anything this vertical
 *   does not offer is dropped silently.
 * @param {object} alert
 * @param {string} alert.title
 * @param {string} [alert.body]
 * @param {string} [alert.link] Staff app path to open, e.g. '/billing/confirm'.
 * @param {string} [alert.dedupeKey] Once per person per key, ever.
 * @param {number} [alert.exceptUserId] Someone who did it themselves and need not hear about it.
 */
export function notifyStaff(kind, { exceptUserId = null, ...alert }) {
  const userIds = recipientsFor(kind).filter((id) => id !== exceptUserId);
  if (!userIds.length) return Promise.resolve({ recipients: 0, devices: 0, delivered: 0, failed: 0 });
  return deliver(userIds, { kind, ...alert });
}

/** "Notifications are on" to one person's devices, whatever they switched off. */
export function sendStaffTest(userId) {
  return deliver([userId], {
    kind: 'test',
    title: 'Notifications are on ✅',
    body: 'This is how payment, expiry and front-desk alerts will look on this device.',
    link: '/dashboard',
    ttl: 5 * 60,
    urgency: 'high',
  });
}

/** The same, but never throws or rejects: alerts must not break what triggered them. */
export function notifyStaffQuietly(kind, alert) {
  try {
    notifyStaff(kind, alert).catch((err) => console.error(`[staff-alerts] ${kind} delivery failed:`, err.message));
  } catch (err) {
    console.error(`[staff-alerts] ${kind} failed:`, err.message);
  }
}

/* --------------------------------------------------------- the triggers */

const money = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const fullName = (row) => [row.first_name, row.last_name].filter(Boolean).join(' ').trim() || 'Someone';

/** A member said "I've paid" for an online payment (src/onlinePayments.js). */
export function alertPaymentClaim(request) {
  notifyStaffQuietly('payment_claim', {
    title: `${money(request.amount)} to confirm`,
    body: `${fullName(request)}${request.member_code ? ` (${request.member_code})` : ''} paid for ${String(request.title || 'a payment').toLowerCase()}. Ref ${request.ref_code}${request.utr ? ` · UTR ${request.utr}` : ''}. Check your UPI app, then confirm it.`,
    link: getBusinessType() === 'coaching' ? '/fees/confirm' : '/billing/confirm',
    dedupeKey: `payreq:${request.id}`,
    urgency: 'high',
    ttl: 24 * 60 * 60,
  });
}

/** The WhatsApp assistant booked a free trial (gym) or a demo class (coaching). */
export function alertTrialBooked({ id, name, when, coaching = false }) {
  notifyStaffQuietly('trial_booked', {
    title: coaching ? `Demo class booked: ${name}` : `Free trial booked: ${name}`,
    body: `${when} — booked by the WhatsApp assistant.`,
    link: coaching ? '/admissions' : '/trials',
    dedupeKey: `${coaching ? 'demo' : 'trial'}:${id}:${when}`,
    ttl: 24 * 60 * 60,
  });
}

/**
 * The WhatsApp assistant raised "needs a reply from the team" on a chat. Only
 * called when the flag goes up (see flagForStaff in waChat.js), so a chat that
 * stays flagged does not alert again on every message.
 */
export function alertChatHandoff({ who, reason }) {
  notifyStaffQuietly('chat_handoff', {
    title: `WhatsApp: ${who} needs a reply`,
    body: reason || 'The assistant handed this chat over to the team.',
    link: getBusinessType() === 'coaching' ? '/admissions' : '/trials',
    urgency: 'high',
    ttl: 12 * 60 * 60,
  });
}

/* ------------------------------------------------------- morning digest */

function namesLine(names) {
  const shown = names.slice(0, DIGEST_NAMES);
  const more = names.length - shown.length;
  if (more > 0) return `${shown.join(', ')} and ${more} more`;
  if (shown.length <= 1) return shown.join('');
  return `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`;
}

/** No later membership already sold: someone who renewed early is not news. */
const NOT_RENEWED = `NOT EXISTS (
  SELECT 1 FROM subscriptions r
  WHERE r.member_id = s.member_id AND r.id != s.id AND r.status IN ('active', 'frozen') AND r.end_date > s.end_date
)`;

function expiryDigests(date) {
  const plan = say('subscription');
  const jobs = [];

  const yesterday = addDays(date, -1);
  const expired = all(
    `SELECT DISTINCT m.id, m.first_name, m.last_name FROM subscriptions s JOIN members m ON m.id = s.member_id
     WHERE s.end_date = ? AND s.status IN ('active', 'expired') AND ${NOT_RENEWED}
     ORDER BY m.first_name, m.last_name`,
    [yesterday],
  );
  if (expired.length) {
    const n = expired.length;
    jobs.push(
      notifyStaff('membership_expired', {
        title: `${n} ${plan}${n === 1 ? '' : 's'} expired yesterday`,
        body: `${namesLine(expired.map(fullName))} — not renewed yet. A call today is the best chance of bringing them back.`,
        link: '/billing/expired',
        dedupeKey: `expired:${date}`,
      }),
    );
  }

  const ahead = addDays(date, EXPIRING_DAYS);
  const expiring = all(
    `SELECT DISTINCT m.id, m.first_name, m.last_name FROM subscriptions s JOIN members m ON m.id = s.member_id
     WHERE s.end_date = ? AND s.status = 'active' AND ${NOT_RENEWED}
     ORDER BY m.first_name, m.last_name`,
    [ahead],
  );
  if (expiring.length) {
    const n = expiring.length;
    jobs.push(
      notifyStaff('membership_expiring', {
        title: `${n} ${plan}${n === 1 ? ' ends' : 's end'} in ${EXPIRING_DAYS} days`,
        body: `${namesLine(expiring.map(fullName))} — ending on ${ahead}. Remind them to renew.`,
        link: '/billing/expiring',
        dedupeKey: `expiring:${date}`,
      }),
    );
  }
  return jobs;
}

function overdueFeeDigest(date) {
  const yesterday = addDays(date, -1);
  const overdue = all(
    `SELECT m.first_name, m.last_name,
            i.amount_due - COALESCE((SELECT SUM(fi.amount) FROM fee_payment_items fi WHERE fi.installment_id = i.id), 0) AS balance
     FROM student_fee_installments i
     JOIN student_fee_plans p ON p.id = i.plan_id
     JOIN members m ON m.id = p.member_id
     WHERE i.due_date = ? AND p.status = 'active'
     ORDER BY m.first_name, m.last_name`,
    [yesterday],
  ).filter((row) => row.balance > 0.005);
  if (!overdue.length) return [];
  const total = overdue.reduce((sum, row) => sum + row.balance, 0);
  const n = overdue.length;
  return [
    notifyStaff('fees_overdue', {
      title: `${n} installment${n === 1 ? '' : 's'} overdue · ${money(total)}`,
      body: `${namesLine([...new Set(overdue.map(fullName))])} — due yesterday and still unpaid.`,
      link: '/fees',
      dedupeKey: `fees-overdue:${date}`,
    }),
  ];
}

/**
 * The once-a-day digests for the current gym. Safe to run every few minutes:
 * each carries a per-day dedupe key, and nothing goes out before
 * DIGEST_AFTER_MINUTES on the gym's own clock.
 */
export async function sweepStaffAlerts({ now = new Date() } = {}) {
  const clock = gymClock(now);
  run("DELETE FROM staff_notifications WHERE created_at < datetime('now', '-60 days')");
  if (clock.minutes < DIGEST_AFTER_MINUTES) return { sent: 0 };

  const jobs = getBusinessType() === 'coaching' ? overdueFeeDigest(clock.date) : expiryDigests(clock.date);
  const results = await Promise.all(jobs);
  return { sent: results.reduce((sum, r) => sum + r.recipients, 0) };
}
