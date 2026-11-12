/**
 * Draws the marketing pages' link-preview cards — public/images/og/gymbook.png
 * and seatbook.png, 1200 × 630 — with `npm run og:gen`. They are what WhatsApp,
 * LinkedIn, X and Slack show when someone pastes the GymBook or SeatBook link
 * (see og:image in src/marketing.js).
 *
 * Unlike the icons (gen-icons.js), these carry text, so they are rendered by a
 * real browser from HTML rather than rasterised by hand: the headline is set
 * in the app's own Inter, from the same words the page uses
 * (public/js/marketing.js). Playwright drives an installed Chrome or Edge, so
 * no browser download is needed. The PNGs are committed; nobody needs to run
 * this to deploy.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { marketingContent } from '../public/js/marketing.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'images', 'og');

/** Matches each brand's palette in public/css/app.css. */
const BRANDS = {
  gym: { file: 'gymbook.png', brand: '#f97316', icon: 'icons/icon-512.png' },
  library: { file: 'seatbook.png', brand: '#10b981', icon: 'icons/library/icon-512.png' },
};

const asset = (rel) => pathToFileURL(path.join(ROOT, 'public', rel)).href;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function cardHtml(brand) {
  const c = marketingContent(brand);
  const { brand: color, icon } = BRANDS[brand];
  const chips = c.features.slice(0, 4).map((f) => `<span>${esc(f.title)}</span>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @font-face { font-family: Inter; font-weight: 100 900; src: url('${asset('fonts/inter-latin-wght-normal.woff2')}') format('woff2-variations'); }
    * { box-sizing: border-box; margin: 0; }
    body { width: 1200px; height: 630px; font-family: Inter, system-ui, sans-serif; color: #e6edf5;
      background: radial-gradient(900px 520px at 85% -10%, ${color}40, transparent 65%), radial-gradient(700px 420px at -10% 110%, ${color}22, transparent 60%), #0d1117;
      padding: 72px 80px; display: flex; flex-direction: column; }
    .top { display: flex; align-items: center; gap: 18px; font-size: 34px; font-weight: 750; letter-spacing: -0.02em; }
    .top img { width: 64px; height: 64px; border-radius: 16px; }
    .kicker { margin-left: auto; padding: 8px 18px; border-radius: 999px; font-size: 20px; font-weight: 650; color: ${color}; background: ${color}22; border: 1px solid ${color}55; }
    h1 { margin-top: 70px; font-size: 76px; line-height: 1.02; letter-spacing: -0.045em; font-weight: 800; }
    h1 span { color: ${color}; }
    p { margin-top: 22px; max-width: 900px; font-size: 27px; line-height: 1.4; color: #a9b6c7; }
    .chips { margin-top: auto; display: flex; flex-wrap: wrap; gap: 12px; }
    .chips span { padding: 10px 18px; border-radius: 12px; font-size: 20px; font-weight: 600; background: #171f2b; border: 1px solid #263140; }
  </style></head><body>
    <div class="top"><img src="${asset(icon)}" alt="">${esc(c.name)}<span class="kicker">${esc(c.eyebrow)}</span></div>
    <h1>${esc(c.headline[0])}<span>${esc(c.headline[1])}</span></h1>
    <p>${esc(c.proof.join(' · '))}</p>
    <div class="chips">${chips}</div>
  </body></html>`;
}

async function launch() {
  for (const channel of ['chrome', 'msedge']) {
    try {
      return await chromium.launch({ channel });
    } catch {
      // try the next installed browser
    }
  }
  return chromium.launch(); // Playwright's own, if `npx playwright install` was run
}

fs.mkdirSync(OUT, { recursive: true });
const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
for (const brand of Object.keys(BRANDS)) {
  const file = path.join(OUT, BRANDS[brand].file);
  const htmlFile = path.join(OUT, `.${brand}.html`);
  fs.writeFileSync(htmlFile, cardHtml(brand));
  await page.goto(pathToFileURL(htmlFile).href);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: file, type: 'png' });
  fs.rmSync(htmlFile);
  console.log(`wrote ${path.relative(ROOT, file)}`);
}
await browser.close();
