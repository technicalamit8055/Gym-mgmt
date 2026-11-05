import { listDevices, startBroadcast } from './broadcast.js';

/**
 * The dock's page. Everything outside this page — the device token, the API,
 * the file system, ffmpeg — is the main process's (main.js), reached through
 * `window.studio` (preload.cjs). The class itself is a WebSocket on the
 * server's live gateway, which this page holds as the class's teacher.
 *
 * Small on purpose: the board is the lesson, so the dock is a slim strip on
 * its edge, every panel is a pop-up beside it sized to what it holds, and the
 * dock folds down to a single LIVE bubble. Every screen, not only the dock,
 * can be dragged by its grip and folded to a bubble. The window is resized to fit
 * whatever is showing, so nothing transparent sits over Note 3.
 *
 * Polls run the way a class on a projected board needs them to: the teacher
 * launches A–D with a timer, and only once the voting is over taps the right
 * answer to reveal it — choosing it first would put it on the board.
 *
 * "Next topic" (the Topic button, or Ctrl+Alt+M over Note 3) puts a chapter
 * marker on the class's recording. Its time is the board's own count of
 * time on air, not of the class: the recording starts when the stream does,
 * and a stream that drops and comes back leaves the gap out of the video.
 *
 * Rendering is plain DOM. Text from students (doubts, names) only ever goes
 * in as text nodes, never as HTML. The clocks update their own elements in
 * place rather than re-rendering, so a finger mid-tap (or mid-drag on the
 * grip) never has its element swapped out from under it.
 */

const studio = window.studio;

/** Window widths per view, in device-independent pixels; heights fit the content. */
const WIDTHS = { setup: 400, lectures: 400, youtube: 400, notes: 400, dock: 92, mini: 84, panel: 92 + 350 };
const MAX_HEIGHT = 640;
const SHELL_PADDING = 20;
const POLL_DURATIONS = [30, 45];
const NOTES_SEARCH_MS = 3 * 60_000;
const STREAM_RETRIES = 3;

const state = {
  view: 'boot', // boot | setup | lectures | youtube | live | notes
  side: 'right',
  status: null,
  busy: false,
  error: null,
  form: null,
  lectures: null,
  unpairArmed: false,
  session: null,
  startedAt: 0,
  conn: 'connecting',
  collapsed: false,
  panel: null, // poll | poll-live | reveal | results | doubts | markers | end | stream
  poll: null,
  results: null,
  doubts: [],
  pinnedId: null,
  unread: 0,
  stream: null, // { state, error, run }
  streamForm: null,
  devices: null,
  notes: null,
  markers: [],
  markLabel: '',
  marked: null, // the label just marked, shown on the Topic button for a moment
};

/* ── DOM ─────────────────────────────────────────────────────────────── */

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'style') Object.assign(el.style, value);
    else if (key === 'value') el.value = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

const app = document.getElementById('app');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const mmss = (ms) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const mins = String(Math.floor((total % 3600) / 60)).padStart(hours ? 2 : 1, '0');
  return `${hours ? `${hours}:` : ''}${mins}:${String(total % 60).padStart(2, '0')}`;
};
const megabytes = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
/** The server's UTC "YYYY-MM-DD HH:MM:SS" as epoch ms. */
const utcMs = (stamp) => Date.parse(`${String(stamp).replace(' ', 'T')}Z`);
const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;

/* ── Window size: fitted to what is showing ──────────────────────────── */

function sizeKey() {
  if (state.collapsed && state.view !== 'boot') return 'mini';
  if (state.view === 'live') return state.panel ? 'panel' : 'dock';
  return state.view === 'boot' ? 'setup' : state.view;
}

let size = { w: 0, h: 0 };
async function resizeTo(key, w, hgt) {
  if (w === size.w && hgt === size.h) return;
  size = { w, h: hgt };
  const res = await studio.resize({ mode: key === 'dock' || key === 'mini' ? 'dock' : 'panel', width: w, height: hgt });
  if (res.ok) state.side = res.data.side;
}

/** The tallest thing on show, plus the shell's padding. */
const contentHeight = () => Math.min(MAX_HEIGHT, Math.ceil(Math.max(60, ...[...app.children].map((c) => c.getBoundingClientRect().height))) + SHELL_PADDING);

let dragging = false;
let renderQueued = false;
let chain = Promise.resolve();

/**
 * Re-draws the page after a state change (never on a clock tick): width
 * first, so the text wraps as it will; then the height it came out at.
 */
function update() {
  chain = chain.then(async () => {
    if (dragging) {
      renderQueued = true;
      return;
    }
    const key = sizeKey();
    const width = WIDTHS[key];
    if (width !== size.w) await resizeTo(key, width, size.h || 300);
    render();
    await resizeTo(key, width, contentHeight());
    render(); // the side may have changed with the size
  }).catch((err) => console.error(err));
  return chain;
}

function render() {
  const scrolled = app.querySelector('.scroll')?.scrollTop ?? 0;
  app.className = `shell side-${state.side}`;
  const views = { boot: () => [], setup: setupView, lectures: lecturesView, youtube: youtubeView, live: liveView, notes: notesView };
  const view = state.collapsed && state.view !== 'boot' ? mini : views[state.view];
  app.replaceChildren(...[view()].flat().filter(Boolean));
  const list = app.querySelector('.scroll');
  if (list) list.scrollTop = scrolled;
  tick();
}

