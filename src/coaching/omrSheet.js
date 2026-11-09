import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { MARKER_SIZE, MARKERS, ORIENTATION_BAR, PAGE, rollDigits, sheetLayout } from '../../public/js/omrLayout.js';
import { templateFor } from '../printTemplates.js';

/**
 * The printable OMR answer sheet: one A4 page drawn from the same layout the
 * phone reads with (public/js/omrLayout.js), so what is printed is exactly
 * where the scanner looks.
 *
 * Three styles (see OMR_STYLES): the original CoachBook sheet, a school-board
 * pattern with bilingual Hindi/English text, and a competitive-exam pattern.
 * The institute's OMR template (src/printTemplates.js) can replace the
 * heading, sub-heading and instructions and add write-in boxes.
 *
 * Two flavours of each:
 *   - blank: one page for the teacher to photocopy; students write their
 *     name and bubble their roll number;
 *   - named: one page per student on the roster with the name printed and
 *     the roll-number bubbles already filled, for an institute that prints
 *     per paper — nobody can bubble the wrong roll number.
 *
 * Drawing rules the scanner depends on: the corner squares and the top bar
 * are solid black with clear paper around them, the patch mirrored from the
 * bar at the bottom stays blank, nothing else is a solid dark block, and
 * bubbles are thin grey rings with a pale label and bare paper around them,
 * so an empty one reads as near-white and a filled one as dark.
 *
 * Text is set in Noto Sans, with Noto Sans Devanagari for Hindi (that font
 * has no Latin letters, so mixed text is drawn as runs, one font each).
 * Bubble labels stay in Helvetica, as on the first printed sheets.
 */

const PT = 72 / 25.4;
const mm = (v) => v * PT;
const INK = '#111111';
const SOFT = '#6b7280';
const RING = '#7c8089';
const LETTER = '#a3a7ae';
const RULE = '#9ca3af';

const STYLE_ACCENT = { board: '#1e3a8a', competitive: '#7f1d1d' };

/* ── Fonts ───────────────────────────────────────────────────────────── */

const FONT_DIR = fileURLToPath(new URL('../../assets/fonts/', import.meta.url));
const FONT_FILES = {
  regular: 'NotoSans-Regular.ttf',
  semibold: 'NotoSans-SemiBold.ttf',
  bold: 'NotoSans-Bold.ttf',
  dev: 'NotoSansDevanagari-Regular.ttf',
  devBold: 'NotoSansDevanagari-Bold.ttf',
};
let fontBuffers;
function loadFonts() {
  if (fontBuffers !== undefined) return fontBuffers;
  try {
    fontBuffers = Object.fromEntries(Object.entries(FONT_FILES).map(([k, f]) => [k, readFileSync(FONT_DIR + f)]));
  } catch {
    fontBuffers = null;
  }
  return fontBuffers;
}

const DEVANAGARI = /[ऀ-ॿ᳐-᳿꣠-ꣿ]/;
const LATIN_LETTER = /[A-Za-zÀ-ɏ]/;
/** Neutral characters the Devanagari font also carries — they may stay inside a Hindi run. Anything else switches to Latin. */
const DEV_SAFE = new Set([...'0123456789 ()/.,-+:;×−–—?\'"!%']);

