import { findClassNotes } from './notesFinder.js';
import { youtubeOutput } from './streamer.js';
import { createStudioApi, parseServerUrl } from './studioApi.js';

/**
 * What the dock's page can ask the main process to do — one method per IPC
 * channel (main.js wires them to `studio:<name>`). Kept free of Electron so
 * it can be tested, and driven by a plain browser, without one: the OS
 * pieces (the settings file, the sealed key, the file dialogs, the window)
 * come in as `deps`.
 *
 * Every method resolves to `{ ok, data }` or `{ ok: false, error, ... }`.
 */

export const MAX_NOTES_BYTES = 15 * 1024 * 1024; // the server's limit (MAX_MATERIAL_BYTES)

const positiveId = (value) => (Number.isInteger(value) && value > 0 ? value : null);

const CHANNEL_ID = /^UC[\w-]{22}$/;
/** What students' apps play: the channel's live feed (public streams only, a YouTube rule). */
export const channelWatchUrl = (channelId) => `https://www.youtube.com/embed/live_stream?channel=${channelId}`;

/**
 * @param {object} deps
 * @param {{ get(): object, save(patch: object): void }} deps.settings
 * @param {{ available(): boolean, save(t: string): void, load(): string|null, clear(): void }} deps.tokens
 * @param {{ size(path: string): number, read(path: string): Buffer }} deps.files
 * @param {() => Promise<string|null>} deps.pickFolder
 * @param {() => Promise<{path: string, name: string, size: number, modified: number}|null>} deps.pickPdf
 * @param {(mode: string, width: number, height: number) => {side: string}} deps.resize
 * @param {() => void} deps.quit
 * @param {{ save(t: string): void, load(): string|null, clear(): void }} deps.streamKey
 *   The YouTube stream key, sealed like the device token.
 * @param {{ start(o: object): void, stop(): void }} deps.streamer See streamer.js.
 * @param {{ available(): boolean, get(): boolean, set(on: boolean): void }} deps.startup
 *   Opening Studio when the board signs in to Windows — the installed app only.
 * @param {typeof fetch} [deps.fetchImpl]
 */
