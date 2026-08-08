import { clear, date, fullName, h } from './ui.js';
import { getGymLogoUrl } from './receipt.js';

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
