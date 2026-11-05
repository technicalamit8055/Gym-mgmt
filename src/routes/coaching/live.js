import express, { Router } from 'express';
import { MANAGES_BILLING, requireRole } from '../../auth.js';
import { gymDateOf, utcTimestamp } from '../../clock.js';
import { all, get, run, tenantStorage, tx } from '../../db.js';
import { badRequest, conflict, forbidden, notFound } from '../../errors.js';
import { notifyMember } from '../../notifications.js';
import { parse } from '../../validate.js';
import { requireModule } from '../../verticals.js';
import { activeRoster } from '../../coaching/attendance.js';
import { DOUBT_STATUSES, doubtsForTeacher } from '../../coaching/liveDoubts.js';
import { issueSocketTicket } from '../../coaching/liveGateway.js';
import { closeSessionRoom, liveVotes, pollResults } from '../../coaching/livePolls.js';
import { broadcastToSession } from '../../coaching/liveRooms.js';
import { stampNotesPdf } from '../../coaching/notesPdf.js';
import { formatDay } from '../../coaching/notify.js';
import { recordClass } from '../../coaching/recordings.js';
import { closeStream } from '../../coaching/selfHostedStream.js';
import { finishBroadcastLater } from '../../coaching/youtube.js';
import { MATERIAL_SELECT, MAX_MATERIAL_BYTES } from './materials.js';
import { idParam, instituteName } from './shared.js';

/**
 * Live classes: a teacher puts one batch's lecture on air, takes it off, and
 * the smartboard publishes the class's notes to the batch.
 * The student side is GET /api/portal/coaching/live/active (portal.js).
 *
 * A teacher (role 'trainer') can only go live for a batch and subject they
 * teach — allocated to it, or on its timetable — and only end their own
 * class. Managers can do either for anyone. The front desk can do neither.
 *
 * One class on air per batch and per teacher is a partial unique index
 * (schema.js); the pre-checks below only turn the constraint into a message
 * naming the class that is already live.
 */
export const liveRoutes = Router();
liveRoutes.use('/live', requireModule('live'));

const SQLITE_CONSTRAINT_UNIQUE = 2067;

const canRunClasses = requireRole(...MANAGES_BILLING, 'trainer');
const isManager = (user) => MANAGES_BILLING.includes(user?.role);

/** What staff and students both see of a session — never who created it. */
export const LIVE_SELECT = `
  SELECT ls.id, ls.batch_id, ls.subject_id, ls.faculty_id, ls.title, ls.status, ls.stream_url,
         ls.scheduled_at, ls.started_at, ls.ended_at, ls.created_at,
         b.name AS batch_name, b.code AS batch_code, s.name AS subject_name, u.name AS faculty_name
  FROM live_sessions ls
  JOIN academic_batches b ON b.id = ls.batch_id
  LEFT JOIN academic_subjects s ON s.id = ls.subject_id
  LEFT JOIN users u ON u.id = ls.faculty_id
`;

const START_FIELDS = {
  batch_id: { type: 'int', required: true, min: 1 },
  subject_id: { type: 'int', required: true, min: 1 },
  faculty_id: { type: 'int', min: 1 },
  title: { type: 'string', max: 200 },
  stream_url: { type: 'string', max: 500 },
};

/** Allocated to the batch for that subject, or timetabled to teach it. */
function teaches(facultyId, batchId, subjectId) {
  const params = [facultyId, batchId, subjectId];
  return Boolean(
    get('SELECT 1 FROM faculty_allocations WHERE faculty_id = ? AND batch_id = ? AND subject_id = ?', params)
      || get('SELECT 1 FROM academic_timetable WHERE faculty_id = ? AND batch_id = ? AND subject_id = ? AND active = 1 LIMIT 1', params),
  );
}

/** Students open this link, so only a web address — never javascript: or data:. */
export function streamUrl(value) {
  if (!value) return null;
  let url = null;
  try {
    url = new URL(value);
  } catch {
    // falls through to the 400 below
  }
  if (!url || !['https:', 'http:'].includes(url.protocol)) {
    throw badRequest('The stream link has to be a web address', { stream_url: 'must be an http(s) URL' });
  }
  return url.href;
}

