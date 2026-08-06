import { Router } from 'express';
import { MANAGES_BILLING, requireAuth, requireRole } from '../auth.js';
import { all, get, run } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { parse } from '../validate.js';

/**
 * Gym shifts (e.g. a 5am-10am morning batch, a 4pm-9pm evening batch) that
 * members can be assigned to. Purely a time window used to auto-checkout a
 * member once their shift ends — see autoCloseFinishedVisits() in
 * maintenance.js. Unrelated to the `classes` table's per-class timetable.
 */
export const sessionRoutes = Router();
sessionRoutes.use(requireAuth);

const SESSION_FIELDS = {
  name: { type: 'string', required: true, min: 1, max: 60 },
  start_time: { type: 'time', required: true },
  end_time: { type: 'time', required: true },
  active: { type: 'boolean', default: 1 },
};

sessionRoutes.get('/', (req, res) => {
  const where = req.query.active === 'true' ? 'WHERE active = 1' : '';
  res.json({ items: all(`SELECT * FROM sessions ${where} ORDER BY start_time`) });
});

sessionRoutes.post('/', requireRole(...MANAGES_BILLING), (req, res) => {
  const body = parse(req.body, SESSION_FIELDS);
  if (body.end_time <= body.start_time) {
    throw badRequest('End time must be after start time', { end_time: 'must be after the start time' });
  }

  const columns = Object.keys(body);
  const info = run(
    `INSERT INTO sessions (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    columns.map((c) => body[c]),
  );
  res.status(201).json(get('SELECT * FROM sessions WHERE id = ?', [info.lastInsertRowid]));
});

sessionRoutes.patch('/:id', requireRole(...MANAGES_BILLING), (req, res) => {
  const id = Number(req.params.id);
  const existing = get('SELECT * FROM sessions WHERE id = ?', [id]);
  if (!existing) throw notFound('Session not found');

  const body = parse(
    req.body,
    Object.fromEntries(
      Object.entries(SESSION_FIELDS).map(([k, v]) => [k, { ...v, required: false, default: undefined }]),
    ),
  );
  const columns = Object.keys(body);
  if (!columns.length) throw badRequest('Nothing to update');

  const merged = { ...existing, ...body };
  if (merged.end_time <= merged.start_time) {
    throw badRequest('End time must be after start time', { end_time: 'must be after the start time' });
  }

  run(`UPDATE sessions SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [
    ...columns.map((c) => body[c]),
    id,
  ]);
  res.json(get('SELECT * FROM sessions WHERE id = ?', [id]));
});

sessionRoutes.delete('/:id', requireRole(...MANAGES_BILLING), (req, res) => {
  const id = Number(req.params.id);
  if (get('SELECT id FROM members WHERE session_id = ?', [id])) {
    throw conflict('Members are still assigned to this session — reassign them first');
  }
  const info = run('DELETE FROM sessions WHERE id = ?', [id]);
  if (!info.changes) throw notFound('Session not found');
  res.json({ ok: true });
});