/** Without the bundled fonts: the PDF base font and its Latin-1 set, as before. */
const KEEP = new Set([...'–—‘’“”•…₹−'].map((c) => c.codePointAt(0)));
function latin(text) {
  return [...String(text ?? '').normalize('NFKC')]
    .filter((ch) => ch.codePointAt(0) <= 0xff || KEEP.has(ch.codePointAt(0)))
    .join('')
    .replace(/₹/g, 'Rs ')
    .replace(/−/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A text writer bound to one document. Positions are in millimetres and
 * mean the top of the line, as PDFKit's own do; runs are placed on a shared
 * baseline so Hindi and English sit level.
 */
function writer(doc) {
  const fonts = loadFonts();
  if (fonts) for (const [k, buf] of Object.entries(fonts)) doc.registerFont(`omr-${k}`, buf);
  const fontOf = (kind, weight) => {
    if (!fonts) return weight === 'regular' ? 'Helvetica' : 'Helvetica-Bold';
    if (kind === 'dev') return weight === 'regular' ? 'omr-dev' : 'omr-devBold';
    return `omr-${weight}`;
  };
  const runsOf = (text) => {
    const str = fonts ? String(text ?? '').normalize('NFC').replace(/\s+/g, ' ') : latin(text);
    if (!fonts) return str ? [{ kind: 'lat', text: str }] : [];
    const out = [];
    let cur = null;
    for (const ch of str) {
      const own = DEVANAGARI.test(ch) ? 'dev' : LATIN_LETTER.test(ch) ? 'lat' : DEV_SAFE.has(ch) ? null : 'lat';
      const kind = own ?? cur?.kind ?? 'lat';
      if (cur && cur.kind === kind) cur.text += ch;
      else out.push((cur = { kind, text: ch }));
    }
    return out;
  };
  const widthOf = (runs, size, weight) =>
    runs.reduce((w, r) => w + doc.font(fontOf(r.kind, weight)).fontSize(size).widthOfString(r.text), 0);
  const drawRuns = (runs, xPt, topPt, size, weight, color) => {
    const baseline = topPt + size * 0.76;
    let x = xPt;
    for (const r of runs) {
      doc.font(fontOf(r.kind, weight)).fontSize(size).fillColor(color);
      doc.text(r.text, x, baseline, { lineBreak: false, baseline: 'alphabetic' });
      x += doc.widthOfString(r.text);
    }
  };

  /** One line; shrinks to fit `width` (mm) rather than wrapping or cutting. */
  const line = (text, x, y, { size = 8, weight = 'regular', color = INK, width, align = 'left' } = {}) => {
    const runs = runsOf(text);
    if (!runs.length) return 0;
    let s = size;
    let w = widthOf(runs, s, weight);
    if (width && w > mm(width)) {
      s = Math.max(size * 0.6, (s * mm(width)) / w);
      w = widthOf(runs, s, weight);
    }
    let left = mm(x);
    if (width && align === 'center') left += (mm(width) - w) / 2;
    if (width && align === 'right') left += mm(width) - w;
    drawRuns(runs, left, mm(y), s, weight, color);
    return w / PT;
  };

  /** A wrapped paragraph; returns its height in mm. `draw: false` only measures. */
  const paragraph = (text, x, y, width, { size = 7, weight = 'regular', color = INK, leading = 1.32, indent = 0, draw = true } = {}) => {
    const words = String(text ?? '').split(/\s+/).filter(Boolean);
    const space = widthOf(runsOf(' '), size, weight);
    const lines = [];
    let cur = [];
    let curW = 0;
    for (const word of words) {
      const w = widthOf(runsOf(word), size, weight);
      const avail = mm(width - (lines.length ? indent : 0));
      if (cur.length && curW + space + w > avail) {
        lines.push(cur.join(' '));
        cur = [word];
        curW = w;
      } else {
        curW += (cur.length ? space : 0) + w;
        cur.push(word);
      }
    }
    if (cur.length) lines.push(cur.join(' '));
    const hasDev = fonts && DEVANAGARI.test(String(text));
    const lh = (size * (hasDev ? leading + 0.12 : leading)) / PT;
    if (draw) lines.forEach((l, i) => drawRuns(runsOf(l), mm(x + (i ? indent : 0)), mm(y + i * lh), size, weight, color));
    return lines.length * lh;
  };

  return { line, paragraph };
}

const fmt = (v) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100));
const fmtDate = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ''));
  return m ? `${m[3]}-${m[2]}-${m[1]}` : String(iso ?? '');
};

/** "+4 correct, −1 wrong" — the marking line. */
const marking = (test) => `+${fmt(test.omr_marks_correct)} correct${test.negative_marking ? `, −${fmt(test.negative_marking)} wrong` : ''}`;

/* ── Shared pieces ───────────────────────────────────────────────────── */

function drawRegistration(doc) {
  for (const m of Object.values(MARKERS)) doc.rect(mm(m.x - MARKER_SIZE / 2), mm(m.y - MARKER_SIZE / 2), mm(MARKER_SIZE), mm(MARKER_SIZE)).fill(INK);
  doc.rect(mm(ORIENTATION_BAR.x), mm(ORIENTATION_BAR.y), mm(ORIENTATION_BAR.width), mm(ORIENTATION_BAR.height)).fill(INK);
}

