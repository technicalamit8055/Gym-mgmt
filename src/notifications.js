import crypto from 'node:crypto';
import { gymOffsetMinutes } from './clock.js';
import { config, DEFAULT_TENANT_SLUG } from './config.js';
import { all, get, run, tenantStorage, tx } from './db.js';
import { fitnessAccessFor } from './fitness.js';
import { effectiveDietTargets } from './nutrition.js';
import { addDays } from './validate.js';
import { moduleEnabled, say } from './verticals.js';
import { tenantBranding } from './tenants.js';
import { sendPush } from './webPush.js';

/**
 * Member push notifications: who gets what, when, and the record of it.
 *
 * Everything here runs against *the current gym's* database, the same as
 * maintenance.js — the sweep in server.js wraps each call in that gym's
 * tenantStorage context, and the routes inherit it from resolveTenant.
 *
 * Every notification is two things: a row in the member's notification center
 * (member_notifications) and a push to each device they enabled. The row is
 * written first and carries a dedupe key, which is what lets the sweep run
 * every few minutes without ever sending the same 11:00 water reminder twice.
 */

export const NOTIFICATION_CATEGORIES = ['water', 'nutrition', 'workout', 'announcement', 'membership', 'test'];
export const ANNOUNCEMENT_KINDS = ['general', 'closure', 'maintenance', 'holiday', 'event'];
export const PREFERENCE_KEYS = ['water', 'nutrition', 'workout', 'announcements', 'membership', 'sound', 'vibrate'];

/** Which preference switch silences which category. `test` has none: a member
 * pressing "Send test" wants to see it whatever else they turned off. */
const CATEGORY_PREFERENCE = {
  water: 'water',
  nutrition: 'nutrition',
  workout: 'workout',
  announcement: 'announcements',
  membership: 'membership',
  test: null,
};

/** A dead subscription that keeps failing for reasons other than 404/410
 * (a key mismatch after the VAPID keys were replaced, say) is dropped after
 * this many consecutive failures rather than retried forever. */
const MAX_CONSECUTIVE_FAILURES = 5;

/** Parallel sends per batch: enough to get a gym-wide announcement out in
 * seconds, few enough not to look like abuse to a push service. */
const SEND_CONCURRENCY = 8;

/** How long after a scheduled time a reminder may still go out. A sweep
 * delayed by a restart still catches its slot; a 19:00 reminder is never sent
 * at 21:30. */
const SLOT_WINDOW_MINUTES = 60;

/** Hydration is measured against a waking day, not 24 hours: at 11:00 a
 * member is a quarter of the way through, not almost half. */
const DAY_START_MINUTES = 7 * 60;
const DAY_END_MINUTES = 22 * 60;

/** A session left running this long was abandoned, not paused — its row is
 * dropped quietly instead of producing a confusing "still training?" nudge. */
const ABANDONED_WORKOUT_HOURS = 12;

const DEFAULT_SETTINGS = {
  id: 1,
  water_enabled: 1,
  water_times: '11:00,15:00,19:00',
  nutrition_enabled: 1,
  lunch_time: '14:00',
  dinner_time: '21:00',
  workout_enabled: 1,
  workout_nudge_minutes: 120,
  membership_enabled: 1,
  membership_days_before: 3,
};

const DEFAULT_PREFERENCES = {
  water: 1,
  nutrition: 1,
  workout: 1,
  announcements: 1,
  membership: 1,
  sound: 1,
  vibrate: 1,
};

/* ------------------------------------------------------------- settings */

export function pushSettings() {
  return get('SELECT * FROM push_settings WHERE id = 1') ?? { ...DEFAULT_SETTINGS };
}