function alreadyLive(batchId, facultyId) {
  const onBatch = get(`${LIVE_SELECT} WHERE ls.status = 'live' AND ls.batch_id = ?`, [batchId]);
  if (onBatch) {
    return conflict(`${onBatch.batch_name} is already live${onBatch.faculty_name ? ` with ${onBatch.faculty_name}` : ''}`, {
      code: 'batch_already_live',
      session_id: onBatch.id,
    });
  }
  const onFaculty = get(`${LIVE_SELECT} WHERE ls.status = 'live' AND ls.faculty_id = ?`, [facultyId]);
  if (onFaculty) {
    return conflict(`${onFaculty.faculty_name} is already live with ${onFaculty.batch_name} — end that class first`, {
      code: 'faculty_already_live',
      session_id: onFaculty.id,
    });
  }
  return null;
}

liveRoutes.post('/live/sessions', canRunClasses, (req, res) => {
  const body = parse(req.body, START_FIELDS);
  const manager = isManager(req.user);
  if (!manager && body.faculty_id && body.faculty_id !== req.user.id) {
    throw forbidden('A teacher can only start their own class');
  }
  const facultyId = body.faculty_id ?? req.user.id;
  if (facultyId !== req.user.id && !get('SELECT id FROM users WHERE id = ? AND active = 1', [facultyId])) {
    throw notFound('Teacher not found');
  }

  const batch = get('SELECT course_id, active FROM academic_batches WHERE id = ?', [body.batch_id]);
  if (!batch) throw notFound('Batch not found');
  if (!batch.active) throw badRequest('That batch is archived', { batch_id: 'archived' });
  if (!get('SELECT id FROM academic_subjects WHERE id = ? AND course_id = ?', [body.subject_id, batch.course_id])) {
    throw badRequest('That subject is not part of this batch’s course', { subject_id: 'mismatch' });
  }
  if (!manager && !teaches(facultyId, body.batch_id, body.subject_id)) {
    throw forbidden('You are not assigned to teach this subject to this batch');
  }

  res.status(201).json(openLiveSession({
    batchId: body.batch_id,
    subjectId: body.subject_id,
    facultyId,
    title: body.title || null,
    streamUrl: streamUrl(body.stream_url),
    createdBy: req.user.id,
  }));
});

/**
 * Puts a class on air, once whoever asked has been allowed to — shared with
 * the classroom smartboard's own route (studio.js), which records itself as
 * `studioDeviceId`.
 */
export function openLiveSession({ batchId, subjectId, facultyId, title = null, streamUrl: url = null, createdBy = null, studioDeviceId = null }) {
  const busy = alreadyLive(batchId, facultyId);
  if (busy) throw busy;
  let info;
  try {
    info = run(
      `INSERT INTO live_sessions (batch_id, subject_id, faculty_id, title, status, stream_url, started_at, created_by, studio_device_id)
       VALUES (?, ?, ?, ?, 'live', ?, ?, ?, ?)`,
      [batchId, subjectId, facultyId, title, url, utcTimestamp(), createdBy, studioDeviceId],
    );
  } catch (err) {
    if (err.errcode !== SQLITE_CONSTRAINT_UNIQUE) throw err;
    throw alreadyLive(batchId, facultyId) ?? conflict('Another class just went live for this batch');
  }
  return get(`${LIVE_SELECT} WHERE ls.id = ?`, [info.lastInsertRowid]);
}

/** The class's own teacher, or a manager — refused otherwise. */
function assertRunsClass(session, user, action) {
  if (!isManager(user) && session.faculty_id !== user.id) {
    throw forbidden(`Only the teacher taking this class, or a manager, can ${action}`);
  }
}

liveRoutes.patch('/live/sessions/:id/end', canRunClasses, (req, res) => {
  const id = idParam(req);
  const session = get('SELECT faculty_id FROM live_sessions WHERE id = ?', [id]);
  if (!session) throw notFound('Live class not found');
  assertRunsClass(session, req.user, 'end it');
  res.json(endLiveSession(id));
});

