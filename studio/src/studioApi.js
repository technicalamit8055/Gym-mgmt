/**
 * The board's calls to CoachBook (/api/studio — see the server's
 * src/routes/coaching/studio.js), made from the main process with the device
 * token. Every call resolves to `{ ok, status, data }` or
 * `{ ok: false, status, error, details }` rather than throwing: these results
 * cross into the dock's page over IPC, which does not carry errors well.
 */

/**
 * The institute's address as typed — "https://coachbook.in/g/apex" or an
 * institute's own domain — checked and split into the API base and the
 * socket origin. Plain http is refused except on this machine: the device
 * token travels in every request.
 */
export function parseServerUrl(input) {
  let url;
  try {
    url = new URL(String(input ?? '').trim());
  } catch {
    return { error: 'Type the institute’s CoachBook address, starting with https://' };
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    return { error: 'The address has to start with https://' };
  }
  const base = `${url.origin}${url.pathname.replace(/\/+$/, '').replace(/\/api$/, '')}`;
  return { base, socketOrigin: `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}` };
}

export function createStudioApi({ base, getToken, fetchImpl = globalThis.fetch }) {
  async function call(method, path, { json, bytes, auth = true, timeoutMs = 20_000 } = {}) {
    const headers = {};
    if (auth) {
      const token = getToken();
      if (!token) return { ok: false, status: 401, error: 'This board is not paired' };
      headers.Authorization = `Bearer ${token}`;
    }
    let body;
    if (json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    } else if (bytes) {
      headers['Content-Type'] = 'application/pdf';
      body = bytes;
    }
    let res;
    try {
      res = await fetchImpl(`${base}/api/studio${path}`, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      const timedOut = err?.name === 'TimeoutError';
      return { ok: false, status: 0, error: timedOut ? 'CoachBook did not answer in time' : 'Cannot reach CoachBook — check the board’s internet' };
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      // an empty or non-JSON body; the status says enough
    }
    if (res.ok) return { ok: true, status: res.status, data };
    return { ok: false, status: res.status, error: data?.error || `CoachBook answered ${res.status}`, details: data?.details ?? null };
  }

  return {
    pair: (code) => call('POST', '/pair', { json: { code }, auth: false }),
    me: () => call('GET', '/me'),
    lectures: () => call('GET', '/lectures'),
    goLive: (slotId, streamUrl = null) => call('POST', '/sessions', { json: { slot_id: slotId, stream_url: streamUrl } }),
    attachStream: (id, streamUrl) => call('PATCH', `/sessions/${id}/stream`, { json: { stream_url: streamUrl } }),
    // The class's unlisted broadcast; YouTube can take a few seconds to make one.
    youtube: (id) => call('POST', `/sessions/${id}/youtube`, { timeoutMs: 45_000 }),
    // Where to send a private class (CoachBook's own player, not YouTube).
    privateStream: (id) => call('POST', `/sessions/${id}/private`, { timeoutMs: 45_000 }),
    session: (id) => call('GET', `/sessions/${id}`),
    socketTicket: (id) => call('POST', `/sessions/${id}/socket-ticket`),
    endClass: (id) => call('PATCH', `/sessions/${id}/end`),
    // "Next topic": a chapter on the class's recording, `offsetSec` into it.
    addMarker: (id, offsetSec, label = null) => call('POST', `/sessions/${id}/markers`, { json: { offset_sec: offsetSec, label } }),
    markers: (id) => call('GET', `/sessions/${id}/markers`),
    removeMarker: (id, markerId) => call('DELETE', `/sessions/${id}/markers/${markerId}`),
    // A big export over classroom Wi-Fi takes its time.
    publishNotes: (id, bytes) => call('POST', `/sessions/${id}/publish-notes`, { bytes, timeoutMs: 120_000 }),
  };
}
