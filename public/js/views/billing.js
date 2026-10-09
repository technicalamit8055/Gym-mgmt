import { api, session } from '../api.js';
import {
  clear,
  confirmDialog,
  date,
  dateField,
  fullName,
  h,
  initials,
  labelledControl,
  money,
  relativeDays,
  renderIcon,
  STATUS_TONE,
  table,
  toast,
} from '../ui.js';
import { openMembershipForm, openPaymentForm } from './forms.js';
import { downloadReceipt, getGymName, printReceipt } from '../receipt.js';

/** Membership filter → [dot tone, caption under the "listed" count]. */
const FILTERS = {
  active: ['green', 'Total active members'],
  '': ['grey', 'All memberships'],
  expiring: ['amber', 'Ending within 7 days'],
  expired: ['red', 'Expired memberships'],
  due: ['red', 'With an unpaid balance'],
  frozen: ['blue', 'Currently frozen'],
};

const STATUS_ICON = { active: 'checkCircle', frozen: 'pause', expired: 'alert', cancelled: 'xCircle' };

const METHOD_STAT = {
  cash: ['green', 'cash'],
  card: ['blue', 'card'],
  upi: ['orange', 'smartphone'],
  bank: ['violet', 'bank'],
  online: ['blue', 'globe'],
};

/**
 * A billing metric card: white icon tile, label / figure / caption, and the
 * same icon drawn large and faint behind the right edge.
 */
const billStat = ({ tone, icon, label, value, note, alert = false }) =>
  h(
    'div',
    { class: `bill-stat bill-${tone}` },
    h('div', { class: 'bill-stat-icon' }, renderIcon(icon, { size: 28, stroke: 2 })),
    h(
      'div',
      { class: 'bill-stat-body' },
      h('div', { class: 'bill-stat-label' }, label),
      h('div', { class: `bill-stat-value${alert ? ' alert' : ''}` }, value),
      note ? h('div', { class: 'bill-stat-note' }, note) : null,
    ),
    renderIcon(icon, { size: 96, stroke: 1.4, class: 'bill-stat-wm' }),
  );

const iconBadge = (tone, icon, text) =>
  h('span', { class: `badge ${tone} bill-badge` }, renderIcon(icon, { size: 13, stroke: 2.4 }), text);

const contractValue = (row) => row.price - row.discount + (row.addon_total || 0);

function memberCell(row) {
  return h(
    'a',
    { class: 'bill-member', href: `#/members/${row.member_id}` },
    h('span', { class: 'bill-avatar' }, initials(row.first_name, row.last_name)),
    h(
      'span',
      { class: 'bill-member-meta' },
      h('span', { class: 'bill-member-name' }, fullName(row)),
      h('span', { class: 'bill-member-sub' }, row.email || row.phone || row.member_code || ''),
    ),
  );
}

/** Days left on a running membership; other states are carried by the plan badge. */
function remainingBadge(row) {
  if (row.status !== 'active') return null;
  const days = relativeDays(row.end_date);
  if (days === null) return null;
  if (days < 0) return iconBadge('red', 'alert', `Expired ${Math.abs(days)}d ago`);
  if (days === 0) return iconBadge('amber', 'clock', 'Ends today');
  if (days <= 7) return iconBadge('amber', 'clock', `${days}d left`);
  return iconBadge('green', 'checkCircle', `${days}d left`);
}

function paidBadge(row) {
  if (row.due <= 0) return iconBadge('green', 'checkCircle', 'Paid');
  if (row.paid > 0) return iconBadge('amber', 'clock', 'Partial');
  return iconBadge('red', 'alert', 'Unpaid');
}

/*
 * The row's overflow menu. It lives on <body> with fixed positioning because
 * the table scrolls sideways on a phone, and that overflow would clip it.
 */
let closeRowMenu = null;
let rowMenuAnchor = null;

