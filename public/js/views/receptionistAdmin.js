import { api } from '../api.js';
import { append, buildForm, clear, closeModal, confirmDialog, date, h, openModal, renderIcon, table, toast } from '../ui.js';

/**
 * Operator console → AI receptionist: what CoachBook institutes pay for the
 * WhatsApp admissions assistant. The price, free trial and longer-plan
 * discounts are set here once for every institute; each institute's row
 * shows where its plan stands, what it has paid and how much the assistant
 * is actually doing for it, with the levers for the support cases — a UPI
 * payment taken outside the app, free months, a special price, a longer
 * trial, ending access. See src/coaching/receptionistBilling.js.
 */

const fill = (el, ...children) => append(clear(el), children);
const rupees = (n) => `₹${Math.round(Number(n || 0)).toLocaleString('en-IN')}`;

const STATUS = {
  active: { label: 'Paid', tone: 'green' },
  trial: { label: 'Free trial', tone: 'blue' },
  expired: { label: 'Lapsed', tone: 'red' },
  none: { label: 'Not started', tone: 'grey' },
};
const CHANNEL = { online: 'Razorpay', manual: 'Paid outside app', comp: 'Free months' };

function kpi(label, value, { icon, tone = 'blue', foot } = {}) {
  return h(
    'div',
    { class: `card op-kpi tone-${tone}` },
    h('div', { class: 'op-kpi-head' }, h('span', { class: 'op-kpi-label' }, label), icon ? h('span', { class: 'op-kpi-icon' }, renderIcon(icon, { size: 17 })) : null),
    h('div', { class: 'op-kpi-value' }, value),
    foot ? h('div', { class: 'op-kpi-foot' }, foot) : null,
  );
}

const cardTitle = (icon, text, tone = 'blue') =>
  h('div', { class: `op-card-title tone-${tone}` }, h('span', { class: 'head-icon' }, renderIcon(icon, { size: 17 })), h('h3', {}, text));

/** What each plan length costs at these settings — the same arithmetic as
 * offersFor() on the server, so the preview is what institutes will see. */
function previewOffers(s) {
  return [1, 3, 6, 12].map((months) => {
    const discount = months === 1 ? 0 : Number(s[`discount_${months}m`]) || 0;
    return { months, price: Math.round(Number(s.price_monthly) * months * (1 - discount / 100)), discount };
  });
}

function pricingCard(state, { onSaved }) {
  const s = state.settings;
  const preview = h('div', { class: 'op-rc-preview' });
  const paintPreview = (values) =>
    fill(
      preview,
      ...previewOffers(values).map((o) =>
        h('div', {}, h('strong', {}, rupees(o.price)), h('span', { class: 'muted' }, `${o.months} month${o.months === 1 ? '' : 's'}${o.discount ? ` · ${o.discount}% off` : ''}`)),
      ),
    );
  paintPreview(s);

  const form = buildForm(
    [
      { name: 'price_monthly', label: 'Price per month (₹)', type: 'number', min: 1, step: 1, value: s.price_monthly, required: true, hint: 'Every institute without a special price pays this.' },
      { name: 'trial_days', label: 'Free trial (days)', type: 'number', min: 0, max: 90, value: s.trial_days, hint: 'Starts when an institute first switches the assistant on. 0 = no trial.' },
      { name: 'discount_3m', label: '3-month discount (%)', type: 'number', min: 0, max: 90, step: 'any', value: s.discount_3m },
      { name: 'discount_6m', label: '6-month discount (%)', type: 'number', min: 0, max: 90, step: 'any', value: s.discount_6m },
      { name: 'discount_12m', label: '12-month discount (%)', type: 'number', min: 0, max: 90, step: 'any', value: s.discount_12m },
      {
        name: 'sales_open',
        label: 'Selling',
        type: 'select',
        value: String(s.sales_open),
        options: [
          { value: '1', label: 'Open — trials and purchases allowed' },
          { value: '0', label: 'Closed — paid institutes keep running' },
        ],
      },
    ],
    {
      submitLabel: 'Save pricing',
      onSubmit: async (values) => {
        const payload = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, Number(v)]));
        const fresh = await api.platformUpdateReceptionistPricing(payload);
        toast(`Saved — new purchases are ${rupees(fresh.settings.price_monthly)}/month`);
        await onSaved(fresh);
      },
    },
  );
  // Live preview while typing; the form itself is untouched.
  form.addEventListener('input', () => {
    const values = Object.fromEntries(new FormData(form).entries());
    if (Number(values.price_monthly) > 0) paintPreview(values);
  });
  // buildForm's Cancel closes a modal; there is none here.
  form.querySelector('.modal-foot .btn.ghost')?.remove();

  return h(
    'div',
    { class: 'card' },
    h('div', { class: 'card-head' }, cardTitle('revenue', 'Price', 'green')),
    !state.razorpay_configured
      ? h(
          'p',
          { class: 'op-rc-warn' },
          renderIcon('alert', { size: 15 }),
          'Razorpay keys are not set on this server, so institutes cannot pay in the app. Record UPI or bank payments against each institute below.',
        )
      : null,
    h('p', { class: 'muted', style: 'margin:0 0 10px;font-size:13px' }, 'What institutes see when they buy:'),
    preview,
    form,
  );
}

