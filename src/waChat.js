import { gymNowTime, gymOffsetMinutes, utcTimestamp } from './clock.js';
import { config } from './config.js';
import { all, get, run, tenantStorage } from './db.js';
import { today } from './validate.js';
import { sendChatMessage } from './whatsapp.js';

/**
 * The WhatsApp conversation engine both AI receptionists share: CoachBook's
 * admissions assistant (src/coaching/receptionist.js) and GymBook's front-desk
 * assistant (src/gymReceptionist.js).
 *
 * Everything here is about the chat, not the business: the conversation row
 * and its transcript (wa_conversations / wa_messages, carried by every tenant
 * database), the staff takeover that silences the assistant, gathering a
 * burst of messages into one question, the reply ceilings, and sending —
 * text, map pins and the owner's alert. What the assistant knows and may do
 * is each vertical's own.
 *
 * Every function that touches the database expects to run inside the
 * tenant's context (tenantStorage), the same as a request handler.
 */

/* ── Labels ──────────────────────────────────────────────────────────── */

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 0 (Sunday) – 6 for a YYYY-MM-DD calendar date. */
export const weekdayOf = (iso) => new Date(`${iso}T00:00:00Z`).getUTCDay();

/** "4:00 PM" from "16:00". */
export function timeLabel(hhmm) {
  if (!hhmm) return '';
  const [h, m] = String(hhmm).split(':').map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m || 0).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** "Wed, 22 Oct" from "2026-10-22". */
