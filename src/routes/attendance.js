import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { ATTENDANCE_SELECT, performCheckIn } from '../checkin.js';
import { all, get, run } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { autoCloseFinishedVisits } from '../maintenance.js';
import { parse, toInt } from '../validate.js';

export const attendanceRoutes = Router();
attendanceRoutes.use(requireAuth);

attendanceRoutes.get('/', (req, res) => {
  autoCloseFinishedVisits();

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

  const result = performCheckIn(member, body.source);
  return res.status(result.action === 'checked_in' ? 201 : 200).json(result);
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
