import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

/**
 * The staff bell (src/staffAlerts.js): who gets which alert by role, a member
 * claiming an online payment alerting the people who can confirm it (inbox +
 * Web Push with a link to the confirm queue), each person's own switches, the
 * morning expiry / overdue-fee digests, and a WhatsApp chat handed to staff.
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-staff-alerts-test-'));
process.env.DB_FILE = path.join(tmpDir, 'default.db');
process.env.PLATFORM_DB_FILE = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.AUTH_SECRET = 'test-secret';
process.env.WHATSAPP_TRANSPORT = 'memory';
process.env.WHATSAPP_MESSAGE_GAP_MS = '0';

const { createApp } = await import('../src/app.js');
const { closeDb, get, run, tenantStorage } = await import('../src/db.js');
const { closeRegistryDb, tenantDbPath } = await import('../src/tenants.js');
const webPush = await import('../src/webPush.js');
const { settlePushDeliveries } = await import('../src/notifications.js');
const { sweepStaffAlerts } = await import('../src/staffAlerts.js');
const { flagForStaff } = await import('../src/waChat.js');
const { memberToken } = await import('./helpers/memberAuth.js');

const GYM = 'pulse-gym';
const ACADEMY = 'bright-academy';

/** Every push the server tries to send, instead of a real push service. */
const sent = [];
webPush.setPushTransport(async (url, init) => {
  sent.push({ url, body: init.body });
  return { status: 201, text: async () => '' };
});

function fakeBrowser(name) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16).toString('base64url');
  return {
    privateKey: ecdh.getPrivateKey().toString('base64url'),
    auth,
    json: { endpoint: `https://push.example.test/send/${name}`, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth } },
  };
}
const readPush = (browser, delivery) =>
  JSON.parse(webPush.decryptPayload({ privateKey: browser.privateKey, auth: browser.auth }, delivery.body).toString('utf8'));

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
const as = (who, method, urlPath, body, slug = GYM) => call(method, urlPath, body, { token: tokens[who], slug });

/** The gym's database, pinned to UTC so "09:00" in a test is 09:00 on the gym's clock. */
const inTenant = (slug, businessType, fn) =>
  tenantStorage.run({ slug, dbFile: tenantDbPath(slug), businessType, timezone: 'UTC' }, fn);
const inGym = (fn) => inTenant(GYM, 'gym', fn);

const utcDate = (offsetDays = 0) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
const at = (hhmm) => new Date(`${utcDate()}T${hhmm}:00Z`);

async function signup(slug, name, email, businessType) {
  const res = await call(
    'POST',
    '/api/platform/signup',
    { slug, gym_name: name, admin_name: 'Owner', admin_email: email, admin_password: 'strongpass123', business_type: businessType, currency: 'INR' },
    { slug: null },
  );
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.token;
}

async function addStaff(key, role) {
  const email = `${key}@pulse.test`;
  const created = await as('admin', 'POST', '/api/staff', { name: `${key} person`, email, password: 'staffpass123', role });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  tokens[key] = (await call('POST', '/api/auth/login', { email, password: 'staffpass123' })).body.token;
  assert.ok(tokens[key]);
}

