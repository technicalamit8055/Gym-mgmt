import { api, session } from '../../api.js';
import { coaching } from '../../coachingApi.js';
import { clear, closeModal, confirmDialog, date, dateField, emptyState, h, money, openModal, renderIcon, stat, toast, today } from '../../ui.js';
import { fill, fullName, INSTALLMENT_STATUS, openAlertSettings, pct, pillTabs, PLAN_STATUS, reportSend, section, selectControl, tone } from './common.js';
import { feeFields } from './enrollForm.js';

/**
 * Fees & installments: who owes what and when, collecting it, and the
 * receipts. A payment is spread across a plan's installments oldest-first by
 * the server (or onto the installment it was collected against), so the desk
 * only ever types "how much, and how".
 */

const METHODS = [
  { value: 'cash', label: 'Cash' },
  { value: 'upi', label: 'UPI' },
  { value: 'card', label: 'Card' },
  { value: 'bank', label: 'Bank transfer' },
  { value: 'cheque', label: 'Cheque' },
  { value: 'online', label: 'Online' },
];
const methodLabel = (m) => METHODS.find((x) => x.value === m)?.label || m;

/* ── Collecting a payment ────────────────────────────────────────────── */

export function openCollectModal({ plan, installment = null, onDone }) {
  const suggested = installment ? installment.balance : plan.installments.find((i) => i.balance > 0.005)?.balance ?? plan.balance;
  const amount = h('input', { type: 'number', min: 1, step: '1', value: suggested, max: plan.balance });
  const method = h('select', {}, ...METHODS.map((m) => h('option', { value: m.value }, m.label)));
  const chequeNo = h('input', { type: 'text', placeholder: 'Cheque number' });
  const chequeField = h('label', { class: 'field', hidden: true }, h('span', {}, 'Cheque number', h('span', { class: 'req' }, ' *')), chequeNo);
  method.addEventListener('change', () => (chequeField.hidden = method.value !== 'cheque'));
  const paidOn = dateField({ name: 'paid_on', value: today(), max: today() });
  const reference = h('input', { type: 'text', placeholder: 'UPI ref / transaction id' });
  const note = h('input', { type: 'text', placeholder: 'Optional' });
  const sendReceipt = h('input', { type: 'checkbox', checked: true });
  const field = (label, control, full = false) => h('label', { class: `field${full ? ' full' : ''}` }, h('span', {}, label), control);

  const submit = h('button', { class: 'btn primary', type: 'button' }, renderIcon('check', { size: 16 }), 'Record payment');
  submit.addEventListener('click', async () => {
    submit.disabled = true;
    try {
      const res = await coaching.collect(plan.id, {
        amount: Number(amount.value),
        method: method.value,
        cheque_no: method.value === 'cheque' ? chequeNo.value.trim() : undefined,
        paid_on: paidOn.value || today(),
        reference: reference.value.trim() || undefined,
        note: note.value.trim() || undefined,
        installment_id: installment?.id,
        send_receipt: sendReceipt.checked,
      });
      closeModal();
      toast(`${money(Number(amount.value))} received · receipt ${res.receipt_no}`);
      if (sendReceipt.checked) reportSend(res.whatsapp, { what: 'receipt' });
      await onDone?.(res);
    } catch (err) {
      toast(err.message || 'Could not record the payment', 'error');
    } finally {
      submit.disabled = false;
    }
  });

  openModal({
    title: `Collect fee · ${fullName(plan)}`,
    subtitle: `${plan.course_name} · ${money(plan.balance)} left to pay${installment ? ` · installment ${installment.installment_number}` : ''}`,
    icon: 'wallet',
    body: h(
      'div',
      { class: 'form-grid' },
      field('Amount', amount),
      field('Method', method),
      chequeField,
      field('Date', paidOn),
      field('Reference', reference),
      field('Note', note, true),
      h('label', { class: 'cb-check field full' }, sendReceipt, 'WhatsApp the PDF receipt to the guardian'),
    ),
    footer: [h('button', { class: 'btn ghost', type: 'button', onclick: closeModal }, 'Cancel'), submit],
  });
}

