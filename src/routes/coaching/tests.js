import { Router } from 'express';
import { all, get, run, tx } from '../../db.js';
import { badRequest, conflict, notFound } from '../../errors.js';
import { parse, today } from '../../validate.js';
import { requireModule } from '../../verticals.js';
import { activeRoster } from '../../coaching/attendance.js';
import { sendScorecards } from '../../coaching/notify.js';
import { rankMarks, testStats } from '../../coaching/ranks.js';
import { dateQuery, idParam, idQuery, instituteName, optional, updateSql } from './shared.js';

/**
 * Test series: create a test for a batch, enter marks in one table, and
 * publish — which recomputes ranks and percentiles, shows the result in the
 * student app, and (optionally) WhatsApps every parent a scorecard.
 *
 * Ranks are recomputed on every marks save, not just at publish, so the marks
 * screen always shows where each student stands as the teacher types.
 */
export const testRoutes = Router();
testRoutes.use('/tests', requireModule('tests'));

export const TEST_TYPES = ['weekly', 'monthly', 'mock', 'dpp', 'other'];

const TEST_FIELDS = {
  batch_id: { type: 'int', required: true, min: 1 },
  subject_id: { type: 'int', min: 1 },
  title: { type: 'string', required: true, min: 2, max: 120 },
  test_type: { type: 'enum', values: TEST_TYPES, default: 'weekly' },
  test_date: { type: 'date', required: true },
  max_marks: { type: 'number', required: true, min: 1, max: 10000 },
  passing_marks: { type: 'number', min: 0, default: 0 },
  negative_marking: { type: 'number', min: 0, max: 100, default: 0 },
  syllabus: { type: 'string', max: 1000 },
};

const TEST_SELECT = `
  SELECT t.*, b.name AS batch_name, b.code AS batch_code, s.name AS subject_name,
         (SELECT COUNT(*) FROM academic_test_marks tm WHERE tm.test_id = t.id) AS marks_entered,
         (SELECT COUNT(*) FROM academic_test_marks tm WHERE tm.test_id = t.id AND tm.is_absent = 0) AS appeared,
         (SELECT ROUND(AVG(tm.marks_obtained), 2) FROM academic_test_marks tm WHERE tm.test_id = t.id AND tm.is_absent = 0) AS average,
         (SELECT MAX(tm.marks_obtained) FROM academic_test_marks tm WHERE tm.test_id = t.id AND tm.is_absent = 0) AS highest,
         (SELECT COUNT(*) FROM batch_enrollments e WHERE e.batch_id = t.batch_id AND e.status = 'active') AS enrolled
  FROM academic_tests t
  JOIN academic_batches b ON b.id = t.batch_id
  LEFT JOIN academic_subjects s ON s.id = t.subject_id
`;

function checkTest(body) {
  const batch = body.batch_id ? get('SELECT course_id FROM academic_batches WHERE id = ?', [body.batch_id]) : null;
  if (body.batch_id && !batch) throw notFound('Batch not found');
  if (body.subject_id && batch && !get('SELECT id FROM academic_subjects WHERE id = ? AND course_id = ?', [body.subject_id, batch.course_id])) {
    throw badRequest('That subject is not part of this batch’s course', { subject_id: 'mismatch' });
  }
  if (body.passing_marks && body.max_marks && body.passing_marks > body.max_marks) {
    throw badRequest('Passing marks cannot be more than the maximum', { passing_marks: 'above max' });
  }
}

testRoutes.get('/tests', (req, res) => {
  const where = ['t.test_date BETWEEN ? AND ?'];
  const params = [dateQuery(req, 'from', '0000-01-01'), dateQuery(req, 'to', '9999-12-31')];
  const batchId = idQuery(req, 'batch_id');
  if (batchId) {
    where.push('t.batch_id = ?');
    params.push(batchId);
  }
  if (req.query.type && TEST_TYPES.includes(req.query.type)) {
    where.push('t.test_type = ?');
    params.push(req.query.type);
  }
  res.json({ items: all(`${TEST_SELECT} WHERE ${where.join(' AND ')} ORDER BY t.test_date DESC, t.id DESC LIMIT 500`, params) });
});

