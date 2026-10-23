import assert from 'node:assert/strict';
import { memberToken as signInMember } from './helpers/memberAuth.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-wearables-test-'));
process.env.DB_FILE = path.join(tmpDir, 'default.db');
process.env.PLATFORM_DB_FILE = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.AUTH_SECRET = 'test-secret';

const { createApp } = await import('../src/app.js');
const { closeDb, tenantStorage } = await import('../src/db.js');
const { closeRegistryDb, tenantDbPath } = await import('../src/tenants.js');
const { SYNC_WINDOW_DAYS, cleanSyncDays } = await import('../src/wearables.js');
const { addDays, today } = await import('../src/validate.js');

const TENANT = 'weargym';
const inGym = (fn) => tenantStorage.run({ slug: TENANT, dbFile: tenantDbPath(TENANT), timezone: 'UTC', businessType: 'gym' }, fn);

let base;
let server;

const call = async (method, urlPath, body, { token, tenant = TENANT } = {}) => {
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

let adminToken;
let memberToken;
let memberId;
let otherToken;
let todayIso;

async function addMember(firstName, phone) {
  const member = await call('POST', '/api/members', { first_name: firstName, phone }, { token: adminToken });
  return member.body.id;
}

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  await call('POST', '/api/platform/signup', {
    slug: TENANT,
    gym_name: 'Wear Gym',
    admin_name: 'Owner',
    admin_email: 'owner@weargym.test',
    admin_password: 'ownerpass123',
  }, { tenant: null });
  adminToken = (await call('POST', '/api/auth/login', { email: 'owner@weargym.test', password: 'ownerpass123' })).body.token;

  // A gym that charges for the tracker, with no trial: wearables are part of it.
  await call('PUT', '/api/fitness-addons/settings', { monthly_price: 599, trial_days: 0 }, { token: adminToken });

  memberId = await addMember('Asha', '9876511001');
  memberToken = await signInMember(call, { staffToken: adminToken, memberId });
  const otherId = await addMember('Ravi', '9876511002');
  otherToken = await signInMember(call, { staffToken: adminToken, memberId: otherId });
  for (const id of [memberId, otherId]) {
    await call('POST', '/api/fitness-addons/subscribe', { member_id: id }, { token: adminToken });
  }
  // The gym's own calendar day, which is what every sync is checked against.
  todayIso = (await call('GET', '/api/portal/diets/daily', undefined, { token: memberToken })).body.log_date;
});

