/**
 * Shared rasteriser + PNG encoder behind gen-icons.js (GymBook's barbell) and
 * gen-icons-library.js (SeatBook's book) — extracted once a second brand mark
 * needed the exact same supersample-and-encode pipeline. Hand-rolled rather
 * than a dependency: the icons change roughly never, and a build-time image
 * library (sharp, canvas) would add a native compile step to a project that
 * otherwise installs in seconds.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/** Edges are anti-aliased by rendering at this multiple and averaging down. */
export const SS = 4;

/** An RGBA canvas in straight (non-premultiplied) 0..1 floats. */
export function canvas(size) {
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
export function fill(c, color, inside, alphaAt) {
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
export const roundedRect = (x0, y0, x1, y1, r) => (x, y) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const dx = Math.max(x0 + r - x, 0, x - (x1 - r));
  const dy = Math.max(y0 + r - y, 0, y - (y1 - r));
  return dx * dx + dy * dy <= r * r;
};

/** A soft radial glow, in the shape's own colour, so a tile is not flat. */
export const glow = (cx, cy, radius, peak) => (x, y) => {
  const d = Math.hypot(x - cx, y - cy);
  return Math.max(0, 1 - d / radius) * peak;
};

/**
 * @param {number} size    pixel width/height of the finished icon
 * @param {object} options
 * @param {boolean} options.bleed  square background (Apple + maskable) rather
 *                                 than a rounded tile with clear corners
 * @param {number} options.scale   size of the mark relative to the canvas
 * @param {{bg:number[], bgTop:number[], brand:number[]}} options.colors
 * @param {(c: object, k: number) => void} options.drawMark
 */
export function drawIcon(size, { bleed = false, scale = 1, colors, drawMark }) {
  const c = canvas(size * SS);
  const shape = bleed ? () => true : roundedRect(0, 0, 1, 1, 0.22);

  fill(c, colors.bg, shape);
  fill(c, colors.bgTop, shape, glow(0.28, 0.1, 0.95, 0.85));
  fill(c, colors.brand, shape, glow(0.3, 0.08, 0.8, 0.13));

  drawMark(c, scale);
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
export function encodePng(rgba, size) {
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

/** The size/variant matrix every brand's icon set shares. */
export const ICON_SPECS = [
  { file: 'icon-192.png', size: 192 },
  { file: 'icon-512.png', size: 512 },
  // Maskable: full bleed, mark shrunk into the 80% safe zone so Android can
  // crop it to a circle, squircle or teardrop without clipping the mark.
  { file: 'maskable-192.png', size: 192, bleed: true, scale: 0.68 },
  { file: 'maskable-512.png', size: 512, bleed: true, scale: 0.68 },
  // iOS masks the corners itself and renders transparency as black, so the
  // home-screen icon has to be an opaque square.
  { file: 'apple-touch-icon.png', size: 180, bleed: true, scale: 0.86 },
  { file: 'favicon-32.png', size: 32 },
];

export function renderIconSet(outDir, colors, drawMark, specs = ICON_SPECS) {
  fs.mkdirSync(outDir, { recursive: true });
  for (const { file, size, bleed, scale } of specs) {
    const png = encodePng(drawIcon(size, { bleed, scale, colors, drawMark }), size);
    fs.writeFileSync(path.join(outDir, file), png);
    console.log(`${file.padEnd(22)} ${size}×${size}  ${(png.length / 1024).toFixed(1)} kB`);
  }
}
