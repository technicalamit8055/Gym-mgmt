import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { gymNowTime, utcTimestamp } from './clock.js';
import { all, get, run, tenantStorage, tx } from './db.js';
import { badRequest, notFound } from './errors.js';
import { addDays, today } from './validate.js';
import { moduleEnabled } from './verticals.js';
import { conversationFor, dateLabel, deliver, isPaused, phoneKey, timeLabel } from './waChat.js';
import { formatPhoneNumber, renderTemplate, whatsappReady } from './whatsapp.js';

/**
 * GymBook's free trial passes: who may have one, issuing and sending it, the
 * desk checking a trial visitor in, and the follow-ups that turn a trial into
 * a membership.
 *
 * A pass belongs to a lead (gym_leads) — someone who wrote on WhatsApp, walked
 * in or called. The WhatsApp front-desk assistant (src/gymReceptionist.js)
 * books one through issueTrialPass() the same as the desk does, so the rules
 * live here once:
 *
 * - One trial per phone number every trial_cooldown_days, counted by the
 *   number's last ten digits, so "+91 98765-43210" and "9876543210" are the
 *   same person. A revoked pass does not count.
 * - Not for an existing member — their number is checked against the roster.
 * - Starting today or within trial_booking_days, and at most trial_daily_cap
 *   passes starting on one day when the owner sets a cap.
 * - At most trial_visits visits inside trial_days days, one per calendar day
 *   (trial_visits' UNIQUE (pass_id, visit_date) is what enforces that).
 *
 * The desk may override the member, cooldown, cap and booking-window rules
 * for a pass it issues by hand; the assistant never can.
 *
 * Trial visitors are not members, so a trial visit is a trial_visits row
 * rather than an attendance row: the roster, the dashboard's member counts
 * and the visit reports stay about members.
 */

/* ── Settings ────────────────────────────────────────────────────────── */

/** The gym's receptionist-and-trials settings row. */
export const deskSettings = () => get('SELECT * FROM gym_receptionist_settings WHERE id = 1');

/* ── Pass codes ──────────────────────────────────────────────────────── */

/** Version tag of a trial pass's QR, distinct from a member card's GB1 so
 * the desk can tell the two apart from the scan alone. */
export const TRIAL_QR_PREFIX = 'GBT1';

/** No 0/O, 1/I/L: the code is read off a phone screen and typed. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_RE = /^TR[A-Z2-9]{6}$/;

/** "TR" and six random characters — 887 million codes, so a pass cannot be
 * guessed, and short enough to read out at the desk. */
function newPassCode() {
  for (;;) {
    let code = 'TR';
    for (let i = 0; i < 6; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!get('SELECT 1 FROM trial_passes WHERE code = ?', [code])) return code;
  }
}

export const trialQrPayload = (code) => `${TRIAL_QR_PREFIX}:${code}`;

/** The pass code in whatever the desk received — the QR payload, or the
 * code typed with spaces, a dash or in lower case — or null when it is not
 * one. */
export function trialCodeFromScan(raw) {
  let value = String(raw ?? '').replace(/[\r\n\t]+/g, ' ').trim();
  if (value.slice(0, TRIAL_QR_PREFIX.length + 1).toUpperCase() === `${TRIAL_QR_PREFIX}:`) value = value.slice(TRIAL_QR_PREFIX.length + 1);
  value = value.replace(/[\s-]+/g, '').toUpperCase();
  return CODE_RE.test(value) ? value : null;
}

/** The trial pass a desk scan or typed code names, on an account that has
 * trial passes; undefined otherwise. */
export function trialPassForScan(raw) {
  const code = moduleEnabled('trials') ? trialCodeFromScan(raw) : null;
  return code ? get('SELECT * FROM trial_passes WHERE code = ?', [code]) : undefined;
}

/** Vector QR for the desk's screen and a printout. */
export const trialQrSvg = (code) => QRCode.toString(trialQrPayload(code), { type: 'svg', errorCorrectionLevel: 'M', margin: 1, width: 240 });

/** The PNG sent on WhatsApp — large enough to scan off a phone held up to a
 * desk camera. */
const trialQrPng = (code) => QRCode.toBuffer(trialQrPayload(code), { errorCorrectionLevel: 'M', margin: 2, width: 512 });

/* ── Leads ───────────────────────────────────────────────────────────── */

