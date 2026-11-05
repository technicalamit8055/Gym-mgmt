import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gymbook-youtube-test-'));
process.env.DB_FILE = path.join(tmpDir, 'default.db');
process.env.PLATFORM_DB_FILE = path.join(tmpDir, 'platform.db');
process.env.TENANTS_DIR = path.join(tmpDir, 'tenants');
process.env.AUTH_SECRET = 'test-secret';
process.env.YOUTUBE_CLIENT_ID = 'client-123.apps.googleusercontent.com';
process.env.YOUTUBE_CLIENT_SECRET = 'client-secret';

const { createApp } = await import('../src/app.js');
const { closeDb, get, tenantStorage } = await import('../src/db.js');
const { closeRegistryDb, tenantDbPath } = await import('../src/tenants.js');
const { today } = await import('../src/validate.js');
const { config } = await import('../src/config.js');
const { weekdayOf } = await import('../src/coaching/attendance.js');
const { YOUTUBE_SCOPE, setYoutubeTransport, youtubeIdle } = await import('../src/coaching/youtube.js');

let root;
let server;
let admin;
const SLUG = 'vidya-youtube';
const CHANNEL = 'UCabcdefghijklmnopqrstuv';

/* ── A fake Google ───────────────────────────────────────────────────── */

const google = {
  calls: [],
  revoked: false,
  broadcasts: new Map(), // id -> { lifeCycleStatus, boundStreamId, body }
  streams: 0,
  nextBroadcast: 0,
  reset() {
    this.calls = [];
  },
  named(pattern) {
    return this.calls.filter((c) => pattern.test(`${c.method} ${c.path}`));
  },
};

const reply = (status, body) => ({ status, text: async () => (body === undefined ? '' : JSON.stringify(body)) });

