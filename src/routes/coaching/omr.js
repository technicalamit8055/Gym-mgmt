import { Router } from 'express';
import { all, get, run, tx } from '../../db.js';
import { badRequest, conflict, notFound } from '../../errors.js';
import { parse } from '../../validate.js';
import { requireModule } from '../../verticals.js';
import { activeRoster } from '../../coaching/attendance.js';
import { cleanResponse, gradeResponse, MAX_QUESTIONS, parseAnswerKey, questionStats } from '../../coaching/omr.js';
import { omrSheetPdf } from '../../coaching/omrSheet.js';
import { rankMarks } from '../../coaching/ranks.js';
import { OPTION_LABELS, rollDigits } from '../../../public/js/omrLayout.js';
import { idParam, instituteName } from './shared.js';

/**
 * OMR sheet marking for a test — the server half of the phone scanner.
 *
 *   GET    /tests/:id/omr              the paper's shape, key, roster and who is scanned
 *   PUT    /tests/:id/omr              set the shape and (optionally) the answer key
 *   GET    /tests/:id/omr/sheet.pdf    the printable sheet; ?named=1 for one page per student
 *   POST   /tests/:id/omr/scans        one scanned sheet: grade it, save the mark, re-rank
 *   DELETE /tests/:id/omr/scans/:mid   take a scan (and the mark it made) back out
 *
 * The phone reads the bubbles; the server holds the key and does the
 * marking, so a key never has to be trusted to a phone and the score is
 * worked out one way for everyone. A scan becomes an ordinary
 * academic_test_marks row, so ranks, publishing and the WhatsApp scorecard
 * are the test series' own — publishing from the scanner is the same publish.
 */
export const omrRoutes = Router();
omrRoutes.use('/tests', requireModule('tests'));

const OMR_FIELDS = {
  questions: { type: 'int', required: true, min: 1, max: MAX_QUESTIONS },
  options: { type: 'int', min: 2, max: OPTION_LABELS.length, default: 4 },
  marks_correct: { type: 'number', required: true, min: 0.25, max: 100 },
};

function loadTest(id) {
  const test = get(
    `SELECT t.*, b.name AS batch_name, s.name AS subject_name
     FROM academic_tests t JOIN academic_batches b ON b.id = t.batch_id
     LEFT JOIN academic_subjects s ON s.id = t.subject_id WHERE t.id = ?`,
    [id],
  );
  if (!test) throw notFound('Test not found');
  return test;
}

const keyOf = (test) => (test.omr_answer_key ? JSON.parse(test.omr_answer_key) : null);
const paperOf = (test) => ({ questions: test.omr_questions, options: test.omr_options });
const scheme = (test) => ({ marksCorrect: test.omr_marks_correct, negative: test.negative_marking || 0 });

/** Ranks and percentiles for the whole test from its current marks. */
function rerank(testId) {
  const rows = all('SELECT id, marks_obtained, is_absent FROM academic_test_marks WHERE test_id = ?', [testId]);
  for (const row of rankMarks(rows)) run('UPDATE academic_test_marks SET rank = ?, percentile = ? WHERE id = ?', [row.rank, row.percentile, row.id]);
}

/** Writes a scanned score as the student's mark. A changed score re-arms the parent's scorecard, as a typed correction does. */
function writeMark(testId, memberId, score) {
  run(
    `INSERT INTO academic_test_marks (test_id, member_id, marks_obtained, is_absent)
     VALUES (?, ?, ?, 0)
     ON CONFLICT (test_id, member_id) DO UPDATE SET
       marks_obtained = excluded.marks_obtained, is_absent = 0,
       whatsapp_sent = CASE WHEN academic_test_marks.marks_obtained != excluded.marks_obtained
                              OR academic_test_marks.is_absent != 0 THEN 0 ELSE academic_test_marks.whatsapp_sent END,
       updated_at = datetime('now')`,
    [testId, memberId, score],
  );
}

/** Re-marks every scanned sheet against the test's current key and scheme. */
export function regradeOmr(testId) {
  const test = loadTest(testId);
  const key = keyOf(test);
  if (!key) return 0;
  const responses = all('SELECT id, member_id, answers FROM academic_omr_responses WHERE test_id = ?', [testId]);
  for (const r of responses) {
    const g = gradeResponse(key, JSON.parse(r.answers), scheme(test));
    run('UPDATE academic_omr_responses SET correct = ?, wrong = ?, blank = ?, score = ? WHERE id = ?', [g.correct, g.wrong, g.blank, g.score, r.id]);
    writeMark(testId, r.member_id, g.score);
  }
  if (responses.length) rerank(testId);
  return responses.length;
}

/**
 * The answer key from the test's own question paper (the DPP generator /
 * question bank), when every question is a four-option MCQ — so a paper set
 * in the app can be sat on printed OMR sheets with no key typed twice.
 */
