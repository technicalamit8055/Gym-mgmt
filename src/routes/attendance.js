import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { all, get, run, tx } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { expireOverdueSubscriptions } from '../maintenance.js';
import { parse, toInt } from '../validate.js';

export const attendanceRoutes = Router();
attendanceRoutes.use(requireAuth);

const ATTENDANCE_SELECT = `
  SELECT a.*, m.code AS member_code, m.first_name, m.last_name, m.photo_url
  FROM attendance a JOIN members m ON m.id = a.member_id
`;

attendanceRoutes.get('/', (req, res) => {
  const where = [];
  const params = [];
  if (req.query.member_id) {
    where.push('a.member_id = ?');
    params.push(Number(req.query.member_id));
  }
  if (req.query.date) {
    where.push('date(a.check_in) = ?');
    params.push(String(req.query.date));
  }
  if (req.query.from) {
    where.push('date(a.check_in) >= ?');
    params.push(String(req.query.from));
  }
  if (req.query.to) {
    where.push('date(a.check_in) <= ?');
    params.push(String(req.query.to));
  }
  if (req.query.open === 'true') where.push('a.check_out IS NULL');

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(toInt(req.query.limit, 100), 500);
  res.json({
    items: all(`${ATTENDANCE_SELECT} ${clause} ORDER BY a.check_in DESC LIMIT ?`, [...params, limit]),
  });
});

/**
 * Front-desk check-in. Accepts a member id or the printed member code so the
 * desk can scan a card without looking the member up first.
 */
attendanceRoutes.post('/check-in', (req, res) => {
  const body = parse(req.body, {
    member_id: { type: 'int' },
    code: { type: 'string', max: 20 },
    source: { type: 'enum', values: ['desk', 'kiosk', 'app'], default: 'desk' },
  });
  if (!body.member_id && !body.code) throw badRequest('Provide a member id or member code');

  const member = body.member_id
    ? get('SELECT * FROM members WHERE id = ?', [body.member_id])
    : get('SELECT * FROM members WHERE code = ? COLLATE NOCASE', [body.code]);
  if (!member) throw notFound('No member matches that id or code');
  if (member.status === 'frozen') throw badRequest(`${member.first_name}'s membership is frozen`);
  if (member.status === 'inactive') throw badRequest(`${member.first_name}'s membership is inactive`);

  expireOverdueSubscriptions();
  const sub = get(
    "SELECT * FROM subscriptions WHERE member_id = ? AND status = 'active' AND date('now') BETWEEN start_date AND end_date ORDER BY end_date DESC LIMIT 1",
    [member.id],
  );
  if (!sub) throw badRequest(`${member.first_name} has no active membership — renew before checking in`);
  if (sub.sessions_total !== null && sub.sessions_used >= sub.sessions_total) {
    throw badRequest(`${member.first_name} has used all ${sub.sessions_total} sessions on this plan`);
  }

  const openVisit = get(
    "SELECT * FROM attendance WHERE member_id = ? AND check_out IS NULL AND date(check_in) = date('now')",
    [member.id],
  );
  if (openVisit) {
    return res.status(200).json({
      already_in: true,
      visit: get(`${ATTENDANCE_SELECT} WHERE a.id = ?`, [openVisit.id]),
    });
  }

  const visitId = tx(() => {
    const info = run('INSERT INTO attendance (member_id, source) VALUES (?, ?)', [member.id, body.source]);
    if (sub.sessions_total !== null) {
      run('UPDATE subscriptions SET sessions_used = sessions_used + 1 WHERE id = ?', [sub.id]);
    }
    return info.lastInsertRowid;
  });

  return res.status(201).json({
    already_in: false,
    visit: get(`${ATTENDANCE_SELECT} WHERE a.id = ?`, [visitId]),
    membership: {
      plan_id: sub.plan_id,
      end_date: sub.end_date,
      sessions_total: sub.sessions_total,
      sessions_left: sub.sessions_total === null ? null : sub.sessions_total - (sub.sessions_used + 1),
    },
  });
});

attendanceRoutes.post('/check-out', (req, res) => {
  const body = parse(req.body, {
    member_id: { type: 'int' },
    attendance_id: { type: 'int' },
  });

  const visit = body.attendance_id
    ? get('SELECT * FROM attendance WHERE id = ?', [body.attendance_id])
    : get(
        'SELECT * FROM attendance WHERE member_id = ? AND check_out IS NULL ORDER BY check_in DESC LIMIT 1',
        [body.member_id],
      );
  if (!visit) throw notFound('No open visit found');
  if (visit.check_out) throw badRequest('That visit is already checked out');

  run("UPDATE attendance SET check_out = datetime('now') WHERE id = ?", [visit.id]);
  res.json(get(`${ATTENDANCE_SELECT} WHERE a.id = ?`, [visit.id]));
});