/** Takes a class off air, once whoever asked has been allowed to. */
export function endLiveSession(id) {
  const session = get('SELECT status, youtube_broadcast_id FROM live_sessions WHERE id = ?', [id]);
  if (!session) throw notFound('Live class not found');
  if (session.status !== 'live') throw conflict(session.status === 'ended' ? 'This class has already ended' : 'This class has not started');
  // The status guard makes a second, simultaneous "End" a no-op, not a new ended_at.
  const info = run("UPDATE live_sessions SET status = 'ended', ended_at = ? WHERE id = ? AND status = 'live'", [utcTimestamp(), id]);
  if (!info.changes) throw conflict('This class has already ended');
  // A poll still running is closed and saved with whatever votes it has.
  closeSessionRoom(tenantStorage.getStore().slug, id);
  // A private class served from here stops being served — first, so no late
  // upload lands in its recording once that is finished, just below.
  closeStream(tenantStorage.getStore().slug, id);
  // Its recording goes into the batch's lecture library (src/coaching/recordings.js).
  recordClass(id);
  // Its unlisted YouTube broadcast, if it had one, is ended (or deleted, if it never went on air).
  finishBroadcastLater(session.youtube_broadcast_id);
  return get(`${LIVE_SELECT} WHERE ls.id = ?`, [id]);
}

/* ── Live polls ──────────────────────────────────────────────────────── */

/** A one-time pass onto the class's socket (src/coaching/liveGateway.js). */
liveRoutes.post('/live/sessions/:id/socket-ticket', canRunClasses, (req, res) => {
  const id = idParam(req);
  const session = get('SELECT faculty_id, status FROM live_sessions WHERE id = ?', [id]);
  if (!session) throw notFound('Live class not found');
  assertRunsClass(session, req.user, 'run its polls');
  if (session.status !== 'live') throw conflict('This class is not live', { code: 'session_not_live' });
  res.json(issueSocketTicket({ sessionId: id, role: 'teacher', userId: req.user.id, name: req.user.name }));
});

/**
 * The class's Doubt Box: the pinned doubt, and the queue — `?status=open`
 * (the default), `resolved` or `all`. The same data the teacher's socket gets
 * on joining, for a screen that is not connected (or the review after class).
 * Pinning and answering happen on the socket, where the class sees them.
 */
liveRoutes.get('/live/sessions/:id/doubts', canRunClasses, (req, res) => {
  const id = idParam(req);
  const session = get('SELECT faculty_id FROM live_sessions WHERE id = ?', [id]);
  if (!session) throw notFound('Live class not found');
  assertRunsClass(session, req.user, 'see its doubts');
  const { status } = parse(req.query, { status: { type: 'enum', values: DOUBT_STATUSES, default: 'open' } });
  res.json(doubtsForTeacher(id, status));
});

const fullName = (m) => [m.first_name, m.last_name].filter(Boolean).join(' ');

/**
 * Every poll of a class with its breakdown, answer and fastest, plus how
 * each student on the batch did across them — including the ones who never
 * answered, who are the point of looking. A poll still running is counted
 * from memory, so the numbers move while it is open.
 */
