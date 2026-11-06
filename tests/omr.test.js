import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-omr-test-'));
process.env.DB_FILE = path.join(tmpDir, 'default.db');
process.env.PLATFORM_DB_FILE = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.AUTH_SECRET = 'test-secret';
process.env.WHATSAPP_MESSAGE_GAP_MS = '0';

const { createApp } = await import('../src/app.js');
const { closeDb } = await import('../src/db.js');
const { closeRegistryDb } = await import('../src/tenants.js');
const { today } = await import('../src/validate.js');
const { sentInMemory } = await import('../src/whatsapp.js');
const { gradeResponse, parseAnswerKey, questionStats } = await import('../src/coaching/omr.js');
const { rollDigits } = await import('../public/js/omrLayout.js');
const { findSheet, readSheet } = await import('../public/js/omrScan.js');
const { renderSheet, sampleAnswers } = await import('./helpers/omrRender.js');

/* ── Answer keys and grading ─────────────────────────────────────────── */

describe('answer keys', () => {
  it('reads a typed key however it is laid out', () => {
    assert.deepEqual(parseAnswerKey('ABCD ab(ca)*', { questions: 8, options: 4 }), ['A', 'B', 'C', 'D', 'A', 'B', 'AC', '*']);
    assert.deepEqual(parseAnswerKey('1.A 2.B 3-C 4: D', { questions: 4, options: 4 }), ['A', 'B', 'C', 'D']);
    assert.deepEqual(parseAnswerKey('a,b,[cd],*', { questions: 4, options: 4 }), ['A', 'B', 'CD', '*']);
    assert.deepEqual(parseAnswerKey(['a', 'B', 'ca', '*'], { questions: 4, options: 4 }), ['A', 'B', 'AC', '*']);
  });

  it('refuses a key of the wrong length or with an option the paper does not have', () => {
    assert.throws(() => parseAnswerKey('ABC', { questions: 4, options: 4 }), /3 answers but the paper has 4/);
    assert.throws(() => parseAnswerKey('ABCE', { questions: 4, options: 4 }), /Question 4/);
    assert.ok(parseAnswerKey('ABCE', { questions: 4, options: 5 }));
    assert.throws(() => parseAnswerKey('AB(CD', { questions: 3, options: 4 }), /never closed/);
  });

  it('grades with negative marking, multi-answer keys, bonus questions and double-filled bubbles', () => {
    const key = ['A', 'B', 'AC', '*', 'D', 'C'];
    const g = gradeResponse(key, ['A', 'C', 'C', '', 'BD', ''], { marksCorrect: 4, negative: 1 });
    // A ✓, C ✗, C ✓ (either accepted), bonus, two bubbles ✗, blank
    assert.deepEqual(g.outcome, ['correct', 'wrong', 'correct', 'bonus', 'wrong', 'blank']);
    assert.equal(g.correct, 2);
    assert.equal(g.wrong, 2);
    assert.equal(g.blank, 1);
    assert.equal(g.score, 3 * 4 - 2);
  });

  it('works out which questions the batch found hard', () => {
    const stats = questionStats(['A', 'B'], [['A', 'C'], ['A', 'C'], ['B', '']]);
    assert.equal(stats[0].correct_pct, 66.67);
    assert.deepEqual(stats[1].common_wrong, { answer: 'C', count: 2 });
    assert.equal(stats[1].blank_pct, 33.33);
  });

  it('bubbles the trailing digits of a roll number', () => {
    assert.equal(rollDigits('B12A-07'), '0007');
    assert.equal(rollDigits('2024105'), '4105');
    assert.equal(rollDigits('NEET'), null);
  });
});

/* ── Reading a sheet out of a camera frame ───────────────────────────── */

