import { isNativeApp, pathPrefix, serverUrl } from '../../api.js';
import { coaching } from '../../coachingApi.js';
import { buildForm, closeModal, confirmDialog, date, emptyState, h, openModal, renderIcon, toast } from '../../ui.js';
import { fill, section } from './common.js';

/**
 * Smartboards: the classroom boards that run CoachBook Studio (studio/).
 * A manager adds a board for a classroom and gets an 8-character pairing
 * code, typed into Studio on the board with this institute's address. The
 * code is shown once and lasts 15 minutes; a new one also signs the board
 * out, which is how a lost or replaced board is cut off.
 *
 * Managers only, like the API behind it (src/routes/coaching/studio.js):
 * a paired board can start any lecture timetabled in its room.
 *
 * The page also chooses who can watch: privately, through CoachBook's own
 * player (src/coaching/privateStream.js), or on YouTube — where it connects
 * the institute's channel, so each class a board streams is its own
 * unlisted video (src/coaching/youtube.js).
 */

// The server stores instants as UTC `YYYY-MM-DD HH:MM:SS`; date() would read that as local time.
const fromUtc = (value) => (value ? `${String(value).replace(' ', 'T')}Z` : value);
const clock = (value) => new Date(fromUtc(value)).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/** What Studio asks for as "CoachBook address": this institute's own root, wherever the app is served from. */
const instituteAddress = () => new URL(serverUrl(`${pathPrefix}/api/health`), window.location.href).origin + pathPrefix;

