/**
 * Draws CoachBook's PWA icon set into public/icons/coaching/ — run with
 * `npm run icons:gen:coaching`. An institute with no uploaded logo installs
 * with this instead of GymBook's barbell. Also draws the CoachBook Android
 * app's launcher icons and splash screens. The generated PNGs are committed,
 * so nobody needs to run this to deploy.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  centreOnBackground,
  drawIcon,
  drawMarkOnly,
  encodePng,
  fill,
  renderBadge,
  renderIconSet,
  roundedRect,
} from './iconRaster.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Matches --brand under body[data-vertical='coaching'] in public/css/coaching.css. */
const COLORS = {
  bg: [0x0b, 0x0e, 0x1f],
  bgTop: [0x1a, 0x1f, 0x3d],
  brand: [0x81, 0x8c, 0xf8],
};
const CAP = [0xee, 0xf0, 0xff];

/**
 * The mark: a graduation cap — the mortarboard as a flat diamond, the
 * skull-cap band under it, and a tassel hanging off the right corner.
 * Scaled by `k` around the centre, same trick as the other two marks.
 */
function drawCap(c, k) {
  const s = (v) => 0.5 + (v - 0.5) * k;
  const box = (x0, x1, y0, y1, r = 0) => roundedRect(s(x0), s(y0), s(x1), s(y1), r * k);
  const diamond = (cx, cy, hw, hh) => (x, y) => Math.abs(x - s(cx)) / (hw * k) + Math.abs(y - s(cy)) / (hh * k) <= 1;

  // Band under the board, drawn first so the board overlaps its top edge.
  fill(c, COLORS.brand, box(0.33, 0.67, 0.44, 0.66, 0.05));
  // The mortarboard.
  fill(c, CAP, diamond(0.5, 0.4, 0.34, 0.15));
  // Button at the centre of the board.
  fill(c, COLORS.brand, diamond(0.5, 0.4, 0.035, 0.018));
  // Tassel cord down the right side, and its fringe.
  fill(c, COLORS.brand, box(0.745, 0.765, 0.4, 0.66));
  fill(c, COLORS.brand, box(0.725, 0.785, 0.64, 0.74, 0.012));
}

renderIconSet(path.join(ROOT, 'public', 'icons', 'coaching'), COLORS, drawCap);
renderBadge(path.join(ROOT, 'public', 'icons', 'coaching', 'badge-96.png'), drawCap);

/* ------------------------------------------- the CoachBook Android app */

/**
 * The students' app is the `coachbook` build flavor of android/, and these
 * override the GymVym images in android/app/src/main/res: launcher icons,
 * the status-bar icon and the splash screens.
 */
const RES = path.join(ROOT, 'android', 'app', 'src', 'coachbook', 'res');
const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };

/**
 * An adaptive icon's 108dp layers show only the middle 72dp, so the mark is
 * shrunk to sit in that window as it does in the maskable icon's safe zone.
 */
const ADAPTIVE_SCALE = 0.68 * (72 / 108);

function writePng(dir, file, rgba, width, height = width) {
  fs.mkdirSync(path.join(RES, dir), { recursive: true });
  fs.writeFileSync(path.join(RES, dir, file), encodePng(rgba, width, height));
}

for (const [density, k] of Object.entries(DENSITIES)) {
  const legacy = 48 * k;
  const layer = 108 * k;
  writePng(`mipmap-${density}`, 'ic_launcher.png', drawIcon(legacy, { colors: COLORS, drawMark: drawCap }), legacy);
  writePng(`mipmap-${density}`, 'ic_launcher_round.png', drawIcon(legacy, { round: true, scale: 0.86, colors: COLORS, drawMark: drawCap }), legacy);
  writePng(`mipmap-${density}`, 'ic_launcher_foreground.png', drawIcon(layer, { bleed: true, scale: ADAPTIVE_SCALE, colors: COLORS, drawMark: drawCap }), layer);
  writePng(`mipmap-${density}`, 'ic_launcher_monochrome.png', drawMarkOnly(layer, drawCap, ADAPTIVE_SCALE), layer);
  writePng(`drawable-${density}`, 'ic_stat_notify.png', drawMarkOnly(24 * k, drawCap, 1.25), 24 * k);
}

/** Same sizes as the GymVym splash screens they replace. */
const SPLASHES = [
  ['drawable', 480, 320],
  ['drawable-land-mdpi', 480, 320],
  ['drawable-land-hdpi', 800, 480],
  ['drawable-land-xhdpi', 1280, 720],
  ['drawable-land-xxhdpi', 1600, 960],
  ['drawable-land-xxxhdpi', 1920, 1280],
  ['drawable-port-mdpi', 320, 480],
  ['drawable-port-hdpi', 480, 800],
  ['drawable-port-xhdpi', 720, 1280],
  ['drawable-port-xxhdpi', 960, 1600],
  ['drawable-port-xxxhdpi', 1280, 1920],
];
for (const [dir, width, height] of SPLASHES) {
  const tile = Math.round(Math.min(width, height) * 0.3);
  writePng(dir, 'splash.png', centreOnBackground(width, height, COLORS.bg, drawIcon(tile, { colors: COLORS, drawMark: drawCap }), tile), width, height);
}
console.log(`Android app icons and splash screens → ${path.relative(ROOT, RES)}`);