function drawBubble(doc, x, y, r, label, { filled = false, size = 6 } = {}) {
  if (filled) {
    doc.circle(mm(x), mm(y), mm(r)).fill(INK);
    return;
  }
  doc.circle(mm(x), mm(y), mm(r)).lineWidth(0.8).stroke(RING);
  doc.font('Helvetica').fontSize(size).fillColor(LETTER).text(label, mm(x - r), mm(y) - size * 0.383, { width: mm(2 * r), align: 'center', lineBreak: false });
}

/** Right / wrong mark examples, starting at (x, y) — y is the bubble centre line. */
function drawMarkExamples(doc, w, x, y, { right = 'Right', wrong = 'Wrong', r = 2 } = {}) {
  const rightW = w.line(right, x, y - 1.3, { size: 7, weight: 'bold' });
  const rx = x + rightW + 2 + r;
  doc.circle(mm(rx), mm(y), mm(r)).fill(INK);
  const wx = rx + r + 5;
  const wrongW = w.line(wrong, wx, y - 1.3, { size: 7, weight: 'bold' });
  const xs = [0, 1, 2].map((i) => wx + wrongW + 2 + r + i * (2 * r + 3));
  for (const cx of xs) doc.circle(mm(cx), mm(y), mm(r)).lineWidth(0.8).stroke(RING);
  const k = r / 2;
  doc.moveTo(mm(xs[0] - 1.1 * k), mm(y)).lineTo(mm(xs[0] - 0.2 * k), mm(y + k)).lineTo(mm(xs[0] + 1.3 * k), mm(y - 1.2 * k)).lineWidth(0.9).stroke(INK);
  doc.moveTo(mm(xs[1] - 1.1 * k), mm(y - 1.1 * k)).lineTo(mm(xs[1] + 1.1 * k), mm(y + 1.1 * k)).moveTo(mm(xs[1] + 1.1 * k), mm(y - 1.1 * k)).lineTo(mm(xs[1] - 1.1 * k), mm(y + 1.1 * k)).lineWidth(0.9).stroke(INK);
  doc.save().circle(mm(xs[2]), mm(y), mm(r)).clip().rect(mm(xs[2] - r), mm(y), mm(2 * r), mm(r)).fill(INK).restore();
}

function drawFooter(doc, w, layout, test, styleNote) {
  w.line(
    `CoachBook OMR sheet v${layout.version}${styleNote ? ` · ${styleNote}` : ''} · ${layout.questions}×${layout.options} · Scan in the CoachBook app: Tests › ${test.title} › Scan sheets`,
    20, PAGE.height - 7.5, { size: 6.5, color: SOFT, width: PAGE.width - 40, align: 'center' },
  );
}

const customInstructions = (template) =>
  String(template?.instructions ?? '').split('\n').map((l) => l.trim()).filter(Boolean);

/* ── Style: CoachBook (version 1) ────────────────────────────────────── */

