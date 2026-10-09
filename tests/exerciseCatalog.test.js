import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

/**
 * The platform exercise catalogue: operator CRUD, demo uploads, and what gyms
 * and members see of it.
 *
 * Its own file for the same reason as platformConsole.test.js — config.js reads
 * PLATFORM_ADMIN_* and the media dir once at import.
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-catalog-test-'));
process.env.NODE_ENV = 'test';
process.env.DB_FILE = path.join(tmpDir, 'default.db');
process.env.PLATFORM_DB_FILE = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.EXERCISE_MEDIA_DIR = path.join(tmpDir, 'media');
process.env.BACKUP_DIR = path.join(tmpDir, 'backups');
process.env.BACKUP_INTERVAL_HOURS = '0';
process.env.AUTH_SECRET = 'test-secret';
process.env.PLATFORM_ADMIN_EMAIL = 'ops@gymbook.test';
process.env.PLATFORM_ADMIN_PASSWORD = 'operator-pass-123';

const { createApp } = await import('../src/app.js');
const { closeDb } = await import('../src/db.js');
const { closeRegistryDb } = await import('../src/tenants.js');

const TENANT = 'catgym';

// Smallest buffers that carry a real signature, padded past the 12-byte floor.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 1)]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(24, 2)]);
const GIF_2 = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(24, 3)]);

let base;
let server;
let ops;
let adminToken;
let memberToken;

const call = async (method, urlPath, body, { token, tenant, raw, contentType } = {}) => {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers: {
      ...(body && !raw ? { 'Content-Type': 'application/json' } : {}),
      ...(raw ? { 'Content-Type': contentType ?? 'application/octet-stream' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(tenant ? { 'X-Tenant-Slug': tenant } : {}),
    },
    body: raw ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed, headers: res.headers, text };
};

const catalog = (urlPath = '', opts = {}) => call('GET', `/api/platform/admin/catalog/exercises${urlPath}`, undefined, { token: ops, ...opts });

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  ops = (await call('POST', '/api/platform/admin/login', { email: 'ops@gymbook.test', password: 'operator-pass-123' })).body.token;

  await call('POST', '/api/platform/signup', {
    slug: TENANT,
    gym_name: 'Catalog Gym',
    admin_name: 'Owner',
    admin_email: `owner@${TENANT}.test`,
    admin_password: 'ownerpass123',
  });
  adminToken = (await call('POST', '/api/auth/login', { email: `owner@${TENANT}.test`, password: 'ownerpass123' }, { tenant: TENANT })).body.token;

  const member = await call('POST', '/api/members', { first_name: 'Rahul', last_name: 'Verma', phone: '9876500011' }, { token: adminToken, tenant: TENANT });
  const plans = await call('GET', '/api/plans', undefined, { token: adminToken, tenant: TENANT });
  await call('POST', '/api/subscriptions', { member_id: member.body.id, plan_id: plans.body.items[0].id }, { token: adminToken, tenant: TENANT });
  await call('PUT', '/api/fitness-addons/settings', { monthly_price: 599, trial_days: 0 }, { token: adminToken, tenant: TENANT });
  await call('POST', '/api/fitness-addons/subscribe', { member_id: member.body.id, months: 1, method: 'upi', reference: 'UPI-1' }, { token: adminToken, tenant: TENANT });
  memberToken = (await call('POST', '/api/portal/login', { identifier: member.body.code, pin: '0011' }, { tenant: TENANT })).body.token;
});

after(() => {
  server.close();
  closeDb();
  closeRegistryDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('catalogue access', () => {
  it('is closed to anyone but the operator', async () => {
    assert.equal((await call('GET', '/api/platform/admin/catalog/exercises')).status, 401);
    const asGym = await call('GET', '/api/platform/admin/catalog/exercises', undefined, { token: adminToken, tenant: TENANT });
    assert.equal(asGym.status, 403, 'a gym owner is not a platform operator');
  });

  it('starts with the standard exercises, once', async () => {
    const res = await catalog();
    assert.equal(res.status, 200);
    assert.ok(res.body.total >= 60);
    assert.ok(res.body.items.find((e) => e.name === 'Deadlift'));
    assert.deepEqual(res.body.items[0].secondary_muscles, []);
    assert.equal(res.body.items[0].media_url, null);
  });
});

describe('operator CRUD', () => {
  let id;

  it('creates an exercise with secondary muscles and tags', async () => {
    const res = await call(
      'POST',
      '/api/platform/admin/catalog/exercises',
      {
        name: '  Cable   Pull-Through ',
        muscle_group: 'legs',
        equipment: 'cable',
        secondary_muscles: ['back', 'legs', 'core', 'back'],
        tags: ['Compound', 'hinge'],
        instructions: 'Hinge at the hips.',
      },
      { token: ops },
    );
    assert.equal(res.status, 201);
    assert.equal(res.body.name, 'Cable Pull-Through', 'whitespace is collapsed');
    assert.deepEqual(res.body.secondary_muscles, ['back', 'core'], 'deduped, and never the primary muscle');
    assert.deepEqual(res.body.tags, ['compound', 'hinge']);
    id = res.body.id;
  });

  it('refuses a duplicate name in any case', async () => {
    const res = await call('POST', '/api/platform/admin/catalog/exercises', { name: 'cable pull-through', muscle_group: 'legs', equipment: 'cable' }, { token: ops });
    assert.equal(res.status, 409);
  });

  it('rejects an unknown muscle group or equipment', async () => {
    const bad = await call('POST', '/api/platform/admin/catalog/exercises', { name: 'Nope', muscle_group: 'toes', equipment: 'cable' }, { token: ops });
    assert.equal(bad.status, 400);
    const badGear = await call('POST', '/api/platform/admin/catalog/exercises', { name: 'Nope', muscle_group: 'legs', equipment: 'trebuchet' }, { token: ops });
    assert.equal(badGear.status, 400);
  });

  it('patches one field without resetting the rest', async () => {
    const res = await call('PATCH', `/api/platform/admin/catalog/exercises/${id}`, { instructions: 'Squeeze the glutes.' }, { token: ops });
    assert.equal(res.status, 200);
    assert.equal(res.body.instructions, 'Squeeze the glutes.');
    assert.deepEqual(res.body.secondary_muscles, ['back', 'core']);
    assert.equal(res.body.equipment, 'cable');
  });

  it('drops a secondary muscle that becomes the primary one', async () => {
    const res = await call('PATCH', `/api/platform/admin/catalog/exercises/${id}`, { muscle_group: 'back' }, { token: ops });
    assert.deepEqual(res.body.secondary_muscles, ['core']);
  });

  it('filters by search, muscle and media', async () => {
    assert.ok((await catalog('?q=pull-through')).body.items.some((e) => e.id === id));
    assert.equal((await catalog('?muscle_group=cardio')).body.items.every((e) => e.muscle_group === 'cardio'), true);
    assert.equal((await catalog('?media=yes')).body.items.some((e) => e.id === id), false);
  });

  it('deletes', async () => {
    assert.equal((await call('DELETE', `/api/platform/admin/catalog/exercises/${id}`, undefined, { token: ops })).status, 200);
    assert.equal((await call('PATCH', `/api/platform/admin/catalog/exercises/${id}`, { name: 'x1' }, { token: ops })).status, 404);
  });
});

describe('demo media', () => {
  let exercise;

  before(async () => {
    exercise = (await catalog('?q=Deadlift')).body.items.find((e) => e.name === 'Deadlift');
  });

  const upload = (bytes, id = exercise.id, contentType = 'application/octet-stream') =>
    call('PUT', `/api/platform/admin/catalog/exercises/${id}/media`, bytes, { token: ops, raw: true, contentType });

  it('accepts a GIF and serves it, cacheable for good', async () => {
    const res = await upload(GIF, exercise.id, 'image/gif');
    assert.equal(res.status, 200);
    assert.equal(res.body.media_type, 'gif');
    assert.equal(res.body.media_mime, 'image/gif');
    assert.match(res.body.media_url, /^\/api\/exercise-media\/\d+-[a-f0-9]{8}\.gif$/);

    const served = await fetch(`${base}${res.body.media_url}`);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get('content-type'), 'image/gif');
    assert.match(served.headers.get('cache-control'), /immutable/);
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), GIF);
  });

  it('judges the file by its bytes, not its declared type', async () => {
    const html = Buffer.from('<html><script>alert(1)</script></html>');
    const res = await upload(html, exercise.id, 'image/gif');
    assert.equal(res.status, 400);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
    assert.equal((await upload(svg, exercise.id, 'image/svg+xml')).status, 400);
  });

  it('refuses an oversize upload with a clear status', async () => {
    const huge = Buffer.concat([PNG, Buffer.alloc(9 * 1024 * 1024)]);
    assert.equal((await upload(huge)).status, 413);
  });

  it('replacing the demo removes the old file and gives a new URL', async () => {
    const first = (await upload(GIF, exercise.id)).body;
    const second = (await upload(GIF_2, exercise.id)).body;
    assert.notEqual(first.media_url, second.media_url);
    assert.equal((await fetch(`${base}${first.media_url}`)).status, 404);
    assert.equal((await fetch(`${base}${second.media_url}`)).status, 200);
  });

  it('will not serve anything that is not a catalogue file name', async () => {
    assert.equal((await fetch(`${base}/api/exercise-media/..%2Fplatform.db`)).status, 404);
    assert.equal((await fetch(`${base}/api/exercise-media/passwd`)).status, 404);
  });

  it('shows up in what a gym and a member see', async () => {
    const png = (await upload(PNG, exercise.id)).body;

    const staff = await call('GET', '/api/workouts/exercises?q=Deadlift', undefined, { token: adminToken, tenant: TENANT });
    const staffRow = staff.body.items.find((e) => e.name === 'Deadlift');
    assert.equal(staffRow.media_url, png.media_url);
    assert.equal(staffRow.media_type, 'image');
    assert.equal(staff.body.items.filter((e) => e.name === 'Deadlift').length, 1, 'the gym\'s own seeded copy is not listed twice');

    const portal = await call('GET', '/api/portal/workouts/exercises?q=Deadlift', undefined, { token: memberToken, tenant: TENANT });
    assert.equal(portal.status, 200, JSON.stringify(portal.body));
    assert.equal(portal.body.items.find((e) => e.name === 'Deadlift').media_url, png.media_url);
  });

  it('clears the demo', async () => {
    const cleared = await call('DELETE', `/api/platform/admin/catalog/exercises/${exercise.id}/media`, undefined, { token: ops });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.media_url, null);
  });

  it('deleting an exercise deletes its file', async () => {
    const made = await call('POST', '/api/platform/admin/catalog/exercises', { name: 'Temp Move', muscle_group: 'core', equipment: 'bodyweight' }, { token: ops });
    const withMedia = await upload(GIF, made.body.id);
    const file = withMedia.body.media_url.split('/').pop();
    assert.ok(fs.existsSync(path.join(process.env.EXERCISE_MEDIA_DIR, file)));
    await call('DELETE', `/api/platform/admin/catalog/exercises/${made.body.id}`, undefined, { token: ops });
    assert.equal(fs.existsSync(path.join(process.env.EXERCISE_MEDIA_DIR, file)), false);
  });
});

describe('what gyms see', () => {
  it('merges a gym\'s custom exercise with the catalogue', async () => {
    const made = await call('POST', '/api/workouts/exercises', { name: 'House Special Carry', muscle_group: 'full_body', equipment: 'kettlebell' }, { token: adminToken, tenant: TENANT });
    assert.equal(made.status, 201);

    const list = await call('GET', '/api/workouts/exercises', undefined, { token: adminToken, tenant: TENANT });
    const custom = list.body.items.find((e) => e.name === 'House Special Carry');
    assert.equal(custom.source, 'gym');
    assert.equal(custom.media_url, null);
    assert.ok(list.body.items.find((e) => e.name === 'Barbell Bench Press' && e.source === 'catalog'));
  });

  it('returns the catalogue entry when a gym "adds" a standard exercise', async () => {
    const res = await call('POST', '/api/workouts/exercises', { name: 'deadlift', muscle_group: 'back', equipment: 'barbell' }, { token: adminToken, tenant: TENANT });
    assert.equal(res.status, 200);
    assert.equal(res.body.source, 'catalog');
  });

  it('puts the demo on a member\'s routine', async () => {
    const exercise = (await catalog('?q=Pull-Up')).body.items.find((e) => e.name === 'Pull-Up');
    await call('PUT', `/api/platform/admin/catalog/exercises/${exercise.id}/media`, GIF, { token: ops, raw: true });

    const templates = (await call('GET', '/api/workouts/templates', undefined, { token: adminToken, tenant: TENANT })).body.items;
    const ppl = templates.find((t) => t.name.startsWith('Push / Pull / Legs'));
    const members = (await call('GET', '/api/members', undefined, { token: adminToken, tenant: TENANT })).body.items;
    await call('POST', '/api/workouts/assign', { member_id: members[0].id, plan_id: ppl.id }, { token: adminToken, tenant: TENANT });

    const current = await call('GET', '/api/portal/workouts/current', undefined, { token: memberToken, tenant: TENANT });
    assert.equal(current.status, 200);
    const pullDay = current.body.plan.days.find((d) => d.day_name.includes('Pull (Back'));
    const row = pullDay.exercises.find((e) => e.exercise_name === 'Pull-Up');
    assert.equal(row.media_type, 'gif');
    assert.match(row.media_url, /\.gif$/);
    assert.equal(pullDay.exercises.find((e) => e.exercise_name === 'Face Pull').media_url, null, 'no demo yet, no URL');
  });
});

describe('bulk import', () => {
  it('creates new rows, updates existing ones, and reports bad lines', async () => {
    const res = await call(
      'POST',
      '/api/platform/admin/catalog/import',
      {
        rows: [
          { name: 'Landmine Press', muscle_group: 'shoulders', equipment: 'barbell', secondary_muscles: 'chest, arms', tags: 'unilateral' },
          { name: 'Deadlift', instructions: 'Brace, push the floor away.' },
          { name: 'Mystery Move', muscle_group: 'wings', equipment: 'barbell' },
          { name: '', muscle_group: 'legs' },
        ],
      },
      { token: ops },
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.created, 1);
    assert.equal(res.body.updated, 1);
    assert.deepEqual(res.body.errors.map((e) => e.line), [3, 4]);

    const landmine = (await catalog('?q=Landmine')).body.items[0];
    assert.deepEqual(landmine.secondary_muscles, ['chest', 'arms']);
    const deadlift = (await catalog('?q=Deadlift')).body.items.find((e) => e.name === 'Deadlift');
    assert.equal(deadlift.instructions, 'Brace, push the floor away.');
    assert.equal(deadlift.muscle_group, 'back', 'columns the sheet did not carry are left alone');
  });

  it('caps the size of one import', async () => {
    const rows = Array.from({ length: 1001 }, (_, i) => ({ name: `Bulk ${i}`, muscle_group: 'core' }));
    assert.equal((await call('POST', '/api/platform/admin/catalog/import', { rows }, { token: ops })).status, 400);
  });
});
