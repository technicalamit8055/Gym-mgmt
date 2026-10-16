import { Router } from 'express';
import { MANAGES_BILLING, requireRole } from '../../auth.js';
import { all, get, run, tx } from '../../db.js';
import { badRequest, conflict, notFound } from '../../errors.js';
import { parse, today } from '../../validate.js';
import { requireModule } from '../../verticals.js';
import { componentsJson, parseComponents } from '../../coaching/fees.js';
import { idParam, insertSql, optional, updateSql, weekdaysValue } from './shared.js';

/**
 * Courses, their subjects and batches, fee structures, classrooms and the
 * faculty profile — the setup an institute does once a session. Reading is
 * open to every staff role (a teacher needs the batch list to take
 * attendance); changing it is the billing roles', since a course and its fee
 * are what the institute sells.
 */
export const academicRoutes = Router();
// Scoped to this router's own paths: the CoachBook routers are chained under
// one mount (index.js), and a bare use() would run for every request passing
// through, including other routers' ones.
academicRoutes.use(
  ['/courses', '/subjects', '/batches', '/faculty-allocations', '/fee-structures', '/classrooms', '/faculty'],
  requireModule('batches'),
);

const managers = requireRole(...MANAGES_BILLING);

/* ── Courses ─────────────────────────────────────────────────────────── */

const COURSE_FIELDS = {
  name: { type: 'string', required: true, min: 2, max: 120 },
  code: { type: 'string', max: 20 },
  target_exam: { type: 'string', max: 80 },
  academic_year: { type: 'string', required: true, min: 4, max: 20 },
  description: { type: 'string', max: 1000 },
  active: { type: 'boolean' },
};

const COURSE_SELECT = `
  SELECT c.*,
    (SELECT COUNT(*) FROM academic_subjects s WHERE s.course_id = c.id) AS subject_count,
    (SELECT COUNT(*) FROM academic_batches b WHERE b.course_id = c.id AND b.active = 1) AS batch_count,
    (SELECT COUNT(*) FROM batch_enrollments e JOIN academic_batches b ON b.id = e.batch_id
       WHERE b.course_id = c.id AND e.status = 'active') AS student_count
  FROM academic_courses c
`;

function courseDetail(id) {
  const course = get(`${COURSE_SELECT} WHERE c.id = ?`, [id]);
  if (!course) return null;
  course.subjects = all('SELECT * FROM academic_subjects WHERE course_id = ? ORDER BY sort_order, name', [id]);
  course.fee_structures = all('SELECT * FROM fee_structures WHERE course_id = ? ORDER BY active DESC, total_fee', [id]).map((f) => ({
    ...f,
    components: parseComponents(f.components),
  }));
  return course;
}

academicRoutes.get('/courses', (req, res) => {
  const includeArchived = req.query.archived === '1';
  const courses = all(`${COURSE_SELECT} ${includeArchived ? '' : 'WHERE c.active = 1'} ORDER BY c.active DESC, c.name`);
  for (const course of courses) {
    course.subjects = all('SELECT * FROM academic_subjects WHERE course_id = ? ORDER BY sort_order, name', [course.id]);
    course.fee_structures = all('SELECT * FROM fee_structures WHERE course_id = ? AND active = 1 ORDER BY total_fee', [course.id]).map(
      (f) => ({ ...f, components: parseComponents(f.components) }),
    );
  }
  res.json({ items: courses });
});

academicRoutes.get('/courses/:id', (req, res) => {
  const course = courseDetail(idParam(req));
  if (!course) throw notFound('Course not found');
  res.json(course);
});

academicRoutes.post('/courses', managers, (req, res) => {
  const body = parse(req.body, COURSE_FIELDS);
  const subjects = Array.isArray(req.body?.subjects) ? req.body.subjects : [];
  const id = tx(() => {
    const { sql, params } = insertSql('academic_courses', body);
    const courseId = Number(run(sql, params).lastInsertRowid);
    subjects.forEach((subject, i) => {
      const s = parse(subject, { name: { type: 'string', required: true, min: 1, max: 60 }, code: { type: 'string', max: 12 } });
      run('INSERT INTO academic_subjects (course_id, name, code, sort_order) VALUES (?, ?, ?, ?)', [courseId, s.name, s.code ?? null, i]);
    });
    return courseId;
  });
  res.status(201).json(courseDetail(id));
});

