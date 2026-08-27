import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-fitness-test-'));
process.env.DB_FILE = path.join(tmpDir, 'default.db');
process.env.PLATFORM_DB_FILE = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.AUTH_SECRET = 'test-secret';

const { createApp } = await import('../src/app.js');
const { closeDb } = await import('../src/db.js');
const { closeRegistryDb } = await import('../src/tenants.js');
const { estimate1rm } = await import('../src/fitness.js');
const { addDays, addMonths, today } = await import('../src/validate.js');

const TENANT = 'fitgym';

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
let trainerToken;
let memberToken;
let memberId;
let memberCode;
let planId;

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  await call('POST', '/api/platform/signup', {
    slug: TENANT,
    gym_name: 'Fit Gym',
    admin_name: 'Owner',
    admin_email: 'owner@fitgym.test',
    admin_password: 'ownerpass123',
  }, { tenant: null });

  adminToken = (
    await call('POST', '/api/auth/login', { email: 'owner@fitgym.test', password: 'ownerpass123' })
  ).body.token;

  const trainer = await call(
    'POST',
    '/api/staff',
    { name: 'Coach Meera', email: 'coach@fitgym.test', password: 'coachpass123', role: 'trainer' },
    { token: adminToken },
  );
  assert.equal(trainer.status, 201);
  trainerToken = (
    await call('POST', '/api/auth/login', { email: 'coach@fitgym.test', password: 'coachpass123' })
  ).body.token;

  const member = await call(
    'POST',
    '/api/members',
    { first_name: 'Rahul', last_name: 'Verma', phone: '9876500011' },
    { token: adminToken },
  );
  memberId = member.body.id;
  memberCode = member.body.code;

  planId = (await call('GET', '/api/plans', undefined, { token: adminToken })).body.items[0].id;
  await call('POST', '/api/subscriptions', { member_id: memberId, plan_id: planId }, { token: adminToken });

  const login = await call('POST', '/api/portal/login', { identifier: memberCode, pin: '0011' });
  assert.equal(login.status, 200);
  memberToken = login.body.token;
});

