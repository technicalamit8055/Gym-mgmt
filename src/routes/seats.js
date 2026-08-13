import { Router } from 'express';
import { MANAGES_BILLING, requireAuth, requireRole } from '../auth.js';
import { all, get, run } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import {
  allocateSeat,
  releaseSeat,
  seatHolder,
  seatMap,
  seatVacancy,
  transferSeat,
} from '../seats.js';
import { requireModule } from '../verticals.js';
import { parse } from '../validate.js';

/** Seats, zones and the waitlist — SeatBook's own module. The allocation
 * lifecycle itself (allocate/extend/release/transfer, the concurrency-safe
 * part) lives in src/seats.js; this file is the usual CRUD-router shape
 * shared with plans.js/equipment.js, plus the map and vacancy reads. */
export const seatRoutes = Router();
seatRoutes.use(requireAuth, requireModule('seats'));

const SEAT_FIELDS = {
  code: { type: 'string', required: true, min: 1, max: 20 },
  zone_id: { type: 'int', min: 1 },
  row_label: { type: 'string', max: 10 },
  col_index: { type: 'int', min: 0 },
  seat_type: { type: 'enum', values: ['standard', 'cabin', 'ac', 'premium', 'window'], default: 'standard' },
  has_power: { type: 'boolean', default: 0 },
  status: { type: 'enum', values: ['available', 'maintenance', 'retired'], default: 'available' },
};

const ZONE_FIELDS = {
  name: { type: 'string', required: true, min: 1, max: 60 },
  sort_order: { type: 'int', default: 0 },
  active: { type: 'boolean', default: 1 },
};

const WAITLIST_FIELDS = {
  member_id: { type: 'int', min: 1 },
  name: { type: 'string', max: 80 },
  phone: { type: 'string', max: 20 },
  session_id: { type: 'int', min: 1 },
  seat_type: { type: 'string', max: 20 },
  note: { type: 'string', max: 300 },
};

const ALLOCATE_FIELDS = {
  session_id: { type: 'int', required: true, min: 1 },
  member_id: { type: 'int', required: true, min: 1 },
  subscription_id: { type: 'int', min: 1 },
  start_date: { type: 'date', required: true },
  end_date: { type: 'date', required: true },
  note: { type: 'string', max: 300 },
};

/* --------------------------------------------------------------- seats --- */

seatRoutes.get('/', (req, res) => {
  const where = [];
  const params = [];
  if (req.query.zone_id) {
    where.push('se.zone_id = ?');
    params.push(Number(req.query.zone_id));
  }
  if (req.query.status) {
    where.push('se.status = ?');
    params.push(String(req.query.status));
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  res.json({
    items: all(
      `SELECT se.*, z.name AS zone_name
       FROM seats se LEFT JOIN seat_zones z ON z.id = se.zone_id
       ${clause}
       ORDER BY se.zone_id, se.row_label, se.col_index, se.id`,
      params,
    ),
  });
});

seatRoutes.get('/map', (req, res) => {
  res.json(seatMap({ on: req.query.on ? String(req.query.on) : undefined }));
});

seatRoutes.get('/vacancy', (req, res) => {
  res.json(seatVacancy({ on: req.query.on ? String(req.query.on) : undefined }));
});

seatRoutes.post('/', requireRole(...MANAGES_BILLING), (req, res) => {
  const body = parse(req.body, SEAT_FIELDS);
  if (get('SELECT id FROM seats WHERE code = ?', [body.code])) {
    throw conflict('A seat with that code already exists');
  }
  const columns = Object.keys(body);
  const info = run(
    `INSERT INTO seats (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    columns.map((c) => body[c]),
  );
  res.status(201).json(get('SELECT * FROM seats WHERE id = ?', [info.lastInsertRowid]));
});

/**
 * The onboarding unlock — nobody hand-creates 120 desks one at a time. The
 * client computes the row/column layout (planSeats()) and posts the final
 * flat list; this endpoint just validates and inserts it as one unit.
 */
seatRoutes.post('/bulk', requireRole(...MANAGES_BILLING), (req, res) => {
  const seatsIn = Array.isArray(req.body?.seats) ? req.body.seats : [];
  if (!seatsIn.length) throw badRequest('No seats to create');
  if (seatsIn.length > 2000) throw badRequest('That is too many seats for one request');

  const zoneId = req.body?.zone_id ? Number(req.body.zone_id) : null;
  if (zoneId && !get('SELECT id FROM seat_zones WHERE id = ?', [zoneId])) throw notFound('Zone not found');

  const seenCodes = new Set();
  const rows = seatsIn.map((s, index) => {
    const code = String(s.code || '').trim();
    if (!code) throw badRequest(`Seat #${index + 1} is missing a code`);
    if (seenCodes.has(code)) throw badRequest(`Seat code "${code}" is repeated in this batch`);
    seenCodes.add(code);
    return {
      code,
      zone_id: zoneId,
      row_label: s.row_label ? String(s.row_label).trim() : null,
      col_index: Number.isInteger(s.col_index) ? s.col_index : null,
      seat_type: s.seat_type || 'standard',
      has_power: s.has_power ? 1 : 0,
    };
  });

  const existing = all(
    `SELECT code FROM seats WHERE code IN (${rows.map(() => '?').join(', ')})`,
    rows.map((r) => r.code),
  );
  if (existing.length) throw conflict(`Seat code "${existing[0].code}" already exists`);

  const insert = () => {
    let created = 0;
    for (const row of rows) {
      run(
        'INSERT INTO seats (code, zone_id, row_label, col_index, seat_type, has_power) VALUES (?, ?, ?, ?, ?, ?)',
        [row.code, row.zone_id, row.row_label, row.col_index, row.seat_type, row.has_power],
      );
      created += 1;
    }
    return created;
  };

  res.status(201).json({ created: insert() });
});

