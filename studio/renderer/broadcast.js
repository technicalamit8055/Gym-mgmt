/**
 * The board's YouTube broadcast, from the page's side: the screen (Note 3),
 * the teacher's camera in the corner, and the microphone, drawn onto a
 * 1280×720 canvas and recorded as WebM in half-second chunks for the main
 * process to hand to ffmpeg (src/streamer.js).
 *
 * The main process picks the screen (main.js, setDisplayMediaRequestHandler)
 * and keeps the Studio window itself out of the capture.
 */

const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 30;
/** The camera's corner: a 16:9 picture a quarter of the frame wide. */
const CAMERA = { width: 320, height: 180, margin: 24, radius: 14 };

/** A stream, or null when the device is missing or refused. */
async function media(constraints) {
  try {
    return await navigator.mediaDevices.getUserMedia(constraints);
  } catch {
    return null;
  }
}

async function playing(stream) {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  await video.play();
  return video;
}

/** Cameras and microphones, by name — asking for access once if the names are hidden. */
export async function listDevices() {
  let devices = await navigator.mediaDevices.enumerateDevices();
  if (devices.some((d) => (d.kind === 'videoinput' || d.kind === 'audioinput') && !d.label)) {
    const probe = await media({ audio: true, video: true }) ?? await media({ audio: true });
    probe?.getTracks().forEach((t) => t.stop());
    devices = await navigator.mediaDevices.enumerateDevices();
  }
  const named = (kind, fallback) => devices
    .filter((d) => d.kind === kind && d.deviceId !== 'default' && d.deviceId !== 'communications')
    .map((d, i) => ({ id: d.deviceId, label: d.label || `${fallback} ${i + 1}` }));
  return { cameras: named('videoinput', 'Camera'), mics: named('audioinput', 'Microphone') };
}

/** Draws `video` to fill (cover) or fit (contain) a box. */
function drawInto(ctx, video, x, y, w, h, cover) {
  const vw = video.videoWidth || w;
  const vh = video.videoHeight || h;
  const scale = cover ? Math.max(w / vw, h / vh) : Math.min(w / vw, h / vh);
  const dw = vw * scale;
  const dh = vh * scale;
  ctx.drawImage(video, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

/**
 * Starts capturing and recording. `onChunk` gets each piece of WebM, in
 * order; `onEnded` is told if the screen capture stops on its own.
 *
 * @param {{cameraId: string, micId: string, onChunk: (b: ArrayBuffer) => void, onEnded: (why: string) => void}} opts
 *   cameraId 'off' leaves the camera out; '' means the default device.
 */
export async function startBroadcast({ cameraId, micId, onChunk, onEnded }) {
  const screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: FPS }, audio: false });
  const camera = cameraId === 'off'
    ? null
    : await media({ video: { deviceId: cameraId ? { exact: cameraId } : undefined, width: { ideal: 640 }, height: { ideal: 360 } } });
  const mic = await media({ audio: { deviceId: micId ? { exact: micId } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  const screenVideo = await playing(screen);
  const cameraVideo = camera ? await playing(camera) : null;

  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext('2d', { alpha: false });
  const draw = () => {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    drawInto(ctx, screenVideo, 0, 0, WIDTH, HEIGHT, false);
    if (cameraVideo) {
      const { width: w, height: h, margin, radius } = CAMERA;
      const x = WIDTH - w - margin;
      const y = HEIGHT - h - margin;
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, radius);
      ctx.clip();
      drawInto(ctx, cameraVideo, x, y, w, h, true);
      ctx.restore();
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, radius);
      ctx.stroke();
    }
  };
  // A timer, not requestAnimationFrame: the window is never "visible" enough
  // to be painted when it is just the dock (main.js turns throttling off).
  const timer = setInterval(draw, 1000 / FPS);
  draw();

  const out = canvas.captureStream(FPS);
  // YouTube wants a sound track even from a silent board.
  let silence = null;
  if (mic) {
    out.addTrack(mic.getAudioTracks()[0]);
  } else {
    // A destination with nothing playing into it sends no audio at all, and
    // the recorder then waits for audio and records nothing: play it a muted tone.
    silence = new AudioContext();
    const quiet = silence.createMediaStreamDestination();
    const mute = silence.createGain();
    mute.gain.value = 0;
    const tone = silence.createOscillator();
    tone.connect(mute).connect(quiet);
    tone.start();
    out.addTrack(quiet.stream.getAudioTracks()[0]);
  }

  const recorder = new MediaRecorder(out, { mimeType: 'video/webm;codecs=vp8,opus', videoBitsPerSecond: 4_000_000, audioBitsPerSecond: 128_000 });
  // In order: each chunk's bytes are read asynchronously.
  let queue = Promise.resolve();
  recorder.ondataavailable = (event) => {
    if (!event.data.size) return;
    queue = queue.then(async () => onChunk(await event.data.arrayBuffer()));
  };
  recorder.start(500);
  screen.getVideoTracks()[0].addEventListener('ended', () => onEnded?.('The screen capture stopped'));

  return {
    camera: Boolean(camera),
    mic: Boolean(mic),
    stop() {
      clearInterval(timer);
      if (recorder.state !== 'inactive') recorder.stop();
      for (const stream of [screen, camera, mic]) stream?.getTracks().forEach((t) => t.stop());
      silence?.close();
    },
  };
}