/** The clocks: elapsed class time and the poll countdown, updated in place. */
function tick() {
  const now = Date.now();
  for (const el of app.querySelectorAll('[data-tick="elapsed"]')) el.textContent = mmss(now - state.startedAt);
  for (const el of app.querySelectorAll('[data-tick="poll-left"]')) {
    el.textContent = state.poll ? `${Math.ceil(Math.max(0, state.poll.endsAt - now) / 1000)}s` : '';
  }
  for (const el of app.querySelectorAll('[data-tick="votes"]')) el.textContent = state.poll ? `${state.poll.votes ?? 0}` : '';
}
setInterval(tick, 500);

/* ── Setup: pairing ──────────────────────────────────────────────────── */

function setupView() {
  const s = state.status ?? {};
  // What was typed lives in state, so a re-render (the busy state, an error) keeps it.
  state.form ??= { server: s.serverUrl || '', code: '' };
  const input = (field, props) => h('input', { ...props, value: state.form[field], oninput: (event) => { state.form[field] = event.target.value; } });
  const submit = async () => {
    state.busy = true;
    state.error = null;
    update();
    const res = await studio.pair({ serverUrl: state.form.server, code: state.form.code });
    state.busy = false;
    if (!res.ok) {
      state.error = res.error;
      return update();
    }
    state.status = res.data;
    state.form = null;
    return showLectures();
  };
  return h('section', { class: 'card' },
    cardBar(),
    h('div', { class: 'brand' }, 'CoachBook Studio'),
    h('h1', null, 'Pair this smartboard'),
    h('p', null, 'A manager adds this board to its classroom in CoachBook and gets a pairing code. Type the institute’s address and that code.'),
    s.notice && h('p', { class: 'notice' }, s.notice),
    h('label', null, 'CoachBook address', input('server', { id: 'server', type: 'url', placeholder: 'https://coachbook.in/g/your-institute', autocomplete: 'off' })),
    h('label', null, 'Pairing code', input('code', { id: 'code', type: 'text', placeholder: 'ABCD-EFGH', maxlength: '9', autocomplete: 'off', spellcheck: 'false' })),
    state.error && h('p', { class: 'error', role: 'alert' }, state.error),
    s.encryption === false && h('p', { class: 'error' }, 'This computer cannot encrypt the board’s key, so pairing will not be saved.'),
    h('button', { class: 'btn primary wide', disabled: state.busy, onclick: submit }, state.busy ? 'Pairing…' : 'Pair board'),
    h('div', { class: 'row end' }, h('button', { class: 'btn quiet small', onclick: () => studio.quit() }, 'Quit')));
}

/* ── Today's lectures ────────────────────────────────────────────────── */

async function showLectures() {
  state.view = 'lectures';
  state.error = null;
  state.lectures = null;
  update();
  const res = await studio.lectures();
  if (res.status === 401) return boot();
  state.lectures = res.ok ? res.data : null;
  state.error = res.ok ? null : res.error;
  return update();
}

async function goLive(lecture) {
  state.busy = true;
  state.error = null;
  update();
  const res = lecture.live_session_id ? await studio.session({ sessionId: lecture.live_session_id }) : await studio.goLive({ slotId: lecture.slot_id });
  state.busy = false;
  if (!res.ok) {
    state.error = res.error;
    return update();
  }
  return enterClass(res.data);
}

function lecturesView() {
  const s = state.status ?? {};
  const room = state.lectures?.classroom ?? s.device?.classroom_name ?? '';
  const items = state.lectures?.items;
  const yt = s.streaming ?? {};
  return h('section', { class: 'card' },
    cardBar(),
    h('div', { class: 'row' },
      h('div', { class: 'spacer' },
        h('div', { class: 'brand' }, s.institute || 'CoachBook Studio'),
        h('h1', null, room ? `Today in ${room}` : 'Today’s lectures')),
      h('button', { class: 'icon-btn', title: 'Refresh', 'aria-label': 'Refresh', onclick: showLectures }, '↻')),
    s.offline && h('p', { class: 'notice' }, `Offline: ${s.error}`),
    state.error && h('p', { class: 'error', role: 'alert' }, state.error),
    h('div', { class: 'scroll' },
      !items
        ? h('p', { class: 'empty' }, state.error ? '' : 'Loading…')
        : items.length
          ? items.map((lecture) => h('div', { class: `lecture${lecture.live_session_id ? ' is-live' : ''}` },
            h('div', { class: 'what' },
              h('strong', null, `${lecture.start_time} · ${lecture.subject_name}`),
              h('span', null, `${lecture.batch_name} · ${lecture.faculty_name || 'No teacher set'}`)),
            h('button', {
              class: `btn small ${lecture.live_session_id ? 'danger' : 'primary'}`,
              disabled: state.busy || (!lecture.faculty_id && !lecture.live_session_id),
              onclick: () => goLive(lecture),
            }, lecture.live_session_id ? 'Join live' : 'Go live')))
          : h('p', { class: 'empty' },
            `No lectures are timetabled in ${room || 'this room'} today. A lecture shows here on its day when its room — or its batch’s room — is “${room}”, spelt the same as the classroom.`)),
    h('div', { class: 'setting' },
      h('div', { class: 'spacer' },
        h('strong', null, yt.private ? 'Live stream' : 'YouTube Live'),
        h('span', null, yt.private
          ? 'Private — only the batch’s students, in the CoachBook app'
          : yt.unlisted
            ? `Unlisted on ${yt.channelTitle || 'the institute’s channel'} — each class is its own video`
            : yt.ready ? 'Ready — the board streams when you go live' : 'Not set up — classes run without a stream')),
      h('button', { class: `btn small${yt.ready ? '' : ' primary'}`, onclick: showYoutube }, yt.managed ? 'Camera' : yt.ready ? 'Change' : 'Set up')),
    h('div', { class: 'setting' },
      h('div', { class: 'spacer' },
        h('strong', null, 'Note 3 exports'),
        h('span', { class: 'folder', title: s.notesDir || '' }, s.notesDir || 'Folder not set')),
      h('button', { class: `btn small${s.notesDir ? '' : ' primary'}`, onclick: chooseFolder }, s.notesDir ? 'Change' : 'Set')),
    typeof s.startAtLogin === 'boolean' && h('div', { class: 'setting' },
      h('div', { class: 'spacer' },
        h('strong', null, 'Start with Windows'),
        h('span', null, s.startAtLogin ? 'On — the dock opens when the board signs in' : 'Off — open Studio from the Start menu')),
      h('button', { class: 'btn small', onclick: toggleStartAtLogin }, s.startAtLogin ? 'Turn off' : 'Turn on')),
    h('div', { class: 'row' },
      h('button', {
        class: `btn small ${state.unpairArmed ? 'danger' : 'quiet'}`,
        onclick: async () => {
          if (!state.unpairArmed) {
            state.unpairArmed = true;
            setTimeout(() => { state.unpairArmed = false; update(); }, 4000);
            return update();
          }
          await studio.unpair();
          state.unpairArmed = false;
          return boot();
        },
      }, state.unpairArmed ? 'Tap again to unpair' : 'Unpair board'),
      h('div', { class: 'spacer' }),
      h('button', { class: 'btn quiet small', onclick: () => studio.quit() }, 'Quit')));
}

