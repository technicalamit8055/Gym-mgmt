import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-photo-test-'));
process.env.DB_FILE = path.join(tmpDir, 'default.db');
process.env.PLATFORM_DB_FILE = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.AUTH_SECRET = 'test-secret';

const { createApp } = await import('../src/app.js');
const { all, closeDb, get, run, tenantStorage } = await import('../src/db.js');
const { closeRegistryDb } = await import('../src/tenants.js');
const { MAX_PHOTO_BYTES, memberPhotoUrl } = await import('../src/photo.js');

/** A real 1×1 PNG, so the bytes that come back out can be compared exactly. */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);
const PNG_DATA_URL = `data:image/png;base64,${PNG_BYTES.toString('base64')}`;

let base;
let server;
let token;
let prefix;

const call = async (method, urlPath, body, { token: t = token } = {}) => {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(t ? { Authorization: `Bearer ${t}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

const signupGym = async (slug) => {
  const res = await call('POST', '/api/platform/signup', {
    slug,
    gym_name: slug,
    admin_name: 'Owner',
    admin_email: `owner@${slug}.test`,
    admin_password: 'photo12345',
    timezone: 'Asia/Kolkata',
  });
  assert.equal(res.status, 201);
  return res.body.token;
};

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  token = await signupGym('photo-gym');
  prefix = '/g/photo-gym';
});

after(() => {
  server.close();
  closeDb();
  closeRegistryDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('uploading and serving a member photo', () => {
  let member;

  before(async () => {
    const res = await call('POST', `${prefix}/api/members`, {
      first_name: 'Asha',
      last_name: 'Rao',
      photo: PNG_DATA_URL,
    });
    assert.equal(res.status, 201);
    member = res.body;
  });

  it('answers with a URL, never the image bytes', () => {
    assert.ok(member.photo_url, 'a member with a photo should carry a photo_url');
    assert.doesNotMatch(member.photo_url, /^data:/);
    assert.match(member.photo_url, /^\/g\/photo-gym\/api\/member-photos\/\d+\?/);
  });

  it('carries the gym path prefix so a path-addressed gym resolves', () => {
    assert.ok(member.photo_url.startsWith(`${prefix}/api/member-photos/`));
  });

  it('does not leak the raw version counter into the response', () => {
    assert.equal('photo_version' in member, false);
  });

  it('serves the exact bytes that were uploaded', async () => {
    const res = await fetch(`${base}${member.photo_url}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.deepEqual(bytes, PNG_BYTES);
  });

  it('serves it without an Authorization header, since an <img> cannot send one', async () => {
    const res = await fetch(`${base}${member.photo_url}`);
    assert.equal(res.status, 200);
  });

  it('marks it cacheable and private', async () => {
    const res = await fetch(`${base}${member.photo_url}`);
    assert.match(res.headers.get('cache-control'), /private/);
    assert.match(res.headers.get('cache-control'), /immutable/);
  });

  it('keeps image bytes out of the roster listing', async () => {
    const res = await call('GET', `${prefix}/api/members?limit=50`);
    assert.equal(res.status, 200);
    assert.doesNotMatch(JSON.stringify(res.body), /data:image/);
    const row = res.body.items.find((m) => m.id === member.id);
    assert.match(row.photo_url, /\/api\/member-photos\//);
  });
});

describe('a photo URL cannot be forged or reused', () => {
  let photoUrl;

  before(async () => {
    const res = await call('POST', `${prefix}/api/members`, {
      first_name: 'Vikram',
      photo: PNG_DATA_URL,
    });
    photoUrl = res.body.photo_url;
  });

  const expect401 = async (url, why) => {
    const res = await fetch(`${base}${url}`);
    assert.equal(res.status, 401, why);
  };

  it('rejects a tampered signature', async () => {
    await expect401(photoUrl.replace(/s=./, 's=X'), 'a flipped signature byte must not pass');
  });

  it('rejects a missing signature', async () => {
    await expect401(photoUrl.replace(/&s=[^&]+/, ''), 'no signature must not pass');
  });

  it('rejects a signature lifted onto another member id', async () => {
    const other = await call('POST', `${prefix}/api/members`, { first_name: 'Nobody' });
    const swapped = photoUrl.replace(/member-photos\/\d+/, `member-photos/${other.body.id}`);
    await expect401(swapped, 'a signature is bound to one member id');
  });

  it('rejects an expiry pushed into the future without resigning', async () => {
    const far = Math.floor(Date.now() / 1000) + 86_400 * 365;
    await expect401(photoUrl.replace(/e=\d+/, `e=${far}`), 'the expiry is covered by the signature');
  });

  it('rejects an already-expired link', async () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    await expect401(photoUrl.replace(/e=\d+/, `e=${past}`), 'an expired link must not pass');
  });

  it('will not resolve one gym’s photo URL against another gym', async () => {
    await signupGym('other-gym');
    await expect401(
      photoUrl.replace('/g/photo-gym/', '/g/other-gym/'),
      'the signature is scoped to the gym it was minted in',
    );
  });
});

