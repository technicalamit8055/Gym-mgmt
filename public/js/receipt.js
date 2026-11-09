import { api, serverOrigin, serverUrl } from './api.js';
import { clear, date, fullName, h, money, toast, today } from './ui.js';
import { imageBytesToPdf } from './pdf.js';

/**
 * Payment receipt: a clean, printer-friendly document rendered into #print-root
 * using the same body.printing mechanism as QR ID cards.
 *
 * `printReceipt(data, { gymName })` builds and prints a single receipt in the
 * owner's receipt template (Settings › Print templates) — the same style the
 * server's PDF uses, so a printed and a downloaded receipt match.
 *
 * `data` is a payment object with at least:
 *   id, amount, method, paid_on, reference, note,
 *   member_code, first_name, last_name,
 *   plan_name (optional), start_date (optional), end_date (optional),
 *   price (optional), discount (optional)
 *
 * For the "print right after save" flow, we synthesize this object from form
 * values + the API response rather than making an extra fetch.
 */

export const DEFAULT_RECEIPT_TEMPLATE = {
  style: 'modern',
  accent: '#4f46e5',
  show_logo: true,
  address: '',
  contact: '',
  footer_note: 'Thank you for your payment!',
  terms: '',
  show_signature: false,
  signature_label: 'Authorised signatory',
};

let templatePromise = null;

/** The gym's receipt template, fetched once per page load (and dropped when the editor saves). */
export function receiptTemplate() {
  if (!templatePromise) {
    templatePromise = api.templates
      .get()
      .then((res) => ({ ...DEFAULT_RECEIPT_TEMPLATE, ...(res?.templates?.receipt || {}) }))
      .catch(() => {
        templatePromise = null;
        return { ...DEFAULT_RECEIPT_TEMPLATE };
      });
  }
  return templatePromise;
}

export function forgetReceiptTemplate() {
  templatePromise = null;
}

const METHOD_LABELS = { upi: 'UPI', cash: 'Cash', card: 'Card', bank: 'Bank transfer', bank_transfer: 'Bank transfer', neft: 'NEFT', imps: 'IMPS', rtgs: 'RTGS', cheque: 'Cheque', online: 'Online', wallet: 'Wallet' };
const methodLabel = (method) => {
  const key = String(method || 'cash').trim().toLowerCase();
  return METHOD_LABELS[key] || key.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
};

