import path from 'node:path';
import express from 'express';
import { ROOT } from './config.js';
import { HttpError } from './errors.js';
import { attendanceRoutes } from './routes/attendance.js';
import { authRoutes, staffRoutes } from './routes/auth.js';
import { bookingRoutes, classRoutes } from './routes/classes.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { equipmentRoutes } from './routes/equipment.js';
import { memberRoutes } from './routes/members.js';
import { paymentRoutes } from './routes/payments.js';
import { planRoutes } from './routes/plans.js';
import { platformRoutes } from './routes/platform.js';
import { reportRoutes } from './routes/reports.js';
import { subscriptionRoutes } from './routes/subscriptions.js';
import { biometricRoutes } from './routes/biometric.js';
import { handleRazorpayWebhook } from './routes/billing.js';
import { requireActiveSubscription, resolveTenant } from './tenant.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');

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

  app.use(express.json({ limit: '1mb' }));

  // Tenant-agnostic: uptime monitors and load balancers must get 200 even
  // against a Host header that doesn't resolve to any gym.
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.use(resolveTenant);

  // Signup, login, and billing must stay reachable even while a tenant is
  // suspended (lapsed trial/payment) — the gate below only applies past here.
  app.use('/api/platform', platformRoutes);
  app.use('/api/auth', authRoutes);

  app.use(requireActiveSubscription);

  app.use('/api/staff', staffRoutes);
  app.use('/api/members', memberRoutes);
  app.use('/api/plans', planRoutes);
  app.use('/api/subscriptions', subscriptionRoutes);
  app.use('/api/payments', paymentRoutes);
  app.use('/api/attendance', attendanceRoutes);
  app.use('/api/biometric', biometricRoutes);
  app.use('/api/classes', classRoutes);
  app.use('/api/bookings', bookingRoutes);
  app.use('/api/equipment', equipmentRoutes);
  app.use('/api/dashboard', dashboardRoutes);
  app.use('/api/reports', reportRoutes);

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'No such endpoint' });
  });

  app.use(express.static(path.join(ROOT, 'public')));
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