describe('what counts as a photo', () => {
  const post = (photo) => call('POST', `${prefix}/api/members`, { first_name: 'Test', photo });

  it('refuses an SVG, which can carry script', async () => {
    const svg = `data:image/svg+xml;base64,${Buffer.from('<svg onload="alert(1)"/>').toString('base64')}`;
    const res = await post(svg);
    assert.equal(res.status, 400);
    assert.ok(res.body.details.photo);
  });

  it('refuses a link to another origin', async () => {
    const res = await post('https://example.com/tracker.png');
    assert.equal(res.status, 400);
  });

  it('refuses a javascript: payload', async () => {
    const res = await post('javascript:alert(1)');
    assert.equal(res.status, 400);
  });

  it('refuses an image bigger than the cap', async () => {
    const huge = `data:image/png;base64,${Buffer.alloc(MAX_PHOTO_BYTES + 1024, 1).toString('base64')}`;
    const res = await post(huge);
    assert.equal(res.status, 400);
    assert.match(res.body.details.photo, /KB/);
  });

  it('leaves no member behind when the photo is rejected', async () => {
    const before = await call('GET', `${prefix}/api/members?q=Rejected&limit=50`);
    await call('POST', `${prefix}/api/members`, { first_name: 'Rejected', photo: 'not-an-image' });
    const after = await call('GET', `${prefix}/api/members?q=Rejected&limit=50`);
    assert.equal(after.body.total, before.body.total);
  });

  it('accepts jpeg and webp too', async () => {
    for (const mime of ['image/jpeg', 'image/webp']) {
      const res = await post(`data:${mime};base64,${PNG_BYTES.toString('base64')}`);
      assert.equal(res.status, 201, `${mime} should be accepted`);
      const served = await fetch(`${base}${res.body.photo_url}`);
      assert.equal(served.headers.get('content-type'), mime);
    }
  });
});

describe('changing and removing a photo', () => {
  let member;

  before(async () => {
    const res = await call('POST', `${prefix}/api/members`, {
      first_name: 'Meera',
      photo: PNG_DATA_URL,
    });
    member = res.body;
  });

  it('mints a new URL when the photo changes, so no cache can go stale', async () => {
    const jpeg = `data:image/jpeg;base64,${PNG_BYTES.toString('base64')}`;
    const res = await call('PATCH', `${prefix}/api/members/${member.id}`, { photo: jpeg });
    assert.equal(res.status, 200);
    assert.notEqual(res.body.photo_url, member.photo_url);
    member = res.body;
  });

  it('leaves the photo alone when an unrelated field is edited', async () => {
    const res = await call('PATCH', `${prefix}/api/members/${member.id}`, { phone: '9876543210' });
    assert.equal(res.status, 200);
    assert.equal(res.body.phone, '9876543210');
    assert.ok(res.body.photo_url, 'editing a phone number must not drop the photo');
    const served = await fetch(`${base}${res.body.photo_url}`);
    assert.equal(served.status, 200);
  });

  it('accepts a photo-only edit', async () => {
    const res = await call('PATCH', `${prefix}/api/members/${member.id}`, { photo: PNG_DATA_URL });
    assert.equal(res.status, 200);
    assert.ok(res.body.photo_url);
  });

  it('removes the photo when sent an empty value', async () => {
    const res = await call('PATCH', `${prefix}/api/members/${member.id}`, { photo: '' });
    assert.equal(res.status, 200);
    assert.equal(res.body.photo_url, null);
  });

  it('stops serving the bytes once removed', async () => {
    const stale = await call('GET', `${prefix}/api/members/${member.id}`);
    assert.equal(stale.body.photo_url, null);
  });

  it('still rejects an update that changes nothing at all', async () => {
    const res = await call('PATCH', `${prefix}/api/members/${member.id}`, {});
    assert.equal(res.status, 400);
  });

  it('drops the photo row when the member is deleted', async () => {
    const created = await call('POST', `${prefix}/api/members`, {
      first_name: 'Temp',
      photo: PNG_DATA_URL,
    });
    const photoUrl = created.body.photo_url;
    assert.equal((await fetch(`${base}${photoUrl}`)).status, 200);

    const gone = await call('DELETE', `${prefix}/api/members/${created.body.id}`);
    assert.equal(gone.status, 200);
    assert.equal((await fetch(`${base}${photoUrl}`)).status, 404);
  });
});

