import { Router } from 'express';
import { MANAGES_BILLING, requireAuth, requireRole } from '../auth.js';
import { all, get, run } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { parse } from '../validate.js';

export const equipmentRoutes = Router();
equipmentRoutes.use(requireAuth);

const EQUIPMENT_FIELDS = {
  name: { type: 'string', required: true, min: 2, max: 80 },
  category: { type: 'string', max: 60 },
  serial_no: { type: 'string', max: 60 },
  quantity: { type: 'int', min: 1, max: 999, default: 1 },
  purchased_on: { type: 'date' },
  cost: { type: 'number', min: 0 },
  status: { type: 'enum', values: ['operational', 'maintenance', 'retired'], default: 'operational' },
  last_service_on: { type: 'date' },
  next_service_on: { type: 'date' },
  notes: { type: 'string', max: 500 },
};

equipmentRoutes.get('/', (req, res) => {
  const where = [];
  const params = [];
  if (req.query.status) {
    where.push('status = ?');
    params.push(String(req.query.status));
  }
  if (req.query.category) {
    where.push('category = ?');
    params.push(String(req.query.category));
  }
  if (req.query.due === 'true') where.push("next_service_on IS NOT NULL AND next_service_on <= date('now', '+14 day')");

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  res.json({
    items: all(`SELECT * FROM equipment ${clause} ORDER BY status, category, name`, params),
    categories: all('SELECT DISTINCT category FROM equipment WHERE category IS NOT NULL ORDER BY category').map(
      (r) => r.category,
    ),
  });
});

equipmentRoutes.post('/', requireRole(...MANAGES_BILLING), (req, res) => {
  const body = parse(req.body, EQUIPMENT_FIELDS);
  const columns = Object.keys(body);
  const info = run(
    `INSERT INTO equipment (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    columns.map((c) => body[c]),
  );
  res.status(201).json(get('SELECT * FROM equipment WHERE id = ?', [info.lastInsertRowid]));
});

equipmentRoutes.patch('/:id', requireRole(...MANAGES_BILLING), (req, res) => {
  const id = Number(req.params.id);
  if (!get('SELECT id FROM equipment WHERE id = ?', [id])) throw notFound('Equipment not found');

  const body = parse(
    req.body,
    Object.fromEntries(
      Object.entries(EQUIPMENT_FIELDS).map(([k, v]) => [k, { ...v, required: false, default: undefined }]),
    ),
  );
  const columns = Object.keys(body);
  if (!columns.length) throw badRequest('Nothing to update');

  run(`UPDATE equipment SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [
    ...columns.map((c) => body[c]),
    id,
  ]);
  res.json(get('SELECT * FROM equipment WHERE id = ?', [id]));
});

equipmentRoutes.delete('/:id', requireRole(...MANAGES_BILLING), (req, res) => {
  const info = run('DELETE FROM equipment WHERE id = ?', [Number(req.params.id)]);
  if (!info.changes) throw notFound('Equipment not found');
  res.json({ ok: true });
});
