import fs from 'node:fs';
import { coachConfigured } from '../aiCoach.js';
import { gymNowTime, gymOffsetMinutes, utcTimestamp } from '../clock.js';
import { config } from '../config.js';
import { all, get, run, tenantStorage } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { findTenantBySlug, tenantDbPath } from '../tenants.js';
import { today } from '../validate.js';
import { moduleEnabled } from '../verticals.js';
import { formatPhoneNumber, markChatRead, onInboundMessage, sendChatMessage, whatsappReady } from '../whatsapp.js';
import { coachingSettings } from './notify.js';
import * as data from './receptionistData.js';
import { FALLBACK_REPLY, promisesFollowUp, runReceptionist } from './receptionistAi.js';

/**
 * CoachBook's 24/7 WhatsApp admissions assistant.
 *
 * A parent writes to the institute's linked WhatsApp number (src/whatsapp.js
 * hears it on the gym's own socket); this decides whether the assistant
 * answers, gathers a burst of messages into one question, has
 * receptionistAi.js answer it from the institute's live data, and sends the
 * reply — then, when a demo was booked, the location pin and the director's
 * hot-lead alert. Every message either way is kept as the chat's transcript
 * (wa_messages), which the admissions desk reads beside the lead.
 *
 * Who decides, in order:
 * - Tenant: only the gym whose socket heard the message, resolved from the
 *   registry by slug, and only a live CoachBook account. Nothing in the
 *   message picks the database.
 * - The owner: ai_receptionist off means nothing is stored or answered.
 * - Staff: a reply typed on the linked phone (or sent from the desk) pauses
 *   the assistant in that chat for ai_pause_minutes, so it never talks over
 *   a person. A reply drafted while staff took over is dropped.
 * - Ceilings: replies per chat per hour (a loop with another auto-responder
 *   stops itself) and per institute per day (the cost cap).
 */

/* ── Tenant ──────────────────────────────────────────────────────────── */

/** The tenant context for a socket's gym, or null when it is not a live
 * CoachBook account (a gym, a library, a suspended trial). */
function tenantFor(slug) {
  if (!slug || !fs.existsSync(config.platformDbFile)) return null;
  const tenant = findTenantBySlug(slug);
  if (!tenant || !['trial', 'active'].includes(tenant.status)) return null;
  if ((tenant.business_type || 'gym') !== 'coaching') return null;
  return {
    store: { slug: tenant.slug, dbFile: tenantDbPath(tenant.slug), timezone: tenant.timezone || undefined, businessType: 'coaching' },
    instituteName: tenant.gym_name || tenant.display_name || 'our institute',
  };
}

/* ── Conversations and the transcript ────────────────────────────────── */

/** Far enough ahead to mean "until someone turns it back on". */
const PAUSED_INDEFINITELY = '9999-12-31 23:59:59';

const isPaused = (conv) => Boolean(conv?.bot_paused_until && conv.bot_paused_until > utcTimestamp());

/** The chat's row, created on first contact. A chat that reappears under a
 * different address (WhatsApp moving it to a privacy @lid) is matched by
 * its phone number and follows the newest address. */
