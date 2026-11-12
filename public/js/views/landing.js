import { gymPathUrl } from '../api.js';
import { marketingContent } from '../marketing.js';
import { h, renderIcon, toast } from '../ui.js';
import { testDrive } from './landingDemo.js';
import { productPreview } from './landingPreview.js';
import {
  comparison,
  faqList,
  featureGrid,
  finalCta,
  landingFooter,
  productSwitch,
  proofList,
  roiCalculator,
  sectionHead,
  stickyCta,
} from './landingSections.js';

/**
 * The root domain's public pages: GymBook at "/", SeatBook at "/library"
 * (views/landingLibrary.js). One layout for both — what the product is, a
 * way in for accounts that already exist, and a way to create one that
 * doesn't — with every word coming from public/js/marketing.js, which the
 * server also reads to write the same page into the HTML for crawlers
 * (src/marketing.js).
 *
 * Rendered full-page rather than inside the app shell — there is no gym to
 * put a sidebar for, and every nav item would 404.
 */

/** "Already have a gym?" — turns a typed address into the URL it lives at. */
export function signInBox(urlMode, rootHost, copy = {}) {
  const {
    placeholder = 'your-gym',
    ariaLabel = 'Your gym address',
    errorMessage = 'Enter your gym address first',
    buttonLabel = 'Go to my gym',
  } = copy;

  const input = h('input', {
    name: 'slug',
    placeholder,
    'aria-label': ariaLabel,
    autocapitalize: 'none',
    autocorrect: 'off',
    spellcheck: 'false',
  });

  const go = () => {
    const slug = input.value.trim().toLowerCase();
    if (!slug) {
      toast(errorMessage, 'error');
      input.focus();
      return;
    }
    window.location.href = urlMode === 'subdomain' ? `${window.location.protocol}//${slug}.${rootHost}` : gymPathUrl(slug);
  };

  return h(
    'form',
    {
      class: 'landing-signin',
      onsubmit: (event) => {
        event.preventDefault();
        go();
      },
    },
    h('span', { class: 'muted' }, 'Already set up?'),
    h(
      'div',
      { class: 'landing-signin-field' },
      urlMode === 'subdomain' ? null : h('span', { class: 'affix' }, '/g/'),
      input,
      urlMode === 'subdomain' ? h('span', { class: 'affix' }, `.${rootHost}`) : null,
    ),
    h('button', { class: 'btn', type: 'submit' }, buttonLabel),
  );
}

/** One marketing page, for `brand` 'gym' or 'library'. */
export function renderMarketingPage(brand, { context, navigate }) {
  const trialDays = context.trial_days ?? 7;
  const content = marketingContent(brand, { trialDays });
  const start = () => navigate('/signup');

  const heroCta = h(
    'div',
    { class: 'landing-cta' },
    h('button', { class: 'btn primary lg', onclick: start }, `Start your ${trialDays}-day free trial`),
    proofList(content.proof),
  );
  const finale = finalCta(content, trialDays, start);

  return h(
    'div',
    { class: 'landing', 'data-brand': brand === 'library' ? 'library' : null },
    h(
      'header',
      { class: 'landing-top' },
      h('a', { class: 'brand', href: content.path }, h('div', { class: 'logo' }, renderIcon(content.icon, { size: 18 })), content.name),
      productSwitch(brand),
      h('div', { class: 'spacer' }),
      context.platform_admin ? h('a', { class: 'btn sm ghost', href: '#/platform' }, 'Operator console') : null,
      h('button', { class: 'btn sm primary', onclick: start }, 'Start free'),
    ),

    h(
      'section',
      { class: 'landing-hero' },
      h('span', { class: 'landing-eyebrow' }, renderIcon('sparkle', { size: 14 }), content.eyebrow),
      h('h1', {}, content.headline[0], h('span', { class: 'grad' }, content.headline[1])),
      h('p', { class: 'lede' }, content.lede),
      heroCta,
      signInBox(context.url_mode, window.location.host, content.signin),
    ),

    productPreview(brand),

    h(
      'section',
      { 'aria-labelledby': 'features-heading' },
      sectionHead(content.featuresHeading, content.featuresLede, 'features-heading'),
      featureGrid(content.features),
    ),

    testDrive(content),
    roiCalculator(content, start),
    comparison(content.compare),

    h(
      'section',
      { class: 'landing-steps' },
      h('h2', {}, content.steps.heading),
      h(
        'ol',
        {},
        content.steps.items.map(([lead, rest]) => h('li', {}, h('strong', {}, lead), rest)),
      ),
      h('button', { class: 'btn primary', onclick: start }, content.steps.cta),
    ),

    faqList(content),
    finale,
    landingFooter(content, trialDays),
    stickyCta({ label: `Start your ${trialDays}-day free trial`, onStart: start, hero: heroCta, finale }),
  );
}

export const renderLanding = (ctx) => renderMarketingPage('gym', ctx);
