/**
 * Regenerates public/js/vendor/jsqr.min.js.
 *
 * jsQR is vendored rather than declared as a dependency: public/ is served as
 * static files with no bundler, so the browser has to be able to fetch the file
 * by URL. This script exists so that vendored blob is reproducible instead of
 * being a mystery — it pins the versions and records how the file was built.
 *
 * Usage: npm run vendor:jsqr
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from '../src/config.js';

const JSQR_VERSION = '1.4.0';
const ESBUILD_VERSION = '0.24.0';
const OUT = path.join(ROOT, 'public', 'js', 'vendor', 'jsqr.min.js');

const HEADER = `/*!
 * jsQR v${JSQR_VERSION} — pure-JS QR decoder. Apache-2.0.
 * https://github.com/cozmo/jsQR
 *
 * Vendored (not a runtime npm dependency) because the browser loads it
 * directly: this app serves public/ as static files with no bundler, and the
 * file is fetched on demand only by browsers whose native BarcodeDetector is
 * missing. Regenerate with:  npm run vendor:jsqr
 */
`;

/** Runs through a shell: npm and npx are .cmd shims on Windows, which Node
 * refuses to spawn directly. */
const sh = (command, cwd) => execSync(command, { cwd, stdio: 'inherit' });
const q = (value) => JSON.stringify(value);

const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-jsqr-'));

try {
  console.log(`Fetching jsqr@${JSQR_VERSION}…`);
  fs.writeFileSync(path.join(staging, 'package.json'), '{"private":true}');
  sh(`npm install jsqr@${JSQR_VERSION} --no-audit --no-fund --loglevel=error`, staging);

  const entry = path.join(staging, 'node_modules', 'jsqr', 'dist', 'jsQR.js');
  if (!fs.existsSync(entry)) throw new Error(`jsQR bundle not found at ${entry}`);

  console.log('Minifying…');
  const minified = path.join(staging, 'jsqr.min.js');
  sh(
    `npx --yes esbuild@${ESBUILD_VERSION} ${q(entry)} --minify --legal-comments=none ` +
      `--target=es2018 --outfile=${q(minified)}`,
  );

  const bundle = fs.readFileSync(minified, 'utf8');
  // Guard against a future esbuild/jsQR combination that mangles the UMD
  // wrapper: the browser reaches this through window.jsQR and nothing else.
  const probe = {};
  new Function('self', bundle).call(probe, probe);
  if (typeof probe.jsQR !== 'function') {
    throw new Error('Minified bundle does not register a jsQR global — refusing to write it');
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, HEADER + bundle);
  console.log(`Wrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}