export function savePushSettings(patch) {
  run('INSERT OR IGNORE INTO push_settings (id) VALUES (1)');
  const fields = Object.keys(patch).filter((key) => key in DEFAULT_SETTINGS && key !== 'id');
  if (fields.length) {
    run(
      `UPDATE push_settings SET ${fields.map((f) => `${f} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = 1`,
      fields.map((f) => patch[f]),
    );
  }
  return pushSettings();
}

/** "11:00, 15:00,19:00" -> ['11:00', '15:00', '19:00'], sorted, deduplicated,
 * or null if any entry is not an HH:MM time. */
export function parseTimeList(value) {
  const times = String(value || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  if (times.some((t) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(t))) return null;
  return [...new Set(times)].sort();
}

export function preferencesFor(memberId) {
  const row = get('SELECT * FROM notification_preferences WHERE member_id = ?', [memberId]);
  const prefs = { ...DEFAULT_PREFERENCES };
  if (row) for (const key of PREFERENCE_KEYS) prefs[key] = row[key];
  return prefs;
}

export function savePreferences(memberId, patch) {
  const next = { ...preferencesFor(memberId) };
  for (const key of PREFERENCE_KEYS) {
    if (patch[key] !== undefined && patch[key] !== null) next[key] = patch[key] ? 1 : 0;
  }
  run(
    `INSERT INTO notification_preferences (member_id, ${PREFERENCE_KEYS.join(', ')}, updated_at)
     VALUES (?, ${PREFERENCE_KEYS.map(() => '?').join(', ')}, datetime('now'))
     ON CONFLICT(member_id) DO UPDATE SET ${PREFERENCE_KEYS.map((k) => `${k} = excluded.${k}`).join(', ')},
       updated_at = excluded.updated_at`,
    [memberId, ...PREFERENCE_KEYS.map((k) => next[k])],
  );
  return next;
}

/* -------------------------------------------------------- subscriptions */

/** Most phones register once; this only stops a misbehaving client from
 * growing one member's device list without bound. */
const MAX_DEVICES_PER_MEMBER = 10;

/**
 * Stores (or moves) a device's subscription onto `memberId`.
 *
 * Upserted on the endpoint: re-subscribing the same browser refreshes its
 * keys, and a shared tablet that a second member signs into is handed over to
 * them — the previous member stops getting this device's notifications, which
 * is exactly what signing out and in again should mean.
 */
export function saveSubscription(memberId, { endpoint, p256dh, auth, platform, userAgent, pathPrefix }) {
  run(
    `INSERT INTO push_subscriptions (member_id, endpoint, p256dh, auth, platform, user_agent, path_prefix)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET
       member_id = excluded.member_id, p256dh = excluded.p256dh, auth = excluded.auth,
       platform = excluded.platform, user_agent = excluded.user_agent, path_prefix = excluded.path_prefix,
       failure_count = 0, last_error = NULL, updated_at = datetime('now')`,
    [memberId, endpoint, p256dh, auth, platform, userAgent, pathPrefix],
  );
  run(
    `DELETE FROM push_subscriptions WHERE member_id = ? AND id NOT IN (
       SELECT id FROM push_subscriptions WHERE member_id = ? ORDER BY updated_at DESC, id DESC LIMIT ?
     )`,
    [memberId, memberId, MAX_DEVICES_PER_MEMBER],
  );
  return get('SELECT id, platform, created_at, updated_at FROM push_subscriptions WHERE endpoint = ?', [endpoint]);
}

export function removeSubscription(memberId, endpoint) {
  return run('DELETE FROM push_subscriptions WHERE member_id = ? AND endpoint = ?', [memberId, endpoint]).changes;
}

export function deviceCount(memberId) {
  return get('SELECT COUNT(*) AS n FROM push_subscriptions WHERE member_id = ?', [memberId]).n;
}

/* ---------------------------------------------------------------- inbox */

/**
 * An announcement's picture, as an origin-relative path without the /g/<slug>
 * prefix — the browser adds its own (api.js's pathPrefix), and a push payload
 * adds the subscribing device's. The token in it is the only thing standing
 * between the bytes and anyone, see getAnnouncementImage().
 */
const ANNOUNCEMENT_IMAGE_URL_SQL =
  "CASE WHEN a.image_bytes IS NOT NULL THEN '/api/announcement-images/' || a.id || '?t=' || a.image_token END";

/** Every column but the image BLOB, which no listing should ever drag along. */
const ANNOUNCEMENT_COLUMNS = `a.id, a.title, a.body, a.kind, a.urgent, a.created_by, a.recipients, a.devices,
  a.delivered, a.failed, a.created_at, ${ANNOUNCEMENT_IMAGE_URL_SQL} AS image_url`;

export function unreadCount(memberId) {
  return get('SELECT COUNT(*) AS n FROM member_notifications WHERE member_id = ? AND read_at IS NULL', [memberId]).n;
}

export function listNotifications(memberId, { limit = 30 } = {}) {
  return all(
    `SELECT n.id, n.category, n.title, n.body, n.screen, n.created_at, n.read_at, a.kind AS announcement_kind, a.urgent,
            ${ANNOUNCEMENT_IMAGE_URL_SQL} AS image_url
     FROM member_notifications n
     LEFT JOIN push_announcements a ON a.id = n.announcement_id
     WHERE n.member_id = ?
     ORDER BY n.created_at DESC, n.id DESC
     LIMIT ?`,
    [memberId, limit],
  );
}

export function markRead(memberId, ids) {
  if (Array.isArray(ids) && ids.length) {
    return run(
      `UPDATE member_notifications SET read_at = datetime('now')
       WHERE member_id = ? AND read_at IS NULL AND id IN (${ids.map(() => '?').join(', ')})`,
      [memberId, ...ids],
    ).changes;
  }
  return run("UPDATE member_notifications SET read_at = datetime('now') WHERE member_id = ? AND read_at IS NULL", [
    memberId,
  ]).changes;
}

/** Keeps the notification center to a sensible length; called from the
 * sweep, so nothing on a request path pays for it. */
function pruneOldNotifications() {
  run("DELETE FROM member_notifications WHERE created_at < datetime('now', '-90 days')");
}

/* -------------------------------------------------------------- delivery */

/** Sends still in flight, so tests (and a graceful shutdown) can wait for a
 * broadcast that its route answered before it finished. */
const inflight = new Set();

function track(promise) {
  inflight.add(promise);
  promise.finally(() => inflight.delete(promise)).catch(() => {});
  return promise;
}

export async function settlePushDeliveries() {
  while (inflight.size) await Promise.allSettled([...inflight]);
}

/** Runs `worker` over `items` with at most `limit` running at once. */
async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(lanes);
  return results;
}

/**
 * The deep link a tapped notification opens, in the address shape this
 * device used for the gym: `/g/acme/#/portal/diet` for a gym addressed by
 * path, `/#/portal/diet` on its own subdomain or domain.
 */
const portalUrl = (prefix, screen) => `${prefix || ''}/#/portal${screen ? `/${screen}` : ''}`;

/**
 * Pushes one message to a set of subscriptions and books the outcome against
 * each: success resets its failure streak, "gone" deletes it, anything else
 * counts towards MAX_CONSECUTIVE_FAILURES.
 *
 * @returns {Promise<{delivered: number, failed: number}>}
 */
async function pushToSubscriptions(subscriptions, buildPayload, options) {
  const outcomes = await pool(subscriptions, SEND_CONCURRENCY, async (sub) => {
    const result = await sendPush(sub, buildPayload(sub), options(sub));
    if (result.ok) {
      run("UPDATE push_subscriptions SET failure_count = 0, last_error = NULL, last_success_at = datetime('now') WHERE id = ?", [
        sub.id,
      ]);
    } else if (result.gone) {
      run('DELETE FROM push_subscriptions WHERE id = ?', [sub.id]);
    } else {
      run('UPDATE push_subscriptions SET failure_count = failure_count + 1, last_error = ? WHERE id = ?', [
        result.error,
        sub.id,
      ]);
      run('DELETE FROM push_subscriptions WHERE id = ? AND failure_count >= ?', [sub.id, MAX_CONSECUTIVE_FAILURES]);
    }
    return result.ok;
  });
  const delivered = outcomes.filter(Boolean).length;
  return { delivered, failed: outcomes.length - delivered };
}

/**
 * How a push should look for *this* gym: its own name, and its own uploaded
 * logo as the notification's large icon — the same image its installed app
 * uses (routes/pwa.js) — falling back to the GymBook/SeatBook mark.
 *
 * The URLs are origin-relative and prefix-free on purpose: the tenant-icon
 * routes take the slug from the path, so they answer on the root domain, a
 * /g/<slug> address, a subdomain or a custom domain alike.
 */
function branding() {
  const library = moduleEnabled('seats');
  const slug = tenantStorage.getStore()?.slug;
  let tenant = null;
  if (slug && slug !== DEFAULT_TENANT_SLUG) {
    try {
      tenant = tenantBranding(slug);
    } catch {
      // No registry (single-gym install): the defaults below are right.
    }
  }
  const version = tenant?.logo_version || 1;
  let icon = library ? '/icons/library/icon-192.png' : '/icons/icon-192.png';
  if (tenant?.has_icon) icon = `/api/platform/tenant-icon/${slug}?v=${version}`;
  else if (tenant?.has_logo) icon = `/api/platform/tenant-logo/${slug}?v=${version}`;
  return {
    name: tenant?.gym_name || tenant?.display_name || config.gymName || (library ? 'SeatBook' : 'GymBook'),
    icon,
    // Android's status-bar icon: a single-colour silhouette (npm run icons:gen).
    badge: library ? '/icons/library/badge-96.png' : '/icons/badge-96.png',
  };
}

/**
 * Who an announcement is from has to be in its title: until a member installs
 * the app, Android heads every notification "Chrome · <domain>", and a member
 * with two gyms on their phone needs to know which one is closed today.
 */
const announcementTitle = (gymName, title) => `${gymName}: ${title}`;

/** What sw.js's push handler reads. Kept small — push services cap payloads
 * at about 4 KB, and the body is the only field of any length. */
function payloadFor(notification, prefs, { unread, sub, brand, urgent = false }) {
  return {
    v: 1,
    id: notification.id,
    category: notification.category,
    title: notification.title,
    body: notification.body,
    url: portalUrl(sub.path_prefix, notification.screen),
    // Android shows this expanded beneath the text; iOS ignores it.
    image: notification.image ? `${sub.path_prefix || ''}${notification.image}` : undefined,
    icon: brand.icon,
    badge: brand.badge,
    tag: notification.tag,
    urgent: urgent ? 1 : 0,
    sound: prefs.sound ? 1 : 0,
    vibrate: prefs.vibrate ? 1 : 0,
    // The member's unread count, for the home-screen icon badge.
    unread,
    ts: Date.now(),
  };
}

/**
 * Records a notification for one member and pushes it to their devices.
 *
 * @param {number} memberId
 * @param {object} n
 * @param {string} n.category One of NOTIFICATION_CATEGORIES.
 * @param {string} n.title
 * @param {string} n.body
 * @param {string} [n.screen] Portal screen to open: 'diet', 'workout', 'pay',
 *   'notifications', or omitted for Home.
 * @param {string} [n.dedupeKey] Once per member per key, ever.
 * @param {string} [n.tag] Replaces an older notification on the lock screen
 *   with the same tag instead of stacking a second one.
 * @param {number} [n.ttl] Seconds a push service may hold it for an offline
 *   phone; past that the reminder is stale and better dropped.
 * @returns {Promise<{skipped?: string, id?: number, devices: number, delivered: number, failed: number}>}
 */
export function notifyMember(memberId, { category, title, body, screen, dedupeKey, tag, ttl = 2 * 60 * 60, urgency = 'normal' }) {
  const prefs = preferencesFor(memberId);
  const prefKey = CATEGORY_PREFERENCE[category];
  if (prefKey && !prefs[prefKey]) return Promise.resolve({ skipped: 'preference', devices: 0, delivered: 0, failed: 0 });

  const inserted = run(
    `INSERT OR IGNORE INTO member_notifications (member_id, category, title, body, screen, dedupe_key)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [memberId, category, title, body, screen ?? null, dedupeKey ?? null],
  );
  if (!inserted.changes) return Promise.resolve({ skipped: 'duplicate', devices: 0, delivered: 0, failed: 0 });
  const id = Number(inserted.lastInsertRowid);

  const subs = all('SELECT * FROM push_subscriptions WHERE member_id = ?', [memberId]);
  if (!subs.length) return Promise.resolve({ id, devices: 0, delivered: 0, failed: 0 });

  const unread = unreadCount(memberId);
  const brand = branding();
  const notification = { id, category, title, body, screen, tag: tag || `${category}-${id}` };
  return track(
    (async () => {
      const result = await pushToSubscriptions(
        subs,
        (sub) => payloadFor(notification, prefs, { unread, sub, brand }),
        () => ({ ttl, urgency, topic: tag }),
      );
      if (result.delivered) run('UPDATE member_notifications SET pushed = 1 WHERE id = ?', [id]);
      return { id, devices: subs.length, ...result };
    })(),
  );
}

/* --------------------------------------------------------- announcements */

/**
 * Broadcasts a gym announcement to every current member.
 *
 * Every active or frozen member gets it in their notification center, app or
 * no app — it is still news when they next open it. The push goes to those
 * with devices registered and announcements switched on; an `urgent` one
 * (a closure, a burst pipe) goes to every device regardless of that switch,
 * which is what the switch's own label promises.
 *
 * The rows are written synchronously; the pushes are not. The returned
 * `delivery` promise resolves once every device has been tried, updating the
 * announcement's delivered/failed counts — the route answers before that.
 *
 * @param {{mime: string, bytes: Buffer}} [opts.image] Optional picture,
 *   already validated (see parseUploadDataUrl in photo.js).
 */
export function createAnnouncement({ title, body, kind = 'general', urgent = false, userId = null, image = null }) {
  const announcement = tx(() => {
    const { lastInsertRowid } = run(
      `INSERT INTO push_announcements (title, body, kind, urgent, created_by, image_mime, image_bytes, image_token)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        title,
        body,
        kind,
        urgent ? 1 : 0,
        userId,
        image?.mime ?? null,
        image?.bytes ?? null,
        image ? crypto.randomBytes(16).toString('hex') : null,
      ],
    );
    const id = Number(lastInsertRowid);
    const recipients = run(
      `INSERT INTO member_notifications (member_id, category, title, body, screen, announcement_id, dedupe_key)
       SELECT id, 'announcement', ?, ?, 'notifications', ?, ?
       FROM members WHERE status IN ('active', 'frozen')`,
      [title, body, id, `announcement:${id}`],
    ).changes;
    run('UPDATE push_announcements SET recipients = ? WHERE id = ?', [recipients, id]);
    return get(`SELECT ${ANNOUNCEMENT_COLUMNS} FROM push_announcements a WHERE a.id = ?`, [id]);
  });

  const targets = all(
    `SELECT ps.*, n.id AS notification_id,
            COALESCE(np.sound, 1) AS pref_sound, COALESCE(np.vibrate, 1) AS pref_vibrate,
            (SELECT COUNT(*) FROM member_notifications u WHERE u.member_id = ps.member_id AND u.read_at IS NULL) AS unread
     FROM push_subscriptions ps
     JOIN member_notifications n ON n.member_id = ps.member_id AND n.announcement_id = ?
     LEFT JOIN notification_preferences np ON np.member_id = ps.member_id
     WHERE ? = 1 OR COALESCE(np.announcements, 1) = 1`,
    [announcement.id, announcement.urgent],
  );
  run('UPDATE push_announcements SET devices = ? WHERE id = ?', [targets.length, announcement.id]);

  const brand = branding();
  const pushTitle = announcementTitle(brand.name, title);
  const delivery = track(
    (async () => {
      const result = await pushToSubscriptions(
        targets,
        (sub) =>
          payloadFor(
            {
              id: sub.notification_id,
              category: 'announcement',
              title: pushTitle,
              body,
              screen: 'notifications',
              tag: `announcement-${announcement.id}`,
              image: announcement.image_url,
            },
            { sound: sub.pref_sound, vibrate: sub.pref_vibrate },
            { unread: sub.unread, sub, brand, urgent: announcement.urgent },
          ),
        () => ({
          // A closure notice is still worth reading a day late; an offline
          // phone should get it when it comes back.
          ttl: 24 * 60 * 60,
          urgency: announcement.urgent ? 'high' : 'normal',
          topic: `announcement-${announcement.id}`,
        }),
      );
      run('UPDATE push_announcements SET delivered = ?, failed = ? WHERE id = ?', [
        result.delivered,
        result.failed,
        announcement.id,
      ]);
      run(
        `UPDATE member_notifications SET pushed = 1
         WHERE announcement_id = ? AND member_id IN (SELECT member_id FROM push_subscriptions WHERE last_success_at IS NOT NULL)`,
        [announcement.id],
      );
      return result;
    })(),
  );

  return { announcement: { ...announcement, devices: targets.length }, delivery };
}

