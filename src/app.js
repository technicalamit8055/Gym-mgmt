import path from 'node:path';
import express from 'express';
import { config, ROOT } from './config.js';
import { HttpError } from './errors.js';
import { attendanceRoutes } from './routes/attendance.js';
import { authRoutes, staffRoutes } from './routes/auth.js';
import { bookingRoutes, classRoutes } from './routes/classes.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { equipmentRoutes } from './routes/equipment.js';
import { memberRoutes } from './routes/members.js';
import { memberPhotoRoutes } from './routes/memberPhotos.js';
import { paymentRoutes } from './routes/payments.js';
import { planRoutes } from './routes/plans.js';
import { platformRoutes } from './routes/platform.js';
import { pwaRoutes } from './routes/pwa.js';
import { qrRoutes } from './routes/qr.js';
import { reportRoutes } from './routes/reports.js';
import { seatRoutes } from './routes/seats.js';
import { sessionRoutes } from './routes/sessions.js';
import { subscriptionRoutes } from './routes/subscriptions.js';
import { whatsappRoutes } from './routes/whatsapp.js';
import { biometricRoutes } from './routes/biometric.js';
import { handleRazorpayWebhook } from './routes/billing.js';
import { deviceAttendanceRoutes } from './routes/deviceAttendance.js';
import { deviceRoutes } from './routes/devices.js';
import { requireActiveSubscription, resolveTenant } from './tenant.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // Opt-in (config.trustProxy, TRUST_PROXY env var): only correct once a real
  // reverse proxy is actually in front — otherwise a client's own
  // X-Forwarded-For would be trusted, spoofing req.ip and req.protocol.
  app.set('trust proxy', config.trustProxy);

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('Referrer-Policy', 'no-referrer');
    if (req.secure) res.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    next();
  });

  // Razorpay signs the RAW request body, so this path needs the bytes before
  // express.json() below parses (and thereby consumes) them. Mounted before
  // resolveTenant too: Razorpay calls one fixed URL with no tenant subdomain
  // context — the handler resolves its own tenant via razorpay_subscription_id
  // and must not be subject to resolveTenant's unknown/cancelled-tenant response.
  app.post(
    '/api/platform/webhooks/razorpay',
    express.raw({ type: 'application/json', limit: '1mb' }),
    handleRazorpayWebhook,
  );

  // Fixed paths dictated by the fingerprint terminal's own firmware
  // convention — not tenant-subdomain-routed (see deviceAttendance.js for
  // why), so mounted here alongside the Razorpay webhook.
  app.use('/iclock', deviceAttendanceRoutes);

  app.use(express.json({ limit: '5mb' }));

  // Tenant-agnostic: uptime monitors and load balancers must get 200 even
  // against a Host header that doesn't resolve to any gym.
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.use(resolveTenant);

  // The installed-app manifest, named after whichever gym the address resolved
  // to. Outside /api so the subscription gate below never applies: a lapsed
  // gym's home-screen icon must still open the page that takes payment.
  app.use(pwaRoutes);

  // Signup, login, and billing must stay reachable even while a tenant is
  // suspended (lapsed trial/payment) — the gate below only applies past here.
  app.use('/api/platform', platformRoutes);
  app.use('/api/auth', authRoutes);

  // Ahead of the subscription gate, and with no requireAuth of its own: these
  // URLs are individually signed (src/photo.js), and a lapsed gym serving
  // broken avatars on the page that takes their payment helps nobody.
  app.use('/api/member-photos', memberPhotoRoutes);

  // Scoped to /api, not the whole app: the gate must not reach express.static
  // and the SPA fallback below, or a gym whose trial lapsed would get a JSON
  // 402 for "/" and never be able to load the billing page that fixes it.
  app.use('/api', requireActiveSubscription);

  app.use('/api/staff', staffRoutes);
  app.use('/api/devices', deviceRoutes);
  app.use('/api/members', memberRoutes);
  app.use('/api/plans', planRoutes);
  app.use('/api/subscriptions', subscriptionRoutes);
  app.use('/api/payments', paymentRoutes);
  app.use('/api/attendance', attendanceRoutes);
  app.use('/api/sessions', sessionRoutes);
  app.use('/api/biometric', biometricRoutes);
  app.use('/api/qr', qrRoutes);
  app.use('/api/classes', classRoutes);
  app.use('/api/bookings', bookingRoutes);
  app.use('/api/equipment', equipmentRoutes);
  app.use('/api/dashboard', dashboardRoutes);
  app.use('/api/reports', reportRoutes);
  app.use('/api/whatsapp', whatsappRoutes);
  // Gated inside the router itself (requireModule('seats')), not here — see
  // verticals.js for why the mount list stays a plain map of paths to routers.
  app.use('/api/seats', seatRoutes);

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'No such endpoint' });
  });

  app.use(
    express.static(path.join(ROOT, 'public'), {
      setHeaders(res, filePath) {
        // A cached service worker script is a stuck deployment: the browser
        // would keep re-registering the old one, and the new shell would never
        // install. Icons are the opposite — content-stable, so let them sit.
        if (path.basename(filePath) === 'sw.js') {
          res.set('Cache-Control', 'no-cache');
          res.set('Service-Worker-Allowed', '/');
        } else if (filePath.includes(`${path.sep}icons${path.sep}`)) {
          res.set('Cache-Control', 'public, max-age=604800');
        }
      },
    }),
  );
  app.get('*splat', (_req, res) => {
    res.sendFile(path.join(ROOT, 'public', 'index.html'));
  });

  // eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity
  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message, details: err.details });
    }
    if (err?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Request body is not valid JSON' });
    }
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong on our side' });
  });

  return app;
}