liveRoutes.get('/live/sessions/:id/polls', canRunClasses, (req, res) => {
  const id = idParam(req);
  const session = get(`${LIVE_SELECT} WHERE ls.id = ?`, [id]);
  if (!session) throw notFound('Live class not found');
  assertRunsClass(session, req.user, 'see its polls');

  const roster = activeRoster(session.batch_id);
  const people = new Map(roster.map((s) => [s.member_id, { member_id: s.member_id, member_code: s.member_code, name: fullName(s), on_roster: true }]));
  const saved = all(
    `SELECT v.poll_id, v.member_id, v.choice, v.response_ms, v.id AS seq, m.first_name, m.last_name, m.code AS member_code
     FROM live_poll_votes v JOIN members m ON m.id = v.member_id
     WHERE v.poll_id IN (SELECT id FROM live_polls WHERE session_id = ?)`,
    [id],
  );
  for (const v of saved) {
    if (!people.has(v.member_id)) people.set(v.member_id, { member_id: v.member_id, member_code: v.member_code, name: fullName(v), on_roster: false });
  }
  const votesOf = (poll) => {
    const live = poll.status === 'open' ? liveVotes(tenantStorage.getStore().slug, id, poll.id) : null;
    const votes = live ?? saved.filter((v) => v.poll_id === poll.id);
    return votes.map((v) => ({ member_id: v.member_id, choice: v.choice, response_ms: v.response_ms, seq: v.seq, name: people.get(v.member_id)?.name ?? v.name }));
  };

  const tally = new Map();
  const polls = all('SELECT * FROM live_polls WHERE session_id = ? ORDER BY id', [id]).map((poll) => {
    const votes = votesOf(poll);
    const { ranked, ...results } = pollResults({ optionCount: poll.option_count, correctOption: poll.correct_option, votes });
    const fastest = ranked[0]?.member_id;
    for (const v of votes) {
      const t = tally.get(v.member_id) ?? { answered: 0, graded: 0, correct: 0, fastest: 0, total_ms: 0 };
      t.answered += 1;
      t.total_ms += v.response_ms;
      if (poll.correct_option) {
        t.graded += 1;
        if (v.choice === poll.correct_option) t.correct += 1;
      }
      if (v.member_id === fastest) t.fastest += 1;
      tally.set(v.member_id, t);
    }
    return {
      id: poll.id,
      question: poll.question,
      status: poll.status,
      duration_sec: poll.duration_sec,
      opened_at: poll.opened_at,
      closed_at: poll.closed_at,
      ...results,
      options: results.options.map((o) => ({ ...o, text: poll[`option_${o.option.toLowerCase()}`] ?? null })),
      participation: roster.length ? Math.round((results.total / roster.length) * 1000) / 10 : null,
    };
  });

  const students = [...people.values()]
    .map((p) => {
      const t = tally.get(p.member_id) ?? { answered: 0, graded: 0, correct: 0, fastest: 0, total_ms: 0 };
      return {
        ...p,
        answered: t.answered,
        correct: t.correct,
        graded: t.graded,
        fastest: t.fastest,
        avg_response_ms: t.answered ? Math.round(t.total_ms / t.answered) : null,
      };
    })
    .sort((a, b) => b.correct - a.correct || b.answered - a.answered || (a.avg_response_ms ?? Infinity) - (b.avg_response_ms ?? Infinity) || a.name.localeCompare(b.name));

  const graded = polls.filter((p) => p.correct_option && p.total);
  res.json({
    session,
    roster_size: roster.length,
    summary: {
      polls: polls.length,
      avg_accuracy: graded.length ? Math.round((graded.reduce((sum, p) => sum + p.accuracy, 0) / graded.length) * 10) / 10 : null,
      avg_participation: polls.length && roster.length
        ? Math.round((polls.reduce((sum, p) => sum + p.participation, 0) / polls.length) * 10) / 10
        : null,
      never_answered: students.filter((s) => s.on_roster && !s.answered).length,
    },
    polls,
    students,
  });
});

/* ── Class notes from the smartboard ─────────────────────────────────── */

/**
 * Tells everyone on the batch the notes are up: a row in each student's
 * notification centre, and a push to the devices they enabled. Under
 * `announcement`, so a student who silenced announcements is not pushed —
 * the notes are on their Notes & DPPs screen either way. Not awaited: the
 * board should not wait on a phone that is switched off.
 */
function announceNotes(material, session) {
  const roster = activeRoster(session.batch_id);
  const what = [session.subject_name, session.title].filter(Boolean).join(' — ') || 'Class';
  for (const student of roster) {
    notifyMember(student.member_id, {
      category: 'announcement',
      title: `${session.subject_name || 'Class'} notes are ready`,
      body: `${what} (${formatDay(session.lecture_date)})${session.faculty_name ? ` with ${session.faculty_name}` : ''}: the notes are in Notes & DPPs.`,
      screen: 'materials',
      dedupeKey: `material:${material.id}`,
      tag: `live-notes-${session.id}`,
      ttl: 24 * 60 * 60,
    }).catch(() => {});
  }
  return roster.length;
}

/**
 * The board's PDF export, as the raw request body, published to the batch:
 * stamped with the institute's header and footer (src/coaching/notesPdf.js),
 * saved as the class's `notes` material, and announced to every student on
 * the batch. `?title=` overrides the material's title.
 *
 * Sending it again — the board retrying, or the teacher re-exporting a
 * corrected copy — replaces the file (200, `replaced: true`) and does not
 * notify the batch a second time.
 */
