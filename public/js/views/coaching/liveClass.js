import { coaching, liveSocketUrl } from '../../coachingApi.js';
import { classPlayer } from '../../classPlayer.js';
import { streamSource } from '../../liveStream.js';
import { append, clear, h, renderIcon, svg, toast } from '../../ui.js';

/**
 * The student's live classroom — the `live` screen of the CoachBook app
 * (portalCoaching.js), opened from the "Live now" card on Home.
 *
 *   the stream    the class's stream_url in our own player (classPlayer.js:
 *                 quality menu for a private stream, YouTube with nothing in
 *                 it that opens YouTube), with LIVE, the clock and full
 *                 screen laid over it, and the doubt the teacher pinned just
 *                 beneath it
 *   Chat          the class chat, and the Doubts tab: one box, with "Mark as
 *                 doubt" deciding which it goes to
 *   Class notes   empty while the class runs; the moment it ends it waits for
 *                 the board's PDF and shows it to download (the socket says
 *                 so at once; a poll of the materials list is the fallback)
 *   the poll      a sheet that slides up by itself when the teacher starts a
 *                 poll: a countdown ring, A–D, locked on the first tap; when
 *                 time is up, how the class split; and once the teacher
 *                 reveals the answer, the verdict and the three fastest
 *
 * Everything live comes over the class socket (src/coaching/liveGateway.js),
 * joined with a one-time ticket. The screen stops itself — socket, timers,
 * sheet — when the portal's cleanup runs (any tab switch), and also if it
 * finds itself no longer on the page, whatever took it off.
 */

const TICK_MS = 250;
const NOTES_POLL_MS = 8000;
const NOTES_GIVE_UP_MS = 20 * 60_000;
const RING_R = 27;
const RING_C = 2 * Math.PI * RING_R;
const MEDALS = ['🥇', '🥈', '🥉'];

const paint = (node, ...children) => append(clear(node), children);
const utcMs = (stamp) => Date.parse(`${String(stamp).replace(' ', 'T')}Z`);
const clock = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(hours ? 2 : 1, '0');
  return `${hours ? `${hours}:` : ''}${mm}:${String(s % 60).padStart(2, '0')}`;
};
const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;
const megabytes = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/** The live screen: the class, a choice of classes, or a wait for one to start. */
export async function liveClassTab({ registerCleanup, switchTab }) {
  const { items } = await coaching.portal.liveActive();
  const body = h('div', { class: 'portal-tab-body cbl-page' });

  if (items.length === 1) return mountClassroom(body, items[0], { registerCleanup, switchTab });

  if (items.length > 1) {
    return paint(body,
      h('div', { class: 'portal-page-head' }, h('h2', {}, 'Live now'), h('p', {}, 'More than one of your batches is live. Pick a class.')),
      ...items.map((s) => h('button', {
        class: 'cbl-pick',
        type: 'button',
        onclick: () => {
          paint(body);
          mountClassroom(body, s, { registerCleanup, switchTab });
        },
      }, h('span', { class: 'cbl-dot' }), h('div', { class: 'cb-grow' }, h('div', { class: 'cb-strong' }, s.subject_name), h('div', { class: 'muted cb-small' }, [s.batch_name, s.faculty_name].filter(Boolean).join(' · '))), renderIcon('chevronRight', { size: 18 }))));
  }

  // Nothing live: wait here, looking again every 15 seconds.
  const check = setInterval(async () => {
    if (!body.isConnected) return;
    try {
      if ((await coaching.portal.liveActive()).items.length) switchTab('live');
    } catch {
      // offline for a moment; the next look will do
    }
  }, 15_000);
  registerCleanup(() => clearInterval(check));
  return paint(body,
    h('div', { class: 'cbl-idle' },
      h('div', { class: 'cbl-idle-icon' }, renderIcon('monitor', { size: 34 })),
      h('h2', {}, 'No class is live right now'),
      h('p', { class: 'muted' }, 'This screen opens the class by itself when your teacher goes live.'),
      h('button', { class: 'btn', type: 'button', onclick: () => switchTab('materials') }, renderIcon('fileText', { size: 16 }), 'Notes & DPPs')));
}

/* ── The classroom ───────────────────────────────────────────────────── */

