import { all, get, run, tx } from './db.js';
import { today } from './validate.js';
import { dateLabel, daysLabel, flagForStaff, phoneKey, timeLabel } from './waChat.js';
import {
  appendNote,
  cleanText,
  deskSettings,
  issueTrialPass,
  latestPassFor,
  memberWithPhone,
  openLeadForPhone,
  openTrialDates,
  passView,
  trialEligibility,
} from './trialPasses.js';

/**
 * What GymBook's WhatsApp front-desk assistant knows and may change, read
 * live from the gym's own tables on every reply (see gymReceptionist.js).
 *
 * Everything the model may say about the gym comes out of here — plans and
 * prices, gym sessions, the class timetable, trainers, opening hours, the
 * address and the owner's own notes — so a price the manager edits at 8 PM
 * is the price a visitor hears at 9 PM. The mutations (upsertLead,
 * bookTrial, handoff) write the same gym_leads rows the desk works from,
 * and a booking goes through trialPasses.js's rules like any other.
 */

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "1 month", "3 months", "1 year", "15 days" from a plan's duration. */
export function durationLabel(days) {
  if (days % 365 === 0) return `${days / 365} year${days === 365 ? '' : 's'}`;
  if (days % 30 === 0) return `${days / 30} month${days === 30 ? '' : 's'}`;
  if (days % 7 === 0 && days <= 28) return `${days / 7} week${days === 7 ? '' : 's'}`;
  return `${days} day${days === 1 ? '' : 's'}`;
}

/* ── Reads ───────────────────────────────────────────────────────────── */

/** The gym itself: name, contact, hours, address and the owner's notes. */
export function gymProfile({ gymName, currency }) {
  const s = deskSettings();
  return {
    name: gymName,
    currency,
    phone: s.gym_phone || null,
    opening_hours: s.opening_hours || null,
    address: s.gym_address || null,
    landmark_directions: s.landmark_directions || null,
    has_map_pin: s.latitude != null && s.longitude != null,
    desk_hours: s.office_open && s.office_close ? `${daysLabel(s.office_days)} ${timeLabel(s.office_open)} – ${timeLabel(s.office_close)}` : null,
    owner_notes: s.ai_persona_notes || null,
  };
}

/** Every plan on sale, cheapest first: price, length and any session limit. */
export const planCatalog = () =>
  all('SELECT id, name, description, price, duration_days, sessions FROM plans WHERE active = 1 ORDER BY price, duration_days').map((p) => ({
    plan_id: p.id,
    name: p.name,
    price: p.price,
    duration: durationLabel(p.duration_days),
    sessions: p.sessions ?? null,
    description: p.description ? p.description.slice(0, 200) : null,
  }));

/** The gym's timed sessions ("Morning 5:30 – 10:00 AM"), when it runs them. */
export const gymSessions = () =>
  all('SELECT name, start_time, end_time FROM sessions WHERE active = 1 ORDER BY start_time').map((s) => ({
    name: s.name,
    timing: `${timeLabel(s.start_time)} – ${timeLabel(s.end_time)}`,
  }));

/** The weekly class timetable, compact: it rides on every reply. */
export const classTimetable = () =>
  all(
    `SELECT c.name, c.weekday, c.start_time, c.duration_min, c.room, u.name AS trainer
     FROM classes c LEFT JOIN users u ON u.id = c.trainer_id
     WHERE c.active = 1 ORDER BY c.weekday, c.start_time LIMIT 60`,
  ).map((c) => ({
    class: c.name,
    day: DAY_NAMES[c.weekday].slice(0, 3),
    time: timeLabel(c.start_time),
    duration_min: c.duration_min,
    trainer: c.trainer || null,
  }));

/** The trainers, with what the owner entered about them. */
export const trainerList = () =>
  all("SELECT name, qualification, specialization FROM users WHERE active = 1 AND role = 'trainer' ORDER BY name LIMIT 20").map((u) => ({
    name: u.name,
    qualification: u.qualification || null,
    specialization: u.specialization || null,
  }));

/** What the free trial is, when the owner lets the assistant offer it. */
export function trialOffer() {
  const s = deskSettings();
  if (!s.trial_enabled) return { offered: false };
  return {
    offered: true,
    days: s.trial_days,
    visits: Math.min(s.trial_visits, s.trial_days),
    bookable_up_to_days_ahead: s.trial_booking_days,
    how_it_works: 'A free QR pass is sent here on WhatsApp; show it at the front desk.',
  };
}