export function listAnnouncements({ limit = 20 } = {}) {
  return all(
    `SELECT ${ANNOUNCEMENT_COLUMNS}, u.name AS created_by_name,
            (SELECT COUNT(*) FROM member_notifications n WHERE n.announcement_id = a.id AND n.read_at IS NOT NULL) AS read_count
     FROM push_announcements a LEFT JOIN users u ON u.id = a.created_by
     ORDER BY a.created_at DESC, a.id DESC LIMIT ?`,
    [limit],
  );
}

/**
 * The bytes behind an announcement's image URL, or null.
 *
 * Unauthenticated by necessity — Android's notification system fetches the
 * picture itself, with no session — so the URL's random token is the
 * credential, compared in constant time. It only ever unlocks a picture the
 * gym already broadcast to all its members.
 */
export function getAnnouncementImage(id, token) {
  const row = get('SELECT image_mime, image_bytes, image_token FROM push_announcements WHERE id = ?', [id]);
  if (!row?.image_bytes || !row.image_token || typeof token !== 'string') return null;
  const expected = Buffer.from(row.image_token);
  const given = Buffer.from(token);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  return { mime: row.image_mime, bytes: Buffer.from(row.image_bytes) };
}

/** Headline numbers for the staff page: how far a broadcast would reach. */
export function pushReach() {
  return get(
    `SELECT
       (SELECT COUNT(DISTINCT member_id) FROM push_subscriptions) AS members,
       (SELECT COUNT(*) FROM push_subscriptions) AS devices,
       (SELECT COUNT(*) FROM push_subscriptions WHERE platform = 'ios') AS ios,
       (SELECT COUNT(*) FROM push_subscriptions WHERE platform = 'android') AS android,
       (SELECT COUNT(*) FROM members WHERE status IN ('active', 'frozen')) AS current_members`,
  );
}

