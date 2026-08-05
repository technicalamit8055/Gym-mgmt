import { api } from '../api.js';
import { addDays, buildForm, closeModal, h, money, openModal, today, toast } from '../ui.js';

/** Members formatted for a <datalist>-backed picker: "GM0004 — Priya Sharma". */
async function memberOptions() {
  const { items } = await api.members({ limit: 200, sort: 'name' });
  return items.map((m) => ({ value: `${m.code} — ${m.first_name} ${m.last_name}`.trim(), id: m.id }));
}

function resolveMember(options, raw) {
  const text = String(raw || '').trim().toLowerCase();
  const match = options.find((o) => o.value.toLowerCase() === text) || options.find((o) => o.value.toLowerCase().startsWith(text));
  return match?.id;
}

function datalist(id, options) {
  return h('datalist', { id }, ...options.map((option) => h('option', { value: option.value })));
}

/* ------------------------------------------------------------ member form */

export function openMemberForm({ member, onSaved }) {
  const editing = Boolean(member);
  openModal({
    title: editing ? `Edit ${member.first_name} ${member.last_name}` : 'Add a new member',
    wide: true,
    body: buildForm(
      [
        { name: 'first_name', label: 'First name', required: true, value: member?.first_name },
        { name: 'last_name', label: 'Last name', value: member?.last_name },
        { name: 'phone', label: 'Phone', value: member?.phone, placeholder: '9876543210' },
        { name: 'email', label: 'Email', type: 'email', value: member?.email },
        {
          name: 'gender',
          label: 'Gender',
          type: 'select',
          value: member?.gender || '',
          options: [
            { value: '', label: '—' },
            { value: 'male', label: 'Male' },
            { value: 'female', label: 'Female' },
            { value: 'other', label: 'Other' },
          ],
        },
        { name: 'date_of_birth', label: 'Date of birth', type: 'date', value: member?.date_of_birth },
        { name: 'joined_on', label: 'Joined on', type: 'date', value: member?.joined_on || today() },
        {
          name: 'status',
          label: 'Status',
          type: 'select',
          value: member?.status || 'active',
          options: [
            { value: 'active', label: 'Active' },
            { value: 'frozen', label: 'Frozen' },
            { value: 'inactive', label: 'Inactive' },
          ],
        },
        { name: 'emergency_contact', label: 'Emergency contact', value: member?.emergency_contact },
        { name: 'emergency_phone', label: 'Emergency phone', value: member?.emergency_phone },
        { name: 'address', label: 'Address', type: 'textarea', full: true, value: member?.address },
        {
          name: 'health_notes',
          label: 'Health notes',
          type: 'textarea',
          full: true,
          value: member?.health_notes,
          hint: 'Injuries, conditions or anything trainers should know',
        },
      ],
      {
        submitLabel: editing ? 'Save changes' : 'Add member',
        onSubmit: async (values) => {
          const saved = editing ? await api.updateMember(member.id, values) : await api.createMember(values);
          closeModal();
          toast(editing ? 'Member updated' : `${saved.first_name} added as ${saved.code}`);
          await onSaved?.(saved);
        },
      },
    ),
  });
}

/* ------------------------------------------------------- sell a membership */

export async function openMembershipForm({ member, onSaved }) {
  const [{ items: plans }, options] = await Promise.all([
    api.plans({ active: 'true' }),
    member ? Promise.resolve([]) : memberOptions(),
  ]);

  if (!plans.length) {
    toast('Create a membership plan first', 'error');
    return;
  }

  const planField = {
    name: 'plan_id',
    label: 'Plan',
    type: 'select',
    required: true,
    value: plans[0].id,
    options: plans.map((plan) => ({
      value: plan.id,
      label: `${plan.name} — ${money(plan.price)} / ${plan.duration_days} days`,
    })),
  };

  // A renewal has to begin after the membership already paid for, otherwise the
  // server rejects it as an overlap.
  const current = member?.subscriptions?.find((s) => s.status === 'active' && s.end_date >= today());
  const defaultStart = current ? addDays(current.end_date, 1) : today();

  const fields = [
    member
      ? null
      : {
          name: 'member',
          label: 'Member',
          required: true,
          full: true,
          list: 'member-options',
          placeholder: 'Search by code or name',
        },
    planField,
    {
      name: 'start_date',
      label: 'Starts on',
      type: 'date',
      value: defaultStart,
      hint: current ? `Continues the day after the current membership ends (${current.end_date})` : null,
    },
    { name: 'discount', label: 'Discount', type: 'number', value: 0, min: 0, step: '0.01' },
    { name: 'payment_amount', label: 'Amount collected now', type: 'number', min: 0, step: '0.01', value: plans[0].price },
    {
      name: 'payment_method',
      label: 'Payment method',
      type: 'select',
      value: 'cash',
      options: ['cash', 'card', 'upi', 'bank', 'online'].map((v) => ({ value: v, label: v.toUpperCase() })),
    },
    { name: 'note', label: 'Note', full: true },
  ];

  const form = buildForm(fields, {
    submitLabel: 'Create membership',
    onSubmit: async (values) => {
      const memberId = member?.id ?? resolveMember(options, values.member);
      if (!memberId) {
        toast('Pick a member from the list', 'error');
        return;
      }
      const plan = plans.find((p) => String(p.id) === String(values.plan_id));
      await api.createSubscription({
        member_id: memberId,
        plan_id: values.plan_id,
        start_date: values.start_date || undefined,
        discount: values.discount || 0,
        payment_amount: values.payment_amount || undefined,
        payment_method: values.payment_method,
        note: values.note || undefined,
      });
      closeModal();
      toast(`${plan.name} activated`);
      await onSaved?.();
    },
  });

  // Keep the suggested collection amount in step with the chosen plan.
  const planSelect = form.querySelector('[name=plan_id]');
  const amountInput = form.querySelector('[name=payment_amount]');
  const discountInput = form.querySelector('[name=discount]');
  const syncAmount = () => {
    const plan = plans.find((p) => String(p.id) === planSelect.value);
    if (plan) amountInput.value = Math.max(plan.price - Number(discountInput.value || 0), 0);
  };
  planSelect.addEventListener('change', syncAmount);
  discountInput.addEventListener('input', syncAmount);

  openModal({
    title: member ? `New membership for ${member.first_name}` : 'Sell a membership',
    wide: true,
    body: h('div', {}, options.length ? datalist('member-options', options) : null, form),
  });
}

