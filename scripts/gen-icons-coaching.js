/**
 * Draws CoachBook's PWA icon set into public/icons/coaching/ — run with
 * `npm run icons:gen:coaching`. An institute with no uploaded logo installs
 * with this instead of GymBook's barbell. The generated PNGs are committed,
 * so nobody needs to run this to deploy.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fill, renderBadge, renderIconSet, roundedRect } from './iconRaster.js';

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
