import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { memberToken } from './helpers/memberAuth.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-recordings-test-'));
process.env.DB_FILE = path.join(tmpDir, 'default.db');
process.env.PLATFORM_DB_FILE = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.AUTH_SECRET = 'test-secret';

const { createApp } = await import('../src/app.js');
const { closeDb, get, run, tenantStorage } = await import('../src/db.js');
const { closeRegistryDb, tenantDbPath } = await import('../src/tenants.js');
const { today } = await import('../src/validate.js');
const { youtubeVideoId } = await import('../src/coaching/recordings.js');

let root;
let server;
let admin;
const SLUG = 'vidya-recordings';

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
const inTenant = (fn) => tenantStorage.run({ slug: SLUG, dbFile: tenantDbPath(SLUG), businessType: 'coaching' }, fn);

async function staffMember(name, email, role) {
  const created = await call('POST', '/api/staff', { name, email, password: 'staffpass123', role });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const login = await call('POST', '/api/auth/login', { email, password: 'staffpass123' }, { useToken: null });
  return { id: login.body.user.id, token: login.body.token };
}

async function student(firstName, batchId) {
  const created = await call('POST', '/api/members', { first_name: firstName, last_name: 'Sharma', phone: '9800000002' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal((await call('POST', '/api/coaching/enrollments', { member_id: created.body.id, batch_id: batchId })).status, 201);
  const memberCall = (method, urlPath, body, opts = {}) => call(method, urlPath, body, { useToken: opts.token });
  return { id: created.body.id, token: await memberToken(memberCall, { staffToken: admin, memberId: created.body.id }) };
}

/** A class taught live and ended, the way a teacher or board would. */
async function teach(body) {
  const live = await call('POST', '/api/coaching/live/sessions', body);
  assert.equal(live.status, 201, JSON.stringify(live.body));
  assert.equal((await call('PATCH', `/api/coaching/live/sessions/${live.body.id}/end`)).status, 200);
  return live.body.id;
}

const filedFor = (sessionId) => inTenant(() => get('SELECT * FROM class_recordings WHERE live_session_id = ?', [sessionId]));
const as = (who) => ({ useToken: who.token });

let physics;
let chemistry;
let biology;
let batchA;
let batchB;
let desk;
let aarav; // batch A
let diya; // batch B

before(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  root = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${root}/api/platform/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug: SLUG, gym_name: 'Vidya Classes', admin_name: 'Director', admin_email: 'director@vidya-rec.test', admin_password: 'strongpass123', currency: 'INR', business_type: 'coaching' }),
  });
  admin = (await res.json()).token;

  const course = (await call('GET', '/api/coaching/courses')).body.items[0];
  [physics, chemistry] = course.subjects;
  batchA = (await call('GET', '/api/coaching/batches')).body.items.find((b) => b.code === 'B12A');
  batchB = (await call('POST', '/api/coaching/batches', { course_id: course.id, name: 'Batch 12-B', code: 'B12B', start_date: today() })).body;
  biology = (await call('POST', '/api/coaching/courses', { name: 'NEET 2027', academic_year: '2026-2027', subjects: [{ name: 'Biology' }] })).body.subjects[0];
  desk = await staffMember('Front Desk', 'desk@vidya-rec.test', 'staff');
  aarav = await student('Aarav', batchA.id);
  diya = await student('Diya', batchB.id);
});