function toggleRowMenu(anchor, items) {
  const wasOpen = rowMenuAnchor === anchor;
  closeRowMenu?.();
  if (wasOpen) return;

  const menu = h(
    'div',
    { class: 'row-menu', role: 'menu' },
    ...items.filter(Boolean).map(({ label, icon, danger, onSelect }) =>
      h(
        'button',
        {
          type: 'button',
          role: 'menuitem',
          class: `row-menu-item${danger ? ' danger' : ''}`,
          onclick: () => {
            close();
            onSelect();
          },
        },
        renderIcon(icon, { size: 16 }),
        label,
      ),
    ),
  );
  document.body.append(menu);

  const rect = anchor.getBoundingClientRect();
  const below = rect.bottom + 6;
  const top = below + menu.offsetHeight > window.innerHeight - 8 ? rect.top - menu.offsetHeight - 6 : below;
  menu.style.top = `${Math.max(8, top)}px`;
  menu.style.left = `${Math.max(8, rect.right - menu.offsetWidth)}px`;
  anchor.setAttribute('aria-expanded', 'true');

  const onPointer = (event) => {
    if (!menu.contains(event.target) && !anchor.contains(event.target)) close();
  };
  const onKey = (event) => {
    if (event.key !== 'Escape') return;
    close();
    anchor.focus();
  };
  function close() {
    menu.remove();
    anchor.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onPointer, true);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('scroll', close, true);
    window.removeEventListener('resize', close);
    window.removeEventListener('hashchange', close);
    closeRowMenu = null;
    rowMenuAnchor = null;
  }
  document.addEventListener('pointerdown', onPointer, true);
  document.addEventListener('keydown', onKey);
  window.addEventListener('scroll', close, true);
  window.addEventListener('resize', close);
  window.addEventListener('hashchange', close);
  closeRowMenu = close;
  rowMenuAnchor = anchor;
  menu.querySelector('button')?.focus();
}

