import { Router } from 'express';
import { MANAGES_BILLING, requireRole } from '../../auth.js';
import { all, get, run } from '../../db.js';
import { badRequest, conflict, forbidden, notFound } from '../../errors.js';
import { parse, today } from '../../validate.js';
import { requireModule } from '../../verticals.js';
import { SLOT_SELECT, allConflicts, capacityWarnings, describeConflict, findConflicts } from '../../coaching/timetable.js';
import { dateQuery, idParam, idQuery, optional } from './shared.js';

/**
 * The weekly master timetable and the lecture log.
 *
 * A slot that would double-book a teacher, a room or a batch is refused with
 * 409 and the list of what it collides with (`details.conflicts`); sending it
 * again with `override: true` saves it anyway — a planned combined class is
 * a real thing — and the clash stays visible on the "check the week" list.
 */
export const timetableRoutes = Router();
timetableRoutes.use(['/timetable', '/lecture-logs'], requireModule('timetable'));

const managers = requireRole(...MANAGES_BILLING);

const SLOT_FIELDS = {
  batch_id: { type: 'int', required: true, min: 1 },
  subject_id: { type: 'int', required: true, min: 1 },
  faculty_id: { type: 'int', min: 1 },
  weekday: { type: 'int', required: true, min: 0, max: 6 },
  start_time: { type: 'time', required: true },
  end_time: { type: 'time', required: true },
  room: { type: 'string', max: 40 },
  active: { type: 'boolean' },
};

function checkSlot(slot) {
  if (slot.end_time <= slot.start_time) throw badRequest('The lecture has to end after it starts', { end_time: 'before start' });
  const batch = get('SELECT course_id FROM academic_batches WHERE id = ?', [slot.batch_id]);
  if (!batch) throw notFound('Batch not found');
  if (!get('SELECT id FROM academic_subjects WHERE id = ? AND course_id = ?', [slot.subject_id, batch.course_id])) {
    throw badRequest('That subject is not part of this batch’s course', { subject_id: 'mismatch' });
  }
  if (slot.faculty_id && !get('SELECT id FROM users WHERE id = ? AND active = 1', [slot.faculty_id])) throw notFound('Teacher not found');
}

function refuseConflicts(slot, excludeId, override) {
  const conflicts = findConflicts(slot, { excludeId });
  if (conflicts.length && !override) {
    throw conflict(`This clashes with ${conflicts.length === 1 ? 'another lecture' : `${conflicts.length} lectures`}: ${describeConflict(conflicts[0])}`, {
      code: 'timetable_conflict',
      conflicts: conflicts.map((c) => ({ id: c.id, reasons: c.reasons, text: describeConflict(c) })),
    });
  }
  return conflicts;
}

timetableRoutes.get('/timetable', (req, res) => {
  const where = ['t.active = 1', 'b.active = 1'];
  const params = [];
  const batchId = idQuery(req, 'batch_id');
  const facultyId = idQuery(req, 'faculty_id');
  if (batchId) {
    where.push('t.batch_id = ?');
    params.push(batchId);
  }
  if (facultyId) {
    where.push('t.faculty_id = ?');
    params.push(facultyId);
  }
  if (req.query.room) {
    where.push('COALESCE(t.room, b.room) = ? COLLATE NOCASE');
    params.push(String(req.query.room));
  }
  const items = all(`${SLOT_SELECT} WHERE ${where.join(' AND ')} ORDER BY t.weekday, t.start_time, b.name`, params);
  const clashes = allConflicts();
  const clashing = new Set(clashes.flatMap((c) => [c.a.id, c.b.id]));
  res.json({
    items: items.map((slot) => ({ ...slot, has_conflict: clashing.has(slot.id) })),
    conflicts: clashes.map((c) => ({
      a_id: c.a.id,
      b_id: c.b.id,
      reasons: c.reasons,
      text: describeConflict({ ...c.b, reasons: c.reasons }),
      with: `${c.a.batch_name} · ${c.a.subject_name}`,
    })),
  });
});

timetableRoutes.post('/timetable', managers, (req, res) => {
  const body = parse(req.body, SLOT_FIELDS);
  checkSlot(body);
  const override = req.body?.override === true;
  const conflicts = refuseConflicts(body, null, override);
  const info = run(
    'INSERT INTO academic_timetable (batch_id, subject_id, faculty_id, weekday, start_time, end_time, room) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [body.batch_id, body.subject_id, body.faculty_id ?? null, body.weekday, body.start_time, body.end_time, body.room || null],
  );
  res.status(201).json({
    ...get(`${SLOT_SELECT} WHERE t.id = ?`, [info.lastInsertRowid]),
    overridden_conflicts: conflicts.map(describeConflict),
    warnings: capacityWarnings(body),
  });
});