after(() => {
  server.close();
  closeDb();
  closeRegistryDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('YouTube links', () => {
  it('finds the video in every shape of link, and nothing in a channel feed or another site', () => {
    for (const url of ['https://www.youtube.com/watch?v=abcDEF12345', 'https://youtu.be/abcDEF12345', 'https://www.youtube.com/live/abcDEF12345?si=x', 'https://m.youtube.com/embed/abcDEF12345']) {
      assert.equal(youtubeVideoId(url), 'abcDEF12345', url);
    }
    for (const url of ['https://www.youtube.com/embed/live_stream?channel=UCabcdefghijklmnopqrstuv', 'https://zoom.us/j/123', 'not a url', null]) {
      assert.equal(youtubeVideoId(url), null, String(url));
    }
  });
});

let lectureId;

describe('a live class files its recording when it ends', () => {
  it('files a class taught over YouTube under its batch and subject', async () => {
    const sessionId = await teach({ batch_id: batchA.id, subject_id: physics.id, stream_url: 'https://youtu.be/abcDEF12345' });
    const filed = filedFor(sessionId);
    assert.equal(filed.batch_id, batchA.id);
    assert.equal(filed.subject_id, physics.id);
    assert.equal(filed.source, 'youtube');
    assert.equal(filed.video_ref, 'abcDEF12345');
    assert.equal(filed.status, 'ready');
    assert.equal(filed.title, `${physics.name} lecture`);
    assert.equal(filed.duration_sec, null, 'a class under a minute long has no length to show yet');
    lectureId = filed.id;
  });

  it('files nothing for a class on Zoom or in the room alone', async () => {
    assert.equal(filedFor(await teach({ batch_id: batchA.id, subject_id: chemistry.id, stream_url: 'https://zoom.us/j/123' })), undefined);
    assert.equal(filedFor(await teach({ batch_id: batchA.id, subject_id: chemistry.id })), undefined);
  });
});

describe('My Batches', () => {
  it('lists the student’s own batches with how many lectures they hold', async () => {
    const mine = (await call('GET', '/api/portal/coaching/batches', undefined, as(aarav))).body;
    assert.deepEqual(mine.items.map((b) => b.id), [batchA.id]);
    const [a] = mine.items;
    assert.equal(a.lectures, 1);
    assert.equal(a.watched, 0);
    assert.ok(a.subjects >= 2);
    assert.equal(a.live_session_id, null);
    assert.equal(mine.continue_watching, null);
    assert.equal((await call('GET', '/api/portal/coaching/batches', undefined, as(diya))).body.items[0].lectures, 0);
  });

  it('shows a batch’s subjects, and a subject’s lectures and notes', async () => {
    const note = await call('POST', '/api/coaching/materials', { title: 'Kinematics notes', file_url: 'https://drive.example/kin', kind: 'notes', batch_id: batchA.id, subject_id: physics.id });
    assert.equal(note.status, 201, JSON.stringify(note.body));

    const batch = (await call('GET', `/api/portal/coaching/batches/${batchA.id}`, undefined, as(aarav))).body;
    const byName = Object.fromEntries(batch.subjects.map((s) => [s.name, s]));
    assert.equal(byName[physics.name].lectures, 1);
    assert.equal(byName[physics.name].materials, 1);
    assert.equal(byName[chemistry.name].lectures, 0);
    assert.equal(batch.recent.length, 1);
    assert.equal(batch.live, null);

    const subject = (await call('GET', `/api/portal/coaching/batches/${batchA.id}/subjects/${physics.id}`, undefined, as(aarav))).body;
    assert.deepEqual(subject.lectures.map((r) => [r.id, r.number]), [[lectureId, 1]]);
    assert.equal(subject.lectures[0].video_ref, undefined, 'the video itself only comes with the lecture');
    assert.deepEqual(subject.materials.map((m) => m.title), ['Kinematics notes']);
    assert.deepEqual((await call('GET', `/api/portal/coaching/batches/${batchA.id}/subjects/${chemistry.id}`, undefined, as(aarav))).body.materials, []);
  });

  it('keeps other batches and other courses’ subjects out of reach', async () => {
    assert.equal((await call('GET', `/api/portal/coaching/batches/${batchB.id}`, undefined, as(aarav))).status, 404);
    assert.equal((await call('GET', `/api/portal/coaching/batches/${batchA.id}/subjects/${biology.id}`, undefined, as(aarav))).status, 404);
    assert.equal((await call('GET', `/api/portal/coaching/recordings/${lectureId}`, undefined, as(diya))).status, 404);
    assert.equal((await call('PUT', `/api/portal/coaching/recordings/${lectureId}/progress`, { position_sec: 5 }, as(diya))).status, 404);
  });

  it('plays a lecture from where the student left it, and ticks it off near the end', async () => {
    const lecture = (await call('GET', `/api/portal/coaching/recordings/${lectureId}`, undefined, as(aarav))).body;
    assert.equal(lecture.play_url, 'https://www.youtube.com/watch?v=abcDEF12345');
    assert.equal(lecture.number, 1);
    assert.equal(lecture.position_sec, 0);
    assert.equal(lecture.next, null);
    assert.deepEqual(lecture.notes, []);
    assert.deepEqual(lecture.chapters, [], 'no topics were marked in that class');

    const part = await call('PUT', `/api/portal/coaching/recordings/${lectureId}/progress`, { position_sec: 120, duration_sec: 3000 }, as(aarav));
    assert.equal(part.status, 200, JSON.stringify(part.body));
    assert.equal(part.body.completed, 0);
    let mine = (await call('GET', '/api/portal/coaching/batches', undefined, as(aarav))).body;
    assert.equal(mine.continue_watching.id, lectureId);
    assert.equal(mine.continue_watching.position_sec, 120);
    assert.equal(mine.continue_watching.duration_sec, 3000, 'the video’s own length, from the player');

    assert.equal((await call('PUT', `/api/portal/coaching/recordings/${lectureId}/progress`, { position_sec: 2750, duration_sec: 3000 }, as(aarav))).body.completed, 1);
    mine = (await call('GET', '/api/portal/coaching/batches', undefined, as(aarav))).body;
    assert.equal(mine.continue_watching, null);
    assert.equal(mine.items[0].watched, 1);
    // Rewatching the start does not take the tick away.
    assert.equal((await call('PUT', `/api/portal/coaching/recordings/${lectureId}/progress`, { position_sec: 10, duration_sec: 3000 }, as(aarav))).body.completed, 1);
  });
});

describe('Recorded lectures, for staff', () => {
  it('adds a lecture recorded elsewhere by its link', async () => {
    const lecture = { batch_id: batchA.id, subject_id: physics.id, title: 'Vectors revision', recorded_on: '2026-01-10' };
    assert.equal((await call('POST', '/api/coaching/recordings', { ...lecture, url: 'https://youtu.be/xyzXYZ98765' }, { useToken: desk.token })).status, 403);
    assert.equal((await call('POST', '/api/coaching/recordings', { ...lecture, subject_id: biology.id, url: 'https://youtu.be/xyzXYZ98765' })).body.details.subject_id, 'mismatch');
    assert.equal((await call('POST', '/api/coaching/recordings', { ...lecture, url: 'javascript:alert(1)' })).status, 400);

    const added = await call('POST', '/api/coaching/recordings', { ...lecture, url: 'https://www.youtube.com/watch?v=xyzXYZ98765', duration_min: 45 });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    assert.equal(added.body.source, 'youtube');
    assert.equal(added.body.duration_sec, 2700);
    assert.equal(added.body.recorded_on, '2026-01-10');
    const file = await call('POST', '/api/coaching/recordings', { ...lecture, title: 'Units and dimensions', url: 'https://cdn.example/units.mp4' });
    assert.equal(file.body.source, 'link');
    assert.equal((await call('GET', `/api/coaching/recordings/${file.body.id}/play`)).body.play_url, 'https://cdn.example/units.mp4');

    // Numbered by when they were taught, not when they were added.
    const subject = (await call('GET', `/api/portal/coaching/batches/${batchA.id}/subjects/${physics.id}`, undefined, as(aarav))).body;
    const numbers = Object.fromEntries(subject.lectures.map((r) => [r.title, r.number]));
    assert.equal(numbers[`${physics.name} lecture`], 3);
    assert.ok(numbers['Vectors revision'] <= 2 && numbers['Units and dimensions'] <= 2);
  });

  it('files the next live class in the chapter the last one was put in', async () => {
    const edited = await call('PATCH', `/api/coaching/recordings/${lectureId}`, { chapter: 'Kinematics', title: 'Projectile motion' });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.chapter, 'Kinematics');
    assert.equal((await call('PATCH', `/api/coaching/recordings/${lectureId}`, { subject_id: biology.id })).status, 400);
    assert.equal((await call('PATCH', `/api/coaching/recordings/${lectureId}`, { title: '' })).status, 400);

    const next = filedFor(await teach({ batch_id: batchA.id, subject_id: physics.id, stream_url: 'https://youtu.be/nextLEC4567' }));
    assert.equal(next.chapter, 'Kinematics');

    const lecture = (await call('GET', `/api/portal/coaching/recordings/${lectureId}`, undefined, as(aarav))).body;
    assert.equal(lecture.next.id, next.id, 'up next is the following lecture of the subject');
  });

  it('hides a lecture from students, and deletes one', async () => {
    assert.equal((await call('PATCH', `/api/coaching/recordings/${lectureId}`, { published: false })).body.published, 0);
    const subject = (await call('GET', `/api/portal/coaching/batches/${batchA.id}/subjects/${physics.id}`, undefined, as(aarav))).body;
    assert.ok(!subject.lectures.some((r) => r.id === lectureId));
    assert.equal((await call('GET', `/api/portal/coaching/recordings/${lectureId}`, undefined, as(aarav))).status, 404);

    const list = (await call('GET', `/api/coaching/recordings?batch_id=${batchA.id}&subject_id=${physics.id}`)).body.items;
    const hidden = list.find((r) => r.id === lectureId);
    assert.equal(hidden.viewers, 1);
    assert.equal(hidden.completed, 1);

    assert.equal((await call('DELETE', `/api/coaching/recordings/${lectureId}`, undefined, { useToken: desk.token })).status, 403);
    assert.equal((await call('DELETE', `/api/coaching/recordings/${lectureId}`)).status, 200);
    assert.equal((await call('DELETE', `/api/coaching/recordings/${lectureId}`)).status, 404);
    assert.equal(inTenant(() => get('SELECT COUNT(*) AS n FROM recording_progress WHERE recording_id = ?', [lectureId])).n, 0);
  });

  it('files lectures and notes with no subject under General', async () => {
    const orphan = filedFor(await teach({ batch_id: batchA.id, subject_id: chemistry.id, stream_url: 'https://youtu.be/orphanLEC12' }));
    inTenant(() => run('UPDATE class_recordings SET subject_id = NULL WHERE id = ?', [orphan.id]));
    const batch = (await call('GET', `/api/portal/coaching/batches/${batchA.id}`, undefined, as(aarav))).body;
    const general = batch.subjects.find((s) => s.id === 0);
    assert.equal(general.name, 'General');
    assert.equal(general.lectures, 1);
    const subject = (await call('GET', `/api/portal/coaching/batches/${batchA.id}/subjects/0`, undefined, as(aarav))).body;
    assert.deepEqual(subject.lectures.map((r) => r.id), [orphan.id]);
  });
});
