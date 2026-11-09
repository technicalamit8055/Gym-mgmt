import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-templates-test-'));
process.env.DB_FILE = path.join(tmpDir, 'default.db');
process.env.PLATFORM_DB_FILE = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.AUTH_SECRET = 'test-secret';

const { createApp } = await import('../src/app.js');
const { closeDb } = await import('../src/db.js');
const { closeRegistryDb } = await import('../src/tenants.js');
const { cleanTemplate, defaultTemplate } = await import('../src/printTemplates.js');
const { generateReceiptPdf, indianWords } = await import('../src/receiptPdf.js');

let base;
let server;

const call = async (method, urlPath, body, { token, tenant, raw = false } = {}) => {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(tenant ? { 'X-Tenant-Slug': tenant } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (raw) return { status: res.status, type: res.headers.get('content-type'), bytes: Buffer.from(await res.arrayBuffer()) };
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

const signupAndLogin = async (slug, extra = {}) => {
  const email = `owner@${slug}.test`;
  const res = await call('POST', '/api/platform/signup', {
    slug,
    gym_name: `${slug} place`,
    admin_name: 'Owner',
    admin_email: email,
    admin_password: 'ownerpass123',
    ...extra,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return (await call('POST', '/api/auth/login', { email, password: 'ownerpass123' }, { tenant: slug })).body.token;
};

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

describe('template validation', () => {
  it('accepts known values and drops unknown keys', () => {
    const out = cleanTemplate('receipt', { style: 'classic', accent: '#1E3A8A', show_signature: 'true', bogus: 1 });
    assert.deepEqual(out, { style: 'classic', accent: '#1e3a8a', show_signature: true });
  });

  it('rejects a bad style, colour or overlong text', () => {
    assert.throws(() => cleanTemplate('receipt', { style: 'fancy' }), /style must be one of/);
    assert.throws(() => cleanTemplate('id_card', { accent: 'red' }), /colour/);
    assert.throws(() => cleanTemplate('receipt', { footer_note: 'x'.repeat(200) }), /at most 120/);
    assert.throws(() => cleanTemplate('omr', { extra_fields: ['a', 'b', 'c', 'd', 'e'] }), /at most 4/);
  });

  it('keeps multi-line text for terms and instructions', () => {
    assert.equal(cleanTemplate('receipt', { terms: ' Line one \r\n\r\n\r\nLine two ' }).terms, 'Line one\n\nLine two');
  });
});

describe('receipt PDF', () => {
  it('spells amounts the Indian way', () => {
    assert.equal(indianWords(14999), 'Fourteen Thousand Nine Hundred Ninety-Nine');
    assert.equal(indianWords(1499950), 'Fourteen Lakh Ninety-Nine Thousand Nine Hundred Fifty');
    assert.equal(indianWords(25000000), 'Two Crore Fifty Lakh');
  });

  for (const style of ['modern', 'classic', 'minimal']) {
    it(`renders the ${style} style with the rupee sign embedded`, async () => {
      const pdf = await generateReceiptPdf(
        { id: 7, amount: 14999, method: 'upi', paid_on: '2026-11-06', first_name: 'Amit', last_name: 'Singh', plan_name: 'Quarterly', price: 15000, discount: 1 },
        { gymName: 'Iron House', template: { ...defaultTemplate('receipt'), style, terms: 'No refunds.', show_signature: true } },
      );
      assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
      // The embedded subset font is what draws "₹"; Helvetica alone cannot.
      assert.match(pdf.toString('latin1'), /NotoSans/);
    });
  }
});

describe('template routes', () => {
  let token;
  let staffToken;

  it('serves defaults to a fresh gym, without the OMR template', async () => {
    token = await signupAndLogin('tplgym');
    const res = await call('GET', '/api/templates', null, { token, tenant: 'tplgym' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.templates.receipt, defaultTemplate('receipt'));
    assert.deepEqual(res.body.templates.id_card, defaultTemplate('id_card'));
    assert.equal(res.body.templates.omr, undefined);
    assert.deepEqual(res.body.choices.receipt.style, ['modern', 'classic', 'minimal']);
  });

  it('saves a partial change over the defaults and resets it', async () => {
    const saved = await call('PUT', '/api/templates/receipt', { style: 'classic', terms: 'No refunds.' }, { token, tenant: 'tplgym' });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.template.style, 'classic');
    assert.equal(saved.body.template.footer_note, 'Thank you for your payment!');

    const again = await call('GET', '/api/templates', null, { token, tenant: 'tplgym' });
    assert.equal(again.body.templates.receipt.terms, 'No refunds.');

    const bad = await call('PUT', '/api/templates/receipt', { accent: 'blue' }, { token, tenant: 'tplgym' });
    assert.equal(bad.status, 400);

    const reset = await call('DELETE', '/api/templates/receipt', null, { token, tenant: 'tplgym' });
    assert.deepEqual(reset.body.template, defaultTemplate('receipt'));
  });

  it('lets staff read templates but only an admin change them', async () => {
    const staff = await call('POST', '/api/staff', { name: 'Desk', email: 'desk@tplgym.test', password: 'deskpass123', role: 'staff' }, { token, tenant: 'tplgym' });
    assert.equal(staff.status, 201, JSON.stringify(staff.body));
    staffToken = (await call('POST', '/api/auth/login', { email: 'desk@tplgym.test', password: 'deskpass123' }, { tenant: 'tplgym' })).body.token;
    assert.equal((await call('GET', '/api/templates', null, { token: staffToken, tenant: 'tplgym' })).status, 200);
    assert.equal((await call('PUT', '/api/templates/receipt', { style: 'minimal' }, { token: staffToken, tenant: 'tplgym' })).status, 403);
  });

  it('previews a receipt with unsaved values as a PDF', async () => {
    const res = await call('POST', '/api/templates/receipt/preview', { style: 'minimal' }, { token, tenant: 'tplgym', raw: true });
    assert.equal(res.status, 200);
    assert.equal(res.type, 'application/pdf');
    assert.equal(res.bytes.subarray(0, 5).toString(), '%PDF-');
  });

  it('puts the card template on ID card data and serves the payment receipt PDF', async () => {
    await call('PUT', '/api/templates/id_card', { style: 'vertical', accent: '#0f766e' }, { token, tenant: 'tplgym' });
    const member = await call('POST', '/api/members', { first_name: 'Amit', last_name: 'Singh' }, { token, tenant: 'tplgym' });
    const card = await call('GET', `/api/qr/member/${member.body.id}`, null, { token, tenant: 'tplgym' });
    assert.equal(card.body.template.style, 'vertical');
    assert.equal(card.body.template.accent, '#0f766e');

    const payment = await call('POST', '/api/payments', { member_id: member.body.id, amount: 1200, method: 'cash' }, { token, tenant: 'tplgym' });
    assert.equal(payment.status, 201, JSON.stringify(payment.body));
    const pdf = await call('GET', `/api/payments/${payment.body.id}/receipt.pdf`, null, { token, tenant: 'tplgym', raw: true });
    assert.equal(pdf.status, 200);
    assert.equal(pdf.type, 'application/pdf');
    assert.equal(pdf.bytes.subarray(0, 5).toString(), '%PDF-');
  });

  it('offers the OMR template and sheet preview to a coaching institute only', async () => {
    assert.equal((await call('PUT', '/api/templates/omr', { default_style: 'board' }, { token, tenant: 'tplgym' })).status, 404);

    const coachToken = await signupAndLogin('tplcoach', { business_type: 'coaching' });
    const got = await call('GET', '/api/templates', null, { token: coachToken, tenant: 'tplcoach' });
    assert.equal(got.body.templates.omr.default_style, 'coachbook');

    const saved = await call('PUT', '/api/templates/omr', { default_style: 'board', extra_fields: "Father's name\nCentre code" }, { token: coachToken, tenant: 'tplcoach' });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.template.extra_fields, ["Father's name", 'Centre code']);

    for (const style of ['coachbook', 'board', 'competitive']) {
      const res = await call('POST', '/api/templates/omr/preview', { default_style: style }, { token: coachToken, tenant: 'tplcoach', raw: true });
      assert.equal(res.status, 200, `${style} preview`);
      assert.equal(res.bytes.subarray(0, 5).toString(), '%PDF-');
    }
  });
});