academicRoutes.patch('/courses/:id', managers, (req, res) => {
  const id = idParam(req);
  if (!get('SELECT id FROM academic_courses WHERE id = ?', [id])) throw notFound('Course not found');
  const { sql, params } = updateSql('academic_courses', parse(req.body, optional(COURSE_FIELDS)), id);
  run(sql, params);
  res.json(courseDetail(id));
});

/**
 * Deleting a course would take its batches, enrollments, attendance and
 * marks with it (CASCADE), and a fee plan cannot lose its course at all — so
 * a course anyone has used is archived instead, the same "retire, don't
 * delete" rule lockers and seats follow.
 */
academicRoutes.delete('/courses/:id', managers, (req, res) => {
  const id = idParam(req);
  if (!get('SELECT id FROM academic_courses WHERE id = ?', [id])) throw notFound('Course not found');
  const used =
    get('SELECT COUNT(*) AS n FROM student_fee_plans WHERE course_id = ?', [id]).n
    + get('SELECT COUNT(*) AS n FROM batch_enrollments e JOIN academic_batches b ON b.id = e.batch_id WHERE b.course_id = ?', [id]).n;
  if (used) {
    run('UPDATE academic_courses SET active = 0 WHERE id = ?', [id]);
    run('UPDATE academic_batches SET active = 0 WHERE course_id = ?', [id]);
    return res.json({ ok: true, archived: true, reason: 'Students are or were enrolled, so the course was archived instead of deleted' });
  }
  run('DELETE FROM academic_courses WHERE id = ?', [id]);
  return res.json({ ok: true, archived: false });
});

/* ── Subjects ────────────────────────────────────────────────────────── */

const SUBJECT_FIELDS = {
  name: { type: 'string', required: true, min: 1, max: 60 },
  code: { type: 'string', max: 12 },
  sort_order: { type: 'int', min: 0, max: 999 },
};

academicRoutes.post('/courses/:id/subjects', managers, (req, res) => {
  const courseId = idParam(req);
  if (!get('SELECT id FROM academic_courses WHERE id = ?', [courseId])) throw notFound('Course not found');
  const body = parse(req.body, SUBJECT_FIELDS);
  if (get('SELECT id FROM academic_subjects WHERE course_id = ? AND name = ? COLLATE NOCASE', [courseId, body.name])) {
    throw conflict(`This course already has ${body.name}`);
  }
  const order = body.sort_order ?? get('SELECT COALESCE(MAX(sort_order) + 1, 0) AS n FROM academic_subjects WHERE course_id = ?', [courseId]).n;
  const info = run('INSERT INTO academic_subjects (course_id, name, code, sort_order) VALUES (?, ?, ?, ?)', [
    courseId,
    body.name,
    body.code ?? null,
    order,
  ]);
  res.status(201).json(get('SELECT * FROM academic_subjects WHERE id = ?', [info.lastInsertRowid]));
});

academicRoutes.patch('/subjects/:id', managers, (req, res) => {
  const id = idParam(req);
  if (!get('SELECT id FROM academic_subjects WHERE id = ?', [id])) throw notFound('Subject not found');
  const { sql, params } = updateSql('academic_subjects', parse(req.body, optional(SUBJECT_FIELDS)), id);
  run(sql, params);
  res.json(get('SELECT * FROM academic_subjects WHERE id = ?', [id]));
});

academicRoutes.delete('/subjects/:id', managers, (req, res) => {
  const id = idParam(req);
  if (!get('SELECT id FROM academic_subjects WHERE id = ?', [id])) throw notFound('Subject not found');
  const used =
    get('SELECT COUNT(*) AS n FROM batch_attendance WHERE subject_id = ?', [id]).n
    + get('SELECT COUNT(*) AS n FROM academic_tests WHERE subject_id = ?', [id]).n;
  if (used) throw conflict('This subject has attendance or test history, so it cannot be deleted. Rename it instead.');
  run('DELETE FROM academic_subjects WHERE id = ?', [id]);
  res.json({ ok: true });
});

