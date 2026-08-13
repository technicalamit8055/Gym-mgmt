/**
 * Draws SeatBook's PWA icon set into public/icons/library/ — run with
 * `npm run icons:gen:library`. A library tenant with no uploaded logo installs
 * with this instead of GymBook's barbell. The generated PNGs are committed,
 * so nobody needs to run this to deploy.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fill, renderIconSet, roundedRect } from './iconRaster.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Matches --brand under [data-brand='library'] in public/css/app.css. */
const COLORS = {
  bg: [0x0d, 0x11, 0x17],
  bgTop: [0x1b, 0x24, 0x31],
  brand: [0x38, 0xbd, 0xf8],
};
const PAGE = [0xe6, 0xed, 0xf5];
const SPINE = [0x0d, 0x11, 0x17];

/**
 * The mark: an open book, viewed from the front — a cover, a spine down the
 * centre, and a ribbon bookmark. Scaled by `k` so the maskable variant can
 * shrink it into its safe zone without a second design, same trick as
 * gen-icons.js's barbell.
 */
function drawBook(c, k) {
  const s = (v) => 0.5 + (v - 0.5) * k;
  const box = (x0, x1, y0, y1, r = 0) => roundedRect(s(x0), s(y0), s(x1), s(y1), r * k);

  // Cover.
  fill(c, PAGE, box(0.22, 0.78, 0.2, 0.8, 0.035));
  // Spine, slightly inset so the cover reads as a border around it.
  fill(c, COLORS.brand, box(0.465, 0.535, 0.2, 0.8));
  // Page-edge accents, top and bottom, so the shape doesn't read as a plain card.
  fill(c, SPINE, box(0.3, 0.42, 0.28, 0.3, 0.006));
  fill(c, SPINE, box(0.58, 0.7, 0.28, 0.3, 0.006));
  fill(c, SPINE, box(0.3, 0.42, 0.37, 0.39, 0.006));
  fill(c, SPINE, box(0.58, 0.7, 0.37, 0.39, 0.006));
  // Ribbon bookmark, hanging from the top edge of the spine.
  fill(c, SPINE, box(0.478, 0.522, 0.2, 0.56));
}

renderIconSet(path.join(ROOT, 'public', 'icons', 'library'), COLORS, drawBook);
