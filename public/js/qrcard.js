import { clear, date, fullName, h } from './ui.js';

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

  return h(
    'div',
    { class: 'id-card' },
    h(
      'div',
      { class: 'id-card-main' },
      h('div', { class: 'id-card-gym' }, card.gym_name),
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
 * Deliberately omits the member photo: photo_url can point at another origin,
 * which taints the canvas and makes toDataURL throw — losing the whole
 * download. The printed card keeps the photo; the shareable image doesn't.
 */
export async function downloadCardPng(card) {
  const scale = 300; // dpi
  const width = Math.round(CARD_W_IN * scale);
  const height = Math.round(CARD_H_IN * scale);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  // Header band
  const bandHeight = Math.round(height * 0.19);
  ctx.fillStyle = '#111827';
  ctx.fillRect(0, 0, width, bandHeight);
  ctx.fillStyle = '#ffffff';
  ctx.font = `600 ${Math.round(bandHeight * 0.42)}px system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.fillText(card.gym_name, Math.round(width * 0.05), bandHeight / 2, width * 0.9);

  const member = card.member;
  const left = Math.round(width * 0.05);
  let y = bandHeight + Math.round(height * 0.16);

  ctx.fillStyle = '#111827';
  ctx.font = `700 ${Math.round(height * 0.115)}px system-ui, sans-serif`;
  ctx.fillText(fullName(member), left, y, width * 0.55);

  y += Math.round(height * 0.15);
  ctx.fillStyle = '#6b7280';
  ctx.font = `500 ${Math.round(height * 0.082)}px ui-monospace, monospace`;
  ctx.fillText(member.code, left, y, width * 0.55);

  if (member.membership_end) {
    y += Math.round(height * 0.125);
    ctx.font = `400 ${Math.round(height * 0.066)}px system-ui, sans-serif`;
    ctx.fillText(`Valid until ${date(member.membership_end)}`, left, y, width * 0.55);
  }

  ctx.fillStyle = '#9ca3af';
  ctx.font = `400 ${Math.round(height * 0.055)}px system-ui, sans-serif`;
  ctx.fillText('Scan at reception', left, height - Math.round(height * 0.08), width * 0.55);

  // QR block, right-aligned. Data URL, so the canvas stays untainted.
  const qr = await loadImage(card.png);
  const qrSize = Math.round(height * 0.62);
  const qrX = width - qrSize - Math.round(width * 0.05);
  const qrY = bandHeight + Math.round((height - bandHeight - qrSize) / 2);
  ctx.drawImage(qr, qrX, qrY, qrSize, qrSize);

  const link = document.createElement('a');
  link.href = canvas.toDataURL('image/png');
  link.download = `${member.code}-gym-card.png`;
  link.click();
}