/* ── One plan ────────────────────────────────────────────────────────── */

function openReschedule(plan, onDone) {
  const kept = plan.installments.filter((i) => i.amount_paid > 0.005);
  const keptTotal = kept.reduce((acc, i) => acc + i.amount_paid, 0);
  const remaining = Math.round((plan.final_amount - keptTotal) * 100) / 100;
  const fees = feeFields({ course: { fee_structures: [{ id: '', name: 'Remaining balance', total_fee: remaining, installments: 2, interval_days: 30 }] } });
  // The total here is what is left, not the course fee: lock it.
  fees.node.querySelector('.cb-check')?.remove();
  const body = h(
    'div',
    {},
    h('p', { class: 'muted' }, `${money(remaining)} is still to be scheduled. Installments with money against them stay as they are${kept.length ? ` (${kept.length} kept)` : ''}.`),
    fees.node,
  );
  const save = h('button', { class: 'btn primary' }, 'Save new schedule');
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      const value = fees.value();
      if (Math.abs(value.total_amount - value.discount_amount - remaining) > 0.005) throw new Error(`The new schedule must cover exactly ${money(remaining)}`);
      await coaching.reschedule(plan.id, value.schedule);
      closeModal();
      toast('Schedule updated');
      await onDone?.();
    } catch (err) {
      toast(err.message, 'error');
      save.disabled = false;
    }
  });
  openModal({ title: 'Reschedule the unpaid fee', icon: 'calendar', wide: true, body, footer: [h('button', { class: 'btn ghost', onclick: closeModal }, 'Cancel'), save] });
}

