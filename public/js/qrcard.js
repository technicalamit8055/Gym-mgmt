import { clear, date, fullName, h } from './ui.js';
import { gymPosterNode, gymPosterPngBlob } from './gymPoster.js';
import { getGymLogoUrl } from './receipt.js';
import { isLibrary, t } from './vertical.js';

/**
 * Member QR ID cards: on-screen preview, printing, and a downloadable image
 * staff can send over WhatsApp or email.
 *
 * Card geometry follows CR80 (the standard plastic card, 3.375in × 2.125in) so
 * a printed sheet lines up with off-the-shelf card stock and laminate pouches.
 */

const CARD_W_IN = 3.375;
const CARD_H_IN = 2.125;

/** One card, as DOM. Used unchanged for the on-screen preview and the print
 * sheet — what staff see is what comes out of the printer. */
export function idCardNode(card) {
  const member = card.member;
  const logoUrl = card.logo_url || getGymLogoUrl();

  const gymHeader = logoUrl
    ? h('div', { class: 'id-card-gym-brand' },
        h('img', { class: 'id-card-logo-img', src: logoUrl, alt: '' }),
        h('div', { class: 'id-card-gym' }, card.gym_name),
      )
    : h('div', { class: 'id-card-gym' }, card.gym_name);

  return h(
    'div',
    { class: 'id-card' },
    h(
      'div',
      { class: 'id-card-main' },
      gymHeader,
      member.photo_url
        ? h('img', { class: 'id-card-photo', src: member.photo_url, alt: '' })
        : null,
      h('div', { class: 'id-card-name' }, fullName(member)),
      h('div', { class: 'id-card-code' }, member.code),
      member.membership_end
        ? h('div', { class: 'id-card-valid' }, `Valid until ${date(member.membership_end)}`)
        : h('div', { class: 'id-card-valid muted' }, 'No active membership'),
    ),
    h(
      'div',
      { class: 'id-card-qr' },
      // Server-rendered SVG: stays sharp at any print resolution.
      h('div', { class: 'id-card-qr-img', html: card.svg }),
      h('div', { class: 'id-card-hint' }, 'Scan at reception'),
    ),
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
    img.src = src;
  });

/**
 * Draws the card to a canvas and downloads it as a PNG.
 *
 * The photo is included: photo_url is always served by this app on this origin
 * (see src/photo.js), so drawing it leaves the canvas untainted and toDataURL
 * still works. A photo that fails to load is skipped rather than losing the
 * whole download.
 */