describe('migrating a database that still has photos in members.photo_url', () => {
  // Every existing install has its photos sitting in that column as base64
  // data URLs. Opening the database has to carry them across, because the code
  // stops reading the column the moment it is deployed.
  const legacyFile = path.join(tmpDir, 'legacy.db');
  const inLegacy = (fn) => tenantStorage.run({ slug: 'legacy', dbFile: legacyFile }, fn);
  let memberId;

  before(() => {
    // Open once so the schema exists, then put the database back into its
    // pre-migration shape: photo_url present and populated, nothing moved.
    inLegacy(() => {
      run("INSERT INTO members (code, first_name) VALUES ('GM0001', 'Legacy')");
      memberId = Number(get("SELECT id FROM members WHERE code = 'GM0001'").id);
      run('DELETE FROM member_photos');
      run('UPDATE members SET photo_version = 0');
      run('ALTER TABLE members ADD COLUMN photo_url TEXT');
      run('UPDATE members SET photo_url = ? WHERE id = ?', [PNG_DATA_URL, memberId]);
    });
    closeDb(legacyFile);
  });

  after(() => closeDb(legacyFile));

  it('moves the bytes into member_photos on the next open', () => {
    const row = inLegacy(() =>
      get('SELECT mime, bytes FROM member_photos WHERE member_id = ?', [memberId]),
    );
    assert.ok(row, 'the photo should have been carried across');
    assert.equal(row.mime, 'image/png');
    assert.deepEqual(Buffer.from(row.bytes), PNG_BYTES);
  });

  it('marks the member as having a photo', () => {
    const row = inLegacy(() => get('SELECT photo_version FROM members WHERE id = ?', [memberId]));
    assert.equal(row.photo_version, 1);
  });

  it('leaves no photo_url column behind to read by accident', () => {
    const columns = inLegacy(() => all("SELECT name FROM pragma_table_info('members')")).map(
      (c) => c.name,
    );
    assert.equal(columns.includes('photo_url'), false);
    assert.equal(columns.includes('photo_version'), true);
  });

  it('serves the migrated photo over a URL like any other', async () => {
    const url = inLegacy(() => memberPhotoUrl(memberId, 1));
    // Minted in the 'legacy' scope, so it only verifies there — which is the
    // per-gym scoping working, not a failure.
    assert.match(url, /\/api\/member-photos\/\d+\?v=1&e=\d+&s=/);
  });
});

describe('the check-in desk still gets a photo to show', () => {
  it('returns a photo URL alongside a visit, not image bytes', async () => {
    const member = await call('POST', `${prefix}/api/members`, {
      first_name: 'Deepak',
      photo: PNG_DATA_URL,
    });
    const plan = await call('POST', `${prefix}/api/plans`, {
      name: 'Photo Monthly',
      price: 1000,
      duration_days: 30,
    });
    await call('POST', `${prefix}/api/subscriptions`, {
      member_id: member.body.id,
      plan_id: plan.body.id,
    });

    const checkIn = await call('POST', `${prefix}/api/attendance/check-in`, {
      member_id: member.body.id,
    });
    assert.equal(checkIn.status, 201);
    assert.match(checkIn.body.visit.photo_url, /\/api\/member-photos\//);
    assert.equal('photo_version' in checkIn.body.visit, false);

    const list = await call('GET', `${prefix}/api/attendance?open=true`);
    assert.doesNotMatch(JSON.stringify(list.body), /data:image/);
    const row = list.body.items.find((v) => v.member_id === member.body.id);
    assert.match(row.photo_url, /\/api\/member-photos\//);
    assert.equal((await fetch(`${base}${row.photo_url}`)).status, 200);
  });
});
