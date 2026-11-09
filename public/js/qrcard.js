import { serverOrigin, serverUrl } from './api.js';
import { clear, date, fullName, h } from './ui.js';
import { gymPosterNode, gymPosterPngBlob } from './gymPoster.js';
import { getGymLogoUrl } from './receipt.js';
import { isCoaching, isEducation, isLibrary, t } from './vertical.js';

/**
 * Member QR ID cards: on-screen preview, printing, and a downloadable image
 * staff can send over WhatsApp or email.
 *
 * Card geometry follows CR80 (the standard plastic card, 3.375in × 2.125in) so
 * a printed sheet lines up with off-the-shelf card stock and laminate pouches.
 */

const CARD_W_IN = 3.375;
const CARD_H_IN = 2.125;

/** What a card looks like when the server sent no template (an older server, or a sample). */
export const DEFAULT_CARD_TEMPLATE = {
  style: 'classic',
  accent: '#111827',
  show_photo: true,
  show_validity: true,
  show_phone: false,
  title: '',
  qr_hint: 'Scan at reception',
  footer_note: '',
};

/** White or near-black, whichever reads better on `hex`. */
function onAccent(hex) {
  const n = parseInt(String(hex || '#111827').slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.45 ? '#111827' : '#ffffff';
}

const initialsOf = (member) =>
  `${member.first_name?.[0] || ''}${member.last_name?.[0] || ''}`.toUpperCase() || (member.code || '?').slice(0, 2);

/**
 * The words on a card, decided once for the DOM and the canvas alike: which
 * lines show, in what order, per the template.
 */
function cardContent(card) {
  const template = { ...DEFAULT_CARD_TEMPLATE, ...(card.template || {}) };
  const member = card.member;
  const title = template.title || (isCoaching() ? 'Student ID card' : isLibrary() ? 'Library card' : 'Member card');
  const meta = [];
  if (template.show_validity) {
    if (member.membership_end) meta.push(`Valid until ${date(member.membership_end)}`);
    else if (!isCoaching()) meta.push('No active membership');
  }
  if (template.show_phone && member.phone) meta.push(member.phone);
  return {
    template,
    title,
    name: fullName(member),
    code: member.code,
    meta,
    photoUrl: template.show_photo ? member.photo_url || null : null,
    showPhoto: template.show_photo,
    initials: initialsOf(member),
    logoUrl: card.logo_url || getGymLogoUrl(),
    accent: template.accent,
    ink: onAccent(template.accent),
  };
}

/** One card, as DOM. Used unchanged for the on-screen preview and the print
 * sheet — what staff see is what comes out of the printer. The owner's
 * template (Settings › Print templates) picks the style and what shows. */
export function idCardNode(card) {
  const c = cardContent(card);
  const { template } = c;

  const photo = c.showPhoto
    ? c.photoUrl
      ? h('img', { class: 'idc-photo', src: c.photoUrl, alt: '' })
      : h('div', { class: 'idc-photo idc-initials' }, c.initials)
    : null;

  return h(
    'div',
    {
      class: `id-card idc-${template.style}${c.showPhoto ? '' : ' idc-nophoto'}`,
      style: `--idc-accent:${c.accent};--idc-on-accent:${c.ink}`,
    },
    h(
      'div',
      { class: 'idc-head' },
      c.logoUrl ? h('img', { class: 'idc-logo', src: c.logoUrl, alt: '' }) : null,
      h('div', { class: 'idc-org' }, card.gym_name),
      h('div', { class: 'idc-title' }, c.title),
    ),
    h(
      'div',
      { class: 'idc-body' },
      h(
        'div',
        { class: 'idc-info' },
        photo,
        h(
          'div',
          { class: 'idc-text' },
          h('div', { class: 'idc-name' }, c.name),
          h('div', { class: 'idc-code' }, c.code),
          ...c.meta.map((line) => h('div', { class: 'idc-meta' }, line)),
        ),
      ),
      h(
        'div',
        { class: 'idc-qr' },
        // Server-rendered SVG: stays sharp at any print resolution.
        h('div', { class: 'idc-qr-img', html: card.svg }),
        template.qr_hint ? h('div', { class: 'idc-hint' }, template.qr_hint) : null,
      ),
    ),
    template.footer_note ? h('div', { class: 'idc-foot' }, template.footer_note) : null,
  );
}

/**
 * Prints one or more cards.
 *
 * Renders into #print-root and flips a body class that the print stylesheet
 * uses to hide the app shell. Done in-document rather than via a popup window
 * because a blocked popup would silently produce nothing.
 */
export function printCards(cards) {
  const root = document.getElementById('print-root');
  if (!root) return;

  clear(root).append(...cards.map((card) => h('div', { class: 'id-card-slot' }, idCardNode(card))));
  document.body.classList.add('printing');

  const cleanup = () => {
    document.body.classList.remove('printing');
    clear(root);
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);

  // Give the browser a frame to lay the cards out (and decode any photos)
  // before the print dialog snapshots the page.
  requestAnimationFrame(() => {
    window.print();
    // Safari never fires afterprint; clear on a timer as a backstop so the
    // hidden print sheet doesn't linger in the DOM.
    setTimeout(cleanup, 1000);
  });
}

const loadImage = (src) =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load the QR image'));
    img.crossOrigin = serverOrigin(src);
    img.src = serverUrl(src);
  });

