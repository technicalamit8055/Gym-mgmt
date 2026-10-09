import { Router } from 'express';
import { MANAGES_BILLING, requireAuth, requireMemberAuth, requireRole } from '../auth.js';
import { badRequest } from '../errors.js';
import {
  ANNOUNCEMENT_KINDS,
  PREFERENCE_KEYS,
  clearActiveWorkout,
  createAnnouncement,
  deviceCount,
  listAnnouncements,
  listNotifications,
  markRead,
  notifyMember,
  parseTimeList,
  preferencesFor,
  pushReach,
  pushSettings,
  recordActiveWorkout,
  removeSubscription,
  saveSubscription,
  savePreferences,
  savePushSettings,
  unreadCount,
} from '../notifications.js';
import { createLimiter } from '../rateLimit.js';
import { parse, toInt } from '../validate.js';
import { moduleEnabled } from '../verticals.js';
import { isValidEndpoint, vapidKeys } from '../webPush.js';

/* ================================================================ member */

/**
 * The member side: registering this device, choosing what to hear about, and
 * the notification center. Mounted at /api/portal/notifications, ahead of the
 * main portal router, and behind the same member-token auth.
 */
export const portalNotificationRoutes = Router();
portalNotificationRoutes.use(requireMemberAuth);

const PLATFORMS = ['ios', 'android', 'desktop', 'other'];

/** Which categories make sense for this gym: the habit nudges ride on the
 * Diet & Workout tracker, which a library does not have. */
const availableCategories = () =>
  moduleEnabled('fitness')
    ? ['water', 'nutrition', 'workout', 'announcements', 'membership']
    : ['announcements', 'membership'];

/** Everything the Profile screen needs in one round trip. */
portalNotificationRoutes.get('/config', (req, res) => {
  res.json({
    public_key: vapidKeys().publicKey,
    preferences: preferencesFor(req.member.id),
    categories: availableCategories(),
    devices: deviceCount(req.member.id),
    unread: unreadCount(req.member.id),
  });
});

/**
 * Registers (or refreshes) this browser's push subscription.
 *
 * Takes PushSubscription.toJSON() as the browser produces it. The endpoint is
 * checked to be https: it is a URL this server will later POST to, so an
 * arbitrary one would turn the sweep into a request-forgery tool.
 */
portalNotificationRoutes.post('/subscriptions', (req, res) => {
  const body = parse(req.body, {
    endpoint: { type: 'string', required: true, max: 1024 },
    platform: { type: 'enum', values: PLATFORMS, default: 'other' },
    path_prefix: { type: 'string', max: 60, default: '' },
  });
  const keys = req.body?.keys ?? {};
  if (!isValidEndpoint(body.endpoint)) throw badRequest('That is not a push subscription', { endpoint: 'must be an https URL' });
  if (typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string' || keys.p256dh.length > 200 || keys.auth.length > 100) {
    throw badRequest('That is not a push subscription', { keys: 'p256dh and auth are required' });
  }
  if (Buffer.from(keys.p256dh, 'base64url').length !== 65 || Buffer.from(keys.auth, 'base64url').length < 16) {
    throw badRequest('That is not a push subscription', { keys: 'are not valid subscription keys' });
  }
  // Only ever "" or "/g/<slug>": it is pasted in front of the deep link a
  // notification opens, so anything else could point a tap off-site.
  const pathPrefix = /^(\/g\/[a-z][a-z0-9-]{2,39})?$/.test(body.path_prefix) ? body.path_prefix : '';

  const subscription = saveSubscription(req.member.id, {
    endpoint: body.endpoint,
    p256dh: keys.p256dh,
    auth: keys.auth,
    platform: body.platform,
    userAgent: String(req.get('user-agent') || '').slice(0, 300),
    pathPrefix,
  });
  res.status(201).json({ subscription, devices: deviceCount(req.member.id) });
});

portalNotificationRoutes.delete('/subscriptions', (req, res) => {
  const { endpoint } = parse(req.body, { endpoint: { type: 'string', required: true, max: 1024 } });
  removeSubscription(req.member.id, endpoint);
  res.json({ devices: deviceCount(req.member.id) });
});

portalNotificationRoutes.get('/preferences', (req, res) => {
  res.json(preferencesFor(req.member.id));
});

portalNotificationRoutes.put('/preferences', (req, res) => {
  const patch = parse(
    req.body,
    Object.fromEntries(PREFERENCE_KEYS.map((key) => [key, { type: 'boolean' }])),
  );
  res.json(savePreferences(req.member.id, patch));
});

portalNotificationRoutes.get('/', (req, res) => {
  const limit = Math.min(Math.max(toInt(req.query.limit, 30), 1), 100);
  res.json({ items: listNotifications(req.member.id, { limit }), unread: unreadCount(req.member.id) });
});

portalNotificationRoutes.post('/read', (req, res) => {
  const ids = Array.isArray(req.body?.ids)
    ? req.body.ids.map(Number).filter((id) => Number.isInteger(id) && id > 0).slice(0, 200)
    : null;
  markRead(req.member.id, ids);
  res.json({ unread: unreadCount(req.member.id) });
});

