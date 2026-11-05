import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createStudioApi, parseServerUrl } from '../src/studioApi.js';

describe('the institute’s address', () => {
  it('splits into the API base and the socket origin', () => {
    assert.deepEqual(parseServerUrl(' https://coachbook.in/g/apex/ '), { base: 'https://coachbook.in/g/apex', socketOrigin: 'wss://coachbook.in' });
    assert.deepEqual(parseServerUrl('https://classes.apex.in'), { base: 'https://classes.apex.in', socketOrigin: 'wss://classes.apex.in' });
    assert.deepEqual(parseServerUrl('https://coachbook.in/g/apex/api'), { base: 'https://coachbook.in/g/apex', socketOrigin: 'wss://coachbook.in' });
    assert.deepEqual(parseServerUrl('http://localhost:3000/g/apex'), { base: 'http://localhost:3000/g/apex', socketOrigin: 'ws://localhost:3000' });
  });

  it('refuses plain http anywhere but this machine, and nonsense', () => {
    assert.match(parseServerUrl('http://coachbook.in/g/apex').error, /https/);
    assert.match(parseServerUrl('coachbook.in').error, /address/);
    assert.match(parseServerUrl('').error, /address/);
  });
});

describe('calls to CoachBook', () => {
  const fakeFetch = (respond) => {
    const calls = [];
    const fn = async (url, init) => {
      calls.push({ url, init });
      return respond(url, init);
    };
    fn.calls = calls;
    return fn;
  };
  const json = (status, body) => ({ ok: status < 400, status, json: async () => body });

  it('sends the device token, and only once paired', async () => {
    let token = null;
    const fetchImpl = fakeFetch(() => json(200, { items: [] }));
    const api = createStudioApi({ base: 'https://coachbook.in/g/apex', getToken: () => token, fetchImpl });
    assert.deepEqual(await api.lectures(), { ok: false, status: 401, error: 'This board is not paired' });
    assert.equal(fetchImpl.calls.length, 0, 'nothing leaves the board without a token');
    token = 'cbs_secret';
    const res = await api.lectures();
    assert.equal(res.ok, true);
    assert.equal(fetchImpl.calls[0].url, 'https://coachbook.in/g/apex/api/studio/lectures');
    assert.equal(fetchImpl.calls[0].init.headers.Authorization, 'Bearer cbs_secret');
  });

  it('pairs without a token, and uploads notes as a PDF body', async () => {
    const fetchImpl = fakeFetch(() => json(200, {}));
    const api = createStudioApi({ base: 'https://x.in', getToken: () => 'cbs_t', fetchImpl });
    await api.pair('ABCD-EFGH');
    assert.equal(fetchImpl.calls[0].init.headers.Authorization, undefined);
    assert.equal(fetchImpl.calls[0].init.body, JSON.stringify({ code: 'ABCD-EFGH' }));
    await api.publishNotes(7, Buffer.from('%PDF-1.4'));
    assert.equal(fetchImpl.calls[1].url, 'https://x.in/api/studio/sessions/7/publish-notes');
    assert.equal(fetchImpl.calls[1].init.headers['Content-Type'], 'application/pdf');
  });

  it('marks the next topic at a point in the recording, and takes a marker back', async () => {
    const fetchImpl = fakeFetch(() => json(201, {}));
    const api = createStudioApi({ base: 'https://x.in', getToken: () => 'cbs_t', fetchImpl });
    await api.addMarker(7, 754, 'Torque');
    assert.equal(fetchImpl.calls[0].url, 'https://x.in/api/studio/sessions/7/markers');
    assert.equal(fetchImpl.calls[0].init.body, JSON.stringify({ offset_sec: 754, label: 'Torque' }));
    await api.removeMarker(7, 3);
    assert.equal(fetchImpl.calls[1].init.method, 'DELETE');
    assert.equal(fetchImpl.calls[1].url, 'https://x.in/api/studio/sessions/7/markers/3');
  });

  it('turns failures into results, not exceptions', async () => {
    const refused = createStudioApi({ base: 'https://x.in', getToken: () => 't', fetchImpl: fakeFetch(() => json(409, { error: 'Batch 12-A is already live', details: { code: 'batch_already_live', session_id: 4 } })) });
    assert.deepEqual(await refused.goLive(3), { ok: false, status: 409, error: 'Batch 12-A is already live', details: { code: 'batch_already_live', session_id: 4 } });
    const offline = createStudioApi({ base: 'https://x.in', getToken: () => 't', fetchImpl: async () => { throw new TypeError('fetch failed'); } });
    assert.equal((await offline.me()).status, 0);
    assert.match((await offline.me()).error, /internet/);
  });
});
