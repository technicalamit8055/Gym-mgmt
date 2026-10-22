import { isNativeApp, serverUrl } from './api.js';
import { BODY_H, BODY_W, bodyFigure, musclesWorked } from './bodyMap.js';
import { h, initials, openModal, renderIcon, toast } from './ui.js';
import { muscleSplit, setsByExercise, workoutTimeLabel } from './workoutDetail.js';

/**
 * Hevy's "Share workout": a row of square cards about one finished session —
 * what was done, the muscles it hit, its records and numbers — that the member
 * swipes through and shares whichever one they stop on, as a picture.
 *
 * Every card is one SVG string, 1080 × 1080 (Instagram's square). It is shown
 * inline in the carousel and rasterised for the PNG, so what is shared is what
 * was on screen. The gym's logo and name head every card, where Hevy puts its
 * own, and the highlights are the gym's brand colour.
 *
 * Text is set in the device's UI font, not the app's web font: an SVG drawn as
 * an image is snapshotted before a web font loads (see gymPoster.js), and the
 * preview has to wrap and clip exactly as the picture does.
 */

const SIZE = 1080;
const PAD = 70;
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

const LIGHT = { bg: '#ffffff', ink: '#111827', muted: '#6b7280', faint: '#f4f5f7', tile: '#e8eaee', skin: '#e3e6ea', muscle: '#c9ced6' };
const DARK = { bg: '#1f2023', ink: '#f3f4f6', muted: '#9ca3af', faint: '#26272b', tile: '#33353a', skin: '#3a3c42', muscle: '#55585f' };

/** Things that weigh about as much as a session's volume, lightest first. */
const COMPARISONS = [
  { kg: 4, emoji: '🐈', one: 'a cat', many: 'cats' },
  { kg: 30, emoji: '🐕', one: 'a golden retriever', many: 'golden retrievers' },
  { kg: 100, emoji: '🐼', one: 'a giant panda', many: 'giant pandas' },
  { kg: 190, emoji: '🦁', one: 'a lion', many: 'lions' },
  { kg: 300, emoji: '🐻', one: 'a grizzly bear', many: 'grizzly bears' },
  { kg: 500, emoji: '🐎', one: 'a horse', many: 'horses' },
  { kg: 1400, emoji: '🚗', one: 'a car', many: 'cars' },
  { kg: 1800, emoji: '🦛', one: 'a hippo', many: 'hippos' },
  { kg: 2300, emoji: '🦏', one: 'a rhino', many: 'rhinos' },
  { kg: 6000, emoji: '🐘', one: 'an elephant', many: 'elephants' },
  { kg: 7000, emoji: '🦖', one: 'a T-rex', many: 'T-rexes' },
  { kg: 12000, emoji: '🚌', one: 'a bus', many: 'buses' },
  { kg: 30000, emoji: '🐋', one: 'a humpback whale', many: 'humpback whales' },
  { kg: 41000, emoji: '✈️', one: 'a passenger jet', many: 'passenger jets' },
];

/** The radar's six regions, at the angle Hevy draws each (degrees, counter-
 * clockwise from the right). Cardio and full-body have no spoke. */
const RADAR = [
  ['Chest', 0],
  ['Arms', 60],
  ['Core', 120],
  ['Shoulders', 180],
  ['Back', 240],
  ['Legs', 300],
];

const RECORD_LABEL = { best_1rm: 'Best One Rep Max', heaviest_weight: 'Heaviest Weight Lifted' };

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let measureCtx;
function textWidth(text, size, weight) {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  measureCtx.font = `${weight} ${size}px ${FONT}`;
  return measureCtx.measureText(text).width;
}

/** `text` cut to fit `max` pixels, with an ellipsis when anything went. */
function fit(text, max, size, weight = 400) {
  const full = String(text ?? '');
  if (textWidth(full, size, weight) <= max) return full;
  let lo = 0;
  let hi = full.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (textWidth(`${full.slice(0, mid).trimEnd()}…`, size, weight) <= max) lo = mid;
    else hi = mid - 1;
  }
  return `${full.slice(0, lo).trimEnd()}…`;
}

