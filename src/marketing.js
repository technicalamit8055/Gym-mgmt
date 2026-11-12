import { config, DEFAULT_TENANT_SLUG } from './config.js';
import { hostnameOf } from './customDomains.js';
import { escapeHtml, jsonLdScript, shellWithHead } from './htmlShell.js';
import {
  COACHBOOK_SIGNUP,
  MARKETING_BRANDS,
  MARKETING_PATHS,
  PRODUCT_LINKS,
  marketingContent,
} from '../public/js/marketing.js';

/**
 * The server's half of the platform's own marketing pages — GymBook at "/",
 * SeatBook at "/library", on the root domain only.
 *
 * The browser draws those pages (public/js/views/landing.js), but search
 * engines, WhatsApp link previews and AI crawlers read the HTML as it is
 * sent. Left alone, that HTML is index.html: one generic title, no share
 * tags, and an empty <div id="app">. This writes into it, from the same
 * content the page draws (public/js/marketing.js):
 *
 * - the title, description, canonical URL, OpenGraph and Twitter tags;
 * - JSON-LD: the product as a SoftwareApplication, and its FAQ as an
 *   FAQPage that matches the FAQ shown on the page word for word;
 * - a plain, readable copy of the page inside #app — headline, features,
 *   comparison, FAQ — which app.js replaces with the live page on boot.
 *
 * robots.txt and sitemap.xml live here too: they describe the same pages.
 */

/** True when this request is the platform's own root, not any gym's address. */
export const onPlatformRoot = (req) => (req.tenant?.slug ?? DEFAULT_TENANT_SLUG) === DEFAULT_TENANT_SLUG;

/**
 * Which marketing page this request is for. Mirrors landingBrand in
 * public/js/api.js: the "/library" path, or a seatbook.* hostname.
 */
export function marketingBrandFor(req) {
  if (/^\/library\/?$/.test(req.path)) return 'library';
  return /^(www\.)?seatbook\./.test(hostnameOf(req.get('host'))) ? 'library' : 'gym';
}

/**
 * The address these pages should be indexed under. With ROOT_DOMAIN set
 * that is always the platform's own https address — whichever hostname the
 * request came in on (an unknown domain pointed at the server also lands on
 * the marketing page), so search engines see one copy, not one per alias.
 */
export function publicOrigin(req) {
  if (config.rootDomain) return `https://${config.rootDomain.toLowerCase()}`;
  return `${req.protocol}://${req.get('host')}`;
}

/* ── Structured data ───────────────────────────────────────────────────── */

function structuredData(content, { origin, url }) {
  const orgId = `${origin}/#organization`;
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': orgId,
        name: 'GymBook',
        url: `${origin}/`,
        logo: `${origin}/icons/icon-512.png`,
      },
      {
        '@type': 'WebPage',
        '@id': `${url}#webpage`,
        url,
        name: content.title,
        description: content.description,
        inLanguage: 'en-IN',
        publisher: { '@id': orgId },
        about: { '@id': `${url}#software` },
      },
      // No `offers`: the subscription price lives in the operator console,
      // and a made-up price (or a "0" for the trial) would put a false
      // "Free" under the result. Add one when pricing is public.
      {
        '@type': 'SoftwareApplication',
        '@id': `${url}#software`,
        name: content.name,
        url,
        description: content.description,
        applicationCategory: 'BusinessApplication',
        applicationSubCategory: content.category,
        operatingSystem: 'Web, Android, iOS, Windows, macOS',
        image: `${origin}${content.ogImage}`,
        featureList: content.features.map((feature) => feature.title),
        publisher: { '@id': orgId },
      },
      {
        '@type': 'FAQPage',
        '@id': `${url}#faq`,
        mainEntity: content.faqs.map(({ q, a }) => ({
          '@type': 'Question',
          name: q,
          acceptedAnswer: { '@type': 'Answer', text: a },
        })),
      },
    ],
  };
}

/* ── The crawlable copy of the page ────────────────────────────────────── */

const cell = ([state, note], column) => {
  const word = state === true ? 'Yes' : state === false ? 'No' : 'Partly';
  return `<td data-label="${escapeHtml(column)}">${word} — ${escapeHtml(note)}</td>`;
};

/**
 * The page's words as plain HTML, in the same classes the live page uses so
 * it reads properly even with JavaScript off. app.js swaps it out on boot;
 * with JavaScript on, the splash covers it until then.
 */