/* ── Batches ─────────────────────────────────────────────────────────── */

const BATCH_FIELDS = {
  course_id: { type: 'int', required: true, min: 1 },
  name: { type: 'string', required: true, min: 2, max: 80 },
  code: { type: 'string', required: true, min: 1, max: 16 },
  capacity: { type: 'int', min: 1, max: 2000, default: 40 },
  room: { type: 'string', max: 40 },
  start_time: { type: 'time' },
  end_time: { type: 'time' },
  start_date: { type: 'date', required: true },
  end_date: { type: 'date' },
  active: { type: 'boolean' },
};

export const BATCH_SELECT = `
  SELECT b.*, c.name AS course_name, c.academic_year,
    (SELECT COUNT(*) FROM batch_enrollments e WHERE e.batch_id = b.id AND e.status = 'active') AS enrolled
  FROM academic_batches b JOIN academic_courses c ON c.id = b.course_id
`;

function checkBatch(body, id = null) {
  if (body.code) {
    body.code = body.code.toUpperCase().replace(/\s+/g, '');
    if (get('SELECT id FROM academic_batches WHERE code = ? AND id != ?', [body.code, id ?? 0])) {
      throw conflict(`Batch code ${body.code} is already in use`, { code: 'taken' });
    }
  }
  if (body.course_id && !get('SELECT id FROM academic_courses WHERE id = ?', [body.course_id])) throw notFound('Course not found');
  if (body.start_time && body.end_time && body.end_time <= body.start_time) {
    throw badRequest('The batch has to end after it starts', { end_time: 'before start' });
  }
  if (body.start_date && body.end_date && body.end_date < body.start_date) {
    throw badRequest('The end date is before the start date', { end_date: 'before start' });
  }
}

academicRoutes.get('/batches', (req, res) => {
  const where = [];
  const params = [];
  if (req.query.course_id) {
    where.push('b.course_id = ?');
    params.push(Number(req.query.course_id));
  }
  if (req.query.archived !== '1') where.push('b.active = 1');
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  res.json({ items: all(`${BATCH_SELECT} ${clause} ORDER BY c.name, b.start_time IS NULL, b.start_time, b.name`, params) });
});

academicRoutes.get('/batches/:id', (req, res) => {
  const id = idParam(req);
  const batch = get(`${BATCH_SELECT} WHERE b.id = ?`, [id]);
  if (!batch) throw notFound('Batch not found');
  batch.subjects = all('SELECT * FROM academic_subjects WHERE course_id = ? ORDER BY sort_order, name', [batch.course_id]);
  batch.students = all(
    `SELECT e.id AS enrollment_id, e.roll_number, e.seat_no, e.enrolled_on, e.status, e.member_id,
            m.code AS member_code, m.first_name, m.last_name, m.phone, m.emergency_contact, m.emergency_phone
     FROM batch_enrollments e JOIN members m ON m.id = e.member_id
     WHERE e.batch_id = ? ORDER BY e.status = 'active' DESC, e.roll_number, m.first_name`,
    [id],
  );
  batch.faculty = all(
    `SELECT fa.*, u.name AS faculty_name, s.name AS subject_name
     FROM faculty_allocations fa JOIN users u ON u.id = fa.faculty_id JOIN academic_subjects s ON s.id = fa.subject_id
     WHERE fa.batch_id = ? ORDER BY s.sort_order, s.name`,
    [id],
  );
  res.json(batch);
});

academicRoutes.post('/batches', managers, (req, res) => {
  const body = parse(req.body, BATCH_FIELDS);
  body.weekdays = weekdaysValue(req.body?.weekdays) ?? null;
  checkBatch(body);
  const { sql, params } = insertSql('academic_batches', body);
  const info = run(sql, params);
  res.status(201).json(get(`${BATCH_SELECT} WHERE b.id = ?`, [info.lastInsertRowid]));
});