describe('reading a sheet from the camera', () => {
  const frame = { width: 900, height: 1200 };

  it('finds the corners through perspective and reads every answer and the roll number', () => {
    const answers = sampleAnswers(100, 4, 3);
    const gray = renderSheet({
      questions: 100, options: 4, answers, roll: '0007', frame,
      quad: [[120, 90], [790, 140], [840, 1130], [60, 1090]],
    });
    const found = findSheet(gray, frame.width, frame.height);
    assert.ok(found.found, JSON.stringify(found));
    const read = readSheet(gray, frame.width, frame.height, found.H, { questions: 100, options: 4 });
    assert.deepEqual(read.answers, answers);
    assert.equal(read.roll, '0007');
    assert.equal(read.rollProblem, null);
  });

  it('reads a sheet held upside down the right way round', () => {
    const answers = sampleAnswers(40, 5, 11);
    const gray = renderSheet({
      questions: 40, options: 5, answers, roll: '1234', frame, light: [0.7, 1],
      quad: [[820, 1100], [110, 1150], [70, 120], [780, 60]],
    });
    const found = findSheet(gray, frame.width, frame.height);
    assert.ok(found.found, JSON.stringify(found));
    const read = readSheet(gray, frame.width, frame.height, found.H, { questions: 40, options: 5 });
    assert.deepEqual(read.answers, answers);
    assert.equal(read.roll, '1234');
  });

  it('reads a sheet lying sideways in a landscape frame', () => {
    const wide = { width: 1280, height: 900 };
    const answers = sampleAnswers(60, 4, 5);
    const gray = renderSheet({
      questions: 60, options: 4, answers, roll: '  42', frame: wide,
      // The sheet's top edge runs down the right of the frame.
      quad: [[1180, 80], [1170, 830], [110, 850], [140, 60]],
    });
    const found = findSheet(gray, wide.width, wide.height);
    assert.ok(found.found, JSON.stringify(found));
    const read = readSheet(gray, wide.width, wide.height, found.H, { questions: 60, options: 4 });
    assert.deepEqual(read.answers, answers);
    assert.equal(read.roll, '0042');
  });

  it('reads light pencil-like marks against a blank sheet', () => {
    const answers = sampleAnswers(30, 4, 9);
    const gray = renderSheet({
      questions: 30, options: 4, answers, roll: '0101', frame, fillInk: 120, fillRadius: 0.85,
      quad: [[100, 100], [800, 100], [800, 1130], [100, 1130]],
    });
    const found = findSheet(gray, frame.width, frame.height);
    assert.ok(found.found);
    const read = readSheet(gray, frame.width, frame.height, found.H, { questions: 30, options: 4 });
    assert.deepEqual(read.answers, answers);
  });

  it('says which problem it has with an unreadable roll number', () => {
    const gray = renderSheet({
      questions: 20, options: 4, answers: sampleAnswers(20, 4, 2), roll: '', frame,
      quad: [[100, 100], [800, 100], [800, 1130], [100, 1130]],
    });
    const found = findSheet(gray, frame.width, frame.height);
    const read = readSheet(gray, frame.width, frame.height, found.H, { questions: 20, options: 4 });
    assert.equal(read.roll, null);
    assert.equal(read.rollProblem, 'blank');
  });

  it('reports no sheet in a frame without one', () => {
    const gray = new Uint8Array(frame.width * frame.height).fill(200);
    for (let i = 0; i < 40; i++) for (let y = 0; y < 30; y++) for (let x = 0; x < 30; x++) gray[(50 + y + i * 25) * frame.width + 100 + x + (i % 3) * 200] = 30;
    const found = findSheet(gray, frame.width, frame.height);
    assert.equal(found.found, false);
  });
});

/* ── The API, end to end ─────────────────────────────────────────────── */

let root;
let server;
let token;
const SLUG = 'omr-institute';

