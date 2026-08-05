import crypto from 'node:crypto';
import { config } from './config.js';

const API_BASE = 'https://api.razorpay.com/v1';

export function isRazorpayConfigured() {
  return Boolean(config.razorpay.keyId && config.razorpay.keySecret && config.razorpay.planId);
}

function authHeader() {
  return `Basic ${Buffer.from(`${config.razorpay.keyId}:${config.razorpay.keySecret}`).toString('base64')}`;
}

async function request(method, path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
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
