import { api } from '../api.js';
import { buildForm, clear, closeModal, confirmDialog, date, h, money, openModal, renderIcon, toast } from '../ui.js';

/**
 * Billing → To confirm (and CoachBook Fees → To confirm): payments members
 * made from the app to the gym's own UPI ID and said "I've paid" for.
 *
 * A plain UPI ID tells the server nothing, so someone checks the gym's UPI
 * app or bank statement for the amount and the reference (it is in the
 * payment note) and confirms. Confirming creates the membership or payment
 * and sends the usual receipt; rejecting tells the member it wasn't found.
 */

const STATUS = {
  claimed: ['amber', 'To confirm'],
  confirmed: ['green', 'Confirmed'],
  rejected: ['red', 'Rejected'],
  pending: ['grey', 'Not paid yet'],
  expired: ['grey', 'Expired'],
};

export async function paymentQueuePane({ onChanged } = {}) {
  const state = { status: 'claimed' };
  const host = h('div', { class: 'payq' });

  async function paint() {
    let data;
    try {
      data = await api.onlinePayments.requests({ status: state.status });
    } catch (err) {
      clear(host).append(h('div', { class: 'card' }, h('p', { class: 'muted' }, err.message)));
      return;
    }
    const filters = h(
      'div',
      { class: 'payq-filters' },
      ...[
        ['claimed', `To confirm${data.claimed ? ` (${data.claimed})` : ''}`],
        ['confirmed', 'Confirmed'],
        ['rejected', 'Rejected'],
        ['all', 'All'],
      ].map(([key, label]) =>
        h(
          'button',
          {
            type: 'button',
            class: `btn sm${state.status === key ? ' primary' : ' ghost'}`,
            onclick: () => {
              state.status = key;
              paint();
            },
          },
          label,
        ),
      ),
    );

    const rows = data.items.map((r) => row(r));
    clear(host).append(
      h(
        'div',
        { class: 'card' },
        h(
          'div',
          { class: 'payq-head' },
          h('div', {}, h('h3', {}, 'Online payments'), h('p', { class: 'muted' }, 'Check your UPI app for the amount and reference, then confirm.')),
          filters,
        ),
        rows.length
          ? h('div', { class: 'payq-list' }, ...rows)
          : h(
              'div',
              { class: 'empty' },
              state.status === 'claimed' ? 'Nothing to confirm — payments members make from the app show up here.' : 'No payments here yet.',
            ),
      ),
    );
  }

  function row(r) {
    const [tone, label] = STATUS[r.status] || ['grey', r.status];
    const name = [r.first_name, r.last_name].filter(Boolean).join(' ');
    const actions =
      r.status === 'claimed' || r.status === 'expired' || r.status === 'pending'
        ? h(
            'div',
            { class: 'payq-actions' },
            h('button', { class: 'btn sm primary', type: 'button', onclick: () => confirm(r) }, renderIcon('check', { size: 15 }), 'Confirm'),
            r.status === 'claimed' ? h('button', { class: 'btn sm ghost', type: 'button', onclick: () => reject(r) }, 'Reject') : null,
          )
        : null;
    return h(
      'div',
      { class: `payq-row is-${r.status}` },
      h(
        'div',
        { class: 'payq-who' },
        h('strong', {}, name || r.member_code),
        h('small', { class: 'muted' }, `${r.member_code} · ${r.title}`),
      ),
      h(
        'div',
        { class: 'payq-ref' },
        h('span', {}, 'Ref ', h('b', {}, r.ref_code)),
        r.utr ? h('span', {}, 'UTR ', h('b', {}, r.utr)) : h('span', { class: 'muted' }, 'No UTR given'),
        h('small', { class: 'muted' }, r.claimed_at ? `Paid ${date(r.claimed_at.slice(0, 10))}` : `Started ${date(r.created_at.slice(0, 10))}`),
      ),
      h('div', { class: 'payq-amount' }, money(r.amount)),
      h('span', { class: `badge ${tone}` }, label),
      actions,
      r.reject_reason ? h('small', { class: 'payq-reason muted' }, r.reject_reason) : null,
    );
  }

  function confirm(r) {
    confirmDialog({
      title: `Confirm ${money(r.amount)} from ${r.first_name || r.member_code}?`,
      message: `Only confirm once you can see ${money(r.amount)} in your UPI app or bank${r.utr ? ` with UTR ${r.utr}` : ''} (note: ${r.ref_code}). This records the payment${r.kind === 'membership' ? ' and starts the membership' : ''} and sends the receipt.`,
      confirmLabel: 'Confirm payment',
      onConfirm: async () => {
        await api.onlinePayments.confirm(r.id);
        toast('Payment confirmed');
        await paint();
        onChanged?.();
      },
    });
  }

  function reject(r) {
    const form = buildForm(
      [{ name: 'reason', label: 'Tell the member why (optional)', value: '', placeholder: 'e.g. Not received in our account', full: true }],
      {
        submitLabel: 'Reject payment',
        onSubmit: async (values) => {
          await api.onlinePayments.reject(r.id, values.reason || '');
          closeModal();
          toast('Payment rejected — the member has been told');
          await paint();
          onChanged?.();
        },
      },
    );
    openModal({ title: `Reject ${money(r.amount)} from ${r.first_name || r.member_code}?`, body: form });
  }

  await paint();
  return host;
}

/** How many are waiting, for a tab badge. Null when this person cannot see the queue. */
export async function claimedPaymentCount() {
  try {
    return (await api.onlinePayments.requests({ status: 'claimed' })).claimed;
  } catch {
    return null;
  }
}
