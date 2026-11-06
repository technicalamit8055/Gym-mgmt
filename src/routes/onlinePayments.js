import { Router } from 'express';
import { MANAGES_BILLING, requireAuth, requireMemberAuth, requireRole } from '../auth.js';
import { config } from '../config.js';
import { sendFeeReceipt } from '../coaching/notify.js';
import { getBusinessType } from '../db.js';
import { badRequest, notFound, tooManyRequests } from '../errors.js';
import {
  claimRequest,
  claimedCount,
  confirmRequest,
  createRequest,
  duesFor,
  getPaymentSettings,
  getRequest,
  getRequestByToken,
  listRequests,
  onlinePaymentsLive,
  paySheet,
  rejectRequest,
  savePaymentSettings,
  upiQrDataUrl,
  upiUri,
} from '../onlinePayments.js';
import { createLimiter } from '../rateLimit.js';
import { parse } from '../validate.js';
import { sendAutoReceiptIfEnabled } from './payments.js';

/**
 * Members paying online (src/onlinePayments.js), three audiences:
 *   /api/online-payments  — the desk: settings, the "to confirm" queue
 *   /api/portal/pay       — a signed-in member or parent
 *   /api/pay/:token       — anyone holding a pay link from a WhatsApp reminder
 */

const gymNameOf = (req) => req.tenant?.gym_name || req.tenant?.display_name || config.gymName || 'GymBook';
const idOf = (req) => {
  const n = Number(req.params.id);
  if (!Number.isInteger(n) || n < 1) throw badRequest('Invalid id');
  return n;
};

/* ── The desk ────────────────────────────────────────────────────────── */

export const onlinePaymentRoutes = Router();
onlinePaymentRoutes.use(requireAuth, requireRole(...MANAGES_BILLING));

onlinePaymentRoutes.get('/settings', async (req, res) => {
  const settings = getPaymentSettings();
  // A ₹1 sample the owner can scan to check the UPI ID really reaches them.
  const sampleUri = settings.upi_vpa
    ? upiUri({ amount: 1, ref_code: 'GBTEST01', title: 'Test payment' }, settings, gymNameOf(req))
    : null;
  res.json({ ...settings, live: onlinePaymentsLive(settings), sample_uri: sampleUri, sample_qr: sampleUri ? await upiQrDataUrl(sampleUri) : null });
});

onlinePaymentRoutes.put('/settings', (req, res) => {
  const body = parse(req.body, {
    enabled: { type: 'boolean' },
    upi_vpa: { type: 'string', max: 120 },
    payee_name: { type: 'string', max: 60 },
    alert_phone: { type: 'string', max: 20 },
    pay_link_in_reminders: { type: 'boolean' },
  });
  const patch = Object.fromEntries(Object.entries(body).filter(([k]) => Object.hasOwn(req.body ?? {}, k)));
  res.json(savePaymentSettings(patch));
});

onlinePaymentRoutes.get('/requests', (req, res) => {
  const status = ['pending', 'claimed', 'confirmed', 'rejected', 'expired', 'all'].includes(req.query.status) ? req.query.status : 'claimed';
  res.json({ items: listRequests({ status, limit: 200 }), claimed: claimedCount() });
});

onlinePaymentRoutes.post('/requests/:id/confirm', async (req, res) => {
  const { request, paymentId, already } = confirmRequest(idOf(req), { userId: req.user?.id ?? null });
  if (!already && paymentId) sendReceipt(request, paymentId, req);
  res.json({ request, payment_id: paymentId, already });
});

onlinePaymentRoutes.post('/requests/:id/reject', (req, res) => {
  const body = parse(req.body ?? {}, { reason: { type: 'string', max: 200 } });
  res.json({ request: rejectRequest(idOf(req), { userId: req.user?.id ?? null, reason: body.reason }) });
});

/** The same receipt the desk's own sale sends — queued, never awaited. */
function sendReceipt(request, paymentId, req) {
  const done = request.kind === 'fee_installment'
    ? sendFeeReceipt(paymentId, {
        instituteName: gymNameOf(req),
        logoBuffer: req.tenant?.logo_bytes ? Buffer.from(req.tenant.logo_bytes) : null,
        currency: req.tenant?.currency || 'INR',
      })
    : sendAutoReceiptIfEnabled(paymentId, req);
  Promise.resolve(done).catch((err) => console.error('[payments] receipt after online payment failed:', err.message));
}