export function createController(deps) {
  const { settings, tokens, files, fetchImpl, streamKey, streamer, startup } = deps;
  let token = tokens.load();
  let api = null;
  let socketOrigin = null;
  /** The institute's YouTube channel, when one is connected in CoachBook (from /me):
   * each class then streams as its own unlisted broadcast, and no key is typed in here. */
  let channel = null;
  /** Private streaming is on in CoachBook (from /me): classes go to the board's own
   * private input, played in CoachBook's player — neither the channel nor a key is used. */
  let privateOn = false;
  /** PDFs the page may upload: ones found in the export folder or picked by the teacher. */
  const offered = new Set();

  function connect(serverUrl) {
    const parsed = parseServerUrl(serverUrl);
    if (parsed.error) return parsed;
    api = createStudioApi({ base: parsed.base, getToken: () => token, fetchImpl });
    socketOrigin = parsed.socketOrigin;
    return parsed;
  }
  if (settings.get().serverUrl) connect(settings.get().serverUrl);

  const notPaired = { ok: false, status: 401, error: 'This board is not paired' };
  const withApi = (fn) => (arg = {}) => (api ? fn(arg) : notPaired);

  /**
   * The YouTube set-up, as the page may see it: never the key itself.
   * `private`: CoachBook streams the institute's classes privately, to this
   * board's own input. `unlisted`: the channel is connected in CoachBook,
   * which makes each class's broadcast. Neither: the typed-in key streams to
   * the channel's public live feed. `managed` is either of the first two —
   * CoachBook says where the video goes, and nothing is typed in here.
   */
  function streaming() {
    const s = settings.get().stream ?? {};
    const hasKey = Boolean(streamKey.load());
    const unlisted = !privateOn && Boolean(channel);
    const keyed = !privateOn && !channel && CHANNEL_ID.test(s.channelId ?? '');
    return {
      ready: privateOn || unlisted || (hasKey && keyed),
      private: privateOn,
      unlisted,
      managed: privateOn || unlisted,
      channelTitle: channel?.channel_title ?? null,
      hasKey,
      channelId: s.channelId ?? '',
      cameraId: s.cameraId ?? '',
      micId: s.micId ?? '',
      watchUrl: keyed ? channelWatchUrl(s.channelId) : null,
    };
  }

  async function status() {
    const s = settings.get();
    const base = {
      serverUrl: s.serverUrl ?? '',
      notesDir: s.notesDir ?? '',
      encryption: tokens.available(),
      streaming: streaming(),
      // null where it cannot be set: run from source, it would register electron.exe.
      startAtLogin: startup.available() ? startup.get() : null,
    };
    if (!token || !api) return { ok: true, data: { ...base, paired: false } };
    const me = await api.me();
    if (me.status === 401) {
      // Re-paired or removed in CoachBook: this key is dead.
      tokens.clear();
      token = null;
      channel = null;
      privateOn = false;
      return { ok: true, data: { ...base, streaming: streaming(), paired: false, notice: 'This board was unpaired in CoachBook. Pair it again.' } };
    }
    if (!me.ok) return { ok: true, data: { ...base, paired: true, offline: true, error: me.error } };
    channel = me.data.youtube?.connected ? me.data.youtube : null;
    privateOn = me.data.private_stream?.on === true;
    return { ok: true, data: { ...base, streaming: streaming(), paired: true, device: me.data.device, institute: me.data.institute } };
  }

  return {
    status,

    async pair({ serverUrl, code } = {}) {
      const parsed = connect(serverUrl);
      if (parsed.error) return { ok: false, error: parsed.error };
      const res = await api.pair(String(code ?? ''));
      if (!res.ok) return res;
      tokens.save(res.data.token);
      token = res.data.token;
      settings.save({ serverUrl: parsed.base });
      return status();
    },

    async unpair() {
      tokens.clear();
      token = null;
      return { ok: true };
    },

    async chooseNotesDir() {
      const dir = await deps.pickFolder();
      if (!dir) return { ok: false, cancelled: true };
      settings.save({ notesDir: dir });
      return { ok: true, data: { notesDir: dir } };
    },

    async setStartAtLogin({ on } = {}) {
      if (!startup.available()) return { ok: false, error: 'Only the installed Studio can start with Windows' };
      startup.set(on === true);
      return { ok: true, data: { startAtLogin: startup.get() } };
    },

    lectures: withApi(() => api.lectures()),

    goLive: withApi(async ({ slotId }) => {
      const { ready, watchUrl } = streaming();
      const res = await api.goLive(positiveId(slotId), ready ? watchUrl : null);
      // Already on air from the teacher's phone: join that class instead.
      if (res.status === 409 && res.details?.code === 'batch_already_live') return api.session(res.details.session_id);
      return res;
    }),

    /* — YouTube Live — */

    async streamSettings() {
      return { ok: true, data: streaming() };
    },

    /** Saves the set-up. A blank key leaves the saved one; `clearKey` forgets it. */
    async saveStreamSettings({ streamKey: key, clearKey, channelId, cameraId, micId } = {}) {
      const channel = String(channelId ?? '').trim();
      if (channel && !CHANNEL_ID.test(channel)) {
        return { ok: false, error: 'The channel ID starts with UC and is 24 characters — YouTube Studio → Settings → Channel → Advanced settings' };
      }
      const typed = String(key ?? '').trim();
      if (typed && !/^[\w-]{8,64}$/.test(typed)) return { ok: false, error: 'That does not look like a YouTube stream key' };
      if (clearKey) streamKey.clear();
      else if (typed) streamKey.save(typed);
      settings.save({ stream: { channelId: channel, cameraId: String(cameraId ?? ''), micId: String(micId ?? '') } });
      return { ok: true, data: streaming() };
    },

    /**
     * Starts ffmpeg; the page then feeds it (studio:stream-chunk). With the
     * channel connected in CoachBook, CoachBook makes the class's unlisted
     * broadcast and says where to send it; otherwise the typed-in key.
     */
    async streamStart({ sessionId } = {}) {
      if (privateOn) {
        if (!api) return notPaired;
        const res = await api.privateStream(positiveId(sessionId));
        if (!res.ok) {
          // Switched back to YouTube in CoachBook since the board last looked.
          if (res.details?.code === 'private_stream_off') privateOn = false;
          return res;
        }
        // Served by CoachBook itself (HLS uploads), or by Cloudflare (RTMPS).
        const where = res.data.hls ? { hls: res.data.hls } : { output: res.data.output };
        return { ok: true, data: { run: streamer.start({ ...where, secret: res.data.stream_key }) } };
      }
      if (channel) {
        if (!api) return notPaired;
        const res = await api.youtube(positiveId(sessionId));
        if (!res.ok) {
          // Disconnected in CoachBook since the board last looked: the typed-in key, if any, from now on.
          if (res.details?.code === 'youtube_not_connected') channel = null;
          return res;
        }
        return { ok: true, data: { run: streamer.start({ output: res.data.output, secret: res.data.stream_key }) } };
      }
      const key = streamKey.load();
      if (!key || !streaming().ready) return { ok: false, error: 'YouTube Live is not set up on this board' };
      return { ok: true, data: { run: streamer.start({ output: youtubeOutput(key), secret: key }) } };
    },

    async streamStop() {
      streamer.stop();
      return { ok: true };
    },

    /**
     * Points the class at this board's broadcast — for a class started from a
     * phone. Unlisted, streamStart already did: asking for the broadcast sets it.
     */
    attachStream: withApi(async ({ sessionId }) => {
      if (privateOn || channel) return { ok: true, data: null };
      const { ready, watchUrl } = streaming();
      if (!ready) return { ok: false, error: 'YouTube Live is not set up on this board' };
      return api.attachStream(positiveId(sessionId), watchUrl);
    }),

    session: withApi(({ sessionId }) => api.session(positiveId(sessionId))),

    socketUrl: withApi(async ({ sessionId }) => {
      const res = await api.socketTicket(positiveId(sessionId));
      if (!res.ok) return res;
      return { ok: true, data: { url: `${socketOrigin}${res.data.path}?ticket=${encodeURIComponent(res.data.ticket)}` } };
    }),

    endClass: withApi(async ({ sessionId }) => {
      const res = await api.endClass(positiveId(sessionId));
      // Ended already (from a phone, or a second tap): over is over.
      if (res.status === 409 && /already ended/.test(res.error)) return { ok: true, data: null };
      return res;
    }),

    async findNotes({ since } = {}) {
      const found = await findClassNotes(settings.get().notesDir, { since: Number(since) || 0 });
      if (found) offered.add(found.path);
      return { ok: true, data: found };
    },

    async pickNotesFile() {
      const picked = await deps.pickPdf();
      if (!picked) return { ok: false, cancelled: true };
      offered.add(picked.path);
      return { ok: true, data: picked };
    },

    publishNotes: withApi(async ({ sessionId, file } = {}) => {
      if (!offered.has(file)) return { ok: false, error: 'That file was not offered for upload' };
      if (files.size(file) > MAX_NOTES_BYTES) return { ok: false, error: 'The PDF is over 15 MB — export it at a lower quality from Note 3' };
      return api.publishNotes(positiveId(sessionId), files.read(file));
    }),

    async resize({ mode, width, height } = {}) {
      const w = Math.min(Math.max(Math.round(Number(width) || 92), 60), 1400);
      const h = Math.min(Math.max(Math.round(Number(height) || 380), 60), 1400);
      return { ok: true, data: await deps.resize(String(mode || 'panel'), w, h) };
    },

    async quit() {
      deps.quit();
      return { ok: true };
    },
  };
}
