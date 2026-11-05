import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import PDFKit from 'pdfkit';
import { openSocket } from './helpers/liveSocket.js';
import { memberToken } from './helpers/memberAuth.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-studio-test-'));
process.env.DB_FILE = path.join(tmpDir, 'default.db');
process.env.PLATFORM_DB_FILE = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.AUTH_SECRET = 'test-secret';

const { createApp } = await import('../src/app.js');
const { closeDb, get, run, tenantStorage } = await import('../src/db.js');
const { closeRegistryDb, tenantDbPath } = await import('../src/tenants.js');
const { today } = await import('../src/validate.js');
const { config } = await import('../src/config.js');
const { attachLiveGateway } = await import('../src/coaching/liveGateway.js');
const { weekdayOf } = await import('../src/coaching/attendance.js');

let root;
let server;
let gateway;
let admin;
const SLUG = 'vidya-studio';
const OTHER = 'shiksha-studio';

const call = async (method, urlPath, body, { useToken = admin, slug = SLUG, raw = null } = {}) => {
  const res = await fetch(`${root}/g/${slug}${urlPath}`, {
    method,
    headers: {
      ...(raw ? { 'Content-Type': 'application/pdf' } : body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(useToken ? { Authorization: `Bearer ${useToken}` } : {}),
    },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const board = (method, urlPath, body, opts = {}) => call(method, `/api/studio${urlPath}`, body, { useToken: boardToken, ...opts });

const signup = async (slug, email, businessType = 'coaching') => {
  const res = await fetch(`${root}/api/platform/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, gym_name: 'Vidya Classes', admin_name: 'Director', admin_email: email, admin_password: 'strongpass123', currency: 'INR', business_type: businessType }),
  });
  return (await res.json()).token;
};
const inTenant = (fn) => tenantStorage.run({ slug: SLUG, dbFile: tenantDbPath(SLUG) }, fn);
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function staffMember(name, email) {
  assert.equal((await call('POST', '/api/staff', { name, email, password: 'staffpass123', role: 'trainer' })).status, 201);
  const login = await call('POST', '/api/auth/login', { email, password: 'staffpass123' }, { useToken: null });
  return { id: login.body.user.id, token: login.body.token };
}

const notesPdf = () => new Promise((resolve) => {
  const doc = new PDFKit();
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  doc.on('end', () => resolve(Buffer.concat(chunks)));
  doc.text('Note 3 export');
  doc.end();
});

let room101;
let room202;
let batchA; // Room 101
let batchB; // Room 202
let physics;
let chemistry;
let verma;
let rao;
let slotPhysics; // today, Room 101, Verma
let slotNoTeacher; // today, Room 101, nobody
let slotOtherDay; // Room 101, not today
let slotRoom202; // today, Room 202, Rao
let device;
let pairingCode;
let boardToken;
let session;

describe('the classroom smartboard', () => {
  before(async () => {
    server = createApp().listen(0);
    gateway = attachLiveGateway(server);
    await new Promise((resolve) => server.once('listening', resolve));
    root = `http://127.0.0.1:${server.address().port}`;
    admin = await signup(SLUG, 'director@vidya-studio.test');

    const course = (await call('GET', '/api/coaching/courses')).body.items[0];
    [physics, chemistry] = course.subjects;
    batchA = (await call('GET', '/api/coaching/batches')).body.items.find((b) => b.code === 'B12A');
    assert.equal(batchA.room, 'Room 101');
    batchB = (await call('POST', '/api/coaching/batches', { course_id: course.id, name: 'Batch 12-B', code: 'B12B', start_date: today(), room: 'Room 202' })).body;
    room101 = (await call('POST', '/api/coaching/classrooms', { name: 'room 101', capacity: 60 })).body;
    room202 = (await call('POST', '/api/coaching/classrooms', { name: 'Room 202', capacity: 60 })).body;
    verma = await staffMember('Prof Verma', 'verma@vidya-studio.test');
    rao = await staffMember('Prof Rao', 'rao@vidya-studio.test');

    const weekday = weekdayOf(today());
    const slot = async (body) => {
      const res = await call('POST', '/api/coaching/timetable', { ...body, override: true });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      return res.body.id;
    };
    slotPhysics = await slot({ batch_id: batchA.id, subject_id: physics.id, faculty_id: verma.id, weekday, start_time: '09:00', end_time: '10:00' });
    slotNoTeacher = await slot({ batch_id: batchA.id, subject_id: chemistry.id, weekday, start_time: '10:00', end_time: '11:00' });
    slotOtherDay = await slot({ batch_id: batchA.id, subject_id: physics.id, faculty_id: verma.id, weekday: (weekday + 1) % 7, start_time: '09:00', end_time: '10:00' });
    slotRoom202 = await slot({ batch_id: batchB.id, subject_id: chemistry.id, faculty_id: rao.id, weekday, start_time: '09:00', end_time: '10:00' });
  });

  after(() => {
    gateway.close();
    server.close();
    closeDb();
    closeRegistryDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('is registered by a manager, who sees the pairing code once', async () => {
    assert.equal((await call('POST', '/api/coaching/studio-devices', { name: 'Board', classroom_id: room101.id }, { useToken: verma.token })).status, 403);
    assert.equal((await call('POST', '/api/coaching/studio-devices', { name: 'Board', classroom_id: 9999 })).status, 404);
    const res = await call('POST', '/api/coaching/studio-devices', { name: 'Room 101 smartboard', classroom_id: room101.id });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    device = res.body.device;
    pairingCode = res.body.pairing.code;
    assert.match(pairingCode, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    assert.equal(device.paired, 0);
    const list = await call('GET', '/api/coaching/studio-devices');
    assert.equal(list.body.items[0].pairing_code_hash, undefined);
    assert.equal(list.body.items[0].weekly_lectures, 3, 'every day’s lectures in Room 101, the batch’s room matched loosely');
    const stored = inTenant(() => get('SELECT pairing_code_hash FROM studio_devices WHERE id = ?', [device.id]));
    assert.equal(stored.pairing_code_hash, sha256(pairingCode.replace('-', '')), 'only a hash of the code is kept');
  });

  it('trades the code for its device token once, keeping only a hash of the token', async () => {
    const typed = pairingCode.toLowerCase().replace('-', ' ');
    const res = await call('POST', '/api/studio/pair', { code: typed }, { useToken: null });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    boardToken = res.body.token;
    assert.match(boardToken, /^cbs_[\w-]{43}$/);
    assert.equal(res.body.device.classroom_name, 'room 101');
    assert.equal(res.body.institute, 'Vidya Classes');
    assert.equal((await call('POST', '/api/studio/pair', { code: pairingCode }, { useToken: null })).status, 401, 'a code works once');
    const stored = inTenant(() => get('SELECT token_hash, pairing_code_hash FROM studio_devices WHERE id = ?', [device.id]));
    assert.deepEqual({ ...stored }, { token_hash: sha256(boardToken), pairing_code_hash: null });
    const me = await board('GET', '/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.device.name, 'Room 101 smartboard');
    assert.equal(me.body.socket_path, '/ws/live');
  });

  it('refuses a code past its fifteen minutes', async () => {
    const extra = await call('POST', '/api/coaching/studio-devices', { name: 'Spare board', classroom_id: room202.id });
    inTenant(() => run("UPDATE studio_devices SET pairing_expires_at = datetime('now', '-1 minute') WHERE id = ?", [extra.body.device.id]));
    assert.equal((await call('POST', '/api/studio/pair', { code: extra.body.pairing.code }, { useToken: null })).status, 401);
    await call('DELETE', `/api/coaching/studio-devices/${extra.body.device.id}`);
  });

  it('sees only today’s lectures in its own room', async () => {
    const res = await board('GET', '/lectures');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.items.map((l) => l.slot_id), [slotPhysics, slotNoTeacher], 'not Room 202, not another day');
    assert.equal(res.body.items[0].faculty_name, 'Prof Verma');
    assert.equal(res.body.items[0].live_session_id, null);
    assert.ok(!res.body.items.some((l) => l.slot_id === slotOtherDay || l.slot_id === slotRoom202));
  });

  it('goes live for a lecture in its room, as the timetabled teacher', async () => {
    assert.equal((await board('POST', '/sessions', { slot_id: slotRoom202 })).status, 404, 'another room’s lecture');
    assert.equal((await board('POST', '/sessions', { slot_id: slotOtherDay })).status, 404, 'not today');
    const nobody = await board('POST', '/sessions', { slot_id: slotNoTeacher });
    assert.equal(nobody.status, 409);
    assert.equal(nobody.body.details.code, 'no_teacher');

    const res = await board('POST', '/sessions', { slot_id: slotPhysics, title: 'Rotational motion' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    session = res.body;
    assert.equal(session.faculty_id, verma.id);
    assert.equal(session.status, 'live');
    const row = inTenant(() => get('SELECT studio_device_id, created_by FROM live_sessions WHERE id = ?', [session.id]));
    assert.deepEqual({ ...row }, { studio_device_id: device.id, created_by: null });
    assert.equal((await board('GET', '/lectures')).body.items[0].live_session_id, session.id);
  });

  it('runs the class’s polls on the socket as its teacher', async () => {
    const ticket = await board('POST', `/sessions/${session.id}/socket-ticket`);
    assert.equal(ticket.status, 200);
    const socket = await openSocket(root, ticket.body);
    const joined = await socket.next('room:joined');
    assert.equal(joined.role, 'teacher');
    const poll = await socket.request('teacher:create_poll', { correct_option: 'B', duration_sec: 30 });
    assert.equal(poll.ok, true, JSON.stringify(poll));
    assert.equal((await socket.request('poll:end', { poll_id: poll.data.poll_id })).ok, true);
    assert.equal(inTenant(() => get('SELECT created_by FROM live_polls WHERE id = ?', [poll.data.poll_id])).created_by, verma.id, 'on the teacher’s name');
    socket.close();
  });

  it('attaches its YouTube broadcast to the class, switching viewers over at once', async () => {
    const socket = await openSocket(root, (await board('POST', `/sessions/${session.id}/socket-ticket`)).body);
    await socket.next('room:joined');
    const live = 'https://www.youtube.com/embed/live_stream?channel=UCabcdefghijklmnopqrstuv';
    const res = await board('PATCH', `/sessions/${session.id}/stream`, { stream_url: live });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.stream_url, live);
    assert.deepEqual(await socket.next('session:stream'), { stream_url: live });
    assert.equal((await board('PATCH', `/sessions/${session.id}/stream`, { stream_url: 'javascript:alert(1)' })).status, 400);
    socket.close();
  });

  it('marks the next topic, for chapters on the class’s recording', async () => {
    // A broadcast YouTube keeps as a video, so the class files a recording when it ends.
    assert.equal((await board('PATCH', `/sessions/${session.id}/stream`, { stream_url: 'https://youtu.be/abcDEF12345' })).status, 200);
    const first = await board('POST', `/sessions/${session.id}/markers`, { offset_sec: 0, label: '  Torque  ' });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.marker.label, 'Torque');
    const oops = await board('POST', `/sessions/${session.id}/markers`, { offset_sec: 300 });
    assert.equal(oops.body.marker.label, 'Topic 2', 'unnamed: the next topic number');
    await board('POST', `/sessions/${session.id}/markers`, { offset_sec: 1250, label: 'Moment of inertia' });
    assert.equal((await board('DELETE', `/sessions/${session.id}/markers/${oops.body.marker.id}`)).status, 200);
    const list = await board('GET', `/sessions/${session.id}/markers`);
    assert.deepEqual(list.body.items.map((m) => [m.offset_sec, m.label]), [[0, 'Torque'], [1250, 'Moment of inertia']]);
    assert.equal((await board('POST', `/sessions/${session.id}/markers`, { offset_sec: -5 })).status, 400);
  });

  it('ends the class and publishes Note 3’s export as its notes', async () => {
    const ended = await board('PATCH', `/sessions/${session.id}/end`);
    assert.equal(ended.status, 200);
    assert.equal(ended.body.status, 'ended');
    const published = await board('POST', `/sessions/${session.id}/publish-notes`, undefined, { raw: await notesPdf() });
    assert.equal(published.status, 201, JSON.stringify(published.body));
    assert.equal(published.body.material.uploaded_by, verma.id);
    assert.equal(published.body.material.live_session_id, session.id);
    assert.equal((await board('POST', `/sessions/${session.id}/socket-ticket`)).status, 409, 'no socket for a class that is over');
    assert.equal((await board('POST', `/sessions/${session.id}/markers`, { offset_sec: 10 })).status, 409, 'no markers once it is over');

    const filed = inTenant(() => get('SELECT id FROM class_recordings WHERE live_session_id = ?', [session.id]));
    const played = await call('GET', `/api/coaching/recordings/${filed.id}/play`);
    assert.deepEqual(played.body.chapters, [{ offset_sec: 0, label: 'Torque' }, { offset_sec: 1250, label: 'Moment of inertia' }]);
  });

  it('can take over a class its room’s teacher started from their phone — and nothing from another room', async () => {
    const phone = await call('POST', '/api/coaching/live/sessions', { batch_id: batchA.id, subject_id: physics.id }, { useToken: verma.token });
    assert.equal(phone.status, 201);
    const clash = await board('POST', '/sessions', { slot_id: slotPhysics });
    assert.equal(clash.status, 409);
    assert.equal(clash.body.details.code, 'batch_already_live');
    assert.equal(clash.body.details.session_id, phone.body.id, 'the 409 names the class to join');
    assert.equal((await board('GET', `/sessions/${phone.body.id}`)).status, 200);

    const elsewhere = await call('POST', '/api/coaching/live/sessions', { batch_id: batchB.id, subject_id: chemistry.id }, { useToken: rao.token });
    assert.equal(elsewhere.status, 201);
    for (const [method, url, raw] of [
      ['GET', `/sessions/${elsewhere.body.id}`],
      ['POST', `/sessions/${elsewhere.body.id}/socket-ticket`],
      ['PATCH', `/sessions/${elsewhere.body.id}/end`],
      ['POST', `/sessions/${elsewhere.body.id}/publish-notes`, await notesPdf()],
    ]) assert.equal((await board(method, url, undefined, { raw })).status, 404, `${method} ${url}`);
    assert.equal((await board('PATCH', `/sessions/${phone.body.id}/end`)).status, 200);
  });

  it('keeps a board’s token and a person’s token apart', async () => {
    assert.equal((await call('GET', '/api/coaching/studio-devices', undefined, { useToken: boardToken })).status, 401);
    assert.equal((await call('GET', '/api/coaching/live/active', undefined, { useToken: boardToken })).status, 401);
    assert.equal((await board('GET', '/me', undefined, { useToken: admin })).status, 401);
    assert.equal((await board('GET', '/me', undefined, { useToken: verma.token })).status, 401);
    const member = await call('POST', '/api/members', { first_name: 'Aarav', phone: '9800000007' });
    const memberCall = (method, urlPath, body, opts = {}) => call(method, urlPath, body, { useToken: opts.token });
    const studentToken = await memberToken(memberCall, { staffToken: admin, memberId: member.body.id });
    assert.equal((await board('GET', '/me', undefined, { useToken: studentToken })).status, 401);
    assert.equal((await board('GET', '/me', undefined, { useToken: null })).status, 401);
    assert.equal((await board('GET', '/me', undefined, { useToken: 'cbs_made-up' })).status, 401);

    await signup(OTHER, 'director@shiksha-studio.test');
    assert.equal((await board('GET', '/me', undefined, { slug: OTHER })).status, 401, 'one institute’s board means nothing to another');
  });

  it('is cut off by a new pairing code, and by being removed', async () => {
    const repaired = await call('POST', `/api/coaching/studio-devices/${device.id}/pairing-code`);
    assert.equal(repaired.status, 200);
    assert.equal(repaired.body.device.paired, 0);
    assert.equal((await board('GET', '/me')).status, 401, 'the old token is dead');
    const again = await call('POST', '/api/studio/pair', { code: repaired.body.pairing.code }, { useToken: null });
    boardToken = again.body.token;
    assert.equal((await board('GET', '/me')).status, 200);

    assert.equal((await call('DELETE', `/api/coaching/studio-devices/${device.id}`)).status, 200);
    assert.equal((await board('GET', '/me')).status, 401);
    const history = inTenant(() => get('SELECT studio_device_id FROM live_sessions WHERE id = ?', [session.id]));
    assert.equal(history.studio_device_id, null, 'its classes stay, unlinked');
  });

  it('locks out a run of wrong pairing codes', async () => {
    let last;
    for (let i = 0; i <= config.loginMaxAttempts; i += 1) {
      last = await call('POST', '/api/studio/pair', { code: `WRNG-${String(i).padStart(4, 'X')}` }, { useToken: null });
    }
    assert.equal(last.status, 429);
  });

  it('is not part of a gym account', async () => {
    await signup('iron-studio', 'owner@iron-studio.test', 'gym');
    const res = await call('POST', '/api/studio/pair', { code: 'ABCD-EFGH' }, { useToken: null, slug: 'iron-studio' });
    assert.equal(res.status, 404);
    assert.equal(res.body.details.code, 'module_not_enabled');
  });
});
