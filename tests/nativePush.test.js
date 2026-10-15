import assert from 'node:assert/strict';
import { memberToken as signInMember } from './helpers/memberAuth.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-fcm-test-'));
process.env.DB_FILE = path.join(tmpDir, 'default.db');
process.env.PLATFORM_DB_FILE = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.AUTH_SECRET = 'test-secret';

// A service-account key of our own, so the JWT the server signs can be checked.
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const keyFile = path.join(tmpDir, 'firebase-sa.json');
fs.writeFileSync(
  keyFile,
  JSON.stringify({
    type: 'service_account',
    project_id: 'gymbook-test',
    client_email: 'push@gymbook-test.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    token_uri: 'https://oauth2.example.test/token',
  }),
);
process.env.FCM_CREDENTIALS = keyFile;

const { createApp } = await import('../src/app.js');
const { config } = await import('../src/config.js');
const { closeDb, get, tenantStorage } = await import('../src/db.js');
const { closeRegistryDb, tenantDbPath } = await import('../src/tenants.js');
const fcm = await import('../src/fcm.js');
const { notifyMember, settlePushDeliveries } = await import('../src/notifications.js');

let base;
let server;

/** Every request the server makes to Google, instead of Google. */
const tokenRequests = [];
const sends = [];
let sendStatus = () => ({ status: 200, body: '{"name":"projects/gymbook-test/messages/1"}' });
fcm.setFcmTransport(async (url, init) => {
  if (url === 'https://oauth2.example.test/token') {
    tokenRequests.push(new URLSearchParams(init.body));
    return { status: 200, text: async () => JSON.stringify({ access_token: 'ya29.test', expires_in: 3600 }) };
  }
  sends.push({ url, headers: init.headers, message: JSON.parse(init.body).message });
  const { status, body } = sendStatus();
  return { status, text: async () => body };
});

