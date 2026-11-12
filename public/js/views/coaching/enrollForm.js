import { api, session } from '../../api.js';
import { coaching } from '../../coachingApi.js';
import { addDays, clear, closeModal, date, dateField, h, money, openModal, renderIcon, toast, today } from '../../ui.js';
import { fill, fullName, timeRange, weekdayList } from './common.js';

/**
 * Admitting a student into a batch, optionally with their course fee plan —
 * the admission desk's one form. Used from a batch's page, a student's page
 * and the admissions pipeline (`inquiry` set: admits the lead, creating the
 * student).
 *
 * The installment schedule is previewed live with the server's own split
 * (remainder on the first installment, see buildSchedule in
 * src/coaching/fees.js) and every row stays editable — a family that asks to
 * pay ₹20,000 now and the rest in two parts just gets those numbers typed in.
 */

const MAX_INSTALLMENTS = 6;

/** Mirrors buildSchedule() in src/coaching/fees.js. */
export function splitFee(total, n, start, gap) {
  const count = Math.max(1, Math.min(MAX_INSTALLMENTS, Number(n) || 1));
  const minor = Math.round(Number(total || 0) * 100);
  const whole = minor % 100 === 0;
  const base = whole ? Math.floor(minor / 100 / count) * 100 : Math.floor(minor / count);
  const first = minor - base * (count - 1);
  return Array.from({ length: count }, (_, i) => ({
    amount_due: (i === 0 ? first : base) / 100,
    due_date: addDays(start, i * (Number(gap) || 0)),
    label: count === 1 ? 'Full fee' : i === 0 ? 'At admission' : `Installment ${i + 1}`,
  }));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const monthLabel = (ym) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
const addMonth = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
};
const ordinal = (n) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;
export const dayOfMonth = (n) => ordinal(Number(n));

/**
 * The first `count` months a monthly plan bills. Mirrors nextMonthToBill() in
 * src/coaching/fees.js: due on the billing day, except the first month, due
 * on the start date when that is later.
 */
export function monthlyPreview({ start, day, endMonth, amount, count = 3 }) {
  const rows = [];
  let month = start.slice(0, 7);
  while (rows.length < count && (!endMonth || month <= endMonth)) {
    const onDay = `${month}-${String(day).padStart(2, '0')}`;
    rows.push({ label: monthLabel(month), due_date: rows.length === 0 && start > onDay ? start : onDay, amount_due: amount });
    month = addMonth(month);
  }
  return rows;
}

/**
 * The fee half of the form, also used on its own to add a plan later.
 * Two kinds of plan: a course fee (paid in full or in installments) or a
 * monthly fee (charged every month until a last month, or until stopped).
 * `allowMonthly: false` hides the choice — the reschedule dialog re-splits a
 * course fee and has no use for it.
 */
