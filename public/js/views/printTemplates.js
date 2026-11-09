import { api, saveFile, session } from '../api.js';
import { closeModal, confirmDialog, h, openModal, renderIcon, toast } from '../ui.js';
import { DEFAULT_RECEIPT_TEMPLATE, forgetReceiptTemplate, getGymLogoUrl, getGymName, receiptNode } from '../receipt.js';
import { DEFAULT_CARD_TEMPLATE, idCardNode } from '../qrcard.js';
import { isCoaching, isLibrary, t } from '../vertical.js';

/**
 * Settings › Print templates: the owner's designs for receipts, ID cards and
 * (CoachBook) OMR answer sheets. Each editor shows the change as it is made —
 * receipts and cards are drawn right here from the same code that prints
 * them; "Preview PDF" asks the server for the exact file with the unsaved
 * values. Stored by src/printTemplates.js; only an admin can save.
 */

const RECEIPT_STYLES = [
  { value: 'modern', label: 'Modern', hint: 'Accent stripe and the amount in a green card at the top.' },
  { value: 'classic', label: 'Classic', hint: 'Framed, formal invoice with ruled rows and the amount in words.' },
  { value: 'minimal', label: 'Minimal', hint: 'Narrow, black and white — for thermal and ink-saving printers.' },
];

const CARD_STYLES = [
  { value: 'classic', label: 'Classic', hint: 'White card with an accent rule under your name.' },
  { value: 'band', label: 'Header band', hint: 'Accent band across the top and a larger photo.' },
  { value: 'vertical', label: 'Vertical', hint: 'Portrait card with a round photo — made for lanyards.' },
];

const OMR_STYLES = [
  { value: 'coachbook', label: 'Standard', hint: 'CoachBook’s own sheet: 4 columns of 25, 4-digit roll number.' },
  { value: 'board', label: 'Board pattern (BSEB 10th / 12th)', hint: 'Bilingual Hindi–English, candidate boxes, signatures, 5 framed columns, 6-digit roll number.' },
  { value: 'competitive', label: 'Competitive (JEE / NEET)', hint: 'Options numbered 1–4 like NTA sheets, booklet and centre code boxes.' },
];

/* ── Controls ─────────────────────────────────────────────────────────── */

function styleChooser(name, choices, state, onChange) {
  return h(
    'div',
    { class: 'tpl-styles', role: 'radiogroup' },
    choices.map((choice) => {
      const input = h('input', { type: 'radio', name: `tpl-${name}`, value: choice.value, checked: state[name] === choice.value });
      input.addEventListener('change', () => onChange(name, choice.value));
      return h('label', { class: 'tpl-style' }, input, h('span', { class: 'tpl-style-text' }, h('strong', {}, choice.label), h('small', {}, choice.hint)));
    }),
  );
}

function control(spec, state, onChange) {
  const { name, label, type, hint, placeholder, choices, max } = spec;
  if (type === 'styles') {
    return h('div', { class: 'field full' }, h('span', {}, label), styleChooser(name, choices, state, onChange));
  }
  if (type === 'bool') {
    const input = h('input', { type: 'checkbox', checked: Boolean(state[name]) });
    input.addEventListener('change', () => onChange(name, input.checked));
    return h('label', { class: 'tpl-check full' }, input, h('span', {}, label, hint ? h('small', { class: 'muted' }, hint) : null));
  }
  if (type === 'color') {
    const swatch = h('input', { type: 'color', value: state[name] });
    const text = h('input', { type: 'text', value: state[name], maxlength: 7, spellcheck: 'false', class: 'tpl-hex' });
    swatch.addEventListener('input', () => {
      text.value = swatch.value;
      onChange(name, swatch.value);
    });
    text.addEventListener('input', () => {
      if (/^#[0-9a-f]{6}$/i.test(text.value)) {
        swatch.value = text.value;
        onChange(name, text.value.toLowerCase());
      }
    });
    return h('label', { class: 'field' }, h('span', {}, label), h('span', { class: 'tpl-color' }, swatch, text));
  }
  const multiline = type === 'textarea' || type === 'list';
  const value = type === 'list' ? (state[name] || []).join('\n') : state[name] ?? '';
  const input = multiline
    ? h('textarea', { rows: type === 'list' ? 3 : 3, placeholder: placeholder || '', maxlength: max || undefined }, value)
    : h('input', { type: 'text', value, placeholder: placeholder || '', maxlength: max || undefined });
  input.addEventListener('input', () => {
    onChange(name, type === 'list' ? input.value.split('\n').map((s) => s.trim()).filter(Boolean) : input.value);
  });
  return h('label', { class: `field${multiline ? ' full' : ''}` }, h('span', {}, label), input, hint ? h('small', { class: 'muted' }, hint) : null);
}

