import { api, session } from '../api.js';
import { buildForm, confirmDialog, date, h, table, toast } from '../ui.js';

/**
 * WhatsApp automation: pairing, templates, a test send, and the delivery log.
 *
 * Pairing is asynchronous — the QR appears here, the owner scans it on their
 * phone, and the server only learns it worked seconds later. So while a QR is
 * on screen this view polls the status and re-renders itself once the state
 * moves.
 */

/** Strips the modal Cancel button off a form rendered inline on a page. */
function inlineForm(form, submitLabel) {
  form.querySelector('.modal-foot').remove();
  form.append(h('button', { class: 'btn primary', type: 'submit' }, submitLabel));
  return form;
}

/**
 * Re-renders the view when the pairing state changes.
 *
 * Anchored to a node rather than to a module-level timer: the router swaps the
 * page by emptying its container, so `isConnected` going false is exactly the
 * signal that this view is gone and the poll must stop. A module-level handle
 * leaked a timer per visit and reloaded whatever page had replaced this one.
 */
function pollUntilStateChanges(anchor, fromState, reload) {
  const timer = setInterval(async () => {
    if (!anchor.isConnected) return clearInterval(timer);
    try {
      const next = await api.whatsappStatus();
      if (next.state !== fromState) {
        clearInterval(timer);
        if (anchor.isConnected) reload();
      }
    } catch {
      // A transient failure is not worth tearing the poll down for.
    }
  }, 4000);
}

