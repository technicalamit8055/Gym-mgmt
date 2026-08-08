import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-whatsapp-test-'));
process.env.DB_FILE = path.join(tmpDir, 'default.db');
process.env.PLATFORM_DB_FILE = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.WHATSAPP_AUTH_DIR = path.join(tmpDir, 'whatsapp_auth');
process.env.AUTH_SECRET = 'test-secret';

const { createApp } = await import('../src/app.js');
const { closeDb, tenantStorage } = await import('../src/db.js');
const { closeRegistryDb, tenantDbPath } = await import('../src/tenants.js');
const { addDays, today } = await import('../src/validate.js');
const { formatPhoneNumber, getWhatsAppStatus, hasStoredCredentials, renderTemplate, reminderMessage } =
  await import('../src/whatsapp.js');
const { sendAutomatedRenewalReminders } = await import('../src/maintenance.js');

let base;
let server;

const call = async (method, urlPath, body, { token, tenant } = {}) => {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(tenant ? { 'X-Tenant-Slug': tenant } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

const signup = (slug, gymName) =>
  call('POST', '/api/platform/signup', {
    slug,
    gym_name: gymName,
    admin_name: 'Owner',
    admin_email: `owner@${slug}.test`,
    admin_password: 'ownerpass123',
  });

const login = (slug, email = `owner@${slug}.test`, password = 'ownerpass123') =>
  call('POST', '/api/auth/login', { email, password }, { tenant: slug });

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  closeDb();
  closeRegistryDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('phone numbers are normalised into WhatsApp JIDs', () => {
  it('adds the default country code to a bare national number', () => {
    assert.equal(formatPhoneNumber('9876543210'), '919876543210@s.whatsapp.net');
  });

  it('strips the punctuation staff actually type', () => {
    assert.equal(formatPhoneNumber('+91 98765-43210'), '919876543210@s.whatsapp.net');
    assert.equal(formatPhoneNumber('(987) 654 3210'), '919876543210@s.whatsapp.net');
  });

  it('drops a trunk zero rather than sending it as part of the country code', () => {
    assert.equal(formatPhoneNumber('09876543210'), '919876543210@s.whatsapp.net');
  });

  it('leaves a number that already carries a country code alone', () => {
    assert.equal(formatPhoneNumber('919876543210'), '919876543210@s.whatsapp.net');
    assert.equal(formatPhoneNumber('+1 415 555 0132'), '14155550132@s.whatsapp.net');
  });

  it('rejects anything that cannot be a phone number', () => {
    assert.equal(formatPhoneNumber(null), null);
    assert.equal(formatPhoneNumber(''), null);
    assert.equal(formatPhoneNumber('not a phone'), null);
    assert.equal(formatPhoneNumber('000'), null);
    assert.equal(formatPhoneNumber('1234567890123456789'), null);
  });
});

describe('message templates', () => {
  it('substitutes every supplied placeholder', () => {
    assert.equal(
      renderTemplate('Hi {{first_name}}, pay {{amount}} for {{plan_name}} to {{gym_name}}', {
        first_name: 'Rahul',
        amount: 1500,
        plan_name: 'Monthly Gym',
        gym_name: 'Iron House Gym',
      }),
      'Hi Rahul, pay 1500 for Monthly Gym to Iron House Gym',
    );
  });

  it('tolerates whitespace inside the braces', () => {
    assert.equal(renderTemplate('Hi {{  first_name  }}', { first_name: 'Asha' }), 'Hi Asha');
  });

  it('leaves an unknown placeholder visible so a template typo is obvious', () => {
    assert.equal(renderTemplate('Hi {{frist_name}}', { first_name: 'Asha' }), 'Hi {{frist_name}}');
  });

  it('renders a zero rather than treating it as missing', () => {
    assert.equal(renderTemplate('Due: {{amount}}', { amount: 0 }), 'Due: 0');
  });
});

describe('WhatsApp API access control', () => {
  let adminToken;
  let trainerToken;

  before(async () => {
    assert.equal((await signup('wagym', 'Iron House Gym')).status, 201);
    adminToken = (await login('wagym')).body.token;

    const staff = await call(
      'POST',
      '/api/staff',
      { name: 'Trainer Tara', email: 'trainer@wagym.test', password: 'trainerpass123', role: 'trainer' },
      { token: adminToken, tenant: 'wagym' },
    );
    assert.equal(staff.status, 201);
    trainerToken = (await login('wagym', 'trainer@wagym.test', 'trainerpass123')).body.token;
  });

  it('refuses an unauthenticated caller', async () => {
    assert.equal((await call('GET', '/api/whatsapp/status', null, { tenant: 'wagym' })).status, 401);
  });

  it('keeps a trainer out entirely — these endpoints send under the gym’s number', async () => {
    for (const [method, url] of [
      ['GET', '/api/whatsapp/status'],
      ['GET', '/api/whatsapp/settings'],
      ['GET', '/api/whatsapp/logs'],
      ['POST', '/api/whatsapp/connect'],
      ['POST', '/api/whatsapp/send-test'],
    ]) {
      const res = await call(method, url, method === 'POST' ? {} : null, {
        token: trainerToken,
        tenant: 'wagym',
      });
      assert.equal(res.status, 403, `${method} ${url} should be forbidden for a trainer`);
    }
  });

  it('lets a manager read status but never hands them the pairing QR', async () => {
    await call(
      'POST',
      '/api/staff',
      { name: 'Manager Mia', email: 'manager@wagym.test', password: 'managerpass123', role: 'manager' },
      { token: adminToken, tenant: 'wagym' },
    );
    const managerToken = (await login('wagym', 'manager@wagym.test', 'managerpass123')).body.token;

    const res = await call('GET', '/api/whatsapp/status', null, { token: managerToken, tenant: 'wagym' });
    assert.equal(res.status, 200);
    assert.equal(res.body.qr, null);

    // Pairing and unlinking stay with the owner.
    assert.equal(
      (await call('POST', '/api/whatsapp/connect', {}, { token: managerToken, tenant: 'wagym' })).status,
      403,
    );
    assert.equal(
      (await call('POST', '/api/whatsapp/logout', {}, { token: managerToken, tenant: 'wagym' })).status,
      403,
    );
  });
});

describe('settings are per gym', () => {
  let acmeToken;
  let boltToken;

  before(async () => {
    await signup('acmewa', 'Acme Fitness');
    await signup('boltwa', 'Bolt Fitness');
    acmeToken = (await login('acmewa')).body.token;
    boltToken = (await login('boltwa')).body.token;
  });

  it('starts from the column defaults', async () => {
    const res = await call('GET', '/api/whatsapp/settings', null, { token: acmeToken, tenant: 'acmewa' });
    assert.equal(res.status, 200);
    assert.equal(res.body.auto_receipt, 1);
    assert.equal(res.body.reminder_days_before, 3);
    assert.match(res.body.receipt_template, /\{\{first_name\}\}/);
  });

  it('round-trips a saved change', async () => {
    const saved = await call(
      'PUT',
      '/api/whatsapp/settings',
      {
        auto_receipt: '0',
        auto_reminder: '1',
        reminder_days_before: '7',
        receipt_template: 'Paid {{amount}} — {{gym_name}}',
        reminder_template: 'Expiring {{end_date}} — {{gym_name}}',
        welcome_template: 'Welcome {{first_name}}',
      },
      { token: acmeToken, tenant: 'acmewa' },
    );
    assert.equal(saved.status, 200);
    assert.equal(saved.body.auto_receipt, 0);
    assert.equal(saved.body.auto_reminder, 1);
    assert.equal(saved.body.reminder_days_before, 7);

    const reread = await call('GET', '/api/whatsapp/settings', null, { token: acmeToken, tenant: 'acmewa' });
    assert.equal(reread.body.receipt_template, 'Paid {{amount}} — {{gym_name}}');
  });

  it('does not leak one gym’s templates into another', async () => {
    const bolt = await call('GET', '/api/whatsapp/settings', null, { token: boltToken, tenant: 'boltwa' });
    assert.equal(bolt.body.reminder_days_before, 3);
    assert.match(bolt.body.receipt_template, /thank you for your payment/);
  });

  it('rejects a template that is missing or absurdly long', async () => {
    const res = await call(
      'PUT',
      '/api/whatsapp/settings',
      { receipt_template: '', reminder_template: 'x', welcome_template: 'y' },
      { token: acmeToken, tenant: 'acmewa' },
    );
    assert.equal(res.status, 400);
    assert.equal(res.body.details.receipt_template, 'is required');
  });
});

describe('sending while unlinked', () => {
  let token;
  let paymentId;

  before(async () => {
    await signup('sendwa', 'Sunrise Gym');
    token = (await login('sendwa')).body.token;
    const ctx = { token, tenant: 'sendwa' };

    await call('POST', '/api/members', { first_name: 'Asha', last_name: 'Menon', phone: '9990001111' }, ctx);
    await call('POST', '/api/plans', { name: 'Monthly', price: 1500, duration_days: 30 }, ctx);
    const sub = await call(
      'POST',
      '/api/subscriptions',
      { member_id: 1, plan_id: 1, start_date: today(), payment_amount: 1500 },
      ctx,
    );
    assert.equal(sub.status, 201);

    const payments = await call('GET', '/api/payments', null, ctx);
    paymentId = payments.body.items[0].id;
  });

  it('reports the gym as not connected', async () => {
    const res = await call('GET', '/api/whatsapp/status', null, { token, tenant: 'sendwa' });
    assert.equal(res.body.connected, false);
    assert.equal(res.body.state, 'DISCONNECTED');
  });

  it('fails a receipt send with a message that says what to do', async () => {
    const res = await call('POST', '/api/whatsapp/send-receipt', { payment_id: paymentId }, { token, tenant: 'sendwa' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /not connected/i);
  });

  it('records the failure in the delivery log rather than losing it', async () => {
    const logs = await call('GET', '/api/whatsapp/logs', null, { token, tenant: 'sendwa' });
    assert.equal(logs.status, 200);
    assert.equal(logs.body.items.length, 1);

    const [entry] = logs.body.items;
    assert.equal(entry.status, 'failed');
    assert.equal(entry.type, 'receipt');
    assert.equal(entry.phone, '9990001111');
    assert.equal(entry.first_name, 'Asha');
    assert.match(entry.error, /not connected/i);
  });

  it('renders the gym’s own name into the message, not a hardcoded default', async () => {
    const logs = await call('GET', '/api/whatsapp/logs', null, { token, tenant: 'sendwa' });
    assert.match(logs.body.items[0].message, /Sunrise Gym/);
    assert.doesNotMatch(logs.body.items[0].message, /GymBook|Gymbook/);
  });

  it('404s an unknown payment and 400s a missing id', async () => {
    assert.equal(
      (await call('POST', '/api/whatsapp/send-receipt', { payment_id: 99999 }, { token, tenant: 'sendwa' })).status,
      404,
    );
    assert.equal(
      (await call('POST', '/api/whatsapp/send-receipt', {}, { token, tenant: 'sendwa' })).status,
      400,
    );
  });

  it('recording a payment still succeeds when WhatsApp is unavailable', async () => {
    const res = await call(
      'POST',
      '/api/payments',
      { member_id: 1, amount: 200, method: 'cash', paid_on: today() },
      { token, tenant: 'sendwa' },
    );
    assert.equal(res.status, 201);
    assert.equal(res.body.amount, 200);
  });
});

describe('per-gym connection state', () => {
  it('keeps each gym’s socket, status and credentials separate', () => {
    assert.equal(getWhatsAppStatus('acmewa').connected, false);
    assert.equal(getWhatsAppStatus('boltwa').connected, false);
    assert.equal(hasStoredCredentials('acmewa'), false);
    assert.equal(hasStoredCredentials('boltwa'), false);
    // Distinct session records, not one shared object.
    assert.notEqual(getWhatsAppStatus('acmewa'), getWhatsAppStatus('boltwa'));
  });
});

describe('the renewal sweep', () => {
  it('does nothing while the gym is unlinked, however many members are expiring', async () => {
    const token = (await login('sendwa')).body.token;
    const ctx = { token, tenant: 'sendwa' };
    await call('POST', '/api/members', { first_name: 'Ravi', last_name: 'Kumar', phone: '9990002222' }, ctx);
    await call(
      'POST',
      '/api/subscriptions',
      { member_id: 2, plan_id: 1, start_date: today(), payment_amount: 0 },
      ctx,
    );

    const queued = tenantStorage.run({ slug: 'sendwa', dbFile: tenantDbPath('sendwa') }, () =>
      sendAutomatedRenewalReminders({ gymName: 'Sunrise Gym' }),
    );
    assert.equal(queued, 0);
  });

  it('builds the reminder from the gym name it is handed', () => {
    const message = reminderMessage(
      { first_name: 'Ravi', last_name: 'Kumar', plan_name: 'Monthly', end_date: addDays(today(), 3) },
      { gymName: 'Sunrise Gym', template: 'Hi {{first_name}}, {{plan_name}} ends {{end_date}} — {{gym_name}}' },
    );
    assert.equal(message, `Hi Ravi, Monthly ends ${addDays(today(), 3)} — Sunrise Gym`);
  });
});

const { generateReceiptPdf } = await import('../src/receiptPdf.js');

describe('PDF receipt generation', () => {
  it('generates a valid PDF buffer for a payment', async () => {
    const pdfBuffer = await generateReceiptPdf(
      {
        id: 101,
        amount: 2500,
        method: 'upi',
        paid_on: '2026-08-07',
        first_name: 'Rahul',
        last_name: 'Sharma',
        member_code: 'M001',
        phone: '9876543210',
        plan_name: 'Quarterly Membership',
        start_date: '2026-08-07',
        end_date: '2026-11-07',
      },
      { gymName: 'Iron House Gym' },
    );

    assert.ok(Buffer.isBuffer(pdfBuffer));
    assert.ok(pdfBuffer.length > 500);
    assert.equal(pdfBuffer.subarray(0, 4).toString(), '%PDF');
  });
});
