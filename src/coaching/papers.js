import { coachConfigured, getClient } from '../aiCoach.js';
import { config } from '../config.js';
import { all, get, run, tx } from '../db.js';
import { badRequest, HttpError } from '../errors.js';
import { rankMarks } from './ranks.js';

/**
 * Question papers: the questions a test carries, the DPP generator that
 * writes them, and the student's attempt in the app.
 *
 * A paper is plain text with LaTeX between $…$ (display maths between
 * $$…$$) — the student app and the printed paper both typeset it with KaTeX
 * (public/js/math.js). Two kinds of question, the two JEE Main has: a
 * single-correct MCQ (four options, the answer is the option's index) and a
 * numerical-answer question (a value, with a tolerance for a decimal one).
 *
 * The generator asks Gemini for the paper as JSON, with each question's
 * worked solution written *before* its answer, so the answer is the end of
 * the working rather than a guess the working then has to justify. Every
 * question is checked here before a teacher sees it: four distinct options,
 * an answer that exists, balanced maths. One that fails is dropped, and a
 * paper that comes back short is topped up once.
 *
 * An attempt is graded on submit and written into academic_test_marks like a
 * mark the teacher typed, so ranks, publishing and the WhatsApp scorecard are
 * the ones the paper tests already use. Correcting a question afterwards
 * regrades every submitted attempt.
 */

export const LEVELS = {
  foundation: { label: 'Foundation (Class 6–10)', brief: 'Foundation level for Class 6–10: concept-building questions of one or two steps, clear numbers, no tricks.' },
  board: { label: 'Board / NCERT', brief: 'CBSE and state-board level, as in NCERT exercises and board papers: direct application of one concept.' },
  jee_main: { label: 'JEE Main', brief: 'JEE Main level: one or two concepts per question, solvable in about two to three minutes, with calculation that rewards the right method.' },
  jee_advanced: { label: 'JEE Advanced', brief: 'JEE Advanced level: multi-concept questions that need deeper reasoning, several steps and careful handling of edge cases.' },
  neet: { label: 'NEET', brief: 'NEET level: firmly NCERT-based, quick conceptual and short numerical questions, about one minute each.' },
  olympiad: { label: 'Olympiad', brief: 'Olympiad level: non-routine problems that need insight rather than a formula.' },
};

export const TOUGHNESS = {
  mixed: 'a mix: roughly a third easy, a third medium and a third hard, easiest first',
  easy: 'easy for this level',
  medium: 'medium for this level',
  hard: 'hard for this level',
};

/** Which kinds of question: all MCQ, JEE Main's 2:1 MCQ and numerical, or all numerical. */
export const MIXES = ['mcq', 'mixed', 'numeric'];

export const MAX_QUESTIONS = 100;
export const MAX_GENERATED = 30;
const DIFFICULTIES = ['easy', 'medium', 'hard'];
const LETTERS = ['A', 'B', 'C', 'D'];
/** Past the deadline, a save or submit still counts for this long — the
 * last answer tapped as the clock ran out, on a slow phone network. */
export const GRACE_SECONDS = 60;

/* ── Checking a question ─────────────────────────────────────────────── */

/** Whether every $ in `text` (not \$, a literal dollar) has its partner. */
export function balancedMath(text) {
  return ((String(text ?? '').match(/(?<!\\)\$/g) ?? []).length) % 2 === 0;
}

/** Trimmed text, line endings normalised and runs of blank lines collapsed. */
const tidy = (value) =>
  String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/** "Q3. A ball…" → "A ball…"; "(B) 5 m/s" → "5 m/s". */
const stripNumbering = (text) => text.replace(/^(?:Q(?:uestion)?\s*\.?\s*)?\d{1,3}\s*[.):]\s+/i, '');
const stripLetter = (text) => text.replace(/^(?:\(\s*[A-Da-d]\s*\)|[A-D]\s*[.):]|[a-d]\))\s*/, '');

const round2 = (n) => Math.round(n * 100) / 100;

/** The option a model or a form named: an index, or a letter A–D. */
function optionIndex(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  const s = String(value ?? '').trim().replace(/[().]/g, '').toUpperCase();
  if (/^[0-3]$/.test(s)) return Number(s);
  return LETTERS.indexOf(s);
}

