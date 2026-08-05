import { api, session } from '../api.js';
import { buildForm, closeModal, date, h, openModal, table, toast } from '../ui.js';

const ROLES = [
  { value: 'admin', label: 'Admin — full access' },
  { value: 'manager', label: 'Manager — billing and operations' },
  { value: 'trainer', label: 'Trainer — classes and members' },
  { value: 'staff', label: 'Front desk — check-ins and members' },
];

function openStaffForm({ person, onSaved }) {
  const editing = Boolean(person);
  openModal({
    title: editing ? `Edit ${person.name}` : 'Add a staff account',
    body: buildForm(
      [
        { name: 'name', label: 'Name', required: true, value: person?.name },
        { name: 'email', label: 'Email', type: 'email', required: true, value: person?.email },
        { name: 'phone', label: 'Phone', value: person?.phone },
        { name: 'role', label: 'Role', type: 'select', value: person?.role || 'staff', options: ROLES },
        {
          name: 'password',
          label: editing ? 'New password' : 'Password',
          type: 'password',
          required: !editing,
          hint: editing ? 'Leave blank to keep the current password' : 'At least 8 characters',
        },
        editing
          ? {
              name: 'active',
              label: 'Account status',
              type: 'select',
              value: String(person.active),
              options: [
                { value: '1', label: 'Active' },
                { value: '0', label: 'Disabled' },
              ],
            }
          : null,
      ],
      {
        submitLabel: editing ? 'Save' : 'Create account',
        onSubmit: async (values) => {
          const payload = { ...values };
          if (!payload.password) delete payload.password;
          if (editing) await api.updateStaff(person.id, payload);
          else await api.createStaff(payload);
          closeModal();
          toast(editing ? 'Staff account updated' : 'Staff account created');
          await onSaved?.();
        },
      },
    ),
  });
}

export async function renderStaff({ setActions, reload }) {
  const [{ items }, { items: classes }] = await Promise.all([api.staff({}), api.classes({})]);
  const isAdmin = session.can('admin');

  if (isAdmin) {
    setActions(h('button', { class: 'btn primary', onclick: () => openStaffForm({ onSaved: reload }) }, '＋ Add staff'));
  }

  const classesByTrainer = classes.reduce((acc, klass) => {
    if (klass.trainer_id) acc[klass.trainer_id] = (acc[klass.trainer_id] || 0) + 1;
    return acc;
  }, {});

  return h(
    'div',
    { class: 'grid', style: 'gap:16px' },
    h(
      'div',
      { class: 'card', style: 'padding:6px 6px 14px' },
      table(
        [
          { label: 'Name', render: (row) => h('div', {}, h('div', { style: 'font-weight:600' }, row.name), h('div', { class: 'muted', style: 'font-size:12px' }, row.email)) },
          { label: 'Role', render: (row) => h('span', { class: 'badge violet', style: 'text-transform:capitalize' }, row.role) },
          { label: 'Phone', render: (row) => row.phone || '—' },
          { label: 'Classes', align: 'right', render: (row) => classesByTrainer[row.id] || 0 },
          { label: 'Joined', render: (row) => date(row.created_at) },
          { label: 'Status', render: (row) => (row.active ? h('span', { class: 'badge green' }, 'Active') : h('span', { class: 'badge grey' }, 'Disabled')) },
          {
            label: '',
            render: (row) =>
              isAdmin ? h('button', { class: 'btn sm', onclick: () => openStaffForm({ person: row, onSaved: reload }) }, 'Edit') : null,
          },
        ],
        items,
        { empty: 'No staff accounts' },
      ),
    ),
    !isAdmin
      ? h('div', { class: 'card muted', style: 'font-size:13px' }, 'Only admins can add or edit staff accounts.')
      : null,
  );
}
