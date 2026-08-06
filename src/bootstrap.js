import { hashPassword } from './auth.js';
import { get, getDb, run } from './db.js';

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
  const name = overrides.name ?? process.env.ADMIN_NAME ?? 'Gym Owner';

  run('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)', [
    name,
    email,
    hashPassword(password),
    'admin',
  ]);

  return { email, password, generated: !overrides.password && !process.env.ADMIN_PASSWORD };
}

/**
 * Three plans a new gym can start selling immediately.
 *
 * Without these the first thing a freshly-signed-up owner meets is a dead end:
 * performCheckIn() refuses anyone without an active membership, and you cannot
 * sell a membership without a plan — so the product looks broken until they
 * find the Plans page on their own. These are meant to be edited, not kept.
 *
 * Prices are per-currency because "1500" is a sane monthly fee in rupees and
 * an absurd one in dollars; anything not listed falls back to the generic tier.
 */
const STARTER_PRICES = {
  INR: [1500, 4000, 14000],
  USD: [40, 105, 360],
  EUR: [40, 105, 360],
  GBP: [35, 95, 320],
};
const GENERIC_PRICES = [50, 135, 450];

const STARTER_PLANS = [
  { name: 'Monthly', description: 'Full gym access, renewed every month', duration_days: 30 },
  { name: 'Quarterly', description: 'Three months of full gym access', duration_days: 90 },
  { name: 'Annual', description: 'Twelve months of full gym access', duration_days: 365 },
];

/** Seeds starter plans into the current tenant's DB. No-ops the moment the gym
 * has any plan of its own, so it can never overwrite real data on a re-run. */
export function seedStarterPlans(currency = 'INR') {
  getDb();
  if (get('SELECT COUNT(*) AS n FROM plans').n > 0) return 0;

  const prices = STARTER_PRICES[String(currency).toUpperCase()] ?? GENERIC_PRICES;
  STARTER_PLANS.forEach((plan, index) => {
    run('INSERT INTO plans (name, description, price, duration_days) VALUES (?, ?, ?, ?)', [
      plan.name,
      plan.description,
      prices[index],
      plan.duration_days,
    ]);
  });
  return STARTER_PLANS.length;
}
