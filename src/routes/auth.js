import { Router } from 'express';
import { hashPassword, issueToken, requireAuth, requireRole, verifyPassword } from '../auth.js';
import { config, DEFAULT_TENANT_SLUG } from '../config.js';
import { all, get, run } from '../db.js';
import { badRequest, conflict, notFound, tooManyRequests, unauthorized } from '../errors.js';
import { createLimiter } from '../rateLimit.js';
import { parse } from '../validate.js';

export const authRoutes = Router();

const loginLimiter = createLimiter({
  maxAttempts: config.loginMaxAttempts,
  windowMs: config.loginWindowMs,
  lockoutMs: config.loginLockoutMs,
});

authRoutes.post('/login', (req, res) => {
  const tenantSlug = req.tenant?.slug ?? DEFAULT_TENANT_SLUG;
  const emailForKey = String(req.body?.email || '').trim().toLowerCase();
  const limiterKey = `${tenantSlug}:${req.ip}:${emailForKey}`;

  const gate = loginLimiter.check(limiterKey);
  if (gate.locked) {
    res.set('Retry-After', String(gate.retryAfterSeconds));
    throw tooManyRequests('Too many failed attempts. Try again later.');
  }

  const body = parse(req.body, {
    email: { type: 'email', required: true },
    password: { type: 'string', required: true },
  });

  const user = get('SELECT * FROM users WHERE email = ?', [body.email]);
  if (!user || !verifyPassword(body.password, user.password_hash)) {
    loginLimiter.recordAttempt(limiterKey);
    throw unauthorized('Email or password is incorrect');
  }
  if (!user.active) throw unauthorized('This account has been deactivated');

  loginLimiter.recordSuccess(limiterKey);
  res.json({
    token: issueToken(user, tenantSlug),
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  });
});

authRoutes.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

authRoutes.post('/change-password', requireAuth, (req, res) => {
  const body = parse(req.body, {
    current_password: { type: 'string', required: true },
    new_password: { type: 'string', required: true, min: 8 },
  });

  const user = get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  if (!verifyPassword(body.current_password, user.password_hash)) {
    throw badRequest('Current password is incorrect', { current_password: 'does not match' });
  }
  run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(body.new_password), user.id]);
  res.json({ ok: true });
});

/* ---------------------------------------------------------------- staff CRUD */

export const staffRoutes = Router();
staffRoutes.use(requireAuth);

const STAFF_COLUMNS = 'id, name, email, role, phone, active, created_at';

staffRoutes.get('/', (req, res) => {
  const where = [];
  const params = [];
  if (req.query.role) {
    where.push('role = ?');
    params.push(String(req.query.role));
  }
  if (req.query.active !== undefined && req.query.active !== '') {
    where.push('active = ?');
    params.push(req.query.active === 'false' || req.query.active === '0' ? 0 : 1);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  res.json({ items: all(`SELECT ${STAFF_COLUMNS} FROM users ${clause} ORDER BY name`, params) });
});

staffRoutes.post('/', requireRole('admin'), (req, res) => {
  const body = parse(req.body, {
    name: { type: 'string', required: true, min: 2, max: 80 },
    email: { type: 'email', required: true },
    password: { type: 'string', required: true, min: 8 },
    role: { type: 'enum', values: ['admin', 'manager', 'trainer', 'staff'], default: 'staff' },
    phone: { type: 'string', max: 30 },
  });

  if (get('SELECT id FROM users WHERE email = ?', [body.email])) {
    throw conflict('A staff account with that email already exists');
  }

  const info = run(
    'INSERT INTO users (name, email, password_hash, role, phone) VALUES (?, ?, ?, ?, ?)',
    [body.name, body.email, hashPassword(body.password), body.role, body.phone ?? null],
  );
  res.status(201).json(get(`SELECT ${STAFF_COLUMNS} FROM users WHERE id = ?`, [info.lastInsertRowid]));
});

staffRoutes.patch('/:id', requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  const existing = get('SELECT id FROM users WHERE id = ?', [id]);
  if (!existing) throw notFound('Staff member not found');

  const body = parse(req.body, {
    name: { type: 'string', min: 2, max: 80 },
    email: { type: 'email' },
    role: { type: 'enum', values: ['admin', 'manager', 'trainer', 'staff'] },
    phone: { type: 'string', max: 30 },
    active: { type: 'boolean' },
    password: { type: 'string', min: 8 },
  });

  if (body.email && get('SELECT id FROM users WHERE email = ? AND id != ?', [body.email, id])) {
    throw conflict('Another staff account already uses that email');
  }

  const fields = [];
  const params = [];
  for (const key of ['name', 'email', 'role', 'phone', 'active']) {
    if (key in body) {
      fields.push(`${key} = ?`);
      params.push(body[key]);
    }
  }
  if (body.password) {
    fields.push('password_hash = ?');
    params.push(hashPassword(body.password));
  }
  if (fields.length) {
    run(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, [...params, id]);
  }
  res.json(get(`SELECT ${STAFF_COLUMNS} FROM users WHERE id = ?`, [id]));
});
