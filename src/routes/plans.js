import { Router } from 'express';
import { MANAGES_BILLING, requireAuth, requireRole } from '../auth.js';
import { all, get, run } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { parse } from '../validate.js';

export const planRoutes = Router();
planRoutes.use(requireAuth);

const PLAN_FIELDS = {
  name: { type: 'string', required: true, min: 2, max: 80 },
  description: { type: 'string', max: 500 },
  price: { type: 'number', required: true, min: 0 },
  duration_days: { type: 'int', required: true, min: 1, max: 3650 },
  sessions: { type: 'int', min: 1, max: 1000 },
  // Bundles the Diet & Workout tracker into this plan, so a premium
  // membership carries it without a separate monthly add-on — see
  // fitnessAccessFor() in src/fitness.js.
  includes_fitness_addon: { type: 'boolean', default: 0 },
  active: { type: 'boolean', default: 1 },
};

planRoutes.get('/', (req, res) => {
  const clause = req.query.active === 'true' ? 'WHERE p.active = 1' : '';
  res.json({
    items: all(`
      SELECT p.*, COALESCE(s.members, 0) AS active_members
      FROM plans p
      LEFT JOIN (
        SELECT plan_id, COUNT(DISTINCT member_id) AS members
        FROM subscriptions WHERE status = 'active' GROUP BY plan_id
      ) s ON s.plan_id = p.id
      ${clause}
      ORDER BY p.active DESC, p.price
    `),
  });
});

planRoutes.post('/', requireRole(...MANAGES_BILLING), (req, res) => {
  const body = parse(req.body, PLAN_FIELDS);
  if (get('SELECT id FROM plans WHERE name = ?', [body.name])) {
    throw conflict('A plan with that name already exists');
  }
  const columns = Object.keys(body);
  const info = run(
    `INSERT INTO plans (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    columns.map((c) => body[c]),
  );
  res.status(201).json(get('SELECT * FROM plans WHERE id = ?', [info.lastInsertRowid]));
});

planRoutes.patch('/:id', requireRole(...MANAGES_BILLING), (req, res) => {
  const id = Number(req.params.id);
  if (!get('SELECT id FROM plans WHERE id = ?', [id])) throw notFound('Plan not found');

  const body = parse(
    req.body,
    Object.fromEntries(Object.entries(PLAN_FIELDS).map(([k, v]) => [k, { ...v, required: false, default: undefined }])),
  );
  const columns = Object.keys(body);
  if (!columns.length) throw badRequest('Nothing to update');

  run(`UPDATE plans SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [
    ...columns.map((c) => body[c]),
    id,
  ]);
  res.json(get('SELECT * FROM plans WHERE id = ?', [id]));
});

planRoutes.delete('/:id', requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  const inUse = get('SELECT COUNT(*) AS n FROM subscriptions WHERE plan_id = ?', [id]);
  if (inUse.n > 0) {
    run('UPDATE plans SET active = 0 WHERE id = ?', [id]);
    return res.json({ ok: true, archived: true, reason: 'Plan is in use, archived instead of deleted' });
  }
  const info = run('DELETE FROM plans WHERE id = ?', [id]);
  if (!info.changes) throw notFound('Plan not found');
  return res.json({ ok: true, archived: false });
});
