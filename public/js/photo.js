import { clear, closeModal, h, openModal, toast } from './ui.js';

/**
 * Loads an image from a File, Blob, or URL string and renders it onto a square
 * canvas (center cropped) at 300x300, returning a compressed JPEG base64 Data URL.
 */
export function cropAndResizeImage(source, size = 250, quality = 0.75) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';

    const process = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');

        // Center crop math
        const minDim = Math.min(img.width, img.height);
        const sx = (img.width - minDim) / 2;
        const sy = (img.height - minDim) / 2;

        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, size, size);
        ctx.drawImage(img, sx, sy, minDim, minDim, 0, 0, size, size);

        resolve(canvas.toDataURL('image/jpeg', quality));
      } catch (err) {
        reject(err);
      }
    };

    img.onload = process;
    img.onerror = () => reject(new Error('Could not read image file'));

    if (source instanceof File || source instanceof Blob) {
      const reader = new FileReader();
      reader.onload = (e) => {
        img.src = e.target.result;
      };
      reader.onerror = () => reject(new Error('Could not read image file'));
      reader.readAsDataURL(source);
    } else if (typeof source === 'string') {
      img.src = source;
    } else {
      reject(new Error('Invalid image source'));
    }
  });
}

/**
 * Opens a modal with live camera preview (webcam) allowing the user to snap a photo.
 *
 * @param {object} opts
 * @param {function(string)} opts.onCapture - Called with the JPEG data URL on snap
 */
export async function openCameraModal({ onCapture }) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast('Camera is not supported on this browser/device', 'error');
    return;
  }

  let stream = null;
  let facingMode = 'user';
  
  const video = h('video', { autoplay: true, playsinline: true, muted: true, class: 'photo-camera-video' });
  const captureBtn = h('button', { class: 'btn primary', type: 'button' }, '📸 Snap photo');
  const switchBtn = h('button', { class: 'btn ghost', type: 'button', style: 'margin-right:auto' }, '🔄 Switch Camera');
  const statusMsg = h('div', { class: 'muted', style: 'font-size:13px;text-align:center;margin-top:6px' }, 'Starting camera…');

  const stopStream = () => {
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      stream = null;
    }
  };

  const startStream = async () => {
    stopStream();
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode, width: { ideal: 640 }, height: { ideal: 640 } },
        audio: false,
      });
      video.srcObject = stream;
      await video.play();
      statusMsg.textContent = 'Position face inside the reticle and click Snap photo';
      captureBtn.disabled = false;
    } catch (err) {
      console.error(err);
      statusMsg.textContent = err.name === 'NotAllowedError'
        ? 'Camera access denied by browser permissions'
        : 'Could not access camera device';
      captureBtn.disabled = true;
      toast('Could not start camera', 'error');
    }
  };

  switchBtn.addEventListener('click', () => {
    facingMode = facingMode === 'user' ? 'environment' : 'user';
    startStream();
  });

  openModal({
    title: '📷 Click Member Photo',
    body: h(
      'div',
      { class: 'photo-camera-container' },
      h(
        'div',
        { class: 'photo-camera-frame' },
        video,
        h('div', { class: 'photo-camera-reticle' }),
      ),
      statusMsg,
    ),
    footer: [
      switchBtn,
      h('button', { class: 'btn ghost', type: 'button', onclick: closeModal }, 'Cancel'),
      captureBtn,
    ],
    onClose: stopStream,
  });

  startStream();

  captureBtn.addEventListener('click', async () => {
    try {
      captureBtn.disabled = true;
      statusMsg.textContent = 'Processing photo…';

      const canvas = document.createElement('canvas');
      const videoW = video.videoWidth || 640;
      const videoH = video.videoHeight || 480;
      const minDim = Math.min(videoW, videoH);

      canvas.width = 250;
      canvas.height = 250;
      const ctx = canvas.getContext('2d');

      const sx = (videoW - minDim) / 2;
      const sy = (videoH - minDim) / 2;

      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, 250, 250);
      ctx.drawImage(video, sx, sy, minDim, minDim, 0, 0, 250, 250);

      const dataUrl = canvas.toDataURL('image/jpeg', 0.75);

      stopStream();
      closeModal();
      onCapture(dataUrl);
      toast('Photo captured!');
    } catch (err) {
      console.error(err);
      toast('Could not process captured photo', 'error');
      captureBtn.disabled = false;
    }
  });
}

