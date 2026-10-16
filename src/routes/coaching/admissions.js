import { Router } from 'express';
import { all, get, run, tx } from '../../db.js';
import { badRequest, conflict, notFound } from '../../errors.js';
import { parse, today } from '../../validate.js';
import { requireModule } from '../../verticals.js';
import { nextMemberCode } from '../members.js';
import { enrollWithFee, parseFeeInput } from './students.js';
import { idParam, insertSql, optional, updateSql } from './shared.js';

/**
 * The admissions pipeline: a walk-in or a call becomes an inquiry, maybe a
 * demo class, a follow-up, and then either an admission or a decline.
 * Admitting turns the lead into a student (a members row, with the next
 * CB code), enrolls them, and can open their fee plan — one step at the desk.
 */
export const admissionRoutes = Router();
admissionRoutes.use('/inquiries', requireModule('admissions'));

export const INQUIRY_STATUSES = ['inquiry', 'demo_scheduled', 'demo_attended', 'follow_up', 'admitted', 'declined'];
export const INQUIRY_SOURCES = ['walk_in', 'phone', 'referral', 'banner', 'social', 'website', 'school', 'other'];

const INQUIRY_FIELDS = {
  student_name: { type: 'string', required: true, min: 2, max: 100 },
  guardian_name: { type: 'string', max: 100 },
  phone: { type: 'string', required: true, min: 6, max: 30 },
  email: { type: 'email' },
  course_id: { type: 'int', min: 1 },
  target_class: { type: 'string', max: 40 },
  school_name: { type: 'string', max: 120 },
  status: { type: 'enum', values: INQUIRY_STATUSES, default: 'inquiry' },
  demo_on: { type: 'date' },
  follow_up_on: { type: 'date' },
  notes: { type: 'string', max: 2000 },
  source: { type: 'enum', values: INQUIRY_SOURCES, default: 'walk_in' },
  assigned_to: { type: 'int', min: 1 },
};

const INQUIRY_SELECT = `
  SELECT i.*, c.name AS course_name, u.name AS assigned_name, m.code AS member_code
  FROM student_inquiries i
  LEFT JOIN academic_courses c ON c.id = i.course_id
  LEFT JOIN users u ON u.id = i.assigned_to
  LEFT JOIN members m ON m.id = i.member_id
`;

function checkRefs(body) {
  if (body.course_id && !get('SELECT id FROM academic_courses WHERE id = ?', [body.course_id])) throw notFound('Course not found');
  if (body.assigned_to && !get('SELECT id FROM users WHERE id = ?', [body.assigned_to])) throw notFound('Staff member not found');
  if (body.status === 'admitted') {
    throw badRequest('Use "Admit" to admit a student — it creates their profile and enrollment', { status: 'use admit' });
  }
}

