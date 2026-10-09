import { api, pathPrefix } from '../api.js';
import { fitImage } from '../photo.js';
import { buildForm, clear, confirmDialog, date, h, renderIcon, table, toast } from '../ui.js';
import { isLibrary } from '../vertical.js';

/**
 * Push notifications, from the gym's side: send an announcement to every
 * member's phone, and decide when the automated nudges go out. What members
 * receive and how is in src/notifications.js; members choose which kinds they
 * want from their own Profile tab.
 */

/** Strips the modal Cancel button off a form rendered inline on a page. */
function inlineForm(form, submitLabel) {
  form.querySelector('.modal-foot').remove();
  form.append(h('button', { class: 'btn primary', type: 'submit' }, submitLabel));
  return form;
}

const ON_OFF = [
  { value: '1', label: 'On' },
  { value: '0', label: 'Off' },
];

const KIND_LABELS = {
  general: 'General',
  closure: 'Closure',
  maintenance: 'Maintenance',
  holiday: 'Holiday hours',
  event: 'Event',
};

const KIND_BADGE = { general: 'grey', closure: 'red', maintenance: 'amber', holiday: 'blue', event: 'green' };

/**
 * The optional picture on an announcement: pick, preview, remove. Scaled and
 * compressed in the browser before it is ever sent (fitImage), so a 12 MP
 * phone photo goes out as a ~200 KB JPEG.
 *
 * @returns {{node: HTMLElement, value: () => string|null}}
 */
function imagePicker() {
  let dataUrl = null;
  const input = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', hidden: true });
  const preview = h('div', { style: 'display:flex;align-items:center;gap:12px;flex-wrap:wrap' });

  function paint() {
    clear(preview).append(
      dataUrl
        ? h('img', {
            src: dataUrl,
            alt: 'Announcement picture',
            style: 'max-width:260px;max-height:130px;border-radius:10px;border:1px solid var(--line);object-fit:cover',
          })
        : null,
      h(
        'button',
        { class: 'btn sm', type: 'button', onclick: () => input.click() },
        renderIcon('image', { size: 15 }),
        dataUrl ? 'Change picture' : 'Add a picture',
      ),
      dataUrl
        ? h(
            'button',
            {
              class: 'btn sm ghost',
              type: 'button',
              onclick: () => {
                dataUrl = null;
                paint();
              },
            },
            'Remove',
          )
        : null,
    );
  }

  input.addEventListener('change', async () => {
    const [file] = input.files;
    input.value = '';
    if (!file) return;
    try {
      dataUrl = await fitImage(file);
      paint();
    } catch (err) {
      toast(err.message || 'Could not read that picture', 'error');
    }
  });
  paint();

  return {
    node: h(
      'div',
      { class: 'field full' },
      h('span', {}, 'Picture (optional)'),
      preview,
      input,
      h(
        'div',
        { class: 'muted', style: 'font-size:12px;margin-top:4px' },
        'Shown large under the message on Android and in the member app. A wide picture (about 2:1) fits best. iPhones show the text only.',
      ),
    ),
    value: () => dataUrl,
  };
}

function reachTile(value, label) {
  return h(
    'div',
    { style: 'flex:1;min-width:120px;padding:12px 14px;border:1px solid var(--line);border-radius:12px' },
    h('div', { style: 'font-size:22px;font-weight:800;font-variant-numeric:tabular-nums' }, String(value ?? 0)),
    h('div', { class: 'muted', style: 'font-size:12px' }, label),
  );
}