export function marketingBodyHtml(content, { trialDays }) {
  const e = escapeHtml;
  const signup = `${content.path}#/signup`;
  const others = PRODUCT_LINKS.map(
    (p) => `<a href="${p.href}"${p.brand === content.brand ? ' aria-current="page"' : ''}>${e(p.name)}</a>`,
  ).join(' · ');

  return `
      <div class="landing"${content.brand === 'library' ? ' data-brand="library"' : ''}>
        <header class="landing-top">
          <a class="brand" href="${content.path}">${e(content.name)}</a>
          <nav class="landing-switch" aria-label="Products">${others}</nav>
          <a class="btn sm primary" href="${signup}">Start free</a>
        </header>
        <main>
          <section class="landing-hero">
            <p class="landing-eyebrow">${e(content.eyebrow)}</p>
            <h1>${e(content.headline[0])}<span class="grad">${e(content.headline[1])}</span></h1>
            <p class="lede">${e(content.lede)}</p>
            <p class="landing-cta"><a class="btn primary lg" href="${signup}">Start your ${trialDays}-day free trial</a></p>
            <ul class="landing-proof">${content.proof.map((p) => `<li>${e(p)}</li>`).join('')}</ul>
          </section>
          <section aria-labelledby="ssr-features">
            <div class="landing-section-head">
              <h2 id="ssr-features">${e(content.featuresHeading)}</h2>
              <p class="muted">${e(content.featuresLede)}</p>
            </div>
            <div class="landing-features">
              ${content.features.map((f) => `<article class="card landing-feature"><h3>${e(f.title)}</h3><p class="muted">${e(f.body)}</p></article>`).join('\n              ')}
            </div>
          </section>
          <section aria-labelledby="ssr-compare">
            <div class="landing-section-head">
              <h2 id="ssr-compare">${e(content.compare.heading)}</h2>
              <p class="muted">${e(content.compare.lede)}</p>
            </div>
            <div class="landing-compare">
              <table>
                <thead><tr><th scope="col"></th>${content.compare.columns.map((c) => `<th scope="col">${e(c)}</th>`).join('')}</tr></thead>
                <tbody>
                  ${content.compare.rows.map(([label, ...cells]) => `<tr><th scope="row">${e(label)}</th>${cells.map((c, i) => cell(c, content.compare.columns[i])).join('')}</tr>`).join('\n                  ')}
                </tbody>
              </table>
            </div>
          </section>
          <section class="landing-steps">
            <h2>${e(content.steps.heading)}</h2>
            <ol>${content.steps.items.map(([b, rest]) => `<li><strong>${e(b)}</strong>${e(rest)}</li>`).join('')}</ol>
            <a class="btn primary" href="${signup}">${e(content.steps.cta)}</a>
          </section>
          <section aria-labelledby="ssr-faq">
            <div class="landing-section-head"><h2 id="ssr-faq">${e(content.faqHeading)}</h2></div>
            <div class="landing-faq">
              ${content.faqs.map(({ q, a }) => `<details><summary>${e(q)}</summary><p>${e(a)}</p></details>`).join('\n              ')}
            </div>
          </section>
        </main>
        <footer class="landing-foot muted">
          <p>${e(content.footer)} ${trialDays}-day free trial, then a single monthly subscription.</p>
          <p>${others} · <a href="${COACHBOOK_SIGNUP}">CoachBook for coaching institutes</a></p>
        </footer>
      </div>
    `;
}

/* ── The whole document ────────────────────────────────────────────────── */

/**
 * index.html as a marketing page: its head rewritten and its body
 * pre-filled. `origin` is publicOrigin(req).
 */
export function marketingShellHtml(brand, { origin, trialDays = config.trialDays }) {
  const content = marketingContent(brand, { trialDays });
  const url = `${origin}${content.path}`;
  const image = `${origin}${content.ogImage}`;
  const e = escapeHtml;

  let html = shellWithHead({
    title: content.title,
    description: content.description,
    appTitle: content.name,
    tags: [
      `<link rel="canonical" href="${e(url)}" />`,
      `<meta name="robots" content="index, follow, max-image-preview:large" />`,
      `<meta property="og:type" content="website" />`,
      `<meta property="og:site_name" content="${e(content.name)}" />`,
      `<meta property="og:locale" content="en_IN" />`,
      `<meta property="og:url" content="${e(url)}" />`,
      `<meta property="og:title" content="${e(content.title)}" />`,
      `<meta property="og:description" content="${e(content.description)}" />`,
      `<meta property="og:image" content="${e(image)}" />`,
      `<meta property="og:image:width" content="1200" />`,
      `<meta property="og:image:height" content="630" />`,
      `<meta property="og:image:alt" content="${e(`${content.name} — ${content.category}`)}" />`,
      `<meta name="twitter:card" content="summary_large_image" />`,
      `<meta name="twitter:title" content="${e(content.title)}" />`,
      `<meta name="twitter:description" content="${e(content.description)}" />`,
      `<meta name="twitter:image" content="${e(image)}" />`,
      // With JavaScript off the splash would never lift off the copy below it.
      `<noscript><style>.splash { display: none; }</style></noscript>`,
      jsonLdScript(structuredData(content, { origin, url })),
    ],
  }).replace('<div id="app"></div>', `<div id="app">${marketingBodyHtml(content, { trialDays })}</div>`);

  // SeatBook's own tab and home-screen icons, not GymBook's barbell.
  if (brand === 'library') {
    html = html
      .replace('href="/icons/apple-touch-icon.png"', `href="${content.appleIcon}"`)
      .replace('href="/icons/favicon-32.png"', `href="${content.favicon}"`)
      .replace('href="/icons/icon-192.png"', 'href="/icons/library/icon-192.png"');
  }
  return html;
}

/* ── robots.txt and sitemap.xml ────────────────────────────────────────── */

/**
 * The API, and the fingerprint terminals' endpoint, are never pages. The
 * sitemap is only advertised on the platform's root, which is the only place
 * that has one.
 */
export function robotsTxt({ origin, root }) {
  return [
    'User-agent: *',
    'Allow: /',
    'Disallow: /api/',
    'Disallow: /iclock',
    ...(root ? ['', `Sitemap: ${origin}/sitemap.xml`] : []),
    '',
  ].join('\n');
}

export function sitemapXml({ origin }) {
  const urls = MARKETING_BRANDS.map((brand) => `  <url><loc>${escapeHtml(`${origin}${MARKETING_PATHS[brand]}`)}</loc></url>`);
  return ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">', ...urls, '</urlset>', ''].join('\n');
}
