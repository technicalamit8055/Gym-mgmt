/**
 * Draws GymBook's PWA icon set into public/icons/ — run with `npm run icons:gen`.
 * The generated PNGs are committed, so nobody needs to run this to deploy.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fill, renderIconSet, roundedRect } from './iconRaster.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Matches the app's own palette (see :root in public/css/app.css). */
const COLORS = {
  bg: [0x0d, 0x11, 0x17],
  bgTop: [0x1b, 0x24, 0x31],
  brand: [0xf9, 0x73, 0x16],
};
const BAR = [0xe6, 0xed, 0xf5];

/**
 * The mark itself: a barbell, drawn about the centre and scaled by `k` so the
 * maskable variant can shrink it into its safe zone without a second design.
 */
function drawBarbell(c, k) {
  const s = (v) => 0.5 + (v - 0.5) * k;
  const plate = (x0, x1, y0, y1) => roundedRect(s(x0), s(y0), s(x1), s(y1), 0.028 * k);

  fill(c, BAR, plate(0.235, 0.765, 0.474, 0.526));
  // Inboard plates are the tall pair; the end collars sit outside them.
  fill(c, COLORS.brand, plate(0.3, 0.378, 0.315, 0.685));
  fill(c, COLORS.brand, plate(0.622, 0.7, 0.315, 0.685));
  fill(c, COLORS.brand, plate(0.208, 0.272, 0.383, 0.617));
  fill(c, COLORS.brand, plate(0.728, 0.792, 0.383, 0.617));
}

renderIconSet(path.join(ROOT, 'public', 'icons'), COLORS, drawBarbell);
