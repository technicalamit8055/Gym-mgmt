import { api, gymPathUrl, platformSession } from '../api.js';
import { buildForm, clear, closeModal, date, h, openModal, relativeDays, stat, table, toast } from '../ui.js';

/**
 * Operator console — the view for whoever runs the platform, listing every
 * gym on it.
 *
 * Signed in with its own credentials (PLATFORM_ADMIN_EMAIL/PASSWORD) and its
 * own token, entirely separate from any gym's staff login. A gym admin cannot
 * reach this no matter how privileged they are inside their own gym.
 */

const STATUS_TONE = { active: 'green', trial: 'blue', suspended: 'red', cancelled: 'grey' };
const STATUSES = [
  { value: 'active', label: 'Active — paid, full access' },
  { value: 'trial', label: 'Trial — full access until the end date' },
  { value: 'suspended', label: 'Suspended — can sign in and pay, nothing else' },
  { value: 'cancelled', label: 'Cancelled — hard block on everything' },
];

function loginCard(rerender) {
  const form = buildForm(
    [
      { name: 'email', label: 'Operator email', type: 'email', required: true, full: true },
      { name: 'password', label: 'Password', type: 'password', required: true, full: true },
    ],
    {
      submitLabel: 'Sign in',
      onSubmit: async (values) => {
        const { token } = await api.platformLogin(values.email, values.password);
        platformSession.save(token);
        await rerender();
      },
    },
  );
  form.querySelector('.modal-foot').remove();
  form.append(h('button', { class: 'btn primary block', type: 'submit' }, 'Sign in'));

  return h(
    'div',
    { class: 'login' },
    h(
      'div',
      { class: 'login-card' },
      h('h1', {}, '🛠️ Operator console'),
      h('p', { class: 'sub' }, 'Platform-wide access to every gym on this deployment.'),
      form,
      h(
        'div',
        { class: 'row', style: 'margin-top:16px;justify-content:center' },
        h('a', { class: 'btn sm ghost', href: '#/' }, '← Back to the site'),
      ),
    ),
  );
}

function openStatusModal(tenant, onSaved) {
  openModal({
    title: `${tenant.gym_name} — change status`,
    body: buildForm(
      [
        { name: 'status', label: 'Status', type: 'select', value: tenant.status, options: STATUSES, full: true },
        {
          name: 'trial_ends_on',
          label: 'Trial ends on',
          type: 'date',
          value: tenant.trial_ends_on || '',
          full: true,
          hint: 'Only used when the status is Trial. Set a future date to grant an extension.',
        },
        { name: 'reason', label: 'Reason', full: true, hint: 'Recorded against the gym for your own reference.' },
      ],
      {
        submitLabel: 'Apply',
        onSubmit: async (values) => {
          const payload = { status: values.status };
          if (values.trial_ends_on) payload.trial_ends_on = values.trial_ends_on;
          if (values.reason) payload.reason = values.reason;
          await api.platformSetStatus(tenant.slug, payload);
          closeModal();
          toast(`${tenant.gym_name} is now ${values.status}`);
          await onSaved();
        },
      },
    ),
  });
}

/**
 * Issues a reset link for a gym whose owner is locked out, and shows it for the
 * operator to copy.
 *
 * The link is displayed rather than sent: this app has no mail transport, and
 * the operator is already talking to the owner over whatever channel brought
 * them the support request.
 */
function openPasswordResetModal(tenant) {
  const email = h('input', {
    class: 'input',
    type: 'email',
    placeholder: "leave blank for the gym's owner",
    autocomplete: 'off',
  });
  const result = h('div', { style: 'display:none;margin-top:12px' });
  const issue = h('button', { class: 'btn primary' }, 'Issue reset link');

  issue.onclick = async () => {
    issue.disabled = true;
    try {
      const payload = email.value.trim() ? { email: email.value.trim() } : {};
      const reset = await api.platformIssuePasswordReset(tenant.slug, payload);

      const link = h('input', { class: 'input', value: reset.url, readonly: true });
      link.onclick = () => link.select();

      result.style.display = '';
      clear(result).append(
        h('p', { class: 'sub' }, `One-time link for ${reset.email} — valid ${reset.expires_in_minutes} minutes.`),
        link,
        h(
          'div',
          { class: 'row', style: 'gap:6px;margin-top:8px' },
          h(
            'button',
            {
              class: 'btn sm',
              onclick: async () => {
                try {
                  await navigator.clipboard.writeText(reset.url);
                  toast('Link copied');
                } catch {
                  link.select();
                  toast('Select and copy the link above', 'info');
                }
              },
            },
            'Copy link',
          ),
        ),
        h(
          'p',
          { class: 'muted', style: 'font-size:12px;margin-top:8px' },
          'Send it over a channel you already trust. It works once, then stops.',
        ),
      );
      toast('Reset link issued');
    } catch (err) {
      toast(err.message || 'Could not issue a reset link', 'error');
    } finally {
      issue.disabled = false;
    }
  };

  openModal({
    title: `${tenant.gym_name} — password reset`,
    body: h(
      'div',
      {},
      h(
        'p',
        { class: 'sub' },
        'For an owner who has lost their password. Nothing is emailed — you get a link to pass on.',
      ),
      h('label', { class: 'field full' }, h('span', {}, 'Staff email (optional)'), email),
      result,
    ),
    footer: [h('button', { class: 'btn ghost', onclick: closeModal }, 'Close'), issue],
  });
}

