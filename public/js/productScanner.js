import { cameraProblem, startBarcodeScan } from './barcodeScanner.js';
import { closeModal, h, openModal, renderIcon } from './ui.js';

/**
 * The "scan a pack" window the product lists share — the operator's central
 * catalogue, a partner shop's shelf, and a gym's own desk shelf.
 *
 * The camera when there is one, and a digits box that is always there and
 * focused: a USB or Bluetooth barcode gun types the code and presses Enter,
 * which is how most shop counters scan, and it works on a desktop with no
 * webcam at all.
 *
 * `resolve(code)` turns a code into whatever the caller needs (a server
 * lookup, or nothing — the code itself); the window stays open on a failed
 * resolve, with the reason, so the next pack can be tried straight away.
 * `onDone(result)` runs once the window has closed.
 */
export function openProductScanner({ title = 'Scan a barcode', subtitle, resolve = async (code) => code, onDone }) {
  const issue = cameraProblem();
  const video = h('video', { class: 'portal-scan-video', playsinline: '', muted: '', 'aria-label': 'Camera view' });
  const stage = h('div', { class: 'portal-scan-stage' }, video, h('div', { class: 'portal-scan-guide', 'aria-hidden': 'true' }, h('i')));
  const status = h('div', { class: 'portal-scan-status', role: 'status' });
  const digits = h('input', {
    inputmode: 'numeric',
    autocomplete: 'off',
    placeholder: 'Type the barcode digits',
    'aria-label': 'Barcode digits',
    maxlength: 20,
  });
  const go = h('button', { class: 'btn primary', type: 'submit' }, 'Look up');
  const again = h('button', { class: 'btn sm hidden', type: 'button' }, renderIcon('scan', { size: 14 }), 'Scan again');
  let stopCamera = null;
  let busy = false;
  let closed = false;

  const stop = () => {
    stopCamera?.();
    stopCamera = null;
    stage.classList.remove('live');
  };

  async function handle(raw) {
    const code = String(raw || '').replace(/[\s-]/g, '');
    if (!code || busy) return;
    busy = true;
    go.disabled = true;
    stop();
    status.textContent = `Looking up ${code}…`;
    try {
      const result = await resolve(code);
      if (closed) return;
      closed = true;
      closeModal();
      onDone?.(result, code);
    } catch (err) {
      status.textContent = err.message || 'Could not look that barcode up';
      again.classList.toggle('hidden', Boolean(issue));
      digits.select();
    } finally {
      busy = false;
      go.disabled = false;
    }
  }

  async function startCamera() {
    if (issue || stopCamera || closed) return;
    again.classList.add('hidden');
    status.textContent = 'Starting camera…';
    try {
      stopCamera = await startBarcodeScan(video, {
        onCode: (code) => {
          stopCamera = null;
          stage.classList.remove('live');
          digits.value = code;
          handle(code);
        },
      });
    } catch (err) {
      stopCamera = null;
      again.classList.remove('hidden');
      status.textContent =
        err?.name === 'NotAllowedError' || err?.name === 'NotFoundError'
          ? 'No camera to use here — type the digits, or scan with a barcode gun.'
          : err?.message || 'Could not start the camera — type the digits instead.';
      return;
    }
    if (closed || !video.isConnected) {
      stop();
      return;
    }
    stage.classList.add('live');
    status.textContent = 'Hold the barcode level inside the frame';
  }
  again.addEventListener('click', startCamera);

  const form = h(
    'form',
    {
      class: 'pscan-form',
      onsubmit: (event) => {
        event.preventDefault();
        handle(digits.value);
      },
    },
    digits,
    go,
  );

  openModal({
    title,
    subtitle: subtitle ?? 'Point the camera at the barcode on the pack',
    icon: 'scan',
    className: 'pscan-modal',
    body: h('div', { class: 'pscan' }, issue ? null : stage, status, issue ? h('p', { class: 'muted pscan-note' }, issue) : again, form),
    onClose: () => {
      closed = true;
      stop();
    },
  });
  setTimeout(() => digits.focus());
  if (issue) status.textContent = 'Type the barcode digits, or scan with a barcode gun.';
  else startCamera();
}

/** A barcode input with its own scan button beside it, for product forms. */
export function barcodeInput(input) {
  return h(
    'div',
    { class: 'pscan-field' },
    input,
    h(
      'button',
      {
        type: 'button',
        class: 'btn sm',
        title: 'Scan the barcode',
        'aria-label': 'Scan the barcode',
        onclick: () =>
          openProductScanner({
            title: 'Scan the pack’s barcode',
            onDone: (code) => {
              input.value = code;
              input.dispatchEvent(new Event('input', { bubbles: true }));
            },
          }),
      },
      renderIcon('scan', { size: 15 }),
    ),
  );
}