async function chooseFolder() {
  const res = await studio.chooseNotesDir();
  if (res.ok) state.status = { ...state.status, notesDir: res.data.notesDir };
  return update();
}

async function toggleStartAtLogin() {
  const res = await studio.setStartAtLogin({ on: !state.status?.startAtLogin });
  if (res.ok) state.status = { ...state.status, startAtLogin: res.data.startAtLogin };
  state.error = res.ok ? null : res.error;
  return update();
}

/* ── YouTube Live set-up ─────────────────────────────────────────────── */

async function showYoutube() {
  const yt = state.status?.streaming ?? {};
  state.view = 'youtube';
  state.error = null;
  state.streamForm = { key: '', channelId: yt.channelId || '', cameraId: yt.cameraId || '', micId: yt.micId || '', hasKey: yt.hasKey };
  update();
  state.devices = await listDevices().catch(() => ({ cameras: [], mics: [] }));
  return update();
}

function youtubeView() {
  const f = state.streamForm;
  const field = (name, props) => h('input', { ...props, value: f[name], oninput: (event) => { f[name] = event.target.value; } });
  const pick = (name, options, first) => h('select', { onchange: (event) => { f[name] = event.target.value; } },
    [first, ...options].map((o) => h('option', { value: o.id, selected: f[name] === o.id }, o.label)));
  const save = async () => {
    state.busy = true;
    state.error = null;
    update();
    const res = await studio.saveStreamSettings({ streamKey: f.key, channelId: f.channelId, cameraId: f.cameraId, micId: f.micId });
    state.busy = false;
    if (!res.ok) {
      state.error = res.error;
      return update();
    }
    state.status = { ...state.status, streaming: res.data };
    return showLectures();
  };
  // Private, or the channel connected in CoachBook: CoachBook says where each class goes, so only the camera and microphone are set here.
  const { unlisted, managed, private: privately } = state.status?.streaming ?? {};
  return h('section', { class: 'card' },
    cardBar(),
    h('div', { class: 'brand' }, privately ? 'Live stream' : 'YouTube Live'),
    h('h1', null, 'Stream this board'),
    h('p', null, `Going live streams the board’s screen, camera and microphone to ${privately ? 'the batch’s students' : 'the institute’s YouTube channel'}. Studio’s own controls stay out of the stream.`),
    privately && h('p', { class: 'notice' }, 'Classes stream privately: only students of the batch can watch, inside the CoachBook app, each on their own link. This is set in CoachBook → Smartboards.'),
    unlisted && h('p', { class: 'notice' }, `Each class streams to ${state.status.streaming.channelTitle || 'the institute’s channel'} as its own unlisted video, and only that batch’s students get the link. The channel is connected in CoachBook → Smartboards.`),
    !managed && h('label', null, 'Stream key — YouTube Studio → Create → Go live → Stream',
      field('key', { type: 'password', placeholder: f.hasKey ? 'Saved — type a new one to replace it' : 'xxxx-xxxx-xxxx-xxxx-xxxx', autocomplete: 'off', spellcheck: 'false' })),
    !managed && h('label', null, 'Channel ID — YouTube Studio → Settings → Channel → Advanced',
      field('channelId', { type: 'text', placeholder: 'UC…', autocomplete: 'off', spellcheck: 'false' })),
    !managed && h('p', { class: 'notice' }, 'Students’ app plays the channel’s live feed, which YouTube shows for public streams. Set the channel’s default live visibility to Public — or connect the channel in CoachBook → Smartboards to stream classes unlisted.'),
    h('div', { class: 'two' },
      h('label', null, 'Camera', pick('cameraId', [{ id: 'off', label: 'No camera — board only' }, ...(state.devices?.cameras ?? [])], { id: '', label: 'Default camera' })),
      h('label', null, 'Microphone', pick('micId', state.devices?.mics ?? [], { id: '', label: 'Default microphone' }))),
    state.error && h('p', { class: 'error', role: 'alert' }, state.error),
    h('div', { class: 'row' },
      !managed && f.hasKey && h('button', {
        class: 'btn small quiet',
        onclick: async () => {
          const res = await studio.saveStreamSettings({ clearKey: true, channelId: f.channelId, cameraId: f.cameraId, micId: f.micId });
          if (res.ok) state.status = { ...state.status, streaming: res.data };
          return showLectures();
        },
      }, 'Turn streaming off'),
      h('div', { class: 'spacer' }),
      h('button', { class: 'btn small', onclick: showLectures }, 'Cancel'),
      h('button', { class: 'btn small primary', disabled: state.busy, onclick: save }, 'Save')));
}