function paperKey(testId) {
  try {
    const rows = all('SELECT kind, correct_option FROM academic_test_questions WHERE test_id = ? ORDER BY position, id', [testId]);
    if (!rows.length || rows.length > MAX_QUESTIONS || rows.some((r) => r.kind !== 'mcq' || r.correct_option === null)) return null;
    return rows.map((r) => OPTION_LABELS[r.correct_option]);
  } catch {
    return null; // a database from before question papers existed
  }
}

function omrState(testId) {
  const test = loadTest(testId);
  const key = keyOf(test);
  const responses = new Map(all('SELECT * FROM academic_omr_responses WHERE test_id = ?', [testId]).map((r) => [r.member_id, r]));
  const marks = new Map(all('SELECT member_id, rank, marks_obtained, is_absent FROM academic_test_marks WHERE test_id = ?', [testId]).map((m) => [m.member_id, m]));
  const roster = activeRoster(test.batch_id).map((s) => {
    const r = responses.get(s.member_id);
    const mark = marks.get(s.member_id);
    return {
      member_id: s.member_id,
      member_code: s.member_code,
      first_name: s.first_name,
      last_name: s.last_name,
      roll_number: s.roll_number,
      roll_digits: rollDigits(s.roll_number),
      scanned: Boolean(r),
      answers: r ? JSON.parse(r.answers) : null,
      correct: r?.correct ?? null,
      wrong: r?.wrong ?? null,
      blank: r?.blank ?? null,
      score: r?.score ?? null,
      scanned_at: r?.scanned_at ?? null,
      rank: mark?.rank ?? null,
      marked_by_hand: Boolean(mark && !r),
    };
  });
  return {
    test: {
      id: test.id,
      title: test.title,
      batch_id: test.batch_id,
      batch_name: test.batch_name,
      subject_name: test.subject_name,
      test_date: test.test_date,
      max_marks: test.max_marks,
      negative_marking: test.negative_marking,
      published_at: test.published_at,
    },
    configured: Boolean(test.omr_questions),
    questions: test.omr_questions,
    options: test.omr_options,
    marks_correct: test.omr_marks_correct,
    answer_key: key,
    paper_key: paperKey(testId),
    roster,
    scanned: responses.size,
    question_stats: key && responses.size ? questionStats(key, [...responses.values()].map((r) => JSON.parse(r.answers))) : null,
  };
}

omrRoutes.get('/tests/:id/omr', (req, res) => {
  res.json(omrState(idParam(req)));
});

/**
 * Sets the paper's shape and marking, and the key when it is ready — the
 * shape alone is enough to print sheets before the key is final. The
 * test's max_marks becomes questions × marks per question. A changed key or
 * marking re-grades every sheet already scanned; the shape cannot change
 * once sheets are scanned, since they were read against it.
 */
omrRoutes.put('/tests/:id/omr', (req, res) => {
  const testId = idParam(req);
  const test = loadTest(testId);
  const body = parse(req.body, OMR_FIELDS);
  const hasKey = req.body?.answer_key !== undefined && req.body?.answer_key !== null && req.body?.answer_key !== '';
  const key = hasKey ? parseAnswerKey(req.body.answer_key, body) : null;
  const scanned = get('SELECT COUNT(*) AS n FROM academic_omr_responses WHERE test_id = ?', [testId]).n;
  if (scanned && (body.questions !== test.omr_questions || body.options !== test.omr_options)) {
    throw conflict(`${scanned} sheet${scanned === 1 ? ' is' : 's are'} already scanned against ${test.omr_questions} questions × ${test.omr_options} options. Delete those scans to change the paper.`);
  }
  if (scanned && !key) throw badRequest('Sheets are already scanned, so the answer key cannot be removed', { answer_key: 'required' });
  const maxMarks = Math.round(body.questions * body.marks_correct * 100) / 100;
  // A test with a question paper already has its maximum set by the paper
  // (src/coaching/papers.js recomputes it on every paper save), so the OMR
  // marking has to agree with it rather than overwrite it.
  const paperTotal = (() => {
    try {
      return get('SELECT COUNT(*) AS n, SUM(marks) AS total FROM academic_test_questions WHERE test_id = ?', [testId]);
    } catch {
      return null;
    }
  })();
  if (paperTotal?.n && Math.abs(paperTotal.total - maxMarks) > 0.001) {
    throw conflict(`This test’s question paper is out of ${paperTotal.total}, but ${body.questions} questions × ${body.marks_correct} is ${maxMarks}. Make them match.`, { marks_correct: 'paper mismatch' });
  }
  const typedTop = get(
    `SELECT MAX(tm.marks_obtained) AS top FROM academic_test_marks tm
     WHERE tm.test_id = ? AND NOT EXISTS (SELECT 1 FROM academic_omr_responses r WHERE r.test_id = tm.test_id AND r.member_id = tm.member_id)`,
    [testId],
  ).top;
  if (typedTop !== null && typedTop > maxMarks) throw conflict(`A student already has ${typedTop} typed in, above this paper's ${maxMarks}`);
  tx(() => {
    run('UPDATE academic_tests SET omr_questions = ?, omr_options = ?, omr_marks_correct = ?, omr_answer_key = ?, max_marks = ? WHERE id = ?', [
      body.questions, body.options, body.marks_correct, key ? JSON.stringify(key) : null, maxMarks, testId,
    ]);
    regradeOmr(testId);
  });
  res.json(omrState(testId));
});

