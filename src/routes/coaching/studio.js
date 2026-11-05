import express, { Router } from 'express';
import { MANAGES_BILLING, requireRole } from '../../auth.js';
import { config } from '../../config.js';
import { all, get, run, tenantStorage } from '../../db.js';
import { HttpError, conflict, notFound, tooManyRequests, unauthorized } from '../../errors.js';
import { createLimiter } from '../../rateLimit.js';
import { parse } from '../../validate.js';
import { requireModule } from '../../verticals.js';
import { LIVE_SOCKET_PATH, issueSocketTicket } from '../../coaching/liveGateway.js';
import { broadcastToSession } from '../../coaching/liveRooms.js';
import {
  DEVICE_SELECT, deviceById, issuePairingCode, redeemPairingCode, requireStudioDevice, roomLecture, roomLectureCount, roomLectures, roomSession,
} from '../../coaching/studio.js';
import { PrivateStreamError, privateStreamForClass, privateStreamReady } from '../../coaching/privateStream.js';
import { closeStream, deleteFile, putFile } from '../../coaching/selfHostedStream.js';
import { YoutubeError, broadcastForClass, youtubeReady, youtubeStatus } from '../../coaching/youtube.js';
import { LIVE_SELECT, endLiveSession, openLiveSession, publishSessionNotes, streamUrl } from './live.js';
import { MAX_MATERIAL_BYTES } from './materials.js';
import { idParam, instituteName } from './shared.js';

/* ── Managing boards (staff, /api/coaching/studio-devices) ───────────── */

/**
 * Registering, re-pairing and removing classroom boards — managers only:
 * a paired board can start any lecture timetabled in its room.
 */
export const studioDeviceRoutes = Router();
studioDeviceRoutes.use('/studio-devices', requireModule('live'), requireRole(...MANAGES_BILLING));

studioDeviceRoutes.get('/studio-devices', (_req, res) => {
  const items = all(`${DEVICE_SELECT} ORDER BY c.name, d.name`);
  res.json({ items: items.map((d) => ({ ...d, weekly_lectures: roomLectureCount(d) })) });
});

/** Registers a board for a classroom; the pairing code is shown this once. */
studioDeviceRoutes.post('/studio-devices', (req, res) => {
  const body = parse(req.body, {
    name: { type: 'string', required: true, min: 2, max: 80 },
    classroom_id: { type: 'int', required: true, min: 1 },
  });
  if (!get('SELECT id FROM classrooms WHERE id = ?', [body.classroom_id])) throw notFound('Classroom not found');
  const id = Number(run('INSERT INTO studio_devices (name, classroom_id, created_by) VALUES (?, ?, ?)', [body.name, body.classroom_id, req.user.id]).lastInsertRowid);
  const pairing = issuePairingCode(id);
  res.status(201).json({ device: deviceById(id), pairing });
});

/** A new code — and the board's current token stops working. */
studioDeviceRoutes.post('/studio-devices/:id/pairing-code', (req, res) => {
  const id = idParam(req);
  if (!deviceById(id)) throw notFound('Board not found');
  const pairing = issuePairingCode(id);
  res.json({ device: deviceById(id), pairing });
});

studioDeviceRoutes.delete('/studio-devices/:id', (req, res) => {
  const info = run('DELETE FROM studio_devices WHERE id = ?', [idParam(req)]);
  if (!info.changes) throw notFound('Board not found');
  res.json({ ok: true });
});

/* ── The board's own API (/api/studio) ───────────────────────────────── */

export const studioRoutes = Router();
studioRoutes.use(requireModule('live'));

// A pairing code is 8 characters from 31, so guessing is hopeless anyway;
// this keeps a script from even trying.
const pairLimiter = createLimiter({ maxAttempts: config.loginMaxAttempts, windowMs: config.loginWindowMs, lockoutMs: config.loginLockoutMs });

/** Code in, device token out — the only call a board makes without one. */
studioRoutes.post('/pair', (req, res) => {
  const key = `${req.tenant?.slug}:${req.ip}`;
  const gate = pairLimiter.check(key);
  if (gate.locked) {
    res.set('Retry-After', String(gate.retryAfterSeconds));
    throw tooManyRequests('Too many wrong codes. Try again later.');
  }
  const { code } = parse(req.body, { code: { type: 'string', required: true, max: 20 } });
  const paired = redeemPairingCode(code);
  if (!paired) {
    pairLimiter.recordAttempt(key);
    throw unauthorized('That pairing code is wrong or has expired — ask for a new one');
  }
  res.json({ token: paired.token, device: paired.device, institute: instituteName(req) });
});

/**
 * A private class's video, uploaded by the board's ffmpeg as HLS
 * (src/coaching/selfHostedStream.js). ffmpeg sends no Authorization header;
 * the upload token in the path, made for this class when the board asked to
 * stream it, is the credential.
 */
