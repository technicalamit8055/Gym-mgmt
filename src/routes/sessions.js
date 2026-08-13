import { Router } from 'express';
import { MANAGES_BILLING, requireAuth, requireRole } from '../auth.js';
import { all, get, run } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { parse } from '../validate.js';

/**
 * Gym shifts (e.g. a 5am-10am morning batch, a 4pm-9pm evening batch) — or, for
 * a library tenant, the shifts a seat is sold by (Morning/Evening/Night).
 * Purely a time window: for a gym it drives auto-checkout once the shift ends
 * (autoCloseFinishedVisits() in maintenance.js); for a library it is what
 * seat_allocations.session_id points at. Genuinely shared, so this router is
 * never gated behind requireModule. Unrelated to the `classes` table's
 * per-class timetable.
 */
export const sessionRoutes = Router();
sessionRoutes.use(requireAuth);

const SESSION_FIELDS = {
  name: { type: 'string', required: true, min: 1, max: 60 },
  start_time: { type: 'time', required: true },
  end_time: { type: 'time', required: true },
  active: { type: 'boolean', default: 1 },
  // Below this line: meaningful to a library's shift-priced passes, unused by
  // a gym's plain batches (price defaults to 0, the rest stay null/0).
  price: { type: 'number', min: 0, default: 0 },
  capacity: { type: 'int', min: 1, max: 100000 },
  code: { type: 'string', max: 8 },
  sort_order: { type: 'int', default: 0 },
};

/** A shift that runs past midnight (22:00-06:00) has end_time <= start_time —
 * indistinguishable, on the clock alone, from a plain input mistake. Treat it
 * as overnight rather than rejecting it; see the auto-checkout fix in
 * maintenance.js that this flag exists for. */
function withOvernight(body) {
  return { ...body, overnight: body.end_time <= body.start_time ? 1 : 0 };
}

sessionRoutes.get('/', (req, res) => {
  const where = req.query.active === 'true' ? 'WHERE active = 1' : '';
  res.json({ items: all(`SELECT * FROM sessions ${where} ORDER BY sort_order, start_time`) });
});

sessionRoutes.post('/', requireRole(...MANAGES_BILLING), (req, res) => {
  const body = withOvernight(parse(req.body, SESSION_FIELDS));
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

  const merged = withOvernight({ ...existing, ...body });
  const finalColumns = [...columns, 'overnight'];
  run(`UPDATE sessions SET ${finalColumns.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [
    ...finalColumns.map((c) => merged[c]),
    id,
  ]);
  res.json(get('SELECT * FROM sessions WHERE id = ?', [id]));
});

sessionRoutes.delete('/:id', requireRole(...MANAGES_BILLING), (req, res) => {
  const id = Number(req.params.id);
  if (get('SELECT id FROM members WHERE session_id = ?', [id])) {
    throw conflict('Members are still assigned to this session — reassign them first');
  }
  if (get('SELECT id FROM subscriptions WHERE session_id = ? AND status IN (\'active\', \'frozen\')', [id])) {
    throw conflict('Active passes are sold for this shift — end or reassign them first');
  }
  if (get('SELECT id FROM plans WHERE session_id = ?', [id])) {
    throw conflict('A plan is locked to this shift — unlock or remove it first');
  }
  if (get("SELECT id FROM seat_allocations WHERE session_id = ? AND status = 'active'", [id])) {
    throw conflict('Seats are still allocated for this shift — release them first');
  }
  const info = run('DELETE FROM sessions WHERE id = ?', [id]);
  if (!info.changes) throw notFound('Session not found');
  res.json({ ok: true });
});
