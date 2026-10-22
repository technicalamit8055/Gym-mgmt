import { coaching } from '../coachingApi.js';
import { clear, date, h, initials, money, renderIcon, time, toast, today } from '../ui.js';
import { attendanceCalendarView } from './coaching/attendance.js';
import { fill, INSTALLMENT_STATUS, MATERIAL_KIND_LABEL, pct, TEST_TYPE_LABEL, tone, WEEK_ORDER, WEEKDAYS, WEEKDAYS_LONG } from './coaching/common.js';

/**
 * The CoachBook student & parent app — the tabs renderPortalApp() in
 * portal.js draws for an institute instead of the gym's Workout/Diet/Store:
 *
 *   Home        digital student ID, today's classes, fee banner, latest result
 *   Timetable   the week's lectures by day, and upcoming tests
 *   Tests       results with rank and percentile, subject averages, trend
 *   Fees        course fee, installments, payments and PDF receipts
 *   Attendance  the month as a calendar (from Home and Profile)
 *   Notes       notes, DPPs, PYQs and assignments to download (from Home)
 *
 * The QR ID itself is the portal's existing Pass tab — the same scannable
 * code the gate terminal and the desk read.
 */

const fmt = (v) => (v === null || v === undefined ? '—' : Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100));
const nowHHMM = () => new Date().toTimeString().slice(0, 5);
const name = (m) => `${m.first_name || ''} ${m.last_name || ''}`.trim();

function tabBody(title, subtitle, ...children) {
  return h(
    'div',
    { class: 'portal-tab-body cbp-stack' },
    h('div', { class: 'portal-page-head' }, h('h2', {}, title), subtitle ? h('p', {}, subtitle) : null),
    ...children,
  );
}

function classRow(slot) {
  const isNow = slot.weekday === new Date().getDay() && slot.start_time <= nowHHMM() && slot.end_time > nowHHMM();
  return h(
    'div',
    { class: `cbp-class${isNow ? ' is-now' : ''}` },
    h('div', { class: 'cbp-class-time' }, time(slot.start_time)),
    h(
      'div',
      { class: 'cb-grow' },
      h('div', { class: 'cb-strong' }, slot.subject_name),
      h('div', { class: 'muted cb-small' }, [slot.effective_room, slot.faculty_name, `till ${time(slot.end_time)}`].filter(Boolean).join(' · ')),
    ),
  );
}