admissionRoutes.get('/inquiries', (req, res) => {
  const where = [];
  const params = [];
  if (req.query.status) {
    where.push('i.status = ?');
    params.push(String(req.query.status));
  }
  if (req.query.course_id) {
    where.push('i.course_id = ?');
    params.push(Number(req.query.course_id));
  }
  const q = String(req.query.q || '').trim();
  if (q) {
    where.push('(i.student_name LIKE ? OR i.guardian_name LIKE ? OR i.phone LIKE ? OR i.school_name LIKE ?)');
    params.push(...Array(4).fill(`%${q}%`));
  }
  if (req.query.due === '1') {
    where.push("i.status NOT IN ('admitted', 'declined') AND (i.follow_up_on <= ? OR i.demo_on <= ?)");
    params.push(today(), today());
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const items = all(
    `${INQUIRY_SELECT} ${clause}
     ORDER BY CASE WHEN i.status IN ('admitted', 'declined') THEN 1 ELSE 0 END,
              COALESCE(i.follow_up_on, i.demo_on, '9999-12-31'), i.created_at DESC
     LIMIT 500`,
    params,
  );
  const counts = Object.fromEntries(INQUIRY_STATUSES.map((s) => [s, 0]));
  for (const row of all('SELECT status, COUNT(*) AS n FROM student_inquiries GROUP BY status')) counts[row.status] = row.n;
  const thisMonth = get(
    `SELECT COUNT(*) AS leads, SUM(CASE WHEN status = 'admitted' THEN 1 ELSE 0 END) AS admitted
     FROM student_inquiries WHERE created_at >= ?`,
    [`${today().slice(0, 7)}-01`],
  );
  res.json({
    items,
    counts,
    month: { leads: thisMonth.leads, admitted: thisMonth.admitted ?? 0 },
    follow_ups_due: get(
      "SELECT COUNT(*) AS n FROM student_inquiries WHERE status NOT IN ('admitted', 'declined') AND (follow_up_on <= ? OR demo_on <= ?)",
      [today(), today()],
    ).n,
  });
});

admissionRoutes.post('/inquiries', (req, res) => {
  const body = parse(req.body, INQUIRY_FIELDS);
  checkRefs(body);
  const { sql, params } = insertSql('student_inquiries', body);
  const info = run(sql, params);
  res.status(201).json(get(`${INQUIRY_SELECT} WHERE i.id = ?`, [info.lastInsertRowid]));
});

admissionRoutes.patch('/inquiries/:id', (req, res) => {
  const id = idParam(req);
  const current = get('SELECT status FROM student_inquiries WHERE id = ?', [id]);
  if (!current) throw notFound('Inquiry not found');
  const body = parse(req.body, optional(INQUIRY_FIELDS));
  if (current.status === 'admitted' && body.status && body.status !== 'admitted') {
    throw conflict('This inquiry is already admitted; edit the student instead');
  }
  checkRefs(body);
  const { sql, params } = updateSql('student_inquiries', { ...body, updated_at: new Date().toISOString().slice(0, 19).replace('T', ' ') }, id);
  run(sql, params);
  res.json(get(`${INQUIRY_SELECT} WHERE i.id = ?`, [id]));
});

admissionRoutes.delete('/inquiries/:id', (req, res) => {
  const info = run('DELETE FROM student_inquiries WHERE id = ?', [idParam(req)]);
  if (!info.changes) throw notFound('Inquiry not found');
  res.json({ ok: true });
});

/**
 * Admits a lead: creates the student (or links an existing one by
 * `member_id`), enrolls them into `batch_id`, and opens their fee plan when
 * `fee` is sent. The name on the inquiry is split into first/last the way the
 * desk would type it; everything else carries over.
 */
admissionRoutes.post('/inquiries/:id/admit', (req, res) => {
  const id = idParam(req);
  const inquiry = get('SELECT * FROM student_inquiries WHERE id = ?', [id]);
  if (!inquiry) throw notFound('Inquiry not found');
  if (inquiry.status === 'admitted' && inquiry.member_id) throw conflict('This inquiry has already been admitted');

  const body = parse(req.body, {
    member_id: { type: 'int', min: 1 },
    batch_id: { type: 'int', required: true, min: 1 },
    first_name: { type: 'string', max: 60 },
    last_name: { type: 'string', max: 60 },
    phone: { type: 'string', max: 30 },
    email: { type: 'email' },
    roll_number: { type: 'string', max: 20 },
    allow_over_capacity: { type: 'boolean', default: 0 },
  });
  const fee = req.body?.fee ? parseFeeInput(req.body.fee) : null;
  if (!get('SELECT id FROM academic_batches WHERE id = ?', [body.batch_id])) throw notFound('Batch not found');

  let memberId = body.member_id ?? null;
  let created = false;
  if (memberId) {
    if (!get('SELECT id FROM members WHERE id = ?', [memberId])) throw notFound('Student not found');
  } else {
    const [first, ...rest] = inquiry.student_name.trim().split(/\s+/);
    const email = body.email ?? inquiry.email ?? null;
    if (email && get('SELECT id FROM members WHERE email = ?', [email])) {
      throw conflict('A student with that email already exists — admit them as that student instead', { email: 'taken' });
    }
    memberId = tx(() => {
      const info = run(
        `INSERT INTO members (code, first_name, last_name, phone, email, joined_on, emergency_contact, emergency_phone,
                              school_name, current_class, exam_target)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          nextMemberCode(),
          body.first_name || first,
          body.last_name ?? rest.join(' '),
          body.phone ?? inquiry.phone,
          email,
          today(),
          inquiry.guardian_name,
          // The inquiry's number is almost always the parent's — it is who
          // called — so it becomes the guardian WhatsApp number too.
          inquiry.phone,
          inquiry.school_name,
          inquiry.target_class,
          inquiry.course_id ? get('SELECT target_exam FROM academic_courses WHERE id = ?', [inquiry.course_id])?.target_exam ?? null : null,
        ],
      );
      return Number(info.lastInsertRowid);
    });
    created = true;
  }

  let result;
  try {
    result = enrollWithFee({ memberId, body, fee, user: req.user });
  } catch (err) {
    if (created) run('DELETE FROM members WHERE id = ?', [memberId]);
    throw err;
  }
  run("UPDATE student_inquiries SET status = 'admitted', member_id = ?, updated_at = datetime('now') WHERE id = ?", [memberId, id]);
  res.status(201).json({
    ...result,
    member: get('SELECT id, code, first_name, last_name, phone FROM members WHERE id = ?', [memberId]),
    inquiry: get(`${INQUIRY_SELECT} WHERE i.id = ?`, [id]),
  });
});