export async function renderNotifications({ reload }) {
  const [{ settings, reach, fitness }, announcements] = await Promise.all([
    api.pushSettings(),
    api.announcements({ limit: 30 }).catch(() => ({ items: [] })),
  ]);
  const people = isLibrary() ? 'students' : 'members';

  const reachCard = h(
    'div',
    { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', {}, 'Reach')),
    h(
      'p',
      { class: 'muted', style: 'margin:0 0 12px;font-size:13px' },
      `${people[0].toUpperCase()}${people.slice(1)} turn notifications on from the member app’s Profile tab. On iPhone they first need to add the app to their Home Screen (iOS 16.4 or later).`,
    ),
    h(
      'div',
      { class: 'row', style: 'gap:10px;flex-wrap:wrap' },
      reachTile(reach.members, `${people} with notifications on`),
      reachTile(reach.devices, 'devices'),
      reachTile(reach.android, 'Android'),
      reachTile(reach.ios, 'iPhone / iPad'),
      reachTile(reach.current_members, `current ${people}`),
    ),
  );

  const picker = imagePicker();
  const composeForm = inlineForm(
    buildForm(
      [
        { name: 'title', label: 'Title', required: true, placeholder: 'Closed today', full: true },
        {
          name: 'body',
          label: 'Message',
          type: 'textarea',
          required: true,
          full: true,
          placeholder: 'A water pipe burst overnight — we are closed until tomorrow morning. Sorry for the trouble!',
          hint: 'Keep it short — lock screens show the first two lines or so.',
        },
        {
          name: 'kind',
          label: 'Type',
          type: 'select',
          value: 'general',
          options: Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label })),
        },
        {
          name: 'urgent',
          label: 'Priority',
          type: 'select',
          value: '0',
          options: [
            { value: '0', label: 'Normal' },
            { value: '1', label: 'Urgent — reaches everyone, stays on screen' },
          ],
          hint: `Urgent also reaches ${people} who switched announcements off. Use it for closures and emergencies.`,
        },
      ],
      {
        submitLabel: 'Send',
        onSubmit: async (values) => {
          // Checked here rather than left to the server, because the send
          // happens inside the confirm dialog, which can only toast an error —
          // these messages belong under their fields.
          const details = {};
          if (values.title.trim().length < 3) details.title = 'must be at least 3 characters';
          if (values.body.trim().length < 3) details.body = 'must be at least 3 characters';
          if (Object.keys(details).length) throw Object.assign(new Error('Some fields need attention'), { details });

          const urgent = values.urgent === '1';
          confirmDialog({
            title: urgent ? 'Send an urgent announcement?' : 'Send this announcement?',
            message: `“${values.title.trim()}” goes to every current ${isLibrary() ? 'student' : 'member'}’s notification center, and to ${
              urgent ? 'every' : 'each opted-in'
            } phone straight away. It cannot be recalled.`,
            confirmLabel: 'Send',
            danger: urgent,
            onConfirm: async () => {
              const sent = await api.sendAnnouncement({ ...values, urgent, image: picker.value() || undefined });
              toast(`Sent to ${sent.recipients} ${people} · pushing to ${sent.devices} device${sent.devices === 1 ? '' : 's'}`);
              reload();
            },
          });
        },
      },
    ),
    'Send announcement',
  );

  composeForm.querySelector('.form-grid').append(picker.node);

  const scheduleFields = [
    fitness && {
      name: 'water_enabled',
      label: 'Hydration reminders',
      type: 'select',
      options: ON_OFF,
      value: String(settings.water_enabled),
      hint: 'Only sent to members behind their daily water goal at that time.',
    },
    fitness && {
      name: 'water_times',
      label: 'Hydration reminder times',
      value: settings.water_times.split(',').join(', '),
      placeholder: '11:00, 15:00, 19:00',
      hint: '24-hour times, separated by commas.',
    },
    fitness && {
      name: 'nutrition_enabled',
      label: 'Meal tracking reminders',
      type: 'select',
      options: ON_OFF,
      value: String(settings.nutrition_enabled),
      hint: 'Only sent if that meal has not been logged yet.',
    },
    fitness && { name: 'lunch_time', label: 'Lunch reminder at', type: 'time', value: settings.lunch_time },
    fitness && { name: 'dinner_time', label: 'Dinner reminder at', type: 'time', value: settings.dinner_time },
    fitness && {
      name: 'workout_enabled',
      label: 'Unfinished workout nudge',
      type: 'select',
      options: ON_OFF,
      value: String(settings.workout_enabled),
    },
    fitness && {
      name: 'workout_nudge_minutes',
      label: 'Nudge after (minutes)',
      type: 'number',
      min: 30,
      max: 600,
      value: settings.workout_nudge_minutes,
      hint: 'How long a workout can run in the app before the member is asked to finish it.',
    },
    {
      name: 'membership_enabled',
      label: 'Renewal reminders',
      type: 'select',
      options: ON_OFF,
      value: String(settings.membership_enabled),
      hint: 'Sent alongside WhatsApp reminders, to members with the app.',
    },
    {
      name: 'membership_days_before',
      label: 'Days before expiry',
      type: 'number',
      min: 0,
      max: 60,
      value: settings.membership_days_before,
      hint: 'Members are also reminded on the day it ends.',
    },
  ];

  const scheduleForm = inlineForm(
    buildForm(scheduleFields, {
      onSubmit: async (values) => {
        const payload = {};
        for (const [key, value] of Object.entries(values)) {
          if (key.endsWith('_enabled')) payload[key] = value === '1';
          else if (key === 'workout_nudge_minutes' || key === 'membership_days_before') payload[key] = Number(value);
          else payload[key] = value;
        }
        await api.updatePushSettings(payload);
        toast('Notification schedule saved');
        reload();
      },
    }),
    'Save',
  );

  return h(
    'div',
    { class: 'grid', style: 'gap:16px' },
    reachCard,
    h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, 'Send an announcement')), composeForm),
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', {}, 'Automated reminders')),
      h(
        'p',
        { class: 'muted', style: 'margin:0 0 12px;font-size:13px' },
        `Times are your ${isLibrary() ? 'library' : 'gym'}’s local time. Each ${isLibrary() ? 'student' : 'member'} can still switch any of these off for themselves.`,
      ),
      scheduleForm,
    ),
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', {}, 'Recent announcements')),
      table(
        [
          {
            label: 'Announcement',
            render: (row) =>
              h(
                'div',
                { style: 'max-width:360px' },
                row.image_url
                  ? h('img', {
                      src: `${pathPrefix}${row.image_url}`,
                      alt: '',
                      loading: 'lazy',
                      style: 'display:block;width:120px;height:60px;object-fit:cover;border-radius:8px;margin-bottom:6px',
                    })
                  : null,
                h('strong', {}, row.title),
                row.urgent ? h('span', { class: 'badge red', style: 'margin-left:6px' }, 'Urgent') : null,
                h('div', { class: 'muted', style: 'font-size:12px;white-space:pre-wrap;margin-top:2px' }, row.body),
              ),
          },
          { label: 'Type', render: (row) => h('span', { class: `badge ${KIND_BADGE[row.kind] || 'grey'}` }, KIND_LABELS[row.kind] || row.kind) },
          {
            label: 'Reach',
            render: (row) =>
              h(
                'div',
                { style: 'font-size:12px' },
                h('div', {}, `${row.recipients} ${people}`),
                h('div', { class: 'muted' }, `${row.delivered}/${row.devices} devices${row.failed ? ` · ${row.failed} failed` : ''}`),
                h('div', { class: 'muted' }, `${row.read_count} opened`),
              ),
          },
          {
            label: 'Sent',
            render: (row) =>
              h('div', {}, date(row.created_at, { withTime: true }), row.created_by_name ? h('div', { class: 'muted', style: 'font-size:12px' }, row.created_by_name) : null),
          },
        ],
        announcements.items || [],
        { empty: 'No announcements sent yet' },
      ),
    ),
  );
}
