import { getGymLogoUrl } from './receipt.js';
import { renderIcon } from './ui.js';

/**
 * The illustrated "Apni Fitness Ab Mobile Par" desk poster for gyms.
 *
 * The artwork (public/images/poster/gym-poster-bg.png) holds the photos and
 * decoration only, with empty slots. Everything that is words, or that differs
 * per gym — logo, name, tagline, copy, the QR code and the link — is laid over
 * it here as SVG, so text stays sharp at print size, is never misspelled by an
 * image generator, and every gym gets its own poster from one picture.
 *
 * One SVG serves all three uses: inline for the preview and for printing, and
 * rasterised for the PNG download (with the images inlined, since an SVG drawn
 * as an image may not fetch anything).
 *
 * All coordinates are the artwork's own pixels (1024 × 1536), measured from
 * the template. A replacement template with its slots elsewhere means
 * re-measuring SLOTS, nothing more.
 */

const BG_URL = '/images/poster/gym-poster-bg.png';
const W = 1024;
const H = 1536;

/** Matched to the artwork's paint, not the gym's theme: the splashes, rings
 * and brackets in the picture are this orange whatever palette is chosen. */
const ORANGE = '#f26a1b';
const INK = '#111827';
const MUTED = '#4b5563';
/** The app's own font for the live poster. The PNG cannot use it: an SVG
 * rasterised as an image is snapshotted before an embedded web font loads,
 * which leaves every word invisible. So the download is set in the device's
 * own UI font, and measured in it too, so its wrapping still fits. */
const APP_FONT = "'Inter Variable', Inter, system-ui, -apple-system, 'Segoe UI', sans-serif";
const SYSTEM_FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
/** Whichever of the two the poster being built is set in. buildSvg() is
 * synchronous, so one build never sees another's. */
let FONT = APP_FONT;

const SLOTS = {
  logo: { cx: 85, cy: 78, r: 46 },
  name: { x: 154, maxWidth: 360 },
  headline: { x: 38, maxWidth: 470 },
  sub: { x: 40, y: 340, maxWidth: 410 },
  // The phone mockup's blank screen: a rectangle tilted with the phone.
  phone: { cx: 873, cy: 367, w: 200, h: 462, angle: 7 },
  cards: { top: 468, textBottom: 626, pad: 13, columns: [[37, 173], [212, 172], [388, 161], [554, 165]] },
  // Centred between the orange corner brackets.
  qr: { x: 398, y: 862, size: 228 },
  steps: { top: 1136, bottom: 1361, columns: [56, 376, 696], width: 280, dividers: [361, 681] },
  link: { left: 41, right: 983, top: 1393, bottom: 1475 },
  // The blank phone held up in the "Digital Member Pass" card.
  passPhone: { cx: 655, cy: 712, w: 60, h: 148, angle: 16 },
  // Where a brand would be printed on the products in the artwork.
  shaker: { cx: 948, logoY: 886, logoR: 30, wordY: 940, wordWidth: 72 },
  tub: { cx: 489, logoY: 722, logoR: 19, wordY: 757, wordWidth: 54 },
  jar: { cx: 424, cy: 768, r: 12 },
};

/** Hinglish, as the gym asked for. Every claim is something the member app
 * actually does today — the trackers (free or the paid add-on, either way
 * present in every gym's portal), supplement logging in the diet tracker's
 * food library, and the scannable pass. */
const COPY = {
  headline: ['Apni Fitness', 'Ab Mobile Par'],
  sub: 'Workout track karo, diet follow karo, apna member pass saath rakho — sab kuch ek hi app mein!',
  cards: [
    { title: 'Workout Tracker', body: 'Apne workouts log karo, progress aur PRs dekho.' },
    { title: 'Diet Tracker', body: 'Meals log karo, calories aur protein khud count hote hain.' },
    { title: 'Supplements Log', body: 'Whey, creatine, BCAA — roz ka intake track karo.' },
    { title: 'Digital Member Pass', body: 'Phone dikhao, gym mein entry. Fast, easy & secure.' },
  ],
  scan: 'SCAN NOW',
  stepsTitle: 'App Kaise Use Karein?',
  steps: [
    { title: 'Camera Open Karo', body: 'Phone ka camera open karo aur upar diya gaya QR code scan karo.' },
    {
      title: 'Login Karo',
      body: 'Apni Member ID ya registered phone number aur PIN se login karo. PIN nahi hai? Front desk se poochho.',
    },
    {
      title: 'Home Screen Par Add Karo',
      body: 'Android: Install par tap karo. iPhone: Safari mein Share button, phir “Add to Home Screen”.',
    },
  ],
  linkLabel: 'Ya seedha link open karo',
};

