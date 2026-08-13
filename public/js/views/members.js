import { api, session } from '../api.js';
import {
  buildForm,
  clear,
  closeModal,
  confirmDialog,
  date,
  expiryLabel,
  fullName,
  h,
  initials,
  money,
  openModal,
  personCell,
  sourceBadge,
  statusBadge,
  table,
  time,
  toast,
  today,
} from '../ui.js';
import { openMemberForm, openMembershipForm, openPaymentForm } from './forms.js';
import { downloadCardPng, idCardNode, printCards, renderCardPngBytes } from '../qrcard.js';
import { downloadReceipt, getGymName, printReceipt } from '../receipt.js';
import { createPhotoPicker } from '../photo.js';
import { isLibrary, tl } from '../vertical.js';

/**
 * A function, not a module-level constant: every view here is statically
 * imported by app.js, so a top-level const would freeze "membership" as the
 * gym word before setVertical() ever runs. See the trap this guards against
 * in vertical.js's header comment.
 */
const filters = () => [
  { value: '', label: `All ${tl('membership')}s` },
  { value: 'active', label: `Active ${tl('membership')}` },
  { value: 'expiring', label: 'Expiring in 7 days' },
  { value: 'expired', label: 'Expired' },
  { value: 'dues', label: 'Has dues' },
  { value: 'none', label: 'Never subscribed' },
];