export async function renderCardPngBytes(card) {
  const scale = 300; // dpi
  const width = Math.round(CARD_W_IN * scale); // ~1013px
  const height = Math.round(CARD_H_IN * scale); // ~638px

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  // Card background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  // Card outer border line
  ctx.strokeStyle = '#e5e7eb';
  ctx.lineWidth = Math.round(scale * 0.01);
  ctx.strokeRect(0, 0, width, height);

  // Header band (#111827)
  const bandHeight = Math.round(height * 0.18);
  ctx.fillStyle = '#111827';
  ctx.fillRect(0, 0, width, bandHeight);

  const logoUrl = card.logo_url || getGymLogoUrl();
  let textX = Math.round(width * 0.05);

  if (logoUrl) {
    try {
      const logoImg = await loadImage(logoUrl);
      const logoSize = Math.round(bandHeight * 0.62);
      const logoX = Math.round(width * 0.04);
      const logoY = Math.round((bandHeight - logoSize) / 2);

      ctx.save();
      ctx.beginPath();
      if (ctx.roundRect) {
        ctx.roundRect(logoX, logoY, logoSize, logoSize, Math.round(logoSize * 0.18));
      } else {
        ctx.rect(logoX, logoY, logoSize, logoSize);
      }
      ctx.clip();
      ctx.drawImage(logoImg, logoX, logoY, logoSize, logoSize);
      ctx.restore();

      textX = logoX + logoSize + Math.round(width * 0.03);
    } catch {
      // Skips cleanly if logo image fails to load
    }
  }

  // Gym Name in header band
  ctx.fillStyle = '#ffffff';
  ctx.font = `600 ${Math.round(bandHeight * 0.44)}px system-ui, sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(card.gym_name, textX, bandHeight / 2, width * 0.95 - textX);

  const member = card.member;
  const left = Math.round(width * 0.05);
  const maxTextWidth = Math.round(width * 0.48);

  let currentY = bandHeight + Math.round(height * 0.05);

  // Member photo (if present)
  if (member.photo_url) {
    try {
      const photoImg = await loadImage(member.photo_url);
      const photoSize = Math.round(height * 0.32);
      const photoX = left;
      const photoY = currentY;

      ctx.save();
      ctx.beginPath();
      if (ctx.roundRect) {
        ctx.roundRect(photoX, photoY, photoSize, photoSize, Math.round(photoSize * 0.12));
      } else {
        ctx.rect(photoX, photoY, photoSize, photoSize);
      }
      ctx.clip();
      ctx.drawImage(photoImg, photoX, photoY, photoSize, photoSize);
      ctx.restore();

      currentY = photoY + photoSize + Math.round(height * 0.04);
    } catch {
      // Fallback gracefully if image fails to load
    }
  } else {
    currentY += Math.round(height * 0.04);
  }

  ctx.textBaseline = 'top';

  // Member Name
  ctx.fillStyle = '#111827';
  ctx.font = `700 ${Math.round(height * 0.085)}px system-ui, sans-serif`;
  ctx.fillText(fullName(member), left, currentY, maxTextWidth);
  currentY += Math.round(height * 0.095);

  // Member Code
  ctx.fillStyle = '#4b5563';
  ctx.font = `500 ${Math.round(height * 0.065)}px ui-monospace, monospace`;
  ctx.fillText(member.code, left, currentY, maxTextWidth);
  currentY += Math.round(height * 0.08);

  // Validity Date / Membership Status
  ctx.fillStyle = member.membership_end ? '#4b5563' : '#9ca3af';
  ctx.font = `400 ${Math.round(height * 0.055)}px system-ui, sans-serif`;
  const validText = member.membership_end ? `Valid until ${date(member.membership_end)}` : 'No active membership';
  ctx.fillText(validText, left, currentY, maxTextWidth);

  // QR block on the right side
  const qr = await loadImage(card.png);
  const qrSize = Math.round(height * 0.54);
  const qrX = width - qrSize - Math.round(width * 0.05);
  const qrY = bandHeight + Math.round(height * 0.06);
  ctx.drawImage(qr, qrX, qrY, qrSize, qrSize);

  // "Scan at reception" centered directly under the QR code
  ctx.fillStyle = '#9ca3af';
  ctx.font = `400 ${Math.round(height * 0.048)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText('Scan at reception', qrX + qrSize / 2, qrY + qrSize + Math.round(height * 0.03));

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

export async function downloadCardPng(card) {
  const pngBytes = await renderCardPngBytes(card);
  const member = card.member;
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([pngBytes], { type: 'image/png' }));
  link.download = `${member.code}-gym-card.png`;
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
    sub: isLibrary()
      ? 'Your seat pass, fees and attendance — right on your phone.'
      : 'Your membership pass, classes, payments and check-ins — right on your phone.',
    caption: 'Scan with your phone camera',
    steps: [
      'Point your camera at the code and tap the link that appears.',
      `Sign in with your ${member} ID or phone number and your PIN. No PIN yet? Ask at the front desk.`,
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
  return isLibrary() ? plainPosterNode(poster) : gymPosterNode(poster);
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
  const blob = isLibrary() ? await plainPosterPngBlob(poster) : await gymPosterPngBlob(poster);
  const slug = poster.gym_name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'gym';
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${slug}-app-qr.png`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
