import assert from 'node:assert/strict';
import { memberToken as signInMember } from './helpers/memberAuth.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-coach-test-'));
process.env.DB_FILE = path.join(tmpDir, 'default.db');
process.env.PLATFORM_DB_FILE = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.AUTH_SECRET = 'test-secret';
process.env.GOOGLE_CLOUD_PROJECT = 'test-project';
process.env.AI_COACH_DAILY_LIMIT = '3';
process.env.AI_PLAN_DAILY_LIMIT = '2';

const { createApp } = await import('../src/app.js');
const { closeDb } = await import('../src/db.js');
const { closeRegistryDb } = await import('../src/tenants.js');
const { config } = await import('../src/config.js');
const { cleanMealPlan, contextSteps, parsePlanReply, parseReply, partialAnswer, sanitiseSession, setAiClientForTests } = await import(
  '../src/aiCoach.js'
);
const { today } = await import('../src/validate.js');

const TENANT = 'coachgym';

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

/** A stand-in for Gemini that records what it was asked and replies with
 * whatever the test queued (a string is the raw response text). Streamed, the
 * queued thoughts come first, then the reply in small pieces like the real one. */
const fake = {
  calls: [],
  reply: JSON.stringify({ answer: 'Drop to 15 kg and aim for 12.' }),
  thoughts: [],
  fail: false,
  failMidStream: false,
  models: {
    generateContentStream: async (params) => {
      fake.calls.push(params);
      if (fake.fail) throw new Error('vertex down');
      return (async function* () {
        for (const text of fake.thoughts) yield { candidates: [{ content: { parts: [{ text, thought: true }] } }] };
        for (let i = 0; i < fake.reply.length; i += 7) {
          if (fake.failMidStream && i > 0) throw new Error('stream reset');
          yield { candidates: [{ content: { parts: [{ text: fake.reply.slice(i, i + 7) }] } }] };
        }
        yield { usageMetadata: { promptTokenCount: 1500, candidatesTokenCount: 60, thoughtsTokenCount: 40 } };
      })();
    },
    generateContent: async (params) => {
      fake.calls.push(params);
      if (fake.fail) throw new Error('vertex down');
      return { text: fake.reply, usageMetadata: { promptTokenCount: 1500, candidatesTokenCount: 60, thoughtsTokenCount: 40 } };
    },
  },
};

let adminToken;
let memberToken;
let memberId;
let otherToken;
let otherId;

const lastContext = () => {
  const params = fake.calls.at(-1);
  const prompt = params.contents.at(-1).parts[0].text;
  return JSON.parse(prompt.slice('MEMBER CONTEXT:\n'.length, prompt.indexOf('\n\nQUESTION:')));
};

before(async () => {
  setAiClientForTests(fake);
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  await call('POST', '/api/platform/signup', {
    slug: TENANT,
    gym_name: 'Coach Gym',
    admin_name: 'Owner',
    admin_email: 'owner@coachgym.test',
    admin_password: 'ownerpass123',
  }, { tenant: null });
  adminToken = (await call('POST', '/api/auth/login', { email: 'owner@coachgym.test', password: 'ownerpass123' })).body.token;

  const member = await call(
    'POST',
    '/api/members',
    { first_name: 'Asha', last_name: 'Rao', phone: '9876500021', gender: 'female', date_of_birth: '1996-04-10', health_notes: 'Left shoulder impingement' },
    { token: adminToken },
  );
  memberId = member.body.id;
  memberToken = await signInMember(call, { staffToken: adminToken, memberId });

  const other = await call('POST', '/api/members', { first_name: 'Vikram', last_name: 'Shah', phone: '9876500022' }, { token: adminToken });
  otherId = other.body.id;
  otherToken = await signInMember(call, { staffToken: adminToken, memberId: otherId });
});

after(() => {
  setAiClientForTests(null);
  server.close();
  closeDb();
  closeRegistryDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  fake.calls = [];
  fake.thoughts = [];
  fake.fail = false;
  fake.failMidStream = false;
  fake.reply = JSON.stringify({ answer: 'Drop to 15 kg and aim for 12.' });
});