/* ------------------------------------------------------- active workouts */

export function recordActiveWorkout(memberId, { workoutName, startedAt }) {
  run(
    `INSERT INTO active_workouts (member_id, workout_name, started_at) VALUES (?, ?, ?)
     ON CONFLICT(member_id) DO UPDATE SET
       workout_name = excluded.workout_name,
       -- A new start time is a new session and may be nudged afresh; a
       -- heartbeat for the same session must not re-arm the nudge.
       nudged_at = CASE WHEN active_workouts.started_at = excluded.started_at THEN active_workouts.nudged_at ELSE NULL END,
       started_at = excluded.started_at,
       updated_at = datetime('now')`,
    [memberId, workoutName, startedAt],
  );
}

export function clearActiveWorkout(memberId) {
  run('DELETE FROM active_workouts WHERE member_id = ?', [memberId]);
}

/* ------------------------------------------------------------------ sweep */

const toMinutes = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/** The gym's wall clock at `now`: its calendar date and minutes past midnight. */
function gymClock(now) {
  const local = new Date(now.getTime() + gymOffsetMinutes() * 60_000);
  return {
    date: local.toISOString().slice(0, 10),
    minutes: local.getUTCHours() * 60 + local.getUTCMinutes(),
  };
}

const inSlot = (clock, slot) => {
  const start = toMinutes(slot);
  return clock.minutes >= start && clock.minutes < start + SLOT_WINDOW_MINUTES;
};