/* ── The broadcast ───────────────────────────────────────────────────── */

let broadcast = null;
let streamRun = null;
let streamAttempts = 0;
let streamRetryTimer = null;

async function startStreaming() {
  const yt = state.status?.streaming;
  if (!yt?.ready || state.view !== 'live') return;
  stopStreaming();
  state.stream = { state: 'starting' };
  update();
  const started = await studio.streamStart({ sessionId: state.session?.id });
  if (!started.ok) {
    state.stream = { state: 'failed', error: started.error };
    return update();
  }
  streamRun = started.data.run;
  try {
    broadcast = await startBroadcast({
      cameraId: yt.cameraId,
      micId: yt.micId,
      onChunk: (chunk) => studio.streamChunk(chunk),
      onEnded: (why) => streamFailed(why),
    });
  } catch (err) {
    streamFailed(`Could not capture the board: ${err.message}`);
  }
  return update();
}

function stopStreaming() {
  clearTimeout(streamRetryTimer);
  onAirPause();
  broadcast?.stop();
  broadcast = null;
  streamRun = null;
  studio.streamStop();
}

/** Stops, says why, and tries again a few times while the class is on. */
function streamFailed(error) {
  stopStreaming();
  state.stream = { state: 'failed', error };
  if (state.view === 'live' && streamAttempts < STREAM_RETRIES) {
    streamAttempts += 1;
    streamRetryTimer = setTimeout(startStreaming, 5000 * streamAttempts);
  }
  update();
}

studio.onStreamStatus?.((status) => {
  // Statuses from a run already replaced (a restart) are history.
  if (status.run !== streamRun) return;
  if (status.state === 'failed') return streamFailed(status.error);
  if (status.state === 'live') {
    streamAttempts = 0;
    onAirStart();
  }
  state.stream = status;
  return update();
});

/* ── Time on air: where a marker falls in the recording ──────────────── */

/**
 * Seconds of video so far. Kept on the board for the class (localStorage),
 * so Studio restarted mid-class carries on from where its count was. With
 * no stream on this board, the class's own clock is the best there is.
 */
const onAir = { sessionId: null, ms: 0, since: 0 };
const onAirKey = (sessionId) => `studio-on-air-${sessionId}`;

function onAirLoad(sessionId) {
  let ms = 0;
  try {
    ms = Number(localStorage.getItem(onAirKey(sessionId))) || 0;
  } catch {
    // no storage: the count starts again
  }
  Object.assign(onAir, { sessionId, ms, since: 0 });
}

const onAirMs = () => onAir.ms + (onAir.since ? Date.now() - onAir.since : 0);

function onAirSave() {
  if (!onAir.sessionId) return;
  try {
    localStorage.setItem(onAirKey(onAir.sessionId), String(Math.round(onAirMs())));
  } catch {
    // as above
  }
}

function onAirStart() {
  if (!onAir.since) onAir.since = Date.now();
}

function onAirPause() {
  if (!onAir.since) return;
  onAir.ms = onAirMs();
  onAir.since = 0;
  onAirSave();
}
setInterval(() => onAir.since && onAirSave(), 5000);

const videoSeconds = () => Math.floor((state.status?.streaming?.ready ? onAirMs() : Date.now() - state.startedAt) / 1000);

/* ── The class socket ────────────────────────────────────────────────── */

let socket = null;
let reconnectTimer = null;
let attempt = 0;
let refSeq = 0;
const pending = new Map();

async function connect() {
  clearTimeout(reconnectTimer);
  if (state.view !== 'live') return;
  state.conn = 'connecting';
  const res = await studio.socketUrl({ sessionId: state.session.id });
  if (state.view !== 'live') return;
  if (!res.ok) {
    // The class was ended somewhere else: on to the notes.
    if (res.status === 409) return classOver();
    return scheduleReconnect();
  }
  const ws = new WebSocket(res.data.url);
  socket = ws;
  ws.onopen = () => {
    attempt = 0;
    state.conn = 'open';
    update();
  };
  ws.onmessage = (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.event === 'ack') {
      const resolve = pending.get(message.ref);
      pending.delete(message.ref);
      resolve?.(message);
      return;
    }
    onEvent(message.event, message.data);
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null;
    state.conn = 'offline';
    for (const resolve of pending.values()) resolve({ ok: false, error: 'Connection lost — reconnecting…' });
    pending.clear();
    update();
    scheduleReconnect();
  };
  return undefined;
}

function scheduleReconnect() {
  if (state.view !== 'live') return;
  attempt += 1;
  reconnectTimer = setTimeout(connect, Math.min(15_000, 1000 * 2 ** (attempt - 1)));
}

function disconnect() {
  clearTimeout(reconnectTimer);
  const ws = socket;
  socket = null;
  ws?.close();
}

/** Sends `{ event, data }` and resolves with the server's ack. */
function send(event, data) {
  return new Promise((resolve) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      resolve({ ok: false, error: 'Not connected — reconnecting…' });
      return;
    }
    refSeq += 1;
    const ref = refSeq;
    pending.set(ref, resolve);
    socket.send(JSON.stringify({ event, data, ref }));
    setTimeout(() => {
      if (pending.delete(ref)) resolve({ ok: false, error: 'CoachBook did not answer' });
    }, 8000);
  });
}

const withEnd = (poll) => ({ ...poll, endsAt: Date.now() + (poll.remaining_ms ?? 0) });

