import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { createController } from '../src/controller.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-controller-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const json = (status, body) => ({ ok: status < 400, status, json: async () => body });

/** A controller over in-memory settings and key, against a scripted CoachBook. */
function setup({ routes = {}, settings: initial = {}, token = null, installed = false } = {}) {
  let settings = { ...initial };
  let stored = token;
  let key = null;
  const streams = [];
  const requests = [];
  const fetchImpl = async (url, init) => {
    const key = `${init.method} ${new URL(url).pathname.replace(/^.*\/api\/studio/, '')}`;
    requests.push({ key, init });
    const respond = routes[key];
    return respond ? respond(init) : json(404, { error: 'No such endpoint' });
  };
  const controller = createController({
    settings: { get: () => settings, save: (patch) => { settings = { ...settings, ...patch }; } },
    tokens: { available: () => true, save: (t) => { stored = t; }, load: () => stored, clear: () => { stored = null; } },
    files: { size: (f) => fs.statSync(f).size, read: (f) => fs.readFileSync(f) },
    pickFolder: async () => null,
    pickPdf: async () => null,
    resize: (mode, width, height) => ({ side: 'right', mode, width, height }),
    quit: () => {},
    streamKey: { save: (k) => { key = k; }, load: () => key, clear: () => { key = null; } },
    streamer: { start: (o) => streams.push(['start', o]), stop: () => streams.push(['stop']) },
    startup: {
      available: () => installed,
      get: () => settings.startAtLogin !== false,
      set: (on) => { settings = { ...settings, startAtLogin: on }; },
    },
    fetchImpl,
  });
  return { controller, requests, settings: () => settings, stored: () => stored, streamKey: () => key, streams };
}