/* ------------------------------------------------------------ text tools */

const esc = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let measureCtx;
/** Width in artwork pixels, measured with the same font the SVG renders in —
 * SVG has no line wrapping of its own, so every wrap is decided here. */
function measure(content, size, weight) {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  measureCtx.font = `${weight} ${size}px ${FONT}`;
  return measureCtx.measureText(content).width;
}

/** The largest size, down to `min`, at which `content` fits on one line. */
function fitSize(content, { size, min, weight, maxWidth }) {
  let current = size;
  while (current > min && measure(content, current, weight) > maxWidth) current -= 1;
  return current;
}

function wrap(content, size, weight, maxWidth) {
  const lines = [];
  let line = '';
  for (const word of String(content).split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (line && measure(next, size, weight) > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** One line of text. Squeezed with textLength only as a last resort, when
 * even the smallest allowed size still overflows. */
function text(x, y, content, { size, weight = 400, fill = INK, anchor = 'start', maxWidth, extra = '' }) {
  const squeeze =
    maxWidth && measure(content, size, weight) > maxWidth ? ` textLength="${maxWidth}" lengthAdjust="spacingAndGlyphs"` : '';
  return `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}"${squeeze}${extra}>${esc(content)}</text>`;
}

/** A wrapped paragraph; past `maxLines` the last line ends in an ellipsis. */
function paragraph(x, y, content, { size, weight = 400, fill = MUTED, maxWidth, lineHeight, maxLines = 99, anchor = 'start' }) {
  let lines = wrap(content, size, weight, maxWidth);
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    let last = lines[maxLines - 1];
    while (last && measure(`${last}…`, size, weight) > maxWidth) last = last.slice(0, -1);
    lines[maxLines - 1] = `${last.trimEnd()}…`;
  }
  const spans = lines.map((line, i) => `<tspan x="${x}" dy="${i ? lineHeight : 0}">${esc(line)}</tspan>`).join('');
  return { svg: `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${spans}</text>`, lines: lines.length };
}

/** One of the app's own line icons, placed at (x, y) and tinted. */
function icon(name, x, y, size, color, stroke = 2) {
  const node = renderIcon(name, { size, stroke });
  if (!node) return '';
  node.setAttribute('x', x);
  node.setAttribute('y', y);
  node.setAttribute('color', color);
  node.removeAttribute('class');
  return node.outerHTML;
}

/** The gym's name cut to one word for a product label: "The Gold's Standard
 * Fitness Gym" prints as GOLD'S, not THE. */
const brandWord = (name) => {
  const words = String(name).split(/\s+/).filter(Boolean);
  const skip = new Set(['the', 'a', 'an', 'of', 'and', '&']);
  return (words.find((word) => !skip.has(word.toLowerCase())) || words[0] || 'GYM').toUpperCase();
};

const initials = (name) =>
  String(name)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join('') || 'G';

/** The gym's logo in a circle, or its initials when it has none. */
function logoMark(id, cx, cy, r, logoHref, gymName) {
  if (logoHref) {
    return `<clipPath id="${id}"><circle cx="${cx}" cy="${cy}" r="${r}"/></clipPath>` +
      `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#fff"/>` +
      `<image href="${esc(logoHref)}" x="${cx - r}" y="${cy - r}" width="${r * 2}" height="${r * 2}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${id})"/>`;
  }
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${INK}"/>` +
    text(cx, cy + r * 0.36, initials(gymName), { size: Math.round(r * 0.95), weight: 800, fill: '#fff', anchor: 'middle' });
}

/* --------------------------------------------------------------- sections */

function brandBlock(poster, logoHref) {
  const { logo, name } = SLOTS;
  const nameSize = fitSize(poster.gym_name, { size: 31, min: 20, weight: 800, maxWidth: name.maxWidth });
  const nameY = poster.tagline ? 74 : 88;
  return [
    logoMark('poster-logo', logo.cx, logo.cy, logo.r, logoHref, poster.gym_name),
    text(name.x, nameY, poster.gym_name, { size: nameSize, weight: 800, maxWidth: name.maxWidth }),
    poster.tagline ? text(name.x, 106, poster.tagline, { size: 19, fill: MUTED, maxWidth: name.maxWidth }) : '',
  ].join('');
}

function headlineBlock() {
  const { x, maxWidth } = SLOTS.headline;
  // Both lines share one size, set by whichever is wider, as in the design.
  const size = Math.min(...COPY.headline.map((line) => fitSize(line, { size: 72, min: 40, weight: 900, maxWidth })));
  return [
    text(x, 218, COPY.headline[0], { size, weight: 900, extra: ' letter-spacing="-1.5"' }),
    text(x, 218 + size * 1.08, COPY.headline[1], { size, weight: 900, fill: ORANGE, extra: ' letter-spacing="-1.5"' }),
    paragraph(SLOTS.sub.x, SLOTS.sub.y, COPY.sub, { size: 20, maxWidth: SLOTS.sub.maxWidth, lineHeight: 28, maxLines: 3 }).svg,
  ].join('');
}

/** A miniature of the member app's home screen, drawn into the blank phone. */
function phoneScreen(poster, logoHref) {
  const { cx, cy, angle } = SLOTS.phone;
  const tile = (x, y, bg, iconName, color, label) =>
    `<rect x="${x}" y="${y}" width="80" height="64" rx="10" fill="${bg}"/>` +
    icon(iconName, x + 28, y + 10, 24, color) +
    text(x + 40, y + 52, label, { size: 10.5, weight: 700, anchor: 'middle', maxWidth: 72 });
  const bar = (y, label, value, fraction, color) =>
    text(-18, y, label, { size: 9, weight: 600, fill: MUTED }) +
    text(78, y, value, { size: 9, weight: 600, fill: MUTED, anchor: 'end' }) +
    `<rect x="-18" y="${y + 4}" width="96" height="4" rx="2" fill="#e5e7eb"/>` +
    `<rect x="-18" y="${y + 4}" width="${96 * fraction}" height="4" rx="2" fill="${color}"/>`;
  // A 75% ring: the circumference times the share still to go.
  const ringR = 21;
  const ring = 2 * Math.PI * ringR;

  return `<g transform="translate(${cx} ${cy}) rotate(${angle})">` +
    logoMark('poster-phone-logo', 0, -172, 22, logoHref, poster.gym_name) +
    `<circle cx="0" cy="-172" r="22" fill="none" stroke="${ORANGE}" stroke-width="2"/>` +
    text(0, -134, poster.gym_name, { size: fitSize(poster.gym_name, { size: 13, min: 9, weight: 800, maxWidth: 170 }), weight: 800, anchor: 'middle', maxWidth: 170 }) +
    (poster.tagline ? text(0, -120, poster.tagline, { size: 8.5, fill: MUTED, anchor: 'middle', maxWidth: 170 }) : '') +
    text(-84, -94, 'Hello Member', { size: 14, weight: 800 }) +
    text(-84, -80, 'Stay consistent, stay strong', { size: 8.5, fill: MUTED }) +
    tile(-84, -68, '#fff1e6', 'barbell', ORANGE, 'Workout') +
    tile(4, -68, '#e7f8ee', 'apple', '#16a34a', 'Diet') +
    tile(-84, 4, '#e8f0fe', 'bottle', '#2563eb', 'Supplements') +
    tile(4, 4, '#fde8ef', 'qrCode', '#e11d48', 'Member Pass') +
    `<rect x="-84" y="80" width="168" height="104" rx="12" fill="#fff" stroke="#eceef2"/>` +
    text(-74, 99, "Today's Progress", { size: 10.5, weight: 800 }) +
    `<circle cx="-50" cy="140" r="${ringR}" fill="none" stroke="#e5e7eb" stroke-width="6"/>` +
    `<circle cx="-50" cy="140" r="${ringR}" fill="none" stroke="#22c55e" stroke-width="6" stroke-linecap="round" stroke-dasharray="${ring}" stroke-dashoffset="${ring * 0.25}" transform="rotate(-90 -50 140)"/>` +
    text(-50, 144, '75%', { size: 11, weight: 800, anchor: 'middle' }) +
    bar(120, 'Workout', '4/5', 0.8, ORANGE) +
    bar(144, 'Diet', '3/3', 1, '#22c55e') +
    bar(168, 'Protein', '90g', 0.7, '#3b82f6') +
    `<line x1="-92" y1="196" x2="92" y2="196" stroke="#eceef2"/>` +
    icon('home', -80, 202, 15, ORANGE) +
    icon('barbell', -38, 202, 15, '#9ca3af') +
    icon('apple', 4, 202, 15, '#9ca3af') +
    icon('member', 46, 202, 15, '#9ca3af') +
    `</g>`;
}

/**
 * A QR-looking pattern for the pass in the card picture. Deliberately not a
 * real code: the scannable one is the big QR below, and a second, tiny code
 * a camera might pick up first would only confuse people.
 */
function decorativeQr(x, y, size, seedText) {
  const n = 21;
  let seed = [...String(seedText)].reduce((acc, c) => (acc * 31 + c.charCodeAt(0)) >>> 0, 7);
  const random = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 16) & 1;
  const inFinder = (cx, cy) => [[0, 0], [n - 7, 0], [0, n - 7]].some(([fx, fy]) => cx >= fx - 1 && cx <= fx + 7 && cy >= fy - 1 && cy <= fy + 7);
  let d = '';
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      if (!inFinder(col, row) && random()) d += `M${col} ${row}h1v1h-1z`;
    }
  }
  const finders = [[0, 0], [n - 7, 0], [0, n - 7]]
    .map(([fx, fy]) => `M${fx} ${fy}h7v7h-7zM${fx + 1} ${fy + 1}v5h5v-5zM${fx + 2} ${fy + 2}h3v3h-3z`)
    .join('');
  return `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges">` +
    `<path d="${finders}${d}" fill="${INK}" fill-rule="evenodd"/></svg>`;
}