/**
 * Draws the card to a canvas and returns PNG bytes — the same template,
 * geometry (in inches, at 300 dpi) and wording as idCardNode, so the image
 * sent over WhatsApp matches the printed card.
 *
 * The photo is included: photo_url is always served by this app on this origin
 * (see src/photo.js), so drawing it leaves the canvas untainted and toDataURL
 * still works. A photo or logo that fails to load is skipped rather than
 * losing the whole download.
 */
export async function renderCardPngBytes(card) {
  const c = cardContent(card);
  const { template } = c;
  const vertical = template.style === 'vertical';
  const DPI = 300;
  const W = Math.round((vertical ? CARD_H_IN : CARD_W_IN) * DPI);
  const H = Math.round((vertical ? CARD_W_IN : CARD_H_IN) * DPI);
  const inch = (v) => Math.round(v * DPI);
  const FONT = `'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`;
  const MONO = `ui-monospace, 'SF Mono', Menlo, monospace`;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  const [logoImg, photoImg, qrImg] = await Promise.all([
    c.logoUrl ? loadImage(c.logoUrl).catch(() => null) : null,
    c.photoUrl ? loadImage(c.photoUrl).catch(() => null) : null,
    loadImage(card.png),
  ]);

  const roundRect = (x, y, w, hh, r) => {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, hh, r);
    else ctx.rect(x, y, w, hh);
  };
  const text = (str, x, y, { size, weight = 400, color = '#111827', align = 'left', font = FONT, maxWidth, spacing = 0, upper = false } = {}) => {
    ctx.font = `${weight} ${inch(size)}px ${font}`;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = 'alphabetic';
    if ('letterSpacing' in ctx) ctx.letterSpacing = `${inch(spacing)}px`;
    let s = upper ? String(str).toUpperCase() : String(str);
    if (maxWidth) {
      // Ellipsis instead of the canvas squashing the glyphs.
      while (s.length > 1 && ctx.measureText(s).width > maxWidth) s = s.slice(0, -2) + '…';
    }
    ctx.fillText(s, x, y);
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
  };
  const drawPhoto = (x, y, w, hh, { circle = false, ring = null } = {}) => {
    if (!c.showPhoto) return;
    ctx.save();
    if (circle) {
      ctx.beginPath();
      ctx.arc(x + w / 2, y + hh / 2, w / 2, 0, Math.PI * 2);
    } else roundRect(x, y, w, hh, inch(0.06));
    ctx.clip();
    if (photoImg) {
      // Cover-fit: fill the frame, crop the overflow.
      const s = Math.max(w / photoImg.width, hh / photoImg.height);
      const dw = photoImg.width * s;
      const dh = photoImg.height * s;
      ctx.drawImage(photoImg, x + (w - dw) / 2, y + (hh - dh) / 2, dw, dh);
    } else {
      ctx.fillStyle = tintOf(c.accent, 0.86);
      ctx.fillRect(x, y, w, hh);
      text(c.initials, x + w / 2, y + hh / 2 + inch(0.08), { size: 0.22, weight: 800, color: c.accent, align: 'center' });
    }
    ctx.restore();
    if (ring) {
      ctx.lineWidth = inch(0.03);
      ctx.strokeStyle = ring;
      ctx.beginPath();
      ctx.arc(x + w / 2, y + hh / 2, w / 2, 0, Math.PI * 2);
      ctx.stroke();
    } else if (!circle) {
      ctx.lineWidth = inch(0.005);
      ctx.strokeStyle = '#d1d5db';
      roundRect(x, y, w, hh, inch(0.06));
      ctx.stroke();
    }
  };
  const drawLogo = (x, y, size) => {
    if (!logoImg) return 0;
    ctx.save();
    roundRect(x, y, size, size, Math.round(size * 0.18));
    ctx.clip();
    ctx.drawImage(logoImg, x, y, size, size);
    ctx.restore();
    return size;
  };

  // Card
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  const pad = inch(0.16);
  const footH = template.footer_note ? inch(0.17) : 0;

  if (vertical) {
    const headH = inch(c.showPhoto ? 0.95 : 0.7);
    ctx.fillStyle = c.accent;
    ctx.fillRect(0, 0, W, headH);
    let y = inch(0.14);
    const logoSize = inch(0.26);
    if (drawLogo((W - logoSize) / 2, y, logoSize)) y += logoSize + inch(0.04);
    text(card.gym_name, W / 2, y + inch(0.12), { size: 0.12, weight: 800, color: c.ink, align: 'center', maxWidth: W - pad * 2, upper: true, spacing: 0.005 });
    text(c.title, W / 2, y + inch(0.22), { size: 0.07, weight: 600, color: c.ink, align: 'center', maxWidth: W - pad * 2, upper: true, spacing: 0.006 });
    let by = headH;
    if (c.showPhoto) {
      const size = inch(0.78);
      drawPhoto((W - size) / 2, headH - inch(0.3), size, size, { circle: true, ring: '#ffffff' });
      by = headH - inch(0.3) + size;
    }
    by += inch(0.16);
    text(c.name, W / 2, by, { size: 0.13, weight: 700, align: 'center', maxWidth: W - pad * 2 });
    by += inch(0.13);
    text(c.code, W / 2, by, { size: 0.095, weight: 500, color: '#4b5563', align: 'center', font: MONO, maxWidth: W - pad * 2 });
    for (const line of c.meta) {
      by += inch(0.12);
      text(line, W / 2, by, { size: 0.085, color: '#6b7280', align: 'center', maxWidth: W - pad * 2 });
    }
    const qrSize = inch(0.95);
    const hintH = template.qr_hint ? inch(0.12) : 0;
    const qrY = H - footH - inch(0.1) - hintH - qrSize;
    ctx.drawImage(qrImg, (W - qrSize) / 2, qrY, qrSize, qrSize);
    if (template.qr_hint) text(template.qr_hint, W / 2, qrY + qrSize + inch(0.09), { size: 0.07, color: '#6b7280', align: 'center' });
  } else {
    const band = template.style === 'band';
    const headH = inch(band ? 0.42 : 0.4);
    if (band) {
      ctx.fillStyle = c.accent;
      ctx.fillRect(0, 0, W, headH);
    } else {
      ctx.fillStyle = c.accent;
      ctx.fillRect(pad, headH - inch(0.02), W - pad * 2, inch(0.02));
    }
    const logoSize = inch(0.24);
    let x = pad;
    if (drawLogo(x, (headH - logoSize) / 2, logoSize)) x += logoSize + inch(0.06);
    ctx.font = `600 ${inch(0.07)}px ${FONT}`;
    const titleW = ctx.measureText(c.title.toUpperCase()).width + inch(0.06);
    text(card.gym_name, x, headH / 2 + inch(0.045), { size: 0.13, weight: 800, color: band ? c.ink : c.accent, maxWidth: W - pad - x - titleW - inch(0.06), upper: true, spacing: 0.005 });
    text(c.title, W - pad, headH / 2 + inch(0.03), { size: 0.07, weight: 600, color: band ? c.ink : '#6b7280', align: 'right', upper: true, spacing: 0.006 });

    const qrSize = inch(band ? 1.0 : 1.05);
    const hintH = template.qr_hint ? inch(0.11) : 0;
    const bodyTop = headH + inch(0.08);
    const bodyH = H - footH - bodyTop - inch(0.08);
    const qrX = W - pad - qrSize;
    const qrY = bodyTop + (bodyH - qrSize - hintH) / 2;
    ctx.drawImage(qrImg, qrX, qrY, qrSize, qrSize);
    if (template.qr_hint) text(template.qr_hint, qrX + qrSize / 2, qrY + qrSize + inch(0.085), { size: 0.07, color: '#6b7280', align: 'center' });

    const textMax = qrX - inch(0.1);
    if (band) {
      // Photo left, text beside it.
      const pw = inch(0.72);
      const ph = inch(0.86);
      let tx = pad;
      if (c.showPhoto) {
        drawPhoto(pad, bodyTop + (bodyH - ph) / 2, pw, ph);
        tx = pad + pw + inch(0.1);
      }
      const lines = 2 + c.meta.length;
      let ty = bodyTop + bodyH / 2 - (lines * inch(0.13)) / 2 + inch(0.1);
      text(c.name, tx, ty, { size: 0.13, weight: 700, maxWidth: textMax - tx });
      ty += inch(0.14);
      text(c.code, tx, ty, { size: 0.095, weight: 500, color: '#4b5563', font: MONO, maxWidth: textMax - tx });
      for (const line of c.meta) {
        ty += inch(0.12);
        text(line, tx, ty, { size: 0.085, color: '#6b7280', maxWidth: textMax - tx });
      }
    } else {
      let ty = bodyTop + inch(0.02);
      if (c.showPhoto) {
        const size = inch(0.6);
        drawPhoto(pad, ty, size, size);
        ty += size + inch(0.05);
      } else ty += inch(0.12);
      ty += inch(0.12);
      text(c.name, pad, ty, { size: 0.13, weight: 700, maxWidth: textMax - pad });
      ty += inch(0.13);
      text(c.code, pad, ty, { size: 0.095, weight: 500, color: '#4b5563', font: MONO, maxWidth: textMax - pad });
      for (const line of c.meta) {
        ty += inch(0.12);
        text(line, pad, ty, { size: 0.085, color: '#6b7280', maxWidth: textMax - pad });
      }
    }
  }

  if (template.footer_note) {
    const solid = template.style !== 'classic';
    if (solid) {
      ctx.fillStyle = c.accent;
      ctx.fillRect(0, H - footH, W, footH);
    } else {
      ctx.fillStyle = '#e5e7eb';
      ctx.fillRect(0, H - footH, W, Math.max(1, inch(0.005)));
    }
    text(template.footer_note, W / 2, H - footH / 2 + inch(0.025), { size: 0.068, color: solid ? c.ink : '#6b7280', align: 'center', maxWidth: W - pad * 2 });
  }

  // Hairline edge, as the card stock's cut line.
  ctx.strokeStyle = '#e5e7eb';
  ctx.lineWidth = Math.max(1, inch(0.006));
  ctx.strokeRect(0, 0, W, H);

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