function trialCell(tenant) {
  if (!tenant.trial_ends_on) return h('span', { class: 'muted' }, '—');
  const days = relativeDays(tenant.trial_ends_on);
  if (tenant.status !== 'trial') return h('span', { class: 'muted' }, date(tenant.trial_ends_on));
  if (days < 0) return h('span', { class: 'badge red' }, `Lapsed ${Math.abs(days)}d ago`);
  if (days === 0) return h('span', { class: 'badge amber' }, 'Ends today');
  return h('span', { class: `badge ${days <= 2 ? 'amber' : 'blue'}` }, `${days}d left`);
}

export async function renderPlatformConsole({ context, rerender }) {
  if (!context.platform_admin) {
    return h(
      'div',
      { class: 'onboard' },
      h(
        'div',
        { class: 'onboard-card' },
        h('h1', {}, 'Console not enabled'),
        h(
          'p',
          { class: 'sub' },
          'Set PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD and restart the server to enable the operator console.',
        ),
        h('a', { class: 'btn ghost', href: '#/' }, '← Back to the site'),
      ),
    );
  }

  if (!platformSession.token) return loginCard(rerender);

  let data;
  try {
    data = await api.platformTenants({ stats: 1 });
  } catch (err) {
    // 401 here means the operator's own token lapsed — no gym session to
    // clear, so just drop back to the console's login card.
    if (err.status === 401 || err.status === 403) {
      platformSession.clear();
      return loginCard(rerender);
    }
    throw err;
  }

  const counts = data.items.reduce((acc, tenant) => {
    acc[tenant.status] = (acc[tenant.status] || 0) + 1;
    return acc;
  }, {});

  const columns = [
    {
      label: 'Gym',
      render: (row) =>
        h(
          'div',
          {},
          h('div', { style: 'font-weight:600' }, row.gym_name),
          h(
            'a',
            { class: 'muted', style: 'font-size:12px', href: gymPathUrl(row.slug) },
            `/g/${row.slug}`,
          ),
        ),
    },
    {
      label: 'Status',
      render: (row) =>
        h(
          'div',
          { class: 'wrap', style: 'gap:6px' },
          h('span', { class: `badge ${STATUS_TONE[row.status] || 'grey'}` }, row.status),
          row.suspended_reason && row.status === 'suspended'
            ? h('span', { class: 'muted', style: 'font-size:12px' }, row.suspended_reason)
            : null,
        ),
    },
    { label: 'Trial', render: trialCell },
    { label: 'Members', align: 'right', render: (row) => (row.stats ? row.stats.members : h('span', { class: 'badge red' }, 'db error')) },
    { label: 'Staff', align: 'right', render: (row) => row.stats?.staff ?? '—' },
    { label: 'Visits 30d', align: 'right', render: (row) => row.stats?.visits_30d ?? '—' },
    { label: 'Currency', render: (row) => row.currency },
    { label: 'Created', render: (row) => h('span', { class: 'muted' }, date(row.created_at)) },
    {
      label: '',
      align: 'right',
      render: (row) =>
        h(
          'div',
          { class: 'row', style: 'gap:6px;justify-content:flex-end' },
          h(
            'button',
            { class: 'btn sm ghost', onclick: () => openStatusModal(row, rerender) },
            'Status',
          ),
          h(
            'button',
            {
              class: 'btn sm ghost',
              title: 'Issue a one-time password reset link for this gym',
              onclick: () => openPasswordResetModal(row),
            },
            'Reset password',
          ),
        ),
    },
  ];

  return h(
    'div',
    { class: 'console' },
    h(
      'header',
      { class: 'landing-top' },
      h('div', { class: 'brand' }, h('div', { class: 'logo' }, '🛠️'), 'Operator console'),
      h('div', { class: 'spacer' }),
      h('a', { class: 'btn sm ghost', href: '#/' }, 'Site'),
      h(
        'button',
        {
          class: 'btn sm ghost',
          onclick: async () => {
            platformSession.clear();
            await rerender();
          },
        },
        'Sign out',
      ),
    ),

    h(
      'div',
      { class: 'console-body' },
      h(
        'div',
        { class: 'grid cols-4', style: 'gap:12px;margin-bottom:16px' },
        stat('Gyms', data.total),
        stat('Active', counts.active || 0, 'Paying', { accent: true }),
        stat('On trial', counts.trial || 0),
        stat('Suspended', counts.suspended || 0, 'Lapsed trial or payment'),
      ),
      h(
        'div',
        { class: 'card', style: 'padding:6px 6px 14px' },
        table(columns, data.items, { empty: 'No gyms have signed up yet' }),
      ),
    ),
  );
}
