import { api } from '../api.js';
import { clear, date, fullName, h, initials, isFullscreen, money, sourceBadge, statusBadge, table, time, toast, today, toggleFullscreen } from '../ui.js';

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

/* ── QR card helpers ───────────────────────────────────────────────── */

/** Marks a value as coming off a printed GymBook card rather than being typed;
 * must match QR_PREFIX in src/qr.js. */
const QR_PREFIX = 'GB1:';

const looksLikeCard = (value) => value.slice(0, QR_PREFIX.length).toUpperCase() === QR_PREFIX;

/**
 * Can this device open a camera at all? getUserMedia is only exposed in a
 * secure context, so plain http on a LAN address fails here even though the
 * hardware is present — worth distinguishing, because the fix is a URL change
 * rather than a different browser.
 */
function cameraAvailability() {
  if (!window.isSecureContext) {
    return {
      ok: false,
      reason:
        'Camera scanning needs a secure connection. Open the desk over HTTPS (or on localhost) to scan with the camera — a handheld scanner works into the box above either way.',
    };
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return {
      ok: false,
      reason: 'This browser will not give the page camera access. Use a handheld scanner into the box above.',
    };
  }
  return { ok: true };
}

/**
 * Picks a QR decoder.
 *
 * The native BarcodeDetector is preferred — it's hardware-accelerated and costs
 * no download — but it is far from universal: it ships on Android, ChromeOS and
 * macOS, and is absent from Chrome and Edge on Windows and Linux as well as from
 * Safari and Firefox. So the fallback is a vendored decoder, fetched only when
 * it's actually needed.
 *
 * Both branches return the same shape: a function taking the <video> and
 * resolving to a decoded string, or null when nothing is in frame.
 */
async function loadQrDecoder() {
  if ('BarcodeDetector' in window) {
    try {
      const formats = await window.BarcodeDetector.getSupportedFormats();
      if (formats.includes('qr_code')) {
        const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
        return async (video) => {
          const [found] = await detector.detect(video);
          return found?.rawValue ?? null;
        };
      }
    } catch {
      // Present but unusable on this platform — fall through to jsQR.
    }
  }

  await loadJsQr();
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  return async (video) => {
    const width = video.videoWidth;
    const height = video.videoHeight;
    // Frames arrive before the stream reports dimensions; nothing to read yet.
    if (!width || !height) return null;

    canvas.width = width;
    canvas.height = height;
    ctx.drawImage(video, 0, 0, width, height);
    const { data } = ctx.getImageData(0, 0, width, height);
    // Cards are held upright at a desk, so don't pay for inverted-image passes.
    return window.jsQR(data, width, height, { inversionAttempts: 'dontInvert' })?.data ?? null;
  };
}

let jsQrLoad;