const hlsUpload = express.raw({ type: () => true, limit: '16mb' });
studioRoutes.put('/hls/:token/:file', hlsUpload, (req, res) => {
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!putFile(tenantStorage.getStore().slug, req.params.token, req.params.file, body)) throw notFound('No such stream');
  res.status(201).end();
});
studioRoutes.delete('/hls/:token/:file', (req, res) => {
  if (!deleteFile(tenantStorage.getStore().slug, req.params.token, req.params.file)) throw notFound('No such stream');
  res.status(204).end();
});

studioRoutes.use(requireStudioDevice);

/**
 * How the board streams: `private_stream.on` — to its own Cloudflare input
 * (privateStream.js), first; else `youtube.connected` — an unlisted broadcast
 * per class; else a typed-in key, to the channel's public live feed.
 */
studioRoutes.get('/me', (req, res) => {
  const youtube = youtubeReady() ? { connected: true, channel_title: youtubeStatus().channel_title } : { connected: false };
  res.json({ device: req.studioDevice, institute: instituteName(req), socket_path: LIVE_SOCKET_PATH, youtube, private_stream: { on: privateStreamReady() } });
});

/** Today in this room: each lecture, and whether its batch is live now. */
studioRoutes.get('/lectures', (req, res) => {
  res.json({ classroom: req.studioDevice.classroom_name, items: roomLectures(req.studioDevice) });
});

/**
 * Goes live for one of today's lectures in this room, as its timetabled
 * teacher. If the batch is already live (the teacher started from their
 * phone), the 409 names that class, and the board joins it instead.
 */
studioRoutes.post('/sessions', (req, res) => {
  const body = parse(req.body, {
    slot_id: { type: 'int', required: true, min: 1 },
    title: { type: 'string', max: 200 },
    stream_url: { type: 'string', max: 500 },
  });
  const lecture = roomLecture(req.studioDevice, body.slot_id);
  if (!lecture.faculty_id) throw conflict('No teacher is timetabled for this lecture — set one on the timetable first', { code: 'no_teacher' });
  res.status(201).json(openLiveSession({
    batchId: lecture.batch_id,
    subjectId: lecture.subject_id,
    facultyId: lecture.faculty_id,
    title: body.title || null,
    streamUrl: streamUrl(body.stream_url),
    studioDeviceId: req.studioDevice.id,
  }));
});

/**
 * The board's own broadcast, attached to a class — when it starts streaming
 * a class the teacher went live with from their phone, or restarts its
 * stream. Students already watching switch to it without reloading.
 */
studioRoutes.patch('/sessions/:id/stream', (req, res) => {
  const session = roomSession(req.studioDevice, idParam(req));
  if (session.status !== 'live') throw conflict('This class is not live', { code: 'session_not_live' });
  const url = streamUrl(parse(req.body, { stream_url: { type: 'string', max: 500 } }).stream_url);
  run('UPDATE live_sessions SET stream_url = ?, cf_live_input_id = NULL WHERE id = ?', [url, session.id]);
  closeStream(tenantStorage.getStore().slug, session.id);
  broadcastToSession(tenantStorage.getStore().slug, session.id, 'session:stream', { stream_url: url });
  res.json(get(`${LIVE_SELECT} WHERE ls.id = ?`, [session.id]));
});

/**
 * The class's unlisted YouTube broadcast, for a board about to stream it:
 * where to send the video (`output`, with `stream_key` so the board can
 * blank it out of errors). Asked again — a restart, or a second board — it
 * reuses the broadcast while YouTube still has it open. Students already
 * watching switch to a new link without reloading.
 */
studioRoutes.post('/sessions/:id/youtube', async (req, res) => {
  const session = roomSession(req.studioDevice, idParam(req));
  if (session.status !== 'live') throw conflict('This class is not live', { code: 'session_not_live' });
  if (!youtubeReady()) throw conflict('No YouTube channel is connected in CoachBook', { code: 'youtube_not_connected' });
  const full = get(`${LIVE_SELECT} WHERE ls.id = ?`, [session.id]);
  let broadcast;
  try {
    broadcast = await broadcastForClass({ ...full, youtube_broadcast_id: session.youtube_broadcast_id }, req.studioDevice.id);
  } catch (err) {
    if (!(err instanceof YoutubeError)) throw err;
    throw new HttpError(502, err.message, { code: 'youtube_failed', reason: err.reason });
  }
  closeStream(tenantStorage.getStore().slug, session.id);
  if (broadcast.streamUrl !== full.stream_url) {
    broadcastToSession(tenantStorage.getStore().slug, session.id, 'session:stream', { stream_url: broadcast.streamUrl });
  }
  res.json({ stream_url: broadcast.streamUrl, output: broadcast.output, stream_key: broadcast.streamKey });
});