/* ── The member app ──────────────────────────────────────────────────── */

export const portalPayRoutes = Router();
portalPayRoutes.use(requireMemberAuth);

/** Whether this gym takes payments in the app, what this member owes, and their recent payments. */
portalPayRoutes.get('/', (req, res) => {
  const settings = getPaymentSettings();
  res.json({
    enabled: onlinePaymentsLive(settings),
    payee_name: settings.payee_name || gymNameOf(req),
    dues: getBusinessType() === 'coaching' ? [] : duesFor(req.member.id),
    requests: listRequests({ status: 'all', memberId: req.member.id, limit: 10 }).map(memberView),
  });
});

portalPayRoutes.post('/', async (req, res) => {
  const body = parse(req.body, {
    kind: { type: 'enum', values: ['membership', 'dues', 'fee_installment'], required: true },
    plan_id: { type: 'int', min: 1 },
    subscription_id: { type: 'int', min: 1 },
    installment_id: { type: 'int', min: 1 },
  });
  const request = createRequest({
    memberId: req.member.id,
    kind: body.kind,
    planId: body.plan_id ?? null,
    subscriptionId: body.subscription_id ?? null,
    installmentId: body.installment_id ?? null,
  });
  res.status(201).json(await paySheet(request, { gymName: gymNameOf(req) }));
});

const ownRequest = (req) => {
  const request = getRequest(idOf(req));
  if (!request || request.member_id !== req.member.id) throw notFound('Payment not found');
  return request;
};

portalPayRoutes.get('/:id', async (req, res) => {
  res.json(await paySheet(ownRequest(req), { gymName: gymNameOf(req) }));
});

portalPayRoutes.post('/:id/claim', async (req, res) => {
  const body = parse(req.body ?? {}, { utr: { type: 'string', max: 30 } });
  const request = claimRequest(ownRequest(req).id, { utr: body.utr || null });
  res.json(await paySheet(request, { gymName: gymNameOf(req) }));
});

function memberView(r) {
  return {
    id: r.id,
    ref_code: r.ref_code,
    kind: r.kind,
    title: r.title,
    amount: r.amount,
    status: r.status,
    plan_id: r.plan_id,
    subscription_id: r.subscription_id,
    installment_id: r.installment_id,
    utr: r.utr,
    reject_reason: r.reject_reason,
    created_at: r.created_at,
    claimed_at: r.claimed_at,
    decided_at: r.decided_at,
  };
}

/* ── A pay link, no sign-in ──────────────────────────────────────────── */

const linkLimiter = createLimiter({ maxAttempts: 60, windowMs: 10 * 60_000, lockoutMs: 10 * 60_000 });

export const publicPayRoutes = Router();
publicPayRoutes.use((req, res, next) => {
  const gate = linkLimiter.check(req.ip);
  if (gate.locked) {
    res.set('Retry-After', String(gate.retryAfterSeconds));
    return next(tooManyRequests('Too many attempts — wait a few minutes and try again.'));
  }
  linkLimiter.recordAttempt(req.ip);
  res.set('Cache-Control', 'no-store');
  next();
});

/** The link names exactly one request; it shows only that, and only the member's first name. */
async function linkSheet(request, req) {
  const sheet = await paySheet(request, { gymName: gymNameOf(req) });
  return { ...sheet, first_name: request.first_name, gym_name: gymNameOf(req) };
}

publicPayRoutes.get('/:token', async (req, res) => {
  const request = getRequestByToken(req.params.token);
  if (!request) throw notFound('This payment link is not valid');
  res.json(await linkSheet(request, req));
});

publicPayRoutes.post('/:token/claim', async (req, res) => {
  const request = getRequestByToken(req.params.token);
  if (!request) throw notFound('This payment link is not valid');
  const body = parse(req.body ?? {}, { utr: { type: 'string', max: 30 } });
  res.json(await linkSheet(claimRequest(request.id, { utr: body.utr || null }), req));
});