/**
 * Creates a Photo Picker UI component with preview avatar and upload/camera/remove controls.
 *
 * @param {object} opts
 * @param {string|null} opts.initialUrl
 * @param {function(string|null)} opts.onChange
 * @returns {HTMLElement}
 */
export function createPhotoPicker({ initialUrl = null, onChange } = {}) {
  let currentUrl = initialUrl || null;
  /**
   * Whether the person actually touched the photo.
   *
   * `initialUrl` for an existing member is a *server URL* that serves the
   * bytes, not the bytes themselves — so it must never be sent back as an
   * upload. Callers ask changed() first and leave the photo alone when it is
   * false, which is also what stops an unrelated edit (fixing a phone number)
   * from rewriting the photo it never loaded.
   */
  let dirty = false;

  const avatarImg = h('img', {
    class: 'photo-picker-img',
    src: currentUrl || '',
    alt: 'Member photo preview',
    style: currentUrl ? '' : 'display:none',
  });

  const placeholder = h(
    'div',
    { class: 'photo-picker-placeholder', style: currentUrl ? 'display:none' : '' },
    '🧑',
  );

  const fileInput = h('input', {
    type: 'file',
    accept: 'image/png, image/jpeg, image/webp, image/gif',
    style: 'display:none',
  });

  const updatePreview = (url) => {
    currentUrl = url || null;
    dirty = true;
    if (currentUrl) {
      avatarImg.src = currentUrl;
      avatarImg.style.display = '';
      placeholder.style.display = 'none';
      removeBtn.style.display = '';
    } else {
      avatarImg.src = '';
      avatarImg.style.display = 'none';
      placeholder.style.display = '';
      removeBtn.style.display = 'none';
    }
    onChange?.(currentUrl);
  };

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await cropAndResizeImage(file);
      updatePreview(dataUrl);
      toast('Photo selected');
    } catch (err) {
      toast(err.message || 'Could not process photo file', 'error');
    } finally {
      fileInput.value = '';
    }
  });

  const uploadBtn = h(
    'button',
    {
      class: 'btn sm ghost',
      type: 'button',
      onclick: () => fileInput.click(),
    },
    '📁 Upload file',
  );

  const cameraBtn = h(
    'button',
    {
      class: 'btn sm ghost',
      type: 'button',
      onclick: () => {
        openCameraModal({
          onCapture: (dataUrl) => updatePreview(dataUrl),
        });
      },
    },
    '📸 Take photo',
  );

  const removeBtn = h(
    'button',
    {
      class: 'btn sm danger ghost',
      type: 'button',
      style: currentUrl ? '' : 'display:none',
      onclick: () => {
        updatePreview(null);
        toast('Photo removed', 'info');
      },
    },
    '🗑️ Remove',
  );

  const container = h(
    'div',
    { class: 'photo-picker' },
    h(
      'div',
      { class: 'photo-picker-avatar' },
      avatarImg,
      placeholder,
    ),
    h(
      'div',
      { class: 'photo-picker-controls' },
      h('div', { style: 'font-weight:600;font-size:14px;margin-bottom:4px' }, 'Member photo'),
      h('div', { class: 'muted', style: 'font-size:12px;margin-bottom:8px' }, 'Upload a file or take a camera snapshot for member profile & ID cards.'),
      h('div', { class: 'row wrap', style: 'gap:6px' }, uploadBtn, cameraBtn, removeBtn),
      fileInput,
    ),
  );

  container.getValue = () => currentUrl;
  container.setValue = (url) => updatePreview(url);
  container.changed = () => dirty;

  return container;
}
