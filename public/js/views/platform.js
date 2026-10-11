import { api, gymPathUrl, platformSession } from '../api.js';
import {
  barChart,
  buildForm,
  clear,
  closeModal,
  confirmDialog,
  date,
  emptyState,
  h,
  openModal,
  relativeDays,
  renderIcon,
  table,
  toast,
} from '../ui.js';
import { getAppMode, toggleAppMode } from '../vertical.js';
import { checkSummary, dnsRecordsTable, domainStatusBadge } from './customDomains.js';
import { renderCatalogSection } from './exerciseCatalog.js';
import { renderFoodCatalogSection } from './foodCatalog.js';
import { renderNavBadgesSection } from './navBadgesAdmin.js';
import { renderStoreAdminSection } from './storeAdmin.js';

/**
 * Operator console — the view for whoever runs the platform, listing every
 * gym on it.
 *
 * Signed in with its own credentials (PLATFORM_ADMIN_EMAIL/PASSWORD) and its
 * own token, entirely separate from any gym's staff login. A gym admin cannot
 * reach this no matter how privileged they are inside their own gym.
 */

const STATUS_TONE = { active: 'green', trial: 'blue', suspended: 'red', cancelled: 'grey' };
const STATUS_LABEL = { active: 'Active', trial: 'Trial', suspended: 'Suspended', cancelled: 'Cancelled' };
const STATUS_ORDER = ['active', 'trial', 'suspended', 'cancelled'];
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

const statusBadge = (status) =>
  h('span', { class: `badge dot ${STATUS_TONE[status] || 'grey'}` }, STATUS_LABEL[status] || status);

/** Two-letter monogram for a gym, tinted by business type, so a long list of
 * names has something to scan down besides text. */