function text(x, y, value, { size, weight = 400, fill, anchor = 'start', max = SIZE - 2 * PAD }) {
  return `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(fit(value, max, size, weight))}</text>`;
}

/** A stroke icon from ui.js, as markup placed in the card. */
function icon(name, { x, y, size, color, stroke = 2 }) {
  const node = renderIcon(name, { size, stroke });
  node.setAttribute('x', x);
  node.setAttribute('y', y);
  node.setAttribute('style', `color:${color}`);
  return node.outerHTML;
}

const formatNumber = (value, digits) => Number(value).toLocaleString(undefined, { maximumFractionDigits: digits });

/** The thing the volume is most like, and how many of it. */
export function volumeComparison(kg) {
  const match = COMPARISONS.findLast((item) => item.kg <= kg);
  if (!match) return null;
  const count = Math.floor(kg / match.kg);
  return { emoji: match.emoji, phrase: count >= 2 ? `${formatNumber(count, 0)} ${match.many}` : match.one };
}

/**
 * The radar's outline: each region a 60° wedge out to its share, joined along
 * the spokes between them — the petal shape on Hevy's muscle-split card.
 */
export function radarPath(values, { cx, cy, radius }) {
  const max = Math.max(...values);
  if (!(max > 0)) return null;
  const point = (r, deg) => {
    const rad = (deg * Math.PI) / 180;
    return `${(cx + r * Math.cos(rad)).toFixed(1)} ${(cy - r * Math.sin(rad)).toFixed(1)}`;
  };
  let d = `M${cx} ${cy}`;
  RADAR.forEach(([, deg], i) => {
    const r = (values[i] / max) * radius;
    d += ` L${point(r, deg - 30)} A${r.toFixed(1)} ${r.toFixed(1)} 0 0 0 ${point(r, deg + 30)}`;
  });
  return `${d} Z`;
}

/**
 * The cards for one session, in carousel order. Cards with nothing to say are
 * left out: no PR cards without records, no body without a muscle, no radar
 * for a cardio-only day.
 *
 *   log       a workout_logs row with its `sets` and `records`
 *   person    { first_name, last_name }
 *   images    { logo, avatar } hrefs (URLs for the preview, data URLs to rasterise)
 *   gymName, accent, unit, toDisplay as in openWorkoutShare
 */
