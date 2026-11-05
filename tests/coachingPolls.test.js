import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { openSocket as connectTo, refusedWith } from './helpers/liveSocket.js';
import { memberToken } from './helpers/memberAuth.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-coaching-polls-test-'));
process.env.DB_FILE = path.join(tmpDir, 'default.db');
process.env.PLATFORM_DB_FILE = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.AUTH_SECRET = 'test-secret';

const { createApp } = await import('../src/app.js');
const { closeDb, get, tenantStorage } = await import('../src/db.js');
const { closeRegistryDb, tenantDbPath } = await import('../src/tenants.js');
const { today } = await import('../src/validate.js');
const { attachLiveGateway } = await import('../src/coaching/liveGateway.js');
const { LEADERBOARD_SIZE, percentages, pollResults, rankRespondents } = await import('../src/coaching/livePolls.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sum = (list) => Math.round(list.reduce((a, b) => a + b, 0) * 10) / 10;

/* ── The arithmetic ──────────────────────────────────────────────────── */

describe('poll arithmetic', () => {
  it('gives one-decimal percentages that always add up to 100', () => {
    assert.deepEqual(percentages([1, 1, 1]), [33.4, 33.3, 33.3]);
    assert.deepEqual(percentages([1, 2]), [33.3, 66.7]);
    assert.deepEqual(percentages([2, 1, 0, 1]), [50, 25, 0, 25]);
    assert.deepEqual(percentages([0, 0, 0, 0]), [0, 0, 0, 0]);
    for (let trial = 0; trial < 500; trial += 1) {
      const counts = Array.from({ length: 2 + (trial % 3) }, () => Math.floor(Math.random() * 400));
      const result = percentages(counts);
      if (counts.some(Boolean)) assert.equal(sum(result), 100, `${counts} → ${result}`);
      counts.forEach((n, i) => {
        if (!n) assert.equal(result[i], 0, 'an option nobody chose stays at 0');
      });
    }
  });

  it('ranks only correct answers, fastest first, with ties sharing a place', () => {
    const votes = [
      { member_id: 1, choice: 'B', response_ms: 900, seq: 1 },
      { member_id: 2, choice: 'A', response_ms: 100, seq: 2 }, // fastest, but wrong
      { member_id: 3, choice: 'B', response_ms: 400, seq: 3 },
      { member_id: 4, choice: 'B', response_ms: 400, seq: 4 },
      { member_id: 5, choice: 'B', response_ms: 1200, seq: 5 },
    ];
    assert.deepEqual(rankRespondents(votes, 'B').map((r) => [r.member_id, r.rank]), [[3, 1], [4, 1], [1, 3], [5, 4]]);
    assert.deepEqual(rankRespondents(votes, null).map((r) => [r.member_id, r.rank]), [[2, 1], [3, 2], [4, 2], [1, 4], [5, 5]], 'an opinion poll ranks everyone');
  });

  it('keeps everyone tied at the last leaderboard place on it', () => {
    const votes = Array.from({ length: 14 }, (_, i) => ({ member_id: i + 1, choice: 'A', response_ms: i < 9 ? 100 + i : 500, seq: i + 1 }));
    const results = pollResults({ optionCount: 2, correctOption: 'A', votes });
    assert.equal(results.leaderboard.length, 14, 'places 10–14 all share rank 10');
    assert.ok(results.leaderboard.every((r) => r.rank <= LEADERBOARD_SIZE));
    assert.equal(results.accuracy, 100);
    assert.deepEqual(results.options.map((o) => [o.option, o.count, o.percent, o.correct]), [['A', 14, 100, true], ['B', 0, 0, false]]);
  });
});

/* ── Over the socket ─────────────────────────────────────────────────── */

let root;
let server;
let gateway;
let admin;
const SLUG = 'vidya-polls';

const call = async (method, urlPath, body, { useToken = admin, slug = SLUG } = {}) => {
  const res = await fetch(`${root}/g/${slug}${urlPath}`, {
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

const openSocket = (ticket) => connectTo(root, ticket);

async function staffMember(name, email, role) {
  assert.equal((await call('POST', '/api/staff', { name, email, password: 'staffpass123', role })).status, 201);
  const login = await call('POST', '/api/auth/login', { email, password: 'staffpass123' }, { useToken: null });
  return { id: login.body.user.id, token: login.body.token };
}

async function student(firstName, batch) {
  const created = await call('POST', '/api/members', { first_name: firstName, last_name: 'Kumar', phone: '9800000005' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const enrolled = await call('POST', '/api/coaching/enrollments', { member_id: created.body.id, batch_id: batch.id });
  assert.equal(enrolled.status, 201, JSON.stringify(enrolled.body));
  const memberCall = (method, urlPath, body, opts = {}) => call(method, urlPath, body, { useToken: opts.token });
  return { id: created.body.id, name: firstName, token: await memberToken(memberCall, { staffToken: admin, memberId: created.body.id }) };
}

const staffTicket = (sessionId, who) => call('POST', `/api/coaching/live/sessions/${sessionId}/socket-ticket`, undefined, { useToken: who.token });
const studentTicket = (sessionId, who) => call('POST', `/api/portal/coaching/live/sessions/${sessionId}/socket-ticket`, undefined, { useToken: who.token });
async function join(sessionId, who, kind) {
  const res = await (kind === 'teacher' ? staffTicket : studentTicket)(sessionId, who);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const socket = await openSocket(res.body);
  const joined = await socket.next('room:joined');
  return { socket, joined };
}

const forPoll = (id) => (data) => data.poll_id === id;

const CLASS_SIZE = 80;
const BURST_CHOICES = ['A', 'B', 'B', 'C', 'D', 'B', 'A'];

let physics;
let bigBatch;
let batchB;
let verma; // teaches bigBatch Physics
let rao; // teaches batch B Chemistry
let desk;
let students = [];
let diya; // batch B
let session;
let sessionB;
let teacher;
let classroom = []; // { student, socket }
let diyaSocket;
let pollRanked;
let lastPoll;
let timerPoll; // closed on its timer, answer revealed afterwards // opened in the reconnect test, closed by ending the class

describe('live polls over the socket', () => {
  before(async () => {
    server = createApp().listen(0);
    gateway = attachLiveGateway(server);
    await new Promise((resolve) => server.once('listening', resolve));
    root = `http://127.0.0.1:${server.address().port}`;
    const signup = await fetch(`${root}/api/platform/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug: SLUG, gym_name: 'Vidya Classes', admin_name: 'Director', admin_email: 'director@vidya-polls.test', admin_password: 'strongpass123', currency: 'INR', business_type: 'coaching',
      }),
    });
    admin = (await signup.json()).token;

    const course = (await call('GET', '/api/coaching/courses')).body.items[0];
    const [phy, chemistry] = course.subjects;
    physics = phy;
    bigBatch = (await call('POST', '/api/coaching/batches', { course_id: course.id, name: 'JEE Crash', code: 'JCR', capacity: 150, start_date: today() })).body;
    batchB = (await call('POST', '/api/coaching/batches', { course_id: course.id, name: 'Batch 12-B', code: 'B12B', start_date: today() })).body;
    verma = await staffMember('Prof Verma', 'verma@vidya-polls.test', 'trainer');
    rao = await staffMember('Prof Rao', 'rao@vidya-polls.test', 'trainer');
    desk = await staffMember('Front Desk', 'desk@vidya-polls.test', 'staff');
    await call('POST', `/api/coaching/batches/${bigBatch.id}/faculty`, { faculty_id: verma.id, subject_id: physics.id });
    await call('POST', `/api/coaching/batches/${batchB.id}/faculty`, { faculty_id: rao.id, subject_id: chemistry.id });

    for (let i = 0; i < CLASS_SIZE; i += 10) {
      const chunk = await Promise.all(Array.from({ length: Math.min(10, CLASS_SIZE - i) }, (_, j) => student(`S${String(i + j + 1).padStart(2, '0')}`, bigBatch)));
      students.push(...chunk);
    }
    diya = await student('Diya', batchB);

    session = (await call('POST', '/api/coaching/live/sessions', { batch_id: bigBatch.id, subject_id: physics.id }, { useToken: verma.token })).body;
    sessionB = (await call('POST', '/api/coaching/live/sessions', { batch_id: batchB.id, subject_id: chemistry.id }, { useToken: rao.token })).body;
  });

  after(() => {
    for (const { socket } of classroom) socket.close();
    gateway.close();
    server.close();
    closeDb();
    closeRegistryDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('only hands a ticket to the class’s teacher, a manager, or a student on its batch', async () => {
    assert.equal((await staffTicket(session.id, rao)).status, 403);
    assert.equal((await staffTicket(session.id, desk)).status, 403);
    assert.equal((await staffTicket(session.id, { token: admin })).status, 200);
    assert.equal((await studentTicket(session.id, diya)).status, 404, 'another batch’s class is not found');
    assert.equal((await studentTicket(9999, students[0])).status, 404);
    assert.equal((await studentTicket(session.id, { token: verma.token })).status, 401);
  });

  it('refuses a socket without a fresh ticket, and a ticket twice', async () => {
    const ws = root.replace('http', 'ws');
    assert.equal(await refusedWith(`${ws}/ws/live`), 401);
    assert.equal(await refusedWith(`${ws}/ws/live?ticket=forged`), 401);
    assert.equal(await refusedWith(`${ws}/somewhere-else`), 404);
    const ticket = (await studentTicket(session.id, students[0])).body;
    const first = await openSocket(ticket);
    assert.equal(await refusedWith(`${ws}${ticket.path}?ticket=${ticket.ticket}`), 401, 'single use');
    first.close();
  });

  it('puts everyone in the class’s room', async () => {
    const t = await join(session.id, verma, 'teacher');
    teacher = t.socket;
    assert.equal(t.joined.room, `session_${session.id}`);
    assert.equal(t.joined.role, 'teacher');
    assert.equal(t.joined.poll, null);
    classroom = await Promise.all(students.map(async (s) => ({ student: s, socket: (await join(session.id, s, 'student')).socket })));
    diyaSocket = (await join(sessionB.id, diya, 'student')).socket;
  });

  it('broadcasts a poll and its countdown, keeping the answer from students', async () => {
    const ack = await teacher.request('teacher:create_poll', {
      question: 'Direction of angular momentum?', option_count: 4, correct_option: 'B', duration_sec: 45,
      options: { A: 'Along r', B: 'Along r × p', C: 'Along p', D: 'Zero' },
    });
    assert.equal(ack.ok, true, JSON.stringify(ack));
    assert.equal(ack.data.correct_option, 'B', 'the teacher sees the key');

    const started = await classroom[0].socket.next('poll:started');
    assert.equal(started.poll_id, ack.data.poll_id);
    assert.equal(started.duration_sec, 45);
    assert.ok(started.remaining_ms > 44_000 && started.remaining_ms <= 45_000);
    assert.deepEqual(started.options.map((o) => [o.option, o.text]), [['A', 'Along r'], ['B', 'Along r × p'], ['C', 'Along p'], ['D', 'Zero']]);
    assert.equal(started.correct_option, undefined, 'no answer key on a student’s screen');
    await Promise.all(classroom.slice(1).map(({ socket }) => socket.next('poll:started')));

    const tick = await classroom[1].socket.next('poll:tick', forPoll(ack.data.poll_id), 2000);
    assert.ok(tick.remaining_ms < started.remaining_ms);
    assert.equal(tick.counts, undefined, 'students see how many answered, not what they answered');
    assert.ok((await teacher.next('poll:tick', forPoll(ack.data.poll_id), 2000)).counts);

    await sleep(50);
    assert.ok(!diyaSocket.inbox.some((m) => m.event === 'poll:started'), 'another class’s room hears nothing');
  });

  it('tallies a burst of simultaneous votes exactly, first answer final', async () => {
    // A second poll is refused while the first runs.
    const running = await teacher.request('teacher:create_poll', { duration_sec: 30 });
    assert.equal(running.ok, false);
    assert.equal(running.details.code, 'poll_running');
    const poll = running.details.poll_id;

    // Every student sends their answer and a second, different one at once.
    const acks = await Promise.all(classroom.map(({ socket }, i) => {
      const choice = BURST_CHOICES[i % BURST_CHOICES.length];
      const change = choice === 'A' ? 'D' : 'A';
      return Promise.all([socket.request('student:submit_vote', { poll_id: poll, choice }), socket.request('student:submit_vote', { poll_id: poll, choice: change })]);
    }));
    acks.forEach(([first, second], i) => {
      assert.equal(first.ok, true, JSON.stringify(first));
      assert.equal(first.data.choice, BURST_CHOICES[i % BURST_CHOICES.length]);
      assert.ok(first.data.response_ms >= 0);
      assert.equal(second.ok, false);
      assert.equal(second.details.code, 'already_voted');
      assert.equal(second.details.choice, first.data.choice, 'the first answer stands');
    });

    const ended = await teacher.request('poll:end', { poll_id: poll });
    assert.equal(ended.ok, true);
    const results = await classroom[5].socket.next('poll:end', forPoll(poll));
    const expected = { A: 0, B: 0, C: 0, D: 0 };
    classroom.forEach((_, i) => { expected[BURST_CHOICES[i % BURST_CHOICES.length]] += 1; });
    assert.equal(results.total, CLASS_SIZE);
    assert.deepEqual(Object.fromEntries(results.options.map((o) => [o.option, o.count])), expected);
    assert.equal(sum(results.options.map((o) => o.percent)), 100);
    assert.equal(results.correct_option, 'B', 'the answer is revealed at the end');
    assert.equal(results.correct_count, expected.B);
    assert.equal(results.accuracy, Math.round((expected.B / CLASS_SIZE) * 1000) / 10);
    assert.equal(results.reason, 'teacher');
    assert.ok(results.leaderboard.every((r) => r.choice === 'B'));

    const mine = await classroom[1].socket.next('poll:my_result', forPoll(poll));
    assert.equal(mine.choice, 'B');
    assert.equal(mine.correct, true);
    assert.equal(mine.ranked_of, expected.B);
    const wrong = await classroom[0].socket.next('poll:my_result', forPoll(poll));
    assert.equal(wrong.correct, false);
    assert.equal(wrong.rank, null);

    const saved = tenantStorage.run({ slug: SLUG, dbFile: tenantDbPath(SLUG) }, () => ({
      votes: get('SELECT COUNT(*) AS n FROM live_poll_votes WHERE poll_id = ?', [poll]).n,
      status: get('SELECT status FROM live_polls WHERE id = ?', [poll]).status,
    }));
    assert.deepEqual(saved, { votes: CLASS_SIZE, status: 'closed' }, 'one vote row per student, written on close');
    await Promise.all(classroom.filter((_, i) => i !== 5).map(({ socket }) => socket.next('poll:end', forPoll(poll))));
  });

  it('ranks the fastest correct answers in the order they arrived', async () => {
    const created = await teacher.request('teacher:create_poll', { option_count: 3, correct_option: 'C', duration_sec: 30 });
    assert.equal(created.ok, true, JSON.stringify(created));
    const pollId = created.data.poll_id;
    await Promise.all(classroom.map(({ socket }) => socket.next('poll:started', forPoll(pollId))));

    // A wrong answer first and between the right ones, which must not place.
    const order = [];
    for (let i = 0; i < 16; i += 1) {
      const { socket, student: s } = classroom[i];
      const choice = i === 0 || i % 5 === 0 ? 'A' : 'C';
      const ack = await socket.request('student:submit_vote', { poll_id: pollId, choice });
      assert.equal(ack.ok, true);
      order.push({ member_id: s.id, choice, response_ms: ack.data.response_ms });
      await sleep(25);
    }
    await teacher.request('poll:end', { poll_id: pollId });
    const results = await classroom[20].socket.next('poll:end', forPoll(pollId));
    pollRanked = results;

    const expected = order.filter((v) => v.choice === 'C').slice(0, LEADERBOARD_SIZE);
    assert.deepEqual(results.leaderboard.map((r) => r.member_id), expected.map((v) => v.member_id));
    assert.deepEqual(results.leaderboard.map((r) => r.rank), expected.map((_, i) => i + 1));
    assert.deepEqual(results.leaderboard.map((r) => r.response_ms), expected.map((v) => v.response_ms), 'the times each student was told');
    assert.equal(results.leaderboard[0].name, `${classroom[1].student.name} K.`, 'first name and initial in front of the class');
    for (let i = 1; i < results.leaderboard.length; i += 1) assert.ok(results.leaderboard[i].response_ms > results.leaderboard[i - 1].response_ms);

    const third = await classroom[3].socket.next('poll:my_result', forPoll(pollId));
    assert.equal(third.rank, 3, 'S04 was the third right answer');
    assert.equal((await classroom[5].socket.next('poll:my_result', forPoll(pollId))).rank, null, 'a wrong answer has no place');
    assert.equal((await classroom[40].socket.next('poll:my_result', forPoll(pollId))).choice, null, 'nor does silence');
  });

  it('closes a poll on its own timer and refuses a late vote', async () => {
    const created = await teacher.request('teacher:create_poll', { option_count: 2, duration_sec: 5 });
    const pollId = created.data.poll_id;
    assert.equal((await classroom[0].socket.request('student:submit_vote', { poll_id: pollId, choice: 'b' })).ok, true, 'case does not matter');
    const ended = await classroom[0].socket.next('poll:end', forPoll(pollId), 7000);
    assert.equal(ended.poll_id, pollId);
    assert.equal(ended.reason, 'timer');
    assert.equal(ended.correct_option, null);
    assert.equal(ended.awaiting_answer, true, 'no answer yet: the teacher reveals it after the voting');
    assert.deepEqual(ended.leaderboard, [], 'nobody is ranked before anyone knows who was right');
    assert.equal((await classroom[0].socket.next('poll:my_result', forPoll(pollId))).rank, null);
    const late = await classroom[1].socket.request('student:submit_vote', { poll_id: pollId, choice: 'A' });
    assert.equal(late.ok, false);
    assert.equal(late.details.code, 'poll_closed');
    timerPoll = pollId;
  });

  it('reveals the answer after the voting, then ranks the fastest right answers', async () => {
    assert.equal((await classroom[0].socket.request('teacher:reveal_answer', { poll_id: timerPoll, correct_option: 'B' })).status, 403);
    assert.equal((await teacher.request('teacher:reveal_answer', { poll_id: timerPoll, correct_option: 'C' })).status, 400, 'C is not on a two-option poll');
    assert.equal((await teacher.request('teacher:reveal_answer', { poll_id: 99999, correct_option: 'A' })).status, 404);

    const revealed = await teacher.request('teacher:reveal_answer', { poll_id: timerPoll, correct_option: 'b' });
    assert.equal(revealed.ok, true, JSON.stringify(revealed));
    const seen = await classroom[7].socket.next('poll:revealed', forPoll(timerPoll));
    assert.equal(seen.correct_option, 'B');
    assert.equal(seen.awaiting_answer, false);
    assert.deepEqual(seen.leaderboard.map((r) => [r.rank, r.member_id]), [[1, classroom[0].student.id]]);
    const mine = await classroom[0].socket.next('poll:my_result', (d) => d.poll_id === timerPoll && d.correct !== null);
    assert.deepEqual([mine.choice, mine.correct, mine.rank], ['B', true, 1]);
    const saved = tenantStorage.run({ slug: SLUG, dbFile: tenantDbPath(SLUG) }, () => get('SELECT correct_option FROM live_polls WHERE id = ?', [timerPoll]));
    assert.equal(saved.correct_option, 'B', 'kept for the history');

    // Revealing a poll still running closes it first.
    const running = (await teacher.request('teacher:create_poll', { duration_sec: 60 })).data.poll_id;
    await classroom[4].socket.request('student:submit_vote', { poll_id: running, choice: 'D' });
    await classroom[5].socket.request('student:submit_vote', { poll_id: running, choice: 'A' });
    await teacher.request('teacher:reveal_answer', { poll_id: running, correct_option: 'D' });
    assert.equal((await classroom[6].socket.next('poll:end', forPoll(running))).awaiting_answer, true);
    const after = await classroom[6].socket.next('poll:revealed', forPoll(running));
    assert.deepEqual(after.leaderboard.map((r) => r.member_id), [classroom[4].student.id]);
    assert.equal(after.accuracy, 50);
  });

  it('keeps each side to its own events and refuses bad input', async () => {
    const studentPoll = await classroom[0].socket.request('teacher:create_poll', {});
    assert.equal(studentPoll.status, 403);
    const badKey = await teacher.request('teacher:create_poll', { option_count: 2, correct_option: 'C' });
    assert.equal(badKey.status, 400);
    assert.equal(badKey.details.correct_option, 'not an option');
    const tooShort = await teacher.request('teacher:create_poll', { duration_sec: 2 });
    assert.equal(tooShort.status, 400);
    const unknown = await teacher.request('teacher:launch_rocket', {});
    assert.equal(unknown.ok, false);

    const poll = (await teacher.request('teacher:create_poll', { option_count: 2, correct_option: 'A', duration_sec: 60 })).data.poll_id;
    assert.equal((await teacher.request('student:submit_vote', { poll_id: poll, choice: 'A' })).status, 403);
    assert.equal((await classroom[0].socket.request('student:submit_vote', { poll_id: poll, choice: 'C' })).status, 400, 'C is not on a two-option poll');
    assert.equal((await classroom[0].socket.request('student:submit_vote', { poll_id: poll + 1, choice: 'A' })).details.code, 'poll_closed');
    assert.equal((await classroom[0].socket.request('poll:end', { poll_id: poll })).status, 403);
    assert.equal((await teacher.request('poll:end', { poll_id: poll })).ok, true);
    classroom[0].socket.ws.send('not json');
    await sleep(100);
    const garbled = classroom[0].socket.inbox.find((m) => m.event === 'ack' && m.ref === null);
    assert.equal(garbled?.ok, false);
    assert.match(garbled.error, /JSON/);
  });

  it('remembers a student’s answer when they reconnect mid-poll', async () => {
    const created = await teacher.request('teacher:create_poll', { duration_sec: 60 });
    assert.equal(created.ok, true, JSON.stringify(created));
    const running = created.data.poll_id;
    lastPoll = running;
    const s = classroom[2];
    assert.equal((await s.socket.request('student:submit_vote', { poll_id: running, choice: 'B' })).ok, true);
    s.socket.close();
    const back = await join(session.id, s.student, 'student');
    s.socket = back.socket;
    assert.equal(back.joined.poll.poll_id, running);
    assert.deepEqual(back.joined.poll.my_vote.choice, 'B');
    const again = await s.socket.request('student:submit_vote', { poll_id: running, choice: 'A' });
    assert.equal(again.details.code, 'already_voted');
  });

  it('saves a running poll when the class ends, and tells the room', async () => {
    const running = lastPoll;
    assert.equal((await classroom[3].socket.request('student:submit_vote', { poll_id: running, choice: 'A' })).ok, true);
    const ended = await call('PATCH', `/api/coaching/live/sessions/${session.id}/end`, undefined, { useToken: verma.token });
    assert.equal(ended.status, 200);
    const result = await classroom[3].socket.next('poll:end', forPoll(running));
    assert.equal(result.poll_id, running);
    assert.equal(result.reason, 'class_ended');
    assert.equal(result.total, 2, 'the reconnecting student’s vote and this one');
    await classroom[3].socket.next('session:ended');
    const refused = await teacher.request('teacher:create_poll', {});
    assert.equal(refused.details.code, 'session_not_live');
  });

  it('reports every poll and every student for the lecture', async () => {
    assert.equal((await call('GET', `/api/coaching/live/sessions/${session.id}/polls`, undefined, { useToken: rao.token })).status, 403);
    const res = await call('GET', `/api/coaching/live/sessions/${session.id}/polls`, undefined, { useToken: verma.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const { polls, students: report, summary, roster_size: rosterSize } = res.body;
    assert.equal(rosterSize, CLASS_SIZE);
    assert.deepEqual(polls.map((p) => p.status), ['closed', 'closed', 'closed', 'closed', 'closed', 'closed']);
    assert.equal(summary.polls, 6);

    const [burst, ranked] = polls;
    assert.equal(burst.question, 'Direction of angular momentum?');
    assert.equal(burst.total, CLASS_SIZE);
    assert.equal(burst.participation, 100);
    assert.deepEqual(burst.options.map((o) => o.text), ['Along r', 'Along r × p', 'Along p', 'Zero']);
    assert.equal(sum(burst.options.map((o) => o.percent)), 100);

    // Read back from the database, the leaderboard is the one the class saw.
    assert.deepEqual(
      ranked.leaderboard.map((r) => [r.rank, r.member_id, r.response_ms]),
      pollRanked.leaderboard.map((r) => [r.rank, r.member_id, r.response_ms]),
    );
    assert.equal(ranked.leaderboard[0].name, `${classroom[1].student.name} Kumar`, 'staff see full names');
    assert.equal(ranked.participation, 20);

    const silent = report.filter((s) => !s.answered);
    assert.equal(summary.never_answered, silent.length);
    assert.equal(report.length, CLASS_SIZE);
    const top = report[0];
    assert.ok(top.correct >= report[1].correct);
    const s02 = report.find((s) => s.member_id === classroom[1].student.id);
    assert.deepEqual([s02.answered, s02.correct, s02.graded], [2, 2, 2], 'right on both graded polls it answered');
    assert.ok(s02.fastest >= 1, 'and fastest on the ranked one');
  });
});
