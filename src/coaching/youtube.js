import crypto from 'node:crypto';
import { utcTimestamp } from '../clock.js';
import { config } from '../config.js';
import { get, run, tenantStorage } from '../db.js';
import { seal, unseal } from '../sealed.js';
import { dropYoutubeRecording } from './recordings.js';

/**
 * Unlisted YouTube classes for CoachBook Studio.
 *
 * A manager signs in to the institute's YouTube channel once, from the
 * Smartboards page (OAuth 2.0 web flow, one Google client for the whole
 * platform — see docs/YOUTUBE.md). From then on, when a smartboard goes live
 * the server creates an unlisted broadcast for that one class, binds it to
 * the board's own reusable stream, and hands the board the ingest address.
 * Students get the broadcast's watch link as the class's stream_url, which
 * only students of that batch are ever sent (portal.js /live/active).
 *
 * Unlisted is not private: it keeps the class off the channel page, search
 * and recommendations, but anyone a student forwards the link to can watch.
 * Private would need every student's Google account invited by hand.
 *
 * Quota: each class costs about 100 of the Google project's 10,000 daily
 * units (broadcast insert 50 + bind 50, a 1-unit status read at the end, and
 * 50 more when it has to be ended or deleted), so a default project carries
 * roughly 65–100 classes a day across every institute until Google raises
 * it. See docs/YOUTUBE.md.
 */

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const API = 'https://www.googleapis.com/youtube/v3';
export const YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube';
const STATE_TTL_MS = 10 * 60 * 1000;

export const youtubeConfigured = () => Boolean(config.youtube.clientId && config.youtube.clientSecret);

/* ── Transport ───────────────────────────────────────────────────────── */

/** The network call, swappable so tests never reach Google (as fcm.js). */
let transport = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });

export function setYoutubeTransport(fn) {
  const previous = transport;
  transport = fn;
  accessTokens.clear();
  return previous;
}

/** A refusal from Google, with its machine reason (e.g. `quotaExceeded`). */
export class YoutubeError extends Error {
  constructor(message, { status = 0, reason = null } = {}) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

/** What a manager or teacher can act on, for the reasons that come up. */
const REASONS = {
  liveStreamingNotEnabled: 'Live streaming is not turned on for this YouTube channel yet. Turn it on in YouTube Studio → Create → Go live; the first time takes up to 24 hours.',
  insufficientLivePermissions: 'This YouTube channel is not allowed to live stream. Check the channel’s live streaming status in YouTube Studio.',
  quotaExceeded: 'CoachBook has used up its YouTube allowance for today. Classes run without a stream until it resets (midnight US Pacific time).',
  rateLimitExceeded: 'YouTube is asking CoachBook to slow down. Try again in a minute.',
  invalid_grant: 'Google no longer accepts CoachBook’s sign-in to this channel. Connect the channel again from Smartboards.',
};

async function google(url, init = {}) {
  let res;
  try {
    res = await transport(url, init);
  } catch {
    throw new YoutubeError('Cannot reach YouTube right now. Try again in a minute.');
  }
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // not JSON — the status says enough
  }
  if (res.status >= 200 && res.status < 300) return body;
  // OAuth answers {error: 'invalid_grant'}; the Data API {error: {errors: [{reason}], message}}.
  const reason = typeof body?.error === 'string' ? body.error : body?.error?.errors?.[0]?.reason ?? null;
  const said = typeof body?.error === 'object' ? body.error.message : body?.error_description;
  throw new YoutubeError(REASONS[reason] ?? `YouTube refused (${res.status}${said ? `: ${said}` : ''})`, { status: res.status, reason });
}

const form = (fields) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields).toString(),
});

/* ── Signing in ──────────────────────────────────────────────────────── */

const hash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const slugNow = () => tenantStorage.getStore()?.slug;

/**
 * Google's consent page for this institute. `state` is `<slug>.<nonce>`: the
 * slug tells the platform-wide callback which institute's database to open
 * (a slug has no dots), and the nonce — stored only as a hash, for ten
 * minutes, usable once — is what proves the callback answers a sign-in a
 * manager of that institute started here.
 */