async function fakeGoogle(url, init = {}) {
  const u = new URL(url);
  const method = init.method || 'GET';
  const form = typeof init.body === 'string' && init.headers?.['Content-Type']?.includes('urlencoded') ? Object.fromEntries(new URLSearchParams(init.body)) : null;
  const json = typeof init.body === 'string' && !form ? JSON.parse(init.body) : null;
  const auth = init.headers?.Authorization ?? null;
  google.calls.push({ method, path: u.pathname, query: Object.fromEntries(u.searchParams), form, json, auth });

  if (u.hostname === 'oauth2.googleapis.com' && u.pathname === '/token') {
    if (form.grant_type === 'authorization_code') {
      if (form.code === 'no-scope') return reply(200, { access_token: 'at-x', refresh_token: 'rt-x', expires_in: 3600, scope: 'openid' });
      if (form.code === 'no-channel') return reply(200, { access_token: 'at-empty', refresh_token: 'rt-x', expires_in: 3600, scope: YOUTUBE_SCOPE });
      return reply(200, { access_token: 'at-1', refresh_token: 'rt-secret-refresh', expires_in: 3600, scope: `${YOUTUBE_SCOPE} openid` });
    }
    if (google.revoked) return reply(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
    return reply(200, { access_token: 'at-2', expires_in: 3600 });
  }
  if (u.pathname === '/revoke') return reply(200, {});

  const api = u.pathname.replace('/youtube/v3', '');
  if (api === '/channels') return reply(200, { items: auth === 'Bearer at-empty' ? [] : [{ id: CHANNEL, snippet: { title: 'Vidya Classes' } }] });
  if (api === '/liveStreams' && method === 'POST') {
    google.streams += 1;
    return reply(200, { id: `stream-${google.streams}`, cdn: { ingestionInfo: { streamName: `key-${google.streams}`, rtmpsIngestionAddress: 'rtmps://a.rtmps.youtube.com:443/live2' } } });
  }
  if (api === '/liveBroadcasts' && method === 'POST') {
    google.nextBroadcast += 1;
    const id = `bcast${google.nextBroadcast}`;
    google.broadcasts.set(id, { lifeCycleStatus: 'ready', boundStreamId: null, body: json });
    return reply(200, { id });
  }
  if (api === '/liveBroadcasts' && method === 'GET') {
    const b = google.broadcasts.get(u.searchParams.get('id'));
    return reply(200, { items: b ? [{ id: u.searchParams.get('id'), status: { lifeCycleStatus: b.lifeCycleStatus }, contentDetails: { boundStreamId: b.boundStreamId } }] : [] });
  }
  if (api === '/liveBroadcasts/bind') {
    google.broadcasts.get(u.searchParams.get('id')).boundStreamId = u.searchParams.get('streamId');
    return reply(200, { id: u.searchParams.get('id') });
  }
  if (api === '/liveBroadcasts/transition') {
    google.broadcasts.get(u.searchParams.get('id')).lifeCycleStatus = u.searchParams.get('broadcastStatus');
    return reply(200, {});
  }
  if (api === '/liveBroadcasts' && method === 'DELETE') {
    google.broadcasts.delete(u.searchParams.get('id'));
    return reply(204);
  }
  return reply(404, { error: { message: `fake Google has no ${method} ${api}` } });
}

/* ── Helpers ─────────────────────────────────────────────────────────── */

const call = async (method, urlPath, body, { useToken = admin, slug = SLUG } = {}) => {
  const res = await fetch(`${root}/g/${slug}${urlPath}`, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(useToken ? { Authorization: `Bearer ${useToken}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const inTenant = (fn) => tenantStorage.run({ slug: SLUG, dbFile: tenantDbPath(SLUG) }, fn);

/** Starts a sign-in and plays Google's redirect back with `params`. */
async function signIn(params) {
  const { body } = await call('POST', '/api/coaching/youtube/connect', {});
  const state = new URL(body.url).searchParams.get('state');
  const res = await fetch(`${root}/api/youtube/callback?${new URLSearchParams({ state, ...params })}`, { redirect: 'manual' });
  return { state, res };
}

let boardToken;
let teacher;
let slotId;
const board = (method, urlPath, body) => call(method, `/api/studio${urlPath}`, body, { useToken: boardToken });

describe('unlisted YouTube classes', () => {
  before(async () => {
    setYoutubeTransport(fakeGoogle);
    server = createApp().listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    root = `http://127.0.0.1:${server.address().port}`;
    const signup = await fetch(`${root}/api/platform/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: SLUG, gym_name: 'Vidya Classes', admin_name: 'Director', admin_email: 'director@vidya-yt.test', admin_password: 'strongpass123', currency: 'INR', business_type: 'coaching' }),
    });
    admin = (await signup.json()).token;

    await call('POST', '/api/staff', { name: 'Prof Verma', email: 'verma@vidya-yt.test', password: 'staffpass123', role: 'trainer' });
    teacher = (await call('POST', '/api/auth/login', { email: 'verma@vidya-yt.test', password: 'staffpass123' }, { useToken: null })).body;
    const course = (await call('GET', '/api/coaching/courses')).body.items[0];
    const batch = (await call('GET', '/api/coaching/batches')).body.items.find((b) => b.code === 'B12A');
    const room = (await call('POST', '/api/coaching/classrooms', { name: batch.room, capacity: 60 })).body;
    slotId = (await call('POST', '/api/coaching/timetable', {
      batch_id: batch.id, subject_id: course.subjects[0].id, faculty_id: teacher.user.id, weekday: weekdayOf(today()), start_time: '09:00', end_time: '10:00', override: true,
    })).body.id;
    const added = await call('POST', '/api/coaching/studio-devices', { name: 'Room 101 smartboard', classroom_id: room.id });
    boardToken = (await call('POST', '/api/studio/pair', { code: added.body.pairing.code }, { useToken: null })).body.token;
  });

  after(() => {
    server.close();
    closeDb();
    closeRegistryDb();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('is for managers, and says when this server has no Google app', async () => {
    assert.equal((await call('GET', '/api/coaching/youtube', undefined, { useToken: teacher.token })).status, 403);
    assert.equal((await call('POST', '/api/coaching/youtube/connect', {}, { useToken: teacher.token })).status, 403);
    const saved = config.youtube.clientId;
    config.youtube.clientId = '';
    try {
      assert.equal((await call('GET', '/api/coaching/youtube')).body.configured, false);
      const refused = await call('POST', '/api/coaching/youtube/connect', {});
      assert.equal(refused.status, 409);
      assert.equal(refused.body.details.code, 'youtube_not_configured');
    } finally {
      config.youtube.clientId = saved;
    }
    const status = (await call('GET', '/api/coaching/youtube')).body;
    assert.deepEqual([status.configured, status.connected], [true, false]);
  });

  it('sends the manager to Google with a one-time state, kept only as a hash', async () => {
    const { body } = await call('POST', '/api/coaching/youtube/connect', {});
    const url = new URL(body.url);
    assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(url.searchParams.get('client_id'), config.youtube.clientId);
    assert.equal(url.searchParams.get('redirect_uri'), config.youtube.redirectUri);
    assert.equal(url.searchParams.get('scope'), YOUTUBE_SCOPE);
    assert.equal(url.searchParams.get('access_type'), 'offline');
    const [slug, nonce] = url.searchParams.get('state').split('.');
    assert.equal(slug, SLUG);
    const stored = inTenant(() => get('SELECT state_hash FROM youtube_oauth_states WHERE state_hash = ?', [nonce]));
    assert.equal(stored, undefined, 'the nonce itself is never stored');
  });

  it('refuses a callback whose state it did not issue', async () => {
    for (const state of ['nonsense', `${SLUG}.${'x'.repeat(32)}`, `no-such-institute.${'x'.repeat(32)}`]) {
      const res = await fetch(`${root}/api/youtube/callback?state=${state}&code=good`, { redirect: 'manual' });
      assert.equal(res.status, 400, state);
    }
    assert.equal((await call('GET', '/api/coaching/youtube')).body.connected, false);
  });

  it('comes back explaining a refusal, a missing permission or a missing channel, and saves nothing', async () => {
    const back = (outcome) => `${root}/g/${SLUG}/?youtube=${outcome}#/smartboards`;
    assert.equal((await signIn({ error: 'access_denied' })).res.headers.get('location'), back('denied'));
    assert.equal((await signIn({ code: 'no-scope' })).res.headers.get('location'), back('scope'));
    assert.equal((await signIn({ code: 'no-channel' })).res.headers.get('location'), back('no_channel'));
    assert.equal((await call('GET', '/api/coaching/youtube')).body.connected, false);
  });

  it('connects the channel, sealing the refresh token, and the state cannot be replayed', async () => {
    const { state, res } = await signIn({ code: 'good' });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), `${root}/g/${SLUG}/?youtube=connected#/smartboards`);
    const exchange = google.named(/POST \/token/).pop();
    assert.equal(exchange.form.redirect_uri, config.youtube.redirectUri);

    const status = (await call('GET', '/api/coaching/youtube')).body;
    assert.equal(status.connected, true);
    assert.equal(status.channel_title, 'Vidya Classes');
    assert.equal(status.connected_by_name, 'Director');
    const row = inTenant(() => get('SELECT refresh_token_sealed FROM youtube_connection'));
    assert.ok(!row.refresh_token_sealed.includes('rt-secret-refresh'), 'sealed, not stored in the clear');

    const replay = await fetch(`${root}/api/youtube/callback?state=${state}&code=good`, { redirect: 'manual' });
    assert.equal(replay.status, 400);
  });

  let sessionId;

  it('tells the board, which gets an unlisted broadcast bound to its own reusable stream', async () => {
    assert.deepEqual((await board('GET', '/me')).body.youtube, { connected: true, channel_title: 'Vidya Classes' });
    const live = await board('POST', '/sessions', { slot_id: slotId });
    assert.equal(live.status, 201, JSON.stringify(live.body));
    sessionId = live.body.id;

    google.reset();
    const res = await board('POST', `/sessions/${sessionId}/youtube`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.output, 'rtmps://a.rtmps.youtube.com:443/live2/key-1');
    assert.equal(res.body.stream_key, 'key-1');
    assert.equal(res.body.stream_url, 'https://www.youtube.com/watch?v=bcast1');

    const created = google.broadcasts.get('bcast1').body;
    assert.equal(created.status.privacyStatus, 'unlisted');
    assert.equal(created.contentDetails.enableAutoStart, true);
    assert.equal(created.contentDetails.enableEmbed, true);
    assert.match(created.snippet.title, /Batch|·/);
    assert.equal(google.broadcasts.get('bcast1').boundStreamId, 'stream-1');
    assert.equal(google.named(/POST \/token/).length, 0, 'the access token from sign-in is reused');

    const session = await board('GET', `/sessions/${sessionId}`);
    assert.equal(session.body.stream_url, 'https://www.youtube.com/watch?v=bcast1', 'students get the unlisted watch link');
    const stored = inTenant(() => get('SELECT youtube_ingest_sealed FROM studio_devices'));
    assert.ok(!stored.youtube_ingest_sealed.includes('key-1'), 'the stream key is sealed too');
  });

  it('reuses the broadcast on a restart, and makes a new one once YouTube has ended it', async () => {
    google.reset();
    const again = await board('POST', `/sessions/${sessionId}/youtube`);
    assert.equal(again.body.stream_url, 'https://www.youtube.com/watch?v=bcast1');
    assert.equal(google.named(/POST \/youtube\/v3\/liveBroadcasts$/).length, 0, 'no new broadcast');
    assert.equal(google.named(/bind/).length, 0, 'still bound to this board');
    assert.equal(google.named(/liveStreams/).length, 0, 'the board keeps its stream');

    google.broadcasts.get('bcast1').lifeCycleStatus = 'complete';
    const fresh = await board('POST', `/sessions/${sessionId}/youtube`);
    assert.equal(fresh.body.stream_url, 'https://www.youtube.com/watch?v=bcast2');
    assert.equal(fresh.body.output, 'rtmps://a.rtmps.youtube.com:443/live2/key-1', 'same stream, same key');
  });

  it('ends a broadcast still on air when the class ends', async () => {
    google.broadcasts.get('bcast2').lifeCycleStatus = 'live';
    assert.equal((await board('PATCH', `/sessions/${sessionId}/end`)).status, 200);
    await youtubeIdle();
    assert.equal(google.broadcasts.get('bcast2').lifeCycleStatus, 'complete');
    assert.equal((await board('POST', `/sessions/${sessionId}/youtube`)).status, 409, 'an ended class gets no broadcast');
    // YouTube keeps it as a video at the same address: the batch's recording.
    const filed = inTenant(() => get('SELECT source, video_ref, status FROM class_recordings WHERE live_session_id = ?', [sessionId]));
    assert.deepEqual({ ...filed }, { source: 'youtube', video_ref: 'bcast2', status: 'ready' });
  });

  it('deletes a broadcast that never went on air', async () => {
    const live = await board('POST', '/sessions', { slot_id: slotId });
    await board('POST', `/sessions/${live.body.id}/youtube`);
    assert.equal(google.broadcasts.get('bcast3').lifeCycleStatus, 'ready');
    await board('PATCH', `/sessions/${live.body.id}/end`);
    await youtubeIdle();
    assert.equal(google.broadcasts.has('bcast3'), false);
    assert.equal(inTenant(() => get('SELECT id FROM class_recordings WHERE live_session_id = ?', [live.body.id])), undefined, 'nothing was recorded, so nothing to rewatch');
  });

  it('marks the connection broken when Google stops accepting it, and the board falls back', async () => {
    const live = await board('POST', '/sessions', { slot_id: slotId });
    google.revoked = true;
    setYoutubeTransport(fakeGoogle); // forgets the cached access token
    const res = await board('POST', `/sessions/${live.body.id}/youtube`);
    assert.equal(res.status, 502);
    assert.equal(res.body.details.reason, 'invalid_grant');
    assert.match(res.body.error, /Connect the channel again/);

    const status = (await call('GET', '/api/coaching/youtube')).body;
    assert.match(status.broken.reason, /Connect the channel again/);
    assert.equal((await board('GET', '/me')).body.youtube.connected, false);
    assert.equal((await board('POST', `/sessions/${live.body.id}/youtube`)).body.details.code, 'youtube_not_connected');
    await board('PATCH', `/sessions/${live.body.id}/end`);
    await youtubeIdle();
  });

  it('reconnecting clears the break; disconnecting revokes the sign-in', async () => {
    google.revoked = false;
    await signIn({ code: 'good' });
    assert.equal((await call('GET', '/api/coaching/youtube')).body.broken, null);

    google.reset();
    const res = await call('DELETE', '/api/coaching/youtube');
    assert.equal(res.body.connected, false);
    assert.equal(google.named(/POST \/revoke/)[0].form.token, 'rt-secret-refresh');
    assert.equal((await board('GET', '/me')).body.youtube.connected, false);
  });
});