const call = async (method, urlPath, body, { token, tenant = 'fcmgym' } = {}) => {
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

const inGym = (fn) =>
  tenantStorage.run({ slug: 'fcmgym', dbFile: tenantDbPath('fcmgym'), timezone: 'UTC', businessType: 'gym' }, fn);

const fcmToken = (name) => `${name}:APA91b${'x'.repeat(140)}`;

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

describe('native push (Android app, Firebase)', () => {
  let staffToken;
  let memberToken;
  let memberId;
  const phone = fcmToken('asha-phone');

  it('sets up a gym with a member signed into the app', async () => {
    await call(
      'POST',
      '/api/platform/signup',
      { slug: 'fcmgym', gym_name: 'FCM Gym', admin_name: 'Owner', admin_email: 'owner@fcmgym.test', admin_password: 'ownerpass123' },
      { tenant: null },
    );
    staffToken = (await call('POST', '/api/auth/login', { email: 'owner@fcmgym.test', password: 'ownerpass123' })).body.token;
    const member = await call('POST', '/api/members', { first_name: 'Asha', phone: '9876500001' }, { token: staffToken });
    memberId = member.body.id;
    memberToken = await signInMember(call, { staffToken, memberId });
    assert.ok(memberToken);
  });

  it('registers the app’s FCM token as one of the member’s devices', async () => {
    const res = await call('POST', '/api/portal/notifications/devices', { token: phone, path_prefix: '/g/fcmgym' }, { token: memberToken });
    assert.equal(res.status, 201);
    assert.equal(res.body.devices, 1);
    const row = inGym(() => get('SELECT * FROM push_subscriptions WHERE member_id = ?', [memberId]));
    assert.equal(row.endpoint, `fcm:${phone}`);
    assert.equal(row.platform, 'android');
    assert.equal(row.origin, base, 'kept so a notification picture can get an absolute URL');
  });

  it('refuses something that is not an FCM token', async () => {
    const res = await call('POST', '/api/portal/notifications/devices', { token: 'https://evil.example/x' }, { token: memberToken });
    assert.equal(res.status, 400);
  });

  it('sends through FCM v1, signed in as the service account', async () => {
    const result = await inGym(() =>
      notifyMember(memberId, { category: 'water', title: 'Time for water', body: 'Have a glass', screen: 'diet', tag: 'water' }),
    );
    assert.equal(result.delivered, 1);

    assert.equal(sends.length, 1);
    const [send] = sends;
    assert.equal(send.url, 'https://fcm.googleapis.com/v1/projects/gymbook-test/messages:send');
    assert.equal(send.headers.Authorization, 'Bearer ya29.test');
    assert.equal(send.message.token, phone);
    assert.deepEqual(send.message.notification, { title: 'Time for water', body: 'Have a glass' });
    assert.equal(send.message.data.url, '/g/fcmgym/#/portal/diet', 'the deep link the app opens on tap');
    assert.equal(send.message.android.notification.tag, 'water');
    assert.equal(send.message.android.notification.channel_id, 'alerts');
    for (const value of Object.values(send.message.data)) assert.equal(typeof value, 'string', 'FCM data takes strings only');

    // The OAuth2 JWT-bearer grant, verifiable with the key's public half.
    const assertion = tokenRequests[0].get('assertion');
    assert.equal(tokenRequests[0].get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [h, c, s] = assertion.split('.');
    assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s, 'base64url')));
    const claims = JSON.parse(Buffer.from(c, 'base64url').toString('utf8'));
    assert.equal(claims.iss, 'push@gymbook-test.iam.gserviceaccount.com');
    assert.equal(claims.scope, 'https://www.googleapis.com/auth/firebase.messaging');
    assert.equal(claims.aud, 'https://oauth2.example.test/token');
  });

  it('reuses its access token, and files a silenced member under the quiet channel', async () => {
    await call('PUT', '/api/portal/notifications/preferences', { sound: false }, { token: memberToken });
    sends.length = 0;
    await inGym(() => notifyMember(memberId, { category: 'workout', title: 'Leg day', body: 'Squats today' }));
    assert.equal(tokenRequests.length, 1, 'one sign-in to Google, not one per message');
    assert.equal(sends[0].message.android.notification.channel_id, 'quiet');
  });

  it('gives an announcement picture an absolute URL on this server', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
    sends.length = 0;
    const res = await call(
      'POST',
      '/api/notifications/announcements',
      { title: 'Zumba night', body: 'Friday 7pm', kind: 'event', image: `data:image/png;base64,${png.toString('base64')}` },
      { token: staffToken },
    );
    assert.equal(res.status, 201);
    await inGym(() => settlePushDeliveries());
    assert.equal(sends[0].message.notification.image, `${base}/g/fcmgym${res.body.image_url}`);
    assert.equal(sends[0].message.notification.title, 'FCM Gym: Zumba night');
  });

  it('forgets a token Firebase reports as unregistered', async () => {
    sendStatus = () => ({ status: 404, body: '{"error":{"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}' });
    const result = await inGym(() => notifyMember(memberId, { category: 'workout', title: 'Rest day', body: 'Recover well' }));
    assert.equal(result.failed, 1);
    assert.equal(inGym(() => get('SELECT COUNT(*) AS n FROM push_subscriptions WHERE member_id = ?', [memberId])).n, 0);
    sendStatus = () => ({ status: 200, body: '{}' });
  });

  it('unregisters a device on request', async () => {
    await call('POST', '/api/portal/notifications/devices', { token: phone }, { token: memberToken });
    const res = await call('DELETE', '/api/portal/notifications/devices', { token: phone }, { token: memberToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.devices, 0);
  });

  it('says so, instead of registering a device it could never reach, when FCM is not set up', async () => {
    const saved = config.fcm.credentialsFile;
    config.fcm.credentialsFile = '';
    fcm.resetFcm();
    try {
      const res = await call('POST', '/api/portal/notifications/devices', { token: phone }, { token: memberToken });
      assert.equal(res.status, 503);
      assert.match(res.body.error, /set up/);
    } finally {
      config.fcm.credentialsFile = saved;
      fcm.resetFcm();
    }
  });
});