async function newMember(first) {
  const res = await as('admin', 'POST', '/api/members', {
    first_name: first,
    last_name: 'Shah',
    phone: `98${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

const inbox = async (who, slug = GYM) => (await as(who, 'GET', '/api/staff-alerts', undefined, slug)).body;

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  root = `http://127.0.0.1:${server.address().port}`;
  tokens.admin = await signup(GYM, 'Pulse Gym', 'owner@pulse.test', 'gym');
  tokens.academy = await signup(ACADEMY, 'Bright Academy', 'owner@bright.test', 'coaching');
  await addStaff('manager', 'manager');
  await addStaff('desk', 'staff');
  await addStaff('coach', 'trainer');
});

after(() => {
  server.close();
  closeDb();
  closeRegistryDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('staff alerts at a gym', () => {
  const adminBrowser = fakeBrowser('owner-laptop');

  it('offers each role the alerts it can act on', async () => {
    const keys = async (who) => (await as(who, 'GET', '/api/staff-alerts/config')).body.kinds.map((k) => k.key);
    assert.deepEqual(await keys('admin'), ['payment_claim', 'membership_expired', 'membership_expiring', 'trial_booked', 'chat_handoff']);
    assert.deepEqual(await keys('manager'), await keys('admin'));
    assert.deepEqual(await keys('desk'), ['membership_expired', 'membership_expiring', 'trial_booked', 'chat_handoff']);
    // A trainer cannot confirm payments, and answering WhatsApp is the desk's job.
    assert.deepEqual(await keys('coach'), ['membership_expired', 'membership_expiring', 'trial_booked']);

    const config = (await as('coach', 'GET', '/api/staff-alerts/config')).body;
    assert.equal(config.preferences.membership_expired, true, 'everything is on until switched off');
    assert.equal(config.devices, 0);
    assert.ok(config.public_key);
    assert.equal((await call('GET', '/api/staff-alerts/config')).status, 401);
  });

  it('a member claiming an online payment alerts admin and manager, with a push that opens the confirm queue', async () => {
    const registered = await as('admin', 'POST', '/api/staff-alerts/subscriptions', {
      ...adminBrowser.json,
      platform: 'desktop',
      path_prefix: `/g/${GYM}`,
    });
    assert.equal(registered.status, 201, JSON.stringify(registered.body));
    assert.equal(registered.body.devices, 1);

    assert.equal((await as('admin', 'PUT', '/api/online-payments/settings', { enabled: true, upi_vpa: 'pulsegym@okicici' })).status, 200);
    const member = await newMember('Neha');
    const memberAuth = await memberToken(call, { staffToken: tokens.admin, memberId: member.id, slug: GYM });
    const plan = (await as('admin', 'GET', '/api/plans')).body.items.find((p) => p.active);
    const request = (await call('POST', '/api/portal/pay', { kind: 'membership', plan_id: plan.id }, { token: memberAuth })).body;

    sent.length = 0;
    const claimed = await call('POST', `/api/portal/pay/${request.id}/claim`, { utr: '412345678901' }, { token: memberAuth });
    assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
    await settlePushDeliveries();

    const adminInbox = await inbox('admin');
    assert.equal(adminInbox.unread, 1);
    const [alert] = adminInbox.items;
    assert.equal(alert.kind, 'payment_claim');
    assert.equal(alert.link, '/billing/confirm');
    assert.match(alert.title, /^₹[\d,]+ to confirm$/);
    assert.match(alert.body, /Neha Shah/);
    assert.match(alert.body, /UTR 412345678901/);

    assert.equal((await inbox('manager')).unread, 1);
    assert.equal((await inbox('desk')).unread, 0, 'the desk cannot confirm payments');
    assert.equal((await inbox('coach')).unread, 0);

    assert.equal(sent.length, 1, 'only the admin registered a browser');
    const push = readPush(adminBrowser, sent[0]);
    assert.equal(push.title, `Pulse Gym: ${alert.title}`);
    assert.equal(push.url, `/g/${GYM}/#/billing/confirm`);
    assert.equal(push.category, 'staff:payment_claim');
    assert.equal(push.unread, 1);

    // Claiming twice is a no-op for the member, and alerts nobody twice.
    await call('POST', `/api/portal/pay/${request.id}/claim`, {}, { token: memberAuth });
    assert.equal((await inbox('admin')).unread, 1);
  });

  it("follows each person's own switches, and ignores ones their role cannot have", async () => {
    const off = await as('manager', 'PUT', '/api/staff-alerts/preferences', { payment_claim: false });
    assert.equal(off.status, 200);
    assert.equal(off.body.payment_claim, false);
    const trainer = await as('coach', 'PUT', '/api/staff-alerts/preferences', { payment_claim: true, trial_booked: false });
    assert.equal(trainer.body.payment_claim, undefined, 'a trainer cannot opt in to payment alerts');
    assert.equal(trainer.body.trial_booked, false);

    const member = await newMember('Ravi');
    const memberAuth = await memberToken(call, { staffToken: tokens.admin, memberId: member.id, slug: GYM });
    const plan = (await as('admin', 'GET', '/api/plans')).body.items.find((p) => p.active);
    const request = (await call('POST', '/api/portal/pay', { kind: 'membership', plan_id: plan.id }, { token: memberAuth })).body;
    await call('POST', `/api/portal/pay/${request.id}/claim`, {}, { token: memberAuth });
    await settlePushDeliveries();

    assert.equal((await inbox('admin')).unread, 2);
    assert.equal((await inbox('manager')).unread, 1, 'switched off: nothing new');
    await as('manager', 'PUT', '/api/staff-alerts/preferences', { payment_claim: true });
  });

  it("marks alerts read for that person only", async () => {
    const before = await inbox('admin');
    const one = await as('admin', 'POST', '/api/staff-alerts/read', { ids: [before.items[0].id] });
    assert.equal(one.body.unread, before.unread - 1);
    // Someone else's id is not theirs to mark: it changes neither inbox.
    await as('manager', 'POST', '/api/staff-alerts/read', { ids: [before.items[1].id] });
    assert.equal((await inbox('admin')).unread, before.unread - 1);
    assert.equal((await inbox('manager')).unread, 1);

    assert.equal((await as('admin', 'POST', '/api/staff-alerts/read', {})).body.unread, 0);
    assert.equal((await as('admin', 'GET', '/api/staff-alerts/unread')).body.unread, 0);
    assert.equal((await inbox('manager')).unread, 1, "the admin's mark-all does not touch the manager's copy");
    assert.equal((await as('manager', 'POST', '/api/staff-alerts/read', {})).body.unread, 0);
  });

  it('sends a morning digest of last night’s expiries and the ones ending soon, once a day', async () => {
    const ana = await newMember('Ana');
    const ben = await newMember('Ben');
    const cara = await newMember('Cara');
    inGym(() => {
      const planId = get('SELECT id FROM plans WHERE active = 1 LIMIT 1').id;
      const sub = (memberId, start, end, status = 'active') =>
        run('INSERT INTO subscriptions (member_id, plan_id, start_date, end_date, price, status) VALUES (?, ?, ?, ?, 1000, ?)', [
          memberId,
          planId,
          start,
          end,
          status,
        ]);
      sub(ana.id, utcDate(-31), utcDate(-1), 'expired');
      // Ben ran out too, but already bought the next month: not news.
      sub(ben.id, utcDate(-31), utcDate(-1), 'expired');
      sub(ben.id, utcDate(0), utcDate(30));
      sub(cara.id, utcDate(-27), utcDate(3));
    });

    await inGym(() => sweepStaffAlerts({ now: at('07:30') }));
    assert.equal((await inbox('coach')).unread, 0, 'nothing before 08:00');

    await inGym(() => sweepStaffAlerts({ now: at('09:00') }));
    const items = (await inbox('coach')).items;
    const expired = items.find((i) => i.kind === 'membership_expired');
    const expiring = items.find((i) => i.kind === 'membership_expiring');
    assert.equal(expired.title, '1 membership expired yesterday');
    assert.match(expired.body, /^Ana Shah — not renewed yet/);
    assert.doesNotMatch(expired.body, /Ben/);
    assert.equal(expired.link, '/billing/expired');
    assert.equal(expiring.title, '1 membership ends in 3 days');
    assert.match(expiring.body, /^Cara Shah/);
    assert.equal(expiring.link, '/billing/expiring');
    assert.equal((await inbox('desk')).unread, 2);

    await inGym(() => sweepStaffAlerts({ now: at('11:00') }));
    assert.equal((await inbox('coach')).unread, 2, 'the same day never digests twice');
  });

  it('alerts the desk once when the WhatsApp assistant hands a chat over', async () => {
    const before = { desk: (await inbox('desk')).unread, coach: (await inbox('coach')).unread };
    inGym(() => {
      run("INSERT INTO wa_conversations (jid, phone, contact_name) VALUES ('919800000001@s.whatsapp.net', '919800000001', 'Kabir')");
      const conv = get("SELECT * FROM wa_conversations WHERE phone = '919800000001'");
      flagForStaff(conv, 'Wants a corporate rate for 12 people');
      flagForStaff(conv, 'Asked again');
    });
    await settlePushDeliveries();
    const items = (await inbox('desk')).items.filter((i) => i.kind === 'chat_handoff');
    assert.equal(items.length, 1, 'raised once, alerted once');
    assert.equal(items[0].title, 'WhatsApp: Kabir needs a reply');
    assert.equal(items[0].body, 'Wants a corporate rate for 12 people');
    assert.equal(items[0].link, '/trials');
    assert.equal((await inbox('desk')).unread, before.desk + 1);
    assert.equal((await inbox('coach')).unread, before.coach, 'not a trainer alert');
  });

  it('needs a registered device for a test, and lets the next person on a browser release it', async () => {
    assert.equal((await as('coach', 'POST', '/api/staff-alerts/test', {})).status, 400);

    sent.length = 0;
    const test = await as('admin', 'POST', '/api/staff-alerts/test', {});
    assert.equal(test.status, 200);
    assert.equal(test.body.delivered, 1);
    assert.equal(readPush(adminBrowser, sent[0]).title, 'Pulse Gym: Notifications are on ✅');

    // The desk signs in on the owner's laptop: the browser stops getting the owner's alerts.
    const released = await as('desk', 'DELETE', '/api/staff-alerts/subscriptions', { endpoint: adminBrowser.json.endpoint });
    assert.equal(released.status, 200);
    assert.equal((await as('admin', 'GET', '/api/staff-alerts/config')).body.devices, 0);
  });

  it('refuses a subscription that is not a real one', async () => {
    const bad = await as('desk', 'POST', '/api/staff-alerts/subscriptions', { endpoint: 'http://evil.test/x', keys: {} });
    assert.equal(bad.status, 400);
  });
});

describe('staff alerts at a coaching institute', () => {
  it('offers overdue fees, demo bookings and website enquiries instead of membership expiries', async () => {
    const kinds = (await call('GET', '/api/staff-alerts/config', undefined, { token: tokens.academy, slug: ACADEMY })).body.kinds;
    assert.deepEqual(
      kinds.map((k) => k.key),
      ['payment_claim', 'fees_overdue', 'trial_booked', 'website_enquiry', 'chat_handoff'],
    );
    assert.equal(kinds.find((k) => k.key === 'trial_booked').label, 'Demo classes booked');
  });

  it('digests installments that fell due yesterday and are still unpaid', async () => {
    const student = (
      await call('POST', '/api/members', { first_name: 'Isha', last_name: 'Rao', phone: '9811122233' }, { token: tokens.academy, slug: ACADEMY })
    ).body;
    inTenant(ACADEMY, 'coaching', () => {
      const course = run("INSERT INTO academic_courses (name, academic_year) VALUES ('JEE 2027', '2026-27')").lastInsertRowid;
      const plan = run(
        'INSERT INTO student_fee_plans (member_id, course_id, total_amount, final_amount) VALUES (?, ?, 30000, 30000)',
        [student.id, course],
      ).lastInsertRowid;
      run('INSERT INTO student_fee_installments (plan_id, installment_number, amount_due, due_date) VALUES (?, 1, 15000, ?)', [plan, utcDate(-1)]);
      run('INSERT INTO student_fee_installments (plan_id, installment_number, amount_due, due_date) VALUES (?, 2, 15000, ?)', [plan, utcDate(30)]);
    });
    await inTenant(ACADEMY, 'coaching', () => sweepStaffAlerts({ now: at('09:00') }));
    const { items } = (await call('GET', '/api/staff-alerts', undefined, { token: tokens.academy, slug: ACADEMY })).body;
    const [overdue] = items.filter((i) => i.kind === 'fees_overdue');
    assert.equal(overdue.title, '1 installment overdue · ₹15,000');
    assert.match(overdue.body, /^Isha Rao — due yesterday/);
    assert.equal(overdue.link, '/fees');
  });
});
