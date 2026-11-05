import crypto from 'node:crypto';
import { config } from '../config.js';
import { get, run } from '../db.js';
import { seal, unseal } from '../sealed.js';
import { recordingRoom } from '../recordingStorage.js';
import { hasStream, openIngest, watchToken } from './selfHostedStream.js';

/**
 * Private classes for CoachBook Studio.
 *
 * For a paid batch, YouTube is the wrong home: an unlisted link can be
 * forwarded, the player is YouTube's, and YouTube picks the quality. With
 * private streaming on (a manager's choice, on the Smartboards page), the
 * board streams to one of two places, the platform's choice
 * (config.privateStreamBackend):
 *
 *   selfhosted  this server (selfHostedStream.js): the board uploads HLS in
 *               three qualities, students fetch it with a signed link.
 *               Free but for bandwidth — the default.
 *   cloudflare  Cloudflare Stream, below. Billed by the minute watched.
 *
 * With Cloudflare, a board streams to its own live input — made once, then
 * reused for every class, like its YouTube stream — and a class records
 * which input carries it. Nothing public ever holds a link to it:
 *
 *   - the input requires signed links, so its bare HLS address plays nothing;
 *   - each student of the batch, and only them (portal.js /live/active), is
 *     signed their own link, good for a few hours — a forwarded one stops
 *     working, and the app asks for a fresh one when it does;
 *   - students watch in CoachBook's own player (public/js/classPlayer.js),
 *     with a quality menu, since Cloudflare sends every rendition.
 *
 * Links are signed here with a Stream signing key (RS256 JWTs, Cloudflare's
 * "self-signed tokens"), so letting a student in costs no API call. One
 * Cloudflare account serves the whole platform. See docs/PRIVATE_STREAMING.md.
 */

const API = 'https://api.cloudflare.com/client/v4';
export const CLOUDFLARE_INGEST = 'rtmps://live.cloudflare.com:443/live/';
/** Long enough for a class and a late start; Cloudflare allows 24 hours at most. */
const LINK_TTL_S = 6 * 60 * 60;

/** Who carries private classes on this platform: this server, or Cloudflare. */
export const privateBackend = () => config.privateStreamBackend;

function cloudflareConfigured() {
  const c = config.cloudflareStream;
  return Boolean(c.accountId && c.apiToken && c.customerCode && c.keyId && c.keyPem);
}

/** Self-hosted needs nothing set up; Cloudflare needs its account and signing key. */
export const privateStreamConfigured = () => privateBackend() === 'selfhosted' || cloudflareConfigured();

/** Where this institute's boards stream: 'youtube' or 'private'. */
export const streamProvider = () => get('SELECT stream_provider FROM coaching_settings WHERE id = 1')?.stream_provider ?? 'youtube';

export function setStreamProvider(provider) {
  run("UPDATE coaching_settings SET stream_provider = ?, updated_at = datetime('now') WHERE id = 1", [provider]);
}

/** Whether a board should stream this institute's classes privately. */
export const privateStreamReady = () => privateStreamConfigured() && streamProvider() === 'private';

/* ── Transport ───────────────────────────────────────────────────────── */

/** The network call, swappable so tests never reach Cloudflare (as youtube.js). */
let transport = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });

export function setStreamTransport(fn) {
  const previous = transport;
  transport = fn;
  return previous;
}

/** A refusal from Cloudflare, said so a teacher or manager can act on it. */
export class PrivateStreamError extends Error {
  constructor(message, { status = 0 } = {}) {
    super(message);
    this.status = status;
  }
}

