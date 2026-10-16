import { api, session } from '../../api.js';
import { coaching } from '../../coachingApi.js';
import { clear, date, emptyState, h, money, renderIcon, toast, today } from '../../ui.js';
import { attendanceCalendarView } from './attendance.js';
import { fill, fullName, INSTALLMENT_STATUS, pct, PLAN_STATUS, section, TEST_TYPE_LABEL, timeRange, tone, weekdayList } from './common.js';
import { openEnrollModal } from './enrollForm.js';
import { openCollectModal, openNewPlanModal, openPlanModal } from './fees.js';

/**
 * A student's academic side on their page (views/members.js): the batches
 * they are in with roll numbers, their fee plans and installments, this
 * month's attendance calendar, and recent test results with a printable
 * report card.
 */

/** One request per page render, shared by the summary card and the section. */
let cached = { id: null, at: 0, promise: null };
function academics(memberId) {
  if (cached.id !== memberId || Date.now() - cached.at > 2000) {
    cached = { id: memberId, at: Date.now(), promise: coaching.academics(memberId) };
  }
  return cached.promise;
}

const fmt = (v) => (v === null || v === undefined ? '—' : Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100));

export function coachingStudentActions(member, { reload }) {
  return [
    h(
      'button',
      {
        class: 'btn',
        onclick: async () => {
          try {
            const result = await api.checkIn({ member_id: member.id });
            toast(result.action === 'checked_out' ? `${member.first_name} checked out` : `${member.first_name} checked in — marked present for today’s lectures`);
            reload();
          } catch (err) {
            toast(err.message, 'error');
          }
        },
      },
      renderIcon('checkin', { size: 16 }),
      'Gate check-in',
    ),
    h('button', { class: 'btn', onclick: () => printReportCard(member) }, renderIcon('print', { size: 16 }), 'Report card'),
    h('button', { class: 'btn primary', onclick: () => openEnrollModal({ member, onDone: reload }) }, renderIcon('userPlus', { size: 16 }), 'Enroll in batch'),
  ];
}

/** The middle card of the page's top row: batches and the fee position. */
export function coachingSummaryCard(member, { reload }) {
  const body = h('div', {}, h('p', { class: 'muted cb-small' }, 'Loading…'));
  academics(member.id)
    .then((data) => {
      const active = data.enrollments.filter((e) => e.status === 'active');
      const plans = data.fee_plans.filter((p) => p.status !== 'cancelled');
      const balance = plans.reduce((acc, p) => acc + Math.max(0, p.balance), 0);
      const overdue = plans.reduce((acc, p) => acc + (p.overdue_amount || 0), 0);
      fill(body, 
        active.length
          ? h(
              'div',
              {},
              ...active.map((e) =>
                h(
                  'a',
                  { class: 'cb-enrollment cb-link-row', href: `#/batches/${e.batch_id}` },
                  h('span', { class: 'cb-roll' }, e.roll_number || '—'),
                  h('div', { class: 'cb-grow' }, h('div', { class: 'cb-strong' }, e.batch_name), h('div', { class: 'muted cb-small' }, `${e.course_name} · ${weekdayList(e.weekdays)} · ${timeRange(e.start_time, e.end_time)}`)),
                ),
              ),
            )
          : emptyState('Not in any batch yet.', {
              icon: 'graduation',
              action: h('button', { class: 'btn sm primary', onclick: () => openEnrollModal({ member, onDone: reload }) }, 'Enroll in a batch'),
            }),
        plans.length
          ? h(
              'div',
              { class: 'cb-plan-summary', style: 'margin-top:12px' },
              h('div', {}, h('span', { class: 'muted cb-small' }, 'Fee balance'), h('strong', { class: balance > 0 ? '' : 'cb-green' }, money(balance))),
              h('div', {}, h('span', { class: 'muted cb-small' }, 'Overdue'), h('strong', { class: overdue > 0 ? 'cb-red' : '' }, money(overdue))),
            )
          : null,
      );
    })
    .catch((err) => fill(body, h('p', { class: 'cb-red cb-small' }, err.message)));
  return h('div', { class: 'card md-card cb-student-panel' }, h('div', { class: 'card-head' }, h('h3', {}, 'Batches & fees')), body);
}

