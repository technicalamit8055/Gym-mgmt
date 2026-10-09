import { api, session } from '../api.js';
import { buildForm, clear, closeModal, confirmDialog, currencyInfo, emptyState, h, money, openModal, renderIcon, toast } from '../ui.js';
import { isLibrary, t } from '../vertical.js';

/** The tile beside each field of the plan form: icon (or literal glyph) and tone. */
const FIELD_TILES = {
  name: { icon: 'plans', tone: 'blue' },
  price: { tone: 'green' },
  duration_days: { icon: 'calendar', tone: 'violet' },
  sessions: { tone: 'orange' },
  active: { icon: 'cart', tone: 'red' },
  description: { icon: 'fileText', tone: 'sky' },
};

function openPlanForm({ plan, onSaved }) {
  const editing = Boolean(plan);
  const noun = isLibrary() ? 'pass' : 'plan';
  const members = t('members').toLowerCase();
  const cash = currencyInfo();
  const form = buildForm(
    [
      {
        name: 'name',
        label: `${isLibrary() ? 'Pass' : 'Plan'} name`,
        required: true,
        full: true,
        value: plan?.name,
        placeholder: 'e.g. Monthly, Quarterly, Annual',
        hint: `Give a clear and short name for this ${noun}.`,
      },
      {
        name: 'price',
        label: 'Price',
        type: 'number',
        required: true,
        min: 0,
        step: '0.01',
        value: plan?.price,
        placeholder: 'e.g. 1500',
        hint: `Enter the ${noun} price in ${cash.name.replace(/\b\w/g, (c) => c.toUpperCase())} (${cash.symbol}).`,
      },
      {
        name: 'duration_days',
        label: 'Duration (days)',
        type: 'number',
        required: true,
        min: 1,
        value: plan?.duration_days ?? 30,
        hint: `Number of days this ${noun} will be valid.`,
      },
      {
        name: 'sessions',
        label: 'Session limit',
        type: 'number',
        min: 1,
        value: plan?.sessions ?? '',
        placeholder: 'e.g. 10',
        hint: 'Leave blank for unlimited access.',
      },
      {
        name: 'active',
        label: 'Available for sale',
        type: 'select',
        value: plan ? String(plan.active) : '1',
        options: [
          { value: '1', label: 'Yes' },
          { value: '0', label: 'No — archived' },
        ],
        hint: `Set whether this ${noun} can be purchased by ${members}.`,
      },
      {
        name: 'description',
        label: 'Description',
        type: 'textarea',
        full: true,
        value: plan?.description,
        placeholder: isLibrary() ? 'e.g. Reserved seat, open every day…' : 'e.g. Full gym access, renewed every month…',
        hint: `Add a short description to help your ${members} understand this ${noun}.`,
      },
    ],
    {
      submitLabel: editing ? `Save ${noun}` : `Create ${noun}`,
      onSubmit: async (values) => {
        const payload = { ...values, sessions: values.sessions === '' ? null : values.sessions };
        if (editing) await api.updatePlan(plan.id, payload);
        else await api.createPlan(payload);
        closeModal();
        toast(editing ? 'Plan updated' : 'Plan created');
        await onSaved?.();
      },
    },
  );

  // buildForm lays out plain fields; give each a coloured tile beside it.
  // Price shows the gym's own currency symbol, and the session limit the
  // business's mark, rather than a fixed icon.
  for (const [name, tile] of Object.entries(FIELD_TILES)) {
    const field = form.elements[name].closest('label.field');
    const glyph =
      name === 'price'
        ? h('span', { class: 'pf-glyph' }, cash.symbol)
        : renderIcon(name === 'sessions' ? (isLibrary() ? 'ticket' : 'barbell') : tile.icon, { size: 24, stroke: 2 });
    field.classList.add('pf-field');
    field.prepend(h('span', { class: `pf-tile tone-${tile.tone}`, 'aria-hidden': 'true' }, glyph));
  }
  const submit = form.querySelector('button[type="submit"]');
  if (!editing) submit.prepend(renderIcon('plus', { size: 20, stroke: 2.2 }));
  form.classList.add('pf-form');

  openModal({
    title: editing ? `Edit ${plan.name}` : isLibrary() ? 'New library pass' : 'New membership plan',
    subtitle: editing
      ? `Update the details of this ${noun}.`
      : isLibrary() ? 'Create a new pass for your library.' : 'Create a new membership plan for your gym.',
    icon: 'crown',
    className: 'pf-modal',
    body: form,
  });
}

const ART = '/images/plans';

/** Cards take these in turn, so neighbouring plans never share a colour. */
const TONES = [
  { name: 'blue', art: 'calendar.svg' },
  { name: 'violet', art: 'calendar-clock.svg' },
  { name: 'orange', art: 'trophy.svg' },
];

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** Sortable columns of the "All plans" table, in display order. */
function planColumns(Member) {
  return [
    { key: 'name', label: t('plan'), value: (row) => row.name.toLowerCase() },
    { key: 'price', label: 'Price', value: (row) => row.price, render: (row) => money(row.price) },
    { key: 'duration', label: 'Duration', value: (row) => row.duration_days, render: (row) => `${row.duration_days} days` },
    // Unlimited sorts after every capped plan, not before.
    { key: 'sessions', label: 'Sessions', value: (row) => row.sessions ?? Infinity, render: (row) => row.sessions ?? '∞' },
    { key: 'members', label: `Active ${Member.toLowerCase()}s`, value: (row) => row.active_members, render: (row) => row.active_members },
    {
      key: 'perDay',
      label: 'Value per day',
      value: (row) => row.price / row.duration_days,
      render: (row) => money(row.price / row.duration_days),
    },
  ];
}

