import { clear, date, fullName, h, money, today } from './ui.js';

/**
 * Payment receipt: a clean, printer-friendly document rendered into #print-root
 * using the same body.printing mechanism as QR ID cards.
 *
 * `printReceipt(data, { gymName })` builds and prints a single receipt.
 *
 * `data` is a payment object with at least:
 *   id, amount, method, paid_on, reference, note,
 *   member_code, first_name, last_name,
 *   plan_name (optional), start_date (optional), end_date (optional),
 *   price (optional), discount (optional)
 *
 * For the "print right after save" flow, we synthesize this object from form
 * values + the API response rather than making an extra fetch.
 */

function receiptNode(data, { gymName = 'GymBook' } = {}) {
  const memberName = data.first_name
    ? fullName(data)
    : data.member_name || 'Member';

  const now = new Date();
  const timestamp = now.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  return h(
    'div',
    { class: 'receipt' },

    /* ── header ─────────────────────────────────────────────────────── */
    h('div', { class: 'receipt-header' },
      h('div', { class: 'receipt-gym' }, gymName),
      h('div', { class: 'receipt-title' }, 'Payment Receipt'),
    ),

    h('div', { class: 'receipt-divider' }),

    /* ── member info ───────────────────────────────────────────────── */
    h('div', { class: 'receipt-section' },
      h('div', { class: 'receipt-section-title' }, 'Member'),
      h('div', { class: 'receipt-row' },
        h('span', { class: 'receipt-label' }, 'Name'),
        h('span', { class: 'receipt-value' }, memberName),
      ),
      data.member_code ? h('div', { class: 'receipt-row' },
        h('span', { class: 'receipt-label' }, 'Code'),
        h('span', { class: 'receipt-value' }, data.member_code),
      ) : null,
      data.phone ? h('div', { class: 'receipt-row' },
        h('span', { class: 'receipt-label' }, 'Phone'),
        h('span', { class: 'receipt-value' }, data.phone),
      ) : null,
    ),

    h('div', { class: 'receipt-divider' }),

    /* ── payment info ──────────────────────────────────────────────── */
    h('div', { class: 'receipt-section' },
      h('div', { class: 'receipt-section-title' }, 'Payment Details'),
      h('div', { class: 'receipt-row' },
        h('span', { class: 'receipt-label' }, 'Receipt #'),
        h('span', { class: 'receipt-value' }, data.id ? `PAY-${String(data.id).padStart(5, '0')}` : '—'),
      ),
      h('div', { class: 'receipt-row' },
        h('span', { class: 'receipt-label' }, 'Date'),
        h('span', { class: 'receipt-value' }, date(data.paid_on || today())),
      ),
      h('div', { class: 'receipt-row' },
        h('span', { class: 'receipt-label' }, 'Method'),
        h('span', { class: 'receipt-value receipt-method' }, String(data.method || 'cash').toUpperCase()),
      ),
      data.reference ? h('div', { class: 'receipt-row' },
        h('span', { class: 'receipt-label' }, 'Reference'),
        h('span', { class: 'receipt-value' }, data.reference),
      ) : null,
      data.note ? h('div', { class: 'receipt-row' },
        h('span', { class: 'receipt-label' }, 'Note'),
        h('span', { class: 'receipt-value' }, data.note),
      ) : null,
    ),

    /* ── plan info (if linked to a subscription) ───────────────────── */
    data.plan_name ? h('div', {},
      h('div', { class: 'receipt-divider' }),
      h('div', { class: 'receipt-section' },
        h('div', { class: 'receipt-section-title' }, 'Membership'),
        h('div', { class: 'receipt-row' },
          h('span', { class: 'receipt-label' }, 'Plan'),
          h('span', { class: 'receipt-value' }, data.plan_name),
        ),
        data.start_date && data.end_date ? h('div', { class: 'receipt-row' },
          h('span', { class: 'receipt-label' }, 'Period'),
          h('span', { class: 'receipt-value' }, `${date(data.start_date)} → ${date(data.end_date)}`),
        ) : null,
        data.price != null ? h('div', { class: 'receipt-row' },
          h('span', { class: 'receipt-label' }, 'Plan price'),
          h('span', { class: 'receipt-value' }, money(data.price)),
        ) : null,
        data.discount ? h('div', { class: 'receipt-row' },
          h('span', { class: 'receipt-label' }, 'Discount'),
          h('span', { class: 'receipt-value' }, `− ${money(data.discount)}`),
        ) : null,
      ),
    ) : null,

    h('div', { class: 'receipt-divider thick' }),

    /* ── total ──────────────────────────────────────────────────────── */
    h('div', { class: 'receipt-total' },
      h('span', {}, 'Amount Paid'),
      h('span', {}, money(data.amount)),
    ),

    h('div', { class: 'receipt-divider' }),

    /* ── footer ─────────────────────────────────────────────────────── */
    h('div', { class: 'receipt-footer' },
      h('div', {}, 'Thank you for your payment!'),
      h('div', { class: 'receipt-timestamp' }, `Printed on ${timestamp}`),
    ),
  );
}

/**
 * Prints a payment receipt using the same #print-root mechanism as QR cards.
 *
 * @param {object} data - Payment data (see receiptNode for shape)
 * @param {object} opts
 * @param {string} opts.gymName - The gym's display name
 */
export function printReceipt(data, { gymName } = {}) {
  const root = document.getElementById('print-root');
  if (!root) return;

  clear(root).append(h('div', { class: 'receipt-page' }, receiptNode(data, { gymName })));
  document.body.classList.add('printing');

  const cleanup = () => {
    document.body.classList.remove('printing');
    clear(root);
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);

  requestAnimationFrame(() => {
    window.print();
    setTimeout(cleanup, 1000);
  });
}

/**
 * Returns the gym name from the platform context cached in the DOM's title bar
 * brand element — avoids an extra API call and import cycle.
 */
export function getGymName() {
  const brand = document.querySelector('.brand');
  return brand?.textContent?.trim() || 'GymBook';
}