/** A pop-up the class's own events opened unfolds a folded dock. */
function openPanel(panel) {
  state.panel = panel;
  state.collapsed = false;
}

function onEvent(event, data) {
  switch (event) {
    case 'room:joined':
      state.doubts = data.doubts ?? [];
      state.pinnedId = data.pinned_doubt?.id ?? null;
      state.poll = data.poll ? withEnd(data.poll) : null;
      break;
    case 'poll:started':
      state.poll = withEnd(data);
      break;
    case 'poll:tick':
      // Every second: in place, not re-rendered.
      if (state.poll?.poll_id === data.poll_id) state.poll = withEnd({ ...state.poll, ...data });
      return;
    case 'poll:end':
      state.poll = null;
      state.results = data;
      // No answer yet: ask for it now that the voting is over.
      openPanel(data.awaiting_answer ? 'reveal' : 'results');
      break;
    case 'poll:revealed':
      state.results = data;
      openPanel('results');
      break;
    case 'doubt:new':
      if (!state.doubts.some((d) => d.id === data.id)) state.doubts.push(data);
      if (state.panel !== 'doubts') state.unread += 1;
      break;
    case 'doubt:pinned':
      state.pinnedId = data.id;
      break;
    case 'doubt:unpinned':
      if (state.pinnedId === data.doubt_id) state.pinnedId = null;
      break;
    case 'doubt:resolved':
      state.doubts = state.doubts.filter((d) => d.id !== data.doubt_id);
      if (state.pinnedId === data.doubt_id) state.pinnedId = null;
      break;
    case 'session:ended':
      classOver();
      return;
    default:
      return;
  }
  update();
}

/* ── Live: the dock ──────────────────────────────────────────────────── */

async function enterClass(session) {
  state.session = session;
  state.startedAt = utcMs(session.started_at);
  Object.assign(state, {
    view: 'live', panel: null, collapsed: false, poll: null, results: null, doubts: [], pinnedId: null, unread: 0, error: null, stream: null,
  });
  streamAttempts = 0;
  onAirLoad(session.id);
  state.markers = [];
  state.markLabel = '';
  await update();
  connect();
  studio.markers({ sessionId: session.id }).then((res) => {
    if (res.ok && state.session?.id === session.id) {
      state.markers = res.data.items;
      update();
    }
  });
  if (state.status?.streaming?.ready) {
    // Joined a class the teacher started elsewhere: point it at this board's stream.
    // (Private or unlisted, streamStart asks CoachBook for the class's stream, which points the class at it.)
    if (!state.status.streaming.managed && session.stream_url !== state.status.streaming.watchUrl) await studio.attachStream({ sessionId: session.id });
    startStreaming();
  }
}

function togglePanel(panel) {
  state.error = null;
  state.panel = state.panel === panel ? null : panel;
  if (state.panel === 'doubts') state.unread = 0;
  return update();
}

function grip(label = '⋮⋮') {
  const el = h('div', { class: 'grip', title: 'Drag to move', 'aria-label': 'Drag to move' }, label);
  let moved = false;
  el.addEventListener('pointerdown', (event) => {
    el.setPointerCapture(event.pointerId);
    dragging = true;
    moved = false;
    studio.drag('start', event.screenX, event.screenY);
  });
  el.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    moved = true;
    studio.drag('move', event.screenX, event.screenY);
  });
  const stop = (event) => {
    if (!dragging) return;
    dragging = false;
    studio.drag('end', event.screenX, event.screenY);
    if (renderQueued) {
      renderQueued = false;
      update();
    }
  };
  el.addEventListener('pointerup', stop);
  el.addEventListener('pointercancel', stop);
  el.wasDragged = () => moved;
  return el;
}

const STREAM_LABEL = { starting: 'Starting', live: 'On air', failed: 'Problem' };

function dock() {
  const polling = Boolean(state.poll);
  const stream = state.stream;
  return h('nav', { class: 'dock', 'aria-label': 'Class controls' },
    grip(),
    h('div', { class: 'live-pill', title: `${state.session.subject_name} · ${state.session.batch_name}` },
      h('span', { class: 'dot' }),
      h('span', { class: 'time', 'data-tick': 'elapsed' })),
    stream && h('button', {
      class: `yt ${stream.state}`,
      title: stream.error || 'YouTube Live',
      'aria-label': `YouTube: ${STREAM_LABEL[stream.state] || stream.state}`,
      onclick: () => togglePanel('stream'),
    }, '▶', STREAM_LABEL[stream.state] || ''),
    h('button', {
      class: `dock-btn poll${polling ? ' running' : ''}${['poll', 'poll-live', 'reveal', 'results'].includes(state.panel) ? ' active' : ''}`,
      'aria-label': polling ? 'Poll running' : 'Quick poll',
      onclick: () => togglePanel(polling ? 'poll-live' : state.results?.awaiting_answer ? 'reveal' : 'poll'),
    },
    polling ? h('span', { class: 'icon count', 'data-tick': 'poll-left' }) : h('span', { class: 'icon' }, '⚡'),
    polling ? h('span', null, h('span', { 'data-tick': 'votes' }), ' in') : 'Poll'),
    h('button', {
      class: `dock-btn${state.panel === 'doubts' ? ' active' : ''}`,
      'aria-label': `Doubts${state.unread ? `, ${state.unread} new` : ''}`,
      onclick: () => togglePanel('doubts'),
    },
    h('span', { class: 'icon' }, '❓'),
    'Doubts',
    state.unread > 0 && h('span', { class: 'badge' }, state.unread > 99 ? '99+' : state.unread)),
    h('button', {
      class: `dock-btn${state.panel === 'markers' ? ' active' : ''}${state.marked ? ' marked' : ''}`,
      title: 'Next topic — Ctrl+Alt+M',
      'aria-label': `Topics${state.markers.length ? `, ${state.markers.length} marked` : ''}`,
      onclick: () => togglePanel('markers'),
    },
    h('span', { class: 'icon' }, state.marked ? '✓' : '🔖'),
    'Topic',
    state.markers.length > 0 && h('span', { class: 'badge quiet' }, state.markers.length)),
    h('button', { class: `dock-btn end${state.panel === 'end' ? ' active' : ''}`, 'aria-label': 'End class', onclick: () => togglePanel('end') },
      h('span', { class: 'icon' }, '⏹'),
      'End'),
    h('div', { class: 'dock-foot' },
      h('span', { class: `conn ${state.conn}`, title: { open: 'Connected', connecting: 'Connecting…', offline: 'Reconnecting…' }[state.conn] }),
      foldButton()));
}

