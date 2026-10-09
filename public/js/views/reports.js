import { api } from '../api.js';
import {
  addDays,
  barChart,
  clear,
  date,
  dateField,
  fullName,
  h,
  initials,
  labelledControl,
  lineChart,
  money,
  renderIcon,
  svg,
  table,
  today,
  toast,
} from '../ui.js';
import { isLibrary } from '../vertical.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** Monday-first, the way a gym week is read. */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

const TONE_COLOR = {
  orange: 'var(--brand)',
  blue: 'var(--blue)',
  purple: 'var(--violet)',
  green: 'var(--green)',
  red: 'var(--red)',
};

const METHOD_STYLE = {
  cash: ['green', 'cash'],
  card: ['blue', 'card'],
  upi: ['orange', 'smartphone'],
  bank: ['purple', 'bank'],
  online: ['blue', 'globe'],
};

const EXPORT_ICON = { payments: 'wallet', subscriptions: 'bag' };

const periodLabel = (period) => {
  if (period.length === 7) {
    const [year, month] = period.split('-');
    return `${MONTHS[Number(month) - 1]} ${String(year).slice(2)}`;
  }
  return period.slice(5);
};
const monthOnly = (period) => MONTHS[Number(period.slice(5, 7)) - 1];

const daySpan = (from, to) => Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000));

/** Every YYYY-MM from `from`'s month through `to`'s, so an empty month is a bar, not a gap. */
function monthsBetween(from, to) {
  const out = [];
  let [year, month] = from.slice(0, 7).split('-').map(Number);
  const end = to.slice(0, 7);
  for (let guard = 0; guard < 120; guard++) {
    const key = `${year}-${String(month).padStart(2, '0')}`;
    out.push(key);
    if (key >= end) break;
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return out;
}

function daysBetween(from, to) {
  const out = [];
  for (let day = from, guard = 0; day <= to && guard < 400; day = addDays(day, 1), guard++) out.push(day);
  return out;
}

function lastTwelveMonths() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 11, 1);
  return monthsBetween(start.toLocaleDateString('en-CA'), today());
}

/* ---------------------------------------------------------------- pieces */

const WAVE_BACK = 'M0,62 C45,30 90,34 140,52 C200,74 240,18 300,30 C340,38 370,58 400,46 L400,120 L0,120 Z';
const WAVE_FRONT = 'M0,84 C55,64 100,92 160,78 C225,62 265,98 325,84 C360,76 385,68 400,70 L400,120 L0,120 Z';

/** Two soft hills in the card's tone, drawn behind its content. */
const waves = (className) =>
  svg(
    'svg',
    { class: className, viewBox: '0 0 400 120', preserveAspectRatio: 'none', 'aria-hidden': 'true' },
    svg('path', { d: WAVE_BACK, fill: 'currentColor', opacity: 0.55 }),
    svg('path', { d: WAVE_FRONT, fill: 'currentColor' }),
  );

const tileIcon = (icon, tone, size = 18) =>
  h('span', { class: `rpt-icon rpt-${tone}` }, renderIcon(icon, { size, stroke: 2.2 }));

const cardHead = (icon, tone, title, chip) =>
  h('div', { class: 'rpt-head' }, tileIcon(icon, tone), h('h3', {}, title), chip ? h('span', { class: `rpt-chip rpt-${tone}` }, chip) : null);

const panel = (className, ...children) => h('div', { class: `card rpt-card ${className || ''}` }, ...children);

/** The illustrated "nothing to show" block: tinted hills, an icon tile and one line. */
const emptyArt = (icon, tone, message) =>
  h(
    'div',
    { class: `rpt-empty rpt-${tone}` },
    waves('rpt-empty-waves'),
    h('span', { class: 'rpt-empty-icon' }, renderIcon(icon, { size: 26, stroke: 2 })),
    h('p', {}, message),
  );

const avatar = (person) => h('span', { class: 'bill-avatar rpt-avatar' }, initials(person.first_name, person.last_name));

const personLink = (person) =>
  h('a', { class: 'rpt-person', href: `#/members/${person.id}` }, avatar(person), h('span', {}, fullName(person)));

