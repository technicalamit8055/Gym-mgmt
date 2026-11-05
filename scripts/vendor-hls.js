/**
 * Regenerates public/js/vendor/hls.light.min.js.
 *
 * hls.js plays the private class streams (HLS from Cloudflare Stream) in
 * browsers without HLS built in, and is what gives the class player its
 * quality menu (public/js/classPlayer.js). Vendored rather than a dependency
 * for the same reason as jsQR (scripts/vendor-jsqr.js): public/ is served as
 * static files with no bundler. The "light" build leaves out subtitles,
 * alternate audio and DRM, none of which a live class uses.
 *
 * Usage: npm run vendor:hls
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from '../src/config.js';

const HLS_VERSION = '1.7.4';
const OUT = path.join(ROOT, 'public', 'js', 'vendor', 'hls.light.min.js');

const HEADER = `/*!
 * hls.js v${HLS_VERSION} (light build) — HLS playback over Media Source Extensions. Apache-2.0.
 * https://github.com/video-dev/hls.js
 *
 * Vendored (not a runtime npm dependency) because the browser loads it
 * directly, on demand, only when a class streams privately. Regenerate with:
 *   npm run vendor:hls
 */
`;

const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-hls-'));

try {
  console.log(`Fetching hls.js@${HLS_VERSION}…`);
  fs.writeFileSync(path.join(staging, 'package.json'), '{"private":true}');
  execSync(`npm install hls.js@${HLS_VERSION} --no-audit --no-fund --loglevel=error`, { cwd: staging, stdio: 'inherit' });

  const entry = path.join(staging, 'node_modules', 'hls.js', 'dist', 'hls.light.min.js');
  if (!fs.existsSync(entry)) throw new Error(`hls.js light build not found at ${entry}`);
  const bundle = fs.readFileSync(entry, 'utf8').replace(/\n\/\/# sourceMappingURL=.*$/m, '');

  // The player reaches it through window.Hls and nothing else.
  // Its UMD wrapper registers on the global object, as in a browser.
  new Function(bundle)();
  if (typeof globalThis.Hls !== 'function') throw new Error('The bundle does not register a Hls global — refusing to write it');

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, HEADER + bundle);
  console.log(`Wrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}