function checkText(text, what, { required = true, max }) {
  const clean = tidy(text);
  if (!clean) {
    if (required) throw new Error(`${what} is empty`);
    return null;
  }
  if (clean.length > max) throw new Error(`${what} is too long (${max} characters at most)`);
  if (!balancedMath(clean)) throw new Error(`${what} has a $ without its closing $`);
  return clean;
}

/**
 * One question, cleaned, or an Error saying what is wrong with it. Used on
 * the model's output (where a bad question is dropped) and on a teacher's
 * edit (where it is a 400 naming the question).
 */
export function checkQuestion(raw, { defaultMarks = 4 } = {}) {
  if (!raw || typeof raw !== 'object') throw new Error('is not a question');
  const kind = raw.kind === 'numeric' ? 'numeric' : 'mcq';
  const question = stripNumbering(checkText(raw.question, 'The question', { max: 4000 }));
  if (question.length < 5) throw new Error('The question is too short');
  const marks = raw.marks === undefined || raw.marks === null || raw.marks === '' ? defaultMarks : Number(raw.marks);
  if (!Number.isFinite(marks) || marks <= 0 || marks > 100) throw new Error('Marks must be between 0 and 100');
  const clean = {
    kind,
    question,
    options: null,
    correct_option: null,
    answer_value: null,
    answer_tolerance: 0,
    hint: checkText(raw.hint, 'The hint', { required: false, max: 600 }),
    solution: checkText(raw.solution, 'The solution', { required: false, max: 6000 }),
    marks: round2(marks),
    difficulty: DIFFICULTIES.includes(raw.difficulty) ? raw.difficulty : null,
  };

  if (kind === 'mcq') {
    if (!Array.isArray(raw.options) || raw.options.length !== 4) throw new Error('An MCQ needs exactly four options');
    clean.options = raw.options.map((o, i) => stripLetter(checkText(o, `Option ${LETTERS[i]}`, { max: 600 })));
    if (clean.options.some((o) => !o)) throw new Error('An option is empty');
    const seen = new Set(clean.options.map((o) => o.toLowerCase().replace(/\s+/g, '')));
    if (seen.size !== 4) throw new Error('Two options are the same');
    const correct = optionIndex(raw.correct_option);
    if (!(correct >= 0 && correct <= 3)) throw new Error('Pick the correct option');
    clean.correct_option = correct;
  } else {
    const value = Number(String(raw.answer_value ?? '').trim().replace(/,/g, ''));
    if (raw.answer_value === null || raw.answer_value === undefined || String(raw.answer_value).trim() === '' || !Number.isFinite(value)) {
      throw new Error('A numerical question needs its answer as a number');
    }
    const given = raw.answer_tolerance === undefined || raw.answer_tolerance === null || raw.answer_tolerance === '' ? null : Number(raw.answer_tolerance);
    if (given !== null && (!Number.isFinite(given) || given < 0)) throw new Error('The tolerance must be zero or more');
    // A decimal answer is accepted to its last printed place; a whole number exactly.
    const tolerance = given ?? (Number.isInteger(value) ? 0 : 0.01);
    if (tolerance > Math.max(1, Math.abs(value))) throw new Error('The tolerance is larger than the answer itself');
    clean.answer_value = value;
    clean.answer_tolerance = tolerance;
  }
  return clean;
}

/** The text two questions are compared by, so a repeat is caught. */
const fingerprint = (q) => q.question.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 160);

/* ── The generator ───────────────────────────────────────────────────── */

export const generatorConfigured = () => coachConfigured();

/** Papers generated in the last 24 hours, against config.aiTests.dailyLimit. */
export const generationsToday = () => get("SELECT COUNT(*) AS n FROM ai_test_generations WHERE created_at >= datetime('now', '-1 day')").n;