export function signInUrl({ userId, returnUrl }) {
  const nonce = crypto.randomBytes(24).toString('base64url');
  run('DELETE FROM youtube_oauth_states WHERE expires_at < ?', [utcTimestamp()]);
  run('INSERT INTO youtube_oauth_states (state_hash, user_id, return_url, expires_at) VALUES (?, ?, ?, ?)', [hash(nonce), userId, returnUrl, utcTimestamp(STATE_TTL_MS)]);
  const params = new URLSearchParams({
    client_id: config.youtube.clientId,
    redirect_uri: config.youtube.redirectUri,
    response_type: 'code',
    scope: YOUTUBE_SCOPE,
    // A refresh token, every time: classes go live long after the manager has left.
    access_type: 'offline',
    prompt: 'consent',
    state: `${slugNow()}.${nonce}`,
  });
  return `${AUTH_URL}?${params}`;
}

/** Splits the callback's state; null if it is not one of ours. */
export function parseState(state) {
  const match = /^([a-z][a-z0-9-]{1,39})\.([\w-]{32})$/.exec(String(state ?? ''));
  return match ? { slug: match[1], nonce: match[2] } : null;
}

/** The sign-in the nonce belongs to, used up — or null if unknown or stale. */
export function takeSignIn(nonce) {
  const row = get('SELECT user_id, return_url, expires_at FROM youtube_oauth_states WHERE state_hash = ?', [hash(nonce)]);
  if (!row) return null;
  run('DELETE FROM youtube_oauth_states WHERE state_hash = ?', [hash(nonce)]);
  return row.expires_at < utcTimestamp() ? null : row;
}

/**
 * Trades the callback's code for tokens, checks the account has a channel
 * and granted the YouTube scope (Google lets a user untick it), and saves
 * the connection. Throws a YoutubeError with a `reason` the callback turns
 * into a message on the Smartboards page.
 */
