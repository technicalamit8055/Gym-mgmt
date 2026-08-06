import { api, session } from '../api.js';
import { buildForm, closeModal, confirmDialog, h, openModal, table, time, toast } from '../ui.js';

function openSessionForm({ item, onSaved }) {
  const editing = Boolean(item);
  openModal({
    title: editing ? `Edit ${item.name}` : 'Add a gym session',
    body: buildForm(
      [
        { name: 'name', label: 'Name', required: true, value: item?.name, placeholder: 'Morning' },
        { name: 'start_time', label: 'Starts at', type: 'time', required: true, value: item?.start_time },
        { name: 'end_time', label: 'Ends at', type: 'time', required: true, value: item?.end_time },
      ],
      {
        submitLabel: editing ? 'Save' : 'Add session',
        onSubmit: async (values) => {
          if (editing) await api.updateSession(item.id, values);
          else await api.createSession(values);
          closeModal();
          toast(editing ? 'Session updated' : 'Session added');
          await onSaved?.();
        },
      },
    ),
  });
}

export async function renderSessions({ setActions, reload }) {
  const { items } = await api.sessions({});

  if (session.managesBilling) {
    setActions(h('button', { class: 'btn primary', onclick: () => openSessionForm({ onSaved: reload }) }, '＋ Add session'));
  }

  return h(
    'div',
    { class: 'grid', style: 'gap:16px' },
    h(
      'div',
      { class: 'card' },
      h(
        'p',
        { class: 'muted', style: 'font-size:13px;margin:0 0 14px' },
        'Members assigned to a session are checked out automatically once it ends, if they never scan or tap out themselves. Members with no assigned session are only checked out manually.',
      ),
    ),
    h(
      'div',
      { class: 'card', style: 'padding:6px 6px 14px' },
      table(
        [
          { label: 'Name', render: (row) => h('div', { style: 'font-weight:600' }, row.name) },
          { label: 'Starts', render: (row) => time(row.start_time) },
          { label: 'Ends', render: (row) => time(row.end_time) },
          {
            label: '',
            render: (row) =>
              session.managesBilling
                ? h(
                    'div',
                    { class: 'row', style: 'gap:6px' },
                    h('button', { class: 'btn sm', onclick: () => openSessionForm({ item: row, onSaved: reload }) }, 'Edit'),
                    h(
                      'button',
                      {
                        class: 'btn sm danger',
                        onclick: () =>
                          confirmDialog({
                            title: `Delete ${row.name}?`,
                            message: 'Members currently assigned to this session must be reassigned first.',
                            confirmLabel: 'Delete',
                            danger: true,
                            onConfirm: async () => {
                              await api.deleteSession(row.id);
                              toast('Session deleted');
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
        { empty: 'No gym sessions set up yet' },
      ),
    ),
  );
}