export function feeFields({ course, onChange, allowMonthly = true }) {
  const all = course?.fee_structures || [];
  // The course's monthly fee is set once in its fee planner (Courses &
  // batches) and used as-is here; the structure picker is only for course
  // fees paid in full or in installments.
  const monthlyStructure = allowMonthly ? all.find((s) => s.billing_cycle === 'monthly') : null;
  const structures = all.filter((s) => s.billing_cycle !== 'monthly');
  const first = structures[0];
  const state = {
    on: true,
    cycle: allowMonthly ? 'monthly' : 'one_time',
    structureId: allowMonthly ? monthlyStructure?.id ?? '' : first?.id ?? '',
    oneTimeStructureId: first?.id ?? '',
    total: first?.total_fee ?? '',
    discount: 0,
    reason: '',
    count: first?.installments ?? 1,
    start: today(),
    gap: first?.interval_days ?? 30,
    rows: [],
    edited: false,
    monthlyFee: monthlyStructure ? monthlyStructure.total_fee : '',
    monthlyDiscount: 0,
    billingDay: Math.min(28, Number(today().slice(8, 10))),
    endMonth: '',
  };

  const num = (v) => (v === '' || v === null ? '' : Number(v));
  const input = (props) => h('input', { ...props, oninput: props.oninput });
  const totalInput = input({ type: 'number', min: 0, step: '1', value: state.total, oninput: (e) => update({ total: num(e.target.value) }) });
  const discountInput = input({ type: 'number', min: 0, step: '1', value: 0, oninput: (e) => update({ discount: num(e.target.value) || 0 }) });
  const reasonInput = input({ type: 'text', placeholder: 'Sibling, merit, early bird…', oninput: (e) => (state.reason = e.target.value) });
  const countSelect = h(
    'select',
    { onchange: (e) => update({ count: Number(e.target.value) }) },
    ...Array.from({ length: MAX_INSTALLMENTS }, (_, i) => h('option', { value: i + 1, selected: i + 1 === Number(state.count) }, i === 0 ? 'Pay in full' : `${i + 1} installments`)),
  );
  const gapInput = input({ type: 'number', min: 0, max: 365, value: state.gap, oninput: (e) => update({ gap: num(e.target.value) || 0 }) });
  const startInput = dateField({ name: 'start', value: state.start, onchange: (e) => update({ start: e.target.value || today() }) });
  const structureSelect = structures.length
    ? h(
        'select',
        {
          onchange: (e) => {
            const s = structures.find((x) => x.id === Number(e.target.value));
            state.structureId = s?.id ?? '';
            state.oneTimeStructureId = state.structureId;
            if (s) {
              totalInput.value = s.total_fee;
              countSelect.value = String(Math.min(MAX_INSTALLMENTS, s.installments));
              gapInput.value = s.interval_days;
              update({ total: s.total_fee, count: Math.min(MAX_INSTALLMENTS, s.installments), gap: s.interval_days });
            }
          },
        },
        ...structures.map((s) => h('option', { value: s.id }, `${s.name} · ${money(s.total_fee)}`)),
        h('option', { value: '' }, 'Custom fee'),
      )
    : null;

  const preview = h('div', { class: 'cb-schedule' });
  const payable = () => Math.max(0, (Number(state.total) || 0) - (Number(state.discount) || 0));

  function paintRows() {
    fill(preview, 
      h('div', { class: 'cb-schedule-head' }, h('span', {}, 'Installment'), h('span', {}, 'Due on'), h('span', { class: 'num' }, 'Amount')),
      ...state.rows.map((row, i) =>
        h(
          'div',
          { class: 'cb-schedule-row' },
          h('span', { class: 'cb-strong' }, row.label),
          dateField({
            name: `due_${i}`,
            value: row.due_date,
            onchange: (e) => {
              row.due_date = e.target.value;
              state.edited = true;
            },
          }),
          h('input', {
            type: 'number',
            min: 0,
            step: '1',
            value: row.amount_due,
            class: 'num',
            oninput: (e) => {
              row.amount_due = Number(e.target.value) || 0;
              state.edited = true;
              paintTotal();
            },
          }),
        ),
      ),
      h('div', { class: 'cb-schedule-total' }),
    );
    paintTotal();
    function paintTotal() {
      const total = state.rows.reduce((acc, r) => acc + (Number(r.amount_due) || 0), 0);
      const diff = Math.round((total - payable()) * 100) / 100;
      const node = preview.querySelector('.cb-schedule-total');
      fill(node, 
        h('span', {}, `Fee after discount: `, h('strong', {}, money(payable()))),
        diff ? h('span', { class: 'cb-red' }, `Installments are ${money(Math.abs(diff))} ${diff > 0 ? 'over' : 'short'}`) : h('span', { class: 'cb-green' }, 'Adds up'),
      );
    }
  }

  function update(patch) {
    Object.assign(state, patch);
    state.rows = splitFee(payable(), state.count, state.start, state.gap);
    state.edited = false;
    paintRows();
    onChange?.(state);
  }
  update({});

  const toggle = h('input', {
    type: 'checkbox',
    checked: true,
    onchange: (e) => {
      state.on = e.target.checked;
      body.hidden = !state.on;
    },
  });
  const field = (label, control, full = false) => h('label', { class: `field${full ? ' full' : ''}` }, h('span', {}, label), control);

  /* Monthly fee: charged every month on the billing day. */
  state.monthStart = today();
  const monthlyPayable = () => Math.max(0, (Number(state.monthlyFee) || 0) - (Number(state.monthlyDiscount) || 0));
  const monthlyFeeInput = input({
    type: 'number',
    min: 0,
    step: '1',
    value: state.monthlyFee,
    readOnly: Boolean(monthlyStructure),
    oninput: (e) => paintMonthly({ monthlyFee: num(e.target.value) }),
  });
  const monthlyDiscountInput = input({ type: 'number', min: 0, step: '1', value: 0, oninput: (e) => paintMonthly({ monthlyDiscount: num(e.target.value) || 0 }) });
  const monthlyReasonInput = input({ type: 'text', placeholder: 'Sibling, merit, early bird…', oninput: (e) => (state.reason = e.target.value) });
  const billingDayInput = input({
    type: 'number',
    min: 1,
    max: 28,
    value: state.billingDay,
    oninput: (e) => paintMonthly({ billingDay: Math.max(1, Math.min(28, Number(e.target.value) || 1)) }),
  });
  const monthStartInput = dateField({ name: 'month_start', value: state.monthStart, onchange: (e) => paintMonthly({ monthStart: e.target.value || today() }) });
  const endMonthInput = input({ type: 'month', value: '', oninput: (e) => paintMonthly({ endMonth: e.target.value }) });
  const monthlyPreviewNode = h('div', { class: 'cb-schedule' });

  function paintMonthly(patch = {}) {
    Object.assign(state, patch);
    const amount = monthlyPayable();
    const rows = monthlyPreview({ start: state.monthStart, day: state.billingDay, endMonth: state.endMonth, amount });
    fill(
      monthlyPreviewNode,
      h('div', { class: 'cb-schedule-head' }, h('span', {}, 'Month'), h('span', {}, 'Due on'), h('span', { class: 'num' }, 'Amount')),
      ...rows.map((row) => h('div', { class: 'cb-schedule-row' }, h('span', { class: 'cb-strong' }, row.label), h('span', {}, row.due_date ? date(row.due_date) : ''), h('span', { class: 'num' }, money(row.amount_due)))),
      h(
        'div',
        { class: 'cb-schedule-total' },
        h('span', {}, 'Every month: ', h('strong', {}, money(amount))),
        h(
          'span',
          { class: 'muted' },
          `Due on the ${dayOfMonth(state.billingDay)} · ${state.endMonth ? `until ${monthLabel(state.endMonth)}` : 'until you stop it'}`,
        ),
      ),
    );
    onChange?.(state);
  }

  const oneTimeGrid = h(
    'div',
    { class: 'form-grid' },
    field('Course fee', totalInput),
    field('Discount', discountInput),
    field('Reason for discount', reasonInput, true),
    field('Payment plan', countSelect),
    field('Days between installments', gapInput),
    field('First due on', startInput),
  );
  const monthlyGrid = h(
    'div',
    { class: 'form-grid' },
    h(
      'label',
      { class: 'field' },
      h('span', {}, 'Monthly fee'),
      monthlyFeeInput,
      h(
        'small',
        { class: 'muted' },
        monthlyStructure
          ? 'Fixed in the course’s fee planner. Use the discount for this student.'
          : 'Tip: set the monthly fee once on the course (Courses & batches) to fill this in.',
      ),
    ),
    field('Discount per month', monthlyDiscountInput),
    field('Reason for discount', monthlyReasonInput, true),
    field('First month starts on', monthStartInput),
    field('Fee due date every month (1–28)', billingDayInput),
    h(
      'label',
      { class: 'field full' },
      h('span', {}, 'Last month (optional)'),
      endMonthInput,
      h('small', { class: 'muted' }, 'Leave blank to keep charging every month until you stop the plan.'),
    ),
  );
  const oneTimePart = h(
    'div',
    {},
    structureSelect ? h('div', { class: 'form-grid' }, field('Fee structure', structureSelect, true)) : null,
    oneTimeGrid,
    preview,
  );
  const monthlyPart = h('div', {}, monthlyGrid, monthlyPreviewNode);

  function paintCycle() {
    oneTimePart.hidden = state.cycle !== 'one_time';
    monthlyPart.hidden = state.cycle !== 'monthly';
  }
  function setCycle(cycle, patch = {}) {
    state.cycle = cycle;
    state.structureId = cycle === 'monthly' ? monthlyStructure?.id ?? '' : state.oneTimeStructureId;
    paintCycle();
    if (cycle === 'monthly') paintMonthly(patch);
    else onChange?.(state);
  }
  const cycleSelect = allowMonthly
    ? h(
        'select',
        { onchange: (e) => setCycle(e.target.value) },
        h('option', { value: 'monthly', selected: state.cycle === 'monthly' }, 'Monthly fee · charged every month'),
        h('option', { value: 'one_time', selected: state.cycle === 'one_time' }, 'Course fee · paid in full or in installments'),
      )
    : null;
  paintMonthly();
  paintCycle();

  const body = h(
    'div',
    { class: 'cb-fee-body' },
    cycleSelect ? h('div', { class: 'form-grid' }, field('How is the fee collected?', cycleSelect, true)) : null,
    oneTimePart,
    monthlyPart,
  );

  return {
    node: h(
      'div',
      { class: 'cb-fee-block' },
      h('label', { class: 'cb-check cb-strong' }, toggle, 'Set up the fee now'),
      body,
    ),
    /** The `fee` payload for the API, or null when switched off. */
    value() {
      if (!state.on) return null;
      if (state.cycle === 'monthly') {
        if (!(Number(state.monthlyFee) > 0)) throw new Error('Enter the monthly fee, or untick “Set up the fee now”');
        if (!(monthlyPayable() > 0)) throw new Error('The discount must be less than the monthly fee');
        if (state.endMonth && state.endMonth < state.monthStart.slice(0, 7)) throw new Error('The last month is before the first');
        return {
          billing_cycle: 'monthly',
          fee_structure_id: state.structureId || undefined,
          monthly_fee: Number(state.monthlyFee),
          monthly_discount: Number(state.monthlyDiscount) || 0,
          discount_reason: state.reason || undefined,
          billing_day: state.billingDay,
          start_date: state.monthStart,
          end_month: state.endMonth || undefined,
        };
      }
      if (!(Number(state.total) > 0)) throw new Error('Enter the course fee, or untick “Set up the fee now”');
      return {
        fee_structure_id: state.structureId || undefined,
        total_amount: Number(state.total),
        discount_amount: Number(state.discount) || 0,
        discount_reason: state.reason || undefined,
        schedule: state.rows.map((r) => ({ amount_due: Number(r.amount_due), due_date: r.due_date, label: r.label })),
      };
    },
  };
}

