import PDFDocument from 'pdfkit';
import { MARKER_SIZE, MARKERS, ORIENTATION_BAR, PAGE, rollDigits, sheetLayout } from '../../public/js/omrLayout.js';

/**
 * The printable OMR answer sheet: one A4 page drawn from the same layout the
 * phone reads with (public/js/omrLayout.js), so what is printed is exactly
 * where the scanner looks.
 *
 * Two flavours:
 *   - blank: one page for the teacher to photocopy; students write their
 *     name and bubble their roll number;
 *   - named: one page per student on the roster with the name printed and
 *     the roll-number bubbles already filled, for an institute that prints
 *     per paper — nobody can bubble the wrong roll number.
 *
 * Drawing rules the scanner depends on: the corner squares and the top bar
 * are solid black with clear paper around them, the patch mirrored from the
 * bar at the bottom stays blank, and bubbles are thin grey rings with a pale
 * letter, so an empty one reads as near-white and a filled one as dark.
 *
 * Helvetica is one of the PDF base fonts and embeds nothing, at the cost of
 * its Latin-1 character set: anything outside it is dropped from the text.
 */

const PT = 72 / 25.4;
const mm = (v) => v * PT;
const INK = '#111111';
const SOFT = '#6b7280';
const RING = '#7c8089';
const LETTER = '#a3a7ae';

const KEEP = new Set([...'–—‘’“”•…₹'].map((c) => c.codePointAt(0)));
function latin(text) {
  return [...String(text ?? '').normalize('NFKC')]
    .filter((ch) => ch.codePointAt(0) <= 0xff || KEEP.has(ch.codePointAt(0)))
    .join('')
    .replace(/₹/g, 'Rs ')
    .replace(/\s+/g, ' ')
    .trim();
}

const fmt = (v) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100));

function drawBubble(doc, x, y, r, label, { filled = false } = {}) {
  if (filled) {
    doc.circle(mm(x), mm(y), mm(r)).fill(INK);
    return;
  }
  doc.circle(mm(x), mm(y), mm(r)).lineWidth(0.8).stroke(RING);
  doc.font('Helvetica').fontSize(6).fillColor(LETTER).text(label, mm(x - r), mm(y) - 2.3, { width: mm(2 * r), align: 'center', lineBreak: false });
}

