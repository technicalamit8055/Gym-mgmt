import { api, session } from '../api.js';
import { downloadReceipt, getGymName, printReceipt } from '../receipt.js';
import { openMemberForm, openMembershipForm, openPaymentForm } from './forms.js';
import { openLiveSeatMap } from './seats.js';
import {
  barChart,
  clear,
  date,
  dayMonth,
  expiryLabel,
  fullName,
  h,
  initials,
  lineChart,
  money,
  renderIcon,
  stat,
  svg,
  table,
  time,
  toast,
} from '../ui.js';
import { isLibrary, t, tl } from '../vertical.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (period) => {
  const [year, month] = period.split('-');
  return `${MONTHS[Number(month) - 1]} ${String(year).slice(2)}`;
};

/** Icon-set names (see ui.js), not glyphs — the method badge has to line up
 * with the rest of the app's iconography, not with the desk's emoji font. */
const METHOD_ICON = { cash: 'cash', card: 'card', upi: 'smartphone', bank: 'bank', online: 'globe' };
const METHOD_TONE = { cash: 'green', card: 'blue', upi: 'grey', bank: 'violet', online: 'blue' };

/** Plan-mix slices, in order, drawn from the app's own status palette so the
 * donut follows the active theme and light/dark mode. */
const PLAN_COLORS = ['var(--brand)', 'var(--blue)', 'var(--green)', 'var(--violet)', 'var(--amber)', 'var(--red)'];

function greetingFor(hour) {
  if (hour < 5) return 'Good night';
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/** "in since 6:04 AM" → "1h 12m" — recomputed on an interval so the card ages
 * without a full dashboard refresh. */
function formatDuration(checkIn) {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(checkIn).getTime()) / 60000));
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const sinceLine = (checkIn) => `since ${time(checkIn.slice(11))} · ${formatDuration(checkIn)} ago`;

/** A coloured chip for a stat card's footer: direction arrow or status tick + text. */
const pill = (kind, icon, text) =>
  h('span', { class: `trend-pill ${kind}` }, icon ? renderIcon(icon, { size: 14, stroke: 2.2 }) : null, text);

/**
 * A metric card in the dashboard's tinted treatment: gradient icon tile on the
 * left, a ghost watermark on the right, and a footer of chip + caption. It is
 * the shared stat() with the layout and extras layered on, so the click-through,
 * pulse and keyboard behaviour stay in one place.
 */
function toneStat(label, value, { tone, watermark, chip, note, ...options }) {
  const card = stat(label, value, null, options);
  card.classList.add('toned', `tone-${tone}`);
  if (watermark) {
    card.prepend(h('img', { class: 'stat-wm', src: `/images/watermarks/watermark-${watermark}.svg`, alt: '', 'aria-hidden': 'true' }));
  }
  if (chip || note) card.append(h('div', { class: 'stat-foot' }, chip, note ? h('span', { class: 'stat-note' }, note) : null));
  return card;
}

/** Tinted square that fronts a card's title. `icon` is a renderIcon name or a node. */
const headIcon = (icon, tone) =>
  h('span', { class: `head-icon tone-${tone}` }, typeof icon === 'string' ? renderIcon(icon, { size: 18 }) : icon);

/** Read-only caption for the period a chart shows — styled like a picker, but
 * the dashboard API only returns these fixed windows. */
const rangeChip = (text) =>
  h('span', { class: 'range-chip' }, renderIcon('calendar', { size: 14 }), text, renderIcon('chevronRight', { size: 13, class: 'range-caret' }));

/** Card-header link with a trailing arrow ("All payments →"). */
const headLink = (href, text) => h('a', { class: 'head-link', href }, text, renderIcon('arrowRight', { size: 15 }));

