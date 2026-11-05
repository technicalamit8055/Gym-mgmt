import crypto from 'node:crypto';
import { utcTimestamp } from '../clock.js';
import { all, get, run } from '../db.js';
import { notFound, unauthorized } from '../errors.js';
import { today } from '../validate.js';
import { weekdayOf } from './attendance.js';

/**
 * CoachBook Studio devices: the smartboard in a classroom that runs the
 * class controller (the studio/ Electron app).
 *
 * A board is paired to a classroom, not to a teacher. A manager registers it
 * and gets a one-time pairing code; whoever sets the board up types the code
 * in, and the board trades it for its own device token, which it keeps
 * encrypted with the OS (studio/src/tokenStore.js). The server keeps only
 * SHA-256 hashes of both — they are long random strings, so a fast hash is
 * enough, and a copy of the database is not a copy of the boards' keys.
 *
 * What a board may do follows from its room: start any lecture timetabled
 * there today, acting as that lecture's teacher; and control a class that is
 * live for a batch timetabled there today, or that it started itself.
 * Anything else is "not found", so a board learns nothing about other rooms.
 */

const TOKEN_PREFIX = 'cbs_';
export const PAIRING_TTL_MS = 15 * 60 * 1000;
// No 0/O or 1/I/L: read off a manager's phone and typed on a touch keyboard.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export const hashSecret = (secret) => crypto.createHash('sha256').update(String(secret)).digest('hex');

const normalCode = (code) => String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * A fresh pairing code for the board, shown once. Issuing one also unpairs
 * the board: its old token stops working, which is how a lost or replaced
 * board is cut off without deleting its history.
 */
export function issuePairingCode(deviceId) {
  const code = Array.from({ length: 8 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
  const expiresAt = utcTimestamp(PAIRING_TTL_MS);
  run(
    'UPDATE studio_devices SET pairing_code_hash = ?, pairing_expires_at = ?, token_hash = NULL, paired_at = NULL WHERE id = ?',
    [hashSecret(code), expiresAt, deviceId],
  );
  return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expires_at: expiresAt };
}

/** Trades a pairing code for the board's token, once. Null if the code is wrong or stale. */
export function redeemPairingCode(code) {
  const device = get('SELECT id, pairing_expires_at FROM studio_devices WHERE pairing_code_hash = ?', [hashSecret(normalCode(code))]);
  if (!device || !device.pairing_expires_at || device.pairing_expires_at < utcTimestamp()) return null;
  const token = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
  const now = utcTimestamp();
  run(
    `UPDATE studio_devices SET token_hash = ?, pairing_code_hash = NULL, pairing_expires_at = NULL, paired_at = ?, last_seen_at = ?
     WHERE id = ?`,
    [hashSecret(token), now, now, device.id],
  );
  return { token, device: deviceById(device.id) };
}

export const DEVICE_SELECT = `
  SELECT d.id, d.name, d.classroom_id, c.name AS classroom_name, d.paired_at, d.last_seen_at, d.created_at,
         (d.token_hash IS NOT NULL) AS paired, d.pairing_expires_at
  FROM studio_devices d JOIN classrooms c ON c.id = d.classroom_id
`;

export const deviceById = (id) => get(`${DEVICE_SELECT} WHERE d.id = ?`, [id]);

/**
 * Auth for the board's own API (/api/studio): its device token as a bearer.
 * A staff or member token is a signed payload, never `cbs_…`, so neither can
 * pass here — and a board's token is just as useless on their routes.
 */
export function requireStudioDevice(req, _res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const device = token.startsWith(TOKEN_PREFIX) ? get(`${DEVICE_SELECT} WHERE d.token_hash = ?`, [hashSecret(token)]) : null;
  if (!device) return next(unauthorized('This board is not paired — pair it again from CoachBook'));
  // "Last seen" on the manager's device list; at most one write a minute.
  if (!device.last_seen_at || device.last_seen_at < utcTimestamp(-60_000)) {
    run('UPDATE studio_devices SET last_seen_at = ? WHERE id = ?', [utcTimestamp(), device.id]);
  }
  req.studioDevice = device;
  return next();
}

/* ── The board's room ────────────────────────────────────────────────── */

// "Room 101" and "room 101 " are one room, as in the timetable's clash check.
const IN_ROOM = 'lower(trim(COALESCE(t.room, b.room))) = lower(trim(?))';

/** Today's lectures in the board's room, earliest first, with any class live for their batch. */
export function roomLectures(device) {
  return all(
    `SELECT t.id AS slot_id, t.batch_id, t.subject_id, t.faculty_id, t.start_time, t.end_time,
            b.name AS batch_name, b.code AS batch_code, s.name AS subject_name, u.name AS faculty_name,
            (SELECT ls.id FROM live_sessions ls WHERE ls.batch_id = t.batch_id AND ls.status = 'live') AS live_session_id
     FROM academic_timetable t
     JOIN academic_batches b ON b.id = t.batch_id AND b.active = 1
     JOIN academic_subjects s ON s.id = t.subject_id
     LEFT JOIN users u ON u.id = t.faculty_id
     WHERE t.active = 1 AND t.weekday = ? AND ${IN_ROOM}
     ORDER BY t.start_time, t.id`,
    [weekdayOf(today()), device.classroom_name],
  );
}

/**
 * Lectures a week in the board's room. Zero usually means the timetable
 * spells the room differently from the classroom, so the board lists nothing.
 */
export function roomLectureCount(device) {
  return get(
    `SELECT COUNT(*) AS n FROM academic_timetable t JOIN academic_batches b ON b.id = t.batch_id AND b.active = 1
     WHERE t.active = 1 AND ${IN_ROOM}`,
    [device.classroom_name],
  ).n;
}

/** One of today's lectures in the board's room, or 404. */
export function roomLecture(device, slotId) {
  const lecture = roomLectures(device).find((l) => l.slot_id === slotId);
  if (!lecture) throw notFound('That lecture is not in this room today');
  return lecture;
}

/**
 * A live session the board may control: one it started, or one live for a
 * batch timetabled in its room today (started from a teacher's phone, say).
 */
export function roomSession(device, sessionId) {
  const session = get(
    `SELECT ls.id, ls.batch_id, ls.faculty_id, ls.status, ls.studio_device_id, ls.youtube_broadcast_id, u.name AS faculty_name
     FROM live_sessions ls LEFT JOIN users u ON u.id = ls.faculty_id WHERE ls.id = ?`,
    [sessionId],
  );
  const mine = session && (session.studio_device_id === device.id || roomLectures(device).some((l) => l.batch_id === session.batch_id));
  if (!mine) throw notFound('Live class not found');
  return session;
}