function drawPage(doc, layout, { institute, test, student }) {
  // Registration: corner squares and the orientation bar.
  doc.fillColor(INK);
  for (const m of Object.values(MARKERS)) doc.rect(mm(m.x - MARKER_SIZE / 2), mm(m.y - MARKER_SIZE / 2), mm(MARKER_SIZE), mm(MARKER_SIZE)).fill(INK);
  doc.rect(mm(ORIENTATION_BAR.x), mm(ORIENTATION_BAR.y), mm(ORIENTATION_BAR.width), mm(ORIENTATION_BAR.height)).fill(INK);

  // Header.
  const left = 22;
  const width = 130;
  doc.font('Helvetica-Bold').fontSize(14).fillColor(INK).text(latin(institute) || 'CoachBook', mm(left), mm(22), { width: mm(width), lineBreak: false, ellipsis: true });
  doc.font('Helvetica-Bold').fontSize(8).fillColor(SOFT).text('OMR ANSWER SHEET', mm(left), mm(29.5), { lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(latin(test.title), mm(left), mm(33.5), { width: mm(width), lineBreak: false, ellipsis: true });
  const details = [
    latin(test.batch_name),
    latin(test.subject_name),
    test.test_date,
    `${layout.questions} questions`,
    `+${fmt(test.omr_marks_correct)} correct${test.negative_marking ? `, -${fmt(test.negative_marking)} wrong` : ''}`,
  ].filter(Boolean);
  doc.font('Helvetica').fontSize(7.5).fillColor(SOFT).text(details.join('  ·  '), mm(left), mm(39), { width: mm(width), lineBreak: false, ellipsis: true });

  // Who: name and signature lines (or the printed name).
  doc.font('Helvetica').fontSize(8).fillColor(SOFT).text('Student name', mm(left), mm(46.5), { lineBreak: false });
  if (student) {
    doc.font('Helvetica-Bold').fontSize(11).fillColor(INK).text(latin(student.name), mm(left + 22), mm(45.5), { width: mm(width - 22), lineBreak: false, ellipsis: true });
  }
  doc.moveTo(mm(left + 21), mm(50)).lineTo(mm(left + width), mm(50)).lineWidth(0.5).stroke('#9ca3af');
  doc.font('Helvetica').fontSize(8).fillColor(SOFT).text('Signature', mm(left), mm(54.5), { lineBreak: false });
  doc.moveTo(mm(left + 21), mm(58)).lineTo(mm(left + 70), mm(58)).lineWidth(0.5).stroke('#9ca3af');
  if (student?.roll) doc.font('Helvetica').fontSize(8).fillColor(SOFT).text(`Roll no. ${latin(student.roll)}`, mm(left + 76), mm(54.5), { lineBreak: false });

  // Instructions, with drawn examples of a correct and three wrong marks.
  const boxTop = 62;
  doc.roundedRect(mm(left - 2), mm(boxTop), mm(width + 2), mm(34), 6).lineWidth(0.5).stroke('#d1d5db');
  const lines = [
    'Use a black or dark blue ball-point pen. Fill the bubble completely.',
    'Write the last 4 digits of your roll number in the boxes (B12A-07 is 0007) and fill one bubble under each digit.',
    `A correct answer earns ${fmt(test.omr_marks_correct)}${test.negative_marking ? `, a wrong one costs ${fmt(test.negative_marking)}` : ''}. A blank earns 0. More than one bubble filled counts as wrong.`,
    'Do not fold this sheet, and do not write on the black squares or the bar at the top.',
  ];
  let y = boxTop + 3;
  doc.font('Helvetica').fontSize(7.2).fillColor(INK);
  for (const line of lines) {
    doc.text(`•  ${line}`, mm(left + 1), mm(y), { width: mm(width - 4) });
    y = doc.y / PT + 1.2;
  }
  const exY = boxTop + 29.5;
  doc.font('Helvetica-Bold').fontSize(7).fillColor(INK).text('Right', mm(left + 1), mm(exY - 1.2), { lineBreak: false });
  doc.circle(mm(left + 13), mm(exY), mm(2)).fill(INK);
  doc.font('Helvetica-Bold').fontSize(7).fillColor(INK).text('Wrong', mm(left + 22), mm(exY - 1.2), { lineBreak: false });
  const wrongX = [left + 35, left + 42, left + 49];
  for (const x of wrongX) doc.circle(mm(x), mm(exY), mm(2)).lineWidth(0.8).stroke(RING);
  doc.moveTo(mm(wrongX[0] - 1.1), mm(exY)).lineTo(mm(wrongX[0] - 0.2), mm(exY + 1)).lineTo(mm(wrongX[0] + 1.3), mm(exY - 1.2)).lineWidth(0.9).stroke(INK);
  doc.moveTo(mm(wrongX[1] - 1.1), mm(exY - 1.1)).lineTo(mm(wrongX[1] + 1.1), mm(exY + 1.1)).moveTo(mm(wrongX[1] + 1.1), mm(exY - 1.1)).lineTo(mm(wrongX[1] - 1.1), mm(exY + 1.1)).lineWidth(0.9).stroke(INK);
  doc.save().circle(mm(wrongX[2]), mm(exY), mm(2)).clip().rect(mm(wrongX[2] - 2), mm(exY), mm(4), mm(2)).fill(INK).restore();

  // Roll number grid.
  const digits = student?.roll ? rollDigits(student.roll) : null;
  doc.font('Helvetica-Bold').fontSize(7).fillColor(INK).text('ROLL NO.', mm(layout.rollLabel.x), mm(layout.rollLabel.y), { lineBreak: false });
  layout.roll.forEach((column, d) => {
    const { box } = column;
    doc.rect(mm(box.x), mm(box.y), mm(box.size), mm(box.size)).lineWidth(0.6).stroke('#6b7280');
    if (digits) doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(digits[d], mm(box.x), mm(box.y + 1.4), { width: mm(box.size), align: 'center', lineBreak: false });
    column.bubbles.forEach((b) => drawBubble(doc, b.x, b.y, layout.bubbleRadius, b.label, { filled: digits?.[d] === b.label }));
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
    for (const b of item.bubbles) drawBubble(doc, b.x, b.y, layout.bubbleRadius, b.label);
  }

  // Footer, below the bottom markers — clear of the blank patch the scanner checks.
  doc.font('Helvetica').fontSize(6.5).fillColor(SOFT).text(
    `CoachBook OMR sheet v${layout.version} · ${layout.questions}×${layout.options} · Scan in the CoachBook app: Tests › ${latin(test.title)} › Scan sheets`,
    mm(20), mm(PAGE.height - 7.5), { width: mm(PAGE.width - 40), align: 'center', lineBreak: false, ellipsis: true },
  );
}

/**
 * Builds the sheet PDF for an OMR-configured test. `students` (optional) is
 * [{ name, roll }] for the named flavour, one page each; without it the
 * result is a single blank page. Resolves to a Buffer.
 */
export function omrSheetPdf({ institute, test, students = null }) {
  const layout = sheetLayout({ questions: test.omr_questions, options: test.omr_options });
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: false, info: { Title: `${latin(test.title)} - OMR sheet`, Creator: 'CoachBook' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const pages = students?.length ? students : [null];
    for (const student of pages) {
      doc.addPage({ size: 'A4', margin: 0 });
      drawPage(doc, layout, { institute, test, student });
    }
    doc.end();
  });
}
