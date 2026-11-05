import crypto from 'node:crypto';
import { config } from '../config.js';
import { recordingRoom } from '../recordingStorage.js';
import { createRecorder } from './serverRecording.js';

/**
 * Private classes served by CoachBook itself — no YouTube, no paid service.
 *
 * The board's ffmpeg (studio/src/streamer.js) encodes the class three times
 * — 720p, 480p, 360p — and uploads it here as HLS over plain HTTP PUTs:
 * a master playlist, a playlist per quality, and two-second segments. This
 * keeps only the last half-minute of each class, in memory, and serves it
 * to students holding a signed link. Nothing is transcoded here, so one
 * modest server carries many classes; what it costs is bandwidth.
 *
 *   uploading   PUT /api/studio/hls/<ingest token>/<file> (routes/coaching/studio.js).
 *               The token is made when the board asks to stream a class
 *               (openIngest), lives only in memory, and a new one retires
 *               the old: a restarted stream starts clean.
 *   watching    GET /api/live-hls/<watch token>/<file> (routes/coaching/liveHls.js).
 *               The watch token is signed for one student and one class
 *               (watchToken), good for a few hours. It sits in the path, so
 *               the playlists' relative links carry it to every segment
 *               without rewriting, and players that cannot add headers
 *               (iOS's own HLS) still work.
 *
 * In memory, so one process: a restart loses the live window, and the
 * board's ffmpeg, refused, restarts its stream and makes a new one. Where
 * the institute keeps recordings, each run is also copied to disk as it
 * arrives (serverRecording.js), and filed as a lecture when the class ends.
 */

const KEEP_SEGMENTS_MS = 30_000;
const IDLE_MS = 10 * 60_000;
const WATCH_TTL_S = 3 * 60 * 60;
/** Long enough for a lecture watched with pauses; the app asks for a fresh one after. */
const RECORDING_TTL_S = 6 * 60 * 60;
const FILE_NAME = /^[\w.-]{1,80}$/;

/** `${slug}:${sessionId}` → { ingestHash, files: Map<name, { body, type, at }>, lastPut } */
const streams = new Map();
/** ingest token hash → `${slug}:${sessionId}` */
const ingests = new Map();

const keyOf = (slug, sessionId) => `${slug}:${sessionId}`;
const hash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

const TYPES = { m3u8: 'application/vnd.apple.mpegurl', ts: 'video/mp2t', m4s: 'video/iso.segment', mp4: 'video/mp4' };
const typeOf = (name) => TYPES[name.split('.').pop()] ?? null;

/**
 * A new upload token for the class, retiring any earlier one, and an empty
 * window — segment numbers start again with each ffmpeg run. `record`: the
 * institute keeps recordings, so this run is copied to disk as it arrives
 * (serverRecording.js).
 */
export function openIngest(slug, sessionId, { record = false } = {}) {
  const key = keyOf(slug, sessionId);
  const previous = streams.get(key);
  if (previous) ingests.delete(previous.ingestHash);
  const token = crypto.randomBytes(24).toString('base64url');
  const ingestHash = hash(token);
  let recorder = null;
  if (record) {
    try {
      recorder = createRecorder(slug, sessionId);
    } catch (err) {
      console.error(`[recording:${slug}] could not start recording class ${sessionId}:`, err.message);
    }
  }
  streams.set(key, { ingestHash, files: new Map(), lastPut: Date.now(), recorder });
  ingests.set(ingestHash, key);
  return token;
}

/** Whether the class is being streamed here — what makes it "private, self-hosted" to students. */
export const hasStream = (slug, sessionId) => streams.has(keyOf(slug, sessionId));