async function cloudflare(method, path, body) {
  const { accountId, apiToken } = config.cloudflareStream;
  let res;
  try {
    res = await transport(`${API}/accounts/${accountId}/stream${path}`, {
      method,
      headers: { Authorization: `Bearer ${apiToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new PrivateStreamError('Cannot reach the streaming service right now. Try again in a minute.');
  }
  let payload = null;
  try {
    payload = JSON.parse(await res.text());
  } catch {
    // not JSON — the status says enough
  }
  if (res.status >= 200 && res.status < 300 && payload?.success !== false) return payload?.result ?? null;
  const said = payload?.errors?.map((e) => e.message).filter(Boolean).join('; ');
  if (res.status === 401 || res.status === 403) {
    throw new PrivateStreamError('The streaming service refused CoachBook’s credentials. The platform operator needs to check the Cloudflare API token.', { status: res.status });
  }
  throw new PrivateStreamError(`The streaming service refused (${res.status}${said ? `: ${said}` : ''})`, { status: res.status });
}

/* ── A board's live input ────────────────────────────────────────────── */

/**
 * The board's live input — made once and reused for every class, so the
 * board is the only thing that ever pushes to it. Recording is on because
 * Cloudflare plays nothing without it; each class is kept as a video on the
 * account (and counts toward its storage) until deleted there.
 */
async function boardInput(deviceId) {
  const device = get('SELECT name, cf_live_input_id, cf_ingest_sealed FROM studio_devices WHERE id = ?', [deviceId]);
  const saved = device.cf_live_input_id ? JSON.parse(unseal(device.cf_ingest_sealed) || 'null') : null;
  if (saved) return { id: device.cf_live_input_id, ...saved };

  const input = await cloudflare('POST', '/live_inputs', {
    meta: { name: `${device.name} (CoachBook Studio)`.slice(0, 120) },
    recording: { mode: 'automatic', requireSignedURLs: true },
  });
  if (!input?.uid || !input.rtmps?.streamKey) throw new PrivateStreamError('The streaming service did not return a live input.');
  const ingest = { url: input.rtmps.url || CLOUDFLARE_INGEST, key: input.rtmps.streamKey };
  run('UPDATE studio_devices SET cf_live_input_id = ?, cf_ingest_sealed = ? WHERE id = ?', [input.uid, seal(JSON.stringify(ingest)), deviceId]);
  return { id: input.uid, ...ingest };
}

/**
 * Where the board sends the class, and points the class at it. Self-hosted:
 * `hls`, the address to upload HLS to (a fresh token in it, which is also
 * `streamKey`). Cloudflare: `output`, the board's live input over RTMPS.
 * `streamKey` is there so the board can blank it out of errors. Asked again
 * — a restart, a second board — it just repoints.
 *
 * @param {{ slug: string, ingestBase: string }} where  the institute, and its
 *   upload address as the board reaches this server
 * @returns {Promise<{ hls?: string, output?: string, streamKey: string }>}
 */
export async function privateStreamForClass(session, deviceId, { slug, ingestBase }) {
  if (privateBackend() === 'selfhosted') {
    // Recorded to disk as it streams, where the institute keeps recordings (serverRecording.js)
    // and the server's disk has room for it (recordingStorage.js).
    const record = Boolean(get('SELECT record_classes FROM coaching_settings WHERE id = 1')?.record_classes) && recordingRoom();
    const token = openIngest(slug, session.id, { record });
    run('UPDATE live_sessions SET cf_live_input_id = NULL, stream_url = NULL WHERE id = ?', [session.id]);
    return { hls: `${ingestBase}/${token}/`, streamKey: token };
  }
  const input = await boardInput(deviceId);
  run('UPDATE live_sessions SET cf_live_input_id = ?, stream_url = NULL WHERE id = ?', [input.id, session.id]);
  return { output: `${input.url.replace(/\/+$/, '')}/${input.key}`, streamKey: input.key };
}

/* ── A class's recording ─────────────────────────────────────────────── */

/** Slack either side of the class, for a board that connected a little early. */
const RECORDING_SLACK_MS = 5 * 60_000;
const utcMs = (stamp) => Date.parse(`${String(stamp).replace(' ', 'T')}Z`);

/**
 * The video Cloudflare kept of one class: the board's live input records
 * every connection as its own video, so the class's is the one made while
 * it was on air — the longest, if the board dropped and reconnected.
 *
 * @param {{ from: string, to: string }} window  the class's started_at and
 *   ended_at, UTC `YYYY-MM-DD HH:MM:SS`
 * @returns {Promise<{ state: 'ready', uid: string, duration: number|null }
 *   | { state: 'processing' } | { state: 'none' }>}
 */
export async function classRecording(inputId, { from, to }) {
  if (!cloudflareConfigured()) return { state: 'none' };
  const videos = (await cloudflare('GET', `/live_inputs/${encodeURIComponent(inputId)}/videos`)) ?? [];
  const start = utcMs(from) - RECORDING_SLACK_MS;
  const end = utcMs(to) + RECORDING_SLACK_MS;
  const during = videos.filter((v) => {
    const made = Date.parse(v.created);
    return made >= start && made <= end && v.status?.state !== 'error';
  });
  if (!during.length) return { state: 'none' };
  const ready = during.filter((v) => v.readyToStream);
  if (ready.length < during.length) return { state: 'processing' };
  const best = ready.reduce((a, b) => ((b.duration ?? 0) > (a.duration ?? 0) ? b : a));
  return { state: 'ready', uid: best.uid, duration: best.duration > 0 ? Math.round(best.duration) : null };
}

/* ── A student's link ────────────────────────────────────────────────── */

const b64url = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

let signingKey = null;
let signingKeyFor = null;

function privateKey() {
  const { keyPem } = config.cloudflareStream;
  if (signingKeyFor !== keyPem) {
    // Cloudflare hands the PEM over base64-encoded; a raw PEM pasted in works too.
    const pem = keyPem.includes('BEGIN') ? keyPem : Buffer.from(keyPem, 'base64').toString('utf8');
    signingKey = crypto.createPrivateKey(pem);
    signingKeyFor = keyPem;
  }
  return signingKey;
}

/** A signed playback token for one live input, good for `ttlSeconds`. */
export function playbackToken(inputId, { ttlSeconds = LINK_TTL_S, now = Date.now() } = {}) {
  const { keyId } = config.cloudflareStream;
  const issued = Math.floor(now / 1000);
  const head = b64url({ alg: 'RS256', kid: keyId });
  const body = b64url({ sub: inputId, kid: keyId, nbf: issued - 60, exp: issued + ttlSeconds });
  const signature = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey()).toString('base64url');
  return `${head}.${body}.${signature}`;
}

/** The HLS address one student's app plays — signed for them alone. A live
 * input's uid plays the class live; a video's uid, its recording. */
export function playbackUrl(uid) {
  return `https://customer-${config.cloudflareStream.customerCode}.cloudflarestream.com/${playbackToken(uid)}/manifest/video.m3u8`;
}

/** Whether a Cloudflare recording can be played here at all. */
export const cloudflarePlayable = () => cloudflareConfigured();

/**
 * A live class as one student sees it: a private one gets their own signed
 * link, and `private_stream` so the app knows to ask for a fresh one later.
 *
 * @param {{ slug: string, memberId: number, watchBase: string }} who  the
 *   student, and this server's playback address as their app reaches it
 */
export function forStudent(session, inputId, { slug, memberId, watchBase }) {
  if (hasStream(slug, session.id)) {
    return { ...session, private_stream: true, stream_url: `${watchBase}/${watchToken(slug, session.id, memberId)}/master.m3u8` };
  }
  if (!inputId) return session;
  return { ...session, private_stream: true, stream_url: cloudflareConfigured() ? playbackUrl(inputId) : null };
}