/* ── The editor ───────────────────────────────────────────────────────── */

async function openPdf(blob, fileName) {
  // A new tab shows the PDF where the browser can; the app's WebView (and a
  // blocked pop-up) gets the file saved instead.
  const url = URL.createObjectURL(blob);
  const win = window.Capacitor?.isNativePlatform?.() ? null : window.open(url, '_blank');
  if (!win) {
    const saved = await saveFile(blob, fileName);
    if (saved) toast(saved);
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function openEditor({ kind, title, subtitle, icon, fields, initial, preview, pdf, onSaved }) {
  const isAdmin = session.can('admin');
  const state = { ...initial };
  const previewBox = h('div', { class: `tpl-preview tpl-preview-${kind}` });

  const render = () => {
    if (preview) previewBox.replaceChildren(preview(state));
  };
  let timer = null;
  const onChange = (name, value) => {
    state[name] = value;
    clearTimeout(timer);
    timer = setTimeout(render, 60);
  };

  const pdfButton = pdf
    ? h('button', { class: 'btn', type: 'button' }, renderIcon('download', { size: 16 }), pdf.label)
    : null;
  pdfButton?.addEventListener('click', async () => {
    pdfButton.disabled = true;
    try {
      await openPdf(await api.templates.preview(kind, state), pdf.fileName);
    } catch (err) {
      toast(err.message || 'Could not build the preview', 'error');
    } finally {
      pdfButton.disabled = false;
    }
  });

  const saved = (template) => {
    onSaved?.(template);
    window.dispatchEvent(new CustomEvent('gymbook:templates-saved', { detail: { kind, template } }));
  };

  const save = h('button', { class: 'btn primary', type: 'button', disabled: !isAdmin }, renderIcon('save', { size: 16 }), 'Save template');
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      const { template } = await api.templates.save(kind, state);
      saved(template);
      closeModal();
      toast(`${title} saved — it applies to everything printed from now on`);
    } catch (err) {
      toast(err.message || 'Could not save the template', 'error');
      save.disabled = false;
    }
  });

  const reset = h('button', { class: 'btn ghost', type: 'button', disabled: !isAdmin }, renderIcon('refresh', { size: 16 }), 'Reset to default');
  reset.addEventListener('click', () => {
    confirmDialog({
      title: 'Reset this template?',
      message: 'Every setting goes back to how it was shipped. Anything already printed is not affected.',
      confirmLabel: 'Reset',
      onConfirm: async () => {
        const { template } = await api.templates.reset(kind);
        saved(template);
        closeModal();
        toast(`${title} reset to default`);
      },
    });
  });

  openModal({
    title,
    subtitle,
    icon,
    wide: true,
    className: 'tpl-modal',
    body: h(
      'div',
      { class: 'tpl-editor' },
      h(
        'div',
        { class: 'tpl-form form-grid' },
        isAdmin ? null : h('p', { class: 'muted full', style: 'margin:0' }, 'Only an admin can change templates.'),
        ...fields.map((spec) => control(spec, state, onChange)),
      ),
      h('div', { class: 'tpl-preview-col' }, h('div', { class: 'tpl-preview-label' }, preview ? 'Live preview' : 'Preview'), previewBox, pdfButton),
    ),
    footer: h('div', { class: 'row tpl-foot' }, reset, h('div', { class: 'spacer' }), h('button', { class: 'btn ghost', type: 'button', onclick: closeModal }, 'Cancel'), save),
  });
  if (!preview) {
    previewBox.replaceChildren(
      h('div', { class: 'tpl-pdf-note' }, renderIcon('scan', { size: 34 }), h('p', {}, pdf?.note || 'Use the button below to see the exact printed file.')),
    );
  }
  render();
}

/* ── Samples ──────────────────────────────────────────────────────────── */

