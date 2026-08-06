import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-qr-test-'));
process.env.DB_FILE = path.join(tmpDir, 'default.db');
process.env.PLATFORM_DB_FILE = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.AUTH_SECRET = 'test-secret';

const { createApp } = await import('../src/app.js');
const { closeDb } = await import('../src/db.js');
const { closeRegistryDb } = await import('../src/tenants.js');
const { normalizeScan, QR_PREFIX } = await import('../src/qr.js');

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

describe('normalizeScan', () => {
  it('unwraps the card prefix and flags the value as coming from a card', () => {
    assert.deepEqual(normalizeScan(`${QR_PREFIX}:abc123`), { value: 'abc123', from_card: true });
  });

  it('treats a bare value as typed input, not a card', () => {
    assert.deepEqual(normalizeScan('GM0042'), { value: 'GM0042', from_card: false });
  });

  it('strips the newline a handheld scanner appends', () => {
    assert.deepEqual(normalizeScan(`${QR_PREFIX}:abc123\r\n`), { value: 'abc123', from_card: true });
  });

  it('matches the prefix case-insensitively', () => {
    assert.deepEqual(normalizeScan('gb1:abc123'), { value: 'abc123', from_card: true });
  });

  it('returns an empty value for blank or missing input', () => {
    assert.deepEqual(normalizeScan('   '), { value: '', from_card: false });
    assert.deepEqual(normalizeScan(null), { value: '', from_card: false });
  });
});

