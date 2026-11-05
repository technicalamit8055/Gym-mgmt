import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { memberToken } from './helpers/memberAuth.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-server-recording-test-'));
process.env.DB_FILE = path.join(tmpDir, 'default.db');
process.env.PLATFORM_DB_FILE = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.RECORDINGS_DIR = path.join(tmpDir, 'recordings');
process.env.AUTH_SECRET = 'test-secret';
process.env.PLATFORM_ADMIN_EMAIL = 'ops@coachbook.test';
process.env.PLATFORM_ADMIN_PASSWORD = 'operator-pass-123';
process.env.MAIL_TRANSPORT = 'memory';
delete process.env.PRIVATE_STREAM_BACKEND;

const { createApp } = await import('../src/app.js');
const { closeDb, get, run, tenantStorage } = await import('../src/db.js');
const { closeRegistryDb, tenantDbPath } = await import('../src/tenants.js');
const { today } = await import('../src/validate.js');
const { weekdayOf } = await import('../src/coaching/attendance.js');
const { pruneServerRecordings } = await import('../src/coaching/recordings.js');
const { COACHING_MIGRATIONS } = await import('../src/coaching/schema.js');
const { resetOperatorWarning, setDiskProbe, warnOperatorIfLow } = await import('../src/recordingStorage.js');
const { outbox } = await import('../src/mailer.js');

/** A 100 GB disk with `freeGb` free, as fs.statfs reports it. */
const disk = (freeGb) => () => ({ bsize: 1024 ** 3, blocks: 100, bavail: freeGb });
const realProbe = setDiskProbe(disk(50));

let root;
let server;
let admin;
const SLUG = 'vidya-recording';
const RECORDINGS = path.join(tmpDir, 'recordings', SLUG);

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

/* ── The board's ffmpeg, played by hand ──────────────────────────────── */

const MASTER = [
  '#EXTM3U',
  '#EXT-X-VERSION:6',
  '#EXT-X-STREAM-INF:BANDWIDTH=2525600,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2"',
  'stream_0.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=1205600,RESOLUTION=854x480,CODECS="avc1.4d401f,mp4a.40.2"',
  'stream_1.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=710600,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2"',
  'stream_2.m3u8',
  '',
].join('\n');

/** A live playlist naming segments `from`..`to` (ffmpeg keeps the last six). */
const livePlaylist = (variant, from, to) => [
  '#EXTM3U', '#EXT-X-VERSION:6', '#EXT-X-TARGETDURATION:2', `#EXT-X-MEDIA-SEQUENCE:${from}`,
  ...Array.from({ length: to - from + 1 }, (_, k) => [`#EXTINF:2.000000,`, `stream_${variant}_${String(from + k).padStart(5, '0')}.ts`]).flat(),
  '',
].join('\n');

const put = (url, body) => fetch(url, { method: 'PUT', body });

/** Uploads segments `from`..`to` of every quality, then the playlists, as ffmpeg does. */
async function stream(ingest, from, to, { tag = 'run' } = {}) {
  for (let n = from; n <= to; n += 1) {
    for (const v of [0, 1, 2]) {
      const name = `stream_${v}_${String(n).padStart(5, '0')}.ts`;
      assert.equal((await put(`${ingest}${name}`, `${tag}:${name}`)).status, 201);
    }
    if (n === from) assert.equal((await put(`${ingest}master.m3u8`, MASTER)).status, 201);
    for (const v of [0, 1, 2]) await put(`${ingest}stream_${v}.m3u8`, livePlaylist(v, Math.max(from, n - 5), n));
  }
}

let boardToken;
let slotId;
let pupil;
const board = (method, urlPath, body) => call(method, `/api/studio${urlPath}`, body, { useToken: boardToken });
const activeFor = async (who) => (await call('GET', '/api/portal/coaching/live/active', undefined, { useToken: who.token })).body.items;

