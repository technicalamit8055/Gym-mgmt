import { clear, closeModal, h, money, openModal, renderIcon, toast } from './ui.js';

/**
 * The pay sheet: paying the gym's own UPI ID for a renewal, dues or a fee
 * installment. Shared by GymVym (views/portal.js), the CoachBook app
 * (views/portalCoaching.js) and the no-sign-in pay link (views/pay.js) —
 * each hands in how to load and claim its request, the sheet does the rest.
 *
 * A UPI ID has no callback to say the money arrived, so after paying the
 * member taps "I've paid" (optionally with the 12-digit UTR) and the gym
 * confirms it. The sheet says so plainly rather than pretending it is done.
 *
 * @param {object} opts
 * @param {object} opts.sheet   The server's pay sheet (routes/onlinePayments.js paySheet).
 * @param {(utr: string|null) => Promise<object>} opts.claim  Marks it paid; resolves with the new sheet.
 * @param {() => void} [opts.onChange]  Called after a claim, so the caller can refresh its list.
 * @param {boolean} [opts.inline]  Render into the page instead of a modal (the pay link).
 */
export function openPaySheet({ sheet, claim, onChange, inline = false }) {
  const body = h('div', { class: 'upipay' });
  // DOM append() would print a null as the text "null"; h() is what skips them.
  const paint = (s) => clear(body).append(...content(s).filter(Boolean));

  function content(s) {
    if (s.status === 'claimed') {
      return [
        statusBlock('info', 'Waiting for confirmation', `${s.payee_name} will check the payment and confirm it — usually within a few hours. You'll get a notification.`),
        facts(s),
      ];
    }
    if (s.status === 'confirmed') {
      return [statusBlock('checkCircle', 'Payment received', `Thank you! ${money(s.amount)} for ${s.title.toLowerCase()} is confirmed.`, 'ok'), facts(s)];
    }
    if (s.status === 'rejected') {
      return [
        statusBlock('xCircle', 'Payment not found', `${s.payee_name} could not find this payment.${s.reject_reason ? ` "${s.reject_reason}"` : ''} Please contact the front desk with your UPI reference.`, 'bad'),
        facts(s),
      ];
    }
    if (s.status === 'expired' || !s.upi_uri) {
      return [statusBlock('alert', 'This payment has expired', 'Start it again from the app to get a fresh payment.', 'bad')];
    }
    return payable(s);
  }

  function payable(s) {
    const mobile = /Android|iPhone|iPad/i.test(navigator.userAgent);
    const utr = h('input', {
      class: 'upipay-utr',
      inputmode: 'numeric',
      autocomplete: 'off',
      maxlength: '14',
      placeholder: '12-digit UPI reference (optional)',
      'aria-label': 'UPI reference number (UTR)',
    });
    const paidBtn = h('button', { class: 'btn primary upipay-paid', type: 'button' }, "I've paid");
    paidBtn.addEventListener('click', async () => {
      const value = utr.value.replace(/\s+/g, '');
      if (value && !/^\d{12}$/.test(value)) {
        toast('The UPI reference is the 12-digit number your UPI app shows after paying', 'error');
        utr.focus();
        return;
      }
      paidBtn.disabled = true;
      try {
        const next = await claim(value || null);
        paint(next);
        onChange?.(next);
      } catch (err) {
        toast(err.message || 'Could not mark this payment', 'error');
        paidBtn.disabled = false;
      }
    });

    return [
      h(
        'div',
        { class: 'upipay-amount' },
        h('small', {}, s.title),
        h('strong', {}, money(s.amount)),
        h('span', {}, `to ${s.payee_name}`),
      ),
      mobile
        ? h(
            'a',
            { class: 'btn primary upipay-open', href: s.upi_uri },
            renderIcon('wallet', { size: 18 }),
            'Pay with a UPI app',
          )
        : null,
      h(
        'div',
        { class: 'upipay-qr' },
        h('img', { src: s.qr, alt: `UPI QR code to pay ${money(s.amount)}`, width: 220, height: 220 }),
        h('small', {}, mobile ? 'Or scan this from another phone' : 'Scan with any UPI app — GPay, PhonePe, Paytm, BHIM'),
      ),
      h(
        'div',
        { class: 'upipay-vpa' },
        h('span', {}, s.upi_vpa),
        h(
          'button',
          {
            class: 'btn sm ghost',
            type: 'button',
            onclick: () => copy(s.upi_vpa, 'UPI ID copied'),
          },
          'Copy',
        ),
      ),
      h('p', { class: 'upipay-ref' }, 'Reference ', h('b', {}, s.ref_code), ' — it is in the payment note, so the gym can find it.'),
      h('div', { class: 'upipay-step' }, h('label', {}, 'After paying'), utr, paidBtn),
    ];
  }

  paint(sheet);
  if (inline) return body;
  openModal({ title: sheet.status === 'pending' ? 'Pay online' : 'Your payment', icon: 'wallet', className: 'upipay-modal', body });
  return body;
}

function statusBlock(icon, title, text, tone = '') {
  return h(
    'div',
    { class: `upipay-status ${tone}` },
    h('span', { class: 'upipay-status-ico' }, renderIcon(icon, { size: 28, stroke: 2 })),
    h('h3', {}, title),
    h('p', {}, text),
  );
}

function facts(s) {
  return h(
    'dl',
    { class: 'upipay-facts' },
    h('dt', {}, 'Amount'),
    h('dd', {}, money(s.amount)),
    h('dt', {}, 'For'),
    h('dd', {}, s.title),
    h('dt', {}, 'Reference'),
    h('dd', {}, s.ref_code),
    s.utr ? h('dt', {}, 'UTR') : null,
    s.utr ? h('dd', {}, s.utr) : null,
  );
}

async function copy(text, done) {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
  } catch {
    toast(text);
  }
}

/** Starts a payment from the member app and opens its sheet. */
export async function startMemberPayment(api, payload, { onChange } = {}) {
  const sheet = await api.portal.pay.start(payload);
  return openPaySheet({ sheet, claim: (utr) => api.portal.pay.claim(sheet.id, utr), onChange });
}

/** Re-opens an existing payment (a row in "Recent online payments"). */
export async function openMemberPayment(api, id, { onChange } = {}) {
  const sheet = await api.portal.pay.get(id);
  return openPaySheet({ sheet, claim: (utr) => api.portal.pay.claim(id, utr), onChange });
}

export { closeModal };
