import crypto from 'node:crypto';
import { config } from './config.js';

export function isRazorpayConfigured() {
  return Boolean(config.razorpay.keyId && config.razorpay.keySecret && config.razorpay.planId);
}

/**
 * One-off member payments (the fitness add-on, store orders) need only the API
 * key pair — no plan — so they can go live on a deployment that has not set up
 * gym SaaS subscriptions at all.
 */
export function isRazorpayOrdersConfigured() {
  return Boolean(config.razorpay.keyId && config.razorpay.keySecret);
}

function authHeader() {
  return `Basic ${Buffer.from(`${config.razorpay.keyId}:${config.razorpay.keySecret}`).toString('base64')}`;
}

async function request(method, path, body) {
  const res = await fetch(`${config.razorpay.apiBase}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: authHeader() },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const message = data?.error?.description || `Razorpay request failed with status ${res.status}`;
    throw Object.assign(new Error(message), { status: res.status, razorpay: data });
  }
  return data;
}

/** Creates a subscription against the single dashboard-configured plan — no tiers, nothing to choose. */
export function createSubscription({ notes } = {}) {
  return request('POST', '/subscriptions', {
    plan_id: config.razorpay.planId,
    total_count: config.razorpay.totalCount,
    customer_notify: 1,
    notes: notes ?? {},
  });
}

/**
 * A Razorpay Order: the server-side amount a Checkout is opened against, so
 * the member's browser never decides what it pays. `amount` is rupees;
 * Razorpay wants the smallest unit (paise) as an integer.
 */
export function createOrder({ amount, currency = 'INR', receipt, notes } = {}) {
  return request('POST', '/orders', {
    amount: Math.round(Number(amount) * 100),
    currency,
    receipt: receipt ? String(receipt).slice(0, 40) : undefined,
    notes: notes ?? {},
  });
}

/**
 * Checkout's success handler hands back the order id, the payment id and a
 * signature of "<order_id>|<payment_id>" keyed with the API secret. What the
 * browser reports is only a claim until this says otherwise.
 */
export function verifyPaymentSignature({ orderId, paymentId, signature }, secret = config.razorpay.keySecret) {
  if (!orderId || !paymentId || !signature || !secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(String(signature));
  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

/**
 * Pure, no I/O — directly unit-testable with a hand-computed HMAC. rawBody
 * must be the exact, unparsed request bytes: Razorpay signs the raw JSON it
 * sent, not a re-serialized version of it.
 */
export function verifyWebhookSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !secret || !rawBody) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(String(signatureHeader));
  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}