/** `hex` washed toward white by `amount` — the initials tile's background. */
function tintOf(hex, amount) {
  const n = parseInt(String(hex).slice(1), 16);
  const mix = (v) => Math.round(v + (255 - v) * amount);
  return `rgb(${mix((n >> 16) & 255)}, ${mix((n >> 8) & 255)}, ${mix(n & 255)})`;
}

export async function downloadCardPng(card) {
  const pngBytes = await renderCardPngBytes(card);
  const member = card.member;
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([pngBytes], { type: 'image/png' }));
  link.download = `${member.code}-id-card.png`;
  link.click();
  URL.revokeObjectURL(link.href);
}

/* ── Member-app poster ────────────────────────────────────────────────── */

/**
 * The "scan to get the app" sheet an owner sticks on the front desk. Built
 * from GET /api/qr/app: the QR opens the gym's member portal, which the phone
 * then installs to its home screen like an app.
 *
 * Gyms get the illustrated poster in gymPoster.js. Libraries get this plain
 * one: that artwork is dumbbells and whey, which would be wrong for a study
 * hall. Its copy feeds both the printed sheet and the PNG, so the two never
 * drift apart.
 */
function posterCopy(poster) {
  const member = t('member').toLowerCase();
  return {
    headline: 'Get our app',
    sub: isCoaching()
      ? 'Your student ID, timetable, test results and fee receipts — right on your phone.'
      : isLibrary()
        ? 'Your seat pass, fees and attendance — right on your phone.'
        : 'Your membership pass, classes, payments and check-ins — right on your phone.',
    caption: 'Scan with your phone camera',
    steps: [
      'Point your camera at the code and tap the link that appears.',
      `Sign in with your ${member} ID or phone number and your password. No password yet? Tap "Forgot password?" or ask at the front desk.`,
      'Add it to your home screen. Android: tap Install. iPhone: in Safari, tap Share, then Add to Home Screen.',
    ],
    url: poster.url,
  };
}