/** Fetches the vendored decoder once per page, on first use. */
function loadJsQr() {
  if (window.jsQR) return Promise.resolve();
  jsQrLoad ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/js/vendor/jsqr.min.js';
    script.onload = () => (window.jsQR ? resolve() : reject(new Error('QR decoder loaded but did not register')));
    script.onerror = () => {
      // Let a later attempt retry rather than caching the failure forever.
      jsQrLoad = undefined;
      reject(new Error('Could not load the QR decoder'));
    };
    document.head.append(script);
  });
  return jsQrLoad;
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
          { label: 'Via', render: (row) => sourceBadge(row.source) },
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
    const checkedOut = result.action === 'checked_out';
    clear(feedback).append(
      h(
        'div',
        { class: `checkin-result ${checkedOut ? 'out' : 'ok'}` },
        h('div', { class: 'row', style: 'gap:12px' }, h('div', { class: 'avatar lg' }, initials(visit.first_name, visit.last_name)),
          h(
            'div',
            {},
            h('div', { style: 'font-size:18px;font-weight:700' }, fullName(visit)),
            h(
              'div',
              { class: 'muted', style: 'font-size:13px' },
              checkedOut
                ? `Checked out at ${time(visit.check_out.slice(11))}`
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
    toast(checkedOut ? `${visit.first_name} checked out` : `Welcome, ${visit.first_name}`);
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
      // A handheld scanner types the card payload into this same box. Route it
      // by shape so the visit records the channel it actually came through
      // instead of logging every scan as a desk entry.
      const result = looksLikeCard(code) ? await api.qrCheckIn(code) : await api.checkIn({ code });
      showResult(result);
    } catch (err) {
      showError(err);
    }
    input.focus();
  }

  /* ── QR card scanning ─────────────────────────────────────────────── */

  const scanPanel = h('div', {});
  const video = h('video', { muted: true, playsinline: 'true' });
  const scanStage = h('div', { class: 'scan-video-wrap', style: 'display:none' }, video, h('div', { class: 'scan-reticle' }));
  let scanStream;
  let scanning = false;

  function stopScan() {
    scanning = false;
    for (const track of scanStream?.getTracks() ?? []) track.stop();
    scanStream = undefined;
    video.srcObject = null;
    scanStage.style.display = 'none';
    scanButton.disabled = false;
    scanButton.textContent = '📷 Scan a card';
    scanButton.classList.remove('scanning');
  }

  /** Shows who was just scanned and lets staff admit them. Read-only until
   * they press the button, so an expiry or an unpaid balance can be spotted
   * before the member is waved through. */
  function showScanned(code, info) {
    const member = info.member;

    const admit = h(
      'button',
      {
        class: 'btn primary',
        onclick: async () => {
          admit.disabled = true;
          try {
            showResult(await api.qrCheckIn(code));
          } catch (err) {
            showError(err);
          }
        },
      },
      // Named, because the desk box on the same screen also has a "Check in"
      // button — the scanned member's name makes it obvious which is which.
      // Scanning again while already in checks them out (see performCheckIn).
      info.already_in ? `Check out ${member.first_name}` : `Check in ${member.first_name}`,
    );

    clear(scanPanel).append(
      h(
        'div',
        { class: 'checkin-result ok' },
        h(
          'div',
          { class: 'row', style: 'gap:12px;align-items:flex-start' },
          member.photo_url
            ? h('img', { class: 'scan-result-photo', src: member.photo_url, alt: '' })
            : h('div', { class: 'avatar lg' }, initials(member.first_name, member.last_name)),
          h(
            'div',
            { style: 'min-width:0' },
            h('div', { style: 'font-size:17px;font-weight:700' }, fullName(member)),
            h('div', { class: 'muted', style: 'font-size:12px' }, member.code),
            h(
              'div',
              { class: 'row', style: 'gap:6px;margin-top:8px;flex-wrap:wrap' },
              statusBadge(member.status),
              info.subscription
                ? h('span', { class: 'badge green' }, `${info.subscription.plan_name} to ${date(info.subscription.end_date)}`)
                : h('span', { class: 'badge red' }, 'No active membership'),
              info.sessions_left !== null && info.sessions_left !== undefined
                ? h('span', { class: 'badge blue' }, `${info.sessions_left} sessions left`)
                : null,
              member.balance_due > 0 ? h('span', { class: 'badge amber' }, `${money(member.balance_due)} due`) : null,
              info.already_in ? h('span', { class: 'badge violet' }, 'Already in the gym') : null,
            ),
          ),
        ),
        h(
          'div',
          { class: 'row', style: 'gap:8px;margin-top:12px' },
          admit,
          h('a', { class: 'btn ghost sm', href: `#/members/${member.id}` }, 'Open profile'),
        ),
      ),
    );
  }

  async function handleScanned(code) {
    try {
      showScanned(code, await api.qrLookup(code));
    } catch (err) {
      clear(scanPanel);
      showError(err);
    }
  }

  async function startScan() {
    clear(scanPanel);
    clear(feedback);

    scanButton.disabled = true;
    scanButton.textContent = 'Starting camera…';

    let decode;
    try {
      // Decoder first: on a browser needing the fallback this fetches it, and
      // failing here means never lighting up the camera for nothing.
      decode = await loadQrDecoder();
      scanStream = await navigator.mediaDevices.getUserMedia({
        // Rear camera on a tablet; a desktop webcam ignores facingMode. The
        // resolution hint keeps full-frame software decoding cheap without
        // starving it of detail — these are treated as preferences, not
        // requirements, so a webcam that can't oblige still opens.
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
    } catch (err) {
      scanButton.disabled = false;
      scanButton.textContent = '📷 Scan a card';
      toast(
        err?.name === 'NotAllowedError'
          ? 'Camera access was blocked — allow it in the browser, or scan into the box above'
          : err?.message || 'Could not start the camera',
        'error',
      );
      return;
    }

    scanButton.disabled = false;
    video.srcObject = scanStream;
    await video.play().catch(() => {});
    scanStage.style.display = 'block';
    scanButton.textContent = '■ Stop scanning';
    scanButton.classList.add('scanning');
    scanning = true;

    const tick = async () => {
      // The router swaps views without a teardown hook, so the loop watches
      // for its own video being detached and releases the camera itself.
      if (!scanning || !video.isConnected) {
        stopScan();
        return;
      }
      try {
        const value = await decode(video);
        if (value) {
          stopScan();
          await handleScanned(value.trim());
          return;
        }
      } catch {
        // A transient decode failure (e.g. a frame arriving before the video
        // reports its dimensions) isn't fatal — keep sampling.
      }
      // ~8 fps: fast enough to feel instant at the desk, and on the jsQR path
      // it leaves the main thread time to breathe between full-frame decodes.
      setTimeout(tick, 120);
    };
    tick();
  }

  const scanButton = h(
    'button',
    { class: 'btn primary block', onclick: () => (scanning ? stopScan() : startScan()) },
    '📷 Scan a card',
  );

  const camera = cameraAvailability();

  const qrCard = h(
    'div',
    { class: 'card qr-card' },
    h('h3', {}, '🎟️ Member QR card'),
    h(
      'p',
      { class: 'muted', style: 'font-size:13px;margin:0 0 14px' },
      camera.ok
        ? 'Point the camera at the QR on the member’s card to see their details, then check them in.'
        : camera.reason,
    ),
    camera.ok ? scanButton : null,
    scanStage,
    scanPanel,
  );

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

  const kioskFullscreenBtn = h(
    'button',
    {
      id: 'btn-fullscreen-checkin',
      class: 'btn ghost',
      onclick: () => toggleFullscreen(),
    },
    isFullscreen() ? '🗗 Exit Fullscreen' : '⛶ Kiosk Fullscreen',
  );
  setActions(kioskFullscreenBtn, h('a', { class: 'btn', href: '#/members' }, 'Find a member'));
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
        h(
          'div',
          { class: 'muted', style: 'font-size:12px;margin-top:6px' },
          'A handheld QR scanner can type straight into this box.',
        ),
        h('button', { class: 'btn primary block', style: 'margin-top:12px', onclick: submit }, 'Check in'),
        feedback,
      ),
      qrCard,
      bioCard,
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, 'In the gym now')), openList),
    ),
    h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', {}, "Today's check-ins")), recent),
  );
}