export async function openPlanModal(planId, { onChanged } = {}) {
  const body = h('div', {}, h('p', { class: 'muted' }, 'Loading…'));
  const paint = async () => {
    const plan = await coaching.feePlan(planId);
    const refresh = async () => {
      await paint();
      await onChanged?.();
    };
    fill(body, 
      h(
        'div',
        { class: 'cb-plan-summary' },
        h('div', {}, h('span', { class: 'muted cb-small' }, 'Course fee'), h('strong', {}, money(plan.total_amount))),
        plan.discount_amount
          ? h('div', {}, h('span', { class: 'muted cb-small' }, `Concession${plan.discount_reason ? ` (${plan.discount_reason})` : ''}`), h('strong', { class: 'cb-green' }, `− ${money(plan.discount_amount)}`))
          : null,
        h('div', {}, h('span', { class: 'muted cb-small' }, 'Payable'), h('strong', {}, money(plan.final_amount))),
        h('div', {}, h('span', { class: 'muted cb-small' }, 'Paid'), h('strong', { class: 'cb-green' }, money(plan.amount_paid))),
        h('div', {}, h('span', { class: 'muted cb-small' }, 'Balance'), h('strong', { class: plan.balance > 0 ? 'cb-red' : '' }, money(plan.balance))),
        h('div', {}, h('span', { class: 'muted cb-small' }, 'Status'), tone(PLAN_STATUS, plan.effective_status)),
      ),
      plan.components.length ? h('p', { class: 'muted cb-small' }, `Includes ${plan.components.map((c) => `${c.label} ${money(c.amount)}`).join(' · ')}`) : null,
      h('div', { class: 'cb-subhead' }, 'Installments'),
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          { class: 'cb-table' },
          h('thead', {}, h('tr', {}, ...['#', 'Due', 'Amount', 'Paid', 'Balance', 'Status', ''].map((l) => h('th', {}, l)))),
          h(
            'tbody',
            {},
            ...plan.installments.map((inst) =>
              h(
                'tr',
                {},
                h('td', {}, h('div', { class: 'cb-strong' }, inst.installment_number), h('div', { class: 'muted cb-small' }, inst.label || '')),
                h('td', {}, date(inst.due_date)),
                h('td', {}, money(inst.amount_due)),
                h('td', {}, money(inst.amount_paid)),
                h('td', { class: inst.balance > 0.005 ? 'cb-strong' : 'muted' }, money(inst.balance)),
                h('td', {}, tone(INSTALLMENT_STATUS, inst.status), inst.reminder_sent_at ? h('div', { class: 'muted cb-small' }, `Reminded ${date(inst.reminder_sent_at)}`) : null),
                h(
                  'td',
                  {},
                  inst.balance > 0.005 && plan.status !== 'cancelled'
                    ? h(
                        'div',
                        { class: 'row' },
                        h('button', { class: 'btn sm primary', onclick: () => openCollectModal({ plan, installment: inst, onDone: refresh }) }, 'Collect'),
                        h(
                          'button',
                          {
                            class: 'btn sm ghost',
                            title: 'WhatsApp a reminder to the guardian',
                            onclick: async () => {
                              try {
                                await coaching.remindInstallment(inst.id);
                                toast('Reminder going out on WhatsApp');
                                await paint();
                              } catch (err) {
                                toast(err.message, 'error');
                              }
                            },
                          },
                          renderIcon('whatsapp', { size: 14 }),
                        ),
                      )
                    : null,
                ),
              ),
            ),
          ),
        ),
      ),
      h('div', { class: 'cb-subhead' }, `Payments · ${plan.payments.length}`),
      plan.payments.length
        ? h('div', {}, ...plan.payments.map((p) => paymentRow({ ...p, receipt_no: `FEE-${String(p.id).padStart(5, '0')}`, method: p.cheque_no ? 'cheque' : p.method }, refresh)))
        : h('p', { class: 'muted cb-small' }, 'Nothing collected yet.'),
      plan.note ? h('p', { class: 'muted cb-small' }, `Note: ${plan.note}`) : null,
      h(
        'div',
        { class: 'cb-plan-actions' },
        plan.balance > 0.005 && plan.status !== 'cancelled'
          ? h('button', { class: 'btn primary', onclick: () => openCollectModal({ plan, onDone: refresh }) }, renderIcon('wallet', { size: 15 }), 'Collect payment')
          : null,
        plan.balance > 0.005 && plan.status !== 'cancelled' ? h('button', { class: 'btn', onclick: () => openReschedule(plan, refresh) }, renderIcon('calendar', { size: 15 }), 'Reschedule') : null,
        h('div', { class: 'spacer' }),
        plan.status === 'active'
          ? h(
              'button',
              {
                class: 'btn ghost',
                onclick: () =>
                  confirmDialog({
                    title: 'Cancel this fee plan?',
                    message: 'For a student who left: no more reminders, and the unpaid balance stops counting as owed. Money already collected stays on record.',
                    confirmLabel: 'Cancel plan',
                    danger: true,
                    secondaryLabel: 'Mark defaulted instead',
                    onSecondary: async () => {
                      await coaching.updateFeePlan(plan.id, { status: 'defaulted' });
                      closeModal();
                      await refresh();
                    },
                    onConfirm: async () => {
                      await coaching.updateFeePlan(plan.id, { status: 'cancelled' });
                      await refresh();
                    },
                  }),
              },
              'Cancel plan',
            )
          : h('button', { class: 'btn ghost', onclick: async () => { await coaching.updateFeePlan(plan.id, { status: 'active' }); await refresh(); } }, 'Re-open plan'),
      ),
    );
  };
  const plan = await coaching.feePlan(planId);
  openModal({ title: `${fullName(plan)} · ${plan.course_name}`, subtitle: `${plan.member_code}${plan.batch_name ? ` · ${plan.batch_name}` : ''}`, icon: 'wallet', wide: true, body });
  await paint();
}