describe('the board’s controller', () => {
  it('pairs: keeps the token sealed away and remembers the institute', async () => {
    const t = setup({
      routes: {
        'POST /pair': () => json(200, { token: 'cbs_new', device: { name: 'Board' }, institute: 'Apex' }),
        'GET /me': (init) => json(init.headers.Authorization === 'Bearer cbs_new' ? 200 : 401, { device: { name: 'Board' }, institute: 'Apex' }),
      },
    });
    const res = await t.controller.pair({ serverUrl: 'https://coachbook.in/g/apex/', code: 'abcd-efgh' });
    assert.equal(res.ok, true);
    assert.equal(res.data.paired, true);
    assert.equal(t.stored(), 'cbs_new');
    assert.equal(t.settings().serverUrl, 'https://coachbook.in/g/apex');
    assert.equal(JSON.stringify(res).includes('cbs_new'), false, 'the token never goes back to the page');
  });

  it('starts with Windows once installed, until it is turned off', async () => {
    const installed = setup({ installed: true });
    assert.equal((await installed.controller.status()).data.startAtLogin, true);
    const off = await installed.controller.setStartAtLogin({ on: false });
    assert.deepEqual(off.data, { startAtLogin: false });
    assert.equal(installed.settings().startAtLogin, false);
    assert.equal((await installed.controller.status()).data.startAtLogin, false);

    const fromSource = setup();
    assert.equal((await fromSource.controller.status()).data.startAtLogin, null);
    assert.equal((await fromSource.controller.setStartAtLogin({ on: true })).ok, false);
    assert.equal(fromSource.settings().startAtLogin, undefined);
  });

  it('forgets a key CoachBook no longer accepts', async () => {
    const t = setup({ settings: { serverUrl: 'https://x.in' }, token: 'cbs_old', routes: { 'GET /me': () => json(401, { error: 'not paired' }) } });
    const res = await t.controller.status();
    assert.equal(res.data.paired, false);
    assert.match(res.data.notice, /unpaired/);
    assert.equal(t.stored(), null);
  });

  it('joins the class instead when the batch is already live', async () => {
    const t = setup({
      settings: { serverUrl: 'https://x.in' },
      token: 'cbs_t',
      routes: {
        'POST /sessions': () => json(409, { error: 'already live', details: { code: 'batch_already_live', session_id: 12 } }),
        'GET /sessions/12': () => json(200, { id: 12, status: 'live' }),
      },
    });
    const res = await t.controller.goLive({ slotId: 3 });
    assert.deepEqual(res.data, { id: 12, status: 'live' });
  });

  it('builds the socket address from the institute’s origin and a one-time ticket', async () => {
    const t = setup({ settings: { serverUrl: 'https://coachbook.in/g/apex' }, token: 'cbs_t', routes: { 'POST /sessions/5/socket-ticket': () => json(200, { ticket: 'a+b/c', path: '/ws/live' }) } });
    const res = await t.controller.socketUrl({ sessionId: 5 });
    assert.equal(res.data.url, 'wss://coachbook.in/ws/live?ticket=a%2Bb%2Fc');
  });

  it('treats a class already ended elsewhere as ended', async () => {
    const t = setup({ settings: { serverUrl: 'https://x.in' }, token: 'cbs_t', routes: { 'PATCH /sessions/5/end': () => json(409, { error: 'This class has already ended' }) } });
    assert.deepEqual(await t.controller.endClass({ sessionId: 5 }), { ok: true, data: null });
  });

  it('uploads only a PDF it found or the teacher picked', async () => {
    const exportsDir = path.join(dir, 'exports');
    fs.mkdirSync(exportsDir);
    const notes = path.join(exportsDir, 'class.pdf');
    fs.writeFileSync(notes, '%PDF-1.4 notes');
    const secret = path.join(dir, 'secret.pdf');
    fs.writeFileSync(secret, '%PDF-1.4 not for upload');
    const t = setup({
      settings: { serverUrl: 'https://x.in', notesDir: exportsDir },
      token: 'cbs_t',
      routes: { 'POST /sessions/5/publish-notes': (init) => json(201, { size: init.body.length }) },
    });

    const refused = await t.controller.publishNotes({ sessionId: 5, file: secret });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /not offered/);
    assert.equal(t.requests.length, 0, 'nothing was sent');

    const found = await t.controller.findNotes({ since: Date.now() - 60_000 });
    assert.equal(found.data.path, notes);
    const sent = await t.controller.publishNotes({ sessionId: 5, file: notes });
    assert.equal(sent.ok, true);
    assert.equal(sent.data.size, fs.statSync(notes).size);
  });

  it('refuses everything that needs CoachBook before pairing', async () => {
    const t = setup();
    assert.equal((await t.controller.lectures()).status, 401);
    assert.equal((await t.controller.status()).data.paired, false);
    assert.match((await t.controller.pair({ serverUrl: 'http://coachbook.in', code: 'x' })).error, /https/);
  });

  it('keeps the YouTube stream key sealed away from the page', async () => {
    const t = setup({ settings: { serverUrl: 'https://x.in' }, token: 'cbs_t', routes: { 'POST /sessions': (init) => json(201, { id: 9, sent: JSON.parse(init.body) }) } });
    assert.equal((await t.controller.streamStart()).ok, false, 'not set up yet');
    const bad = await t.controller.saveStreamSettings({ streamKey: 'abcd-efgh-ijkl-mnop', channelId: 'apex-institute' });
    assert.match(bad.error, /starts with UC/);

    const saved = await t.controller.saveStreamSettings({ streamKey: 'abcd-efgh-ijkl-mnop', channelId: 'UCabcdefghijklmnopqrstuv', cameraId: 'cam1' });
    assert.equal(saved.data.ready, true);
    assert.equal(t.streamKey(), 'abcd-efgh-ijkl-mnop');
    assert.ok(!JSON.stringify(saved).includes('abcd-efgh'), 'the key never goes back to the page');
    assert.ok(!JSON.stringify(await t.controller.status()).includes('abcd-efgh'));
    assert.equal((await t.controller.saveStreamSettings({ streamKey: '', channelId: 'UCabcdefghijklmnopqrstuv' })).data.hasKey, true, 'a blank key keeps the saved one');

    await t.controller.streamStart();
    assert.deepEqual(t.streams.at(-1), ['start', { output: 'rtmps://a.rtmps.youtube.com:443/live2/abcd-efgh-ijkl-mnop', secret: 'abcd-efgh-ijkl-mnop' }]);
    const live = await t.controller.goLive({ slotId: 3 });
    assert.equal(live.data.sent.stream_url, 'https://www.youtube.com/embed/live_stream?channel=UCabcdefghijklmnopqrstuv', 'students get the channel’s live feed');

    await t.controller.saveStreamSettings({ clearKey: true, channelId: 'UCabcdefghijklmnopqrstuv' });
    assert.equal(t.streamKey(), null);
    assert.equal((await t.controller.goLive({ slotId: 3 })).data.sent.stream_url, null, 'no stream without a key');
  });

  it('streams unlisted when the channel is connected in CoachBook, with no key typed in', async () => {
    let connected = true;
    const t = setup({
      settings: { serverUrl: 'https://x.in' },
      token: 'cbs_t',
      routes: {
        'GET /me': () => json(200, { device: { name: 'Board' }, institute: 'Apex', youtube: connected ? { connected: true, channel_title: 'Apex Classes' } : { connected: false } }),
        'POST /sessions': (init) => json(201, { id: 9, sent: JSON.parse(init.body) }),
        'POST /sessions/9/youtube': () => (connected
          ? json(200, { stream_url: 'https://www.youtube.com/watch?v=abc', output: 'rtmps://a.rtmps.youtube.com:443/live2/key-9', stream_key: 'key-9' })
          : json(409, { error: 'No YouTube channel is connected in CoachBook', details: { code: 'youtube_not_connected' } })),
      },
    });
    const yt = (await t.controller.status()).data.streaming;
    assert.deepEqual([yt.ready, yt.unlisted, yt.channelTitle, yt.watchUrl], [true, true, 'Apex Classes', null]);

    const live = await t.controller.goLive({ slotId: 3 });
    assert.equal(live.data.sent.stream_url, null, 'CoachBook sets the link when the board asks for the broadcast');
    assert.equal((await t.controller.streamStart({ sessionId: 9 })).ok, true);
    assert.deepEqual(t.streams.at(-1), ['start', { output: 'rtmps://a.rtmps.youtube.com:443/live2/key-9', secret: 'key-9' }]);
    assert.deepEqual(await t.controller.attachStream({ sessionId: 9 }), { ok: true, data: null }, 'nothing to attach: the broadcast is the class’s');
    assert.equal(t.requests.filter((r) => r.key.startsWith('PATCH')).length, 0);

    connected = false;
    const refused = await t.controller.streamStart({ sessionId: 9 });
    assert.equal(refused.ok, false);
    assert.equal((await t.controller.streamSettings()).data.unlisted, false, 'falls back to the typed-in key from now on');
  });

  it('streams privately when CoachBook says so, ahead of the channel and any typed-in key', async () => {
    let on = true;
    const t = setup({
      settings: { serverUrl: 'https://x.in', stream: { channelId: 'UCabcdefghijklmnopqrstuv' } },
      token: 'cbs_t',
      routes: {
        'GET /me': () => json(200, { device: { name: 'Board' }, institute: 'Apex', youtube: { connected: true, channel_title: 'Apex Classes' }, private_stream: { on } }),
        'POST /sessions': (init) => json(201, { id: 9, sent: JSON.parse(init.body) }),
        'POST /sessions/9/private': () => (on
          ? json(200, { output: 'rtmps://live.cloudflare.com:443/live/cf-key', stream_key: 'cf-key' })
          : json(409, { error: 'Private streaming is not on for this institute', details: { code: 'private_stream_off' } })),
      },
    });
    await t.controller.saveStreamSettings({ streamKey: 'abcd-efgh-ijkl-mnop', channelId: 'UCabcdefghijklmnopqrstuv' });
    const s = (await t.controller.status()).data.streaming;
    assert.deepEqual([s.ready, s.private, s.unlisted, s.managed, s.watchUrl], [true, true, false, true, null]);

    const live = await t.controller.goLive({ slotId: 3 });
    assert.equal(live.data.sent.stream_url, null, 'no public link for a private class');
    assert.equal((await t.controller.streamStart({ sessionId: 9 })).ok, true);
    assert.deepEqual(t.streams.at(-1), ['start', { output: 'rtmps://live.cloudflare.com:443/live/cf-key', secret: 'cf-key' }]);
    assert.deepEqual(await t.controller.attachStream({ sessionId: 9 }), { ok: true, data: null });
    assert.equal(t.requests.some((r) => r.key.includes('/youtube')), false, 'YouTube is never asked');

    on = false;
    assert.equal((await t.controller.streamStart({ sessionId: 9 })).ok, false);
    assert.equal((await t.controller.streamSettings()).data.private, false, 'back to YouTube from now on');
  });

  it('uploads HLS to CoachBook itself when that is where private classes go', async () => {
    const t = setup({
      settings: { serverUrl: 'https://x.in' },
      token: 'cbs_t',
      routes: {
        'GET /me': () => json(200, { device: { name: 'Board' }, institute: 'Apex', youtube: { connected: false }, private_stream: { on: true } }),
        'POST /sessions/9/private': () => json(200, { hls: 'https://x.in/api/studio/hls/tok9/', output: null, stream_key: 'tok9' }),
      },
    });
    await t.controller.status();
    assert.equal((await t.controller.streamStart({ sessionId: 9 })).ok, true);
    assert.deepEqual(t.streams.at(-1), ['start', { hls: 'https://x.in/api/studio/hls/tok9/', secret: 'tok9' }]);
  });

  it('offers the page exactly the methods the preload exposes', () => {
    const preload = fs.readFileSync(new URL('../preload.cjs', import.meta.url), 'utf8');
    const list = preload.match(/const METHODS = \[([^\]]+)\]/)[1];
    const exposed = [...list.matchAll(/'(\w+)'/g)].map((m) => m[1]);
    assert.deepEqual(exposed.sort(), Object.keys(setup().controller).sort());
  });
});