/**
 * The class streamed privately, for a board about to stream it: where to
 * send the video. There is no link for the room — the socket only tells
 * students already watching to ask for their own signed one.
 */
studioRoutes.post('/sessions/:id/private', async (req, res) => {
  const session = roomSession(req.studioDevice, idParam(req));
  if (session.status !== 'live') throw conflict('This class is not live', { code: 'session_not_live' });
  if (!privateStreamReady()) throw conflict('Private streaming is not on for this institute', { code: 'private_stream_off' });
  const { slug } = tenantStorage.getStore();
  let stream;
  try {
    stream = await privateStreamForClass(session, req.studioDevice.id, {
      slug,
      ingestBase: `${req.protocol}://${req.get('host')}${req.tenantPathPrefix || ''}/api/studio/hls`,
    });
  } catch (err) {
    if (!(err instanceof PrivateStreamError)) throw err;
    throw new HttpError(502, err.message, { code: 'private_stream_failed' });
  }
  broadcastToSession(slug, session.id, 'session:stream', { private: true });
  res.json({ hls: stream.hls ?? null, output: stream.output ?? null, stream_key: stream.streamKey });
});

studioRoutes.get('/sessions/:id', (req, res) => {
  const session = roomSession(req.studioDevice, idParam(req));
  res.json(get(`${LIVE_SELECT} WHERE ls.id = ?`, [session.id]));
});

/** The board joins the class's socket as its teacher, for polls and doubts. */
studioRoutes.post('/sessions/:id/socket-ticket', (req, res) => {
  const session = roomSession(req.studioDevice, idParam(req));
  if (session.status !== 'live') throw conflict('This class is not live', { code: 'session_not_live' });
  res.json(issueSocketTicket({ sessionId: session.id, role: 'teacher', userId: session.faculty_id, name: session.faculty_name || req.studioDevice.name }));
});

studioRoutes.patch('/sessions/:id/end', (req, res) => {
  const session = roomSession(req.studioDevice, idParam(req));
  res.json(endLiveSession(session.id));
});

/** Plenty for a lecture; enough to stop a stuck key filling the seek bar. */
const MAX_MARKERS = 100;
const sessionMarkers = (sessionId) => all('SELECT id, offset_sec, label FROM live_markers WHERE session_id = ? ORDER BY offset_sec, id', [sessionId]);

/**
 * "Next topic": a chapter marker on the class's recording, `offset_sec`
 * into it by the board's own count of its time on air. Unnamed, it is the
 * next "Topic N".
 */
studioRoutes.post('/sessions/:id/markers', (req, res) => {
  const session = roomSession(req.studioDevice, idParam(req));
  if (session.status !== 'live') throw conflict('This class is not live', { code: 'session_not_live' });
  const body = parse(req.body, {
    offset_sec: { type: 'int', required: true, min: 0, max: 24 * 3600 },
    label: { type: 'string', max: 80 },
  });
  const count = get('SELECT COUNT(*) AS n FROM live_markers WHERE session_id = ?', [session.id]).n;
  if (count >= MAX_MARKERS) throw conflict(`A class can have ${MAX_MARKERS} markers at most`, { code: 'too_many_markers' });
  const label = body.label?.trim() || `Topic ${count + 1}`;
  const id = Number(run('INSERT INTO live_markers (session_id, offset_sec, label) VALUES (?, ?, ?)', [session.id, body.offset_sec, label]).lastInsertRowid);
  res.status(201).json({ marker: { id, offset_sec: body.offset_sec, label }, items: sessionMarkers(session.id) });
});

studioRoutes.get('/sessions/:id/markers', (req, res) => {
  res.json({ items: sessionMarkers(roomSession(req.studioDevice, idParam(req)).id) });
});

/** A marker tapped by mistake. */
studioRoutes.delete('/sessions/:id/markers/:markerId', (req, res) => {
  const session = roomSession(req.studioDevice, idParam(req));
  const info = run('DELETE FROM live_markers WHERE id = ? AND session_id = ?', [Number(req.params.markerId) || 0, session.id]);
  if (!info.changes) throw notFound('Marker not found');
  res.json({ items: sessionMarkers(session.id) });
});

/** Note 3's export, published as the class's notes, uploaded by its teacher. */
studioRoutes.post(
  '/sessions/:id/publish-notes',
  express.raw({ type: () => true, limit: MAX_MATERIAL_BYTES }),
  async (req, res) => {
    const session = roomSession(req.studioDevice, idParam(req));
    const { status, body } = await publishSessionNotes(session.id, req.body, { userId: session.faculty_id, institute: instituteName(req) });
    res.status(status).json(body);
  },
);
