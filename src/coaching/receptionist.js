import fs from 'node:fs';
import { coachConfigured } from '../aiCoach.js';
import { gymNowTime } from '../clock.js';
import { config } from '../config.js';
import { all, get, run, tenantStorage } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { alertTrialBooked } from '../staffAlerts.js';
import { findTenantBySlug, tenantDbPath } from '../tenants.js';
import { today } from '../validate.js';
import { moduleEnabled } from '../verticals.js';
import {
  conversationFor,
  conversationView,
  deliver,
  enqueue,
  hasPlace,
  historyBefore,
  holdingReply,
  isPaused,
  note,
  record,
  sendLocation,
  sendOwnerAlert,
  setPaused,
  staffSend,
  takeOver,
  transcriptMessages,
  withinCeilings,
  withinOfficeHours,
} from '../waChat.js';
import { formatPhoneNumber, markChatRead, whatsappReady } from '../whatsapp.js';
import { coachingSettings } from './notify.js';
import * as data from './receptionistData.js';
import { FALLBACK_REPLY, promisesFollowUp, runReceptionist } from './receptionistAi.js';
import { receptionistEntitled } from './receptionistBilling.js';

export { receptionistIdle } from '../waChat.js';

/**
 * CoachBook's 24/7 WhatsApp admissions assistant.
 *
 * A parent writes to the institute's linked WhatsApp number (src/whatsapp.js
 * hears it on the gym's own socket); this decides whether the assistant
 * answers, gathers a burst of messages into one question, has
 * receptionistAi.js answer it from the institute's live data, and sends the
 * reply — then, when a demo was booked, the location pin and the director's
 * hot-lead alert. Every message either way is kept as the chat's transcript
 * (wa_messages), which the admissions desk reads beside the lead. The chat
 * mechanics — transcript, takeover, gathering, ceilings, sending — are
 * shared with GymBook's assistant in src/waChat.js.
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

/** The institute as a place to send: the map pin, address and directions. */
const placeOf = (settings, instituteName) => ({
  name: instituteName,
  address: settings.institute_address,
  directions: settings.landmark_directions,
  mapsUrl: settings.maps_url,
  latitude: settings.latitude,
  longitude: settings.longitude,
});

/* ── Incoming ────────────────────────────────────────────────────────── */

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
  // Paid for (or on its free trial) — see receptionistBilling.js. A lapsed
  // plan stores nothing, the same as switched off.
  if (!receptionistEntitled(tenant.store.slug, today())) return { handled: false, reason: 'not_subscribed' };
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
    takeOver(conv, { pauseMinutes: settings.ai_pause_minutes, slug: tenant.store.slug, by: 'staff_reply' });
    return { handled: true, reason: 'staff_reply' };
  }
  if (isPaused(conv)) return { handled: true, reason: 'paused' };
  if (settings.ai_reply_mode === 'after_hours' && withinOfficeHours(settings)) return { handled: true, reason: 'office_hours' };
  if (!coachConfigured()) return { handled: true, reason: 'ai_not_configured' };

  enqueue(tenant, conv, { text, key: event.key ?? null, rowId }, respond);
  return { handled: true, reason: 'queued' };
}

/* ── Answering ───────────────────────────────────────────────────────── */

async function respond(buffer, messages) {
  const { slug } = buffer.tenant.store;
  const instituteName = buffer.tenant.instituteName;
  const conv = get('SELECT * FROM wa_conversations WHERE id = ?', [buffer.conversationId]);
  const settings = coachingSettings();
  if (!conv || !settings.ai_receptionist || isPaused(conv) || !receptionistEntitled(slug, today())) return;
  if (!withinCeilings(conv, { handoff: data.handoff, org: 'institute' })) return;

  markChatRead(slug, messages.map((m) => m.key));

  const inquiry = data.inquiryForConversation(conv);
  if (inquiry && conv.inquiry_id !== inquiry.id) {
    run('UPDATE wa_conversations SET inquiry_id = ? WHERE id = ?', [inquiry.id, conv.id]);
    conv.inquiry_id = inquiry.id;
  }
  const firstNew = Math.min(...messages.map((m) => m.rowId));
  const history = historyBefore(conv, firstNew);
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
    await holdingReply(slug, conv, err, { handoff: data.handoff, text: FALLBACK_REPLY });
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
    const b = state.booked.booking;
    const student = get('SELECT student_name FROM student_inquiries WHERE id = ?', [state.booked.inquiry_id])?.student_name;
    alertTrialBooked({
      id: state.booked.inquiry_id,
      name: student || 'a new student',
      when: `${b.day}, ${b.time}${b.teacher ? ` with ${b.teacher}` : ''}`,
      coaching: true,
    });
    await sendLocation(slug, conv, placeOf(settings, instituteName));
    await alertDirector(slug, conv, state.booked, settings);
  } else if (state.wantsLocation) {
    await sendLocation(slug, conv, placeOf(settings, instituteName));
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
      return {
        ok: true,
        already_booked: Boolean(result.already_booked),
        booking: result.booking,
        location_pin_will_be_sent: hasPlace(placeOf(coachingSettings(), '')),
      };
    }
    case 'send_location': {
      const s = coachingSettings();
      if (!hasPlace(placeOf(s, ''))) {
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
  await sendOwnerAlert(slug, conv, { phone, message, who: 'director' });
}

/* ── The desk ────────────────────────────────────────────────────────── */

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

/** The inquiry's WhatsApp chat for the desk's transcript drawer. `after`
 * returns only newer messages, for the drawer's live refresh. */
export function inquiryTranscript(inquiryId, { after = 0 } = {}) {
  const inquiry = loadInquiry(inquiryId);
  const conv = conversationForInquiry(inquiry);
  const settings = coachingSettings();
  return {
    conversation: conversationView(conv),
    messages: transcriptMessages(conv, { after }),
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
  await staffSend(conv, { text: body, userName, pauseMinutes: coachingSettings().ai_pause_minutes });
  return inquiryTranscript(inquiryId);
}

/** Pauses the assistant in this chat until turned back on, or resumes it. */
export function setAssistantPaused(inquiryId, paused) {
  const conv = conversationForInquiry(loadInquiry(inquiryId));
  if (!conv) throw notFound('There is no WhatsApp chat with this inquiry yet');
  setPaused(conv, paused);
  return inquiryTranscript(inquiryId);
}
