/**
 * Razorpay Checkout, for the member app's in-app payments (the Diet & Workout
 * add-on and the store).
 *
 * The server opens the Razorpay order and decides the amount; this only shows
 * Razorpay's own payment sheet against it and hands back what Checkout
 * reported, for the server to verify. Nothing here is trusted on its own.
 *
 * The script is fetched on first use rather than in index.html: most members
 * never pay in the app, and a third-party script on every page load would cost
 * them all for the few who do.
 */

const SCRIPT_URL = 'https://checkout.razorpay.com/v1/checkout.js';
let loading = null;

function loadCheckout() {
  if (window.Razorpay) return Promise.resolve();
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT_URL;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      loading = null;
      script.remove();
      reject(new Error('Could not open the payment window. Check your internet connection and try again.'));
    };
    document.head.append(script);
  });
  return loading;
}

/** Thrown when the member closes the sheet without paying — not an error to
 * shout about, so callers can tell it apart and stay quiet. */
export class PaymentCancelled extends Error {
  constructor(message = 'Payment cancelled') {
    super(message);
    this.cancelled = true;
  }
}

/**
 * Opens Checkout for one server-created order, UPI first.
 *
 * Resolves with { razorpay_order_id, razorpay_payment_id, razorpay_signature }
 * — exactly the fields the verify endpoints expect — and rejects with
 * PaymentCancelled if the sheet is closed. A failed attempt keeps the sheet
 * open for a retry (Razorpay's own behaviour); its reason is only surfaced if
 * the member then gives up.
 */
export async function payWithRazorpay(checkout) {
  await loadCheckout();
  const brand = getComputedStyle(document.body).getPropertyValue('--brand').trim() || '#f97316';

  return new Promise((resolve, reject) => {
    let lastFailure = null;
    const rzp = new window.Razorpay({
      key: checkout.key_id,
      order_id: checkout.order_id,
      amount: checkout.amount,
      currency: checkout.currency,
      name: checkout.name,
      description: checkout.description,
      prefill: checkout.prefill,
      theme: { color: brand },
      config: {
        display: {
          blocks: { upi: { name: 'Pay with UPI', instruments: [{ method: 'upi' }] } },
          sequence: ['block.upi'],
          preferences: { show_default_blocks: true },
        },
      },
      handler: (response) =>
        resolve({
          razorpay_order_id: response.razorpay_order_id,
          razorpay_payment_id: response.razorpay_payment_id,
          razorpay_signature: response.razorpay_signature,
        }),
      modal: {
        confirm_close: true,
        ondismiss: () => reject(new PaymentCancelled(lastFailure ?? 'Payment cancelled')),
      },
    });
    rzp.on('payment.failed', (res) => {
      lastFailure = res?.error?.description || 'The payment did not go through';
    });
    rzp.open();
  });
}