/** Folds whatever is showing down to the bubble, out of the way of the board. */
function foldButton() {
  return h('button', { class: 'fold', title: 'Fold into a bubble', 'aria-label': 'Fold into a bubble', onclick: () => { state.collapsed = true; state.panel = null; update(); } }, '–');
}

/** The top of every full-size screen: a grip to move it, and the fold. */
function cardBar() {
  return h('div', { class: 'card-bar' }, grip(), foldButton());
}

/** Folded: one bubble, dragged by itself, tapped to unfold. Out of class it just says Studio. */
function mini() {
  const bubble = grip();
  bubble.className = 'mini';
  bubble.replaceChildren(...(state.view === 'live'
    ? [
      h('span', { class: 'dot' }),
      h('span', { class: 'time', 'data-tick': state.poll ? 'poll-left' : 'elapsed' }),
      state.unread > 0 && h('span', { class: 'badge' }, state.unread),
    ]
    : [h('span', { class: 'mini-label' }, 'Studio')]).filter(Boolean));
  bubble.setAttribute('aria-label', 'Unfold Studio');
  bubble.addEventListener('click', () => {
    if (bubble.wasDragged()) return;
    state.collapsed = false;
    update();
  });
  return bubble;
}

function liveView() {
  const panels = {
    poll: pollPanel, 'poll-live': pollLivePanel, reveal: revealPanel, results: resultsPanel, doubts: doubtsPanel, markers: markersPanel, end: endPanel, stream: streamPanel,
  };
  return [dock(), state.panel && panels[state.panel]?.()];
}

function panel(title, ...body) {
  return h('section', { class: 'panel' },
    h('div', { class: 'panel-head' },
      h('h2', null, title),
      h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => togglePanel(state.panel) }, '✕')),
    state.error && h('p', { class: 'error', role: 'alert' }, state.error),
    ...body);
}

/* ── Quick poll: launch, let them vote, then reveal ──────────────────── */

function pollPanel() {
  return panel('Quick poll',
    h('p', null, 'Students answer A, B, C or D. When the time is up you tap the right answer to reveal it — it is never on the board before.'),
    h('div', { class: 'choices' }, POLL_DURATIONS.map((sec) => h('button', {
      class: 'choice',
      disabled: state.busy,
      onclick: () => launchPoll(sec),
    }, h('strong', null, `${sec}s`), h('span', null, 'Start')))));
}

async function launchPoll(durationSec) {
  state.busy = true;
  update();
  const ack = await send('teacher:create_poll', { option_count: 4, duration_sec: durationSec });
  state.busy = false;
  if (!ack.ok) {
    state.error = ack.error;
    return update();
  }
  state.poll = withEnd(ack.data);
  state.results = null;
  // Out of the way of the board while the class answers.
  state.panel = null;
  return update();
}

function pollLivePanel() {
  if (!state.poll) return panel('Quick poll', h('p', null, 'No poll is running.'));
  return panel('Poll running',
    h('div', { class: 'big-row' },
      h('div', { class: 'big-number', 'data-tick': 'poll-left' }),
      h('p', null, h('strong', { 'data-tick': 'votes' }), ' answered')),
    h('button', {
      class: 'btn wide',
      onclick: async () => {
        const ack = await send('poll:end', { poll_id: state.poll?.poll_id });
        if (!ack.ok) {
          state.error = ack.error;
          update();
        }
      },
    }, 'End poll now'));
}

function revealPanel() {
  const r = state.results;
  if (!r) return panel('Quick poll', h('p', null, 'No poll to reveal.'));
  return panel('Time is up',
    h('p', null, `${r.total} answered. Tap the right answer to show the class.`),
    h('div', { class: 'choices four' }, r.options.map((o) => h('button', {
      class: 'choice',
      disabled: state.busy,
      onclick: () => reveal(o.option),
    }, h('strong', null, o.option), h('span', null, `${o.percent}%`)))),
    h('button', { class: 'btn quiet small', onclick: () => { state.results = null; togglePanel('reveal'); } }, 'Skip — no answer for this one'));
}

async function reveal(letter) {
  state.busy = true;
  update();
  const ack = await send('teacher:reveal_answer', { poll_id: state.results.poll_id, correct_option: letter });
  state.busy = false;
  if (!ack.ok) state.error = ack.error;
  else {
    state.results = ack.data;
    state.panel = 'results';
  }
  return update();
}

