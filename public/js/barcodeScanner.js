/**
 * Reads product barcodes (EAN-13, EAN-8, UPC-A, UPC-E) off the camera for the
 * member app's food logger.
 *
 * Same shape as the check-in desk's QR scanner (views/checkin.js): the native
 * BarcodeDetector where it can read these formats — Android, ChromeOS, macOS —
 * and otherwise a vendored ZXing build (js/vendor/zxing-1d.min.js), fetched
 * only on first use. iPhones and Chrome on Windows take the fallback.
 */

const PRODUCT_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];

/** Why the camera cannot be used here, or null when it can. */
export function cameraProblem() {
  if (!window.isSecureContext) return 'Camera scanning needs a secure (https) connection. Type the barcode digits instead.';
  if (!navigator.mediaDevices?.getUserMedia) return 'This browser will not share the camera. Type the barcode digits instead.';
  return null;
}

let zxingLoad;

function loadZxing() {
  if (window.GymbookBarcode) return Promise.resolve();
  zxingLoad ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/js/vendor/zxing-1d.min.js';
    script.onload = () => (window.GymbookBarcode ? resolve() : reject(new Error('Barcode reader loaded but did not register')));
    script.onerror = () => {
      zxingLoad = undefined;
      reject(new Error('Could not load the barcode reader'));
    };
    document.head.append(script);
  });
  return zxingLoad;
}

/**
 * A function from the <video> to a decoded code, or null for "nothing yet".
 *
 * The fallback reads a horizontal band across the middle of the frame, scaled
 * to at most 960 px wide: a barcode is held level in the guide, and decoding
 * the whole 1280×720 frame in JavaScript would cost a phone its frame rate.
 */
async function loadDecoder() {
  if ('BarcodeDetector' in window) {
    try {
      const supported = await window.BarcodeDetector.getSupportedFormats();
      const formats = PRODUCT_FORMATS.filter((f) => supported.includes(f));
      if (formats.length) {
        const detector = new window.BarcodeDetector({ formats });
        return async (video) => (await detector.detect(video))[0]?.rawValue ?? null;
      }
    } catch {
      // Present but unusable on this platform — fall through to ZXing.
    }
  }

  await loadZxing();
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  return async (video) => {
    const { videoWidth: vw, videoHeight: vh } = video;
    if (!vw || !vh) return null;
    const bandH = Math.round(vh * 0.4);
    const scale = Math.min(1, 960 / vw);
    const width = Math.round(vw * scale);
    const height = Math.round(bandH * scale);
    canvas.width = width;
    canvas.height = height;
    ctx.drawImage(video, 0, Math.round((vh - bandH) / 2), vw, bandH, 0, 0, width, height);
    const { data } = ctx.getImageData(0, 0, width, height);
    const luminance = new Uint8ClampedArray(width * height);
    for (let i = 0, p = 0; i < luminance.length; i++, p += 4) {
      luminance[i] = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
    }
    return window.GymbookBarcode.decode(luminance, width, height);
  };
}

/**
 * Starts the rear camera into `video` and calls `onCode` once with the first
 * barcode read the same way on two consecutive frames — a cheap guard against
 * a half-in-frame misread. Resolves to a stop() that releases the camera; the
 * loop also stops itself if the video is taken out of the page.
 */
export async function startBarcodeScan(video, { onCode }) {
  const decode = await loadDecoder();
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: false,
  });
  video.srcObject = stream;
  video.setAttribute('playsinline', '');
  video.muted = true;
  await video.play().catch(() => {});

  let running = true;
  let previous = null;
  const stop = () => {
    running = false;
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
  };

  const tick = async () => {
    if (!running) return;
    if (!video.isConnected) {
      stop();
      return;
    }
    try {
      const code = (await decode(video))?.trim() || null;
      if (code && code === previous) {
        stop();
        onCode(code);
        return;
      }
      previous = code;
    } catch {
      // A frame that arrives before the stream has dimensions — keep going.
    }
    setTimeout(tick, 140);
  };
  tick();
  return stop;
}
