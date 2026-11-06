import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { memberToken } from './helpers/memberAuth.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-papers-test-'));
process.env.DB_FILE = path.join(tmpDir, 'default.db');
process.env.PLATFORM_DB_FILE = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.AUTH_SECRET = 'test-secret';
process.env.GOOGLE_CLOUD_PROJECT = 'test-project';

const { createApp } = await import('../src/app.js');
const { closeDb, run, tenantStorage } = await import('../src/db.js');
const { closeRegistryDb, tenantDbPath } = await import('../src/tenants.js');
const { addDays, today } = await import('../src/validate.js');
const { setAiClientForTests } = await import('../src/aiCoach.js');
const { balancedMath, checkQuestion, gradeAttempt, parseGenerated, splitMix } = await import('../src/coaching/papers.js');

const SLUG = 'vector-academy';
let root;
let server;
let token;

const call = async (method, urlPath, body, { useToken = token } = {}) => {
  const res = await fetch(`${root}/g/${SLUG}${urlPath}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(useToken ? { Authorization: `Bearer ${useToken}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const memberCall = (method, urlPath, body, opts = {}) => call(method, urlPath, body, { useToken: opts.token });

/** Runs SQL against the institute's own database (to wind a clock back). */
const tenantRun = (sql, params) =>
  tenantStorage.run({ slug: SLUG, dbFile: tenantDbPath(SLUG), businessType: 'coaching' }, () => run(sql, params));

/* A stand-in for Gemini: replies with whatever the test queues next. */
const fake = {
  replies: [],
  calls: [],
  models: {
    generateContent: async (params) => {
      fake.calls.push(params);
      const next = fake.replies.shift();
      if (next instanceof Error) throw next;
      return { text: JSON.stringify(next ?? { questions: [] }), usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 4000 } };
    },
  },
};

const mcq = (n, correct = 'B') => ({
  kind: 'mcq',
  difficulty: 'medium',
  question: `If $\\vec{A} = ${n}\\hat{i} + 4\\hat{j}$, what is $|\\vec{A}|$ in case ${n}?`,
  options: ['(A) $3$', '(B) $5$', '(C) $7$', '(D) $25$'],
  solution: `$|\\vec{A}| = \\sqrt{${n}^2 + 4^2}$`,
  correct_option: correct,
  hint: 'Use Pythagoras on the components.',
});
const numeric = (n, value) => ({
  kind: 'numeric',
  difficulty: 'hard',
  question: `Find $\\vec{A}\\cdot\\vec{B}$ for case ${n} (to two decimals).`,
  options: [],
  solution: `The dot product is $${value}$.`,
  answer_value: value,
  hint: 'Multiply matching components and add.',
});

before(async () => {
  setAiClientForTests(fake);
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  root = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${root}/api/platform/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      slug: SLUG, gym_name: 'Vector Academy', admin_name: 'Anita Rao', admin_email: 'anita@vector.test',
      admin_password: 'strongpass123', currency: 'INR', business_type: 'coaching',
    }),
  });
  const body = await res.json();
  assert.equal(res.status, 201, JSON.stringify(body));
  token = body.token;
});

