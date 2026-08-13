import { api, gymPathUrl, platformSession } from '../api.js';
import {
  barChart,
  buildForm,
  clear,
  closeModal,
  date,
  h,
  openModal,
  relativeDays,
  stat,
  table,
  toast,
} from '../ui.js';

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

/** Money formatted in a *gym's* own currency, not the operator's. ui.js's
 * money() is bound to the signed-in gym's currency, which the console has no
 * concept of — every row here can be denominated differently. */
function amount(value, currency = 'INR') {
  const n = Number(value || 0);
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: n % 1 === 0 ? 0 : 2,
      notation: Math.abs(n) >= 100_000 ? 'compact' : 'standard',
    }).format(n);
  } catch {
    return `${currency} ${n.toFixed(0)}`;
  }
}

const bytes = (n) => {
  const value = Number(n || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
};

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

/** Edits a gym's identity on its owner's behalf — the support case where a
 * name was typed wrong at signup or a timezone was never set. */
function openEditModal(tenant, onSaved) {
  openModal({
    title: `${tenant.gym_name} — edit details`,
    body: buildForm(
      [
        { name: 'gym_name', label: 'Gym name', value: tenant.gym_name || '', required: true, full: true },
        { name: 'currency', label: 'Currency', value: tenant.currency || 'INR', hint: 'ISO code, e.g. INR, USD, GBP.' },
        {
          name: 'timezone',
          label: 'Timezone',
          value: tenant.timezone || '',
          hint: 'IANA name, e.g. Asia/Kolkata. Blank uses the server’s own.',
        },
      ],
      {
        submitLabel: 'Save changes',
        onSubmit: async (values) => {
          const payload = { gym_name: values.gym_name, currency: values.currency };
          // Sent only when non-blank: the server treats an empty string as
          // "not supplied" and COALESCEs it away, so clearing is a no-op
          // rather than an error.
          if (values.timezone.trim()) payload.timezone = values.timezone.trim();
          await api.platformUpdateTenant(tenant.slug, payload);
          closeModal();
          toast('Gym details updated');
          await onSaved();
        },
      },
    ),
  });
}

/**
 * The mis-selected-at-signup repair. Deliberately not exposed to the owner —
 * the nav, the seeded catalogue and the member-code prefix all follow from
 * this, so it lives only here, behind a confirmation naming exactly what
 * carries over unchanged.
 */
function openBusinessTypeModal(tenant, onSaved) {
  openModal({
    title: `${tenant.gym_name} — change business type`,
    body: buildForm(
      [
        {
          name: 'business_type',
          label: 'Business type',
          type: 'select',
          value: tenant.business_type || 'gym',
          full: true,
          options: [
            { value: 'gym', label: 'Gym' },
            { value: 'library', label: 'Library / study hall' },
          ],
          hint: 'Changes the nav, the seeded catalogue and future member-code numbering. Existing members, plans and history are untouched.',
        },
      ],
      {
        submitLabel: 'Apply',
        onSubmit: async (values) => {
          await api.platformSetBusinessType(tenant.slug, { business_type: values.business_type });
          closeModal();
          toast(`${tenant.gym_name} is now a ${values.business_type === 'library' ? 'library' : 'gym'} account`);
          await onSaved();
        },
      },
    ),
  });
}

/**
 * Permanent deletion, behind a typed confirmation.
 *
 * The server independently refuses anything that is not already cancelled and
 * re-checks the typed slug, so this dialog is a speed bump rather than the
 * actual guard — but it is the speed bump that stops the misclick.
 */
function openDeleteModal(tenant, onDeleted) {
  const confirmInput = h('input', { class: 'input', placeholder: tenant.slug, autocomplete: 'off' });
  const remove = h('button', { class: 'btn danger', disabled: true }, 'Delete permanently');

  confirmInput.addEventListener('input', () => {
    remove.disabled = confirmInput.value.trim() !== tenant.slug;
  });

  remove.onclick = async () => {
    remove.disabled = true;
    try {
      const result = await api.platformDeleteTenant(tenant.slug, { confirm_slug: confirmInput.value.trim() });
      closeModal();
      toast(result.archived_to ? 'Gym deleted — a final snapshot was archived first' : 'Gym deleted');
      await onDeleted();
    } catch (err) {
      toast(err.message || 'Could not delete this gym', 'error');
      remove.disabled = false;
    }
  };

  openModal({
    title: `Delete ${tenant.gym_name}?`,
    body: h(
      'div',
      {},
      h(
        'p',
        { class: 'sub' },
        'This removes the gym from the registry and deletes its database — every member, payment and visit it holds.',
      ),
      tenant.status !== 'cancelled'
        ? h(
            'p',
            { class: 'badge red', style: 'display:block;padding:10px;line-height:1.5' },
            `This gym is ${tenant.status}. Only a cancelled gym can be deleted — change its status first.`,
          )
        : h(
            'p',
            { class: 'muted', style: 'font-size:13px' },
            'A final verified snapshot is written to the backups folder first, and the delete is abandoned if that snapshot cannot be taken.',
          ),
      h(
        'label',
        { class: 'field full' },
        h('span', {}, `Type ${tenant.slug} to confirm`),
        confirmInput,
      ),
    ),
    footer: [h('button', { class: 'btn ghost', onclick: closeModal }, 'Cancel'), remove],
  });
}

/** A labelled row inside the detail modal's definition lists. */
const kv = (label, value) => [h('dt', {}, label), h('dd', {}, value ?? '—')];

/** Opens the per-gym drill-down: who runs it, what it sells, what it earned,
 * and whether its integrations are live. */
async function openDetailModal(row, onChanged) {
  const bodyNode = h('div', {}, h('div', { class: 'empty' }, 'Loading…'));
  openModal({ title: row.gym_name, body: bodyNode, wide: true });

  let data;
  try {
    data = await api.platformTenant(row.slug);
  } catch (err) {
    clear(bodyNode).append(h('div', { class: 'empty' }, err.message || 'Could not load this gym'));
    return;
  }

  const { tenant, stats, detail, devices, whatsapp, url } = data;
  const currency = tenant.currency || 'INR';

  const waTone = whatsapp.connected ? 'green' : whatsapp.has_credentials ? 'amber' : 'grey';
  const waLabel = whatsapp.connected
    ? 'Connected'
    : whatsapp.has_credentials
      ? `Paired but ${whatsapp.state.toLowerCase()}`
      : 'Never linked';

  clear(bodyNode).append(
    h(
      'div',
      { class: 'grid cols-4', style: 'gap:12px;margin-bottom:16px' },
      stat('Active members', stats?.members ?? '—', `${stats?.members_total ?? 0} on the roster`),
      stat('This month', amount(stats?.revenue_month, currency), 'Collected', { accent: true }),
      stat('All time', amount(stats?.revenue_total, currency), 'Collected'),
      stat('Visits 30d', stats?.visits_30d ?? '—'),
    ),

    h(
      'div',
      { class: 'grid cols-2', style: 'gap:16px' },

      h(
        'div',
        { class: 'card' },
        h('div', { class: 'card-head' }, h('h3', {}, 'Account')),
        h(
          'dl',
          { class: 'kv' },
          ...kv('Address', h('a', { href: url, target: '_blank' }, `/g/${tenant.slug}`)),
          ...kv('Status', h('span', { class: `badge ${STATUS_TONE[tenant.status] || 'grey'}` }, tenant.status)),
          ...kv('Signed up', date(tenant.created_at)),
          ...kv('Currency', currency),
          ...kv('Timezone', tenant.timezone || h('span', { class: 'muted' }, 'server default')),
          ...kv('Trial ends', tenant.trial_ends_on ? date(tenant.trial_ends_on) : '—'),
          ...kv(
            'Suspended',
            tenant.suspended_at
              ? `${date(tenant.suspended_at)}${tenant.suspended_reason ? ` — ${tenant.suspended_reason}` : ''}`
              : '—',
          ),
          ...kv('Subscription', tenant.razorpay_subscription_id || h('span', { class: 'muted' }, 'none')),
          ...kv('WhatsApp', h('span', { class: `badge ${waTone}` }, waLabel)),
          ...kv('Devices', devices.length ? devices.map((d) => d.serial_number).join(', ') : '—'),
          ...kv('New members', `${stats?.new_members_month ?? 0} this month`),
          ...kv('Last visit', stats?.last_visit_at ? date(stats.last_visit_at, { withTime: true }) : 'Never'),
        ),
      ),

      h(
        'div',
        { class: 'card' },
        h('div', { class: 'card-head' }, h('h3', {}, `Staff (${detail?.staff?.length ?? 0})`)),
        table(
          [
            { label: 'Name', render: (s) => h('div', {}, s.name, h('div', { class: 'muted', style: 'font-size:12px' }, s.email)) },
            { label: 'Role', render: (s) => h('span', { class: 'badge grey' }, s.role) },
            {
              label: '',
              align: 'right',
              render: (s) => (s.active ? '' : h('span', { class: 'badge red' }, 'disabled')),
            },
          ],
          detail?.staff ?? [],
          { empty: 'No staff accounts' },
        ),
      ),

      h(
        'div',
        { class: 'card' },
        h('div', { class: 'card-head' }, h('h3', {}, 'Recent payments')),
        table(
          [
            { label: 'Member', render: (p) => `${p.first_name} ${p.last_name || ''}`.trim() },
            { label: 'Method', render: (p) => h('span', { class: 'badge grey' }, p.method) },
            { label: 'Date', render: (p) => h('span', { class: 'muted' }, date(p.paid_on)) },
            { label: 'Amount', align: 'right', render: (p) => amount(p.amount, currency) },
          ],
          detail?.recent_payments ?? [],
          { empty: 'No payments recorded' },
        ),
      ),

      h(
        'div',
        { class: 'card' },
        h('div', { class: 'card-head' }, h('h3', {}, 'Plans')),
        table(
          [
            { label: 'Plan', render: (p) => p.name },
            { label: 'Days', align: 'right', render: (p) => p.duration_days },
            {
              label: 'Price',
              align: 'right',
              render: (p) =>
                h('span', {}, amount(p.price, currency), p.active ? null : h('span', { class: 'badge grey' }, ' archived')),
            },
          ],
          detail?.plans ?? [],
          { empty: 'No plans set up' },
        ),
      ),
    ),

    h(
      'div',
      { class: 'row', style: 'gap:8px;margin-top:16px;flex-wrap:wrap' },
      h('button', { class: 'btn sm', onclick: () => { closeModal(); openEditModal(tenant, onChanged); } }, 'Edit details'),
      h('button', { class: 'btn sm ghost', onclick: () => { closeModal(); openStatusModal(tenant, onChanged); } }, 'Change status'),
      h('button', { class: 'btn sm ghost', onclick: () => { closeModal(); openPasswordResetModal(tenant); } }, 'Reset password'),
      h('button', { class: 'btn sm ghost', onclick: () => { closeModal(); openBusinessTypeModal(tenant, onChanged); } }, 'Change type'),
      h('div', { class: 'spacer', style: 'flex:1' }),
      h('button', { class: 'btn sm danger', onclick: () => { closeModal(); openDeleteModal(tenant, onChanged); } }, 'Delete gym'),
    ),
  );
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

/**
 * Backups, run and reviewed from here.
 *
 * Rendered into a node it owns so a run can refresh the list in place — a full
 * console re-render would re-open every gym's database just to show that a
 * backup finished.
 */
function backupCard() {
  const listNode = h('div', {}, h('div', { class: 'empty' }, 'Loading…'));
  const meta = h('div', { class: 'muted', style: 'font-size:12px' });
  const run = h('button', { class: 'btn sm primary' }, '↻ Back up now');

  const load = async () => {
    try {
      const data = await api.platformBackups();
      meta.textContent = `Every ${data.interval_hours || 0}h · keeping ${data.keep} · ${
        data.offsite ? 'off-site copy configured' : 'this machine only'
      }`;
      clear(listNode).append(
        table(
          [
            { label: 'Taken', render: (b) => date(b.taken_at, { withTime: true }) },
            { label: 'Databases', align: 'right', render: (b) => b.databases },
            { label: 'Size', align: 'right', render: (b) => bytes(b.bytes) },
          ],
          data.items,
          { empty: 'No backups taken yet' },
        ),
      );
    } catch (err) {
      clear(listNode).append(h('div', { class: 'empty' }, err.message || 'Could not load backups'));
    }
  };

  run.onclick = async () => {
    run.disabled = true;
    run.textContent = 'Backing up…';
    try {
      const summary = await api.platformRunBackup();
      if (summary.errors?.length) {
        toast(`Backup finished with ${summary.errors.length} problem(s): ${summary.errors[0]}`, 'error');
      } else {
        toast(
          `Backed up ${summary.databases} database(s)${summary.uploaded ? `, ${summary.uploaded} uploaded off-site` : ''}`,
        );
      }
      await load();
    } catch (err) {
      toast(err.message || 'Backup failed', 'error');
    } finally {
      run.disabled = false;
      run.textContent = '↻ Back up now';
    }
  };

  load();

  return h(
    'div',
    { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', {}, 'Backups'), h('div', { class: 'spacer' }), run),
    meta,
    h('div', { style: 'margin-top:10px' }, listNode),
  );
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
  let analytics;
  try {
    [data, analytics] = await Promise.all([
      api.platformTenants({ stats: 1 }),
      // Registry-only, so this costs nothing beyond the call itself.
      api.platformAnalytics().catch(() => null),
    ]);
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

  // Rolled up from the rows already fetched rather than a second server pass.
  // Bucketed by currency because summing gyms billed in different ones would
  // produce a number that means nothing.
  const revenueByCurrency = {};
  let totalMembers = 0;
  for (const row of data.items) {
    if (!row.stats) continue;
    const code = row.currency || 'INR';
    revenueByCurrency[code] = (revenueByCurrency[code] || 0) + row.stats.revenue_month;
    totalMembers += row.stats.members;
  }
  const revenueLabel = Object.keys(revenueByCurrency).length
    ? Object.entries(revenueByCurrency)
        .map(([code, value]) => amount(value, code))
        .join(' + ')
    : amount(0);

  const state = { q: '', status: '', businessType: '', sort: 'created:desc' };
  const tableNode = h('div', {});

  const SORTS = {
    'created:desc': (a, b) => String(b.created_at).localeCompare(String(a.created_at)),
    'created:asc': (a, b) => String(a.created_at).localeCompare(String(b.created_at)),
    'name:asc': (a, b) => a.gym_name.localeCompare(b.gym_name),
    'members:desc': (a, b) => (b.stats?.members ?? -1) - (a.stats?.members ?? -1),
    'revenue:desc': (a, b) => (b.stats?.revenue_month ?? -1) - (a.stats?.revenue_month ?? -1),
    'visits:desc': (a, b) => (b.stats?.visits_30d ?? -1) - (a.stats?.visits_30d ?? -1),
  };

  const columns = [
    {
      label: 'Gym',
      render: (row) =>
        h(
          'div',
          {},
          h(
            'div',
            { class: 'row', style: 'gap:6px' },
            h('span', { style: 'font-weight:600' }, row.gym_name),
            h('span', { class: `badge ${row.business_type === 'library' ? 'blue' : 'grey'}` }, row.business_type === 'library' ? 'Library' : 'Gym'),
          ),
          h(
            'a',
            {
              class: 'muted',
              style: 'font-size:12px',
              href: gymPathUrl(row.slug),
              onclick: (e) => e.stopPropagation(),
            },
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
    {
      label: 'Members',
      align: 'right',
      render: (row) => (row.stats ? row.stats.members : h('span', { class: 'badge red' }, 'db error')),
    },
    {
      label: 'This month',
      align: 'right',
      render: (row) => (row.stats ? amount(row.stats.revenue_month, row.currency) : '—'),
    },
    { label: 'Visits 30d', align: 'right', render: (row) => row.stats?.visits_30d ?? '—' },
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
            {
              class: 'btn sm ghost',
              onclick: (e) => {
                e.stopPropagation();
                openStatusModal(row, rerender);
              },
            },
            'Status',
          ),
          h(
            'button',
            {
              class: 'btn sm ghost',
              title: 'Issue a one-time password reset link for this gym',
              onclick: (e) => {
                e.stopPropagation();
                openPasswordResetModal(row);
              },
            },
            'Reset password',
          ),
        ),
    },
  ];

  const draw = () => {
    const needle = state.q.toLowerCase();
    const rows = data.items
      .filter((row) => !state.status || row.status === state.status)
      .filter((row) => !state.businessType || row.business_type === state.businessType)
      .filter(
        (row) =>
          !needle ||
          row.gym_name.toLowerCase().includes(needle) ||
          row.slug.toLowerCase().includes(needle),
      )
      .sort(SORTS[state.sort]);

    clear(tableNode).append(
      table(columns, rows, {
        onRowClick: (row) => openDetailModal(row, rerender),
        empty: state.q || state.status || state.businessType ? 'No gym matches that' : 'No gyms have signed up yet',
      }),
    );
    // Appended separately rather than as a `cond ? node : null` argument above:
    // clear() hands back the element, so that .append() is the DOM's own, which
    // renders a null as the literal text "null".
    if (rows.length && rows.length !== data.items.length) {
      tableNode.append(
        h(
          'div',
          { class: 'muted', style: 'font-size:12px;padding:10px 12px 0' },
          `${rows.length} of ${data.items.length} gyms`,
        ),
      );
    }
  };

  const search = h('input', {
    class: 'search',
    type: 'search',
    placeholder: 'Search by gym name or address…',
  });
  search.addEventListener('input', () => {
    state.q = search.value.trim();
    draw();
  });

  const statusFilter = h(
    'select',
    {
      onchange: (e) => {
        state.status = e.target.value;
        draw();
      },
    },
    h('option', { value: '' }, 'Any status'),
    ...['active', 'trial', 'suspended', 'cancelled'].map((s) =>
      h('option', { value: s }, `${s[0].toUpperCase()}${s.slice(1)} (${counts[s] || 0})`),
    ),
  );

  const businessTypeCounts = data.items.reduce((acc, row) => {
    const key = row.business_type || 'gym';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const businessTypeFilter = h(
    'select',
    {
      onchange: (e) => {
        state.businessType = e.target.value;
        draw();
      },
    },
    h('option', { value: '' }, 'Gym + Library'),
    h('option', { value: 'gym' }, `Gym (${businessTypeCounts.gym || 0})`),
    h('option', { value: 'library' }, `Library (${businessTypeCounts.library || 0})`),
  );

  const sortSelect = h(
    'select',
    {
      onchange: (e) => {
        state.sort = e.target.value;
        draw();
      },
    },
    h('option', { value: 'created:desc' }, 'Newest first'),
    h('option', { value: 'created:asc' }, 'Oldest first'),
    h('option', { value: 'name:asc' }, 'Name A–Z'),
    h('option', { value: 'members:desc' }, 'Most members'),
    h('option', { value: 'revenue:desc' }, 'Highest revenue'),
    h('option', { value: 'visits:desc' }, 'Most visits'),
  );

  draw();

  const signups = (analytics?.signups_by_month ?? []).map((point) => ({
    label: point.month.slice(5),
    value: point.count,
  }));

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
        stat('Gyms', data.total, `${counts.trial || 0} on trial`),
        stat('Active', counts.active || 0, 'Paying', { accent: true }),
        stat('Members', totalMembers, 'Active, platform-wide'),
        stat('Collected', revenueLabel, 'This month, across all gyms'),
      ),

      h(
        'div',
        { class: 'grid cols-2', style: 'gap:16px;margin-bottom:16px' },
        h(
          'div',
          { class: 'card' },
          h('div', { class: 'card-head' }, h('h3', {}, 'Signups')),
          signups.length
            ? barChart(signups, { height: 150 })
            : h('div', { class: 'empty' }, 'No signup history yet'),
        ),
        backupCard(),
      ),

      h(
        'div',
        { class: 'toolbar' },
        search,
        statusFilter,
        businessTypeFilter,
        sortSelect,
      ),

      h('div', { class: 'card', style: 'padding:6px 6px 14px' }, tableNode),
    ),
  );
}
