import { Router } from 'express';
import { MANAGES_BILLING, requireAuth, requireRole } from '../auth.js';
import { all, get, run, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { expireOverdueSubscriptions } from '../maintenance.js';
import { parse, toInt } from '../validate.js';

export const memberRoutes = Router();
memberRoutes.use(requireAuth);

export const MEMBER_SELECT = `
  SELECT m.*,
    active_sub.plan_name        AS plan_name,
    active_sub.end_date         AS membership_end,
    active_sub.id               AS subscription_id,
    COALESCE(billed.total, 0) - COALESCE(paid.total, 0) AS balance_due,
    visits.last_visit           AS last_visit,
    COALESCE(visits.count, 0)   AS visit_count
  FROM members m
  LEFT JOIN (
    SELECT s.member_id, s.id, s.end_date, p.name AS plan_name,
           ROW_NUMBER() OVER (PARTITION BY s.member_id ORDER BY s.end_date DESC, s.id DESC) AS rn
    FROM subscriptions s JOIN plans p ON p.id = s.plan_id
    WHERE s.status = 'active'
  ) active_sub ON active_sub.member_id = m.id AND active_sub.rn = 1
  LEFT JOIN (
    SELECT member_id, SUM(price - discount) AS total FROM subscriptions
    WHERE status != 'cancelled' GROUP BY member_id
  ) billed ON billed.member_id = m.id
  LEFT JOIN (
    SELECT member_id, SUM(amount) AS total FROM payments GROUP BY member_id
  ) paid ON paid.member_id = m.id
  LEFT JOIN (
    SELECT member_id, MAX(check_in) AS last_visit, COUNT(*) AS count
    FROM attendance GROUP BY member_id
  ) visits ON visits.member_id = m.id
`;

const MEMBER_FIELDS = {
  first_name: { type: 'string', required: true, min: 1, max: 60 },
  last_name: { type: 'string', max: 60, default: '' },
  email: { type: 'email' },
  phone: { type: 'string', max: 30 },
  gender: { type: 'enum', values: ['male', 'female', 'other'] },
  date_of_birth: { type: 'date' },
  address: { type: 'string', max: 300 },
  emergency_contact: { type: 'string', max: 80 },
  emergency_phone: { type: 'string', max: 30 },
  health_notes: { type: 'string', max: 1000 },
  photo_url: { type: 'string', max: 500 },
  joined_on: { type: 'date' },
  status: { type: 'enum', values: ['active', 'inactive', 'frozen'] },
  // The numeric ID a fingerprint terminal (e.g. a Realtime/eSSL device)
  // enrolls this member under — matched against physical check-in punches.
  device_pin: { type: 'int' },
};

const optional = (fields) =>
  Object.fromEntries(
    Object.entries(fields).map(([key, spec]) => [key, { ...spec, required: false }]),
  );

/**
 * MEMBER_SELECT is `m.*`, which would otherwise spray the member's QR card
 * secret through every list response. Callers get a flag instead; the token
 * itself is only served by the /api/qr endpoints that need to render a card.
 */
export function publicMember(row) {
  if (!row) return row;
  const { qr_token, ...rest } = row;
  return { ...rest, has_qr: Boolean(qr_token) };
}

function nextMemberCode() {
  const row = get("SELECT MAX(CAST(substr(code, 3) AS INTEGER)) AS n FROM members WHERE code LIKE 'GM%'");
  return `GM${String((row?.n || 0) + 1).padStart(4, '0')}`;
}

memberRoutes.get('/', (req, res) => {
  expireOverdueSubscriptions();

  const where = [];
  const params = [];

  const q = String(req.query.q || '').trim();
  if (q) {
    where.push(
      "(m.first_name LIKE ? OR m.last_name LIKE ? OR m.code LIKE ? OR m.phone LIKE ? OR m.email LIKE ? OR (m.first_name || ' ' || m.last_name) LIKE ?)",
    );
    params.push(...Array(6).fill(`%${q}%`));
  }
  if (req.query.status) {
    where.push('m.status = ?');
    params.push(String(req.query.status));
  }

  switch (req.query.membership) {
    case 'active':
      where.push('active_sub.id IS NOT NULL');
      break;
    case 'expiring':
      where.push("active_sub.end_date IS NOT NULL AND active_sub.end_date <= date('now', '+7 day')");
      break;
    case 'expired':
      where.push('active_sub.id IS NULL AND EXISTS (SELECT 1 FROM subscriptions s WHERE s.member_id = m.id)');
      break;
    case 'none':
      where.push('NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.member_id = m.id)');
      break;
    case 'dues':
      where.push('COALESCE(billed.total, 0) - COALESCE(paid.total, 0) > 0');
      break;
    default:
      break;
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(toInt(req.query.limit, 25), 200);
  const page = Math.max(toInt(req.query.page, 1), 1);

  const sortable = {
    name: "m.first_name || ' ' || m.last_name",
    joined: 'm.joined_on',
    expiry: 'active_sub.end_date',
    dues: 'balance_due',
    code: 'm.code',
  };
  const sort = sortable[req.query.sort] || sortable.name;
  const dir = String(req.query.dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';

  const items = all(
    `${MEMBER_SELECT} ${clause} ORDER BY ${sort} ${dir} LIMIT ? OFFSET ?`,
    [...params, limit, (page - 1) * limit],
  );
  const { total } = get(`SELECT COUNT(*) AS total FROM (${MEMBER_SELECT} ${clause})`, params);

  res.json({
    items: items.map(publicMember),
    total,
    page,
    limit,
    pages: Math.max(Math.ceil(total / limit), 1),
  });
});

memberRoutes.get('/:id', (req, res) => {
  expireOverdueSubscriptions();
  const id = Number(req.params.id);
  const row = get(`${MEMBER_SELECT} WHERE m.id = ?`, [id]);
  if (!row) throw notFound('Member not found');
  const member = publicMember(row);

  member.subscriptions = all(
    `SELECT s.*, p.name AS plan_name, p.duration_days
     FROM subscriptions s JOIN plans p ON p.id = s.plan_id
     WHERE s.member_id = ? ORDER BY s.start_date DESC, s.id DESC`,
    [id],
  );
  member.payments = all(
    'SELECT * FROM payments WHERE member_id = ? ORDER BY paid_on DESC, id DESC LIMIT 50',
    [id],
  );
  member.attendance = all(
    'SELECT * FROM attendance WHERE member_id = ? ORDER BY check_in DESC LIMIT 30',
    [id],
  );
  member.bookings = all(
    `SELECT b.*, c.name AS class_name, c.start_time
     FROM bookings b JOIN classes c ON c.id = b.class_id
     WHERE b.member_id = ? ORDER BY b.class_date DESC LIMIT 30`,
    [id],
  );
  res.json(member);
});

memberRoutes.post('/', (req, res) => {
  const body = parse(req.body, MEMBER_FIELDS);
  if (body.email && get('SELECT id FROM members WHERE email = ?', [body.email])) {
    throw conflict('A member with that email already exists');
  }
  if (body.device_pin && get('SELECT id FROM members WHERE device_pin = ?', [body.device_pin])) {
    throw conflict('Another member is already enrolled with that device PIN');
  }

  const columns = Object.keys(body);
  const info = tx(() => {
    const code = nextMemberCode();
    return run(
      `INSERT INTO members (code, ${columns.join(', ')}) VALUES (?, ${columns.map(() => '?').join(', ')})`,
      [code, ...columns.map((c) => body[c])],
    );
  });

  res.status(201).json(publicMember(get(`${MEMBER_SELECT} WHERE m.id = ?`, [info.lastInsertRowid])));
});

memberRoutes.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!get('SELECT id FROM members WHERE id = ?', [id])) throw notFound('Member not found');

  const body = parse(req.body, optional(MEMBER_FIELDS));
  const columns = Object.keys(body);
  if (!columns.length) throw badRequest('Nothing to update');

  if (body.email && get('SELECT id FROM members WHERE email = ? AND id != ?', [body.email, id])) {
    throw conflict('Another member already uses that email');
  }
  if (body.device_pin && get('SELECT id FROM members WHERE device_pin = ? AND id != ?', [body.device_pin, id])) {
    throw conflict('Another member is already enrolled with that device PIN');
  }

  run(
    `UPDATE members SET ${columns.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`,
    [...columns.map((c) => body[c]), id],
  );
  res.json(publicMember(get(`${MEMBER_SELECT} WHERE m.id = ?`, [id])));
});

memberRoutes.delete('/:id', requireRole(...MANAGES_BILLING), (req, res) => {
  const id = Number(req.params.id);
  const info = run('DELETE FROM members WHERE id = ?', [id]);
  if (!info.changes) throw notFound('Member not found');
  res.json({ ok: true });
});
