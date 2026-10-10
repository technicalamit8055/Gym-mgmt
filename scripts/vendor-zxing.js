/**
 * Regenerates public/js/vendor/zxing-1d.min.js — the product-barcode decoder
 * the member app's food scanner falls back to.
 *
 * Vendored for the same reason as jsQR (see vendor-jsqr.js): public/ is served
 * as static files with no bundler. Only ZXing's EAN/UPC readers are bundled —
 * EAN-13, EAN-8, UPC-A and UPC-E are what grocery packs carry — which keeps the
 * file a fraction of the full library.
 *
 * Usage: npm run vendor:zxing
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from '../src/config.js';

const ZXING_VERSION = '0.23.0';
const ESBUILD_VERSION = '0.24.0';
const OUT = path.join(ROOT, 'public', 'js', 'vendor', 'zxing-1d.min.js');

const HEADER = `/*!
 * @zxing/library v${ZXING_VERSION} (EAN/UPC readers only). Apache-2.0.
 * https://github.com/zxing-js/library
 *
 * Vendored (not a runtime npm dependency) because the browser loads it
 * directly, and only when its native BarcodeDetector cannot read EAN/UPC.
 * Exposes window.GymbookBarcode.decode(luminance, width, height).
 * Regenerate with:  npm run vendor:zxing
 */
`;

// Deep ESM imports: the package root re-exports every symbology plus the
// browser helpers, and esbuild cannot shake them out (the package is not
// marked side-effect free) — 450 KB instead of a few dozen.
const ENTRY = `
import BarcodeFormat from '@zxing/library/esm/core/BarcodeFormat.js';
import BinaryBitmap from '@zxing/library/esm/core/BinaryBitmap.js';
import DecodeHintType from '@zxing/library/esm/core/DecodeHintType.js';
import HybridBinarizer from '@zxing/library/esm/core/common/HybridBinarizer.js';
import RGBLuminanceSource from '@zxing/library/esm/core/RGBLuminanceSource.js';
import MultiFormatUPCEANReader from '@zxing/library/esm/core/oned/MultiFormatUPCEANReader.js';

const hints = new Map([
  [DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E]],
  [DecodeHintType.TRY_HARDER, true],
]);
const reader = new MultiFormatUPCEANReader(hints);

// luminance: one greyscale byte per pixel, row-major.
export function decode(luminance, width, height) {
  try {
    const bitmap = new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(luminance, width, height)));
    return reader.decode(bitmap, hints).getText();
  } catch {
    // NotFound / checksum / format errors all mean "no barcode in this frame".
    return null;
  } finally {
    reader.reset();
  }
}
`;

const sh = (command, cwd) => execSync(command, { cwd, stdio: 'inherit' });
const q = (value) => JSON.stringify(value);

const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-zxing-'));

try {
  console.log(`Fetching @zxing/library@${ZXING_VERSION}…`);
  fs.writeFileSync(path.join(staging, 'package.json'), '{"private":true}');
  sh(`npm install @zxing/library@${ZXING_VERSION} --no-audit --no-fund --loglevel=error`, staging);
  fs.writeFileSync(path.join(staging, 'entry.js'), ENTRY);

  console.log('Bundling…');
  const bundled = path.join(staging, 'zxing-1d.min.js');
  sh(
    `npx --yes esbuild@${ESBUILD_VERSION} entry.js --bundle --minify --legal-comments=none ` +
      `--format=iife --global-name=GymbookBarcode --target=es2018 --outfile=${q(bundled)}`,
    staging,
  );

  const bundle = fs.readFileSync(bundled, 'utf8');
  // Smoke test: the global must exist and a blank frame must read as "none".
  const probe = new Function(`${bundle}; return GymbookBarcode;`)();
  if (typeof probe?.decode !== 'function') {
    throw new Error('Bundle does not define GymbookBarcode.decode — refusing to write it');
  }
  if (probe.decode(new Uint8ClampedArray(64 * 64).fill(255), 64, 64) !== null) {
    throw new Error('Bundle decoded a barcode from a blank frame — refusing to write it');
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  // The IIFE declares a top-level `var GymbookBarcode`, which a classic
  // <script> makes a window global.
  fs.writeFileSync(OUT, HEADER + bundle);
  console.log(`Wrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}