export function buildCards(log, { person, gymName, images, accent, unit, toDisplay }) {
  const byExercise = setsByExercise(log.sets);
  const volumeKg = Number(log.total_volume_kg) || 0;
  const volume = `${formatNumber(toDisplay(volumeKg), 1)} ${unit}`;
  const duration = workoutTimeLabel(log.duration_seconds);
  const lit = musclesWorked(log.sets.filter((set) => set.set_type !== 'warmup').map((set) => set.muscle_group));
  const strengthMuscles = [...lit].some((group) => group !== 'cardio' && group !== 'other');
  const name = `${person.first_name ?? ''} ${person.last_name ?? ''}`.trim();

  const card = (theme, body) => {
    const t = theme;
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}" font-family="${esc(FONT)}">` +
      `<rect width="${SIZE}" height="${SIZE}" fill="${t.bg}"/>` +
      // Hevy's faint watermark shapes, here two rounded bars.
      `<g fill="none" stroke="${t.faint}" stroke-width="64">` +
      `<rect x="250" y="420" width="380" height="720" rx="150" transform="rotate(-22 440 780)"/>` +
      `<rect x="560" y="-120" width="380" height="720" rx="150" transform="rotate(-22 750 240)"/></g>` +
      header(t, `av-${cards.length}`) +
      body +
      `</svg>`
    );
  };

  function header(t, clipId) {
    const logoSize = 76;
    const avatarR = 34;
    const nameMax = 330;
    const nameText = fit(name, nameMax, 38, 500);
    const nameW = textWidth(nameText, 38, 500);
    const avatarCx = SIZE - PAD - nameW - 18 - avatarR;
    const gymX = PAD + (images.logo ? logoSize + 22 : 0);
    const gymMax = avatarCx - avatarR - 40 - gymX;
    const avatar = images.avatar
      ? `<clipPath id="${clipId}"><circle cx="${avatarCx}" cy="110" r="${avatarR}"/></clipPath>` +
        `<image href="${esc(images.avatar)}" x="${avatarCx - avatarR}" y="${110 - avatarR}" width="${2 * avatarR}" height="${2 * avatarR}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${clipId})"/>`
      : `<circle cx="${avatarCx}" cy="110" r="${avatarR}" fill="${accent}"/>` +
        text(avatarCx, 122, initials(person.first_name, person.last_name), { size: 28, weight: 700, fill: '#fff', anchor: 'middle' });
    return (
      (images.logo
        ? `<image href="${esc(images.logo)}" x="${PAD}" y="${110 - logoSize / 2}" width="${logoSize}" height="${logoSize}" preserveAspectRatio="xMidYMid meet"/>`
        : '') +
      text(gymX, 126, gymName, { size: 44, weight: 800, fill: t.ink, max: gymMax }) +
      avatar +
      `<text x="${SIZE - PAD}" y="123" font-size="38" font-weight="500" fill="${t.ink}" text-anchor="end">${esc(nameText)}</text>`
    );
  }

  const colors = (t) => ({ skin: t.skin, muscle: t.muscle, accent, line: t.bg });
  const statRow = (t, y) => {
    const cell = (x, anchor, label, value) =>
      text(x, y, label, { size: 34, fill: t.muted, anchor }) + text(x, y + 56, value, { size: 46, weight: 500, fill: t.ink, anchor });
    return cell(PAD + 120, 'middle', 'Duration', duration) + cell(SIZE / 2, 'middle', 'Volume', volume) + cell(SIZE - PAD - 120, 'middle', 'Sets', String(log.total_sets));
  };

  const cards = [];

  // 1 · The exercise list, with the body beside it.
  {
    const rows = [...byExercise];
    const shown = rows.length > 10 ? rows.slice(0, 9) : rows;
    const lines = shown.map(([exercise, sets]) => `${sets.length} × ${exercise}`);
    if (shown.length < rows.length) lines.push(`+ ${rows.length - shown.length} more`);
    const textMax = strengthMuscles ? 640 : SIZE - 2 * PAD;
    const lineH = 60;
    const blockH = 80 + lines.length * lineH;
    const top = Math.max(220, 190 + (SIZE - 190 - blockH) / 2);
    const figureH = 390;
    const figureW = (figureH * BODY_W) / BODY_H;
    const figureX = SIZE - PAD - figureW + 10;
    cards.push({
      id: 'exercises',
      label: 'Exercises',
      svg: card(
        LIGHT,
        text(PAD, top + 50, log.workout_name, { size: 54, weight: 700, fill: LIGHT.ink, max: textMax }) +
          lines.map((line, i) => text(PAD, top + 130 + i * lineH, line, { size: 38, fill: LIGHT.ink, max: textMax })).join('') +
          (strengthMuscles
            ? bodyFigure('front', lit, { x: figureX, y: 190, height: figureH, colors: colors(LIGHT) }) +
              bodyFigure('back', lit, { x: figureX, y: 600, height: figureH, colors: colors(LIGHT) })
            : ''),
      ),
    });
  }

  // 2 · Front and back, big, over the headline numbers.
  if (strengthMuscles) {
    const figureH = 600;
    const figureW = (figureH * BODY_W) / BODY_H;
    const gap = 40;
    const x = (SIZE - 2 * figureW - gap) / 2;
    cards.push({
      id: 'body',
      label: 'Muscles',
      svg: card(
        LIGHT,
        bodyFigure('front', lit, { x, y: 200, height: figureH, colors: colors(LIGHT) }) +
          bodyFigure('back', lit, { x: x + figureW + gap, y: 200, height: figureH, colors: colors(LIGHT) }) +
          statRow(LIGHT, 900),
      ),
    });
  }

  // 3 · One card per record, under a medal.
  const medal =
    `<g transform="translate(${SIZE / 2} 410)">` +
    `<path d="M-46 30 L-78 118 L-44 104 L-26 138 L4 56 Z" fill="#f59e0b"/>` +
    `<path d="M46 30 L78 118 L44 104 L26 138 L-4 56 Z" fill="#f59e0b"/>` +
    `<circle cx="0" cy="-12" r="76" fill="#facc15"/><circle cx="0" cy="-12" r="58" fill="none" stroke="#eab308" stroke-width="6"/></g>`;
  for (const record of log.records ?? []) {
    cards.push({
      id: `record-${record.kind}-${record.exercise_name}`,
      label: 'Record',
      svg: card(
        LIGHT,
        medal +
          text(SIZE / 2, 680, `${formatNumber(toDisplay(record.value_kg), 2)} ${unit}`, { size: 104, weight: 700, fill: LIGHT.ink, anchor: 'middle' }) +
          text(SIZE / 2, 760, record.exercise_name, { size: 46, weight: 500, fill: LIGHT.ink, anchor: 'middle' }) +
          text(SIZE / 2, 830, RECORD_LABEL[record.kind] ?? 'Personal record', { size: 40, fill: LIGHT.muted, anchor: 'middle' }),
      ),
    });
  }

  // 4 · The volume, as something it weighs about as much as.
  const like = volumeComparison(volumeKg);
  if (like) {
    cards.push({
      id: 'volume',
      label: 'Volume',
      svg: card(
        LIGHT,
        `<text x="${SIZE / 2}" y="600" font-size="300" text-anchor="middle">${like.emoji}</text>` +
          text(SIZE / 2, 760, `You lifted a total of ${volume}`, { size: 52, weight: 700, fill: LIGHT.ink, anchor: 'middle' }) +
          text(SIZE / 2, 840, `That's like lifting ${like.phrase}!`, { size: 40, fill: LIGHT.muted, anchor: 'middle' }),
      ),
    });
  }

  // 5 · The four headline numbers as tiles.
  {
    const gap = 24;
    const tileW = (SIZE - 2 * PAD - gap) / 2;
    const tileH = 336;
    const tile = (col, row, iconName, value, label) => {
      const x = PAD + col * (tileW + gap);
      const y = 290 + row * (tileH + gap);
      const cx = x + tileW / 2;
      return (
        `<rect x="${x}" y="${y}" width="${tileW}" height="${tileH}" rx="28" fill="${LIGHT.bg}" stroke="${LIGHT.tile}" stroke-width="3"/>` +
        icon(iconName, { x: cx - 48, y: y + 56, size: 96, color: accent, stroke: 2.2 }) +
        text(cx, y + 226, value, { size: 54, weight: 700, fill: LIGHT.ink, anchor: 'middle', max: tileW - 40 }) +
        text(cx, y + 282, label, { size: 38, fill: LIGHT.muted, anchor: 'middle', max: tileW - 40 })
      );
    };
    cards.push({
      id: 'stats',
      label: 'Stats',
      svg: card(
        LIGHT,
        text(SIZE / 2, 222, log.workout_name, { size: 48, weight: 700, fill: LIGHT.ink, anchor: 'middle' }) +
          tile(0, 0, 'timer', duration, 'Duration') +
          tile(1, 0, 'muscleArm', String(byExercise.size), byExercise.size === 1 ? 'Exercise' : 'Exercises') +
          tile(0, 1, 'refreshCw', String(log.total_sets), log.total_sets === 1 ? 'Set' : 'Sets') +
          tile(1, 1, 'weight', volume, 'Volume'),
      ),
    });
  }

  // 6 · The muscle split as a radar, on dark as Hevy has it.
  {
    const split = new Map(muscleSplit(log.sets).map(({ label, pct }) => [label, pct]));
    const values = RADAR.map(([label]) => split.get(label) ?? 0);
    const cx = SIZE / 2;
    const cy = 520;
    const radius = 230;
    const d = radarPath(values, { cx, cy, radius });
    if (d) {
      const spokes = RADAR.map(([, deg]) => {
        const rad = (deg * Math.PI) / 180;
        return `<line x1="${cx}" y1="${cy}" x2="${(cx + radius * Math.cos(rad)).toFixed(1)}" y2="${(cy - radius * Math.sin(rad)).toFixed(1)}"/>`;
      }).join('');
      const labels = RADAR.map(([label, deg]) => {
        const rad = (deg * Math.PI) / 180;
        const lx = cx + (radius + 40) * Math.cos(rad);
        const ly = cy - (radius + 40) * Math.sin(rad) + 14;
        const anchor = deg === 0 ? 'start' : deg === 180 ? 'end' : 'middle';
        const nudge = deg === 0 || deg === 180 ? 0 : deg < 180 ? -16 : 24;
        return text(lx, ly + nudge, label, { size: 40, fill: DARK.ink, anchor, max: 300 });
      }).join('');
      cards.push({
        id: 'split',
        label: 'Muscle split',
        svg: card(
          DARK,
          `<g stroke="${DARK.muted}" stroke-opacity="0.6" stroke-width="2">${spokes}</g>` +
            `<path d="${d}" fill="${accent}" fill-opacity="0.22" stroke="${accent}" stroke-width="6" stroke-linejoin="round"/>` +
            labels +
            statRow(DARK, 900),
        ),
      });
    }
  }

  return cards;
}

