import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

/**
 * What institutes pay for the WhatsApp admissions assistant: the operator's
 * price and trial, the in-app Razorpay checkout, the operator's manual levers,
 * and the assistant going quiet when a plan lapses.
 *
 * Razorpay's Orders API is a local stub (RAZORPAY_API_BASE), as in
 * monetization.test.js.
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-receptionist-billing-'));
process.env.NODE_ENV = 'test';
process.env.DB_FILE = path.join(tmpDir, 'default.db');
process.env.PLATFORM_DB_FILE = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.BACKUP_INTERVAL_HOURS = '0';
process.env.AUTH_SECRET = 'test-secret';
process.env.PLATFORM_ADMIN_EMAIL = 'ops@gymbook.test';
process.env.PLATFORM_ADMIN_PASSWORD = 'operator-pass-123';
process.env.RAZORPAY_KEY_ID = 'rzp_test_key';
process.env.RAZORPAY_KEY_SECRET = 'rzp-test-secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'rzp-webhook-secret';
process.env.GOOGLE_CLOUD_PROJECT = 'test-project';
process.env.WHATSAPP_TRANSPORT = 'memory';
process.env.AI_RECEPTIONIST_DEBOUNCE_MS = '20';

const razorpayOrders = [];
const stub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    if (req.method === 'POST' && req.url === '/orders') {
      const body = JSON.parse(raw);
      const order = { id: `order_${razorpayOrders.length + 1}`, amount: body.amount, currency: body.currency, notes: body.notes };
      razorpayOrders.push(order);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(order));
    }
    res.writeHead(404).end('{}');
  });
});
stub.listen(0);
await new Promise((resolve) => stub.once('listening', resolve));
process.env.RAZORPAY_API_BASE = `http://127.0.0.1:${stub.address().port}`;

const { createApp } = await import('../src/app.js');
const { closeDb } = await import('../src/db.js');
const { closeRegistryDb } = await import('../src/tenants.js');
const { addDays, addMonths } = await import('../src/validate.js');
const { receiveWhatsAppMessage, receptionistIdle } = await import('../src/coaching/receptionist.js');
const { setAiClientForTests } = await import('../src/aiCoach.js');

// The assistant answers during the trial test; it must never reach Vertex.
setAiClientForTests({
  models: { generateContent: async () => ({ text: 'Hello! How can I help?', candidates: [{ content: { role: 'model', parts: [{ text: 'Hello! How can I help?' }] } }] }) },
});

const APEX = 'apex-academy';
const ZENITH = 'zenith-academy';
const GYM = 'iron-den';

let base;
let server;
let ops;
let apexAdmin;
let zenithAdmin;
let apexTeacher;

const call = async (method, urlPath, body, { token, tenant, headers = {}, raw } = {}) => {
  const res = await fetch(`${base}${tenant ? `/g/${tenant}` : ''}${urlPath}`, {
    method,
    headers: {
      ...(body !== undefined || raw ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const apex = (method, urlPath, body, token = apexAdmin) => call(method, `/api/coaching${urlPath}`, body, { token, tenant: APEX });
const opsCall = (method, urlPath, body) => call(method, `/api/platform/admin${urlPath}`, body, { token: ops });

const sign = (orderId, paymentId) => crypto.createHmac('sha256', 'rzp-test-secret').update(`${orderId}|${paymentId}`).digest('hex');
const paid = (orderId, paymentId) => ({ razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: sign(orderId, paymentId) });

const signup = async (slug, name, email, businessType) => {
  const res = await call('POST', '/api/platform/signup', {
    slug, gym_name: name, admin_name: 'Owner Name', admin_email: email, admin_password: 'strongpass123', business_type: businessType, currency: 'INR',
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.token;
};

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  apexAdmin = await signup(APEX, 'Apex Academy', 'owner@apex.test', 'coaching');
  zenithAdmin = await signup(ZENITH, 'Zenith Academy', 'owner@zenith.test', 'coaching');
  await signup(GYM, 'Iron Den', 'owner@iron.test', 'gym');
  assert.equal((await call('POST', '/api/staff', { name: 'Er. Verma', email: 'v@apex.test', password: 'teacherpass1', role: 'trainer' }, { token: apexAdmin, tenant: APEX })).status, 201);
  apexTeacher = (await call('POST', '/api/auth/login', { email: 'v@apex.test', password: 'teacherpass1' }, { tenant: APEX })).body.token;
  ops = (await call('POST', '/api/platform/admin/login', { email: 'ops@gymbook.test', password: 'operator-pass-123' })).body.token;
  assert.ok(ops);
});

after(() => {
  setAiClientForTests(null);
  server.close();
  stub.close();
  closeDb();
  closeRegistryDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('the operator’s price', () => {
  it('starts from ₹1,999 a month with longer plans discounted', async () => {
    const res = await apex('GET', '/admissions/assistant');
    assert.equal(res.status, 200);
    const { plan } = res.body;
    assert.equal(plan.status, 'none');
    assert.equal(plan.trial_available, true);
    assert.equal(plan.online_payments, true);
    assert.deepEqual(
      plan.offers.map((o) => [o.months, o.price, o.save_pct]),
      [[1, 1999, 0], [3, 5697, 5], [6, 10795, 10], [12, 20390, 15]],
    );
  });

  it('is whatever the operator sets in the console, for every institute at once', async () => {
    assert.equal((await call('GET', '/api/platform/admin/receptionist')).status, 401, 'console only');
    const res = await opsCall('PUT', '/receptionist/settings', { price_monthly: 2499, trial_days: 14, discount_3m: 0, discount_6m: 10, discount_12m: 20 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.settings.price_monthly, 2499);
    assert.ok(res.body.institutes.some((i) => i.slug === APEX));
    assert.ok(!res.body.institutes.some((i) => i.slug === GYM), 'gyms are not sold the receptionist');

    const { plan } = (await apex('GET', '/admissions/assistant')).body;
    assert.equal(plan.trial_days, 14);
    assert.deepEqual(plan.offers.map((o) => o.price), [2499, 7497, 13495, 23990]);
    assert.equal((await opsCall('PUT', '/receptionist/settings', { price_monthly: 0 })).status, 400);
  });

  it('can give one institute its own price', async () => {
    const res = await opsCall('PATCH', `/receptionist/${ZENITH}`, { price_monthly: 1499 });
    assert.equal(res.status, 200);
    const zenith = (await call('GET', '/api/coaching/admissions/assistant', undefined, { token: zenithAdmin, tenant: ZENITH })).body.plan;
    assert.equal(zenith.price_monthly, 1499);
    assert.equal(zenith.custom_price, true);
    assert.equal((await apex('GET', '/admissions/assistant')).body.plan.price_monthly, 2499, 'others keep the default');
    assert.equal((await opsCall('PATCH', `/receptionist/${GYM}`, { price_monthly: 999 })).status, 404);
  });
});

describe('the free trial', () => {
  it('starts the first time the owner switches the assistant on', async () => {
    const res = await apex('PATCH', '/admissions/assistant', { ai_receptionist: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.trial_started, true);
    assert.equal(res.body.plan.status, 'trial');
    assert.equal(res.body.plan.days_left, 14);
    assert.equal(res.body.plan.trial_available, false);
  });

  it('is not started again by switching off and on', async () => {
    await apex('PATCH', '/admissions/assistant', { ai_receptionist: false });
    const res = await apex('PATCH', '/admissions/assistant', { ai_receptionist: true });
    assert.equal(res.body.trial_started, false);
    assert.equal(res.body.plan.status, 'trial');
  });

  it('lets the assistant answer while it runs', async () => {
    const res = await receiveWhatsAppMessage({ slug: APEX, jid: '919800000001@s.whatsapp.net', phone: '919800000001', id: 'T1', text: 'Fees?' });
    assert.equal(res.reason, 'queued');
    assert.ok(await receptionistIdle());
  });
});

describe('paying in the app', () => {
  let order;
  let trialEnd;

  it('opens Razorpay at the operator’s price, never the browser’s', async () => {
    trialEnd = (await apex('GET', '/admissions/assistant')).body.plan.trial_ends_on;
    assert.equal((await apex('POST', '/admissions/assistant/checkout', { months: 3 }, apexTeacher)).status, 403, 'faculty cannot buy');
    assert.equal((await apex('POST', '/admissions/assistant/checkout', { months: 2 })).status, 400);

    const res = await apex('POST', '/admissions/assistant/checkout', { months: 3, amount: 1 });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    order = res.body.checkout;
    assert.equal(order.amount, 7497 * 100, 'paise, from the console price');
    assert.equal(order.key_id, 'rzp_test_key');
    assert.equal(razorpayOrders.at(-1).notes.kind, 'ai_receptionist');
    assert.equal((await apex('GET', '/admissions/assistant')).body.plan.status, 'trial', 'nothing changes until it is paid');
  });

  it('refuses a forged payment, and another institute’s order', async () => {
    const forged = await apex('POST', '/admissions/assistant/verify', { ...paid(order.order_id, 'pay_x'), razorpay_signature: 'f'.repeat(64) });
    assert.equal(forged.status, 400);
    const stolen = await call('POST', '/api/coaching/admissions/assistant/verify', paid(order.order_id, 'pay_1'), { token: zenithAdmin, tenant: ZENITH });
    assert.equal(stolen.status, 404);
  });

  it('adds the months after the trial, once, however often it is confirmed', async () => {
    const res = await apex('POST', '/admissions/assistant/verify', paid(order.order_id, 'pay_1'));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.settled, true);
    assert.equal(res.body.plan.status, 'active');
    const expected = addDays(addMonths(addDays(trialEnd, 1), 3), -1);
    assert.equal(res.body.plan.paid_until, expected, 'the trial days are not lost');

    const again = await apex('POST', '/admissions/assistant/verify', paid(order.order_id, 'pay_1'));
    assert.equal(again.body.settled, false);
    assert.equal(again.body.plan.paid_until, expected);
  });

  it('is settled by the Razorpay webhook when the owner never comes back', async () => {
    const before = (await apex('GET', '/admissions/assistant')).body.plan.paid_until;
    const open = await apex('POST', '/admissions/assistant/checkout', { months: 1 });
    const payload = JSON.stringify({ event: 'order.paid', payload: { payment: { entity: { id: 'pay_2', order_id: open.body.checkout.order_id } } } });
    const signature = crypto.createHmac('sha256', 'rzp-webhook-secret').update(payload).digest('hex');
    const hook = await call('POST', '/api/platform/webhooks/razorpay', undefined, { raw: payload, headers: { 'x-razorpay-signature': signature } });
    assert.equal(hook.status, 200);
    const after = (await apex('GET', '/admissions/assistant')).body.plan.paid_until;
    assert.equal(after, addDays(addMonths(addDays(before, 1), 1), -1));
  });

  it('shows in the console as revenue', async () => {
    const res = await opsCall('GET', '/receptionist');
    const row = res.body.institutes.find((i) => i.slug === APEX);
    assert.equal(row.plan.status, 'active');
    assert.equal(row.revenue, 7497 + 2499);
    assert.equal(row.usage.switched_on, true);
    assert.equal(res.body.summary.paying, 1);
    assert.equal(res.body.summary.revenue_total, 7497 + 2499);
    assert.equal(res.body.summary.monthly_run_rate, 2499);
    assert.equal(res.body.payments.length, 2);
  });
});

describe('the operator’s levers', () => {
  it('records a UPI or cash payment taken outside the app', async () => {
    assert.equal((await opsCall('POST', `/receptionist/${ZENITH}/payments`, { months: 1 })).status, 400, 'needs the amount');
    const res = await opsCall('POST', `/receptionist/${ZENITH}/payments`, { months: 1, amount: 1499, note: 'UPI ref 4432' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const zenith = res.body.institutes.find((i) => i.slug === ZENITH);
    assert.equal(zenith.plan.status, 'active');
    assert.equal(zenith.revenue, 1499);
    assert.equal(res.body.payments[0].channel, 'manual');
    assert.equal(res.body.payments[0].recorded_by, 'ops@gymbook.test');
  });

  it('gives months free without counting them as revenue', async () => {
    const before = (await opsCall('GET', '/receptionist')).body.institutes.find((i) => i.slug === ZENITH);
    const res = await opsCall('POST', `/receptionist/${ZENITH}/payments`, { months: 2, channel: 'comp', amount: 5000 });
    const after = res.body.institutes.find((i) => i.slug === ZENITH);
    assert.equal(after.revenue, before.revenue);
    assert.equal(after.plan.paid_until, addDays(addMonths(addDays(before.plan.paid_until, 1), 2), -1));
  });

  it('ends access, and the assistant goes quiet until they renew', async () => {
    const res = await opsCall('PATCH', `/receptionist/${APEX}`, { end_access: true });
    assert.equal(res.body.institutes.find((i) => i.slug === APEX).plan.status, 'expired');

    const msg = await receiveWhatsAppMessage({ slug: APEX, jid: '919800000002@s.whatsapp.net', phone: '919800000002', id: 'E1', text: 'Fees?' });
    assert.deepEqual(msg, { handled: false, reason: 'not_subscribed' });

    await apex('PATCH', '/admissions/assistant', { ai_receptionist: false });
    const on = await apex('PATCH', '/admissions/assistant', { ai_receptionist: true });
    assert.equal(on.status, 402);
    assert.equal(on.body.details.code, 'receptionist_plan_ended');
    // Every other setting still saves.
    assert.equal((await apex('PATCH', '/admissions/assistant', { ai_persona_name: 'Riya' })).status, 200);
  });

  it('extends a trial', async () => {
    const res = await opsCall('PATCH', `/receptionist/${APEX}`, { extend_trial_days: 5 });
    const plan = res.body.institutes.find((i) => i.slug === APEX).plan;
    assert.equal(plan.status, 'trial');
    assert.equal(plan.days_left, 5);
  });

  it('can close sales: no new trials, no checkout', async () => {
    await opsCall('PUT', '/receptionist/settings', { sales_open: false });
    try {
      const fresh = await signup('nova-academy', 'Nova Academy', 'owner@nova.test', 'coaching');
      const on = await call('PATCH', '/api/coaching/admissions/assistant', { ai_receptionist: true }, { token: fresh, tenant: 'nova-academy' });
      assert.equal(on.status, 402);
      assert.equal(on.body.details.code, 'receptionist_plan_required');
      const buy = await call('POST', '/api/coaching/admissions/assistant/checkout', { months: 1 }, { token: fresh, tenant: 'nova-academy' });
      assert.equal(buy.status, 400);
    } finally {
      await opsCall('PUT', '/receptionist/settings', { sales_open: true });
    }
  });
});
