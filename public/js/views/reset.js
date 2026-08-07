import { api } from '../api.js';
import { h, toast } from '../ui.js';

/**
 * Setting a new password from a reset link.
 *
 * A public route, so it renders full-page with no app shell: whoever opens this
 * cannot sign in, and there is no gym navigation to show them.
 *
 * The token arrives in the hash (`#/reset?token=…`) rather than the query
 * string, because the hash is where this app's router lives and — usefully —
 * a hash is never sent to the server, so the link stays out of access logs.
 */

/** Pulls `token` out of a hash route's own query part. */
function tokenFromHash(hash = window.location.hash) {
  const queryStart = hash.indexOf('?');
  if (queryStart === -1) return '';
  return new URLSearchParams(hash.slice(queryStart + 1)).get('token') || '';
}

const MIN_LENGTH = 8;

export async function renderReset({ context, navigate }) {
  const gymNameStr = context?.tenant?.gym_name || 'GymBook';
  const logoUrl = context?.tenant?.logo_url;
  const logoNode = logoUrl
    ? h('img', { class: 'login-logo-img', src: logoUrl, alt: gymNameStr })
    : '🏋️';
  const heading = h('h1', {}, logoNode, gymNameStr);
  const token = tokenFromHash();

  const card = (...children) => h('div', { class: 'login' }, h('div', { class: 'login-card' }, ...children));

  const deadEnd = (title, detail) =>
    card(
      heading,
      h('p', { class: 'sub' }, title),
      h('p', { class: 'login-notice' }, detail),
      h(
        'div',
        { class: 'row', style: 'margin-top:16px;justify-content:center' },
        h('button', { class: 'btn sm ghost', onclick: () => navigate('/dashboard') }, 'Back to sign in'),
      ),
    );

  if (!token) {
    return deadEnd(
      'That link is incomplete.',
      'The address is missing its reset token. Use the full link exactly as it was given to you.',
    );
  }

  // Checked before asking for a password, so an expired link says so up front
  // rather than after someone has typed a new password twice.
  let valid = false;
  try {
    ({ valid } = await api.checkPasswordReset(token));
  } catch {
    valid = false;
  }
  if (!valid) {
    return deadEnd(
      'That link has expired or has already been used.',
      'Reset links work once and last an hour. Ask whoever issued it for a fresh one.',
    );
  }

  const password = h('input', {
    class: 'input',
    type: 'password',
    required: true,
    autocomplete: 'new-password',
    placeholder: `At least ${MIN_LENGTH} characters`,
  });
  const confirm = h('input', {
    class: 'input',
    type: 'password',
    required: true,
    autocomplete: 'new-password',
  });
  const error = h('p', { class: 'field-error', style: 'display:none' });
  const submit = h('button', { class: 'btn primary block', type: 'submit' }, 'Set new password');

  const fail = (message) => {
    error.textContent = message;
    error.style.display = '';
    submit.disabled = false;
  };

  const form = h(
    'form',
    {
      onsubmit: async (event) => {
        event.preventDefault();
        error.style.display = 'none';
        submit.disabled = true;

        if (password.value.length < MIN_LENGTH) return fail(`Use at least ${MIN_LENGTH} characters.`);
        if (password.value !== confirm.value) return fail('Those two passwords do not match.');

        try {
          await api.resetPassword(token, password.value);
        } catch (err) {
          return fail(err.message || 'Could not set that password.');
        }
        toast('Password updated — sign in with it now');
        // Navigating away drops the spent token out of the address bar.
        navigate('/dashboard');
        return undefined;
      },
    },
    h('label', { class: 'field full' }, h('span', {}, 'New password'), password),
    h('label', { class: 'field full' }, h('span', {}, 'Confirm new password'), confirm),
    error,
    submit,
  );

  return card(
    h('h1', {}, heading),
    h('p', { class: 'sub' }, 'Choose a new password for your account.'),
    form,
  );
}