describe('Ask Coach access', () => {
  it('sits behind the Diet & Workout add-on', async () => {
    const res = await call('POST', '/api/portal/coach/ask', { question: 'Next set?', screen: 'workout' }, { token: memberToken });
    assert.equal(res.status, 402);
    assert.equal(res.body.details.code, 'fitness_addon_required');
    assert.equal(fake.calls.length, 0);
  });

  it('opens once the member has the add-on', async () => {
    const sub = await call('POST', '/api/fitness-addons/subscribe', { member_id: memberId }, { token: adminToken });
    assert.ok(sub.status === 200 || sub.status === 201, JSON.stringify(sub.body));
    const status = await call('GET', '/api/portal/coach/status', undefined, { token: memberToken });
    assert.equal(status.status, 200);
    assert.deepEqual(status.body, {
      enabled: true,
      daily_limit: 3,
      remaining_today: 3,
      plan_daily_limit: 2,
      plans_remaining_today: 2,
      // No Diet settings yet: the profile's defaults (4 days, maintain).
      plan_defaults: { goal: 'general_fitness', days_per_week: 4 },
    });
  });
});

describe('Ask Coach context', () => {
  before(async () => {
    await call('POST', '/api/portal/weight', { weight_kg: 62.5, log_date: today() }, { token: memberToken });
    const log = await call(
      'POST',
      '/api/portal/workouts/logs',
      {
        workout_name: 'Shoulders',
        duration_seconds: 2400,
        sets: [
          { exercise_name: 'Lateral Raise', muscle_group: 'shoulders', set_number: 1, set_type: 'normal', weight_kg: 7.5, reps: 12, rpe: 8, completed: true },
          { exercise_name: 'Lateral Raise', muscle_group: 'shoulders', set_number: 2, set_type: 'normal', weight_kg: 7.5, reps: 10, rpe: 9, completed: true },
        ],
      },
      { token: memberToken },
    );
    assert.equal(log.status, 201, JSON.stringify(log.body));
  });

  it('gives the exercise picker the whole last session, with effort, for the next-set chip', async () => {
    const res = await call('GET', '/api/portal/workouts/exercises?q=Lateral%20Raise', undefined, { token: memberToken });
    assert.equal(res.status, 200);
    const item = res.body.items.find((i) => i.name === 'Lateral Raise');
    assert.deepEqual(
      item.last_session.map(({ weight_kg, reps, rpe, set_type }) => ({ weight_kg, reps, rpe, set_type })),
      [
        { weight_kg: 7.5, reps: 12, rpe: 8, set_type: 'normal' },
        { weight_kg: 7.5, reps: 10, rpe: 9, set_type: 'normal' },
      ],
    );
    // "Previous" stays the single last set it always was.
    assert.equal(item.previous.reps, 10);
  });

  it('answers with the member’s own profile, history and live session', async () => {
    fake.reply = JSON.stringify({
      answer: 'Go back to 7.5 kg for 10.',
      suggestion: { exercise: 'Lateral Raise', weight_kg: 7.5, reps: 10 },
    });
    const res = await call(
      'POST',
      '/api/portal/coach/ask',
      {
        question: 'What weight should I select for the next set?',
        screen: 'workout',
        unit: 'kg',
        session: {
          workout_name: 'Shoulders',
          elapsed_seconds: 600,
          exercises: [
            {
              name: 'Lateral Raise',
              equipment: 'dumbbell',
              target_sets: 3,
              target_reps: '8-15',
              sets: [
                { set_type: 'normal', weight_kg: 7.5, reps: 13, completed: true },
                { set_type: 'normal', weight_kg: 10, reps: 6, rpe: 10, completed: true },
                { set_type: 'normal', weight_kg: 0, reps: 0, completed: false },
              ],
              suggestion: { weight_kg: 7.5, reps: 12 },
            },
          ],
        },
      },
      { token: memberToken },
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.answer, 'Go back to 7.5 kg for 10.');
    assert.deepEqual(res.body.suggestion, { exercise: 'Lateral Raise', weight_kg: 7.5, reps: 10 });
    assert.equal(res.body.remaining_today, 2);

    const params = fake.calls[0];
    assert.equal(params.model, config.aiCoach.model);
    assert.equal(params.config.responseMimeType, 'application/json');
    assert.match(params.config.systemInstruction, /coach/);

    const ctx = lastContext();
    assert.equal(ctx.member.sex, 'female');
    assert.ok(ctx.member.age >= 29);
    assert.equal(ctx.member.bodyweight_kg, 62.5);
    assert.equal(ctx.member.limitations, 'Left shoulder impingement');
    assert.equal(ctx.live_session.exercises[0].sets[1].rpe, 10);
    assert.deepEqual(ctx.live_session.exercises[0].next_set_suggestion, { kg: 7.5, reps: 12 });
    assert.equal(ctx.exercise_history['Lateral Raise'].length, 1);
    assert.match(ctx.exercise_history['Lateral Raise'][0], /7\.5×12, 7\.5×10/);
    assert.equal(ctx.last_7_days[0].name, 'Shoulders');
  });

  it('sends earlier turns back as the chat’s memory', async () => {
    const res = await call('POST', '/api/portal/coach/ask', { question: 'And after that?', screen: 'workout' }, { token: memberToken });
    assert.equal(res.status, 200);
    const contents = fake.calls[0].contents;
    assert.equal(contents.length, 3);
    assert.equal(contents[0].parts[0].text, 'What weight should I select for the next set?');
    assert.equal(contents[1].role, 'model');
  });

  it('never shows one member another member’s logs', async () => {
    await call('POST', '/api/fitness-addons/subscribe', { member_id: otherId }, { token: adminToken });
    const res = await call('POST', '/api/portal/coach/ask', { question: 'How am I doing?', screen: 'diet' }, { token: otherToken });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const ctx = lastContext();
    assert.equal(ctx.member.first_name, 'Vikram');
    assert.deepEqual(ctx.exercise_history, {});
    assert.deepEqual(ctx.last_7_days, []);
    assert.equal(ctx.member.limitations, null);
  });
});