/** Picks a student by name/code/phone as you type. */
function studentPicker(onPick) {
  const results = h('div', { class: 'cb-picker-results' });
  let timer;
  const search = h('input', {
    type: 'search',
    class: 'search',
    placeholder: 'Search students by name, ID or phone…',
    oninput: (e) => {
      clearTimeout(timer);
      const q = e.target.value.trim();
      timer = setTimeout(async () => {
        if (q.length < 2) return clear(results);
        const { items } = await api.members({ q, limit: 8 });
        fill(results, 
          ...(items.length
            ? items.map((m) =>
                h(
                  'button',
                  {
                    type: 'button',
                    class: 'cb-picker-item',
                    onclick: () => {
                      onPick(m);
                      clear(results);
                      search.value = fullName(m);
                    },
                  },
                  h('strong', {}, fullName(m)),
                  h('span', { class: 'muted' }, ` ${m.code}${m.phone ? ` · ${m.phone}` : ''}`),
                ),
              )
            : [h('p', { class: 'muted cb-small' }, 'No student matches. Add them on the Students page first.')]),
        );
      }, 220);
    },
  });
  return h('div', { class: 'cb-picker-wrap' }, search, results);
}

/**
 * Opens the admission form. Give `member` to enroll a known student, or
 * `inquiry` to admit a lead (which creates the student); `batchId` presets
 * the batch.
 */
