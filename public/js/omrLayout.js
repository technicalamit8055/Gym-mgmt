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

/**
 * The sheet styles an institute can print. Every style shares the corner
 * markers, the orientation bar and its blank twin, so one scanner finds them
 * all; what differs is where the bubbles sit, so a test remembers the style
 * its sheets were printed in (academic_tests.omr_style) and the scanner reads
 * with that one.
 *
 *   coachbook   — the original sheet (version 1, geometry frozen);
 *   board       — school-board pattern: candidate boxes, a 6-digit roll grid,
 *                 five framed columns of 20, bilingual Hindi/English text;
 *   competitive — entrance-exam pattern: options printed as 1 2 3 4, four
 *                 framed columns of 25, a 6-digit roll grid.
 */
export const OMR_STYLES = ['coachbook', 'board', 'competitive'];
export const OMR_STYLE_NAMES = {
  coachbook: 'Standard (CoachBook)',
  board: 'Board pattern (BSEB 10th / 12th)',
  competitive: 'Competitive (JEE / NEET pattern)',
};

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
export function sheetLayout({ questions, options = 4, style = 'coachbook' } = {}) {
  const q = Math.trunc(Number(questions));
  const o = Math.trunc(Number(options));
  if (!(q >= 1 && q <= MAX_QUESTIONS)) throw new RangeError(`An OMR sheet holds 1 to ${MAX_QUESTIONS} questions`);
  if (!(o >= 2 && o <= OPTION_LABELS.length)) throw new RangeError(`An OMR question has 2 to ${OPTION_LABELS.length} options`);
  const s = style || 'coachbook';
  if (!OMR_STYLES.includes(s)) throw new RangeError(`Unknown OMR sheet style "${style}"`);
  if (s !== 'coachbook') return patternLayout(q, o, PATTERNS[s]);
  return coachbookLayout(q, o);
}

/* ── Board and competitive patterns ──────────────────────────────────── */

/**
 * Geometry for the two exam-pattern sheets. Both put a candidate panel
 * (write-in boxes) on the left and a 6-digit roll grid on the right of the
 * header, an instructions band under them, and framed answer columns below.
 * Frames sit at least 1.4 bubble radii from every bubble centre, so the
 * scanner's paper ring around a bubble only ever sees paper.
 */
const PATTERNS = {
  board: {
    version: 1,
    style: 'board',
    radius: 2.0,
    rows: 20,
    columns: 5,
    answerTop: 150,
    rowPitch: 6.2,
    blockGap: 1.5,
    numericLabels: false,
    // Option x offsets inside a column, by option count.
    firstOption: (o) => (o === 5 ? 10.8 : 12.5),
    optionPitch: (o) => (o === 5 ? 5.0 : 5.6),
  },
  competitive: {
    version: 1,
    style: 'competitive',
    radius: 2.0,
    rows: 25,
    columns: 4,
    answerTop: 136,
    rowPitch: 5.4,
    blockGap: 1.2,
    numericLabels: true,
    firstOption: () => 13,
    optionPitch: () => 6.0,
  },
};

const FRAME_LEFT = 19;
const FRAME_RIGHT = 191;
const PATTERN_ROLL = { digits: 6, left: 151, pitchX: 6.4, boxTop: 39, boxSize: 5.6, top: 48, pitchY: 5.2 };
const HEADER_PANEL_TOP = 31;
const HEADER_PANEL_BOTTOM = 99;