after(() => {
  server.close();
  closeDb();
  closeRegistryDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('cleaning a sync', () => {
  // Checked in a UTC gym, so its today is the one cleanSyncDays sees.
  const day0 = inGym(today);
  const clean = (days) => inGym(() => cleanSyncDays(days));

  it('drops days after today and before the window, keeping the rest', () => {
    const days = clean([
      { date: addDays(day0, 1), steps: 10 },
      { date: addDays(day0, -(SYNC_WINDOW_DAYS + 1)), steps: 10 },
      { date: day0, steps: 4321.6, active_calories: 300, distance_m: 2500, active_minutes: 30 },
    ]);
    assert.deepEqual(days, [{ date: day0, steps: 4322, active_calories: 300, distance_m: 2500, active_minutes: 30 }]);
  });

  it('keeps a metric the source does not share as null, and the last entry for a repeated date', () => {
    const days = clean([
      { date: day0, steps: 100 },
      { date: day0, steps: 200, active_calories: null },
    ]);
    assert.deepEqual(days, [{ date: day0, steps: 200, active_calories: null, distance_m: null, active_minutes: null }]);
  });

  it('caps a metric at what a person could do in a day', () => {
    assert.equal(clean([{ date: day0, steps: 10_000_000 }])[0].steps, 200_000);
  });

  it('refuses anything that is not a list of days', () => {
    assert.equal(clean('lots'), null);
    assert.equal(clean([{ date: 'yesterday' }]), null);
    assert.equal(clean([{ date: day0, steps: -5 }]), null);
    assert.equal(clean([{ date: day0, steps: '9000' }]), null);
    assert.equal(clean(Array.from({ length: SYNC_WINDOW_DAYS + 2 }, () => ({ date: day0 }))), null);
  });
});

describe('connecting Health Connect', () => {
  it('is part of the paid tracker', async () => {
    const id = await addMember('Nobody', '9876511009');
    const token = await signInMember(call, { staffToken: adminToken, memberId: id });
    const res = await call('GET', '/api/portal/wearables', undefined, { token });
    assert.equal(res.status, 402);
    assert.equal(res.body.details.code, 'fitness_addon_required');
  });

  it('starts with nothing connected', async () => {
    const res = await call('GET', '/api/portal/wearables', undefined, { token: memberToken });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.providers, ['health_connect']);
    assert.deepEqual(res.body.connections, []);
    assert.deepEqual(res.body.days, []);
    assert.equal(res.body.step_goal, 10_000);
  });

  it('refuses a sync before the app is connected, and an app it does not know', async () => {
    const early = await call('POST', '/api/portal/wearables/health_connect/sync', { days: [] }, { token: memberToken });
    assert.equal(early.status, 409);
    const unknown = await call('POST', '/api/portal/wearables/fitbit/connect', undefined, { token: memberToken });
    assert.equal(unknown.status, 404);
  });

  it('connects once, however often it is asked', async () => {
    const first = await call('POST', '/api/portal/wearables/health_connect/connect', undefined, { token: memberToken });
    assert.equal(first.status, 201);
    const again = await call('POST', '/api/portal/wearables/health_connect/connect', undefined, { token: memberToken });
    assert.equal(again.body.connections.length, 1);
    assert.equal(again.body.connections[0].provider, 'health_connect');
    assert.equal(again.body.connections[0].last_synced_at, null);
  });

  it('stores synced days, replacing a day sent again', async () => {
    const yesterday = addDays(todayIso, -1);
    await call('POST', '/api/portal/wearables/health_connect/sync', {
      days: [{ date: yesterday, steps: 9000, active_calories: 400, distance_m: 6000, active_minutes: 20 }],
    }, { token: memberToken });
    const res = await call('POST', '/api/portal/wearables/health_connect/sync', {
      days: [
        { date: yesterday, steps: 9500, active_calories: 420, distance_m: 6300, active_minutes: 25 },
        { date: todayIso, steps: 3000, active_calories: null, distance_m: 2000, active_minutes: 0 },
      ],
    }, { token: memberToken });
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.days.map(({ log_date, steps, active_calories, providers }) => ({ log_date, steps, active_calories, providers })),
      [
        { log_date: yesterday, steps: 9500, active_calories: 420, providers: ['health_connect'] },
        { log_date: todayIso, steps: 3000, active_calories: null, providers: ['health_connect'] },
      ],
    );
    assert.ok(res.body.connections[0].last_synced_at);

    const bad = await call('POST', '/api/portal/wearables/health_connect/sync', { days: [{ date: todayIso, steps: -1 }] }, { token: memberToken });
    assert.equal(bad.status, 400);
  });

  it('shows a member only their own activity', async () => {
    const res = await call('GET', '/api/portal/wearables', undefined, { token: otherToken });
    assert.deepEqual(res.body.connections, []);
    assert.deepEqual(res.body.days, []);
  });
});