export async function renderPlans({ setActions, reload }) {
  const { items } = await api.plans();
  const Member = t('member');
  const member = Member.toLowerCase();
  const Plan = t('plan');

  if (session.managesBilling) {
    setActions(
      h(
        'button',
        { class: 'btn primary pl-new', onclick: () => openPlanForm({ onSaved: reload }) },
        renderIcon('plus', { size: 18, stroke: 2.2 }),
        `New ${Plan.toLowerCase()}`,
      ),
    );
  }

  const deleteButton = (plan) =>
    h(
      'button',
      {
        class: 'btn danger pl-action',
        onclick: () =>
          confirmDialog({
            title: `Delete ${plan.name}?`,
            message: 'Plans that have been sold are archived instead of deleted so history stays intact.',
            confirmLabel: 'Delete plan',
            danger: true,
            onConfirm: async () => {
              const result = await api.deletePlan(plan.id);
              toast(result.archived ? 'Plan archived — it is still referenced by memberships' : 'Plan deleted');
              await reload();
            },
          }),
      },
      renderIcon('trash', { size: 17 }),
      'Delete',
    );

  const planCard = (plan, index) => {
    const tone = TONES[index % TONES.length];
    return h(
      'div',
      { class: `card pl-card tone-${tone.name}${plan.active ? '' : ' archived'}` },
      h('img', { class: 'pl-art', src: `${ART}/${tone.art}`, alt: '', 'aria-hidden': 'true' }),
      h(
        'div',
        { class: 'pl-top' },
        h('span', { class: 'pl-icon' }, renderIcon('calendar', { size: 30, stroke: 1.8 })),
        h('div', { class: 'pl-title' }, h('h3', {}, plan.name), h('div', { class: 'pl-price' }, money(plan.price))),
        plan.active ? h('span', { class: 'badge green pl-badge' }, 'On sale') : h('span', { class: 'badge grey pl-badge' }, 'Archived'),
      ),
      h(
        'ul',
        { class: 'pl-facts' },
        h(
          'li',
          {},
          renderIcon('calendar', { size: 19 }),
          `${plan.duration_days} days · ${plan.sessions ? plural(plan.sessions, 'session') : 'unlimited visits'}`,
        ),
        plan.description
          ? h('li', {}, renderIcon(isLibrary() ? 'book' : 'barbell', { size: 19 }), plan.description)
          : null,
        h('li', {}, renderIcon('users', { size: 19 }), `${plural(plan.active_members, `active ${member}`)}`),
      ),
      session.managesBilling
        ? h(
          'div',
          { class: 'pl-actions' },
          h(
            'button',
            { class: 'btn pl-action', onclick: () => openPlanForm({ plan, onSaved: reload }) },
            renderIcon('edit', { size: 17 }),
            'Edit',
          ),
          session.can('admin') ? deleteButton(plan) : null,
        )
        : null,
    );
  };

  /* ── "All plans", sortable by any column ─────────────────────────── */

  const columns = planColumns(Member);
  const toneOf = new Map(items.map((plan, index) => [plan.id, TONES[index % TONES.length].name]));
  let sort = { key: null, dir: 1 };
  const tbody = h('tbody', {});
  const headCells = new Map();

  const paintRows = () => {
    const column = columns.find((c) => c.key === sort.key);
    const rows = column
      ? [...items].sort((a, b) => {
        const x = column.value(a);
        const y = column.value(b);
        return (x < y ? -1 : x > y ? 1 : 0) * sort.dir;
      })
      : items;
    clear(tbody).append(
      ...rows.map((row) =>
        h(
          'tr',
          {},
          h(
            'td',
            {},
            h(
              'span',
              { class: 'pl-cell-name' },
              h('span', { class: `pl-cell-icon tone-${toneOf.get(row.id)}` }, renderIcon('calendar', { size: 18 })),
              row.name,
            ),
          ),
          ...columns.slice(1).map((c) => h('td', {}, c.render(row))),
        ),
      ),
    );
    for (const [key, th] of headCells) {
      th.setAttribute('aria-sort', key === sort.key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none');
    }
  };

  const thead = h(
    'thead',
    {},
    h(
      'tr',
      {},
      ...columns.map((c) => {
        const th = h(
          'th',
          { 'aria-sort': 'none' },
          h(
            'button',
            {
              class: 'pl-sort',
              type: 'button',
              onclick: () => {
                sort = { key: c.key, dir: sort.key === c.key ? -sort.dir : 1 };
                paintRows();
              },
            },
            c.label,
            renderIcon('sort', { size: 14, stroke: 2.4 }),
          ),
        );
        headCells.set(c.key, th);
        return th;
      }),
    ),
  );
  paintRows();

  return h(
    'div',
    { class: 'grid pl-page' },
    items.length
      ? h('div', { class: 'pl-cards' }, ...items.map(planCard))
      : h('div', { class: 'card empty' }, `No ${t('plans').toLowerCase()} yet — create your first membership plan`),
    h(
      'div',
      { class: 'card pl-all' },
      h(
        'div',
        { class: 'pl-all-head' },
        h('span', { class: 'pl-icon tone-violet' }, renderIcon('list', { size: 26, stroke: 2 })),
        h(
          'div',
          { class: 'pl-title' },
          h('h3', {}, `All ${t('plans').toLowerCase()}`),
          h('p', {}, isLibrary() ? 'Overview of all library passes.' : 'Overview of all membership plans.'),
        ),
      ),
      items.length
        ? h('div', { class: 'table-wrap pl-table-wrap' }, h('table', { class: 'pl-table' }, thead, tbody))
        : emptyState(`No ${t('plans').toLowerCase()} yet`),
    ),
  );
}
