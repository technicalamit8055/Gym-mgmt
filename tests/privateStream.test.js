import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { memberToken } from './helpers/memberAuth.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-private-stream-test-'));
process.env.DB_FILE = path.join(tmpDir, 'default.db');
process.env.PLATFORM_DB_FILE = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.AUTH_SECRET = 'test-secret';

// A signing key of our own, handed over base64-encoded as Cloudflare does.
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.PRIVATE_STREAM_BACKEND = 'cloudflare';
process.env.CLOUDFLARE_ACCOUNT_ID = 'acct-1';
process.env.CLOUDFLARE_STREAM_API_TOKEN = 'cf-token';
process.env.CLOUDFLARE_STREAM_CUSTOMER_CODE = 'abc123';
process.env.CLOUDFLARE_STREAM_KEY_ID = 'key-1';
process.env.CLOUDFLARE_STREAM_KEY_PEM = Buffer.from(privateKey.export({ type: 'pkcs1', format: 'pem' })).toString('base64');

const { createApp } = await import('../src/app.js');
const { closeDb, get, run, tenantStorage } = await import('../src/db.js');
const { closeRegistryDb, tenantDbPath } = await import('../src/tenants.js');
const { today } = await import('../src/validate.js');
const { config } = await import('../src/config.js');
const { weekdayOf } = await import('../src/coaching/attendance.js');
const { setStreamTransport } = await import('../src/coaching/privateStream.js');

let root;
let server;
let admin;
const SLUG = 'vidya-private';

/* ── A fake Cloudflare ───────────────────────────────────────────────── */

const cf = { calls: [], inputs: 0, videos: {} }; // videos: input uid -> its recordings
const reply = (status, body) => ({ status, text: async () => JSON.stringify(body) });

async function fakeCloudflare(url, init = {}) {
  const u = new URL(url);
  cf.calls.push({ method: init.method, path: u.pathname, auth: init.headers?.Authorization, json: init.body ? JSON.parse(init.body) : null });
  if (init.method === 'POST' && u.pathname === '/client/v4/accounts/acct-1/stream/live_inputs') {
    cf.inputs += 1;
    return reply(200, { success: true, result: { uid: `input${cf.inputs}`, rtmps: { url: 'rtmps://live.cloudflare.com:443/live/', streamKey: `secret-key-${cf.inputs}` } } });
  }
  const videos = /^\/client\/v4\/accounts\/acct-1\/stream\/live_inputs\/([^/]+)\/videos$/.exec(u.pathname);
  if (init.method === 'GET' && videos) return reply(200, { success: true, result: cf.videos[videos[1]] ?? [] });
  return reply(404, { success: false, errors: [{ message: 'no such route' }] });
}

/* ── Helpers ─────────────────────────────────────────────────────────── */

const call = async (method, urlPath, body, { useToken = admin } = {}) => {
  const res = await fetch(`${root}/g/${SLUG}${urlPath}`, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(useToken ? { Authorization: `Bearer ${useToken}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const inTenant = (fn) => tenantStorage.run({ slug: SLUG, dbFile: tenantDbPath(SLUG) }, fn);

/** Checks a token as Cloudflare would: our public key, RS256, our key id. */
function verify(token) {
  const [head, body, signature] = token.split('.');
  assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${head}.${body}`), publicKey, Buffer.from(signature, 'base64url')), 'signed with the key');
  return { header: JSON.parse(Buffer.from(head, 'base64url')), claims: JSON.parse(Buffer.from(body, 'base64url')) };
}

let boardToken;
let teacher;
let slotId;
let pupil;
let outsider;
const board = (method, urlPath, body) => call(method, `/api/studio${urlPath}`, body, { useToken: boardToken });

