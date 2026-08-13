import { Router } from 'express';
import { MANAGES_BILLING, requireAuth, requireRole } from '../auth.js';
import { all, get, run } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { releaseLapsedLockerAllocations } from '../maintenance.js';
import { parse, today } from '../validate.js';
import { requireModule } from '../verticals.js';

/**
 * Lockers, tracked the same shape as seats minus the shift: one live
 * allocation per locker (idx_locker_alloc_live, a partial unique index),
 * released the moment a student leaves rather than sitting in a spreadsheet.
 */
export const lockerRoutes = Router();
lockerRoutes.use(requireAuth, requireModule('lockers'));

const LOCKER_FIELDS = {
  code: { type: 'string', required: true, min: 1, max: 20 },
  zone_id: { type: 'int', min: 1 },
  monthly_fee: { type: 'number', min: 0, default: 0 },
  status: { type: 'enum', values: ['available', 'maintenance', 'retired'], default: 'available' },
};

const LOCKER_SELECT = `
  SELECT lk.*, z.name AS zone_name,
         la.id AS allocation_id, la.member_id, la.end_date AS held_until,
         la.fee, la.deposit, la.key_issued,
         m.code AS member_code, m.first_name, m.last_name
  FROM lockers lk
  LEFT JOIN seat_zones z ON z.id = lk.zone_id
  LEFT JOIN locker_allocations la ON la.locker_id = lk.id AND la.status = 'active'
  LEFT JOIN members m ON m.id = la.member_id
`;

lockerRoutes.get('/', (req, res) => {
  releaseLapsedLockerAllocations();
  const where = req.query.status ? 'WHERE lk.status = ?' : '';
  const params = req.query.status ? [String(req.query.status)] : [];
  const items = all(`${LOCKER_SELECT} ${where} ORDER BY lk.zone_id, lk.code`, params);
  res.json({
    items,
    totals: {
      total: items.length,
      occupied: items.filter((l) => l.allocation_id).length,
      available: items.filter((l) => l.status === 'available' && !l.allocation_id).length,
    },
  });
});

lockerRoutes.post('/', requireRole(...MANAGES_BILLING), (req, res) => {
  const body = parse(req.body, LOCKER_FIELDS);
  if (get('SELECT id FROM lockers WHERE code = ?', [body.code])) {
    throw conflict('A locker with that code already exists');
  }
  const columns = Object.keys(body);
  const info = run(
    `INSERT INTO lockers (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    columns.map((c) => body[c]),
  );
  res.status(201).json(get('SELECT * FROM lockers WHERE id = ?', [info.lastInsertRowid]));
});

lockerRoutes.patch('/:id', requireRole(...MANAGES_BILLING), (req, res) => {
  const id = Number(req.params.id);
  if (!get('SELECT id FROM lockers WHERE id = ?', [id])) throw notFound('Locker not found');

  const body = parse(
    req.body,
    Object.fromEntries(Object.entries(LOCKER_FIELDS).map(([k, v]) => [k, { ...v, required: false, default: undefined }])),
  );
  const columns = Object.keys(body);
  if (!columns.length) throw badRequest('Nothing to update');

  if (body.code && get('SELECT id FROM lockers WHERE code = ? AND id != ?', [body.code, id])) {
    throw conflict('A locker with that code already exists');
  }

  run(`UPDATE lockers SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [
    ...columns.map((c) => body[c]),
    id,
  ]);
  res.json(get('SELECT * FROM lockers WHERE id = ?', [id]));
});

lockerRoutes.delete('/:id', requireRole(...MANAGES_BILLING), (req, res) => {
  const id = Number(req.params.id);
  const hasHistory = get('SELECT COUNT(*) AS n FROM locker_allocations WHERE locker_id = ?', [id]).n > 0;
  if (hasHistory) {
    const info = run("UPDATE lockers SET status = 'retired' WHERE id = ?", [id]);
    if (!info.changes) throw notFound('Locker not found');
    return res.json({ ok: true, retired: true, reason: 'Locker has allocation history, retired instead of deleted' });
  }
  const info = run('DELETE FROM lockers WHERE id = ?', [id]);
  if (!info.changes) throw notFound('Locker not found');
  return res.json({ ok: true, retired: false });
});

lockerRoutes.post('/:id/allocate', requireRole(...MANAGES_BILLING), (req, res) => {
  releaseLapsedLockerAllocations();
  const lockerId = Number(req.params.id);
  const body = parse(req.body, {
    member_id: { type: 'int', required: true, min: 1 },
    subscription_id: { type: 'int', min: 1 },
    start_date: { type: 'date', required: true },
    end_date: { type: 'date', required: true },
    fee: { type: 'number', min: 0, default: 0 },
    deposit: { type: 'number', min: 0, default: 0 },
    key_issued: { type: 'boolean', default: 0 },
  });

  const locker = get('SELECT * FROM lockers WHERE id = ?', [lockerId]);
  if (!locker) throw notFound('Locker not found');
  if (locker.status !== 'available') throw badRequest('That locker is not available');

  const holder = get(
    `SELECT m.first_name, m.last_name, m.code AS member_code, la.end_date
     FROM locker_allocations la JOIN members m ON m.id = la.member_id
     WHERE la.locker_id = ? AND la.status = 'active'`,
    [lockerId],
  );
  if (holder) {
    throw conflict(
      `Locker ${locker.code} is held by ${holder.first_name} ${holder.last_name} (${holder.member_code}) until ${holder.end_date}`,
    );
  }

  const info = run(
    `INSERT INTO locker_allocations (locker_id, member_id, subscription_id, start_date, end_date, fee, deposit, key_issued)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [lockerId, body.member_id, body.subscription_id ?? null, body.start_date, body.end_date, body.fee, body.deposit, body.key_issued],
  );
  res.status(201).json(get('SELECT * FROM locker_allocations WHERE id = ?', [info.lastInsertRowid]));
});

lockerRoutes.post('/:id/release', requireRole(...MANAGES_BILLING), (req, res) => {
  const lockerId = Number(req.params.id);
  const allocation = get("SELECT id FROM locker_allocations WHERE locker_id = ? AND status = 'active'", [lockerId]);
  if (!allocation) throw notFound('That locker is not currently allocated');

  run("UPDATE locker_allocations SET status = 'released', released_on = ?, released_reason = 'manual' WHERE id = ?", [
    today(),
    allocation.id,
  ]);
  res.json(get('SELECT * FROM locker_allocations WHERE id = ?', [allocation.id]));
});