function patternLayout(q, o, p) {
  const colWidth = (FRAME_RIGHT - FRAME_LEFT) / p.columns;
  const rowY = (row) => p.answerTop + row * p.rowPitch + Math.floor(row / 5) * p.blockGap;
  const first = p.firstOption(o);
  const pitch = p.optionPitch(o);
  const display = (j) => (p.numericLabels ? String(j + 1) : OPTION_LABELS[j]);
  const items = [];
  for (let i = 0; i < q; i++) {
    const column = Math.floor(i / p.rows);
    const row = i % p.rows;
    const left = FRAME_LEFT + column * colWidth;
    const y = rowY(row);
    items.push({
      number: i + 1,
      labelX: left + first - p.radius - 1.6,
      y,
      bubbles: Array.from({ length: o }, (_, j) => ({ x: left + first + j * pitch, y, label: OPTION_LABELS[j], display: display(j) })),
    });
  }
  const used = Math.ceil(q / p.rows);
  const R = PATTERN_ROLL;
  const roll = Array.from({ length: R.digits }, (_, d) => {
    const x = R.left + d * R.pitchX;
    return {
      box: { x: x - R.boxSize / 2, y: R.boxTop, size: R.boxSize },
      bubbles: Array.from({ length: 10 }, (_, digit) => ({ x, y: R.top + digit * R.pitchY, label: String(digit), display: String(digit) })),
    };
  });
  const lastRow = rowY(p.rows - 1);
  return {
    version: p.version,
    style: p.style,
    questions: q,
    options: o,
    bubbleRadius: p.radius,
    items,
    // Every column frame is drawn, used or not, so a short paper still looks like the real sheet.
    columns: Array.from({ length: p.columns }, (_, c) => {
      const left = FRAME_LEFT + c * colWidth;
      return {
        left,
        width: colWidth,
        used: c < used,
        headerY: p.answerTop - 6.4,
        firstOptionX: left + first,
        optionPitch: pitch,
        labels: Array.from({ length: o }, (_, j) => display(j)),
        // Hairlines between blocks of five, in the middle of the block gap.
        dividers: Array.from({ length: Math.floor((p.rows - 1) / 5) }, (_, k) => (rowY(k * 5 + 4) + rowY(k * 5 + 5)) / 2),
        frame: { x: left + 0.6, y: p.answerTop - 9.5, width: colWidth - 1.2, height: lastRow - p.answerTop + 9.5 + 3.6 },
        headerRule: p.answerTop - 3.4,
      };
    }),
    rows: p.rows,
    answerTop: p.answerTop,
    answerBottom: lastRow + p.radius,
    roll,
    rollDigits: R.digits,
    rollPanel: { x: 144, y: HEADER_PANEL_TOP, width: 46, height: HEADER_PANEL_BOTTOM - HEADER_PANEL_TOP },
    rollLabel: { x: 144, y: HEADER_PANEL_TOP + 2, width: 46 },
    candidatePanel: { x: 20, y: HEADER_PANEL_TOP, width: 121, height: HEADER_PANEL_BOTTOM - HEADER_PANEL_TOP },
    instructions: { x: 20, y: HEADER_PANEL_BOTTOM + 3, width: 170, height: p.answerTop - 9.5 - (HEADER_PANEL_BOTTOM + 3) - 2.5 },
  };
}

/* ── The original CoachBook sheet (version 1) ────────────────────────── */

function coachbookLayout(q, o) {
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
      bubbles: Array.from({ length: o }, (_, j) => ({ x: left + OPTION_OFFSET + j * OPTION_PITCH, y, label: OPTION_LABELS[j], display: OPTION_LABELS[j] })),
    });
  }
  const columns = Math.ceil(q / ROWS_PER_COLUMN);

  const roll = Array.from({ length: ROLL_DIGITS }, (_, d) => {
    const x = ROLL_LEFT + d * ROLL_PITCH_X;
    return {
      box: { x: x - ROLL_BOX_SIZE / 2, y: ROLL_BOX_TOP, size: ROLL_BOX_SIZE },
      bubbles: Array.from({ length: 10 }, (_, digit) => ({ x, y: ROLL_TOP + digit * ROLL_PITCH_Y, label: String(digit), display: String(digit) })),
    };
  });

  return {
    version: SHEET_VERSION,
    style: 'coachbook',
    rollDigits: ROLL_DIGITS,
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
export function rollDigits(rollNumber, digits = ROLL_DIGITS) {
  const match = /(\d+)\D*$/.exec(String(rollNumber ?? ''));
  if (!match) return null;
  return match[1].slice(-digits).padStart(digits, '0');
}

/** How many roll-number digits a style's sheet bubbles. */
export const rollDigitsFor = (style) => (style && style !== 'coachbook' ? PATTERN_ROLL.digits : ROLL_DIGITS);
