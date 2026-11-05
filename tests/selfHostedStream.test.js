import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { memberToken } from './helpers/memberAuth.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-selfhosted-test-'));
process.env.DB_FILE = path.join(tmpDir, 'default.db');
process.env.PLATFORM_DB_FILE = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.AUTH_SECRET = 'test-secret';
delete process.env.PRIVATE_STREAM_BACKEND;

const { createApp } = await import('../src/app.js');
const { closeDb } = await import('../src/db.js');
const { closeRegistryDb } = await import('../src/tenants.js');
const { today } = await import('../src/validate.js');
const { weekdayOf } = await import('../src/coaching/attendance.js');
const { checkWatchToken, watchToken } = await import('../src/coaching/selfHostedStream.js');

let root;
let server;
let admin;
const SLUG = 'vidya-selfhosted';
const OTHER = 'shiksha-selfhosted';

const call = async (method, urlPath, body, { useToken = admin, slug = SLUG } = {}) => {
  const res = await fetch(`${root}/g/${slug}${urlPath}`, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(useToken ? { Authorization: `Bearer ${useToken}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const signup = async (slug, email) => {
  const res = await fetch(`${root}/api/platform/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, gym_name: 'Vidya Classes', admin_name: 'Director', admin_email: email, admin_password: 'strongpass123', currency: 'INR', business_type: 'coaching' }),
  });
  return (await res.json()).token;
};

/** What the board's ffmpeg does: a PUT of raw bytes, no Authorization header. */
const upload = (url, body, method = 'PUT') => fetch(url, { method, body });
const MASTER = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2525600,RESOLUTION=1280x720\nstream_0.m3u8\n';
const PLAYLIST = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\nstream_0_00000.ts\n';

let boardToken;
let slotId;
let pupil;
const board = (method, urlPath, body) => call(method, `/api/studio${urlPath}`, body, { useToken: boardToken });
const activeFor = async (who) => (await call('GET', '/api/portal/coaching/live/active', undefined, { useToken: who.token })).body.items;