testRoutes.post('/tests', (req, res) => {
  const body = parse(req.body, TEST_FIELDS);
  checkTest(body);
  const info = run(
    `INSERT INTO academic_tests (batch_id, subject_id, title, test_type, test_date, max_marks, passing_marks, negative_marking, syllabus, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      body.batch_id, body.subject_id ?? null, body.title, body.test_type, body.test_date, body.max_marks,
      body.passing_marks, body.negative_marking, body.syllabus ?? null, req.user?.id ?? null,
    ],
  );
  res.status(201).json(get(`${TEST_SELECT} WHERE t.id = ?`, [info.lastInsertRowid]));
});

testRoutes.patch('/tests/:id', (req, res) => {
  const id = idParam(req);
  const current = get('SELECT * FROM academic_tests WHERE id = ?', [id]);
  if (!current) throw notFound('Test not found');
  const body = parse(req.body, optional(TEST_FIELDS));
  if (body.batch_id && body.batch_id !== current.batch_id && get('SELECT 1 FROM academic_test_marks WHERE test_id = ?', [id])) {
    throw conflict('Marks are already entered for this test, so it cannot move to another batch');
  }
  checkTest({ ...current, ...body });
  if (body.max_marks && body.max_marks < current.max_marks) {
    const top = get('SELECT MAX(marks_obtained) AS top FROM academic_test_marks WHERE test_id = ?', [id]).top;
    if (top !== null && top > body.max_marks) throw conflict(`A student already has ${top}, above that maximum`, { max_marks: 'below a score' });
  }
  const { sql, params } = updateSql('academic_tests', body, id);
  run(sql, params);
  res.json(get(`${TEST_SELECT} WHERE t.id = ?`, [id]));
});

testRoutes.delete('/tests/:id', (req, res) => {
  const info = run('DELETE FROM academic_tests WHERE id = ?', [idParam(req)]);
  if (!info.changes) throw notFound('Test not found');
  res.json({ ok: true });
});

/** The marks sheet: every student on the batch's roster (plus anyone who has
 * a mark but has since left), with their mark, rank and percentile. */
function marksSheet(testId) {
  const test = get(`${TEST_SELECT} WHERE t.id = ?`, [testId]);
  if (!test) return null;
  const marks = new Map(all('SELECT * FROM academic_test_marks WHERE test_id = ?', [testId]).map((m) => [m.member_id, m]));
  const roster = activeRoster(test.batch_id);
  const onRoster = new Set(roster.map((r) => r.member_id));
  const leavers = all(
    `SELECT tm.member_id, m.code AS member_code, m.first_name, m.last_name, NULL AS roll_number
     FROM academic_test_marks tm JOIN members m ON m.id = tm.member_id WHERE tm.test_id = ?`,
    [testId],
  ).filter((row) => !onRoster.has(row.member_id));
  const items = [...roster, ...leavers].map((student) => {
    const mark = marks.get(student.member_id);
    return {
      member_id: student.member_id,
      member_code: student.member_code,
      roll_number: student.roll_number,
      first_name: student.first_name,
      last_name: student.last_name,
      entered: Boolean(mark),
      marks_obtained: mark?.marks_obtained ?? null,
      is_absent: mark ? Boolean(mark.is_absent) : false,
      rank: mark?.rank ?? null,
      percentile: mark?.percentile ?? null,
      remarks: mark?.remarks ?? null,
      whatsapp_sent: Boolean(mark?.whatsapp_sent),
    };
  });
  const entered = items.filter((i) => i.entered).map((i) => ({ ...i, is_absent: i.is_absent ? 1 : 0 }));
  return { test, items, stats: testStats(entered, { maxMarks: test.max_marks, passingMarks: test.passing_marks }) };
}

/** Writes ranks and percentiles for the whole test from its current marks. */
function recomputeRanks(testId) {
  const rows = all('SELECT id, marks_obtained, is_absent FROM academic_test_marks WHERE test_id = ?', [testId]);
  for (const row of rankMarks(rows)) {
    run('UPDATE academic_test_marks SET rank = ?, percentile = ? WHERE id = ?', [row.rank, row.percentile, row.id]);
  }
}

testRoutes.get('/tests/:id', (req, res) => {
  const sheet = marksSheet(idParam(req));
  if (!sheet) throw notFound('Test not found');
  res.json(sheet);
});

/**
 * Fast marks entry: [{ member_id, marks_obtained, is_absent, remarks }] for
 * any number of students at once. A row with neither marks nor absent is
 * cleared (the teacher deleted what they typed). Marks are bounded by the
 * paper: up to max_marks, and below zero only on a negatively-marked test.
 */
testRoutes.put('/tests/:id/marks', (req, res) => {
  const testId = idParam(req);
  const test = get('SELECT * FROM academic_tests WHERE id = ?', [testId]);
  if (!test) throw notFound('Test not found');
  const entries = req.body?.entries;
  if (!Array.isArray(entries) || !entries.length) throw badRequest('Enter at least one mark', { entries: 'required' });
  const enrolled = new Set(activeRoster(test.batch_id).map((r) => r.member_id));
  const existing = new Set(all('SELECT member_id FROM academic_test_marks WHERE test_id = ?', [testId]).map((r) => r.member_id));
  const floor = test.negative_marking > 0 ? -test.max_marks : 0;

  const clean = entries.map((entry) => {
    const memberId = Number(entry?.member_id);
    if (!enrolled.has(memberId) && !existing.has(memberId)) {
      throw badRequest('One of those students is not in this batch', { entries: 'not enrolled' });
    }
    const absent = entry.is_absent === true || entry.is_absent === 1 || entry.is_absent === '1';
    const blank = entry.marks_obtained === null || entry.marks_obtained === undefined || entry.marks_obtained === '';
    if (absent || blank) return { memberId, absent, clear: !absent && blank, marks: 0, remarks: entry.remarks ?? null };
    const marks = Number(entry.marks_obtained);
    if (!Number.isFinite(marks) || marks > test.max_marks || marks < floor) {
      throw badRequest(`Marks must be between ${floor} and ${test.max_marks}`, { entries: 'out of range' });
    }
    return { memberId, absent: false, clear: false, marks: Math.round(marks * 100) / 100, remarks: entry.remarks ? String(entry.remarks).slice(0, 200) : null };
  });

  tx(() => {
    for (const row of clean) {
      if (row.clear) {
        run('DELETE FROM academic_test_marks WHERE test_id = ? AND member_id = ?', [testId, row.memberId]);
        continue;
      }
      run(
        `INSERT INTO academic_test_marks (test_id, member_id, marks_obtained, is_absent, remarks)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (test_id, member_id) DO UPDATE SET
           marks_obtained = excluded.marks_obtained, is_absent = excluded.is_absent, remarks = excluded.remarks,
           -- a corrected mark after publishing earns the parent a fresh scorecard
           whatsapp_sent = CASE WHEN academic_test_marks.marks_obtained != excluded.marks_obtained
                                  OR academic_test_marks.is_absent != excluded.is_absent THEN 0 ELSE academic_test_marks.whatsapp_sent END,
           updated_at = datetime('now')`,
        [testId, row.memberId, row.marks, row.absent ? 1 : 0, row.remarks],
      );
    }
    recomputeRanks(testId);
  });
  res.json(marksSheet(testId));
});

/**
 * Publishing: the result appears in the student app, and with `notify`
 * every parent whose child sat the paper (and has not had this scorecard
 * yet) gets it on WhatsApp. Publishing again after corrections only sends to
 * the students whose marks changed.
 */
testRoutes.post('/tests/:id/publish', (req, res) => {
  const testId = idParam(req);
  const body = parse(req.body, { notify: { type: 'boolean', default: 1 } });
  const before = marksSheet(testId);
  if (!before) throw notFound('Test not found');
  if (!before.stats.appeared && !before.stats.absent) throw badRequest('Enter the marks before publishing');
  recomputeRanks(testId);
  run("UPDATE academic_tests SET published_at = COALESCE(published_at, datetime('now')) WHERE id = ?", [testId]);
  const sheet = marksSheet(testId);
  const whatsapp = body.notify ? sendScorecards(testId, { instituteName: instituteName(req), stats: sheet.stats }) : { queued: 0 };
  res.json({ ...sheet, whatsapp });
});

testRoutes.post('/tests/:id/unpublish', (req, res) => {
  const id = idParam(req);
  if (!run('UPDATE academic_tests SET published_at = NULL WHERE id = ?', [id]).changes) throw notFound('Test not found');
  res.json(get(`${TEST_SELECT} WHERE t.id = ?`, [id]));
});

/**
 * A student's report card: every test with their score against the batch's
 * average and topper, and an average percentage per subject — the
 * "quarterly performance card" the front end prints.
 */
export function reportCard(memberId, { from = '0000-01-01', to = '9999-12-31', publishedOnly = false } = {}) {
  const tests = all(
    `SELECT t.id, t.title, t.test_type, t.test_date, t.max_marks, t.passing_marks, t.published_at,
            b.name AS batch_name, s.name AS subject_name,
            tm.marks_obtained, tm.is_absent, tm.rank, tm.percentile, tm.remarks,
            (SELECT COUNT(*) FROM academic_test_marks x WHERE x.test_id = t.id AND x.is_absent = 0) AS appeared,
            (SELECT ROUND(AVG(x.marks_obtained), 2) FROM academic_test_marks x WHERE x.test_id = t.id AND x.is_absent = 0) AS average,
            (SELECT MAX(x.marks_obtained) FROM academic_test_marks x WHERE x.test_id = t.id AND x.is_absent = 0) AS highest
     FROM academic_test_marks tm
     JOIN academic_tests t ON t.id = tm.test_id
     JOIN academic_batches b ON b.id = t.batch_id
     LEFT JOIN academic_subjects s ON s.id = t.subject_id
     WHERE tm.member_id = ? AND t.test_date BETWEEN ? AND ? ${publishedOnly ? 'AND t.published_at IS NOT NULL' : ''}
     ORDER BY t.test_date DESC, t.id DESC`,
    [memberId, from, to],
  );
  const bySubject = {};
  for (const t of tests) {
    if (t.is_absent) continue;
    const key = t.subject_name || 'Combined';
    const entry = (bySubject[key] ??= { subject_name: key, tests: 0, percentage_total: 0, best: null });
    const pct = (t.marks_obtained / t.max_marks) * 100;
    entry.tests += 1;
    entry.percentage_total += pct;
    entry.best = entry.best === null ? pct : Math.max(entry.best, pct);
  }
  const subjects = Object.values(bySubject).map((s) => ({
    subject_name: s.subject_name,
    tests: s.tests,
    average_percentage: Math.round((s.percentage_total / s.tests) * 10) / 10,
    best_percentage: Math.round(s.best * 10) / 10,
  }));
  const sat = tests.filter((t) => !t.is_absent);
  return {
    tests,
    subjects,
    overall_percentage: sat.length ? Math.round((sat.reduce((acc, t) => acc + (t.marks_obtained / t.max_marks) * 100, 0) / sat.length) * 10) / 10 : null,
    tests_taken: sat.length,
    tests_missed: tests.length - sat.length,
  };
}

testRoutes.get('/tests/students/:id/report-card', (req, res) => {
  const memberId = idParam(req);
  const member = get('SELECT id, code, first_name, last_name, school_name, current_class, exam_target FROM members WHERE id = ?', [memberId]);
  if (!member) throw notFound('Student not found');
  res.json({
    member,
    from: dateQuery(req, 'from', null),
    to: dateQuery(req, 'to', today()),
    ...reportCard(memberId, { from: dateQuery(req, 'from', '0000-01-01'), to: dateQuery(req, 'to', '9999-12-31') }),
  });
});
