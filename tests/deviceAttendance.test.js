import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-device-test-'));
process.env.DB_FILE = path.join(tmpDir, 'default.db');
process.env.PLATFORM_DB_FILE = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.AUTH_SECRET = 'test-secret';

const { createApp } = await import('../src/app.js');
const { closeDb } = await import('../src/db.js');
const { closeRegistryDb } = await import('../src/tenants.js');

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

const postDevice = (query, textBody) =>
  fetch(`${base}/iclock/cdata?${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: textBody,
  });

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

describe('physical device attendance', () => {
  let token;
  let memberId;

  it('sets up a tenant, a device, a member with a device_pin, and an active plan', async () => {
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

    const deviceRes = await call('POST', '/api/devices', { serial: 'RSS1110031760', label: 'Front desk' }, { token, tenant: 'ironhouse' });
    assert.equal(deviceRes.status, 201);

    const member = await call('POST', '/api/members', { first_name: 'Amit', device_pin: 42 }, { token, tenant: 'ironhouse' });
    assert.equal(member.status, 201);
    memberId = member.body.id;

    const plan = await call('POST', '/api/plans', { name: 'Monthly', price: 1000, duration_days: 30 }, { token, tenant: 'ironhouse' });
    const sub = await call('POST', '/api/subscriptions', { member_id: memberId, plan_id: plan.body.id }, { token, tenant: 'ironhouse' });
    assert.equal(sub.status, 201);
  });

  it('checks a member in from a device punch matched by device_pin', async () => {
    const res = await postDevice('SN=RSS1110031760&table=ATTLOG', '42\t2026-01-01 09:00:00\t1\t0');
    assert.equal(res.status, 200);
    assert.match(await res.text(), /OK/);

    const attendance = await call('GET', `/api/attendance?member_id=${memberId}`, null, { token, tenant: 'ironhouse' });
    assert.equal(attendance.body.items.length, 1);
    assert.equal(attendance.body.items[0].source, 'device');
  });

  it('is idempotent for a second punch the same day', async () => {
    const res = await postDevice('SN=RSS1110031760&table=ATTLOG', '42\t2026-01-01 18:00:00\t1\t0');
    assert.equal(res.status, 200);

    const attendance = await call('GET', `/api/attendance?member_id=${memberId}`, null, { token, tenant: 'ironhouse' });
    assert.equal(attendance.body.items.length, 1); // still just the one open visit
  });

  it('acks an upload from an unregistered device serial without crashing', async () => {
    const res = await postDevice('SN=unknown-serial&table=ATTLOG', '42\t2026-01-01 09:00:00\t1\t0');
    assert.equal(res.status, 200);
    assert.match(await res.text(), /OK/);
  });

  it('acks a punch with no matching device_pin without crashing', async () => {
    const res = await postDevice('SN=RSS1110031760&table=ATTLOG', '9999\t2026-01-01 09:00:00\t1\t0');
    assert.equal(res.status, 200);
  });

  it('responds to the handshake and heartbeat endpoints', async () => {
    const handshake = await fetch(`${base}/iclock/cdata?SN=RSS1110031760&options=all`);
    assert.equal(handshake.status, 200);
    assert.ok((await handshake.text()).length > 0);

    const heartbeat = await fetch(`${base}/iclock/getrequest?SN=RSS1110031760`);
    assert.equal(heartbeat.status, 200);
    assert.match(await heartbeat.text(), /OK/);
  });
});