describe('recording the private classes this server carries', () => {
  before(async () => {
    server = createApp().listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    root = `http://127.0.0.1:${server.address().port}`;
    const signup = await fetch(`${root}/api/platform/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: SLUG, gym_name: 'Vidya Classes', admin_name: 'Director', admin_email: 'director@vidya-recording.test', admin_password: 'strongpass123', currency: 'INR', business_type: 'coaching' }),
    });
    admin = (await signup.json()).token;

    await call('POST', '/api/staff', { name: 'Prof Verma', email: 'verma@vidya-recording.test', password: 'staffpass123', role: 'trainer' });
    const teacher = (await call('POST', '/api/auth/login', { email: 'verma@vidya-recording.test', password: 'staffpass123' }, { useToken: null })).body;
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

    await call('PUT', '/api/coaching/streaming', { provider: 'private' });
  });

  after(() => {
    setDiskProbe(realProbe);
    server.close();
    closeDb();
    closeRegistryDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('is off until a manager turns it on, and keeps 30 days unless told otherwise', async () => {
    const status = (await call('GET', '/api/coaching/streaming')).body;
    assert.deepEqual([status.private_backend, status.record_classes, status.recording_keep_days], ['selfhosted', false, 30]);

    // Off: a class streamed here leaves nothing behind.
    const live = (await board('POST', '/sessions', { slot_id: slotId })).body;
    const go = (await board('POST', `/sessions/${live.id}/private`)).body;
    await stream(go.hls, 0, 2);
    await board('PATCH', `/sessions/${live.id}/end`);
    assert.equal(inTenant(() => get('SELECT COUNT(*) AS n FROM class_recordings').n), 0);
    assert.equal(fs.existsSync(RECORDINGS), false, 'nothing on disk');

    assert.equal((await call('PUT', '/api/coaching/streaming', { recording_keep_days: 0 })).status, 400);
    const on = (await call('PUT', '/api/coaching/streaming', { record_classes: true, recording_keep_days: 60 })).body;
    assert.deepEqual([on.provider, on.record_classes, on.recording_keep_days], ['private', true, 60], 'the provider is untouched');
  });

  let sessionId;
  let recordingId;

  it('records 480p and 360p as the class streams, across a restart, and files it when the class ends', async () => {
    sessionId = (await board('POST', '/sessions', { slot_id: slotId })).body.id;
    const first = (await board('POST', `/sessions/${sessionId}/private`)).body;
    await stream(first.hls, 0, 3, { tag: 'first' });
    // The board's stream restarts: numbering starts again at 0.
    const second = (await board('POST', `/sessions/${sessionId}/private`)).body;
    await stream(second.hls, 0, 1, { tag: 'second' });
    assert.equal((await board('PATCH', `/sessions/${sessionId}/end`)).status, 200);

    const filed = inTenant(() => get('SELECT * FROM class_recordings WHERE live_session_id = ?', [sessionId]));
    assert.equal(filed.source, 'server');
    assert.equal(filed.status, 'ready');
    assert.equal(filed.video_ref, `session-${sessionId}`);
    assert.equal(filed.duration_sec, 12, 'six two-second segments');
    assert.ok(filed.size_bytes > 0, 'its size is kept, for the operator’s storage card');
    recordingId = filed.id;

    const dir = path.join(RECORDINGS, `session-${sessionId}`);
    const files = fs.readdirSync(dir);
    assert.ok(!files.some((f) => /stream_0_/.test(f)), '720p is not kept');
    assert.ok(!files.some((f) => f.endsWith('.part')), 'the running playlists are finished');
    assert.equal(files.filter((f) => /^r1_stream_1_/.test(f)).length, 4);
    assert.equal(files.filter((f) => /^r2_stream_2_/.test(f)).length, 2);

    const master = fs.readFileSync(path.join(dir, 'master.m3u8'), 'utf8');
    assert.match(master, /RESOLUTION=854x480[^\n]*\nv480\.m3u8\n[^\n]*RESOLUTION=640x360[^\n]*\nv360\.m3u8/);
    assert.doesNotMatch(master, /1280x720/);
    const v480 = fs.readFileSync(path.join(dir, 'v480.m3u8'), 'utf8');
    assert.match(v480, /#EXT-X-PLAYLIST-TYPE:VOD/);
    assert.match(v480, /r1_stream_1_00003\.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:2\.000000,\nr2_stream_1_00000\.ts/, 'the restart is marked');
    assert.match(v480, /#EXT-X-ENDLIST\n$/);
    assert.equal(fs.readFileSync(path.join(dir, 'r2_stream_1_00000.ts'), 'utf8'), 'second:stream_1_00000.ts', 'no clash between runs');
  });

  let link;

  it('plays for the batch’s students on a link of their own', async () => {
    const lecture = (await call('GET', `/api/portal/coaching/recordings/${recordingId}`, undefined, { useToken: pupil.token })).body;
    assert.equal(lecture.private_stream, true, 'the app asks for a fresh link when it runs out');
    link = lecture.play_url;
    assert.match(link, new RegExp(`^${root}/g/${SLUG}/api/recording-hls/${recordingId}\\.${pupil.id}\\.\\d+\\.[\\w-]{43}/master\\.m3u8$`));

    const master = await fetch(link);
    assert.equal(master.status, 200);
    assert.equal(master.headers.get('content-type'), 'application/vnd.apple.mpegurl');
    assert.match(await master.text(), /v480\.m3u8/);
    assert.match(await (await fetch(new URL('v360.m3u8', link))).text(), /#EXT-X-ENDLIST/);
    const segment = await fetch(new URL('r1_stream_2_00001.ts', link));
    assert.equal(segment.status, 200);
    assert.equal(segment.headers.get('content-type'), 'video/mp2t');
    assert.equal(await segment.text(), 'first:stream_2_00001.ts');

    for (const name of ['streams.json', 'runs', '..%2Fmaster.m3u8']) assert.equal((await fetch(new URL(name, link))).status, 404, name);
    const staff = (await call('GET', `/api/coaching/recordings/${recordingId}/play`)).body;
    assert.equal((await fetch(staff.play_url)).status, 200, 'staff can check it too');
  });

  it('refuses a live class’s token, a tampered one, and a hidden recording', async () => {
    const token = new URL(link).pathname.split('/').at(-2);
    const [, member, expires, mac] = token.split('.');
    const play = (t, kind = 'recording-hls') => fetch(`${root}/g/${SLUG}/api/${kind}/${t}/master.m3u8`).then((r) => r.status);
    assert.equal(await play(`${recordingId}.${Number(member) + 1}.${expires}.${mac}`), 404);
    assert.equal(await play(token, 'live-hls'), 404, 'a recording’s token is not a live class’s');

    inTenant(() => run('UPDATE class_recordings SET published = 0 WHERE id = ?', [recordingId]));
    assert.equal(await play(token), 404, 'hidden by staff: stops at once');
    inTenant(() => run('UPDATE class_recordings SET published = 1 WHERE id = ?', [recordingId]));
    assert.equal(await play(token), 200);
  });

  it('deleting it from Recorded lectures deletes the video too', async () => {
    assert.equal((await call('DELETE', `/api/coaching/recordings/${recordingId}`)).status, 200);
    assert.equal(fs.existsSync(path.join(RECORDINGS, `session-${sessionId}`)), false);
    assert.equal((await fetch(link)).status, 404);
  });

  it('deletes recordings past the keep-for days, every hour', async () => {
    const live = (await board('POST', '/sessions', { slot_id: slotId })).body;
    await stream((await board('POST', `/sessions/${live.id}/private`)).body.hls, 0, 1);
    await board('PATCH', `/sessions/${live.id}/end`);
    const dir = path.join(RECORDINGS, `session-${live.id}`);
    assert.ok(fs.existsSync(dir));

    assert.equal(inTenant(() => pruneServerRecordings()), 0, 'fresh: kept');
    assert.equal(inTenant(() => pruneServerRecordings({ now: Date.now() + 59 * 86_400_000 })), 0, 'within 60 days');
    assert.equal(inTenant(() => pruneServerRecordings({ now: Date.now() + 61 * 86_400_000 })), 1);
    assert.equal(fs.existsSync(dir), false);
    assert.equal(inTenant(() => get("SELECT COUNT(*) AS n FROM class_recordings WHERE source = 'server'").n), 0);
  });

  it('does not start recording on a nearly full disk, and says so to managers', async () => {
    setDiskProbe(disk(5)); // 5% free
    assert.equal((await call('GET', '/api/coaching/streaming')).body.recording_paused, true);
    const live = (await board('POST', '/sessions', { slot_id: slotId })).body;
    await stream((await board('POST', `/sessions/${live.id}/private`)).body.hls, 0, 2);
    assert.equal((await activeFor(pupil))[0].private_stream, true, 'the class still streams live');
    await board('PATCH', `/sessions/${live.id}/end`);
    assert.equal(inTenant(() => get('SELECT COUNT(*) AS n FROM class_recordings WHERE live_session_id = ?', [live.id]).n), 0);
    assert.equal(fs.existsSync(path.join(RECORDINGS, `session-${live.id}`)), false);
    setDiskProbe(disk(50));
    assert.equal((await call('GET', '/api/coaching/streaming')).body.recording_paused, false);
  });

  it('stops a recording when the disk fills mid-class, and still files what it has', async () => {
    const live = (await board('POST', '/sessions', { slot_id: slotId })).body;
    const go = (await board('POST', `/sessions/${live.id}/private`)).body;
    await stream(go.hls, 0, 2);
    setDiskProbe(disk(1)); // 1 GB left: under the 2 GB floor too
    await stream(go.hls, 3, 5);
    setDiskProbe(disk(50));
    await board('PATCH', `/sessions/${live.id}/end`);
    const filed = inTenant(() => get('SELECT duration_sec, size_bytes FROM class_recordings WHERE live_session_id = ?', [live.id]));
    assert.equal(filed.duration_sec, 6, 'the three segments before the disk filled');
  });

  it('shows the operator the disk and whose recordings take the most', async () => {
    const login = await fetch(`${root}/api/platform/admin/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'ops@coachbook.test', password: 'operator-pass-123' }),
    });
    const { token } = await login.json();
    const storage = async () => (await fetch(`${root}/api/platform/admin/storage`, { headers: { Authorization: `Bearer ${token}` } })).json();
    const s = await storage();
    assert.deepEqual([s.disk.state, s.disk.free_pct, s.warn_pct, s.stop_pct], ['ok', 50, 20, 10]);
    const mine = s.institutes.find((i) => i.slug === SLUG);
    assert.equal(mine.recordings, 1);
    assert.ok(mine.bytes > 0 && s.recordings_bytes >= mine.bytes);
    assert.deepEqual([mine.recording_on, mine.keep_days], [true, 60]);
    assert.equal((await fetch(`${root}/api/platform/admin/storage`)).status, 401, 'operators only');

    setDiskProbe(disk(15));
    assert.equal((await storage()).disk.state, 'low');
    setDiskProbe(disk(50));
  });

  it('emails the operator while the disk is low, once a day at most', async () => {
    resetOperatorWarning();
    outbox.length = 0;
    assert.equal(await warnOperatorIfLow(), false, 'plenty of room: nothing');
    setDiskProbe(disk(15));
    assert.equal(await warnOperatorIfLow(), true);
    assert.equal(outbox.at(-1).to, 'ops@coachbook.test');
    assert.match(outbox.at(-1).subject, /getting full/);
    assert.equal(await warnOperatorIfLow(), false, 'not again the same day');
    setDiskProbe(disk(5));
    assert.equal(await warnOperatorIfLow({ now: Date.now() + 25 * 3600_000 }), true, 'a day later, and now full');
    assert.match(outbox.at(-1).subject, /recording paused/);
    setDiskProbe(disk(50));
  });
});


