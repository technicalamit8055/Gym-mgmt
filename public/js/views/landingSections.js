import { COACHBOOK_SIGNUP, PRODUCT_LINKS, roiEstimate } from '../marketing.js';
import { h, renderIcon } from '../ui.js';

/**
 * The building blocks of the marketing pages below the hero, shared by
 * GymBook's and SeatBook's (views/landing.js). Each takes its words from the
 * page's content (public/js/marketing.js) and owns no copy of its own beyond
 * labels, so the two products never drift apart in layout.
 */

const inr = (value) => `₹${new Intl.NumberFormat('en-IN').format(Math.round(value))}`;

/** GymBook | SeatBook, in the top bar: the other product is one click away. */
export function productSwitch(brand) {
  return h(
    'nav',
    { class: 'landing-switch', 'aria-label': 'Products' },
    PRODUCT_LINKS.map((product) =>
      h(
        'a',
        { href: product.href, 'aria-current': product.brand === brand ? 'page' : null, title: `${product.name} — for ${product.label.toLowerCase()}` },
        product.name,
      ),
    ),
  );
}

/** The three reassurances under the hero button. */
export const proofList = (items) =>
  h(
    'ul',
    { class: 'landing-proof' },
    items.map((item) => h('li', {}, renderIcon('check', { size: 14, stroke: 2.4 }), item)),
  );

export const sectionHead = (heading, lede, id) =>
  h('div', { class: 'landing-section-head' }, h('h2', { id }, heading), lede ? h('p', { class: 'muted' }, lede) : null);

export function featureGrid(features) {
  return h(
    'div',
    { class: 'landing-features' },
    features.map((feature) =>
      h(
        'article',
        { class: 'card landing-feature' },
        h('div', { class: 'landing-feature-icon' }, renderIcon(feature.icon, { size: 20 })),
        h('h3', {}, feature.title),
        h('p', { class: 'muted' }, feature.body),
      ),
    ),
  );
}

/* ── ROI calculator ────────────────────────────────────────────────────── */

/**
 * "What are late renewals costing you?" Four sliders, one estimate. Every
 * assumption is a slider the visitor can see and move — the fine print says
 * the rest — because a calculator that hides its maths reads as a sales trick.
 */
export function roiCalculator(content, onStart) {
  const { unit, count, fee } = content.roi;
  const state = { count: count.value, fee: fee.value, lateRate: 15, recovery: 30 };

  const out = {
    recovered: h('strong', { class: 'roi-big' }),
    yearly: h('strong', {}),
    hours: h('strong', {}),
    atRisk: h('strong', {}),
  };

  const slider = (key, label, { min, max, step }, format) => {
    const id = `roi-${key}`;
    const value = h('output', { for: id });
    const input = h('input', {
      id,
      type: 'range',
      min,
      max,
      step,
      value: state[key],
      oninput: () => {
        state[key] = Number(input.value);
        update();
      },
    });
    const show = () => {
      value.textContent = format(state[key]);
      input.setAttribute('aria-valuetext', value.textContent);
      // The filled part of the track, for browsers that only style it via CSS.
      input.style.setProperty('--fill', `${((state[key] - min) / (max - min)) * 100}%`);
    };
    return { row: h('div', { class: 'roi-field' }, h('label', { for: id }, label, value), input), show };
  };

  const fields = [
    slider('count', `Active ${unit}`, count, (v) => new Intl.NumberFormat('en-IN').format(v)),
    slider('fee', 'Average monthly fee', fee, inr),
    slider('lateRate', 'Renew late or lapse in a month', { min: 0, max: 50, step: 1 }, (v) => `${v}%`),
    slider('recovery', 'Brought back by a timely reminder', { min: 0, max: 80, step: 5 }, (v) => `${v}%`),
  ];

  function update() {
    fields.forEach((field) => field.show());
    const result = roiEstimate({ count: state.count, fee: state.fee, lateRate: state.lateRate / 100, recovery: state.recovery / 100 });
    out.recovered.textContent = inr(result.recovered);
    out.yearly.textContent = inr(result.yearly);
    out.hours.textContent = `${result.hours} hrs`;
    out.atRisk.textContent = inr(result.atRisk);
  }
  update();

  return h(
    'section',
    { class: 'landing-roi', 'aria-labelledby': 'roi-heading' },
    sectionHead(content.roi.heading, content.roi.lede, 'roi-heading'),
    h(
      'div',
      { class: 'card roi' },
      h('div', { class: 'roi-inputs' }, fields.map((field) => field.row)),
      h(
        'div',
        { class: 'roi-results', 'aria-live': 'polite' },
        h('span', { class: 'roi-label' }, 'Back in your account, every month'),
        out.recovered,
        h(
          'dl',
          { class: 'roi-facts' },
          h('div', {}, h('dt', {}, 'Over a year'), h('dd', {}, out.yearly)),
          h('div', {}, h('dt', {}, 'Typing saved a month'), h('dd', {}, out.hours)),
          h('div', {}, h('dt', {}, 'At risk each month'), h('dd', {}, out.atRisk)),
        ),
        h('button', { class: 'btn primary lg block', onclick: onStart }, 'Start getting it back'),
        h(
          'p',
          { class: 'roi-fine' },
          `An estimate, not a promise. It assumes monthly renewals, and one reminder and one receipt per ${unit === 'students' ? 'student' : 'member'} a month at about two minutes each to type by hand.`,
        ),
      ),
    ),
  );
}

