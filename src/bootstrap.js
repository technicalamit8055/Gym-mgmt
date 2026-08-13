import { hashPassword } from './auth.js';
import { get, getDb, run } from './db.js';
import { currentVertical, starterPricesFor } from './verticals.js';

/**
 * Makes sure a fresh install can be logged into. Runs once — as soon as a real
 * admin exists this is a no-op.
 */
export function ensureAdminAccount(overrides = {}) {
  getDb();
  const existing = get('SELECT COUNT(*) AS n FROM users');
  if (existing.n > 0) return null;

  const email = (overrides.email ?? process.env.ADMIN_EMAIL ?? 'admin@gymbook.local').toLowerCase();
  const password = overrides.password ?? process.env.ADMIN_PASSWORD ?? 'admin12345';
  const owner = `${currentVertical().vocabulary.org} Owner`;
  const name = overrides.name ?? process.env.ADMIN_NAME ?? owner.replace(/^./, (c) => c.toUpperCase());

  run('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)', [
    name,
    email,
    hashPassword(password),
    'admin',
  ]);

  return { email, password, generated: !overrides.password && !process.env.ADMIN_PASSWORD };
}

/**
 * Shifts a library sells passes by. The generic session-seed migration in
 * db.js has already written a Morning and an Evening row into this brand-new
 * file (they're a gym batch default) — UPDATE those two by name rather than
 * duplicating them, then INSERT the rest. Guarded on the tenant having zero
 * seats, not zero plans, so this can never stomp a hall that already has real
 * data if it were ever called again post-signup.
 */
function seedShifts(vertical) {
  if (!vertical.starterShifts) return;
  if (get('SELECT COUNT(*) AS n FROM seats').n > 0) return;

  for (const shift of vertical.starterShifts) {
    const existing = get('SELECT id FROM sessions WHERE name = ?', [shift.name]);
    if (existing) {
      run('UPDATE sessions SET start_time = ?, end_time = ?, code = ?, sort_order = ?, overnight = ? WHERE id = ?', [
        shift.start_time,
        shift.end_time,
        shift.code,
        shift.sort_order,
        shift.overnight,
        existing.id,
      ]);
    } else {
      run(
        'INSERT INTO sessions (name, start_time, end_time, code, sort_order, overnight) VALUES (?, ?, ?, ?, ?, ?)',
        [shift.name, shift.start_time, shift.end_time, shift.code, shift.sort_order, shift.overnight],
      );
    }
  }
}

/**
 * Plans a new account can start selling immediately.
 *
 * Without these the first thing a freshly-signed-up owner meets is a dead end:
 * performCheckIn() refuses anyone without an active membership, and you cannot
 * sell a membership without a plan — so the product looks broken until they
 * find the Plans page on their own. These are meant to be edited, not kept.
 *
 * The catalogue itself lives in verticals.js: a gym opens with Monthly /
 * Quarterly / Annual, a study hall with shift-bound passes. Prices there are
 * per-currency because "1500" is a sane monthly fee in rupees and an absurd one
 * in dollars.
 */
export function seedStarterPlans(currency = 'INR') {
  getDb();
  const vertical = currentVertical();
  seedShifts(vertical);

  if (get('SELECT COUNT(*) AS n FROM plans').n > 0) return 0;

  const prices = starterPricesFor(vertical, currency);
  vertical.starterPlans.forEach((plan, index) => {
    const sessionId = plan.shift ? get('SELECT id FROM sessions WHERE name = ?', [plan.shift])?.id ?? null : null;
    run('INSERT INTO plans (name, description, price, duration_days, session_id) VALUES (?, ?, ?, ?, ?)', [
      plan.name,
      plan.description,
      prices[index],
      plan.duration_days,
      sessionId,
    ]);
  });
  return vertical.starterPlans.length;
}