export async function completeSignIn({ code, userId }) {
  const tokens = await google(TOKEN_URL, form({
    grant_type: 'authorization_code',
    code,
    client_id: config.youtube.clientId,
    client_secret: config.youtube.clientSecret,
    redirect_uri: config.youtube.redirectUri,
  }));
  if (!String(tokens?.scope ?? '').split(' ').includes(YOUTUBE_SCOPE)) {
    throw new YoutubeError('CoachBook needs permission to manage the channel’s live streams.', { reason: 'scope_denied' });
  }
  if (!tokens.refresh_token) throw new YoutubeError('Google did not give CoachBook a lasting sign-in. Try again.', { reason: 'no_refresh_token' });

  const channels = await google(`${API}/channels?part=snippet&mine=true`, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
  const channel = channels?.items?.[0];
  if (!channel) throw new YoutubeError('That Google account has no YouTube channel.', { reason: 'no_channel' });

  run(
    `INSERT INTO youtube_connection (id, channel_id, channel_title, refresh_token_sealed, connected_by, connected_at)
     VALUES (1, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET channel_id = excluded.channel_id, channel_title = excluded.channel_title,
       refresh_token_sealed = excluded.refresh_token_sealed, connected_by = excluded.connected_by,
       connected_at = excluded.connected_at, broken_at = NULL, broken_reason = NULL`,
    [channel.id, channel.snippet?.title ?? null, seal(tokens.refresh_token), userId, utcTimestamp()],
  );
  remember(Number(tokens.expires_in) || 3600, tokens.access_token);
  return connection();
}

/** Forgets the channel, and asks Google to revoke the sign-in too (best effort). */
export async function disconnect() {
  const conn = get('SELECT refresh_token_sealed FROM youtube_connection WHERE id = 1');
  run('DELETE FROM youtube_connection WHERE id = 1');
  accessTokens.delete(slugNow());
  const refresh = unseal(conn?.refresh_token_sealed);
  if (refresh) await google(REVOKE_URL, form({ token: refresh })).catch(() => {});
}

/* ── The connection ──────────────────────────────────────────────────── */

const connection = () => get('SELECT * FROM youtube_connection WHERE id = 1');

/** What the Smartboards page shows — never a token. */
export function youtubeStatus() {
  const conn = connection();
  return {
    configured: youtubeConfigured(),
    connected: Boolean(conn),
    channel_id: conn?.channel_id ?? null,
    channel_title: conn?.channel_title ?? null,
    connected_at: conn?.connected_at ?? null,
    connected_by_name: conn?.connected_by ? get('SELECT name FROM users WHERE id = ?', [conn.connected_by])?.name ?? null : null,
    broken: conn?.broken_at ? { at: conn.broken_at, reason: conn.broken_reason } : null,
  };
}

/** Whether a board should ask for an unlisted broadcast rather than use a typed-in key. */
export function youtubeReady() {
  const conn = connection();
  return youtubeConfigured() && Boolean(conn) && !conn.broken_at;
}

function markBroken(reason) {
  run('UPDATE youtube_connection SET broken_at = ?, broken_reason = ? WHERE id = 1 AND broken_at IS NULL', [utcTimestamp(), reason]);
  accessTokens.delete(slugNow());
}

/* ── Access tokens ───────────────────────────────────────────────────── */

/** Per institute: { token, expiresAt }. An hour each; renewed a minute early. */
const accessTokens = new Map();

function remember(expiresInSeconds, token) {
  accessTokens.set(slugNow(), { token, expiresAt: Date.now() + expiresInSeconds * 1000 });
}

async function accessToken() {
  const cached = accessTokens.get(slugNow());
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const conn = connection();
  if (!conn || conn.broken_at) throw new YoutubeError('No YouTube channel is connected.', { reason: 'not_connected' });
  const refresh = unseal(conn.refresh_token_sealed);
  if (!refresh) {
    markBroken('The saved sign-in can no longer be read. Connect the channel again.');
    throw new YoutubeError(REASONS.invalid_grant, { reason: 'invalid_grant' });
  }
  try {
    const tokens = await google(TOKEN_URL, form({
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: config.youtube.clientId,
      client_secret: config.youtube.clientSecret,
    }));
    remember(Number(tokens.expires_in) || 3600, tokens.access_token);
    return tokens.access_token;
  } catch (err) {
    // Revoked, password changed, or a Testing-mode app's 7-day token run out.
    if (err.reason === 'invalid_grant') markBroken(REASONS.invalid_grant);
    throw err;
  }
}

/** A Data API call as the channel, retried once on a 401 with a fresh token. */
async function youtube(method, path, { query = {}, body } = {}) {
  const url = `${API}${path}?${new URLSearchParams(query)}`;
  const init = (token) => ({
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  try {
    return await google(url, init(await accessToken()));
  } catch (err) {
    if (err.status !== 401) throw err;
    accessTokens.delete(slugNow());
    return google(url, init(await accessToken()));
  }
}

/* ── A board's stream ────────────────────────────────────────────────── */

/**
 * The board's YouTube stream on the connected channel — made once, then
 * reused for every class (a reusable stream keeps its key), so the board is
 * the only thing that ever pushes to it.
 */
async function boardStream(deviceId) {
  const channelId = connection().channel_id;
  const device = get('SELECT name, youtube_stream_id, youtube_stream_channel, youtube_ingest_sealed FROM studio_devices WHERE id = ?', [deviceId]);
  const saved = device.youtube_stream_channel === channelId ? JSON.parse(unseal(device.youtube_ingest_sealed) || 'null') : null;
  if (device.youtube_stream_id && saved) return { id: device.youtube_stream_id, ...saved };

  const stream = await youtube('POST', '/liveStreams', {
    query: { part: 'snippet,cdn,contentDetails' },
    body: {
      snippet: { title: `${device.name} (CoachBook Studio)`.slice(0, 128) },
      cdn: { ingestionType: 'rtmp', resolution: 'variable', frameRate: 'variable' },
      contentDetails: { isReusable: true },
    },
  });
  const info = stream.cdn?.ingestionInfo ?? {};
  // RTMPS where YouTube offers it, so the key never crosses the network in the clear.
  const ingest = { address: info.rtmpsIngestionAddress || info.ingestionAddress, key: info.streamName };
  run(
    'UPDATE studio_devices SET youtube_stream_id = ?, youtube_stream_channel = ?, youtube_ingest_sealed = ? WHERE id = ?',
    [stream.id, channelId, seal(JSON.stringify(ingest)), deviceId],
  );
  return { id: stream.id, ...ingest };
}

const forgetBoardStream = (deviceId) => run('UPDATE studio_devices SET youtube_stream_id = NULL, youtube_stream_channel = NULL, youtube_ingest_sealed = NULL WHERE id = ?', [deviceId]);

/* ── A class's broadcast ─────────────────────────────────────────────── */

export const watchUrl = (broadcastId) => `https://www.youtube.com/watch?v=${broadcastId}`;

/** YouTube refuses < and > in titles, and anything over 100 characters. */
const broadcastTitle = (session) => [session.subject_name, session.batch_name, session.title].filter(Boolean).join(' · ').replace(/[<>]/g, '').slice(0, 100) || 'Live class';

const DONE = new Set(['complete', 'revoked']);

/**
 * The unlisted broadcast for one live class, bound to this board's stream,
 * and where the board sends its video. Asked again (a restarted stream, a
 * second board taking over), it reuses the class's broadcast while YouTube
 * still has it open, rebinding it only if another board's stream is on it;
 * once it has ended, the class gets a new one, and a new stream_url.
 *
 * @returns {{ broadcastId: string, streamUrl: string, output: string, streamKey: string }}
 */
export async function broadcastForClass(session, deviceId) {
  let stream = await boardStream(deviceId);
  let broadcastId = session.youtube_broadcast_id;
  let boundTo = null;
  if (broadcastId) {
    const found = (await youtube('GET', '/liveBroadcasts', { query: { part: 'status,contentDetails', id: broadcastId } }))?.items?.[0];
    if (!found || DONE.has(found.status?.lifeCycleStatus)) broadcastId = null;
    else boundTo = found.contentDetails?.boundStreamId ?? null;
  }
  if (!broadcastId) {
    const created = await youtube('POST', '/liveBroadcasts', {
      query: { part: 'snippet,status,contentDetails' },
      body: {
        snippet: { title: broadcastTitle(session), scheduledStartTime: new Date().toISOString() },
        status: { privacyStatus: 'unlisted', selfDeclaredMadeForKids: false },
        // On air as soon as the board's video arrives, and off when it stops;
        // embeddable, since students watch inside the app.
        contentDetails: { enableAutoStart: true, enableAutoStop: true, enableEmbed: true, enableDvr: true, recordFromStart: true, latencyPreference: 'low' },
      },
    });
    broadcastId = created.id;
  }
  if (boundTo !== stream.id) {
    try {
      await youtube('POST', '/liveBroadcasts/bind', { query: { part: 'id', id: broadcastId, streamId: stream.id } });
    } catch (err) {
      // The board's stream was deleted on YouTube's side: make it a new one.
      if (err.status !== 404) throw err;
      forgetBoardStream(deviceId);
      stream = await boardStream(deviceId);
      await youtube('POST', '/liveBroadcasts/bind', { query: { part: 'id', id: broadcastId, streamId: stream.id } });
    }
  }
  const streamUrl = watchUrl(broadcastId);
  run('UPDATE live_sessions SET youtube_broadcast_id = ?, stream_url = ?, cf_live_input_id = NULL WHERE id = ?', [broadcastId, streamUrl, session.id]);
  return { broadcastId, streamUrl, output: `${stream.address.replace(/\/+$/, '')}/${stream.key}`, streamKey: stream.key };
}

/* ── After the class ─────────────────────────────────────────────────── */

const pending = new Set();

/**
 * Closes the class's broadcast once the class is over. Usually YouTube has
 * already ended it (enableAutoStop, when the board stopped sending); one
 * still live is ended now; one that never went on air — the board never
 * streamed — is deleted, so the channel is not left with empty upcoming
 * streams. Runs after the response, in the background: a slow YouTube
 * never holds up ending a class.
 */
export function finishBroadcastLater(broadcastId) {
  if (!broadcastId || !youtubeConfigured()) return;
  const work = (async () => {
    try {
      const found = (await youtube('GET', '/liveBroadcasts', { query: { part: 'status', id: broadcastId } }))?.items?.[0];
      const status = found?.status?.lifeCycleStatus;
      if (status === 'live') await youtube('POST', '/liveBroadcasts/transition', { query: { part: 'status', id: broadcastId, broadcastStatus: 'complete' } });
      else if (['created', 'ready', 'testStarting', 'testing'].includes(status)) {
        await youtube('DELETE', '/liveBroadcasts', { query: { id: broadcastId } });
        // Nothing was recorded, so the class leaves nothing to rewatch.
        dropYoutubeRecording(broadcastId);
      }
    } catch (err) {
      console.error(`[youtube] could not close broadcast ${broadcastId}:`, err.message);
    }
  })();
  pending.add(work);
  work.finally(() => pending.delete(work));
}

/** Settles once every background close has (tests). */
export const youtubeIdle = () => Promise.allSettled([...pending]);
