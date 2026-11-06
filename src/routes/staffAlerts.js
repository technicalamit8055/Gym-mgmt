import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { badRequest } from '../errors.js';
import { createLimiter } from '../rateLimit.js';
import {
  kindsForRole,
  listStaffNotifications,
  markStaffRead,
  preferencesForUser,
  removeStaffSubscription,
  saveStaffSubscription,
  savePreferencesForUser,
  sendStaffTest,
  staffDeviceCount,
  staffUnreadCount,
} from '../staffAlerts.js';
import { parse, toInt } from '../validate.js';
import { isValidEndpoint, vapidKeys } from '../webPush.js';

/**
 * The staff bell (src/staffAlerts.js): every signed-in member of staff, any
 * role, reads their own inbox, chooses which alerts they get, and registers
 * this browser for push. Everything is scoped to req.user — nobody reads or
 * changes anyone else's.
 */
export const staffAlertRoutes = Router();
staffAlertRoutes.use(requireAuth);

const PLATFORMS = ['ios', 'android', 'desktop', 'other'];

/** The cheap poll the topbar makes every minute or so. */
staffAlertRoutes.get('/unread', (req, res) => {
  res.json({ unread: staffUnreadCount(req.user.id) });
});

staffAlertRoutes.get('/', (req, res) => {
  const limit = Math.min(Math.max(toInt(req.query.limit, 30), 1), 100);
  res.json({ items: listStaffNotifications(req.user.id, { limit }), unread: staffUnreadCount(req.user.id) });
});

staffAlertRoutes.post('/read', (req, res) => {
  const ids = Array.isArray(req.body?.ids)
    ? req.body.ids.map(Number).filter((id) => Number.isInteger(id) && id > 0).slice(0, 200)
    : null;
  markStaffRead(req.user.id, ids);
  res.json({ unread: staffUnreadCount(req.user.id) });
});

/** Everything the settings dialog needs in one round trip. */
staffAlertRoutes.get('/config', (req, res) => {
  res.json({
    public_key: vapidKeys().publicKey,
    kinds: kindsForRole(req.user.role).map(({ key, label, hint }) => ({ key, label, hint })),
    preferences: preferencesForUser(req.user),
    devices: staffDeviceCount(req.user.id),
    unread: staffUnreadCount(req.user.id),
  });
});

staffAlertRoutes.put('/preferences', (req, res) => {
  const patch = Object.fromEntries(
    Object.entries(req.body ?? {}).filter(([, value]) => typeof value === 'boolean'),
  );
  res.json(savePreferencesForUser(req.user, patch));
});

/**
 * Registers this browser for staff alerts. Same checks as the member route
 * (routes/notifications.js): the endpoint is a URL this server will POST to,
 * so it must be https, and the keys must be real P-256 subscription keys.
 */
staffAlertRoutes.post('/subscriptions', (req, res) => {
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
  // Only ever "" or "/g/<slug>": it prefixes the link a tapped alert opens.
  const pathPrefix = /^(\/g\/[a-z][a-z0-9-]{2,39})?$/.test(body.path_prefix) ? body.path_prefix : '';

  const subscription = saveStaffSubscription(req.user.id, {
    endpoint: body.endpoint,
    p256dh: keys.p256dh,
    auth: keys.auth,
    platform: body.platform,
    userAgent: String(req.get('user-agent') || '').slice(0, 300),
    pathPrefix,
  });
  res.status(201).json({ subscription, devices: staffDeviceCount(req.user.id) });
});

staffAlertRoutes.delete('/subscriptions', (req, res) => {
  const { endpoint } = parse(req.body, { endpoint: { type: 'string', required: true, max: 1024 } });
  removeStaffSubscription(endpoint);
  res.json({ devices: staffDeviceCount(req.user.id) });
});

const testLimiter = createLimiter({ maxAttempts: 5, windowMs: 10 * 60_000, lockoutMs: 10 * 60_000 });

staffAlertRoutes.post('/test', async (req, res, next) => {
  try {
    const key = `${req.tenant?.slug ?? ''}:staff:${req.user.id}`;
    if (testLimiter.check(key).locked) {
      return res.status(429).json({ error: 'Too many test notifications — try again in a few minutes' });
    }
    testLimiter.recordAttempt(key);
    if (!staffDeviceCount(req.user.id)) throw badRequest('Turn on notifications on this device first');
    return res.json(await sendStaffTest(req.user.id));
  } catch (err) {
    return next(err);
  }
});