academicRoutes.patch('/batches/:id', managers, (req, res) => {
  const id = idParam(req);
  if (!get('SELECT id FROM academic_batches WHERE id = ?', [id])) throw notFound('Batch not found');
  const body = parse(req.body, optional(BATCH_FIELDS));
  const weekdays = weekdaysValue(req.body?.weekdays);
  if (weekdays !== undefined) body.weekdays = weekdays;
  const current = get('SELECT * FROM academic_batches WHERE id = ?', [id]);
  checkBatch({ ...current, ...body, code: body.code }, id);
  if (body.code) body.code = body.code.toUpperCase().replace(/\s+/g, '');
  if (body.capacity && body.capacity < get("SELECT COUNT(*) AS n FROM batch_enrollments WHERE batch_id = ? AND status = 'active'", [id]).n) {
    throw conflict('More students are enrolled than that capacity allows', { capacity: 'below enrolled' });
  }
  const { sql, params } = updateSql('academic_batches', body, id);
  run(sql, params);
  res.json(get(`${BATCH_SELECT} WHERE b.id = ?`, [id]));
});

academicRoutes.delete('/batches/:id', managers, (req, res) => {
  const id = idParam(req);
  if (!get('SELECT id FROM academic_batches WHERE id = ?', [id])) throw notFound('Batch not found');
  const used =
    get('SELECT COUNT(*) AS n FROM batch_enrollments WHERE batch_id = ?', [id]).n
    + get('SELECT COUNT(*) AS n FROM academic_tests WHERE batch_id = ?', [id]).n;
  if (used) {
    run('UPDATE academic_batches SET active = 0 WHERE id = ?', [id]);
    return res.json({ ok: true, archived: true, reason: 'The batch has students or tests, so it was archived instead of deleted' });
  }
  run('DELETE FROM academic_batches WHERE id = ?', [id]);
  return res.json({ ok: true, archived: false });
});

/* ── Faculty allocation ──────────────────────────────────────────────── */

academicRoutes.post('/batches/:id/faculty', managers, (req, res) => {
  const batchId = idParam(req);
  const batch = get('SELECT * FROM academic_batches WHERE id = ?', [batchId]);
  if (!batch) throw notFound('Batch not found');
  const body = parse(req.body, {
    faculty_id: { type: 'int', required: true, min: 1 },
    subject_id: { type: 'int', required: true, min: 1 },
    hourly_rate: { type: 'number', min: 0, default: 0 },
  });
  if (!get('SELECT id FROM users WHERE id = ? AND active = 1', [body.faculty_id])) throw notFound('Teacher not found');
  if (!get('SELECT id FROM academic_subjects WHERE id = ? AND course_id = ?', [body.subject_id, batch.course_id])) {
    throw badRequest('That subject is not part of this batch’s course', { subject_id: 'mismatch' });
  }
  if (get('SELECT id FROM faculty_allocations WHERE faculty_id = ? AND batch_id = ? AND subject_id = ?', [body.faculty_id, batchId, body.subject_id])) {
    throw conflict('That teacher already teaches this subject to this batch');
  }
  const info = run('INSERT INTO faculty_allocations (faculty_id, batch_id, subject_id, hourly_rate) VALUES (?, ?, ?, ?)', [
    body.faculty_id,
    batchId,
    body.subject_id,
    body.hourly_rate,
  ]);
  res.status(201).json(get('SELECT * FROM faculty_allocations WHERE id = ?', [info.lastInsertRowid]));
});

academicRoutes.delete('/faculty-allocations/:id', managers, (req, res) => {
  const info = run('DELETE FROM faculty_allocations WHERE id = ?', [idParam(req)]);
  if (!info.changes) throw notFound('Allocation not found');
  res.json({ ok: true });
});

/* ── Fee structures ──────────────────────────────────────────────────── */

const FEE_STRUCTURE_FIELDS = {
  name: { type: 'string', required: true, min: 2, max: 80 },
  total_fee: { type: 'number', required: true, min: 0 },
  installments: { type: 'int', min: 1, max: 12, default: 1 },
  interval_days: { type: 'int', min: 0, max: 365, default: 30 },
  active: { type: 'boolean' },
};

