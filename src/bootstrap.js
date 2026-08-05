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