function shareCell(amount, total, tone) {
  const pct = total ? Math.round((amount / total) * 100) : 0;
  return h(
    'div',
    { class: `rpt-share rpt-${tone}` },
    h('span', { class: 'rpt-share-pct' }, `${pct}%`),
    h('span', { class: 'rpt-bar' }, h('span', { style: `width:${pct}%` })),
  );
}

/**
 * Change against the previous range of the same length. Nothing to compare
 * against (a first period with takings) shows no chip rather than "+∞%".
 */
function trendChip(current, previous) {
  if (!previous && current) return null;
  const pct = previous ? Math.round(((current - previous) / previous) * 100) : 0;
  const dir = pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
  return h(
    'span',
    { class: `rpt-trend ${dir}`, title: 'Compared with the previous period of the same length' },
    dir === 'flat' ? null : renderIcon(dir === 'up' ? 'arrowUp' : 'arrowDown', { size: 13, stroke: 2.6 }),
    `${Math.abs(pct)}%`,
  );
}

/* Mini charts for the metric cards. With fewer than two real readings there
   is no shape to show, so a faint stand-in keeps the card's look instead. */
const FALLBACK_BARS = [0.22, 0.38, 0.55, 0.72, 1];
const FALLBACK_AREA = [2, 3, 2.2, 2.8, 2, 4.5, 3, 3.6, 5.5, 3.4, 2.6];