const SYSTEM_INSTRUCTION = `You set practice papers (DPPs — Daily Practice Problems — and tests) for Indian coaching institutes preparing students for school boards, JEE and NEET. A teacher names the class, subject, topic and level; you write the questions, and the teacher checks them before students see them.

Every question:
- Is on the requested topic only, at the requested level, and can be solved from its text alone. There are no figures, diagrams, graphs or tables to look at, so never write "in the figure" or "shown below"; describe any set-up fully in words.
- Is original and different from the others: vary the sub-topic, the situation and the numbers. Use numbers that work out cleanly by hand.
- States units where they matter and says which unit a numerical answer is in ("in m/s", "in kJ").

Maths and science notation is LaTeX inside dollar signs: $\\vec{A} \\cdot \\vec{B}$, $\\frac{1}{2}mv^2$, $3\\hat{i} + 4\\hat{j}$, $60^\\circ$, $\\sqrt{3}$, chemical formulae like $\\mathrm{H_2SO_4}$. Use $$…$$ only for a long equation on its own line. Never use \\( \\) or \\[ \\]. Close every $ you open. Write prose as plain text: no markdown, no asterisks, no headings, and do not number the questions or letter the options yourself.

A single-correct MCQ ("mcq") has exactly four options. Exactly one is correct; the other three are the answers that common mistakes produce (a sign slip, a missed factor, the wrong formula). Never use "All of the above" or "None of these".

A numerical-answer question ("numeric") has a single number as its answer — an integer where possible, otherwise rounded to two decimal places, and the question says to round it.

For each question, write "solution" first: a short, correct, step-by-step working that ends with the final answer. Actually work it out — then give the answer ("correct_option" or "answer_value") that the solution arrived at. They must agree. If a question turns out ambiguous or unsolvable while you work it, replace it with a different question.

"hint" is one sentence pointing at the idea or first step, without giving away the answer.

"difficulty" is easy, medium or hard relative to the requested level.`;

const QUESTION_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['mcq', 'numeric'] },
          difficulty: { type: 'string', enum: DIFFICULTIES },
          question: { type: 'string' },
          options: { type: 'array', items: { type: 'string' }, description: 'Exactly four for an mcq; empty for numeric' },
          solution: { type: 'string' },
          correct_option: { type: 'string', enum: LETTERS, description: 'mcq only' },
          answer_value: { type: 'number', description: 'numeric only' },
          hint: { type: 'string' },
        },
        required: ['kind', 'difficulty', 'question', 'solution', 'hint'],
      },
    },
  },
  required: ['questions'],
};

/** How many of each kind a paper of `count` gets. */
export function splitMix(mix, count) {
  if (mix === 'numeric') return { mcq: 0, numeric: count };
  if (mix === 'mixed') {
    const numeric = Math.max(1, Math.round(count / 3));
    return { mcq: count - numeric, numeric };
  }
  return { mcq: count, numeric: 0 };
}

function requestText(spec, counts, existing) {
  const lines = [
    'PAPER REQUEST',
    spec.class_level ? `Class: ${spec.class_level}` : null,
    `Subject: ${spec.subject}`,
    `Topic: ${spec.topic}`,
    `Level: ${LEVELS[spec.level].label}. ${LEVELS[spec.level].brief}`,
    `Difficulty: ${TOUGHNESS[spec.toughness]}.`,
    `Write ${counts.mcq + counts.numeric} questions: ${[
      counts.mcq ? `${counts.mcq} single-correct MCQ${counts.mcq === 1 ? '' : 's'}` : null,
      counts.numeric ? `${counts.numeric} numerical-answer question${counts.numeric === 1 ? '' : 's'}` : null,
    ]
      .filter(Boolean)
      .join(', then ')}.`,
    spec.instructions ? `The teacher adds: ${spec.instructions}` : null,
  ];
  if (existing.length) {
    lines.push('', 'The paper already has these questions. Do not repeat them or their ideas:');
    for (const q of existing) lines.push(`- ${q.question.slice(0, 140).replace(/\s+/g, ' ')}`);
  }
  return lines.filter((l) => l !== null).join('\n');
}

/** The model's reply, as questions that passed checkQuestion(). */
export function parseGenerated(rawText, { defaultMarks = 4 } = {}) {
  let data;
  try {
    data = JSON.parse(String(rawText ?? ''));
  } catch {
    return { questions: [], dropped: 0, unreadable: true };
  }
  const list = Array.isArray(data?.questions) ? data.questions : [];
  const questions = [];
  let dropped = 0;
  for (const raw of list) {
    try {
      // The schema sends an empty options list on a numerical question.
      const kind = raw?.kind === 'numeric' ? 'numeric' : 'mcq';
      questions.push(checkQuestion({ ...raw, kind, marks: defaultMarks }, { defaultMarks }));
    } catch {
      dropped += 1;
    }
  }
  return { questions, dropped, unreadable: false };
}

/**
 * Writes a paper. `spec` is the teacher's request, already validated by the
 * route: { class_level, subject, topic, level, toughness, mix, count,
 * instructions, marks }. Resolves to { questions, dropped, input_tokens,
 * output_tokens }; throws a 502 when the model gives nothing usable.
 */