describe('the class_recordings rebuild that allows server recordings', () => {
  it('keeps every recording and every student’s progress', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    for (const t of ['academic_batches', 'academic_subjects', 'users', 'live_sessions', 'members']) db.exec(`CREATE TABLE ${t} (id INTEGER PRIMARY KEY)`);
    db.exec('CREATE TABLE coaching_settings (id INTEGER PRIMARY KEY)');
    db.exec('INSERT INTO academic_batches (id) VALUES (1); INSERT INTO members (id) VALUES (7); INSERT INTO coaching_settings (id) VALUES (1)');
    // The table as it was first made: no 'server'.
    db.exec(`
      CREATE TABLE class_recordings (
        id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id INTEGER NOT NULL REFERENCES academic_batches(id) ON DELETE CASCADE,
        subject_id INTEGER REFERENCES academic_subjects(id) ON DELETE SET NULL, faculty_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        live_session_id INTEGER REFERENCES live_sessions(id) ON DELETE SET NULL, title TEXT NOT NULL, chapter TEXT,
        source TEXT NOT NULL CHECK (source IN ('youtube', 'cloudflare', 'link')), video_ref TEXT,
        status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('processing', 'ready', 'failed')),
        duration_sec INTEGER, recorded_at TEXT NOT NULL, published INTEGER NOT NULL DEFAULT 1, checked_at TEXT,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK (status <> 'ready' OR video_ref IS NOT NULL)
      )`);
    db.exec(`CREATE TABLE recording_progress (
      recording_id INTEGER NOT NULL REFERENCES class_recordings(id) ON DELETE CASCADE,
      member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      position_sec INTEGER NOT NULL DEFAULT 0, completed INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (recording_id, member_id))`);
    db.exec("INSERT INTO class_recordings (id, batch_id, title, source, video_ref, recorded_at) VALUES (5, 1, 'Lecture 1', 'youtube', 'abcdefghijk', '2026-11-01 09:00:00')");
    db.exec('INSERT INTO recording_progress (recording_id, member_id, position_sec) VALUES (5, 7, 600)');

    const migration = COACHING_MIGRATIONS.find((m) => String(m).includes('rebuildRecordingsForServer'));
    migration(db);
    migration(db); // and again, as every start does: a no-op

    assert.deepEqual({ ...db.prepare('SELECT recording_id, member_id, position_sec FROM recording_progress').get() }, { recording_id: 5, member_id: 7, position_sec: 600 });
    assert.equal(db.prepare('SELECT title FROM class_recordings WHERE id = 5').get().title, 'Lecture 1');
    db.exec("INSERT INTO class_recordings (batch_id, title, source, video_ref, recorded_at) VALUES (1, 'Lecture 2', 'server', 'session-9', '2026-11-02 09:00:00')");
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1, 'foreign keys are back on');
    // The cascade still works on the rebuilt table.
    db.exec('DELETE FROM class_recordings WHERE id = 5');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM recording_progress').get().n, 0);
    db.close();
  });
});