export function coachingPortalTabs({ getMe, switchTab }) {
  async function home() {
    const me = getMe();
    const data = await coaching.portal.overview();
    const m = me.member;
    const enrollment = data.enrollments[0];
    const att = data.attendance;
    const due = data.fees.next_due;
    const daysToDue = due ? Math.round((Date.parse(`${due.due_date}T00:00:00`) - Date.parse(`${today()}T00:00:00`)) / 86_400_000) : null;

    const idCard = h(
      'div',
      { class: 'cbp-id' },
      h(
        'div',
        { class: 'cbp-id-top' },
        m.photo_url ? h('img', { class: 'cbp-id-photo', src: m.photo_url, alt: '' }) : h('div', { class: 'cbp-id-photo' }, initials(m.first_name, m.last_name)),
        h(
          'div',
          { class: 'cb-grow' },
          h('div', { class: 'cbp-id-name' }, name(m)),
          h('div', { class: 'cbp-id-sub' }, `Student ID ${m.code}${enrollment?.roll_number ? ` · Roll ${enrollment.roll_number}` : ''}`),
          h('div', { class: 'cbp-id-sub' }, enrollment ? `${enrollment.batch_name} · ${enrollment.course_name}` : 'Not in a batch yet'),
        ),
      ),
      h(
        'div',
        { class: 'cbp-id-meta' },
        h('div', {}, h('strong', {}, pct(att?.percentage)), 'Attendance'),
        h('div', {}, h('strong', {}, data.next_test ? date(data.next_test.test_date).slice(0, 5) : '—'), 'Next test'),
        h('div', {}, h('strong', {}, data.fees.balance > 0 ? money(data.fees.balance, { compact: true }) : 'Paid'), 'Fee balance'),
      ),
      h('button', { class: 'cbp-id-btn', type: 'button', onclick: () => switchTab('pass') }, renderIcon('qrCode', { size: 18 }), 'Show my QR ID'),
    );

    const banner =
      due && (daysToDue <= 7 || data.fees.overdue_amount > 0)
        ? h(
            'button',
            { class: `cbp-banner${daysToDue < 0 ? ' is-overdue' : ''}`, type: 'button', style: 'text-align:left;font:inherit;color:inherit;cursor:pointer', onclick: () => switchTab('fees') },
            renderIcon('alert', { size: 20 }),
            h(
              'div',
              { class: 'cb-grow' },
              h('div', { class: 'cb-strong' }, daysToDue < 0 ? `Installment ${due.installment_number} is overdue` : `Installment ${due.installment_number} due ${daysToDue === 0 ? 'today' : `in ${daysToDue} day${daysToDue === 1 ? '' : 's'}`}`),
              h('div', { class: 'cb-small muted' }, `${money(due.balance)} · ${due.course_name} · due ${date(due.due_date)}`),
            ),
            renderIcon('chevronRight', { size: 18 }),
          )
        : null;

    const classes = h(
      'div',
      { class: 'cbp-card' },
      h('div', { class: 'cbp-head' }, h('h3', { class: 'cbp-title' }, `Today · ${WEEKDAYS_LONG[data.today.weekday]}`), h('button', { class: 'cbp-link', type: 'button', onclick: () => switchTab('schedule') }, 'Timetable')),
      data.today.classes.length ? h('div', {}, ...data.today.classes.map(classRow)) : h('div', { class: 'cbp-empty' }, 'No classes today.'),
    );

    const latest = data.latest_result;
    const stats = h(
      'div',
      { class: 'cbp-stats' },
      h('button', { class: 'cbp-stat', type: 'button', onclick: () => switchTab('attendance') }, h('strong', {}, pct(att?.percentage)), h('span', {}, 'This month')),
      h(
        'button',
        { class: 'cbp-stat', type: 'button', onclick: () => switchTab('tests') },
        h('strong', {}, latest && !latest.is_absent ? `#${latest.rank ?? '—'}` : '—'),
        h('span', {}, latest ? 'Last test rank' : 'No results yet'),
      ),
      h('button', { class: 'cbp-stat', type: 'button', onclick: () => switchTab('materials') }, h('strong', {}, renderIcon('fileText', { size: 20 })), h('span', {}, 'Notes & DPPs')),
    );

    const result = latest
      ? h(
          'div',
          { class: 'cbp-card' },
          h('div', { class: 'cbp-head' }, h('h3', { class: 'cbp-title' }, 'Latest result'), h('button', { class: 'cbp-link', type: 'button', onclick: () => switchTab('tests') }, 'All tests')),
          testRow(latest),
        )
      : null;

    const nextTest = data.next_test
      ? h(
          'div',
          { class: 'cbp-card cbp-row' },
          h('span', { class: 'cb-section-icon' }, renderIcon('calendar', { size: 17 })),
          h(
            'div',
            { class: 'cb-grow' },
            h('div', { class: 'cb-strong' }, data.next_test.title),
            h('div', { class: 'muted cb-small' }, `${TEST_TYPE_LABEL[data.next_test.test_type]} · ${date(data.next_test.test_date)} · out of ${fmt(data.next_test.max_marks)}`),
            data.next_test.syllabus ? h('div', { class: 'cb-small' }, data.next_test.syllabus) : null,
          ),
        )
      : null;

    const hello = new Date().getHours() < 12 ? 'Good morning' : new Date().getHours() < 17 ? 'Good afternoon' : 'Good evening';
    return h(
      'div',
      { class: 'portal-tab-body cbp-stack' },
      h('div', { class: 'portal-page-head' }, h('h2', {}, `${hello}, ${m.first_name}`), h('p', {}, 'Here is your day at the institute.')),
      idCard,
      banner,
      classes,
      stats,
      nextTest,
      result,
    );
  }

  async function schedule() {
    const data = await coaching.portal.timetable();
    let day = new Date().getDay();
    const list = h('div', {});
    const strip = h('div', { class: 'cbp-days' });
    const paint = () => {
      fill(strip, 
        ...WEEK_ORDER.map((d) =>
          h(
            'button',
            {
              type: 'button',
              class: `cbp-day${d === day ? ' is-on' : ''}${d === new Date().getDay() ? ' is-today' : ''}`,
              onclick: () => {
                day = d;
                paint();
              },
            },
            WEEKDAYS[d],
            h('div', { class: 'cb-small' }, String(data.slots.filter((s) => s.weekday === d).length || '·')),
          ),
        ),
      );
      const slots = data.slots.filter((s) => s.weekday === day);
      fill(list, 
        h('h3', { class: 'cbp-title', style: 'margin-bottom:6px' }, WEEKDAYS_LONG[day]),
        slots.length ? h('div', {}, ...slots.map(classRow)) : h('div', { class: 'cbp-empty' }, `No classes on ${WEEKDAYS_LONG[day]}.`),
      );
    };
    paint();
    return tabBody(
      'Timetable',
      'Your weekly classes and upcoming tests.',
      strip,
      h('div', { class: 'cbp-card' }, list),
      h(
        'div',
        { class: 'cbp-card' },
        h('h3', { class: 'cbp-title', style: 'margin-bottom:6px' }, 'Upcoming tests'),
        data.upcoming_tests.length
          ? h(
              'div',
              {},
              ...data.upcoming_tests.map((t) =>
                h(
                  'div',
                  { class: 'cbp-test' },
                  h('div', { class: 'cbp-score' }, date(t.test_date).slice(0, 5), h('small', {}, WEEKDAYS[new Date(`${t.test_date}T00:00:00`).getDay()])),
                  h('div', { class: 'cb-grow' }, h('div', { class: 'cb-strong' }, t.title), h('div', { class: 'muted cb-small' }, `${TEST_TYPE_LABEL[t.test_type]}${t.subject_name ? ` · ${t.subject_name}` : ''} · out of ${fmt(t.max_marks)}`), t.syllabus ? h('div', { class: 'cb-small' }, t.syllabus) : null),
                ),
              ),
            )
          : h('div', { class: 'cbp-empty' }, 'No tests in the next few weeks.'),
      ),
    );
  }

  async function attendance() {
    const host = h('div', { class: 'cbp-card' }, h('div', { class: 'cbp-empty' }, 'Loading…'));
    const load = async (month) => {
      const data = await coaching.portal.attendance(month);
      fill(host, attendanceCalendarView(data, { onMonth: (m) => load(m).catch((e) => toast(e.message, 'error')) }));
    };
    await load(today().slice(0, 7));
    return tabBody('Attendance', 'Green is present, red is absent. Tap a day for each lecture.', host);
  }

  function testRow(t) {
    return h(
      'div',
      { class: 'cbp-test' },
      h('div', { class: 'cbp-score' }, t.is_absent ? 'AB' : fmt(t.marks_obtained), h('small', {}, t.is_absent ? 'absent' : `of ${fmt(t.max_marks)}`)),
      h(
        'div',
        { class: 'cb-grow' },
        h('div', { class: 'cb-strong' }, t.title),
        h('div', { class: 'muted cb-small' }, `${TEST_TYPE_LABEL[t.test_type]}${t.subject_name ? ` · ${t.subject_name}` : ''} · ${date(t.test_date)}`),
        t.is_absent
          ? null
          : h(
              'div',
              { class: 'cb-small' },
              `Rank ${t.rank ?? '—'} of ${t.appeared} · Percentile ${fmt(t.percentile)} · Batch avg ${fmt(t.average)} · Top ${fmt(t.highest)}`,
            ),
        t.remarks ? h('div', { class: 'cb-small muted' }, `“${t.remarks}”`) : null,
      ),
    );
  }

  async function tests() {
    const card = await coaching.portal.tests();
    const sat = card.tests.filter((t) => !t.is_absent).slice(0, 10).reverse();
    const trend = sat.length >= 2
      ? h(
          'div',
          { class: 'cbp-card' },
          h('h3', { class: 'cbp-title' }, 'Your trend'),
          h('p', { class: 'cbp-sub' }, 'Score as a percentage, last tests'),
          h(
            'div',
            { class: 'cbp-trend' },
            ...sat.map((t) => {
              const p = Math.max(2, Math.min(100, (t.marks_obtained / t.max_marks) * 100));
              return h('div', { class: 'cbp-trend-bar', style: `height:${p}%`, title: `${t.title}: ${fmt(p)}%` }, h('span', {}, `${Math.round(p)}`));
            }),
          ),
        )
      : null;
    return tabBody(
      'Tests & results',
      card.tests_taken ? `${card.tests_taken} tests taken · average ${pct(card.overall_percentage)}` : 'Your results appear here once they are published.',
      trend,
      card.subjects.length
        ? h(
            'div',
            { class: 'cbp-card' },
            h('h3', { class: 'cbp-title', style: 'margin-bottom:6px' }, 'By subject'),
            ...card.subjects.map((s) =>
              h(
                'div',
                { class: 'cbp-subject' },
                h('span', { style: 'min-width:96px' }, s.subject_name),
                h('div', { class: `cb-bar${s.average_percentage < 40 ? ' is-low' : s.average_percentage < 60 ? ' is-mid' : ''}` }, h('span', { class: 'cb-bar-fill', style: `width:${s.average_percentage}%` }), h('span', { class: 'cb-bar-label' }, `${s.average_percentage}%`)),
              ),
            ),
          )
        : null,
      h('div', { class: 'cbp-card' }, card.tests.length ? h('div', {}, ...card.tests.map(testRow)) : h('div', { class: 'cbp-empty' }, 'No published results yet.')),
    );
  }

  async function materials() {
    const { items } = await coaching.portal.materials();
    const kinds = [...new Set(items.map((m) => m.kind))];
    let filter = '';
    const list = h('div', {});
    const chips = h('div', { class: 'cbp-days' });
    const paint = () => {
      fill(chips, 
        h('button', { type: 'button', class: `cbp-day${!filter ? ' is-on' : ''}`, onclick: () => { filter = ''; paint(); } }, 'All'),
        ...kinds.map((k) => h('button', { type: 'button', class: `cbp-day${filter === k ? ' is-on' : ''}`, onclick: () => { filter = k; paint(); } }, MATERIAL_KIND_LABEL[k])),
      );
      const shown = items.filter((m) => !filter || m.kind === filter);
      fill(list, 
        shown.length
          ? h(
              'div',
              {},
              ...shown.map((m) =>
                h(
                  'div',
                  { class: 'cbp-install' },
                  h('span', { class: `cb-kind is-${m.kind}` }, renderIcon(m.has_file ? 'fileText' : 'link', { size: 17 })),
                  h(
                    'div',
                    { class: 'cb-grow' },
                    h('div', { class: 'cb-strong' }, m.title),
                    h('div', { class: 'muted cb-small' }, [MATERIAL_KIND_LABEL[m.kind], m.subject_name, date(m.created_at)].filter(Boolean).join(' · ')),
                    m.kind === 'assignment'
                      ? h(
                          'span',
                          { class: `badge ${m.submission?.status === 'pending' ? 'amber' : 'green'}` },
                          m.submission?.status === 'pending' ? `To submit${m.due_date ? ` by ${date(m.due_date)}` : ''}` : 'Submitted',
                        )
                      : null,
                  ),
                  m.has_file
                    ? h(
                        'button',
                        {
                          class: 'btn sm',
                          type: 'button',
                          'aria-label': `Download ${m.title}`,
                          onclick: () => coaching.portal
                              .downloadMaterial(m.id)
                              .then((saved) => saved && toast(saved))
                              .catch((err) => toast(err.message, 'error')),
                        },
                        renderIcon('download', { size: 15 }),
                      )
                    : h('a', { class: 'btn sm', href: m.file_url, target: '_blank', rel: 'noopener', 'aria-label': `Open ${m.title}` }, renderIcon('link', { size: 15 })),
                ),
              ),
            )
          : h('div', { class: 'cbp-empty' }, 'Nothing here yet.'),
      );
    };
    paint();
    return tabBody('Notes & DPPs', 'Study material from your teachers.', kinds.length > 1 ? chips : null, h('div', { class: 'cbp-card' }, list));
  }

  async function fees() {
    const data = await coaching.portal.fees();
    if (!data.plans.length) return tabBody('Fees', null, h('div', { class: 'cbp-card cbp-empty' }, 'No course fee on your account yet.'));
    return tabBody(
      'Fees',
      'Your course fee, installments and receipts.',
      ...data.plans.map((plan) => {
        const paidPct = plan.final_amount ? Math.min(100, (plan.amount_paid / plan.final_amount) * 100) : 0;
        return h(
          'div',
          { class: 'cbp-card' },
          h('h3', { class: 'cbp-title' }, plan.course_name),
          h('p', { class: 'cbp-sub' }, `${plan.batch_name || ''}${plan.discount_amount ? ` · ${money(plan.discount_amount)} concession` : ''}`),
          h('div', { class: 'cbp-progress' }, h('span', { style: `width:${paidPct}%` })),
          h('div', { class: 'cbp-row cb-small' }, h('span', { class: 'cb-grow' }, `${money(plan.amount_paid)} paid of ${money(plan.final_amount)}`), h('strong', {}, plan.balance > 0.005 ? `${money(plan.balance)} left` : 'Fully paid')),
          h(
            'div',
            { style: 'margin-top:8px' },
            ...plan.installments.map((inst) =>
              h(
                'div',
                { class: 'cbp-install' },
                h('span', { class: 'cb-roll' }, `#${inst.installment_number}`),
                h('div', { class: 'cb-grow' }, h('div', { class: 'cb-strong' }, money(inst.amount_due)), h('div', { class: 'muted cb-small' }, `${inst.label || ''} · due ${date(inst.due_date)}${inst.amount_paid > 0 && inst.balance > 0.005 ? ` · ${money(inst.balance)} left` : ''}`)),
                tone(INSTALLMENT_STATUS, inst.status),
              ),
            ),
          ),
        );
      }),
      h(
        'div',
        { class: 'cbp-card' },
        h('h3', { class: 'cbp-title', style: 'margin-bottom:6px' }, 'Receipts'),
        data.payments.length
          ? h(
              'div',
              {},
              ...data.payments.map((p) =>
                h(
                  'div',
                  { class: 'cbp-install' },
                  h('div', { class: 'cb-grow' }, h('div', { class: 'cb-strong' }, money(p.amount)), h('div', { class: 'muted cb-small' }, `${p.receipt_no} · ${date(p.paid_on)} · ${String(p.method).toUpperCase()}${p.cheque_status === 'pending' ? ' · cheque clearing' : ''}`)),
                  h(
                    'button',
                    { class: 'btn sm', type: 'button', 'aria-label': `Download receipt ${p.receipt_no}`, onclick: () => coaching.portal.downloadReceipt(p.id).then((saved) => saved && toast(saved)).catch((err) => toast(err.message, 'error')) },
                    renderIcon('download', { size: 15 }),
                    'PDF',
                  ),
                ),
              ),
            )
          : h('div', { class: 'cbp-empty' }, 'No payments yet.'),
      ),
    );
  }

  return { home, schedule, attendance, tests, materials, fees };
}

/** The bottom bar for an institute (see buildTabs in portal.js). */
export const COACHING_PORTAL_TABS = [
  { key: 'home', label: 'Home', icon: 'home' },
  { key: 'schedule', label: 'Timetable', icon: 'calendarTab' },
  { key: 'tests', label: 'Tests', icon: 'trophyTab' },
  { key: 'fees', label: 'Fees', icon: 'walletTab' },
  { key: 'profile', label: 'Profile', icon: 'person' },
];