function gymAvatar(row) {
  const letters = String(row.gym_name || row.slug || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join('');
  return h('span', { class: `op-avatar ${row.business_type === 'library' ? 'library' : 'gym'}`, 'aria-hidden': 'true' }, letters);
}

/**
 * A console metric tile: label and a tinted icon on top, the figure, then an
 * optional footer line. Its own markup rather than ui.js's stat() so the tone
 * can follow what the number means (green for paying, blue for trial…)
 * instead of every tile wearing the brand orange.
 */
function kpi(label, value, { icon, tone = 'blue', foot, onClick } = {}) {
  return h(
    onClick ? 'button' : 'div',
    { class: `card op-kpi tone-${tone}${onClick ? ' clickable' : ''}`, type: onClick ? 'button' : null, onclick: onClick || null },
    h(
      'div',
      { class: 'op-kpi-head' },
      h('span', { class: 'op-kpi-label' }, label),
      icon ? h('span', { class: 'op-kpi-icon' }, renderIcon(icon, { size: 17 })) : null,
    ),
    h('div', { class: 'op-kpi-value' }, value),
    foot ? h('div', { class: 'op-kpi-foot' }, foot) : null,
  );
}

/** A card title with its tinted icon tile, as every console card wears it. */
const cardTitle = (icon, text, tone = 'blue') =>
  h('div', { class: `op-card-title tone-${tone}` }, h('span', { class: 'head-icon' }, renderIcon(icon, { size: 17 })), h('h3', {}, text));

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
  form.append(h('button', { class: 'btn primary block lg', type: 'submit' }, renderIcon('key', { size: 17 }), 'Sign in to the console'));

  const mark = () => h('div', { class: 'login-logo-mark' }, renderIcon('wrench', { size: 20 }));
  const point = (icon, text) => h('li', {}, h('span', { class: 'pt-icon' }, renderIcon(icon, { size: 16 })), text);

  // The staff sign-in's split layout, so the console reads as part of the same
  // product rather than a bare debug form.
  return h(
    'div',
    { class: 'auth op-auth' },
    h(
      'aside',
      { class: 'auth-aside' },
      h('div', { class: 'auth-brand' }, mark(), 'Operator console'),
      h(
        'div',
        { class: 'auth-pitch' },
        h('span', { class: 'op-eyebrow' }, renderIcon('shield', { size: 14 }), 'Restricted access'),
        h('h2', {}, 'Every gym on the platform, in one place.'),
        h('p', {}, 'Accounts, trials and billing status, custom domains, backups and the shared libraries every gym draws on.'),
        h(
          'ul',
          { class: 'auth-points' },
          point('building', 'Gym and library accounts at a glance'),
          point('globe', 'Custom domains and DNS health'),
          point('database', 'Backups you can run on demand'),
          point('store', 'Store, add-ons and revenue share'),
        ),
      ),
      h('div', { class: 'auth-foot' }, 'Gym staff sign in at their own address — this console is for the platform operator only.'),
    ),
    h(
      'main',
      { class: 'auth-main' },
      h(
        'div',
        { class: 'auth-card' },
        h('div', { class: 'auth-mobile-brand' }, mark(), 'Operator console'),
        h('h1', {}, 'Welcome back'),
        h('p', { class: 'sub' }, 'Sign in with the operator credentials set on this deployment.'),
        form,
        h(
          'div',
          { class: 'auth-alt' },
          h('a', { href: '#/' }, renderIcon('arrowLeft', { size: 14 }), 'Back to the site'),
        ),
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

/* ── Custom domains ──────────────────────────────────────────────────── */

/** Connects a domain on a gym's behalf — the "can you set it up for us?" case. */
function openAddDomainModal(tenant, onSaved) {
  openModal({
    title: `${tenant.gym_name} — connect a domain`,
    body: buildForm(
      [
        { name: 'hostname', label: 'Domain', required: true, full: true, placeholder: 'app.theirgym.com' },
        {
          name: 'when',
          label: 'Goes live',
          type: 'select',
          value: 'verify',
          full: true,
          options: [
            { value: 'verify', label: 'Once its DNS checks out (recommended)' },
            { value: 'now', label: 'Now — I have confirmed they own it another way' },
          ],
          hint: 'Going live now skips the ownership TXT record. Only do this when you know the domain is theirs.',
        },
      ],
      {
        submitLabel: 'Connect',
        onSubmit: async (values) => {
          const { domain } = await api.platformAddDomain(tenant.slug, {
            hostname: values.hostname,
            activate: values.when === 'now',
          });
          closeModal();
          toast(domain.status === 'active' ? `${domain.hostname} is live` : `${domain.hostname} added — waiting for DNS`);
          await onSaved();
        },
      },
    ),
  });
}

/** Moves a claim to a corrected hostname; it then has to verify again. */
function openEditDomainModal(domain, onSaved) {
  openModal({
    title: `Change ${domain.hostname}`,
    body: buildForm(
      [
        {
          name: 'hostname',
          label: 'Domain',
          value: domain.hostname,
          required: true,
          full: true,
          hint: 'The domain drops back to "Waiting for DNS" and must pass its check again under the new name.',
        },
      ],
      {
        submitLabel: 'Save',
        onSubmit: async (values) => {
          await api.platformUpdateDomain(domain.id, { hostname: values.hostname });
          closeModal();
          toast('Domain updated');
          await onSaved();
        },
      },
    ),
  });
}

/**
 * The operator's controls for one domain, shared by the gym drill-down and the
 * Domains tab. `refresh` redraws in place after a quick action; `onChanged`
 * re-renders the console after the ones that close the current view.
 */
function domainActions(domain, { onChanged, refresh = onChanged }) {
  const act = (label, run, { danger = false } = {}) => {
    const button = h('button', { class: `btn sm ${danger ? 'ghost danger' : 'ghost'}`, type: 'button' }, label);
    button.onclick = async (event) => {
      event.stopPropagation();
      button.disabled = true;
      try {
        await run();
      } catch (err) {
        toast(err.message || 'That did not work', 'error');
      } finally {
        button.disabled = false;
      }
    };
    return button;
  };

  return h(
    'div',
    { class: 'row', style: 'gap:6px;flex-wrap:wrap' },
    act('Check DNS', async () => {
      const { domain: updated, result } = await api.platformCheckDomain(domain.id);
      const failing = result.routing.ok ? result.ownership.message : result.routing.message;
      toast(
        `${updated.hostname}: ${result.ok ? 'all records look right' : failing}`,
        result.ok ? 'success' : 'error',
      );
      await refresh();
    }),
    domain.status === 'active'
      ? act('Take offline', async () => {
        await api.platformUpdateDomain(domain.id, { status: 'pending' });
        toast(`${domain.hostname} no longer routes to the gym`);
        await refresh();
      })
      : act('Force live', async () => {
        await api.platformUpdateDomain(domain.id, { status: 'active' });
        toast(`${domain.hostname} is live`);
        await refresh();
      }),
    act('Change', async () => {
      closeModal();
      openEditDomainModal(domain, onChanged);
    }),
    act(
      'Disconnect',
      async () => {
        closeModal();
        confirmDialog({
          title: `Disconnect ${domain.hostname}?`,
          message: 'Visitors to this address will stop reaching the gym. The gym can connect it again later.',
          confirmLabel: 'Disconnect',
          danger: true,
          onConfirm: async () => {
            await api.platformRemoveDomain(domain.id);
            toast(`${domain.hostname} disconnected`);
            await onChanged();
          },
        });
      },
      { danger: true },
    ),
  );
}

function domainsCard(tenant, domains, setup, { onChanged, refresh }) {
  const add = h(
    'button',
    { class: 'btn sm', type: 'button', onclick: () => { closeModal(); openAddDomainModal(tenant, onChanged); } },
    renderIcon('plus', { size: 15 }),
    'Connect a domain',
  );

  return h(
    'div',
    { class: 'card', style: 'grid-column:1 / -1' },
    h(
      'div',
      { class: 'card-head' },
      cardTitle('globe', `Custom domains (${domains.length})`, 'blue'),
      h('div', { class: 'spacer' }),
      setup.enabled ? add : null,
    ),
    !setup.enabled
      ? h('p', { class: 'muted', style: 'margin:0' }, 'Not enabled on this deployment — set CUSTOM_DOMAIN_TARGET (see docs/CUSTOM_DOMAINS.md).')
      : !domains.length
        ? h('p', { class: 'muted', style: 'margin:0' }, 'This gym has not connected a domain.')
        : null,
    ...domains.map((domain) =>
      h(
        'div',
        { class: 'domain-item' },
        h(
          'div',
          { class: 'domain-item-head' },
          h(
            'div',
            {},
            h('div', { class: 'domain-name' }, domain.hostname),
            h('div', { class: 'muted', style: 'font-size:12px' }, domain.kind === 'apex' ? 'Root domain' : `Subdomain of ${domain.apex}`),
          ),
          domainStatusBadge(domain),
        ),
        dnsRecordsTable(domain),
        checkSummary(domain),
        h('div', { style: 'margin-top:10px' }, domainActions(domain, { onChanged, refresh })),
      ),
    ),
  );
}

/**
 * Every gym's domains in one table: the place to spot the ones stuck waiting
 * on DNS, and to act on any of them without hunting for the gym first.
 */
async function renderDomainsSection(rerender) {
  const data = await api.platformDomains();
  const needle = { q: '' };
  const tableNode = h('div', {});

  const draw = () => {
    const q = needle.q.toLowerCase();
    const rows = data.items.filter(
      (d) => !q || d.hostname.includes(q) || d.tenant_slug.includes(q) || (d.gym_name || '').toLowerCase().includes(q),
    );
    clear(tableNode).append(
      table(
        [
          {
            label: 'Domain',
            render: (d) =>
              h(
                'div',
                {},
                h('a', { href: d.url, target: '_blank', rel: 'noopener', onclick: (e) => e.stopPropagation() }, d.hostname),
                h('div', { class: 'muted', style: 'font-size:12px' }, d.kind === 'apex' ? 'Root domain' : 'Subdomain'),
              ),
          },
          {
            label: 'Gym',
            render: (d) =>
              h('div', {}, d.gym_name || d.tenant_slug, h('div', { class: 'muted', style: 'font-size:12px' }, `/g/${d.tenant_slug}`)),
          },
          { label: 'Status', render: domainStatusBadge },
          {
            label: 'Last check',
            render: (d) =>
              d.last_check
                ? h(
                  'div',
                  { style: 'font-size:13px' },
                  h('span', { class: d.last_check.ok ? 'domain-ok' : 'domain-bad' }, d.last_check.ok ? 'Passing' : 'Failing'),
                  h('div', { class: 'muted', style: 'font-size:12px' }, date(d.last_check.checked_at, { withTime: true })),
                )
                : h('span', { class: 'muted' }, 'Never'),
          },
          { label: '', align: 'right', render: (d) => domainActions(d, { onChanged: rerender }) },
        ],
        rows,
        { empty: needle.q ? 'No domain matches that' : 'No gym has connected a domain yet' },
      ),
    );
  };

  const search = h('input', { class: 'search', type: 'search', placeholder: 'Search by domain or gym…' });
  search.addEventListener('input', () => {
    needle.q = search.value.trim();
    draw();
  });
  draw();

  const active = data.items.filter((d) => d.status === 'active').length;
  return h(
    'div',
    { class: 'op-stack' },
    h(
      'div',
      { class: 'op-kpis' },
      kpi('Connected domains', data.total, { icon: 'globe', tone: 'blue', foot: `${active} live` }),
      kpi('Waiting for DNS', data.total - active, {
        icon: 'hourglass',
        tone: data.total - active ? 'amber' : 'green',
        foot: data.total - active ? 'Not routing yet' : 'Nothing pending',
      }),
      // Hostnames and IPs at tile size wrap mid-word; set them smaller.
      kpi('CNAME target', h('span', { class: 'op-kpi-mono' }, data.cname_target || '—'), {
        icon: 'link',
        tone: 'purple',
        foot: data.enabled ? 'What gyms point at' : 'Not configured',
      }),
      kpi('Root-domain IPs', h('span', { class: 'op-kpi-mono' }, data.apex_ipv4?.length ? data.apex_ipv4.join(', ') : '—'), {
        icon: 'layers',
        tone: 'green',
        foot: 'A records for root domains',
      }),
    ),
    !data.enabled
      ? h(
        'div',
        { class: 'op-callout' },
        renderIcon('info', { size: 18 }),
        h(
          'div',
          {},
          h('strong', {}, 'Custom domains are off on this deployment. '),
          'Set CUSTOM_DOMAIN_TARGET (and CUSTOM_DOMAIN_IPV4 for root domains), put an on-demand-TLS proxy in front, then restart — see docs/CUSTOM_DOMAINS.md.',
        ),
      )
      : null,
    h(
      'div',
      { class: 'card op-table-card' },
      h(
        'div',
        { class: 'op-table-head' },
        cardTitle('globe', 'All domains', 'blue'),
        h('div', { class: 'spacer' }),
        search,
      ),
      tableNode,
    ),
  );
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

const bareUrl = (url) => String(url).replace(/^https?:\/\//, '');

/** Opens the per-gym drill-down: who runs it, what it sells, what it earned,
 * and whether its integrations are live. */
async function openDetailModal(row, onChanged) {
  const bodyNode = h('div', {}, h('div', { class: 'empty' }, 'Loading…'));
  openModal({
    title: row.gym_name,
    subtitle: `${row.business_type === 'library' ? 'Library' : 'Gym'} · /g/${row.slug} · ${STATUS_LABEL[row.status] || row.status}`,
    icon: 'building',
    className: 'op-detail',
    body: bodyNode,
    wide: true,
  });

  // Redrawn in place by the domain actions, so checking DNS keeps this open
  // on the gym instead of dropping the operator back on the list.
  const refresh = async () => {
    await drawDetail(row, bodyNode, { onChanged, refresh });
    onChanged();
  };
  await drawDetail(row, bodyNode, { onChanged, refresh });
}

async function drawDetail(row, bodyNode, { onChanged, refresh }) {
  let data;
  try {
    data = await api.platformTenant(row.slug);
  } catch (err) {
    clear(bodyNode).append(h('div', { class: 'empty' }, err.message || 'Could not load this gym'));
    return;
  }

  const { tenant, stats, detail, devices, whatsapp, url, platform_url: platformUrl, domains, domain_setup: domainSetup } = data;
  const currency = tenant.currency || 'INR';

  const waTone = whatsapp.connected ? 'green' : whatsapp.has_credentials ? 'amber' : 'grey';
  const waLabel = whatsapp.connected
    ? 'Connected'
    : whatsapp.has_credentials
      ? `Paired but ${whatsapp.state.toLowerCase()}`
      : 'Never linked';

  const action = (icon, text, open, extra = '') =>
    h('button', { class: `btn sm ${extra}`, type: 'button', onclick: () => { closeModal(); open(); } }, renderIcon(icon, { size: 15 }), text);

  clear(bodyNode).append(
    h(
      'div',
      { class: 'op-detail-actions' },
      action('edit', 'Edit details', () => openEditModal(tenant, onChanged)),
      action('shield', 'Change status', () => openStatusModal(tenant, onChanged)),
      action('key', 'Reset password', () => openPasswordResetModal(tenant)),
      action('layers', 'Change type', () => openBusinessTypeModal(tenant, onChanged)),
      h('div', { class: 'spacer' }),
      h('a', { class: 'btn sm primary', href: url, target: '_blank', rel: 'noopener' }, 'Open gym', renderIcon('arrowRight', { size: 15 })),
    ),

    h(
      'div',
      { class: 'op-kpis compact' },
      kpi('Active members', stats?.members ?? '—', { icon: 'members', tone: 'purple', foot: `${stats?.members_total ?? 0} on the roster` }),
      kpi('This month', amount(stats?.revenue_month, currency), { icon: 'revenue', tone: 'green', foot: 'Collected' }),
      kpi('All time', amount(stats?.revenue_total, currency), { icon: 'wallet', tone: 'amber', foot: 'Collected' }),
      kpi('Visits', stats?.visits_30d ?? '—', { icon: 'activity', tone: 'blue', foot: 'Last 30 days' }),
    ),

    h(
      'div',
      { class: 'grid cols-2', style: 'gap:16px' },

      h(
        'div',
        { class: 'card' },
        h('div', { class: 'card-head' }, cardTitle('idCard', 'Account', 'blue')),
        h(
          'dl',
          { class: 'kv' },
          ...kv('Address', h('a', { href: url, target: '_blank', rel: 'noopener' }, bareUrl(url))),
          // Only differs once the gym has a live custom domain.
          ...(url !== platformUrl
            ? kv('Platform address', h('a', { href: platformUrl, target: '_blank', rel: 'noopener' }, bareUrl(platformUrl)))
            : []),
          ...kv('Status', statusBadge(tenant.status)),
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
        h('div', { class: 'card-head' }, cardTitle('staff', `Staff (${detail?.staff?.length ?? 0})`, 'purple')),
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
        h('div', { class: 'card-head' }, cardTitle('billing', 'Recent payments', 'green')),
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
        h('div', { class: 'card-head' }, cardTitle('plans', 'Plans', 'amber')),
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

      domainsCard(tenant, domains, domainSetup, { onChanged, refresh }),
    ),

    // Set apart from the everyday actions above, so the one irreversible
    // button is never a neighbour of "Edit details".
    h(
      'div',
      { class: 'op-danger' },
      h(
        'div',
        {},
        h('div', { class: 'op-danger-title' }, 'Delete this gym'),
        h(
          'div',
          { class: 'muted' },
          tenant.status === 'cancelled'
            ? 'Removes it from the registry and deletes its database. A final snapshot is archived first.'
            : 'Only a cancelled gym can be deleted — change its status first.',
        ),
      ),
      h(
        'button',
        { class: 'btn sm danger', type: 'button', onclick: () => { closeModal(); openDeleteModal(tenant, onChanged); } },
        renderIcon('trash', { size: 15 }),
        'Delete gym',
      ),
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

/** The line under a gym's status badge: how long a trial has left, or why a
 * suspended gym was suspended. Null when there is nothing to add. */
function statusNote(tenant) {
  if (tenant.status === 'trial' && tenant.trial_ends_on) {
    const days = relativeDays(tenant.trial_ends_on);
    if (days < 0) return h('div', { class: 'op-status-note op-note-red' }, `Lapsed ${Math.abs(days)}d ago`);
    if (days === 0) return h('div', { class: 'op-status-note op-note-amber' }, 'Ends today');
    return h('div', { class: `op-status-note${days <= 2 ? ' op-note-amber' : ''}`, title: `Ends ${date(tenant.trial_ends_on)}` }, `${days}d left`);
  }
  if (tenant.status === 'suspended' && tenant.suspended_reason) {
    return h('div', { class: 'op-status-note', title: tenant.suspended_reason }, tenant.suspended_reason);
  }
  return null;
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
  const meta = h('div', { class: 'op-pills' });
  const run = h('button', { class: 'btn sm primary' }, renderIcon('refresh', { size: 15 }), 'Back up now');
  const pill = (icon, text) => h('span', { class: 'op-pill' }, renderIcon(icon, { size: 13 }), text);

  const load = async () => {
    try {
      const data = await api.platformBackups();
      clear(meta).append(
        // 0 switches the built-in timer off in favour of an external scheduler.
        pill('history', data.interval_hours ? `Every ${data.interval_hours}h` : 'No built-in schedule'),
        pill('layers', `Keeping ${data.keep}`),
        pill(data.offsite ? 'globe' : 'database', data.offsite ? 'Off-site copy on' : 'This machine only'),
      );
      clear(listNode).append(
        data.items.length
          ? h(
            'div',
            { class: 'op-list' },
            ...data.items.slice(0, 5).map((b, i) =>
              h(
                'div',
                { class: 'op-list-row' },
                h('span', { class: `op-list-icon ${i === 0 ? 'tone-green' : 'tone-blue'}` }, renderIcon(i === 0 ? 'checkCircle' : 'database', { size: 15 })),
                h(
                  'div',
                  { class: 'op-list-main' },
                  h('div', { class: 'op-list-title' }, date(b.taken_at, { withTime: true })),
                  h('div', { class: 'op-list-note' }, `${b.databases} database${b.databases === 1 ? '' : 's'}${i === 0 ? ' · latest' : ''}`),
                ),
                h('span', { class: 'op-list-aside' }, bytes(b.bytes)),
              ),
            ),
          )
          : emptyState('Run one now, or schedule them with BACKUP_INTERVAL_HOURS.', { icon: 'database', title: 'No backups taken yet' }),
      );
    } catch (err) {
      clear(listNode).append(h('div', { class: 'empty' }, err.message || 'Could not load backups'));
    }
  };

  run.onclick = async () => {
    run.disabled = true;
    clear(run).append(renderIcon('refresh', { size: 15, class: 'spin' }), 'Backing up…');
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
      clear(run).append(renderIcon('refresh', { size: 15 }), 'Back up now');
    }
  };

  load();

  return h(
    'div',
    { class: 'card' },
    h('div', { class: 'card-head' }, cardTitle('database', 'Backups', 'green'), h('div', { class: 'spacer' }), run),
    meta,
    h('div', { style: 'margin-top:14px' }, listNode),
  );
}

/**
 * The gyms that want the operator today: trials about to lapse or already
 * lapsed, suspensions, unreadable databases and domains stuck on DNS. Worst
 * first, so the top of the card is always the most urgent thing.
 */
function attentionItems(rows) {
  const items = [];
  for (const row of rows) {
    if (!row.stats) {
      items.push({ row, tone: 'red', icon: 'alert', title: 'Database could not be read', note: 'Stats failed to load — check the server log' });
    }
    if (row.status === 'trial' && row.trial_ends_on) {
      const days = relativeDays(row.trial_ends_on);
      if (days < 0) {
        items.push({ row, tone: 'red', icon: 'hourglass', title: `Trial lapsed ${Math.abs(days)}d ago`, note: 'Extend it or move the gym to active' });
      } else if (days <= 3) {
        items.push({ row, tone: 'amber', icon: 'hourglass', title: days === 0 ? 'Trial ends today' : `Trial ends in ${days}d`, note: `Ends ${date(row.trial_ends_on)}` });
      }
    }
    if (row.status === 'suspended') {
      items.push({ row, tone: 'red', icon: 'ban', title: 'Suspended', note: row.suspended_reason || 'No reason recorded' });
    }
    for (const domain of row.custom_domains ?? []) {
      if (domain.status !== 'active') {
        items.push({ row, tone: 'amber', icon: 'globe', title: `${domain.hostname} waiting for DNS`, note: 'Custom domain is not routing yet' });
      }
    }
  }
  const rank = { red: 0, amber: 1 };
  return items.sort((a, b) => rank[a.tone] - rank[b.tone]);
}

function attentionCard(rows, onOpen) {
  const items = attentionItems(rows);
  const shown = items.slice(0, 6);
  return h(
    'div',
    { class: 'card' },
    h(
      'div',
      { class: 'card-head' },
      cardTitle('bell', 'Needs attention', items.length ? 'amber' : 'green'),
      h('div', { class: 'spacer' }),
      items.length ? h('span', { class: 'badge amber' }, `${items.length} open`) : null,
    ),
    items.length
      ? h(
        'div',
        { class: 'op-list' },
        ...shown.map((item) =>
          h(
            'button',
            { class: 'op-list-row interactive', type: 'button', onclick: () => onOpen(item.row) },
            h('span', { class: `op-list-icon tone-${item.tone}` }, renderIcon(item.icon, { size: 15 })),
            h(
              'div',
              { class: 'op-list-main' },
              h('div', { class: 'op-list-title' }, item.row.gym_name),
              h('div', { class: 'op-list-note' }, h('span', { class: `op-note-${item.tone}` }, item.title), ` · ${item.note}`),
            ),
            renderIcon('chevronRight', { size: 16, class: 'op-list-chevron' }),
          ),
        ),
        items.length > shown.length
          ? h('div', { class: 'op-list-more' }, `+ ${items.length - shown.length} more`)
          : null,
      )
      : emptyState('No lapsing trials, suspensions or stuck domains.', { icon: 'checkCircle', title: 'All clear' }),
  );
}

/** One bar split by status, with a clickable legend that filters the list. */
function statusMixCard(counts, total, onPick) {
  return h(
    'div',
    { class: 'card op-mix' },
    h('div', { class: 'card-head' }, cardTitle('activity', 'Account status', 'purple')),
    h('div', { class: 'op-mix-total' }, h('strong', {}, total), h('span', { class: 'muted' }, total === 1 ? 'account' : 'accounts')),
    h(
      'div',
      { class: 'op-mix-bar', role: 'img', 'aria-label': STATUS_ORDER.map((s) => `${STATUS_LABEL[s]} ${counts[s] || 0}`).join(', ') },
      ...(total
        ? STATUS_ORDER.filter((s) => counts[s]).map((s) =>
          h('span', { class: `op-mix-seg ${STATUS_TONE[s]}`, style: `flex:${counts[s]}`, title: `${STATUS_LABEL[s]}: ${counts[s]}` }),
        )
        : [h('span', { class: 'op-mix-seg empty', style: 'flex:1' })]),
    ),
    h(
      'div',
      { class: 'op-mix-legend' },
      ...STATUS_ORDER.map((s) =>
        h(
          'button',
          { class: 'op-mix-row', type: 'button', title: `Show ${STATUS_LABEL[s].toLowerCase()} accounts`, onclick: () => onPick(s) },
          h('span', { class: `op-mix-dot ${STATUS_TONE[s]}` }),
          h('span', { class: 'op-mix-label' }, STATUS_LABEL[s]),
          h('span', { class: 'op-mix-count' }, counts[s] || 0),
          h('span', { class: 'op-mix-pct' }, total ? `${Math.round(((counts[s] || 0) / total) * 100)}%` : '—'),
        ),
      ),
    ),
  );
}

/** Which page of the console is showing. Module state, so it survives the
 * full re-render every action here triggers. */
let consoleSection = 'gyms';

const SECTIONS = [
  {
    id: 'gyms',
    group: 'Platform',
    icon: 'building',
    label: 'Gyms',
    title: 'Gyms & libraries',
    sub: 'Every account on this deployment — status, trials, members and what they collected.',
  },
  {
    id: 'domains',
    group: 'Platform',
    icon: 'globe',
    label: 'Domains',
    title: 'Custom domains',
    sub: 'Every gym’s connected domains, and whether their DNS checks out.',
  },
  {
    id: 'catalog',
    group: 'Content',
    icon: 'barbell',
    label: 'Exercise library',
    title: 'Exercise library',
    sub: 'The shared catalogue behind every gym’s workout logger.',
  },
  {
    id: 'foods',
    group: 'Content',
    icon: 'apple',
    label: 'Food library',
    title: 'Food library',
    sub: 'The food database every member’s diet tracker searches.',
  },
  {
    id: 'navbadges',
    group: 'Content',
    icon: 'sparkle',
    label: 'Menu badges',
    title: 'Member app menu badges',
    sub: 'Labels like “Offer” or “New” on the bottom tabs of every member’s app.',
  },
  {
    id: 'store',
    group: 'Revenue',
    icon: 'store',
    label: 'Store & monetization',
    title: 'Store & monetization',
    sub: 'The member store, the Diet & Workout add-on and each gym’s revenue share.',
  },
];

/**
 * The console's frame: a sidebar of sections on the left (a sticky strip of
 * tabs on a phone) and a page header naming where you are. Every section
 * renders inside it, so they all share one chrome.
 */
function consoleShell(rerender, body, { actions = [] } = {}) {
  const current = SECTIONS.find((s) => s.id === consoleSection) || SECTIONS[0];

  const go = async (id) => {
    if (id === consoleSection) return;
    consoleSection = id;
    window.scrollTo(0, 0);
    await rerender();
  };

  const signOut = async () => {
    platformSession.clear();
    await rerender();
  };

  // Two copies of the theme switch (sidebar footer, phone header) — each
  // repaints both, so they never disagree about which mode is on.
  const painters = [];
  const modeButton = (compact) => {
    const button = h('button', {
      class: compact ? 'btn sm ghost icon-only' : 'btn sm ghost',
      type: 'button',
      title: 'Switch between light and dark',
    });
    const paint = () => {
      const light = getAppMode() === 'light';
      clear(button).append(renderIcon(light ? 'moon' : 'sun', { size: 15 }));
      if (!compact) button.append(light ? 'Dark' : 'Light');
      button.setAttribute('aria-label', light ? 'Switch to dark mode' : 'Switch to light mode');
    };
    button.onclick = () => {
      toggleAppMode();
      painters.forEach((p) => p());
    };
    painters.push(paint);
    paint();
    return button;
  };

  const groups = [...new Set(SECTIONS.map((s) => s.group))];

  return h(
    'div',
    { class: 'console op-shell' },
    h(
      'aside',
      { class: 'op-side' },
      h(
        'div',
        { class: 'op-side-brand' },
        h('div', { class: 'brand' }, h('div', { class: 'logo' }, renderIcon('wrench', { size: 18 })), h('div', { class: 'op-brand-text' }, h('span', {}, 'Operator'), h('small', {}, 'Platform console'))),
        h(
          'div',
          { class: 'op-side-quick' },
          modeButton(true),
          h('button', { class: 'btn sm ghost icon-only', type: 'button', title: 'Sign out', 'aria-label': 'Sign out', onclick: signOut }, renderIcon('logout', { size: 15 })),
        ),
      ),
      h(
        'nav',
        { class: 'op-nav', 'aria-label': 'Console sections' },
        ...groups.map((group) => [
          h('div', { class: 'nav-section' }, group),
          ...SECTIONS.filter((s) => s.group === group).map((s) =>
            h(
              'button',
              {
                class: `nav-link${s.id === current.id ? ' active' : ''}`,
                type: 'button',
                'aria-current': s.id === current.id ? 'page' : null,
                onclick: () => go(s.id),
              },
              h('span', { class: 'icon' }, renderIcon(s.icon, { size: 18 })),
              h('span', {}, s.label),
            ),
          ),
        ]),
      ),
      h(
        'div',
        { class: 'op-side-foot' },
        h(
          'div',
          { class: 'sidebar-user' },
          h('span', { class: 'op-user-mark' }, renderIcon('shield', { size: 16 })),
          h('div', { class: 'sidebar-user-meta' }, h('div', { class: 'sidebar-user-name' }, 'Platform operator'), h('div', { class: 'sidebar-user-role' }, 'Full access')),
        ),
        h(
          'div',
          { class: 'sidebar-actions' },
          modeButton(false),
          h('a', { class: 'btn sm ghost', href: '#/' }, renderIcon('home', { size: 15 }), 'Site'),
          h('button', { class: 'btn sm ghost op-signout', type: 'button', onclick: signOut }, renderIcon('logout', { size: 15 }), 'Sign out'),
        ),
      ),
    ),
    h(
      'main',
      { class: 'op-main' },
      h(
        'header',
        { class: 'op-page-head' },
        h(
          'div',
          { class: 'op-page-title' },
          h('span', { class: 'op-eyebrow' }, renderIcon(current.icon, { size: 14 }), current.group),
          h('h1', {}, current.title),
          h('p', {}, current.sub),
        ),
        actions.length ? h('div', { class: 'op-page-actions' }, ...actions) : null,
      ),
      h('div', { class: 'op-body' }, body),
    ),
  );
}

const refreshButton = (rerender) =>
  h(
    'button',
    {
      class: 'btn sm',
      type: 'button',
      onclick: async (event) => {
        event.currentTarget.disabled = true;
        await rerender();
      },
    },
    renderIcon('refreshCw', { size: 15 }),
    'Refresh',
  );

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
        h('a', { class: 'btn ghost', href: '#/' }, renderIcon('arrowLeft', { size: 16 }), 'Back to the site'),
      ),
    );
  }

  if (!platformSession.token) return loginCard(rerender);

  const onExpired = async () => {
    platformSession.clear();
    await rerender();
  };

  if (consoleSection === 'catalog') return consoleShell(rerender, renderCatalogSection({ onExpired }));
  if (consoleSection === 'foods') return consoleShell(rerender, renderFoodCatalogSection({ onExpired }));
  if (consoleSection === 'store') return consoleShell(rerender, renderStoreAdminSection({ onExpired }));
  if (consoleSection === 'navbadges') return consoleShell(rerender, renderNavBadgesSection({ onExpired }));

  if (consoleSection === 'domains') {
    let section;
    try {
      section = await renderDomainsSection(rerender);
    } catch (err) {
      if (err.status === 401 || err.status === 403) {
        platformSession.clear();
        return loginCard(rerender);
      }
      throw err;
    }
    return consoleShell(rerender, section, { actions: [refreshButton(rerender)] });
  }

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

  const businessTypeCounts = data.items.reduce((acc, row) => {
    const key = row.business_type || 'gym';
    acc[key] = (acc[key] || 0) + 1;
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
  const countNode = h('span', { class: 'badge grey' });

  const SORTS = {
    'created:desc': (a, b) => String(b.created_at).localeCompare(String(a.created_at)),
    'created:asc': (a, b) => String(a.created_at).localeCompare(String(b.created_at)),
    'name:asc': (a, b) => a.gym_name.localeCompare(b.gym_name),
    'members:desc': (a, b) => (b.stats?.members ?? -1) - (a.stats?.members ?? -1),
    'revenue:desc': (a, b) => (b.stats?.revenue_month ?? -1) - (a.stats?.revenue_month ?? -1),
    'visits:desc': (a, b) => (b.stats?.visits_30d ?? -1) - (a.stats?.visits_30d ?? -1),
  };

  const rowAction = (icon, title, run) =>
    h(
      'button',
      {
        class: 'btn sm ghost icon-only',
        type: 'button',
        title,
        'aria-label': title,
        onclick: (e) => {
          e.stopPropagation();
          run();
        },
      },
      renderIcon(icon, { size: 15 }),
    );

  const columns = [
    {
      label: 'Account',
      render: (row) =>
        h(
          'div',
          { class: 'op-gym' },
          gymAvatar(row),
          h(
            'div',
            { class: 'op-gym-text' },
            h('div', { class: 'op-gym-name' }, row.gym_name),
            h(
              'div',
              { class: 'op-gym-meta' },
              h('a', { href: gymPathUrl(row.slug), onclick: (e) => e.stopPropagation() }, `/g/${row.slug}`),
              h('span', {}, row.business_type === 'library' ? 'Library' : 'Gym'),
            ),
            ...(row.custom_domains ?? []).map((domain) =>
              h(
                'div',
                { class: 'op-gym-domain', title: domain.status === 'active' ? 'Live custom domain' : 'Custom domain waiting for DNS' },
                renderIcon('globe', { size: 12 }),
                domain.hostname,
                domain.status === 'active' ? null : h('span', { class: 'badge amber' }, 'DNS'),
              ),
            ),
          ),
        ),
    },
    {
      label: 'Status',
      render: (row) => h('div', { class: 'op-status-cell' }, statusBadge(row.status), statusNote(row)),
    },
    {
      label: 'Members',
      align: 'right',
      render: (row) => (row.stats ? row.stats.members : h('span', { class: 'badge red' }, 'db error')),
    },
    {
      label: 'This month',
      align: 'right',
      render: (row) => (row.stats ? h('strong', {}, amount(row.stats.revenue_month, row.currency)) : '—'),
    },
    { label: 'Visits 30d', align: 'right', render: (row) => row.stats?.visits_30d ?? '—' },
    { label: 'Joined', render: (row) => h('span', { class: 'muted op-nowrap' }, date(row.created_at)) },
    {
      label: '',
      align: 'right',
      render: (row) =>
        h(
          'div',
          { class: 'op-row-actions' },
          rowAction('shield', 'Change status', () => openStatusModal(row, rerender)),
          rowAction('key', 'Issue a password reset link', () => openPasswordResetModal(row)),
          renderIcon('chevronRight', { size: 16, class: 'op-row-chevron' }),
        ),
    },
  ];

  const statusTabs = h('div', { class: 'filter-tabs op-status-tabs', role: 'tablist' });
  const drawTabs = () => {
    clear(statusTabs).append(
      ...[['', 'All', data.total], ...STATUS_ORDER.map((s) => [s, STATUS_LABEL[s], counts[s] || 0])].map(([value, text, n]) =>
        h(
          'button',
          {
            class: `filter-tab${state.status === value ? ' active' : ''}`,
            type: 'button',
            role: 'tab',
            'aria-selected': String(state.status === value),
            onclick: () => {
              state.status = value;
              drawTabs();
              draw();
            },
          },
          text,
          h('span', { class: 'op-tab-count' }, n),
        ),
      ),
    );
  };

  const draw = () => {
    const needle = state.q.toLowerCase();
    const rows = data.items
      .filter((row) => !state.status || row.status === state.status)
      .filter((row) => !state.businessType || row.business_type === state.businessType)
      .filter(
        (row) =>
          !needle ||
          row.gym_name.toLowerCase().includes(needle) ||
          row.slug.toLowerCase().includes(needle) ||
          (row.custom_domains ?? []).some((domain) => domain.hostname.includes(needle)),
      )
      .sort(SORTS[state.sort]);

    countNode.textContent = rows.length === data.items.length ? `${rows.length}` : `${rows.length} of ${data.items.length}`;
    clear(tableNode).append(
      table(columns, rows, {
        onRowClick: (row) => openDetailModal(row, rerender),
        empty: state.q || state.status || state.businessType ? 'No account matches those filters' : 'No gyms have signed up yet',
      }),
    );
  };

  const search = h('input', {
    class: 'search',
    type: 'search',
    placeholder: 'Search name, address or domain…',
  });
  search.addEventListener('input', () => {
    state.q = search.value.trim();
    draw();
  });

  const businessTypeFilter = h(
    'select',
    {
      'aria-label': 'Business type',
      onchange: (e) => {
        state.businessType = e.target.value;
        draw();
      },
    },
    h('option', { value: '' }, 'All types'),
    h('option', { value: 'gym' }, `Gyms (${businessTypeCounts.gym || 0})`),
    h('option', { value: 'library' }, `Libraries (${businessTypeCounts.library || 0})`),
  );

  const sortSelect = h(
    'select',
    {
      'aria-label': 'Sort',
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

  drawTabs();
  draw();

  const directory = h(
    'div',
    { class: 'card op-table-card' },
    h(
      'div',
      { class: 'op-table-head' },
      cardTitle('building', 'All accounts', 'blue'),
      countNode,
      h('div', { class: 'spacer' }),
      statusTabs,
    ),
    h('div', { class: 'op-table-tools' }, search, businessTypeFilter, sortSelect),
    tableNode,
  );

  const pickStatus = (status) => {
    state.status = status;
    drawTabs();
    draw();
    directory.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const signups = (analytics?.signups_by_month ?? []).map((point) => ({
    label: new Date(`${point.month}-01T00:00:00`).toLocaleString(undefined, { month: 'short' }),
    value: point.count,
  }));
  const signupTotal = signups.reduce((sum, point) => sum + point.value, 0);
  const paying = counts.active || 0;

  return consoleShell(
    rerender,
    h(
      'div',
      { class: 'op-stack' },
      h(
        'div',
        { class: 'op-kpis' },
        kpi('Accounts', data.total, {
          icon: 'building',
          tone: 'blue',
          foot: `${businessTypeCounts.gym || 0} gyms · ${businessTypeCounts.library || 0} libraries`,
        }),
        kpi('Paying', paying, {
          icon: 'checkCircle',
          tone: 'green',
          foot: data.total ? `${Math.round((paying / data.total) * 100)}% of accounts · ${counts.trial || 0} on trial` : 'No accounts yet',
          onClick: () => pickStatus('active'),
        }),
        kpi('Active members', totalMembers.toLocaleString(), { icon: 'members', tone: 'purple', foot: 'Across every account' }),
        kpi('Collected', revenueLabel, { icon: 'revenue', tone: 'amber', foot: 'This month, all accounts' }),
      ),

      h(
        'div',
        { class: 'op-split' },
        h(
          'div',
          { class: 'card' },
          h(
            'div',
            { class: 'card-head' },
            cardTitle('trendUp', 'New signups', 'blue'),
            h('div', { class: 'spacer' }),
            h('span', { class: 'muted op-head-note' }, signups.length ? `${signupTotal} in the last ${signups.length} months` : ''),
          ),
          signups.length
            ? barChart(signups, { height: 190 })
            : emptyState('Signups appear here month by month.', { icon: 'trendUp', title: 'No signup history yet' }),
        ),
        statusMixCard(counts, data.total, pickStatus),
      ),

      h(
        'div',
        { class: 'op-split even' },
        attentionCard(data.items, (row) => openDetailModal(row, rerender)),
        backupCard(),
      ),

      directory,
    ),
    { actions: [refreshButton(rerender)] },
  );
}
