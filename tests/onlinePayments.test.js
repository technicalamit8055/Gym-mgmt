import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

/**
 * Members paying online to the gym's own UPI ID: the desk switching it on,
 * a member asking to pay (amount always the server's), the UPI link and QR,
 * "I've paid" with a UTR, and the desk confirming — which is the only thing
 * that creates the membership or payment. Also a CoachBook installment, the
 * public pay link a reminder carries, and expiry.
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-online-pay-test-'));
process.env.DB_FILE = path.join(tmpDir, 'default.db');
process.env.PLATFORM_DB_FILE = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.AUTH_SECRET = 'test-secret';
process.env.WHATSAPP_TRANSPORT = 'memory';
process.env.WHATSAPP_MESSAGE_GAP_MS = '0';

const { createApp } = await import('../src/app.js');
const { closeDb, get, run, tenantStorage } = await import('../src/db.js');
const { closeRegistryDb, tenantDbPath } = await import('../src/tenants.js');
const { addDays, today } = await import('../src/validate.js');
const { expireStaleRequests, payLinkFor, upiUri, withPayLink } = await import('../src/onlinePayments.js');
const { memberToken } = await import('./helpers/memberAuth.js');

const GYM = 'pulse-gym';
const ACADEMY = 'bright-academy';

let root;
let server;
const tokens = {};

const call = async (method, urlPath, body, { token, slug = GYM } = {}) => {
  const res = await fetch(`${root}${slug ? `/g/${slug}` : ''}${urlPath}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const staff = (method, urlPath, body, slug = GYM) => call(method, urlPath, body, { token: tokens[slug], slug });

const inTenant = (slug, businessType, fn) => tenantStorage.run({ slug, dbFile: tenantDbPath(slug), businessType }, fn);

async function signup(slug, name, email, businessType) {
  const res = await call(
    'POST',
    '/api/platform/signup',
    { slug, gym_name: name, admin_name: 'Owner', admin_email: email, admin_password: 'strongpass123', business_type: businessType, currency: 'INR' },
    { slug: null },
  );
  assert.equal(res.status, 201, JSON.stringify(res.body));
  tokens[slug] = res.body.token;
}

async function newMember(first, slug = GYM) {
  const res = await staff('POST', '/api/members', { first_name: first, last_name: 'Shah', phone: `98${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}` }, slug);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  root = `http://127.0.0.1:${server.address().port}`;
  await signup(GYM, 'Pulse Gym', 'owner@pulse.test', 'gym');
  await signup(ACADEMY, 'Bright Academy', 'owner@bright.test', 'coaching');
});

after(() => {
  server.close();
  closeDb();
  closeRegistryDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('the UPI link and reminder text', () => {
  it('builds an NPCI upi://pay link with the amount and reference', () => {
    const uri = upiUri({ amount: 1499, ref_code: 'GBABC234', title: 'Monthly renewal' }, { upi_vpa: 'pulse@okaxis', payee_name: 'Pulse Gym' });
    const params = new URL(uri.replace('upi://', 'https://x/')).searchParams;
    assert.ok(uri.startsWith('upi://pay?'));
    assert.equal(params.get('pa'), 'pulse@okaxis');
    assert.equal(params.get('pn'), 'Pulse Gym');
    assert.equal(params.get('am'), '1499.00');
    assert.equal(params.get('cu'), 'INR');
    assert.equal(params.get('tr'), 'GBABC234');
    assert.ok(!uri.includes('+'), 'spaces are %20, not +');
    assert.ok(uri.includes('pa=pulse@okaxis'), 'the @ stays literal — some UPI apps do not decode %40');
  });

  it('puts the link where {{pay_link}} is, appends it otherwise, and drops the placeholder without one', () => {
    assert.equal(withPayLink('Renew now: {{pay_link}}', 'https://x/pay'), 'Renew now: https://x/pay');
    assert.equal(withPayLink('Renew soon.', 'https://x/pay'), 'Renew soon.\n\nPay online: https://x/pay');
    assert.equal(withPayLink('Renew now: {{pay_link}}', null), 'Renew now:');
    assert.equal(withPayLink('Renew soon.', null), 'Renew soon.');
    assert.equal(payLinkFor({ token: 'abc' }, 'https://g.test/g/x/'), 'https://g.test/g/x/#/pay?token=abc');
  });
});

describe('online payments at a gym', () => {
  let member;
  let memberAuth;
  let plan;
  let request;

  before(async () => {
    member = await newMember('Neha');
    memberAuth = await memberToken(call, { staffToken: tokens[GYM], memberId: member.id, slug: GYM });
    plan = (await staff('GET', '/api/plans')).body.items.find((p) => p.active);
    assert.ok(plan, 'signup seeds starter plans');
  });

  const asMember = (method, urlPath, body) => call(method, urlPath, body, { token: memberAuth });

  it('is off until the gym sets a UPI ID, and refuses a bad one', async () => {
    const state = await asMember('GET', '/api/portal/pay');
    assert.equal(state.status, 200);
    assert.equal(state.body.enabled, false);
    const refused = await asMember('POST', '/api/portal/pay', { kind: 'membership', plan_id: plan.id });
    assert.equal(refused.status, 400);

    assert.equal((await staff('PUT', '/api/online-payments/settings', { enabled: true })).status, 400, 'no UPI ID yet');
    const bad = await staff('PUT', '/api/online-payments/settings', { upi_vpa: 'not a vpa' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.details.upi_vpa, 'invalid UPI ID');

    const saved = await staff('PUT', '/api/online-payments/settings', { enabled: true, upi_vpa: 'pulsegym@okicici', payee_name: 'Pulse Gym' });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const settings = await staff('GET', '/api/online-payments/settings');
    assert.equal(settings.body.live, true);
    assert.match(settings.body.sample_qr, /^data:image\/png;base64,/);
  });

  it('keeps the settings and queue away from trainers and members', async () => {
    assert.equal((await call('GET', '/api/online-payments/requests', undefined, { token: memberAuth })).status, 401);
    assert.equal((await call('GET', '/api/online-payments/settings')).status, 401);
  });

  it('prices a renewal from the plan, ignoring any amount the app sends, and reuses an open request', async () => {
    const res = await asMember('POST', '/api/portal/pay', { kind: 'membership', plan_id: plan.id, amount: 1 });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    request = res.body;
    assert.equal(request.amount, plan.price);
    assert.equal(request.status, 'pending');
    assert.match(request.ref_code, /^GB[A-Z2-9]{6}$/);
    assert.ok(request.upi_uri.includes(`am=${plan.price.toFixed(2)}`));
    assert.match(request.qr, /^data:image\/png;base64,/);

    const again = await asMember('POST', '/api/portal/pay', { kind: 'membership', plan_id: plan.id });
    assert.equal(again.body.id, request.id, 'a second tap returns the same request');
  });

  it('grants nothing on "I\'ve paid", and checks the UTR', async () => {
    const short = await asMember('POST', `/api/portal/pay/${request.id}/claim`, { utr: '1234' });
    assert.equal(short.status, 400);
    const claimed = await asMember('POST', `/api/portal/pay/${request.id}/claim`, { utr: '4123 5678 9012' });
    assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
    assert.equal(claimed.body.status, 'claimed');
    assert.equal(claimed.body.utr, '412356789012');
    assert.equal(claimed.body.upi_uri, null, 'a claimed request is no longer payable');

    const subs = await staff('GET', `/api/subscriptions?member_id=${member.id}`);
    assert.equal(subs.body.items.length, 0, 'no membership before the desk confirms');

    const queue = await staff('GET', '/api/online-payments/requests');
    assert.equal(queue.body.claimed, 1);
    assert.equal(queue.body.items[0].id, request.id);
    assert.equal(queue.body.items[0].member_code, member.code);
  });

  it('refuses the same UTR on a second payment', async () => {
    const other = await newMember('Rohan');
    const otherAuth = await memberToken(call, { staffToken: tokens[GYM], memberId: other.id, slug: GYM });
    const req2 = await call('POST', '/api/portal/pay', { kind: 'membership', plan_id: plan.id }, { token: otherAuth });
    const reused = await call('POST', `/api/portal/pay/${req2.body.id}/claim`, { utr: '412356789012' }, { token: otherAuth });
    assert.equal(reused.status, 409);
    // Someone else's request is not theirs to claim.
    assert.equal((await call('POST', `/api/portal/pay/${request.id}/claim`, {}, { token: otherAuth })).status, 404);
  });

  it('confirming creates the membership and a UPI payment, once', async () => {
    const res = await staff('POST', `/api/online-payments/requests/${request.id}/confirm`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.request.status, 'confirmed');
    assert.ok(res.body.payment_id);

    const subs = (await staff('GET', `/api/subscriptions?member_id=${member.id}`)).body.items;
    assert.equal(subs.length, 1);
    assert.equal(subs[0].plan_id, plan.id);
    assert.equal(subs[0].start_date, inTenant(GYM, 'gym', today));
    assert.equal(subs[0].due, 0, 'paid in full');
    const pay = inTenant(GYM, 'gym', () => get('SELECT * FROM payments WHERE id = ?', [res.body.payment_id]));
    assert.equal(pay.method, 'upi');
    assert.equal(pay.reference, 'UPI 412356789012');

    const twice = await staff('POST', `/api/online-payments/requests/${request.id}/confirm`);
    assert.equal(twice.body.already, true);
    assert.equal((await staff('GET', `/api/subscriptions?member_id=${member.id}`)).body.items.length, 1, 'still one membership');

    const notes = await asMember('GET', '/api/portal/notifications');
    assert.ok(JSON.stringify(notes.body).includes('Payment received'), 'the member is told');
  });

  it('a renewal paid while still a member starts the day after the current one ends', async () => {
    const res = await asMember('POST', '/api/portal/pay', { kind: 'membership', plan_id: plan.id });
    assert.equal(res.status, 201);
    await asMember('POST', `/api/portal/pay/${res.body.id}/claim`, {});
    assert.equal((await staff('POST', `/api/online-payments/requests/${res.body.id}/confirm`)).status, 200);
    const subs = (await staff('GET', `/api/subscriptions?member_id=${member.id}`)).body.items.sort((a, b) => a.start_date.localeCompare(b.start_date));
    assert.equal(subs.length, 2);
    assert.equal(subs[1].start_date, addDays(subs[0].end_date, 1));
  });

  it('pays dues on a membership the desk sold on credit', async () => {
    const debtor = await newMember('Arjun');
    const sold = await staff('POST', '/api/subscriptions', { member_id: debtor.id, plan_id: plan.id, payment_amount: 100 });
    assert.equal(sold.status, 201, JSON.stringify(sold.body));
    const auth = await memberToken(call, { staffToken: tokens[GYM], memberId: debtor.id, slug: GYM });
    const state = await call('GET', '/api/portal/pay', undefined, { token: auth });
    assert.equal(state.body.dues.length, 1);
    assert.equal(state.body.dues[0].due, plan.price - 100);

    const res = await call('POST', '/api/portal/pay', { kind: 'dues', subscription_id: sold.body.id }, { token: auth });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.amount, plan.price - 100);
    await call('POST', `/api/portal/pay/${res.body.id}/claim`, {}, { token: auth });
    assert.equal((await staff('POST', `/api/online-payments/requests/${res.body.id}/confirm`)).status, 200);
    const after = await call('GET', '/api/portal/pay', undefined, { token: auth });
    assert.equal(after.body.dues.length, 0, 'nothing owed any more');
  });

  it('a rejected payment tells the member and cannot then be confirmed', async () => {
    const res = await asMember('POST', '/api/portal/pay', { kind: 'membership', plan_id: plan.id });
    await asMember('POST', `/api/portal/pay/${res.body.id}/claim`, {});
    const rejected = await staff('POST', `/api/online-payments/requests/${res.body.id}/reject`, { reason: 'Not in our account.' });
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.request.status, 'rejected');
    assert.equal(rejected.body.request.reject_reason, 'Not in our account.');
    assert.equal((await staff('POST', `/api/online-payments/requests/${res.body.id}/confirm`)).status, 409);
    const mine = await asMember('GET', `/api/portal/pay/${res.body.id}`);
    assert.equal(mine.body.status, 'rejected');
  });

  it('opens a pay link with no sign-in, showing only that one payment', async () => {
    const res = await asMember('POST', '/api/portal/pay', { kind: 'membership', plan_id: plan.id });
    const token = inTenant(GYM, 'gym', () => get('SELECT token FROM payment_requests WHERE id = ?', [res.body.id]).token);
    const page = await call('GET', `/api/pay/${token}`);
    assert.equal(page.status, 200, JSON.stringify(page.body));
    assert.equal(page.body.amount, plan.price);
    assert.equal(page.body.first_name, 'Neha');
    assert.equal(page.body.gym_name, 'Pulse Gym');
    assert.equal(page.body.phone, undefined, 'no contact details on a public page');
    assert.equal(page.body.member_id, undefined);
    assert.equal((await call('GET', '/api/pay/not-a-real-token')).status, 404);

    const claimed = await call('POST', `/api/pay/${token}/claim`, { utr: '998877665544' });
    assert.equal(claimed.body.status, 'claimed');
  });

  it('while one is waiting for the desk, paying the same plan again shows that one', async () => {
    const res = await asMember('POST', '/api/portal/pay', { kind: 'membership', plan_id: plan.id });
    assert.equal(res.body.status, 'claimed', 'the pay-link claim above is still open');
  });

  it('expires requests nobody paid, but leaves claimed ones for the desk', async () => {
    const latecomer = await newMember('Isha');
    const auth = await memberToken(call, { staffToken: tokens[GYM], memberId: latecomer.id, slug: GYM });
    const asLatecomer = (m, u, b) => call(m, u, b, { token: auth });
    const res = await asLatecomer('POST', '/api/portal/pay', { kind: 'membership', plan_id: plan.id });
    inTenant(GYM, 'gym', () => run("UPDATE payment_requests SET expires_at = '2000-01-01 00:00:00' WHERE status IN ('pending', 'claimed')"));
    const expired = inTenant(GYM, 'gym', expireStaleRequests);
    assert.ok(expired >= 1);
    assert.equal(inTenant(GYM, 'gym', () => get('SELECT status FROM payment_requests WHERE id = ?', [res.body.id]).status), 'expired');
    assert.ok(inTenant(GYM, 'gym', () => get("SELECT COUNT(*) AS n FROM payment_requests WHERE status = 'claimed'").n) >= 1);
    // A fresh tap after expiry starts a new request.
    const fresh = await asLatecomer('POST', '/api/portal/pay', { kind: 'membership', plan_id: plan.id });
    assert.notEqual(fresh.body.id, res.body.id);
  });
});

describe('online payments at a coaching institute', () => {
  it('pays one fee installment and splits it onto that installment', async () => {
    const student = await newMember('Aarav', ACADEMY);
    const course = (await staff('GET', '/api/coaching/courses', undefined, ACADEMY)).body.items[0];
    const plan = await staff(
      'POST',
      '/api/coaching/fees/plans',
      {
        member_id: student.id,
        course_id: course.id,
        total_amount: 10000,
        schedule: [
          { amount_due: 4000, due_date: today() },
          { amount_due: 6000, due_date: addDays(today(), 30) },
        ],
      },
      ACADEMY,
    );
    assert.equal(plan.status, 201, JSON.stringify(plan.body));
    const [first, second] = plan.body.installments;

    await staff('PUT', '/api/online-payments/settings', { enabled: true, upi_vpa: 'bright@okhdfcbank' }, ACADEMY);
    const auth = await memberToken(call, { staffToken: tokens[ACADEMY], memberId: student.id, slug: ACADEMY });
    const asStudent = (m, u, b) => call(m, u, b, { token: auth, slug: ACADEMY });

    assert.equal((await asStudent('POST', '/api/portal/pay', { kind: 'membership', plan_id: 1 })).status, 400, 'no gym renewals here');
    const res = await asStudent('POST', '/api/portal/pay', { kind: 'fee_installment', installment_id: second.id });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.amount, 6000);
    assert.equal(res.body.title, 'Fee installment 2');
    await asStudent('POST', `/api/portal/pay/${res.body.id}/claim`, { utr: '111122223333' });

    const confirmed = await staff('POST', `/api/online-payments/requests/${res.body.id}/confirm`, undefined, ACADEMY);
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    const fees = await asStudent('GET', '/api/portal/coaching/fees');
    const insts = fees.body.plans[0].installments;
    assert.equal(insts.find((i) => i.id === second.id).balance, 0, 'the installment chosen is paid');
    assert.equal(insts.find((i) => i.id === first.id).balance, 4000, 'the other is untouched');
    assert.equal((await asStudent('POST', '/api/portal/pay', { kind: 'fee_installment', installment_id: second.id })).status, 400, 'nothing left to pay');
  });
});