function checkComponents(body, raw) {
  if (raw === undefined) return;
  body.components = componentsJson(raw);
  const components = parseComponents(body.components);
  const total = body.total_fee;
  if (components.length && total !== undefined) {
    const sum = components.reduce((acc, c) => acc + c.amount, 0);
    if (Math.abs(sum - total) > 0.005) {
      throw badRequest(`The fee breakdown adds up to ${sum}, not the total fee of ${total}`, { components: 'must add up to the total' });
    }
  }
}

academicRoutes.post('/courses/:id/fee-structures', managers, (req, res) => {
  const courseId = idParam(req);
  if (!get('SELECT id FROM academic_courses WHERE id = ?', [courseId])) throw notFound('Course not found');
  const body = parse(req.body, FEE_STRUCTURE_FIELDS);
  checkComponents(body, req.body?.components);
  const { sql, params } = insertSql('fee_structures', { ...body, course_id: courseId });
  const info = run(sql, params);
  const row = get('SELECT * FROM fee_structures WHERE id = ?', [info.lastInsertRowid]);
  res.status(201).json({ ...row, components: parseComponents(row.components) });
});

academicRoutes.patch('/fee-structures/:id', managers, (req, res) => {
  const id = idParam(req);
  const current = get('SELECT * FROM fee_structures WHERE id = ?', [id]);
  if (!current) throw notFound('Fee structure not found');
  const body = parse(req.body, optional(FEE_STRUCTURE_FIELDS));
  checkComponents({ ...body, total_fee: body.total_fee ?? current.total_fee }, req.body?.components);
  if (req.body?.components !== undefined) body.components = componentsJson(req.body.components);
  const { sql, params } = updateSql('fee_structures', body, id);
  run(sql, params);
  const row = get('SELECT * FROM fee_structures WHERE id = ?', [id]);
  res.json({ ...row, components: parseComponents(row.components) });
});

/** Retired rather than deleted once a plan was built from it, so that plan
 * can still say where its numbers came from. */
academicRoutes.delete('/fee-structures/:id', managers, (req, res) => {
  const id = idParam(req);
  if (!get('SELECT id FROM fee_structures WHERE id = ?', [id])) throw notFound('Fee structure not found');
  if (get('SELECT COUNT(*) AS n FROM student_fee_plans WHERE fee_structure_id = ?', [id]).n) {
    run('UPDATE fee_structures SET active = 0 WHERE id = ?', [id]);
    return res.json({ ok: true, archived: true });
  }
  run('DELETE FROM fee_structures WHERE id = ?', [id]);
  return res.json({ ok: true, archived: false });
});

/* ── Classrooms ──────────────────────────────────────────────────────── */

const ROOM_FIELDS = {
  name: { type: 'string', required: true, min: 1, max: 40 },
  capacity: { type: 'int', required: true, min: 1, max: 2000 },
  notes: { type: 'string', max: 200 },
};

academicRoutes.get('/classrooms', (_req, res) => {
  res.json({
    items: all(
      `SELECT r.*, (SELECT COUNT(*) FROM academic_batches b WHERE b.active = 1 AND b.room = r.name COLLATE NOCASE) AS batch_count
       FROM classrooms r ORDER BY r.name`,
    ),
  });
});

academicRoutes.post('/classrooms', managers, (req, res) => {
  const body = parse(req.body, ROOM_FIELDS);
  if (get('SELECT id FROM classrooms WHERE name = ? COLLATE NOCASE', [body.name])) throw conflict(`${body.name} already exists`);
  const info = run('INSERT INTO classrooms (name, capacity, notes) VALUES (?, ?, ?)', [body.name, body.capacity, body.notes ?? null]);
  res.status(201).json(get('SELECT * FROM classrooms WHERE id = ?', [info.lastInsertRowid]));
});