after(() => {
  server.close();
  closeDb();
  closeRegistryDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('estimated one-rep max', () => {
  it('treats a single as its own 1RM', () => {
    assert.equal(estimate1rm(100, 1), 103.3);
  });

  it('ranks more reps at the same weight higher', () => {
    assert.ok(estimate1rm(100, 8) > estimate1rm(100, 5));
  });

  it('is zero for a bodyweight or empty set', () => {
    assert.equal(estimate1rm(0, 12), 0);
    assert.equal(estimate1rm(60, 0), 0);
  });
});

describe('the exercise and food libraries', () => {
  it('ships a seeded catalogue', async () => {
    const exercises = await call('GET', '/api/workouts/exercises', undefined, { token: trainerToken });
    assert.equal(exercises.status, 200);
    assert.ok(exercises.body.items.length >= 40, `only ${exercises.body.items.length} exercises seeded`);

    const foods = await call('GET', '/api/diets/foods', undefined, { token: trainerToken });
    assert.ok(foods.body.items.length >= 50, `only ${foods.body.items.length} foods seeded`);
  });

  it('filters exercises by muscle group and name', async () => {
    const legs = await call('GET', '/api/workouts/exercises?muscle_group=legs', undefined, { token: trainerToken });
    assert.ok(legs.body.items.length > 0);
    assert.ok(legs.body.items.every((e) => e.muscle_group === 'legs'));

    const search = await call('GET', '/api/workouts/exercises?q=Bench', undefined, { token: trainerToken });
    assert.ok(search.body.items.every((e) => e.name.includes('Bench')));
  });

  it('lets a trainer add a custom exercise, and returns the existing row instead of duplicating', async () => {
    const created = await call(
      'POST',
      '/api/workouts/exercises',
      { name: 'Landmine Press', muscle_group: 'shoulders', equipment: 'barbell' },
      { token: trainerToken },
    );
    assert.equal(created.status, 201);
    assert.equal(created.body.is_custom, 1);

    const again = await call(
      'POST',
      '/api/workouts/exercises',
      { name: 'landmine press', muscle_group: 'shoulders' },
      { token: trainerToken },
    );
    assert.equal(again.status, 200);
    assert.equal(again.body.id, created.body.id);
  });

  it('refuses to delete a standard exercise but allows a custom one', async () => {
    const standard = (await call('GET', '/api/workouts/exercises?q=Deadlift', undefined, { token: trainerToken }))
      .body.items.find((e) => e.name === 'Deadlift');
    const refused = await call('DELETE', `/api/workouts/exercises/${standard.id}`, undefined, { token: trainerToken });
    assert.equal(refused.status, 400);

    const custom = (await call('GET', '/api/workouts/exercises?q=Landmine', undefined, { token: trainerToken }))
      .body.items[0];
    assert.equal((await call('DELETE', `/api/workouts/exercises/${custom.id}`, undefined, { token: trainerToken })).status, 200);
  });

  it('adds a custom food with its macros', async () => {
    const created = await call(
      'POST',
      '/api/diets/foods',
      { name: 'Protein Ladoo', category: 'supplements', serving_unit: '1 piece', calories: 180, protein_g: 12, carbs_g: 14, fats_g: 8 },
      { token: trainerToken },
    );
    assert.equal(created.status, 201);
    assert.equal(created.body.calories, 180);
    assert.equal(created.body.is_custom, 1);
  });
});

describe('workout plan templates', () => {
  let templateId;

  it('ships starter templates with days and exercises', async () => {
    const res = await call('GET', '/api/workouts/templates', undefined, { token: trainerToken });
    assert.equal(res.status, 200);
    assert.ok(res.body.items.length >= 3);
    const ppl = res.body.items.find((t) => t.name.startsWith('Push / Pull / Legs'));
    assert.equal(ppl.day_count, 6);
    assert.ok(ppl.exercise_count >= 30);
  });

  it('lets a trainer build a template', async () => {
    const res = await call(
      'POST',
      '/api/workouts/templates',
      {
        name: 'Bench Specialisation',
        description: 'Six weeks of pressing',
        goal: 'strength',
        level: 'advanced',
        days_per_week: 2,
        days: [
          {
            day_name: 'Day 1: Heavy Bench',
            notes: 'Top single, then back-offs',
            exercises: [
              { exercise_name: 'Barbell Bench Press', muscle_group: 'chest', target_sets: 5, target_reps: '3', rest_seconds: 180, target_rpe: 8.5 },
              { exercise_name: 'Triceps Pushdown', muscle_group: 'arms', target_sets: 3, target_reps: '12-15', rest_seconds: 60 },
            ],
          },
          {
            day_name: 'Day 2: Volume Bench',
            exercises: [{ exercise_name: 'Incline Dumbbell Press', muscle_group: 'chest', target_sets: 4, target_reps: '10' }],
          },
        ],
      },
      { token: trainerToken },
    );
    assert.equal(res.status, 201);
    templateId = res.body.id;
    assert.equal(res.body.is_template, 1);
    assert.equal(res.body.days.length, 2);
    assert.equal(res.body.days[0].day_number, 1);
    assert.equal(res.body.days[0].exercises.length, 2);
    assert.equal(res.body.days[0].exercises[0].target_rpe, 8.5);
    assert.equal(res.body.days[0].exercises[0].rest_seconds, 180);
    // Defaulted, not required of the client.
    assert.equal(res.body.days[1].exercises[0].rest_seconds, 90);
  });

  it('reports errors against the offending row', async () => {
    const res = await call(
      'POST',
      '/api/workouts/templates',
      {
        name: 'Broken',
        days: [
          { day_name: 'Day 1', exercises: [{ exercise_name: 'Squat', muscle_group: 'quads' }] },
          { day_name: '', exercises: [] },
        ],
      },
      { token: trainerToken },
    );
    assert.equal(res.status, 400);
    assert.ok(res.body.details['days.0.exercises.0.muscle_group']);
    assert.ok(res.body.details['days.1.day_name']);
  });

  it('replaces the day tree on update, and leaves it alone when days are omitted', async () => {
    const renamed = await call(
      'PUT',
      `/api/workouts/templates/${templateId}`,
      { name: 'Bench Specialisation v2', goal: 'strength', level: 'advanced', days_per_week: 2 },
      { token: trainerToken },
    );
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.name, 'Bench Specialisation v2');
    assert.equal(renamed.body.days.length, 2, 'omitting days must not wipe them');

    const rebuilt = await call(
      'PUT',
      `/api/workouts/templates/${templateId}`,
      {
        name: 'Bench Specialisation v2',
        target_calories: 0,
        days: [{ day_name: 'Day 1: Bench only', exercises: [{ exercise_name: 'Barbell Bench Press', muscle_group: 'chest' }] }],
      },
      { token: trainerToken },
    );
    assert.equal(rebuilt.body.days.length, 1);
    assert.equal(rebuilt.body.days[0].exercises.length, 1);
  });

  it('deletes an unassigned template', async () => {
    assert.equal((await call('DELETE', `/api/workouts/templates/${templateId}`, undefined, { token: trainerToken })).status, 200);
    assert.equal((await call('GET', `/api/workouts/templates/${templateId}`, undefined, { token: trainerToken })).status, 404);
  });
});

describe('assigning plans to a member', () => {
  it('assigns a workout plan and keeps only one live routine', async () => {
    const templates = (await call('GET', '/api/workouts/templates', undefined, { token: trainerToken })).body.items;
    const ppl = templates.find((t) => t.name.startsWith('Push / Pull / Legs'));
    const upperLower = templates.find((t) => t.name.startsWith('Upper / Lower'));

    const first = await call(
      'POST',
      '/api/workouts/assign',
      { member_id: memberId, plan_id: ppl.id, notes: 'Start here' },
      { token: trainerToken },
    );
    assert.equal(first.status, 201);
    assert.equal(first.body.status, 'active');
    assert.equal(first.body.plan.id, ppl.id, 'without customise the member trains off the template itself');

    const second = await call(
      'POST',
      '/api/workouts/assign',
      { member_id: memberId, plan_id: upperLower.id, customise: true },
      { token: trainerToken },
    );
    assert.equal(second.status, 201);
    // The clone is member-owned, so tuning it cannot reach anyone else.
    assert.equal(second.body.plan.is_template, 0);
    assert.equal(second.body.plan.member_id, memberId);
    assert.equal(second.body.plan.days.length, 4);
    assert.notEqual(second.body.plan.id, upperLower.id);

    const view = await call(`GET`, `/api/workouts/members/${memberId}`, undefined, { token: trainerToken });
    assert.equal(view.body.assignment.id, second.body.id);
  });

  it('refuses to delete a template members are still training on', async () => {
    const ppl = (await call('GET', '/api/workouts/templates', undefined, { token: trainerToken })).body.items
      .find((t) => t.name.startsWith('Push / Pull / Legs'));
    // Put a second member on it so there is a live assignment to protect.
    const other = await call('POST', '/api/members', { first_name: 'Neha', phone: '9876500022' }, { token: adminToken });
    await call('POST', '/api/workouts/assign', { member_id: other.body.id, plan_id: ppl.id }, { token: trainerToken });

    const res = await call('DELETE', `/api/workouts/templates/${ppl.id}`, undefined, { token: trainerToken });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /still training/);
  });

  it('assigns a diet plan and clones it when asked', async () => {
    const templates = (await call('GET', '/api/diets/templates', undefined, { token: trainerToken })).body.items;
    assert.ok(templates.length >= 4);
    const fatLoss = templates.find((t) => t.goal === 'fat_loss');
    assert.ok(fatLoss.meal_count >= 3);

    const res = await call(
      'POST',
      '/api/diets/assign',
      { member_id: memberId, plan_id: fatLoss.id, customise: true },
      { token: trainerToken },
    );
    assert.equal(res.status, 201);
    assert.equal(res.body.plan.is_template, 0);
    assert.equal(res.body.plan.member_id, memberId);
    assert.ok(res.body.plan.meals.length >= 3);
    assert.ok(res.body.plan.meals[0].items.length > 0);
    // A meal's target is the sum of its items, computed on write.
    const first = res.body.plan.meals[0];
    assert.equal(first.target_calories, first.items.reduce((sum, i) => sum + i.calories, 0));
  });

  it('rejects an end date before the start date', async () => {
    const fatLoss = (await call('GET', '/api/diets/templates', undefined, { token: trainerToken })).body.items[0];
    const res = await call(
      'POST',
      '/api/diets/assign',
      { member_id: memberId, plan_id: fatLoss.id, start_date: today(), end_date: addDays(today(), -1) },
      { token: trainerToken },
    );
    assert.equal(res.status, 400);
    assert.ok(res.body.details.end_date);
  });
});