export async function renderMembers({ setActions, navigate }) {
  const state = { q: '', status: '', membership: '', page: 1, sort: 'name', dir: 'asc', limit: 25 };
  const container = h('div', {});
  const results = h('div', {});

  /* Ticked members carried across pages, so a print run can be assembled from
     more than one screen of results. */
  const selected = new Set();

  const printButton = h(
    'button',
    {
      class: 'btn',
      disabled: true,
      onclick: async () => {
        printButton.disabled = true;
        printButton.textContent = 'Building cards…';
        try {
          const { items } = await api.qrCards([...selected]);
          if (!items.length) throw new Error('None of the selected members could be found');
          printCards(items);
        } catch (err) {
          toast(err.message || 'Could not build the cards', 'error');
        } finally {
          syncPrintButton();
        }
      },
    },
    '🖨️ Print cards',
  );

  function syncPrintButton() {
    printButton.disabled = selected.size === 0;
    printButton.textContent = selected.size ? `🖨️ Print ${selected.size} card${selected.size === 1 ? '' : 's'}` : '🖨️ Print cards';
  }

  setActions(
    printButton,
    h('button', { class: 'btn', onclick: () => api.download('members').catch((e) => toast(e.message, 'error')) }, '⇩ Export CSV'),
    h(
      'button',
      {
        class: 'btn primary',
        onclick: () => openMemberForm({ onSaved: (saved) => navigate(`/members/${saved.id}`) }),
      },
      '＋ New member',
    ),
  );

  const search = h('input', {
    class: 'search',
    placeholder: 'Search name, code, phone or email…',
    type: 'search',
  });
  let debounce;
  search.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      state.q = search.value.trim();
      state.page = 1;
      load();
    }, 250);
  });

  const membershipSelect = h(
    'select',
    {
      onchange: (e) => {
        state.membership = e.target.value;
        state.page = 1;
        load();
      },
    },
    ...filters().map((f) => h('option', { value: f.value }, f.label)),
  );

  const statusSelect = h(
    'select',
    {
      onchange: (e) => {
        state.status = e.target.value;
        state.page = 1;
        load();
      },
    },
    h('option', { value: '' }, 'Any status'),
    h('option', { value: 'active' }, 'Active'),
    h('option', { value: 'frozen' }, 'Frozen'),
    h('option', { value: 'inactive' }, 'Inactive'),
  );

  const sortSelect = h(
    'select',
    {
      onchange: (e) => {
        const [sort, dir] = e.target.value.split(':');
        state.sort = sort;
        state.dir = dir;
        load();
      },
    },
    h('option', { value: 'name:asc' }, 'Name A–Z'),
    h('option', { value: 'joined:desc' }, 'Newest first'),
    h('option', { value: 'expiry:asc' }, 'Expiring soonest'),
    h('option', { value: 'dues:desc' }, 'Highest dues'),
    h('option', { value: 'code:asc' }, 'Member code'),
  );

  container.append(
    h('div', { class: 'toolbar' }, search, membershipSelect, statusSelect, h('div', { class: 'spacer', style: 'flex:1' }), sortSelect),
    results,
  );

  async function load() {
    clear(results).append(h('div', { class: 'empty' }, 'Loading…'));
    const data = await api.members(state);

    const selectAll = h('input', {
      type: 'checkbox',
      title: 'Select every member on this page',
      onclick: (event) => {
        for (const row of data.items) {
          if (event.target.checked) selected.add(row.id);
          else selected.delete(row.id);
        }
        syncPrintButton();
        load();
      },
    });
    selectAll.checked = data.items.length > 0 && data.items.every((row) => selected.has(row.id));

    const columns = [
      {
        label: selectAll,
        render: (row) => {
          const box = h('input', {
            type: 'checkbox',
            title: 'Select for card printing',
            // Row clicks open the member; a tick must not navigate away.
            onclick: (event) => {
              event.stopPropagation();
              if (event.target.checked) selected.add(row.id);
              else selected.delete(row.id);
              syncPrintButton();
            },
          });
          box.checked = selected.has(row.id);
          return box;
        },
      },
      { label: 'Member', render: (row) => personCell(row) },
      { label: 'Contact', render: (row) => h('div', {}, h('div', {}, row.phone || '—'), h('div', { class: 'muted', style: 'font-size:12px' }, row.email || '')) },
      { label: 'Plan', render: (row) => row.plan_name || h('span', { class: 'muted' }, 'None') },
      { label: 'Expiry', render: (row) => (row.membership_end ? h('div', {}, h('div', {}, date(row.membership_end)), expiryLabel(row.membership_end)) : expiryLabel(null)) },
      { label: 'Last visit', render: (row) => (row.last_visit ? date(row.last_visit) : h('span', { class: 'muted' }, 'Never')) },
      {
        label: 'Dues',
        align: 'right',
        render: (row) =>
          row.balance_due > 0 ? h('span', { class: 'badge red' }, money(row.balance_due)) : h('span', { class: 'muted' }, '—'),
      },
      { label: 'Status', render: (row) => statusBadge(row.status) },
    ];

    clear(results).append(
      h(
        'div',
        { class: 'card', style: 'padding:6px 6px 14px' },
        table(columns, data.items, {
          onRowClick: (row) => navigate(`/members/${row.id}`),
          empty: 'No members match these filters',
        }),
        h(
          'div',
          { class: 'pagination' },
          h('span', { class: 'muted' }, `${data.total} member${data.total === 1 ? '' : 's'} · page ${data.page} of ${data.pages}`),
          h(
            'button',
            {
              class: 'btn sm',
              disabled: data.page <= 1,
              onclick: () => {
                state.page -= 1;
                load();
              },
            },
            '‹ Prev',
          ),
          h(
            'button',
            {
              class: 'btn sm',
              disabled: data.page >= data.pages,
              onclick: () => {
                state.page += 1;
                load();
              },
            },
            'Next ›',
          ),
        ),
      ),
    );
  }

  await load();
  return container;
}

/* ── WebAuthn browser helpers ──────────────────────────────────────── */

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

/* ------------------------------------------------------------ member detail */