function conversationFor({ jid, phone, pushName }) {
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
 * already there (same chat, same message id). */
function record(conv, { direction, author, kind = 'text', body, waId = null, status = 'sent', error = null, meta = null }) {
  const info = run(
    `INSERT OR IGNORE INTO wa_messages (conversation_id, direction, author, kind, body, wa_id, status, error, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [conv.id, direction, author, kind, String(body).slice(0, 4000), waId, status, error, meta ? JSON.stringify(meta) : null],
  );
  if (!info.changes) return null;
  if (kind !== 'note') run("UPDATE wa_conversations SET last_message_at = datetime('now'), updated_at = datetime('now') WHERE id = ?", [conv.id]);
  return Number(info.lastInsertRowid);
}

const note = (conv, body) => record(conv, { direction: 'out', author: 'system', kind: 'note', body });

function pause(conv, minutes, by) {
  const until = minutes === null ? PAUSED_INDEFINITELY : utcTimestamp(minutes * 60_000);
  run("UPDATE wa_conversations SET bot_paused_until = ?, paused_by = ?, updated_at = datetime('now') WHERE id = ?", [until, by, conv.id]);
  conv.bot_paused_until = until;
  conv.paused_by = by;
  return until;
}

/** "9:40 PM" for a stored UTC timestamp, in the institute's time. */
function localTime(utc) {
  const local = new Date(Date.parse(`${utc.replace(' ', 'T')}Z`) + gymOffsetMinutes() * 60_000).toISOString();
  const day = local.slice(0, 10);
  return `${data.timeLabel(local.slice(11, 16))}${day === today() ? '' : ` on ${data.dateLabel(day)}`}`;
}

/* ── Incoming ────────────────────────────────────────────────────────── */

function withinOfficeHours(settings) {
  const days = String(settings.office_days || '').split(',').filter(Boolean).map(Number);
  const now = gymNowTime();
  return days.includes(data.weekdayOf(today())) && now >= settings.office_open && now < settings.office_close;
}

/**
 * Every message the institute's number sends or receives in a one-to-one
 * chat, from src/whatsapp.js. Resolves to what was done with it — the tests
 * and the logs read that; WhatsApp does not.
 */
export async function receiveWhatsAppMessage(event) {
  const tenant = tenantFor(event?.slug);
  if (!tenant) return { handled: false, reason: 'not_coaching' };
  return tenantStorage.run(tenant.store, () => accept(event, tenant));
}

function accept(event, tenant) {
  if (!moduleEnabled('admissions')) return { handled: false, reason: 'module_off' };
  const settings = coachingSettings();
  if (!settings.ai_receptionist) return { handled: false, reason: 'off' };
  // The director testing from their own phone, or a teacher: not a lead.
  if (data.isInsiderPhone(event.phone)) return { handled: false, reason: 'insider' };
  const text = String(event.text || '').trim();
  if (!text) return { handled: false, reason: 'empty' };

  const conv = conversationFor(event);
  const rowId = record(conv, {
    direction: event.fromMe ? 'out' : 'in',
    author: event.fromMe ? 'staff' : 'parent',
    kind: event.kind === 'media' ? 'media' : 'text',
    body: text,
    waId: event.id || null,
    status: event.fromMe ? 'sent' : 'received',
  });
  if (!rowId) return { handled: false, reason: 'duplicate' };

  if (event.fromMe) {
    takeOver(conv, settings, tenant.store.slug, 'staff_reply');
    return { handled: true, reason: 'staff_reply' };
  }
  if (isPaused(conv)) return { handled: true, reason: 'paused' };
  if (settings.ai_reply_mode === 'after_hours' && withinOfficeHours(settings)) return { handled: true, reason: 'office_hours' };
  if (!coachConfigured()) return { handled: true, reason: 'ai_not_configured' };

  enqueue(tenant, conv, { text, key: event.key ?? null, rowId });
  return { handled: true, reason: 'queued' };
}

/** A person replied in this chat: the assistant steps back. */
function takeOver(conv, settings, slug, by) {
  const wasPaused = isPaused(conv);
  const until = pause(conv, Math.max(1, Number(settings.ai_pause_minutes) || 720), by);
  run("UPDATE wa_conversations SET needs_staff = 0, updated_at = datetime('now') WHERE id = ?", [conv.id]);
  cancelPending(slug, conv.id);
  if (!wasPaused) note(conv, `Staff replied — the assistant is paused in this chat until ${localTime(until)}.`);
}

/* ── Gathering a burst into one question ─────────────────────────────── */

/** `${slug}|${conversation id}` -> the messages waiting for one reply. */
const pending = new Map();

function enqueue(tenant, conv, message) {
  const key = `${tenant.store.slug}|${conv.id}`;
  let buffer = pending.get(key);
  if (!buffer) {
    buffer = { key, tenant, conversationId: conv.id, messages: [], firstAt: 0, timer: null, running: false };
    pending.set(key, buffer);
  }
  buffer.messages.push(message);
  if (!buffer.firstAt) buffer.firstAt = Date.now();
  schedule(buffer);
}

/** Waits for the parent to stop typing — debounceMs after the last message,
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

function cancelPending(slug, conversationId) {
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
    await tenantStorage.run(buffer.tenant.store, () => respond(buffer, messages));
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

/* ── Answering ───────────────────────────────────────────────────────── */

const HISTORY_MESSAGES = 20;
const HOLDING_EVERY_MS = 6 * 60 * 60 * 1000;
const LOCATION_EVERY_MS = 30 * 60 * 1000;

async function respond(buffer, messages) {
  const { slug } = buffer.tenant.store;
  const instituteName = buffer.tenant.instituteName;
  const conv = get('SELECT * FROM wa_conversations WHERE id = ?', [buffer.conversationId]);
  const settings = coachingSettings();
  if (!conv || !settings.ai_receptionist || isPaused(conv)) return;
  const { chatHourlyLimit, dailyLimit } = config.aiReceptionist;

  const lastHour = get("SELECT COUNT(*) AS n FROM wa_messages WHERE conversation_id = ? AND author = 'ai' AND created_at >= ?", [conv.id, utcTimestamp(-3_600_000)]).n;
  if (lastHour >= chatHourlyLimit) {
    pause(conv, 60, 'limit');
    data.handoff(conv, 'The assistant reached its hourly reply limit in this chat');
    note(conv, 'The assistant paused itself for an hour after its reply limit for this chat. Please reply in person.');
    return;
  }
  const lastDay = get("SELECT COUNT(*) AS n FROM wa_messages WHERE author = 'ai' AND created_at >= ?", [utcTimestamp(-86_400_000)]).n;
  if (lastDay >= dailyLimit) {
    if (!conv.needs_staff) data.handoff(conv, "The assistant reached today's reply limit for the institute");
    return;
  }

  markChatRead(slug, messages.map((m) => m.key));

  const inquiry = data.inquiryForConversation(conv);
  if (inquiry && conv.inquiry_id !== inquiry.id) {
    run('UPDATE wa_conversations SET inquiry_id = ? WHERE id = ?', [inquiry.id, conv.id]);
    conv.inquiry_id = inquiry.id;
  }
  const firstNew = Math.min(...messages.map((m) => m.rowId));
  const history = all(
    `SELECT author, body FROM wa_messages WHERE conversation_id = ? AND id < ? AND kind != 'note' AND status != 'failed'
     ORDER BY id DESC LIMIT ?`,
    [conv.id, firstNew, HISTORY_MESSAGES],
  ).reverse();
  const now = today();
  const payload = {
    now: `${data.dateLabel(now)} ${new Date(`${now}T00:00:00Z`).getUTCFullYear()}, ${data.timeLabel(gymNowTime())}`,
    today: now,
    institute: data.instituteProfile({ instituteName }),
    courses: data.courseCatalog(),
    LEAD: data.leadSummary(inquiry),
    contact: { whatsapp_name: conv.contact_name || null, KNOWN_FAMILY: data.knownFamily(conv.phone) },
  };

  const state = { booked: null, wantsLocation: false, admissionsTopic: false, handedOff: false };
  let result;
  try {
    result = await runReceptionist({
      instituteName,
      personaName: settings.ai_persona_name,
      history,
      data: payload,
      newMessages: messages.map((m) => m.text),
      executeTool: (name, args) => runTool(conv, state, name, args),
    });
  } catch (err) {
    console.error(`[receptionist:${slug}] the assistant could not answer:`, err.message);
    await holdingReply(slug, conv, err);
    return;
  }

  // A person may have stepped in while the model was thinking.
  if (isPaused(get('SELECT bot_paused_until FROM wa_conversations WHERE id = ?', [conv.id]))) {
    note(conv, 'An assistant reply was dropped because staff took over while it was being written.');
    return;
  }
  if (result.guarded) {
    data.handoff(conv, `The assistant held back a reply quoting an amount not in the institute's data (${result.ungrounded.join(', ')})`);
  } else if (!state.handedOff && promisesFollowUp(result.reply)) {
    data.handoff(conv, `Told the parent the team will follow up on: "${messages.map((m) => m.text).join(' / ').slice(0, 160)}"`);
  }

  await deliver(slug, conv, {
    author: 'ai',
    text: result.reply,
    // Brief: the parent has already waited while the model worked.
    typingMs: Math.min(1500, 500 + result.reply.length * 4),
    meta: {
      tools: result.toolCalls.map((t) => ({ name: t.name, ok: t.result?.ok !== false })),
      guarded: result.guarded || undefined,
      tokens: result.usage.input_tokens + result.usage.output_tokens,
    },
  });

  // A family that asked about fees or demos is a lead even if they never
  // said a name — the desk sees it rather than it living only in a chat.
  if (!conv.inquiry_id && state.admissionsTopic) {
    data.upsertLead(conv, { note: `Asked: ${messages.map((m) => m.text).join(' / ').slice(0, 300)}` });
  }
  if (state.booked && !state.booked.already_booked) {
    await sendLocation(slug, conv, settings, instituteName);
    await alertDirector(slug, conv, state.booked, settings);
  } else if (state.wantsLocation) {
    await sendLocation(slug, conv, settings, instituteName);
  }
}

/** Runs one tool call against this chat's lead. */
function runTool(conv, state, name, args) {
  switch (name) {
    case 'get_fee_details':
      state.admissionsTopic = true;
      return data.feeBreakdown(Number(args.course_id));
    case 'get_demo_slots':
      state.admissionsTopic = true;
      return data.demoAvailability({ courseId: args.course_id ? Number(args.course_id) : null });
    case 'save_lead':
      data.upsertLead(conv, args);
      return { ok: true, saved: true };
    case 'book_demo': {
      const result = data.bookDemo(conv, args);
      if (!result.ok) return result;
      state.booked = result;
      const s = coachingSettings();
      return {
        ok: true,
        already_booked: Boolean(result.already_booked),
        booking: result.booking,
        location_pin_will_be_sent: (s.latitude != null && s.longitude != null) || Boolean(s.institute_address),
      };
    }
    case 'send_location': {
      const s = coachingSettings();
      if ((s.latitude == null || s.longitude == null) && !s.institute_address) {
        return { ok: false, error: 'The institute has not set its location. Say the team will share directions.' };
      }
      state.wantsLocation = true;
      return { ok: true, will_send: 'map pin after your reply', landmark_directions: s.landmark_directions || null };
    }
    case 'handoff_to_staff':
      state.handedOff = true;
      data.handoff(conv, args.reason);
      return { ok: true, flagged_for_staff: true };
    default:
      return { ok: false, error: `There is no tool called ${name}.` };
  }
}

/** Sends one message into the chat and adds it to the transcript, sent or
 * failed. Resolves to whether it went. */
async function deliver(slug, conv, { author, text = null, location = null, body = text, kind = location ? 'location' : 'text', typingMs = 0, meta = null }) {
  try {
    const { id } = await sendChatMessage({ slug, jid: conv.jid, text, location, typingMs });
    record(conv, { direction: 'out', author, kind, body, waId: id, status: 'sent', meta });
    return true;
  } catch (err) {
    record(conv, { direction: 'out', author, kind, body, status: 'failed', error: err.message, meta });
    return false;
  }
}

/** When the model fails, the parent still hears back — once in a while, not
 * on every message — and the desk gets the chat. */
async function holdingReply(slug, conv, err) {
  const recent = get(
    "SELECT 1 FROM wa_messages WHERE conversation_id = ? AND author = 'ai' AND meta LIKE '%\"holding\":true%' AND created_at >= ?",
    [conv.id, utcTimestamp(-HOLDING_EVERY_MS)],
  );
  data.handoff(conv, `The assistant could not reply (${String(err.message || 'error').slice(0, 120)})`);
  if (!recent) await deliver(slug, conv, { author: 'ai', text: FALLBACK_REPLY, typingMs: 1000, meta: { holding: true } });
}

async function sendLocation(slug, conv, settings, instituteName) {
  const recent = get("SELECT 1 FROM wa_messages WHERE conversation_id = ? AND kind = 'location' AND status = 'sent' AND created_at >= ?", [
    conv.id,
    utcTimestamp(-LOCATION_EVERY_MS),
  ]);
  if (recent) return;
  const address = settings.institute_address || null;
  const directions = settings.landmark_directions || null;
  const lines = [`📍 *${instituteName}*`, address, directions ? `Landmark: ${directions}` : null, settings.maps_url || null].filter(Boolean);
  if (settings.latitude != null && settings.longitude != null) {
    const sent = await deliver(slug, conv, {
      author: 'ai',
      location: { latitude: settings.latitude, longitude: settings.longitude, name: instituteName, address: address || undefined },
      body: lines.join('\n'),
    });
    // The pin shows the address; the landmark directions need words.
    if (sent && directions) await deliver(slug, conv, { author: 'ai', text: `🧭 How to reach: ${directions}` });
  } else if (address) {
    await deliver(slug, conv, { author: 'ai', text: lines.join('\n') });
  }
}

/** "🔥 HOT LEAD" to the director's own phone, and into the delivery log. */
async function alertDirector(slug, conv, booked, settings) {
  const phone = String(settings.director_phone || '').trim();
  if (!settings.hot_lead_alerts || !phone) return;
  if (data.phoneKey(phone) === data.phoneKey(conv.phone)) return;
  const lead = get(
    'SELECT i.*, c.name AS course_name FROM student_inquiries i LEFT JOIN academic_courses c ON c.id = i.course_id WHERE i.id = ?',
    [booked.inquiry_id],
  );
  if (!lead) return;
  const b = booked.booking;
  const message = [
    `🔥 *HOT LEAD:* Demo booked for *${lead.student_name}* on ${b.day}, ${b.time}${b.teacher ? ` with ${b.teacher}` : ''}.`,
    [lead.course_name, lead.target_class].filter(Boolean).join(' · ') || null,
    `Parent: ${[lead.guardian_name || conv.contact_name, conv.phone ? `+${conv.phone}` : lead.phone].filter(Boolean).join(' · ')}`,
    `Demo seats left: ${b.seats_left}`,
    '— booked by your WhatsApp admissions assistant',
  ]
    .filter(Boolean)
    .join('\n');
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
  note(conv, status === 'sent' ? 'Hot-lead alert sent to the director.' : `The hot-lead alert to the director failed: ${error}`);
}

/* ── The desk ────────────────────────────────────────────────────────── */

const CONVERSATION_FIELDS = 'id, jid, phone, contact_name, inquiry_id, bot_paused_until, paused_by, needs_staff, handoff_reason, last_message_at, created_at';

/** The chat behind an inquiry: linked to it, else one under the same number. */
function conversationForInquiry(inquiry) {
  const linked = get(`SELECT * FROM wa_conversations WHERE inquiry_id = ? ORDER BY last_message_at DESC LIMIT 1`, [inquiry.id]);
  if (linked) return linked;
  const key = data.phoneKey(inquiry.phone);
  if (!key || key.length < 10) return null;
  const match = all('SELECT * FROM wa_conversations WHERE phone LIKE ? ORDER BY last_message_at DESC LIMIT 10', [`%${key.slice(-4)}`]).find(
    (c) => data.phoneKey(c.phone) === key,
  );
  if (match && !match.inquiry_id) run('UPDATE wa_conversations SET inquiry_id = ? WHERE id = ?', [inquiry.id, match.id]);
  return match ?? null;
}

const loadInquiry = (inquiryId) => {
  const inquiry = get('SELECT * FROM student_inquiries WHERE id = ?', [inquiryId]);
  if (!inquiry) throw notFound('Inquiry not found');
  return inquiry;
};

const conversationView = (conv) =>
  conv
    ? {
        ...get(`SELECT ${CONVERSATION_FIELDS} FROM wa_conversations WHERE id = ?`, [conv.id]),
        paused: isPaused(get('SELECT bot_paused_until FROM wa_conversations WHERE id = ?', [conv.id])),
      }
    : null;

/** The inquiry's WhatsApp chat for the desk's transcript drawer. `after`
 * returns only newer messages, for the drawer's live refresh. */
export function inquiryTranscript(inquiryId, { after = 0 } = {}) {
  const inquiry = loadInquiry(inquiryId);
  const conv = conversationForInquiry(inquiry);
  const settings = coachingSettings();
  const messages = conv
    ? all(
        `SELECT id, direction, author, kind, body, status, error, meta, created_at FROM wa_messages
         WHERE conversation_id = ? AND id > ? ORDER BY id DESC LIMIT 300`,
        [conv.id, after],
      )
        .reverse()
        .map((m) => ({ ...m, meta: m.meta ? JSON.parse(m.meta) : null }))
    : [];
  return {
    conversation: conversationView(conv),
    messages,
    receptionist_on: Boolean(settings.ai_receptionist),
    ai_configured: coachConfigured(),
    whatsapp_connected: whatsappReady(),
    pause_minutes: settings.ai_pause_minutes,
  };
}

/**
 * A staff member's reply from the desk, sent from the institute's number.
 * Starts the chat if there is none yet, and pauses the assistant in it the
 * same as a reply typed on the phone would.
 */
export async function staffReply(inquiryId, { text, userName = null }) {
  const body = String(text ?? '').trim();
  if (!body) throw badRequest('Type a message first', { text: 'required' });
  if (body.length > 2000) throw badRequest('Keep a WhatsApp message under 2000 characters', { text: 'too long' });
  const inquiry = loadInquiry(inquiryId);
  let conv = conversationForInquiry(inquiry);
  if (!conv) {
    const jid = formatPhoneNumber(inquiry.phone);
    if (!jid) throw badRequest(`"${inquiry.phone}" is not a WhatsApp number`, { phone: 'invalid' });
    conv = conversationFor({ jid, phone: jid.split('@')[0], pushName: null });
    run('UPDATE wa_conversations SET inquiry_id = ? WHERE id = ?', [inquiry.id, conv.id]);
  }
  const { slug } = tenantStorage.getStore() ?? {};
  // Sent first: a failed send must not leave the assistant paused for nothing.
  const { id } = await sendChatMessage({ slug, jid: conv.jid, text: body });
  record(conv, { direction: 'out', author: 'staff', body, waId: id, status: 'sent', meta: userName ? { by: userName } : null });
  takeOver(conv, coachingSettings(), slug, 'desk');
  return inquiryTranscript(inquiryId);
}

/** Pauses the assistant in this chat until turned back on, or resumes it. */
export function setAssistantPaused(inquiryId, paused) {
  const conv = conversationForInquiry(loadInquiry(inquiryId));
  if (!conv) throw notFound('There is no WhatsApp chat with this inquiry yet');
  if (paused) {
    pause(conv, null, 'desk');
    note(conv, 'The assistant was paused in this chat from the desk.');
  } else {
    run("UPDATE wa_conversations SET bot_paused_until = NULL, paused_by = NULL, needs_staff = 0, updated_at = datetime('now') WHERE id = ?", [conv.id]);
    note(conv, 'The assistant was switched back on in this chat.');
  }
  return inquiryTranscript(inquiryId);
}

/** Hooks the assistant onto every gym's WhatsApp socket. Idempotent. */
export function startReceptionist() {
  onInboundMessage(receiveWhatsAppMessage);
}