/** Whether this number belongs to a current member — the assistant then
 * knows not to sell them a trial. */
export function knownMember(phone) {
  const member = memberWithPhone(phone);
  return member ? { first_name: member.first_name, status: member.status } : null;
}

/** Whether a number belongs to the gym's own people (the owner, staff):
 * their chats with the gym number are not leads. */
export function isInsiderPhone(phone) {
  const key = phoneKey(phone);
  if (!key || key.length < 10) return false;
  if (phoneKey(deskSettings().owner_phone) === key) return true;
  return all('SELECT phone FROM users WHERE active = 1 AND phone IS NOT NULL AND phone LIKE ?', [`%${key.slice(-4)}`]).some((u) => phoneKey(u.phone) === key);
}

/* ── The lead ────────────────────────────────────────────────────────── */

/** The lead a conversation is about: the one it is linked to (unless they
 * have since joined), else the open one under the same number. */
export function leadForConversation(conversation) {
  if (conversation.lead_id) {
    const linked = get('SELECT * FROM gym_leads WHERE id = ?', [conversation.lead_id]);
    if (linked && linked.status !== 'converted') return linked;
  }
  return openLeadForPhone(conversation.phone);
}

/** What the desk already knows about this person, for the model. */
export function leadSummary(lead) {
  if (!lead) return null;
  const plan = lead.plan_id ? get('SELECT name FROM plans WHERE id = ?', [lead.plan_id])?.name : null;
  const pass = latestPassFor(lead.id);
  const view = pass ? passView(pass) : null;
  return {
    name: lead.name || null,
    goal: lead.goal || null,
    preferred_time: lead.preferred_time || null,
    plan_interest: plan,
    stage: lead.status,
    trial_pass: view
      ? {
          valid: `${dateLabel(view.valid_from)} – ${dateLabel(view.valid_until)}`,
          visits_used: view.visits_used,
          visits_allowed: view.visits_allowed,
          state: view.state,
        }
      : null,
  };
}

const validPlanId = (id) => {
  const n = Number(id);
  return Number.isInteger(n) && n > 0 && get('SELECT id FROM plans WHERE id = ?', [n]) ? n : null;
};

/** The number a lead is filed under: the WhatsApp number when WhatsApp told
 * us it, else one the person typed (a privacy @lid chat hides it). */
function leadPhone(conversation, typed) {
  if (conversation.phone) return `+${conversation.phone}`;
  const digits = String(typed ?? '').replace(/\D/g, '');
  return digits.length >= 10 ? digits : null;
}

/**
 * Creates or updates the conversation's lead from what the person has said,
 * and links the two. `changes` only ever fills in or refines; the stage
 * moves only through a booking or the desk.
 */
export const upsertLead = (conversation, changes = {}) => tx(() => writeLead(conversation, changes));

function writeLead(conversation, changes) {
  const fields = {
    name: cleanText(changes.name, 100),
    goal: cleanText(changes.goal, 120),
    preferred_time: cleanText(changes.preferred_time, 60),
    plan_id: changes.plan_id ? validPlanId(changes.plan_id) : null,
  };
  const existing = leadForConversation(conversation);
  let id;
  if (existing) {
    run(
      `UPDATE gym_leads SET
         name = COALESCE(?, name), goal = COALESCE(?, goal), preferred_time = COALESCE(?, preferred_time),
         plan_id = COALESCE(?, plan_id),
         phone = CASE WHEN phone LIKE 'WhatsApp%' AND ? IS NOT NULL THEN ? ELSE phone END,
         status = CASE WHEN status = 'lost' THEN 'new' ELSE status END,
         follow_up_on = COALESCE(?, follow_up_on),
         notes = ?, updated_at = datetime('now')
       WHERE id = ?`,
      [
        fields.name,
        fields.goal,
        fields.preferred_time,
        fields.plan_id,
        leadPhone(conversation, changes.mobile),
        leadPhone(conversation, changes.mobile),
        changes.follow_up_on ?? null,
        appendNote(existing.notes, changes.note),
        existing.id,
      ],
    );
    id = existing.id;
  } else {
    const info = run(
      `INSERT INTO gym_leads (name, phone, goal, preferred_time, plan_id, status, source, ai_captured, follow_up_on, notes)
       VALUES (?, ?, ?, ?, ?, 'new', 'whatsapp', 1, ?, ?)`,
      [
        fields.name || cleanText(conversation.contact_name, 100),
        leadPhone(conversation, changes.mobile) ?? `WhatsApp ${String(conversation.jid).split('@')[0]}`.slice(0, 30),
        fields.goal,
        fields.preferred_time,
        fields.plan_id,
        changes.follow_up_on ?? null,
        appendNote(null, changes.note),
      ],
    );
    id = Number(info.lastInsertRowid);
  }
  if (conversation.lead_id !== id) {
    run("UPDATE wa_conversations SET lead_id = ?, updated_at = datetime('now') WHERE id = ?", [id, conversation.id]);
    conversation.lead_id = id;
  }
  return get('SELECT * FROM gym_leads WHERE id = ?', [id]);
}