/** Ring of plan shares with the member total in the middle. */
function planDonut(rows, total) {
  const radius = 38;
  const circumference = 2 * Math.PI * radius;
  const gap = rows.length > 1 ? 2.5 : 0;
  let offset = 0;
  const slices = rows.map((row, i) => {
    const length = (row.members / total) * circumference;
    const visible = Math.max(length - gap, 0);
    const slice = svg('circle', {
      class: 'donut-slice',
      cx: 50,
      cy: 50,
      r: radius,
      style: `stroke:${PLAN_COLORS[i % PLAN_COLORS.length]}`,
      'stroke-dasharray': `${visible} ${circumference - visible}`,
      'stroke-dashoffset': -offset,
    });
    offset += length;
    return slice;
  });
  return svg(
    'svg',
    { class: 'donut', viewBox: '0 0 100 100', role: 'img', 'aria-label': `${total} total across ${rows.length} ${rows.length === 1 ? 'plan' : 'plans'}` },
    svg('circle', { class: 'donut-track', cx: 50, cy: 50, r: radius }),
    ...slices,
    svg('text', { class: 'donut-total', x: 50, y: 52, 'text-anchor': 'middle' }, total),
    svg('text', { class: 'donut-caption', x: 50, y: 66, 'text-anchor': 'middle' }, 'Total'),
  );
}