describe('Ask Coach limits and failures', () => {
  it('rejects empty, oversized and unknown-screen questions without calling Gemini', async () => {
    assert.equal((await call('POST', '/api/portal/coach/ask', { question: '  ', screen: 'workout' }, { token: memberToken })).status, 400);
    assert.equal((await call('POST', '/api/portal/coach/ask', { question: 'x'.repeat(501) }, { token: memberToken })).status, 400);
    assert.equal((await call('POST', '/api/portal/coach/ask', { question: 'Hi', screen: 'store' }, { token: memberToken })).status, 400);
    assert.equal(fake.calls.length, 0);
  });

  it('does not count a provider failure or a malformed reply', async () => {
    fake.fail = true;
    const down = await call('POST', '/api/portal/coach/ask', { question: 'Next set?' }, { token: memberToken });
    assert.equal(down.status, 502);
    assert.equal(down.body.details.code, 'coach_unavailable');

    fake.fail = false;
    fake.reply = 'Sure! Use 15 kg.';
    const garbled = await call('POST', '/api/portal/coach/ask', { question: 'Next set?' }, { token: memberToken });
    assert.equal(garbled.status, 502);

    const status = await call('GET', '/api/portal/coach/status', undefined, { token: memberToken });
    assert.equal(status.body.remaining_today, 1);
  });

  it('stops at the daily cap', async () => {
    assert.equal((await call('POST', '/api/portal/coach/ask', { question: 'One more?' }, { token: memberToken })).status, 200);
    const capped = await call('POST', '/api/portal/coach/ask', { question: 'And another?' }, { token: memberToken });
    assert.equal(capped.status, 429);
    assert.equal(capped.body.details.code, 'coach_limit_reached');
  });

  it('is off when the gym switches it off or the platform has no Vertex project', async () => {
    const off = await call('PUT', '/api/fitness-addons/settings', { ai_coach_enabled: false }, { token: adminToken });
    assert.equal(off.status, 200);
    assert.equal(off.body.settings.ai_coach_enabled, 0);
    let status = await call('GET', '/api/portal/coach/status', undefined, { token: memberToken });
    assert.equal(status.body.enabled, false);
    const ask = await call('POST', '/api/portal/coach/ask', { question: 'Next set?' }, { token: memberToken });
    assert.equal(ask.status, 503);
    assert.equal(ask.body.details.code, 'ai_disabled');

    await call('PUT', '/api/fitness-addons/settings', { ai_coach_enabled: true }, { token: adminToken });
    const project = config.aiCoach.project;
    config.aiCoach.project = '';
    try {
      status = await call('GET', '/api/portal/coach/status', undefined, { token: memberToken });
      assert.equal(status.body.enabled, false);
    } finally {
      config.aiCoach.project = project;
    }
  });
});

