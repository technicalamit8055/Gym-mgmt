import { signInBox } from './landing.js';
import { h, renderIcon } from '../ui.js';

/**
 * The root domain's SeatBook marketing page, served at /library.
 *
 * Shares GymBook's landing skeleton and CSS classes (brand-agnostic — see
 * app.css) and its sign-in box, rather than duplicating the url_mode /
 * gymPathUrl logic that box already has right. Only the copy and the feature
 * list are SeatBook's own.
 */

/** Icon-set names, as on GymBook's own landing page — see FEATURES there. */
const FEATURES = [
  {
    icon: 'seats',
    title: 'A live seat map',
    body: 'Every desk, every shift, at a glance. Assign, transfer or release a seat in one tap — the map is always in sync with who is actually sitting there.',
  },
  {
    icon: 'clock',
    title: 'Passes sold per shift',
    body: 'Morning, Afternoon, Evening, Night or Full Day. A desk sold for the morning is free again in the evening — nothing double-books, ever.',
  },
  {
    icon: 'billing',
    title: 'Fees, dues and reminders',
    body: 'Sell passes, take cash, card or UPI, and see outstanding dues per student. Send a fee reminder over WhatsApp with one tap.',
  },
  {
    icon: 'lockers',
    title: 'Lockers, tracked like seats',
    body: 'One live allocation per locker, billed alongside the pass, released the moment a student leaves — no separate spreadsheet.',
  },
  {
    icon: 'expenses',
    title: 'Expenses, not just income',
    body: 'Rent, electricity, wifi, staff — log what goes out, and see collected vs. spent at a glance instead of guessing at month end.',
  },
  {
    icon: 'idCard',
    title: 'ID proof on file',
    body: 'Aadhaar, college ID, whatever you ask for — uploaded once, stored per student, and never mixed up with anyone else’s.',
  },
];

export function renderLandingLibrary({ context, navigate }) {
  const trialDays = context.trial_days ?? 7;
  const rootHost = window.location.host;

  return h(
    'div',
    { class: 'landing', 'data-brand': 'library' },
    h(
      'header',
      { class: 'landing-top' },
      h('div', { class: 'brand' }, h('div', { class: 'logo' }, renderIcon('book', { size: 18 })), 'SeatBook'),
      h('div', { class: 'spacer' }),
      context.platform_admin
        ? h('a', { class: 'btn sm ghost', href: '#/platform' }, 'Operator console')
        : null,
      h('button', { class: 'btn sm primary', onclick: () => navigate('/signup') }, 'Start free'),
    ),

    h(
      'section',
      { class: 'landing-hero' },
      h('h1', {}, 'Every seat. Every shift. Accounted for.'),
      h(
        'p',
        { class: 'lede' },
        'Run a study hall or reading room: seats, shifts, passes, lockers, expenses and student records — in one place, on any screen at the front desk.',
      ),
      h(
        'div',
        { class: 'landing-cta' },
        h('button', { class: 'btn primary lg', onclick: () => navigate('/signup') }, `Start your ${trialDays}-day free trial`),
        h('span', { class: 'muted', style: 'font-size:13px' }, 'No card needed. Ready in about a minute.'),
      ),
      signInBox(context.url_mode, rootHost, {
        placeholder: 'your-hall',
        ariaLabel: 'Your hall address',
        errorMessage: 'Enter your hall address first',
        buttonLabel: 'Go to my hall',
      }),
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
      h('h2', {}, 'From nothing to a full hall'),
      h(
        'ol',
        {},
        h('li', {}, h('strong', {}, 'Pick your address.'), ' It becomes the link your staff sign in at.'),
        h('li', {}, h('strong', {}, 'Create the owner account.'), ' You land straight in, already signed in.'),
        h(
          'li',
          {},
          h('strong', {}, 'Map your seats.'),
          ' Rows, zones, aisles — set up once, then assign students shift by shift.',
        ),
      ),
      h('button', { class: 'btn primary', onclick: () => navigate('/signup') }, 'Create my hall'),
    ),

    h(
      'footer',
      { class: 'landing-foot muted' },
      `SeatBook — every seat, every shift, in one map. ${trialDays}-day trial, then a single monthly subscription. `,
      h('a', { href: '/' }, 'Running a gym instead? →'),
    ),
  );
}