/** A QR-looking SVG for the card preview — finder squares and a seeded speckle, not a real code. */
function sampleQrSvg() {
  const n = 25;
  let seed = 7;
  const rand = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  const cells = [];
  const finder = (x, y) => x < 7 && y < 7;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const inFinder = finder(x, y) || finder(n - 1 - x, y) || finder(x, n - 1 - y);
      if (inFinder) {
        const fx = x < 7 ? x : n - 1 - x;
        const fy = y < 7 ? y : n - 1 - y;
        const ring = Math.max(Math.abs(fx - 3), Math.abs(fy - 3));
        if (ring !== 2) cells.push(`M${x} ${y}h1v1h-1z`);
      } else if (rand() > 0.55) cells.push(`M${x} ${y}h1v1h-1z`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 -1 ${n + 2} ${n + 2}" shape-rendering="crispEdges"><rect x="-1" y="-1" width="${n + 2}" height="${n + 2}" fill="#fff"/><path d="${cells.join('')}" fill="#111827"/></svg>`;
}

function sampleMember() {
  const end = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
  return {
    first_name: isCoaching() ? 'Aarav' : 'Rahul',
    last_name: isCoaching() ? 'Kumar' : 'Sharma',
    code: isCoaching() ? 'CB0042' : 'M0042',
    phone: '98765 43210',
    membership_end: isCoaching() ? null : end,
    photo_url: null,
  };
}

/* ── The three editors ────────────────────────────────────────────────── */

export function openReceiptTemplate(initial) {
  const today = new Date().toISOString().slice(0, 10);
  const sample = {
    id: 42,
    amount: isCoaching() ? 15000 : 4500,
    method: 'upi',
    paid_on: today,
    reference: 'UPI 412398765432',
    ...sampleMember(),
    member_code: isCoaching() ? 'CB0042' : 'M0042',
    phone: '9876543210',
    plan_name: isCoaching() ? 'Class 12 Science (Board + JEE)' : 'Quarterly Membership',
    start_date: today,
    end_date: new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10),
    price: isCoaching() ? 45000 : 5000,
    discount: isCoaching() ? 5000 : 500,
  };
  openEditor({
    kind: 'receipt',
    title: 'Receipt template',
    subtitle: 'Printed receipts, downloads, WhatsApp and portal PDFs all use this.',
    icon: 'fileText',
    initial: { ...DEFAULT_RECEIPT_TEMPLATE, ...initial },
    fields: [
      { name: 'style', label: 'Style', type: 'styles', choices: RECEIPT_STYLES },
      { name: 'accent', label: 'Accent colour', type: 'color' },
      { name: 'show_logo', label: 'Show the logo', type: 'bool' },
      { name: 'address', label: 'Address', type: 'textarea', max: 160, placeholder: 'e.g. Boring Road, Patna 800001' },
      { name: 'contact', label: 'Phone / email line', type: 'text', max: 100, placeholder: 'e.g. +91 98765 43210 · hello@example.com' },
      { name: 'footer_note', label: 'Thank-you line', type: 'text', max: 120 },
      { name: 'terms', label: 'Terms (small print)', type: 'textarea', max: 300, placeholder: 'e.g. Fees once paid are not refundable.' },
      { name: 'show_signature', label: 'Add a signature line', type: 'bool', hint: 'For a stamp and signature on printed copies.' },
      { name: 'signature_label', label: 'Signature caption', type: 'text', max: 40 },
    ],
    preview: (state) => receiptNode(sample, { gymName: getGymName(), logoUrl: getGymLogoUrl(), template: state }),
    pdf: { label: 'Preview PDF', fileName: 'Receipt_preview.pdf' },
    onSaved: () => forgetReceiptTemplate(),
  });
}

export function openCardTemplate(initial) {
  const card = { member: sampleMember(), gym_name: getGymName(), logo_url: getGymLogoUrl(), svg: sampleQrSvg() };
  openEditor({
    kind: 'id_card',
    title: 'ID card template',
    subtitle: `The ${t('member').toLowerCase()} QR card — on screen, printed and as an image.`,
    icon: 'idCard',
    initial: { ...DEFAULT_CARD_TEMPLATE, ...initial },
    fields: [
      { name: 'style', label: 'Style', type: 'styles', choices: CARD_STYLES },
      { name: 'accent', label: 'Accent colour', type: 'color' },
      { name: 'title', label: 'Card title', type: 'text', max: 40, placeholder: isCoaching() ? 'Student ID card' : isLibrary() ? 'Library card' : 'Member card' },
      { name: 'qr_hint', label: 'Line under the QR', type: 'text', max: 40 },
      { name: 'footer_note', label: 'Footer line', type: 'text', max: 90, placeholder: 'e.g. If found, please return to the front desk' },
      { name: 'show_photo', label: 'Show the photo', type: 'bool', hint: 'Initials are shown when there is no photo yet.' },
      { name: 'show_validity', label: 'Show “Valid until”', type: 'bool' },
      { name: 'show_phone', label: 'Show the phone number', type: 'bool' },
    ],
    preview: (state) => idCardNode({ ...card, template: state }),
  });
}