export async function generatePaper(spec) {
  const ai = await getClient();
  const signal = AbortSignal.timeout(config.aiTests.timeoutMs);
  const usage = { input_tokens: 0, output_tokens: 0 };
  const questions = [];
  const seen = new Set();
  let dropped = 0;
  let lastError = null;

  // One request, and a second to top up whatever the checks dropped.
  for (let round = 0; round < 2 && questions.length < spec.count; round++) {
    const need = spec.count - questions.length;
    const have = { mcq: questions.filter((q) => q.kind === 'mcq').length, numeric: questions.filter((q) => q.kind === 'numeric').length };
    const target = splitMix(spec.mix, spec.count);
    const counts = round === 0 ? target : { mcq: Math.max(0, target.mcq - have.mcq), numeric: Math.max(0, target.numeric - have.numeric) };
    if (counts.mcq + counts.numeric !== need) counts.mcq = need - counts.numeric;
    let response;
    try {
      response = await ai.models.generateContent({
        model: config.aiTests.model,
        contents: [{ role: 'user', parts: [{ text: requestText(spec, counts, questions) }] }],
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          responseMimeType: 'application/json',
          responseJsonSchema: QUESTION_SCHEMA,
          temperature: 0.5,
          // Fifteen worked solutions are a long document, and the thinking
          // that checks them counts against this too.
          maxOutputTokens: 32768,
          thinkingConfig: { thinkingBudget: 8192 },
          abortSignal: signal,
        },
      });
    } catch (err) {
      // A top-up that times out still leaves the first round's paper.
      if (round > 0) break;
      lastError = err;
      break;
    }
    usage.input_tokens += response?.usageMetadata?.promptTokenCount ?? 0;
    usage.output_tokens += (response?.usageMetadata?.candidatesTokenCount ?? 0) + (response?.usageMetadata?.thoughtsTokenCount ?? 0);
    const parsed = parseGenerated(response?.text, { defaultMarks: spec.marks });
    dropped += parsed.dropped;
    for (const q of parsed.questions) {
      const key = fingerprint(q);
      if (seen.has(key) || questions.length >= spec.count) continue;
      seen.add(key);
      questions.push(q);
    }
  }

  if (!questions.length) {
    const timedOut = lastError?.name === 'TimeoutError' || lastError?.name === 'AbortError';
    throw new HttpError(
      502,
      timedOut ? 'Writing the paper took too long — try fewer questions' : 'The generator could not write this paper — try again',
      { code: 'generator_failed' },
    );
  }
  // MCQs first, then numerical — the order JEE Main prints its sections in.
  questions.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'mcq' ? -1 : 1));
  return { questions, dropped, ...usage };
}

export function logGeneration({ userId, topic, questions, input_tokens, output_tokens }) {
  run('INSERT INTO ai_test_generations (user_id, topic, questions, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?)', [
    userId ?? null, topic ?? null, questions, input_tokens ?? 0, output_tokens ?? 0,
  ]);
}

/* ── Storing a paper ─────────────────────────────────────────────────── */

function fromRow(row) {
  return { ...row, options: row.options ? JSON.parse(row.options) : null };
}

export function paperQuestions(testId) {
  return all('SELECT * FROM academic_test_questions WHERE test_id = ? ORDER BY position, id', [testId]).map(fromRow);
}

export const questionCount = (testId) => get('SELECT COUNT(*) AS n FROM academic_test_questions WHERE test_id = ?', [testId]).n;

/** Every question checked, or a 400 naming the first bad one. */
export function checkPaper(rawQuestions, { defaultMarks = 4 } = {}) {
  if (!Array.isArray(rawQuestions)) throw badRequest('questions must be a list', { questions: 'required' });
  if (rawQuestions.length > MAX_QUESTIONS) throw badRequest(`A paper can have at most ${MAX_QUESTIONS} questions`, { questions: 'too many' });
  return rawQuestions.map((raw, i) => {
    try {
      return { ...checkQuestion(raw, { defaultMarks }), id: Number.isInteger(Number(raw?.id)) && Number(raw.id) > 0 ? Number(raw.id) : null };
    } catch (err) {
      throw badRequest(`Question ${i + 1}: ${err.message}`, { questions: `question ${i + 1}` });
    }
  });
}

