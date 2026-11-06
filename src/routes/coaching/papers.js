import { Router } from 'express';
import { config } from '../../config.js';
import { all, get } from '../../db.js';
import { badRequest, HttpError, notFound, tooManyRequests } from '../../errors.js';
import { parse } from '../../validate.js';
import { requireModule } from '../../verticals.js';
import {
  checkPaper,
  closeExpiredAttempts,
  generatePaper,
  generationsToday,
  generatorConfigured,
  logGeneration,
  LEVELS,
  MAX_GENERATED,
  MIXES,
  paperQuestions,
  savePaper,
  TOUGHNESS,
} from '../../coaching/papers.js';
import { idParam } from './shared.js';

/**
 * Question papers, under /api/coaching/tests (staff):
 *
 *   GET  /tests/generator    whether the DPP generator is on, and today's use
 *   POST /tests/generate     a draft paper from Gemini — nothing is stored
 *                            until the teacher saves it as a test
 *   GET  /tests/:id/paper    the questions with their answers and solutions
 *   PUT  /tests/:id/paper    replaces the paper; submitted attempts regrade
 *
 * Mounted ahead of the test routes, so /tests/generator is not read as a
 * test id. Saving a new test together with its paper is POST /tests with
 * `questions` (routes/coaching/tests.js).
 */
export const paperRoutes = Router();
paperRoutes.use('/tests', requireModule('tests'));

const GENERATE_FIELDS = {
  subject_id: { type: 'int', min: 1 },
  subject: { type: 'string', max: 80 },
  class_level: { type: 'string', max: 40 },
  topic: { type: 'string', required: true, min: 2, max: 200 },
  level: { type: 'enum', values: Object.keys(LEVELS), default: 'jee_main' },
  toughness: { type: 'enum', values: Object.keys(TOUGHNESS), default: 'mixed' },
  mix: { type: 'enum', values: MIXES, default: 'mcq' },
  count: { type: 'int', min: 1, max: MAX_GENERATED, default: 15 },
  marks: { type: 'number', min: 0.25, max: 100, default: 4 },
  instructions: { type: 'string', max: 600 },
};

paperRoutes.get('/tests/generator', (req, res) => {
  res.json({
    configured: generatorConfigured(),
    used_today: generationsToday(),
    daily_limit: config.aiTests.dailyLimit,
    max_questions: MAX_GENERATED,
    levels: Object.entries(LEVELS).map(([key, l]) => ({ key, label: l.label })),
  });
});

paperRoutes.post('/tests/generate', async (req, res) => {
  if (!generatorConfigured()) {
    throw new HttpError(503, 'The DPP generator is not set up on this server', { code: 'ai_unavailable' });
  }
  const body = parse(req.body, GENERATE_FIELDS);
  let subject = body.subject?.trim();
  if (body.subject_id) {
    const row = get('SELECT name FROM academic_subjects WHERE id = ?', [body.subject_id]);
    if (!row) throw notFound('Subject not found');
    subject = row.name;
  }
  if (!subject) throw badRequest('Pick or type a subject', { subject: 'required' });
  if (generationsToday() >= config.aiTests.dailyLimit) {
    throw tooManyRequests(`The institute has generated ${config.aiTests.dailyLimit} papers today — try again tomorrow`, { code: 'daily_limit' });
  }
  const spec = { ...body, subject };
  const paper = await generatePaper(spec);
  logGeneration({
    userId: req.user?.id,
    topic: `${subject}: ${body.topic}`,
    questions: paper.questions.length,
    input_tokens: paper.input_tokens,
    output_tokens: paper.output_tokens,
  });
  res.json({
    spec,
    questions: paper.questions,
    requested: body.count,
    dropped: paper.dropped,
    used_today: generationsToday(),
    daily_limit: config.aiTests.dailyLimit,
  });
});

/** The paper with its answer key, and how far students have got with it. */
export function staffPaper(testId) {
  const test = get('SELECT id, title, online, duration_min, answers_after, max_marks, negative_marking FROM academic_tests WHERE id = ?', [testId]);
  if (!test) throw notFound('Test not found');
  closeExpiredAttempts(testId);
  const attempts = get(
    `SELECT COUNT(*) AS started, COUNT(submitted_at) AS submitted, ROUND(AVG(score), 2) AS average
     FROM academic_test_attempts WHERE test_id = ?`,
    [testId],
  );
  return { test, questions: paperQuestions(testId), attempts };
}

paperRoutes.get('/tests/:id/paper', (req, res) => {
  res.json(staffPaper(idParam(req)));
});

paperRoutes.put('/tests/:id/paper', (req, res) => {
  const testId = idParam(req);
  if (!get('SELECT 1 FROM academic_tests WHERE id = ?', [testId])) throw notFound('Test not found');
  const clean = checkPaper(req.body?.questions, { defaultMarks: Number(req.body?.default_marks) || 4 });
  // A paper someone has answered can be corrected, but not swapped wholesale
  // for questions they never saw.
  const answered = all('SELECT answers FROM academic_test_attempts WHERE test_id = ?', [testId]);
  if (answered.length && !clean.length) {
    throw new HttpError(409, 'Students have already sat this paper — it cannot be emptied', { code: 'has_attempts' });
  }
  savePaper(testId, clean);
  res.json(staffPaper(testId));
});
