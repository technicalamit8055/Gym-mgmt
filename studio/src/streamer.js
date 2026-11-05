import { spawn } from 'node:child_process';

/**
 * The board's YouTube Live broadcast, from the main process's side.
 *
 * The dock's page captures the screen (and the camera and microphone), lays
 * them out on a canvas and records it as WebM (renderer/broadcast.js). The
 * chunks come here over IPC and go into ffmpeg's stdin; ffmpeg re-encodes to
 * what YouTube ingests — H.264 with a keyframe every two seconds, and AAC —
 * and pushes it over RTMPS, so the stream key is never sent in the clear.
 *
 * ffmpeg repeats its output address in its errors, and that address holds
 * the stream key: every message that leaves here has the key blanked out.
 */

export const YOUTUBE_INGEST = 'rtmps://a.rtmps.youtube.com:443/live2';
export const youtubeOutput = (streamKey) => `${YOUTUBE_INGEST}/${streamKey}`;

/**
 * Whether ffmpeg's progress report (-progress on stdout) says it has sent
 * anything: only then is the stream on air. ffmpeg merely running is not
 * enough — it waits, silently, for the page's first video before it even
 * connects to YouTube.
 */
export const sentBytes = (progress) => [...String(progress).matchAll(/total_size=(\d+)/g)].some((m) => Number(m[1]) > 0)
  // HLS reports no size (N/A): past the first two-second segment, which
  // ffmpeg has then uploaded — a refused upload ends ffmpeg instead.
  || [...String(progress).matchAll(/out_time_us=(\d+)/g)].some((m) => /total_size=N\/A/.test(progress) && Number(m[1]) > 2_500_000);

/** WebM from the page on stdin, an FLV stream of H.264 and AAC out. */
export function ffmpegArgs({ output, fps = 30, videoKbps = 2500 }) {
  return [
    '-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1',
    '-fflags', '+genpts',
    '-i', 'pipe:0',
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-profile:v', 'main', '-pix_fmt', 'yuv420p',
    // The recorder's frame timing wanders; YouTube wants a steady rate and a keyframe every 2s.
    '-fps_mode', 'cfr', '-r', String(fps), '-g', String(fps * 2), '-keyint_min', String(fps * 2), '-sc_threshold', '0',
    '-b:v', `${videoKbps}k`, '-maxrate', `${videoKbps}k`, '-bufsize', `${videoKbps * 2}k`,
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
    '-f', 'flv', output,
  ];
}

/**
 * The qualities a private class is sent in, from the board's 1280×720
 * canvas: students pick one (or Auto) in the app's player. Encoding three is
 * the board's work, so the server only stores and serves — no transcoding.
 */
export const RENDITIONS = [
  { height: 720, kbps: 2200 },
  { height: 480, kbps: 1000 },
  { height: 360, kbps: 550 },
];

/**
 * WebM from the page on stdin, out as HLS in every rendition, uploaded to
 * CoachBook (`hls`, a URL ending in "/") with HTTP PUTs: a master playlist,
 * one playlist per rendition, and two-second segments. See
 * src/coaching/selfHostedStream.js on the server.
 */
export function hlsArgs({ hls, fps = 30 }) {
  const n = RENDITIONS.length;
  const graph = `[0:v]fps=${fps},split=${n}${RENDITIONS.map((_, i) => `[s${i}]`).join('')};`
    + RENDITIONS.map((r, i) => `[s${i}]scale=-2:${r.height}[v${i}]`).join(';');
  return [
    '-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1',
    '-fflags', '+genpts',
    '-i', 'pipe:0',
    '-filter_complex', graph,
    ...RENDITIONS.flatMap((_, i) => ['-map', `[v${i}]`]),
    ...RENDITIONS.flatMap(() => ['-map', '0:a']),
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-profile:v', 'main', '-pix_fmt', 'yuv420p',
    // A keyframe every segment, at the same instant in every rendition, so the player can switch between them.
    '-g', String(fps * 2), '-keyint_min', String(fps * 2), '-sc_threshold', '0',
    ...RENDITIONS.flatMap((r, i) => [`-b:v:${i}`, `${r.kbps}k`, `-maxrate:v:${i}`, `${r.kbps}k`, `-bufsize:v:${i}`, `${r.kbps * 2}k`]),
    '-c:a', 'aac', '-b:a', '96k', '-ar', '44100', '-ac', '2',
    '-f', 'hls', '-hls_time', '2', '-hls_list_size', '6',
    // No delete_segments: the server drops old segments itself. On Windows,
    // ffmpeg asks to delete "<token>\<file>", which no route answers, and
    // through nginx those requests stalled the uploads until ffmpeg gave up —
    // about a minute into every run, so the class kept dropping and restarting.
    '-hls_flags', 'independent_segments',
    '-method', 'PUT',
    // One kept-open connection that waits for each answer. Otherwise ffmpeg
    // hangs up the moment a file is sent, and a proxy in front of the server
    // (nginx) drops the upload as cut short: students wait for a video that
    // never arrives.
    '-http_persistent', '1',
    '-master_pl_name', 'master.m3u8',
    '-var_stream_map', RENDITIONS.map((_, i) => `v:${i},a:${i}`).join(' '),
    '-hls_segment_filename', `${hls}stream_%v_%05d.ts`,
    `${hls}stream_%v.m3u8`,
  ];
}

