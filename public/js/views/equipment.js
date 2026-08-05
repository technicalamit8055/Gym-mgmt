import { api, session } from '../api.js';
import { buildForm, closeModal, confirmDialog, date, h, money, openModal, statusBadge, table, toast, today } from '../ui.js';

function openEquipmentForm({ item, onSaved }) {
  const editing = Boolean(item);
  openModal({
    title: editing ? `Edit ${item.name}` : 'Add equipment',
    wide: true,
    body: buildForm(
      [
        { name: 'name', label: 'Name', required: true, value: item?.name },
        { name: 'category', label: 'Category', value: item?.category, placeholder: 'Cardio, Machines, Free Weights…' },
        { name: 'serial_no', label: 'Serial number', value: item?.serial_no },
        { name: 'quantity', label: 'Quantity', type: 'number', min: 1, value: item?.quantity ?? 1 },
        { name: 'purchased_on', label: 'Purchased on', type: 'date', value: item?.purchased_on },
        { name: 'cost', label: 'Cost', type: 'number', min: 0, step: '0.01', value: item?.cost },
        {
          name: 'status',
          label: 'Status',
          type: 'select',
          value: item?.status || 'operational',
          options: [
            { value: 'operational', label: 'Operational' },
            { value: 'maintenance', label: 'In maintenance' },
            { value: 'retired', label: 'Retired' },
          ],
        },
        { name: 'last_service_on', label: 'Last serviced', type: 'date', value: item?.last_service_on },
        { name: 'next_service_on', label: 'Next service due', type: 'date', value: item?.next_service_on },
        { name: 'notes', label: 'Notes', type: 'textarea', full: true, value: item?.notes },
      ],
      {
        submitLabel: editing ? 'Save' : 'Add equipment',
        onSubmit: async (values) => {
          if (editing) await api.updateEquipment(item.id, values);
          else await api.createEquipment(values);
          closeModal();
          toast(editing ? 'Equipment updated' : 'Equipment added');
          await onSaved?.();
        },
      },
    ),
  });
}

export async function renderEquipment({ setActions, reload }) {
  const { items } = await api.equipment({});

  if (session.managesBilling) {
    setActions(h('button', { class: 'btn primary', onclick: () => openEquipmentForm({ onSaved: reload }) }, '＋ Add equipment'));
  }

  const counts = items.reduce(
    (acc, item) => {
      acc[item.status] = (acc[item.status] || 0) + 1;
      acc.value += (item.cost || 0) * item.quantity;
      acc.units += item.quantity;
      return acc;
    },
    { value: 0, units: 0 },
  );
  const dueSoon = items.filter((item) => item.next_service_on && item.next_service_on <= addDaysIso(today(), 30));

  return h(
    'div',
    { class: 'grid', style: 'gap:16px' },
    h(
      'div',
      { class: 'grid cols-4' },
      h('div', { class: 'card stat accent' }, h('div', { class: 'label' }, 'Units on the floor'), h('div', { class: 'value' }, counts.units), h('div', { class: 'hint' }, `${items.length} line items`)),
      h('div', { class: 'card stat' }, h('div', { class: 'label' }, 'Asset value'), h('div', { class: 'value' }, money(counts.value, { compact: true }))),
      h('div', { class: 'card stat' }, h('div', { class: 'label' }, 'In maintenance'), h('div', { class: 'value', style: counts.maintenance ? 'color:var(--amber)' : '' }, counts.maintenance || 0)),
      h('div', { class: 'card stat' }, h('div', { class: 'label' }, 'Service due in 30 days'), h('div', { class: 'value' }, dueSoon.length)),
    ),
    h(
      'div',
      { class: 'card', style: 'padding:6px 6px 14px' },
      table(
        [
          { label: 'Equipment', render: (row) => h('div', {}, h('div', { style: 'font-weight:600' }, row.name), h('div', { class: 'muted', style: 'font-size:12px' }, row.serial_no || '')) },
          { label: 'Category', render: (row) => row.category || '—' },
          { label: 'Qty', align: 'right', render: (row) => row.quantity },
          { label: 'Cost', align: 'right', render: (row) => (row.cost ? money(row.cost) : '—') },
          { label: 'Purchased', render: (row) => (row.purchased_on ? date(row.purchased_on) : '—') },
          {
            label: 'Next service',
            render: (row) => {
              if (!row.next_service_on) return h('span', { class: 'muted' }, '—');
              const overdue = row.next_service_on < today();
              return h('span', { class: `badge ${overdue ? 'red' : 'blue'}` }, date(row.next_service_on));
            },
          },
          { label: 'Status', render: (row) => statusBadge(row.status) },
          {
            label: '',
            render: (row) =>
              session.managesBilling
                ? h(
                    'div',
                    { class: 'row', style: 'gap:6px' },
                    h('button', { class: 'btn sm', onclick: () => openEquipmentForm({ item: row, onSaved: reload }) }, 'Edit'),
                    row.status === 'maintenance'
                      ? h(
                          'button',
                          {
                            class: 'btn sm',
                            onclick: async () => {
                              await api.updateEquipment(row.id, {
                                status: 'operational',
                                last_service_on: today(),
                                next_service_on: addDaysIso(today(), 180),
                              });
                              toast(`${row.name} marked serviced`);
                              await reload();
                            },
                          },
                          'Mark serviced',
                        )
                      : h(
                          'button',
                          {
                            class: 'btn sm',
                            onclick: async () => {
                              await api.updateEquipment(row.id, { status: 'maintenance' });
                              toast(`${row.name} sent to maintenance`);
                              await reload();
                            },
                          },
                          'Maintenance',
                        ),
                    h(
                      'button',
                      {
                        class: 'btn sm danger',
                        onclick: () =>
                          confirmDialog({
                            title: `Delete ${row.name}?`,
                            message: 'This removes the equipment record permanently.',
                            confirmLabel: 'Delete',
                            danger: true,
                            onConfirm: async () => {
                              await api.deleteEquipment(row.id);
                              toast('Equipment deleted');
                              await reload();
                            },
                          }),
                      },
                      'Delete',
                    ),
                  )
                : null,
          },
        ],
        items,
        { empty: 'No equipment recorded yet' },
      ),
    ),
  );
}

function addDaysIso(iso, days) {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString('en-CA');
}
