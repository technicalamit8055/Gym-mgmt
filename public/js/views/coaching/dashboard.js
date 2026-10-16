import { session } from '../../api.js';
import { coaching } from '../../coachingApi.js';
import { date, emptyState, h, money, renderIcon, stat, toast } from '../../ui.js';
import { requestSheet } from './attendance.js';
import { INQUIRY_STATUS, TEST_TYPE_LABEL, fullName, pct, percentBar, section, timeRange, tone } from './common.js';

/**
 * The director's first screen: what is happening today (lectures and how far
 * attendance has got), what money is in and still out, who needs a call
 * (fee defaulters, admissions follow-ups, students under the attendance
 * line), and which tests are coming or still need their results published.
 */

const greeting = (hour) => (hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening');

function lectureRow(lecture, navigate) {
  const done = lecture.marked > 0;
  return h(
    'div',
    { class: 'list-item cb-lecture' },
    h('div', { class: 'cb-lecture-time' }, h('strong', {}, timeRange(lecture.start_time, lecture.end_time).split(' – ')[0]), h('span', { class: 'muted' }, lecture.room || '')),
    h(
      'div',
      { class: 'cb-grow' },
      h('div', { class: 'cb-strong' }, `${lecture.subject_name} · ${lecture.batch_name}`),
      h('div', { class: 'muted cb-small' }, lecture.faculty_name || 'No teacher assigned'),
    ),
    done
      ? h('span', { class: `badge ${lecture.absent ? 'amber' : 'green'}` }, `${lecture.marked}/${lecture.enrolled} marked${lecture.absent ? ` · ${lecture.absent} absent` : ''}`)
      : h(
          'button',
          {
            class: 'btn sm primary',
            onclick: () => {
              requestSheet({ batch_id: lecture.batch_id, subject_id: lecture.subject_id });
              navigate('/attendance');
            },
          },
          renderIcon('checkin', { size: 14 }),
          'Take attendance',
        ),
  );
}

export async function renderCoachingDashboard({ navigate, reload }) {
  const data = await coaching.dashboard();
  const user = session.user;
  const fees = data.fees;

  const quick = h(
    'div',
    { class: 'cb-quick' },
    h('button', { class: 'btn primary', onclick: () => navigate('/attendance') }, renderIcon('checkin', { size: 16 }), 'Take attendance'),
    h('button', { class: 'btn', onclick: () => navigate('/admissions') }, renderIcon('userPlus', { size: 16 }), 'New inquiry'),
    fees ? h('button', { class: 'btn', onclick: () => navigate('/fees') }, renderIcon('wallet', { size: 16 }), 'Collect fee') : null,
    h('button', { class: 'btn', onclick: () => navigate('/tests') }, renderIcon('trophy', { size: 16 }), 'Enter marks'),
  );

  const stats = h(
    'div',
    { class: 'grid cols-4' },
    stat('Active students', data.students.active, `${data.students.new_this_month} enrolled this month`, { icon: 'members', onClick: () => navigate('/members') }),
    stat(
      'Attendance today',
      `${data.attendance.today_present}`,
      data.attendance.today_absent
        ? `${data.attendance.today_absent} absent · ${data.attendance.today_alerted} parents alerted`
        : `Month so far: ${pct(data.attendance.month_percentage)}`,
      { icon: 'checkin', pulse: data.lectures.length > 0, onClick: () => navigate('/attendance') },
    ),
    fees
      ? stat('Fees collected this month', money(fees.collected_this_month, { compact: true }), `${money(fees.outstanding, { compact: true })} still to collect`, {
          icon: 'wallet',
          accent: true,
          onClick: () => navigate('/fees'),
        })
      : stat('Upcoming tests', data.tests.upcoming.length, 'In the next few days', { icon: 'trophy', onClick: () => navigate('/tests') }),
    fees
      ? stat('Overdue installments', fees.overdue_count, fees.overdue_count ? `${money(fees.overdue_amount)} overdue` : 'Nobody is behind', {
          icon: 'alert',
          trend: fees.overdue_count ? { positive: false, text: `${fees.collection_rate ?? 100}% collected on time` } : null,
          onClick: () => navigate('/fees'),
        })
      : stat('Admissions this month', data.admissions.month_leads, `${data.admissions.month.admitted || 0} admitted`, { icon: 'userPlus' }),
  );

  const lectures = section(
    'Today’s lectures',
    data.lectures.length
      ? h('div', {}, ...data.lectures.map((l) => lectureRow(l, navigate)))
      : emptyState('No lectures on the timetable today. Plan the week on the Timetable page.', { icon: 'calendar' }),
    { icon: 'calendar', actions: h('a', { href: '#/timetable' }, 'Timetable →') },
  );

  const dues = fees
    ? section(
        'Fee follow-ups',
        fees.overdue.length || fees.upcoming.length
          ? h(
              'div',
              {},
              ...[...fees.overdue.map((d) => ({ ...d, late: true })), ...fees.upcoming].slice(0, 8).map((due) =>
                h(
                  'div',
                  { class: 'list-item' },
                  h(
                    'div',
                    { class: 'cb-grow' },
                    h('a', { class: 'cb-strong', href: `#/members/${due.member_id}` }, fullName(due)),
                    h('div', { class: 'muted cb-small' }, `${due.course_name} · installment ${due.installment_number}`),
                  ),
                  h(
                    'div',
                    { class: 'cb-right' },
                    h('div', { class: 'cb-strong' }, money(due.balance)),
                    h('div', { class: `cb-small ${due.late ? 'cb-red' : 'muted'}` }, due.late ? `${due.days_overdue} days overdue` : `Due ${date(due.due_date)}`),
                  ),
                  h(
                    'button',
                    {
                      class: 'btn sm ghost',
                      title: 'Send a WhatsApp reminder to the guardian',
                      onclick: async (e) => {
                        e.currentTarget.disabled = true;
                        try {
                          await coaching.remindInstallment(due.id);
                          toast(`Reminder going out to ${fullName(due)}’s guardian`);
                        } catch (err) {
                          toast(err.message, 'error');
                          e.currentTarget.disabled = false;
                        }
                      },
                    },
                    renderIcon('whatsapp', { size: 14 }),
                  ),
                ),
              ),
            )
          : emptyState('No installment is overdue or due this week.', { icon: 'checkCircle' }),
        { icon: 'wallet', actions: h('a', { href: '#/fees' }, 'All dues →') },
      )
    : null;

  const tests = section(
    'Tests',
    h(
      'div',
      {},
      data.tests.awaiting_results.length
        ? h(
            'div',
            { class: 'cb-callout is-amber' },
            renderIcon('alert', { size: 16 }),
            `${data.tests.awaiting_results.length} test${data.tests.awaiting_results.length === 1 ? '' : 's'} taken but not published yet`,
          )
        : null,
      ...data.tests.awaiting_results.map((t) =>
        h(
          'a',
          { class: 'list-item cb-link-row', href: `#/tests/${t.id}` },
          h('div', { class: 'cb-grow' }, h('div', { class: 'cb-strong' }, t.title), h('div', { class: 'muted cb-small' }, `${t.batch_name} · ${date(t.test_date)}`)),
          h('span', { class: 'badge amber' }, t.marks_entered ? `${t.marks_entered} marks in` : 'Enter marks'),
        ),
      ),
      ...data.tests.upcoming.map((t) =>
        h(
          'a',
          { class: 'list-item cb-link-row', href: `#/tests/${t.id}` },
          h('div', { class: 'cb-grow' }, h('div', { class: 'cb-strong' }, t.title), h('div', { class: 'muted cb-small' }, `${t.batch_name}${t.subject_name ? ` · ${t.subject_name}` : ''}`)),
          h('span', { class: 'badge blue' }, `${TEST_TYPE_LABEL[t.test_type] || 'Test'} · ${date(t.test_date)}`),
        ),
      ),
      !data.tests.awaiting_results.length && !data.tests.upcoming.length ? emptyState('No tests scheduled.', { icon: 'trophy' }) : null,
    ),
    { icon: 'trophy', actions: h('a', { href: '#/tests' }, 'Test series →') },
  );

  const admissions = section(
    'Admissions',
    h(
      'div',
      {},
      h(
        'div',
        { class: 'cb-funnel' },
        ...['inquiry', 'demo_scheduled', 'follow_up', 'admitted'].map((key) =>
          h('div', { class: 'cb-funnel-step' }, h('strong', {}, data.admissions.month[key] || 0), h('span', { class: 'muted' }, INQUIRY_STATUS[key].label)),
        ),
      ),
      data.admissions.follow_ups.length
        ? h(
            'div',
            {},
            h('div', { class: 'cb-subhead' }, 'Due today'),
            ...data.admissions.follow_ups.map((lead) =>
              h(
                'div',
                { class: 'list-item' },
                h('div', { class: 'cb-grow' }, h('div', { class: 'cb-strong' }, lead.student_name), h('div', { class: 'muted cb-small' }, `${lead.course_name || 'No course yet'} · ${lead.phone}`)),
                tone(INQUIRY_STATUS, lead.status),
              ),
            ),
          )
        : h('p', { class: 'muted cb-small' }, 'No follow-ups due today.'),
    ),
    { icon: 'userPlus', subtitle: 'This month', actions: h('a', { href: '#/admissions' }, 'Pipeline →') },
  );

  const low = section(
    `Below ${data.attendance.threshold}% attendance`,
    data.attendance.low.length
      ? h(
          'div',
          {},
          ...data.attendance.low.map((s) =>
            h(
              'div',
              { class: 'list-item' },
              h('a', { class: 'cb-grow cb-strong', href: `#/members/${s.member_id}` }, fullName(s)),
              h('div', { style: 'width:150px' }, percentBar(s.percentage, { threshold: data.attendance.threshold })),
            ),
          ),
        )
      : emptyState('Everyone is above the line this month.', { icon: 'checkCircle' }),
    { icon: 'alert', subtitle: 'This month' },
  );

  const batches = section(
    'Batches',
    data.batches.length
      ? h(
          'div',
          {},
          ...data.batches.map((b) =>
            h(
              'a',
              { class: 'list-item cb-link-row', href: `#/batches/${b.id}` },
              h('div', { class: 'cb-grow' }, h('div', { class: 'cb-strong' }, b.name), h('div', { class: 'muted cb-small' }, b.course_name)),
              h('div', { class: 'cb-occupancy' }, h('span', { style: `width:${Math.min(100, (b.enrolled / b.capacity) * 100)}%` })),
              h('span', { class: 'muted cb-small' }, `${b.enrolled}/${b.capacity}`),
            ),
          ),
        )
      : emptyState('No batches yet.', { icon: 'graduation', action: h('a', { class: 'btn sm primary', href: '#/courses' }, 'Set up a batch') }),
    { icon: 'graduation', actions: h('a', { href: '#/courses' }, 'Manage →') },
  );

  return h(
    'div',
    { class: 'grid cb-page', style: 'gap:16px' },
    h(
      'div',
      { class: 'cb-hero' },
      h(
        'div',
        {},
        h('h2', {}, `${greeting(new Date().getHours())}, ${(user?.name || '').split(' ')[0] || 'there'}`),
        h(
          'p',
          { class: 'muted' },
          data.whatsapp_connected
            ? 'Parent alerts are live on WhatsApp.'
            : h('span', {}, 'WhatsApp is not linked — parents won’t get alerts. ', h('a', { href: '#/whatsapp' }, 'Link it now')),
        ),
      ),
      quick,
    ),
    stats,
    h('div', { class: 'grid cols-2 top' }, lectures, dues || tests),
    h('div', { class: 'grid cols-2 top' }, dues ? tests : admissions, dues ? admissions : low),
    h('div', { class: 'grid cols-2 top' }, dues ? low : batches, dues ? batches : null),
    h('div', { class: 'cb-refresh' }, h('button', { class: 'btn sm ghost', onclick: reload }, renderIcon('refresh', { size: 14 }), 'Refresh')),
  );
}