after(() => {
  setAiClientForTests(null);
  server.close();
  closeDb();
  closeRegistryDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/* ── Checking questions ──────────────────────────────────────────────── */

describe('checking a question', () => {
  it('strips the model’s own numbering and option letters, and maps a letter to an index', () => {
    const q = checkQuestion({ ...mcq(3), question: 'Q1. ' + mcq(3).question });
    assert.match(q.question, /^If /);
    assert.deepEqual(q.options, ['$3$', '$5$', '$7$', '$25$']);
    assert.equal(q.correct_option, 1);
  });

  it('refuses unbalanced maths, repeated options and an answer that is not an option', () => {
    assert.throws(() => checkQuestion({ ...mcq(3), question: 'What is $x^2 when x = 3?' }), /\$ without its closing/);
    assert.throws(() => checkQuestion({ ...mcq(3), options: ['1', '2', '2', '3'] }), /same/);
    assert.throws(() => checkQuestion({ ...mcq(3), correct_option: 'E' }), /correct option/);
    assert.throws(() => checkQuestion({ ...numeric(1, 3), answer_value: 'about five' }), /answer as a number/);
    assert.equal(balancedMath('Costs \\$5 and $x$'), true);
  });

  it('accepts a decimal numerical answer to its last place and a whole number exactly', () => {
    assert.equal(checkQuestion(numeric(1, 2.75)).answer_tolerance, 0.01);
    assert.equal(checkQuestion(numeric(1, 12)).answer_tolerance, 0);
  });

  it('drops the faulty questions in a reply and keeps the rest', () => {
    const parsed = parseGenerated(JSON.stringify({ questions: [mcq(3), { ...mcq(4), options: ['1', '2'] }, numeric(1, 6)] }));
    assert.equal(parsed.questions.length, 2);
    assert.equal(parsed.dropped, 1);
    assert.equal(parseGenerated('not json').unreadable, true);
  });

  it('splits a mixed paper 2:1 like JEE Main', () => {
    assert.deepEqual(splitMix('mixed', 15), { mcq: 10, numeric: 5 });
    assert.deepEqual(splitMix('mcq', 15), { mcq: 15, numeric: 0 });
  });

  it('grades with negative marking, and a numerical answer within its tolerance', () => {
    const questions = [
      { id: 1, kind: 'mcq', options: ['a', 'b', 'c', 'd'], correct_option: 1, marks: 4 },
      { id: 2, kind: 'mcq', options: ['a', 'b', 'c', 'd'], correct_option: 2, marks: 4 },
      { id: 3, kind: 'numeric', answer_value: 2.75, answer_tolerance: 0.01, marks: 4 },
      { id: 4, kind: 'numeric', answer_value: 12, answer_tolerance: 0, marks: 4 },
    ];
    const graded = gradeAttempt(questions, { 1: 1, 2: 0, 3: '2.76' }, 1);
    assert.equal(graded.score, 4 - 1 + 4);
    assert.deepEqual([graded.correct, graded.wrong, graded.skipped], [2, 1, 1]);
    assert.equal(graded.results[4], 'skipped');
  });
});

/* ── Generating, saving and sitting a DPP ────────────────────────────── */

describe('the DPP generator and the app test', () => {
  let batch;
  let physics;
  let students;
  let studentTokens;
  let draft;
  let test;

  before(async () => {
    const course = await call('POST', '/api/coaching/courses', { name: 'Class 11 JEE 2027', academic_year: '2026-2027', subjects: [{ name: 'Physics' }] });
    assert.equal(course.status, 201, JSON.stringify(course.body));
    physics = course.body.subjects[0];
    batch = (await call('POST', '/api/coaching/batches', { course_id: course.body.id, name: 'JEE 11-A', code: 'J11A', start_date: today() })).body;
    students = [];
    for (const first of ['Aarav', 'Diya', 'Kabir']) {
      const m = await call('POST', '/api/members', { first_name: first, last_name: 'Shah', phone: '9800000011' });
      assert.equal((await call('POST', '/api/coaching/enrollments', { member_id: m.body.id, batch_id: batch.id })).status, 201);
      students.push(m.body);
    }
    studentTokens = [];
    for (const s of students) studentTokens.push(await memberToken(memberCall, { staffToken: token, memberId: s.id }));
  });

  it('says it is set up, with the day’s allowance', async () => {
    const res = await call('GET', '/api/coaching/tests/generator');
    assert.equal(res.status, 200);
    assert.equal(res.body.configured, true);
    assert.equal(res.body.used_today, 0);
    assert.ok(res.body.levels.some((l) => l.key === 'jee_main'));
  });

  it('writes a paper, drops a faulty question and tops the paper up', async () => {
    fake.replies.push({ questions: [mcq(3), mcq(5, 'C'), { ...mcq(6), question: 'Broken $x' }, numeric(1, 2.75)] });
    fake.replies.push({ questions: [mcq(7, 'A')] });
    const res = await call('POST', '/api/coaching/tests/generate', {
      subject_id: physics.id, class_level: 'Class 11', topic: 'Vectors', level: 'jee_main', mix: 'mixed', count: 4, marks: 4,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.questions.length, 4);
    assert.equal(res.body.dropped, 1);
    assert.equal(res.body.used_today, 1);
    // MCQs first, then numerical.
    assert.deepEqual(res.body.questions.map((q) => q.kind), ['mcq', 'mcq', 'mcq', 'numeric']);
    const prompt = fake.calls[0].contents[0].parts[0].text;
    assert.match(prompt, /Subject: Physics/);
    assert.match(prompt, /Topic: Vectors/);
    assert.match(prompt, /JEE Main/);
    assert.match(prompt, /3 single-correct MCQs, then 1 numerical-answer question/);
    assert.match(fake.calls[1].contents[0].parts[0].text, /Do not repeat them/);
    assert.equal(fake.calls[0].config.responseMimeType, 'application/json');
    draft = res.body.questions;
  });

  it('answers a failed generation with a 502, not a crash', async () => {
    fake.replies.push(new Error('quota exceeded'));
    const res = await call('POST', '/api/coaching/tests/generate', { subject: 'Physics', topic: 'Kinematics' });
    assert.equal(res.status, 502);
    assert.equal(res.body.details?.code ?? res.body.code, 'generator_failed');
  });

  it('saves the draft as a test, its maximum from the paper, open in the app', async () => {
    const res = await call('POST', '/api/coaching/tests', {
      batch_id: batch.id, subject_id: physics.id, title: 'DPP: Vectors', test_type: 'dpp', test_date: today(),
      max_marks: 1, negative_marking: 1, duration_min: 30, answers_after: 'submit', online: true,
      topic: 'Vectors', level: 'jee_main', class_level: 'Class 11', generated: true, questions: draft,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    test = res.body;
    assert.equal(test.max_marks, 16);
    assert.equal(test.question_count, 4);
    assert.equal(test.online, 1);

    const paper = await call('GET', `/api/coaching/tests/${test.id}/paper`);
    assert.equal(paper.body.questions.length, 4);
    assert.equal(paper.body.questions[1].correct_option, 2);
  });

  it('will not open a test with no paper in the app, nor let a PATCH fight the paper’s maximum', async () => {
    const bare = await call('POST', '/api/coaching/tests', { batch_id: batch.id, title: 'Paper test', test_date: today(), max_marks: 50, online: true });
    assert.equal(bare.status, 400);
    const max = await call('PATCH', `/api/coaching/tests/${test.id}`, { max_marks: 100 });
    assert.equal(max.status, 400);
  });

  it('lists the test in the student app and sends the paper without its answers', async () => {
    const list = await call('GET', '/api/portal/coaching/tests', undefined, { useToken: studentTokens[0] });
    assert.equal(list.status, 200);
    assert.equal(list.body.online.length, 1);
    assert.equal(list.body.online[0].status, 'not_started');
    assert.equal(list.body.online[0].questions, 4);

    const paper = await call('GET', `/api/portal/coaching/tests/${test.id}/paper`, undefined, { useToken: studentTokens[0] });
    assert.equal(paper.status, 200);
    assert.equal(paper.body.can_start, true);
    assert.equal(paper.body.revealed, false);
    for (const q of paper.body.questions) {
      assert.equal(q.correct_option, undefined);
      assert.equal(q.answer_value, undefined);
      assert.equal(q.solution, undefined);
      assert.ok(q.hint);
    }
  });

  it('times, autosaves and grades an attempt into the marks sheet, then shows the answer key', async () => {
    const t = studentTokens[0];
    const started = await call('POST', `/api/portal/coaching/tests/${test.id}/start`, {}, { useToken: t });
    assert.equal(started.status, 200);
    assert.equal(started.body.attempt.status, 'in_progress');
    assert.ok(started.body.attempt.seconds_left > 29 * 60 && started.body.attempt.seconds_left <= 30 * 60);
    const ids = started.body.questions.map((q) => q.id);

    // Right, wrong, (skip), right numerical — and an answer to a question not on the paper.
    const saved = await call('PUT', `/api/portal/coaching/tests/${test.id}/answers`, { answers: { [ids[0]]: 1, [ids[1]]: 0, [ids[3]]: '2.75', 99999: 2 }, hints_used: [ids[1]] }, { useToken: t });
    assert.equal(saved.status, 200);
    const resumed = await call('GET', `/api/portal/coaching/tests/${test.id}/paper`, undefined, { useToken: t });
    assert.deepEqual(Object.keys(resumed.body.attempt.answers).map(Number).sort(), [ids[0], ids[1], ids[3]].sort());
    assert.deepEqual(resumed.body.attempt.hints_used, [ids[1]]);

    const submitted = await call('POST', `/api/portal/coaching/tests/${test.id}/submit`, {}, { useToken: t });
    assert.equal(submitted.status, 200);
    assert.equal(submitted.body.attempt.score, 4 - 1 + 4);
    assert.deepEqual([submitted.body.attempt.correct, submitted.body.attempt.wrong, submitted.body.attempt.skipped], [2, 1, 1]);
    // A practice paper shows the key as soon as it is in.
    assert.equal(submitted.body.revealed, true);
    assert.equal(submitted.body.questions[1].result, 'wrong');
    assert.equal(submitted.body.questions[1].correct_option, 2);

    const again = await call('POST', `/api/portal/coaching/tests/${test.id}/submit`, {}, { useToken: t });
    assert.equal(again.status, 409);
    const late = await call('PUT', `/api/portal/coaching/tests/${test.id}/answers`, { answers: {} }, { useToken: t });
    assert.equal(late.status, 409);

    const sheet = await call('GET', `/api/coaching/tests/${test.id}`);
    const row = sheet.body.items.find((i) => i.member_id === students[0].id);
    assert.equal(row.marks_obtained, 7);
    assert.equal(row.rank, 1);
    assert.equal(row.app.status, 'submitted');
  });

  it('submits what was saved when time runs out with the app closed', async () => {
    const t = studentTokens[1];
    const started = await call('POST', `/api/portal/coaching/tests/${test.id}/start`, {}, { useToken: t });
    const ids = started.body.questions.map((q) => q.id);
    await call('PUT', `/api/portal/coaching/tests/${test.id}/answers`, { answers: { [ids[0]]: 1, [ids[1]]: 2 } }, { useToken: t });
    tenantRun("UPDATE academic_test_attempts SET deadline_at = datetime('now', '-5 minutes') WHERE test_id = ? AND member_id = ?", [test.id, students[1].id]);

    const late = await call('PUT', `/api/portal/coaching/tests/${test.id}/answers`, { answers: { [ids[2]]: 1 } }, { useToken: t });
    assert.equal(late.status, 409);
    const sheet = await call('GET', `/api/coaching/tests/${test.id}`);
    const row = sheet.body.items.find((i) => i.member_id === students[1].id);
    assert.equal(row.marks_obtained, 8);
    assert.equal(row.rank, 1);
    assert.equal(row.app.status, 'submitted');
  });

  it('regrades every submitted attempt when a teacher corrects an answer', async () => {
    const paper = (await call('GET', `/api/coaching/tests/${test.id}/paper`)).body;
    // The key was wrong on Q2: option A is right after all.
    const fixed = paper.questions.map((q, i) => (i === 1 ? { ...q, correct_option: 0 } : q));
    const res = await call('PUT', `/api/coaching/tests/${test.id}/paper`, { questions: fixed });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.questions[1].id, paper.questions[1].id, 'the question keeps its id');
    const sheet = await call('GET', `/api/coaching/tests/${test.id}`);
    assert.equal(sheet.body.items.find((i) => i.member_id === students[0].id).marks_obtained, 12);
    assert.equal(sheet.body.items.find((i) => i.member_id === students[1].id).marks_obtained, 3);
    const refused = await call('PUT', `/api/coaching/tests/${test.id}/paper`, { questions: [] });
    assert.equal(refused.status, 409);
  });

  it('keeps a closed or future test out of reach, and another batch’s test hidden', async () => {
    const future = await call('POST', '/api/coaching/tests', {
      batch_id: batch.id, title: 'Next week', test_type: 'dpp', test_date: addDays(today(), 7), max_marks: 1, online: true, questions: draft.slice(0, 1),
    });
    const t = studentTokens[2];
    const paper = await call('GET', `/api/portal/coaching/tests/${future.body.id}/paper`, undefined, { useToken: t });
    assert.equal(paper.body.can_start, false);
    assert.match(paper.body.blocked_reason, /opens on/);
    assert.equal((await call('POST', `/api/portal/coaching/tests/${future.body.id}/start`, {}, { useToken: t })).status, 409);

    await call('PATCH', `/api/coaching/tests/${test.id}`, { online: false });
    assert.equal((await call('GET', `/api/portal/coaching/tests/${test.id}/paper`, undefined, { useToken: t })).status, 404);
    // Those who sat it still see their result.
    assert.equal((await call('GET', `/api/portal/coaching/tests/${test.id}/paper`, undefined, { useToken: studentTokens[0] })).status, 200);

    const course = await call('POST', '/api/coaching/courses', { name: 'NEET 2027', academic_year: '2026-2027' });
    const other = (await call('POST', '/api/coaching/batches', { course_id: course.body.id, name: 'NEET-A', code: 'NA', start_date: today() })).body;
    const theirs = await call('POST', '/api/coaching/tests', {
      batch_id: other.id, title: 'NEET DPP', test_type: 'dpp', test_date: today(), max_marks: 1, online: true, questions: draft.slice(0, 1),
    });
    assert.equal((await call('GET', `/api/portal/coaching/tests/${theirs.body.id}/paper`, undefined, { useToken: t })).status, 404);
  });
});