/** UTC `YYYY-MM-DD HH:MM:SS`, the shape datetime('now') stores. */
const sqlInstant = (date) => date.toISOString().slice(0, 19).replace('T', ' ');

const litres = (ml) => `${(Math.round(ml / 100) / 10).toLocaleString('en-US')} L`;

/** Members with at least one device and `prefKey` switched on — the habit
 * nudges only ever go to members who installed the app and asked for them,
 * so nobody's notification center fills with reminders they cannot receive. */
function reachableMembers(prefKey) {
  return all(
    `SELECT m.id, m.first_name
     FROM members m
     LEFT JOIN notification_preferences np ON np.member_id = m.id
     WHERE m.status = 'active'
       AND EXISTS (SELECT 1 FROM push_subscriptions ps WHERE ps.member_id = m.id)
       AND COALESCE(np.${prefKey}, 1) = 1`,
  );
}

/** The same goal the Diet tab shows: the trainer's, the member's own, or the default. */
const waterTargetFor = (memberId) => effectiveDietTargets(memberId).targets.target_water_ml;

function hydrationNudges(settings, clock) {
  const slot = (parseTimeList(settings.water_times) ?? []).find((t) => inSlot(clock, t));
  if (!slot) return [];

  const span = DAY_END_MINUTES - DAY_START_MINUTES;
  const fraction = Math.min(1, Math.max(0, (toMinutes(slot) - DAY_START_MINUTES) / span));
  const jobs = [];
  for (const member of reachableMembers('water')) {
    if (!fitnessAccessFor(member.id).has_access) continue;
    const target = waterTargetFor(member.id);
    const drunk =
      get('SELECT water_ml FROM diet_logs WHERE member_id = ? AND log_date = ?', [member.id, clock.date])?.water_ml ?? 0;
    // Rounded to a glass so the nudge reads like advice, not arithmetic.
    const expected = Math.round((target * fraction) / 250) * 250;
    if (drunk >= expected || drunk >= target) continue;

    jobs.push(
      notifyMember(member.id, {
        category: 'water',
        title: 'Time for a glass of water 💧',
        body:
          drunk > 0
            ? `You're at ${litres(drunk)} of your ${litres(target)} goal — aim for about ${litres(expected)} by now. Tap to log a glass.`
            : `Nothing logged yet today. Your goal is ${litres(target)} — start with a glass now and tap to log it.`,
        screen: 'diet',
        dedupeKey: `water:${clock.date}:${slot}`,
        tag: 'water-reminder',
        // Worthless once the next slot comes round.
        ttl: 90 * 60,
      }),
    );
  }
  return jobs;
}