export async function renderBilling({ setActions, reload }) {
  const state = { tab: 'memberships', filter: 'active', from: '', to: '' };
  const body = h('div', {});

  setActions(
    h('button', { class: 'btn', onclick: () => api.download('payments').catch((e) => toast(e.message, 'error')) }, renderIcon('download', { size: 16 }), 'Export payments'),
    session.managesBilling
      ? h('button', { class: 'btn', onclick: () => openPaymentForm({ onSaved: reload }) }, renderIcon('billing', { size: 16 }), 'Record payment')
      : null,
    session.managesBilling
      ? h('button', { class: 'btn primary', onclick: () => openMembershipForm({ onSaved: reload }) }, renderIcon('plus', { size: 16 }), 'Sell membership')
      : null,
  );

  const tabs = h(
    'div',
    { class: 'bill-tabs', role: 'tablist' },
    ...[
      ['memberships', 'Memberships', 'users'],
      ['payments', 'Payments', 'card'],
    ].map(([key, label, icon]) =>
      h(
        'button',
        {
          type: 'button',
          role: 'tab',
          class: `bill-tab${state.tab === key ? ' active' : ''}`,
          'aria-selected': String(state.tab === key),
          dataset: { tab: key },
          onclick: () => {
            state.tab = key;
            for (const button of tabs.children) {
              const active = button.dataset.tab === key;
              button.classList.toggle('active', active);
              button.setAttribute('aria-selected', String(active));
            }
            render();
          },
        },
        renderIcon(icon, { size: 18 }),
        label,
      ),
    ),
  );

  const filterSelect = h(
    'select',
    {
      'aria-label': 'Filter memberships',
      onchange: (event) => {
        state.filter = event.target.value;
        filterControl.dataset.tone = FILTERS[state.filter][0];
        render();
      },
    },
    h('option', { value: 'active', selected: true }, 'Active'),
    h('option', { value: '' }, 'All memberships'),
    h('option', { value: 'expiring' }, 'Expiring in 7 days'),
    h('option', { value: 'expired' }, 'Expired'),
    h('option', { value: 'due' }, 'Unpaid balance'),
    h('option', { value: 'frozen' }, 'Frozen'),
  );
  // The coloured dot in front of the label says which slice is on screen.
  const filterControl = h('label', { class: 'bill-filter', dataset: { tone: 'green' } }, h('span', { class: 'bill-filter-dot', 'aria-hidden': 'true' }), filterSelect);

  async function collect(row) {
    const member = await api.member(row.member_id);
    openPaymentForm({ member, subscriptions: member.subscriptions, onSaved: render });
  }

  function rowActions(row) {
    const manages = session.managesBilling;
    const live = row.status === 'active' || row.status === 'frozen';
    return [
      { label: 'View member', icon: 'user', onSelect: () => (window.location.hash = `#/members/${row.member_id}`) },
      manages && row.due > 0 ? { label: 'Collect payment', icon: 'wallet', onSelect: () => collect(row).catch((e) => toast(e.message, 'error')) } : null,
      manages && row.status === 'active'
        ? {
            label: 'Freeze',
            icon: 'pause',
            onSelect: async () => {
              try {
                await api.freezeSubscription(row.id);
                toast('Membership frozen');
                await render();
              } catch (err) {
                toast(err.message || 'Could not freeze the membership', 'error');
              }
            },
          }
        : null,
      manages && row.status === 'frozen'
        ? {
            label: 'Resume',
            icon: 'play',
            onSelect: async () => {
              try {
                const result = await api.resumeSubscription(row.id);
                toast(`Resumed — ${result.days_credited} day(s) credited`);
                await render();
              } catch (err) {
                toast(err.message || 'Could not resume the membership', 'error');
              }
            },
          }
        : null,
      manages && live
        ? {
            label: 'Cancel membership',
            icon: 'ban',
            danger: true,
            onSelect: () =>
              confirmDialog({
                title: 'Cancel this membership?',
                message: `${fullName(row)} loses access immediately. Payments already recorded are kept.`,
                confirmLabel: 'Cancel membership',
                danger: true,
                onConfirm: async () => {
                  await api.cancelSubscription(row.id);
                  toast('Membership cancelled');
                  await render();
                },
              }),
          }
        : null,
    ];
  }

  async function renderMemberships() {
    const params = { limit: 200 };
    if (state.filter === 'expiring') params.expiring_in = 7;
    else if (state.filter === 'due') params.due = 'true';
    else if (state.filter) params.status = state.filter;

    const { items } = await api.subscriptions(params);
    const totals = items.reduce(
      (acc, row) => ({
        value: acc.value + contractValue(row),
        paid: acc.paid + row.paid,
        due: acc.due + Math.max(row.due, 0),
      }),
      { value: 0, paid: 0, due: 0 },
    );
    const scope = state.filter === 'active' ? 'active' : 'listed';

    return h(
      'div',
      { class: 'grid', style: 'gap:22px' },
      h(
        'div',
        { class: 'bill-stats' },
        billStat({ tone: 'orange', icon: 'users', label: 'Memberships listed', value: items.length, note: FILTERS[state.filter][1] }),
        billStat({ tone: 'green', icon: 'fileText', label: 'Contract value', value: money(totals.value, { compact: true }), note: `Total value of ${scope} plans` }),
        billStat({ tone: 'blue', icon: 'wallet', label: 'Collected', value: money(totals.paid, { compact: true }), note: 'Total amount received' }),
        billStat({ tone: 'red', icon: 'clock', label: 'Outstanding', value: money(totals.due, { compact: true }), note: 'Amount pending', alert: totals.due > 0 }),
      ),
      h(
        'div',
        { class: 'card bill-table' },
        table(
          [
            { label: 'Member', render: memberCell },
            {
              label: 'Plan',
              render: (row) =>
                h(
                  'div',
                  { class: 'bill-stack' },
                  h('span', { class: 'bill-plan' }, row.plan_name),
                  iconBadge(STATUS_TONE[row.status] || 'grey', STATUS_ICON[row.status] || 'info', row.status.charAt(0).toUpperCase() + row.status.slice(1)),
                ),
            },
            {
              label: 'Period',
              render: (row) =>
                h(
                  'div',
                  { class: 'bill-period' },
                  renderIcon('calendar', { size: 20, class: 'bill-period-icon' }),
                  h('div', { class: 'bill-stack' }, h('span', { class: 'bill-dates' }, `${date(row.start_date)} → ${date(row.end_date)}`), remainingBadge(row)),
                ),
            },
            { label: 'Value', render: (row) => h('span', { class: 'bill-amount' }, money(contractValue(row))) },
            { label: 'Paid', render: (row) => h('div', { class: 'bill-stack' }, h('span', { class: 'bill-amount' }, money(row.paid)), paidBadge(row)) },
            {
              label: 'Due',
              render: (row) => (row.due > 0 ? h('span', { class: 'bill-amount bill-due' }, money(row.due)) : h('span', { class: 'bill-dash' }, '—')),
            },
            {
              label: 'Actions',
              render: (row) =>
                h(
                  'div',
                  { class: 'bill-actions' },
                  session.managesBilling
                    ? h(
                        'button',
                        {
                          class: 'btn bill-btn',
                          title: 'Send a renewal reminder on WhatsApp',
                          onclick: async (event) => {
                            event.stopPropagation();
                            const button = event.currentTarget;
                            button.disabled = true;
                            try {
                              await api.sendWhatsAppReminder({ subscription_id: row.id });
                              toast('Renewal reminder sent on WhatsApp');
                            } catch (err) {
                              toast(err.message || 'Could not send the reminder', 'error');
                            } finally {
                              button.disabled = false;
                            }
                          },
                        },
                        renderIcon('whatsapp', { size: 17 }), 'Remind',
                      )
                    : null,
                  h(
                    'button',
                    {
                      class: 'btn bill-btn bill-more',
                      title: 'More actions',
                      'aria-label': `More actions for ${fullName(row)}`,
                      'aria-haspopup': 'menu',
                      'aria-expanded': 'false',
                      onclick: (event) => {
                        event.stopPropagation();
                        toggleRowMenu(event.currentTarget, rowActions(row));
                      },
                    },
                    renderIcon('more', { size: 20, stroke: 2.5, class: 'bill-more-icon' }),
                  ),
                ),
            },
          ],
          items,
          { empty: 'No memberships match this filter' },
        ),
      ),
    );
  }

  async function renderPayments() {
    const { items, totals } = await api.payments({ limit: 200, from: state.from || undefined, to: state.to || undefined });
    const byMethod = items.reduce((acc, row) => {
      acc[row.method] = (acc[row.method] || 0) + row.amount;
      return acc;
    }, {});

    return h(
      'div',
      { class: 'grid', style: 'gap:22px' },
      h(
        'div',
        { class: 'bill-stats' },
        billStat({ tone: 'orange', icon: 'wallet', label: 'Total collected', value: money(totals.amount, { compact: true }), note: `${totals.count} payments` }),
        ...Object.entries(byMethod)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([method, amount]) => {
            const [tone, icon] = METHOD_STAT[method] || ['blue', 'cash'];
            return billStat({ tone, icon, label: method.toUpperCase(), value: money(amount, { compact: true }), note: `Received by ${method}` });
          }),
      ),
      h(
        'div',
        { class: 'card bill-table' },
        table(
          [
            { label: 'Date', render: (row) => date(row.paid_on) },
            { label: 'Member', render: (row) => h('a', { href: `#/members/${row.member_id}` }, fullName(row)) },
            { label: 'Plan', render: (row) => h('span', { class: 'muted' }, row.plan_name || 'Not linked') },
            { label: 'Method', render: (row) => h('span', { class: 'badge grey' }, row.method) },
            { label: 'Reference', render: (row) => h('span', { class: 'muted' }, row.reference || '—') },
            { label: 'Amount', align: 'right', render: (row) => money(row.amount) },
            {
              label: '',
              render: (row) =>
                h(
                  'div',
                  { class: 'row', style: 'gap:6px;justify-content:flex-end' },
                  h(
                    'button',
                    {
                      class: 'btn sm ghost',
                      title: 'Print receipt',
                      onclick: async (event) => {
                        event.stopPropagation();
                        try {
                          const fullPayment = await api.paymentReceipt(row.id);
                          printReceipt(fullPayment, { gymName: getGymName() });
                        } catch (err) {
                          toast(err.message || 'Could not load receipt details', 'error');
                        }
                      },
                    },
                    renderIcon('print', { size: 15 }), 'Print',
                  ),
                  session.managesBilling
                    ? h(
                        'button',
                        {
                          class: 'btn sm ghost',
                          title: 'Send this receipt on WhatsApp',
                          onclick: async (event) => {
                            event.stopPropagation();
                            const button = event.currentTarget;
                            button.disabled = true;
                            try {
                              // Let the server attach its own built-in PDF receipt
                              // (src/receiptPdf.js) rather than rendering a fresh one
                              // here — keeps the WhatsApp copy identical to the
                              // auto-sent one instead of a second, divergent render.
                              await api.sendWhatsAppReceipt(row.id);
                              toast('Receipt sent on WhatsApp');
                            } catch (err) {
                              toast(err.message || 'Could not send the receipt', 'error');
                            } finally {
                              button.disabled = false;
                            }
                          },
                        },
                        renderIcon('whatsapp', { size: 16 }), 'Receipt',
                      )
                    : null,
                  h(
                    'button',
                    {
                      class: 'btn sm ghost',
                      title: 'Download receipt',
                      onclick: async (event) => {
                        event.stopPropagation();
                        try {
                          const fullPayment = await api.paymentReceipt(row.id);
                          await downloadReceipt(fullPayment, { gymName: getGymName() });
                        } catch (err) {
                          toast(err.message || 'Could not load receipt details', 'error');
                        }
                      },
                    },
                    renderIcon('download', { size: 15 }),
                  ),
                  session.can('admin')
                    ? h(
                        'button',
                        {
                          class: 'btn sm danger',
                          onclick: (event) => {
                            event.stopPropagation();
                            confirmDialog({
                              title: 'Delete this payment?',
                              message: `${money(row.amount)} from ${fullName(row)} on ${date(row.paid_on)} will be removed and the member's balance will go back up.`,
                              confirmLabel: 'Delete payment',
                              danger: true,
                              onConfirm: async () => {
                                await api.deletePayment(row.id);
                                toast('Payment deleted');
                                await render();
                              },
                            });
                          },
                        },
                        'Delete',
                      )
                    : null,
                ),
            },
          ],
          items,
          { empty: 'No payments in this range' },
        ),
      ),
    );
  }

  const dateFrom = dateField({
    onchange: (event) => {
      state.from = event.target.value;
      render();
    },
  });
  const dateTo = dateField({
    onchange: (event) => {
      state.to = event.target.value;
      render();
    },
  });

  const toolbar = h('div', { class: 'toolbar bill-toolbar' });

  async function render() {
    closeRowMenu?.();
    clear(toolbar).append(
      tabs,
      h('div', { style: 'flex:1' }),
      ...(state.tab === 'memberships'
        ? [filterControl]
        : [labelledControl('From', dateFrom), labelledControl('to', dateTo)]),
    );
    clear(body).append(h('div', { class: 'empty' }, 'Loading…'));
    const view = state.tab === 'memberships' ? await renderMemberships() : await renderPayments();
    clear(body).append(view);
  }

  await render();
  return h('div', {}, toolbar, body);
}
