import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { gymOffsetMinutes } from './clock.js';
import { templateFor } from './printTemplates.js';

/*
 * Server-side PDF receipts: staff downloads, WhatsApp attachments, the member
 * portal and CoachBook fee receipts all come from here, so one owner-chosen
 * template (src/printTemplates.js, kind 'receipt') shapes every one of them.
 *
 * Three styles share the same content:
 *   modern  — accent stripe, the amount in a green card up top, soft sections;
 *   classic — a framed, formal invoice with ruled rows and the amount in words;
 *   minimal — narrow, black on white, no fills: for thermal and ink-saving printers.
 *
 * The 14 standard PDF fonts (Helvetica & co.) only cover WinAnsi, so "₹" and
 * "−" came out as "¹" and '"'. We embed Noto Sans instead (assets/fonts, OFL),
 * which PDFKit subsets so the file stays small. If the font files are ever
 * missing we fall back to Helvetica and spell the symbols in ASCII.
 */

const FONT_DIR = fileURLToPath(new URL('../assets/fonts/', import.meta.url));
const FONT_FILES = {
  regular: 'NotoSans-Regular.ttf',
  semibold: 'NotoSans-SemiBold.ttf',
  bold: 'NotoSans-Bold.ttf',
};
const HELVETICA = { regular: 'Helvetica', semibold: 'Helvetica-Bold', bold: 'Helvetica-Bold' };

let fontBuffers;
function loadFonts() {
  if (fontBuffers !== undefined) return fontBuffers;
  try {
    fontBuffers = Object.fromEntries(
      Object.entries(FONT_FILES).map(([key, file]) => [key, readFileSync(FONT_DIR + file)]),
    );
  } catch {
    fontBuffers = null;
  }
  return fontBuffers;
}

const COLORS = {
  ink: '#0f172a',
  body: '#334155',
  muted: '#64748b',
  faint: '#94a3b8',
  hairline: '#e2e8f0',
  green: '#047857',
  greenDark: '#065f46',
  greenTint: '#ecfdf5',
  greenLine: '#a7f3d0',
  amber: '#b45309',
  amberTint: '#fffbeb',
  amberLine: '#fde68a',
};