describe('the paid add-on', () => {
  it('locks the member portal until the member is entitled', async () => {
    const status = await call('GET', '/api/portal/fitness/status', undefined, { token: memberToken });
    assert.equal(status.status, 200);
    assert.equal(status.body.has_access, false);
    assert.equal(status.body.source, null);
    assert.equal(status.body.settings.monthly_price, 499);

    for (const url of ['/api/portal/workouts/current', '/api/portal/diets/current', '/api/portal/workouts/prs']) {
      const res = await call('GET', url, undefined, { token: memberToken });
      assert.equal(res.status, 402, `${url} should be paywalled`);
      assert.equal(res.body.details.code, 'fitness_addon_required');
      assert.equal(res.body.details.monthly_price, 499);
    }

    const write = await call('POST', '/api/portal/diets/water', { add_ml: 250 }, { token: memberToken });
    assert.equal(write.status, 402);
  });

  it('lets an admin reprice the add-on but not a trainer', async () => {
    const refused = await call('PUT', '/api/fitness-addons/settings', { monthly_price: 1 }, { token: trainerToken });
    assert.equal(refused.status, 403);

    const res = await call('PUT', '/api/fitness-addons/settings', { monthly_price: 599, trial_days: 0 }, { token: adminToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.settings.monthly_price, 599);
  });

  it('sells the add-on, records the payment and unlocks the portal', async () => {
    const refused = await call('POST', '/api/fitness-addons/subscribe', { member_id: memberId }, { token: trainerToken });
    assert.equal(refused.status, 403, 'taking money is the desk\'s job, not the trainer\'s');

    const res = await call(
      'POST',
      '/api/fitness-addons/subscribe',
      { member_id: memberId, months: 1, method: 'upi', reference: 'UPI-9911' },
      { token: adminToken },
    );
    assert.equal(res.status, 201);
    // Price falls back to the gym's configured rate.
    assert.equal(res.body.payment.amount, 599);
    assert.equal(res.body.payment.method, 'upi');
    assert.equal(res.body.payment.subscription_id, null, 'add-on revenue must not land on a membership');
    assert.equal(res.body.addon.status, 'active');
    assert.equal(res.body.addon.end_date, addMonths(addDays(today(), -1), 1));
    assert.equal(res.body.access.has_access, true);
    assert.equal(res.body.access.source, 'addon');

    const status = await call('GET', '/api/portal/fitness/status', undefined, { token: memberToken });
    assert.equal(status.body.has_access, true);
    assert.equal((await call('GET', '/api/portal/diets/current', undefined, { token: memberToken })).status, 200);
  });

  it('extends the existing add-on rather than stacking a second one', async () => {
    const before = (await call('GET', `/api/fitness-addons/members/${memberId}`, undefined, { token: adminToken })).body;
    const res = await call(
      'POST',
      '/api/fitness-addons/subscribe',
      { member_id: memberId, months: 2, price: 500 },
      { token: adminToken },
    );
    assert.equal(res.status, 201);
    assert.equal(res.body.addon.id, before.addon.id, 'the live row is extended, not duplicated');
    assert.equal(res.body.addon.end_date, addMonths(before.addon.end_date, 2));
    assert.equal(res.body.addon.price, 599 + 1000, 'what the member has paid in total');

    const history = (await call('GET', `/api/fitness-addons/members/${memberId}`, undefined, { token: adminToken })).body;
    assert.equal(history.history.length, 1);
  });

  it('comps the add-on without writing a payment when asked', async () => {
    const other = await call('POST', '/api/members', { first_name: 'Imran', phone: '9876500033' }, { token: adminToken });
    const res = await call(
      'POST',
      '/api/fitness-addons/subscribe',
      { member_id: other.body.id, months: 1, price: 0, record_payment: false, note: 'Trial run, on the house' },
      { token: adminToken },
    );
    assert.equal(res.status, 201);
    assert.equal(res.body.payment, null);
    assert.equal(res.body.access.has_access, true);

    const payments = await call('GET', `/api/payments?member_id=${other.body.id}`, undefined, { token: adminToken });
    assert.equal(payments.body.items.length, 0);
  });

  it('cancels an add-on, keeping the payment on the books', async () => {
    const other = await call('POST', '/api/members', { first_name: 'Sara', phone: '9876500044' }, { token: adminToken });
    const sold = await call('POST', '/api/fitness-addons/subscribe', { member_id: other.body.id }, { token: adminToken });

    const cancelled = await call('POST', `/api/fitness-addons/cancel/${sold.body.addon.id}`, {}, { token: adminToken });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.addon.status, 'cancelled');
    assert.equal(cancelled.body.access.has_access, false);

    const payments = await call('GET', `/api/payments?member_id=${other.body.id}`, undefined, { token: adminToken });
    assert.equal(payments.body.items.length, 1, 'cancelling access is not a refund');

    const again = await call('POST', `/api/fitness-addons/cancel/${sold.body.addon.id}`, {}, { token: adminToken });
    assert.equal(again.status, 400);
  });

  it('treats a lapsed add-on as expired on the next read', async () => {
    const other = await call('POST', '/api/members', { first_name: 'Vikas', phone: '9876500055' }, { token: adminToken });
    const sold = await call('POST', '/api/fitness-addons/subscribe', { member_id: other.body.id }, { token: adminToken });

    // Backdate the end into the past, which is what a real month passing does.
    const { tenantStorage, run } = await import('../src/db.js');
    const { tenantDbPath } = await import('../src/tenants.js');
    tenantStorage.run({ dbFile: tenantDbPath(TENANT), businessType: 'gym' }, () => {
      run('UPDATE member_fitness_addons SET end_date = ? WHERE id = ?', [addDays(today(), -1), sold.body.addon.id]);
    });

    const res = await call('GET', `/api/fitness-addons/members/${other.body.id}`, undefined, { token: adminToken });
    assert.equal(res.body.has_access, false);
    assert.equal(res.body.history[0].status, 'expired');
  });

  it('grants access through a membership plan that bundles it', async () => {
    const plan = await call(
      'POST',
      '/api/plans',
      { name: 'VIP Personal Training', price: 5000, duration_days: 30, includes_fitness_addon: true },
      { token: adminToken },
    );
    assert.equal(plan.status, 201);
    assert.equal(plan.body.includes_fitness_addon, 1);

    const vip = await call('POST', '/api/members', { first_name: 'Anita', phone: '9876500066' }, { token: adminToken });
    // No add-on sold: entitlement rides on the membership alone.
    let access = (await call('GET', `/api/fitness-addons/members/${vip.body.id}`, undefined, { token: adminToken })).body;
    assert.equal(access.has_access, false);

    await call('POST', '/api/subscriptions', { member_id: vip.body.id, plan_id: plan.body.id }, { token: adminToken });
    access = (await call('GET', `/api/fitness-addons/members/${vip.body.id}`, undefined, { token: adminToken })).body;
    assert.equal(access.has_access, true);
    assert.equal(access.source, 'plan');
    assert.equal(access.is_bundled, true);
    assert.equal(access.bundled_plan, 'VIP Personal Training');
  });

  it('opens the feature to everyone when the gym turns charging off', async () => {
    const walkIn = await call('POST', '/api/members', { first_name: 'Dev', phone: '9876500077' }, { token: adminToken });
    let access = (await call('GET', `/api/fitness-addons/members/${walkIn.body.id}`, undefined, { token: adminToken })).body;
    assert.equal(access.has_access, false);

    await call('PUT', '/api/fitness-addons/settings', { enabled: false }, { token: adminToken });
    access = (await call('GET', `/api/fitness-addons/members/${walkIn.body.id}`, undefined, { token: adminToken })).body;
    assert.equal(access.has_access, true);
    assert.equal(access.source, 'free');

    await call('PUT', '/api/fitness-addons/settings', { enabled: true }, { token: adminToken });
  });

  it('honours a free trial anchored on the join date', async () => {
    await call('PUT', '/api/fitness-addons/settings', { trial_days: 7 }, { token: adminToken });

    const fresh = await call('POST', '/api/members', { first_name: 'Kiran', phone: '9876500088' }, { token: adminToken });
    let access = (await call('GET', `/api/fitness-addons/members/${fresh.body.id}`, undefined, { token: adminToken })).body;
    assert.equal(access.source, 'trial');
    assert.equal(access.trial_ends_on, addDays(today(), 7));

    const veteran = await call(
      'POST',
      '/api/members',
      { first_name: 'Old', phone: '9876500099', joined_on: addDays(today(), -60) },
      { token: adminToken },
    );
    access = (await call('GET', `/api/fitness-addons/members/${veteran.body.id}`, undefined, { token: adminToken })).body;
    assert.equal(access.has_access, false, 'a trial is a welcome offer, not a permanent one');

    await call('PUT', '/api/fitness-addons/settings', { trial_days: 0 }, { token: adminToken });
  });
});

