import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-push-test-'));
process.env.DB_FILE = path.join(tmpDir, 'default.db');
process.env.PLATFORM_DB_FILE = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.AUTH_SECRET = 'test-secret';

const { createApp } = await import('../src/app.js');
const { closeDb, run, get, tenantStorage } = await import('../src/db.js');
const { closeRegistryDb, tenantDbPath } = await import('../src/tenants.js');
const webPush = await import('../src/webPush.js');
const { settlePushDeliveries, sweepPushNotifications } = await import('../src/notifications.js');

let base;
let server;

/** Every push the server tries to send, instead of a real push service. */
const sent = [];
let nextStatus = 201;
webPush.setPushTransport(async (url, init) => {
  sent.push({ url, headers: init.headers, body: init.body });
  return { status: typeof nextStatus === 'function' ? nextStatus(url) : nextStatus, text: async () => '' };
});

/** A browser-side subscription: its own P-256 key pair and auth secret, as
 * PushManager.subscribe() would mint them. */
function fakeBrowser(name) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16).toString('base64url');
  return {
    privateKey: ecdh.getPrivateKey().toString('base64url'),
    auth,
    json: {
      endpoint: `https://push.example.test/send/${name}`,
      keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth },
    },
  };
}

const readPush = (browser, delivery) =>
  JSON.parse(webPush.decryptPayload({ privateKey: browser.privateKey, auth: browser.auth }, delivery.body).toString('utf8'));

const call = async (method, urlPath, body, { token, tenant = 'pushgym' } = {}) => {
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

/** Runs `fn` against the test gym's database, pinned to UTC so "11:05" in a
 * test means 11:05 on the gym's clock. */
const inGym = (fn) =>
  tenantStorage.run({ slug: 'pushgym', dbFile: tenantDbPath('pushgym'), timezone: 'UTC', businessType: 'gym' }, fn);

const today = () => new Date().toISOString().slice(0, 10);
const at = (hhmm) => new Date(`${today()}T${hhmm}:00Z`);

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

describe('web push primitives', () => {
  it('encrypts a payload only the subscribing browser can read (RFC 8291 aes128gcm)', () => {
    const browser = fakeBrowser('crypto');
    const message = JSON.stringify({ title: 'Hello', body: 'x'.repeat(500) });
    const encrypted = webPush.encryptPayload(browser.json.keys, message);

    // Header: 16-byte salt, 4096 record size, 65-byte sender key id.
    assert.equal(encrypted.readUInt32BE(16), 4096);
    assert.equal(encrypted.readUInt8(20), 65);
    assert.equal(webPush.decryptPayload(browser, encrypted).toString('utf8'), message);

    const stranger = fakeBrowser('stranger');
    assert.throws(() => webPush.decryptPayload(stranger, encrypted));
  });

  it('signs a VAPID token the push service can verify against our public key', () => {
    const keys = webPush.generateVapidKeys();
    const header = webPush.vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', {
      keys,
      subject: 'mailto:ops@example.test',
    });
    const [, token, k] = /^vapid t=([^,]+), k=(.+)$/.exec(header);
    assert.equal(k, keys.publicKey);

    const [h, c, s] = token.split('.');
    const claims = JSON.parse(Buffer.from(c, 'base64url').toString('utf8'));
    assert.equal(claims.aud, 'https://fcm.googleapis.com');
    assert.equal(claims.sub, 'mailto:ops@example.test');
    assert.ok(claims.exp - Date.now() / 1000 <= 24 * 3600, 'expiry must stay inside the 24h VAPID ceiling');

    const point = Buffer.from(keys.publicKey, 'base64url');
    const publicKey = crypto.createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: point.subarray(1, 33).toString('base64url'),
        y: point.subarray(33).toString('base64url'),
      },
      format: 'jwk',
    });
    const valid = crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
    assert.ok(valid);
  });

  it('persists the generated key pair so a restart keeps every subscription alive', () => {
    const first = webPush.vapidKeys();
    webPush.resetVapidKeyCache();
    const second = webPush.vapidKeys();
    assert.deepEqual(second, first);
    assert.ok(fs.existsSync(path.join(tmpDir, 'vapid-keys.json')));
  });
});