/** ffmpeg's last words, as a teacher can act on them — with the key blanked. */
export function explainFailure(stderr, secret) {
  const text = secret ? String(stderr).split(secret).join('••••') : String(stderr);
  if (/Failed to resolve|getaddrinfo|Network is unreachable|Connection timed out/i.test(text)) {
    return 'Cannot reach the streaming service — check the board’s internet connection.';
  }
  if (/Input\/output error|Connection refused|Broken pipe|Server returned 4\d\d|handshake/i.test(text)) {
    return 'The stream was not accepted. On YouTube, check the stream key, and that the channel is enabled for live streaming.';
  }
  const last = text.trim().split(/\r?\n/).filter(Boolean).pop();
  return last ? `The stream stopped: ${last}` : 'The stream stopped.';
}

/**
 * @param {object} deps
 * @param {string} deps.ffmpegPath
 * @param {(status: {state: 'starting'|'live'|'stopped'|'failed', run: number, error?: string}) => void} deps.onStatus
 * @param {typeof spawn} [deps.spawnImpl]
 */
export function createStreamer({ ffmpegPath, onStatus: report, spawnImpl = spawn }) {
  let proc = null;
  let runs = 0;

  /** Starts a run and returns its number; every status says which run it is
   * about, so a restart is not confused by the last run's exit. */
  /** `output`: an RTMP(S) address (YouTube, Cloudflare). `hls`: CoachBook's own upload address. */
  function start({ output, hls, secret }) {
    stop();
    runs += 1;
    const run = runs;
    const onStatus = (status) => report({ ...status, run });
    let stderr = '';
    let stopping = false;
    const child = spawnImpl(ffmpegPath, hls ? hlsArgs({ hls }) : ffmpegArgs({ output }), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    proc = { child, stop: () => { stopping = true; } };
    child.stderr?.on('data', (data) => { stderr = (stderr + data).slice(-4000); });
    let onAir = false;
    child.stdout?.on('data', (data) => {
      if (onAir || proc?.child !== child || !sentBytes(data)) return;
      onAir = true;
      onStatus({ state: 'live' });
    });
    // A dead ffmpeg makes the next write fail with EPIPE; the exit below reports why.
    child.stdin?.on('error', () => {});
    child.on('error', (err) => {
      if (proc?.child === child) proc = null;
      onStatus({ state: 'failed', error: `Could not start the stream (${err.code || err.message}).` });
    });
    child.on('exit', () => {
      if (proc?.child === child) proc = null;
      onStatus(stopping ? { state: 'stopped' } : { state: 'failed', error: explainFailure(stderr, secret) });
    });
    onStatus({ state: 'starting' });
    return run;
  }

  function write(chunk) {
    const stdin = proc?.child.stdin;
    if (stdin?.writable) stdin.write(Buffer.from(chunk));
  }

  /** Ends the input, so ffmpeg flushes and closes the stream; forced after 4s. */
  function stop() {
    if (!proc) return;
    const { child } = proc;
    proc.stop();
    proc = null;
    child.stdin?.end();
    setTimeout(() => {
      if (child.exitCode === null) child.kill();
    }, 4000).unref?.();
  }

  return { start, write, stop, get running() { return Boolean(proc); } };
}