function mealNudges(settings, clock) {
  const meals = [
    { type: 'lunch', time: settings.lunch_time, label: 'lunch' },
    { type: 'dinner', time: settings.dinner_time, label: 'dinner' },
  ].filter((meal) => parseTimeList(meal.time)?.length && inSlot(clock, meal.time));
  if (!meals.length) return [];

  const jobs = [];
  for (const member of reachableMembers('nutrition')) {
    if (!fitnessAccessFor(member.id).has_access) continue;
    for (const meal of meals) {
      const day = get(
        `SELECT
           COALESCE(SUM(e.calories), 0) AS calories,
           COALESCE(SUM(CASE WHEN e.meal_type = ? THEN 1 ELSE 0 END), 0) AS logged
         FROM diet_logs l LEFT JOIN diet_log_entries e ON e.diet_log_id = l.id
         WHERE l.member_id = ? AND l.log_date = ?`,
        [meal.type, member.id, clock.date],
      );
      if (day?.logged) continue;
      const calories = day?.calories ?? 0;
      jobs.push(
        notifyMember(member.id, {
          category: 'nutrition',
          title: `Logged your ${meal.label}? 🍽️`,
          body:
            calories > 0
              ? `You're at ${calories.toLocaleString('en-US')} kcal today. Add your ${meal.label} to keep your calories and macros on track.`
              : `Track your ${meal.label} to keep today's calories and macros on track.`,
          screen: 'diet',
          dedupeKey: `meal:${clock.date}:${meal.type}`,
          tag: 'meal-reminder',
          ttl: 2 * 60 * 60,
        }),
      );
    }
  }
  return jobs;
}

