import { utcTimestamp } from '../clock.js';
import { all, get, run, tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound, tooManyRequests } from '../errors.js';
import { broadcast, inTenant } from './liveRooms.js';

/**
 * The Doubt Box and the class chat — two lanes, so a question does not drown
 * in "hi sir" and "audio?".
 *
 * Chat goes to the whole room and is gone when the class is: it is not
 * stored. A doubt goes only to the teacher's queue, and is stored — it has
 * to outlive a reconnect, and the class's doubts are worth reading after it.
 * Students see somebody else's doubt only once the teacher pins it, and one
 * doubt is pinned at a time (a partial unique index, schema.js).
 *
 * Both lanes are on slow mode for students: one chat message, and one doubt,
 * per SLOW_MODE_MS. Only an accepted message starts the clock, so a student
 * whose doubt was turned away can fix it and send it straight back. Teachers
 * are never slowed down.
 */

export const SLOW_MODE_MS = Number(process.env.LIVE_SLOW_MODE_MS || 15_000);
/** Unanswered doubts one student can have waiting at once. */
export const MAX_OPEN_DOUBTS = 3;
const DOUBT_MAX_LENGTH = 500;
const CHAT_MAX_LENGTH = 300;

/* ── What counts as a doubt ──────────────────────────────────────────── */

const LINK = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|in|net|org|io|xyz|me|link|ly|co)\b)/i;

/** Words that make up chat rather than a question. A message made only of
 * these ("good morning sir", "ok got it", "thanku mam") belongs in chat. */
const CHATTER = new Set([
  'hi', 'hii', 'hello', 'helo', 'hlo', 'hey', 'gm', 'good', 'morning', 'afternoon', 'evening', 'night',
  'thanks', 'thank', 'thanku', 'thankyou', 'you', 'ty', 'ok', 'okay', 'k', 'yes', 'yeah', 'yup', 'no', 'nope',
  'done', 'sir', 'mam', 'maam', 'madam', 'bhaiya', 'didi', 'ji', 'namaste', 'present', 'all', 'everyone',
  'nice', 'great', 'awesome', 'super', 'understood', 'clear', 'got', 'it', 'lol', 'and', 'to', 'a', 'very', 'much',
]);

const PROBLEMS = {
  too_long: `Keep a doubt under ${DOUBT_MAX_LENGTH} characters`,
  link: 'Links are not allowed in the Doubt Box',
  too_short: 'Write out the whole question so the teacher can answer it',
  chatter: 'That looks like chat — the Doubt Box is only for questions',
};