liveRoutes.post(
  '/live/sessions/:id/publish-notes',
  canRunClasses,
  express.raw({ type: () => true, limit: MAX_MATERIAL_BYTES }),
  async (req, res) => {
    const id = idParam(req);
    const session = get('SELECT faculty_id FROM live_sessions WHERE id = ?', [id]);
    if (!session) throw notFound('Live class not found');
    assertRunsClass(session, req.user, 'publish its notes');
    const { title } = parse(req.query, { title: { type: 'string', min: 2, max: 150 } });
    const { status, body } = await publishSessionNotes(id, req.body, { title, userId: req.user.id, institute: instituteName(req) });
    res.status(status).json(body);
  },
);

/**
 * The work of publishing, once whoever sent the PDF has been allowed to:
 * shared with the classroom smartboard's own route (studio.js).
 * @returns {Promise<{status: 200|201, body: object}>}
 */
export async function publishSessionNotes(id, bytes, { title: titleOverride, userId, institute }) {
  const session = get(
    `SELECT ls.id, ls.batch_id, ls.subject_id, ls.faculty_id, ls.title, ls.status,
            ${gymDateOf('ls.started_at')} AS lecture_date,
            b.name AS batch_name, b.code AS batch_code, b.course_id, s.name AS subject_name, u.name AS faculty_name
     FROM live_sessions ls
     JOIN academic_batches b ON b.id = ls.batch_id
     LEFT JOIN academic_subjects s ON s.id = ls.subject_id
     LEFT JOIN users u ON u.id = ls.faculty_id
     WHERE ls.id = ?`,
    [id],
  );
  if (!session) throw notFound('Live class not found');
  if (session.status === 'scheduled') throw conflict('This class has not started, so it has no notes yet');
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw badRequest('Send the notes PDF as the request body', { file: 'is required' });

  const title = titleOverride
    || `${session.subject_name || 'Class'} notes${session.title ? ` — ${session.title}` : ''} (${formatDay(session.lecture_date)})`;
  const stamped = await stampNotesPdf(bytes, {
    institute,
    batch: session.batch_name,
    subject: session.subject_name,
    date: formatDay(session.lecture_date),
    teacher: session.faculty_name,
    title,
  });
  const fileName = [session.batch_code, session.subject_name, session.lecture_date, 'notes']
    .filter(Boolean).join('_').replace(/[^\w.-]+/g, '-') + '.pdf';

  // After the await, so the check and the write cannot interleave with a
  // second request for the same class; the unique index backs it anyway.
  const { materialId, replaced } = tx(() => {
    const existing = get("SELECT id FROM academic_materials WHERE live_session_id = ? AND kind = 'notes'", [id]);
    if (existing) {
      run(
        'UPDATE academic_materials SET title = ?, file_name = ?, mime = ?, bytes = ?, file_size_bytes = ?, uploaded_by = ? WHERE id = ?',
        [title, fileName, 'application/pdf', stamped.pdf, stamped.pdf.length, userId, existing.id],
      );
      return { materialId: existing.id, replaced: true };
    }
    const info = run(
      `INSERT INTO academic_materials (course_id, batch_id, subject_id, title, kind, file_name, mime, bytes, file_size_bytes, uploaded_by, live_session_id)
       VALUES (?, ?, ?, ?, 'notes', ?, 'application/pdf', ?, ?, ?, ?)`,
      [session.course_id, session.batch_id, session.subject_id, title, fileName, stamped.pdf, stamped.pdf.length, userId, id],
    );
    return { materialId: Number(info.lastInsertRowid), replaced: false };
  });

  const material = get(`${MATERIAL_SELECT} WHERE ma.id = ?`, [materialId]);
  const notified = replaced ? 0 : announceNotes(material, session);
  // Students still on the class screen see the notes appear without a refresh.
  broadcastToSession(tenantStorage.getStore().slug, id, 'notes:published', { material, replaced });
  return { status: replaced ? 200 : 201, body: { material, pages: stamped.pages, replaced, notified } };
}