/** A streamed question: every Server-Sent Event in order, as { event, data }.
 * A refusal before streaming comes back as plain JSON, with no events. */
const askStreamed = async (body, token) => {
  const res = await fetch(`${base}/api/portal/coach/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', Authorization: `Bearer ${token}`, 'X-Tenant-Slug': TENANT },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!String(res.headers.get('content-type')).startsWith('text/event-stream')) {
    return { status: res.status, body: text ? JSON.parse(text) : null, events: [] };
  }
  const events = text
    .split('\n\n')
    .filter(Boolean)
    .map((block) => ({ event: /^event: (.+)$/m.exec(block)[1], data: JSON.parse(/^data: (.+)$/m.exec(block)[1]) }));
  return { status: res.status, events };
};

describe('Ask Coach streaming', () => {
  // A member of their own, so the daily counts above are left alone.
  let streamToken;

  before(async () => {
    const member = await call(
      'POST',
      '/api/members',
      { first_name: 'Meera', last_name: 'Iyer', phone: '9876500023', health_notes: 'Bad lower back' },
      { token: adminToken },
    );
    await call('POST', '/api/fitness-addons/subscribe', { member_id: member.body.id }, { token: adminToken });
    streamToken = await signInMember(call, { staffToken: adminToken, memberId: member.body.id });
  });

  it('streams what it reads, its thinking and the answer, then the same reply the JSON route gives', async () => {
    const answer = 'Stay at 40 kg — "hold" until 12 feels easy.\nThen add 2.5 kg.';
    fake.thoughts = ['**Checking the last set**\n\nTen reps at RPE 9 ', 'is near the top.'];
    fake.reply = JSON.stringify({ answer, suggestion: { exercise: 'Goblet Squat', weight_kg: 40, reps: 10 } });
    const session = {
      workout_name: 'Legs',
      exercises: [{ name: 'Goblet Squat', sets: [{ weight_kg: 40, reps: 10, rpe: 9, completed: true }, { weight_kg: 40, reps: 0 }] }],
    };
    const res = await askStreamed({ question: 'Next set?', screen: 'workout', session }, streamToken);
    assert.equal(res.status, 200);

    assert.deepEqual(
      res.events.filter((e) => e.event === 'step').map((e) => e.data.text),
      [
        'Reading your profile and goal',
        'Reading this session — 1 exercise, 1 set done',
        'No workouts logged this week yet',
        'Keeping your injury notes in mind',
      ],
    );
    const thinking = res.events.filter((e) => e.event === 'thought').map((e) => e.data.text);
    assert.equal(thinking.join(''), fake.thoughts.join(''));
    const pieces = res.events.filter((e) => e.event === 'answer').map((e) => e.data.text);
    assert.ok(pieces.length > 3, 'the answer arrives in pieces');
    assert.equal(pieces.join(''), answer);
    // Steps first, every thought before the answer starts, done last.
    assert.equal(res.events[0].event, 'step');
    assert.ok(res.events.findLastIndex((e) => e.event === 'thought') < res.events.findIndex((e) => e.event === 'answer'));
    assert.deepEqual(res.events.at(-1), {
      event: 'done',
      data: { answer, suggestion: { exercise: 'Goblet Squat', weight_kg: 40, reps: 10 }, remaining_today: 2 },
    });
    assert.deepEqual(fake.calls[0].config.thinkingConfig, { thinkingBudget: 1024, includeThoughts: true });

    // Saved like any other question: it is the chat's memory next time.
    await askStreamed({ question: 'And then?', screen: 'workout' }, streamToken);
    assert.equal(fake.calls[1].contents[0].parts[0].text, 'Next set?');
  });

  it('ends with an error event, not counted, when Gemini fails mid-answer', async () => {
    fake.failMidStream = true;
    const res = await askStreamed({ question: 'Next set?', screen: 'workout' }, streamToken);
    assert.equal(res.status, 200);
    assert.deepEqual(res.events.at(-1), {
      event: 'error',
      data: { error: 'The coach could not answer just now — try again in a moment', code: 'coach_unavailable' },
    });
    assert.ok(!res.events.some((e) => e.event === 'done'));
    const status = await call('GET', '/api/portal/coach/status', undefined, { token: streamToken });
    assert.equal(status.body.remaining_today, 1);
  });

  it('refuses a bad question as plain JSON before streaming anything', async () => {
    const res = await askStreamed({ question: ' ', screen: 'workout' }, streamToken);
    assert.equal(res.status, 400);
    assert.deepEqual(res.events, []);
    assert.equal(fake.calls.length, 0);
  });
});

describe('AI workout generator', () => {
  // Vikram, the second member: the first has used up their burst allowance on
  // the chat tests above.
  const ask = (body) => call('POST', '/api/portal/coach/plan', body, { token: otherToken });
  const goodPlan = () =>
    JSON.stringify({
      name: 'Dumbbell Upper/Lower',
      description: 'Add 2 kg when every set hits the top of the range.',
      days: [
        {
          day_name: 'Upper',
          exercises: [
            { exercise_name: 'Dumbbell Bench Press', target_sets: 4, target_reps: '8-12', rest_seconds: 90, target_rpe: 8 },
            // Wrong case: matched to the library's spelling.
            { exercise_name: 'one-arm dumbbell row', target_sets: 3, target_reps: '10 – 12', rest_seconds: 75 },
            // Not in the library: dropped and reported.
            { exercise_name: 'Laser Cannon Press', target_sets: 3, target_reps: '10', rest_seconds: 60 },
            // A repeat in the same day: dropped quietly.
            { exercise_name: 'Dumbbell Bench Press', target_sets: 2, target_reps: '12', rest_seconds: 60 },
          ],
        },
        {
          day_name: 'Lower',
          exercises: [{ exercise_name: 'Goblet Squat', target_sets: 99, target_reps: 'lots', rest_seconds: 9999, notes: 'Keep chest up' }],
        },
      ],
    });

  it('builds a draft from the gym’s library, cut to the member’s equipment', async () => {
    fake.reply = goodPlan();
    const res = await ask({ goal: 'muscle_gain', level: 'beginner', days_per_week: 2, minutes: 45, equipment: 'dumbbells', notes: 'Bad left knee' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.plans_remaining_today, 1);
    assert.deepEqual(res.body.dropped, ['Laser Cannon Press']);

    const [upper, lower] = res.body.plan.days;
    assert.deepEqual(upper.exercises.map((e) => e.exercise_name), ['Dumbbell Bench Press', 'One-Arm Dumbbell Row']);
    assert.equal(upper.exercises[0].muscle_group, 'chest');
    assert.equal(upper.exercises[0].equipment, 'dumbbell');
    assert.equal(upper.exercises[1].target_reps, '10-12');
    // Out-of-range numbers are clamped, junk reps fall back.
    assert.deepEqual(
      { sets: lower.exercises[0].target_sets, reps: lower.exercises[0].target_reps, rest: lower.exercises[0].rest_seconds },
      { sets: 8, reps: '8-12', rest: 300 },
    );

    // What Gemini was shown: the request, the member, and dumbbell kit only.
    const prompt = fake.calls[0].contents[0].parts[0].text;
    assert.match(prompt, /"notes":"Bad left knee"/);
    assert.match(prompt, /"first_name":"Vikram"/);
    assert.match(prompt, /Dumbbell Bench Press \| chest \| dumbbell/);
    assert.doesNotMatch(prompt, /\| barbell/);
    assert.match(fake.calls[0].config.systemInstruction, /ONLY exercises from that gym's EXERCISE LIBRARY/);
  });

  it('saves through the ordinary plan route once the member is happy with it', async () => {
    fake.reply = goodPlan();
    const draft = (await ask({ goal: 'strength', level: 'intermediate', days_per_week: 2 })).body.plan;
    const saved = await call('POST', '/api/portal/workouts/routines', { ...draft, activate: true }, { token: otherToken });
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    assert.equal(saved.body.active, true);
    assert.equal(saved.body.days.length, 2);
    assert.equal(saved.body.days[0].exercises[0].exercise_name, 'Dumbbell Bench Press');
  });

  it('checks the request, does not count failures, and stops at its own daily cap', async () => {
    const bad = await ask({ goal: 'get_huge', level: 'beginner', days_per_week: 3 });
    assert.equal(bad.status, 400);
    assert.ok(bad.body.details.goal);
    assert.equal(fake.calls.length, 0);

    // Two plans made above; a third is over the cap of 2.
    fake.reply = goodPlan();
    const capped = await ask({ goal: 'fat_loss', level: 'beginner', days_per_week: 3 });
    assert.equal(capped.status, 429);
    assert.equal(capped.body.details.code, 'plan_limit_reached');
    assert.equal(fake.calls.length, 0);
  });
});

describe('Coach meal plans', () => {
  // A member of their own, so the daily caps above are left alone.
  let token;
  let mealMemberId;
  const plan = {
    name: 'High-protein rest of today',
    meals: [
      {
        meal_type: 'lunch',
        name: 'Chicken rice bowl',
        items: [
          { food_name: 'Grilled chicken breast', portion: '150 g', calories: 248, protein_g: 46.5, carbs_g: 0, fats_g: 5.4 },
          { food_name: 'Cooked white rice', portion: '1 cup', calories: 205, protein_g: 4.3, carbs_g: 44.5, fats_g: 0.4 },
        ],
      },
      {
        meal_type: 'dinner',
        items: [{ food_name: 'Paneer bhurji', portion: '200 g', calories: 520, protein_g: 36, carbs_g: 10, fats_g: 38 }],
      },
    ],
  };

  before(async () => {
    const member = await call('POST', '/api/members', { first_name: 'Neha', last_name: 'Kapoor', phone: '9876500024' }, { token: adminToken });
    mealMemberId = member.body.id;
    await call('POST', '/api/fitness-addons/subscribe', { member_id: mealMemberId }, { token: adminToken });
    token = await signInMember(call, { staffToken: adminToken, memberId: mealMemberId });
  });

  it('sends back a meal plan with the answer and remembers it for the next question', async () => {
    fake.reply = JSON.stringify({ answer: 'Here is the rest of today: **973 calories, 87g protein**.', meal_plan: plan });
    const res = await call('POST', '/api/portal/coach/ask', { question: 'Suggest a meal plan', screen: 'diet' }, { token });
    assert.equal(res.status, 200);
    assert.equal(res.body.meal_plan.name, plan.name);
    assert.deepEqual(res.body.meal_plan.totals, { calories: 973, protein_g: 86.8, carbs_g: 54.5, fats_g: 43.8 });
    assert.equal(res.body.meal_plan.meals[1].name, null);
    assert.ok(fake.calls[0].config.responseJsonSchema.properties.meal_plan, 'the model is asked for a plan');
    assert.ok(fake.calls[0].config.maxOutputTokens >= 8192, 'room for a whole day');

    fake.reply = JSON.stringify({ answer: 'Swapped the chicken for tofu.' });
    const plain = await call('POST', '/api/portal/coach/ask', { question: 'Make lunch vegetarian', screen: 'diet' }, { token });
    const earlier = JSON.parse(fake.calls[1].contents[1].parts[0].text);
    assert.equal(earlier.meal_plan.meals[0].items[0].food_name, 'Grilled chicken breast');
    // A plain answer carries no plan at all.
    assert.ok(!('meal_plan' in plain.body));
  });

  it('tells the coach which meals are already logged today', async () => {
    await call('POST', '/api/portal/diets/entries', { meal_type: 'breakfast', food_name: 'Oats', calories: 300 }, { token });
    fake.reply = JSON.stringify({ answer: 'Fine.' });
    await call('POST', '/api/portal/coach/ask', { question: 'What should I eat next?', screen: 'diet' }, { token });
    assert.deepEqual(lastContext().diet_today.meals_logged, ['breakfast']);
  });

  it('has no way to log a plan in one go — its foods are tracked one by one', async () => {
    const res = await call('POST', '/api/portal/diets/entries/batch', { meals: plan.meals }, { token });
    assert.equal(res.status, 404);
  });

  it('saves, lists and deletes plans, each member only their own', async () => {
    const saved = await call('POST', '/api/portal/diets/meal-plans', { name: plan.name, meals: plan.meals }, { token });
    assert.equal(saved.status, 201);
    assert.equal(saved.body.name, plan.name);
    assert.equal(saved.body.totals.calories, 973);
    // Unknown meal types become snacks rather than failing the save.
    const odd = await call('POST', '/api/portal/diets/meal-plans', { meals: [{ meal_type: 'brunch', items: plan.meals[1].items }] }, { token });
    assert.equal(odd.body.name, 'Meal plan');
    assert.equal(odd.body.meals[0].meal_type, 'snack');

    const list = await call('GET', '/api/portal/diets/meal-plans', undefined, { token });
    assert.deepEqual(list.body.items.map((p) => p.id), [odd.body.id, saved.body.id]);
    assert.deepEqual((await call('GET', '/api/portal/diets/meal-plans', undefined, { token: otherToken })).body.items, []);

    assert.equal((await call('DELETE', `/api/portal/diets/meal-plans/${saved.body.id}`, undefined, { token: otherToken })).status, 404);
    assert.equal((await call('DELETE', `/api/portal/diets/meal-plans/${saved.body.id}`, undefined, { token })).status, 200);
    assert.equal((await call('GET', '/api/portal/diets/meal-plans', undefined, { token })).body.items.length, 1);
    assert.equal((await call('POST', '/api/portal/diets/meal-plans', { name: 'Nothing', meals: [] }, { token })).status, 400);
  });

  it('cleans a plan: bad numbers, nameless foods and empty meals', () => {
    assert.equal(cleanMealPlan(null), null);
    assert.equal(cleanMealPlan({ meals: [{ meal_type: 'lunch', items: [] }] }), null);
    const cleaned = cleanMealPlan({
      meals: [
        { meal_type: 'dinner', items: [{ food_name: 'Dal', calories: '180.6', protein_g: -3, carbs_g: 'lots' }, { calories: 100 }] },
        { meal_type: 'snack', items: [] },
      ],
    });
    assert.deepEqual(cleaned, {
      name: 'Meal plan',
      meals: [{ meal_type: 'dinner', name: null, items: [{ food_name: 'Dal', portion: '1 serving', calories: 181, protein_g: 0, carbs_g: 0, fats_g: 0 }] }],
      totals: { calories: 181, protein_g: 0, carbs_g: 0, fats_g: 0 },
    });
  });
});

describe('Ask Coach helpers', () => {
  it('rejects a plan with nothing from the library in it', () => {
    const library = [{ name: 'Push-Up', muscle_group: 'chest', equipment: 'bodyweight' }];
    assert.throws(() => parsePlanReply('{"name":"X","days":[{"day_name":"A","exercises":[{"exercise_name":"Moon Squat"}]}]}', library));
    assert.throws(() => parsePlanReply('not json', library));
    const ok = parsePlanReply(
      '{"name":"","days":[{"day_name":"","exercises":[{"exercise_name":"push-up","target_sets":3,"target_reps":"15","rest_seconds":45}]},{"day_name":"B","exercises":[]}]}',
      library,
      { days: 3 },
    );
    assert.equal(ok.plan.name, 'AI plan');
    assert.equal(ok.plan.days.length, 1);
    assert.equal(ok.plan.days[0].day_name, 'Day 1');
    assert.equal(ok.plan.days[0].exercises[0].exercise_name, 'Push-Up');
  });

  it('keeps only a usable suggestion from the model’s JSON', () => {
    assert.deepEqual(parseReply('{"answer":" Hold at 30 kg. "}'), { answer: 'Hold at 30 kg.', suggestion: null, meal_plan: null });
    assert.deepEqual(
      parseReply('{"answer":"Go up","suggestion":{"exercise":"Bench Press","weight_kg":"62.5","reps":8}}').suggestion,
      { exercise: 'Bench Press', weight_kg: 62.5, reps: 8 },
    );
    assert.equal(parseReply('{"answer":"Ok","suggestion":{"exercise":"Bench","weight_kg":60,"reps":0}}').suggestion, null);
    assert.deepEqual(
      parseReply('```json\n{"answer":"Drop to 10 kg."}\n```'),
      { answer: 'Drop to 10 kg.', suggestion: null, meal_plan: null },
    );
    assert.deepEqual(
      parseReply('Here is your recommendation: {"answer":"Push for 10 reps."} Hope this helps!'),
      { answer: 'Push for 10 reps.', suggestion: null, meal_plan: null },
    );
    assert.throws(() => parseReply('not json'));
    assert.throws(() => parseReply('{"answer":""}'));
  });

  it('reads the answer out of a JSON reply that is still arriving', () => {
    const whole = JSON.stringify({ answer: 'Say "hold"\nthen 5 × 8', suggestion: null });
    assert.equal(partialAnswer(''), '');
    assert.equal(partialAnswer('{"suggestion":{"reps":8},"answ'), '');
    assert.equal(partialAnswer('{"answer": "Go to 6'), 'Go to 6');
    assert.equal(partialAnswer(whole), 'Say "hold"\nthen 5 × 8');
    // Every prefix is a prefix of the answer: nothing shown is ever taken back.
    for (let i = 0; i <= whole.length; i++) assert.ok('Say "hold"\nthen 5 × 8'.startsWith(partialAnswer(whole.slice(0, i))));
    // An escape cut in half waits for the rest instead of showing a backslash.
    assert.equal(partialAnswer('{"answer":"60 kg \\'), '60 kg ');
    assert.equal(partialAnswer('{"answer":"5 \\u00'), '5 ');
    assert.equal(partialAnswer('{"answer":"5 \\u00d7 8"}'), '5 × 8');
  });

  it('describes what the coach read from the context it was actually sent', () => {
    const steps = contextSteps({
      screen: 'diet',
      member: { limitations: null },
      plan: { name: 'PPL' },
      live_session: { exercises: [{ name: 'Squat', sets: [{ done: true }] }] },
      exercise_history: { Squat: ['x'], Bench: ['x'], Row: ['x'] },
      last_7_days: [{}, {}],
      diet_today: { eaten: { calories: 1240 }, targets: { calories: 2100 } },
    });
    assert.deepEqual(steps, [
      'Reading your profile and goal',
      'Checking your last sessions of Squat and Bench and 1 more',
      'Looking back at 2 workouts this week',
      'Following your plan, PPL',
      "Comparing today's food with your targets — 1240 of 2100 kcal",
    ]);
  });

  it('coerces a hostile session into plain numbers and short strings', () => {
    const clean = sanitiseSession({
      workout_name: 'x'.repeat(500),
      exercises: [{ name: 'Squat', sets: [{ set_type: 'evil', weight_kg: 'NaN', reps: -4, rpe: 99, completed: 'yes' }] }],
    });
    assert.equal(clean.workout_name.length, 80);
    assert.deepEqual(clean.exercises[0].sets[0], { type: 'normal', kg: 0, reps: 0, rpe: 10, done: true });
    assert.equal(sanitiseSession('nope'), null);
  });
});