function mountClassroom(root, session, { registerCleanup, switchTab }) {
  const st = {
    ended: false,
    conn: 'connecting',
    tab: 'chat',
    asDoubt: false,
    chat: [],
    mine: new Set(),
    pinned: null,
    doubts: [],
    poll: null,
    results: null,
    outcome: null,
    notes: null,
    notesState: 'live', // live | waiting | ready | none
    slowMs: 15_000,
    readyAt: { chat: 0, doubt: 0 },
    error: null,
  };
  const startedAt = utcMs(session.started_at);
  let ws = null;
  let disposed = false;
  let mounted = false;
  let refSeq = 0;
  let retry = 0;
  let retryTimer = null;
  let notesTimer = null;
  let resultsTimer = null;
  const pending = new Map();

  /* — the socket — */

  function request(event, data) {
    return new Promise((resolve) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        resolve({ ok: false, error: 'Reconnecting to the class…' });
        return;
      }
      refSeq += 1;
      const ref = refSeq;
      pending.set(ref, resolve);
      ws.send(JSON.stringify({ event, data, ref }));
      setTimeout(() => pending.delete(ref) && resolve({ ok: false, error: 'No answer from the class — try again' }), 8000);
    });
  }

  async function connect() {
    if (disposed || st.ended) return;
    st.conn = 'connecting';
    paintStage();
    let ticket;
    try {
      ticket = await coaching.portal.liveTicket(session.id);
    } catch (err) {
      // No ticket for a class that is not live any more: it ended while we were away.
      if (err.status === 404 || err.status === 409) return classEnded();
      return reconnectLater();
    }
    if (disposed) return;
    const socket = new WebSocket(liveSocketUrl(ticket));
    ws = socket;
    socket.onopen = () => {
      retry = 0;
      st.conn = 'open';
      paintStage();
    };
    socket.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.event === 'ack') {
        pending.get(message.ref)?.(message);
        pending.delete(message.ref);
      } else {
        onEvent(message.event, message.data);
      }
    };
    socket.onclose = () => {
      if (ws !== socket) return;
      ws = null;
      for (const resolve of pending.values()) resolve({ ok: false, error: 'Lost the connection — reconnecting…' });
      pending.clear();
      if (disposed || st.ended) return;
      st.conn = 'offline';
      paintStage();
      reconnectLater();
    };
  }

  function reconnectLater() {
    if (disposed || st.ended) return;
    retry += 1;
    retryTimer = setTimeout(connect, Math.min(15_000, 1000 * 2 ** (retry - 1)));
  }

  function onEvent(event, data) {
    switch (event) {
      case 'room:joined':
        st.pinned = data.pinned_doubt ?? null;
        st.doubts = data.my_doubts ?? [];
        if (data.poll) openPoll(data.poll);
        paintPinned();
        paintPanel();
        break;
      case 'poll:started':
        openPoll(data);
        break;
      case 'poll:tick':
        if (st.poll?.poll_id === data.poll_id) {
          st.poll.endsAt = Date.now() + data.remaining_ms;
          st.poll.votes = data.votes;
        }
        break;
      case 'poll:end':
        if (st.poll?.poll_id === data.poll_id || !st.poll) showResults(data);
        break;
      case 'poll:revealed':
        // The teacher marked the answer after the voting.
        showResults(data);
        break;
      case 'session:stream':
        // The board started (or restarted) its broadcast. A private one has
        // no link for the whole room: each student asks for their own.
        if (data.private) {
          freshStreamUrl().then((url) => {
            session.stream_url = url;
            session.private_stream = true;
            swapPlayer();
          }).catch(() => {});
          break;
        }
        session.stream_url = data.stream_url;
        session.private_stream = false;
        swapPlayer();
        break;
      case 'poll:my_result':
        if (st.results?.poll_id === data.poll_id) {
          st.outcome = data;
          paintSheet();
        }
        break;
      case 'doubt:pinned':
        st.pinned = data;
        for (const d of st.doubts) d.pinned = d.id === data.id;
        paintPinned();
        paintPanel();
        break;
      case 'doubt:unpinned':
        if (st.pinned?.id === data.doubt_id) st.pinned = null;
        for (const d of st.doubts) if (d.id === data.doubt_id) d.pinned = false;
        paintPinned();
        paintPanel();
        break;
      case 'doubt:resolved': {
        if (st.pinned?.id === data.doubt_id) st.pinned = null;
        const own = st.doubts.find((d) => d.id === data.doubt_id);
        if (own) {
          own.resolved = true;
          own.pinned = false;
          toast('Your teacher answered your doubt');
        }
        paintPinned();
        paintPanel();
        break;
      }
      case 'chat:message':
        st.chat.push(data);
        if (st.chat.length > 200) st.chat.splice(0, st.chat.length - 200);
        if (st.tab === 'chat') appendChat(data);
        break;
      case 'session:ended':
        classEnded();
        break;
      case 'notes:published':
        notesReady(data.material);
        break;
      default:
    }
  }

  /* — the class ending, and its notes — */

  function classEnded() {
    if (st.ended) return;
    st.ended = true;
    clearTimeout(retryTimer);
    // The socket stays open if it is: the notes are announced on it.
    st.notesState = st.notes ? 'ready' : 'waiting';
    st.tab = 'notes';
    paintStage();
    paintPinned();
    paintTabs();
    paintPanel();
    paintComposer();
    if (!st.notes) watchForNotes();
  }

  function watchForNotes() {
    const giveUpAt = Date.now() + NOTES_GIVE_UP_MS;
    const look = async () => {
      if (disposed || st.notesState !== 'waiting') return;
      try {
        const { items } = await coaching.portal.materials();
        const notes = items.find((m) => m.live_session_id === session.id && m.kind === 'notes');
        if (notes) return notesReady(notes);
      } catch {
        // offline for a moment
      }
      if (Date.now() > giveUpAt) {
        st.notesState = 'none';
        return paintPanel();
      }
      notesTimer = setTimeout(look, NOTES_POLL_MS);
      return undefined;
    };
    look();
  }

  function notesReady(material) {
    const fresh = !st.notes;
    st.notes = material;
    st.notesState = 'ready';
    clearTimeout(notesTimer);
    if (fresh) toast('The class notes are ready');
    paintTabs();
    paintPanel();
  }

  /* — the stage: the stream, with live controls over it — */

  const stage = h('div', { class: 'cbl-stage' });
  const overlay = h('div', { class: 'cbl-overlay' });
  const pinnedBar = h('div', { class: 'cbl-pinned', hidden: true });
  const elapsed = h('span', { class: 'cbl-elapsed' });

  /** A private stream's link is signed for this student, and runs out: a fresh one. */
  async function freshStreamUrl() {
    const { items } = await coaching.portal.liveActive();
    return items.find((s) => s.id === session.id)?.stream_url ?? null;
  }

  let playerHandle = null;

  function player() {
    playerHandle?.destroy();
    playerHandle = null;
    const src = streamSource(session.stream_url);
    if (src.kind === 'youtube' || src.kind === 'hls' || src.kind === 'video') {
      playerHandle = classPlayer(src, { title: `${session.subject_name} live class`, refreshSrc: session.private_stream ? freshStreamUrl : null });
      return playerHandle.el;
    }
    if (src.kind === 'vimeo') {
      return h('iframe', {
        class: 'cbl-player',
        src: src.src,
        title: `${session.subject_name} live class`,
        allow: 'autoplay; encrypted-media; picture-in-picture; fullscreen',
        allowfullscreen: true,
        // The app sends no referrer at all; YouTube's player will not start without one.
        referrerpolicy: 'strict-origin-when-cross-origin',
      });
    }
    if (src.kind === 'link') return outsidePlayer(src.src, `This class streams on ${src.host}.`);
    return h('div', { class: 'cbl-noplayer' },
      renderIcon('monitor', { size: 30 }),
      h('strong', {}, `${session.faculty_name || 'Your teacher'} is teaching in class`),
      h('span', {}, 'Polls, doubts and the notes all come here.'));
  }

  function outsidePlayer(href, why) {
    return h('div', { class: 'cbl-noplayer' },
      renderIcon('play', { size: 30 }),
      h('strong', {}, why),
      h('a', { class: 'btn primary', href, target: '_blank', rel: 'noopener' }, renderIcon('link', { size: 16 }), 'Open the class'));
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) return document.exitFullscreen().catch(() => {});
    if (stage.requestFullscreen) return stage.requestFullscreen().catch(() => {});
    // iOS only lets the video itself go full screen.
    return stage.querySelector('video')?.webkitEnterFullscreen?.();
  }

  function paintStage() {
    paint(overlay,
      h('div', { class: 'cbl-overlay-top' },
        st.ended
          ? h('span', { class: 'cbl-badge is-ended' }, 'Class ended')
          : h('span', { class: 'cbl-badge' }, h('span', { class: 'cbl-dot' }), 'LIVE', elapsed),
        st.conn !== 'open' && !st.ended ? h('span', { class: 'cbl-badge is-conn' }, st.conn === 'offline' ? 'Reconnecting…' : 'Joining…') : null,
        h('span', { class: 'cb-grow' }),
        h('button', { class: 'cbl-icon-btn', type: 'button', 'aria-label': 'Full screen', onclick: toggleFullscreen },
          renderIcon(document.fullscreenElement ? 'minimize' : 'maximize', { size: 18 }))),
      h('div', { class: 'cbl-overlay-title' }, `${session.subject_name}${session.faculty_name ? ` · ${session.faculty_name}` : ''}`));
  }

  function paintPinned() {
    const pinned = !st.ended && st.pinned;
    pinnedBar.hidden = !pinned;
    if (pinned) {
      paint(pinnedBar,
        h('span', { class: 'cbl-pinned-tag' }, '📌 Pinned doubt'),
        h('span', { class: 'cbl-pinned-text' }, h('strong', {}, `${pinned.name}: `), pinned.body));
    }
  }

  // The pinned doubt sits under the picture, not over it: over it, it would
  // cover the player's own controls.
  let playerEl = player();
  stage.append(playerEl, overlay);

  function swapPlayer() {
    const next = player();
    playerEl.replaceWith(next);
    playerEl = next;
  }
  document.addEventListener('fullscreenchange', paintStage);

  /* — tabs: chat, doubts, notes — */

  const tabs = h('div', { class: 'cbl-tabs', role: 'tablist' });
  const panel = h('div', { class: 'cbl-panel' });

  function setTab(tab) {
    st.tab = tab;
    // Typing in the Doubts tab means a doubt; in Chat, a message — until the toggle says otherwise.
    if (tab === 'doubts') st.asDoubt = true;
    if (tab === 'chat') st.asDoubt = false;
    st.error = null;
    paintTabs();
    paintPanel();
    paintComposer();
  }

  function paintTabs() {
    const openDoubts = st.doubts.filter((d) => !d.resolved).length;
    const tab = (key, label, icon, extra) => h('button', {
      class: `cbl-tab${st.tab === key ? ' is-on' : ''}`,
      type: 'button',
      role: 'tab',
      'aria-selected': String(st.tab === key),
      onclick: () => setTab(key),
    }, renderIcon(icon, { size: 16 }), label, extra);
    paint(tabs,
      tab('chat', 'Chat', 'users'),
      tab('doubts', 'Doubts', 'inbox', openDoubts ? h('span', { class: 'cbl-count' }, openDoubts) : null),
      tab('notes', 'Class notes', 'fileText', st.notesState === 'ready' ? h('span', { class: 'cbl-count is-new' }, '1') : null));
  }

  function chatLine(m) {
    const own = st.mine.has(m.id);
    return h('div', { class: `cbl-msg${m.role === 'teacher' ? ' is-teacher' : ''}${own ? ' is-own' : ''}`, 'data-id': m.id },
      h('div', { class: 'cbl-msg-who' }, own ? 'You' : m.name, m.role === 'teacher' ? h('span', { class: 'cbl-tag' }, 'Teacher') : null),
      h('div', { class: 'cbl-msg-text' }, m.text));
  }

  function appendChat(m) {
    const list = panel.querySelector('.cbl-chat');
    if (!list) return;
    panel.querySelector('.cbl-empty')?.remove();
    // Follow the conversation unless the student has scrolled up to read.
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    list.append(chatLine(m));
    if (atBottom) list.scrollTop = list.scrollHeight;
  }

  function paintPanel() {
    if (st.tab === 'chat') {
      const list = h('div', { class: 'cbl-chat' }, ...st.chat.map(chatLine));
      paint(panel, st.chat.length ? list : h('div', { class: 'cbl-empty' }, 'Say hello to the class. A question for your teacher? Turn on “Mark as doubt”.'), st.chat.length ? null : list);
      list.scrollTop = list.scrollHeight;
      return;
    }
    if (st.tab === 'doubts') {
      const status = (d) => (d.resolved ? ['Answered', 'is-done'] : d.pinned ? ['On everyone’s screen', 'is-pinned'] : ['Waiting for your teacher', '']);
      paint(panel,
        st.pinned && !st.ended
          ? h('div', { class: 'cbl-doubt is-pinned-card' }, h('div', { class: 'cbl-doubt-tag' }, '📌 Pinned by your teacher'), h('div', { class: 'cbl-doubt-body' }, st.pinned.body), h('div', { class: 'muted cb-small' }, st.pinned.name))
          : null,
        h('div', { class: 'cbl-section' }, 'Your doubts'),
        st.doubts.length
          ? [...st.doubts].reverse().map((d) => {
            const [label, tone] = status(d);
            return h('div', { class: 'cbl-doubt' }, h('div', { class: 'cbl-doubt-body' }, d.body), h('span', { class: `cbl-status ${tone}` }, label));
          })
          : h('div', { class: 'cbl-empty' }, 'Doubts go straight to your teacher’s Doubt Box — not into the chat. Only you and your teacher see them, unless your teacher pins one for the class.'));
      return;
    }
    paint(panel, notesPanel());
  }

  function notesPanel() {
    if (st.notesState === 'ready') {
      const n = st.notes;
      return h('div', { class: 'cbl-notes' },
        h('div', { class: 'cbl-notes-icon' }, renderIcon('fileText', { size: 30 })),
        h('div', { class: 'cb-strong' }, n.title),
        h('div', { class: 'muted cb-small' }, [n.file_size_bytes ? megabytes(n.file_size_bytes) : null, 'PDF', 'Also in Notes & DPPs'].filter(Boolean).join(' · ')),
        h('button', {
          class: 'btn primary',
          type: 'button',
          onclick: () => coaching.portal.downloadMaterial(n.id).then((saved) => saved && toast(saved)).catch((err) => toast(err.message, 'error')),
        }, renderIcon('download', { size: 16 }), 'Download notes'),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => switchTab('materials') }, 'All notes & DPPs'));
    }
    if (st.notesState === 'waiting') {
      return h('div', { class: 'cbl-notes' },
        h('div', { class: 'cbl-spinner' }),
        h('div', { class: 'cb-strong' }, 'Class over — the notes are on their way'),
        h('div', { class: 'muted cb-small' }, 'Your teacher’s board is sending them. They will appear here by themselves.'));
    }
    if (st.notesState === 'none') {
      return h('div', { class: 'cbl-notes' },
        h('div', { class: 'cb-strong' }, 'No notes for this class yet'),
        h('div', { class: 'muted cb-small' }, 'When your teacher sends them, they will be in Notes & DPPs and you will get a notification.'),
        h('button', { class: 'btn', type: 'button', onclick: () => switchTab('materials') }, 'Notes & DPPs'));
    }
    return h('div', { class: 'cbl-notes' },
      h('div', { class: 'cbl-notes-icon is-muted' }, renderIcon('fileText', { size: 30 })),
      h('div', { class: 'cb-strong' }, 'Notes come after class'),
      h('div', { class: 'muted cb-small' }, 'The moment your teacher ends the class, the notes from the board show up here to download.'));
  }

  /* — the box: chat, or a doubt — */

  const composer = h('form', { class: 'cbl-composer', onsubmit: (e) => { e.preventDefault(); send(); } });
  const input = h('input', { class: 'cbl-input', type: 'text', maxlength: '500', autocomplete: 'off', enterkeyhint: 'send' });
  const sendBtn = h('button', { class: 'cbl-send', type: 'submit', 'aria-label': 'Send' }, renderIcon('send', { size: 18 }));
  const hint = h('div', { class: 'cbl-hint' });

  function paintComposer() {
    composer.hidden = st.ended || st.tab === 'notes';
    input.placeholder = st.asDoubt ? 'Ask your teacher a doubt…' : 'Message the class…';
    paint(composer,
      h('button', {
        class: `cbl-switch${st.asDoubt ? ' is-on' : ''}`,
        type: 'button',
        role: 'switch',
        'aria-checked': String(st.asDoubt),
        onclick: () => {
          st.asDoubt = !st.asDoubt;
          st.error = null;
          paintComposer();
          input.focus();
        },
      }, h('span', { class: 'cbl-switch-knob' }), 'Mark as doubt'),
      h('div', { class: 'cbl-compose-row' }, input, sendBtn),
      hint);
    paintHint();
  }

  /** The slow-mode countdown and any refusal, updated by the ticker. */
  function paintHint() {
    const lane = st.asDoubt ? 'doubt' : 'chat';
    const wait = st.readyAt[lane] - Date.now();
    sendBtn.disabled = wait > 0;
    composer.classList.toggle('is-doubt', st.asDoubt);
    const text = wait > 0
      ? `Slow mode: you can send again in ${Math.ceil(wait / 1000)}s`
      : st.error || (st.asDoubt ? 'Goes to your teacher’s Doubt Box, not the chat.' : '');
    if (hint.textContent !== text) hint.textContent = text;
    hint.classList.toggle('is-error', Boolean(st.error) && wait <= 0);
  }

  async function send() {
    const text = input.value.trim();
    const lane = st.asDoubt ? 'doubt' : 'chat';
    if (!text || Date.now() < st.readyAt[lane]) return;
    sendBtn.disabled = true;
    const ack = lane === 'doubt' ? await request('student:ask_doubt', { body: text }) : await request('chat:send', { text });
    if (ack.ok) {
      input.value = '';
      st.error = null;
      if (lane === 'chat') {
        st.slowMs = ack.data.slow_mode_ms || st.slowMs;
        st.mine.add(ack.data.id);
        // The room's copy arrives before the ack; mark it as the student's own.
        const echoed = st.chat.find((m) => m.id === ack.data.id);
        if (echoed) panel.querySelector(`.cbl-msg[data-id="${ack.data.id}"]`)?.replaceWith(chatLine(echoed));
      } else {
        st.doubts.push(ack.data);
        if (st.tab !== 'doubts') toast('Sent to your teacher’s Doubt Box');
        paintTabs();
        if (st.tab === 'doubts') paintPanel();
      }
      st.readyAt[lane] = Date.now() + st.slowMs;
    } else {
      if (ack.details?.code === 'slow_mode') st.readyAt[lane] = Date.now() + ack.details.retry_after_ms;
      st.error = ack.details?.code === 'slow_mode' ? null : ack.error;
    }
    paintHint();
  }

  /* — the poll sheet — */

  const scrim = h('div', { class: 'cbl-scrim' });
  const sheet = h('section', { class: 'cbl-sheet', role: 'dialog', 'aria-modal': 'false', 'aria-label': 'Quick poll' });
  const ringArc = svg('circle', { class: 'cbl-ring-arc', cx: 32, cy: 32, r: RING_R, 'stroke-dasharray': RING_C.toFixed(2), 'stroke-dashoffset': '0', transform: 'rotate(-90 32 32)' });
  const ringText = h('div', { class: 'cbl-ring-text' });
  const ring = h('div', { class: 'cbl-ring' }, svg('svg', { viewBox: '0 0 64 64', width: 72, height: 72 }, svg('circle', { class: 'cbl-ring-track', cx: 32, cy: 32, r: RING_R }), ringArc), ringText);
  const votesText = h('span', { class: 'muted cb-small' });

  function openSheet() {
    if (!sheet.isConnected) document.body.append(scrim, sheet);
    // Next frame, so the slide-up animates from off-screen.
    requestAnimationFrame(() => {
      sheet.classList.add('is-open');
      scrim.classList.add('is-open');
    });
  }

  function closeSheet() {
    clearTimeout(resultsTimer);
    sheet.classList.remove('is-open');
    scrim.classList.remove('is-open');
  }
  scrim.addEventListener('click', () => st.results && closeSheet());

  function openPoll(data) {
    clearTimeout(resultsTimer);
    st.results = null;
    st.outcome = null;
    st.poll = {
      ...data,
      endsAt: Date.now() + data.remaining_ms,
      choice: data.my_vote?.choice ?? null,
      locked: Boolean(data.my_vote),
      responseMs: data.my_vote?.response_ms ?? null,
    };
    paintSheet();
    openSheet();
    navigator.vibrate?.(80);
  }

  async function vote(letter) {
    const poll = st.poll;
    if (!poll || poll.locked || poll.endsAt < Date.now() - 250) return;
    // Locked on the tap, before the server answers: one tap, one answer.
    poll.locked = true;
    poll.choice = letter;
    paintSheet();
    const ack = await request('student:submit_vote', { poll_id: poll.poll_id, choice: letter });
    if (st.poll !== poll) return;
    if (ack.ok) {
      poll.responseMs = ack.data.response_ms;
    } else if (ack.details?.code === 'already_voted') {
      poll.choice = ack.details.choice;
    } else {
      poll.locked = false;
      poll.choice = null;
      poll.error = ack.details?.code === 'poll_closed' ? 'Time is up for this poll' : ack.error;
    }
    paintSheet();
  }

  function showResults(data) {
    clearTimeout(resultsTimer);
    st.results = data;
    // Each announcement is followed by the student's own result.
    st.outcome = null;
    st.poll = null;
    paintSheet();
    openSheet();
    // Back to the class by itself after a while, if not closed sooner.
    resultsTimer = setTimeout(closeSheet, 20_000);
  }

  function paintSheet() {
    if (st.results) return paint(sheet, resultsView(st.results));
    const poll = st.poll;
    if (!poll) return closeSheet();
    const letters = ['A', 'B', 'C', 'D'].slice(0, poll.option_count);
    return paint(sheet,
      h('div', { class: 'cbl-grab' }),
      h('div', { class: 'cbl-sheet-head' },
        h('div', { class: 'cb-grow' }, h('div', { class: 'cbl-kicker' }, renderIcon('zap', { size: 14 }), 'Quick poll'), h('h3', {}, poll.question || 'Pick your answer'), votesText),
        ring),
      h('div', { class: `cbl-options${poll.locked ? ' is-locked' : ''}` },
        ...letters.map((letter) => {
          const text = poll.options?.find((o) => o.option === letter)?.text;
          const chosen = poll.choice === letter;
          return h('button', {
            class: `cbl-option${chosen ? ' is-chosen' : ''}`,
            type: 'button',
            disabled: poll.locked,
            'aria-pressed': String(chosen),
            onclick: () => vote(letter),
          }, h('span', { class: 'cbl-option-letter' }, letter), text ? h('span', { class: 'cbl-option-text' }, text) : null, chosen ? renderIcon('lock', { size: 18, class: 'cbl-option-lock' }) : null);
        })),
      h('div', { class: `cbl-sheet-foot${poll.error ? ' is-error' : ''}` },
        poll.error || (poll.locked ? `Locked in: ${poll.choice}${poll.responseMs !== null ? ` in ${seconds(poll.responseMs)}` : ''}. Results when time is up.` : 'Tap your answer. You get one try.')));
  }

  function resultsView(r) {
    const o = st.outcome;
    if (r.awaiting_answer) return awaitingView(r, o);
    const verdict = !o
      ? null
      : o.choice === null
        ? h('div', { class: 'cbl-verdict' }, 'You did not answer this one')
        : o.correct === null
          ? h('div', { class: 'cbl-verdict' }, `You picked ${o.choice}`)
          : o.correct
            ? h('div', { class: 'cbl-verdict is-right' }, renderIcon('checkCircle', { size: 20 }), `Right! ${seconds(o.response_ms)}${o.rank ? ` · #${o.rank} fastest of ${o.ranked_of}` : ''}`)
            : h('div', { class: 'cbl-verdict is-wrong' }, renderIcon('xCircle', { size: 20 }), `You picked ${o.choice}. The answer was ${r.correct_option}.`);
    return [
      h('div', { class: 'cbl-grab' }),
      h('div', { class: 'cbl-sheet-head' },
        h('div', { class: 'cb-grow' },
          h('div', { class: 'cbl-kicker' }, renderIcon('barChart', { size: 14 }), 'Poll results'),
          h('h3', {}, r.correct_option ? `Answer: ${r.correct_option}` : 'How the class answered'),
          h('span', { class: 'muted cb-small' }, `${r.total} answered${r.accuracy !== null ? ` · ${r.accuracy}% got it right` : ''}`)),
        h('button', { class: 'cbl-icon-btn is-plain', type: 'button', 'aria-label': 'Close', onclick: closeSheet }, renderIcon('close', { size: 18 }))),
      verdict,
      h('div', { class: 'cbl-bars' }, ...r.options.map((opt) => h('div', { class: `cbl-bar${opt.correct ? ' is-correct' : ''}${o?.choice === opt.option ? ' is-mine' : ''}` },
        h('span', { class: 'cbl-bar-letter' }, opt.option),
        h('div', { class: 'cbl-bar-track' }, h('div', { class: 'cbl-bar-fill', style: `width:${opt.percent}%` })),
        h('span', { class: 'cbl-bar-num' }, `${opt.percent}%`)))),
      r.leaderboard.length
        ? h('div', { class: 'cbl-top3' },
          h('div', { class: 'cbl-section' }, renderIcon('trophy', { size: 15 }), 'Top 3 fastest'),
          ...r.leaderboard.slice(0, 3).map((row, i) => h('div', { class: 'cbl-top3-row' }, h('span', { class: 'cbl-medal' }, MEDALS[i]), h('span', { class: 'cb-grow' }, row.name), h('strong', {}, seconds(row.response_ms)))))
        : null,
      h('button', { class: 'btn primary cbl-sheet-btn', type: 'button', onclick: closeSheet }, 'Back to class'),
    ];
  }

  /** Time is up, and the teacher has yet to reveal the answer. */
  function awaitingView(r, o) {
    return [
      h('div', { class: 'cbl-grab' }),
      h('div', { class: 'cbl-sheet-head' },
        h('div', { class: 'cb-grow' },
          h('div', { class: 'cbl-kicker' }, renderIcon('timer', { size: 14 }), 'Time is up'),
          h('h3', {}, r.question || 'How the class answered'),
          h('span', { class: 'muted cb-small' }, `${r.total} answered · your teacher reveals the answer next`)),
        h('button', { class: 'cbl-icon-btn is-plain', type: 'button', 'aria-label': 'Close', onclick: closeSheet }, renderIcon('close', { size: 18 }))),
      o && h('div', { class: 'cbl-verdict' }, o.choice ? `Your answer: ${o.choice}` : 'You did not answer this one'),
      h('div', { class: 'cbl-bars' }, ...r.options.map((opt) => h('div', { class: `cbl-bar${o?.choice === opt.option ? ' is-mine' : ''}` },
        h('span', { class: 'cbl-bar-letter' }, opt.option),
        h('div', { class: 'cbl-bar-track' }, h('div', { class: 'cbl-bar-fill', style: `width:${opt.percent}%` })),
        h('span', { class: 'cbl-bar-num' }, `${opt.percent}%`)))),
      h('div', { class: 'cbl-sheet-foot' }, 'The answer and the fastest right answers show here when your teacher reveals it.'),
    ];
  }

  /* — the clocks — */

  function tick() {
    if (disposed) return;
    if (root.isConnected) mounted = true;
    // Taken off the page without the cleanup running: stop anyway.
    else if (mounted) return dispose();
    if (!st.ended) elapsed.textContent = clock(Date.now() - startedAt);
    const poll = st.poll;
    if (poll) {
      const left = Math.max(0, poll.endsAt - Date.now());
      const total = (poll.duration_sec || 30) * 1000;
      ringArc.setAttribute('stroke-dashoffset', (RING_C * (1 - left / total)).toFixed(2));
      ring.classList.toggle('is-hurry', left < 5000);
      ringText.textContent = String(Math.ceil(left / 1000));
      votesText.textContent = `${poll.votes ?? 0} answered`;
    }
    paintHint();
    return undefined;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    clearInterval(ticker);
    clearTimeout(retryTimer);
    clearTimeout(notesTimer);
    clearTimeout(resultsTimer);
    document.removeEventListener('fullscreenchange', paintStage);
    playerHandle?.destroy();
    if (document.fullscreenElement === stage) document.exitFullscreen().catch(() => {});
    const socket = ws;
    ws = null;
    socket?.close();
    scrim.remove();
    sheet.remove();
  }

  const ticker = setInterval(tick, TICK_MS);
  registerCleanup(dispose);

  paint(root,
    h('div', { class: 'cbl' },
      h('div', { class: 'cbl-main' }, stage, pinnedBar),
      h('div', { class: 'cbl-side' }, tabs, panel, composer)));
  paintStage();
  paintTabs();
  paintPanel();
  paintComposer();
  connect();
  return root;
}