function drawCoachbook(doc, w, layout, { institute, test, student, template }) {
  drawRegistration(doc);

  // Header.
  const left = 22;
  const width = 130;
  w.line(template.heading || institute || 'CoachBook', left, 22, { size: 14, weight: 'bold', width });
  w.line((template.subheading || 'OMR ANSWER SHEET').toUpperCase(), left, 29.5, { size: 8, weight: 'bold', color: SOFT, width });
  w.line(test.title, left, 33.5, { size: 10, weight: 'bold', width });
  const details = [test.batch_name, test.subject_name, test.test_date, `${layout.questions} questions`, marking(test)].filter(Boolean);
  w.line(details.join('  ·  '), left, 39, { size: 7.5, color: SOFT, width });

  // Who: name and signature lines (or the printed name).
  w.line('Student name', left, 46.5, { size: 8, color: SOFT });
  if (student) w.line(student.name, left + 22, 45.5, { size: 11, weight: 'bold', width: width - 22 });
  doc.moveTo(mm(left + 21), mm(50)).lineTo(mm(left + width), mm(50)).lineWidth(0.5).stroke(RULE);
  w.line('Signature', left, 54.5, { size: 8, color: SOFT });
  doc.moveTo(mm(left + 21), mm(58)).lineTo(mm(left + 70), mm(58)).lineWidth(0.5).stroke(RULE);
  if (student?.roll) w.line(`Roll no. ${student.roll}`, left + 76, 54.5, { size: 8, color: SOFT });

  // Instructions, with drawn examples of a correct and three wrong marks.
  const boxTop = 62;
  doc.roundedRect(mm(left - 2), mm(boxTop), mm(width + 2), mm(34), 6).lineWidth(0.5).stroke('#d1d5db');
  const lines = customInstructions(template).length
    ? customInstructions(template)
    : [
        'Use a black or dark blue ball-point pen. Fill the bubble completely.',
        'Write the last 4 digits of your roll number in the boxes (B12A-07 is 0007) and fill one bubble under each digit.',
        `A correct answer earns ${fmt(test.omr_marks_correct)}${test.negative_marking ? `, a wrong one costs ${fmt(test.negative_marking)}` : ''}. A blank earns 0. More than one bubble filled counts as wrong.`,
        'Do not fold this sheet, and do not write on the black squares or the bar at the top.',
      ];
  let y = boxTop + 3;
  for (const text of lines) {
    if (y > boxTop + 25) break;
    y += w.paragraph(`•  ${text}`, left + 1, y, width - 4, { size: 7.2, indent: 2.6 }) + 0.6;
  }
  drawMarkExamples(doc, w, left + 1, boxTop + 29.5, { r: 2 });

  // Roll number grid.
  const digits = student?.roll ? rollDigits(student.roll, layout.rollDigits) : null;
  doc.font('Helvetica-Bold').fontSize(7).fillColor(INK).text('ROLL NO.', mm(layout.rollLabel.x), mm(layout.rollLabel.y), { lineBreak: false });
  layout.roll.forEach((column, d) => {
    const { box } = column;
    doc.rect(mm(box.x), mm(box.y), mm(box.size), mm(box.size)).lineWidth(0.6).stroke('#6b7280');
    if (digits) doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(digits[d], mm(box.x), mm(box.y + 1.4), { width: mm(box.size), align: 'center', lineBreak: false });
    column.bubbles.forEach((b) => drawBubble(doc, b.x, b.y, layout.bubbleRadius, b.display, { filled: digits?.[d] === b.label }));
  });

  // Answer grid.
  for (const col of layout.columns) {
    for (let j = 0; j < layout.options; j++) {
      const x = col.firstOptionX + j * col.optionPitch;
      doc.font('Helvetica-Bold').fontSize(7).fillColor(SOFT).text(String.fromCharCode(65 + j), mm(x - 2), mm(col.headerY), { width: mm(4), align: 'center', lineBreak: false });
    }
  }
  for (const item of layout.items) {
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(INK).text(String(item.number), mm(item.labelX - 8), mm(item.y) - 2.7, { width: mm(8), align: 'right', lineBreak: false });
    for (const b of item.bubbles) drawBubble(doc, b.x, b.y, layout.bubbleRadius, b.display);
  }

  // Footer, below the bottom markers — clear of the blank patch the scanner checks.
  drawFooter(doc, w, layout, test, '');
}

/* ── Styles: board and competitive patterns ──────────────────────────── */

const bi = (en, hi, hindi) => (hindi && hi ? `${en} / ${hi}` : en);

/** The write-in boxes for a pattern sheet's candidate panel, as rows of cells. */
function candidateRows(style, { test, student, template, hindi }) {
  const extra = (template.extra_fields || []).map((label) => ({ label }));
  if (style === 'board') {
    return [
      [{ label: bi('Name of candidate', 'परीक्षार्थी का नाम', hindi), value: student?.name }],
      [
        { label: bi('Roll code', 'रोल कोड', hindi), boxes: 5 },
        { label: bi('Roll number', 'रोल नंबर', hindi), value: student?.roll },
        { label: bi('Date', 'तिथि', hindi), value: fmtDate(test.test_date) },
      ],
      [
        { label: bi('Subject', 'विषय', hindi), value: test.subject_name },
        { label: bi('Subject code', 'विषय कोड', hindi), boxes: 3 },
        { label: bi('Booklet set', 'पुस्तिका सेट', hindi), boxes: 1 },
      ],
      [{ label: bi('Booklet serial no.', 'पुस्तिका क्रमांक', hindi) }, ...extra],
    ];
  }
  return [
    [{ label: "Candidate's name", value: student?.name }],
    [
      { label: 'Roll number', value: student?.roll },
      { label: 'Test booklet code', boxes: 1 },
      { label: 'Centre code', boxes: 4 },
    ],
    [
      { label: 'Test / paper', value: test.title },
      { label: 'Date', value: fmtDate(test.test_date) },
      { label: 'Test booklet no.' },
    ],
    [
      { label: 'Subject', value: test.subject_name },
      { label: 'Batch', value: test.batch_name },
      { label: 'Medium (English / Hindi)' },
    ],
    ...(extra.length ? [extra] : []),
  ];
}

