import { badRequest } from '../errors.js';
import { MAX_QUESTIONS, OPTION_LABELS } from '../../public/js/omrLayout.js';

/**
 * OMR answer keys and grading — the pure half of the OMR scanner, so the
 * rules can be tested without a camera or a database.
 *
 * An answer key is one entry per question:
 *   'B'    — B is the answer;
 *   'AC'   — either A or C earns the marks (a question challenged after the
 *            paper, where the institute accepts both);
 *   '*'    — bonus: everyone gets the marks, attempted or not, the way NTA
 *            treats a dropped question.
 *
 * A student's response is one entry per question: '' (left blank), one
 * letter, or several letters when more than one bubble was filled. Several
 * letters is a wrong answer and takes the negative mark — the usual rule on
 * JEE/NEET-style sheets, and the one printed on CoachBook's sheet.
 */

const SEPARATORS = /[\s,.;:|/\\\-\d]/;

/**
 * Turns what a teacher types into a key array. Forgiving about layout:
 * "ABCD BCDA", "1A 2B 3C", "a,b,c" all work, because digits, spaces and
 * punctuation are ignored. (AC) or [AC] is a multi-answer question, * is a bonus.
 */
export function parseAnswerKey(input, { questions, options }) {
  const allowed = OPTION_LABELS.slice(0, options);
  let entries;
  if (Array.isArray(input)) {
    entries = input.map((v) => String(v ?? '').toUpperCase().replace(/\s+/g, ''));
  } else {
    entries = [];
    const text = String(input ?? '').toUpperCase();
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (SEPARATORS.test(ch)) continue;
      if (ch === '(' || ch === '[') {
        const close = text.indexOf(ch === '(' ? ')' : ']', i);
        if (close < 0) throw badRequest(`Question ${entries.length + 1}: an opening ${ch} is never closed`, { answer_key: 'unclosed group' });
        entries.push(text.slice(i + 1, close).replace(/[\s,]/g, ''));
        i = close;
        continue;
      }
      entries.push(ch);
    }
  }
  const key = entries.map((entry, i) => {
    if (entry === '*') return '*';
    const letters = [...new Set(entry.split(''))].sort();
    if (!letters.length || letters.some((l) => !allowed.includes(l))) {
      throw badRequest(`Question ${i + 1}: "${entry || 'blank'}" is not one of ${allowed.join(', ')} or * for a bonus`, { answer_key: 'invalid answer' });
    }
    return letters.join('');
  });
  if (key.length !== questions) {
    throw badRequest(`The key has ${key.length} answer${key.length === 1 ? '' : 's'} but the paper has ${questions} questions`, { answer_key: 'wrong length' });
  }
  return key;
}

/** Validates a scanned response against the paper: one entry per question, letters only from its options. */
export function cleanResponse(answers, { questions, options }) {
  if (!Array.isArray(answers) || answers.length !== questions) {
    throw badRequest(`Send exactly ${questions} answers`, { answers: 'wrong length' });
  }
  const allowed = OPTION_LABELS.slice(0, options);
  return answers.map((raw, i) => {
    const value = [...new Set(String(raw ?? '').toUpperCase().replace(/\s+/g, '').split(''))].filter(Boolean).sort().join('');
    if ([...value].some((l) => !allowed.includes(l))) throw badRequest(`Question ${i + 1}: "${raw}" is not a valid mark`, { answers: 'invalid' });
    return value;
  });
}

const round2 = (v) => Math.round(v * 100) / 100;

/**
 * Marks one response against the key: +marksCorrect for a right answer,
 * −negative for a wrong one (including more than one bubble filled), 0 for a
 * blank, and +marksCorrect on a bonus question whatever was marked.
 */
export function gradeResponse(key, answers, { marksCorrect, negative = 0 }) {
  let correct = 0;
  let wrong = 0;
  let blank = 0;
  let bonus = 0;
  const outcome = key.map((k, i) => {
    const a = answers[i] || '';
    if (k === '*') {
      bonus += 1;
      return 'bonus';
    }
    if (!a) {
      blank += 1;
      return 'blank';
    }
    if (a.length === 1 && k.includes(a)) {
      correct += 1;
      return 'correct';
    }
    wrong += 1;
    return 'wrong';
  });
  return {
    correct,
    wrong,
    blank,
    bonus,
    score: round2((correct + bonus) * marksCorrect - wrong * negative),
    outcome,
  };
}

/**
 * Per-question figures across every scanned sheet: the share who got it
 * right, left it blank, and the wrong option most of them fell for — what a
 * teacher looks at to decide which questions to discuss in class.
 */
export function questionStats(key, responses) {
  return key.map((k, i) => {
    const n = responses.length;
    if (!n) return { number: i + 1, key: k, correct_pct: null, blank_pct: null, common_wrong: null };
    let right = 0;
    let blank = 0;
    const wrongs = {};
    for (const answers of responses) {
      const a = answers[i] || '';
      if (!a) blank += 1;
      else if (k === '*' || (a.length === 1 && k.includes(a))) right += 1;
      else wrongs[a] = (wrongs[a] || 0) + 1;
    }
    const common = Object.entries(wrongs).sort((x, y) => y[1] - x[1])[0];
    return {
      number: i + 1,
      key: k,
      correct_pct: round2((right / n) * 100),
      blank_pct: round2((blank / n) * 100),
      common_wrong: common ? { answer: common[0], count: common[1] } : null,
    };
  });
}

export { MAX_QUESTIONS };