export const LEAD_STATUSES = ['new', 'trial', 'converted', 'lost'];
export const LEAD_SOURCES = ['whatsapp', 'walk_in', 'phone', 'referral', 'social', 'other'];

const NOTES_MAX = 2000;

export const cleanText = (v, max) => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
};

/** Appends a dated line to a lead's notes, dropping the oldest lines when it
 * would outgrow what the desk's own form accepts. */
export function appendNote(existing, line, { by = 'WhatsApp AI' } = {}) {
  if (!line) return existing ?? null;
  const [y, m, d] = today().split('-');
  let notes = `${existing ? `${existing}\n` : ''}[${by} ${d}/${m}/${y.slice(2)}] ${String(line).trim().slice(0, 400)}`;
  while (notes.length > NOTES_MAX && notes.includes('\n')) notes = notes.slice(notes.indexOf('\n') + 1);
  return notes.slice(-NOTES_MAX);
}

export const loadLead = (leadId) => {
  const lead = get('SELECT * FROM gym_leads WHERE id = ?', [leadId]);
  if (!lead) throw notFound('Lead not found');
  return lead;
};

/** The newest lead under this number that is still in play — a converted
 * one is a member now, and that number writing again is a fresh lead. */
export function openLeadForPhone(phone) {
  const key = phoneKey(phone);
  if (!key || key.length < 10) return null;
  return (
    all("SELECT * FROM gym_leads WHERE status != 'converted' AND phone LIKE ? ORDER BY updated_at DESC, id DESC LIMIT 10", [`%${key.slice(-4)}`]).find(
      (l) => phoneKey(l.phone) === key,
    ) ?? null
  );
}

/** The member whose own phone this is, if any. */
export function memberWithPhone(phone) {
  const key = phoneKey(phone);
  if (!key || key.length < 10) return null;
  return (
    all('SELECT id, code, first_name, last_name, phone, status FROM members WHERE phone LIKE ? LIMIT 20', [`%${key.slice(-4)}`]).find(
      (m) => phoneKey(m.phone) === key,
    ) ?? null
  );
}

/* ── Passes ──────────────────────────────────────────────────────────── */

const visitsUsed = (passId) => get('SELECT COUNT(*) AS n FROM trial_visits WHERE pass_id = ?', [passId]).n;

/**
 * Where a pass stands today: 'upcoming' (starts later), 'active', 'used'
 * (every visit taken), 'expired' (past its last day) or 'revoked'.
 */
export function passState(pass, used = visitsUsed(pass.id), now = today()) {
  if (pass.status === 'revoked') return 'revoked';
  if (used >= pass.visits_allowed) return 'used';
  if (now > pass.valid_until) return 'expired';
  if (now < pass.valid_from) return 'upcoming';
  return 'active';
}

/** A pass as the desk and the assistant see it. */
export function passView(pass) {
  const used = visitsUsed(pass.id);
  const last = get('SELECT visit_date FROM trial_visits WHERE pass_id = ? ORDER BY visit_date DESC LIMIT 1', [pass.id]);
  return {
    id: pass.id,
    lead_id: pass.lead_id,
    code: pass.code,
    payload: trialQrPayload(pass.code),
    valid_from: pass.valid_from,
    valid_until: pass.valid_until,
    visits_allowed: pass.visits_allowed,
    visits_used: used,
    visits_left: Math.max(0, pass.visits_allowed - used),
    arrival_time: pass.arrival_time,
    state: passState(pass, used),
    issued_by: pass.issued_by,
    sent_at: pass.sent_at,
    last_visit_on: last?.visit_date ?? null,
    created_at: pass.created_at,
  };
}

/** The lead's newest pass that was not revoked, or null. */
export const latestPassFor = (leadId) =>
  get("SELECT * FROM trial_passes WHERE lead_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1", [leadId]) ?? null;

/** The lead's pass if it can still be used — upcoming or active. */
function openPassFor(leadId) {
  const pass = latestPassFor(leadId);
  return pass && ['upcoming', 'active'].includes(passState(pass)) ? pass : null;
}

/** Rules the desk may knowingly break for a pass it issues by hand. */
const OVERRIDABLE = new Set(['member', 'cooldown', 'full', 'too_far']);