describe('member push notifications', () => {
  let staffToken;
  let memberToken;
  let memberId;
  let otherToken;
  const phone = fakeBrowser('rahul-phone');

  it('sets up a gym with two members signed into the portal', async () => {
    await call('POST', '/api/platform/signup', {
      slug: 'pushgym',
      gym_name: 'Push Gym',
      admin_name: 'Owner',
      admin_email: 'owner@pushgym.test',
      admin_password: 'ownerpass123',
    }, { tenant: null });
    staffToken = (await call('POST', '/api/auth/login', { email: 'owner@pushgym.test', password: 'ownerpass123' })).body.token;

    const member = await call('POST', '/api/members', { first_name: 'Rahul', phone: '9876543210' }, { token: staffToken });
    assert.equal(member.status, 201);
    memberId = member.body.id;
    memberToken = (await call('POST', '/api/portal/login', { identifier: member.body.code, pin: '3210' })).body.token;
    assert.ok(memberToken);

    const other = await call('POST', '/api/members', { first_name: 'Priya', phone: '9123456789' }, { token: staffToken });
    otherToken = (await call('POST', '/api/portal/login', { identifier: other.body.code, pin: '6789' })).body.token;
    assert.ok(otherToken);

    // Tracker free for everyone, so the habit nudges apply.
    inGym(() => run('UPDATE fitness_addon_settings SET enabled = 0 WHERE id = 1'));
  });

  it('hands the portal the public key and default-on preferences', async () => {
    const res = await call('GET', '/api/portal/notifications/config', undefined, { token: memberToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.public_key, webPush.vapidKeys().publicKey);
    assert.equal(res.body.preferences.water, 1);
    assert.equal(res.body.devices, 0);
    assert.deepEqual(res.body.categories, ['water', 'nutrition', 'workout', 'announcements', 'membership']);
  });

  it('refuses a subscription that is not an https push endpoint', async () => {
    const res = await call(
      'POST',
      '/api/portal/notifications/subscriptions',
      { ...phone.json, endpoint: 'http://169.254.169.254/latest/meta-data' },
      { token: memberToken },
    );
    assert.equal(res.status, 400);
  });

  it('requires a member token, not a staff one', async () => {
    const res = await call('POST', '/api/portal/notifications/subscriptions', phone.json, { token: staffToken });
    assert.equal(res.status, 401);
  });

  it('registers a device', async () => {
    const res = await call(
      'POST',
      '/api/portal/notifications/subscriptions',
      { ...phone.json, platform: 'android', path_prefix: '/g/pushgym' },
      { token: memberToken },
    );
    assert.equal(res.status, 201);
    assert.equal(res.body.devices, 1);
  });

  it('sends a test notification, encrypted, VAPID-signed and deep-linked into this gym', async () => {
    sent.length = 0;
    const res = await call('POST', '/api/portal/notifications/test', {}, { token: memberToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.delivered, 1);

    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, phone.json.endpoint);
    assert.equal(sent[0].headers['Content-Encoding'], 'aes128gcm');
    assert.match(sent[0].headers.Authorization, /^vapid t=.+, k=.+$/);
    const payload = readPush(phone, sent[0]);
    assert.equal(payload.category, 'test');
    assert.equal(payload.url, '/g/pushgym/#/portal/notifications');
    assert.equal(payload.sound, 1);
    assert.equal(payload.unread, 1);
    // No uploaded logo: the GymBook mark, plus the status-bar silhouette.
    assert.equal(payload.icon, '/icons/icon-192.png');
    assert.equal(payload.badge, '/icons/badge-96.png');
  });

  it('lists the notification center and marks it read', async () => {
    const list = await call('GET', '/api/portal/notifications', undefined, { token: memberToken });
    assert.equal(list.body.unread, 1);
    assert.equal(list.body.items[0].title, 'Notifications are on ✅');

    const read = await call('POST', '/api/portal/notifications/read', {}, { token: memberToken });
    assert.equal(read.body.unread, 0);
  });

  it("uses the gym's own uploaded logo as the notification icon", async () => {
    const { getRegistryDb } = await import('../src/tenants.js');
    getRegistryDb()
      .prepare("UPDATE tenants SET icon_bytes = ?, icon_mime = 'image/png', logo_version = 4 WHERE slug = 'pushgym'")
      .run(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    sent.length = 0;
    await call('POST', '/api/portal/notifications/test', {}, { token: memberToken });
    assert.equal(readPush(phone, sent[0]).icon, '/api/platform/tenant-icon/pushgym?v=4');
    getRegistryDb().prepare("UPDATE tenants SET icon_bytes = NULL, icon_mime = NULL WHERE slug = 'pushgym'").run();
    await call('POST', '/api/portal/notifications/read', {}, { token: memberToken });
  });

  it('nudges for water at a scheduled time only when the member is behind', async () => {
    sent.length = 0;
    // 10:30 is not a slot; nothing goes out.
    await inGym(() => sweepPushNotifications({ now: at('10:30') }));
    assert.equal(sent.length, 0);

    const first = await inGym(() => sweepPushNotifications({ now: at('11:05') }));
    assert.equal(first.sent, 1);
    const payload = readPush(phone, sent[0]);
    assert.equal(payload.category, 'water');
    assert.equal(payload.url, '/g/pushgym/#/portal/diet');
    assert.match(payload.body, /Nothing logged yet/);

    // The next pass inside the same slot is a no-op — once per slot, ever.
    sent.length = 0;
    await inGym(() => sweepPushNotifications({ now: at('11:20') }));
    assert.equal(sent.length, 0);

    // On track by 15:00 (goal 3 L, ~1.5 L expected): no nudge.
    await call('POST', '/api/portal/diets/water', { water_ml: 2000, log_date: today() }, { token: memberToken });
    await inGym(() => sweepPushNotifications({ now: at('15:10') }));
    assert.equal(sent.filter((s) => readPush(phone, s).category === 'water').length, 0);
  });

  it('reminds about an unlogged meal, and not once it is logged', async () => {
    sent.length = 0;
    await inGym(() => sweepPushNotifications({ now: at('14:10') }));
    const meal = sent.map((s) => readPush(phone, s)).find((p) => p.category === 'nutrition');
    assert.ok(meal);
    assert.match(meal.title, /lunch/);

    await call(
      'POST',
      '/api/portal/diets/entries',
      { meal_type: 'dinner', food_name: 'Dal', calories: 300, log_date: today() },
      { token: memberToken },
    );
    sent.length = 0;
    await inGym(() => sweepPushNotifications({ now: at('21:05') }));
    assert.equal(sent.map((s) => readPush(phone, s)).filter((p) => p.category === 'nutrition').length, 0);
  });

  it('respects a switched-off category', async () => {
    const res = await call('PUT', '/api/portal/notifications/preferences', { nutrition: false, sound: false }, { token: memberToken });
    assert.equal(res.body.nutrition, 0);
    assert.equal(res.body.sound, 0);
    assert.equal(res.body.water, 1);

    // Forget the lunch reminder already sent, so only the switch stands
    // between this pass and a second one.
    inGym(() => run("DELETE FROM member_notifications WHERE category = 'nutrition'"));
    sent.length = 0;
    await inGym(() => sweepPushNotifications({ now: at('14:15') }));
    assert.equal(sent.length, 0);
    await call('PUT', '/api/portal/notifications/preferences', { nutrition: true }, { token: memberToken });
  });

  it('nudges a workout left running past the configured limit, once', async () => {
    const startedAt = Date.now() - 3 * 3_600_000;
    const put = await call(
      'PUT',
      '/api/portal/notifications/active-workout',
      { workout_name: 'Push Day', started_at: startedAt },
      { token: memberToken },
    );
    assert.equal(put.status, 204);

    sent.length = 0;
    await inGym(() => sweepPushNotifications({ now: new Date() }));
    const nudge = sent.map((s) => readPush(phone, s)).find((p) => p.category === 'workout');
    assert.ok(nudge);
    assert.match(nudge.body, /Push Day/);
    assert.equal(nudge.url, '/g/pushgym/#/portal/workout');
    assert.equal(nudge.sound, 0, 'sound preference rides along in the payload');

    // A heartbeat for the same session does not re-arm it.
    await call('PUT', '/api/portal/notifications/active-workout', { workout_name: 'Push Day', started_at: startedAt }, { token: memberToken });
    sent.length = 0;
    await inGym(() => sweepPushNotifications({ now: new Date() }));
    assert.equal(sent.map((s) => readPush(phone, s)).filter((p) => p.category === 'workout').length, 0);

    const cleared = await call('DELETE', '/api/portal/notifications/active-workout', undefined, { token: memberToken });
    assert.equal(cleared.status, 204);
    assert.equal(inGym(() => get('SELECT COUNT(*) AS n FROM active_workouts')).n, 0);
  });

  it('reminds about a membership about to lapse', async () => {
    const plan = await call('POST', '/api/plans', { name: 'Push Test Monthly', price: 1000, duration_days: 30 }, { token: staffToken });
    const sub = await call('POST', '/api/subscriptions', { member_id: memberId, plan_id: plan.body.id }, { token: staffToken });
    assert.equal(sub.status, 201);
    const endsOn = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    inGym(() => run('UPDATE subscriptions SET end_date = ? WHERE id = ?', [endsOn, sub.body.id]));

    sent.length = 0;
    await inGym(() => sweepPushNotifications({ now: at('09:00') }));
    const renewal = sent.map((s) => readPush(phone, s)).find((p) => p.category === 'membership');
    assert.ok(renewal);
    assert.equal(renewal.title, 'Your membership ends in 3 days');
    assert.equal(renewal.url, '/g/pushgym/#/portal/pay');
  });

  it('limits the broadcast tools to admins and managers', async () => {
    await call('POST', '/api/staff', { name: 'Desk', email: 'desk@pushgym.test', password: 'deskpass123', role: 'staff' }, { token: staffToken });
    const deskToken = (await call('POST', '/api/auth/login', { email: 'desk@pushgym.test', password: 'deskpass123' })).body.token;
    const res = await call('POST', '/api/notifications/announcements', { title: 'Hi', body: 'Hello there' }, { token: deskToken });
    assert.equal(res.status, 403);
  });

  it('broadcasts an announcement to every member, pushing to devices that opted in', async () => {
    const priyaPhone = fakeBrowser('priya-phone');
    await call('POST', '/api/portal/notifications/subscriptions', priyaPhone.json, { token: otherToken });
    await call('PUT', '/api/portal/notifications/preferences', { announcements: false }, { token: otherToken });

    sent.length = 0;
    const res = await call(
      'POST',
      '/api/notifications/announcements',
      { title: 'Holiday hours', body: 'We open at 9am on Monday.', kind: 'holiday' },
      { token: staffToken },
    );
    assert.equal(res.status, 201);
    assert.equal(res.body.recipients, 2, 'both members get it in their notification center');
    assert.equal(res.body.devices, 1, 'only the opted-in device is pushed');
    await inGym(() => settlePushDeliveries());
    assert.deepEqual(sent.map((s) => s.url), [phone.json.endpoint]);

    const listed = await call('GET', '/api/notifications/announcements', undefined, { token: staffToken });
    assert.equal(listed.body.items[0].delivered, 1);

    const priyaInbox = await call('GET', '/api/portal/notifications', undefined, { token: otherToken });
    assert.equal(priyaInbox.body.items[0].title, 'Holiday hours');
  });

  it('pushes an urgent announcement past the announcements switch', async () => {
    sent.length = 0;
    const res = await call(
      'POST',
      '/api/notifications/announcements',
      { title: 'Closed today', body: 'A burst pipe — we are closed until tomorrow.', kind: 'closure', urgent: true },
      { token: staffToken },
    );
    assert.equal(res.body.devices, 2);
    await inGym(() => settlePushDeliveries());
    assert.equal(sent.length, 2);
    const payload = readPush(phone, sent.find((s) => s.url === phone.json.endpoint));
    assert.equal(payload.urgent, 1);
    // Named for the gym on the lock screen; the notification center keeps the plain title.
    assert.equal(payload.title, 'Push Gym: Closed today');
    assert.equal(sent[0].headers.Urgency, 'high');
  });

  it('rejects an announcement picture that is not an image', async () => {
    const res = await call(
      'POST',
      '/api/notifications/announcements',
      { title: 'Event', body: 'Zumba night', image: `data:text/html;base64,${Buffer.from('<script>').toString('base64')}` },
      { token: staffToken },
    );
    assert.equal(res.status, 400);
    assert.ok(res.body.details.image);
  });

  it('attaches a picture to an announcement, served by a tokened URL', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
    sent.length = 0;
    const res = await call(
      'POST',
      '/api/notifications/announcements',
      { title: 'Zumba night', body: 'Friday 7pm, bring a friend!', kind: 'event', image: `data:image/png;base64,${png.toString('base64')}` },
      { token: staffToken },
    );
    assert.equal(res.status, 201);
    assert.equal(res.body.image_bytes, undefined, 'the BLOB never rides along in JSON');
    assert.match(res.body.image_url, /^\/api\/announcement-images\/\d+\?t=[0-9a-f]{32}$/);
    await inGym(() => settlePushDeliveries());

    // The push points at it under the device's own /g/<slug> address.
    const payload = readPush(phone, sent.find((s) => s.url === phone.json.endpoint));
    assert.equal(payload.image, `/g/pushgym${res.body.image_url}`);

    // Fetchable with no session (the phone's notification system has none)…
    const image = await fetch(`${base}/g/pushgym${res.body.image_url}`);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
    // …but only with the right token.
    const guessed = await fetch(`${base}/g/pushgym${res.body.image_url.replace(/t=.*/, `t=${'0'.repeat(32)}`)}`);
    assert.equal(guessed.status, 404);

    const inbox = await call('GET', '/api/portal/notifications', undefined, { token: memberToken });
    assert.equal(inbox.body.items[0].image_url, res.body.image_url);
    const listed = await call('GET', '/api/notifications/announcements', undefined, { token: staffToken });
    assert.equal(listed.body.items[0].image_url, res.body.image_url);
    assert.equal(listed.body.items[0].image_bytes, undefined);
  });

  it('forgets a device the push service reports as gone', async () => {
    nextStatus = (url) => (url === phone.json.endpoint ? 410 : 201);
    await call('POST', '/api/portal/notifications/test', {}, { token: memberToken });
    nextStatus = 201;
    const config = await call('GET', '/api/portal/notifications/config', undefined, { token: memberToken });
    assert.equal(config.body.devices, 0);
  });

  it('moves a shared device to whoever subscribed it last', async () => {
    const tablet = fakeBrowser('shared-tablet');
    await call('POST', '/api/portal/notifications/subscriptions', tablet.json, { token: memberToken });
    await call('POST', '/api/portal/notifications/subscriptions', tablet.json, { token: otherToken });
    const owner = inGym(() => get('SELECT member_id FROM push_subscriptions WHERE endpoint = ?', [tablet.json.endpoint]));
    assert.notEqual(owner.member_id, memberId);

    const removed = await call('DELETE', '/api/portal/notifications/subscriptions', { endpoint: tablet.json.endpoint }, { token: otherToken });
    assert.equal(removed.status, 200);
  });

  it('saves the gym-wide schedule and validates the times', async () => {
    const bad = await call('PUT', '/api/notifications/settings', { water_times: '11:00, 25:00' }, { token: staffToken });
    assert.equal(bad.status, 400);

    const ok = await call(
      'PUT',
      '/api/notifications/settings',
      { water_times: '16:00, 10:00', workout_nudge_minutes: 90, nutrition_enabled: false },
      { token: staffToken },
    );
    assert.equal(ok.status, 200);
    assert.equal(ok.body.settings.water_times, '10:00,16:00');
    assert.equal(ok.body.settings.workout_nudge_minutes, 90);
    assert.equal(ok.body.settings.nutrition_enabled, 0);
    assert.equal(ok.body.reach.devices, 1);
  });
});
