import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

/**
 * The platform food catalogue: operator CRUD, bulk import and the blue tick,
 * and how each gym's food library follows it.
 *
 * Its own file because config.js reads PLATFORM_ADMIN_* once at import.
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-foodcat-test-'));
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

const TENANT = 'foodgym';

let base;
let server;
let ops;
let adminToken;
let memberToken;

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

const operator = (method, urlPath, body) => call(method, `/api/platform/admin/catalog/foods${urlPath}`, body, { token: ops });
const memberFoods = async (q) =>
  (await call('GET', `/api/portal/diets/foods${q ? `?q=${encodeURIComponent(q)}` : ''}`, undefined, { token: memberToken, tenant: TENANT })).body;
const memberFood = async (name) => (await memberFoods(name)).items.find((f) => f.name === name);

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  ops = (await call('POST', '/api/platform/admin/login', { email: 'ops@gymbook.test', password: 'operator-pass-123' })).body.token;

  await call('POST', '/api/platform/signup', {
    slug: TENANT,
    gym_name: 'Food Gym',
    admin_name: 'Owner',
    admin_email: `owner@${TENANT}.test`,
    admin_password: 'ownerpass123',
  });
  adminToken = (await call('POST', '/api/auth/login', { email: `owner@${TENANT}.test`, password: 'ownerpass123' }, { tenant: TENANT })).body.token;

  const member = await call('POST', '/api/members', { first_name: 'Asha', phone: '9876500022' }, { token: adminToken, tenant: TENANT });
  const plans = await call('GET', '/api/plans', undefined, { token: adminToken, tenant: TENANT });
  await call('POST', '/api/subscriptions', { member_id: member.body.id, plan_id: plans.body.items[0].id }, { token: adminToken, tenant: TENANT });
  await call('POST', '/api/fitness-addons/subscribe', { member_id: member.body.id }, { token: adminToken, tenant: TENANT });
  memberToken = (await call('POST', '/api/portal/login', { identifier: member.body.code, pin: '0022' }, { tenant: TENANT })).body.token;
});

after(() => {
  server.close();
  closeDb();
  closeRegistryDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('the platform food catalogue', () => {
  it('starts with the starter foods, unverified, and is operator-only', async () => {
    const res = await operator('GET', '');
    assert.equal(res.status, 200);
    assert.ok(res.body.total > 50);
    assert.equal(res.body.verified_total, 0);
    assert.ok(res.body.items.some((f) => f.name === 'Paneer' && f.verified === false));
    assert.ok(res.body.categories.includes('protein'));

    assert.equal((await call('GET', '/api/platform/admin/catalog/foods')).status, 401);
    assert.equal((await call('GET', '/api/platform/admin/catalog/foods', undefined, { token: adminToken })).status, 403);
  });

  it('adopts the gym\'s seeded copies instead of duplicating them', async () => {
    const foods = await memberFoods('Paneer');
    const paneer = foods.items.filter((f) => f.name.toLowerCase() === 'paneer');
    assert.equal(paneer.length, 1);
    assert.ok(paneer[0].catalog_id);
    assert.equal(paneer[0].is_custom, 0);
  });

  it('adds a food, and every gym gets it on its next food list', async () => {
    const created = await operator('POST', '', {
      name: 'Masala Dosa',
      category: 'meal',
      serving_unit: '100g',
      calories: 168,
      protein_g: 3.9,
      carbs_g: 25,
      fats_g: 5.9,
      serving_size_g: 180,
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.serving_label, '180 g', 'a portion size gets words when none are given');
    assert.equal(created.body.verified, false);

    assert.equal((await operator('POST', '', { name: 'masala dosa', calories: 1 })).status, 409);
    assert.equal((await operator('POST', '', { name: 'Thing', calories: 10, category: 'rocks' })).status, 400);
    assert.equal((await operator('POST', '', { name: 'Thing' })).status, 400, 'calories are required');

    const dosa = await memberFood('Masala Dosa');
    assert.equal(dosa.catalog_id, created.body.id);
    assert.equal(dosa.serving_size_g, 180);
    assert.equal(dosa.verified, 0);
  });

  it('puts the blue tick on verified foods for members and staff', async () => {
    const id = (await operator('GET', '?q=Masala Dosa')).body.items[0].id;
    const res = await operator('POST', '/bulk', { ids: [id], action: 'verify' });
    assert.equal(res.body.changed, 1);
    assert.equal((await operator('GET', '?verified=yes')).body.items.length, 1);

    assert.equal((await memberFood('Masala Dosa')).verified, 1);
    const staff = await call('GET', '/api/diets/foods?q=Masala', undefined, { token: adminToken, tenant: TENANT });
    assert.equal(staff.body.items.find((f) => f.name === 'Masala Dosa').verified, 1);

    assert.equal((await operator('POST', '/bulk', { ids: [id], action: 'explode' })).status, 400);
    assert.equal((await operator('POST', '/bulk', { ids: [], action: 'verify' })).status, 400);
  });

  it('updates gyms in place, so favourites and ids survive an edit', async () => {
    const dosa = await memberFood('Masala Dosa');
    const fav = await call('POST', '/api/portal/diets/favorites', { food_id: dosa.id }, { token: memberToken, tenant: TENANT });
    assert.equal(fav.status, 201);

    const id = dosa.catalog_id;
    const edited = await operator('PATCH', `/${id}`, { name: 'Masala Dosa (with potato)', calories: 175 });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.protein_g, 3.9, 'a patch leaves the rest alone');

    const renamed = await memberFood('Masala Dosa (with potato)');
    assert.equal(renamed.id, dosa.id);
    assert.equal(renamed.calories, 175);
    const favs = (await memberFoods()).favorites;
    assert.equal(favs.find((f) => f.food_id === dosa.id).food.name, 'Masala Dosa (with potato)');
  });

  it('imports a sheet: adds, updates by name, skips bad rows and flags odd numbers', async () => {
    const res = await operator('POST', '/import', {
      rows: [
        { name: 'Pesarattu', category: 'Vegetables', calories: '150', protein_g: '7.5 g', carbs_g: 20, fats_g: 4, serving_size_g: 90, serving_label: '1 pesarattu (90g)' },
        { name: 'Upma', category: 'grains', calories: 140, protein_g: 3.5, carbs_g: 22, fats_g: 4.2 },
        { name: 'PANEER', calories: 270 },
        { name: 'Mystery Bar', calories: 500, protein_g: 1, carbs_g: 2, fats_g: 1 },
        { name: '', calories: 100 },
        { name: 'No Calories' },
        { name: 'Bad Number', calories: 'lots' },
      ],
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.created, 3);
    assert.equal(res.body.updated, 1);
    assert.deepEqual(res.body.errors.map((e) => e.line), [5, 6, 7]);
    assert.deepEqual(res.body.warnings.map((w) => w.name), ['Mystery Bar']);

    const list = (await operator('GET', '')).body.items;
    const pesarattu = list.find((f) => f.name === 'Pesarattu');
    assert.equal(pesarattu.category, 'fruits', '"Vegetables" maps onto the fruit & veg category');
    assert.equal(pesarattu.protein_g, 7.5);
    assert.equal(list.find((f) => f.name === 'Upma').category, 'carbs');
    assert.equal(list.find((f) => f.name === 'Mystery Bar').verified, false);

    // Matched case-insensitively, the catalogue's spelling kept, and columns
    // the sheet left out not blanked.
    const paneer = list.find((f) => f.name === 'Paneer');
    assert.equal(paneer.calories, 270);
    assert.equal(paneer.protein_g, 18);
    assert.equal((await memberFood('Paneer')).calories, 270);

    const ticked = await operator('POST', '/import', { rows: [{ name: 'Ragi Mudde', calories: 110, carbs_g: 24, protein_g: 2.5, fats_g: 0.4, verified: '' }], verified: true });
    assert.equal(ticked.body.created, 1);
    assert.equal((await operator('GET', '?q=Ragi')).body.items[0].verified, true);

    assert.equal((await operator('POST', '/import', { rows: 'nope' })).status, 400);
  });

  it('adopts a gym\'s own food of the same name, but never a scanned pack', async () => {
    const own = await call('POST', '/api/diets/foods', { name: 'Protein Ladoo', calories: 120, protein_g: 6 }, { token: adminToken, tenant: TENANT });
    assert.equal(own.body.is_custom, 1);

    await operator('POST', '', { name: 'Protein Ladoo', category: 'supplements', calories: 130, protein_g: 8, carbs_g: 12, fats_g: 4 });
    const ladoos = (await memberFoods('Protein Ladoo')).items.filter((f) => f.name === 'Protein Ladoo');
    assert.equal(ladoos.length, 1);
    assert.equal(ladoos[0].id, own.body.id);
    assert.equal(ladoos[0].calories, 130);
    assert.equal(ladoos[0].is_custom, 0);

    // Now a catalogue food, staff can no longer delete it from their gym.
    const del = await call('DELETE', `/api/diets/foods/${own.body.id}`, undefined, { token: adminToken, tenant: TENANT });
    assert.equal(del.status, 400);

    // A scanned pack keeps the label's numbers, even when the catalogue has
    // a food of the same name — that gym just doesn't get the catalogue's.
    const pack = await call(
      'POST',
      '/api/portal/diets/barcode-foods',
      { barcode: '8901234567890', name: 'Choco Oats Bar', basis: '100g', calories: 420, protein_g: 9 },
      { token: memberToken, tenant: TENANT },
    );
    assert.equal(pack.status, 201);
    await operator('POST', '', { name: 'Choco Oats Bar', calories: 380, protein_g: 8, carbs_g: 60, fats_g: 12 });
    const bars = (await memberFoods('Choco Oats Bar')).items.filter((f) => f.name === 'Choco Oats Bar');
    assert.equal(bars.length, 1);
    assert.equal(bars[0].calories, 420);
    assert.equal(bars[0].catalog_id, null);
  });

  it('removes deleted foods from gyms, keeping what members already logged', async () => {
    const ragi = await memberFood('Ragi Mudde');
    const entry = await call('POST', '/api/portal/diets/entries', { meal_type: 'lunch', food_id: ragi.id, quantity: 2 }, { token: memberToken, tenant: TENANT });
    assert.equal(entry.status, 201);

    const catalogId = ragi.catalog_id;
    assert.equal((await operator('DELETE', `/${catalogId}`)).status, 200);
    assert.equal((await operator('DELETE', `/${catalogId}`)).status, 404);

    assert.equal(await memberFood('Ragi Mudde'), undefined);
    const day = await call('GET', '/api/portal/diets/daily', undefined, { token: memberToken, tenant: TENANT });
    const logged = day.body.entries.find((e) => e.food_name === 'Ragi Mudde');
    assert.equal(logged.calories, 220);
    // Recent still offers it, as a hand-typed copy now.
    const recent = (await memberFoods()).recent.find((r) => r.food_name === 'Ragi Mudde');
    assert.equal(recent.food, null);

    const many = (await operator('GET', '?q=Upma')).body.items.map((f) => f.id);
    assert.equal((await operator('POST', '/bulk', { ids: many, action: 'delete' })).body.changed, 1);
    assert.equal(await memberFood('Upma'), undefined);
  });
});