timetableRoutes.patch('/timetable/:id', managers, (req, res) => {
  const id = idParam(req);
  const current = get('SELECT * FROM academic_timetable WHERE id = ?', [id]);
  if (!current) throw notFound('Lecture not found');
  const body = parse(req.body, optional(SLOT_FIELDS));
  const merged = { ...current, ...body };
  checkSlot(merged);
  const conflicts = merged.active ? refuseConflicts(merged, id, req.body?.override === true) : [];
  const columns = Object.keys(body);
  if (!columns.length) throw badRequest('Nothing to update');
  run(`UPDATE academic_timetable SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [...columns.map((c) => body[c]), id]);
  res.json({ ...get(`${SLOT_SELECT} WHERE t.id = ?`, [id]), overridden_conflicts: conflicts.map(describeConflict), warnings: capacityWarnings(merged) });
});

timetableRoutes.delete('/timetable/:id', managers, (req, res) => {
  const info = run('DELETE FROM academic_timetable WHERE id = ?', [idParam(req)]);
  if (!info.changes) throw notFound('Lecture not found');
  res.json({ ok: true });
});

/** Dry run: what a slot would clash with, for the form to warn as you type. */
timetableRoutes.post('/timetable/check', (req, res) => {
  const body = parse(req.body, SLOT_FIELDS);
  if (body.end_time <= body.start_time) return res.json({ conflicts: [], warnings: [] });
  const conflicts = findConflicts(body, { excludeId: Number(req.body?.id) || null });
  res.json({ conflicts: conflicts.map((c) => ({ id: c.id, reasons: c.reasons, text: describeConflict(c) })), warnings: capacityWarnings(body) });
});

/* ── Lecture log (syllabus tracker) ──────────────────────────────────── */

const LOG_FIELDS = {
  batch_id: { type: 'int', required: true, min: 1 },
  subject_id: { type: 'int', min: 1 },
  faculty_id: { type: 'int', min: 1 },
  lecture_date: { type: 'date' },
  topic: { type: 'string', required: true, min: 2, max: 200 },
  notes: { type: 'string', max: 2000 },
  duration_min: { type: 'int', min: 1, max: 600 },
};

const LOG_SELECT = `
  SELECT l.*, b.name AS batch_name, s.name AS subject_name, u.name AS faculty_name
  FROM lecture_logs l
  JOIN academic_batches b ON b.id = l.batch_id
  LEFT JOIN academic_subjects s ON s.id = l.subject_id
  LEFT JOIN users u ON u.id = l.faculty_id
`;

timetableRoutes.get('/lecture-logs', (req, res) => {
  const where = ['l.lecture_date BETWEEN ? AND ?'];
  const params = [dateQuery(req, 'from', `${today().slice(0, 7)}-01`), dateQuery(req, 'to', today())];
  for (const [key, column] of [['batch_id', 'l.batch_id'], ['subject_id', 'l.subject_id'], ['faculty_id', 'l.faculty_id']]) {
    const value = idQuery(req, key);
    if (value) {
      where.push(`${column} = ?`);
      params.push(value);
    }
  }
  res.json({ items: all(`${LOG_SELECT} WHERE ${where.join(' AND ')} ORDER BY l.lecture_date DESC, l.id DESC LIMIT 500`, params) });
});

/**
 * Logging a lecture. `faculty_id` defaults to whoever is signed in when they
 * are a teacher, and `duration_min` to the timetabled length of that
 * subject's lecture that weekday — what an hourly teacher is paid against.
 */
timetableRoutes.post('/lecture-logs', (req, res) => {
  const body = parse(req.body, LOG_FIELDS);
  const date = body.lecture_date || today();
  if (date > today()) throw badRequest('A lecture cannot be logged for a future date', { lecture_date: 'in the future' });
  const batch = get('SELECT course_id FROM academic_batches WHERE id = ?', [body.batch_id]);
  if (!batch) throw notFound('Batch not found');
  if (body.subject_id && !get('SELECT id FROM academic_subjects WHERE id = ? AND course_id = ?', [body.subject_id, batch.course_id])) {
    throw badRequest('That subject is not part of this batch’s course', { subject_id: 'mismatch' });
  }
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  const slot = body.subject_id
    ? get(
        'SELECT faculty_id, start_time, end_time FROM academic_timetable WHERE batch_id = ? AND subject_id = ? AND weekday = ? AND active = 1 ORDER BY start_time LIMIT 1',
        [body.batch_id, body.subject_id, weekday],
      )
    : null;
  const minutes = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const facultyId = body.faculty_id ?? slot?.faculty_id ?? (req.user?.role === 'trainer' ? req.user.id : null);
  const duration = body.duration_min ?? (slot ? minutes(slot.end_time) - minutes(slot.start_time) : null);
  const info = run(
    `INSERT INTO lecture_logs (batch_id, subject_id, faculty_id, lecture_date, topic, notes, duration_min, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [body.batch_id, body.subject_id ?? null, facultyId, date, body.topic, body.notes ?? null, duration, req.user?.id ?? null],
  );
  res.status(201).json(get(`${LOG_SELECT} WHERE l.id = ?`, [info.lastInsertRowid]));
});

timetableRoutes.delete('/lecture-logs/:id', (req, res) => {
  const id = idParam(req);
  const log = get('SELECT created_by FROM lecture_logs WHERE id = ?', [id]);
  if (!log) throw notFound('Lecture log not found');
  if (log.created_by !== req.user?.id && !MANAGES_BILLING.includes(req.user?.role)) {
    throw forbidden('Only whoever logged this lecture, or a manager, can delete it');
  }
  run('DELETE FROM lecture_logs WHERE id = ?', [id]);
  res.json({ ok: true });
});
