import { gymPathUrl } from '../api.js';
import { h, renderIcon, toast } from '../ui.js';

/**
 * The root domain's public page: what the product is, a way in for gyms that
 * already exist, and a way to create one that doesn't.
 *
 * Rendered full-page rather than inside the app shell — there is no gym to
 * put a sidebar for, and every nav item would 404.
 */

/** `icon` names one of the vectors in ui.js — the marketing page is the first
 * thing a visitor sees, and an emoji renders differently on every platform. */
const FEATURES = [
  {
    icon: 'checkin',
    title: 'Check-in that keeps up',
    body: 'QR ID cards, phone biometrics or a fingerprint terminal at the door. One rescan checks a member back out, and assigned shifts close forgotten visits on their own.',
  },
  {
    icon: 'billing',
    title: 'Memberships and money',
    body: 'Sell plans, take payments in cash, card, UPI or bank, and see outstanding dues per member. Renewals pick up the day the old membership ends.',
  },
  {
    icon: 'idCard',
    title: 'Members, properly filed',
    body: 'Contact and emergency details, health notes, a full history of visits, payments and bookings on one page — and a printable ID card for each.',
  },
  {
    icon: 'equipment',
    title: 'Classes and equipment',
    body: 'A weekly timetable with trainers, rooms and capacity, live seat counts, plus an equipment register with service dates and maintenance alerts.',
  },
  {
    icon: 'reports',
    title: 'Numbers you can act on',
    body: 'Revenue by period, method and plan. Attendance by hour and weekday. Joins, renewals and churn. Every report exports to CSV.',
  },
  {
    icon: 'database',
    title: 'Your data, on its own',
    body: 'Every gym gets its own separate database file. Not a shared table with a filter on it — a different file, so one gym’s data cannot be queried from another.',
  },
];

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

export function renderLanding({ context, navigate }) {
  const trialDays = context.trial_days ?? 7;
  const rootHost = window.location.host;

  return h(
    'div',
    { class: 'landing' },
    h(
      'header',
      { class: 'landing-top' },
      h('div', { class: 'brand' }, h('div', { class: 'logo' }, renderIcon('dumbbell', { size: 18 })), 'GymBook'),
      h('div', { class: 'spacer' }),
      context.platform_admin
        ? h('a', { class: 'btn sm ghost', href: '#/platform' }, 'Operator console')
        : null,
      h('button', { class: 'btn sm primary', onclick: () => navigate('/signup') }, 'Start free'),
    ),

    h(
      'section',
      { class: 'landing-hero' },
      h('h1', {}, 'Run your gym. All of it.'),
      h(
        'p',
        { class: 'lede' },
        'Members, memberships, payments, check-ins, classes and equipment — in one place, on any screen at the front desk.',
      ),
      h(
        'div',
        { class: 'landing-cta' },
        h('button', { class: 'btn primary lg', onclick: () => navigate('/signup') }, `Start your ${trialDays}-day free trial`),
        h('span', { class: 'muted', style: 'font-size:13px' }, 'No card needed. Ready in about a minute.'),
      ),
      signInBox(context.url_mode, rootHost),
    ),

    h(
      'section',
      { class: 'landing-features' },
      FEATURES.map((feature) =>
        h(
          'div',
          { class: 'card landing-feature' },
          h('div', { class: 'landing-feature-icon' }, renderIcon(feature.icon, { size: 20 })),
          h('h3', {}, feature.title),
          h('p', { class: 'muted' }, feature.body),
        ),
      ),
    ),

    h(
      'section',
      { class: 'landing-steps' },
      h('h2', {}, 'From nothing to checking members in'),
      h(
        'ol',
        {},
        h('li', {}, h('strong', {}, 'Pick your address.'), ' It becomes the link your staff sign in at.'),
        h('li', {}, h('strong', {}, 'Create the owner account.'), ' You land straight in, already signed in.'),
        h(
          'li',
          {},
          h('strong', {}, 'Three plans are waiting for you.'),
          ' Edit the prices, add your members, and start scanning people in.',
        ),
      ),
      h('button', { class: 'btn primary', onclick: () => navigate('/signup') }, 'Create my gym'),
    ),

    h(
      'footer',
      { class: 'landing-foot muted' },
      `GymBook — every gym on its own database. ${trialDays}-day trial, then a single monthly subscription. `,
      h('a', { href: '/library' }, 'Running a library or study hall? →'),
    ),
  );
}