describe('QR card check-in', () => {
  let token;
  let memberId;
  let otherId;
  let card;

  it('sets up a tenant, two members, and an active plan', async () => {
    await call('POST', '/api/platform/signup', {
      slug: 'ironhouse',
      gym_name: 'Iron House',
      admin_name: 'Owner',
      admin_email: 'owner@ironhouse.test',
      admin_password: 'ownerpass123',
    });
    token = (
      await call('POST', '/api/auth/login', { email: 'owner@ironhouse.test', password: 'ownerpass123' }, { tenant: 'ironhouse' })
    ).body.token;

    const member = await call('POST', '/api/members', { first_name: 'Amit', last_name: 'Singh' }, { token, tenant: 'ironhouse' });
    assert.equal(member.status, 201);
    memberId = member.body.id;

    const other = await call('POST', '/api/members', { first_name: 'Priya' }, { token, tenant: 'ironhouse' });
    otherId = other.body.id;

    // Not "Monthly": signup seeds starter plans and plans.name is UNIQUE, so
    // this suite needs a name of its own.
    const plan = await call('POST', '/api/plans', { name: 'Gold Monthly', price: 1000, duration_days: 30 }, { token, tenant: 'ironhouse' });
    assert.equal(plan.status, 201);
    for (const id of [memberId, otherId]) {
      const sub = await call('POST', '/api/subscriptions', { member_id: id, plan_id: plan.body.id }, { token, tenant: 'ironhouse' });
      assert.equal(sub.status, 201);
    }
  });

  it('requires staff auth to fetch a card', async () => {
    const res = await call('GET', `/api/qr/member/${memberId}`, null, { tenant: 'ironhouse' });
    assert.equal(res.status, 401);
  });

  it('issues a card with a QR image and a prefixed payload', async () => {
    const res = await call('GET', `/api/qr/member/${memberId}`, null, { token, tenant: 'ironhouse' });
    assert.equal(res.status, 200);
    card = res.body;

    assert.equal(card.gym_name, 'Iron House');
    assert.equal(card.member.code, 'GM0001');
    assert.ok(card.token, 'a card token was issued');
    assert.equal(card.payload, `${QR_PREFIX}:${card.token}`);
    assert.ok(card.issued_at, 'records when the card was issued');

    // The QR itself must be real, renderable output — not an empty stub.
    assert.match(card.svg, /^<svg[^>]+viewBox="0 0 \d+ \d+"/);
    assert.match(card.svg, /<path stroke=/);
    assert.match(card.png, /^data:image\/png;base64,[A-Za-z0-9+/=]+$/);
    assert.ok(card.png.length > 500, 'PNG carries actual image data');
  });

  it('keeps the QR small enough for cheap scanners to read off a printed card', () => {
    // Module count grows with payload length. At card size (~1.15in of QR),
    // a version past ~4 puts the modules under the resolution a budget
    // handheld scanner or phone camera can resolve — so if someone later
    // stuffs a URL into the payload, this is the tripwire.
    const modules = Number(card.svg.match(/viewBox="0 0 (\d+) \d+"/)[1]);
    assert.ok(modules <= 33, `QR is ${modules} modules across, expected <= 33 (version 4)`);
  });

  it('keeps returning the same token instead of silently invalidating the printed card', async () => {
    const again = await call('GET', `/api/qr/member/${memberId}`, null, { token, tenant: 'ironhouse' });
    assert.equal(again.body.token, card.token);
  });

  it('gives each member a distinct, unguessable token', async () => {
    const otherCard = await call('GET', `/api/qr/member/${otherId}`, null, { token, tenant: 'ironhouse' });
    assert.notEqual(otherCard.body.token, card.token);
    assert.ok(card.token.length >= 20, 'token is long enough to resist guessing');
    assert.doesNotMatch(card.token, /GM0001/, 'token is not derived from the member code');
  });

  it('404s for a member that does not exist', async () => {
    const res = await call('GET', '/api/qr/member/999999', null, { token, tenant: 'ironhouse' });
    assert.equal(res.status, 404);
  });

  it('does not leak the card token through the members API, but reports that one exists', async () => {
    const list = await call('GET', '/api/members', null, { token, tenant: 'ironhouse' });
    const row = list.body.items.find((m) => m.id === memberId);
    assert.equal(row.qr_token, undefined);
    assert.equal(row.has_qr, true);

    const detail = await call('GET', `/api/members/${memberId}`, null, { token, tenant: 'ironhouse' });
    assert.equal(detail.body.qr_token, undefined);
    assert.equal(detail.body.has_qr, true);
  });

  /* ── Scanning: details first, then check in ─────────────────────────── */

  it('returns the member details a scan should surface, without checking anyone in', async () => {
    const res = await call('POST', '/api/qr/lookup', { code: card.payload }, { token, tenant: 'ironhouse' });
    assert.equal(res.status, 200);
    assert.equal(res.body.member.id, memberId);
    assert.equal(res.body.member.first_name, 'Amit');
    assert.equal(res.body.already_in, false);
    assert.ok(res.body.subscription, 'shows the active membership');
    assert.equal(res.body.subscription.plan_name, 'Gold Monthly');

    const attendance = await call('GET', `/api/attendance?member_id=${memberId}`, null, { token, tenant: 'ironhouse' });
    assert.equal(attendance.body.items.length, 0, 'lookup is read-only');
  });

  it('accepts a bare token, and a typed member code, in the same scan box', async () => {
    const bare = await call('POST', '/api/qr/lookup', { code: card.token }, { token, tenant: 'ironhouse' });
    assert.equal(bare.body.member.id, memberId);

    const typed = await call('POST', '/api/qr/lookup', { code: 'GM0001' }, { token, tenant: 'ironhouse' });
    assert.equal(typed.body.member.id, memberId);
  });

  it('tolerates the trailing newline a handheld scanner sends', async () => {
    const res = await call('POST', '/api/qr/lookup', { code: `${card.payload}\r\n` }, { token, tenant: 'ironhouse' });
    assert.equal(res.body.member.id, memberId);
  });

  it('refuses a home-made QR that wraps a guessed member code', async () => {
    // The member codes are sequential, so this is the forgery that matters:
    // a card-prefixed payload must match a real token and nothing else.
    const res = await call('POST', '/api/qr/lookup', { code: `${QR_PREFIX}:GM0001` }, { token, tenant: 'ironhouse' });
    assert.equal(res.status, 404);
  });

  it('404s an unrecognised card', async () => {
    const res = await call('POST', '/api/qr/lookup', { code: `${QR_PREFIX}:not-a-real-token` }, { token, tenant: 'ironhouse' });
    assert.equal(res.status, 404);
  });

  it('rejects a lookup with no code at all', async () => {
    const res = await call('POST', '/api/qr/lookup', {}, { token, tenant: 'ironhouse' });
    assert.equal(res.status, 400);
  });

  it('checks the member in from a scanned card', async () => {
    const res = await call('POST', '/api/qr/check-in', { code: card.payload }, { token, tenant: 'ironhouse' });
    assert.equal(res.status, 201);
    assert.equal(res.body.action, 'checked_in');
    assert.equal(res.body.visit.source, 'qr');
    assert.equal(res.body.visit.member_code, 'GM0001');

    const attendance = await call('GET', `/api/attendance?member_id=${memberId}`, null, { token, tenant: 'ironhouse' });
    assert.equal(attendance.body.items.length, 1);
    assert.equal(attendance.body.items[0].source, 'qr');
  });

  it('tells the desk the member is already inside on a re-scan', async () => {
    const res = await call('POST', '/api/qr/lookup', { code: card.payload }, { token, tenant: 'ironhouse' });
    assert.equal(res.body.already_in, true);
    assert.ok(res.body.open_visit);
  });

  it('toggles the member to checked-out on a second scan the same day', async () => {
    const res = await call('POST', '/api/qr/check-in', { code: card.payload }, { token, tenant: 'ironhouse' });
    assert.equal(res.status, 200);
    assert.equal(res.body.action, 'checked_out');
    assert.ok(res.body.visit.check_out);

    // Same visit closed, not a second row.
    const attendance = await call('GET', `/api/attendance?member_id=${memberId}`, null, { token, tenant: 'ironhouse' });
    assert.equal(attendance.body.items.length, 1);
  });

  it('tells the desk the member has left after that scan', async () => {
    const res = await call('POST', '/api/qr/lookup', { code: card.payload }, { token, tenant: 'ironhouse' });
    assert.equal(res.body.already_in, false);
    assert.equal(res.body.open_visit, null);
  });

  it('refuses a scan for a frozen member, with a reason the desk can read out', async () => {
    await call('PATCH', `/api/members/${otherId}`, { status: 'frozen' }, { token, tenant: 'ironhouse' });
    const otherCard = await call('GET', `/api/qr/member/${otherId}`, null, { token, tenant: 'ironhouse' });

    const res = await call('POST', '/api/qr/check-in', { code: otherCard.body.payload }, { token, tenant: 'ironhouse' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /frozen/i);

    // Details still resolve, so the desk can see who it was and why.
    const lookup = await call('POST', '/api/qr/lookup', { code: otherCard.body.payload }, { token, tenant: 'ironhouse' });
    assert.equal(lookup.status, 200);
    assert.equal(lookup.body.member.status, 'frozen');
  });

  /* ── Reissuing a lost card ──────────────────────────────────────────── */

  it('reissues a card and kills the old one', async () => {
    const reissued = await call('POST', `/api/qr/member/${memberId}/reissue`, null, { token, tenant: 'ironhouse' });
    assert.equal(reissued.status, 200);
    assert.notEqual(reissued.body.token, card.token, 'a fresh token was minted');

    const oldCard = await call('POST', '/api/qr/lookup', { code: card.payload }, { token, tenant: 'ironhouse' });
    assert.equal(oldCard.status, 404, 'the lost card no longer works');

    const newCard = await call('POST', '/api/qr/lookup', { code: reissued.body.payload }, { token, tenant: 'ironhouse' });
    assert.equal(newCard.status, 200);
    assert.equal(newCard.body.member.id, memberId);

    card = reissued.body;
  });

  it('404s reissuing for a member that does not exist', async () => {
    const res = await call('POST', '/api/qr/member/999999/reissue', null, { token, tenant: 'ironhouse' });
    assert.equal(res.status, 404);
  });

  /* ── Batch printing ────────────────────────────────────────────────── */

  it('returns a batch of cards for a print run', async () => {
    const res = await call('GET', `/api/qr/cards?ids=${memberId},${otherId}`, null, { token, tenant: 'ironhouse' });
    assert.equal(res.status, 200);
    assert.equal(res.body.items.length, 2);
    for (const item of res.body.items) {
      assert.ok(item.svg.startsWith('<svg'));
      assert.equal(item.payload, `${QR_PREFIX}:${item.token}`);
    }
  });

  it('skips ids that no longer exist rather than failing the whole sheet', async () => {
    const res = await call('GET', `/api/qr/cards?ids=${memberId},999999`, null, { token, tenant: 'ironhouse' });
    assert.equal(res.status, 200);
    assert.equal(res.body.items.length, 1);
    assert.equal(res.body.items[0].member.id, memberId);
  });

  it('rejects a batch request with no usable ids', async () => {
    const res = await call('GET', '/api/qr/cards?ids=', null, { token, tenant: 'ironhouse' });
    assert.equal(res.status, 400);
  });

  /* ── Tenant isolation ──────────────────────────────────────────────── */

  it("will not resolve one gym's card against another gym", async () => {
    await call('POST', '/api/platform/signup', {
      slug: 'flexzone',
      gym_name: 'Flex Zone',
      admin_name: 'Owner Two',
      admin_email: 'owner@flexzone.test',
      admin_password: 'ownerpass123',
    });
    const otherToken = (
      await call('POST', '/api/auth/login', { email: 'owner@flexzone.test', password: 'ownerpass123' }, { tenant: 'flexzone' })
    ).body.token;

    const res = await call('POST', '/api/qr/lookup', { code: card.payload }, { token: otherToken, tenant: 'flexzone' });
    assert.equal(res.status, 404);
  });
});