/** A member hammering "Send test" should not be able to hammer a push
 * service under this server's VAPID identity. */
const testLimiter = createLimiter({ maxAttempts: 5, windowMs: 10 * 60_000, lockoutMs: 10 * 60_000 });

/** Sends a test notification and waits for the outcome, so the button can say
 * "delivered to 2 devices" or why it was not. */
portalNotificationRoutes.post('/test', async (req, res, next) => {
  try {
    const key = `${req.tenant?.slug ?? ''}:${req.member.id}`;
    if (testLimiter.check(key).locked) {
      return res.status(429).json({ error: 'Too many test notifications — try again in a few minutes' });
    }
    testLimiter.recordAttempt(key);
    if (!deviceCount(req.member.id)) {
      throw badRequest('Turn on notifications on this device first');
    }
    const result = await notifyMember(req.member.id, {
      category: 'test',
      title: 'Notifications are on ✅',
      body: 'This is how reminders and gym announcements will look on this device.',
      screen: 'notifications',
      tag: 'test',
      ttl: 5 * 60,
      urgency: 'high',
    });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

/**
 * The portal reports a workout session starting (and re-reports it on
 * resume), so the sweep can nudge a member who walked out without finishing.
 * `started_at` is the device's own epoch-ms start time — the session's
 * identity, so a resumed session is not mistaken for a new one.
 */
portalNotificationRoutes.put('/active-workout', (req, res) => {
  const body = parse(req.body, {
    workout_name: { type: 'string', required: true, max: 80 },
    started_at: { type: 'number', required: true, min: 0 },
  });
  const started = new Date(body.started_at);
  // Clamp a phone with a wrong clock into the plausible range rather than
  // trusting it: no earlier than a day ago, no later than now.
  const now = Date.now();
  const clamped = Math.min(now, Math.max(now - 24 * 3_600_000, started.getTime()));
  recordActiveWorkout(req.member.id, {
    workoutName: body.workout_name,
    startedAt: new Date(clamped).toISOString().slice(0, 19).replace('T', ' '),
  });
  res.status(204).end();
});

portalNotificationRoutes.delete('/active-workout', (req, res) => {
  clearActiveWorkout(req.member.id);
  res.status(204).end();
});

/* ================================================================= staff */

/**
 * The gym's side: when the automated nudges go out, and the broadcast form.
 * Admin and manager only — an announcement lands on every member's lock
 * screen under the gym's name, the same reach as the WhatsApp tools.
 */
export const notificationRoutes = Router();
notificationRoutes.use(requireAuth);
notificationRoutes.use(requireRole(...MANAGES_BILLING));

notificationRoutes.get('/settings', (_req, res) => {
  res.json({
    settings: pushSettings(),
    reach: pushReach(),
    fitness: moduleEnabled('fitness'),
  });
});

notificationRoutes.put('/settings', (req, res) => {
  const body = parse(req.body, {
    water_enabled: { type: 'boolean' },
    water_times: { type: 'string', max: 120 },
    nutrition_enabled: { type: 'boolean' },
    lunch_time: { type: 'time' },
    dinner_time: { type: 'time' },
    workout_enabled: { type: 'boolean' },
    workout_nudge_minutes: { type: 'int', min: 30, max: 600 },
    membership_enabled: { type: 'boolean' },
    membership_days_before: { type: 'int', min: 0, max: 60 },
  });
  if (body.water_times !== undefined && body.water_times !== null) {
    const times = parseTimeList(body.water_times);
    if (!times || !times.length || times.length > 8) {
      throw badRequest('Some fields need attention', {
        water_times: 'must be 1–8 times formatted HH:MM, separated by commas',
      });
    }
    body.water_times = times.join(',');
  }
  const patch = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined && v !== null));
  res.json({ settings: savePushSettings(patch), reach: pushReach(), fitness: moduleEnabled('fitness') });
});

notificationRoutes.get('/announcements', (req, res) => {
  const limit = Math.min(Math.max(toInt(req.query.limit, 20), 1), 100);
  res.json({ items: listAnnouncements({ limit }) });
});

const broadcastLimiter = createLimiter({ maxAttempts: 10, windowMs: 60 * 60_000, lockoutMs: 60 * 60_000 });

notificationRoutes.post('/announcements', (req, res) => {
  const body = parse(req.body, {
    title: { type: 'string', required: true, min: 3, max: 80 },
    body: { type: 'string', required: true, min: 3, max: 500 },
    kind: { type: 'enum', values: ANNOUNCEMENT_KINDS, default: 'general' },
    urgent: { type: 'boolean', default: 0 },
  });
  const key = `${req.tenant?.slug ?? ''}`;
  if (broadcastLimiter.check(key).locked) {
    return res.status(429).json({ error: 'That is a lot of announcements in one hour — try again later' });
  }
  broadcastLimiter.recordAttempt(key);

  const { announcement, delivery } = createAnnouncement({ ...body, userId: req.user.id });
  delivery.catch((err) => console.error('[push] announcement delivery failed:', err.message));
  return res.status(201).json(announcement);
});