/**
 * Replaces a test's paper with `clean` (from checkPaper). A question that
 * keeps its id stays the same question, so answers already given to it
 * still count; one left out is deleted. The test's maximum becomes the sum
 * of the paper's marks, and every submitted attempt is regraded. Runs in the
 * caller's transaction when there is one.
 */
export function savePaper(testId, clean) {
  return tx(() => {
    const existing = new Set(all('SELECT id FROM academic_test_questions WHERE test_id = ?', [testId]).map((r) => r.id));
    const kept = new Set(clean.filter((q) => q.id && existing.has(q.id)).map((q) => q.id));
    for (const id of existing) if (!kept.has(id)) run('DELETE FROM academic_test_questions WHERE id = ?', [id]);
    clean.forEach((q, index) => {
      const values = [
        index + 1, q.kind, q.question, q.options ? JSON.stringify(q.options) : null, q.correct_option, q.answer_value,
        q.answer_tolerance, q.hint, q.solution, q.marks, q.difficulty,
      ];
      if (q.id && kept.has(q.id)) {
        run(
          `UPDATE academic_test_questions SET position = ?, kind = ?, question = ?, options = ?, correct_option = ?, answer_value = ?,
                  answer_tolerance = ?, hint = ?, solution = ?, marks = ?, difficulty = ? WHERE id = ?`,
          [...values, q.id],
        );
      } else {
        run(
          `INSERT INTO academic_test_questions (position, kind, question, options, correct_option, answer_value,
                                                answer_tolerance, hint, solution, marks, difficulty, test_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [...values, testId],
        );
      }
    });
    if (clean.length) {
      const max = round2(clean.reduce((acc, q) => acc + q.marks, 0));
      run('UPDATE academic_tests SET max_marks = ?, passing_marks = MIN(COALESCE(passing_marks, 0), ?) WHERE id = ?', [max, max, testId]);
    } else {
      // Nothing left to sit.
      run('UPDATE academic_tests SET online = 0 WHERE id = ?', [testId]);
    }
    regradeTest(testId);
  });
}

/* ── Grading ─────────────────────────────────────────────────────────── */

/** A student's answer to `q` as the grader reads it, or null for none. */
export function normaliseAnswer(q, value) {
  if (value === null || value === undefined || value === '') return null;
  if (q.kind === 'mcq') {
    const n = Number(value);
    return Number.isInteger(n) && n >= 0 && n < (q.options?.length ?? 4) ? n : null;
  }
  const n = Number(String(value).trim().replace(/,/g, ''));
  return String(value).trim() !== '' && Number.isFinite(n) ? n : null;
}

/** Only answers to this paper's questions, each in the grader's form. */
export function cleanAnswers(questions, raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const q of questions) {
    const value = normaliseAnswer(q, raw[q.id]);
    if (value !== null) out[q.id] = value;
  }
  return out;
}

/**
 * Scores `answers` against `questions`: a question's marks for a right
 * answer, minus `negative` for a wrong one, nothing for a skipped one.
 */
export function gradeAttempt(questions, answers = {}, negative = 0) {
  let score = 0;
  let correct = 0;
  let wrong = 0;
  let skipped = 0;
  const results = {};
  for (const q of questions) {
    const given = normaliseAnswer(q, answers[q.id]);
    if (given === null) {
      skipped += 1;
      results[q.id] = 'skipped';
      continue;
    }
    const right = q.kind === 'mcq' ? given === q.correct_option : Math.abs(given - q.answer_value) <= q.answer_tolerance + 1e-9;
    if (right) {
      correct += 1;
      score += q.marks;
    } else {
      wrong += 1;
      score -= negative;
    }
    results[q.id] = right ? 'correct' : 'wrong';
  }
  return { score: round2(score), correct, wrong, skipped, results };
}

/** Writes ranks and percentiles for the whole test from its current marks. */
export function recomputeRanks(testId) {
  const rows = all('SELECT id, marks_obtained, is_absent FROM academic_test_marks WHERE test_id = ?', [testId]);
  for (const row of rankMarks(rows)) {
    run('UPDATE academic_test_marks SET rank = ?, percentile = ? WHERE id = ?', [row.rank, row.percentile, row.id]);
  }
}

/** A graded attempt's score as the student's mark — a changed score earns
 * the parent a fresh scorecard, like a corrected mark does. */
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

function finalise(test, attempt, questions) {
  const graded = gradeAttempt(questions, JSON.parse(attempt.answers || '{}'), test.negative_marking);
  run(
    `UPDATE academic_test_attempts SET submitted_at = COALESCE(submitted_at, datetime('now')), score = ?, correct = ?, wrong = ?, skipped = ?
     WHERE id = ?`,
    [graded.score, graded.correct, graded.wrong, graded.skipped, attempt.id],
  );
  writeMark(test.id, attempt.member_id, graded.score);
  return graded;
}

/** Regrades every submitted attempt against the paper as it now stands. */
export function regradeTest(testId) {
  const test = get('SELECT * FROM academic_tests WHERE id = ?', [testId]);
  const attempts = all('SELECT * FROM academic_test_attempts WHERE test_id = ? AND submitted_at IS NOT NULL', [testId]);
  if (!test || !attempts.length) return;
  const questions = paperQuestions(testId);
  tx(() => {
    for (const attempt of attempts) finalise(test, attempt, questions);
    recomputeRanks(testId);
  });
}

/**
 * Submits, with what they had saved, every attempt whose time ran out with
 * the app closed — so a student who walked away still gets a score, and the
 * marks sheet is not left waiting on them.
 */
export function closeExpiredAttempts(testId) {
  const expired = all(
    `SELECT * FROM academic_test_attempts
     WHERE test_id = ? AND submitted_at IS NULL AND deadline_at IS NOT NULL
       AND deadline_at < datetime('now', '-${GRACE_SECONDS} seconds')`,
    [testId],
  );
  if (!expired.length) return;
  const test = get('SELECT * FROM academic_tests WHERE id = ?', [testId]);
  const questions = paperQuestions(testId);
  tx(() => {
    for (const attempt of expired) finalise(test, attempt, questions);
    recomputeRanks(testId);
  });
}

/* ── The student's side ──────────────────────────────────────────────── */

const ATTEMPT_SELECT = `
  SELECT a.*,
         CASE WHEN a.deadline_at IS NULL THEN NULL
              ELSE CAST(ROUND((julianday(a.deadline_at) - julianday('now')) * 86400) AS INTEGER) END AS seconds_left
  FROM academic_test_attempts a`;

export const attemptFor = (testId, memberId) => get(`${ATTEMPT_SELECT} WHERE a.test_id = ? AND a.member_id = ?`, [testId, memberId]);

function attemptStatus(attempt) {
  if (!attempt) return 'not_started';
  return attempt.submitted_at ? 'submitted' : 'in_progress';
}

/** Whether this student may see the answer key and solutions: once their
 * own attempt is in (a practice paper), or once the result is published —
 * never in the middle of an attempt. */
export function answersRevealed(test, attempt) {
  if (attempt && !attempt.submitted_at) return false;
  if (test.published_at) return true;
  return Boolean(attempt?.submitted_at) && test.answers_after === 'submit';
}

/** Why this student cannot start the test now, or null if they can. */
export function startBlocker(test, attempt, todayDate) {
  if (attempt) return null;
  if (!test.online) return 'This test is closed';
  if (test.test_date > todayDate) return `This test opens on ${test.test_date}`;
  if (test.published_at) return 'The result is already out — this test is closed';
  return null;
}

/**
 * The paper as the student app gets it: the questions without answers, and
 * the answer key, solutions and their own marking once answersRevealed().
 */
export function studentPaper(test, attempt, questions, { rank = null } = {}) {
  const revealed = answersRevealed(test, attempt);
  const answers = attempt ? JSON.parse(attempt.answers || '{}') : {};
  const graded = attempt?.submitted_at && revealed ? gradeAttempt(questions, answers, test.negative_marking).results : null;
  return {
    test: {
      id: test.id,
      title: test.title,
      test_type: test.test_type,
      test_date: test.test_date,
      batch_name: test.batch_name,
      subject_name: test.subject_name,
      topic: test.topic,
      level: test.level,
      level_label: LEVELS[test.level]?.label ?? null,
      duration_min: test.duration_min,
      max_marks: test.max_marks,
      negative_marking: test.negative_marking,
      answers_after: test.answers_after,
      published: Boolean(test.published_at),
      syllabus: test.syllabus,
    },
    revealed,
    questions: questions.map((q) => ({
      id: q.id,
      position: q.position,
      kind: q.kind,
      question: q.question,
      options: q.options,
      marks: q.marks,
      hint: q.hint,
      ...(revealed
        ? {
            correct_option: q.correct_option,
            answer_value: q.answer_value,
            answer_tolerance: q.answer_tolerance,
            solution: q.solution,
            result: graded?.[q.id] ?? null,
          }
        : {}),
    })),
    attempt: {
      status: attemptStatus(attempt),
      started_at: attempt?.started_at ?? null,
      submitted_at: attempt?.submitted_at ?? null,
      seconds_left: attempt && !attempt.submitted_at && attempt.seconds_left !== null ? Math.max(0, attempt.seconds_left) : null,
      answers,
      hints_used: attempt ? JSON.parse(attempt.hints_used || '[]') : [],
      ...(attempt?.submitted_at
        ? { score: attempt.score, correct: attempt.correct, wrong: attempt.wrong, skipped: attempt.skipped, rank: test.published_at ? rank : null }
        : {}),
    },
  };
}

/** Starts the student's attempt, once; the clock runs from now. */
export function startAttempt(test, memberId) {
  run(
    `INSERT INTO academic_test_attempts (test_id, member_id, started_at, deadline_at)
     VALUES (?, ?, datetime('now'), CASE WHEN ? > 0 THEN datetime('now', '+' || ? || ' minutes') END)
     ON CONFLICT (test_id, member_id) DO NOTHING`,
    [test.id, memberId, test.duration_min ?? 0, test.duration_min ?? 0],
  );
  return attemptFor(test.id, memberId);
}

const pastGrace = (attempt) => attempt.seconds_left !== null && attempt.seconds_left < -GRACE_SECONDS;

/** Autosave: refused once submitted, or once time (and its grace) is up. */
export function saveAnswers(attempt, questions, { answers, hints_used }) {
  if (attempt.submitted_at) throw new HttpError(409, 'This test is already submitted', { code: 'submitted' });
  if (pastGrace(attempt)) throw new HttpError(409, 'Time is up for this test', { code: 'time_up' });
  const ids = new Set(questions.map((q) => q.id));
  const hints = Array.isArray(hints_used) ? [...new Set(hints_used.map(Number).filter((id) => ids.has(id)))] : JSON.parse(attempt.hints_used || '[]');
  run('UPDATE academic_test_attempts SET answers = ?, hints_used = ? WHERE id = ?', [
    JSON.stringify(cleanAnswers(questions, answers)), JSON.stringify(hints), attempt.id,
  ]);
}

/**
 * Submits and grades. Answers sent with the submit count if they arrive in
 * time; after the grace period only what was saved before it does.
 */
export function submitAttempt(test, attempt, questions, body = {}) {
  if (attempt.submitted_at) throw new HttpError(409, 'This test is already submitted', { code: 'submitted' });
  return tx(() => {
    if (body.answers && !pastGrace(attempt)) saveAnswers(attempt, questions, body);
    const fresh = get('SELECT * FROM academic_test_attempts WHERE id = ?', [attempt.id]);
    const graded = finalise(test, fresh, questions);
    recomputeRanks(test.id);
    return graded;
  });
}

/** The tests a student can sit (or has sat) in the app, newest first. */
export function studentOnlineTests(memberId, batchIds) {
  if (!batchIds.length) return [];
  const rows = all(
    `SELECT t.id, t.title, t.test_type, t.test_date, t.duration_min, t.max_marks, t.negative_marking, t.answers_after,
            t.published_at, t.online, t.topic, t.level, b.name AS batch_name, s.name AS subject_name,
            (SELECT COUNT(*) FROM academic_test_questions q WHERE q.test_id = t.id) AS questions,
            a.id AS attempt_id, a.submitted_at, a.score, a.correct, a.wrong, a.skipped
     FROM academic_tests t
     JOIN academic_batches b ON b.id = t.batch_id
     LEFT JOIN academic_subjects s ON s.id = t.subject_id
     LEFT JOIN academic_test_attempts a ON a.test_id = t.id AND a.member_id = ?
     WHERE t.batch_id IN (${batchIds.map(() => '?').join(', ')}) AND (t.online = 1 OR a.id IS NOT NULL)
     ORDER BY t.test_date DESC, t.id DESC LIMIT 100`,
    [memberId, ...batchIds],
  );
  return rows
    .filter((t) => t.questions > 0)
    .map(({ attempt_id: attemptId, online: _online, ...t }) => ({
      ...t,
      level_label: LEVELS[t.level]?.label ?? null,
      status: t.submitted_at ? 'submitted' : attemptId ? 'in_progress' : 'not_started',
    }));
}