async function copy(text, what) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied`);
  } catch {
    toast('Could not copy — type it in instead', 'error');
  }
}

function boardStatus(board) {
  if (board.paired) return h('span', { class: 'badge green' }, 'Paired');
  if (board.pairing_expires_at && new Date(fromUtc(board.pairing_expires_at)) > new Date()) {
    return h('span', { class: 'badge amber' }, 'Waiting for its code');
  }
  return h('span', { class: 'badge grey' }, 'Not paired');
}

/**
 * The code and address to type into Studio. Polls the board list while open
 * and says so once the board has paired, or once the code has run out — an
 * owner setting up a board is usually standing at it with this on their phone.
 */
function showPairingCode({ device, pairing }, onChanged) {
  const code = pairing.code;
  const address = instituteAddress();
  const expiresAt = new Date(fromUtc(pairing.expires_at));
  const state = h('p', { class: 'muted', style: 'font-size:12px;margin:12px 0 0' }, `Valid for 15 minutes, until ${clock(pairing.expires_at)}. It is shown only this once.`);

  const body = h(
    'div',
    { style: 'text-align:center;padding:4px 0 8px' },
    h('p', { style: 'font-weight:600;margin:0 0 10px' }, `On ${device.name}, open CoachBook Studio and enter:`),
    h('div', { class: 'muted', style: 'font-size:13px' }, 'CoachBook address'),
    h(
      'div',
      { class: 'row', style: 'justify-content:center;gap:8px;margin:4px 0 14px' },
      h('code', { style: 'font-size:14px;word-break:break-all' }, address),
      h('button', { class: 'btn sm ghost', type: 'button', onclick: () => copy(address, 'Address') }, 'Copy'),
    ),
    h('div', { class: 'muted', style: 'font-size:13px' }, 'Pairing code'),
    h(
      'div',
      {
        style:
          'display:inline-block;margin-top:4px;font:600 30px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:4px;padding:10px 18px;border:1px solid var(--line);border-radius:8px',
      },
      code,
    ),
    h('div', { style: 'margin-top:8px' }, h('button', { class: 'btn sm', type: 'button', onclick: () => copy(code, 'Code') }, 'Copy code')),
    state,
  );

  openModal({ title: `Pair ${device.name}`, icon: 'monitor', body, footer: [h('button', { class: 'btn primary', onclick: closeModal }, 'Done')] });

  // Anchored to the modal's own node, as whatsapp.js's poll is to its card: once it is gone, the poll stops.
  const timer = setInterval(async () => {
    if (!body.isConnected) return clearInterval(timer);
    if (new Date() > expiresAt) {
      clearInterval(timer);
      fill(state, 'This code has expired. Close this and choose “New pairing code” for another.');
      state.className = 'field-error';
      onChanged?.();
      return undefined;
    }
    try {
      const { items } = await coaching.studioDevices();
      if (items.find((d) => d.id === device.id)?.paired) {
        clearInterval(timer);
        fill(body, h('div', { style: 'padding:12px 0' }, h('div', { style: 'display:flex;justify-content:center;color:var(--green)' }, renderIcon('checkCircle', { size: 36 })), h('p',{ style: 'font-weight:600;margin:10px 0 4px' }, `${device.name} is paired`), h('p', { class: 'muted', style: 'margin:0' }, `It will list today’s lectures in ${device.classroom_name}.`)));
        onChanged?.();
      }
    } catch {
      // A transient failure is not worth tearing the poll down for.
    }
    return undefined;
  }, 4000);
}

function openBoardForm({ rooms, onSaved }) {
  openModal({
    title: 'Add a smartboard',
    subtitle: 'The board shows the lectures timetabled in its classroom.',
    icon: 'monitor',
    body: buildForm(
      [
        { name: 'name', label: 'Board name', required: true, placeholder: 'Room 101 smartboard' },
        {
          name: 'classroom_id',
          label: 'Classroom',
          type: 'select',
          required: true,
          options: rooms.map((r) => ({ value: r.id, label: r.name })),
          hint: 'Lectures match by room name, as on the timetable',
        },
      ],
      {
        submitLabel: 'Add and get a code',
        onSubmit: async (values) => {
          const created = await coaching.createStudioDevice({ name: values.name.trim(), classroom_id: Number(values.classroom_id) });
          closeModal();
          await onSaved?.();
          showPairingCode(created, onSaved);
        },
      },
    ),
  });
}

async function issueCode(board, reload) {
  const issue = async () => {
    const result = await coaching.newPairingCode(board.id);
    await reload();
    showPairingCode(result, reload);
  };
  if (!board.paired) {
    try {
      await issue();
    } catch (err) {
      toast(err.message || 'Could not get a code', 'error');
    }
    return;
  }
  confirmDialog({
    title: `New pairing code for ${board.name}?`,
    message: 'The board is signed out straight away, and works again once the new code is typed into Studio on it. Use this when a board is replaced, reinstalled or lost.',
    confirmLabel: 'Sign it out and get a code',
    danger: true,
    // confirmDialog closes the topmost modal once onConfirm resolves, so the
    // code opens on the next tick — any sooner and it is the one closed.
    onConfirm: async () => {
      const result = await coaching.newPairingCode(board.id);
      await reload();
      setTimeout(() => showPairingCode(result, reload));
    },
  });
}

function boardRow(board, reload) {
  return h(
    'div',
    { class: 'list-item cb-board' },
    h('span', { class: 'cb-section-icon' }, renderIcon('monitor', { size: 16 })),
    h(
      'div',
      { class: 'cb-grow' },
      h('div', { class: 'cb-strong' }, board.name, ' ', boardStatus(board)),
      h(
        'div',
        { class: 'muted cb-small' },
        board.classroom_name,
        ' · ',
        board.paired ? `Last seen ${date(fromUtc(board.last_seen_at), { withTime: true })}` : `Added ${date(fromUtc(board.created_at))}`,
      ),
      board.weekly_lectures === 0
        ? h('div', { class: 'cb-small', style: 'color:var(--amber);margin-top:2px' },
          `No lectures are timetabled in “${board.classroom_name}”, so the board lists none. Set the lecture’s or batch’s room to exactly this name.`)
        : null,
    ),
    h(
      'div',
      { class: 'row' },
      h('button', { class: 'btn sm ghost', onclick: () => issueCode(board, reload) }, 'New pairing code'),
      h(
        'button',
        {
          class: 'btn sm ghost',
          onclick: () =>
            confirmDialog({
              title: `Remove ${board.name}?`,
              message: 'Its key stops working immediately. Classes it ran stay in their history.',
              confirmLabel: 'Remove',
              danger: true,
              onConfirm: async () => {
                await coaching.deleteStudioDevice(board.id);
                toast('Board removed');
                await reload();
              },
            }),
        },
        'Remove',
      ),
    ),
  );
}

/* ── The YouTube channel ─────────────────────────────────────────────── */

/** Where Google sent the manager back from (the callback's ?youtube=…), said once. */
const SIGN_IN_OUTCOME = {
  connected: ['YouTube channel connected — classes now stream as unlisted videos', 'success'],
  denied: ['YouTube was not connected: the sign-in was cancelled', 'error'],
  scope: ['YouTube was not connected: tick “Manage your YouTube account” on Google’s screen and try again', 'error'],
  no_channel: ['YouTube was not connected: that Google account has no YouTube channel. Sign in with the account that owns the institute’s channel.', 'error'],
  failed: ['YouTube could not be connected. Try again in a minute.', 'error'],
};

function announceSignIn() {
  const outcome = new URLSearchParams(window.location.search).get('youtube');
  if (!outcome) return;
  const [message, kind] = SIGN_IN_OUTCOME[outcome] ?? SIGN_IN_OUTCOME.failed;
  toast(message, kind);
  // Said once: a reload or a shared link should not say it again.
  history.replaceState(null, '', window.location.pathname + window.location.hash);
}

async function connectYoutube(button) {
  button.disabled = true;
  try {
    const { url } = await coaching.youtubeConnect();
    window.location.href = url;
  } catch (err) {
    toast(err.message || 'Could not start the YouTube sign-in', 'error');
    button.disabled = false;
  }
}

function youtubeSection(yt, reload) {
  const unlisted = 'Each class a board streams becomes its own unlisted video. Only students of that batch are sent the link — but anyone they forward it to can watch, as with any unlisted video.';
  if (!yt.configured) {
    return section('YouTube', h('p', { class: 'muted cb-small', style: 'margin:0' },
      'Boards stream to YouTube with a stream key typed into Studio, which works for public streams only. Unlisted streams need YouTube sign-in, which is not set up on this CoachBook server yet.'), { icon: 'youtube' });
  }
  const connectButton = (label) => {
    if (isNativeApp) return h('p', { class: 'muted cb-small', style: 'margin:0' }, `Open ${instituteAddress()} in a browser on a computer to ${label.toLowerCase()} — Google does not allow signing in inside the app.`);
    const button = h('button', { class: 'btn primary', onclick: () => connectYoutube(button) }, renderIcon('youtube', { size: 16 }), label);
    return button;
  };

  if (!yt.connected) {
    return section('YouTube', h('div', { class: 'grid', style: 'gap:12px' },
      h('p', { class: 'muted cb-small', style: 'margin:0' }, `Connect the institute’s YouTube channel to stream classes unlisted, so paid batches are not public. ${unlisted}`),
      h('div', {}, connectButton('Connect YouTube channel'))), { icon: 'youtube' });
  }

  const disconnect = h('button', {
    class: 'btn sm ghost',
    onclick: () => confirmDialog({
      title: `Disconnect ${yt.channel_title || 'the YouTube channel'}?`,
      message: 'Boards go back to streaming with a key typed into Studio (public streams), or no stream. Classes already recorded stay on the channel.',
      confirmLabel: 'Disconnect',
      danger: true,
      onConfirm: async () => {
        await coaching.youtubeDisconnect();
        toast('YouTube channel disconnected');
        await reload();
      },
    }),
  }, 'Disconnect');

  return section('YouTube', h('div', { class: 'grid', style: 'gap:12px' },
    h('div', { class: 'list-item cb-board', style: 'padding:0;border:none' },
      h('span', { class: 'cb-section-icon' }, renderIcon('youtube', { size: 16 })),
      h('div', { class: 'cb-grow' },
        h('div', { class: 'cb-strong' }, yt.channel_title || yt.channel_id, ' ',
          yt.broken ? h('span', { class: 'badge red' }, 'Needs reconnecting') : h('span', { class: 'badge green' }, 'Connected')),
        h('div', { class: 'muted cb-small' }, `Connected ${date(fromUtc(yt.connected_at))}${yt.connected_by_name ? ` by ${yt.connected_by_name}` : ''}`)),
      disconnect),
    yt.broken
      ? h('div', { class: 'grid', style: 'gap:10px' },
        h('p', { class: 'field-error', style: 'display:block;margin:0' }, `${yt.broken.reason} Until then, boards cannot stream unlisted.`),
        h('div', {}, connectButton('Reconnect YouTube channel')))
      : h('p', { class: 'muted cb-small', style: 'margin:0' }, unlisted)), { icon: 'youtube' });
}

/* ── Who can watch ───────────────────────────────────────────────────── */

const PROVIDERS = [
  {
    value: 'private',
    title: 'Private — CoachBook player',
    icon: 'lock',
    text: 'For paid batches. Classes never touch YouTube: students watch only inside the app, each with their own link that stops working after a few hours, so a forwarded link is useless. Students pick the quality (Auto, 720p, 480p, 360p).',
  },
  {
    value: 'youtube',
    title: 'YouTube',
    icon: 'youtube',
    text: 'Free. Students watch inside the app with YouTube’s buttons and links hidden, but YouTube picks the quality, and the video is still on your channel (unlisted if the channel is connected below; otherwise public).',
  },
];

function streamingSection(streaming, reload) {
  const choose = async (provider, input) => {
    if (provider === streaming.provider) return;
    try {
      await coaching.setStreaming(provider);
      toast(provider === 'private' ? 'Classes now stream privately. Boards pick it up on their next class.' : 'Classes now stream to YouTube');
      await reload();
    } catch (err) {
      input.checked = false;
      toast(err.message || 'Could not change it', 'error');
    }
  };
  return section('Who can watch classes', h('div', { class: 'grid', style: 'gap:10px' },
    ...PROVIDERS.map((p) => {
      const off = p.value === 'private' && !streaming.private_configured;
      const input = h('input', { type: 'radio', name: 'stream-provider', value: p.value, checked: streaming.provider === p.value, disabled: off });
      input.addEventListener('change', () => choose(p.value, input));
      return h('label', { class: 'list-item cb-board', style: `align-items:flex-start;gap:12px;cursor:${off ? 'default' : 'pointer'}` },
        input,
        h('span', { class: 'cb-section-icon' }, renderIcon(p.icon, { size: 16 })),
        h('div', { class: 'cb-grow' },
          h('div', { class: 'cb-strong' }, p.title, ' ', streaming.provider === p.value ? h('span', { class: 'badge green' }, 'In use') : null),
          h('div', { class: 'muted cb-small' }, p.text),
          off ? h('div', { class: 'muted cb-small', style: 'margin-top:4px' }, 'Not set up on this CoachBook server yet.') : null));
    }),
    streaming.provider === 'private' && streaming.private_backend === 'selfhosted' ? recordingBox(streaming, reload) : null), { icon: 'lock' });
}

const KEEP_DAYS = [7, 15, 30, 60, 90, 180, 365];

/** Recording the private classes this server carries: on or off, and for how long. */
function recordingBox(streaming, reload) {
  const save = async (patch, control) => {
    control.disabled = true;
    try {
      await coaching.updateStreaming(patch);
      if ('record_classes' in patch) toast(patch.record_classes ? 'Classes will be recorded from the next one that starts' : 'Classes are no longer recorded. Recordings already made are kept.');
      await reload();
    } catch (err) {
      toast(err.message || 'Could not save it', 'error');
      await reload();
    }
  };
  const on = streaming.record_classes;
  const toggle = h('input', { type: 'checkbox', checked: on });
  toggle.addEventListener('change', () => save({ record_classes: toggle.checked }, toggle));
  const keep = h('select', { disabled: !on, 'aria-label': 'Keep recordings for' },
    ...KEEP_DAYS.map((d) => h('option', { value: String(d), selected: streaming.recording_keep_days === d }, d === 365 ? '1 year' : `${d} days`)));
  keep.addEventListener('change', () => save({ recording_keep_days: Number(keep.value) }, keep));
  return h('div', { class: 'grid', style: 'gap:10px;padding:12px;border:1px solid var(--border);border-radius:12px' },
    h('label', { style: 'display:flex;gap:12px;align-items:flex-start;cursor:pointer' },
      toggle,
      h('div', { class: 'cb-grow' },
        h('div', { class: 'cb-strong' }, 'Record classes'),
        h('div', { class: 'muted cb-small' }, 'Each private class is saved as it streams and appears in the batch’s Recorded lectures as soon as it ends. Students rewatch it in the app, on their own link, in 480p or 360p. About 0.8 GB of this server’s disk per hour of class.'))),
    on && streaming.recording_paused
      ? h('p', { class: 'field-error', style: 'display:block;margin:0' }, 'Recording is paused: the server’s disk is nearly full. Classes still stream live; they are just not saved. It starts again by itself once there is room. Deleting old recordings here, or keeping them for fewer days, helps.')
      : null,
    h('label', { style: 'display:flex;gap:12px;align-items:center;flex-wrap:wrap' },
      h('span', { class: 'cb-grow muted cb-small' }, 'Keep recordings for — older ones are deleted automatically, video and all.'),
      keep));
}

/* ── Page ────────────────────────────────────────────────────────────── */

export async function renderSmartboards({ reload, setActions }) {
  const [{ items: boards }, { items: rooms }, youtube, streaming] = await Promise.all([coaching.studioDevices(), coaching.classrooms(), coaching.youtube(), coaching.streaming()]);
  announceSignIn();

  setActions(
    rooms.length ? h('button', { class: 'btn primary', onclick: () => openBoardForm({ rooms, onSaved: reload }) }, renderIcon('plus', { size: 16 }), 'Add board') : null,
  );

  const list = !rooms.length
    ? emptyState('A board belongs to a classroom. Add your rooms first, under Courses & batches → Classrooms.', {
        icon: 'building',
        title: 'No classrooms yet',
        action: h('a', { class: 'btn', href: '#/courses' }, 'Go to Courses & batches'),
      })
    : boards.length
      ? h('div', {}, ...boards.map((b) => boardRow(b, reload)))
      : emptyState('Add a board for a classroom to get its pairing code.', { icon: 'monitor', title: 'No smartboards yet' });

  return h(
    'div',
    { class: 'cb-page grid', style: 'gap:16px' },
    h(
      'div',
      { class: 'card muted', style: 'font-size:13px' },
      'Each board runs CoachBook Studio. Add the board here, then type the pairing code into Studio along with this address: ',
      h('code', {}, instituteAddress()),
      '. A paired board lists the lectures timetabled in its classroom each day, and the teacher goes live from it.',
    ),
    section('Boards', list, { icon: 'monitor' }),
    streamingSection(streaming, reload),
    streaming.provider === 'youtube' ? youtubeSection(youtube, reload) : null,
  );
}
