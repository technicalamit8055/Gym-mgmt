/**
 * Regenerates public/js/vendor/katex/ — katex.min.js, katex.min.css and the
 * woff2 fonts the stylesheet points at.
 *
 * KaTeX draws the LaTeX in AI-generated DPPs and tests (public/js/math.js):
 * on the teacher's preview, the printed question paper and the student app's
 * test screen. Vendored rather than a dependency for the same reason as
 * hls.js (scripts/vendor-hls.js): public/ is served as static files with no
 * bundler, and the browser loads it on demand, only on a screen with maths.
 *
 * Only the woff2 fonts are kept. The stylesheet lists woff2 first and every
 * browser the app supports reads it, so the woff/ttf copies would never load.
 *
 * Usage: npm run vendor:katex
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from '../src/config.js';

const KATEX_VERSION = '0.16.22';
const OUT = path.join(ROOT, 'public', 'js', 'vendor', 'katex');

const header = (what) => `/*!
 * KaTeX v${KATEX_VERSION} — ${what}. MIT licence.
 * https://katex.org
 *
 * Vendored (not a runtime npm dependency) because the browser loads it
 * directly, on demand, only on a screen with maths. Regenerate with:
 *   npm run vendor:katex
 */
`;

const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-katex-'));

try {
  console.log(`Fetching katex@${KATEX_VERSION}…`);
  fs.writeFileSync(path.join(staging, 'package.json'), '{"private":true}');
  execSync(`npm install katex@${KATEX_VERSION} --no-audit --no-fund --loglevel=error`, { cwd: staging, stdio: 'inherit' });

  const dist = path.join(staging, 'node_modules', 'katex', 'dist');
  const js = fs.readFileSync(path.join(dist, 'katex.min.js'), 'utf8').replace(/\n\/\/# sourceMappingURL=.*$/m, '');
  const css = fs.readFileSync(path.join(dist, 'katex.min.css'), 'utf8').replace(/\/\*# sourceMappingURL=.*?\*\//g, '');

  // The page reaches it through window.katex and nothing else.
  new Function(js)();
  if (typeof globalThis.katex?.renderToString !== 'function') throw new Error('The bundle does not register a katex global — refusing to write it');

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, 'fonts'), { recursive: true });
  fs.writeFileSync(path.join(OUT, 'katex.min.js'), header('fast maths typesetting') + js);
  fs.writeFileSync(path.join(OUT, 'katex.min.css'), header('stylesheet') + css);
  let fonts = 0;
  for (const file of fs.readdirSync(path.join(dist, 'fonts'))) {
    if (!file.endsWith('.woff2')) continue;
    fs.copyFileSync(path.join(dist, 'fonts', file), path.join(OUT, 'fonts', file));
    fonts += 1;
  }
  console.log(`Wrote ${OUT} (katex.min.js, katex.min.css, ${fonts} fonts)`);
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}