/** A member pass on the phone in the fourth card's picture. */
function passScreen(poster, logoHref) {
  const { cx, cy, angle } = SLOTS.passPhone;
  return `<g transform="translate(${cx} ${cy}) rotate(${angle})">` +
    text(0, -58, 'MEMBER PASS', { size: 6.5, weight: 800, fill: ORANGE, anchor: 'middle', maxWidth: 52 }) +
    logoMark('poster-pass-logo', 0, -41, 10, logoHref, poster.gym_name) +
    text(0, -24, brandWord(poster.gym_name), { size: 6, weight: 800, anchor: 'middle', maxWidth: 52 }) +
    decorativeQr(-21, -18, 42, poster.url) +
    `<rect x="-17" y="30" width="34" height="11" rx="5.5" fill="#dcfce7"/>` +
    text(0, 38, 'ACTIVE', { size: 6, weight: 800, fill: '#15803d', anchor: 'middle' }) +
    `</g>`;
}

/** The gym's logo, and on the larger pieces its name, on the shaker and the
 * supplement tubs — as if they were the gym's own merchandise. */
function productBranding(poster, logoHref) {
  const { shaker, tub, jar } = SLOTS;
  const word = brandWord(poster.gym_name);
  const label = (cx, y, maxWidth, size) =>
    text(cx, y, word, {
      size: fitSize(word, { size, min: 8, weight: 900, maxWidth }),
      weight: 900,
      fill: ORANGE,
      anchor: 'middle',
      maxWidth,
      extra: ' letter-spacing="1"',
    });
  const ring = (cx, cy, r) => `<circle cx="${cx}" cy="${cy}" r="${r + 2}" fill="none" stroke="${ORANGE}" stroke-width="2.5"/>`;
  return [
    logoMark('poster-shaker-logo', shaker.cx, shaker.logoY, shaker.logoR, logoHref, poster.gym_name),
    ring(shaker.cx, shaker.logoY, shaker.logoR),
    label(shaker.cx, shaker.wordY, shaker.wordWidth, 22),
    logoMark('poster-tub-logo', tub.cx, tub.logoY, tub.logoR, logoHref, poster.gym_name),
    ring(tub.cx, tub.logoY, tub.logoR),
    label(tub.cx, tub.wordY, tub.wordWidth, 15),
    logoMark('poster-jar-logo', jar.cx, jar.cy, jar.r, logoHref, poster.gym_name),
    ring(jar.cx, jar.cy, jar.r),
  ].join('');
}