function sparkBars(values) {
  const real = values.filter((v) => v > 0).length >= 2;
  const shown = real ? values.slice(-6) : FALLBACK_BARS;
  const max = Math.max(...shown) || 1;
  const W = 110;
  const H = 64;
  const gap = 6;
  const bw = (W - gap * (shown.length - 1)) / shown.length;
  return svg(
    'svg',
    { class: `rpt-spark${real ? '' : ' faint'}`, viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true' },
    ...shown.map((v, i) => {
      const bh = Math.max(5, (v / max) * H);
      return svg('rect', { x: i * (bw + gap), y: H - bh, width: bw, height: bh, rx: 3, fill: 'currentColor', opacity: 0.35 + (0.65 * (i + 1)) / shown.length });
    }),
  );
}

function sparkArea(values) {
  const real = values.filter((v) => v > 0).length >= 2;
  const shown = real ? values.slice(-24) : FALLBACK_AREA;
  const max = Math.max(...shown) || 1;
  const W = 160;
  const H = 70;
  const step = W / (shown.length - 1);
  const pts = shown.map((v, i) => [i * step, H - 4 - (v / max) * (H - 12)]);
  // Midpoint quadratic smoothing: soft enough for a sparkline, never overshoots.
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length; i++) {
    const [px, py] = pts[i - 1];
    const [x, y] = pts[i];
    d += ` Q${px},${py} ${(px + x) / 2},${(py + y) / 2}`;
  }
  d += ` L${pts.at(-1)[0]},${pts.at(-1)[1]}`;
  return svg(
    'svg',
    { class: `rpt-spark area${real ? '' : ' faint'}`, viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' },
    svg('path', { d: `${d} L${W},${H} L0,${H} Z`, fill: 'currentColor', opacity: 0.22 }),
    svg('path', { d, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke', opacity: 0.7 }),
  );
}

function kpi({ tone, icon, label, value, sub, trend, spark }) {
  return h(
    'div',
    { class: `rpt-kpi rpt-${tone}` },
    waves('rpt-kpi-waves'),
    h('span', { class: 'rpt-kpi-icon' }, renderIcon(icon, { size: 24, stroke: 2.2 })),
    h(
      'div',
      { class: 'rpt-kpi-body' },
      h('div', { class: 'rpt-kpi-top' }, h('span', { class: 'rpt-kpi-label' }, label), trend),
      h('div', { class: 'rpt-kpi-value' }, value),
      sub ? h('div', { class: 'rpt-kpi-sub' }, sub) : null,
    ),
    spark,
  );
}

const avgVisitsOf = (attendance) =>
  attendance.per_day.length ? Math.round(attendance.per_day.reduce((sum, row) => sum + row.visits, 0) / attendance.per_day.length) : 0;

/* ------------------------------------------------------------------ view */

export async function renderReports({ setActions }) {
  const state = { from: addDays(today(), -90), to: today(), group: 'month' };
  const body = h('div', {});

  const exportable = ['members', 'payments', 'attendance', 'subscriptions', ...(isLibrary() ? ['seats', 'lockers', 'expenses'] : [])];
  setActions(
    ...exportable.map((entity) =>
      h(
        'button',
        { class: 'btn sm', onclick: () => api.download(entity).catch((err) => toast(err.message, 'error')) },
        renderIcon(EXPORT_ICON[entity] || 'download', { size: 15 }),
        entity.charAt(0).toUpperCase() + entity.slice(1),
      ),
    ),
  );

  const fromInput = dateField({
    value: state.from,
    onchange: (e) => {
      state.from = e.target.value;
      render();
    },
  });
  const toInput = dateField({
    value: state.to,
    onchange: (e) => {
      state.to = e.target.value;
      render();
    },
  });
  const groupSelect = h(
    'select',
    {
      class: 'rpt-group',
      'aria-label': 'Group revenue',
      onchange: (e) => {
        state.group = e.target.value;
        render();
      },
    },
    h('option', { value: 'month' }, 'By month'),
    h('option', { value: 'day' }, 'By day'),
  );

  async function render() {
    clear(body).append(h('div', { class: 'empty' }, 'Crunching numbers…'));

    const { from, to, group } = state;
    const prevTo = addDays(from, -1);
    const prevFrom = addDays(prevTo, -daySpan(from, to));

    const [revenue, attendance, growth, prevRevenue, prevAttendance, occupancy, pnl] = await Promise.all([
      api.revenueReport({ from, to, group }),
      api.attendanceReport({ from, to }),
      api.growthReport(),
      api.revenueReport({ from: prevFrom, to: prevTo, group }),
      api.attendanceReport({ from: prevFrom, to: prevTo }),
      isLibrary() ? api.occupancyReport({ from, to }) : Promise.resolve(null),
      isLibrary() ? api.pnlReport({ from, to, group }) : Promise.resolve(null),
    ]);

    const avg = (totals) => (totals.payments ? totals.amount / totals.payments : 0);
    const avgVisits = avgVisitsOf(attendance);
    const peakHour = attendance.per_hour.reduce((best, row) => (row.visits > (best?.visits || 0) ? row : best), null);

    // Revenue, one bar per period in the range (empty periods included).
    const periods = group === 'month' ? monthsBetween(from, to) : daysBetween(from, to);
    const revenueByPeriod = new Map(revenue.series.map((row) => [row.period, row]));
    const revenueSeries = periods.map((period) => ({
      period,
      label: group === 'month' ? (periods.length > 12 ? periodLabel(period) : monthOnly(period)) : period.slice(5),
      value: revenueByPeriod.get(period)?.amount || 0,
      payments: revenueByPeriod.get(period)?.payments || 0,
    }));
    const unit = group === 'month' ? 'month' : 'day';
    const rangeChip =
      to === today()
        ? `Last ${periods.length} ${unit}${periods.length === 1 ? '' : 's'}`
        : `${periodLabel(periods[0])} – ${periodLabel(periods.at(-1))}`;

    const joinsByMonth = new Map(growth.joins.map((row) => [row.month, row.members]));
    const joinsSeries = lastTwelveMonths().map((month) => ({ label: monthOnly(month), value: joinsByMonth.get(month) || 0 }));

    const visitsByHour = new Map(attendance.per_hour.map((row) => [row.hour, row.visits]));
    const hours = attendance.per_hour.map((row) => row.hour);
    const hourSeries = hours.length
      ? Array.from({ length: Math.max(...hours) - Math.min(...hours) + 1 }, (_, i) => {
          const hour = Math.min(...hours) + i;
          return { label: String(hour).padStart(2, '0'), value: visitsByHour.get(hour) || 0 };
        })
      : [];
    const visitsByWeekday = new Map(attendance.per_weekday.map((row) => [row.weekday, row.visits]));
    const weekdaySeries = attendance.per_weekday.length
      ? WEEK_ORDER.map((day) => ({ label: WEEKDAYS[day], value: visitsByWeekday.get(day) || 0 }))
      : [];

    const totalRevenue = revenue.totals.amount;
    const atRisk = attendance.inactive_members.length;

    clear(body).append(
      h(
        'div',
        { class: 'rpt-grid' },

        h(
          'div',
          { class: 'rpt-kpis' },
          kpi({
            tone: 'orange',
            icon: 'bag',
            label: 'Revenue in range',
            value: money(totalRevenue, { compact: true }),
            sub: `${revenue.totals.payments} payment${revenue.totals.payments === 1 ? '' : 's'}`,
            trend: trendChip(totalRevenue, prevRevenue.totals.amount),
            spark: sparkBars(revenueSeries.map((row) => row.value)),
          }),
          kpi({
            tone: 'blue',
            icon: 'card',
            label: 'Average payment',
            value: money(avg(revenue.totals), { compact: true }),
            trend: trendChip(avg(revenue.totals), avg(prevRevenue.totals)),
            spark: sparkBars(revenueSeries.map((row) => (row.payments ? row.value / row.payments : 0))),
          }),
          kpi({
            tone: 'purple',
            icon: 'users',
            label: 'Visits per day',
            value: avgVisits,
            trend: trendChip(avgVisits, avgVisitsOf(prevAttendance)),
            spark: sparkArea(attendance.per_day.map((row) => row.visits)),
          }),
          kpi({
            tone: 'orange',
            icon: 'clock',
            label: 'Busiest hour',
            value: peakHour ? `${String(peakHour.hour).padStart(2, '0')}:00` : '—',
            sub: peakHour ? `${peakHour.visits} check-ins` : null,
            spark: sparkArea(hourSeries.map((row) => row.value)),
          }),
        ),

        h(
          'div',
          { class: 'rpt-row two' },
          panel(
            '',
            cardHead('revenue', 'orange', `Revenue by ${unit}`, rangeChip),
            barChart(revenueSeries, { height: 200, color: TONE_COLOR.orange, ghost: true, peakOnly: true, format: (v) => money(v, { compact: true }) }),
          ),
          panel(
            '',
            cardHead('barChart', 'purple', 'New members per month', 'Last 12 months'),
            barChart(joinsSeries, { height: 200, color: TONE_COLOR.purple, ghost: true, peakOnly: true }),
          ),
        ),

        h(
          'div',
          { class: 'rpt-row two' },
          panel(
            'rpt-table',
            cardHead('wallet', 'orange', 'Payments by method'),
            revenue.by_method.length
              ? table(
                  [
                    {
                      label: 'Method',
                      render: (row) => {
                        const [tone, icon] = METHOD_STYLE[row.method] || ['blue', 'cash'];
                        return h('span', { class: 'rpt-method' }, tileIcon(icon, tone, 17), row.method === 'upi' ? 'UPI' : row.method.charAt(0).toUpperCase() + row.method.slice(1));
                      },
                    },
                    { label: 'Payments', align: 'right', render: (row) => row.payments },
                    { label: 'Amount', render: (row) => money(row.amount) },
                    { label: 'Share', render: (row) => shareCell(row.amount, totalRevenue, 'orange') },
                  ],
                  revenue.by_method,
                )
              : emptyArt('wallet', 'orange', 'No payments in this range'),
          ),
          panel(
            'rpt-table',
            cardHead('crown', 'orange', 'Revenue by plan'),
            revenue.by_plan.length
              ? table(
                  [
                    { label: 'Plan', render: (row) => row.plan },
                    { label: 'Amount', render: (row) => money(row.amount) },
                    { label: 'Share', render: (row) => shareCell(row.amount, totalRevenue, 'orange') },
                  ],
                  revenue.by_plan,
                )
              : emptyArt('crown', 'orange', 'No payments in this range'),
          ),
        ),

        h(
          'div',
          { class: 'rpt-row three' },
          panel(
            '',
            cardHead('calendarCheck', 'orange', 'Check-ins per day'),
            attendance.per_day.length >= 2
              ? lineChart(
                  attendance.per_day.map((row) => ({ label: row.day.slice(5), value: row.visits })),
                  { height: 180, color: TONE_COLOR.orange, format: (v) => `${v} visits` },
                )
              : emptyArt('calendarCheck', 'orange', 'Not enough data yet'),
          ),
          panel(
            '',
            cardHead('barChart', 'purple', 'Busiest hours'),
            hourSeries.length
              ? barChart(hourSeries, { height: 180, color: TONE_COLOR.purple, peakOnly: true })
              : emptyArt('barChart', 'purple', 'No data for this period'),
          ),
          panel(
            '',
            cardHead('calendarCheck', 'green', 'Busiest days of the week'),
            weekdaySeries.length
              ? barChart(weekdaySeries, { height: 180, color: TONE_COLOR.green, peakOnly: true })
              : emptyArt('calendarCheck', 'green', 'No data for this period'),
          ),
        ),

        h(
          'div',
          { class: 'rpt-row two' },
          panel(
            'rpt-table',
            cardHead('crown', 'orange', 'Most regular members'),
            attendance.top_members.length
              ? table(
                  [
                    { label: 'Member', render: personLink },
                    { label: 'Code', render: (row) => h('span', { class: 'muted' }, row.code) },
                    { label: 'Visits', align: 'right', render: (row) => h('strong', {}, row.visits) },
                  ],
                  attendance.top_members,
                )
              : emptyArt('users', 'orange', 'No visits in this range'),
          ),
          panel(
            'rpt-table',
            cardHead('alert', 'red', 'At risk — no visit in 14 days', atRisk ? `${atRisk} member${atRisk === 1 ? '' : 's'}` : null),
            atRisk
              ? table(
                  [
                    { label: 'Member', render: personLink },
                    { label: 'Code', render: (row) => h('span', { class: 'muted' }, row.code) },
                    { label: 'Last visit', render: (row) => (row.last_visit ? date(row.last_visit) : h('span', { class: 'rpt-never' }, 'Never')) },
                  ],
                  attendance.inactive_members,
                )
              : emptyArt('checkCircle', 'green', 'Everyone has visited recently'),
          ),
        ),

        panel(
          'rpt-table',
          cardHead('barChart', 'orange', 'Memberships sold vs lapsed, last 12 months'),
          growth.renewals.length
            ? table(
                [
                  { label: 'Month', render: (row) => periodLabel(row.month) },
                  { label: 'Sold', align: 'right', render: (row) => row.memberships },
                  { label: 'Value', render: (row) => money(row.value) },
                  {
                    label: 'Lapsed without renewal',
                    align: 'right',
                    render: (row) => growth.churn.find((c) => c.month === row.month)?.expired ?? 0,
                  },
                ],
                growth.renewals,
              )
            : emptyArt('barChart', 'orange', 'No membership history yet'),
        ),

        occupancy
          ? h(
              'div',
              { class: 'rpt-row two' },
              panel(
                'rpt-table',
                cardHead('clock', 'blue', 'Revenue by shift'),
                occupancy.by_shift.length
                  ? table(
                      [
                        { label: 'Shift', render: (row) => row.shift_name },
                        { label: 'Revenue', render: (row) => money(row.revenue) },
                        { label: 'Share', render: (row) => shareCell(row.revenue, totalRevenue, 'blue') },
                      ],
                      occupancy.by_shift,
                    )
                  : emptyArt('clock', 'blue', 'No shifts set up yet'),
              ),
              panel(
                '',
                cardHead('seats', 'purple', 'Seats occupied per day'),
                occupancy.daily.length >= 2
                  ? lineChart(
                      occupancy.daily.map((row) => ({ label: row.day.slice(5), value: row.occupied })),
                      { height: 200, color: TONE_COLOR.purple, format: (v) => `${v} seats` },
                    )
                  : emptyArt('seats', 'purple', 'Not enough data yet'),
              ),
            )
          : null,

        pnl
          ? panel(
              '',
              cardHead('revenue', 'green', `Collected vs. spent, by ${unit}`),
              pnl.series.length
                ? barChart(
                    pnl.series.map((row) => ({ label: periodLabel(row.period), value: row.net })),
                    { color: TONE_COLOR.green, format: (v) => money(v, { compact: true }) },
                  )
                : emptyArt('revenue', 'green', 'No data for this period'),
            )
          : null,
      ),
    );
  }

  await render();
  return h(
    'div',
    {},
    h(
      'div',
      { class: 'toolbar rpt-toolbar' },
      h('span', { class: 'rpt-toolbar-icon', 'aria-hidden': 'true' }, renderIcon('calendar', { size: 18 })),
      labelledControl('From', fromInput),
      labelledControl('to', toInput),
      groupSelect,
    ),
    body,
  );
}