/** Why `text` is not a doubt (a key of PROBLEMS), or null if it is one. */
export function doubtProblem(text) {
  const clean = String(text ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (clean.length > DOUBT_MAX_LENGTH) return 'too_long';
  if (LINK.test(clean)) return 'link';
  // Letters or digits in any script — a doubt in Hindi counts the same.
  const meaningful = (clean.match(/[\p{L}\p{N}]/gu) || []).length;
  if (clean.length < 8 || meaningful < 5) return 'too_short';
  // "hiiii sirrr" is "hi sir".
  const words = clean.toLowerCase().replace(/(\p{L})\1{2,}/gu, '$1').match(/[\p{L}\p{N}']+/gu) || [];
  if (words.every((w) => CHATTER.has(w.replace(/'/g, '')))) return 'chatter';
  return null;
}

/* ── Slow mode ───────────────────────────────────────────────────────── */

/** `room|member|lane` → when they were last let through. Module-level
 * rather than on the room, so leaving and rejoining does not reset it. */
const lastSent = new Map();

/**
 * Throws 429 while the student is still slowed down; otherwise returns the
 * function that starts their clock, to call once the message is accepted.
 */
function slowMode(client, lane) {
  if (client.role !== 'student') return () => {};
  const key = `${client.room.key}|${client.memberId}|${lane}`;
  const now = Date.now();
  const last = lastSent.get(key);
  if (last !== undefined && now - last < SLOW_MODE_MS) {
    const wait = SLOW_MODE_MS - (now - last);
    throw tooManyRequests(`Slow mode is on — you can send again in ${Math.ceil(wait / 1000)}s`, { code: 'slow_mode', retry_after_ms: wait });
  }
  return () => {
    lastSent.set(key, now);
    if (lastSent.size > 20_000) {
      for (const [k, at] of lastSent) if (now - at >= SLOW_MODE_MS) lastSent.delete(k);
    }
  };
}

/* ── Views ───────────────────────────────────────────────────────────── */

const DOUBT_SELECT = `
  SELECT d.id, d.session_id, d.member_id, d.body, d.pinned, d.pinned_at, d.resolved, d.resolved_at, d.created_at,
         m.first_name, m.last_name, m.code AS member_code, e.roll_number, u.name AS resolved_by_name
  FROM live_doubts d
  JOIN members m ON m.id = d.member_id
  JOIN live_sessions ls ON ls.id = d.session_id
  LEFT JOIN batch_enrollments e ON e.member_id = d.member_id AND e.batch_id = ls.batch_id
  LEFT JOIN users u ON u.id = d.resolved_by
`;

const shortName = (d) => [d.first_name, d.last_name ? `${d.last_name[0].toUpperCase()}.` : ''].filter(Boolean).join(' ');

/** The teacher's queue: who asked, by name and roll number. */
const teacherView = (d) => ({
  id: d.id,
  body: d.body,
  member_id: d.member_id,
  name: [d.first_name, d.last_name].filter(Boolean).join(' '),
  member_code: d.member_code,
  roll_number: d.roll_number,
  pinned: Boolean(d.pinned),
  pinned_at: d.pinned_at,
  resolved: Boolean(d.resolved),
  resolved_at: d.resolved_at,
  resolved_by_name: d.resolved_by_name,
  asked_at: d.created_at,
});

/** A pinned doubt on every screen in the class: first name and initial. */
const classView = (d) => ({ id: d.id, body: d.body, name: shortName(d), asked_at: d.created_at, pinned_at: d.pinned_at });

/** A student's own doubt, as they see it. */
const ownView = (d) => ({ id: d.id, body: d.body, pinned: Boolean(d.pinned), resolved: Boolean(d.resolved), asked_at: d.created_at, resolved_at: d.resolved_at });

const pinnedIn = (sessionId) => get(`${DOUBT_SELECT} WHERE d.session_id = ? AND d.pinned = 1`, [sessionId]);

/* ── Reading, for the REST routes and the join snapshot ──────────────── */

export const DOUBT_STATUSES = ['open', 'resolved', 'all'];

/** The class's doubts for its teacher: pinned first, then oldest-first. */
export function doubtsForTeacher(sessionId, status = 'open') {
  const where = { open: 'AND d.resolved = 0', resolved: 'AND d.resolved = 1', all: '' }[status];
  const items = all(
    `${DOUBT_SELECT} WHERE d.session_id = ? ${where}
     ORDER BY d.pinned DESC, d.resolved, CASE WHEN d.resolved = 0 THEN d.id END, d.resolved_at DESC, d.id`,
    [sessionId],
  ).map(teacherView);
  const counts = get('SELECT COALESCE(SUM(resolved = 0), 0) AS open, COALESCE(SUM(resolved = 1), 0) AS resolved FROM live_doubts WHERE session_id = ?', [sessionId]);
  const pinned = pinnedIn(sessionId);
  return { pinned: pinned ? teacherView(pinned) : null, items, counts };
}

/** What a student sees: the doubt pinned for the class, and their own. */
export function doubtsForStudent(sessionId, memberId) {
  const pinned = pinnedIn(sessionId);
  return {
    pinned: pinned ? classView(pinned) : null,
    mine: all(`${DOUBT_SELECT} WHERE d.session_id = ? AND d.member_id = ? ORDER BY d.id`, [sessionId, memberId]).map(ownView),
  };
}

/** The doubts part of `room:joined`, so a reconnect picks up where it was. */
export function doubtSnapshot(client) {
  return inTenant(client.room, () => {
    if (client.role === 'teacher') {
      const { pinned, items, counts } = doubtsForTeacher(client.sessionId);
      return { pinned_doubt: pinned, doubts: items, doubt_counts: counts };
    }
    const { pinned, mine } = doubtsForStudent(client.sessionId, client.memberId);
    return { pinned_doubt: pinned, my_doubts: mine };
  });
}

/* ── Events ──────────────────────────────────────────────────────────── */

/** A student's doubt, into the teacher's queue — and nowhere else. */
export function askDoubt(client, data) {
  if (client.role !== 'student') throw forbidden('Only students ask doubts');
  const room = client.room;
  const startClock = slowMode(client, 'doubt');
  const body = String(data?.body ?? '').replace(/\s+/g, ' ').trim();
  const problem = doubtProblem(body);
  if (problem) throw badRequest(PROBLEMS[problem], { code: 'not_a_doubt', reason: problem });

  const doubt = inTenant(room, () => tx(() => {
    // Checked per doubt, not just at the ticket: a student dropped from the
    // batch mid-class is out of its Doubt Box from that moment.
    const session = get(
      `SELECT ls.status, EXISTS (SELECT 1 FROM batch_enrollments e WHERE e.batch_id = ls.batch_id AND e.member_id = ? AND e.status = 'active') AS enrolled
       FROM live_sessions ls WHERE ls.id = ?`,
      [client.memberId, room.sessionId],
    );
    if (session?.status !== 'live') throw conflict('This class is not live', { code: 'session_not_live' });
    if (!session.enrolled) throw forbidden('You are not on this batch');
    const open = all('SELECT body FROM live_doubts WHERE session_id = ? AND member_id = ? AND resolved = 0', [room.sessionId, client.memberId]);
    const same = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    if (open.some((d) => same(d.body) === same(body))) throw conflict('You have already asked this', { code: 'duplicate_doubt' });
    if (open.length >= MAX_OPEN_DOUBTS) {
      throw conflict(`You have ${open.length} doubts waiting — ask again once one is answered`, { code: 'too_many_open' });
    }
    const id = run('INSERT INTO live_doubts (session_id, member_id, body, created_at) VALUES (?, ?, ?, ?)', [
      room.sessionId, client.memberId, body, utcTimestamp(),
    ]).lastInsertRowid;
    return get(`${DOUBT_SELECT} WHERE d.id = ?`, [id]);
  }));
  startClock();
  broadcast(room, 'doubt:new', teacherView(doubt), { role: 'teacher' });
  return ownView(doubt);
}

/** One of this class's doubts, for the teacher to act on. */
function teachersDoubt(client, data) {
  if (client.role !== 'teacher') throw forbidden('Only the teacher can do that');
  const id = Number(data?.doubt_id);
  // By session as well as id: a doubt from another class is "not found".
  const doubt = Number.isInteger(id) ? get('SELECT * FROM live_doubts WHERE id = ? AND session_id = ?', [id, client.room.sessionId]) : null;
  if (!doubt) throw notFound('Doubt not found');
  return doubt;
}

/** Pins a doubt on every screen in the class, replacing whatever was pinned. */
export function pinDoubt(client, data) {
  const room = client.room;
  const doubt = inTenant(room, () => tx(() => {
    const d = teachersDoubt(client, data);
    if (d.resolved) throw conflict('This doubt is already answered', { code: 'doubt_resolved' });
    run('UPDATE live_doubts SET pinned = 0 WHERE session_id = ? AND pinned = 1 AND id <> ?', [room.sessionId, d.id]);
    run('UPDATE live_doubts SET pinned = 1, pinned_at = ? WHERE id = ?', [utcTimestamp(), d.id]);
    return get(`${DOUBT_SELECT} WHERE d.id = ?`, [d.id]);
  }));
  broadcast(room, 'doubt:pinned', classView(doubt));
  return teacherView(doubt);
}

export function unpinDoubt(client, data) {
  const room = client.room;
  const id = inTenant(room, () => {
    const d = teachersDoubt(client, data);
    if (!d.pinned) throw conflict('That doubt is not pinned', { code: 'not_pinned' });
    run('UPDATE live_doubts SET pinned = 0 WHERE id = ?', [d.id]);
    return d.id;
  });
  broadcast(room, 'doubt:unpinned', { doubt_id: id });
  return { doubt_id: id };
}

/**
 * Answered. The student who asked hears so; if it was pinned, the whole
 * class does too, since it comes off their screens.
 */
export function resolveDoubt(client, data) {
  const room = client.room;
  const { doubt, wasPinned } = inTenant(room, () => tx(() => {
    const d = teachersDoubt(client, data);
    if (d.resolved) throw conflict('This doubt is already answered', { code: 'doubt_resolved' });
    run('UPDATE live_doubts SET resolved = 1, resolved_at = ?, resolved_by = ?, pinned = 0 WHERE id = ?', [utcTimestamp(), client.userId, d.id]);
    return { doubt: get(`${DOUBT_SELECT} WHERE d.id = ?`, [d.id]), wasPinned: Boolean(d.pinned) };
  }));
  const event = { doubt_id: doubt.id, was_pinned: wasPinned };
  broadcast(room, 'doubt:resolved', event, {
    to: (c) => wasPinned || c.role === 'teacher' || c.memberId === doubt.member_id,
  });
  return teacherView(doubt);
}

let chatSeq = 0;

/** Class chat: to everyone in the room, never stored. */
export function sendChat(client, data) {
  const startClock = slowMode(client, 'chat');
  const text = String(data?.text ?? '').replace(/\s+/g, ' ').trim();
  if (!text) throw badRequest('Write something first', { text: 'is required' });
  if (text.length > CHAT_MAX_LENGTH) throw badRequest(`Keep a message under ${CHAT_MAX_LENGTH} characters`, { text: 'too long' });
  startClock();
  chatSeq += 1;
  const message = { id: chatSeq, name: client.name, role: client.role, text, at: new Date().toISOString() };
  broadcast(client.room, 'chat:message', message);
  return { id: message.id, slow_mode_ms: client.role === 'student' ? SLOW_MODE_MS : 0 };
}