export async function renderWhatsApp({ setActions, reload }) {
  const isAdmin = session.can('admin');

  const [status, settings, logs] = await Promise.all([
    api.whatsappStatus().catch(() => ({ state: 'DISCONNECTED', connected: false, qr: null })),
    api.whatsappSettings().catch(() => ({})),
    api.whatsappLogs({ limit: 30 }).catch(() => ({ items: [] })),
  ]);

  const isConnected = status.connected;
  const hasQr = status.state === 'QR_READY' && Boolean(status.qr);
  const isPairing = status.state === 'QR_READY' || status.state === 'CONNECTING';

  setActions(
    isAdmin
      ? h(
          'div',
          { class: 'row', style: 'gap:8px' },
          h(
            'button',
            {
              class: 'btn sm',
              onclick: async (event) => {
                event.target.disabled = true;
                try {
                  await api.whatsappConnect();
                  toast('Reconnecting to WhatsApp…');
                  reload();
                } catch (err) {
                  toast(err.message || 'Could not reconnect', 'error');
                  event.target.disabled = false;
                }
              },
            },
            isConnected ? '↻ Reconnect' : '↻ Get a QR code',
          ),
          isConnected
            ? h(
                'button',
                {
                  class: 'btn sm danger',
                  onclick: () =>
                    confirmDialog({
                      title: 'Unlink WhatsApp?',
                      message:
                        'Automated receipts and reminders stop until someone scans a new QR code from this gym’s phone.',
                      confirmLabel: 'Unlink',
                      danger: true,
                      onConfirm: async () => {
                        await api.whatsappLogout();
                        toast('WhatsApp unlinked');
                        reload();
                      },
                    }),
                },
                'Unlink',
              )
            : null,
        )
      : null,
  );

  const badge = isConnected
    ? h('span', { class: 'badge green' }, '● Connected')
    : status.state === 'QR_READY'
      ? h('span', { class: 'badge amber' }, 'Waiting for a scan')
      : status.state === 'CONNECTING'
        ? h('span', { class: 'badge blue' }, 'Connecting…')
        : h('span', { class: 'badge grey' }, 'Not connected');

  const connectionCard = h(
    'div',
    { class: 'card' },
    h(
      'div',
      { class: 'card-head' },
      h('h3', {}, 'WhatsApp connection'),
      h('div', { class: 'spacer' }),
      badge,
    ),
    h(
      'p',
      { class: 'muted', style: 'margin:0 0 12px;font-size:13px' },
      'Link this gym’s WhatsApp account to send receipts and renewal reminders at no per-message cost.',
    ),

    hasQr
      ? h(
          'div',
          { style: 'text-align:center;padding:12px' },
          h(
            'p',
            { style: 'font-weight:600;margin:0 0 10px' },
            'On the gym’s phone: WhatsApp → Linked devices → Link a device, then scan this:',
          ),
          h('img', {
            src: status.qr,
            alt: 'WhatsApp pairing QR code',
            style: 'width:220px;height:220px;border:1px solid var(--line);border-radius:8px;background:#fff;padding:8px',
          }),
          h('p', { class: 'muted', style: 'font-size:12px;margin-top:8px' }, 'This page updates itself once you scan.'),
        )
      : null,

    !isConnected && !hasQr
      ? h(
          'p',
          { class: 'muted', style: 'margin:0' },
          status.error ||
            (isAdmin
              ? 'Not linked yet — use “Get a QR code” above, then scan it from the gym’s phone.'
              : 'Not linked yet. An admin needs to scan the QR code from the gym’s phone.'),
        )
      : null,
  );

  if (isPairing) pollUntilStateChanges(connectionCard, status.state, reload);

  const settingsForm = inlineForm(
    buildForm(
      [
        {
          name: 'auto_receipt',
          label: 'Send a receipt automatically when a payment is recorded',
          type: 'select',
          value: String(settings.auto_receipt ?? 1),
          options: [
            { value: '1', label: 'On' },
            { value: '0', label: 'Off' },
          ],
        },
        {
          name: 'send_pdf_receipt',
          label: 'Attach PDF document to payment receipts',
          type: 'select',
          value: String(settings.send_pdf_receipt ?? 1),
          options: [
            { value: '1', label: 'On (Attach PDF Receipt)' },
            { value: '0', label: 'Off (Text message only)' },
          ],
        },
        {
          name: 'auto_reminder',
          label: 'Send renewal reminders automatically',
          type: 'select',
          value: String(settings.auto_reminder ?? 1),
          options: [
            { value: '1', label: 'On' },
            { value: '0', label: 'Off' },
          ],
        },
        {
          name: 'reminder_days_before',
          label: 'Days before expiry to remind',
          type: 'number',
          min: 0,
          max: 60,
          value: settings.reminder_days_before ?? 3,
          hint: 'Members are also reminded on the day their membership ends.',
        },
        {
          name: 'receipt_template',
          label: 'Receipt message',
          type: 'textarea',
          full: true,
          value: settings.receipt_template || '',
          hint: 'Tags: {{first_name}} {{last_name}} {{amount}} {{plan_name}} {{end_date}} {{gym_name}} {{paid_on}} {{method}}',
        },
        {
          name: 'reminder_template',
          label: 'Renewal reminder message',
          type: 'textarea',
          full: true,
          value: settings.reminder_template || '',
          hint: 'Tags: {{first_name}} {{last_name}} {{plan_name}} {{end_date}} {{gym_name}}',
        },
        {
          name: 'welcome_template',
          label: 'Welcome message',
          type: 'textarea',
          full: true,
          value: settings.welcome_template || '',
          hint: 'Tags: {{first_name}} {{last_name}} {{gym_name}}',
        },
      ],
      {
        submitLabel: 'Save',
        onSubmit: async (values) => {
          await api.updateWhatsAppSettings({
            ...values,
            auto_receipt: values.auto_receipt === '1',
            send_pdf_receipt: values.send_pdf_receipt === '1',
            auto_reminder: values.auto_reminder === '1',
            reminder_days_before: Number(values.reminder_days_before),
          });
          toast('WhatsApp settings saved');
          reload();
        },
      },
    ),
    'Save',
  );

  const testForm = inlineForm(
    buildForm(
      [
        { name: 'phone', label: 'Phone number', required: true, placeholder: '9876543210' },
        {
          name: 'message',
          label: 'Message',
          type: 'textarea',
          full: true,
          required: true,
          value: 'Test message from GymBook.',
        },
      ],
      {
        submitLabel: 'Send test',
        onSubmit: async (values) => {
          if (!values.phone.trim() || !values.message.trim()) {
            toast('Enter a phone number and a message', 'error');
            return;
          }
          await api.sendWhatsAppTest(values);
          toast('Test message sent');
          reload();
        },
      },
    ),
    'Send test',
  );

  return h(
    'div',
    { class: 'grid', style: 'gap:16px' },
    connectionCard,

    h(
      'div',
      { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', {}, 'Automation & templates')),
      settingsForm,
    ),

    isAdmin
      ? h(
          'div',
          { class: 'card' },
          h('div', { class: 'card-head' }, h('h3', {}, 'Send a test message')),
          isConnected
            ? testForm
            : h('p', { class: 'muted', style: 'margin:0' }, 'Link WhatsApp above before sending a test.'),
        )
      : null,

    h(
      'div',
      { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', {}, 'Recent messages')),
      table(
        [
          {
            label: 'To',
            render: (row) =>
              h(
                'div',
                {},
                row.first_name
                  ? `${row.first_name} ${row.last_name || ''}`.trim()
                  : h('span', { class: 'muted' }, 'Not a member'),
                h('div', { class: 'muted', style: 'font-size:12px' }, row.phone),
              ),
          },
          {
            label: 'Type',
            render: (row) =>
              h(
                'span',
                { class: `badge ${row.type === 'receipt' ? 'blue' : row.type === 'reminder' ? 'amber' : 'grey'}` },
                row.type,
              ),
          },
          {
            label: 'Message',
            render: (row) =>
              h('div', { style: 'max-width:340px;font-size:12px;white-space:pre-wrap' }, row.message),
          },
          {
            label: 'Status',
            render: (row) =>
              row.status === 'sent'
                ? h('span', { class: 'badge green' }, 'Sent')
                : h(
                    'div',
                    {},
                    h('span', { class: 'badge red' }, 'Failed'),
                    row.error
                      ? h('div', { class: 'muted', style: 'font-size:11px;margin-top:4px;max-width:200px' }, row.error)
                      : null,
                  ),
          },
          { label: 'When', render: (row) => date(row.sent_at, { withTime: true }) },
        ],
        logs.items || [],
        { empty: 'No WhatsApp messages sent yet' },
      ),
    ),
  );
}