function workoutNudges(settings, now) {
  const abandonedBefore = sqlInstant(new Date(now.getTime() - ABANDONED_WORKOUT_HOURS * 3_600_000));
  run('DELETE FROM active_workouts WHERE started_at < ?', [abandonedBefore]);

  const dueBefore = sqlInstant(new Date(now.getTime() - settings.workout_nudge_minutes * 60_000));
  const running = all(
    `SELECT w.* FROM active_workouts w JOIN members m ON m.id = w.member_id
     WHERE w.nudged_at IS NULL AND w.started_at <= ?`,
    [dueBefore],
  );

  const jobs = [];
  for (const session of running) {
    // Marked first, whatever the outcome: one nudge per session, even if the
    // member has switched these off or has no device to receive it.
    run("UPDATE active_workouts SET nudged_at = datetime('now') WHERE member_id = ?", [session.member_id]);
    const minutes = Math.round((now.getTime() - Date.parse(`${session.started_at.replace(' ', 'T')}Z`)) / 60_000);
    const duration = minutes >= 90 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes} min`;
    jobs.push(
      notifyMember(session.member_id, {
        category: 'workout',
        title: 'Still training? 🏋️',
        body: `"${session.workout_name}" has been running for ${duration}. Finish and save it so your sets, PRs and streak count.`,
        screen: 'workout',
        dedupeKey: `workout:${session.started_at}`,
        tag: 'workout-session',
        ttl: 60 * 60,
      }),
    );
  }
  return jobs;
}

function membershipNudges(settings, clock) {
  const days = settings.membership_days_before;
  const target = addDays(clock.date, days);
  const word = say('subscription');
  const expiring = all(
    `SELECT s.id, s.member_id, s.end_date, p.name AS plan_name
     FROM subscriptions s
     JOIN plans p ON p.id = s.plan_id
     JOIN members m ON m.id = s.member_id
     WHERE s.status = 'active' AND s.end_date IN (?, ?)
       AND EXISTS (SELECT 1 FROM push_subscriptions ps WHERE ps.member_id = s.member_id)`,
    [target, clock.date],
  );

  return expiring.map((sub) => {
    const endsToday = sub.end_date === clock.date;
    const left = endsToday ? 0 : days;
    return notifyMember(sub.member_id, {
      category: 'membership',
      title: endsToday
        ? `Your ${word} ends today`
        : `Your ${word} ends in ${left} day${left === 1 ? '' : 's'}`,
      body: `${sub.plan_name} is valid until ${sub.end_date}. Renew at the front desk or from the app to keep your access uninterrupted.`,
      screen: 'pay',
      dedupeKey: `membership:${sub.id}:${sub.end_date}:${left}`,
      tag: 'membership-renewal',
      ttl: 12 * 60 * 60,
    });
  });
}

/**
 * One pass of every automated nudge for *the current gym*.
 *
 * Must run inside a tenantStorage context (server.js walks the tenants), and
 * is safe to run as often as you like: every nudge carries a dedupe key, and
 * the scheduled ones only fire inside SLOT_WINDOW_MINUTES of their time.
 *
 * @param {object} [opts]
 * @param {Date} [opts.now] The instant to evaluate — a parameter so tests can
 *   stand at 11:05 without waiting for it.
 * @returns {Promise<{sent: number, skipped: number}>}
 */
export async function sweepPushNotifications({ now = new Date() } = {}) {
  const settings = pushSettings();
  const clock = gymClock(now);

  const jobs = [];
  if (moduleEnabled('fitness')) {
    if (settings.water_enabled) jobs.push(...hydrationNudges(settings, clock));
    if (settings.nutrition_enabled) jobs.push(...mealNudges(settings, clock));
    if (settings.workout_enabled) jobs.push(...workoutNudges(settings, now));
  }
  if (settings.membership_enabled) jobs.push(...membershipNudges(settings, clock));
  pruneOldNotifications();

  const results = await Promise.all(jobs);
  return {
    sent: results.filter((r) => !r.skipped).length,
    skipped: results.filter((r) => r.skipped).length,
  };
}