function feePlanCard(plan, { member, reload }) {
  const paidPct = plan.final_amount ? Math.min(100, (plan.amount_paid / plan.final_amount) * 100) : 0;
  const canBill = session.managesBilling;
  return h(
    'div',
    { class: 'cb-fee-plan' },
    h(
      'div',
      { class: 'row' },
      h('div', { class: 'cb-grow' }, h('div', { class: 'cb-strong' }, plan.course_name), h('div', { class: 'muted cb-small' }, `${plan.batch_name || 'No batch'} · ${money(plan.final_amount)} payable${plan.discount_amount ? ` (${money(plan.discount_amount)} concession)` : ''}`)),
      tone(PLAN_STATUS, plan.effective_status),
    ),
    h('div', { class: 'cbp-progress' }, h('span', { style: `width:${paidPct}%` })),
    h('div', { class: 'muted cb-small' }, `${money(plan.amount_paid)} paid · ${money(Math.max(0, plan.balance))} left`),
    h(
      'div',
      { class: 'cb-installments' },
      ...plan.installments.map((inst) =>
        h(
          'div',
          { class: 'list-item' },
          h('span', { class: 'cb-roll' }, `#${inst.installment_number}`),
          h('div', { class: 'cb-grow' }, h('div', {}, money(inst.amount_due)), h('div', { class: 'muted cb-small' }, `Due ${date(inst.due_date)}${inst.amount_paid > 0 && inst.balance > 0.005 ? ` · ${money(inst.balance)} left` : ''}`)),
          tone(INSTALLMENT_STATUS, inst.status),
          canBill && inst.balance > 0.005 && plan.status !== 'cancelled'
            ? h('button', { class: 'btn sm', onclick: () => openCollectModal({ plan, installment: inst, onDone: reload }) }, 'Collect')
            : null,
        ),
      ),
    ),
    canBill ? h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { class: 'btn sm ghost', onclick: () => openPlanModal(plan.id, { onChanged: reload }) }, 'Payments & receipts')) : null,
  );
}

export function coachingStudentSection(member, { reload }) {
  const fees = h('div', {}, h('p', { class: 'muted cb-small' }, 'Loading…'));
  const attendance = h('div', {}, h('p', { class: 'muted cb-small' }, 'Loading…'));
  const tests = h('div', {}, h('p', { class: 'muted cb-small' }, 'Loading…'));

  academics(member.id)
    .then((data) => {
      const plans = data.fee_plans;
      fill(fees, 
        plans.length
          ? h('div', { class: 'cb-fee-plans' }, ...plans.map((p) => feePlanCard(p, { member, reload })))
          : emptyState('No fee plan yet.', {
              icon: 'wallet',
              action: session.managesBilling ? h('button', { class: 'btn sm primary', onclick: () => openNewPlanModal({ member, onDone: reload }) }, 'Set up the course fee') : null,
            }),
      );

      fill(tests, 
        data.tests.length
          ? h(
              'div',
              {},
              ...data.tests.slice(0, 8).map((t) =>
                h(
                  'a',
                  { class: 'list-item cb-link-row', href: `#/tests/${t.id}` },
                  h('div', { class: 'cbp-score' }, t.is_absent ? 'AB' : fmt(t.marks_obtained), h('small', {}, t.is_absent ? '' : `/${fmt(t.max_marks)}`)),
                  h('div', { class: 'cb-grow' }, h('div', { class: 'cb-strong' }, t.title), h('div', { class: 'muted cb-small' }, `${TEST_TYPE_LABEL[t.test_type]} · ${t.subject_name || t.batch_name} · ${date(t.test_date)}`)),
                  t.is_absent ? h('span', { class: 'badge grey' }, 'Absent') : h('span', { class: 'badge violet' }, t.rank ? `Rank ${t.rank}/${t.appeared}` : '—'),
                ),
              ),
            )
          : emptyState('No test results yet.', { icon: 'trophy' }),
      );
    })
    .catch((err) => fill(fees, h('p', { class: 'cb-red cb-small' }, err.message)));

  const loadCalendar = (month) =>
    coaching
      .attendanceCalendar(member.id, { month })
      .then((data) => fill(attendance, attendanceCalendarView(data, { onMonth: loadCalendar })))
      .catch((err) => fill(attendance, h('p', { class: 'cb-red cb-small' }, err.message)));
  loadCalendar(today().slice(0, 7));

  return h(
    'div',
    { class: 'grid cols-2 top cb-student-panel' },
    session.managesBilling
      ? section('Fees & installments', fees, {
          icon: 'wallet',
          actions: h('button', { class: 'btn sm ghost', onclick: () => openNewPlanModal({ member, onDone: reload }) }, renderIcon('plus', { size: 13 }), 'Fee plan'),
        })
      : null,
    section('Attendance', attendance, { icon: 'calendar' }),
    section('Recent tests', tests, { icon: 'trophy', actions: h('button', { class: 'btn sm ghost', onclick: () => printReportCard(member) }, renderIcon('print', { size: 13 }), 'Report card') }),
  );
}