omrRoutes.get('/tests/:id/omr/sheet.pdf', async (req, res) => {
  const test = loadTest(idParam(req));
  if (!test.omr_questions) throw badRequest('Set the number of questions first');
  const named = req.query.named === '1' || req.query.named === 'true';
  const students = named
    ? activeRoster(test.batch_id).map((s) => ({ name: `${s.first_name || ''} ${s.last_name || ''}`.trim(), roll: s.roll_number }))
    : null;
  if (named && !students.length) throw badRequest('Nobody is enrolled in this batch');
  const pdf = await omrSheetPdf({ institute: instituteName(req), test, students });
  const safe = test.title.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_').slice(0, 60) || 'test';
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `attachment; filename="OMR_${safe}${named ? '_named' : ''}.pdf"`);
  res.send(pdf);
});

/**
 * One scanned sheet: { member_id, answers: ['A', '', 'BD', …] }. Graded
 * here against the key, saved as the student's mark, and the whole test is
 * re-ranked — so the reply carries the student's rank as it stands now.
 * Scanning the same student again replaces their sheet.
 */
omrRoutes.post('/tests/:id/omr/scans', (req, res) => {
  const testId = idParam(req);
  const test = loadTest(testId);
  const key = keyOf(test);
  if (!key) throw badRequest('Enter the answer key before scanning sheets');
  const { member_id: memberId } = parse(req.body, { member_id: { type: 'int', required: true, min: 1 } });
  const onRoster = activeRoster(test.batch_id).some((s) => s.member_id === memberId);
  if (!onRoster && !get('SELECT 1 FROM academic_test_marks WHERE test_id = ? AND member_id = ?', [testId, memberId])) {
    throw badRequest('That student is not in this batch', { member_id: 'not enrolled' });
  }
  const answers = cleanResponse(req.body?.answers, paperOf(test));
  const g = gradeResponse(key, answers, scheme(test));
  const replaced = Boolean(get('SELECT 1 FROM academic_omr_responses WHERE test_id = ? AND member_id = ?', [testId, memberId]));
  tx(() => {
    run(
      `INSERT INTO academic_omr_responses (test_id, member_id, answers, correct, wrong, blank, score, scanned_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (test_id, member_id) DO UPDATE SET
         answers = excluded.answers, correct = excluded.correct, wrong = excluded.wrong, blank = excluded.blank,
         score = excluded.score, scanned_by = excluded.scanned_by, scanned_at = datetime('now')`,
      [testId, memberId, JSON.stringify(answers), g.correct, g.wrong, g.blank, g.score, req.user?.id ?? null],
    );
    writeMark(testId, memberId, g.score);
    rerank(testId);
  });
  const mark = get('SELECT rank FROM academic_test_marks WHERE test_id = ? AND member_id = ?', [testId, memberId]);
  const counts = get(
    `SELECT (SELECT COUNT(*) FROM academic_omr_responses WHERE test_id = ?) AS scanned,
            (SELECT COUNT(*) FROM academic_test_marks WHERE test_id = ? AND is_absent = 0) AS appeared`,
    [testId, testId],
  );
  res.status(replaced ? 200 : 201).json({
    member_id: memberId,
    replaced,
    answers,
    correct: g.correct,
    wrong: g.wrong,
    blank: g.blank,
    bonus: g.bonus,
    score: g.score,
    max_marks: test.max_marks,
    outcome: g.outcome,
    rank: mark?.rank ?? null,
    scanned: counts.scanned,
    appeared: counts.appeared,
  });
});

omrRoutes.delete('/tests/:id/omr/scans/:memberId', (req, res) => {
  const testId = idParam(req);
  const memberId = idParam(req, 'memberId');
  loadTest(testId);
  tx(() => {
    if (!run('DELETE FROM academic_omr_responses WHERE test_id = ? AND member_id = ?', [testId, memberId]).changes) throw notFound('No scanned sheet for that student');
    run('DELETE FROM academic_test_marks WHERE test_id = ? AND member_id = ?', [testId, memberId]);
    rerank(testId);
  });
  res.json(omrState(testId));
});