describe('private classes served by CoachBook itself', () => {
  before(async () => {
    server = createApp().listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    root = `http://127.0.0.1:${server.address().port}`;
    admin = await signup(SLUG, 'director@vidya-selfhosted.test');

    await call('POST', '/api/staff', { name: 'Prof Verma', email: 'verma@vidya-selfhosted.test', password: 'staffpass123', role: 'trainer' });
    const teacher = (await call('POST', '/api/auth/login', { email: 'verma@vidya-selfhosted.test', password: 'staffpass123' }, { useToken: null })).body;
    const course = (await call('GET', '/api/coaching/courses')).body.items[0];
    const batch = (await call('GET', '/api/coaching/batches')).body.items.find((b) => b.code === 'B12A');
    const room = (await call('POST', '/api/coaching/classrooms', { name: batch.room, capacity: 60 })).body;
    slotId = (await call('POST', '/api/coaching/timetable', {
      batch_id: batch.id, subject_id: course.subjects[0].id, faculty_id: teacher.user.id, weekday: weekdayOf(today()), start_time: '09:00', end_time: '10:00', override: true,
    })).body.id;
    const added = await call('POST', '/api/coaching/studio-devices', { name: 'Room 101 smartboard', classroom_id: room.id });
    boardToken = (await call('POST', '/api/studio/pair', { code: added.body.pairing.code }, { useToken: null })).body.token;

    const created = await call('POST', '/api/members', { first_name: 'Meera', last_name: 'Sharma', phone: '9800000002' });
    await call('POST', '/api/coaching/enrollments', { member_id: created.body.id, batch_id: batch.id });
    const memberCall = (method, urlPath, body, opts = {}) => call(method, urlPath, body, { useToken: opts.token });
    pupil = { id: created.body.id, token: await memberToken(memberCall, { staffToken: admin, memberId: created.body.id }) };
  });

  after(() => {
    server.close();
    closeDb();
    closeRegistryDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('needs no set-up: private is there to choose on any server', async () => {
    const status = (await call('GET', '/api/coaching/streaming')).body;
    assert.deepEqual([status.provider, status.private_configured, status.private_backend], ['youtube', true, 'selfhosted']);
    assert.equal((await call('PUT', '/api/coaching/streaming', { provider: 'private' })).body.provider, 'private');
    assert.equal((await board('GET', '/me')).body.private_stream.on, true);
  });

  let sessionId;
  let ingest;

  it('gives the board an upload address of its own for the class, on this server', async () => {
    sessionId = (await board('POST', '/sessions', { slot_id: slotId })).body.id;
    const res = await board('POST', `/sessions/${sessionId}/private`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.output, null);
    assert.ok(res.body.hls.startsWith(`${root}/g/${SLUG}/api/studio/hls/`), res.body.hls);
    assert.ok(res.body.hls.endsWith(`/${res.body.stream_key}/`));
    ingest = res.body.hls;
    // Students get their link at once; it plays as soon as the first upload lands.
    assert.equal((await activeFor(pupil))[0].private_stream, true);
    assert.equal((await board('GET', `/sessions/${sessionId}`)).body.stream_url, null, 'no link for the room');
  });

  it('takes the board’s uploads, and only with its token and sane names', async () => {
    assert.equal((await upload(`${ingest}master.m3u8`, MASTER)).status, 201);
    assert.equal((await upload(`${ingest}stream_0.m3u8`, PLAYLIST)).status, 201);
    assert.equal((await upload(`${ingest}stream_0_00000.ts`, Buffer.from('segment-bytes'))).status, 201);
    assert.equal((await upload(`${ingest}stream_0_00000.ts`, undefined, 'DELETE')).status, 204);
    assert.equal((await upload(`${ingest}stream_0_00000.ts`, Buffer.from('segment-bytes'))).status, 201);

    assert.equal((await upload(ingest.replace(/hls\/[^/]+\//, 'hls/wrong-token/') + 'master.m3u8', 'x')).status, 404);
    assert.equal((await upload(`${ingest}evil.html`, '<script>')).status, 404, 'only playlists and segments');
    const otherAdmin = await signup(OTHER, 'director@shiksha-selfhosted.test');
    assert.ok(otherAdmin);
    assert.equal((await upload(ingest.replace(`/g/${SLUG}/`, `/g/${OTHER}/`) + 'master.m3u8', 'x')).status, 404, 'not across institutes');
  });

  let link;

  it('signs the student a link of their own, which plays every playlist and segment', async () => {
    const [mine] = await activeFor(pupil);
    assert.equal(mine.private_stream, true);
    link = mine.stream_url;
    assert.match(link, new RegExp(`^${root}/g/${SLUG}/api/live-hls/${sessionId}\\.${pupil.id}\\.\\d+\\.[\\w-]{43}/master\\.m3u8$`));

    const master = await fetch(link);
    assert.equal(master.status, 200);
    assert.equal(master.headers.get('content-type'), 'application/vnd.apple.mpegurl');
    assert.equal(master.headers.get('cache-control'), 'no-store');
    assert.equal(await master.text(), MASTER);
    // The playlist's relative links resolve under the same token.
    const segment = await fetch(new URL('stream_0_00000.ts', link));
    assert.equal(segment.status, 200);
    assert.equal(segment.headers.get('content-type'), 'video/mp2t');
    assert.equal(await segment.text(), 'segment-bytes');
  });

  it('refuses a forged, tampered, expired or other institute’s link', async () => {
    const token = new URL(link).pathname.split('/').at(-2);
    const [, member, expires, mac] = token.split('.');
    const play = (t, slug = SLUG) => fetch(`${root}/g/${slug}/api/live-hls/${t}/master.m3u8`).then((r) => r.status);
    assert.equal(await play(`${sessionId}.${Number(member) + 1}.${expires}.${mac}`), 404, 'another student');
    assert.equal(await play(`${sessionId}.${member}.${Number(expires) + 9999}.${mac}`), 404, 'a longer life');
    assert.equal(await play('nonsense'), 404);
    assert.equal(await play(token, OTHER), 404, 'another institute');

    const stale = watchToken(SLUG, sessionId, pupil.id, { now: Date.now() - 4 * 3600_000 });
    assert.equal(checkWatchToken(SLUG, stale), null, 'expired');
    assert.equal(await play(stale), 404);
  });

  it('a restarted stream gets a new token, and the old one stops working', async () => {
    const again = await board('POST', `/sessions/${sessionId}/private`);
    assert.notEqual(again.body.hls, ingest);
    assert.equal((await upload(`${ingest}master.m3u8`, MASTER)).status, 404, 'the old upload token is retired');
    assert.equal((await fetch(link)).status, 404, 'the window starts empty');
    assert.equal((await upload(`${again.body.hls}master.m3u8`, MASTER)).status, 201);
    assert.equal((await fetch(link)).status, 200, 'the student’s link still works for the class');
    ingest = again.body.hls;
  });

  it('stops serving the class the moment it ends', async () => {
    assert.equal((await board('PATCH', `/sessions/${sessionId}/end`)).status, 200);
    assert.equal((await fetch(link)).status, 404);
    assert.equal((await upload(`${ingest}master.m3u8`, MASTER)).status, 404);
  });

  it('stops serving it when the board moves the class to YouTube', async () => {
    const live = (await board('POST', '/sessions', { slot_id: slotId })).body;
    const go = (await board('POST', `/sessions/${live.id}/private`)).body;
    await upload(`${go.hls}master.m3u8`, MASTER);
    assert.equal((await activeFor(pupil))[0].private_stream, true);
    await board('PATCH', `/sessions/${live.id}/stream`, { stream_url: 'https://www.youtube.com/watch?v=abcdefghijk' });
    const [now] = await activeFor(pupil);
    assert.equal(now.stream_url, 'https://www.youtube.com/watch?v=abcdefghijk');
    assert.equal(now.private_stream, undefined);
    assert.equal((await upload(`${go.hls}master.m3u8`, MASTER)).status, 404);
    await board('PATCH', `/sessions/${live.id}/end`);
  });
});