/** Read off the live theme so the poster carries the gym's own colour. */
function brandColor() {
  const value = getComputedStyle(document.body).getPropertyValue('--brand').trim();
  return /^#[0-9a-f]{3,8}$/i.test(value) ? value : '#111827';
}

function plainPosterNode(poster) {
  const copy = posterCopy(poster);
  const logoUrl = poster.logo_url || getGymLogoUrl();
  return h(
    'div',
    { class: 'app-poster', style: `--poster-accent:${brandColor()}` },
    h(
      'div',
      { class: 'app-poster-brand' },
      logoUrl ? h('img', { class: 'app-poster-logo', src: logoUrl, alt: '' }) : null,
      h('div', { class: 'app-poster-gym' }, poster.gym_name),
    ),
    h('div', { class: 'app-poster-headline' }, copy.headline),
    h('div', { class: 'app-poster-sub' }, copy.sub),
    // Server-rendered SVG: sharp at whatever size the printer draws it.
    h('div', { class: 'app-poster-qr', html: poster.svg }),
    h('div', { class: 'app-poster-caption' }, copy.caption),
    h('ol', { class: 'app-poster-steps' }, ...copy.steps.map((step) => h('li', {}, step))),
    h('div', { class: 'app-poster-url' }, 'Or type ', h('strong', {}, copy.url)),
  );
}