/** The receipt as DOM, in the template's style. Exported for the template editor's preview. */
export function receiptNode(data, { gymName = 'GymBook', logoUrl, template = DEFAULT_RECEIPT_TEMPLATE } = {}) {
  const t = { ...DEFAULT_RECEIPT_TEMPLATE, ...template };
  const style = ['modern', 'classic', 'minimal'].includes(t.style) ? t.style : 'modern';
  const memberName = data.first_name ? fullName(data) : data.member_name || 'Member';
  const receiptNo = data.receipt_no || (data.id ? `PAY-${String(data.id).padStart(5, '0')}` : '—');
  const paidOn = date(data.paid_on || today());
  const now = new Date();
  const timestamp = `${date(now)}, ${now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
  const finalLogoUrl = t.show_logo ? logoUrl ?? getGymLogoUrl() : null;

  const row = (label, value, cls = '') =>
    h('div', { class: `receipt-row ${cls}`.trim() }, h('span', { class: 'receipt-label' }, label), h('span', { class: 'receipt-value' }, value));
  const section = (title, ...rows) => h('div', { class: 'receipt-section' }, h('div', { class: 'receipt-section-title' }, title), ...rows.filter(Boolean));

  const amount = money(data.amount);
  return h(
    'div',
    { class: `receipt rc-${style}`, style: `--rc-accent:${t.accent}` },

    h('div', { class: 'receipt-header' },
      finalLogoUrl ? h('img', { class: 'receipt-logo-img', src: finalLogoUrl, alt: '' }) : null,
      h('div', { class: 'receipt-gym' }, gymName),
      t.address ? h('div', { class: 'receipt-sub' }, t.address) : null,
      t.contact ? h('div', { class: 'receipt-sub' }, t.contact) : null,
      h('div', { class: 'receipt-title' }, 'Payment Receipt'),
    ),

    style === 'classic'
      ? h('div', { class: 'receipt-meta-line' }, h('span', {}, `Receipt no. ${receiptNo}`), h('span', {}, `Date ${paidOn}`))
      : null,

    style === 'modern'
      ? h('div', { class: 'receipt-hero' },
          h('div', { class: 'receipt-hero-label' }, 'Amount paid', h('span', { class: 'receipt-paid' }, 'Paid')),
          h('div', { class: 'receipt-hero-amount' }, amount),
          h('div', { class: 'receipt-hero-meta' }, `${receiptNo} · ${paidOn} · ${methodLabel(data.method)}`),
        )
      : null,

    section('Member',
      row('Name', memberName, 'is-strong'),
      data.member_code ? row('Code', data.member_code) : null,
      data.phone ? row('Phone', data.phone) : null,
    ),
    section('Payment details',
      style === 'classic' ? null : row('Receipt no.', receiptNo),
      style === 'classic' ? null : row('Date', paidOn),
      row('Method', methodLabel(data.method)),
      data.reference ? row('Reference', data.reference) : null,
      data.note ? row('Note', data.note) : null,
    ),
    data.plan_name
      ? section('Membership',
          row('Plan', data.plan_name),
          data.start_date && data.end_date ? row('Period', `${date(data.start_date)} – ${date(data.end_date)}`) : null,
          data.price != null ? row('Plan price', money(data.price)) : null,
          data.discount ? row('Discount', `−${money(data.discount)}`, 'is-discount') : null,
        )
      : null,

    style === 'modern' ? null : h('div', { class: 'receipt-total' }, h('span', {}, style === 'minimal' ? 'Total paid' : 'Amount paid'), h('span', {}, amount)),

    t.terms ? h('div', { class: 'receipt-terms' }, style === 'minimal' ? null : h('div', { class: 'receipt-terms-title' }, 'Terms'), t.terms) : null,
    t.show_signature ? h('div', { class: 'receipt-sign' }, h('span', {}, t.signature_label || 'Authorised signatory')) : null,

    h('div', { class: 'receipt-footer' },
      t.footer_note ? h('div', { class: 'receipt-thanks' }, t.footer_note) : null,
      h('div', { class: 'receipt-timestamp' }, `Printed on ${timestamp}`),
    ),
  );
}

const loadImage = (src) =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load the gym logo'));
    img.crossOrigin = serverOrigin(src);
    img.src = serverUrl(src);
  });

const FONT_STACK = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
const RECEIPT_WIDTH = 340;
const MARGIN_X = 24;
const CONTENT_WIDTH = RECEIPT_WIDTH - MARGIN_X * 2;

/** Greedy word-wrap using real glyph metrics from the canvas — exact, unlike a fixed-width guess. */
function wrapText(ctx, text, maxWidth) {
  const words = String(text).split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const lines = [];
  let line = words[0];
  for (const word of words.slice(1)) {
    const candidate = `${line} ${word}`;
    if (ctx.measureText(candidate).width <= maxWidth) line = candidate;
    else {
      lines.push(line);
      line = word;
    }
  }
  lines.push(line);
  return lines;
}

/**
 * Lays out the receipt as a list of draw ops plus a total height, computed
 * against a scratch canvas context so text can be measured before the real,
 * exactly-sized canvas exists. Mirrors receiptNode's structure and field
 * ordering field-for-field.
 */
function layoutReceipt(ctx, data, { gymName, logoImg }) {
  const memberName = data.first_name ? fullName(data) : data.member_name || 'Member';
  const nowTs = new Date();
  const timestamp = `${date(nowTs)}, ${nowTs.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;

  const ops = [];
  let y = MARGIN_X;

  const font = (size, bold) => `${bold ? '700' : '400'} ${size}px ${FONT_STACK}`;

  const center = (text, size, bold, color) => {
    ctx.font = font(size, bold);
    ops.push({ type: 'text', x: RECEIPT_WIDTH / 2, y, text, size, bold, color, align: 'center' });
    y += size * 1.4;
  };

  const divider = (thick) => {
    y += thick ? 8 : 6;
    ops.push({ type: 'line', x1: MARGIN_X, y1: y, x2: RECEIPT_WIDTH - MARGIN_X, y2: y, thick });
    y += thick ? 8 : 6;
  };

  const sectionTitle = (text) => {
    ctx.font = font(10, true);
    ops.push({ type: 'text', x: MARGIN_X, y, text: text.toUpperCase(), size: 10, bold: true, color: '#6b7280', align: 'left' });
    y += 18;
  };

  const row = (label, value, { bold = false } = {}) => {
    const text = String(value);
    ctx.font = font(11, false);
    const labelWidth = ctx.measureText(label).width;
    ctx.font = font(11, bold);
    const valueWidth = ctx.measureText(text).width;

    if (labelWidth + 10 + valueWidth <= CONTENT_WIDTH) {
      ops.push({ type: 'text', x: MARGIN_X, y, text: label, size: 11, bold: false, color: '#4b5563', align: 'left' });
      ops.push({ type: 'text', x: RECEIPT_WIDTH - MARGIN_X, y, text, size: 11, bold, color: '#111827', align: 'right' });
      y += 19;
    } else {
      ops.push({ type: 'text', x: MARGIN_X, y, text: label, size: 11, bold: false, color: '#4b5563', align: 'left' });
      y += 16;
      for (const line of wrapText(ctx, text, CONTENT_WIDTH)) {
        ops.push({ type: 'text', x: MARGIN_X, y, text: line, size: 11, bold, color: '#111827', align: 'left' });
        y += 16;
      }
      y += 3;
    }
  };

  // ── header ──────────────────────────────────────────────────────────
  if (logoImg) {
    ctx.font = font(16, true);
    const nameWidth = ctx.measureText(gymName).width;
    const logoSize = 28;
    const groupWidth = logoSize + 8 + nameWidth;
    const startX = (RECEIPT_WIDTH - groupWidth) / 2;
    ops.push({ type: 'image', img: logoImg, x: startX, y, w: logoSize, h: logoSize, radius: 6 });
    ops.push({ type: 'text', x: startX + logoSize + 8, y: y + logoSize / 2 + 6, text: gymName, size: 16, bold: true, color: '#111827', align: 'left' });
    y += logoSize + 6;
  } else {
    center(gymName, 18, true, '#111827');
  }
  center('PAYMENT RECEIPT', 11, false, '#6b7280');
  y += 2;
  divider(false);

  // ── member ──────────────────────────────────────────────────────────
  sectionTitle('Member');
  row('Name', memberName);
  if (data.member_code) row('Code', data.member_code);
  if (data.phone) row('Phone', data.phone);
  divider(false);

  // ── payment details ────────────────────────────────────────────────
  sectionTitle('Payment Details');
  row('Receipt #', data.id ? `PAY-${String(data.id).padStart(5, '0')}` : '—');
  row('Date', date(data.paid_on || today()));
  row('Method', String(data.method || 'cash').toUpperCase());
  if (data.reference) row('Reference', data.reference);
  if (data.note) row('Note', data.note);

  // ── membership (if linked to a subscription) ──────────────────────
  if (data.plan_name) {
    divider(false);
    sectionTitle('Membership');
    row('Plan', data.plan_name);
    if (data.start_date && data.end_date) row('Period', `${date(data.start_date)} → ${date(data.end_date)}`);
    if (data.price != null) row('Plan price', money(data.price));
    if (data.discount) row('Discount', `− ${money(data.discount)}`);
  }

  divider(true);

  // ── total ───────────────────────────────────────────────────────────
  ctx.font = font(16, true);
  ops.push({ type: 'text', x: MARGIN_X, y: y + 12, text: 'Amount Paid', size: 16, bold: true, color: '#111827', align: 'left' });
  ops.push({ type: 'text', x: RECEIPT_WIDTH - MARGIN_X, y: y + 12, text: money(data.amount), size: 16, bold: true, color: '#111827', align: 'right' });
  y += 24;
  divider(false);

  // ── footer ──────────────────────────────────────────────────────────
  center('Thank you for your payment!', 12, false, '#6b7280');
  center(`Printed on ${timestamp}`, 10, false, '#9ca3af');

  return { ops, width: RECEIPT_WIDTH, height: y + MARGIN_X };
}

function paintReceipt(ctx, ops) {
  for (const op of ops) {
    if (op.type === 'text') {
      ctx.font = `${op.bold ? '700' : '400'} ${op.size}px ${FONT_STACK}`;
      ctx.fillStyle = op.color;
      ctx.textAlign = op.align;
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(op.text, op.x, op.y);
    } else if (op.type === 'line') {
      ctx.strokeStyle = op.thick ? '#111827' : '#d1d5db';
      ctx.lineWidth = op.thick ? 2 : 1;
      ctx.setLineDash(op.thick ? [] : [3, 3]);
      ctx.beginPath();
      ctx.moveTo(op.x1, op.y1);
      ctx.lineTo(op.x2, op.y2);
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (op.type === 'image') {
      ctx.save();
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(op.x, op.y, op.w, op.h, op.radius);
      else ctx.rect(op.x, op.y, op.w, op.h);
      ctx.clip();
      ctx.drawImage(op.img, op.x, op.y, op.w, op.h);
      ctx.restore();
    }
  }
}

export async function renderReceiptPdfBytes(data, { gymName = 'GymBook', logoUrl } = {}) {
  const finalLogoUrl = logoUrl ?? getGymLogoUrl();
  const logoImg = finalLogoUrl ? await loadImage(finalLogoUrl).catch(() => null) : null;

  const measureCtx = document.createElement('canvas').getContext('2d');
  const layout = layoutReceipt(measureCtx, data, { gymName, logoImg });

  const SCALE = 3;
  const canvas = document.createElement('canvas');
  canvas.width = layout.width * SCALE;
  canvas.height = layout.height * SCALE;
  const ctx = canvas.getContext('2d');
  ctx.scale(SCALE, SCALE);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, layout.width, layout.height);
  paintReceipt(ctx, layout.ops);

  const jpegBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
  const jpegBytes = new Uint8Array(await jpegBlob.arrayBuffer());
  return imageBytesToPdf(jpegBytes, canvas.width, canvas.height, { dpi: 72 * SCALE });
}

/**
 * Downloads a payment receipt as a PDF. A saved payment comes from the server
 * (GET /payments/:id/receipt.pdf), drawn in the gym's receipt template — the
 * same file WhatsApp and the member portal send. Only a payment with no id
 * yet falls back to the in-browser canvas rendering below.
 *
 * @param {object} data - Payment data (see receiptNode for shape)
 * @param {object} opts
 * @param {string} opts.gymName - The gym's display name
 */
export async function downloadReceipt(data, { gymName = 'GymBook', logoUrl } = {}) {
  const receiptNo = data.id ? `PAY-${String(data.id).padStart(5, '0')}` : 'receipt';
  if (data.id) {
    const saved = await api.downloadPaymentReceipt(data.id, `${receiptNo}${data.member_code ? `-${data.member_code}` : ''}.pdf`);
    if (saved) toast(saved);
    return;
  }

  const pdfBytes = await renderReceiptPdfBytes(data, { gymName, logoUrl });
  const url = URL.createObjectURL(new Blob([pdfBytes], { type: 'application/pdf' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${receiptNo}${data.member_code ? `-${data.member_code}` : ''}.pdf`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Prints a payment receipt using the same #print-root mechanism as QR cards.
 *
 * @param {object} data - Payment data (see receiptNode for shape)
 * @param {object} opts
 * @param {string} opts.gymName - The gym's display name
 */
export async function printReceipt(data, { gymName } = {}) {
  const root = document.getElementById('print-root');
  if (!root) return;

  const template = await receiptTemplate();
  clear(root).append(h('div', { class: 'receipt-page' }, receiptNode(data, { gymName, template })));
  document.body.classList.add('printing');

  const cleanup = () => {
    document.body.classList.remove('printing');
    clear(root);
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);

  requestAnimationFrame(() => {
    window.print();
    setTimeout(cleanup, 1000);
  });
}

/**
 * Returns the gym name from the platform context cached in the DOM's title bar
 * brand element — avoids an extra API call and import cycle.
 */
export function getGymName() {
  const brand = document.querySelector('.brand');
  return brand?.textContent?.trim() || 'GymBook';
}

export function getGymLogoUrl() {
  const brandImg = document.querySelector('.brand .logo img');
  return brandImg?.getAttribute('src') || null;
}
