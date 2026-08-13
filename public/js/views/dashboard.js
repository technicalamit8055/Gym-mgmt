import { api } from '../api.js';
import {
  barChart,
  date,
  expiryLabel,
  fullName,
  h,
  initials,
  lineChart,
  money,
  stat,
  table,
  time,
} from '../ui.js';
import { t } from '../vertical.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (period) => {
  const [year, month] = period.split('-');
  return `${MONTHS[Number(month) - 1]} ${String(year).slice(2)}`;
};

export async function renderDashboard({ setActions, navigate }) {
  const data = await api.dashboard();

  setActions(
    h('button', { class: 'btn', onclick: () => navigate('/check-in') }, '🎫 Check in a member'),
    h('button', { class: 'btn primary', onclick: () => navigate('/members') }, '＋ New member'),
  );

  const growth = data.members.joined_this_month;
  const revenueChange = data.revenue.last_month
    ? Math.round(((data.revenue.this_month - data.revenue.last_month) / data.revenue.last_month) * 100)
    : null;

  return h(
    'div',
    { class: 'grid', style: 'gap:16px' },

    h(
      'div',
      { class: 'grid cols-4' },
      stat('Active members', data.members.active, `${data.members.total} on the books · ${growth} joined this month`, {
        accent: true,
      }),
      stat(
        'Revenue this month',
        money(data.revenue.this_month, { compact: true }),
        revenueChange === null
          ? `${money(data.revenue.today)} collected today`
          : `${revenueChange >= 0 ? '▲' : '▼'} ${Math.abs(revenueChange)}% vs last month`,
      ),
      stat(t('inNow'), data.attendance.currently_in, `${data.attendance.today} check-ins today`),
      stat(
        'Expiring in 7 days',
        data.memberships.expiring_soon,
        `${money(data.revenue.outstanding, { compact: true })} in unpaid dues`,
      ),
    ),

    data.expenses
      ? h(
          'div',
          { class: 'grid cols-3' },
          stat('Collected this month', money(data.revenue.this_month, { compact: true })),
          stat('Spent this month', money(data.expenses.spent_this_month, { compact: true })),
          stat('Net this month', money(data.expenses.net_this_month, { compact: true }), null, {
            accent: data.expenses.net_this_month >= 0,
          }),
        )
      : null,

    h(
      'div',
      { class: 'grid cols-2' },
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'card-head' }, h('h3', {}, 'Revenue, last 6 months'), h('div', { class: 'spacer' })),
        barChart(
          data.revenueTrend.map((row) => ({ label: monthLabel(row.month), value: row.amount })),
          { format: (v) => money(v, { compact: true }) },
        ),
      ),
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'card-head' }, h('h3', {}, 'Daily check-ins, last 14 days')),
        lineChart(
          data.attendanceTrend.map((row) => ({ label: row.day.slice(8), value: row.visits })),
          { format: (v) => `${v} visits` },
        ),
      ),
    ),

    h(
      'div',
      { class: 'grid cols-2 top' },
      h(
        'div',
        { class: 'card' },
        h(
          'div',
          { class: 'card-head' },
          h('h3', {}, 'Renewals due'),
          h('div', { class: 'spacer' }),
          h('a', { href: '#/billing' }, 'All memberships'),
        ),
        table(
          [
            { label: 'Member', render: (row) => h('a', { href: `#/members/${row.member_id}` }, fullName(row)) },
            { label: 'Plan', render: (row) => h('span', { class: 'muted' }, row.plan_name) },
            { label: 'Ends', render: (row) => date(row.end_date) },
            { label: '', render: (row) => expiryLabel(row.end_date) },
          ],
          data.expiringSoon,
          { empty: 'No renewals due in the next 10 days' },
        ),
      ),
      h(
        'div',
        { class: 'card' },
        h(
          'div',
          { class: 'card-head' },
          h('h3', {}, 'Latest payments'),
          h('div', { class: 'spacer' }),
          h('a', { href: '#/billing' }, 'All payments'),
        ),
        table(
          [
            { label: 'Member', render: (row) => fullName(row) },
            { label: 'Method', render: (row) => h('span', { class: 'badge grey' }, row.method) },
            { label: 'Date', render: (row) => date(row.paid_on) },
            { label: 'Amount', align: 'right', render: (row) => money(row.amount) },
          ],
          data.recentPayments,
          { empty: 'No payments recorded yet' },
        ),
      ),
    ),

    h(
      'div',
      { class: 'grid cols-3 top' },
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'card-head' }, h('h3', {}, 'Currently checked in')),
        data.checkedInNow.length
          ? h(
              'div',
              { class: 'list' },
              ...data.checkedInNow.map((visit) =>
                h(
                  'div',
                  { class: 'list-item' },
                  h('div', { class: 'avatar' }, initials(visit.first_name, visit.last_name)),
                  h(
                    'div',
                    {},
                    h('div', { style: 'font-weight:600' }, fullName(visit)),
                    h('div', { class: 'muted', style: 'font-size:12px' }, `since ${time(visit.check_in.slice(11))}`),
                  ),
                  h('div', { class: 'spacer' }),
                  h('a', { class: 'btn sm ghost', href: `#/members/${visit.member_id}` }, 'Open'),
                ),
              ),
            )
          : h('div', { class: 'empty' }, 'Nobody is in the gym right now'),
      ),
      data.seats
        ? h(
            'div',
            { class: 'card' },
            h(
              'div',
              { class: 'card-head' },
              h('h3', {}, 'Occupancy by shift'),
              h('div', { class: 'spacer' }),
              h('a', { href: '#/seats' }, 'Seat map'),
            ),
            data.seats.by_shift.length
              ? h(
                  'div',
                  { class: 'list' },
                  ...data.seats.by_shift.map((row) =>
                    h(
                      'div',
                      { style: 'padding:8px 0' },
                      h(
                        'div',
                        { class: 'row', style: 'justify-content:space-between;margin-bottom:6px' },
                        h('a', { href: `#/seats/${row.session_id}` }, row.name),
                        h('strong', {}, `${row.occupied}/${row.capacity}`),
                      ),
                      h('div', { class: 'meter' }, h('span', { style: `width:${Math.min((row.occupied / (row.capacity || 1)) * 100, 100)}%` })),
                    ),
                  ),
                )
              : h('div', { class: 'empty' }, 'No shifts set up yet'),
          )
        : h(
            'div',
            { class: 'card' },
            h('div', { class: 'card-head' }, h('h3', {}, 'Plan mix')),
            data.planMix.length
              ? h(
                  'div',
                  { class: 'list' },
                  ...data.planMix.map((row) => {
                    const top = data.planMix[0].members || 1;
                    return h(
                      'div',
                      { style: 'padding:8px 0' },
                      h(
                        'div',
                        { class: 'row', style: 'justify-content:space-between;margin-bottom:6px' },
                        h('span', {}, row.name),
                        h('strong', {}, row.members),
                      ),
                      h('div', { class: 'meter' }, h('span', { style: `width:${(row.members / top) * 100}%` })),
                    );
                  }),
                )
              : h('div', { class: 'empty' }, 'No active memberships'),
          ),
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'card-head' }, h('h3', {}, 'Needs attention')),
        h(
          'div',
          { class: 'list' },
          ...data.equipmentAlerts.map((item) =>
            h(
              'div',
              { class: 'list-item' },
              h('span', {}, item.name),
              h('div', { class: 'spacer' }),
              item.status === 'maintenance'
                ? h('span', { class: 'badge amber' }, 'In maintenance')
                : h('span', { class: 'badge blue' }, `Service ${date(item.next_service_on)}`),
            ),
          ),
          ...data.birthdays.map((member) =>
            h(
              'div',
              { class: 'list-item' },
              h('a', { href: `#/members/${member.id}` }, fullName(member)),
              h('div', { class: 'spacer' }),
              h('span', { class: 'badge violet' }, `🎂 ${date(member.date_of_birth).slice(0, 6)}`),
            ),
          ),
          !data.equipmentAlerts.length && !data.birthdays.length
            ? h('div', { class: 'empty' }, 'All clear')
            : null,
        ),
      ),
    ),
  );
}