describe('private classes on Cloudflare Stream', () => {
  before(async () => {
    setStreamTransport(fakeCloudflare);
    server = createApp().listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    root = `http://127.0.0.1:${server.address().port}`;
    const signup = await fetch(`${root}/api/platform/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: SLUG, gym_name: 'Vidya Classes', admin_name: 'Director', admin_email: 'director@vidya-private.test', admin_password: 'strongpass123', currency: 'INR', business_type: 'coaching' }),
    });
    admin = (await signup.json()).token;

    await call('POST', '/api/staff', { name: 'Prof Verma', email: 'verma@vidya-private.test', password: 'staffpass123', role: 'trainer' });
    teacher = (await call('POST', '/api/auth/login', { email: 'verma@vidya-private.test', password: 'staffpass123' }, { useToken: null })).body;
    const course = (await call('GET', '/api/coaching/courses')).body.items[0];
    const batches = (await call('GET', '/api/coaching/batches')).body.items;
    const batch = batches.find((b) => b.code === 'B12A');
    const room = (await call('POST', '/api/coaching/classrooms', { name: batch.room, capacity: 60 })).body;
    slotId = (await call('POST', '/api/coaching/timetable', {
      batch_id: batch.id, subject_id: course.subjects[0].id, faculty_id: teacher.user.id, weekday: weekdayOf(today()), start_time: '09:00', end_time: '10:00', override: true,
    })).body.id;
    const added = await call('POST', '/api/coaching/studio-devices', { name: 'Room 101 smartboard', classroom_id: room.id });
    boardToken = (await call('POST', '/api/studio/pair', { code: added.body.pairing.code }, { useToken: null })).body.token;

    const student = async (firstName, batchId) => {
      const created = await call('POST', '/api/members', { first_name: firstName, last_name: 'Sharma', phone: '9800000002' });
      if (batchId) await call('POST', '/api/coaching/enrollments', { member_id: created.body.id, batch_id: batchId });
      const memberCall = (method, urlPath, body, opts = {}) => call(method, urlPath, body, { useToken: opts.token });
      return { token: await memberToken(memberCall, { staffToken: admin, memberId: created.body.id }) };
    };
    pupil = await student('Meera', batch.id);
    outsider = await student('Kabir', null); // in no batch of this class
  });

  after(() => {
    server.close();
    closeDb();
    closeRegistryDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('is a manager’s choice, and only once this server is set up for it', async () => {
    assert.equal((await call('GET', '/api/coaching/streaming', undefined, { useToken: teacher.token })).status, 403);
    const status = (await call('GET', '/api/coaching/streaming')).body;
    assert.deepEqual([status.provider, status.private_configured, status.private_backend], ['youtube', true, 'cloudflare']);
    assert.equal((await board('GET', '/me')).body.private_stream.on, false);

    const saved = config.cloudflareStream.keyId;
    config.cloudflareStream.keyId = '';
    try {
      const refused = await call('PUT', '/api/coaching/streaming', { provider: 'private' });
      assert.equal(refused.status, 409);
      assert.equal(refused.body.details.code, 'private_stream_not_configured');
    } finally {
      config.cloudflareStream.keyId = saved;
    }
    assert.equal((await call('PUT', '/api/coaching/streaming', { provider: 'vimeo' })).status, 400);
    assert.equal((await call('PUT', '/api/coaching/streaming', { provider: 'private' })).body.provider, 'private');
    assert.equal((await board('GET', '/me')).body.private_stream.on, true);
  });

  let sessionId;

  it('gives the board its own signed-only input, reused class after class, the key sealed', async () => {
    const live = await board('POST', '/sessions', { slot_id: slotId });
    assert.equal(live.status, 201, JSON.stringify(live.body));
    sessionId = live.body.id;

    const res = await board('POST', `/sessions/${sessionId}/private`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.output, 'rtmps://live.cloudflare.com:443/live/secret-key-1');
    assert.equal(res.body.stream_key, 'secret-key-1');
    const created = cf.calls.at(-1);
    assert.equal(created.auth, 'Bearer cf-token');
    assert.deepEqual(created.json.recording, { mode: 'automatic', requireSignedURLs: true });

    const stored = inTenant(() => get('SELECT cf_live_input_id, cf_ingest_sealed FROM studio_devices'));
    assert.equal(stored.cf_live_input_id, 'input1');
    assert.ok(!stored.cf_ingest_sealed.includes('secret-key-1'), 'the stream key is sealed');

    assert.equal((await board('POST', `/sessions/${sessionId}/private`)).body.stream_key, 'secret-key-1');
    assert.equal(cf.inputs, 1, 'a restart reuses the input');
    assert.equal((await board('GET', `/sessions/${sessionId}`)).body.stream_url, null, 'no link for the room');
  });

  it('signs each student of the batch their own link, and no one else gets one', async () => {
    const [mine] = (await call('GET', '/api/portal/coaching/live/active', undefined, { useToken: pupil.token })).body.items;
    assert.equal(mine.id, sessionId);
    assert.equal(mine.private_stream, true);
    const url = new URL(mine.stream_url);
    assert.equal(url.host, 'customer-abc123.cloudflarestream.com');
    const [, token, ...rest] = url.pathname.split('/');
    assert.equal(rest.join('/'), 'manifest/video.m3u8');

    const { header, claims } = verify(token);
    assert.deepEqual(header, { alg: 'RS256', kid: 'key-1' });
    assert.equal(claims.sub, 'input1');
    assert.equal(claims.kid, 'key-1');
    const now = Date.now() / 1000;
    assert.ok(claims.exp > now + 3600 && claims.exp <= now + 24 * 3600, 'hours, never past Cloudflare’s 24');

    assert.deepEqual((await call('GET', '/api/portal/coaching/live/active', undefined, { useToken: outsider.token })).body.items, []);
  });

  it('switching back to YouTube stops the board streaming privately', async () => {
    await call('PUT', '/api/coaching/streaming', { provider: 'youtube' });
    assert.equal((await board('GET', '/me')).body.private_stream.on, false);
    const refused = await board('POST', `/sessions/${sessionId}/private`);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.details.code, 'private_stream_off');
    // The board points the class at its YouTube link instead; students follow it.
    await board('PATCH', `/sessions/${sessionId}/stream`, { stream_url: 'https://www.youtube.com/watch?v=abcdefghijk' });
    const [now] = (await call('GET', '/api/portal/coaching/live/active', undefined, { useToken: pupil.token })).body.items;
    assert.equal(now.stream_url, 'https://www.youtube.com/watch?v=abcdefghijk');
    assert.equal(now.private_stream, undefined);
  });

  it('says what went wrong when Cloudflare refuses', async () => {
    await call('PUT', '/api/coaching/streaming', { provider: 'private' });
    const previous = setStreamTransport(async () => reply(403, { success: false, errors: [{ message: 'Authentication error' }] }));
    try {
      // A board with no input yet, so Cloudflare is asked.
      inTenant(() => run('UPDATE studio_devices SET cf_live_input_id = NULL, cf_ingest_sealed = NULL'));
      const res = await board('POST', `/sessions/${sessionId}/private`);
      assert.equal(res.status, 502);
      assert.equal(res.body.details.code, 'private_stream_failed');
      assert.match(res.body.error, /API token/);
    } finally {
      setStreamTransport(previous);
    }
  });

  it('files the class’s recording once Cloudflare has made the video, signed for each student', async () => {
    const res = await board('POST', `/sessions/${sessionId}/private`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const input = inTenant(() => get('SELECT cf_live_input_id FROM live_sessions WHERE id = ?', [sessionId])).cf_live_input_id;
    // The board's earlier connections, before this class, are not this class.
    cf.videos[input] = [
      { uid: 'old-class', created: '2020-01-01T09:00:00Z', readyToStream: true, duration: 3600, status: { state: 'ready' } },
      { uid: 'vid-1', created: new Date().toISOString(), readyToStream: false, duration: -1, status: { state: 'live-inprogress' } },
    ];
    assert.equal((await board('PATCH', `/sessions/${sessionId}/end`)).status, 200);
    const filed = inTenant(() => get('SELECT id, source, status, video_ref FROM class_recordings WHERE live_session_id = ?', [sessionId]));
    assert.equal(filed.source, 'cloudflare');
    assert.equal(filed.status, 'processing');
    assert.equal(filed.video_ref, null);

    // Listed while it processes, but nothing to play yet.
    const batchId = (await call('GET', '/api/portal/coaching/batches', undefined, { useToken: pupil.token })).body.items[0].id;
    const subjectId = inTenant(() => get('SELECT subject_id FROM live_sessions WHERE id = ?', [sessionId])).subject_id;
    const listed = await call('GET', `/api/portal/coaching/batches/${batchId}/subjects/${subjectId}`, undefined, { useToken: pupil.token });
    assert.equal(listed.body.lectures[0].status, 'processing');
    const early = await call('GET', `/api/portal/coaching/recordings/${filed.id}`, undefined, { useToken: pupil.token });
    assert.equal(early.status, 409);
    assert.equal(early.body.details.code, 'recording_processing');

    cf.videos[input][1] = { uid: 'vid-1', created: cf.videos[input][1].created, readyToStream: true, duration: 2710.4, status: { state: 'ready' } };
    const checked = await call('POST', `/api/coaching/recordings/${filed.id}/check`);
    assert.equal(checked.body.status, 'ready');
    assert.equal(checked.body.duration_sec, 2710);

    const lecture = await call('GET', `/api/portal/coaching/recordings/${filed.id}`, undefined, { useToken: pupil.token });
    assert.equal(lecture.status, 200, JSON.stringify(lecture.body));
    assert.equal(lecture.body.private_stream, true);
    const [, token] = new URL(lecture.body.play_url).pathname.split('/');
    assert.equal(verify(token).claims.sub, 'vid-1', 'the recording, not the live input');
    assert.equal((await call('GET', `/api/portal/coaching/recordings/${filed.id}`, undefined, { useToken: outsider.token })).status, 404);
  });
});