function paymentRow(p, reload) {
  return h(
    'div',
    { class: 'list-item' },
    h(
      'div',
      { class: 'cb-grow' },
      h('div', { class: 'cb-strong' }, `${money(p.amount)} · ${methodLabel(p.method)}`),
      h(
        'div',
        { class: 'muted cb-small' },
        [p.receipt_no, date(p.paid_on), p.reference, p.cheque_no ? `Cheque ${p.cheque_no}` : null].filter(Boolean).join(' · '),
        p.cheque_status === 'pending' ? h('span', { class: 'badge amber cb-ml' }, 'Cheque not cleared') : null,
      ),
    ),
    h('button', { class: 'btn sm ghost', title: 'Download PDF receipt', 'aria-label': 'Download receipt', onclick: () => coaching.downloadReceipt(p.id).catch((e) => toast(e.message, 'error')) }, renderIcon('download', { size: 14 })),
    h(
      'button',
      {
        class: 'btn sm ghost',
        title: 'Send the receipt on WhatsApp',
        'aria-label': 'Send receipt on WhatsApp',
        onclick: async () => {
          try {
            await coaching.sendReceipt(p.id);
            toast('Receipt going out on WhatsApp');
          } catch (err) {
            toast(err.message, 'error');
          }
        },
      },
      renderIcon('whatsapp', { size: 14 }),
    ),
    session.can('admin')
      ? h(
          'button',
          {
            class: 'btn sm ghost',
            title: 'Delete this payment',
            'aria-label': 'Delete payment',
            onclick: () =>
              confirmDialog({
                title: `Delete the ${money(p.amount)} payment?`,
                message: 'Only for a payment entered by mistake. The installments it covered fall due again.',
                confirmLabel: 'Delete payment',
                danger: true,
                onConfirm: async () => {
                  await coaching.deletePayment(p.id);
                  toast('Payment deleted');
                  await reload();
                },
              }),
          },
          renderIcon('trash', { size: 14 }),
        )
      : null,
  );
}

/* ── A new plan for an existing student ──────────────────────────────── */

export async function openNewPlanModal({ member = null, onDone } = {}) {
  const [{ items: courses }, { items: batches }] = await Promise.all([coaching.courses(), coaching.batches()]);
  if (!courses.length) return toast('Create a course first', 'info');
  let chosen = member;
  let course = courses[0];
  const feeHost = h('div', {});
  let fee;
  const paintFee = () => {
    fee = feeFields({ course });
    fee.node.querySelector('.cb-check')?.remove();
    fill(feeHost, fee.node);
  };
  paintFee();
  const batchSelect = h('select', {});
  const paintBatches = () =>
    fill(batchSelect, h('option', { value: '' }, 'No particular batch'), ...batches.filter((b) => b.course_id === course.id).map((b) => h('option', { value: b.id }, b.name)));
  paintBatches();
  const courseSelect = h(
    'select',
    {
      onchange: (e) => {
        course = courses.find((c) => c.id === Number(e.target.value));
        paintFee();
        paintBatches();
      },
    },
    ...courses.map((c) => h('option', { value: c.id }, c.name)),
  );
  const results = h('div', { class: 'cb-picker-results' });
  const search = h('input', {
    type: 'search',
    class: 'search',
    placeholder: 'Search students…',
    oninput: async (e) => {
      const q = e.target.value.trim();
      if (q.length < 2) return clear(results);
      const { items } = await api.members({ q, limit: 8 });
      fill(results, 
        ...items.map((m) =>
          h('button', { type: 'button', class: 'cb-picker-item', onclick: () => { chosen = m; search.value = fullName(m); clear(results); } }, h('strong', {}, fullName(m)), h('span', { class: 'muted' }, ` ${m.code}`)),
        ),
      );
    },
  });
  const save = h('button', { class: 'btn primary' }, 'Create fee plan');
  save.addEventListener('click', async () => {
    if (!chosen) return toast('Choose a student', 'error');
    save.disabled = true;
    try {
      const value = fee.value();
      const plan = await coaching.createFeePlan({ ...value, member_id: chosen.id, course_id: course.id, batch_id: batchSelect.value || undefined });
      closeModal();
      toast('Fee plan created');
      await onDone?.(plan);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      save.disabled = false;
    }
  });
  const field = (label, control) => h('label', { class: 'field full' }, h('span', {}, label), control);
  openModal({
    title: 'New fee plan',
    icon: 'wallet',
    wide: true,
    body: h(
      'div',
      {},
      h(
        'div',
        { class: 'form-grid' },
        member ? h('div', { class: 'field full' }, h('span', {}, 'Student'), h('strong', {}, `${fullName(member)} · ${member.code}`)) : field('Student', h('div', { class: 'cb-picker-wrap' }, search, results)),
        field('Course', courseSelect),
        field('Batch', batchSelect),
      ),
      feeHost,
    ),
    footer: [h('button', { class: 'btn ghost', onclick: closeModal }, 'Cancel'), save],
  });
}

