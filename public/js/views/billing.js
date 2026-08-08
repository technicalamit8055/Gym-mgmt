import { api, session } from '../api.js';
import {
  clear,
  confirmDialog,
  date,
  expiryLabel,
  fullName,
  h,
  labelledControl,
  money,
  personCell,
  statusBadge,
  table,
  toast,
} from '../ui.js';
import { openMembershipForm, openPaymentForm } from './forms.js';
import { downloadReceipt, getGymName, printReceipt } from '../receipt.js';

export async function renderBilling({ setActions, reload }) {
  const state = { tab: 'memberships', filter: 'active', from: '', to: '' };
  const body = h('div', {});

  setActions(
    h('button', { class: 'btn', onclick: () => api.download('payments').catch((e) => toast(e.message, 'error')) }, '⇩ Export payments'),
    session.managesBilling
      ? h('button', { class: 'btn', onclick: () => openPaymentForm({ onSaved: reload }) }, '💳 Record payment')
      : null,
    session.managesBilling
      ? h('button', { class: 'btn primary', onclick: () => openMembershipForm({ onSaved: reload }) }, '＋ Sell membership')
      : null,
  );

  const tabs = h(
    'div',
    { class: 'pill-row' },
    ...[
      ['memberships', 'Memberships'],
      ['payments', 'Payments'],
    ].map(([key, label]) =>
      h(
        'button',
        {
          class: `btn sm ${state.tab === key ? 'primary' : 'ghost'}`,
          dataset: { tab: key },
          onclick: () => {
            state.tab = key;
            for (const button of tabs.children) {
              button.className = `btn sm ${button.dataset.tab === key ? 'primary' : 'ghost'}`;
            }
            render();
          },
        },
        label,
      ),
    ),
  );

  const filterSelect = h(
    'select',
    {
      onchange: (event) => {
        state.filter = event.target.value;
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

  async function renderMemberships() {
    const params = { limit: 200 };
    if (state.filter === 'expiring') params.expiring_in = 7;
    else if (state.filter === 'due') params.due = 'true';
    else if (state.filter) params.status = state.filter;

    const { items } = await api.subscriptions(params);
    const totals = items.reduce(
      (acc, row) => ({
        value: acc.value + (row.price - row.discount),
        paid: acc.paid + row.paid,
        due: acc.due + Math.max(row.due, 0),
      }),
      { value: 0, paid: 0, due: 0 },
    );

    return h(
      'div',
      { class: 'grid', style: 'gap:16px' },
      h(
        'div',
        { class: 'grid cols-4' },
        h('div', { class: 'card stat' }, h('div', { class: 'label' }, 'Memberships listed'), h('div', { class: 'value' }, items.length)),
        h('div', { class: 'card stat' }, h('div', { class: 'label' }, 'Contract value'), h('div', { class: 'value' }, money(totals.value, { compact: true }))),
        h('div', { class: 'card stat' }, h('div', { class: 'label' }, 'Collected'), h('div', { class: 'value' }, money(totals.paid, { compact: true }))),
        h(
          'div',
          { class: 'card stat accent' },
          h('div', { class: 'label' }, 'Outstanding'),
          h('div', { class: 'value', style: totals.due ? 'color:var(--red)' : '' }, money(totals.due, { compact: true })),
        ),
      ),
      h(
        'div',
        { class: 'card', style: 'padding:6px 6px 14px' },
        table(
          [
            {
              label: 'Member',
              render: (row) => h('a', { href: `#/members/${row.member_id}` }, personCell(row)),
            },
            { label: 'Plan', render: (row) => row.plan_name },
            { label: 'Period', render: (row) => h('div', {}, h('div', {}, `${date(row.start_date)} → ${date(row.end_date)}`), row.status === 'active' ? expiryLabel(row.end_date) : statusBadge(row.status)) },
            { label: 'Value', align: 'right', render: (row) => money(row.price - row.discount) },
            { label: 'Paid', align: 'right', render: (row) => money(row.paid) },
            {
              label: 'Due',
              align: 'right',
              render: (row) => (row.due > 0 ? h('span', { class: 'badge red' }, money(row.due)) : h('span', { class: 'muted' }, '—')),
            },
            {
              label: '',
              render: (row) =>
                h(
                  'div',
                  { class: 'row', style: 'gap:6px;justify-content:flex-end' },
                  session.managesBilling && row.due > 0
                    ? h(
                        'button',
                        {
                          class: 'btn sm',
                          onclick: async (event) => {
                            event.stopPropagation();
                            const member = await api.member(row.member_id);
                            openPaymentForm({ member, subscriptions: member.subscriptions, onSaved: render });
                          },
                        },
                        'Collect',
                      )
                    : null,
                  session.managesBilling
                    ? h(
                        'button',
                        {
                          class: 'btn sm ghost',
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
                        '💬 Remind',
                      )
                    : null,
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
      { class: 'grid', style: 'gap:16px' },
      h(
        'div',
        { class: 'grid cols-4' },
        h('div', { class: 'card stat accent' }, h('div', { class: 'label' }, 'Total collected'), h('div', { class: 'value' }, money(totals.amount, { compact: true })), h('div', { class: 'hint' }, `${totals.count} payments`)),
        ...Object.entries(byMethod)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([method, amount]) =>
            h('div', { class: 'card stat' }, h('div', { class: 'label', style: 'text-transform:uppercase' }, method), h('div', { class: 'value' }, money(amount, { compact: true }))),
          ),
      ),
      h(
        'div',
        { class: 'card', style: 'padding:6px 6px 14px' },
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
                    '🖨️ Print',
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
                        '💬 Receipt',
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
                    '⬇️',
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

  const dateFrom = h('input', {
    type: 'date',
    style: 'width:auto',
    onchange: (event) => {
      state.from = event.target.value;
      render();
    },
  });
  const dateTo = h('input', {
    type: 'date',
    style: 'width:auto',
    onchange: (event) => {
      state.to = event.target.value;
      render();
    },
  });

  const toolbar = h('div', { class: 'toolbar' });

  async function render() {
    clear(toolbar).append(
      tabs,
      h('div', { style: 'flex:1' }),
      ...(state.tab === 'memberships'
        ? [filterSelect]
        : [labelledControl('From', dateFrom), labelledControl('to', dateTo)]),
    );
    clear(body).append(h('div', { class: 'empty' }, 'Loading…'));
    const view = state.tab === 'memberships' ? await renderMemberships() : await renderPayments();
    clear(body).append(view);
  }

  await render();
  return h('div', {}, toolbar, body);
}