/** The theme's brand colour, so the cards match the gym's app. */
function brandColor() {
  const value = getComputedStyle(document.documentElement).getPropertyValue('--brand').trim();
  return value || '#f97316';
}

async function toDataUrl(url) {
  // Past the HTTP cache: the app's <img> tags already fetched the photo and
  // logo without an Origin, and that cached copy (immutable, no CORS header)
  // would fail this cross-origin read in the native app.
  const res = await fetch(serverUrl(url), { cache: 'no-store' });
  if (!res.ok) throw new Error(`Could not load ${url}`);
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** One card's SVG as a 1080 × 1080 PNG. */
async function pngBlob(svg) {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
    canvas.getContext('2d').drawImage(img, 0, 0, SIZE, SIZE);
    return await new Promise((resolve, reject) =>
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not draw the card'))), 'image/png'),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

const blobBase64 = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

/** The Capacitor plugins are called through the bridge, as nativePermissions.js
 * does: the page has no bundler to import their JS with. */
const native = (plugin, method, options) => window.Capacitor.nativePromise(plugin, method, options);
const cancelled = (err) => err?.name === 'AbortError' || /cancel/i.test(String(err?.message ?? err));

function downloadInBrowser(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function shareImage(blob, filename, title) {
  if (isNativeApp) {
    const { uri } = await native('Filesystem', 'writeFile', {
      path: `share/${filename}`,
      data: await blobBase64(blob),
      directory: 'CACHE',
      recursive: true,
    });
    await native('Share', 'share', { title, files: [uri], dialogTitle: 'Share workout' });
    return;
  }
  const file = new File([blob], filename, { type: 'image/png' });
  if (navigator.canShare?.({ files: [file] })) {
    await navigator.share({ files: [file], title });
    return;
  }
  // A desktop browser that cannot hand a picture to another app.
  downloadInBrowser(blob, filename);
  toast('Card saved — post it from your downloads');
}

async function saveImage(blob, filename, title) {
  if (!isNativeApp) {
    downloadInBrowser(blob, filename);
    return;
  }
  try {
    await native('Filesystem', 'writeFile', {
      path: `GymVym/${filename}`,
      data: await blobBase64(blob),
      directory: 'DOCUMENTS',
      recursive: true,
    });
    toast('Saved to Documents/GymVym');
  } catch {
    // Older Androids keep Documents behind a storage permission; the share
    // sheet's "Save to…" targets need none.
    await shareImage(blob, filename, title);
  }
}

/**
 * Opens the share sheet for a finished session (`log` as the workout detail
 * endpoint returns it, records included).
 *
 *   person     { first_name, last_name, photo_url }
 *   gym        { name, logoUrl }
 *   unit       the member's weight unit; toDisplay converts kg into it
 *   text       the plain-text summary Copy puts on the clipboard
 */
export function openWorkoutShare(log, { person, gym, unit = 'kg', toDisplay = (kg) => kg, text: summary }) {
  const accent = brandColor();
  const options = { person, gymName: gym.name, accent, unit, toDisplay };
  const cards = buildCards(log, { ...options, images: { logo: gym.logoUrl ? serverUrl(gym.logoUrl) : null, avatar: person.photo_url ? serverUrl(person.photo_url) : null } });

  // The picture needs its images inlined: an SVG drawn as an image fetches
  // nothing. Started now so it is usually ready by the first tap.
  const exportCards = Promise.all([
    gym.logoUrl ? toDataUrl(gym.logoUrl).catch(() => null) : null,
    person.photo_url ? toDataUrl(person.photo_url).catch(() => null) : null,
  ]).then(([logo, avatar]) => buildCards(log, { ...options, images: { logo, avatar } }));

  let current = 0;
  const slides = cards.map((c) => {
    const slide = h('div', { class: 'share-cards-slide', role: 'group', 'aria-label': c.label });
    slide.innerHTML = c.svg;
    return slide;
  });
  const track = h('div', { class: 'share-cards-track' }, ...slides);
  const dots = cards.map((c, i) =>
    h('button', {
      class: `share-cards-dot${i === 0 ? ' is-active' : ''}`,
      type: 'button',
      'aria-label': `${c.label} card`,
      onclick: () => track.scrollTo({ left: i * track.clientWidth, behavior: 'smooth' }),
    }),
  );
  track.addEventListener(
    'scroll',
    () => {
      const index = Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
      if (index === current || !dots[index]) return;
      dots[current].classList.remove('is-active');
      dots[index].classList.add('is-active');
      current = index;
    },
    { passive: true },
  );

  const slug = String(log.workout_name || 'workout')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  let busy = false;
  const withCard = (run, failure) => async () => {
    if (busy) return;
    busy = true;
    try {
      const card = (await exportCards)[current];
      await run(await pngBlob(card.svg), `${slug || 'workout'}-${card.id.replace(/[^a-z0-9-]+/gi, '-').toLowerCase()}.png`);
    } catch (err) {
      if (!cancelled(err)) toast(failure, 'error');
    } finally {
      busy = false;
    }
  };

  const action = (iconName, label, onclick) =>
    h(
      'button',
      { class: 'share-cards-action', type: 'button', onclick },
      h('span', { class: 'share-cards-action-icon' }, renderIcon(iconName, { size: 24, stroke: 2 })),
      h('span', {}, label),
    );

  openModal({
    title: 'Share',
    className: 'share-cards-modal',
    body: h(
      'div',
      { class: 'share-cards' },
      track,
      h('div', { class: 'share-cards-dots' }, ...dots),
      h('p', { class: 'share-cards-caption' }, 'Share your workout'),
      h(
        'div',
        { class: 'share-cards-actions' },
        action('upload', 'Share', withCard((blob, name) => shareImage(blob, name, log.workout_name), 'Could not share this card')),
        summary
          ? action('copy', 'Copy text', async () => {
              try {
                await navigator.clipboard.writeText(summary);
                toast('Workout copied — paste it anywhere');
              } catch {
                toast('Could not copy the workout', 'error');
              }
            })
          : null,
        action('download', 'Download', withCard((blob, name) => saveImage(blob, name, log.workout_name), 'Could not save this card')),
      ),
    ),
  });
}