/** The printable performance card: every test, subject averages, attendance. */
export async function printReportCard(member) {
  const win = window.open('', '_blank', 'width=820,height=960');
  if (!win) return toast('Allow pop-ups to print the report card', 'info');
  win.document.write('<p style="font-family:system-ui;padding:24px">Preparing the report card…</p>');
  try {
    const [card, data] = await Promise.all([coaching.reportCard(member.id), academics(member.id)]);
    const institute = document.querySelector('.brand-name')?.textContent || '';
    const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    const year = data.attendance.year.overall;
    const batches = data.enrollments.filter((e) => e.status === 'active').map((e) => `${e.batch_name} (roll ${e.roll_number || '—'})`).join(', ');
    win.document.open();
    win.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Report card · ${esc(fullName(member))}</title>
<style>body{font-family:system-ui,sans-serif;margin:32px;color:#111}h1{font-size:22px;margin:0}h2{font-size:15px;margin:26px 0 8px}
.sub{color:#555;margin:4px 0 0}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:18px}
.box{border:1px solid #ddd;border-radius:10px;padding:10px}.box b{display:block;font-size:20px}.box span{font-size:12px;color:#666}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:6px 8px;border-bottom:1px solid #e5e5e5;text-align:left}th{background:#f3f4f6}.r{text-align:right}</style></head><body>
<h1>${esc(institute)} — Performance report</h1>
<p class="sub">${esc(fullName(member))} · ${esc(member.code)}${member.current_class ? ` · ${esc(member.current_class)}` : ''}${member.exam_target ? ` · Target ${esc(member.exam_target)}` : ''}</p>
<p class="sub">${esc(batches || 'No active batch')} · Printed ${esc(date(today()))}</p>
<div class="grid">
<div class="box"><b>${esc(card.overall_percentage === null ? '—' : `${card.overall_percentage}%`)}</b><span>Average across tests</span></div>
<div class="box"><b>${card.tests_taken}</b><span>Tests taken</span></div>
<div class="box"><b>${card.tests_missed}</b><span>Tests missed</span></div>
<div class="box"><b>${esc(pct(year?.percentage))}</b><span>Attendance (12 months)</span></div>
</div>
<h2>By subject</h2>
<table><thead><tr><th>Subject</th><th class="r">Tests</th><th class="r">Average %</th><th class="r">Best %</th></tr></thead><tbody>
${card.subjects.map((s) => `<tr><td>${esc(s.subject_name)}</td><td class="r">${s.tests}</td><td class="r">${s.average_percentage}</td><td class="r">${s.best_percentage}</td></tr>`).join('') || '<tr><td colspan="4">No tests yet</td></tr>'}
</tbody></table>
<h2>Every test</h2>
<table><thead><tr><th>Date</th><th>Test</th><th class="r">Marks</th><th class="r">%</th><th class="r">Rank</th><th class="r">Batch avg</th><th class="r">Highest</th></tr></thead><tbody>
${card.tests
  .map((t) =>
    t.is_absent
      ? `<tr><td>${esc(date(t.test_date))}</td><td>${esc(t.title)}</td><td class="r" colspan="5">Absent</td></tr>`
      : `<tr><td>${esc(date(t.test_date))}</td><td>${esc(t.title)}${t.subject_name ? ` · ${esc(t.subject_name)}` : ''}</td><td class="r">${esc(fmt(t.marks_obtained))}/${esc(fmt(t.max_marks))}</td><td class="r">${esc(fmt((t.marks_obtained / t.max_marks) * 100))}</td><td class="r">${t.rank ?? '—'}/${t.appeared}</td><td class="r">${esc(fmt(t.average))}</td><td class="r">${esc(fmt(t.highest))}</td></tr>`,
  )
  .join('') || '<tr><td colspan="7">No tests yet</td></tr>'}
</tbody></table>
<script>window.onload=()=>window.print()</script></body></html>`);
    win.document.close();
  } catch (err) {
    win.close();
    toast(err.message, 'error');
  }
}

