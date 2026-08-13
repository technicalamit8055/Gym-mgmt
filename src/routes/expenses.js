import { Router } from 'express';
import { MANAGES_BILLING, requireAuth, requireRole } from '../auth.js';
import { all, get, run } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { parse, startOfMonth, today } from '../validate.js';
import { requireModule } from '../verticals.js';

/** What goes out, not just what comes in — rent, electricity, wifi, staff.
 * `category` is free text with a suggested list on the client, not a CHECK:
 * widening a CHECK means rebuilding the table, and an expense category list
 * is exactly the kind of thing a hall owner wants to extend on their own. */
export const expenseRoutes = Router();
expenseRoutes.use(requireAuth, requireModule('expenses'));

const EXPENSE_FIELDS = {
  category: { type: 'string', required: true, min: 1, max: 60 },
  amount: { type: 'number', required: true, min: 0.01 },
  spent_on: { type: 'date' },
  method: { type: 'enum', values: ['cash', 'card', 'upi', 'bank', 'online'], default: 'cash' },
  vendor: { type: 'string', max: 120 },
  note: { type: 'string', max: 300 },
  recurring: { type: 'boolean', default: 0 },
};

expenseRoutes.get('/', (req, res) => {
  const where = [];
  const params = [];
  if (req.query.category) {
    where.push('category = ?');
    params.push(String(req.query.category));
  }
  if (req.query.from) {
    where.push('spent_on >= ?');
    params.push(String(req.query.from));
  }
  if (req.query.to) {
    where.push('spent_on <= ?');
    params.push(String(req.query.to));
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const items = all(`SELECT * FROM expenses ${clause} ORDER BY spent_on DESC, id DESC`, params);
  res.json({
    items,
    categories: all('SELECT DISTINCT category FROM expenses ORDER BY category').map((r) => r.category),
    totals: { total: items.reduce((sum, e) => sum + e.amount, 0), count: items.length },
  });
});

/** Collected vs. spent for a period — defaults to the current month, the
 * strip the dashboard reuses verbatim. */
expenseRoutes.get('/summary', (req, res) => {
  const from = req.query.from ? String(req.query.from) : startOfMonth(today());
  const to = req.query.to ? String(req.query.to) : today();

  const spent = get('SELECT COALESCE(SUM(amount), 0) AS total FROM expenses WHERE spent_on BETWEEN ? AND ?', [from, to]);
  const collected = get('SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE paid_on BETWEEN ? AND ?', [from, to]);
  const byCategory = all(
    'SELECT category, COALESCE(SUM(amount), 0) AS total FROM expenses WHERE spent_on BETWEEN ? AND ? GROUP BY category ORDER BY total DESC',
    [from, to],
  );

  res.json({
    from,
    to,
    collected: collected.total,
    spent: spent.total,
    net: collected.total - spent.total,
    by_category: byCategory,
  });
});

expenseRoutes.post('/', requireRole(...MANAGES_BILLING), (req, res) => {
  const body = parse(req.body, EXPENSE_FIELDS);
  const spentOn = body.spent_on || today();
  const info = run(
    'INSERT INTO expenses (category, amount, spent_on, method, vendor, note, recurring, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [body.category, body.amount, spentOn, body.method, body.vendor ?? null, body.note ?? null, body.recurring, req.user.id],
  );
  res.status(201).json(get('SELECT * FROM expenses WHERE id = ?', [info.lastInsertRowid]));
});

expenseRoutes.patch('/:id', requireRole(...MANAGES_BILLING), (req, res) => {
  const id = Number(req.params.id);
  if (!get('SELECT id FROM expenses WHERE id = ?', [id])) throw notFound('Expense not found');

  const body = parse(
    req.body,
    Object.fromEntries(Object.entries(EXPENSE_FIELDS).map(([k, v]) => [k, { ...v, required: false, default: undefined }])),
  );
  const columns = Object.keys(body);
  if (!columns.length) throw badRequest('Nothing to update');

  run(`UPDATE expenses SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [
    ...columns.map((c) => body[c]),
    id,
  ]);
  res.json(get('SELECT * FROM expenses WHERE id = ?', [id]));
});

expenseRoutes.delete('/:id', requireRole(...MANAGES_BILLING), (req, res) => {
  const info = run('DELETE FROM expenses WHERE id = ?', [Number(req.params.id)]);
  if (!info.changes) throw notFound('Expense not found');
  res.json({ ok: true });
});
