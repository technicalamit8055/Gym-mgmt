import { Router } from 'express';
import { requireAuth, requireRole } from '../auth.js';
import { config } from '../config.js';
import { conflict, HttpError, notFound } from '../errors.js';
import { createSubscription, isRazorpayConfigured, verifyWebhookSignature } from '../razorpay.js';
import {
  applyWebhookStatus,
  findTenantBySlug,
  findTenantBySubscriptionId,
  setTenantBilling,
} from '../tenants.js';

export const billingRoutes = Router();
billingRoutes.use(requireAuth);

billingRoutes.post('/subscribe', requireRole('admin'), async (req, res) => {
  if (!isRazorpayConfigured()) throw new HttpError(500, 'Billing is not configured');

  const tenant = findTenantBySlug(req.tenant.slug);
  if (!tenant) throw notFound('This login is not attached to a billable gym account');

  if (tenant.status === 'active' && tenant.razorpay_subscription_id) {
    throw conflict('This gym already has an active subscription');
  }

  // A subscription was already created (e.g. a previous call that was never
  // completed at checkout) — hand back the same link instead of minting a
  // second, orphaned Razorpay subscription.
  if (tenant.razorpay_subscription_id && tenant.razorpay_checkout_url && tenant.status !== 'active') {
    return res.json({
      checkout_url: tenant.razorpay_checkout_url,
      subscription_id: tenant.razorpay_subscription_id,
    });
  }

  const subscription = await createSubscription({
    notes: { tenant_slug: tenant.slug, gym_name: tenant.gym_name ?? tenant.display_name },
  });

  setTenantBilling(tenant.slug, { subscriptionId: subscription.id, checkoutUrl: subscription.short_url });

  res.status(201).json({ checkout_url: subscription.short_url, subscription_id: subscription.id });
});

billingRoutes.get('/status', (req, res) => {
  const tenant = findTenantBySlug(req.tenant.slug);
  if (!tenant) throw notFound('This login is not attached to a billable gym account');
  res.json({
    status: tenant.status,
    trial_ends_on: tenant.trial_ends_on,
    razorpay_subscription_id: tenant.razorpay_subscription_id,
    checkout_url: tenant.razorpay_checkout_url,
  });
});

const STATUS_BY_EVENT = {
  'subscription.activated': 'active',
  'subscription.charged': 'active',
  // Recoverable — the tenant-level 'cancelled' status is reserved for a
  // deliberate platform-side action, never set from a webhook.
  'subscription.halted': 'suspended',
  'subscription.cancelled': 'suspended',
};

/** Wired directly in app.js, ahead of express.json()/resolveTenant — see there for why. */
export function handleRazorpayWebhook(req, res) {
  const rawBody = req.body; // Buffer, set by the path-scoped express.raw() in app.js
  const signature = req.get('x-razorpay-signature');

  if (!Buffer.isBuffer(rawBody) || !verifyWebhookSignature(rawBody, signature, config.razorpay.webhookSecret)) {
    return res.status(400).json({ error: 'Invalid webhook signature' });
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Malformed webhook payload' });
  }

  const subscriptionId = event?.payload?.subscription?.entity?.id;
  if (!subscriptionId) return res.status(200).json({ ok: true }); // nothing actionable — ack, don't retry-loop

  const tenant = findTenantBySubscriptionId(subscriptionId);
  if (!tenant) return res.status(200).json({ ok: true }); // unknown subscription — ack

  const nextStatus = STATUS_BY_EVENT[event.event];
  if (nextStatus) {
    applyWebhookStatus(subscriptionId, {
      status: nextStatus,
      reason: nextStatus === 'suspended' ? `razorpay: ${event.event}` : null,
      eventCreatedAt: Number(event.created_at) || Math.floor(Date.now() / 1000),
    });
  }

  res.status(200).json({ ok: true });
}
