import fs from 'node:fs';
import { coachConfigured } from './aiCoach.js';
import { gymNowTime } from './clock.js';
import { config } from './config.js';
import { get, run, tenantStorage } from './db.js';
import { badRequest, notFound } from './errors.js';
import { receptionistEntitled } from './coaching/receptionistBilling.js';
import * as data from './gymReceptionistData.js';
import { FALLBACK_REPLY, promisesFollowUp, runGymReceptionist } from './gymReceptionistAi.js';
import { findTenantBySlug, tenantDbPath } from './tenants.js';
import { conversationForLead, deskSettings, loadLead, sendTrialPass } from './trialPasses.js';
import { today } from './validate.js';
import { moduleEnabled } from './verticals.js';
import {
  conversationFor,
  conversationView,
  dateLabel,
  deliver,
  enqueue,
  hasPlace,
  historyBefore,
  holdingReply,
  isPaused,
  note,
  phoneKey,
  record,
  sendLocation,
  sendOwnerAlert,
  setPaused,
  staffSend,
  takeOver,
  timeLabel,
  transcriptMessages,
  withinCeilings,
  withinOfficeHours,
} from './waChat.js';
import { markChatRead, whatsappReady } from './whatsapp.js';

/**
 * GymBook's 24/7 WhatsApp front-desk assistant.
 *
 * Someone writes to the gym's linked WhatsApp number at 11 PM asking what a
 * month costs; this decides whether the assistant answers, gathers a burst
 * of messages into one question, has gymReceptionistAi.js answer it from the
 * gym's live plans, timetable and hours, and sends the reply — then, when a
 * free trial was booked, the QR pass, the location pin and the owner's
 * hot-lead alert. The chat mechanics (transcript, staff takeover, gathering,
 * ceilings, sending) are shared with CoachBook's assistant in src/waChat.js;
 * the trial rules are src/trialPasses.js's.
 *
 * Who decides, in order:
 * - Tenant: only the gym whose socket heard the message, resolved from the
 *   registry by slug, and only a live GymBook account.
 * - The owner: ai_receptionist off means nothing is stored or answered, and
 *   the AI receptionist plan (shared with CoachBook, receptionistBilling.js)
 *   must be paid for or on its free trial.
 * - Staff: a reply typed on the linked phone or sent from the desk pauses the
 *   assistant in that chat for ai_pause_minutes.
 * - Ceilings: replies per chat per hour and per gym per day.
 */

/* ── Tenant ──────────────────────────────────────────────────────────── */

/** The tenant context for a socket's gym, or null when it is not a live
 * GymBook account (an institute, a library, a suspended trial). */
function tenantFor(slug) {
  if (!slug || !fs.existsSync(config.platformDbFile)) return null;
  const tenant = findTenantBySlug(slug);
  if (!tenant || !['trial', 'active'].includes(tenant.status)) return null;
  if ((tenant.business_type || 'gym') !== 'gym') return null;
  return {
    store: { slug: tenant.slug, dbFile: tenantDbPath(tenant.slug), timezone: tenant.timezone || undefined, businessType: 'gym' },
    gymName: tenant.gym_name || tenant.display_name || 'our gym',
    currency: tenant.currency || 'INR',
  };
}

/** The gym as a place to send: the map pin, address and directions. */
const placeOf = (settings, gymName) => ({
  name: gymName,
  address: settings.gym_address,
  directions: settings.landmark_directions,
  mapsUrl: settings.maps_url,
  latitude: settings.latitude,
  longitude: settings.longitude,
});

/* ── Incoming ────────────────────────────────────────────────────────── */

/**
 * Every message the gym's number sends or receives in a one-to-one chat,
 * from src/whatsapp.js (through src/receptionists.js). Resolves to what was
 * done with it.
 */
export async function receiveGymWhatsAppMessage(event) {
  const tenant = tenantFor(event?.slug);
  if (!tenant) return { handled: false, reason: 'not_gym' };
  return tenantStorage.run(tenant.store, () => accept(event, tenant));
}