seatRoutes.patch('/:id', requireRole(...MANAGES_BILLING), (req, res) => {
  const id = Number(req.params.id);
  if (!get('SELECT id FROM seats WHERE id = ?', [id])) throw notFound('Seat not found');

  const body = parse(
    req.body,
    Object.fromEntries(Object.entries(SEAT_FIELDS).map(([k, v]) => [k, { ...v, required: false, default: undefined }])),
  );
  const columns = Object.keys(body);
  if (!columns.length) throw badRequest('Nothing to update');

  if (body.code && get('SELECT id FROM seats WHERE code = ? AND id != ?', [body.code, id])) {
    throw conflict('A seat with that code already exists');
  }

  run(`UPDATE seats SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [
    ...columns.map((c) => body[c]),
    id,
  ]);
  res.json(get('SELECT * FROM seats WHERE id = ?', [id]));
});

/** Retires rather than deletes once a seat has any allocation history — same
 * shape as plans.js archiving a plan that is still referenced. */
seatRoutes.delete('/:id', requireRole(...MANAGES_BILLING), (req, res) => {
  const id = Number(req.params.id);
  const hasHistory = get('SELECT COUNT(*) AS n FROM seat_allocations WHERE seat_id = ?', [id]).n > 0;
  if (hasHistory) {
    const info = run("UPDATE seats SET status = 'retired' WHERE id = ?", [id]);
    if (!info.changes) throw notFound('Seat not found');
    return res.json({ ok: true, retired: true, reason: 'Seat has allocation history, retired instead of deleted' });
  }
  const info = run('DELETE FROM seats WHERE id = ?', [id]);
  if (!info.changes) throw notFound('Seat not found');
  return res.json({ ok: true, retired: false });
});

/* ----------------------------------------------------------- allocation --- */

seatRoutes.post('/:id/allocate', requireRole(...MANAGES_BILLING), (req, res) => {
  const seatId = Number(req.params.id);
  const body = parse(req.body, ALLOCATE_FIELDS);
  const allocation = allocateSeat({
    seatId,
    sessionId: body.session_id,
    memberId: body.member_id,
    subscriptionId: body.subscription_id ?? null,
    startDate: body.start_date,
    endDate: body.end_date,
    note: body.note ?? null,
  });
  res.status(201).json(allocation);
});

seatRoutes.post('/:id/release', requireRole(...MANAGES_BILLING), (req, res) => {
  const seatId = Number(req.params.id);
  const body = parse(req.body, { session_id: { type: 'int', required: true, min: 1 }, reason: { type: 'string', max: 60 } });
  const holder = seatHolder(seatId, body.session_id);
  if (!holder) throw notFound('That seat is not currently allocated for this shift');
  res.json(releaseSeat(holder.id, { reason: body.reason || 'manual' }));
});

seatRoutes.post('/:id/transfer', requireRole(...MANAGES_BILLING), (req, res) => {
  const seatId = Number(req.params.id);
  const body = parse(req.body, {
    session_id: { type: 'int', required: true, min: 1 },
    to_seat_id: { type: 'int', required: true, min: 1 },
  });
  const holder = seatHolder(seatId, body.session_id);
  if (!holder) throw notFound('That seat is not currently allocated for this shift');
  res.json(transferSeat(holder.id, body.to_seat_id));
});

/* --------------------------------------------------------------- zones --- */

seatRoutes.get('/zones', (req, res) => {
  res.json({ items: all('SELECT * FROM seat_zones ORDER BY sort_order, name') });
});

seatRoutes.post('/zones', requireRole(...MANAGES_BILLING), (req, res) => {
  const body = parse(req.body, ZONE_FIELDS);
  if (get('SELECT id FROM seat_zones WHERE name = ?', [body.name])) {
    throw conflict('A zone with that name already exists');
  }
  const columns = Object.keys(body);
  const info = run(
    `INSERT INTO seat_zones (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    columns.map((c) => body[c]),
  );
  res.status(201).json(get('SELECT * FROM seat_zones WHERE id = ?', [info.lastInsertRowid]));
});

seatRoutes.patch('/zones/:id', requireRole(...MANAGES_BILLING), (req, res) => {
  const id = Number(req.params.id);
  if (!get('SELECT id FROM seat_zones WHERE id = ?', [id])) throw notFound('Zone not found');

  const body = parse(
    req.body,
    Object.fromEntries(Object.entries(ZONE_FIELDS).map(([k, v]) => [k, { ...v, required: false, default: undefined }])),
  );
  const columns = Object.keys(body);
  if (!columns.length) throw badRequest('Nothing to update');

  run(`UPDATE seat_zones SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [
    ...columns.map((c) => body[c]),
    id,
  ]);
  res.json(get('SELECT * FROM seat_zones WHERE id = ?', [id]));
});

/** Seats reference a zone with ON DELETE SET NULL, so removing a zone simply
 * un-zones its seats rather than failing — there is nothing to guard here. */
seatRoutes.delete('/zones/:id', requireRole(...MANAGES_BILLING), (req, res) => {
  const info = run('DELETE FROM seat_zones WHERE id = ?', [Number(req.params.id)]);
  if (!info.changes) throw notFound('Zone not found');
  res.json({ ok: true });
});

/* ------------------------------------------------------------ waitlist --- */

seatRoutes.get('/waitlist', (req, res) => {
  const where = req.query.status ? 'WHERE w.status = ?' : '';
  const params = req.query.status ? [String(req.query.status)] : [];
  res.json({
    items: all(
      `SELECT w.*, sess.name AS shift_name, m.first_name, m.last_name, m.code AS member_code
       FROM seat_waitlist w
       LEFT JOIN sessions sess ON sess.id = w.session_id
       LEFT JOIN members m ON m.id = w.member_id
       ${where}
       ORDER BY w.created_at`,
      params,
    ),
  });
});

seatRoutes.post('/waitlist', requireRole(...MANAGES_BILLING), (req, res) => {
  const body = parse(req.body, WAITLIST_FIELDS);
  if (!body.member_id && !body.name) throw badRequest('A walk-in enquiry needs at least a name');

  const columns = Object.keys(body);
  const info = run(
    `INSERT INTO seat_waitlist (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    columns.map((c) => body[c]),
  );
  res.status(201).json(get('SELECT * FROM seat_waitlist WHERE id = ?', [info.lastInsertRowid]));
});

seatRoutes.patch('/waitlist/:id', requireRole(...MANAGES_BILLING), (req, res) => {
  const id = Number(req.params.id);
  if (!get('SELECT id FROM seat_waitlist WHERE id = ?', [id])) throw notFound('Waitlist entry not found');

  const body = parse(req.body, {
    ...Object.fromEntries(Object.entries(WAITLIST_FIELDS).map(([k, v]) => [k, { ...v, required: false, default: undefined }])),
    status: { type: 'enum', values: ['waiting', 'offered', 'converted', 'dropped'] },
  });
  const columns = Object.keys(body);
  if (!columns.length) throw badRequest('Nothing to update');

  run(`UPDATE seat_waitlist SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [
    ...columns.map((c) => body[c]),
    id,
  ]);
  res.json(get('SELECT * FROM seat_waitlist WHERE id = ?', [id]));
});

seatRoutes.delete('/waitlist/:id', requireRole(...MANAGES_BILLING), (req, res) => {
  const info = run('DELETE FROM seat_waitlist WHERE id = ?', [Number(req.params.id)]);
  if (!info.changes) throw notFound('Waitlist entry not found');
  res.json({ ok: true });
});

/** Turns a waiting enquiry into a real allocation in one step — the seat and
 * shift the front desk just offered them, on the spot. */
seatRoutes.post('/waitlist/:id/convert', requireRole(...MANAGES_BILLING), (req, res) => {
  const id = Number(req.params.id);
  const entry = get('SELECT * FROM seat_waitlist WHERE id = ?', [id]);
  if (!entry) throw notFound('Waitlist entry not found');
  if (entry.status === 'converted') throw conflict('This entry has already been converted');
  if (!entry.member_id) throw badRequest('Convert this to a member before assigning a seat');

  const body = parse(req.body, {
    seat_id: { type: 'int', required: true, min: 1 },
    session_id: { type: 'int', required: true, min: 1 },
    subscription_id: { type: 'int', min: 1 },
    start_date: { type: 'date', required: true },
    end_date: { type: 'date', required: true },
  });

  const allocation = allocateSeat({
    seatId: body.seat_id,
    sessionId: body.session_id,
    memberId: entry.member_id,
    subscriptionId: body.subscription_id ?? null,
    startDate: body.start_date,
    endDate: body.end_date,
  });
  run("UPDATE seat_waitlist SET status = 'converted' WHERE id = ?", [id]);
  res.status(201).json(allocation);
});
