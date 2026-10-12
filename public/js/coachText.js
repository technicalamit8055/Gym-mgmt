/**
 * The coach's answer as display tokens for the Ask Coach sheet
 * (public/js/coach.js). The model may wrap key numbers in **double
 * asterisks**; on top of that the first calorie figure and the first protein
 * figure become the sheet's coloured chips, as in the design ("You've eaten
 * [867 calories] so far today, with [62g protein]").
 *
 * No DOM here, so the rules are tested in node (tests/coachText.test.js).
 */

const CHIPS = [
  ['kcal', /\d[\d,]*(?:\.\d+)?\s?(?:kcal|calories)\b/i],
  ['protein', /\d+(?:\.\d+)?\s?g(?:rams?)?\s+(?:of\s+)?protein\b/i],
];

/** Longest stretch at the end of streamed text that could still turn into a
 * chip or close a bold run, so the typer holds it back instead of showing a
 * word that is about to change shape. */
export const SETTLE_CHARS = 24;

/**
 * @param {string} raw the answer so far, markers and all
 * @returns {{ text: string, kind: ''|'bold'|'kcal'|'protein', end: number }[]}
 *   words (each with its trailing space), bold words, and whole chips, in
 *   order; `end` is where the token stops in the text with the markers removed
 */
export function answerTokens(raw) {
  let text = '';
  const bold = [];
  let on = false;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '*' && raw[i + 1] === '*') {
      on = !on;
      i++;
      continue;
    }
    text += raw[i];
    bold.push(on);
  }

  const kindAt = bold.map((b) => (b ? 'bold' : ''));
  for (const [kind, pattern] of CHIPS) {
    const match = pattern.exec(text);
    if (!match) continue;
    for (let i = match.index; i < match.index + match[0].length; i++) kindAt[i] = kind;
  }

  const tokens = [];
  let start = 0;
  while (start < text.length) {
    const kind = kindAt[start];
    let end = start;
    while (end < text.length && kindAt[end] === kind) end++;
    const run = text.slice(start, end);
    if (kind === 'kcal' || kind === 'protein') {
      tokens.push({ text: run, kind, end });
    } else {
      // A word with its trailing space is the unit that fades in.
      for (const word of run.matchAll(/\s*\S+\s*|\s+/g)) {
        tokens.push({ text: word[0], kind, end: start + word.index + word[0].length });
      }
    }
    start = end;
  }
  return tokens;
}

/** The plain text the tokens cover, markers removed. */
export const plainLength = (raw) => raw.replace(/\*\*/g, '').length;