/**
 * Whether this number may have a free trial starting `startOn` (today when
 * left out). Resolves to { ok: true } or { ok: false, code, reason }, with
 * the reason written to be read out to the person.
 */
export function trialEligibility(phone, { startOn = today() } = {}) {
  const s = deskSettings();
  const key = phoneKey(phone);
  if (!key || key.length < 10) return { ok: false, code: 'no_phone', reason: 'A trial pass needs a 10-digit mobile number.' };

  const member = memberWithPhone(key);
  if (member) return { ok: false, code: 'member', reason: `This number belongs to a member (${member.first_name}, ${member.code}). Trial passes are for new visitors.` };

  const since = addDays(today(), -s.trial_cooldown_days);
  const recent = get(
    "SELECT valid_from FROM trial_passes WHERE phone_key = ? AND status = 'active' AND valid_from > ? ORDER BY valid_from DESC LIMIT 1",
    [key, since],
  );
  if (s.trial_cooldown_days > 0 && recent) {
    return {
      ok: false,
      code: 'cooldown',
      reason: `This number already had a free trial starting ${dateLabel(recent.valid_from)}. It is one trial per number every ${s.trial_cooldown_days} days.`,
      eligible_from: addDays(recent.valid_from, s.trial_cooldown_days),
    };
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(startOn)) || Number.isNaN(Date.parse(startOn))) {
    return { ok: false, code: 'bad_date', reason: 'The start date must be YYYY-MM-DD.' };
  }
  const now = today();
  if (startOn < now) return { ok: false, code: 'past', reason: 'A trial cannot start in the past.' };
  const lastDay = addDays(now, s.trial_booking_days);
  if (startOn > lastDay) return { ok: false, code: 'too_far', reason: `Trials can be booked up to ${s.trial_booking_days} days ahead (until ${dateLabel(lastDay)}).` };
  if (s.trial_daily_cap > 0 && startingOn(startOn) >= s.trial_daily_cap) {
    return { ok: false, code: 'full', reason: `All ${s.trial_daily_cap} trial spots starting ${dateLabel(startOn)} are taken.` };
  }
  return { ok: true };
}

const startingOn = (date) => get("SELECT COUNT(*) AS n FROM trial_passes WHERE valid_from = ? AND status = 'active'", [date]).n;

/** The days a trial may start on, soonest first, with spots left when the
 * owner caps them. Full days are left out. */
export function openTrialDates() {
  const s = deskSettings();
  const now = today();
  const dates = [];
  for (let i = 0; i <= s.trial_booking_days; i++) {
    const date = addDays(now, i);
    const taken = s.trial_daily_cap > 0 ? startingOn(date) : 0;
    if (s.trial_daily_cap > 0 && taken >= s.trial_daily_cap) continue;
    dates.push({ date, day: i === 0 ? `Today (${dateLabel(date)})` : i === 1 ? `Tomorrow (${dateLabel(date)})` : dateLabel(date), spots_left: s.trial_daily_cap > 0 ? s.trial_daily_cap - taken : undefined });
  }
  return dates;
}

/**
 * Issues a free trial pass to a lead. Resolves to { ok: true, pass, created }
 * or the eligibility refusal. A lead who already holds a pass they can still
 * use gets that one back (`already_issued`) — re-confirming on WhatsApp never
 * issues a second pass or sends a second alert.
 *
 * `override` (the desk only) breaks the rules in OVERRIDABLE.
 */