/* ── Comparison ────────────────────────────────────────────────────────── */

const MARK = {
  true: ['yes', 'check', 'Yes'],
  false: ['no', 'close', 'No'],
  null: ['partly', 'minus', 'Partly'],
};

export function comparison(compare) {
  // data-label names the column, for the stacked phone layout (app.css).
  const cell = ([state, note], isUs, column) => {
    const [tone, icon, word] = MARK[String(state)];
    return h(
      'td',
      { class: `cmp-${tone}${isUs ? ' cmp-us' : ''}`, 'data-label': column },
      h('span', { class: 'cmp-mark' }, renderIcon(icon, { size: 14, stroke: 2.4, title: word })),
      h('span', {}, note),
    );
  };
  const last = compare.columns.length - 1;

  return h(
    'section',
    { 'aria-labelledby': 'cmp-heading' },
    sectionHead(compare.heading, compare.lede, 'cmp-heading'),
    h(
      'div',
      { class: 'landing-compare', tabindex: '0', role: 'region', 'aria-label': compare.heading },
      h(
        'table',
        {},
        h(
          'thead',
          {},
          h('tr', {}, h('th', { scope: 'col' }), compare.columns.map((column, i) => h('th', { scope: 'col', class: i === last ? 'cmp-us' : null }, column))),
        ),
        h(
          'tbody',
          {},
          compare.rows.map(([label, ...cells]) => h('tr', {}, h('th', { scope: 'row' }, label), cells.map((c, i) => cell(c, i === last, compare.columns[i])))),
        ),
      ),
    ),
  );
}

/* ── FAQ ───────────────────────────────────────────────────────────────── */

/**
 * Native <details>: keyboard and screen-reader behaviour for free, and the
 * answers stay in the DOM (and in the server's copy) whether open or not.
 * `name` makes it an exclusive accordion where the browser supports it.
 */
export function faqList(content) {
  return h(
    'section',
    { 'aria-labelledby': 'faq-heading' },
    sectionHead(content.faqHeading, null, 'faq-heading'),
    h(
      'div',
      { class: 'landing-faq' },
      content.faqs.map(({ q, a }, i) =>
        h(
          'details',
          { name: 'landing-faq', open: i === 0 ? '' : null },
          h('summary', {}, q, renderIcon('chevronDown', { size: 18, class: 'faq-chevron' })),
          h('p', {}, a),
        ),
      ),
    ),
  );
}

/* ── Calls to action ───────────────────────────────────────────────────── */

export function finalCta(content, trialDays, onStart) {
  return h(
    'section',
    { class: 'landing-final' },
    h('h2', {}, content.finalCta.heading),
    h('p', { class: 'muted' }, content.finalCta.lede),
    h('button', { class: 'btn primary lg', onclick: onStart }, content.finalCta.button),
    h('span', { class: 'muted landing-final-note' }, `${trialDays} days free · No card needed`),
  );
}

/**
 * A slim "Start free" bar pinned to the bottom of a phone screen, shown once
 * the hero's button has scrolled away and hidden again when the closing call
 * to action is on screen — never two buttons saying the same thing at once.
 * Desktop already has one in the sticky top bar, so CSS keeps it phone-only.
 */
export function stickyCta({ label, onStart, hero, finale }) {
  const bar = h(
    'div',
    { class: 'landing-sticky', 'aria-hidden': 'true' },
    h('button', { class: 'btn primary block', tabindex: '-1', onclick: onStart }, label),
  );
  if (!('IntersectionObserver' in window)) return bar;

  const seen = { hero: true, finale: false, heroAbove: false };
  const observer = new IntersectionObserver((entries) => {
    if (!bar.isConnected) {
      observer.disconnect();
      return;
    }
    for (const entry of entries) {
      if (entry.target === hero) {
        seen.hero = entry.isIntersecting;
        seen.heroAbove = !entry.isIntersecting && entry.boundingClientRect.top < 0;
      } else seen.finale = entry.isIntersecting;
    }
    const show = seen.heroAbove && !seen.finale;
    bar.classList.toggle('show', show);
    bar.setAttribute('aria-hidden', String(!show));
    bar.querySelector('button').tabIndex = show ? 0 : -1;
  });
  // Observed once the page is in the document — the caller builds it detached.
  requestAnimationFrame(() => {
    observer.observe(hero);
    observer.observe(finale);
  });
  return bar;
}

export function landingFooter(content, trialDays) {
  return h(
    'footer',
    { class: 'landing-foot muted' },
    h('p', {}, `${content.footer} ${trialDays}-day free trial, then a single monthly subscription.`),
    h(
      'p',
      { class: 'landing-foot-links' },
      PRODUCT_LINKS.map((product) =>
        h('a', { href: product.href, 'aria-current': product.brand === content.brand ? 'page' : null }, `${product.name} for ${product.label.toLowerCase()}`),
      ),
      h('a', { href: COACHBOOK_SIGNUP }, 'CoachBook for coaching institutes'),
    ),
  );
}
