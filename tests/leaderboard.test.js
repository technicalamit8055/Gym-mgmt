import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { memberToken as signInMember } from './helpers/memberAuth.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-leaderboard-test-'));
process.env.DB_FILE = path.join(tmpDir, 'default.db');
process.env.PLATFORM_DB_FILE = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.AUTH_SECRET = 'test-secret';

const { createApp } = await import('../src/app.js');
const { closeDb } = await import('../src/db.js');
const { closeRegistryDb } = await import('../src/tenants.js');

const TENANT = 'lbgym';
let base;
let server;
let adminToken;

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

const members = {};

async function addMember(key, firstName, lastName, phone) {
  const created = await call('POST', '/api/members', { first_name: firstName, last_name: lastName, phone }, { token: adminToken });
  const id = created.body.id;
  const plans = (await call('GET', '/api/plans', undefined, { token: adminToken })).body.items;
  await call('POST', '/api/subscriptions', { member_id: id, plan_id: plans[0].id }, { token: adminToken });
  await call('POST', '/api/fitness-addons/subscribe', { member_id: id, months: 1, method: 'cash' }, { token: adminToken });
  members[key] = { id, token: await signInMember(call, { staffToken: adminToken, memberId: id }) };
}

const logCurl = (key, sets) =>
  call(
    'POST',
    '/api/portal/workouts/logs',
    { workout_name: 'Arms', sets: sets.map((s) => ({ exercise_name: 'Barbell Curl', muscle_group: 'biceps', set_type: 'normal', ...s })) },
    { token: members[key].token },
  );

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  await call('POST', '/api/platform/signup', {
    slug: TENANT,
    gym_name: 'LB Gym',
    admin_name: 'Owner',
    admin_email: 'owner@lbgym.test',
    admin_password: 'ownerpass123',
  }, { tenant: null });
  adminToken = (await call('POST', '/api/auth/login', { email: 'owner@lbgym.test', password: 'ownerpass123' })).body.token;

  await addMember('amit', 'Amit', 'Singh', '9876500101');
  await addMember('gary', 'Gary', 'Nathan', '9876500102');
  await addMember('priya', 'Priya', 'Shah', '9876500103');

  assert.equal((await logCurl('amit', [{ weight_kg: 15, reps: 15 }, { weight_kg: 12, reps: 8 }])).status, 201);
  assert.equal((await logCurl('gary', [{ weight_kg: 47.5, reps: 3 }, { weight_kg: 40, reps: 8 }])).status, 201);
  assert.equal((await logCurl('priya', [{ weight_kg: 30, reps: 5 }, { weight_kg: 60, reps: 2, set_type: 'warmup' }])).status, 201);
});