/** Rows of more than three cells wrap onto the next row. */
const chunkRows = (rows) => rows.flatMap((row) => (row.length <= 3 ? [row] : [row.slice(0, 3), row.slice(3)]));

function drawCell(doc, w, cell, x, y, width, boxH, accent) {
  w.line(cell.label, x, y, { size: 6.2, weight: 'semibold', color: accent, width });
  const top = y + 3.1;
  if (cell.boxes) {
    const size = Math.min(boxH, (width - 0.5) / cell.boxes);
    for (let i = 0; i < cell.boxes; i++) doc.rect(mm(x + i * size), mm(top), mm(size), mm(boxH)).lineWidth(0.5).stroke(RULE);
  } else {
    doc.roundedRect(mm(x), mm(top), mm(width), mm(boxH), 1.5).lineWidth(0.5).stroke(RULE);
    if (cell.value) w.line(cell.value, x + 1.2, top + (boxH - 3.4) / 2, { size: 8.5, weight: 'semibold', width: width - 2.4 });
  }
}

function drawPattern(doc, w, layout, { institute, test, student, template }) {
  const style = layout.style;
  const accent = STYLE_ACCENT[style];
  const hindi = style === 'board' && template.hindi !== false;
  drawRegistration(doc);

  // Heading block, between the orientation bar and the panels.
  w.line(template.heading || institute || 'CoachBook', 22, 18.6, { size: 14, weight: 'bold', width: 166, align: 'center' });
  const kind = template.subheading || (style === 'board' ? 'Board examination pattern' : 'Competitive exam pattern');
  const title = hindi ? 'OMR ANSWER SHEET  ·  उत्तर पत्रक' : 'OMR ANSWER SHEET';
  w.line(`${title}  ·  ${kind}`, 22, 25.2, { size: 8, weight: 'semibold', color: accent, width: 166, align: 'center' });

  // Candidate panel.
  const cp = layout.candidatePanel;
  doc.roundedRect(mm(cp.x), mm(cp.y), mm(cp.width), mm(cp.height), 4).lineWidth(0.7).stroke(accent);
  const examLine = [test.title, test.batch_name, test.subject_name, `${layout.questions} Q`, marking(test)].filter(Boolean).join('  ·  ');
  w.line(`${hindi ? 'परीक्षा / Exam' : 'Exam'}:  ${examLine}`, cp.x + 2.5, cp.y + 2, { size: 6.8, color: SOFT, width: cp.width - 5 });

  const rows = chunkRows(candidateRows(style, { test, student, template, hindi }));
  const sigH = 12;
  const innerTop = cp.y + 6.5;
  const avail = cp.y + cp.height - sigH - 2 - innerTop;
  const rowH = Math.min(10.4, avail / rows.length);
  const boxH = Math.max(4.2, rowH - 4.3);
  const gap = 2.5;
  const innerW = cp.width - 5;
  rows.forEach((row, r) => {
    const y = innerTop + r * rowH;
    const cellW = (innerW - gap * (row.length - 1)) / row.length;
    row.forEach((cell, c) => drawCell(doc, w, cell, cp.x + 2.5 + c * (cellW + gap), y, cellW, boxH, accent));
  });
  // Signatures.
  const sigY = cp.y + cp.height - sigH - 1.5;
  const sigs = [bi('Signature of candidate', 'परीक्षार्थी का हस्ताक्षर', hindi), bi('Signature of invigilator', 'वीक्षक का हस्ताक्षर', hindi)];
  const sigW = (innerW - gap) / 2;
  sigs.forEach((label, i) => {
    const x = cp.x + 2.5 + i * (sigW + gap);
    w.line(label, x, sigY, { size: 6.2, weight: 'semibold', color: accent, width: sigW });
    doc.roundedRect(mm(x), mm(sigY + 3.1), mm(sigW), mm(sigH - 3.6), 1.5).lineWidth(0.5).stroke(RULE);
  });

  // Roll number panel.
  const rp = layout.rollPanel;
  doc.roundedRect(mm(rp.x), mm(rp.y), mm(rp.width), mm(rp.height), 4).lineWidth(0.7).stroke(accent);
  w.line(hindi ? 'ROLL NO. / अनुक्रमांक' : 'ROLL NUMBER', rp.x, layout.rollLabel.y, { size: 7, weight: 'bold', color: accent, width: rp.width, align: 'center' });
  const digits = student?.roll ? rollDigits(student.roll, layout.rollDigits) : null;
  layout.roll.forEach((column, d) => {
    const { box } = column;
    doc.rect(mm(box.x), mm(box.y), mm(box.size), mm(box.size)).lineWidth(0.6).stroke('#6b7280');
    if (digits) doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(digits[d], mm(box.x), mm(box.y + 1.4), { width: mm(box.size), align: 'center', lineBreak: false });
    column.bubbles.forEach((b) => drawBubble(doc, b.x, b.y, layout.bubbleRadius, b.display, { filled: digits?.[d] === b.label, size: 5.5 }));
  });

  // Instructions band.
  const ib = layout.instructions;
  doc.roundedRect(mm(ib.x), mm(ib.y), mm(ib.width), mm(ib.height), 4).lineWidth(0.5).stroke('#d1d5db');
  w.line(hindi ? 'INSTRUCTIONS  /  निर्देश' : 'INSTRUCTIONS', ib.x + 2.5, ib.y + 1.8, { size: 7, weight: 'bold', color: accent });
  const exampleY = ib.y + ib.height - 3.2;
  const custom = customInstructions(template);
  const neg = test.negative_marking ? fmt(test.negative_marking) : null;
  const pos = fmt(test.omr_marks_correct);
  const optionWord = style === 'competitive' ? 'Options are numbered 1 to ' + layout.options + '.' : '';
  const english = custom.length ? custom : [
    'Use only a black or blue ball-point pen. Fill the bubble completely and darkly; do not tick or cross.',
    `Write your roll number in the boxes and fill the matching bubble under each digit (last ${layout.rollDigits} digits).`,
    `Each question has one correct answer${optionWord ? `. ${optionWord}` : '.'} Correct: +${pos}${neg ? `, wrong: −${neg}` : ''}, blank: 0. More than one bubble counts as wrong.`,
    'Do not fold or tear this sheet, and do not write on the black squares or the bar at the top.',
  ];
  const hindiLines = [
    'केवल काले या नीले बॉल-पॉइंट पेन का प्रयोग करें। गोले को पूरी तरह और गहरा भरें; टिक या क्रॉस का निशान न लगाएँ।',
    'अपना अनुक्रमांक खानों में लिखें और हर अंक के नीचे उसी अंक का गोला भरें।',
    `हर प्रश्न का केवल एक सही उत्तर है। सही उत्तर: +${pos}${neg ? `, गलत उत्तर: −${neg}` : ''}। एक से अधिक गोले भरने पर उत्तर गलत माना जाएगा।`,
    'इस पत्रक को न मोड़ें, न फाड़ें, और काले वर्गों या ऊपर की पट्टी पर कुछ न लिखें।',
  ];
  const textTop = ib.y + 6;
  const textBottom = exampleY - 3;
  if (hindi && !custom.length) {
    const colW = (ib.width - 7.5) / 2;
    const fit = (lines, x) => {
      let size = 6.6;
      const height = () => lines.reduce((h, l) => h + w.paragraph(`•  ${l}`, x, 0, colW, { size, indent: 2.4, draw: false }) + 0.5, 0);
      while (size > 5.2 && height() > textBottom - textTop) size -= 0.2;
      let y = textTop;
      for (const l of lines) y += w.paragraph(`•  ${l}`, x, y, colW, { size, indent: 2.4 }) + 0.5;
    };
    fit(english, ib.x + 2.5);
    doc.moveTo(mm(ib.x + ib.width / 2), mm(textTop)).lineTo(mm(ib.x + ib.width / 2), mm(textBottom)).lineWidth(0.4).stroke('#e5e7eb');
    fit(hindiLines, ib.x + 5 + colW);
  } else {
    let size = 6.8;
    const width = ib.width - 5;
    const height = () => english.reduce((h, l) => h + w.paragraph(`•  ${l}`, 0, 0, width, { size, indent: 2.4, draw: false }) + 0.4, 0);
    while (size > 5.2 && height() > textBottom - textTop) size -= 0.2;
    let y = textTop;
    for (const l of english) y += w.paragraph(`•  ${l}`, ib.x + 2.5, y, width, { size, indent: 2.4 }) + 0.4;
  }
  drawMarkExamples(doc, w, ib.x + 2.5, exampleY, { right: hindi ? 'Right / सही' : 'Right', wrong: hindi ? 'Wrong / गलत' : 'Wrong', r: 1.8 });
  w.line(
    hindi ? 'Shade like this  ·  ऐसे भरें' : 'Shade the bubble like the first example',
    ib.x + 95, exampleY - 1.3, { size: 6.5, color: SOFT, width: ib.width - 97.5, align: 'right' },
  );

  // Answer columns.
  for (const col of layout.columns) {
    if (!col.used) continue;
    const f = col.frame;
    doc.save().roundedRect(mm(f.x), mm(f.y), mm(f.width), mm(col.headerRule - f.y), 3).clip()
      .rect(mm(f.x), mm(f.y), mm(f.width), mm(col.headerRule - f.y)).fill(style === 'board' ? '#eef2ff' : '#fef2f2').restore();
    doc.roundedRect(mm(f.x), mm(f.y), mm(f.width), mm(f.height), 3).lineWidth(0.7).stroke(accent);
    doc.moveTo(mm(f.x), mm(col.headerRule)).lineTo(mm(f.x + f.width), mm(col.headerRule)).lineWidth(0.5).stroke(accent);
    w.line(hindi ? 'प्र.' : 'Q.', f.x + 1, col.headerY - 0.3, { size: 6.5, weight: 'bold', color: accent });
    col.labels.forEach((label, j) => {
      const x = col.firstOptionX + j * col.optionPitch;
      doc.font('Helvetica-Bold').fontSize(7).fillColor(accent).text(label, mm(x - 2), mm(col.headerY), { width: mm(4), align: 'center', lineBreak: false });
    });
    for (const y of col.dividers) doc.moveTo(mm(f.x + 1.2), mm(y)).lineTo(mm(f.x + f.width - 1.2), mm(y)).lineWidth(0.35).stroke('#d1d5db');
  }
  const r = layout.bubbleRadius;
  for (const item of layout.items) {
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(INK).text(String(item.number), mm(item.labelX - 8), mm(item.y) - 2.7, { width: mm(8), align: 'right', lineBreak: false });
    for (const b of item.bubbles) drawBubble(doc, b.x, b.y, r, b.display, { size: 5.5 });
  }

  drawFooter(doc, w, layout, test, style === 'board' ? 'board pattern' : 'competitive pattern');
}

