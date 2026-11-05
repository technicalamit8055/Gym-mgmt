import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import { badRequest } from '../errors.js';

/**
 * Stamps a smartboard's exported class notes with the institute's header and
 * footer — institute, batch, subject and date across the top, "Page 3 of 12"
 * along the bottom — so a page forwarded on WhatsApp still says whose it is.
 *
 * The board's own drawing is left untouched: pdf-lib wraps each page's
 * existing content in q/Q the first time it draws on it (autoNormalizeCTM),
 * so a page that leaves a transform or colour set cannot skew the stamp.
 * Each band sits on a translucent white strip, because blackboard-style
 * exports are white chalk on black and grey text would vanish on them.
 *
 * Helvetica is one of the 14 fonts every PDF reader carries, so nothing has to
 * be embedded — at the price of its WinAnsi character set: text it cannot
 * draw (a Devanagari institute name, say) is dropped from the stamp rather
 * than failing the upload.
 */

const INK = rgb(0.16, 0.17, 0.22);
const STRIP = rgb(1, 1, 1);

/**
 * Where a point measured on the page *as displayed* lands in the page's own
 * coordinates, and the angle text must be drawn at to read upright there.
 *
 * A page's /Rotate turns it clockwise for display, so a portrait page with
 * Rotate 90 shows landscape; `box` is its crop box, the part a reader shows.
 */
export function toUserSpace(box, rotation, vx, vy) {
  const { x, y, width: w, height: h } = box;
  switch (rotation) {
    case 90:
      return { x: x + w - vy, y: y + vx, angle: 90 };
    case 180:
      return { x: x + w - vx, y: y + h - vy, angle: 180 };
    case 270:
      return { x: x + vy, y: y + h - vx, angle: 270 };
    default:
      return { x: x + vx, y: y + vy, angle: 0 };
  }
}

/** Only the characters `font` can encode; everything else is dropped. */
function drawable(font, text) {
  const supported = new Set(font.getCharacterSet());
  return [...String(text ?? '')]
    .map((ch) => {
      if (supported.has(ch.codePointAt(0))) return ch;
      const plain = ch.normalize('NFKD').replace(/[̀-ͯ]/g, '');
      return [...plain].every((c) => supported.has(c.codePointAt(0))) ? plain : '';
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Cuts `text` with an ellipsis until it fits `maxWidth`. */
function fit(font, text, size, maxWidth) {
  if (maxWidth <= 0) return '';
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  let cut = text;
  while (cut.length && font.widthOfTextAtSize(`${cut}…`, size) > maxWidth) cut = cut.slice(0, -1);
  return cut ? `${cut.trimEnd()}…` : '';
}

/**
 * @param {Buffer|Uint8Array} bytes The board's PDF.
 * @param {object} stamp Already-formatted strings.
 * @param {string} stamp.institute
 * @param {string} stamp.batch
 * @param {string} [stamp.subject]
 * @param {string} stamp.date
 * @param {string} [stamp.teacher]
 * @param {string} [stamp.title] Written into the document's own metadata.
 * @returns {Promise<{pdf: Buffer, pages: number}>}
 * @throws 400 for anything that is not a readable, unlocked PDF.
 */
export async function stampNotesPdf(bytes, { institute, batch, subject, date, teacher, title }) {
  if (!bytes?.length || Buffer.from(bytes.subarray(0, 1024)).indexOf('%PDF-') === -1) {
    throw badRequest('The notes have to be a PDF', { file: 'not a PDF' });
  }
  let doc;
  let pages;
  try {
    // Loaded *with* encryption ignored and then checked, rather than catching
    // EncryptedPDFError: pdf-lib's ES5 build breaks instanceof on its errors.
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    // Inside the try: a file with no page tree still "loads", and only fails here.
    pages = doc.isEncrypted ? [] : doc.getPages();
  } catch {
    throw badRequest('That PDF could not be read — try exporting it from the board again', { file: 'unreadable' });
  }
  if (doc.isEncrypted) {
    throw badRequest('This PDF is password-protected — export it from the board without a password', { file: 'encrypted' });
  }
  if (!pages.length) throw badRequest('That PDF has no pages', { file: 'empty' });

  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const left = drawable(bold, institute);
  const right = [batch, subject, date].map((part) => drawable(regular, part)).filter(Boolean).join('  ·  ');
  const byline = teacher ? drawable(regular, `Notes by ${teacher}`) : '';

  pages.forEach((page, index) => {
    const box = page.getCropBox();
    const rotation = (((page.getRotation().angle % 360) + 360) % 360);
    const sideways = rotation === 90 || rotation === 270;
    const width = sideways ? box.height : box.width;
    const height = sideways ? box.width : box.height;
    // Scales with the page: ~9pt on A4, ~16pt on a 1920×1080 board export.
    const size = Math.min(24, Math.max(7, Math.min(width, height) * 0.015));
    const band = size * 2.2;
    const margin = size * 1.6;
    const baseline = (bottom) => bottom + (band - size * 0.7) / 2;

    const strip = (vy) => {
      const at = toUserSpace(box, rotation, 0, vy);
      page.drawRectangle({
        x: at.x, y: at.y, width, height: band, rotate: degrees(at.angle), color: STRIP, opacity: 0.82,
      });
    };
    const text = (value, font, vx, vy) => {
      if (!value) return;
      const at = toUserSpace(box, rotation, vx, vy);
      page.drawText(value, { x: at.x, y: at.y, size, font, color: INK, rotate: degrees(at.angle) });
    };
    // Right-hand text keeps its full width; the left side gives way to it.
    const row = (leftText, leftFont, rightText, vy) => {
      const shownRight = fit(regular, rightText, size, width - 2 * margin);
      const rightWidth = shownRight ? regular.widthOfTextAtSize(shownRight, size) : 0;
      const shownLeft = fit(leftFont, leftText, size, width - 2 * margin - rightWidth - (rightWidth ? size * 2 : 0));
      text(shownLeft, leftFont, margin, vy);
      text(shownRight, regular, width - margin - rightWidth, vy);
    };

    strip(height - band);
    row(left, bold, right, baseline(height - band));
    strip(0);
    row(byline, regular, `Page ${index + 1} of ${pages.length}`, baseline(0));
  });

  // Metadata is UTF-16, so it keeps whatever the stamp had to drop.
  if (title) doc.setTitle(title);
  if (institute) doc.setAuthor(institute);
  doc.setSubject([batch, subject, date].filter(Boolean).join(' · '));
  doc.setModificationDate(new Date());
  return { pdf: Buffer.from(await doc.save()), pages: pages.length };
}