/** The desk poster this account gets, as DOM — see posterCopy() for which. */
export async function appPosterNode(poster) {
  return isEducation() ? plainPosterNode(poster) : gymPosterNode(poster);
}

/** Same #print-root mechanism as printCards() — see there for why. */
export async function printAppPoster(poster) {
  const root = document.getElementById('print-root');
  if (!root) return;

  const node = await appPosterNode(poster);
  clear(root).append(h('div', { class: 'app-poster-page' }, node));
  document.body.classList.add('printing');
  // The illustrated poster's artwork is an <image> inside the SVG; printing
  // before it arrives would put a blank sheet with floating text on paper.
  await node.ready;

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

/** Greedy word wrap for canvas text; returns the lines that fit maxWidth. */
function wrapLines(ctx, text, maxWidth) {
  const lines = [];
  let line = '';
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** The plain poster as an A4 PNG (150 dpi). */
async function plainPosterPngBlob(poster) {
  const copy = posterCopy(poster);
  const accent = brandColor();
  const width = 1240;
  const height = 1754;
  const margin = 110;
  const textWidth = width - margin * 2;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = accent;
  ctx.fillRect(0, 0, width, 22);

  // Brand row: logo (if it loads) and the gym name, centred together.
  let y = 110;
  const logoSize = 110;
  const logoUrl = poster.logo_url || getGymLogoUrl();
  let logo = null;
  if (logoUrl) {
    try {
      logo = await loadImage(logoUrl);
    } catch {
      // A logo that fails to load leaves just the name, not a failed download.
    }
  }
  ctx.font = '700 54px system-ui, sans-serif';
  const nameWidth = Math.min(ctx.measureText(poster.gym_name).width, textWidth - (logo ? logoSize + 28 : 0));
  let x = (width - (logo ? logoSize + 28 + nameWidth : nameWidth)) / 2;
  if (logo) {
    ctx.save();
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, logoSize, logoSize, 22);
    else ctx.rect(x, y, logoSize, logoSize);
    ctx.clip();
    ctx.drawImage(logo, x, y, logoSize, logoSize);
    ctx.restore();
    x += logoSize + 28;
  }
  ctx.fillStyle = '#111827';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(poster.gym_name, x, y + logoSize / 2, nameWidth);
  y += logoSize + 70;

  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.font = '800 100px system-ui, sans-serif';
  ctx.fillText(copy.headline, width / 2, y, textWidth);
  y += 124;

  ctx.fillStyle = '#4b5563';
  ctx.font = '400 34px system-ui, sans-serif';
  for (const line of wrapLines(ctx, copy.sub, textWidth)) {
    ctx.fillText(line, width / 2, y);
    y += 46;
  }
  y += 40;

  const qr = await loadImage(poster.png);
  const qrSize = 640;
  const qrX = (width - qrSize) / 2;
  ctx.strokeStyle = accent;
  ctx.lineWidth = 6;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(qrX - 24, y - 24, qrSize + 48, qrSize + 48, 36);
  else ctx.rect(qrX - 24, y - 24, qrSize + 48, qrSize + 48);
  ctx.stroke();
  ctx.drawImage(qr, qrX, y, qrSize, qrSize);
  y += qrSize + 54;

  ctx.fillStyle = '#111827';
  ctx.font = '700 38px system-ui, sans-serif';
  ctx.fillText(copy.caption, width / 2, y, textWidth);
  y += 84;

  // Numbered steps, each wrapped beside its own outlined number.
  const badge = 25;
  const stepX = margin + badge * 2 + 24;
  for (const [index, step] of copy.steps.entries()) {
    ctx.strokeStyle = accent;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(margin + badge, y + 20, badge, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#111827';
    ctx.font = '700 28px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(index + 1), margin + badge, y + 21);

    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#374151';
    ctx.font = '400 30px system-ui, sans-serif';
    for (const line of wrapLines(ctx, step, width - margin - stepX)) {
      ctx.fillText(line, stepX, y);
      y += 40;
    }
    y += 22;
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillStyle = '#6b7280';
  ctx.font = '400 26px ui-monospace, monospace';
  ctx.fillText(`Or type ${copy.url}`, width / 2, height - 60, textWidth);

  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

/**
 * Saves the desk poster as a PNG — for a print shop, or for printing from a
 * phone, which has no print dialog worth the name.
 */
export async function downloadAppPosterPng(poster) {
  const blob = isEducation() ? await plainPosterPngBlob(poster) : await gymPosterPngBlob(poster);
  const slug = poster.gym_name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'gym';
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${slug}-app-qr.png`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
