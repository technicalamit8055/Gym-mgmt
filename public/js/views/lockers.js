import { api, session } from '../api.js';
import { addDays, buildForm, closeModal, confirmDialog, h, money, openModal, stat, table, toast, today } from '../ui.js';
import { datalist, memberOptions, resolveMember } from './forms.js';

function openLockerForm({ locker, onSaved }) {
  const editing = Boolean(locker);
  openModal({
    title: editing ? `Edit locker ${locker.code}` : 'Add a locker',
    body: buildForm(
      [
        { name: 'code', label: 'Code', required: true, value: locker?.code },
        { name: 'monthly_fee', label: 'Monthly fee', type: 'number', min: 0, step: '0.01', value: locker?.monthly_fee ?? 0 },
        {
          name: 'status',
          label: 'Status',
          type: 'select',
          value: locker?.status || 'available',
          options: ['available', 'maintenance', 'retired'].map((v) => ({ value: v, label: v })),
        },
      ],
      {
        submitLabel: editing ? 'Save' : 'Add locker',
        onSubmit: async (values) => {
          if (editing) await api.updateLocker(locker.id, values);
          else await api.createLocker(values);
          closeModal();
          toast(editing ? 'Locker updated' : 'Locker added');
          await onSaved?.();
        },
      },
    ),
  });
}

async function openLockerAllocateForm({ locker, onSaved }) {
  const options = await memberOptions();
  const form = buildForm(
    [
      { name: 'member', label: 'Student', required: true, full: true, list: 'member-options', placeholder: 'Search by code or name' },
      { name: 'start_date', label: 'Starts on', type: 'date', value: today() },
      { name: 'end_date', label: 'Holds until', type: 'date', value: addDays(today(), 30) },
      { name: 'fee', label: 'Fee', type: 'number', min: 0, step: '0.01', value: locker.monthly_fee || 0 },
      { name: 'deposit', label: 'Deposit', type: 'number', min: 0, step: '0.01', value: 0 },
    ],
    {
      submitLabel: `Assign ${locker.code}`,
      onSubmit: async (values) => {
        const memberId = resolveMember(options, values.member);
        if (!memberId) {
          toast('Pick a student from the list', 'error');
          return;
        }
        await api.allocateLocker(locker.id, {
          member_id: memberId,
          start_date: values.start_date || today(),
          end_date: values.end_date,
          fee: values.fee || 0,
          deposit: values.deposit || 0,
        });
        closeModal();
        toast(`${locker.code} assigned`);
        await onSaved?.();
      },
    },
  );

  openModal({ title: `Assign locker ${locker.code}`, body: h('div', {}, datalist('member-options', options), form) });
}

export async function renderLockers({ reload }) {
  const { items, totals } = await api.lockers({});
  const canManage = session.managesBilling;

  return h(
    'div',
    { class: 'grid', style: 'gap:16px' },
    h(
      'div',
      { class: 'grid cols-4' },
      stat('Lockers', totals.total),
      stat('Occupied', totals.occupied),
      stat('Available', totals.available),
      canManage
        ? h(
            'div',
            { class: 'card', style: 'display:flex;align-items:center;justify-content:center' },
            h('button', { class: 'btn primary', onclick: () => openLockerForm({ onSaved: reload }) }, '＋ Add locker'),
          )
        : h('div', {}),
    ),
    h(
      'div',
      { class: 'card', style: 'padding:6px 6px 14px' },
      table(
        [
          { label: 'Locker', render: (row) => h('div', { style: 'font-weight:600' }, row.code) },
          { label: 'Zone', render: (row) => row.zone_name || '—' },
          {
            label: 'Held by',
            render: (row) =>
              row.allocation_id
                ? h('div', {}, h('div', {}, `${row.first_name} ${row.last_name}`), h('div', { class: 'muted', style: 'font-size:12px' }, row.member_code))
                : h('span', { class: 'muted' }, 'Vacant'),
          },
          { label: 'Until', render: (row) => row.held_until || '—' },
          { label: 'Fee', align: 'right', render: (row) => (row.fee ? money(row.fee) : row.monthly_fee ? money(row.monthly_fee) : '—') },
          { label: 'Status', render: (row) => h('span', { class: `badge ${row.status === 'available' ? 'green' : 'grey'}` }, row.status) },
          {
            label: '',
            render: (row) =>
              canManage
                ? h(
                    'div',
                    { class: 'row', style: 'gap:6px' },
                    row.allocation_id
                      ? h(
                          'button',
                          {
                            class: 'btn sm',
                            onclick: () =>
                              confirmDialog({
                                title: `Release locker ${row.code}?`,
                                message: `${row.first_name} will lose this locker.`,
                                confirmLabel: 'Release',
                                onConfirm: async () => {
                                  await api.releaseLocker(row.id);
                                  toast(`${row.code} released`);
                                  await reload();
                                },
                              }),
                          },
                          'Release',
                        )
                      : row.status === 'available'
                        ? h('button', { class: 'btn sm', onclick: () => openLockerAllocateForm({ locker: row, onSaved: reload }) }, 'Assign')
                        : null,
                    h('button', { class: 'btn sm', onclick: () => openLockerForm({ locker: row, onSaved: reload }) }, 'Edit'),
                    h(
                      'button',
                      {
                        class: 'btn sm danger',
                        onclick: () =>
                          confirmDialog({
                            title: `Remove locker ${row.code}?`,
                            message: 'A locker with allocation history is retired rather than deleted.',
                            confirmLabel: 'Remove',
                            danger: true,
                            onConfirm: async () => {
                              await api.deleteLocker(row.id);
                              toast(`${row.code} removed`);
                              await reload();
                            },
                          }),
                      },
                      'Remove',
                    ),
                  )
                : null,
          },
        ],
        items,
        { empty: 'No lockers set up yet' },
      ),
    ),
  );
}
