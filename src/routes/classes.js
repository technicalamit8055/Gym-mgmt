import { Router } from 'express';
import { MANAGES_BILLING, requireAuth, requireRole } from '../auth.js';
import { all, get, run, tx } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { parse, today, toInt } from '../validate.js';

export const classRoutes = Router();
classRoutes.use(requireAuth);

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const CLASS_SELECT = `
  SELECT c.*, u.name AS trainer_name
  FROM classes c LEFT JOIN users u ON u.id = c.trainer_id
`;

const CLASS_FIELDS = {
  name: { type: 'string', required: true, min: 2, max: 80 },
  description: { type: 'string', max: 500 },
  trainer_id: { type: 'int' },
  weekday: { type: 'int', required: true, min: 0, max: 6 },
  start_time: { type: 'time', required: true },
  duration_min: { type: 'int', min: 5, max: 300, default: 60 },
  capacity: { type: 'int', min: 1, max: 500, default: 20 },
  room: { type: 'string', max: 60 },
  active: { type: 'boolean', default: 1 },
};

classRoutes.get('/', (req, res) => {
  const where = [];
  const params = [];
  if (req.query.active === 'true') where.push('c.active = 1');
  if (req.query.weekday !== undefined && req.query.weekday !== '') {
    where.push('c.weekday = ?');
    params.push(toInt(req.query.weekday, 0));
  }
  if (req.query.trainer_id) {
    where.push('c.trainer_id = ?');
    params.push(Number(req.query.trainer_id));
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const items = all(`${CLASS_SELECT} ${clause} ORDER BY c.weekday, c.start_time`, params).map((c) => ({
    ...c,
    weekday_name: WEEKDAYS[c.weekday],
  }));
  res.json({ items });
});

/** The week's timetable with live booking counts, grouped by weekday. */
classRoutes.get('/schedule', (req, res) => {
  const start = String(req.query.week_start || today());
  const rows = all(
    `SELECT c.*, u.name AS trainer_name,
            date(?, '+' || ((c.weekday - CAST(strftime('%w', ?) AS INTEGER) + 7) % 7) || ' day') AS class_date
     FROM classes c LEFT JOIN users u ON u.id = c.trainer_id
     WHERE c.active = 1
     ORDER BY class_date, c.start_time`,
    [start, start],
  );

  const items = rows.map((row) => {
    const booked = get(
      "SELECT COUNT(*) AS n FROM bookings WHERE class_id = ? AND class_date = ? AND status != 'cancelled'",
      [row.id, row.class_date],
    ).n;
    return { ...row, weekday_name: WEEKDAYS[row.weekday], booked, seats_left: row.capacity - booked };
  });

  res.json({ week_start: start, items });
});

classRoutes.post('/', requireRole(...MANAGES_BILLING), (req, res) => {
  const body = parse(req.body, CLASS_FIELDS);
  if (body.trainer_id && !get('SELECT id FROM users WHERE id = ?', [body.trainer_id])) {
    throw notFound('Trainer not found');
  }
  const columns = Object.keys(body);
  const info = run(
    `INSERT INTO classes (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    columns.map((c) => body[c]),
  );
  res.status(201).json(get(`${CLASS_SELECT} WHERE c.id = ?`, [info.lastInsertRowid]));
});

classRoutes.patch('/:id', requireRole(...MANAGES_BILLING), (req, res) => {
  const id = Number(req.params.id);
  if (!get('SELECT id FROM classes WHERE id = ?', [id])) throw notFound('Class not found');

  const body = parse(
    req.body,
    Object.fromEntries(
      Object.entries(CLASS_FIELDS).map(([k, v]) => [k, { ...v, required: false, default: undefined }]),
    ),
  );
  const columns = Object.keys(body);
  if (!columns.length) throw badRequest('Nothing to update');

  run(`UPDATE classes SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [
    ...columns.map((c) => body[c]),
    id,
  ]);
  res.json(get(`${CLASS_SELECT} WHERE c.id = ?`, [id]));
});

classRoutes.delete('/:id', requireRole(...MANAGES_BILLING), (req, res) => {
  const info = run('DELETE FROM classes WHERE id = ?', [Number(req.params.id)]);
  if (!info.changes) throw notFound('Class not found');
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ bookings */

export const bookingRoutes = Router();
bookingRoutes.use(requireAuth);

const BOOKING_SELECT = `
  SELECT b.*, c.name AS class_name, c.start_time, c.capacity, c.room,
         m.code AS member_code, m.first_name, m.last_name
  FROM bookings b
  JOIN classes c ON c.id = b.class_id
  JOIN members m ON m.id = b.member_id
`;

bookingRoutes.get('/', (req, res) => {
  const where = [];
  const params = [];
  if (req.query.class_id) {
    where.push('b.class_id = ?');
    params.push(Number(req.query.class_id));
  }
  if (req.query.member_id) {
    where.push('b.member_id = ?');
    params.push(Number(req.query.member_id));
  }
  if (req.query.date) {
    where.push('b.class_date = ?');
    params.push(String(req.query.date));
  }
  if (req.query.status) {
    where.push('b.status = ?');
    params.push(String(req.query.status));
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  res.json({
    items: all(`${BOOKING_SELECT} ${clause} ORDER BY b.class_date DESC, c.start_time LIMIT ?`, [
      ...params,
      Math.min(toInt(req.query.limit, 100), 500),
    ]),
  });
});

bookingRoutes.post('/', (req, res) => {
  const body = parse(req.body, {
    class_id: { type: 'int', required: true },
    member_id: { type: 'int', required: true },
    class_date: { type: 'date', required: true },
  });

  const klass = get('SELECT * FROM classes WHERE id = ?', [body.class_id]);
  if (!klass) throw notFound('Class not found');
  if (!klass.active) throw badRequest('That class is not running');
  if (!get('SELECT id FROM members WHERE id = ?', [body.member_id])) throw notFound('Member not found');

  const dayOfWeek = new Date(`${body.class_date}T00:00:00Z`).getUTCDay();
  if (dayOfWeek !== klass.weekday) {
    throw badRequest(`${klass.name} runs on ${WEEKDAYS[klass.weekday]}`, { class_date: 'wrong weekday' });
  }
  if (body.class_date < today()) throw badRequest('Pick a date that has not passed yet');

  const booking = tx(() => {
    const booked = get(
      "SELECT COUNT(*) AS n FROM bookings WHERE class_id = ? AND class_date = ? AND status != 'cancelled'",
      [klass.id, body.class_date],
    ).n;
    if (booked >= klass.capacity) throw conflict(`${klass.name} on ${body.class_date} is full`);

    const existing = get('SELECT * FROM bookings WHERE class_id = ? AND member_id = ? AND class_date = ?', [
      klass.id,
      body.member_id,
      body.class_date,
    ]);
    if (existing) {
      if (existing.status !== 'cancelled') throw conflict('This member is already booked into that class');
      run("UPDATE bookings SET status = 'booked' WHERE id = ?", [existing.id]);
      return existing.id;
    }

    return run('INSERT INTO bookings (class_id, member_id, class_date) VALUES (?, ?, ?)', [
      klass.id,
      body.member_id,
      body.class_date,
    ]).lastInsertRowid;
  });

  res.status(201).json(get(`${BOOKING_SELECT} WHERE b.id = ?`, [booking]));
});

bookingRoutes.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!get('SELECT id FROM bookings WHERE id = ?', [id])) throw notFound('Booking not found');
  const body = parse(req.body, {
    status: { type: 'enum', values: ['booked', 'attended', 'cancelled', 'no_show'], required: true },
  });
  run('UPDATE bookings SET status = ? WHERE id = ?', [body.status, id]);
  res.json(get(`${BOOKING_SELECT} WHERE b.id = ?`, [id]));
});