export function issueTrialPass(lead, { startOn = today(), arrivalTime = null, issuedBy = 'staff', userId = null, override = false } = {}) {
  return tx(() => {
    const open = openPassFor(lead.id);
    if (open) return { ok: true, already_issued: true, created: false, pass: passView(open) };
    if (!cleanText(lead.name, 100)) return { ok: false, code: 'no_name', reason: "The visitor's name is needed for the pass." };
    if (lead.status === 'converted') return { ok: false, code: 'member', reason: 'This lead is already a member.' };

    const eligibility = trialEligibility(lead.phone, { startOn });
    if (!eligibility.ok && !(override && issuedBy === 'staff' && OVERRIDABLE.has(eligibility.code))) return eligibility;

    const s = deskSettings();
    const until = addDays(startOn, s.trial_days - 1);
    const info = run(
      `INSERT INTO trial_passes (lead_id, code, phone_key, valid_from, valid_until, visits_allowed, arrival_time, issued_by, issued_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [lead.id, newPassCode(), phoneKey(lead.phone), startOn, until, Math.min(s.trial_visits, s.trial_days), arrivalTime, issuedBy, userId],
    );
    const line = `Free trial pass issued: ${dateLabel(startOn)} – ${dateLabel(until)}${arrivalTime ? `, expected around ${timeLabel(arrivalTime)}` : ''}.${
      eligibility.ok ? '' : ` Issued despite: ${eligibility.reason}`
    }`;
    // Followed up on the trial's last day: the moment to ask them to join.
    run(
      `UPDATE gym_leads SET status = 'trial', follow_up_on = ?, notes = ?, updated_at = datetime('now') WHERE id = ?`,
      [until, appendNote(lead.notes, line, { by: issuedBy === 'ai' ? 'WhatsApp AI' : 'Desk' }), lead.id],
    );
    return { ok: true, created: true, pass: passView(get('SELECT * FROM trial_passes WHERE id = ?', [info.lastInsertRowid])) };
  });
}

/** Cancels a pass: it stops checking in at once, and no longer counts
 * against the number's one trial. */
export function revokeTrialPass(passId) {
  const pass = get('SELECT * FROM trial_passes WHERE id = ?', [passId]);
  if (!pass) throw notFound('Trial pass not found');
  if (pass.status === 'revoked') return passView(pass);
  tx(() => {
    run("UPDATE trial_passes SET status = 'revoked' WHERE id = ?", [passId]);
    const lead = get('SELECT * FROM gym_leads WHERE id = ?', [pass.lead_id]);
    run(
      `UPDATE gym_leads SET status = CASE WHEN status = 'trial' THEN 'new' ELSE status END, notes = ?, updated_at = datetime('now') WHERE id = ?`,
      [appendNote(lead.notes, `Trial pass ${pass.code} cancelled.`, { by: 'Desk' }), lead.id],
    );
  });
  return passView(get('SELECT * FROM trial_passes WHERE id = ?', [passId]));
}

/* ── Sending a pass on WhatsApp ──────────────────────────────────────── */

/** The chat with a lead: linked to it, else the newest under the same
 * number, else a new one started on their number. Null when the number is
 * not one WhatsApp can reach. */
export function conversationForLead(lead, { create = false } = {}) {
  const linked = get('SELECT * FROM wa_conversations WHERE lead_id = ? ORDER BY last_message_at DESC LIMIT 1', [lead.id]);
  if (linked) return linked;
  const key = phoneKey(lead.phone);
  if (key && key.length >= 10) {
    const match = all('SELECT * FROM wa_conversations WHERE phone LIKE ? ORDER BY last_message_at DESC LIMIT 10', [`%${key.slice(-4)}`]).find(
      (c) => phoneKey(c.phone) === key,
    );
    if (match) {
      if (!match.lead_id) run('UPDATE wa_conversations SET lead_id = ? WHERE id = ?', [lead.id, match.id]);
      return { ...match, lead_id: match.lead_id ?? lead.id };
    }
  }
  if (!create) return null;
  const jid = formatPhoneNumber(lead.phone);
  if (!jid) return null;
  const conv = conversationFor({ jid, phone: jid.split('@')[0], pushName: null });
  run('UPDATE wa_conversations SET lead_id = ? WHERE id = ?', [lead.id, conv.id]);
  return { ...conv, lead_id: lead.id };
}

const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || 'there';

/** The words under the pass's QR on WhatsApp. */
export function passCaption(pass, lead, { gymName }) {
  const s = deskSettings();
  const visits = `${pass.visits_allowed} visit${pass.visits_allowed === 1 ? '' : 's'}`;
  const days = pass.valid_from === pass.valid_until ? dateLabel(pass.valid_from) : `${dateLabel(pass.valid_from)} – ${dateLabel(pass.valid_until)}`;
  return [
    `🎟️ *Free trial pass — ${gymName}*`,
    `*${lead.name}*`,
    `Valid ${days} · ${visits}`,
    `Pass code: *${pass.code}*`,
    `Show this QR at the front desk when you arrive${pass.arrival_time ? ` (we expect you around ${timeLabel(pass.arrival_time)})` : ''}.`,
    s.opening_hours ? `🕒 ${s.opening_hours}` : null,
    s.gym_address ? `📍 ${s.gym_address}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Sends the pass — its QR as a picture, the details as the caption — into
 * the lead's chat, starting one if there is none. Resolves to whether it
 * went; the transcript keeps the attempt either way.
 */
export async function sendTrialPass(passId, { gymName, author = 'staff', userName = null } = {}) {
  const pass = get('SELECT * FROM trial_passes WHERE id = ?', [passId]);
  if (!pass) throw notFound('Trial pass not found');
  if (pass.status === 'revoked') throw badRequest('This trial pass was cancelled');
  const lead = loadLead(pass.lead_id);
  const conv = conversationForLead(lead, { create: true });
  if (!conv) throw badRequest(`"${lead.phone}" is not a WhatsApp number`, { phone: 'invalid' });
  const { slug } = tenantStorage.getStore() ?? {};
  const caption = passCaption(pass, lead, { gymName });
  const sent = await deliver(slug, conv, {
    author,
    image: { buffer: await trialQrPng(pass.code), mimetype: 'image/png', caption },
    body: `[Trial pass QR]\n${caption}`,
    meta: { trial_pass: pass.code, ...(userName ? { by: userName } : {}) },
  });
  if (sent) run("UPDATE trial_passes SET sent_at = datetime('now') WHERE id = ?", [pass.id]);
  return sent;
}

/* ── At the desk ─────────────────────────────────────────────────────── */

/** What the desk is shown for a scanned pass, and whether it may check in. */
function deskView(pass, lead) {
  const view = passView(pass);
  // A pass that is cancelled or whose holder has joined stops working at
  // once — even for someone who already came in on it today.
  let blocked = null;
  if (view.state === 'revoked') blocked = `${lead.name}'s trial pass was cancelled`;
  else if (lead.status === 'converted') blocked = `${lead.name} is a member now — check in with their member card`;
  const visitToday = !blocked && Boolean(get('SELECT 1 FROM trial_visits WHERE pass_id = ? AND visit_date = ?', [pass.id, today()]));
  // Otherwise today's visit is recognised before the dates and the count,
  // so a rescan after the last visit says "already in", not "used up".
  if (!blocked && !visitToday) {
    if (view.state === 'upcoming') blocked = `${lead.name}'s trial starts on ${dateLabel(pass.valid_from)}`;
    else if (view.state === 'expired') blocked = `${lead.name}'s trial pass expired on ${dateLabel(pass.valid_until)}`;
    else if (view.state === 'used') blocked = `${lead.name} has used all ${pass.visits_allowed} trial visits`;
  }
  return {
    ...view,
    name: lead.name,
    phone: lead.phone,
    goal: lead.goal,
    lead_status: lead.status,
    visited_today: visitToday,
    can_check_in: !blocked,
    blocked_reason: blocked,
  };
}

/** The desk's read-only look at a scanned pass, before checking in. */
export function trialLookup(pass) {
  return deskView(pass, loadLead(pass.lead_id));
}

/**
 * Checks a trial visitor in. A second scan the same day is recognised
 * ('trial_already_in') rather than using up another visit; a pass that is
 * cancelled, not started, expired or used up is refused with the reason.
 */
export function checkInTrialPass(pass, source = 'desk') {
  const lead = loadLead(pass.lead_id);
  const view = deskView(pass, lead);
  if (view.visited_today) return { action: 'trial_already_in', trial: view };
  if (view.blocked_reason) throw badRequest(view.blocked_reason);

  const first = view.visits_used === 0;
  tx(() => {
    run('INSERT INTO trial_visits (pass_id, visit_date, source) VALUES (?, ?, ?)', [pass.id, today(), source]);
    run(`UPDATE gym_leads SET notes = ?, updated_at = datetime('now') WHERE id = ?`, [
      appendNote(lead.notes, `Trial visit ${view.visits_used + 1} of ${pass.visits_allowed}.`, { by: 'Desk' }),
      lead.id,
    ]);
  });
  return { action: 'trial_checked_in', trial: { ...deskView(pass, loadLead(lead.id)), first_visit: first } };
}

/* ── Follow-ups ──────────────────────────────────────────────────────── */

/** Follow-ups go out in daytime only, gym time. */
const FOLLOW_UP_FROM = '09:00';
const FOLLOW_UP_UNTIL = '20:00';
/** After the first visit, the "how was it?" waits this long. */
const AFTER_VISIT_MS = 2 * 60 * 60 * 1000;

/**
 * The hourly trial follow-up sweep, called from server.js inside each
 * tenant's context beside the renewal reminders:
 *
 * - **No-show** — the trial's first day has passed and they have not come.
 * - **Visited** — a couple of hours after their first visit: how was it?
 * - **Expiry** — the trial's last day, for anyone who has trained on it.
 *
 * Each goes once per pass (its *_sent_at column, stamped before the send and
 * cleared again if the send fails), never more than one a day per pass,
 * never to a converted or lost lead, and never into a chat a person on the
 * team is handling (the assistant's pause). Messages are the owner's own
 * templates. Returns how many were queued.
 */
export function sendTrialFollowUps({ gymName } = {}) {
  try {
    if (!moduleEnabled('trials')) return 0;
    const s = deskSettings();
    if (!s?.trial_followups || !whatsappReady()) return 0;
    const time = gymNowTime();
    if (time < FOLLOW_UP_FROM || time >= FOLLOW_UP_UNTIL) return 0;

    const now = today();
    const recently = utcTimestamp(-20 * 60 * 60 * 1000);
    const candidates = all(
      `SELECT p.*, l.name, l.phone, l.status AS lead_status,
              (SELECT COUNT(*) FROM trial_visits v WHERE v.pass_id = p.id) AS used,
              (SELECT MIN(v.check_in) FROM trial_visits v WHERE v.pass_id = p.id) AS first_check_in
       FROM trial_passes p
       JOIN gym_leads l ON l.id = p.lead_id
       WHERE p.status = 'active' AND l.status = 'trial'
         AND p.valid_from <= ? AND p.valid_until >= date(?, '-1 day')
         AND NOT (COALESCE(p.noshow_sent_at, '') > ? OR COALESCE(p.visited_sent_at, '') > ? OR COALESCE(p.expiry_sent_at, '') > ?)`,
      [now, now, recently, recently, recently],
    );
    let queued = 0;
    for (const pass of candidates) {
      const kind = followUpDue(pass, now);
      if (!kind) continue;
      if (queueFollowUp(pass, kind, { gymName, template: s[`${kind}_template`] })) queued += 1;
    }
    return queued;
  } catch (err) {
    console.error('[trials] follow-up sweep failed:', err.message);
    return 0;
  }
}

/** Which follow-up a pass is due, if any. */
function followUpDue(pass, now) {
  if (pass.used === 0) {
    return !pass.noshow_sent_at && pass.valid_from < now && pass.valid_until >= now ? 'noshow' : null;
  }
  if (!pass.expiry_sent_at && pass.valid_until === now && pass.used < pass.visits_allowed) return 'expiry';
  if (!pass.visited_sent_at && pass.first_check_in && pass.first_check_in <= utcTimestamp(-AFTER_VISIT_MS)) return 'visited';
  return null;
}

const SENT_COLUMN = { noshow: 'noshow_sent_at', visited: 'visited_sent_at', expiry: 'expiry_sent_at' };

function queueFollowUp(pass, kind, { gymName, template }) {
  const lead = get('SELECT * FROM gym_leads WHERE id = ?', [pass.lead_id]);
  const conv = conversationForLead(lead, { create: true });
  if (!conv || isPaused(conv)) return false;
  const text = renderTemplate(template, {
    first_name: firstName(lead.name),
    name: lead.name,
    gym_name: gymName,
    valid_until: dateLabel(pass.valid_until),
    visits_left: Math.max(0, pass.visits_allowed - pass.used),
    pass_code: pass.code,
  });
  const column = SENT_COLUMN[kind];
  run(`UPDATE trial_passes SET ${column} = datetime('now') WHERE id = ?`, [pass.id]);
  // Queued, not awaited, like the renewal reminders; the transcript keeps
  // the outcome, and a failure puts the follow-up back for the next sweep.
  deliver(tenantStorage.getStore()?.slug, conv, { author: 'ai', text, meta: { followup: kind } })
    .then((sent) => {
      if (!sent) run(`UPDATE trial_passes SET ${column} = NULL WHERE id = ?`, [pass.id]);
    })
    .catch((err) => console.error('[trials] follow-up failed:', err.message));
  return true;
}