function featureCards() {
  const { top, textBottom, pad, columns } = SLOTS.cards;
  return COPY.cards
    .map((card, i) => {
      const [left, width] = columns[i];
      const x = left + pad;
      const maxWidth = width - pad * 2;
      const title = paragraph(x, top + 34, card.title, { size: 20, weight: 800, fill: INK, maxWidth, lineHeight: 23, maxLines: 2 });
      const bodyTop = top + 34 + (title.lines - 1) * 23 + 26;
      const maxLines = Math.max(1, Math.floor((textBottom - bodyTop) / 17) + 1);
      return title.svg + paragraph(x, bodyTop, card.body, { size: 13, maxWidth, lineHeight: 17, maxLines }).svg;
    })
    .join('');
}

/** The real QR, sized into the bracketed box — the server's SVG with its
 * fixed width/height swapped for this slot's. */
function qrBlock(qrSvg) {
  const { x, y, size } = SLOTS.qr;
  const start = qrSvg.indexOf('<svg');
  const markup = qrSvg.slice(start).replace(/^<svg([^>]*)>/, (_, attrs) =>
    `<svg${attrs.replace(/\s(width|height|x|y)="[^"]*"/g, '')} x="${x}" y="${y}" width="${size}" height="${size}">`);
  return markup;
}