/* ── Building the PDF ────────────────────────────────────────────────── */

/**
 * Builds the sheet PDF for an OMR-configured test. `students` (optional) is
 * [{ name, roll }] for the named flavour, one page each; without it the
 * result is a single blank page. `style` defaults to the test's own
 * (omr_style), `template` to the institute's OMR template. Resolves to a Buffer.
 */
export function omrSheetPdf({ institute, test, students = null, style, template }) {
  const sheetStyle = style || test.omr_style || 'coachbook';
  const tpl = template || templateFor('omr');
  const layout = sheetLayout({ questions: test.omr_questions, options: test.omr_options, style: sheetStyle });
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: false, info: { Title: `${latin(test.title)} - OMR sheet`, Creator: 'CoachBook' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      const w = writer(doc);
      const pages = students?.length ? students : [null];
      for (const student of pages) {
        doc.addPage({ size: 'A4', margin: 0 });
        const ctx = { institute, test, student, template: tpl };
        if (layout.style === 'coachbook') drawCoachbook(doc, w, layout, ctx);
        else drawPattern(doc, w, layout, ctx);
      }
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * A blank sheet for a made-up 100-question test, for previewing a style and
 * template before any test uses it.
 */
export function omrSamplePdf({ institute, style = 'coachbook', template, questions = 100, options = 4 } = {}) {
  const test = {
    title: 'Sample test',
    batch_name: 'Sample batch',
    subject_name: 'General Science',
    test_date: new Date().toISOString().slice(0, 10),
    omr_questions: questions,
    omr_options: options,
    omr_marks_correct: 4,
    negative_marking: 1,
  };
  return omrSheetPdf({ institute, test, style, template: template || templateFor('omr') });
}