export async function renderDashboard({ setActions, navigate, reload }) {
  const data = await api.dashboard();

  setActions(
    h(
      'button',
      { class: 'btn ghost', title: 'Refresh dashboard data', onclick: () => reload() },
      renderIcon('refresh', { size: 16 }),
      isLibrary() ? 'Refresh analytics' : 'Refresh',
    ),
    h(
      'button',
      { class: 'btn', onclick: () => navigate('/check-in') },
      renderIcon('checkin', { size: 16 }),
      isLibrary() ? 'Attendance check-in' : 'Quick check-in',
    ),
    session.managesBilling
      ? h(
          'button',
          { class: 'btn', onclick: () => openPaymentForm({ onSaved: reload }) },
          renderIcon('billing', { size: 16 }),
          isLibrary() ? 'Collect fee' : 'Record payment',
        )
      : null,
    h(
      'button',
      { class: 'btn primary', onclick: () => openMemberForm({ onSaved: (saved) => navigate(`/members/${saved.id}`) }) },
      renderIcon('plus', { size: 16 }),
      isLibrary() ? `Register ${tl('member')}` : 'New member',
    ),
  );

  const growth = data.members.joined_this_month;
  const revenueChange = data.revenue.last_month
    ? Math.round(((data.revenue.this_month - data.revenue.last_month) / data.revenue.last_month) * 100)
    : null;

  /* ---------------------------------------------------------- header strip */

  const header = h(
    'div',
    { class: 'card dash-header' },
    h(
      'div',
      { class: 'dash-copy' },
      h(
        'h2',
        { class: 'dash-greeting' },
        `${greetingFor(new Date().getHours())}, ${(session.user?.name || '').split(' ')[0] || (isLibrary() ? 'SeatBook Admin' : 'there')} `,
        h('span', { class: 'dash-wave', 'aria-hidden': 'true' }, '👋'),
      ),
      h(
        'div',
        { class: 'dash-sub' },
        `Here's what's happening at ${data.gym?.name || (isLibrary() ? 'your library' : 'your gym')} right now.`,
      ),
      h(
        'div',
        { class: 'live-badge' },
        h('span', { class: 'live-pulse' }, h('span', { class: 'live-pulse-core' })),
        isLibrary()
          ? `LIVE · ${data.attendance.currently_in} seated`
          : `LIVE · ${data.attendance.currently_in} in the gym`,
      ),
    ),
    // The illustration is gym equipment, so a library keeps the plain banner.
    isLibrary()
      ? null
      : h(
          'div',
          { class: 'dash-hero', 'aria-hidden': 'true' },
          h('img', { class: 'dash-hero-art', src: '/images/dashboard-hero.svg', alt: '' }),
          h(
            'figure',
            { class: 'dash-quote' },
            h('span', { class: 'dash-quote-mark' }, '“'),
            h('p', {}, 'Stronger Members Brighter Tomorrows'),
            h('span', { class: 'dash-quote-mark close' }, '”'),
          ),
        ),
  );

  /* -------------------------------------------------------------- stat row */

  const statRow = h(
    'div',
    { class: 'grid cols-4' },
    toneStat(isLibrary() ? `Active ${tl('members')}` : 'Active members', data.members.active, {
      tone: 'blue',
      watermark: 'members',
      icon: 'members',
      chip: pill(growth > 0 ? 'pos' : '', growth > 0 ? 'trendUp' : null, growth > 0 ? `+${growth} this month` : `${data.members.total} total`),
      note: `${data.members.total} on the books · ${data.members.frozen || 0} frozen`,
      onClick: () => navigate('/members'),
    }),
    toneStat(isLibrary() ? 'Fee collection this month' : 'Revenue this month', money(data.revenue.this_month, { compact: true }), {
      tone: 'green',
      watermark: 'revenue',
      icon: 'revenue',
      chip:
        revenueChange === null
          ? null
          : pill(revenueChange >= 0 ? 'pos' : 'neg', revenueChange >= 0 ? 'trendUp' : 'trendDown', `${revenueChange >= 0 ? '+' : '−'}${Math.abs(revenueChange)}%`),
      note: `${money(data.revenue.today)} collected today`,
      onClick: () => navigate('/billing'),
    }),
    toneStat(t('inNow'), data.attendance.currently_in, {
      tone: 'purple',
      // The dumbbell is a gym; a library gets the tint without the picture.
      watermark: isLibrary() ? null : 'gym',
      icon: isLibrary() ? 'seats' : 'activity',
      pulse: data.attendance.currently_in > 0,
      note: `${data.attendance.today} ${isLibrary() ? 'sittings' : 'check-ins'} today`,
      // With seats on, "who is in" is a question about the hall, so this
      // opens the live map rather than the check-in desk. Without seats
      // there is no map to show and the desk is still the right answer.
      onClick: data.seats
        ? () => openLiveSeatMap({ navigate })
        : () => navigate('/check-in'),
    }),
    toneStat(isLibrary() ? `Expiring ${tl('plans')} (7 days)` : 'Expiring in 7 days', data.memberships.expiring_soon, {
      tone: 'amber',
      watermark: 'calendar',
      icon: 'hourglass',
      chip: data.revenue.outstanding
        ? pill('warn', 'alert', `${money(data.revenue.outstanding, { compact: true })} in unpaid dues`)
        : pill('pos', 'checkCircle', 'No outstanding dues'),
      onClick: () => navigate('/billing'),
    }),
  );

  const expenseRow = data.expenses
    ? h(
        'div',
        { class: 'grid cols-3' },
        stat('Collected this month', money(data.revenue.this_month, { compact: true }), null, { icon: 'incoming' }),
        stat('Spent this month', money(data.expenses.spent_this_month, { compact: true }), null, { icon: 'outgoing' }),
        stat('Net this month', money(data.expenses.net_this_month, { compact: true }), null, {
          accent: data.expenses.net_this_month >= 0,
          icon: data.expenses.net_this_month >= 0 ? 'trendUp' : 'trendDown',
        }),
      )
    : null;

  /* --------------------------------------------------------- charts row */

  const chartsRow = h(
    'div',
    { class: 'grid cols-2' },
    h(
      'div',
      { class: 'card' },
      h(
        'div',
        { class: 'card-head' },
        headIcon('reports', 'blue'),
        h('h3', {}, isLibrary() ? 'Fee collection, last 6 months' : 'Revenue, last 6 months'),
        h('div', { class: 'spacer' }),
        rangeChip('Last 6 months'),
      ),
      barChart(
        data.revenueTrend.map((row) => ({ label: monthLabel(row.month), value: row.amount })),
        { format: (v) => money(v, { compact: true }) },
      ),
    ),
    h(
      'div',
      { class: 'card' },
      h(
        'div',
        { class: 'card-head' },
        headIcon('activity', 'purple'),
        h('h3', {}, isLibrary() ? 'Daily study visits, last 14 days' : 'Daily check-ins, last 14 days'),
        h('div', { class: 'spacer' }),
        rangeChip('Last 14 days'),
      ),
      lineChart(
        data.attendanceTrend.map((row) => ({ label: row.day.slice(8), value: row.visits })),
        { format: (v) => `${v} visits` },
      ),
    ),
  );

  /* --------------------------------------------------------- renewals card */

  const renewalsBody = h('div', {});
  const renewalsSearch = h('input', {
    class: 'search',
    placeholder: isLibrary() ? `Search by ${tl('member')} or ${tl('plan')}…` : 'Search by member or plan…',
  });

  function renderRenewals() {
    const q = renewalsSearch.value.trim().toLowerCase();
    const rows = q
      ? data.expiringSoon.filter((row) => `${fullName(row)} ${row.plan_name} ${row.code}`.toLowerCase().includes(q))
      : data.expiringSoon;

    if (!rows.length && !q) {
      clear(renewalsBody).append(
        h(
          'div',
          { class: 'empty empty-art' },
          h('img', { class: 'empty-art-img', src: '/images/empty-calendar.svg', alt: '', width: 64, height: 64 }),
          h(
            'div',
            { class: 'empty-title' },
            isLibrary() ? `No ${tl('plans')} due for renewal in the next 10 days` : 'No renewals due in the next 10 days',
          ),
          h('p', {}, isLibrary() ? `All ${tl('plans')} are up to date! 🎉` : 'All memberships are up to date! 🎉'),
        ),
      );
      return;
    }

    clear(renewalsBody).append(
      table(
        [
          { label: 'Member', render: (row) => h('a', { href: `#/members/${row.member_id}` }, fullName(row)) },
          { label: 'Plan', render: (row) => h('span', { class: 'muted' }, row.plan_name) },
          { label: 'Ends', render: (row) => date(row.end_date) },
          { label: '', render: (row) => expiryLabel(row.end_date) },
          {
            label: '',
            render: (row) =>
              h(
                'div',
                { class: 'row', style: 'gap:6px;justify-content:flex-end' },
                session.managesBilling
                  ? h(
                      'button',
                      {
                        class: 'btn sm',
                        onclick: async (event) => {
                          event.stopPropagation();
                          const member = await api.member(row.member_id);
                          openMembershipForm({ member, onSaved: reload });
                        },
                      },
                      'Renew',
                    )
                  : null,
                h(
                  'button',
                  {
                    class: 'btn sm ghost',
                    title: 'Send a renewal reminder on WhatsApp',
                    onclick: async (event) => {
                      event.stopPropagation();
                      const button = event.currentTarget;
                      button.disabled = true;
                      try {
                        await api.sendWhatsAppReminder({ subscription_id: row.id });
                        toast('Renewal reminder sent on WhatsApp');
                      } catch (err) {
                        toast(err.message || 'Could not send the reminder', 'error');
                      } finally {
                        button.disabled = false;
                      }
                    },
                  },
                  renderIcon('whatsapp', { size: 15 }),
                  'Alert',
                ),
              ),
          },
        ],
        rows,
        {
          empty: q
            ? 'No renewals match that search'
            : isLibrary()
              ? `No ${tl('plans')} due for renewal in the next 10 days`
              : 'No renewals due in the next 10 days',
        },
      ),
    );
  }
  renewalsSearch.addEventListener('input', renderRenewals);
  renderRenewals();

  /* --------------------------------------------------------- payments card */

  const paymentsBody = table(
    [
      {
        label: 'Member',
        render: (row) =>
          h(
            'div',
            { class: 'person' },
            h('div', { class: 'avatar sm' }, initials(row.first_name, row.last_name)),
            h('span', { class: 'name' }, fullName(row)),
          ),
      },
      {
        label: 'Method',
        render: (row) =>
          h(
            'span',
            { class: `badge ${METHOD_TONE[row.method] || 'grey'}` },
            renderIcon(METHOD_ICON[row.method] || 'card', { size: 13 }),
            row.method,
          ),
      },
      { label: 'Date', render: (row) => date(row.paid_on) },
      { label: 'Amount', align: 'right', render: (row) => money(row.amount) },
      {
        label: '',
        render: (row) =>
          h(
            'div',
            { class: 'row', style: 'gap:4px;justify-content:flex-end' },
            h(
              'button',
              {
                class: 'btn sm icon-only',
                title: 'Print receipt',
                'aria-label': 'Print receipt',
                onclick: async (event) => {
                  event.stopPropagation();
                  try {
                    const fullPayment = await api.paymentReceipt(row.id);
                    printReceipt(fullPayment, { gymName: getGymName() });
                  } catch (err) {
                    toast(err.message || 'Could not load receipt details', 'error');
                  }
                },
              },
              renderIcon('print', { size: 15 }),
            ),
            h(
              'button',
              {
                class: 'btn sm icon-only',
                title: 'Download receipt',
                'aria-label': 'Download receipt',
                onclick: async (event) => {
                  event.stopPropagation();
                  try {
                    const fullPayment = await api.paymentReceipt(row.id);
                    await downloadReceipt(fullPayment, { gymName: getGymName() });
                  } catch (err) {
                    toast(err.message || 'Could not load receipt details', 'error');
                  }
                },
              },
              renderIcon('download', { size: 15 }),
            ),
          ),
      },
    ],
    data.recentPayments,
    { empty: 'No payments recorded yet' },
  );

  const dataRow = h(
    'div',
    { class: 'grid cols-2 top' },
    h(
      'div',
      { class: 'card' },
      h(
        'div',
        { class: 'card-head' },
        headIcon('bell', 'amber'),
        h('h3', {}, isLibrary() ? 'Pass renewals due' : 'Renewals due'),
        h('div', { class: 'spacer' }),
        headLink('#/billing', t('memberships')),
      ),
      h('div', { class: 'toolbar', style: 'margin-bottom:10px' }, renewalsSearch),
      renewalsBody,
    ),
    h(
      'div',
      { class: 'card' },
      h(
        'div',
        { class: 'card-head' },
        headIcon('billing', 'blue'),
        h('h3', {}, isLibrary() ? 'Recent fee payments' : 'Latest payments'),
        h('div', { class: 'spacer' }),
        headLink('#/billing', 'All payments'),
      ),
      paymentsBody,
    ),
  );

  /* ----------------------------------------------------- checked-in card */

  const checkedInBody = h('div', {});

  function renderCheckedIn() {
    clear(checkedInBody).append(
      data.checkedInNow.length
        ? h(
            'div',
            { class: 'list' },
            ...data.checkedInNow.map((visit) => {
              const durationEl = h('div', { class: 'muted', style: 'font-size:12px' }, sinceLine(visit.check_in));
              const row = h(
                'div',
                { class: 'list-item' },
                h('div', { class: 'avatar' }, initials(visit.first_name, visit.last_name)),
                h('div', { class: 'checkin-who' }, h('div', { style: 'font-weight:600' }, fullName(visit)), durationEl),
                h('div', { class: 'spacer' }),
                h('span', { class: 'badge green' }, isLibrary() ? 'Seated' : 'In gym'),
                h('a', { class: 'btn sm', href: `#/members/${visit.member_id}` }, 'Open'),
                h(
                  'button',
                  {
                    class: 'btn sm danger',
                    onclick: async (event) => {
                      const button = event.currentTarget;
                      button.disabled = true;
                      try {
                        await api.checkOut({ attendance_id: visit.id });
                        toast(`${visit.first_name} checked out`);
                        row.remove();
                        data.checkedInNow = data.checkedInNow.filter((v) => v.id !== visit.id);
                        data.attendance.currently_in = Math.max(0, data.attendance.currently_in - 1);
                        if (!data.checkedInNow.length) renderCheckedIn();
                      } catch (err) {
                        toast(err.message || 'Could not check out', 'error');
                        button.disabled = false;
                      }
                    },
                  },
                  isLibrary() ? 'Mark checkout' : 'Check out',
                ),
              );
              row._duration = { el: durationEl, checkIn: visit.check_in };
              return row;
            }),
          )
        : h('div', { class: 'empty' }, isLibrary() ? 'Nobody is seated right now' : 'Nobody is in the gym right now'),
    );
  }
  renderCheckedIn();

  // Ages the "since … · Xm" line without a network round trip. The router has
  // no teardown hook (see checkin.js), so the tick watches for its own root
  // being detached from the page and stops itself rather than leaking.
  const checkedInTick = setInterval(() => {
    if (!checkedInBody.isConnected) {
      clearInterval(checkedInTick);
      return;
    }
    for (const row of checkedInBody.querySelectorAll('.list-item')) {
      if (row._duration) row._duration.el.textContent = sinceLine(row._duration.checkIn);
    }
  }, 30_000);

  /* -------------------------------------------------- plan mix / occupancy */

  const planMixTotal = data.planMix.reduce((sum, row) => sum + (row.members || 0), 0);

  const mixOrOccupancy = data.seats
    ? h(
        'div',
        { class: 'card' },
        h(
          'div',
          { class: 'card-head' },
          headIcon('seats', 'blue'),
          h('h3', {}, 'Occupancy by shift'),
          h('div', { class: 'spacer' }),
          h('a', { href: '#/seats' }, 'Seat map'),
        ),
        data.seats.by_shift.length
          ? h(
              'div',
              { class: 'list' },
              ...data.seats.by_shift.map((row) => {
                const pct = Math.min((row.occupied / (row.capacity || 1)) * 100, 100);
                return h(
                  'div',
                  { style: 'padding:8px 0' },
                  h(
                    'div',
                    { class: 'row', style: 'justify-content:space-between;margin-bottom:6px' },
                    h('a', { href: `#/seats/${row.session_id}` }, row.name),
                    h('strong', {}, `${row.occupied}/${row.capacity}`),
                  ),
                  h('div', { class: 'meter gradient' }, h('span', { style: `width:${pct}%` }), h('i', { class: 'meter-pct' }, `${Math.round(pct)}%`)),
                );
              }),
            )
          : h('div', { class: 'empty' }, 'No shifts set up yet'),
      )
    : h(
        'div',
        { class: 'card' },
        h('div', { class: 'card-head' }, headIcon('plans', 'blue'), h('h3', {}, 'Plan mix')),
        planMixTotal
          ? h(
              'div',
              { class: 'plan-mix' },
              planDonut(data.planMix, planMixTotal),
              h(
                'div',
                { class: 'plan-mix-list' },
                ...data.planMix.map((row, i) => {
                  const color = PLAN_COLORS[i % PLAN_COLORS.length];
                  const pct = Math.round((row.members / planMixTotal) * 100);
                  return h(
                    'div',
                    { class: 'plan-mix-row' },
                    h(
                      'div',
                      { class: 'plan-mix-label' },
                      h('i', { class: 'plan-dot', style: `background:${color}` }),
                      h('span', { class: 'plan-name' }, row.name),
                      h('strong', {}, row.members),
                      h('span', { class: 'muted plan-share' }, `${pct}%`),
                    ),
                    h(
                      'div',
                      { class: 'meter gradient' },
                      h('span', { style: `width:${pct}%;background:${color}` }),
                    ),
                  );
                }),
              ),
            )
          : h('div', { class: 'empty' }, 'No active memberships'),
      );

  /* -------------------------------------------------------- needs attention */

  const attentionBody = h('div', {});
  const attentionState = { tab: 'all' };
  const attentionTabs = h(
    'div',
    { class: 'filter-tabs' },
    ...[
      ['all', 'All'],
      ['maintenance', isLibrary() ? t('equipment') : 'Maintenance'],
      ['birthdays', 'Birthdays'],
    ].map(([key, label]) =>
      h(
        'button',
        {
          class: `filter-tab ${attentionState.tab === key ? 'active' : ''}`,
          dataset: { tab: key },
          onclick: () => {
            attentionState.tab = key;
            for (const btn of attentionTabs.children) btn.classList.toggle('active', btn.dataset.tab === key);
            renderAttention();
          },
        },
        label,
      ),
    ),
  );

  function renderAttention() {
    const showEquip = attentionState.tab !== 'birthdays';
    const showBirthdays = attentionState.tab !== 'maintenance';
    const equipRows = showEquip
      ? data.equipmentAlerts.map((item) =>
          h(
            'div',
            { class: 'list-item' },
            h('div', { class: 'avatar' }, renderIcon('wrench', { size: 16 })),
            h('span', { style: 'font-weight:600' }, item.name),
            h('div', { class: 'spacer' }),
            item.status === 'maintenance'
              ? h('span', { class: 'badge amber' }, 'In maintenance')
              : h('span', { class: 'badge blue' }, `Service ${date(item.next_service_on)}`),
          ),
        )
      : [];
    const birthdayRows = showBirthdays
      ? data.birthdays.map((member) =>
          h(
            'div',
            { class: 'list-item' },
            h('div', { class: 'avatar' }, initials(member.first_name, member.last_name)),
            h('a', { href: `#/members/${member.id}` }, fullName(member)),
            h('div', { class: 'spacer' }),
            h('span', { class: 'badge violet' }, renderIcon('bell', { size: 13 }), dayMonth(member.date_of_birth)),
            member.phone
              ? h(
                  'button',
                  {
                    class: 'btn sm',
                    title: 'Send a birthday wish on WhatsApp',
                    onclick: async (event) => {
                      const button = event.currentTarget;
                      button.disabled = true;
                      try {
                        await api.sendWhatsAppBirthday(member.id);
                        toast('Birthday wish sent on WhatsApp');
                      } catch (err) {
                        toast(err.message || 'Could not send the birthday wish', 'error');
                      } finally {
                        button.disabled = false;
                      }
                    },
                  },
                  renderIcon('gift', { size: 15 }),
                  'Wish',
                )
              : null,
          ),
        )
      : [];

    clear(attentionBody).append(
      equipRows.length || birthdayRows.length
        ? h('div', { class: 'list' }, ...equipRows, ...birthdayRows)
        : h('div', { class: 'empty' }, 'All clear'),
    );
  }
  renderAttention();

  const attentionCard = h(
    'div',
    { class: 'card' },
    h(
      'div',
      { class: 'card-head' },
      headIcon('alert', 'red'),
      h('h3', {}, isLibrary() ? 'Library needs attention' : 'Needs attention'),
      h('div', { class: 'spacer' }),
      attentionTabs,
    ),
    attentionBody,
  );

  const bottomRow = h(
    'div',
    { class: 'grid cols-3 top dash-bottom' },
    h(
      'div',
      { class: 'card checkin-card' },
      h(
        'div',
        { class: 'card-head' },
        headIcon(h('span', { class: 'head-dot' }), 'green'),
        h('h3', {}, isLibrary() ? 'Currently seated' : 'Currently checked in'),
        h('div', { class: 'spacer' }),
        data.checkedInNow.length ? h('a', { class: 'head-link', href: '#/check-in' }, 'View all', renderIcon('arrowRight', { size: 15 })) : null,
      ),
      checkedInBody,
    ),
    mixOrOccupancy,
    attentionCard,
  );

  return h('div', { class: 'grid', style: 'gap:16px' }, header, statRow, expenseRow, chartsRow, dataRow, bottomRow);
}
