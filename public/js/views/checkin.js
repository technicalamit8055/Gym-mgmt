import { api } from '../api.js';
import { clear, date, fullName, h, initials, table, time, toast, today } from '../ui.js';

/* ── WebAuthn browser helpers (base64url ↔ ArrayBuffer) ────────────── */

function base64urlToBuffer(base64url) {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = base64.length % 4 === 0 ? '' : '='.repeat(4 - (base64.length % 4));
  const binary = atob(base64 + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function bufferToBase64url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function supportsWebAuthn() {
  return Boolean(window.PublicKeyCredential);
}

export async function renderCheckIn({ setActions }) {
  const feedback = h('div', {});
  const recent = h('div', {});
  const openList = h('div', {});

  const input = h('input', { placeholder: 'Member code, e.g. GM0007', autocomplete: 'off' });

  async function refreshLists() {
    const [{ items: visits }, { items: open }] = await Promise.all([
      api.attendance({ date: today(), limit: 60 }),
      api.attendance({ open: 'true', date: today(), limit: 40 }),
    ]);

    clear(recent).append(
      table(
        [
          { label: 'Member', render: (row) => h('a', { href: `#/members/${row.member_id}` }, fullName(row)) },
          { label: 'Code', render: (row) => h('span', { class: 'muted' }, row.member_code) },
          { label: 'In', render: (row) => time(row.check_in.slice(11)) },
          {
            label: 'Out',
            render: (row) =>
              row.check_out
                ? time(row.check_out.slice(11))
                : h(
                    'button',
                    {
                      class: 'btn sm',
                      onclick: async (event) => {
                        event.stopPropagation();
                        await api.checkOut({ attendance_id: row.id });
                        toast('Checked out');
                        refreshLists();
                      },
                    },
                    'Check out',
                  ),
          },
          { label: 'Via', render: (row) => h('span', { class: `badge ${row.source === 'biometric' ? 'violet' : 'grey'}` }, row.source) },
        ],
        visits,
        { empty: 'No check-ins yet today' },
      ),
    );

    clear(openList).append(
      open.length
        ? h(
            'div',
            { class: 'list' },
            ...open.map((visit) =>
              h(
                'div',
                { class: 'list-item' },
                h('div', { class: 'avatar' }, initials(visit.first_name, visit.last_name)),
                h(
                  'div',
                  {},
                  h('div', { style: 'font-weight:600' }, fullName(visit)),
                  h('div', { class: 'muted', style: 'font-size:12px' }, `in since ${time(visit.check_in.slice(11))}`),
                ),
                h('div', { class: 'spacer' }),
                h(
                  'button',
                  {
                    class: 'btn sm',
                    onclick: async () => {
                      await api.checkOut({ attendance_id: visit.id });
                      toast(`${visit.first_name} checked out`);
                      refreshLists();
                    },
                  },
                  'Check out',
                ),
              ),
            ),
          )
        : h('div', { class: 'empty' }, 'Nobody is in the gym right now'),
    );
  }

  function showResult(result) {
    const visit = result.visit;
    const membership = result.membership;
    clear(feedback).append(
      h(
        'div',
        { class: 'checkin-result ok' },
        h('div', { class: 'row', style: 'gap:12px' }, h('div', { class: 'avatar lg' }, initials(visit.first_name, visit.last_name)),
          h(
            'div',
            {},
            h('div', { style: 'font-size:18px;font-weight:700' }, fullName(visit)),
            h(
              'div',
              { class: 'muted', style: 'font-size:13px' },
              result.already_in
                ? `Already checked in at ${time(visit.check_in.slice(11))}`
                : `Checked in at ${time(visit.check_in.slice(11))}`,
            ),
            membership
              ? h(
                  'div',
                  { style: 'margin-top:6px' },
                  h('span', { class: 'badge green' }, `Valid until ${date(membership.end_date)}`),
                  membership.sessions_left !== null && membership.sessions_left !== undefined
                    ? h('span', { class: 'badge blue', style: 'margin-left:6px' }, `${membership.sessions_left} sessions left`)
                    : null,
                )
              : null,
          ),
        ),
      ),
    );
    toast(result.already_in ? 'Already checked in' : `Welcome, ${visit.first_name}`);
    refreshLists();
  }

  function showError(err) {
    clear(feedback).append(
      h(
        'div',
        { class: 'checkin-result bad' },
        h('div', { style: 'font-weight:600;margin-bottom:4px' }, '⛔ Cannot check in'),
        h('div', { class: 'muted' }, err.message),
      ),
    );
    toast(err.message, 'error');
  }

  async function submit() {
    const code = input.value.trim();
    if (!code) return;
    input.value = '';

    try {
      const result = await api.checkIn({ code });
      showResult(result);
    } catch (err) {
      showError(err);
    }
    input.focus();
  }

  /* ── Biometric check-in flow ──────────────────────────────────────── */

  async function biometricCheckIn(button) {
    if (!supportsWebAuthn()) {
      toast('Biometrics not supported on this device', 'error');
      return;
    }

    button.disabled = true;
    button.classList.add('scanning');
    const originalText = button.innerHTML;
    button.innerHTML = '<span class="bio-pulse"></span> Scanning…';

    try {
      // 1. Get authentication options from server
      const { options, sessionKey } = await api.biometricAuthOptions();

      // 2. Prepare the PublicKeyCredentialRequestOptions
      const publicKey = {
        challenge: base64urlToBuffer(options.challenge),
        timeout: options.timeout || 60000,
        rpId: options.rpId,
        userVerification: options.userVerification || 'preferred',
      };

      if (options.allowCredentials && options.allowCredentials.length > 0) {
        publicKey.allowCredentials = options.allowCredentials.map((c) => ({
          id: base64urlToBuffer(c.id),
          type: c.type,
          transports: c.transports,
        }));
      }

      // 3. Prompt the user for biometric
      const assertion = await navigator.credentials.get({ publicKey });

      // 4. Package the response for the server
      const credential = {
        id: assertion.id,
        rawId: bufferToBase64url(assertion.rawId),
        type: assertion.type,
        response: {
          authenticatorData: bufferToBase64url(assertion.response.authenticatorData),
          clientDataJSON: bufferToBase64url(assertion.response.clientDataJSON),
          signature: bufferToBase64url(assertion.response.signature),
          userHandle: assertion.response.userHandle
            ? bufferToBase64url(assertion.response.userHandle)
            : undefined,
        },
        clientExtensionResults: assertion.getClientExtensionResults(),
        authenticatorAttachment: assertion.authenticatorAttachment,
      };

      // 5. Verify on server and perform check-in
      const result = await api.biometricAuthVerify({ sessionKey, credential });
      showResult(result);
    } catch (err) {
      if (err.name === 'NotAllowedError') {
        toast('Biometric scan cancelled', 'info');
      } else {
        showError(err);
      }
    } finally {
      button.disabled = false;
      button.classList.remove('scanning');
      button.innerHTML = originalText;
    }
  }

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submit();
  });

  setActions(h('a', { class: 'btn', href: '#/members' }, 'Find a member'));
  await refreshLists();
  setTimeout(() => input.focus(), 50);

  /* ── Build the biometric check-in card ────────────────────────────── */

  const bioButton = h(
    'button',
    {
      class: 'btn bio-btn primary block',
      onclick: function () { biometricCheckIn(this); },
    },
    h('span', { class: 'bio-icon' }, '🔒'),
    'Biometric Check-in',
  );

  const bioCard = supportsWebAuthn()
    ? h(
        'div',
        { class: 'card bio-card' },
        h('h3', {}, 'Fingerprint or face scan'),
        h('p', { class: 'muted', style: 'font-size:13px;margin:0 0 14px' }, 'Member scans their enrolled biometric on this device to check in instantly.'),
        bioButton,
      )
    : h(
        'div',
        { class: 'card bio-card bio-unsupported' },
        h('h3', {}, 'Biometric Check-in'),
        h('p', { class: 'muted', style: 'font-size:13px;margin:0' }, '⚠ WebAuthn is not supported on this browser. Use a modern browser with HTTPS to enable biometric check-ins.'),
      );

  return h(
    'div',
    { class: 'grid cols-2' },
    h(
      'div',
      { class: 'grid', style: 'gap:16px;align-content:start' },
      h(
        'div',
        { class: 'card checkin-box' },
        h('h3', {}, 'Scan or type a member code'),
        input,
        h('button', { class: 'btn primary block', style: 'margin-top:12px', onclick: submit }, 'Check in'),
        feedback,
      ),
      bioCard,
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, 'In the gym now')), openList),
    ),
    h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, "Today's check-ins")), recent),
  );
}
