import { api, session } from '../api.js';
import { buildForm, closeModal, confirmDialog, date, h, openModal, table, toast } from '../ui.js';

function openDeviceForm({ onSaved }) {
  openModal({
    title: 'Add a fingerprint device',
    body: buildForm(
      [
        {
          name: 'serial',
          label: 'Serial number',
          required: true,
          hint: 'Printed on a label on the back of the unit',
        },
        { name: 'label', label: 'Label', placeholder: 'Front desk' },
      ],
      {
        submitLabel: 'Register device',
        onSubmit: async (values) => {
          await api.createDevice(values);
          closeModal();
          toast('Device registered');
          await onSaved?.();
        },
      },
    ),
  });
}

export async function renderDevices({ setActions, reload }) {
  const { items } = await api.devices();

  if (session.managesBilling) {
    setActions(h('button', { class: 'btn primary', onclick: () => openDeviceForm({ onSaved: reload }) }, '＋ Add device'));
  }

  return h(
    'div',
    { class: 'grid', style: 'gap:16px' },
    h(
      'div',
      { class: 'card muted', style: 'font-size:13px' },
      'Point the device\'s "Cloud Server"/ADMS setting at this app\'s address with ',
      h('code', {}, '/iclock'),
      ' appended (e.g. ',
      h('code', {}, 'https://your-gym-app.example/iclock'),
      '), then set each member\'s "Fingerprint device PIN" on their profile to match the ID you enroll them under on the device.',
    ),
    h(
      'div',
      { class: 'card', style: 'padding:6px 6px 14px' },
      table(
        [
          { label: 'Label', render: (row) => row.label || h('span', { class: 'muted' }, 'Unlabelled') },
          { label: 'Serial number', render: (row) => h('code', {}, row.serial_number) },
          { label: 'Last seen', render: (row) => date(row.last_seen_at, { withTime: true }) },
          { label: 'Registered', render: (row) => date(row.created_at) },
          {
            label: '',
            render: (row) =>
              session.managesBilling
                ? h(
                    'button',
                    {
                      class: 'btn sm danger',
                      onclick: () =>
                        confirmDialog({
                          title: `Remove ${row.label || row.serial_number}?`,
                          message: 'The device will no longer be able to check members in until re-registered.',
                          confirmLabel: 'Remove',
                          danger: true,
                          onConfirm: async () => {
                            await api.deleteDevice(row.serial_number);
                            toast('Device removed');
                            await reload();
                          },
                        }),
                    },
                    'Remove',
                  )
                : null,
          },
        ],
        items,
        { empty: 'No fingerprint devices registered yet' },
      ),
    ),
  );
}