function recordPaymentModal(row, refresh) {
  openModal({
    title: `${row.name} — record a payment`,
    subtitle: 'For money taken outside the app (UPI, bank transfer, cash), or months given free. The months add on to any time they have left.',
    icon: 'wallet',
    body: buildForm(
      [
        { name: 'months', label: 'Months', type: 'number', min: 1, max: 36, value: 1, required: true },
        {
          name: 'channel',
          label: 'Type',
          type: 'select',
          value: 'manual',
          options: [
            { value: 'manual', label: 'Paid outside the app' },
            { value: 'comp', label: 'Free months (no revenue)' },
          ],
        },
        { name: 'amount', label: 'Amount received (₹)', type: 'number', min: 0, value: row.plan.price_monthly, hint: `Their price: ${rupees(row.plan.price_monthly)}/month` },
        { name: 'note', label: 'Reference / note', full: true, placeholder: 'UPI ref 4432…' },
      ],
      {
        submitLabel: 'Record',
        onSubmit: async (values) => {
          const fresh = await api.platformRecordReceptionistPayment(row.slug, {
            months: Number(values.months),
            channel: values.channel,
            amount: values.channel === 'comp' ? 0 : Number(values.amount),
            note: values.note || undefined,
          });
          closeModal();
          toast(`Recorded — ${row.name} is covered until ${date(fresh.institutes.find((i) => i.slug === row.slug)?.plan.ends_on)}`);
          await refresh(fresh);
        },
      },
    ),
  });
}

function priceModal(row, refresh) {
  openModal({
    title: `${row.name} — special price`,
    subtitle: 'Their own monthly price, used for their next purchase. Leave empty to go back to the standard price.',
    icon: 'revenue',
    body: buildForm(
      [{ name: 'price_monthly', label: 'Price per month (₹)', type: 'number', min: 1, step: 1, value: row.plan.custom_price ? row.plan.price_monthly : '', full: true }],
      {
        submitLabel: 'Save price',
        onSubmit: async (values) => {
          const price = values.price_monthly === '' ? null : Number(values.price_monthly);
          const fresh = await api.platformAdjustReceptionist(row.slug, { price_monthly: price });
          closeModal();
          toast(price ? `${row.name} now pays ${rupees(price)}/month` : `${row.name} is back on the standard price`);
          await refresh(fresh);
        },
      },
    ),
  });
}

function trialModal(row, refresh) {
  openModal({
    title: `${row.name} — extend the free trial`,
    subtitle: 'Adds days to a running trial, or starts a new one from today.',
    icon: 'timer',
    body: buildForm([{ name: 'days', label: 'Days', type: 'number', min: 1, max: 90, value: 7, required: true, full: true }], {
      submitLabel: 'Extend trial',
      onSubmit: async (values) => {
        const fresh = await api.platformAdjustReceptionist(row.slug, { extend_trial_days: Number(values.days) });
        closeModal();
        toast(`${row.name}'s trial now runs until ${date(fresh.institutes.find((i) => i.slug === row.slug)?.plan.ends_on)}`);
        await refresh(fresh);
      },
    }),
  });
}

function endAccess(row, refresh) {
  confirmDialog({
    title: `End ${row.name}'s AI receptionist?`,
    message: 'It stops answering their parents today. Their settings and chats stay; recording a payment switches it back on.',
    confirmLabel: 'End access',
    danger: true,
    onConfirm: async () => {
      const fresh = await api.platformAdjustReceptionist(row.slug, { end_access: true });
      toast(`${row.name}'s AI receptionist has ended`);
      await refresh(fresh);
    },
  });
}

function planCell(plan) {
  const status = STATUS[plan.status] || STATUS.none;
  const when =
    plan.status === 'active' || plan.status === 'trial'
      ? `until ${date(plan.ends_on)} · ${plan.days_left}d left`
      : plan.status === 'expired'
        ? `ended ${date(plan.paid_until && plan.paid_until > (plan.trial_ends_on || '') ? plan.paid_until : plan.trial_ends_on)}`
        : plan.trial_available
          ? 'trial not used'
          : '';
  return h('div', {}, h('span', { class: `badge ${status.tone}` }, status.label), when ? h('div', { class: 'muted', style: 'font-size:12px;margin-top:3px' }, when) : null);
}

function usageCell(usage) {
  if (!usage) return h('span', { class: 'muted' }, '—');
  return h(
    'div',
    { style: 'font-size:12.5px' },
    h('div', {}, `${usage.replies_30d} replies · ${usage.leads_30d} leads · ${usage.demos_30d} demos`),
    h('div', { class: 'muted', style: 'font-size:12px' }, usage.switched_on ? 'Switched on' : 'Switched off by the institute'),
  );
}

