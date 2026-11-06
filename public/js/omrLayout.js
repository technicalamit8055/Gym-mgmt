/**
 * Where everything sits on a CoachBook OMR answer sheet, in millimetres from
 * the top-left corner of an A4 page.
 *
 * One module, two readers: the server draws the printable PDF from it
 * (src/coaching/omrSheet.js) and the phone reads the camera frame with it
 * (js/omrScan.js). It lives under public/ because the browser has no bundler
 * to reach into src/, and it is pure data and arithmetic so Node can import
 * the same file. Change a number here and both sides move together — but a
 * sheet already printed with the old numbers will no longer read, so treat
 * it like a file format: change it only with a new SHEET_VERSION.
 *
 * The page carries:
 *   - four solid 8 mm squares at the corners, which the scanner finds to undo
 *     the camera's perspective;
 *   - a solid bar at the top centre, so a sheet held upside down (or sideways)
 *     is recognised and read the right way round;
 *   - a four-digit roll-number grid (the digits of the student's roll number,
 *     B12A-07 → 0007) so each sheet names its student;
 *   - up to 100 questions in four columns of 25, with 4 or 5 options each.
 */

export const SHEET_VERSION = 1;

export const PAGE = { width: 210, height: 297 };

/** Side of a corner marker, and the centres of the four of them. */
export const MARKER_SIZE = 8;
export const MARKERS = {
  tl: { x: 14, y: 14 },
  tr: { x: 196, y: 14 },
  br: { x: 196, y: 283 },
  bl: { x: 14, y: 283 },
};

/** Distance between marker centres across and down — the frame the scanner maps. */
export const MARKER_SPAN = { x: MARKERS.tr.x - MARKERS.tl.x, y: MARKERS.bl.y - MARKERS.tl.y };

/**
 * The orientation bar, and the patch where it would be if the sheet were
 * upside down. The printed sheet keeps that second patch blank on purpose.
 */
export const ORIENTATION_BAR = { x: 85, y: 11.5, width: 40, height: 5 };
export const ORIENTATION_BLANK = {
  x: PAGE.width - ORIENTATION_BAR.x - ORIENTATION_BAR.width,
  y: MARKERS.tl.y + MARKERS.bl.y - ORIENTATION_BAR.y - ORIENTATION_BAR.height,
  width: ORIENTATION_BAR.width,
  height: ORIENTATION_BAR.height,
};

export const BUBBLE_RADIUS = 2.3;
export const OPTION_LABELS = ['A', 'B', 'C', 'D', 'E'];
export const MAX_QUESTIONS = 100;
export const ROWS_PER_COLUMN = 25;
export const ROLL_DIGITS = 4;

const ANSWER_TOP = 106;
const ROW_PITCH = 6.5;
/** A little extra space after every fifth row, so a student's eye does not slip a line. */
const BLOCK_GAP = 1.5;
const COLUMN_LEFT = 20;
const COLUMN_WIDTH = 44;
const OPTION_OFFSET = 11.5;
const OPTION_PITCH = 6.4;

const ROLL_LEFT = 166;
const ROLL_PITCH_X = 6.4;
const ROLL_BOX_TOP = 30;
const ROLL_BOX_SIZE = 5.6;
const ROLL_TOP = 42;
const ROLL_PITCH_Y = 5.6;

/**
 * The full geometry for a paper of `questions` questions with `options`
 * choices each: every bubble's centre, plus where the labels go.
 */
export function sheetLayout({ questions, options = 4 } = {}) {
  const q = Math.trunc(Number(questions));
  const o = Math.trunc(Number(options));
  if (!(q >= 1 && q <= MAX_QUESTIONS)) throw new RangeError(`An OMR sheet holds 1 to ${MAX_QUESTIONS} questions`);
  if (!(o >= 2 && o <= OPTION_LABELS.length)) throw new RangeError(`An OMR question has 2 to ${OPTION_LABELS.length} options`);

  const rowY = (row) => ANSWER_TOP + row * ROW_PITCH + Math.floor(row / 5) * BLOCK_GAP;
  const items = [];
  for (let i = 0; i < q; i++) {
    const column = Math.floor(i / ROWS_PER_COLUMN);
    const row = i % ROWS_PER_COLUMN;
    const left = COLUMN_LEFT + column * COLUMN_WIDTH;
    const y = rowY(row);
    items.push({
      number: i + 1,
      labelX: left + OPTION_OFFSET - BUBBLE_RADIUS - 1.6,
      y,
      bubbles: Array.from({ length: o }, (_, j) => ({ x: left + OPTION_OFFSET + j * OPTION_PITCH, y, label: OPTION_LABELS[j] })),
    });
  }
  const columns = Math.ceil(q / ROWS_PER_COLUMN);

  const roll = Array.from({ length: ROLL_DIGITS }, (_, d) => {
    const x = ROLL_LEFT + d * ROLL_PITCH_X;
    return {
      box: { x: x - ROLL_BOX_SIZE / 2, y: ROLL_BOX_TOP, size: ROLL_BOX_SIZE },
      bubbles: Array.from({ length: 10 }, (_, digit) => ({ x, y: ROLL_TOP + digit * ROLL_PITCH_Y, label: String(digit) })),
    };
  });

  return {
    version: SHEET_VERSION,
    questions: q,
    options: o,
    bubbleRadius: BUBBLE_RADIUS,
    items,
    columns: Array.from({ length: columns }, (_, c) => ({
      left: COLUMN_LEFT + c * COLUMN_WIDTH,
      headerY: ANSWER_TOP - 6,
      firstOptionX: COLUMN_LEFT + c * COLUMN_WIDTH + OPTION_OFFSET,
      optionPitch: OPTION_PITCH,
    })),
    answerTop: ANSWER_TOP,
    answerBottom: rowY(ROWS_PER_COLUMN - 1) + BUBBLE_RADIUS,
    roll,
    rollLabel: { x: ROLL_LEFT - ROLL_PITCH_X / 2 - 1, y: ROLL_BOX_TOP - 4.5 },
  };
}

/**
 * The digits a roll number is bubbled as: its last run of digits, padded or
 * trimmed to ROLL_DIGITS. "B12A-07" → "0007", "2024105" → "4105". Null when
 * the roll number has no digits at all.
 */
export function rollDigits(rollNumber) {
  const match = /(\d+)\D*$/.exec(String(rollNumber ?? ''));
  if (!match) return null;
  return match[1].slice(-ROLL_DIGITS).padStart(ROLL_DIGITS, '0');
}