export function dateLabel(iso) {
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00Z`);
  return `${DAY_NAMES[d.getUTCDay()].slice(0, 3)}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** "Mon, Wed, Fri" from "1,3,5". */
export const daysLabel = (weekdays) =>
  String(weekdays || '')
    .split(',')
    .filter((d) => d !== '')
    .map((d) => DAY_NAMES[Number(d)]?.slice(0, 3))
    .filter(Boolean)
    .join(', ');

/** The last ten digits — how an Indian number typed any way at the desk
 * ("098765 43210", "+91 98765-43210") compares to WhatsApp's 919876543210. */
export const phoneKey = (phone) => {
  const digits = String(phone ?? '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : digits || null;
};

/** "9:40 PM" for a stored UTC timestamp, in the tenant's time. */
export function localTime(utc) {
  const local = new Date(Date.parse(`${utc.replace(' ', 'T')}Z`) + gymOffsetMinutes() * 60_000).toISOString();
  const day = local.slice(0, 10);
  return `${timeLabel(local.slice(11, 16))}${day === today() ? '' : ` on ${dateLabel(day)}`}`;
}

/** Whether a person is at the desk now, by a settings row's office_* columns. */
export function withinOfficeHours(settings) {
  const days = String(settings.office_days || '').split(',').filter(Boolean).map(Number);
  const now = gymNowTime();
  return days.includes(weekdayOf(today())) && now >= settings.office_open && now < settings.office_close;
}

/* ── Conversations and the transcript ────────────────────────────────── */

/** Far enough ahead to mean "until someone turns it back on". */
export const PAUSED_INDEFINITELY = '9999-12-31 23:59:59';

export const isPaused = (conv) => Boolean(conv?.bot_paused_until && conv.bot_paused_until > utcTimestamp());

/** The chat's row, created on first contact. A chat that reappears under a
 * different address (WhatsApp moving it to a privacy @lid) is matched by
 * its phone number and follows the newest address. */
export function conversationFor({ jid, phone, pushName }) {
  let conv = get('SELECT * FROM wa_conversations WHERE jid = ?', [jid]);
  if (!conv && phone) {
    conv = get('SELECT * FROM wa_conversations WHERE phone = ? ORDER BY id DESC LIMIT 1', [phone]);
    if (conv) run('UPDATE wa_conversations SET jid = ? WHERE id = ?', [jid, conv.id]);
  }
  if (!conv) {
    const info = run('INSERT INTO wa_conversations (jid, phone, contact_name) VALUES (?, ?, ?)', [jid, phone || null, pushName || null]);
    return get('SELECT * FROM wa_conversations WHERE id = ?', [info.lastInsertRowid]);
  }
  if ((phone && !conv.phone) || (pushName && pushName !== conv.contact_name)) {
    run("UPDATE wa_conversations SET phone = COALESCE(phone, ?), contact_name = COALESCE(?, contact_name), updated_at = datetime('now') WHERE id = ?", [
      phone || null,
      pushName || null,
      conv.id,
    ]);
    conv = get('SELECT * FROM wa_conversations WHERE id = ?', [conv.id]);
  }
  return conv;
}

/** Adds one message to the transcript. Null when WhatsApp redelivered one
 * already there (same chat, same message id). `author` 'parent' is the
 * contact on the other end — the column predates gyms. */
export function record(conv, { direction, author, kind = 'text', body, waId = null, status = 'sent', error = null, meta = null }) {
  const info = run(
    `INSERT OR IGNORE INTO wa_messages (conversation_id, direction, author, kind, body, wa_id, status, error, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [conv.id, direction, author, kind, String(body).slice(0, 4000), waId, status, error, meta ? JSON.stringify(meta) : null],
  );
  if (!info.changes) return null;
  if (kind !== 'note') run("UPDATE wa_conversations SET last_message_at = datetime('now'), updated_at = datetime('now') WHERE id = ?", [conv.id]);
  return Number(info.lastInsertRowid);
}

export const note = (conv, body) => record(conv, { direction: 'out', author: 'system', kind: 'note', body });

export function pause(conv, minutes, by) {
  const until = minutes === null ? PAUSED_INDEFINITELY : utcTimestamp(minutes * 60_000);
  run("UPDATE wa_conversations SET bot_paused_until = ?, paused_by = ?, updated_at = datetime('now') WHERE id = ?", [until, by, conv.id]);
  conv.bot_paused_until = until;
  conv.paused_by = by;
  return until;
}

/** A person replied in this chat: the assistant steps back for
 * `pauseMinutes`, and anything it was about to answer is dropped. */
export function takeOver(conv, { pauseMinutes, slug, by }) {
  const wasPaused = isPaused(conv);
  const until = pause(conv, Math.max(1, Number(pauseMinutes) || 720), by);
  run("UPDATE wa_conversations SET needs_staff = 0, updated_at = datetime('now') WHERE id = ?", [conv.id]);
  cancelPending(slug, conv.id);
  if (!wasPaused) note(conv, `Staff replied — the assistant is paused in this chat until ${localTime(until)}.`);
}

/** The desk's pause switch: paused until turned back on, or resumed now. */
export function setPaused(conv, paused) {
  if (paused) {
    pause(conv, null, 'desk');
    note(conv, 'The assistant was paused in this chat from the desk.');
  } else {
    run("UPDATE wa_conversations SET bot_paused_until = NULL, paused_by = NULL, needs_staff = 0, updated_at = datetime('now') WHERE id = ?", [conv.id]);
    note(conv, 'The assistant was switched back on in this chat.');
  }
}

/** Raises the "needs a reply from the team" flag on the chat. */
export function flagForStaff(conv, why) {
  run("UPDATE wa_conversations SET needs_staff = 1, handoff_reason = ?, updated_at = datetime('now') WHERE id = ?", [why, conv.id]);
}

const HISTORY_MESSAGES = 20;

/** The chat before message `beforeId`, oldest first, for the model. */
export const historyBefore = (conv, beforeId) =>
  all(
    `SELECT author, body FROM wa_messages WHERE conversation_id = ? AND id < ? AND kind != 'note' AND status != 'failed'
     ORDER BY id DESC LIMIT ?`,
    [conv.id, beforeId, HISTORY_MESSAGES],
  ).reverse();

const CONVERSATION_FIELDS = 'id, jid, phone, contact_name, inquiry_id, lead_id, bot_paused_until, paused_by, needs_staff, handoff_reason, last_message_at, created_at';

/** The conversation as the desk's drawer shows it, or null. */
export const conversationView = (conv) =>
  conv
    ? {
        ...get(`SELECT ${CONVERSATION_FIELDS} FROM wa_conversations WHERE id = ?`, [conv.id]),
        paused: isPaused(get('SELECT bot_paused_until FROM wa_conversations WHERE id = ?', [conv.id])),
      }
    : null;

/** The transcript for the desk, newest 300; `after` returns only newer
 * messages, for the drawer's live refresh. */
export const transcriptMessages = (conv, { after = 0 } = {}) =>
  conv
    ? all(
        `SELECT id, direction, author, kind, body, status, error, meta, created_at FROM wa_messages
         WHERE conversation_id = ? AND id > ? ORDER BY id DESC LIMIT 300`,
        [conv.id, after],
      )
        .reverse()
        .map((m) => ({ ...m, meta: m.meta ? JSON.parse(m.meta) : null }))
    : [];

/* ── Gathering a burst into one question ─────────────────────────────── */

/** `${slug}|${conversation id}` -> the messages waiting for one reply. */
const pending = new Map();

/**
 * Queues one incoming message. `respond(buffer, messages)` is called once
 * the contact stops typing, inside the tenant's context, with every message
 * gathered since the last reply.
 */
export function enqueue(tenant, conv, message, respond) {
  const key = `${tenant.store.slug}|${conv.id}`;
  let buffer = pending.get(key);
  if (!buffer) {
    buffer = { key, tenant, conversationId: conv.id, messages: [], firstAt: 0, timer: null, running: false, respond };
    pending.set(key, buffer);
  }
  buffer.messages.push(message);
  if (!buffer.firstAt) buffer.firstAt = Date.now();
  schedule(buffer);
}

/** Waits for the contact to stop typing — debounceMs after the last message,
 * but never past maxWaitMs from the first. A reply already being written
 * picks newer messages up as soon as it is sent. */
function schedule(buffer) {
  if (buffer.running) return;
  clearTimeout(buffer.timer);
  const { debounceMs, maxWaitMs } = config.aiReceptionist;
  const wait = Math.max(0, Math.min(debounceMs, buffer.firstAt + maxWaitMs - Date.now()));
  buffer.timer = setTimeout(() => flush(buffer), wait);
  buffer.timer.unref?.();
}

export function cancelPending(slug, conversationId) {
  const buffer = pending.get(`${slug}|${conversationId}`);
  if (!buffer) return;
  clearTimeout(buffer.timer);
  buffer.timer = null;
  buffer.messages = [];
  buffer.firstAt = 0;
  if (!buffer.running) pending.delete(buffer.key);
}

async function flush(buffer) {
  buffer.timer = null;
  if (buffer.running || !buffer.messages.length) return;
  const messages = buffer.messages.splice(0);
  buffer.firstAt = 0;
  buffer.running = true;
  try {
    await tenantStorage.run(buffer.tenant.store, () => buffer.respond(buffer, messages));
  } catch (err) {
    console.error(`[receptionist:${buffer.tenant.store.slug}] reply failed:`, err.message);
  } finally {
    buffer.running = false;
    if (buffer.messages.length) {
      buffer.firstAt = Date.now();
      schedule(buffer);
    } else {
      pending.delete(buffer.key);
    }
  }
}

/** Resolves once every gathered message has been answered — for tests and
 * a graceful shutdown. */
export async function receptionistIdle(timeoutMs = 10_000) {
  const until = Date.now() + timeoutMs;
  while (pending.size && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
  return pending.size === 0;
}

/* ── Ceilings ────────────────────────────────────────────────────────── */

/**
 * Whether the assistant may answer this chat now. Replies per chat per hour
 * (a loop with another auto-responder stops itself, and the chat goes to
 * the desk) and per tenant per day (the cost cap). `handoff(conv, reason)`
 * is the vertical's own: it flags the chat and files the lead.
 */
export function withinCeilings(conv, { handoff, org }) {
  const { chatHourlyLimit, dailyLimit } = config.aiReceptionist;
  const lastHour = get("SELECT COUNT(*) AS n FROM wa_messages WHERE conversation_id = ? AND author = 'ai' AND created_at >= ?", [conv.id, utcTimestamp(-3_600_000)]).n;
  if (lastHour >= chatHourlyLimit) {
    pause(conv, 60, 'limit');
    handoff(conv, 'The assistant reached its hourly reply limit in this chat');
    note(conv, 'The assistant paused itself for an hour after its reply limit for this chat. Please reply in person.');
    return false;
  }
  const lastDay = get("SELECT COUNT(*) AS n FROM wa_messages WHERE author = 'ai' AND created_at >= ?", [utcTimestamp(-86_400_000)]).n;
  if (lastDay >= dailyLimit) {
    if (!conv.needs_staff) handoff(conv, `The assistant reached today's reply limit for the ${org}`);
    return false;
  }
  return true;
}

/* ── Sending ─────────────────────────────────────────────────────────── */

/** Sends one message into the chat and adds it to the transcript, sent or
 * failed. Resolves to whether it went. */
export async function deliver(slug, conv, { author, text = null, location = null, image = null, body = text, kind = location ? 'location' : image ? 'media' : 'text', typingMs = 0, meta = null }) {
  try {
    const { id } = await sendChatMessage({ slug, jid: conv.jid, text, location, image, typingMs });
    record(conv, { direction: 'out', author, kind, body, waId: id, status: 'sent', meta });
    return true;
  } catch (err) {
    record(conv, { direction: 'out', author, kind, body, status: 'failed', error: err.message, meta });
    return false;
  }
}

/**
 * A reply typed at the desk, sent from the tenant's number: recorded under
 * the staff member's name and pausing the assistant in the chat the same as
 * a reply typed on the phone. Sent first, so a failed send never leaves the
 * assistant paused for nothing.
 */
export async function staffSend(conv, { text, userName = null, pauseMinutes }) {
  const { slug } = tenantStorage.getStore() ?? {};
  const { id } = await sendChatMessage({ slug, jid: conv.jid, text });
  record(conv, { direction: 'out', author: 'staff', body: text, waId: id, status: 'sent', meta: userName ? { by: userName } : null });
  takeOver(conv, { pauseMinutes, slug, by: 'desk' });
}

const HOLDING_EVERY_MS = 6 * 60 * 60 * 1000;

/** When the model fails, the contact still hears back — once in a while, not
 * on every message — and the desk gets the chat. */
export async function holdingReply(slug, conv, err, { handoff, text }) {
  const recent = get(
    "SELECT 1 FROM wa_messages WHERE conversation_id = ? AND author = 'ai' AND meta LIKE '%\"holding\":true%' AND created_at >= ?",
    [conv.id, utcTimestamp(-HOLDING_EVERY_MS)],
  );
  handoff(conv, `The assistant could not reply (${String(err.message || 'error').slice(0, 120)})`);
  if (!recent) await deliver(slug, conv, { author: 'ai', text, typingMs: 1000, meta: { holding: true } });
}

const LOCATION_EVERY_MS = 30 * 60 * 1000;

/** Whether a place has anything to send: a pin or at least an address. */
export const hasPlace = (place) => (place.latitude != null && place.longitude != null) || Boolean(place.address);

/**
 * The tenant's location: a native map pin when the coordinates are set
 * (then the landmark directions as words, which a pin cannot carry), else
 * the address as text. At most once per half hour per chat.
 */
export async function sendLocation(slug, conv, place) {
  const recent = get("SELECT 1 FROM wa_messages WHERE conversation_id = ? AND kind = 'location' AND status = 'sent' AND created_at >= ?", [
    conv.id,
    utcTimestamp(-LOCATION_EVERY_MS),
  ]);
  if (recent) return;
  const address = place.address || null;
  const directions = place.directions || null;
  const lines = [`📍 *${place.name}*`, address, directions ? `Landmark: ${directions}` : null, place.mapsUrl || null].filter(Boolean);
  if (place.latitude != null && place.longitude != null) {
    const sent = await deliver(slug, conv, {
      author: 'ai',
      location: { latitude: place.latitude, longitude: place.longitude, name: place.name, address: address || undefined },
      body: lines.join('\n'),
    });
    if (sent && directions) await deliver(slug, conv, { author: 'ai', text: `🧭 How to reach: ${directions}` });
  } else if (address) {
    await deliver(slug, conv, { author: 'ai', text: lines.join('\n') });
  }
}

/** The owner's "🔥 HOT LEAD" message to their own phone, logged in the
 * delivery log and noted in the chat. `who` names them in the note. */
export async function sendOwnerAlert(slug, conv, { phone, message, who }) {
  let status = 'sent';
  let error = null;
  try {
    await sendChatMessage({ slug, phone, text: message });
  } catch (err) {
    status = 'failed';
    error = err.message;
  }
  try {
    run('INSERT INTO whatsapp_logs (phone, member_id, type, message, status, error) VALUES (?, NULL, ?, ?, ?, ?)', [phone, 'lead_alert', message, status, error]);
  } catch (logErr) {
    console.error(`[receptionist:${slug}] could not log the lead alert:`, logErr.message);
  }
  note(conv, status === 'sent' ? `Hot-lead alert sent to the ${who}.` : `The hot-lead alert to the ${who} failed: ${error}`);
}