export async function openEnrollModal({ member = null, inquiry = null, batchId = null, onDone }) {
  const [{ items: batches }, { items: courses }] = await Promise.all([coaching.batches(), coaching.courses()]);
  if (!batches.length) {
    toast('Create a batch first, on Courses & batches', 'info');
    return;
  }
  const canBill = session.managesBilling;
  let chosen = member;
  let batch = batches.find((b) => b.id === Number(batchId)) || (inquiry?.course_id ? batches.find((b) => b.course_id === inquiry.course_id) : null) || batches[0];
  const feeHost = h('div', {});
  let fee = null;
  const paintFee = () => {
    if (!canBill) return fill(feeHost, h('p', { class: 'muted cb-small' }, 'An admin or manager sets up the fee plan.'));
    fee = feeFields({ course: courses.find((c) => c.id === batch.course_id) });
    fill(feeHost, fee.node);
  };
  paintFee();

  const batchInfo = h('div', { class: 'muted cb-small' });
  const paintBatchInfo = () =>
    fill(batchInfo, 
      `${batch.course_name} · ${weekdayList(batch.weekdays)} · ${timeRange(batch.start_time, batch.end_time)} · ${batch.enrolled}/${batch.capacity} seats taken`,
    );
  paintBatchInfo();

  const batchSelect = h(
    'select',
    {
      onchange: (e) => {
        batch = batches.find((b) => b.id === Number(e.target.value));
        paintBatchInfo();
        paintFee();
      },
    },
    ...batches.map((b) => h('option', { value: b.id, selected: b.id === batch.id }, `${b.name} · ${b.course_name}`)),
  );
  const rollInput = h('input', { type: 'text', placeholder: 'Leave blank to number automatically' });
  const overCapacity = h('input', { type: 'checkbox' });

  const submit = h('button', { class: 'btn primary', type: 'button' }, renderIcon('check', { size: 16 }), inquiry ? 'Admit student' : 'Enroll');
  submit.addEventListener('click', async () => {
    let feePayload = null;
    try {
      feePayload = canBill ? fee.value() : null;
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    if (!inquiry && !chosen) {
      toast('Choose a student', 'error');
      return;
    }
    submit.disabled = true;
    try {
      const payload = {
        batch_id: batch.id,
        roll_number: rollInput.value.trim() || undefined,
        allow_over_capacity: overCapacity.checked,
        fee: feePayload || undefined,
      };
      const result = inquiry
        ? await coaching.admitInquiry(inquiry.id, payload)
        : await coaching.enroll({ ...payload, member_id: chosen.id });
      closeModal();
      const who = inquiry ? `${result.member.first_name} (${result.member.code})` : fullName(chosen);
      toast(`${who} is in ${batch.name} · roll no. ${result.enrollment.roll_number}`);
      await onDone?.(result);
    } catch (err) {
      if (err.details?.code === 'batch_full') {
        toast(`${err.message}. Tick “Allow over capacity” to add them anyway.`, 'error');
      } else {
        toast(err.message || 'Could not enroll', 'error');
      }
    } finally {
      submit.disabled = false;
    }
  });

  const field = (label, control, full = true) => h('label', { class: `field${full ? ' full' : ''}` }, h('span', {}, label), control);
  const body = h(
    'div',
    { class: 'cb-enroll' },
    h(
      'div',
      { class: 'form-grid' },
      inquiry
        ? h('div', { class: 'field full' }, h('span', {}, 'Student'), h('div', { class: 'cb-strong' }, inquiry.student_name), h('div', { class: 'muted cb-small' }, `${inquiry.guardian_name ? `Guardian ${inquiry.guardian_name} · ` : ''}${inquiry.phone}`))
        : member
          ? h('div', { class: 'field full' }, h('span', {}, 'Student'), h('div', { class: 'cb-strong' }, `${fullName(member)} · ${member.code}`))
          : field('Student', studentPicker((m) => (chosen = m))),
      field('Batch', h('div', {}, batchSelect, batchInfo)),
      field('Roll number', rollInput, false),
      h('label', { class: 'cb-check field' }, overCapacity, 'Allow over capacity'),
    ),
    feeHost,
  );

  openModal({
    title: inquiry ? `Admit ${inquiry.student_name}` : 'Enroll in a batch',
    subtitle: inquiry ? 'Creates the student profile, enrolls them and opens their fee plan.' : 'The student gets the next roll number in the batch.',
    icon: 'userPlus',
    wide: true,
    body,
    footer: [h('button', { class: 'btn ghost', type: 'button', onclick: closeModal }, 'Cancel'), submit],
  });
}