function accept(event, tenant) {
  if (!moduleEnabled('trials')) return { handled: false, reason: 'module_off' };
  const settings = deskSettings();
  if (!settings.ai_receptionist) return { handled: false, reason: 'off' };
  if (!receptionistEntitled(tenant.store.slug, today())) return { handled: false, reason: 'not_subscribed' };
  // The owner testing from their own phone, or a trainer: not a lead.
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
  const { gymName, currency } = buffer.tenant;
  const conv = get('SELECT * FROM wa_conversations WHERE id = ?', [buffer.conversationId]);
  const settings = deskSettings();
  if (!conv || !settings.ai_receptionist || isPaused(conv) || !receptionistEntitled(slug, today())) return;
  if (!withinCeilings(conv, { handoff: data.handoff, org: 'gym' })) return;

  markChatRead(slug, messages.map((m) => m.key));

  const lead = data.leadForConversation(conv);
  if (lead && conv.lead_id !== lead.id) {
    run('UPDATE wa_conversations SET lead_id = ? WHERE id = ?', [lead.id, conv.id]);
    conv.lead_id = lead.id;
  }
  const history = historyBefore(conv, Math.min(...messages.map((m) => m.rowId)));
  const now = today();
  const payload = {
    now: `${dateLabel(now)} ${new Date(`${now}T00:00:00Z`).getUTCFullYear()}, ${timeLabel(gymNowTime())}`,
    today: now,
    gym: data.gymProfile({ gymName, currency }),
    plans: data.planCatalog(),
    gym_sessions: data.gymSessions(),
    classes: data.classTimetable(),
    trainers: data.trainerList(),
    free_trial: data.trialOffer(),
    LEAD: data.leadSummary(lead),
    contact: { whatsapp_name: conv.contact_name || null, has_mobile_number: Boolean(conv.phone), KNOWN_MEMBER: data.knownMember(conv.phone) },
  };

  const state = { booked: null, wantsLocation: false, joiningTopic: false, handedOff: false };
  let result;
  try {
    result = await runGymReceptionist({
      gymName,
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
    data.handoff(conv, `The assistant held back a reply quoting an amount not in the gym's data (${result.ungrounded.join(', ')})`);
  } else if (!state.handedOff && promisesFollowUp(result.reply)) {
    data.handoff(conv, `Told them the team will follow up on: "${messages.map((m) => m.text).join(' / ').slice(0, 160)}"`);
  }

  await deliver(slug, conv, {
    author: 'ai',
    text: result.reply,
    typingMs: Math.min(1500, 500 + result.reply.length * 4),
    meta: {
      tools: result.toolCalls.map((t) => ({ name: t.name, ok: t.result?.ok !== false })),
      guarded: result.guarded || undefined,
      tokens: result.usage.input_tokens + result.usage.output_tokens,
    },
  });

  // Someone who asked about trials is a lead even if they never said a
  // name — the desk sees it rather than it living only in a chat.
  if (!conv.lead_id && state.joiningTopic) {
    data.upsertLead(conv, { note: `Asked: ${messages.map((m) => m.text).join(' / ').slice(0, 300)}` });
  }
  if (state.booked && !state.booked.already_issued) {
    await sendTrialPass(state.booked.pass_id, { gymName, author: 'ai' });
    await sendLocation(slug, conv, placeOf(settings, gymName));
    await alertOwner(slug, conv, state.booked, settings);
  } else if (state.wantsLocation) {
    await sendLocation(slug, conv, placeOf(settings, gymName));
  }
}

/** Runs one tool call against this chat's lead. */
function runTool(conv, state, name, args) {
  switch (name) {
    case 'get_trial_dates':
      state.joiningTopic = true;
      return data.trialDates(conv);
    case 'save_lead':
      data.upsertLead(conv, args);
      return { ok: true, saved: true };
    case 'book_trial': {
      const result = data.bookTrial(conv, args);
      if (!result.ok) return result;
      state.booked = result;
      return {
        ok: true,
        already_issued: result.already_issued,
        trial: result.trial,
        qr_pass_will_be_sent: !result.already_issued,
        location_pin_will_be_sent: !result.already_issued && hasPlace(placeOf(deskSettings(), '')),
      };
    }
    case 'send_location': {
      const s = deskSettings();
      if (!hasPlace(placeOf(s, ''))) return { ok: false, error: 'The gym has not set its location. Say the team will share directions.' };
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

/** "🔥 HOT LEAD" to the owner's own phone, and into the delivery log. */
async function alertOwner(slug, conv, booked, settings) {
  const phone = String(settings.owner_phone || '').trim();
  if (!settings.hot_lead_alerts || !phone) return;
  if (phoneKey(phone) === phoneKey(conv.phone)) return;
  const lead = get('SELECT l.*, p.name AS plan_name FROM gym_leads l LEFT JOIN plans p ON p.id = l.plan_id WHERE l.id = ?', [booked.lead_id]);
  if (!lead) return;
  const t = booked.trial;
  const message = [
    `🔥 *HOT LEAD:* Free trial booked for *${lead.name}* — ${t.valid}${t.arrival ? `, coming around ${t.arrival}` : ''}.`,
    [lead.goal ? `Goal: ${lead.goal}` : null, lead.preferred_time ? `Prefers ${lead.preferred_time}` : null, lead.plan_name ? `Likes ${lead.plan_name}` : null]
      .filter(Boolean)
      .join(' · ') || null,
    `Phone: ${conv.phone ? `+${conv.phone}` : lead.phone}`,
    '— booked by your WhatsApp front-desk assistant',
  ]
    .filter(Boolean)
    .join('\n');
  await sendOwnerAlert(slug, conv, { phone, message, who: 'owner' });
}

/* ── The desk ────────────────────────────────────────────────────────── */

/** The lead's WhatsApp chat for the desk's transcript drawer. `after`
 * returns only newer messages, for the drawer's live refresh. */
export function leadTranscript(leadId, { after = 0 } = {}) {
  const conv = conversationForLead(loadLead(leadId));
  const settings = deskSettings();
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
 * A staff member's reply from the desk, sent from the gym's number. Starts
 * the chat if there is none yet, and pauses the assistant in it the same as
 * a reply typed on the phone would.
 */
export async function staffReplyToLead(leadId, { text, userName = null }) {
  const body = String(text ?? '').trim();
  if (!body) throw badRequest('Type a message first', { text: 'required' });
  if (body.length > 2000) throw badRequest('Keep a WhatsApp message under 2000 characters', { text: 'too long' });
  const lead = loadLead(leadId);
  const conv = conversationForLead(lead, { create: true });
  if (!conv) throw badRequest(`"${lead.phone}" is not a WhatsApp number`, { phone: 'invalid' });
  await staffSend(conv, { text: body, userName, pauseMinutes: deskSettings().ai_pause_minutes });
  return leadTranscript(leadId);
}

/** Pauses the assistant in this lead's chat until turned back on, or resumes it. */
export function setLeadAssistantPaused(leadId, paused) {
  const conv = conversationForLead(loadLead(leadId));
  if (!conv) throw notFound('There is no WhatsApp chat with this lead yet');
  setPaused(conv, paused);
  return leadTranscript(leadId);
}