function resultsPanel() {
  const r = state.results;
  if (!r) return panel('Quick poll', h('p', null, 'No results yet.'));
  return panel(r.correct_option ? `Answer: ${r.correct_option}` : 'Poll results',
    h('p', null, `${r.total} answered${r.accuracy !== null ? ` · ${r.accuracy}% right` : ''}`),
    h('div', { class: 'bars' }, r.options.map((o) => h('div', { class: `bar${o.correct ? ' correct' : ''}` },
      h('span', { class: 'letter' }, o.option),
      h('div', { class: 'track' }, h('div', { class: 'fill', style: { width: `${o.percent}%` } })),
      h('span', { class: 'num' }, `${o.percent}%`)))),
    r.leaderboard.length > 0 && h('div', { class: 'fastest' },
      h('p', null, 'Fastest right answers'),
      h('ol', null, r.leaderboard.slice(0, 3).map((row) => h('li', null, `${row.name} — ${seconds(row.response_ms)}`)))),
    h('button', { class: 'btn primary wide', onclick: () => { state.results = null; togglePanel('results'); } }, 'Done'));
}

/* ── Doubts ──────────────────────────────────────────────────────────── */

async function doubtAction(event, doubtId) {
  const ack = await send(event, { doubt_id: doubtId });
  if (ack.ok) {
    // An answered doubt that was not pinned is between the asker and the teacher;
    // the room is not told, so the list is updated here.
    if (event === 'teacher:resolve_doubt') state.doubts = state.doubts.filter((d) => d.id !== doubtId);
    state.error = null;
  } else {
    state.error = ack.error;
  }
  return update();
}

function doubtsPanel() {
  const pinned = state.doubts.filter((d) => d.id === state.pinnedId);
  const queue = state.doubts.filter((d) => d.id !== state.pinnedId);
  return panel(`Doubts${state.doubts.length ? ` (${state.doubts.length})` : ''}`,
    h('div', { class: 'scroll' },
      state.doubts.length === 0 && h('p', { class: 'empty' }, 'No doubts yet. Students’ questions arrive here, not in the chat.'),
      [...pinned, ...queue].map((d) => {
        const isPinned = d.id === state.pinnedId;
        return h('article', { class: `doubt${isPinned ? ' pinned' : ''}` },
          isPinned && h('span', { class: 'tag' }, 'On students’ screens'),
          h('div', { class: 'who' }, h('strong', null, d.name), d.roll_number ? ` · ${d.roll_number}` : ''),
          h('div', { class: 'body' }, d.body),
          h('div', { class: 'row' },
            isPinned
              ? h('button', { class: 'btn small', onclick: () => doubtAction('teacher:unpin_doubt', d.id) }, 'Unpin')
              : h('button', { class: 'btn small primary', onclick: () => doubtAction('teacher:pin_doubt', d.id) }, '📌 Pin'),
            h('button', { class: 'btn small', onclick: () => doubtAction('teacher:resolve_doubt', d.id) }, '✓ Answered')));
      })));
}

/* ── Topics: chapter markers on the recording ────────────────────────── */

let markedTimer = null;

/** Marks the next topic here, now; unnamed, CoachBook numbers it. */
async function markTopic(label = '') {
  if (state.view !== 'live' || state.busy) return undefined;
  const sessionId = state.session.id;
  state.busy = true;
  update();
  const res = await studio.addMarker({ sessionId, offsetSec: videoSeconds(), label: label.trim() || null });
  state.busy = false;
  if (state.session?.id !== sessionId) return undefined;
  if (!res.ok) {
    // From the hotkey, with no panel open: open one to say why.
    state.error = res.error;
    openPanel('markers');
    return update();
  }
  state.error = null;
  state.markers = res.data.items;
  state.markLabel = '';
  state.marked = res.data.marker.label;
  clearTimeout(markedTimer);
  markedTimer = setTimeout(() => { state.marked = null; update(); }, 2500);
  return update();
}

async function unmark(markerId) {
  const res = await studio.removeMarker({ sessionId: state.session.id, markerId });
  if (res.ok) state.markers = res.data.items;
  state.error = res.ok ? null : res.error;
  return update();
}

studio.onMarkHotkey?.(() => markTopic());

function markersPanel() {
  const label = h('input', {
    type: 'text',
    value: state.markLabel,
    maxlength: '80',
    placeholder: `Topic ${state.markers.length + 1}`,
    'aria-label': 'Topic name (optional)',
    oninput: (event) => { state.markLabel = event.target.value; },
    onkeydown: (event) => { if (event.key === 'Enter') markTopic(state.markLabel); },
  });
  return panel('Topics',
    h('p', null, 'Mark where each topic starts. Students see them as chapters on the recording’s seek bar. Ctrl+Alt+M marks one without leaving Note 3.'),
    h('div', { class: 'mark-row' },
      label,
      h('button', { class: 'btn primary', disabled: state.busy, onclick: () => markTopic(state.markLabel) }, state.marked ? '✓ Marked' : 'Mark now')),
    h('div', { class: 'scroll' },
      state.markers.length === 0 && h('p', { class: 'empty' }, 'No topics marked yet.'),
      state.markers.map((m) => h('div', { class: 'marker' },
        h('span', { class: 'at' }, mmss(m.offset_sec * 1000)),
        h('span', { class: 'label' }, m.label),
        h('button', { class: 'icon-btn', title: 'Remove', 'aria-label': `Remove ${m.label}`, onclick: () => unmark(m.id) }, '✕')))));
}

/* ── The stream's state ──────────────────────────────────────────────── */