describe('wearable calories in the diet budget', () => {
  const syncToday = (activeCalories) =>
    call('POST', '/api/portal/wearables/health_connect/sync', {
      days: [{ date: todayIso, steps: 12000, active_calories: activeCalories, distance_m: 8000, active_minutes: 60 }],
    }, { token: memberToken });
  const dietDay = async () => (await call('GET', '/api/portal/diets/daily', undefined, { token: memberToken })).body;

  it('credits nothing from a day without active calories', async () => {
    const day = await dietDay();
    assert.equal(day.exercise.wearable.steps, 3000);
    assert.equal(day.exercise.wearable.extra, 0);
    assert.equal(day.exercise.total_burned, 0);
  });

  it('credits only what the watch counted beyond daily life', async () => {
    await syncToday(900);
    const { exercise } = await dietDay();
    const allowance = exercise.wearable.daily_life_allowance;
    // Mifflin-St Jeor for the fallback adult (70 kg, 170 cm, 30, sex unknown)
    // at the default light factor: 1534.5 × 0.375.
    assert.equal(allowance, 575);
    assert.equal(exercise.wearable.extra, 900 - allowance);
    assert.equal(exercise.total_burned, 900 - allowance);
  });

  it('never counts a logged activity and the watch twice', async () => {
    const logged = await call('POST', '/api/portal/activities', { activity: 'football', duration_minutes: 60, calories: 200 }, { token: memberToken });
    let { exercise } = await dietDay();
    // The watch's 325 beyond daily life already covers the 200 logged.
    assert.equal(exercise.total_burned, 325);
    assert.equal(exercise.wearable.extra, 125);

    await syncToday(600);
    ({ exercise } = await dietDay());
    // Now the logged activity is the bigger number, and the watch adds nothing.
    assert.equal(exercise.total_burned, 200);
    assert.equal(exercise.wearable.extra, 0);

    await call('DELETE', `/api/portal/activities/${logged.body.id}`, undefined, { token: memberToken });
  });

  it('sends recent workouts and meals out for Health Connect, with stable ids', async () => {
    const other = await call('GET', '/api/portal/wearables/health_connect/export', undefined, { token: otherToken });
    assert.equal(other.status, 409);

    const workout = await call('POST', '/api/portal/workouts/logs', {
      workout_name: 'Push Day',
      duration_seconds: 1800,
      sets: [{ exercise_name: 'Bench Press', muscle_group: 'chest', weight_kg: 60, reps: 8 }],
    }, { token: memberToken });
    assert.equal(workout.status, 201);
    const lunch = await call('POST', '/api/portal/diets/entries', {
      meal_type: 'lunch', food_name: 'Dal rice', calories: 450, protein_g: 15, carbs_g: 70, fats_g: 10,
    }, { token: memberToken });
    assert.equal(lunch.status, 201);
    // Filled in a day late: it is placed at breakfast time on its own day.
    const yesterday = addDays(todayIso, -1);
    await call('POST', '/api/portal/diets/entries', {
      meal_type: 'breakfast', food_name: 'Poha', calories: 250, log_date: yesterday,
    }, { token: memberToken });

    const res = await call('GET', '/api/portal/wearables/health_connect/export', undefined, { token: memberToken });
    assert.equal(res.status, 200);
    const { workouts, meals } = res.body;
    const now = Date.now();

    const push = workouts.find((w) => w.title === 'Push Day');
    assert.equal(push.id, `gymvym.${TENANT}.workout.${workout.body.log.id}`);
    assert.ok(Date.parse(push.end) - Date.parse(push.start) >= 60_000);
    assert.ok(Date.parse(push.end) <= now);

    const dal = meals.find((m) => m.name === 'Dal rice');
    assert.deepEqual(
      { id: dal.id, date: dal.date, meal_type: dal.meal_type, calories: dal.calories, protein_g: dal.protein_g },
      { id: `gymvym.${TENANT}.meal.${lunch.body.id}`, date: todayIso, meal_type: 'lunch', calories: 450, protein_g: 15 },
    );
    assert.ok(now - Date.parse(dal.time) < 5 * 60_000, 'logged on its own day: the time it was logged');

    const poha = meals.find((m) => m.name === 'Poha');
    assert.equal(poha.date, yesterday);
    assert.ok(Date.parse(poha.time) < Date.parse(dal.time) - 6 * 3600_000);

    // Nothing in it depends on when it was asked for, or the phone would
    // rewrite every record on every sync.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const again = await call('GET', '/api/portal/wearables/health_connect/export', undefined, { token: memberToken });
    assert.deepEqual(again.body, res.body);
  });

  it('forgets the synced days when the member disconnects', async () => {
    const res = await call('DELETE', '/api/portal/wearables/health_connect', undefined, { token: memberToken });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.connections, []);
    assert.deepEqual(res.body.days, []);
    assert.equal((await dietDay()).exercise.wearable, null);
    assert.equal((await call('DELETE', '/api/portal/wearables/health_connect', undefined, { token: memberToken })).status, 404);
  });
});
