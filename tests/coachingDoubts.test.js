import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { openSocket } from './helpers/liveSocket.js';
import { memberToken } from './helpers/memberAuth.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-coaching-doubts-test-'));
process.env.DB_FILE = path.join(tmpDir, 'default.db');
process.env.PLATFORM_DB_FILE = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.AUTH_SECRET = 'test-secret';
// A second rather than 15, so slow mode can be waited out inside a test.
process.env.LIVE_SLOW_MODE_MS = '1000';

const { createApp } = await import('../src/app.js');
const { closeDb, get, tenantStorage } = await import('../src/db.js');
const { closeRegistryDb, tenantDbPath } = await import('../src/tenants.js');
const { today } = await import('../src/validate.js');
const { attachLiveGateway } = await import('../src/coaching/liveGateway.js');
const { MAX_OPEN_DOUBTS, SLOW_MODE_MS, doubtProblem } = await import('../src/coaching/liveDoubts.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SLOWED = SLOW_MODE_MS + 50;

/* ── What counts as a doubt ──────────────────────────────────────────── */

describe('the Doubt Box filter', () => {
  it('keeps chatter, links and noise out', () => {
    for (const [text, reason] of [
      ['hi sir', 'too_short'],
      ['??????????', 'too_short'],
      ['Good morning sir!!', 'chatter'],
      ['hiiiii sirrrrr', 'chatter'],
      ['ok got it thank you mam', 'chatter'],
      ['notes milenge? www.cheapnotes.in', 'link'],
      ['join https://t.me/freebatch for PDFs', 'link'],
      ['x'.repeat(501), 'too_long'],
    ]) assert.equal(doubtProblem(text), reason, text);
  });

  it('lets a real question through, in any script', () => {
    for (const text of [
      'Why is the acceleration not zero at the top?',
      'sir 2nd step mein sign kyu change hua?',
      'त्वरण शून्य क्यों नहीं है?',
      'Is ∫x dx = x²/2 + C here?',
    ]) assert.equal(doubtProblem(text), null, text);
  });
});

/* ── In the class ────────────────────────────────────────────────────── */

let root;
let server;
let gateway;
let admin;
const SLUG = 'vidya-doubts';

const call = async (method, urlPath, body, { useToken = admin } = {}) => {
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

async function staffMember(name, email) {
  assert.equal((await call('POST', '/api/staff', { name, email, password: 'staffpass123', role: 'trainer' })).status, 201);
  const login = await call('POST', '/api/auth/login', { email, password: 'staffpass123' }, { useToken: null });
  return { id: login.body.user.id, token: login.body.token };
}

async function student(firstName, batch) {
  const created = await call('POST', '/api/members', { first_name: firstName, last_name: 'Sharma', phone: '9800000006' });
  const enrolled = await call('POST', '/api/coaching/enrollments', { member_id: created.body.id, batch_id: batch.id });
  assert.equal(enrolled.status, 201, JSON.stringify(enrolled.body));
  const memberCall = (method, urlPath, body, opts = {}) => call(method, urlPath, body, { useToken: opts.token });
  return {
    id: created.body.id, enrollmentId: enrolled.body.enrollment.id, token: await memberToken(memberCall, { staffToken: admin, memberId: created.body.id }),
  };
}

async function join(sessionId, who, kind) {
  const url = kind === 'teacher' ? `/api/coaching/live/sessions/${sessionId}/socket-ticket` : `/api/portal/coaching/live/sessions/${sessionId}/socket-ticket`;
  const ticket = await call('POST', url, undefined, { useToken: who.token });
  assert.equal(ticket.status, 200, JSON.stringify(ticket.body));
  const socket = await openSocket(root, ticket.body);
  return { socket, joined: await socket.next('room:joined') };
}

const ask = (who, body) => who.socket.request('student:ask_doubt', { body });
const pinnedCount = (sessionId) =>
  tenantStorage.run({ slug: SLUG, dbFile: tenantDbPath(SLUG) }, () => get('SELECT COUNT(*) AS n FROM live_doubts WHERE session_id = ? AND pinned = 1', [sessionId]).n);

let batchA;
let batchB;
let verma; // teaches batch A
let rao; // teaches batch B
let sessionA;
let sessionB;
let teacherA;
let teacherB;
let aarav;
let kabir;
let meera; // dropped from batch A mid-class
let diya; // batch B
let aaravDoubt;
let kabirDoubt;
let diyaDoubt;

/** Everyone in class A but `except`, and everyone in class B. */
const bystanders = (except) => [teacherA, aarav, kabir, meera, teacherB, diya].filter((p) => p !== except);

describe('doubts in a live class', () => {
  before(async () => {
    server = createApp().listen(0);
    gateway = attachLiveGateway(server);
    await new Promise((resolve) => server.once('listening', resolve));
    root = `http://127.0.0.1:${server.address().port}`;
    const signup = await fetch(`${root}/api/platform/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug: SLUG, gym_name: 'Vidya Classes', admin_name: 'Director', admin_email: 'director@vidya-doubts.test', admin_password: 'strongpass123', currency: 'INR', business_type: 'coaching',
      }),
    });
    admin = (await signup.json()).token;

    const course = (await call('GET', '/api/coaching/courses')).body.items[0];
    const [physics, chemistry] = course.subjects;
    batchA = (await call('GET', '/api/coaching/batches')).body.items.find((b) => b.code === 'B12A');
    batchB = (await call('POST', '/api/coaching/batches', { course_id: course.id, name: 'Batch 12-B', code: 'B12B', start_date: today() })).body;
    verma = await staffMember('Prof Verma', 'verma@vidya-doubts.test');
    rao = await staffMember('Prof Rao', 'rao@vidya-doubts.test');
    await call('POST', `/api/coaching/batches/${batchA.id}/faculty`, { faculty_id: verma.id, subject_id: physics.id });
    await call('POST', `/api/coaching/batches/${batchB.id}/faculty`, { faculty_id: rao.id, subject_id: chemistry.id });

    sessionA = (await call('POST', '/api/coaching/live/sessions', { batch_id: batchA.id, subject_id: physics.id }, { useToken: verma.token })).body;
    sessionB = (await call('POST', '/api/coaching/live/sessions', { batch_id: batchB.id, subject_id: chemistry.id }, { useToken: rao.token })).body;

    aarav = await student('Aarav', batchA);
    kabir = await student('Kabir', batchA);
    meera = await student('Meera', batchA);
    diya = await student('Diya', batchB);
    teacherA = { ...verma, ...(await join(sessionA.id, verma, 'teacher')) };
    teacherB = { ...rao, ...(await join(sessionB.id, rao, 'teacher')) };
    for (const s of [aarav, kabir, meera]) Object.assign(s, await join(sessionA.id, s, 'student'));
    Object.assign(diya, await join(sessionB.id, diya, 'student'));
  });

  after(() => {
    for (const p of [teacherA, teacherB, aarav, kabir, meera, diya]) p?.socket?.close();
    gateway.close();
    server.close();
    closeDb();
    closeRegistryDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('starts each socket with an empty Doubt Box', () => {
    assert.equal(teacherA.joined.pinned_doubt, null);
    assert.deepEqual(teacherA.joined.doubts, []);
    assert.deepEqual(aarav.joined.my_doubts, []);
    assert.equal(aarav.joined.doubts, undefined, 'the queue is the teacher’s');
  });

  it('routes a doubt to its own class’s teacher, and nobody else', async () => {
    const res = await ask(aarav, 'Why is the acceleration not zero at the top?');
    assert.equal(res.ok, true, JSON.stringify(res));
    aaravDoubt = res.data;
    assert.deepEqual([aaravDoubt.pinned, aaravDoubt.resolved], [false, false]);

    const queued = await teacherA.socket.next('doubt:new');
    assert.equal(queued.id, aaravDoubt.id);
    assert.equal(queued.name, 'Aarav Sharma');
    assert.equal(queued.roll_number, 'B12A-01');
    await sleep(100);
    for (const p of bystanders(teacherA)) assert.ok(!p.socket.got('doubt:new'), 'no other student, and not class B');
  });

  it('turns chatter away without starting slow mode', async () => {
    const chatter = await ask(kabir, 'good morning sir');
    assert.equal(chatter.status, 400);
    assert.deepEqual(chatter.details, { code: 'not_a_doubt', reason: 'chatter' });
    const real = await ask(kabir, 'Sir is the normal force equal to mg on the incline?');
    assert.equal(real.ok, true, 'straight back in, no slow mode for a refused message');
    kabirDoubt = real.data;
    assert.equal((await teacherA.socket.next('doubt:new')).id, kabirDoubt.id);
  });

  it('puts students on slow mode in chat, but never the teacher', async () => {
    const first = await aarav.socket.request('chat:send', { text: 'audio is clear now' });
    assert.equal(first.ok, true);
    assert.equal(first.data.slow_mode_ms, SLOW_MODE_MS);
    const second = await aarav.socket.request('chat:send', { text: 'thanks' });
    assert.equal(second.status, 429);
    assert.equal(second.details.code, 'slow_mode');
    assert.ok(second.details.retry_after_ms > 0 && second.details.retry_after_ms <= SLOW_MODE_MS);

    for (const p of [teacherA, kabir, meera]) assert.equal((await p.socket.next('chat:message')).text, 'audio is clear now');
    assert.ok(!diya.socket.got('chat:message'), 'class B hears nothing of class A');

    for (const text of ['Settle down', 'Open page 42', 'Ready?']) {
      assert.equal((await teacherA.socket.request('chat:send', { text })).ok, true);
    }
    const kabirChat = await kabir.socket.request('chat:send', { text: 'ready sir' });
    assert.equal(kabirChat.ok, true, 'chat and doubts are separate lanes');
    await sleep(SLOWED);
    assert.equal((await aarav.socket.request('chat:send', { text: 'ok thanks' })).ok, true, 'free again after the window');
  });

  it('pins one doubt at a time, on its own class’s screens', async () => {
    const pinned = await teacherA.socket.request('teacher:pin_doubt', { doubt_id: aaravDoubt.id });
    assert.equal(pinned.ok, true, JSON.stringify(pinned));
    for (const p of [teacherA, aarav, kabir, meera]) {
      const shown = await p.socket.next('doubt:pinned');
      assert.equal(shown.id, aaravDoubt.id);
      assert.equal(shown.name, 'Aarav S.', 'first name and initial in front of the class');
      assert.equal(shown.member_id, undefined);
    }
    assert.ok(!diya.socket.got('doubt:pinned') && !teacherB.socket.got('doubt:pinned'));

    await teacherA.socket.request('teacher:pin_doubt', { doubt_id: kabirDoubt.id });
    assert.equal((await kabir.socket.next('doubt:pinned')).id, kabirDoubt.id);
    assert.equal(pinnedCount(sessionA.id), 1, 'pinning Kabir’s took Aarav’s down');
    const staff = await call('GET', `/api/coaching/live/sessions/${sessionA.id}/doubts`, undefined, { useToken: verma.token });
    assert.equal(staff.body.pinned.id, kabirDoubt.id);
    assert.deepEqual(staff.body.items.map((d) => [d.id, d.pinned]), [[kabirDoubt.id, true], [aaravDoubt.id, false]], 'pinned first, then the queue');
  });

  it('keeps every doubt inside its own batch’s class', async () => {
    const res = await ask(diya, 'Why does the ester smell fruity?');
    assert.equal(res.ok, true);
    diyaDoubt = res.data;
    assert.equal((await teacherB.socket.next('doubt:new')).id, diyaDoubt.id);
    assert.ok(!teacherA.socket.got('doubt:new', (d) => d.id === diyaDoubt.id));

    // Class A's teacher cannot reach class B's doubts by id, nor the reverse.
    assert.equal((await teacherA.socket.request('teacher:pin_doubt', { doubt_id: diyaDoubt.id })).status, 404);
    assert.equal((await teacherA.socket.request('teacher:resolve_doubt', { doubt_id: diyaDoubt.id })).status, 404);
    assert.equal((await teacherB.socket.request('teacher:pin_doubt', { doubt_id: aaravDoubt.id })).status, 404);
    assert.equal((await teacherB.socket.request('teacher:resolve_doubt', { doubt_id: kabirDoubt.id })).status, 404);
    assert.equal((await aarav.socket.request('teacher:pin_doubt', { doubt_id: aaravDoubt.id })).status, 403);

    // Nor over REST: each teacher, and each student, sees only their own class.
    assert.equal((await call('GET', `/api/coaching/live/sessions/${sessionA.id}/doubts`, undefined, { useToken: rao.token })).status, 403);
    assert.equal((await call('GET', `/api/portal/coaching/live/sessions/${sessionA.id}/doubts`, undefined, { useToken: diya.token })).status, 404);
    assert.equal((await call('GET', `/api/portal/coaching/live/sessions/${sessionB.id}/doubts`, undefined, { useToken: aarav.token })).status, 404);
    assert.equal((await call('POST', `/api/portal/coaching/live/sessions/${sessionA.id}/socket-ticket`, undefined, { useToken: diya.token })).status, 404);
    const b = await call('GET', `/api/coaching/live/sessions/${sessionB.id}/doubts`, undefined, { useToken: rao.token });
    assert.deepEqual(b.body.items.map((d) => d.id), [diyaDoubt.id]);
  });

  it('shows a student the pinned doubt and their own — not the rest of the queue', async () => {
    const mine = await call('GET', `/api/portal/coaching/live/sessions/${sessionA.id}/doubts`, undefined, { useToken: aarav.token });
    assert.equal(mine.status, 200);
    assert.equal(mine.body.pinned.id, kabirDoubt.id);
    assert.equal(mine.body.pinned.name, 'Kabir S.');
    assert.deepEqual(mine.body.mine.map((d) => d.id), [aaravDoubt.id]);

    // The same on a fresh socket, for a phone that reconnects.
    aarav.socket.close();
    Object.assign(aarav, await join(sessionA.id, aarav, 'student'));
    assert.equal(aarav.joined.pinned_doubt.id, kabirDoubt.id);
    assert.deepEqual(aarav.joined.my_doubts.map((d) => d.id), [aaravDoubt.id]);
    teacherA.socket.close();
    Object.assign(teacherA, await join(sessionA.id, verma, 'teacher'));
    assert.deepEqual(teacherA.joined.doubts.map((d) => d.id), [kabirDoubt.id, aaravDoubt.id]);
    assert.deepEqual(teacherA.joined.doubt_counts, { open: 2, resolved: 0 });
  });

  it('tells the asker when a doubt is answered, and the class when it was pinned', async () => {
    const quiet = await teacherA.socket.request('teacher:resolve_doubt', { doubt_id: aaravDoubt.id });
    assert.equal(quiet.ok, true);
    assert.deepEqual(await aarav.socket.next('doubt:resolved'), { doubt_id: aaravDoubt.id, was_pinned: false });
    await sleep(100);
    assert.ok(!kabir.socket.got('doubt:resolved'), 'an unpinned doubt is between the asker and the teacher');

    await teacherA.socket.request('teacher:resolve_doubt', { doubt_id: kabirDoubt.id });
    for (const p of [aarav, kabir, meera]) assert.deepEqual(await p.socket.next('doubt:resolved', (d) => d.doubt_id === kabirDoubt.id), { doubt_id: kabirDoubt.id, was_pinned: true });
    assert.equal(pinnedCount(sessionA.id), 0, 'off everyone’s screen');
    assert.equal((await teacherA.socket.request('teacher:resolve_doubt', { doubt_id: kabirDoubt.id })).details.code, 'doubt_resolved');
    assert.equal((await teacherA.socket.request('teacher:pin_doubt', { doubt_id: kabirDoubt.id })).details.code, 'doubt_resolved');

    const answered = await call('GET', `/api/coaching/live/sessions/${sessionA.id}/doubts?status=resolved`, undefined, { useToken: verma.token });
    assert.equal(answered.body.items.length, 2);
    assert.ok(answered.body.items.every((d) => d.resolved && d.resolved_by_name === 'Prof Verma'));
    assert.deepEqual(answered.body.counts, { open: 0, resolved: 2 });
    assert.equal(answered.body.pinned, null);
    assert.equal((await call('GET', `/api/coaching/live/sessions/${sessionA.id}/doubts?status=maybe`, undefined, { useToken: verma.token })).status, 400);
  });

  it('refuses a repeat, and more than a handful waiting at once', async () => {
    const asked = [];
    for (let i = 1; i <= MAX_OPEN_DOUBTS; i += 1) {
      await sleep(SLOWED);
      const res = await ask(kabir, `Question number ${i} about friction on the incline`);
      assert.equal(res.ok, true, JSON.stringify(res));
      asked.push(res.data.id);
    }
    await sleep(SLOWED);
    const repeat = await ask(kabir, 'question NUMBER 1 about friction, on the incline!');
    assert.equal(repeat.details.code, 'duplicate_doubt');
    const tooMany = await ask(kabir, 'One more question about the pulley system please');
    assert.equal(tooMany.details.code, 'too_many_open');
    await teacherA.socket.request('teacher:resolve_doubt', { doubt_id: asked[0] });
    assert.equal((await ask(kabir, 'One more question about the pulley system please')).ok, true, 'room again once one is answered');
  });

  it('shuts a student out the moment they leave the batch, and everyone once the class ends', async () => {
    assert.equal((await call('PATCH', `/api/coaching/enrollments/${meera.enrollmentId}`, { status: 'dropped' })).status, 200);
    const dropped = await ask(meera, 'Can you explain the second law again?');
    assert.equal(dropped.status, 403, 'checked per doubt, not just at the ticket');

    assert.equal((await call('PATCH', `/api/coaching/live/sessions/${sessionA.id}/end`, undefined, { useToken: verma.token })).status, 200);
    await sleep(SLOWED);
    const late = await ask(aarav, 'One last thing about the derivation sir');
    assert.equal(late.details.code, 'session_not_live');
    const after = await call('GET', `/api/portal/coaching/live/sessions/${sessionA.id}/doubts`, undefined, { useToken: aarav.token });
    assert.equal(after.status, 200, 'their own doubts stay readable after class');
    assert.deepEqual(after.body.mine.map((d) => [d.id, d.resolved]), [[aaravDoubt.id, true]]);
  });
});
