import { barChart, h, renderIcon, stat } from '../ui.js';

/**
 * A look inside the product for the marketing pages: a browser frame holding a
 * miniature dashboard, drawn with the same stat() and barChart() the real
 * dashboard uses — so it is always in the active brand's colours and can never
 * drift out of date the way a screenshot would.
 *
 * The numbers are sample data and the frame says so. It is decoration: inert to
 * the pointer and hidden from assistive tech, which would otherwise read out a
 * dashboard that is not theirs.
 */

const GYM = {
  host: 'fitpulse.gymbook.app',
  stats: [
    ['Active members', '128', { icon: 'members', accent: true, trend: { positive: true, text: '+12 this month' } }],
    ['Revenue this month', '₹1.84L', { icon: 'revenue', trend: { positive: true, text: '▲ 18% vs last month' } }],
    ['In the gym now', '14', { icon: 'activity', pulse: true, hint: '86 check-ins today' }],
  ],
  chartTitle: 'Revenue, last 6 months',
  bars: [
    ['May', 98000],
    ['Jun', 112000],
    ['Jul', 104000],
    ['Aug', 139000],
    ['Sep', 151000],
    ['Oct', 184000],
  ],
  listTitle: 'Renewals due',
  rows: [
    ['AM', 'Aditya Mehta', 'Annual plan', ['amber', '2d left']],
    ['KS', 'Kavya Shah', 'Quarterly plan', ['green', '6d left']],
    ['RR', 'Rahul Rao', 'Monthly plan', ['green', '9d left']],
  ],
};

const LIBRARY = {
  host: 'quiet-room.seatbook.app',
  stats: [
    ['Active students', '86', { icon: 'members', accent: true, trend: { positive: true, text: '+9 this month' } }],
    ['Fees this month', '₹62K', { icon: 'revenue', trend: { positive: true, text: '▲ 11% vs last month' } }],
    ['Seated now', '41', { icon: 'seats', pulse: true, hint: '58 sittings today' }],
  ],
  chartTitle: 'Fee collection, last 6 months',
  bars: [
    ['May', 38000],
    ['Jun', 44000],
    ['Jul', 41000],
    ['Aug', 52000],
    ['Sep', 57000],
    ['Oct', 62000],
  ],
  listTitle: 'Live seat map',
  seats: true,
};

/** A 12 x 4 hall in the live-map colours: red is a student in the chair, amber a
 * rented desk that is empty right now, dashed is nobody's. Fixed, not random, so
 * the preview is the same on every visit. */
const SEAT_STATES = 'rrarvrrravrrrrvrrarrrvrrrrravrvrrarrrvrrrrrarvrrrarrvr';

const miniSeats = () =>
  h(
    'div',
    { class: 'mini-seats' },
    ...Array.from({ length: 48 }, (_, i) => {
      const code = SEAT_STATES[i % SEAT_STATES.length];
      return h('span', { class: `mini-seat ${code === 'r' ? 'present' : code === 'a' ? 'assigned' : 'vacant'}` });
    }),
  );

export function productPreview(kind = 'gym') {
  const data = kind === 'library' ? LIBRARY : GYM;
  const fmt = (v) => `₹${new Intl.NumberFormat('en-IN', { notation: 'compact', maximumFractionDigits: 1 }).format(v)}`;

  return h(
    'section',
    { class: 'landing-preview', 'aria-hidden': 'true', inert: '' },
    h(
      'div',
      { class: 'preview-frame' },
      h(
        'div',
        { class: 'preview-chrome' },
        h('i', {}),
        h('i', {}),
        h('i', {}),
        h('span', { class: 'preview-url' }, renderIcon('lock', { size: 11 }), data.host),
        h('span', { class: 'preview-note' }, 'Sample data'),
      ),
      h(
        'div',
        { class: 'preview-body' },
        h(
          'div',
          { class: 'grid cols-3' },
          ...data.stats.map(([label, value, { hint, ...options }]) => stat(label, value, hint, options)),
        ),
        h(
          'div',
          { class: 'grid cols-2' },
          h(
            'div',
            { class: 'card' },
            h('div', { class: 'card-head' }, h('h3', {}, data.chartTitle)),
            barChart(
              data.bars.map(([label, value]) => ({ label, value })),
              { height: 170, format: fmt },
            ),
          ),
          h(
            'div',
            { class: 'card' },
            h('div', { class: 'card-head' }, h('h3', {}, data.listTitle)),
            data.seats
              ? miniSeats()
              : h(
                  'div',
                  { class: 'list' },
                  ...data.rows.map(([initials, name, plan, [tone, label]]) =>
                    h(
                      'div',
                      { class: 'list-item' },
                      h('div', { class: 'avatar' }, initials),
                      h('div', {}, h('div', { style: 'font-weight:600' }, name), h('div', { class: 'muted', style: 'font-size:12px' }, plan)),
                      h('div', { class: 'spacer' }),
                      h('span', { class: `badge ${tone}` }, label),
                    ),
                  ),
                ),
          ),
        ),
      ),
    ),
  );
}