academicRoutes.patch('/classrooms/:id', managers, (req, res) => {
  const id = idParam(req);
  if (!get('SELECT id FROM classrooms WHERE id = ?', [id])) throw notFound('Classroom not found');
  const body = parse(req.body, optional(ROOM_FIELDS));
  if (body.name && get('SELECT id FROM classrooms WHERE name = ? COLLATE NOCASE AND id != ?', [body.name, id])) {
    throw conflict(`${body.name} already exists`);
  }
  const { sql, params } = updateSql('classrooms', body, id);
  run(sql, params);
  res.json(get('SELECT * FROM classrooms WHERE id = ?', [id]));
});

academicRoutes.delete('/classrooms/:id', managers, (req, res) => {
  const info = run('DELETE FROM classrooms WHERE id = ?', [idParam(req)]);
  if (!info.changes) throw notFound('Classroom not found');
  res.json({ ok: true });
});

/* ── Faculty ─────────────────────────────────────────────────────────── */

/**
 * Teachers with what they teach, their weekly load from the timetable, and
 * this month's logged lectures — and from those, what a per-lecture or hourly
 * teacher has earned so far. A salaried teacher's figure is the salary.
 */
academicRoutes.get('/faculty', (_req, res) => {
  const monthStart = `${today().slice(0, 7)}-01`;
  const people = all(
    `SELECT u.id, u.name, u.email, u.phone, u.role, u.qualification, u.specialization, u.bio, u.pay_type, u.pay_rate
     FROM users u WHERE u.active = 1 ORDER BY u.role = 'trainer' DESC, u.name`,
  );
  const items = people.map((person) => {
    const subjects = all(
      `SELECT fa.id, fa.hourly_rate, b.id AS batch_id, b.name AS batch_name, s.name AS subject_name
       FROM faculty_allocations fa JOIN academic_batches b ON b.id = fa.batch_id JOIN academic_subjects s ON s.id = fa.subject_id
       WHERE fa.faculty_id = ? AND b.active = 1 ORDER BY b.name, s.name`,
      [person.id],
    );
    const weekly = get(
      `SELECT COUNT(*) AS lectures,
              COALESCE(SUM((CAST(substr(end_time, 1, 2) AS INTEGER) * 60 + CAST(substr(end_time, 4, 2) AS INTEGER))
                         - (CAST(substr(start_time, 1, 2) AS INTEGER) * 60 + CAST(substr(start_time, 4, 2) AS INTEGER))), 0) AS minutes
       FROM academic_timetable WHERE faculty_id = ? AND active = 1`,
      [person.id],
    );
    const month = get(
      `SELECT COUNT(*) AS lectures, COALESCE(SUM(duration_min), 0) AS minutes
       FROM lecture_logs WHERE faculty_id = ? AND lecture_date >= ?`,
      [person.id, monthStart],
    );
    const rate = Number(person.pay_rate) || 0;
    const earned =
      person.pay_type === 'salary'
        ? rate
        : person.pay_type === 'per_lecture'
          ? rate * month.lectures
          : person.pay_type === 'hourly'
            ? Math.round(rate * (month.minutes / 60) * 100) / 100
            : null;
    return {
      ...person,
      subjects,
      weekly_lectures: weekly.lectures,
      weekly_hours: Math.round((weekly.minutes / 60) * 10) / 10,
      month_lectures: month.lectures,
      month_hours: Math.round((month.minutes / 60) * 10) / 10,
      month_earned: earned,
    };
  });
  res.json({ items });
});

academicRoutes.patch('/faculty/:id', managers, (req, res) => {
  const id = idParam(req);
  if (!get('SELECT id FROM users WHERE id = ?', [id])) throw notFound('Teacher not found');
  const body = parse(req.body, {
    qualification: { type: 'string', max: 120 },
    specialization: { type: 'string', max: 120 },
    bio: { type: 'string', max: 1000 },
    pay_type: { type: 'enum', values: ['salary', 'per_lecture', 'hourly'] },
    pay_rate: { type: 'number', min: 0 },
  });
  const { sql, params } = updateSql('users', body, id);
  run(sql, params);
  res.json(get('SELECT id, name, email, phone, role, qualification, specialization, bio, pay_type, pay_rate FROM users WHERE id = ?', [id]));
});