/* ── Panes ───────────────────────────────────────────────────────────── */

async function duesPane(state, repaint) {
  const { items } = await coaching.dues({ window: state.window, days: 7 });
  const windows = [
    { value: 'overdue', label: 'Overdue' },
    { value: 'upcoming', label: 'Due in the next 7 days' },
    { value: 'all', label: 'Everything unpaid' },
  ];
  return h(
    'div',
    { class: 'grid', style: 'gap:16px' },
    h('div', { class: 'toolbar' }, selectControl(windows, state.window, (v) => { state.window = v; repaint(); })),
    h(
      'div',
      { class: 'card', style: 'padding:6px 6px 14px' },
      items.length
        ? h(
            'div',
            { class: 'table-wrap' },
            h(
              'table',
              { class: 'cb-table' },
              h('thead', {}, h('tr', {}, ...['Student', 'Course', 'Installment', 'Due', 'Balance', 'Status', ''].map((l) => h('th', {}, l)))),
              h(
                'tbody',
                {},
                ...items.map((d) =>
                  h(
                    'tr',
                    {},
                    h('td', {}, h('a', { class: 'cb-strong', href: `#/members/${d.member_id}` }, fullName(d)), h('div', { class: 'muted cb-small' }, `${d.member_code} · ${d.emergency_phone || d.phone || 'no phone'}`)),
                    h('td', {}, h('div', {}, d.course_name), h('div', { class: 'muted cb-small' }, d.batch_name || '')),
                    h('td', {}, `#${d.installment_number}`),
                    h('td', {}, h('div', {}, date(d.due_date)), d.days_overdue > 0 ? h('div', { class: 'cb-red cb-small' }, `${d.days_overdue} days late`) : null),
                    h('td', { class: 'cb-strong' }, money(d.balance)),
                    h('td', {}, tone(INSTALLMENT_STATUS, d.status), d.reminder_sent_at ? h('div', { class: 'muted cb-small' }, `Reminded ${date(d.reminder_sent_at)}`) : null),
                    h(
                      'td',
                      {},
                      h(
                        'div',
                        { class: 'row' },
                        h(
                          'button',
                          {
                            class: 'btn sm primary',
                            onclick: async () => {
                              const plan = await coaching.feePlan(d.plan_id);
                              openCollectModal({ plan, installment: plan.installments.find((i) => i.id === d.id), onDone: repaint });
                            },
                          },
                          'Collect',
                        ),
                        h('button', { class: 'btn sm ghost', onclick: () => openPlanModal(d.plan_id, { onChanged: repaint }) }, 'Plan'),
                        h(
                          'button',
                          {
                            class: 'btn sm ghost',
                            title: 'WhatsApp a reminder to the guardian',
                            'aria-label': 'Send reminder',
                            onclick: async () => {
                              try {
                                await coaching.remindInstallment(d.id);
                                toast(`Reminder going out to ${fullName(d)}’s guardian`);
                              } catch (err) {
                                toast(err.message, 'error');
                              }
                            },
                          },
                          renderIcon('whatsapp', { size: 14 }),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          )
        : emptyState(state.window === 'overdue' ? 'Nothing is overdue. 🎉' : 'Nothing due in this window.', { icon: 'checkCircle' }),
    ),
  );
}

async function plansPane(state, repaint) {
  const { items } = await coaching.feePlans({ status: state.planStatus || undefined, q: state.q || undefined });
  // Kept across repaints, so typing does not lose focus when the list redraws.
  state.search ??= h('input', {
    type: 'search',
    class: 'search',
    placeholder: 'Search by student, ID or phone…',
    oninput: (e) => {
      clearTimeout(state.searchTimer);
      state.searchTimer = setTimeout(() => {
        state.q = e.target.value.trim();
        state.refocusSearch = true;
        repaint();
      }, 300);
    },
  });
  const search = state.search;
  return h(
    'div',
    { class: 'grid', style: 'gap:16px' },
    h(
      'div',
      { class: 'toolbar' },
      search,
      selectControl(Object.entries(PLAN_STATUS).map(([value, s]) => ({ value, label: s.label })), state.planStatus, (v) => { state.planStatus = v; repaint(); }, { placeholder: 'Any status' }),
    ),
    h(
      'div',
      { class: 'card', style: 'padding:6px 6px 14px' },
      items.length
        ? h(
            'div',
            { class: 'table-wrap' },
            h(
              'table',
              { class: 'cb-table' },
              h('thead', {}, h('tr', {}, ...['Student', 'Course', 'Payable', 'Paid', 'Balance', 'Next due', 'Status'].map((l) => h('th', {}, l)))),
              h(
                'tbody',
                {},
                ...items.map((p) =>
                  h(
                    'tr',
                    { class: 'clickable', onclick: () => openPlanModal(p.id, { onChanged: repaint }) },
                    h('td', {}, h('div', { class: 'cb-strong' }, fullName(p)), h('div', { class: 'muted cb-small' }, p.member_code)),
                    h('td', {}, h('div', {}, p.course_name), h('div', { class: 'muted cb-small' }, p.batch_name || '')),
                    h('td', {}, money(p.final_amount), p.discount_amount ? h('div', { class: 'muted cb-small' }, `${money(p.discount_amount)} off`) : null),
                    h('td', {}, money(p.amount_paid)),
                    h('td', { class: p.balance > 0 ? 'cb-strong' : 'muted' }, money(p.balance)),
                    h('td', {}, p.next_due_date ? date(p.next_due_date) : '—'),
                    h('td', {}, tone(PLAN_STATUS, p.effective_status)),
                  ),
                ),
              ),
            ),
          )
        : emptyState('No fee plans match.', { icon: 'wallet' }),
    ),
  );
}

async function collectionsPane(state, repaint) {
  const from = state.from || `${today().slice(0, 7)}-01`;
  const to = state.to || today();
  const data = await coaching.feePayments({ from, to, cheque: state.chequesOnly ? 'pending' : undefined });
  const fromInput = dateField({ name: 'from', value: from, max: today(), onchange: (e) => { state.from = e.target.value; repaint(); } });
  const toInput = dateField({ name: 'to', value: to, max: today(), onchange: (e) => { state.to = e.target.value; repaint(); } });
  return h(
    'div',
    { class: 'grid', style: 'gap:16px' },
    h(
      'div',
      { class: 'toolbar' },
      h('label', { class: 'toolbar-pair' }, h('span', { class: 'muted' }, 'From'), fromInput),
      h('label', { class: 'toolbar-pair' }, h('span', { class: 'muted' }, 'To'), toInput),
      h('label', { class: 'cb-check' }, h('input', { type: 'checkbox', checked: Boolean(state.chequesOnly), onchange: (e) => { state.chequesOnly = e.target.checked; repaint(); } }), 'Uncleared cheques only'),
    ),
    h(
      'div',
      { class: 'pill-row' },
      h('span', { class: 'badge blue' }, `Total ${money(data.total)}`),
      ...Object.entries(data.by_method).map(([m, v]) => h('span', { class: 'badge grey' }, `${methodLabel(m)} ${money(v)}`)),
    ),
    section(
      `${data.items.length} payment${data.items.length === 1 ? '' : 's'}`,
      data.items.length
        ? h(
            'div',
            {},
            ...data.items.map((p) =>
              h(
                'div',
                { class: 'list-item' },
                h('div', { class: 'cb-grow' }, h('a', { class: 'cb-strong', href: `#/members/${p.member_id}` }, fullName(p)), h('div', { class: 'muted cb-small' }, `${p.course_name}${p.batch_name ? ` · ${p.batch_name}` : ''}`)),
                p.cheque_status === 'pending'
                  ? h(
                      'div',
                      { class: 'row' },
                      h('button', { class: 'btn sm', onclick: async () => { await coaching.chequeAction(p.id, 'clear'); toast('Cheque marked cleared'); repaint(); } }, 'Cleared'),
                      h(
                        'button',
                        {
                          class: 'btn sm ghost',
                          onclick: () =>
                            confirmDialog({
                              title: `Cheque ${p.cheque_no} bounced?`,
                              message: `The ${money(p.amount)} payment is removed and the installments it covered fall due again.`,
                              confirmLabel: 'Mark bounced',
                              danger: true,
                              onConfirm: async () => {
                                await coaching.chequeAction(p.id, 'bounce');
                                toast('Cheque marked bounced');
                                await repaint();
                              },
                            }),
                        },
                        'Bounced',
                      ),
                    )
                  : null,
                paymentRow(p, repaint),
              ),
            ),
          )
        : emptyState('No fee payments in this period.', { icon: 'receipt' }),
      { icon: 'receipt' },
    ),
  );
}

/* ── Page ────────────────────────────────────────────────────────────── */

export async function renderFees({ setActions }) {
  const state = { pane: 'dues', window: 'overdue', planStatus: '', q: '' };
  const statsHost = h('div', {});
  const tabsHost = h('div', {});
  const host = h('div', {});

  async function repaint() {
    const summary = await coaching.feeSummary();
    fill(statsHost, 
      h(
        'div',
        { class: 'grid cols-4' },
        stat('Collected this month', money(summary.collected_this_month), `${money(summary.collected, { compact: true })} in all`, { icon: 'wallet', accent: true }),
        stat('Still to collect', money(summary.outstanding), `${summary.plans} fee plans · ${money(summary.concessions, { compact: true })} in concessions`, { icon: 'hourglass' }),
        stat('Overdue', money(summary.overdue_amount), `${summary.overdue_count} installment${summary.overdue_count === 1 ? '' : 's'}`, {
          icon: 'alert',
          trend: summary.overdue_count ? { positive: false, text: 'Follow up' } : null,
          onClick: () => { state.pane = 'dues'; state.window = 'overdue'; repaint(); },
        }),
        stat('Collected on time', summary.collection_rate === null ? '—' : pct(summary.collection_rate), summary.pending_cheques ? `${summary.pending_cheques} cheques (${money(summary.pending_cheque_amount)}) to clear` : `${money(summary.due_this_week_amount)} due this week`, { icon: 'trendUp' }),
      ),
    );
    fill(tabsHost, 
      pillTabs(
        [
          { key: 'dues', label: 'Dues', icon: 'alert', count: summary.overdue_count || null },
          { key: 'plans', label: 'Fee plans', icon: 'list' },
          { key: 'collections', label: 'Collections', icon: 'receipt', count: summary.pending_cheques || null },
        ],
        state.pane,
        (key) => {
          state.pane = key;
          repaint();
        },
      ),
    );
    try {
      const pane = state.pane === 'dues' ? await duesPane(state, repaint) : state.pane === 'plans' ? await plansPane(state, repaint) : await collectionsPane(state, repaint);
      fill(host, pane);
      if (state.refocusSearch && state.search) {
        state.refocusSearch = false;
        state.search.focus();
      }
    } catch (err) {
      fill(host, h('div', { class: 'card' }, h('p', { class: 'cb-red' }, err.message)));
    }
  }

  setActions(
    h('button', { class: 'btn ghost', onclick: () => openAlertSettings({ focus: 'fees' }) }, renderIcon('settings', { size: 15 }), 'Reminder settings'),
    h(
      'button',
      {
        class: 'btn',
        onclick: () =>
          confirmDialog({
            title: 'Remind every overdue family now?',
            message: 'Each overdue installment not already reminded today gets a WhatsApp reminder to the guardian.',
            confirmLabel: 'Send reminders',
            onConfirm: async () => {
              const res = await coaching.remindOverdue();
              reportSend({ ...res, connected: true }, { what: 'reminders', none: 'Everyone overdue was already reminded today' });
              await repaint();
            },
          }),
      },
      renderIcon('whatsapp', { size: 15 }),
      'Remind overdue',
    ),
    h('button', { class: 'btn primary', onclick: () => openNewPlanModal({ onDone: repaint }) }, renderIcon('plus', { size: 16 }), 'New fee plan'),
  );
  await repaint();
  return h('div', { class: 'cb-page grid', style: 'gap:16px' }, statsHost, tabsHost, host);
}
