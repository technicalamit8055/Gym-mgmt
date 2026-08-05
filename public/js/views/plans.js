import { api, session } from '../api.js';
import { buildForm, closeModal, confirmDialog, h, money, openModal, table, toast } from '../ui.js';

function openPlanForm({ plan, onSaved }) {
  const editing = Boolean(plan);
  openModal({
    title: editing ? `Edit ${plan.name}` : 'New membership plan',
    body: buildForm(
      [
        { name: 'name', label: 'Plan name', required: true, full: true, value: plan?.name },
        { name: 'price', label: 'Price', type: 'number', required: true, min: 0, step: '0.01', value: plan?.price },
        {
          name: 'duration_days',
          label: 'Duration (days)',
          type: 'number',
          required: true,
          min: 1,
          value: plan?.duration_days ?? 30,
        },
        {
          name: 'sessions',
          label: 'Session limit',
          type: 'number',
          min: 1,
          value: plan?.sessions ?? '',
          hint: 'Leave blank for unlimited access',
        },
        {
          name: 'active',
          label: 'Available for sale',
          type: 'select',
          value: plan ? String(plan.active) : '1',
          options: [
            { value: '1', label: 'Yes' },
            { value: '0', label: 'No — archived' },
          ],
        },
        { name: 'description', label: 'Description', type: 'textarea', full: true, value: plan?.description },
      ],
      {
        submitLabel: editing ? 'Save plan' : 'Create plan',
        onSubmit: async (values) => {
          const payload = { ...values, sessions: values.sessions === '' ? null : values.sessions };
          if (editing) await api.updatePlan(plan.id, payload);
          else await api.createPlan(payload);
          closeModal();
          toast(editing ? 'Plan updated' : 'Plan created');
          await onSaved?.();
        },
      },
    ),
  });
}

export async function renderPlans({ setActions, reload }) {
  const { items } = await api.plans();

  if (session.managesBilling) {
    setActions(h('button', { class: 'btn primary', onclick: () => openPlanForm({ onSaved: reload }) }, '＋ New plan'));
  }

  const cards = h(
    'div',
    { class: 'grid cols-3' },
    ...items.map((plan) =>
      h(
        'div',
        { class: 'card', style: plan.active ? '' : 'opacity:.6' },
        h(
          'div',
          { class: 'row', style: 'justify-content:space-between;align-items:flex-start' },
          h('h3', { style: 'margin:0' }, plan.name),
          plan.active ? h('span', { class: 'badge green' }, 'On sale') : h('span', { class: 'badge grey' }, 'Archived'),
        ),
        h('div', { style: 'font-size:26px;font-weight:700;margin:10px 0 2px' }, money(plan.price)),
        h(
          'div',
          { class: 'muted', style: 'font-size:13px' },
          `${plan.duration_days} days${plan.sessions ? ` · ${plan.sessions} sessions` : ' · unlimited visits'}`,
        ),
        plan.description ? h('p', { class: 'muted', style: 'font-size:13px' }, plan.description) : null,
        h(
          'div',
          { class: 'row', style: 'justify-content:space-between;margin-top:14px' },
          h('span', { class: 'muted', style: 'font-size:13px' }, `${plan.active_members} active member${plan.active_members === 1 ? '' : 's'}`),
          session.managesBilling
            ? h(
                'div',
                { class: 'row', style: 'gap:6px' },
                h('button', { class: 'btn sm', onclick: () => openPlanForm({ plan, onSaved: reload }) }, 'Edit'),
                session.can('admin')
                  ? h(
                      'button',
                      {
                        class: 'btn sm danger',
                        onclick: () =>
                          confirmDialog({
                            title: `Delete ${plan.name}?`,
                            message: 'Plans that have been sold are archived instead of deleted so history stays intact.',
                            confirmLabel: 'Delete plan',
                            danger: true,
                            onConfirm: async () => {
                              const result = await api.deletePlan(plan.id);
                              toast(result.archived ? 'Plan archived — it is still referenced by memberships' : 'Plan deleted');
                              await reload();
                            },
                          }),
                      },
                      'Delete',
                    )
                  : null,
              )
            : null,
        ),
      ),
    ),
  );

  return h(
    'div',
    { class: 'grid', style: 'gap:16px' },
    items.length ? cards : h('div', { class: 'card empty' }, 'No plans yet — create your first membership plan'),
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', {}, 'All plans')),
      table(
        [
          { label: 'Plan', render: (row) => row.name },
          { label: 'Price', align: 'right', render: (row) => money(row.price) },
          { label: 'Duration', align: 'right', render: (row) => `${row.duration_days} days` },
          { label: 'Sessions', align: 'right', render: (row) => row.sessions ?? '∞' },
          { label: 'Active members', align: 'right', render: (row) => row.active_members },
          {
            label: 'Value per day',
            align: 'right',
            render: (row) => money(row.price / row.duration_days),
          },
        ],
        items,
        { empty: 'No plans yet' },
      ),
    ),
  );
}
