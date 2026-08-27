import { Router } from 'express';
import { MANAGES_BILLING, requireAuth, requireRole } from '../auth.js';
import { all, get, run, tx } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { activateFitnessAddon, expireLapsedFitnessAddons, fitnessAccessFor, fitnessSettings } from '../fitness.js';
import { parse, today, toInt } from '../validate.js';
import { requireModule } from '../verticals.js';

/**
 * Selling the Diet & Workout tracker as a monthly add-on.
 *
 * This is the money side of the feature, so unlike workouts.js and diets.js it
 * sits behind MANAGES_BILLING: a trainer writes the programme, the desk takes
 * the payment. Reading a member's entitlement is open to every staff role —
 * a trainer needs to know whether the member they are programming for can
 * actually see it.
 */
export const fitnessAddonRoutes = Router();
fitnessAddonRoutes.use(requireAuth, requireModule('fitness'));

const SETTINGS_FIELDS = {
  enabled: { type: 'boolean' },
  monthly_price: { type: 'number', min: 0, max: 1000000 },
  trial_days: { type: 'int', min: 0, max: 365 },
  description: { type: 'string', max: 500 },
};

fitnessAddonRoutes.get('/settings', (_req, res) => {
  expireLapsedFitnessAddons();
  res.json({
    settings: fitnessSettings(),
    stats: get(`
      SELECT COUNT(*) AS active_subscribers,
             COALESCE(SUM(price), 0) AS lifetime_revenue
      FROM member_fitness_addons WHERE status = 'active'
    `),
    bundled_plans: all('SELECT id, name FROM plans WHERE includes_fitness_addon = 1 AND active = 1 ORDER BY name'),
  });
});

fitnessAddonRoutes.put('/settings', requireRole(...MANAGES_BILLING), (req, res) => {
  const body = parse(req.body, SETTINGS_FIELDS);
  const columns = Object.keys(body);
  if (!columns.length) throw badRequest('Nothing to update');

  run(
    `UPDATE fitness_addon_settings SET ${columns.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now')
     WHERE id = 1`,
    columns.map((c) => body[c]),
  );
  res.json({ settings: fitnessSettings() });
});

/** Everyone currently paying for the add-on, for the desk's own list. */
fitnessAddonRoutes.get('/', (req, res) => {
  expireLapsedFitnessAddons();
  const status = req.query.status ? String(req.query.status) : 'active';
  res.json({
    items: all(
      `SELECT fa.*, m.code AS member_code, m.first_name, m.last_name, m.phone, u.name AS sold_by
       FROM member_fitness_addons fa
       JOIN members m ON m.id = fa.member_id
       LEFT JOIN users u ON u.id = fa.assigned_by
       WHERE fa.status = ?
       ORDER BY fa.end_date`,
      [status],
    ),
  });
});

fitnessAddonRoutes.get('/members/:memberId', (req, res) => {
  const memberId = Number(req.params.memberId);
  if (!get('SELECT id FROM members WHERE id = ?', [memberId])) throw notFound('Member not found');
  res.json({
    ...fitnessAccessFor(memberId),
    history: all(
      `SELECT fa.*, u.name AS sold_by FROM member_fitness_addons fa
       LEFT JOIN users u ON u.id = fa.assigned_by
       WHERE fa.member_id = ? ORDER BY fa.created_at DESC`,
      [memberId],
    ),
  });
});

/**
 * Sells the add-on: takes the money, extends the entitlement, hands back a
 * payment the desk can print a receipt from.
 *
 * `record_payment: false` covers the case the desk needs and a pure billing
 * API would not have — comping the feature for a member, or activating one who
 * paid through some channel this system did not see. A zero-price sale writes
 * no payment either way, because payments.amount is CHECK (amount > 0).
 */
fitnessAddonRoutes.post('/subscribe', requireRole(...MANAGES_BILLING), (req, res) => {
  const settings = fitnessSettings();
  const body = parse(req.body, {
    member_id: { type: 'int', required: true, min: 1 },
    months: { type: 'int', min: 1, max: 24, default: 1 },
    // Falls back to the gym's configured rate, so the desk can take the price
    // off the shelf without retyping it, and override it for a one-off deal.
    price: { type: 'number', min: 0, max: 1000000, default: settings.monthly_price },
    method: { type: 'enum', values: ['cash', 'card', 'upi', 'bank', 'online'], default: 'cash' },
    start_date: { type: 'date', default: today() },
    reference: { type: 'string', max: 80 },
    note: { type: 'string', max: 300 },
    record_payment: { type: 'boolean', default: 1 },
  });

  const member = get('SELECT id, first_name FROM members WHERE id = ?', [body.member_id]);
  if (!member) throw notFound('Member not found');

  const total = Math.round(body.price * body.months * 100) / 100;

  const result = tx(() => {
    let paymentId = null;
    if (body.record_payment && total > 0) {
      // No subscription_id: this is not membership revenue, and hanging it off
      // the membership would double-count it against that membership's dues
      // (see the due calculation in portal.js /me).
      paymentId = run(
        `INSERT INTO payments (member_id, amount, method, paid_on, reference, note)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          member.id,
          total,
          body.method,
          body.start_date,
          body.reference ?? null,
          body.note ?? `Diet & Workout add-on · ${body.months} month${body.months === 1 ? '' : 's'}`,
        ],
      ).lastInsertRowid;
    }

    const addon = activateFitnessAddon({
      memberId: member.id,
      months: body.months,
      price: total,
      startDate: body.start_date,
      paymentId,
      userId: req.user.id,
      note: body.note ?? null,
    });

    return { addon, paymentId };
  });

  res.status(201).json({
    addon: result.addon,
    payment: result.paymentId ? get('SELECT * FROM payments WHERE id = ?', [result.paymentId]) : null,
    access: fitnessAccessFor(member.id),
  });
});

/**
 * Ends an add-on now.
 *
 * The payment stays where it is: cancelling access is not a refund, and
 * silently unwinding takings the day's cash count already includes would be
 * worse than leaving a trainer to issue the refund deliberately.
 */
fitnessAddonRoutes.post('/cancel/:id', requireRole(...MANAGES_BILLING), (req, res) => {
  const id = Number(req.params.id);
  const addon = get('SELECT * FROM member_fitness_addons WHERE id = ?', [id]);
  if (!addon) throw notFound('Add-on subscription not found');
  if (addon.status !== 'active') throw badRequest('That add-on is no longer active');

  run("UPDATE member_fitness_addons SET status = 'cancelled' WHERE id = ?", [id]);
  res.json({
    addon: get('SELECT * FROM member_fitness_addons WHERE id = ?', [id]),
    access: fitnessAccessFor(addon.member_id),
  });
});

/** The add-on's own revenue line, kept separate from membership takings. */
fitnessAddonRoutes.get('/revenue', (req, res) => {
  const months = Math.min(toInt(req.query.months, 6), 24);
  res.json({
    items: all(
      `SELECT fa.start_date, fa.end_date, fa.price, fa.status,
              m.code AS member_code, m.first_name, m.last_name
       FROM member_fitness_addons fa JOIN members m ON m.id = fa.member_id
       ORDER BY fa.created_at DESC LIMIT 200`,
    ),
    totals: get(
      `SELECT COUNT(*) AS sold, COALESCE(SUM(price), 0) AS revenue
       FROM member_fitness_addons WHERE start_date >= date(?, '-' || ? || ' months')`,
      [today(), months],
    ),
  });
});
