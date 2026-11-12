import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

/**
 * public/index.html, the SPA's one page, as the server rewrites it for pages
 * whose <head> must say something specific before any JavaScript runs: an
 * institute's website (coaching/site.js) and the platform's own marketing
 * pages (marketing.js). Crawlers and WhatsApp's link preview read the HTML as
 * sent, so a <title> set later by app.js is one they never see.
 */

export const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

/** A JSON-LD block. "<" is escaped so no text in it can close the script element. */
export const jsonLdScript = (data) => `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;

let shellCache = null;

/** index.html, read once in production and on every call elsewhere so editing it needs no restart. */
export function baseShell() {
  if (shellCache && process.env.NODE_ENV === 'production') return shellCache;
  shellCache = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  return shellCache;
}

/**
 * index.html with its title, description and home-screen name replaced, and
 * `tags` added at the end of the <head>.
 */
export function shellWithHead({ title, description, appTitle, tags = [] }) {
  const extra = tags.filter(Boolean).join('\n    ');
  return baseShell()
    .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(title)}</title>`)
    .replace(/<meta name="description" content="[^"]*"\s*\/>/, `<meta name="description" content="${escapeHtml(description)}" />`)
    .replace(/<meta name="apple-mobile-web-app-title" content="[^"]*"\s*\/>/, `<meta name="apple-mobile-web-app-title" content="${escapeHtml(appTitle)}" />`)
    .replace('</head>', `    ${extra}\n  </head>`);
}