const call = async (method, urlPath, body, { useToken = token } = {}) => {
  const res = await fetch(`${root}/g/${SLUG}${urlPath}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(useToken ? { Authorization: `Bearer ${useToken}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const type = res.headers.get('content-type') || '';
  if (!type.includes('json')) return { status: res.status, body: null, bytes: Buffer.from(await res.arrayBuffer()), type };
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

describe('OMR marking through the API', () => {
  let batch;
  let test;
  const students = [];

  before(async () => {
    server = createApp().listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    root = `http://127.0.0.1:${server.address().port}`;
    const signup = await fetch(`${root}/api/platform/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug: SLUG, gym_name: 'Vidya OMR Classes', admin_name: 'Asha Rao', admin_email: 'asha@omr.test',
        admin_password: 'strongpass123', currency: 'INR', business_type: 'coaching',
      }),
    });
    const signed = await signup.json();
    assert.equal(signup.status, 201, JSON.stringify(signed));
    token = signed.token;
    batch = (await call('GET', '/api/coaching/batches')).body.items[0];
    for (const [i, name] of ['Aarav', 'Diya', 'Kabir'].entries()) {
      const member = await call('POST', '/api/members', { first_name: name, last_name: 'Shah', phone: `98000000${10 + i}`, emergency_phone: `98111111${10 + i}` });
      assert.equal(member.status, 201, JSON.stringify(member.body));
      const enrolled = await call('POST', '/api/coaching/enrollments', { member_id: member.body.id, batch_id: batch.id });
      assert.equal(enrolled.status, 201, JSON.stringify(enrolled.body));
      students.push({ id: member.body.id, roll: enrolled.body.enrollment.roll_number });
    }
    const created = await call('POST', '/api/coaching/tests', {
      batch_id: batch.id, title: 'Mock 4: Full syllabus', test_type: 'mock', test_date: today(), max_marks: 100, negative_marking: 1,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    test = created.body;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    closeDb();
    closeRegistryDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('sets the paper up without a key, so sheets can be printed before the key is final', async () => {
    const res = await call('PUT', `/api/coaching/tests/${test.id}/omr`, { questions: 5, options: 4, marks_correct: 4 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.configured, true);
    assert.equal(res.body.answer_key, null);
    assert.equal(res.body.test.max_marks, 20, 'max marks follow questions × marks per question');
    assert.equal(res.body.roster.length, 3);
    assert.equal(res.body.roster[0].roll_digits, rollDigits(students[0].roll));

    const pdf = await call('GET', `/api/coaching/tests/${test.id}/omr/sheet.pdf`);
    assert.equal(pdf.status, 200);
    assert.match(pdf.type, /application\/pdf/);
    assert.equal(pdf.bytes.subarray(0, 5).toString(), '%PDF-');
    const named = await call('GET', `/api/coaching/tests/${test.id}/omr/sheet.pdf?named=1`);
    assert.equal(named.status, 200);
    assert.ok(named.bytes.length > pdf.bytes.length, 'one page per student');

    const early = await call('POST', `/api/coaching/tests/${test.id}/omr/scans`, { member_id: students[0].id, answers: ['A', 'B', 'C', 'D', 'A'] });
    assert.equal(early.status, 400);
    assert.match(early.body.error, /answer key/);
  });

  it('grades a scanned sheet on the server, saves the mark and ranks it', async () => {
    const keyed = await call('PUT', `/api/coaching/tests/${test.id}/omr`, { questions: 5, options: 4, marks_correct: 4, answer_key: 'ABCDA' });
    assert.equal(keyed.status, 200, JSON.stringify(keyed.body));
    assert.deepEqual(keyed.body.answer_key, ['A', 'B', 'C', 'D', 'A']);

    const first = await call('POST', `/api/coaching/tests/${test.id}/omr/scans`, { member_id: students[0].id, answers: ['A', 'B', 'C', 'D', 'A'] });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.score, 20);
    assert.equal(first.body.rank, 1);

    const second = await call('POST', `/api/coaching/tests/${test.id}/omr/scans`, { member_id: students[1].id, answers: ['A', 'C', '', 'BD', 'a'] });
    assert.equal(second.body.correct, 2);
    assert.equal(second.body.wrong, 2);
    assert.equal(second.body.blank, 1);
    assert.equal(second.body.score, 6);
    assert.equal(second.body.rank, 2);
    assert.equal(second.body.scanned, 2);

    const sheet = await call('GET', `/api/coaching/tests/${test.id}`);
    assert.equal(sheet.body.items.find((i) => i.member_id === students[1].id).marks_obtained, 6);

    const rescan = await call('POST', `/api/coaching/tests/${test.id}/omr/scans`, { member_id: students[1].id, answers: ['A', 'B', 'C', 'D', ''] });
    assert.equal(rescan.status, 200);
    assert.equal(rescan.body.replaced, true);
    assert.equal(rescan.body.score, 16);

    const bad = await call('POST', `/api/coaching/tests/${test.id}/omr/scans`, { member_id: students[2].id, answers: ['A', 'B'] });
    assert.equal(bad.status, 400);
    const stranger = await call('POST', `/api/coaching/tests/${test.id}/omr/scans`, { member_id: 99999, answers: ['A', 'B', 'C', 'D', 'A'] });
    assert.equal(stranger.status, 400);
  });

  it('re-grades every scanned sheet when the key is corrected or the negative marking changes', async () => {
    const fixed = await call('PUT', `/api/coaching/tests/${test.id}/omr`, { questions: 5, options: 4, marks_correct: 4, answer_key: 'ABCD*' });
    assert.equal(fixed.status, 200);
    const diya = fixed.body.roster.find((r) => r.member_id === students[1].id);
    assert.equal(diya.score, 20, 'the bonus question counts for everyone, blank or not');

    const reshape = await call('PUT', `/api/coaching/tests/${test.id}/omr`, { questions: 6, options: 4, marks_correct: 4, answer_key: 'ABCD*A' });
    assert.equal(reshape.status, 409);

    const patched = await call('PATCH', `/api/coaching/tests/${test.id}`, { max_marks: 50 });
    assert.equal(patched.status, 400);
    assert.match(patched.body.error, /OMR/);
  });

  it('publishes and puts the right/wrong/unattempted count in the parent scorecard', async () => {
    await call('POST', `/api/coaching/tests/${test.id}/omr/scans`, { member_id: students[2].id, answers: ['B', 'B', '', '', ''] });
    process.env.WHATSAPP_TRANSPORT = 'memory';
    try {
      const before = sentInMemory.length;
      const res = await call('POST', `/api/coaching/tests/${test.id}/publish`, {});
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.whatsapp.queued, 3);
      await settle();
      const cards = sentInMemory.slice(before).filter((m) => m.type === 'scorecard');
      const kabir = cards.find((c) => /Kabir/.test(c.message));
      assert.ok(kabir, JSON.stringify(cards));
      assert.match(kabir.message, /Correct: 1, Wrong: 1, Unattempted: 2\./);
    } finally {
      delete process.env.WHATSAPP_TRANSPORT;
    }
  });

  it('offers a question paper’s answers as the key and keeps to the paper’s total', async () => {
    const mcq = (q, correct) => ({ kind: 'mcq', question: q, options: ['One', 'Two', 'Three', 'Four'], correct_option: correct, marks: 4 });
    const created = await call('POST', '/api/coaching/tests', {
      batch_id: batch.id, title: 'DPP 7: Kinematics', test_type: 'dpp', test_date: today(), max_marks: 12,
      questions: [mcq('What is the first answer?', 2), mcq('What is the second answer?', 0), mcq('What is the third answer?', 3)],
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const state = await call('GET', `/api/coaching/tests/${created.body.id}/omr`);
    assert.deepEqual(state.body.paper_key, ['C', 'A', 'D']);
    const mismatch = await call('PUT', `/api/coaching/tests/${created.body.id}/omr`, { questions: 3, options: 4, marks_correct: 3 });
    assert.equal(mismatch.status, 409);
    assert.match(mismatch.body.error, /out of 12/);
    const ok = await call('PUT', `/api/coaching/tests/${created.body.id}/omr`, { questions: 3, options: 4, marks_correct: 4, answer_key: state.body.paper_key });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
  });

  it('takes a scan back out along with its mark', async () => {
    const res = await call('DELETE', `/api/coaching/tests/${test.id}/omr/scans/${students[2].id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.scanned, 2);
    const sheet = await call('GET', `/api/coaching/tests/${test.id}`);
    assert.equal(sheet.body.items.find((i) => i.member_id === students[2].id).entered, false);
  });
});
