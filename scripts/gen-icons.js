/**
 * Draws the PWA icon set into public/icons/ — run with `npm run icons:gen`.
 *
 * Hand-rolled rasteriser and PNG encoder rather than a dependency: the icons
 * change roughly never, and a build-time image library (sharp, canvas) would
 * add a native compile step to a project that otherwise installs in seconds.
 * The generated PNGs are committed, so nobody needs to run this to deploy.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'public', 'icons');

/** Matches the app's own palette (see :root in public/css/app.css). */
const BG = [0x0d, 0x11, 0x17];
const BG_TOP = [0x1b, 0x24, 0x31];
const BRAND = [0xf9, 0x73, 0x16];
const BAR = [0xe6, 0xed, 0xf5];

/** Edges are anti-aliased by rendering at this multiple and averaging down. */
const SS = 4;

/* ------------------------------------------------------------- rasteriser */

/** An RGBA canvas in straight (non-premultiplied) 0..1 floats. */
function canvas(size) {
  return { size, px: new Float32Array(size * size * 4) };
}

function blend(c, i, [r, g, b], alpha) {
  if (alpha <= 0) return;
  const da = c.px[i + 3];
  const out = alpha + da * (1 - alpha);
  if (out <= 0) return;
  c.px[i] = (r / 255) * alpha + c.px[i] * da * (1 - alpha);
  c.px[i + 1] = (g / 255) * alpha + c.px[i + 1] * da * (1 - alpha);
  c.px[i + 2] = (b / 255) * alpha + c.px[i + 2] * da * (1 - alpha);
  c.px[i + 3] = out;
  // Straight alpha: un-premultiply the colour we just accumulated.
  c.px[i] /= out;
  c.px[i + 1] /= out;
  c.px[i + 2] /= out;
}

/**
 * Fills every pixel whose centre satisfies `inside(x, y)`, where x and y are
 * unit coordinates (0..1) so shapes are written once and scale to any size.
 */
function fill(c, color, inside, alphaAt) {
  for (let y = 0; y < c.size; y++) {
    const uy = (y + 0.5) / c.size;
    for (let x = 0; x < c.size; x++) {
      const ux = (x + 0.5) / c.size;
      if (!inside(ux, uy)) continue;
      blend(c, (y * c.size + x) * 4, color, alphaAt ? alphaAt(ux, uy) : 1);
    }
  }
}

/** Rounded-rectangle hit test in unit coordinates. */
const roundedRect = (x0, y0, x1, y1, r) => (x, y) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const dx = Math.max(x0 + r - x, 0, x - (x1 - r));
  const dy = Math.max(y0 + r - y, 0, y - (y1 - r));
  return dx * dx + dy * dy <= r * r;
};

/**
 * The mark itself: a barbell, drawn about the centre and scaled by `k` so the
 * maskable variant can shrink it into its safe zone without a second design.
 */
function drawBarbell(c, k) {
  const s = (v) => 0.5 + (v - 0.5) * k;
  const plate = (x0, x1, y0, y1) => roundedRect(s(x0), s(y0), s(x1), s(y1), 0.028 * k);

  fill(c, BAR, plate(0.235, 0.765, 0.474, 0.526));
  // Inboard plates are the tall pair; the end collars sit outside them.
  fill(c, BRAND, plate(0.3, 0.378, 0.315, 0.685));
  fill(c, BRAND, plate(0.622, 0.7, 0.315, 0.685));
  fill(c, BRAND, plate(0.208, 0.272, 0.383, 0.617));
  fill(c, BRAND, plate(0.728, 0.792, 0.383, 0.617));
}

/**
 * @param {number} size    pixel width/height of the finished icon
 * @param {object} options
 * @param {boolean} options.bleed  square background (Apple + maskable) rather
 *                                 than a rounded tile with clear corners
 * @param {number} options.scale   size of the mark relative to the canvas
 */
function drawIcon(size, { bleed = false, scale = 1 } = {}) {
  const c = canvas(size * SS);
  const shape = bleed ? () => true : roundedRect(0, 0, 1, 1, 0.22);

  fill(c, BG, shape);
  // A soft top-left glow in the brand colour, so the tile is not flat black.
  fill(c, BG_TOP, shape, (x, y) => {
    const d = Math.hypot(x - 0.28, y - 0.1);
    return Math.max(0, 1 - d / 0.95) * 0.85;
  });
  fill(c, BRAND, shape, (x, y) => {
    const d = Math.hypot(x - 0.3, y - 0.08);
    return Math.max(0, 1 - d / 0.8) * 0.13;
  });

  drawBarbell(c, scale);
  return downsample(c, size);
}

/** Averages the supersampled canvas down, in premultiplied space so that
 * edge pixels do not pick up colour from fully transparent neighbours. */
function downsample(c, size) {
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * c.size + (x * SS + sx)) * 4;
          const pa = c.px[i + 3];
          r += c.px[i] * pa;
          g += c.px[i + 1] * pa;
          b += c.px[i + 2] * pa;
          a += pa;
        }
      }
      const n = SS * SS;
      const o = (y * size + x) * 4;
      out[o] = a > 0 ? Math.round((r / a) * 255) : 0;
      out[o + 1] = a > 0 ? Math.round((g / a) * 255) : 0;
      out[o + 2] = a > 0 ? Math.round((b / a) * 255) : 0;
      out[o + 3] = Math.round((a / n) * 255);
    }
  }
  return out;
}

/* ------------------------------------------------------------ png encoder */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** 8-bit RGBA (colour type 6), one filter byte per scanline, filter 0. */
function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* --------------------------------------------------------------------- run */

const ICONS = [
  // Android / Chrome install + the manifest's "any" purpose.
  { file: 'icon-192.png', size: 192 },
  { file: 'icon-512.png', size: 512 },
  // Maskable: full bleed, mark shrunk into the 80% safe zone so Android can
  // crop it to a circle, squircle or teardrop without clipping the barbell.
  { file: 'maskable-192.png', size: 192, bleed: true, scale: 0.68 },
  { file: 'maskable-512.png', size: 512, bleed: true, scale: 0.68 },
  // iOS masks the corners itself and renders transparency as black, so the
  // home-screen icon has to be an opaque square.
  { file: 'apple-touch-icon.png', size: 180, bleed: true, scale: 0.86 },
  { file: 'favicon-32.png', size: 32 },
];

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const { file, size, bleed, scale } of ICONS) {
  const png = encodePng(drawIcon(size, { bleed, scale }), size);
  fs.writeFileSync(path.join(OUT_DIR, file), png);
  console.log(`${file.padEnd(22)} ${size}×${size}  ${(png.length / 1024).toFixed(1)} kB`);
}