/* --------------------------------------------------------- record payment */

export async function openPaymentForm({ member, subscriptions = [], onSaved }) {
  const options = member ? [] : await memberOptions();
  const dueSubs = subscriptions.filter((s) => s.status !== 'cancelled');

  const form = buildForm(
    [
      member
        ? null
        : {
            name: 'member',
            label: 'Member',
            required: true,
            full: true,
            list: 'member-options',
            placeholder: 'Search by code or name',
          },
      { name: 'amount', label: 'Amount', type: 'number', required: true, min: 0.01, step: '0.01' },
      {
        name: 'method',
        label: 'Method',
        type: 'select',
        value: 'cash',
        options: ['cash', 'card', 'upi', 'bank', 'online'].map((v) => ({ value: v, label: v.toUpperCase() })),
      },
      { name: 'paid_on', label: 'Paid on', type: 'date', value: today() },
      dueSubs.length
        ? {
            name: 'subscription_id',
            label: 'Against membership',
            type: 'select',
            value: dueSubs[0].id,
            options: [
              { value: '', label: 'Not linked' },
              ...dueSubs.map((s) => ({
                value: s.id,
                label: `${s.plan_name} (${s.start_date} → ${s.end_date})`,
              })),
            ],
          }
        : null,
      { name: 'reference', label: 'Reference / receipt no.' },
      { name: 'note', label: 'Note', full: true },
    ],
    {
      submitLabel: 'Record payment',
      onSubmit: async (values) => {
        const memberId = member?.id ?? resolveMember(options, values.member);
        if (!memberId) {
          toast('Pick a member from the list', 'error');
          return;
        }
        await api.createPayment({
          member_id: memberId,
          amount: values.amount,
          method: values.method,
          paid_on: values.paid_on,
          subscription_id: values.subscription_id || undefined,
          reference: values.reference || undefined,
          note: values.note || undefined,
        });
        closeModal();
        toast(`${money(values.amount)} recorded`);
        await onSaved?.();
      },
    },
  );

  openModal({
    title: member ? `Payment from ${member.first_name}` : 'Record a payment',
    body: h('div', {}, options.length ? datalist('member-options', options) : null, form),
  });
}

/* ------------------------------------------------------------ book a class */

export async function openBookingForm({ klass, classes = [], date: preset, onSaved }) {
  const options = await memberOptions();
  const list = klass ? [klass] : classes;

  const form = buildForm(
    [
      {
        name: 'member',
        label: 'Member',
        required: true,
        full: true,
        list: 'member-options',
        placeholder: 'Search by code or name',
      },
      {
        name: 'class_id',
        label: 'Class',
        type: 'select',
        required: true,
        value: klass?.id,
        options: list.map((c) => ({ value: c.id, label: `${c.name} — ${c.weekday_name} ${c.start_time}` })),
      },
      { name: 'class_date', label: 'Date', type: 'date', required: true, value: preset || klass?.class_date || today() },
    ],
    {
      submitLabel: 'Book seat',
      onSubmit: async (values) => {
        const memberId = resolveMember(options, values.member);
        if (!memberId) {
          toast('Pick a member from the list', 'error');
          return;
        }
        await api.createBooking({
          member_id: memberId,
          class_id: values.class_id,
          class_date: values.class_date,
        });
        closeModal();
        toast('Seat booked');
        await onSaved?.();
      },
    },
  );

  openModal({ title: 'Book a class', body: h('div', {}, datalist('member-options', options), form) });
}