/** `hex` mixed toward white by `amount` (0…1) — a tint that prints as a pale wash of the accent. */
function tint(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c) => Math.round(c + (255 - c) * amount);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(mix);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parseDate(value) {
  if (value instanceof Date) return value;
  if (!value) return null;
  const iso = String(value).includes('T') ? String(value) : String(value).replace(' ', 'T');
  const parsed = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDate(value) {
  if (!value) return '—';
  const parsed = parseDate(value);
  if (!parsed) return String(value);
  return `${String(parsed.getDate()).padStart(2, '0')} ${MONTHS[parsed.getMonth()]} ${parsed.getFullYear()}`;
}

function formatMoney(amount, currency = 'INR') {
  const value = Number(amount || 0);
  const digits = value % 1 === 0 ? 0 : 2;
  try {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(value);
  } catch {
    return `₹${value.toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
  }
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function belowHundred(n) {
  if (n < 20) return ONES[n];
  return `${TENS[Math.floor(n / 10)]}${n % 10 ? `-${ONES[n % 10]}` : ''}`;
}

function belowThousand(n) {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  return [hundreds ? `${ONES[hundreds]} Hundred` : '', rest ? belowHundred(rest) : ''].filter(Boolean).join(' ');
}

/** 1499950 → "Fourteen Lakh Ninety-Nine Thousand Nine Hundred Fifty", the Indian way receipts write it. */
export function indianWords(value) {
  let n = Math.floor(Math.abs(Number(value) || 0));
  if (n === 0) return 'Zero';
  const parts = [];
  const crore = Math.floor(n / 1e7);
  n %= 1e7;
  const lakh = Math.floor(n / 1e5);
  n %= 1e5;
  const thousand = Math.floor(n / 1e3);
  n %= 1e3;
  if (crore) parts.push(`${crore >= 1000 ? indianWords(crore) : belowThousand(crore)} Crore`);
  if (lakh) parts.push(`${belowHundred(lakh)} Lakh`);
  if (thousand) parts.push(`${belowHundred(thousand)} Thousand`);
  if (n) parts.push(belowThousand(n));
  return parts.join(' ');
}

/** "Rupees Fourteen Thousand Nine Hundred Ninety-Nine Only" — INR only; null for other currencies. */
function amountInWords(amount, currency) {
  if (currency !== 'INR') return null;
  const value = Math.abs(Number(amount) || 0);
  const rupees = Math.floor(value);
  const paise = Math.round((value - rupees) * 100);
  return `Rupees ${indianWords(rupees)}${paise ? ` and ${belowHundred(paise)} Paise` : ''} Only`;
}

/** "07 Nov 2026, 3:16 PM" on the gym's own clock — the server itself may run in UTC. */
function printedAt() {
  let offset;
  try {
    offset = gymOffsetMinutes();
  } catch {
    offset = -new Date().getTimezoneOffset();
  }
  const local = new Date(Date.now() + offset * 60_000);
  const hours = local.getUTCHours();
  const minutes = String(local.getUTCMinutes()).padStart(2, '0');
  const date = `${String(local.getUTCDate()).padStart(2, '0')} ${MONTHS[local.getUTCMonth()]} ${local.getUTCFullYear()}`;
  return `${date}, ${hours % 12 || 12}:${minutes} ${hours < 12 ? 'AM' : 'PM'}`;
}

const METHOD_LABELS = {
  upi: 'UPI',
  cash: 'Cash',
  card: 'Card',
  bank: 'Bank transfer',
  bank_transfer: 'Bank transfer',
  neft: 'NEFT',
  imps: 'IMPS',
  rtgs: 'RTGS',
  cheque: 'Cheque',
  online: 'Online',
  wallet: 'Wallet',
};

function formatMethod(method) {
  const key = String(method || 'cash').trim().toLowerCase();
  if (METHOD_LABELS[key]) return METHOD_LABELS[key];
  return key.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

const WIDTHS = { modern: 360, classic: 400, minimal: 252 };
const MARGINS = { modern: 24, classic: 30, minimal: 14 };

/**
 * Generates a PDF receipt. Returns a Promise<Buffer> with the PDF bytes.
 *
 * `data` is a payment (id, amount, method, paid_on, reference, note, member
 * fields, optional membership plan fields) or a CoachBook fee receipt (adds
 * fee_items, components, course_name, batch_name, plan_total, plan_discount,
 * plan_final, balance_after).
 *
 * `options.template` overrides the gym's saved receipt template (the editor's
 * live preview); otherwise it is read from the current tenant.
 */
export function generateReceiptPdf(data, options = {}) {
  return new Promise((resolve, reject) => {
    try {
      const template = { ...templateFor('receipt'), ...(options.template || {}) };
      const style = WIDTHS[template.style] ? template.style : 'modern';
      const fonts = loadFonts();
      const doc = new PDFDocument({
        autoFirstPage: false,
        margin: 0,
        info: { Title: `Receipt ${data.receipt_no || data.id || ''}`.trim(), Creator: options.gymName || 'GymBook' },
      });
      if (fonts) {
        for (const [key, buffer] of Object.entries(fonts)) doc.registerFont(key, buffer);
      }
      const fontName = (weight) => (fonts ? weight : HELVETICA[weight]);
      // Helvetica can't draw these; only used if the bundled fonts are missing.
      const clean = (text) => {
        const str = String(text ?? '');
        return fonts ? str : str.replace(/₹\s?/g, 'Rs. ').replace(/[−–]/g, '-');
      };

      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', (err) => reject(err));

      let logo = null;
      if (options.logoBuffer && template.show_logo) {
        try {
          logo = doc.openImage(options.logoBuffer);
        } catch {
          logo = null;
        }
      }

      const ctx = { fontName, clean, logo, style, template };
      // Lay out once to measure the height, then again on a page that fits exactly.
      const height = drawReceipt(doc, data, options, { ...ctx, draw: false });
      doc.addPage({ size: [WIDTHS[style], Math.ceil(height)], margin: 0 });
      drawReceipt(doc, data, options, { ...ctx, draw: true });
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function drawReceipt(doc, data, options, { draw, fontName, clean, logo, style, template }) {
  const W = WIDTHS[style];
  const M = MARGINS[style];
  const CW = W - M * 2;
  const modern = style === 'modern';
  const classic = style === 'classic';
  const minimal = style === 'minimal';
  const accent = minimal ? COLORS.ink : template.accent;
  const scale = minimal ? 0.92 : 1;
  const fs = (size) => size * scale;

  const currency = options.currency || 'INR';
  const money = (amount) => formatMoney(amount, currency);
  const orgName = options.gymName || data.gym_name || 'GymBook';
  const title = options.title || 'PAYMENT RECEIPT';
  const receiptNo = data.receipt_no || (data.id ? `PAY-${String(data.id).padStart(5, '0')}` : '—');
  const paidOn = formatDate(data.paid_on || new Date());

  let y = 0;

  /* ── drawing primitives (no-ops on the measuring pass) ─────────────── */
  const setFont = (weight, size) => doc.font(fontName(weight)).fontSize(size);
  const measure = (text, weight, size, width, extra = {}) => {
    setFont(weight, size);
    return doc.heightOfString(clean(text), { width, lineGap: 1, ...extra });
  };
  const write = (text, x, top, { weight = 'regular', size = 10, color = COLORS.ink, width, align = 'left', spacing = 0 } = {}) => {
    const str = clean(text);
    const h = measure(str, weight, size, width, { characterSpacing: spacing });
    if (draw) {
      setFont(weight, size);
      doc.fillColor(color).text(str, x, top, { width, align, lineGap: 1, characterSpacing: spacing });
    }
    return h;
  };
  const widthOf = (text, weight, size, spacing = 0) => {
    setFont(weight, size);
    return doc.widthOfString(clean(text), { characterSpacing: spacing });
  };
  const box = (x, top, w, h, { fill, stroke, radius = 8, lineWidth = 0.75 }) => {
    if (!draw) return;
    doc.save();
    if (radius) doc.roundedRect(x, top, w, h, radius);
    else doc.rect(x, top, w, h);
    doc.lineWidth(lineWidth);
    if (fill && stroke) doc.fillAndStroke(fill, stroke);
    else if (fill) doc.fill(fill);
    else doc.stroke(stroke);
    doc.restore();
  };
  const line = (top, { dashed = false, color = COLORS.hairline, width = 0.75, from = M, to = W - M } = {}) => {
    if (!draw) return;
    doc.save().strokeColor(color).lineWidth(width);
    if (dashed) doc.dash(3, { space: 3 });
    doc.moveTo(from, top).lineTo(to, top).stroke();
    doc.restore();
  };
  const pill = (text, centerX, top, { color, fill, size = 7.5 }) => {
    const spacing = 1.1;
    const w = widthOf(text, 'semibold', size, spacing) + 18;
    const h = size + 10;
    box(centerX - w / 2, top, w, h, { fill, radius: h / 2 });
    if (draw) {
      setFont('semibold', size);
      doc.fillColor(color).text(clean(text), centerX - w / 2, top + 4, { width: w, align: 'center', characterSpacing: spacing, lineBreak: false });
    }
    return h;
  };
  const centered = (text, opts) => write(text, M, y, { width: CW, align: 'center', ...opts });

  /* ── Header ────────────────────────────────────────────────────────── */
  if (modern && draw) doc.save().rect(0, 0, W, 5).fill(accent).restore();
  y = classic ? 34 : minimal ? 16 : 26;

  if (logo) {
    const size = minimal ? 34 : 44;
    if (draw) doc.image(logo, (W - size) / 2, y, { fit: [size, size], align: 'center', valign: 'center' });
    y += size + (minimal ? 6 : 10);
  }

  y += centered(orgName, { weight: 'bold', size: fs(classic ? 18 : 17), color: classic ? accent : COLORS.ink });
  if (template.address) {
    y += 1;
    y += centered(template.address, { size: fs(8.5), color: COLORS.muted });
  }
  if (template.contact) {
    y += 1;
    y += centered(template.contact, { size: fs(8.5), color: COLORS.muted });
  }
  if (options.gstin) {
    y += 1;
    y += centered(`GSTIN ${options.gstin}`, { size: fs(8.5), color: COLORS.muted, weight: classic ? 'semibold' : 'regular' });
  }

  if (modern) {
    y += 8;
    y += pill(title.toUpperCase(), W / 2, y, { color: accent, fill: tint(accent, 0.9) });
    y += 16;
  } else if (classic) {
    y += 10;
    const bandH = 22;
    box(M, y, CW, bandH, { fill: accent, radius: 0 });
    write(title.toUpperCase(), M, y + 5.5, { weight: 'bold', size: 9.5, color: '#ffffff', width: CW, align: 'center', spacing: 1.6 });
    y += bandH + 10;
    // Receipt number and date on one line, either side.
    const half = CW / 2;
    const left = write(`Receipt no.  ${receiptNo}`, M, y, { weight: 'semibold', size: 9, color: COLORS.body, width: half });
    const right = write(`Date  ${paidOn}`, M + half, y, { weight: 'semibold', size: 9, color: COLORS.body, width: half, align: 'right' });
    y += Math.max(left, right) + 10;
  } else {
    y += 4;
    y += centered(title.toUpperCase(), { weight: 'bold', size: fs(9), color: COLORS.ink, spacing: 1.2 });
    y += 8;
    line(y, { dashed: true, color: COLORS.ink });
    y += 10;
  }

  /* ── Amount card (modern) ──────────────────────────────────────────── */
  if (modern) {
    const cardTop = y;
    const pad = 14;
    const innerW = CW - pad * 2;
    const cardX = M + pad;
    const amountText = money(data.amount);
    const metaText = `${receiptNo}  ·  ${paidOn}  ·  ${formatMethod(data.method)}`;
    const labelH = measure('AMOUNT PAID', 'semibold', 7.5, innerW, { characterSpacing: 1.1 });
    const amountH = measure(amountText, 'bold', 26, innerW);
    const metaH = measure(metaText, 'regular', 8.5, innerW);
    const cardH = pad + labelH + 2 + amountH + 2 + metaH + pad - 2;
    box(M, cardTop, CW, cardH, { fill: COLORS.greenTint, stroke: COLORS.greenLine, radius: 10 });
    let cy = cardTop + pad;
    cy += write('AMOUNT PAID', cardX, cy, { weight: 'semibold', size: 7.5, color: COLORS.green, width: innerW, spacing: 1.1 }) + 2;
    cy += write(amountText, cardX, cy, { weight: 'bold', size: 26, color: COLORS.greenDark, width: innerW }) + 2;
    write(metaText, cardX, cy, { size: 8.5, color: COLORS.muted, width: innerW });
    const stampW = widthOf('PAID', 'semibold', 7.5, 1.1) + 18;
    pill('PAID', M + CW - pad - stampW / 2, cardTop + pad - 2, { color: '#ffffff', fill: COLORS.green });
    y = cardTop + cardH + 18;
  }

  /* ── Sections ──────────────────────────────────────────────────────── */
  const LABEL_W = minimal ? 78 : classic ? 120 : 104;
  const VALUE_W = CW - LABEL_W;

  const sectionTitle = (text) => {
    if (classic) {
      y += write(text.toUpperCase(), M, y, { weight: 'bold', size: 8, color: accent, width: CW, spacing: 1.2 });
      y += 3;
      line(y, { color: accent, width: 1 });
      y += 6;
      return;
    }
    y += write(text.toUpperCase(), M, y, {
      weight: minimal ? 'bold' : 'semibold',
      size: fs(7.5),
      color: minimal ? COLORS.ink : COLORS.faint,
      width: CW,
      spacing: 1.1,
    });
    y += minimal ? 4 : 6;
  };
  const row = (label, value, { bold = false, color = COLORS.ink } = {}) => {
    const size = fs(bold ? 10 : 9.5);
    const lh = write(label, M, y, { size: fs(9.5), color: minimal ? COLORS.body : COLORS.muted, width: LABEL_W - 8 });
    const vh = write(value ?? '', M + LABEL_W, y, { weight: bold ? 'bold' : 'regular', size, color, width: VALUE_W, align: 'right' });
    const h = Math.max(lh, vh);
    if (classic) {
      y += h + 4;
      line(y, { color: '#eef0f3' });
      y += 5;
    } else {
      y += h + (minimal ? 3 : 5);
    }
  };
  const sectionGap = () => {
    if (classic) {
      y += 10;
      return;
    }
    y += minimal ? 4 : 6;
    line(y, minimal ? { dashed: true, color: COLORS.muted } : {});
    y += minimal ? 9 : 14;
  };

  const personLabel = data.person_label || 'Member';
  const personName = data.first_name ? `${data.first_name} ${data.last_name || ''}`.trim() : data.member_name || personLabel;
  sectionTitle(personLabel);
  row('Name', personName, { bold: true });
  if (data.member_code) row('Code', data.member_code);
  if (data.phone) row('Phone', data.phone);

  sectionGap();
  sectionTitle('Payment details');
  if (!classic) {
    row('Receipt no.', receiptNo);
    row('Date', paidOn);
  }
  row('Method', formatMethod(data.method));
  if (data.reference) row('Reference', data.reference);
  if (data.note) row('Note', data.note);

  if (data.plan_name) {
    sectionGap();
    sectionTitle('Membership');
    row('Plan', data.plan_name);
    if (data.start_date && data.end_date) row('Period', `${formatDate(data.start_date)} – ${formatDate(data.end_date)}`);
    if (data.price != null) row('Plan price', money(data.price));
    if (data.discount) row('Discount', `−${money(data.discount)}`, { color: minimal ? COLORS.ink : COLORS.green });
  }

  const feeItems = Array.isArray(data.fee_items) ? data.fee_items : null;
  const components = Array.isArray(data.components) ? data.components : [];
  if (feeItems) {
    sectionGap();
    sectionTitle('Course fee');
    if (data.course_name) row('Course', data.course_name);
    if (data.batch_name) row('Batch', data.batch_name);
    for (const component of components) row(component.label, money(component.amount));
    if (data.plan_total != null) row('Course fee', money(data.plan_total));
    if (data.plan_discount) row('Concession', `−${money(data.plan_discount)}`, { color: minimal ? COLORS.ink : COLORS.green });
    if (data.plan_final != null) {
      if (!classic) {
        y += 1;
        line(y, { dashed: true, color: minimal ? COLORS.muted : COLORS.hairline });
        y += 6;
      }
      row('Payable', money(data.plan_final), { bold: true });
    }

    sectionGap();
    sectionTitle('Paid towards');
    for (const item of feeItems) {
      const label = item.label ? `#${item.installment_number} ${item.label}` : `Installment ${item.installment_number}`;
      row(label, money(item.amount));
    }

    const balance = Number(data.balance_after ?? 0);
    const owed = balance > 0;
    if (modern) {
      // Balance callout: amber while something is still owed, green once cleared.
      y += 4;
      const top = y;
      const pad = 10;
      const label = owed ? 'Balance due' : 'Fully paid';
      const value = money(owed ? balance : 0);
      const textH = Math.max(measure(label, 'semibold', 10, LABEL_W), measure(value, 'bold', 12, VALUE_W - pad * 2));
      const h = textH + pad * 2;
      box(M, top, CW, h, {
        fill: owed ? COLORS.amberTint : COLORS.greenTint,
        stroke: owed ? COLORS.amberLine : COLORS.greenLine,
        radius: 8,
      });
      const tone = owed ? COLORS.amber : COLORS.green;
      write(label, M + pad, top + pad + 1, { weight: 'semibold', size: 10, color: tone, width: LABEL_W });
      write(value, M + LABEL_W, top + pad - 1, { weight: 'bold', size: 12, color: tone, width: VALUE_W - pad, align: 'right' });
      y = top + h;
    } else {
      row(owed ? 'Balance due' : 'Fully paid', money(owed ? balance : 0), { bold: true, color: classic && owed ? COLORS.amber : COLORS.ink });
    }
  }

  /* ── Amount (classic, minimal) ─────────────────────────────────────── */
  if (classic) {
    y += 12;
    const top = y;
    const pad = 12;
    const amountText = money(data.amount);
    const words = amountInWords(data.amount, currency);
    const amountH = measure(amountText, 'bold', 18, CW / 2);
    const wordsH = words ? measure(words, 'regular', 8.5, CW - pad * 2) + 6 : 0;
    const h = pad + Math.max(amountH, 14) + wordsH + pad;
    box(M, top, CW, h, { fill: tint(accent, 0.92), stroke: accent, radius: 4, lineWidth: 1 });
    write('AMOUNT PAID', M + pad, top + pad + 5, { weight: 'bold', size: 9.5, color: accent, width: CW / 2, spacing: 1 });
    write(amountText, M + CW / 2, top + pad - 1, { weight: 'bold', size: 18, color: COLORS.ink, width: CW / 2 - pad, align: 'right' });
    if (words) write(words, M + pad, top + pad + Math.max(amountH, 14) + 4, { size: 8.5, color: COLORS.body, width: CW - pad * 2 });
    y = top + h;
  } else if (minimal) {
    y += 6;
    line(y, { color: COLORS.ink, width: 1.4 });
    y += 8;
    const lh = write('TOTAL PAID', M, y + 3, { weight: 'bold', size: 10.5, width: CW / 2 });
    const vh = write(money(data.amount), M + CW / 2, y, { weight: 'bold', size: 15, width: CW / 2, align: 'right' });
    y += Math.max(lh + 3, vh) + 4;
    line(y, { color: COLORS.ink, width: 1.4 });
    y += 4;
  }

  /* ── Terms, signature ──────────────────────────────────────────────── */
  if (template.terms) {
    y += minimal ? 10 : 16;
    if (!minimal) {
      y += write('TERMS', M, y, { weight: 'semibold', size: 7, color: COLORS.faint, width: CW, spacing: 1.1 });
      y += 3;
    }
    y += write(template.terms, M, y, { size: fs(7.5), color: COLORS.muted, width: CW });
  }

  if (template.show_signature) {
    y += minimal ? 26 : 34;
    const sigW = minimal ? 110 : 140;
    const sigX = W - M - sigW;
    line(y, { color: COLORS.body, width: 0.75, from: sigX, to: W - M });
    y += 4;
    y += write(template.signature_label || 'Authorised signatory', sigX, y, { size: fs(8), color: COLORS.muted, width: sigW, align: 'center' });
  }

  /* ── Footer ────────────────────────────────────────────────────────── */
  y += minimal ? 12 : 18;
  line(y, { dashed: true, color: minimal ? COLORS.muted : '#cbd5e1' });
  y += minimal ? 10 : 14;
  if (template.footer_note) {
    y += centered(template.footer_note, { weight: 'semibold', size: fs(10.5), color: COLORS.body });
    y += 3;
  }
  if (!template.show_signature) {
    y += centered('This is a computer-generated receipt and needs no signature.', { size: fs(7.5), color: COLORS.faint });
    y += 1;
  }
  y += centered(`Printed on ${printedAt()}`, { size: fs(7.5), color: COLORS.faint });
  y += minimal ? 16 : 26;

  // Classic: a double rule framing the whole receipt.
  if (classic && draw) {
    doc.save().lineWidth(1.4).strokeColor(accent).rect(10, 10, W - 20, y - 20 + 4).stroke();
    doc.lineWidth(0.5).rect(14, 14, W - 28, y - 28 + 4).stroke().restore();
  }
  if (classic) y += 4;

  return y;
}