export function openOmrTemplate(initial) {
  openEditor({
    kind: 'omr',
    title: 'OMR sheet template',
    subtitle: 'The style new tests start with, and the wording printed on every sheet.',
    icon: 'scan',
    initial,
    fields: [
      { name: 'default_style', label: 'Default sheet style', type: 'styles', choices: OMR_STYLES },
      { name: 'heading', label: 'Heading', type: 'text', max: 60, placeholder: 'Your institute name' },
      { name: 'subheading', label: 'Sub-heading', type: 'text', max: 80, placeholder: 'e.g. Annual Board Practice Examination 2026' },
      { name: 'hindi', label: 'Hindi + English text on Board-pattern sheets', type: 'bool' },
      { name: 'extra_fields', label: 'Extra boxes to write in', type: 'list', hint: 'One per line, up to 4 — e.g. Father’s name, Centre code.' },
      { name: 'instructions', label: 'Instructions', type: 'textarea', max: 600, hint: 'One per line. Leave empty for the standard instructions.' },
    ],
    pdf: {
      label: 'Preview sheet PDF',
      fileName: 'OMR_preview.pdf',
      note: 'An OMR sheet is a full A4 page. Preview it as a PDF with these settings — each test can still pick its own style when you set up its sheet.',
    },
  });
}

/**
 * The Print templates page (sidebar › Print templates): one tile per
 * template, its current style, and a button into its editor.
 */
export async function renderPrintTemplates() {
  const { templates } = await api.templates.get();
  const grid = h('div', { class: 'tpl-page' });
  const tiles = (current) => {
    const items = [
      { icon: 'fileText', tone: 'green', title: 'Receipts', text: 'Printed receipts, downloads and the PDFs sent on WhatsApp and the portal. Style, colour, address, terms and a signature line.', open: () => openReceiptTemplate(current.receipt), style: RECEIPT_STYLES.find((s) => s.value === current.receipt?.style)?.label },
      { icon: 'idCard', tone: 'blue', title: 'ID cards', text: `The ${t('member').toLowerCase()} QR card on screen, printed and as an image. Classic, header band or vertical, and what the card shows.`, open: () => openCardTemplate(current.id_card), style: CARD_STYLES.find((s) => s.value === current.id_card?.style)?.label },
      current.omr
        ? { icon: 'scan', tone: 'violet', title: 'OMR sheets', text: 'Answer sheets for tests: Standard, Board pattern (BSEB 10th / 12th) or Competitive (JEE / NEET), with your own heading and instructions.', open: () => openOmrTemplate(current.omr), style: OMR_STYLES.find((s) => s.value === current.omr?.default_style)?.label }
        : null,
    ].filter(Boolean);
    return items.map((item) =>
      h(
        'div',
        { class: 'card tpl-tile' },
        h('span', { class: `stg-head-icon tone-${item.tone}` }, renderIcon(item.icon, { size: 24, stroke: 2 })),
        h('h3', {}, item.title),
        item.style ? h('span', { class: 'tpl-current' }, item.style) : null,
        h('p', { class: 'muted' }, item.text),
        h('button', { class: 'btn primary', type: 'button', onclick: item.open }, renderIcon('edit', { size: 16 }), 'Customize'),
      ),
    );
  };
  grid.replaceChildren(...tiles(templates));
  // A save updates the tiles; the listener goes once this page is gone.
  const onSaved = async () => {
    if (!grid.isConnected) {
      window.removeEventListener('gymbook:templates-saved', onSaved);
      return;
    }
    try {
      grid.replaceChildren(...tiles((await api.templates.get()).templates));
    } catch {
      /* keep what is shown */
    }
  };
  window.addEventListener('gymbook:templates-saved', onSaved);
  return grid;
}