/** Stores one uploaded file. False for an unknown token, a token for another institute, or a bad name. */
export function putFile(slug, token, name, body) {
  const key = ingests.get(hash(token));
  if (!key || !key.startsWith(`${slug}:`) || !FILE_NAME.test(name) || !typeOf(name)) return false;
  const stream = streams.get(key);
  const now = Date.now();
  stream.files.set(name, { body, type: typeOf(name), at: now });
  stream.lastPut = now;
  if (stream.recorder && name.endsWith('.m3u8') && !recordingRoom()) {
    // The disk is nearly full (recordingStorage.js): the recording stops here,
    // and what it has so far is still filed when the class ends.
    console.warn(`[recording:${slug}] the disk is nearly full; stopped recording ${key}`);
    stream.recorder = null;
  }
  if (stream.recorder && name.endsWith('.m3u8')) {
    // A full disk or a bad write loses the recording, never the live class.
    try {
      if (name === 'master.m3u8') stream.recorder.master(body);
      else stream.recorder.playlist(name, body, (file) => stream.files.get(file)?.body);
    } catch (err) {
      console.error(`[recording:${slug}] stopped recording ${key}:`, err.message);
      stream.recorder = null;
    }
  }
  // Segments past the window are gone from every playlist by now.
  for (const [file, entry] of stream.files) {
    if (!file.endsWith('.m3u8') && now - entry.at > KEEP_SEGMENTS_MS) stream.files.delete(file);
  }
  return true;
}

/** ffmpeg's own clean-up of an old segment. */
export function deleteFile(slug, token, name) {
  const key = ingests.get(hash(token));
  if (!key || !key.startsWith(`${slug}:`)) return false;
  streams.get(key).files.delete(name);
  return true;
}

export function getFile(slug, sessionId, name) {
  return streams.get(keyOf(slug, sessionId))?.files.get(name) ?? null;
}

/** The class ended (or moved to YouTube): its stream and upload token are gone. */
export function closeStream(slug, sessionId) {
  const key = keyOf(slug, sessionId);
  const stream = streams.get(key);
  if (!stream) return;
  ingests.delete(stream.ingestHash);
  streams.delete(key);
}

// A board that stopped without the class being ended — switched off, or offline.
setInterval(() => {
  const now = Date.now();
  for (const [key, stream] of streams) {
    if (now - stream.lastPut > IDLE_MS) {
      ingests.delete(stream.ingestHash);
      streams.delete(key);
    }
  }
}, 60_000).unref();

/* ── Watch tokens ────────────────────────────────────────────────────── */

let macKey = null;
let macKeyFor = null;

function signingKey() {
  if (macKeyFor !== config.secret) {
    macKey = Buffer.from(crypto.hkdfSync('sha256', config.secret, Buffer.alloc(0), 'coachbook live hls v1', 32));
    macKeyFor = config.secret;
  }
  return macKey;
}

/** `kind` keeps a live class's token from opening a recording with the same number, and back. */
const mac = (slug, kind, payload) => crypto.createHmac('sha256', signingKey()).update(`${slug}|${kind}|${payload}`).digest('base64url');

/** `<id>.<viewer>.<expires>.<mac>` — for this institute only, and only until it expires. */
function sign(slug, kind, id, viewerId, ttlSeconds, now) {
  const payload = `${id}.${viewerId}.${Math.floor(now / 1000) + ttlSeconds}`;
  return `${payload}.${mac(slug, kind, payload)}`;
}

/** The id a token lets its holder see, or null. Checked on every request, so no database. */
function check(slug, kind, token, now) {
  const match = /^(\d+)\.(\d+)\.(\d+)\.([\w-]{43})$/.exec(String(token ?? ''));
  if (!match) return null;
  const [, id, viewerId, expires, given] = match;
  const expected = mac(slug, kind, `${id}.${viewerId}.${expires}`);
  if (!crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))) return null;
  if (Number(expires) * 1000 < now) return null;
  return Number(id);
}

/** A student's link to a live class. */
export const watchToken = (slug, sessionId, memberId, { ttlSeconds = WATCH_TTL_S, now = Date.now() } = {}) => sign(slug, 'live', sessionId, memberId, ttlSeconds, now);
export const checkWatchToken = (slug, token, { now = Date.now() } = {}) => check(slug, 'live', token, now);

/** A link to a recorded lecture (routes/coaching/liveHls.js) — a student's, or 0 for staff checking it. */
export const recordingToken = (slug, recordingId, viewerId, { ttlSeconds = RECORDING_TTL_S, now = Date.now() } = {}) => sign(slug, 'recording', recordingId, viewerId, ttlSeconds, now);
export const checkRecordingToken = (slug, token, { now = Date.now() } = {}) => check(slug, 'recording', token, now);