/** On the orange brush stroke right of the QR box, rising with it. Anchored
 * at its left end so a wider font grows away from the box, not into it. */
function scanBadge() {
  const size = fitSize(COPY.scan, { size: 34, min: 22, weight: 900, maxWidth: 172 });
  return `<g transform="translate(692 992) rotate(-16)">` +
    text(0, 0, COPY.scan, { size, weight: 900, fill: '#fff', extra: ' letter-spacing="1"' }) +
    `</g>`;
}

function stepsBlock() {
  const { top, columns, width, dividers } = SLOTS.steps;
  const pillSize = 22;
  const pillWidth = measure(COPY.stepsTitle, pillSize, 800) + 48;
  const parts = [
    `<rect x="46" y="${top - 26}" width="${pillWidth}" height="50" rx="25" fill="${ORANGE}"/>`,
    text(70, top + 7, COPY.stepsTitle, { size: pillSize, weight: 800, fill: '#fff' }),
    ...dividers.map((x) => `<line x1="${x}" y1="${top + 48}" x2="${x}" y2="${top + 200}" stroke="#e5e7eb" stroke-width="1.5"/>`),
  ];
  COPY.steps.forEach((step, i) => {
    const x = columns[i];
    const titleWidth = width - 50;
    parts.push(
      `<circle cx="${x + 20}" cy="${top + 64}" r="20" fill="${ORANGE}"/>`,
      text(x + 20, top + 71, String(i + 1), { size: 20, weight: 800, fill: '#fff', anchor: 'middle' }),
      text(x + 50, top + 71, step.title, {
        size: fitSize(step.title, { size: 19, min: 15, weight: 800, maxWidth: titleWidth }),
        weight: 800,
        maxWidth: titleWidth,
      }),
      paragraph(x, top + 112, step.body, { size: 15.5, maxWidth: width, lineHeight: 21, maxLines: 5 }).svg,
    );
  });
  return parts.join('');
}