export async function renderMemberDetail({ params, setTitle, setActions, reload, navigate }) {
  const member = await api.member(params[0]);
  setTitle(`${fullName(member)} · ${member.code}`);

  // A member can hold a membership covering today plus a renewal queued behind
  // it. The card — and freeze/cancel with it — always follows the one in force.
  const now = today();
  const live = member.subscriptions
    .filter((s) => s.status === 'active' || s.status === 'frozen')
    .sort((a, b) => a.start_date.localeCompare(b.start_date));
  const shownSub = live.find((s) => s.start_date <= now && s.end_date >= now) || live[0];
  const activeSub = shownSub?.status === 'active' ? shownSub : undefined;
  const frozenSub = shownSub?.status === 'frozen' ? shownSub : undefined;
  const queuedSub = live.find((s) => s !== shownSub && s.start_date > now);
  const latestVisit = member.attendance?.[0];
  const currentlyIn = Boolean(latestVisit && !latestVisit.check_out && latestVisit.check_in.slice(0, 10) === now);

  setActions(
    h(
      'button',
      {
        class: 'btn',
        onclick: async () => {
          try {
            const result = await api.checkIn({ member_id: member.id });
            toast(result.action === 'checked_out' ? `${member.first_name} checked out` : `${member.first_name} checked in`);
            reload();
          } catch (err) {
            toast(err.message, 'error');
          }
        },
      },
      currentlyIn ? '🎫 Check out' : '🎫 Check in',
    ),
    session.managesBilling
      ? h(
          'button',
          { class: 'btn', onclick: () => openPaymentForm({ member, subscriptions: member.subscriptions, onSaved: reload }) },
          '💳 Record payment',
        )
      : null,
    session.managesBilling
      ? h('button', { class: 'btn primary', onclick: () => openMembershipForm({ member, onSaved: reload }) }, '＋ New membership')
      : null,
  );

  const profileCard = h(
    'div',
    { class: 'card' },
    h(
      'div',
      { class: 'row', style: 'gap:14px;margin-bottom:16px' },
      member.photo_url
        ? h('img', { class: 'avatar lg', src: member.photo_url, alt: fullName(member), style: 'object-fit:cover' })
        : h('div', { class: 'avatar lg' }, initials(member.first_name, member.last_name)),
      h(
        'div',
        {},
        h('div', { style: 'font-size:19px;font-weight:700' }, fullName(member)),
        h('div', { class: 'muted', style: 'font-size:13px' }, `${member.code} · joined ${date(member.joined_on)}`),
        h('div', { style: 'margin-top:6px' }, statusBadge(member.status)),
      ),
    ),
    h(
      'dl',
      { class: 'kv' },
      h('dt', {}, 'Phone'),
      h('dd', {}, member.phone || '—'),
      h('dt', {}, 'Email'),
      h('dd', {}, member.email || '—'),
      h('dt', {}, 'Date of birth'),
      h('dd', {}, member.date_of_birth ? date(member.date_of_birth) : '—'),
      h('dt', {}, 'Gender'),
      h('dd', { style: 'text-transform:capitalize' }, member.gender || '—'),
      h('dt', {}, 'Address'),
      h('dd', {}, member.address || '—'),
      h('dt', {}, 'Emergency'),
      h('dd', {}, member.emergency_contact ? `${member.emergency_contact} · ${member.emergency_phone || ''}` : '—'),
      h('dt', {}, 'Health notes'),
      h('dd', {}, member.health_notes || '—'),
      h('dt', {}, 'Device PIN'),
      h('dd', {}, member.device_pin ?? h('span', { class: 'muted' }, 'Not enrolled')),
      h('dt', {}, 'Gym session'),
      h(
        'dd',
        {},
        member.session_name
          ? `${member.session_name} (${member.session_start}–${member.session_end})`
          : h('span', { class: 'muted' }, 'No assigned session'),
      ),
    ),
    h(
      'div',
      { class: 'row wrap', style: 'margin-top:16px;gap:8px' },
      h('button', { class: 'btn sm', onclick: () => openMemberForm({ member, onSaved: reload }) }, 'Edit details'),
      h(
        'button',
        {
          class: 'btn sm',
          onclick: () => {
            const photoPicker = createPhotoPicker({ initialUrl: member.photo_url });
            const saveBtn = h(
              'button',
              {
                class: 'btn primary',
                onclick: async () => {
                  saveBtn.disabled = true;
                  try {
                    if (photoPicker.changed()) {
                      await api.updateMember(member.id, { photo: photoPicker.getValue() || '' });
                    }
                    closeModal();
                    toast('Member photo updated');
                    await reload();
                  } catch (err) {
                    toast(err.message || 'Could not update photo', 'error');
                    saveBtn.disabled = false;
                  }
                },
              },
              'Save photo',
            );

            openModal({
              title: `Member Photo · ${fullName(member)}`,
              body: h('div', { style: 'padding:8px 0' }, photoPicker),
              footer: [h('button', { class: 'btn ghost', onclick: closeModal }, 'Cancel'), saveBtn],
            });
          },
        },
        '📷 Photo',
      ),
      session.managesBilling
        ? h(
            'button',
            {
              class: 'btn sm danger',
              onclick: () =>
                confirmDialog({
                  title: 'Delete this member?',
                  message: `${fullName(member)}'s memberships, payments and visit history will be removed. This cannot be undone.`,
                  confirmLabel: 'Delete member',
                  danger: true,
                  onConfirm: async () => {
                    await api.deleteMember(member.id);
                    toast('Member deleted');
                    navigate('/members');
                  },
                }),
            },
            'Delete',
          )
        : null,
    ),
  );

  const membershipCard = h(
    'div',
    { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', {}, 'Current membership')),
    activeSub || frozenSub
      ? h(
          'div',
          {},
          h(
            'div',
            { class: 'row', style: 'justify-content:space-between;align-items:flex-start' },
            h(
              'div',
              {},
              h('div', { style: 'font-size:17px;font-weight:700' }, shownSub.plan_name),
              h(
                'div',
                { class: 'muted', style: 'font-size:13px' },
                `${date(shownSub.start_date)} → ${date(shownSub.end_date)}`,
              ),
            ),
            activeSub ? expiryLabel(activeSub.end_date) : statusBadge('frozen'),
          ),
          shownSub.sessions_total
            ? h(
                'div',
                { style: 'margin-top:14px' },
                h(
                  'div',
                  { class: 'row', style: 'justify-content:space-between;font-size:13px;margin-bottom:6px' },
                  h('span', { class: 'muted' }, 'Sessions used'),
                  h('strong', {}, `${shownSub.sessions_used} / ${shownSub.sessions_total}`),
                ),
                h(
                  'div',
                  { class: 'meter' },
                  h('span', {
                    style: `width:${Math.min(
                      (shownSub.sessions_used / shownSub.sessions_total) * 100,
                      100,
                    )}%`,
                  }),
                ),
              )
            : null,
          queuedSub
            ? h(
                'div',
                { class: 'row', style: 'margin-top:14px;gap:8px;font-size:13px' },
                h('span', { class: 'badge blue' }, 'Renewal queued'),
                h('span', { class: 'muted' }, `${queuedSub.plan_name} from ${date(queuedSub.start_date)}`),
              )
            : null,
          session.managesBilling
            ? h(
                'div',
                { class: 'row wrap', style: 'margin-top:16px;gap:8px' },
                activeSub
                  ? h(
                      'button',
                      {
                        class: 'btn sm',
                        onclick: async () => {
                          await api.freezeSubscription(activeSub.id);
                          toast('Membership frozen');
                          reload();
                        },
                      },
                      '⏸ Freeze',
                    )
                  : h(
                      'button',
                      {
                        class: 'btn sm primary',
                        onclick: async () => {
                          const result = await api.resumeSubscription(frozenSub.id);
                          toast(`Resumed — ${result.days_credited} day(s) credited`);
                          reload();
                        },
                      },
                      '▶ Resume',
                    ),
                h(
                  'button',
                  {
                    class: 'btn sm danger',
                    onclick: () =>
                      confirmDialog({
                        title: 'Cancel this membership?',
                        message: 'The member loses access immediately. Payments already recorded are kept.',
                        confirmLabel: 'Cancel membership',
                        danger: true,
                        onConfirm: async () => {
                          await api.cancelSubscription(shownSub.id);
                          toast('Membership cancelled');
                          reload();
                        },
                      }),
                  },
                  'Cancel',
                ),
              )
            : null,
        )
      : h(
          'div',
          { class: 'empty', style: 'padding:20px' },
          h('div', {}, 'No active membership'),
          session.managesBilling
            ? h(
                'button',
                { class: 'btn primary sm', style: 'margin-top:12px', onclick: () => openMembershipForm({ member, onSaved: reload }) },
                'Sell a membership',
              )
            : null,
        ),
  );

  const accountCard = h(
    'div',
    { class: 'card grid', style: 'gap:12px;align-content:start' },
    h('div', { class: 'card-head' }, h('h3', {}, 'Account')),
    h(
      'div',
      { class: 'row', style: 'justify-content:space-between' },
      h('span', { class: 'muted' }, 'Outstanding balance'),
      member.balance_due > 0
        ? h('strong', { style: 'color:var(--red)' }, money(member.balance_due))
        : h('span', { class: 'badge green' }, 'Settled'),
    ),
    h(
      'div',
      { class: 'row', style: 'justify-content:space-between' },
      h('span', { class: 'muted' }, 'Total visits'),
      h('strong', {}, member.visit_count),
    ),
    h(
      'div',
      { class: 'row', style: 'justify-content:space-between' },
      h('span', { class: 'muted' }, 'Last visit'),
      h('strong', {}, member.last_visit ? date(member.last_visit, { withTime: true }) : 'Never'),
    ),
    h(
      'div',
      { class: 'row', style: 'justify-content:space-between' },
      h('span', { class: 'muted' }, 'Memberships bought'),
      h('strong', {}, member.subscriptions.length),
    ),
  );

  /* ── Biometric credentials card ──────────────────────────────────── */

  const bioList = h('div', {});

  async function loadBiometrics() {
    try {
      const { items } = await api.biometricCredentials(member.id);
      clear(bioList);

      if (items.length === 0) {
        bioList.append(
          h('div', { class: 'empty', style: 'padding:16px' },
            h('div', { style: 'font-size:28px;margin-bottom:8px' }, '🔓'),
            h('div', {}, 'No biometrics enrolled'),
            h('div', { class: 'muted', style: 'font-size:12px;margin-top:4px' }, 'Enroll a fingerprint or face scan so this member can check in without their code.'),
          ),
        );
      } else {
        bioList.append(
          h('div', { class: 'list' },
            ...items.map((cred) =>
              h('div', { class: 'list-item' },
                h('div', { class: 'bio-cred-icon' }, '🔒'),
                h('div', {},
                  h('div', { style: 'font-weight:600;font-size:14px' }, cred.device_name || 'Biometric credential'),
                  h('div', { class: 'muted', style: 'font-size:12px' },
                    `Enrolled ${date(cred.created_at)} · ${cred.device_type === 'multiDevice' ? 'Passkey' : 'Device-bound'}`,
                  ),
                ),
                h('div', { class: 'spacer' }),
                h('button', {
                  class: 'btn sm danger',
                  onclick: async () => {
                    confirmDialog({
                      title: 'Revoke this credential?',
                      message: 'The member will no longer be able to check in with this biometric. They can re-enroll.',
                      confirmLabel: 'Revoke',
                      danger: true,
                      onConfirm: async () => {
                        await api.biometricDeleteCredential(member.id, cred.id);
                        toast('Credential revoked');
                        loadBiometrics();
                      },
                    });
                  },
                }, 'Revoke'),
              ),
            ),
          ),
        );
      }
    } catch (err) {
      clear(bioList).append(
        h('div', { class: 'muted', style: 'padding:12px;font-size:13px' }, 'Could not load biometric credentials'),
      );
    }
  }

  async function enrollBiometric() {
    if (!supportsWebAuthn()) {
      toast('Biometrics not supported on this browser', 'error');
      return;
    }

    // Ask for an optional device name
    const deviceName = prompt('Device name (optional, e.g. "Front desk iPad"):') || '';

    try {
      // 1. Get registration options
      const { options, sessionKey } = await api.biometricRegisterOptions({ member_id: member.id });

      // 2. Prepare PublicKeyCredentialCreationOptions
      const publicKey = {
        challenge: base64urlToBuffer(options.challenge),
        rp: options.rp,
        user: {
          id: base64urlToBuffer(options.user.id),
          name: options.user.name,
          displayName: options.user.displayName,
        },
        pubKeyCredParams: options.pubKeyCredParams,
        timeout: options.timeout || 60000,
        attestation: options.attestation || 'none',
        authenticatorSelection: options.authenticatorSelection,
      };

      if (options.excludeCredentials && options.excludeCredentials.length > 0) {
        publicKey.excludeCredentials = options.excludeCredentials.map((c) => ({
          id: base64urlToBuffer(c.id),
          type: c.type,
          transports: c.transports,
        }));
      }

      // 3. Prompt the user for biometric enrollment
      const credential = await navigator.credentials.create({ publicKey });

      // 4. Package the response
      const response = {
        id: credential.id,
        rawId: bufferToBase64url(credential.rawId),
        type: credential.type,
        response: {
          attestationObject: bufferToBase64url(credential.response.attestationObject),
          clientDataJSON: bufferToBase64url(credential.response.clientDataJSON),
        },
        clientExtensionResults: credential.getClientExtensionResults(),
        authenticatorAttachment: credential.authenticatorAttachment,
      };

      // Add transports if available
      if (credential.response.getTransports) {
        response.response.transports = credential.response.getTransports();
      }

      // 5. Verify on server
      await api.biometricRegisterVerify({
        sessionKey,
        member_id: member.id,
        device_name: deviceName.trim() || null,
        credential: response,
      });

      toast('Biometric enrolled successfully!');
      loadBiometrics();
    } catch (err) {
      if (err.name === 'NotAllowedError') {
        toast('Biometric enrollment cancelled', 'info');
      } else {
        toast(err.message || 'Enrollment failed', 'error');
      }
    }
  }

  const biometricCard = h(
    'div',
    { class: 'card bio-member-card' },
    h('div', { class: 'card-head' },
      h('h3', {}, '🔒 Biometric credentials'),
      h('div', { class: 'spacer' }),
      supportsWebAuthn()
        ? h('button', { class: 'btn sm primary', onclick: enrollBiometric }, '＋ Enroll biometric')
        : null,
    ),
    bioList,
  );

  loadBiometrics();

  /* ── QR ID card ──────────────────────────────────────────────────── */

  const qrBody = h('div', { class: 'empty', style: 'padding:16px' }, 'Loading card…');
  let card;

  function renderQrCard() {
    clear(qrBody).append(
      h(
        'div',
        { class: 'qr-preview' },
        idCardNode(card),
        h(
          'div',
          { class: 'grid', style: 'gap:8px;align-content:start' },
          h('button', { class: 'btn primary sm', onclick: () => printCards([card]) }, '🖨️ Print card'),
          h(
            'button',
            {
              class: 'btn sm',
              onclick: async (event) => {
                event.target.disabled = true;
                try {
                  await downloadCardPng(card);
                } catch (err) {
                  toast(err.message || 'Could not build the image', 'error');
                } finally {
                  event.target.disabled = false;
                }
              },
            },
            '⬇️ Download image',
          ),
          session.managesBilling
            ? h(
                'button',
                {
                  class: 'btn sm',
                  title: 'Send ID card to member on WhatsApp',
                  onclick: async (event) => {
                    const button = event.target;
                    button.disabled = true;
                    try {
                      const pngBytes = await renderCardPngBytes(card);
                      let binary = '';
                      for (let i = 0; i < pngBytes.byteLength; i++) {
                        binary += String.fromCharCode(pngBytes[i]);
                      }
                      const imageBase64 = btoa(binary);
                      await api.sendWhatsAppIdCard(member.id, imageBase64);
                      toast('ID card sent on WhatsApp');
                    } catch (err) {
                      toast(err.message || 'Could not send the ID card', 'error');
                    } finally {
                      button.disabled = false;
                    }
                  },
                },
                '💬 Send to WhatsApp',
              )
            : null,
          h(
            'button',
            {
              class: 'btn ghost sm',
              onclick: () =>
                confirmDialog({
                  title: 'Reissue this QR card?',
                  message:
                    "The member's current card stops working immediately — reissue only when a card is lost, then print and hand over the new one.",
                  confirmLabel: 'Reissue card',
                  danger: true,
                  onConfirm: async () => {
                    card = await api.qrReissue(member.id);
                    renderQrCard();
                    toast('New card issued — the old one no longer works');
                  },
                }),
            },
            'Reissue',
          ),
          card.issued_at
            ? h('div', { class: 'muted', style: 'font-size:12px' }, `Issued ${date(card.issued_at, { withTime: true })}`)
            : null,
        ),
      ),
    );
  }

  async function loadQrCard() {
    try {
      card = await api.qrCard(member.id);
      renderQrCard();
    } catch (err) {
      clear(qrBody).append(
        h('div', { class: 'muted', style: 'padding:12px;font-size:13px' }, err.message || 'Could not load the QR card'),
      );
    }
  }

  const qrCardSection = h(
    'div',
    { class: 'card qr-card' },
    h(
      'div',
      { class: 'card-head' },
      h('h3', {}, '🎟️ QR ID card'),
      h('div', { class: 'spacer' }),
      h('span', { class: 'muted', style: 'font-size:12px' }, 'Print it, or send the image to the member'),
    ),
    qrBody,
  );

  loadQrCard();

  /* ── History section ─────────────────────────────────────────────── */

  const history = h(
    'div',
    { class: 'grid cols-2 top' },
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', {}, 'Membership history')),
      table(
        [
          { label: 'Plan', render: (row) => row.plan_name },
          { label: 'Period', render: (row) => `${date(row.start_date)} → ${date(row.end_date)}` },
          { label: 'Value', align: 'right', render: (row) => money(row.price - row.discount) },
          { label: 'Status', render: (row) => statusBadge(row.status) },
        ],
        member.subscriptions,
        { empty: 'No memberships yet' },
      ),
    ),
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', {}, 'Payments')),
      table(
        [
          { label: 'Date', render: (row) => date(row.paid_on) },
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
              ),
          },
        ],
        member.payments,
        { empty: 'No payments recorded' },
      ),
    ),
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', {}, 'Recent visits')),
      table(
        [
          { label: 'Date', render: (row) => date(row.check_in) },
          { label: 'In', render: (row) => time(row.check_in.slice(11)) },
          { label: 'Out', render: (row) => (row.check_out ? time(row.check_out.slice(11)) : h('span', { class: 'badge green' }, 'In gym')) },
          { label: 'Via', render: (row) => sourceBadge(row.source) },
        ],
        member.attendance,
        { empty: 'No visits recorded' },
      ),
    ),
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', {}, 'Class bookings')),
      table(
        [
          { label: 'Class', render: (row) => row.class_name },
          { label: 'Date', render: (row) => date(row.class_date) },
          { label: 'Time', render: (row) => time(row.start_time) },
          { label: 'Status', render: (row) => statusBadge(row.status) },
        ],
        member.bookings,
        { empty: 'No class bookings' },
      ),
    ),
  );

  /* ── ID documents (library only) ─────────────────────────────────── */

  const docsBody = h('div', {}, h('div', { class: 'empty' }, 'Loading…'));

  async function renderDocs() {
    const { items } = await api.memberDocuments({ member_id: member.id });
    clear(docsBody).append(
      items.length
        ? h(
            'div',
            { class: 'list' },
            items.map((doc) =>
              h(
                'div',
                { class: 'list-item' },
                h(
                  'div',
                  {},
                  h('div', { style: 'font-weight:600' }, doc.label || doc.kind.replace(/_/g, ' ')),
                  h('div', { class: 'muted', style: 'font-size:12px' }, doc.number || ''),
                ),
                h('div', { class: 'spacer' }),
                doc.verified ? h('span', { class: 'badge green' }, 'Verified') : h('span', { class: 'badge amber' }, 'Unverified'),
                h('a', { class: 'btn sm ghost', href: doc.file_url, target: '_blank', rel: 'noopener' }, 'View'),
                session.managesBilling && !doc.verified
                  ? h(
                      'button',
                      {
                        class: 'btn sm',
                        onclick: async () => {
                          await api.verifyMemberDocument(doc.id);
                          toast('Marked verified');
                          renderDocs();
                        },
                      },
                      'Verify',
                    )
                  : null,
                session.managesBilling
                  ? h(
                      'button',
                      {
                        class: 'btn sm danger',
                        onclick: () =>
                          confirmDialog({
                            title: 'Remove this document?',
                            message: 'This cannot be undone.',
                            confirmLabel: 'Remove',
                            danger: true,
                            onConfirm: async () => {
                              await api.deleteMemberDocument(doc.id);
                              toast('Document removed');
                              renderDocs();
                            },
                          }),
                      },
                      'Remove',
                    )
                  : null,
              ),
            ),
          )
        : h('div', { class: 'empty' }, 'No documents on file'),
    );
  }

  function openDocumentUploadForm() {
    const fileInput = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,application/pdf' });
    const form = buildForm(
      [
        {
          name: 'kind',
          label: 'Document',
          type: 'select',
          required: true,
          options: [
            { value: 'aadhaar_front', label: 'Aadhaar (front)' },
            { value: 'aadhaar_back', label: 'Aadhaar (back)' },
            { value: 'college_id', label: 'College ID' },
            { value: 'photo_id', label: 'Other photo ID' },
            { value: 'other', label: 'Other' },
          ],
        },
        { name: 'label', label: 'Label (optional)', placeholder: 'e.g. Aadhaar card' },
        { name: 'number', label: 'Document number (optional)' },
      ],
      {
        submitLabel: 'Upload',
        onSubmit: async (values) => {
          const file = fileInput.files?.[0];
          if (!file) {
            toast('Choose a file first', 'error');
            return;
          }
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('Could not read that file'));
            reader.readAsDataURL(file);
          });
          await api.createMemberDocument({ member_id: member.id, kind: values.kind, label: values.label || undefined, number: values.number || undefined, file: dataUrl });
          closeModal();
          toast('Document uploaded');
          renderDocs();
        },
      },
    );
    form.querySelector('.form-grid').prepend(
      h('label', { class: 'field full' }, h('span', {}, 'File (image or PDF, under 2 MB)'), fileInput),
    );
    openModal({ title: `Upload a document · ${fullName(member)}`, body: form });
  }

  renderDocs();

  const documentsCard = isLibrary()
    ? h(
        'div',
        { class: 'card' },
        h(
          'div',
          { class: 'card-head' },
          h('h3', {}, '🪪 ID documents'),
          h('div', { class: 'spacer' }),
          session.managesBilling ? h('button', { class: 'btn sm', onclick: openDocumentUploadForm }, '＋ Upload') : null,
        ),
        docsBody,
      )
    : null;

  return h(
    'div',
    { class: 'grid', style: 'gap:16px' },
    h('a', { href: '#/members', class: 'muted', style: 'font-size:13px' }, '← Back to members'),
    h('div', { class: 'grid cols-3' }, profileCard, membershipCard, accountCard),
    qrCardSection,
    biometricCard,
    documentsCard,
    history,
  );
}