function streamPanel() {
  const s = state.stream ?? { state: 'stopped' };
  const words = {
    starting: 'Connecting to YouTube…',
    live: 'On air. Students watch in the app; YouTube runs a few seconds behind the board.',
    failed: s.error || 'The stream stopped.',
    stopped: 'The stream is off.',
  };
  return panel('YouTube Live',
    h('p', { class: s.state === 'failed' ? 'error' : null }, words[s.state] ?? s.state),
    broadcast && h('p', null, `${broadcast.camera ? 'Camera on' : 'No camera'} · ${broadcast.mic ? 'microphone on' : 'no microphone'}`),
    h('div', { class: 'row' },
      h('button', { class: 'btn small primary', onclick: () => { streamAttempts = 0; startStreaming(); } }, s.state === 'live' ? 'Restart' : 'Try again'),
      s.state !== 'stopped' && h('button', { class: 'btn small', onclick: () => { stopStreaming(); state.stream = { state: 'stopped' }; update(); } }, 'Stop stream')));
}

/* ── Ending the class, and its notes ─────────────────────────────────── */

function endPanel() {
  const s = state.session;
  return panel('End the class?',
    h('p', null, `${s.subject_name} · ${s.batch_name} goes off air${state.stream ? ' and off YouTube' : ''}.`),
    h('p', null, state.status?.notesDir
      ? 'Then the notes Note 3 exported are sent to the batch.'
      : 'Note 3’s export folder is not set, so you will be asked for the notes file.'),
    h('button', { class: 'btn danger wide', disabled: state.busy, onclick: endClass }, state.busy ? 'Ending…' : '⏹ End class'),
    h('button', { class: 'btn wide', onclick: () => togglePanel('end') }, 'Keep teaching'));
}

async function endClass() {
  state.busy = true;
  update();
  const res = await studio.endClass({ sessionId: state.session.id });
  state.busy = false;
  if (!res.ok) {
    state.error = res.error;
    return update();
  }
  return classOver();
}

/** The class is off air (here or elsewhere): stop the stream and socket, find the notes. */
async function classOver() {
  if (state.view !== 'live') return;
  stopStreaming();
  disconnect();
  state.view = 'notes';
  state.panel = null;
  state.collapsed = false;
  state.notes = { phase: state.status?.notesDir ? 'searching' : 'missing', file: null };
  await update();
  if (state.notes.phase === 'searching') searchForNotes();
}

async function searchForNotes() {
  const deadline = Date.now() + NOTES_SEARCH_MS;
  while (state.view === 'notes' && state.notes.phase === 'searching') {
    const res = await studio.findNotes({ since: state.startedAt });
    if (state.view !== 'notes' || state.notes.phase !== 'searching') return;
    if (res.ok && res.data) return upload(res.data);
    if (Date.now() > deadline) {
      state.notes.phase = 'missing';
      return update();
    }
    await sleep(2000);
  }
  return undefined;
}

async function upload(file) {
  state.notes = { phase: 'uploading', file };
  update();
  const res = await studio.publishNotes({ sessionId: state.session.id, file: file.path });
  state.notes = res.ok
    ? { phase: 'done', file, notified: res.data.notified, replaced: res.data.replaced }
    : { phase: 'error', file, message: res.error };
  return update();
}

async function pickFile() {
  const res = await studio.pickNotesFile();
  if (res.ok) return upload(res.data);
  return undefined;
}

function notesView() {
  const n = state.notes;
  const s = state.session;
  const skip = h('button', { class: 'btn quiet small', onclick: showLectures }, 'Skip — no notes for this class');
  const choose = h('button', { class: 'btn small', onclick: pickFile }, 'Choose file…');
  const body = {
    searching: () => [
      h('div', { class: 'spinner' }),
      h('h2', null, 'Looking for the notes'),
      h('p', null, 'Export the class from Note 3 now if you have not. The newest PDF in the export folder goes to the batch.'),
      h('div', { class: 'row center' }, choose, skip),
    ],
    uploading: () => [
      h('div', { class: 'spinner' }),
      h('h2', null, 'Sending the notes…'),
      h('p', null, `${n.file.name} · ${megabytes(n.file.size)}`),
    ],
    done: () => [
      h('div', { class: 'tick' }, '✓'),
      h('h2', null, n.replaced ? 'Notes updated' : 'Notes sent'),
      h('p', null, n.replaced
        ? `The notes for ${s.subject_name} · ${s.batch_name} were replaced with ${n.file.name}.`
        : `${n.file.name} is in Notes & DPPs for ${s.batch_name}, and ${n.notified} students were told.`),
      h('button', { class: 'btn primary wide', onclick: showLectures }, 'Done'),
    ],
    missing: () => [
      h('h2', null, 'No new notes found'),
      h('p', null, state.status?.notesDir
        ? `Nothing exported to ${state.status.notesDir} since the class began.`
        : 'Note 3’s export folder is not set on this board.'),
      h('div', { class: 'row center' },
        h('button', {
          class: 'btn small primary',
          onclick: () => {
            state.notes = { phase: 'searching', file: null };
            update();
            searchForNotes();
          },
          disabled: !state.status?.notesDir,
        }, 'Look again'),
        choose),
      skip,
    ],
    error: () => [
      h('h2', null, 'The notes did not send'),
      h('p', { class: 'error', role: 'alert' }, n.message),
      h('div', { class: 'row center' }, h('button', { class: 'btn small primary', onclick: () => upload(n.file) }, 'Try again'), choose),
      skip,
    ],
  }[n.phase];
  return h('section', { class: 'card center' }, cardBar(), h('div', { class: 'brand' }, `${s.subject_name} · ${s.batch_name}`), body());
}

/* ── Start ───────────────────────────────────────────────────────────── */

async function boot() {
  const res = await studio.status();
  state.status = res.ok ? res.data : { paired: false };
  if (!state.status.paired) {
    state.view = 'setup';
    return update();
  }
  return showLectures();
}

// Opening Studio again (the desktop shortcut) while it is folded unfolds it.
studio.onUnfold?.(() => {
  if (!state.collapsed) return;
  state.collapsed = false;
  update();
});

boot();