after(() => {
  server.close();
  closeDb();
  closeRegistryDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const board = (key, params = {}) =>
  call('GET', `/api/portal/leaderboard?${new URLSearchParams({ exercise: 'Barbell Curl', ...params })}`, undefined, { token: members[key].token });

describe('gym leaderboards', () => {
  it('starts hidden: nobody is listed until they opt in', async () => {
    const settings = await call('GET', '/api/portal/leaderboard/settings', undefined, { token: members.amit.token });
    assert.equal(settings.body.show_on_leaderboard, false);
    assert.equal(settings.body.default_name, 'Amit S.');
    assert.equal(settings.body.decided_at, null);

    const res = await board('amit');
    assert.equal(res.status, 200);
    assert.equal(res.body.items.length, 0);
    assert.equal(res.body.joined, false);
    assert.equal(res.body.me.rank, 1, 'a viewer who has not joined still sees the rank they would have');
  });

  it('ranks members who opted in, by heaviest weight by default, ignoring warmups', async () => {
    for (const key of ['amit', 'gary', 'priya']) {
      const saved = await call('PUT', '/api/portal/leaderboard/settings', { show_on_leaderboard: true }, { token: members[key].token });
      assert.equal(saved.status, 200);
    }
    await call('PUT', '/api/portal/leaderboard/settings', { show_on_leaderboard: true, display_name: 'garynathan' }, { token: members.gary.token });

    const res = await board('amit');
    assert.deepEqual(res.body.items.map((r) => [r.rank, r.name, r.value_kg]), [
      [1, 'garynathan', 47.5],
      [2, 'Priya S.', 30],
      [3, 'You', 15],
    ]);
    assert.equal(res.body.me.rank, 3);
  });

  it('ignores high-rep sets on the 1RM board and ranks volume by the best single set', async () => {
    const e1rm = await board('amit', { metric: 'e1rm' });
    const amit = e1rm.body.items.find((r) => r.is_me);
    // 15 x 15 is past the 12-rep cut-off; 12 x 8 counts: 12 * (1 + 8/30) = 15.2
    assert.equal(amit.value_kg, 15.2);

    const volume = await board('amit', { metric: 'volume' });
    assert.equal(volume.body.items[0].name, 'garynathan');
    assert.equal(volume.body.items[0].value_kg, 320);
    assert.equal(volume.body.items.find((r) => r.is_me).value_kg, 225);
  });

  it('drops a member who opts back out', async () => {
    await call('PUT', '/api/portal/leaderboard/settings', { show_on_leaderboard: false }, { token: members.priya.token });
    const res = await board('amit');
    assert.deepEqual(res.body.items.map((r) => r.rank), [1, 2]);
    const compare = await call('GET', `/api/portal/leaderboard/compare?exercise=Barbell%20Curl&member_id=${members.priya.id}`, undefined, {
      token: members.amit.token,
    });
    assert.equal(compare.status, 404, 'a hidden member cannot be compared against');
  });

  it('compares two members head to head', async () => {
    const res = await call(
      'GET',
      `/api/portal/leaderboard/compare?exercise=Barbell%20Curl&period=all&member_id=${members.gary.id}`,
      undefined,
      { token: members.amit.token },
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.stronger, 'them');
    const heaviest = res.body.metrics.find((m) => m.metric === 'heaviest');
    assert.equal(heaviest.mine, 15);
    assert.equal(heaviest.theirs, 47.5);
    assert.equal(heaviest.gap_pct, 68);
  });

  it('lists featured lifts on the hub with their leader', async () => {
    const res = await call('GET', '/api/portal/leaderboard/hub', undefined, { token: members.amit.token });
    assert.equal(res.status, 200);
    const curl = res.body.items.find((i) => i.exercise_name === 'Barbell Curl');
    assert.equal(curl.leader.name, 'garynathan');
    assert.equal(curl.me.rank, 2);
    assert.ok(res.body.items.some((i) => i.exercise_name === 'Deadlift'));
  });
});

describe('staff leaderboard moderation', () => {
  let trainerToken;
  let staffToken;
  let fakeLogId;

  before(async () => {
    await call('POST', '/api/staff', { name: 'Coach', email: 'coach@lbgym.test', password: 'coachpass123', role: 'trainer' }, { token: adminToken });
    trainerToken = (await call('POST', '/api/auth/login', { email: 'coach@lbgym.test', password: 'coachpass123' })).body.token;
    await call('POST', '/api/staff', { name: 'Desk', email: 'desk@lbgym.test', password: 'deskpass123', role: 'staff' }, { token: adminToken });
    staffToken = (await call('POST', '/api/auth/login', { email: 'desk@lbgym.test', password: 'deskpass123' })).body.token;

    // Amit's best was 15 kg; 60 kg a session later is the kind of jump to check.
    const res = await logCurl('amit', [{ weight_kg: 60, reps: 5 }, { weight_kg: 55, reps: 5 }]);
    fakeLogId = res.body.log.id;
  });

  it('keeps moderation to owners, managers and trainers', async () => {
    assert.equal((await call('GET', '/api/leaderboard/overview', undefined, { token: staffToken })).status, 403);
    assert.equal((await call('PUT', '/api/leaderboard/settings', { enabled: false }, { token: trainerToken })).status, 403);
  });

  it('flags a big jump over the member’s previous best, once per session', async () => {
    const res = await call('GET', '/api/leaderboard/overview', undefined, { token: trainerToken });
    assert.equal(res.status, 200);
    const flags = res.body.flagged.filter((f) => f.member_id === members.amit.id);
    assert.equal(flags.length, 1);
    assert.equal(flags[0].weight_kg, 60);
    assert.equal(flags[0].previous_best_kg, 15);
    assert.equal(flags[0].member_name, 'Amit Singh');
  });

  it('removes a lift from the boards without touching the member’s records', async () => {
    assert.equal((await board('gary', { period: 'all' })).body.items[0].name, 'Amit S.', 'the fake lift tops the board first');

    const removed = await call('POST', '/api/leaderboard/lifts/remove', { log_id: fakeLogId, exercise_name: 'Barbell Curl' }, { token: trainerToken });
    assert.equal(removed.status, 200);

    const after = await board('gary', { period: 'all' });
    assert.equal(after.body.items[0].name, 'You');
    assert.equal(after.body.items.find((r) => r.name === 'Amit S.').value_kg, 15);

    const prs = await call('GET', '/api/portal/workouts/prs', undefined, { token: members.amit.token });
    assert.equal(prs.body.items.find((p) => p.exercise_name === 'Barbell Curl').max_weight_kg, 60, 'personal records keep it');

    const overview = await call('GET', '/api/leaderboard/overview', undefined, { token: trainerToken });
    assert.equal(overview.body.flagged.filter((f) => f.member_id === members.amit.id).length, 0);
    assert.equal(overview.body.hidden.length, 1);
  });

  it('keeps a removal when the member edits that workout', async () => {
    const edited = await call(
      'PUT',
      `/api/portal/workouts/logs/${fakeLogId}`,
      { workout_name: 'Arms', sets: [{ exercise_name: 'Barbell Curl', muscle_group: 'biceps', set_type: 'normal', weight_kg: 70, reps: 5 }] },
      { token: members.amit.token },
    );
    assert.equal(edited.status, 200);
    const after = await board('gary', { period: 'all' });
    assert.equal(after.body.items.find((r) => r.name === 'Amit S.').value_kg, 15);
  });

  it('restores a removed lift and stops flagging it', async () => {
    const restored = await call('POST', '/api/leaderboard/lifts/restore', { log_id: fakeLogId, exercise_name: 'Barbell Curl' }, { token: trainerToken });
    assert.equal(restored.status, 200);
    assert.equal((await board('gary', { period: 'all' })).body.items[0].value_kg, 70);
    const overview = await call('GET', '/api/leaderboard/overview', undefined, { token: trainerToken });
    assert.equal(overview.body.flagged.length, 0);
    assert.equal(overview.body.hidden.length, 0);

    const staffView = await call('GET', '/api/leaderboard/board?exercise=Barbell%20Curl', undefined, { token: trainerToken });
    assert.equal(staffView.body.items[0].member_name, 'Amit Singh');
    assert.equal(staffView.body.items[0].reviewed, true);
  });

  it('blocks a member from the boards until unblocked, and they cannot rejoin themselves', async () => {
    assert.equal((await call('POST', `/api/leaderboard/members/${members.amit.id}/block`, { reason: 'fake lifts' }, { token: trainerToken })).status, 200);
    assert.ok(!(await board('gary', { period: 'all' })).body.items.some((r) => r.name === 'Amit S.'));

    const mine = await board('amit');
    assert.equal(mine.body.blocked, true);
    const rejoin = await call('PUT', '/api/portal/leaderboard/settings', { show_on_leaderboard: true }, { token: members.amit.token });
    assert.equal(rejoin.status, 409);

    await call('POST', `/api/leaderboard/members/${members.amit.id}/unblock`, undefined, { token: trainerToken });
    assert.ok((await board('gary', { period: 'all' })).body.items.some((r) => r.name === 'Amit S.'), 'their own opt-in comes back');
  });

  it('shows members who never answered when the gym defaults to visible', async () => {
    await addMember('neha', 'Neha', 'Rao', '9876500104');
    await logCurl('neha', [{ weight_kg: 20, reps: 5 }]);
    assert.ok(!(await board('gary', { period: 'all' })).body.items.some((r) => r.name === 'Neha R.'));

    assert.equal((await call('PUT', '/api/leaderboard/settings', { default_visible: true }, { token: adminToken })).status, 200);
    assert.ok((await board('gary', { period: 'all' })).body.items.some((r) => r.name === 'Neha R.'));
    // Priya chose to hide earlier, and a default never overrides a choice.
    assert.ok(!(await board('gary', { period: 'all' })).body.items.some((r) => r.name === 'Priya S.'));
  });

  it('switches leaderboards off for members', async () => {
    await call('PUT', '/api/leaderboard/settings', { enabled: false }, { token: adminToken });
    assert.equal((await board('amit')).status, 404);
    const prs = await call('GET', '/api/portal/workouts/prs', undefined, { token: members.amit.token });
    assert.equal(prs.body.leaderboard_enabled, false);
    await call('PUT', '/api/leaderboard/settings', { enabled: true }, { token: adminToken });
  });
});
