import { api } from '../api.js';
import { addDays, barChart, clear, date, fullName, h, labelledControl, lineChart, money, table, today, toast } from '../ui.js';
import { isLibrary } from '../vertical.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const periodLabel = (period) => {
  if (period.length === 7) {
    const [year, month] = period.split('-');
    return `${MONTHS[Number(month) - 1]} ${String(year).slice(2)}`;
  }
  return period.slice(5);
};

export async function renderReports({ setActions }) {
  const state = { from: addDays(today(), -90), to: today(), group: 'month' };
  const body = h('div', {});

  const exportable = ['members', 'payments', 'attendance', 'subscriptions', ...(isLibrary() ? ['seats', 'lockers', 'expenses'] : [])];
  setActions(
    ...exportable.map((entity) =>
      h(
        'button',
        { class: 'btn sm', onclick: () => api.download(entity).catch((err) => toast(err.message, 'error')) },
        `⇩ ${entity}`,
      ),
    ),
  );

  const fromInput = h('input', {
    type: 'date',
    value: state.from,
    style: 'width:auto',
    onchange: (e) => {
      state.from = e.target.value;
      render();
    },
  });
  const toInput = h('input', {
    type: 'date',
    value: state.to,
    style: 'width:auto',
    onchange: (e) => {
      state.to = e.target.value;
      render();
    },
  });
  const groupSelect = h(
    'select',
    {
      style: 'width:auto',
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

    const [revenue, attendance, growth, occupancy, pnl] = await Promise.all([
      api.revenueReport({ from: state.from, to: state.to, group: state.group }),
      api.attendanceReport({ from: state.from, to: state.to }),
      api.growthReport(),
      isLibrary() ? api.occupancyReport({ from: state.from, to: state.to }) : Promise.resolve(null),
      isLibrary() ? api.pnlReport({ from: state.from, to: state.to, group: state.group }) : Promise.resolve(null),
    ]);

    const avgVisits = attendance.per_day.length
      ? Math.round(attendance.per_day.reduce((sum, row) => sum + row.visits, 0) / attendance.per_day.length)
      : 0;
    const peakHour = attendance.per_hour.reduce((best, row) => (row.visits > (best?.visits || 0) ? row : best), null);

    clear(body).append(
      h(
        'div',
        { class: 'grid', style: 'gap:16px' },
        h(
          'div',
          { class: 'grid cols-4' },
          h('div', { class: 'card stat accent' }, h('div', { class: 'label' }, 'Revenue in range'), h('div', { class: 'value' }, money(revenue.totals.amount, { compact: true })), h('div', { class: 'hint' }, `${revenue.totals.payments} payments`)),
          h('div', { class: 'card stat' }, h('div', { class: 'label' }, 'Average payment'), h('div', { class: 'value' }, money(revenue.totals.payments ? revenue.totals.amount / revenue.totals.payments : 0, { compact: true }))),
          h('div', { class: 'card stat' }, h('div', { class: 'label' }, 'Visits per day'), h('div', { class: 'value' }, avgVisits)),
          h('div', { class: 'card stat' }, h('div', { class: 'label' }, 'Busiest hour'), h('div', { class: 'value' }, peakHour ? `${String(peakHour.hour).padStart(2, '0')}:00` : '—'), h('div', { class: 'hint' }, peakHour ? `${peakHour.visits} check-ins` : '')),
        ),

        h(
          'div',
          { class: 'card' },
          h('div', { class: 'card-head' }, h('h3', {}, `Revenue ${state.group === 'month' ? 'by month' : 'by day'}`)),
          barChart(
            revenue.series.map((row) => ({ label: periodLabel(row.period), value: row.amount })),
            { format: (v) => money(v, { compact: true }) },
          ),
        ),

        h(
          'div',
          { class: 'grid cols-2' },
          h(
            'div',
            { class: 'card' },
            h('div', { class: 'card-head' }, h('h3', {}, 'Payments by method')),
            table(
              [
                { label: 'Method', render: (row) => h('span', { class: 'badge grey' }, row.method) },
                { label: 'Payments', align: 'right', render: (row) => row.payments },
                { label: 'Amount', align: 'right', render: (row) => money(row.amount) },
                {
                  label: 'Share',
                  align: 'right',
                  render: (row) => `${Math.round((row.amount / (revenue.totals.amount || 1)) * 100)}%`,
                },
              ],
              revenue.by_method,
              { empty: 'No payments in this range' },
            ),
          ),
          h(
            'div',
            { class: 'card' },
            h('div', { class: 'card-head' }, h('h3', {}, 'Revenue by plan')),
            table(
              [
                { label: 'Plan', render: (row) => row.plan },
                { label: 'Amount', align: 'right', render: (row) => money(row.amount) },
                {
                  label: 'Share',
                  align: 'right',
                  render: (row) => `${Math.round((row.amount / (revenue.totals.amount || 1)) * 100)}%`,
                },
              ],
              revenue.by_plan,
              { empty: 'No payments in this range' },
            ),
          ),
        ),

        h(
          'div',
          { class: 'grid cols-2' },
          h(
            'div',
            { class: 'card' },
            h('div', { class: 'card-head' }, h('h3', {}, 'Check-ins per day')),
            lineChart(
              attendance.per_day.map((row) => ({ label: row.day.slice(5), value: row.visits })),
              { format: (v) => `${v} visits` },
            ),
          ),
          h(
            'div',
            { class: 'card' },
            h('div', { class: 'card-head' }, h('h3', {}, 'Busiest hours')),
            barChart(
              attendance.per_hour.map((row) => ({ label: String(row.hour).padStart(2, '0'), value: row.visits })),
              { format: (v) => v },
            ),
          ),
        ),

        h(
          'div',
          { class: 'grid cols-2' },
          h(
            'div',
            { class: 'card' },
            h('div', { class: 'card-head' }, h('h3', {}, 'Busiest days of the week')),
            barChart(
              attendance.per_weekday.map((row) => ({ label: WEEKDAYS[row.weekday], value: row.visits })),
              { format: (v) => v },
            ),
          ),
          h(
            'div',
            { class: 'card' },
            h('div', { class: 'card-head' }, h('h3', {}, 'New members per month')),
            barChart(
              growth.joins.map((row) => ({ label: periodLabel(row.month), value: row.members })),
              { format: (v) => v },
            ),
          ),
        ),

        h(
          'div',
          { class: 'grid cols-2' },
          h(
            'div',
            { class: 'card' },
            h('div', { class: 'card-head' }, h('h3', {}, 'Most regular members')),
            table(
              [
                { label: 'Member', render: (row) => h('a', { href: `#/members/${row.id}` }, fullName(row)) },
                { label: 'Code', render: (row) => h('span', { class: 'muted' }, row.code) },
                { label: 'Visits', align: 'right', render: (row) => row.visits },
              ],
              attendance.top_members,
              { empty: 'No visits in this range' },
            ),
          ),
          h(
            'div',
            { class: 'card' },
            h(
              'div',
              { class: 'card-head' },
              h('h3', {}, 'At risk — no visit in 14 days'),
              h('div', { class: 'spacer' }),
              h('span', { class: 'badge amber' }, `${attendance.inactive_members.length} members`),
            ),
            table(
              [
                { label: 'Member', render: (row) => h('a', { href: `#/members/${row.id}` }, fullName(row)) },
                { label: 'Code', render: (row) => h('span', { class: 'muted' }, row.code) },
                { label: 'Last visit', render: (row) => (row.last_visit ? date(row.last_visit) : h('span', { class: 'badge red' }, 'Never')) },
              ],
              attendance.inactive_members,
              { empty: 'Everyone has visited recently' },
            ),
          ),
        ),

        h(
          'div',
          { class: 'card' },
          h('div', { class: 'card-head' }, h('h3', {}, 'Memberships sold vs lapsed, last 12 months')),
          table(
            [
              { label: 'Month', render: (row) => periodLabel(row.month) },
              { label: 'Sold', align: 'right', render: (row) => row.memberships },
              { label: 'Value', align: 'right', render: (row) => money(row.value) },
              {
                label: 'Lapsed without renewal',
                align: 'right',
                render: (row) => growth.churn.find((c) => c.month === row.month)?.expired ?? 0,
              },
            ],
            growth.renewals,
            { empty: 'No membership history yet' },
          ),
        ),

        occupancy
          ? h(
              'div',
              { class: 'grid cols-2' },
              h(
                'div',
                { class: 'card' },
                h('div', { class: 'card-head' }, h('h3', {}, 'Revenue by shift')),
                table(
                  [
                    { label: 'Shift', render: (row) => row.shift_name },
                    { label: 'Revenue', align: 'right', render: (row) => money(row.revenue) },
                  ],
                  occupancy.by_shift,
                  { empty: 'No shifts set up yet' },
                ),
              ),
              h(
                'div',
                { class: 'card' },
                h('div', { class: 'card-head' }, h('h3', {}, 'Seats occupied per day')),
                lineChart(
                  occupancy.daily.map((row) => ({ label: row.day.slice(5), value: row.occupied })),
                  { format: (v) => `${v} seats` },
                ),
              ),
            )
          : null,

        pnl
          ? h(
              'div',
              { class: 'card' },
              h('div', { class: 'card-head' }, h('h3', {}, `Collected vs. spent, ${state.group === 'month' ? 'by month' : 'by day'}`)),
              barChart(
                pnl.series.map((row) => ({ label: periodLabel(row.period), value: row.net })),
                { format: (v) => money(v, { compact: true }) },
              ),
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
      { class: 'toolbar' },
      labelledControl('From', fromInput),
      labelledControl('to', toInput),
      groupSelect,
    ),
    body,
  );
}