function linkBlock(url) {
  const { left, right, top, bottom } = SLOTS.link;
  const mid = (top + bottom) / 2;
  const textX = left + 86;
  const maxWidth = right - textX - 24;
  return `<circle cx="${left + 44}" cy="${mid}" r="27" fill="#fff1e6"/>` +
    icon('link', left + 31, mid - 13, 26, ORANGE) +
    text(textX, mid - 10, COPY.linkLabel, { size: 15, fill: MUTED }) +
    text(textX, mid + 20, url, { size: fitSize(url, { size: 23, min: 13, weight: 600, maxWidth }), weight: 600, maxWidth });
}

/* ----------------------------------------------------------------- build */

/** Every weight the poster uses, so measuring never runs on a fallback font
 * and then renders in Inter (or the other way round). */
async function fontsReady(sample) {
  if (!document.fonts?.load) return;
  await Promise.all([400, 600, 700, 800, 900].map((w) => document.fonts.load(`${w} 20px 'Inter Variable'`, sample))).catch(() => {});
}

function buildSvg(poster, { bgHref, logoHref, font = APP_FONT }) {
  FONT = font;
  return `<svg xmlns="http://www.w3.org/2000/svg" class="gym-poster" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="${esc(FONT)}">` +
    `<image href="${esc(bgHref)}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="none"/>` +
    brandBlock(poster, logoHref) +
    headlineBlock() +
    phoneScreen(poster, logoHref) +
    featureCards() +
    passScreen(poster, logoHref) +
    productBranding(poster, logoHref) +
    qrBlock(poster.svg) +
    scanBadge() +
    stepsBlock() +
    linkBlock(poster.url) +
    `</svg>`;
}

const posterLogo = (poster) => poster.logo_url || getGymLogoUrl();

/**
 * Resolves once every <image> inside `root` has loaded (or failed), so a
 * print dialog never snapshots the poster before its artwork arrives.
 *
 * Must be called as soon as the markup exists, before the node goes into the
 * page: SVG images have no `complete` flag to check afterwards, and a cached
 * picture fires its load event almost at once — listen late and it is missed,
 * leaving only the timeout.
 */
function imagesLoaded(root, timeoutMs = 8000) {
  const images = [...root.querySelectorAll('image')];
  return Promise.race([
    Promise.all(images.map((img) => new Promise((resolve) => {
      img.addEventListener('load', resolve, { once: true });
      img.addEventListener('error', resolve, { once: true });
    }))),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

/**
 * The poster as live DOM, for the preview and the print sheet. `ready`
 * resolves once its pictures have loaded — see imagesLoaded().
 */
export async function gymPosterNode(poster) {
  await fontsReady(`${poster.gym_name} ${poster.tagline || ''} ${poster.url}`);
  const holder = document.createElement('div');
  holder.className = 'gym-poster-wrap';
  holder.innerHTML = buildSvg(poster, { bgHref: BG_URL, logoHref: posterLogo(poster) });
  holder.ready = imagesLoaded(holder);
  return holder;
}

async function toDataUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url}`);
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * The poster as a PNG at twice the artwork's size (2048 × 3072) — enough for
 * a print shop to print it at A4 with the text and QR still crisp.
 */
export async function gymPosterPngBlob(poster) {
  const logoUrl = posterLogo(poster);
  const [bgHref, logoHref] = await Promise.all([
    toDataUrl(BG_URL),
    // A logo that will not load leaves the initials, not a failed download.
    logoUrl ? toDataUrl(logoUrl).catch(() => null) : null,
  ]);

  const markup = buildSvg(poster, { bgHref, logoHref, font: SYSTEM_FONT });
  const svgUrl = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.src = svgUrl;
    await img.decode();
    const scale = 2;
    const canvas = document.createElement('canvas');
    canvas.width = W * scale;
    canvas.height = H * scale;
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
}