function institutesCard(state, refresh) {
  const order = { expired: 0, trial: 1, active: 2, none: 3 };
  const rows = [...state.institutes].sort((a, b) => order[a.plan.status] - order[b.plan.status] || a.plan.days_left - b.plan.days_left);
  const action = (icon, title, fn) => h('button', { class: 'btn sm ghost', type: 'button', title, 'aria-label': title, onclick: fn }, renderIcon(icon, { size: 14 }));
  return h(
    'div',
    { class: 'card' },
    h('div', { class: 'card-head' }, cardTitle('graduation', `Institutes (${rows.length})`, 'purple')),
    table(
      [
        { label: 'Institute', render: (r) => h('div', {}, h('strong', {}, r.name), h('div', { class: 'muted', style: 'font-size:12px' }, r.slug)) },
        { label: 'Plan', render: (r) => planCell(r.plan) },
        {
          label: 'Price',
          render: (r) => h('div', {}, `${rupees(r.plan.price_monthly)}/mo`, r.plan.custom_price ? h('div', { class: 'muted', style: 'font-size:12px' }, 'special price') : null),
        },
        { label: 'Last 30 days', render: (r) => usageCell(r.usage) },
        { label: 'Collected', align: 'right', render: (r) => h('div', {}, rupees(r.revenue), r.last_paid_at ? h('div', { class: 'muted', style: 'font-size:12px' }, date(r.last_paid_at)) : null) },
        {
          label: '',
          align: 'right',
          render: (r) =>
            h(
              'div',
              { class: 'op-rc-actions' },
              h('button', { class: 'btn sm primary', type: 'button', onclick: () => recordPaymentModal(r, refresh) }, renderIcon('plus', { size: 14 }), 'Payment'),
              action('revenue', 'Special price', () => priceModal(r, refresh)),
              action('timer', 'Extend trial', () => trialModal(r, refresh)),
              r.plan.status === 'active' || r.plan.status === 'trial' ? action('ban', 'End access', () => endAccess(r, refresh)) : null,
            ),
        },
      ],
      rows,
      { empty: 'No CoachBook institutes yet' },
    ),
  );
}

function paymentsCard(state) {
  const names = Object.fromEntries(state.institutes.map((i) => [i.slug, i.name]));
  return h(
    'div',
    { class: 'card' },
    h('div', { class: 'card-head' }, cardTitle('billing', 'Payments', 'amber')),
    table(
      [
        { label: 'Date', render: (p) => h('span', { class: 'muted' }, date(p.paid_at)) },
        { label: 'Institute', render: (p) => names[p.tenant_slug] || p.tenant_slug },
        { label: 'Plan', render: (p) => `${p.months} month${p.months === 1 ? '' : 's'}${p.period_end ? ` · to ${date(p.period_end)}` : ''}` },
        {
          label: 'How',
          render: (p) =>
            h('div', {}, h('span', { class: `badge ${p.channel === 'online' ? 'green' : p.channel === 'comp' ? 'grey' : 'blue'}` }, CHANNEL[p.channel]), p.note ? h('div', { class: 'muted', style: 'font-size:12px' }, p.note) : null),
        },
        { label: 'Amount', align: 'right', render: (p) => rupees(p.amount) },
      ],
      state.payments,
      { empty: 'No payments yet' },
    ),
  );
}

export function renderReceptionistSection({ onExpired } = {}) {
  const root = h('div', { class: 'op-rc' }, h('div', { class: 'empty' }, 'Loading…'));

  function paint(state) {
    const s = state.summary;
    fill(
      root,
      h(
        'div',
        { class: 'op-kpis' },
        kpi('Paying institutes', s.paying, { icon: 'graduation', tone: 'green', foot: `${s.expired} lapsed` }),
        kpi('On free trial', s.on_trial, { icon: 'timer', tone: 'blue', foot: 'Convert these next' }),
        kpi('Monthly run rate', rupees(s.monthly_run_rate), { icon: 'trendUp', tone: 'purple', foot: 'Paying institutes × their price' }),
        kpi('Collected this month', rupees(s.revenue_month), { icon: 'revenue', tone: 'amber', foot: `${rupees(s.revenue_total)} all time` }),
      ),
      pricingCard(state, { onSaved: refresh }),
      institutesCard(state, refresh),
      paymentsCard(state),
    );
  }

  async function refresh(fresh) {
    try {
      paint(fresh ?? (await api.platformReceptionist()));
    } catch (err) {
      if ((err.status === 401 || err.status === 403) && onExpired) return onExpired();
      fill(root, h('div', { class: 'empty' }, err.message || 'Could not load the AI receptionist'));
    }
  }

  refresh();
  return root;
}