/**
 * The trial days on offer to this chat's number, or why it cannot have a
 * trial. Checked against the number before any date, so the assistant
 * never offers a member or a repeat visitor a pass it cannot book.
 */
export function trialDates(conversation) {
  const s = deskSettings();
  if (!s.trial_enabled) return { ok: false, error: 'The gym is not offering free trials on WhatsApp right now. Invite them to visit during opening hours.' };
  const lead = leadForConversation(conversation);
  const pass = lead ? latestPassFor(lead.id) : null;
  if (pass && ['upcoming', 'active'].includes(passView(pass).state)) {
    const view = passView(pass);
    return { ok: true, already_has_pass: { valid: `${dateLabel(view.valid_from)} – ${dateLabel(view.valid_until)}`, visits_left: view.visits_left } };
  }
  const phone = lead?.phone && !lead.phone.startsWith('WhatsApp') ? lead.phone : conversation.phone;
  if (!phone) return { ok: false, error: 'Their mobile number is not known. Ask for it, then call save_lead with mobile before booking.' };
  const eligible = trialEligibility(phone);
  if (!eligible.ok && ['member', 'cooldown', 'no_phone'].includes(eligible.code)) return { ok: false, eligible: false, reason: eligible.reason };
  const dates = openTrialDates();
  if (!dates.length) return { ok: true, dates: [], note: 'Every trial day is full. Offer to have the team call back to arrange one.' };
  return { ok: true, trial_days: s.trial_days, visits: Math.min(s.trial_visits, s.trial_days), dates: dates.slice(0, 8) };
}

/**
 * Books the free trial: fills in the lead from the chat, then issues the
 * pass through trialPasses.js's rules. Booking again while a pass is still
 * usable returns that pass (`already_issued`) — no second pass, no second
 * alert.
 */
export function bookTrial(conversation, args = {}) {
  const name = cleanText(args.name, 100);
  if (!name || name.length < 2) return { ok: false, error: 'Their name is needed for the pass. Ask for it.' };
  const startOn = String(args.start_date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startOn)) return { ok: false, error: 'start_date must be YYYY-MM-DD, copied from get_trial_dates.' };
  const arrival = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(args.arrival_time || '')) ? args.arrival_time : null;
  if (!deskSettings().trial_enabled) return { ok: false, error: 'The gym is not offering free trials on WhatsApp right now.' };

  const lead = upsertLead(conversation, {
    name,
    goal: args.goal,
    preferred_time: args.preferred_time,
    plan_id: args.plan_id,
    mobile: args.mobile,
    note: args.note,
  });
  const result = issueTrialPass(lead, { startOn, arrivalTime: arrival, issuedBy: 'ai' });
  if (!result.ok) return { ok: false, error: result.reason };
  const pass = result.pass;
  return {
    ok: true,
    already_issued: Boolean(result.already_issued),
    lead_id: lead.id,
    pass_id: pass.id,
    trial: {
      name,
      valid: pass.valid_from === pass.valid_until ? dateLabel(pass.valid_from) : `${dateLabel(pass.valid_from)} – ${dateLabel(pass.valid_until)}`,
      visits: pass.visits_allowed,
      arrival: arrival ? timeLabel(arrival) : null,
    },
  };
}

/** Flags the chat for a person and puts the lead on today's follow-up list. */
export function handoff(conversation, reason) {
  const why = cleanText(reason, 300) || 'Needs a reply from the team';
  return tx(() => {
    flagForStaff(conversation, why);
    const lead = writeLead(conversation, { note: `Needs the team: ${why}`, follow_up_on: today() });
    return { ok: true, lead_id: lead.id };
  });
}