describe('Heavy-style workout logging in the portal', () => {
  let routine;

  it('serves the assigned routine with the day that comes next', async () => {
    const res = await call('GET', '/api/portal/workouts/current', undefined, { token: memberToken });
    assert.equal(res.status, 200);
    routine = res.body;
    assert.equal(res.body.plan.days.length, 4);
    assert.equal(res.body.sessions_logged, 0);
    assert.equal(res.body.today_day.day_name, res.body.plan.days[0].day_name, 'a fresh plan starts at day one');
    assert.deepEqual(res.body.previous, {}, 'nothing to beat yet');
  });

  it('saves a session, computes its totals and records the PRs', async () => {
    const res = await call(
      'POST',
      '/api/portal/workouts/logs',
      {
        workout_name: 'Upper (Strength)',
        plan_id: routine.plan.id,
        day_id: routine.today_day.id,
        duration_seconds: 2880,
        sets: [
          { exercise_name: 'Barbell Bench Press', muscle_group: 'chest', set_type: 'warmup', weight_kg: 40, reps: 10 },
          { exercise_name: 'Barbell Bench Press', muscle_group: 'chest', set_type: 'normal', weight_kg: 80, reps: 5, rpe: 8 },
          { exercise_name: 'Barbell Bench Press', muscle_group: 'chest', set_type: 'normal', weight_kg: 80, reps: 5 },
          { exercise_name: 'Barbell Row', muscle_group: 'back', set_type: 'normal', weight_kg: 60, reps: 8 },
          // Left unticked: planned but never done, so it counts for nothing.
          { exercise_name: 'Barbell Row', muscle_group: 'back', set_type: 'normal', weight_kg: 60, reps: 8, completed: false },
        ],
      },
      { token: memberToken },
    );
    assert.equal(res.status, 201);

    // 40x10 + 80x5 + 80x5 + 60x8 = 400 + 400 + 400 + 480
    assert.equal(res.body.log.total_volume_kg, 1680);
    assert.equal(res.body.log.total_sets, 4);
    assert.equal(res.body.log.total_reps, 28);
    assert.equal(res.body.log.duration_seconds, 2880);
    assert.equal(res.body.log.log_date, today());
    assert.ok(res.body.log.ended_at);

    const prNames = res.body.prs.map((p) => p.exercise_name).sort();
    assert.deepEqual(prNames, ['Barbell Bench Press', 'Barbell Row']);
    const bench = res.body.prs.find((p) => p.exercise_name === 'Barbell Bench Press');
    assert.equal(bench.weight_kg, 80);
    assert.equal(bench.reps, 5);
    assert.equal(bench.est_1rm_kg, estimate1rm(80, 5));
    assert.equal(bench.previous_est_1rm_kg, null);

    // The warmup was stored but is not what the PR was taken from.
    const warmup = res.body.sets.find((s) => s.set_type === 'warmup');
    assert.equal(warmup.is_pr, 0);
    assert.equal(res.body.sets.filter((s) => s.is_pr === 1).length, 2);
    assert.equal(res.body.sets.find((s) => s.rpe === 8).est_1rm_kg, estimate1rm(80, 5));
  });

  it('advances the routine to the day after the one just done', async () => {
    const res = await call('GET', '/api/portal/workouts/current', undefined, { token: memberToken });
    assert.equal(res.body.sessions_logged, 1);
    assert.equal(res.body.today_day.day_name, res.body.plan.days[1].day_name);
    assert.ok(res.body.last_workout);
  });

  it('follows the routine on from a day trained out of order', async () => {
    // Day 4 of four, done deliberately out of turn — the next session should be
    // day 1 again, not day 3 as a plain session count would give.
    const lastDay = routine.plan.days[3];
    const res = await call(
      'POST',
      '/api/portal/workouts/logs',
      {
        workout_name: lastDay.day_name,
        plan_id: routine.plan.id,
        day_id: lastDay.id,
        duration_seconds: 1500,
        sets: [{ exercise_name: 'Front Squat', muscle_group: 'legs', set_type: 'normal', weight_kg: 70, reps: 8 }],
      },
      { token: memberToken },
    );
    assert.equal(res.status, 201);

    const next = await call('GET', '/api/portal/workouts/current', undefined, { token: memberToken });
    assert.equal(next.body.today_day.day_name, routine.plan.days[0].day_name);

    // A freestyle session (no day_id) must not move the rotation on.
    await call(
      'POST',
      '/api/portal/workouts/logs',
      {
        workout_name: 'Quick arms',
        duration_seconds: 600,
        sets: [{ exercise_name: 'Dumbbell Curl', muscle_group: 'arms', set_type: 'normal', weight_kg: 14, reps: 12 }],
      },
      { token: memberToken },
    );
    const after = await call('GET', '/api/portal/workouts/current', undefined, { token: memberToken });
    assert.equal(after.body.today_day.day_name, routine.plan.days[0].day_name);
  });

  it('shows the previous set for each exercise so the member knows what to beat', async () => {
    const res = await call('GET', '/api/portal/workouts/exercises?q=Barbell Bench', undefined, { token: memberToken });
    const bench = res.body.items.find((e) => e.name === 'Barbell Bench Press');
    assert.equal(bench.previous.weight_kg, 80);
    assert.equal(bench.previous.reps, 5);
    assert.equal(bench.previous.log_date, today());
  });

  it('only calls a heavier session a PR', async () => {
    const flat = await call(
      'POST',
      '/api/portal/workouts/logs',
      {
        workout_name: 'Repeat',
        duration_seconds: 1800,
        sets: [{ exercise_name: 'Barbell Bench Press', muscle_group: 'chest', set_type: 'normal', weight_kg: 75, reps: 5 }],
      },
      { token: memberToken },
    );
    assert.deepEqual(flat.body.prs, [], 'a lighter set is not a record');
    assert.equal(flat.body.sets[0].is_pr, 0);

    const better = await call(
      'POST',
      '/api/portal/workouts/logs',
      {
        workout_name: 'New best',
        duration_seconds: 1800,
        sets: [{ exercise_name: 'Barbell Bench Press', muscle_group: 'chest', set_type: 'normal', weight_kg: 85, reps: 5 }],
      },
      { token: memberToken },
    );
    assert.equal(better.body.prs.length, 1);
    assert.equal(better.body.prs[0].previous_est_1rm_kg, estimate1rm(80, 5));
    assert.equal(better.body.prs[0].est_1rm_kg, estimate1rm(85, 5));

    const wall = await call('GET', '/api/portal/workouts/prs', undefined, { token: memberToken });
    const bench = wall.body.items.find((p) => p.exercise_name === 'Barbell Bench Press');
    assert.equal(bench.max_weight_kg, 85);
    assert.equal(bench.max_reps, 5);
    assert.equal(bench.muscle_group, 'chest');
  });

  it('lists history with PR counts and lifetime totals', async () => {
    const res = await call('GET', '/api/portal/workouts/logs', undefined, { token: memberToken });
    // Upper 1680, out-of-order day 560, freestyle arms 168, Repeat 375, New best 425.
    assert.equal(res.body.items.length, 5);
    assert.equal(res.body.stats.total_workouts, 5);
    assert.equal(res.body.stats.lifetime_volume_kg, 1680 + 560 + 168 + 375 + 425);
    assert.equal(res.body.items.find((l) => l.workout_name === 'New best').pr_count, 1);
  });

  it('refuses an empty session and out-of-range figures', async () => {
    const empty = await call('POST', '/api/portal/workouts/logs', { workout_name: 'Nothing', sets: [] }, { token: memberToken });
    assert.equal(empty.status, 400);
    assert.ok(empty.body.details.sets);

    const bad = await call(
      'POST',
      '/api/portal/workouts/logs',
      {
        workout_name: 'Bad',
        sets: [
          { exercise_name: 'Back Squat', muscle_group: 'legs', weight_kg: 5000, reps: 5 },
          { exercise_name: '', muscle_group: 'legs', weight_kg: 100, reps: 5 },
          { exercise_name: 'Back Squat', muscle_group: 'legs', weight_kg: 100, reps: 5, set_type: 'superset' },
        ],
      },
      { token: memberToken },
    );
    assert.equal(bad.status, 400);
    assert.ok(bad.body.details['sets.0.weight_kg']);
    assert.ok(bad.body.details['sets.1.exercise_name']);
    assert.ok(bad.body.details['sets.2.set_type']);
  });

  it('keeps one member out of another member\'s log', async () => {
    const mine = (await call('GET', '/api/portal/workouts/logs', undefined, { token: memberToken })).body.items[0];
    const detail = await call(`GET`, `/api/portal/workouts/logs/${mine.id}`, undefined, { token: memberToken });
    assert.equal(detail.status, 200);
    assert.ok(detail.body.sets.length > 0);

    // A second member, entitled but with no logs of their own.
    const other = await call('POST', '/api/members', { first_name: 'Nosy', phone: '9876501111' }, { token: adminToken });
    await call('POST', '/api/fitness-addons/subscribe', { member_id: other.body.id }, { token: adminToken });
    const otherToken = (await call('POST', '/api/portal/login', { identifier: other.body.code, pin: '1111' })).body.token;

    const peek = await call('GET', `/api/portal/workouts/logs/${mine.id}`, undefined, { token: otherToken });
    assert.equal(peek.status, 404, 'not 403 — whether that id exists is not theirs to learn');
  });

  it('deletes a mis-tapped session but keeps the record it set', async () => {
    const logs = (await call('GET', '/api/portal/workouts/logs', undefined, { token: memberToken })).body.items;
    const target = logs.find((l) => l.workout_name === 'Repeat');
    assert.equal((await call('DELETE', `/api/portal/workouts/logs/${target.id}`, undefined, { token: memberToken })).status, 200);

    const after = await call('GET', '/api/portal/workouts/logs', undefined, { token: memberToken });
    assert.equal(after.body.items.length, 4);
    const wall = await call('GET', '/api/portal/workouts/prs', undefined, { token: memberToken });
    assert.ok(wall.body.items.some((p) => p.exercise_name === 'Barbell Bench Press'));
  });

  it('lets a trainer read the member\'s sessions and records', async () => {
    const res = await call(`GET`, `/api/workouts/members/${memberId}`, undefined, { token: trainerToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.stats.total_workouts, 4);
    assert.equal(res.body.stats.last_workout_on, today());
    assert.ok(res.body.prs.length >= 2);

    const detail = await call('GET', `/api/workouts/logs/${res.body.logs[0].id}`, undefined, { token: trainerToken });
    assert.equal(detail.status, 200);
    assert.equal(detail.body.member_code, memberCode);
    assert.ok(detail.body.sets.length > 0);
  });
});

describe('Lifesum-style diet logging in the portal', () => {
  it('serves the assigned targets', async () => {
    const res = await call('GET', '/api/portal/diets/current', undefined, { token: memberToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.using_default_targets, false);
    assert.equal(res.body.targets.target_calories, 1800);
    assert.equal(res.body.targets.target_protein_g, 150);
    assert.equal(res.body.targets.target_water_ml, 3500);
    assert.ok(res.body.plan.meals.length >= 3);
  });

  it('falls back to sane targets for a member no trainer has reached yet', async () => {
    const fresh = await call('POST', '/api/members', { first_name: 'Unassigned', phone: '9876502222' }, { token: adminToken });
    await call('POST', '/api/fitness-addons/subscribe', { member_id: fresh.body.id }, { token: adminToken });
    const token = (await call('POST', '/api/portal/login', { identifier: fresh.body.code, pin: '2222' })).body.token;

    const res = await call('GET', '/api/portal/diets/current', undefined, { token });
    assert.equal(res.body.using_default_targets, true);
    assert.equal(res.body.targets.target_calories, 2000);
    assert.equal(res.body.plan, null);
  });

  it('logs a food from the library and scales its macros by the serving', async () => {
    const foods = await call('GET', '/api/portal/diets/foods?q=Chicken Breast', undefined, { token: memberToken });
    const chicken = foods.body.items.find((f) => f.name.startsWith('Chicken Breast'));
    assert.equal(chicken.calories, 165);

    const res = await call(
      'POST',
      '/api/portal/diets/entries',
      { meal_type: 'lunch', food_id: chicken.id, quantity: 1.5 },
      { token: memberToken },
    );
    assert.equal(res.status, 201);
    assert.equal(res.body.food_name, chicken.name);
    assert.equal(res.body.calories, Math.round(165 * 1.5));
    assert.equal(res.body.protein_g, 46.5);
    assert.equal(res.body.serving_unit, '100g');
  });

  it('ignores client-sent macros when a library food is named', async () => {
    const chicken = (await call('GET', '/api/portal/diets/foods?q=Chicken Breast', undefined, { token: memberToken }))
      .body.items.find((f) => f.name.startsWith('Chicken Breast'));
    const res = await call(
      'POST',
      '/api/portal/diets/entries',
      { meal_type: 'snack', food_id: chicken.id, quantity: 1, calories: 5, protein_g: 0 },
      { token: memberToken },
    );
    assert.equal(res.body.calories, 165, 'the library is authoritative');
  });

  it('logs a hand-typed food off a packet', async () => {
    const res = await call(
      'POST',
      '/api/portal/diets/entries',
      { meal_type: 'breakfast', food_name: 'Gym cafe protein shake', calories: 250, protein_g: 30, carbs_g: 18, fats_g: 5 },
      { token: memberToken },
    );
    assert.equal(res.status, 201);
    assert.equal(res.body.calories, 250);
    assert.equal(res.body.protein_g, 30);

    const nameless = await call('POST', '/api/portal/diets/entries', { meal_type: 'dinner', calories: 100 }, { token: memberToken });
    assert.equal(nameless.status, 400);
    assert.ok(nameless.body.details.food_name);
  });

  it('totals the day and splits it by meal', async () => {
    const res = await call('GET', '/api/portal/diets/daily', undefined, { token: memberToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.log_date, today());
    // 248 (chicken x1.5) + 165 (chicken x1) + 250 (shake)
    assert.equal(res.body.totals.calories, 248 + 165 + 250);
    assert.equal(res.body.totals.protein_g, 46.5 + 31 + 30);
    assert.equal(res.body.meals.lunch.length, 1);
    assert.equal(res.body.meals.snack.length, 1);
    assert.equal(res.body.meals.breakfast.length, 1);
    assert.equal(res.body.meals.dinner.length, 0);
  });

  it('tracks water by the glass and by the total', async () => {
    const first = await call('POST', '/api/portal/diets/water', { add_ml: 250 }, { token: memberToken });
    assert.equal(first.status, 200);
    assert.equal(first.body.water_ml, 250);

    assert.equal((await call('POST', '/api/portal/diets/water', { add_ml: 250 }, { token: memberToken })).body.water_ml, 500);
    // Undo past zero must not drive the column negative.
    assert.equal((await call('POST', '/api/portal/diets/water', { add_ml: -5000 }, { token: memberToken })).body.water_ml, 0);
    assert.equal((await call('POST', '/api/portal/diets/water', { water_ml: 2000 }, { token: memberToken })).body.water_ml, 2000);

    const daily = await call('GET', '/api/portal/diets/daily', undefined, { token: memberToken });
    assert.equal(daily.body.water_ml, 2000);

    const empty = await call('POST', '/api/portal/diets/water', {}, { token: memberToken });
    assert.equal(empty.status, 400);
  });

  it('removes an entry, and refuses to remove someone else\'s', async () => {
    const daily = await call('GET', '/api/portal/diets/daily', undefined, { token: memberToken });
    const entry = daily.body.meals.snack[0];
    assert.equal((await call('DELETE', `/api/portal/diets/entries/${entry.id}`, undefined, { token: memberToken })).status, 200);

    const after = await call('GET', '/api/portal/diets/daily', undefined, { token: memberToken });
    assert.equal(after.body.meals.snack.length, 0);
    assert.equal(after.body.totals.calories, 248 + 250);

    const other = await call('POST', '/api/members', { first_name: 'Other', phone: '9876503333' }, { token: adminToken });
    await call('POST', '/api/fitness-addons/subscribe', { member_id: other.body.id }, { token: adminToken });
    const otherToken = (await call('POST', '/api/portal/login', { identifier: other.body.code, pin: '3333' })).body.token;
    const stillThere = after.body.meals.lunch[0];
    assert.equal((await call('DELETE', `/api/portal/diets/entries/${stillThere.id}`, undefined, { token: otherToken })).status, 404);
  });

  it('reads back yesterday without inventing a log for it', async () => {
    const res = await call(`GET`, `/api/portal/diets/daily?date=${addDays(today(), -1)}`, undefined, { token: memberToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.entries.length, 0);
    assert.equal(res.body.water_ml, 0);
    assert.equal(res.body.totals.calories, 0);

    const bad = await call('GET', '/api/portal/diets/daily?date=yesterday', undefined, { token: memberToken });
    assert.equal(bad.status, 400);
  });

  it('surfaces the member\'s own recent foods for quick re-logging', async () => {
    const res = await call('GET', '/api/portal/diets/foods', undefined, { token: memberToken });
    assert.ok(res.body.recent.length > 0);
    assert.ok(res.body.recent.some((f) => f.food_name === 'Gym cafe protein shake'));
  });

  it('gives the trainer an adherence view of what was actually eaten', async () => {
    const res = await call(`GET`, `/api/diets/members/${memberId}`, undefined, { token: trainerToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.assignment.plan.target_calories, 1800);
    assert.equal(res.body.days.length, 1);
    assert.equal(res.body.days[0].log_date, today());
    assert.equal(res.body.days[0].calories, 248 + 250);
    assert.equal(res.body.days[0].water_ml, 2000);
    // 498 kcal against an 1800 target is nowhere near the band.
    assert.equal(res.body.adherence_pct, 0);

    const day = await call(`GET`, `/api/diets/members/${memberId}/day?date=${today()}`, undefined, { token: trainerToken });
    assert.equal(day.body.entries.length, 2);
    assert.equal(day.body.water_ml, 2000);
  });
});

describe('vertical gating', () => {
  it('hides the whole feature from a study hall', async () => {
    await call('POST', '/api/platform/signup', {
      slug: 'fithall',
      gym_name: 'Study Hall',
      admin_name: 'Owner',
      admin_email: 'owner@fithall.test',
      admin_password: 'ownerpass123',
      business_type: 'library',
    }, { tenant: null });

    const token = (
      await call('POST', '/api/auth/login', { email: 'owner@fithall.test', password: 'ownerpass123' }, { tenant: 'fithall' })
    ).body.token;

    for (const url of ['/api/workouts/templates', '/api/diets/templates', '/api/fitness-addons/settings']) {
      const res = await call('GET', url, undefined, { token, tenant: 'fithall' });
      assert.equal(res.status, 404, `${url} should not exist for a study hall`);
      assert.equal(res.body.details.code, 'module_not_enabled');
    }
  });
});
