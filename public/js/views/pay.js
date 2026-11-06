import { api } from '../api.js';
import { openPaySheet } from '../upiPay.js';
import { h, renderIcon } from '../ui.js';

/**
 * A pay link from a WhatsApp reminder (`#/pay?token=…`). Public: the member
 * may not have the app, or be signed in on this phone. The token names one
 * payment and is the only credential, so the page shows only that payment.
 *
 * The token sits in the hash, like a password-reset link's, so it never
 * reaches the server's access logs.
 */
function tokenFromHash(hash = window.location.hash) {
  const queryStart = hash.indexOf('?');
  if (queryStart === -1) return '';
  return new URLSearchParams(hash.slice(queryStart + 1)).get('token') || '';
}

export async function renderPay({ context }) {
  const gymName = context?.tenant?.gym_name || 'GymBook';
  const logoUrl = context?.tenant?.logo_url;
  const heading = h(
    'h1',
    {},
    logoUrl ? h('img', { class: 'login-logo-img', src: logoUrl, alt: gymName }) : h('span', { class: 'login-logo-mark' }, renderIcon('wallet', { size: 22 })),
    gymName,
  );
  const card = (...children) => h('div', { class: 'login' }, h('div', { class: 'login-card upipay-page' }, heading, ...children));

  const token = tokenFromHash();
  if (!token) return card(h('p', { class: 'login-notice' }, 'This payment link is incomplete. Open the full link from your message.'));

  let sheet;
  try {
    sheet = await api.payLink(token);
  } catch (err) {
    return card(h('p', { class: 'login-notice' }, err.status === 404 ? 'This payment link is not valid any more. Ask the front desk for a new one.' : err.message || 'Could not open this payment.'));
  }

  return card(
    sheet.first_name ? h('p', { class: 'sub' }, `Hi ${sheet.first_name} 👋`) : null,
    openPaySheet({ sheet, claim: (utr) => api.claimPayLink(token, utr), inline: true }),
  );
}
