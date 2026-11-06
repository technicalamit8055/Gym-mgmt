import { coachConfigured, MAX_VOICE_BYTES, transcribeAudio } from './aiCoach.js';
import { MANAGES_BILLING } from './auth.js';
import { utcTimestamp } from './clock.js';
import { all, get, run, tenantStorage, tx } from './db.js';
import { HttpError } from './errors.js';
import { sellMembership } from './memberships.js';
import { issueQrToken, qrPngBuffer } from './qr.js';
import { nextMemberCode } from './routes/members.js';
import { sendAutoReceiptIfEnabled } from './routes/payments.js';
import { findTenantBySlug, tenantDbPath } from './tenants.js';
import { appendNote, memberWithPhone, openLeadForPhone } from './trialPasses.js';
import { addDays, today } from './validate.js';
import { interpretCommand, TRANSCRIBE_INSTRUCTION, transcribePrompt } from './voiceAdminAi.js';
import { phoneKey, weekdayOf } from './waChat.js';
import { markChatRead, renderTemplate, sendChatMessage, sendWhatsAppMessage } from './whatsapp.js';

/**
 * "Audio Admin": the gym owner runs the front desk from WhatsApp.
 *
 * The owner, on the gym floor, sends the gym's linked number a voice note —
 * "Add Rahul Verma, 98112 23344, 3-month strength plan, took 4000 cash,
 * starts tomorrow" — and gets back "✅ Rahul Verma added (GM0084)…". In
 * between: the clip is written down by the same Gemini voice pipeline as Ask
 * Coach (aiCoach.js transcribeAudio), voiceAdminAi.js turns the words into
 * one forced function call, and this file checks every field against the
 * gym's own data before one transaction adds the member, sells the plan and
 * records the payment (memberships.js, the desk's own sale). Then the new
 * member gets a welcome WhatsApp with their QR card, and the receipt if the
 * gym sends receipts automatically.
 *
 * Who may command, in order:
 * - Tenant: only the gym whose socket heard the message, and only a live
 *   GymBook account.
 * - The owner: voice_admin is off until they turn it on.
 * - The sender: the owner's number from the desk settings, or an active
 *   admin or manager's own phone (the roles that sell memberships at the
 *   desk). WhatsApp vouches for the sender's number; nothing in the message
 *   can claim to be someone else. Everyone else goes on to the receptionist.
 *
 * Mistakes: the model may not guess — a missing name, a 9-digit number or an
 * unclear plan becomes a question back, and the next message answers it. A
 * wrong entry is reversed by replying "undo" within half an hour.
 */

/** How long "undo" reaches back, and how long a question waits for its answer. */
const UNDO_WINDOW_MS = 30 * 60 * 1000;
const PENDING_WINDOW_MS = 15 * 60 * 1000;
/** Commands per gym per day — the cost ceiling, far above any real desk. */
const DAILY_LIMIT = Number(process.env.VOICE_ADMIN_DAILY_LIMIT || 60);
/** A command is a sentence or two; a long clip is a meeting recorded by mistake. */
const MAX_CLIP_SECONDS = 120;
const MAX_CLIP_BYTES = 2 * MAX_VOICE_BYTES;
const MAX_TRANSCRIPT = 1000;

const UNDO_TEXT = /^\s*(undo|undo (that|it|last)|cancel (that|it|last)|revert)\s*[.!]*\s*$/i;
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const METHOD_LABELS = { cash: 'Cash', upi: 'UPI', card: 'Card', bank: 'Bank transfer' };
const DEFAULT_WELCOME = 'Welcome to {{gym_name}}, {{first_name}}! We are thrilled to have you on board.';

/* ── Tenant and sender ───────────────────────────────────────────────── */

function tenantFor(slug) {
  if (!slug) return null;
  let row;
  try {
    row = findTenantBySlug(slug);
  } catch {
    return null;
  }
  if (!row || !['trial', 'active'].includes(row.status)) return null;
  if ((row.business_type || 'gym') !== 'gym') return null;
  return {
    row,
    store: { slug: row.slug, dbFile: tenantDbPath(row.slug), timezone: row.timezone || undefined, businessType: 'gym' },
    gymName: row.gym_name || row.display_name || 'the gym',
    currency: row.currency || 'INR',
  };
}

/** The person behind a number, when they may command: the owner's number in
 * the desk settings, or an active admin or manager's phone. Null otherwise. */
export function trustedSender(phone, ownerPhone) {
  const key = phoneKey(phone);
  if (!key || key.length < 10) return null;
  if (phoneKey(ownerPhone) === key) return { phone: key, name: 'Owner' };
  const user = all(
    `SELECT name, phone FROM users WHERE active = 1 AND role IN (${MANAGES_BILLING.map(() => '?').join(', ')}) AND phone LIKE ?`,
    [...MANAGES_BILLING, `%${key.slice(-4)}`],
  ).find((u) => phoneKey(u.phone) === key);
  return user ? { phone: key, name: user.name } : null;
}

/** Whether anyone at this gym could send a command, given the owner's number
 * about to be saved: switching it on with no number to trust would only look
 * broken. */
export function hasTrustedNumber(ownerPhone) {
  if (phoneKey(ownerPhone)?.length >= 10) return true;
  return all(`SELECT phone FROM users WHERE active = 1 AND phone IS NOT NULL AND role IN (${MANAGES_BILLING.map(() => '?').join(', ')})`, MANAGES_BILLING).some(
    (u) => phoneKey(u.phone)?.length >= 10,
  );
}

/* ── Incoming ────────────────────────────────────────────────────────── */

/**
 * Every message the gym's number receives in a one-to-one chat, from
 * src/receptionists.js, ahead of the front-desk assistant. `handled: false`
 * passes it on.
 */
export function receiveVoiceAdminMessage(event) {
  const tenant = tenantFor(event?.slug);
  if (!tenant) return { handled: false, reason: 'not_gym' };
  return tenantStorage.run(tenant.store, () => accept(event, tenant));
}

function accept(event, tenant) {
  // Staff typing to someone from the linked phone is a reply, not a command;
  // the phone's chat with itself is the owner talking to GymBook.
  if (event.fromMe && !event.self) return { handled: false, reason: 'staff_message' };
  const settings = get('SELECT voice_admin, owner_phone FROM gym_receptionist_settings WHERE id = 1');
  if (!settings?.voice_admin) return { handled: false, reason: 'off' };
  const sender = trustedSender(event.phone, settings.owner_phone);
  if (!sender) return { handled: false, reason: 'not_trusted' };
  const source = event.audio ? 'voice' : event.kind === 'text' ? 'text' : null;
  // A photo or a sticker from the owner is for whoever holds the phone.
  if (!source) return { handled: false, reason: 'not_a_command' };
  if (!coachConfigured()) return { handled: false, reason: 'ai_not_configured' };

  const info = run('INSERT OR IGNORE INTO voice_admin_log (wa_id, sender_phone, sender_name, source, transcript) VALUES (?, ?, ?, ?, ?)', [
    event.id || null,
    sender.phone,
    sender.name,
    source,
    source === 'text' ? String(event.text || '').trim().slice(0, MAX_TRANSCRIPT) : null,
  ]);
  if (!info.changes) return { handled: true, reason: 'duplicate' };
  const logId = Number(info.lastInsertRowid);
  schedule(tenant, () => handle(event, tenant, sender, logId));
  return { handled: true, reason: 'queued' };
}

/* ── One gym's commands, one at a time ───────────────────────────────── */

const lanes = new Map();
let inFlight = 0;

/** Commands run in order per gym — "add Rahul" then "undo" must not race —
 * and off the socket's inbound loop, which a 10-second AI call would stall. */
function schedule(tenant, job) {
  const { slug } = tenant.store;
  inFlight += 1;
  const next = (lanes.get(slug) ?? Promise.resolve())
    .then(() => tenantStorage.run(tenant.store, job))
    .catch((err) => console.error(`[voice-admin:${slug}] a command failed:`, err.message))
    .finally(() => {
      inFlight -= 1;
    });
  lanes.set(slug, next);
}

/** Resolves once every queued command has been answered. For tests. */
export async function voiceAdminIdle(timeoutMs = 10_000) {
  const until = Date.now() + timeoutMs;
  while (inFlight && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
  return inFlight === 0;
}

/* ── Handling a command ──────────────────────────────────────────────── */

async function handle(event, tenant, sender, logId) {
  const ctx = { event, tenant, sender, logId, tokens: 0, heard: null };
  let result;
  try {
    result = await decide(ctx);
  } catch (err) {
    // A rule the sale itself enforces (memberships.js) reads fine to the
    // owner as it is; anything else is ours or the provider's.
    const readable = err instanceof HttpError && err.status < 500;
    if (!readable) console.error(`[voice-admin:${tenant.store.slug}] could not carry out a command:`, err.message);
    result = {
      outcome: readable ? 'rejected' : 'failed',
      error: String(err.message || 'error').slice(0, 300),
      reply: readable
        ? `⚠️ ${err.message} — *nothing was changed*.`
        : '⚠️ Sorry, I could not process that just now — *nothing was changed*. Try again in a minute, or add it in GymBook.',
    };
  }
  await finish(ctx, result);
}

async function decide(ctx) {
  const { event, tenant, sender, logId } = ctx;
  const usedToday = get('SELECT COUNT(*) AS n FROM voice_admin_log WHERE created_at >= ?', [utcTimestamp(-24 * 60 * 60 * 1000)]).n;
  if (usedToday > DAILY_LIMIT) {
    return { outcome: 'rejected', reply: `You have sent ${DAILY_LIMIT} commands in the last 24 hours — the daily limit. Add the rest in GymBook.` };
  }

  let text;
  if (event.audio) {
    const heard = await hear(event.audio, tenant);
    if (heard.problem) return { outcome: 'rejected', reply: heard.problem };
    ctx.tokens += heard.tokens;
    text = heard.text;
    ctx.heard = text;
    run('UPDATE voice_admin_log SET transcript = ? WHERE id = ?', [text, logId]);
    if (!text) return { outcome: 'rejected', reply: '🎙️ I could not make out anything in that voice note. Try again a little closer to the phone, or type it.' };
  } else {
    text = String(event.text || '').trim();
    if (!text) return { outcome: 'ignored' };
  }

  if (UNDO_TEXT.test(text)) return undoLast(sender, tenant);

  const call = await interpretCommand({ gymName: tenant.gymName, data: gymData(tenant, pendingQuestion(sender, logId)), message: text });
  ctx.tokens += call.tokens;
  switch (call.name) {
    case 'add_member':
      return addMember(call.args, ctx);
    case 'ask_owner':
      return { outcome: 'clarify', reply: `❓ ${String(call.args.question || 'Could you say that again with the member’s name, number and plan?').trim().slice(0, 600)}` };
    case 'undo_last':
      return undoLast(sender, tenant);
    case 'cannot_do':
      return {
        outcome: 'rejected',
        reply: `${String(call.args.message || 'From WhatsApp I can only add new members for now.').trim().slice(0, 400)}\n\n${HELP}`,
      };
    default:
      return { outcome: 'ignored' };
  }
}

const HELP = '_Try: "Add Rahul Verma, 98112 23344, 3-month plan, took 4000 cash, starts tomorrow." Reply *undo* to reverse the last one._';

/** Writes the outcome down and, unless the message was not for GymBook,
 * answers in the same chat. Blue ticks only on what was acted on: a voice
 * note meant for whoever holds the phone must still look unread to them. */
async function finish(ctx, { outcome, reply = null, error = null, fields = {} }) {
  const { event, tenant, logId } = ctx;
  let text = reply;
  if (text && ctx.heard && outcome !== 'added') text = `${text}\n\n🎙️ _Heard: “${ctx.heard.slice(0, 300)}”_`;
  const columns = { outcome, reply: text, error, tokens: ctx.tokens, ...fields };
  run(`UPDATE voice_admin_log SET ${Object.keys(columns).map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [...Object.values(columns), logId]);
  if (!text) return;
  markChatRead(tenant.store.slug, [event.key]);
  try {
    await sendChatMessage({ slug: tenant.store.slug, jid: event.jid, text });
  } catch (err) {
    console.error(`[voice-admin:${tenant.store.slug}] could not reply to the owner:`, err.message);
    run('UPDATE voice_admin_log SET error = COALESCE(error, ?) WHERE id = ?', [`Reply not sent: ${err.message}`.slice(0, 300), logId]);
  }
}

/** The voice note as text, or `problem` when it is not one to write down. */
async function hear(audio, tenant) {
  const tooLong = '🎙️ That voice note is too long. Keep a command under 2 minutes — one member at a time.';
  if (audio.seconds > MAX_CLIP_SECONDS || audio.bytes > MAX_CLIP_BYTES) return { problem: tooLong };
  const buffer = await audio.download();
  if (!buffer?.length) throw new Error('The voice note could not be downloaded');
  if (buffer.length > MAX_CLIP_BYTES) return { problem: tooLong };
  // WhatsApp's "audio/ogg; codecs=opus" — Gemini takes the type alone.
  const mimeType = String(audio.mimetype || 'audio/ogg').split(';')[0].trim().toLowerCase();
  const heard = await transcribeAudio({
    audio: Buffer.from(buffer).toString('base64'),
    mimeType: mimeType.startsWith('audio/') ? mimeType : 'audio/ogg',
    instruction: TRANSCRIBE_INSTRUCTION,
    prompt: transcribePrompt(tenant.gymName),
    maxLength: MAX_TRANSCRIPT,
  });
  return { text: heard.text, tokens: heard.input_tokens + heard.output_tokens };
}

/** What the model is told about the gym: today, the plans on sale, and the
 * question it asked this sender a moment ago, if any. */
function gymData(tenant, pending) {
  const now = today();
  return {
    TODAY: `${now} (${DAY_NAMES[weekdayOf(now)]})`,
    gym: tenant.gymName,
    currency: tenant.currency,
    plans: all('SELECT id, name, duration_days, price, sessions FROM plans WHERE active = 1 ORDER BY duration_days, price'),
    PENDING_QUESTION: pending,
  };
}

/** The back-and-forth a new message may be answering: this sender's
 * questions from the last few minutes with what they said before each. */
function pendingQuestion(sender, logId) {
  const rows = all('SELECT outcome, transcript, reply, created_at FROM voice_admin_log WHERE sender_phone = ? AND id < ? ORDER BY id DESC LIMIT 4', [sender.phone, logId]);
  const since = utcTimestamp(-PENDING_WINDOW_MS);
  const turns = [];
  for (const row of rows) {
    if (row.outcome !== 'clarify' || row.created_at < since) break;
    turns.unshift({ owner_said: row.transcript, you_asked: String(row.reply || '').split('\n\n🎙️')[0].replace(/^❓\s*/, '') });
  }
  return turns.length ? turns : null;
}

/* ── Adding a member ─────────────────────────────────────────────────── */

const cleanName = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
const fullName = (m) => `${m.first_name}${m.last_name ? ` ${m.last_name}` : ''}`;
const spaced = (digits) => (digits.length === 10 ? `${digits.slice(0, 5)} ${digits.slice(5)}` : digits);
const round2 = (n) => Math.round(n * 100) / 100;

function money(amount, currency) {
  try {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency, minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `${currency} ${amount}`;
  }
}

/** "7 Nov", or "5 Feb 2027" outside the current year. */
function shortDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}${String(y) === today().slice(0, 4) ? '' : ` ${y}`}`;
}

const isCalendarDate = (iso) => /^\d{4}-\d{2}-\d{2}$/.test(iso) && new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10) === iso;

/** A mobile number as heard, or the question to ask about it. Stored the way
 * the desk types one: the ten national digits. */
function mobileOf(raw, firstName) {
  const cc = process.env.WHATSAPP_COUNTRY_CODE || '91';
  let digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length === 10 + cc.length && digits.startsWith(cc)) digits = digits.slice(cc.length);
  if (digits.length !== 10) {
    return {
      question: digits
        ? `I heard the number as ${digits} — that is ${digits.length} digits. What is ${firstName}'s 10-digit mobile number?`
        : `What is ${firstName}'s mobile number?`,
    };
  }
  if (cc === '91' && !/^[6-9]/.test(digits)) return { question: `${spaced(digits)} does not look like a mobile number. Could you say ${firstName}'s number again?` };
  return { digits };
}

const planChoices = (currency) =>
  all('SELECT name, price, duration_days FROM plans WHERE active = 1 ORDER BY duration_days, price LIMIT 12')
    .map((p) => `• ${p.name} — ${money(p.price, currency)}`)
    .join('\n');

/**
 * add_member, checked against the gym's data and carried out in one
 * transaction: the member, the membership and the payment all land, or none
 * do. Anything that does not check out goes back to the owner as a question.
 */
async function addMember(args, ctx) {
  const { tenant, sender } = ctx;
  const { currency } = tenant;
  const ask = (question) => ({ outcome: 'clarify', reply: `❓ ${question}` });

  const firstName = cleanName(args.first_name);
  const lastName = cleanName(args.last_name);
  if (!firstName) return ask('What is the new member’s name?');

  const mobile = mobileOf(args.mobile, firstName);
  if (mobile.question) return ask(mobile.question);
  const existing = memberWithPhone(mobile.digits);
  if (existing) {
    return {
      outcome: 'rejected',
      reply: `⚠️ ${spaced(mobile.digits)} is already *${fullName(existing)}* (${existing.code}) — nothing was added. Renew or edit existing members in GymBook.`,
    };
  }

  const plan = Number.isInteger(Number(args.plan_id)) ? get('SELECT * FROM plans WHERE id = ? AND active = 1', [Number(args.plan_id)]) : null;
  if (!plan) {
    const choices = planChoices(currency);
    return choices ? ask(`Which plan is ${firstName} joining?\n${choices}`) : { outcome: 'rejected', reply: '⚠️ There are no plans on sale yet. Add your plans in GymBook first.' };
  }

  const now = today();
  const startDate = args.start_date ? String(args.start_date).trim() : now;
  if (!isCalendarDate(startDate)) return ask(`When does ${firstName} start?`);
  if (startDate < addDays(now, -31) || startDate > addDays(now, 90)) {
    return ask(`Should ${firstName}'s ${plan.name} really start on ${shortDate(startDate)}? Say the start date again.`);
  }

  const discount = round2(Math.max(0, Number(args.discount) || 0));
  if (discount >= plan.price && plan.price > 0) return ask(`A ${money(discount, currency)} discount is the whole ${plan.name} price (${money(plan.price, currency)}). What discount did you mean?`);
  const total = round2(plan.price - discount);
  const paid = round2(Math.max(0, Number(args.amount_paid) || 0));
  if (paid > total) {
    return ask(`${money(paid, currency)} is more than the ${plan.name} price of ${money(total, currency)}. How much did ${firstName} pay?`);
  }
  const method = METHOD_LABELS[args.payment_method] ? args.payment_method : 'cash';
  const gender = ['male', 'female', 'other'].includes(args.gender) ? args.gender : null;

  const added = tx(() => {
    const code = nextMemberCode();
    const memberId = Number(
      run('INSERT INTO members (code, first_name, last_name, phone, gender, joined_on) VALUES (?, ?, ?, ?, ?, ?)', [
        code,
        firstName,
        lastName,
        mobile.digits,
        gender,
        now,
      ]).lastInsertRowid,
    );
    const { subscriptionId, paymentId } = sellMembership({
      memberId,
      planId: plan.id,
      startDate,
      discount,
      note: `Added from WhatsApp by ${sender.name}`,
      payment: paid > 0 ? { amount: paid, method } : null,
    });
    const token = issueQrToken(memberId);
    // Someone who came in on a free trial: their lead has joined now.
    const lead = openLeadForPhone(mobile.digits);
    if (lead) {
      run(
        `UPDATE gym_leads SET status = 'converted', member_id = ?, converted_on = ?, follow_up_on = NULL, notes = ?, updated_at = datetime('now') WHERE id = ?`,
        [memberId, now, appendNote(lead.notes, `Joined as a member (added from WhatsApp by ${sender.name}).`, { by: 'Desk' }), lead.id],
      );
    }
    return { memberId, code, token, subscriptionId, paymentId, lead };
  });

  const sub = get('SELECT start_date, end_date FROM subscriptions WHERE id = ?', [added.subscriptionId]);
  const member = { id: added.memberId, code: added.code, first_name: firstName, last_name: lastName, phone: mobile.digits };
  const welcome = await sendWelcome({ member, token: added.token, plan, sub, gymName: tenant.gymName });
  if (added.paymentId) sendAutoReceiptIfEnabled(added.paymentId, { tenant: tenant.row });

  const due = round2(total - paid);
  const lines = [
    `✅ *${fullName(member)}* added (${added.code})`,
    `📱 ${spaced(mobile.digits)}`,
    `📋 ${plan.name} registered: ${shortDate(sub.start_date)} – ${shortDate(sub.end_date)}`,
    discount ? `🏷️ ${money(discount, currency)} discount` : null,
    paid
      ? `💵 ${money(paid, currency)} ${METHOD_LABELS[method]} logged${due > 0 ? ` · *${money(due, currency)} due*` : ' · fully paid'}`
      : `💵 No payment logged · *${money(due, currency)} due*`,
    welcome.ok ? '💬 Welcome WhatsApp sent to member with QR card.' : `⚠️ Welcome WhatsApp not sent: ${welcome.error}`,
    added.lead ? '🎯 Their free-trial lead is marked as joined.' : null,
    '',
    ctx.heard ? `🎙️ _Heard: “${ctx.heard.slice(0, 300)}”_` : null,
    'Reply *undo* within 30 minutes to reverse this.',
  ];
  return {
    outcome: 'added',
    reply: lines.filter((l) => l !== null).join('\n'),
    fields: {
      member_id: added.memberId,
      subscription_id: added.subscriptionId,
      payment_id: added.paymentId,
      lead_id: added.lead?.id ?? null,
      lead_prev_status: added.lead?.status ?? null,
    },
  };
}

/** The gym's welcome message (its own template) with the member's QR card,
 * from the gym's number. Resolves to { ok, error }; never throws. */
async function sendWelcome({ member, token, plan, sub, gymName }) {
  const template = get('SELECT welcome_template FROM whatsapp_settings WHERE id = 1')?.welcome_template || DEFAULT_WELCOME;
  const caption = [
    renderTemplate(template, { first_name: member.first_name, last_name: member.last_name, gym_name: gymName }),
    '',
    `🪪 Member ID: *${member.code}*`,
    `📋 ${plan.name}: ${shortDate(sub.start_date)} – ${shortDate(sub.end_date)}`,
    'Show this QR at the front desk to check in.',
  ].join('\n');
  try {
    await sendWhatsAppMessage({
      phone: member.phone,
      message: caption,
      image: { buffer: await qrPngBuffer(token), mimetype: 'image/png', caption },
      type: 'welcome',
      memberId: member.id,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || 'WhatsApp did not take it' };
  }
}

/* ── Undo ────────────────────────────────────────────────────────────── */

/**
 * Reverses the last member this sender added from WhatsApp, within the
 * window: the payment, the membership and the member go, and a trial lead
 * they came from is open again. A member with anything since — a check-in,
 * another payment — is left for the desk, where the owner can see what goes.
 */
function undoLast(sender, tenant) {
  const row = get(
    "SELECT * FROM voice_admin_log WHERE sender_phone = ? AND outcome = 'added' AND undone_at IS NULL AND created_at >= ? ORDER BY id DESC LIMIT 1",
    [sender.phone, utcTimestamp(-UNDO_WINDOW_MS)],
  );
  if (!row) {
    return { outcome: 'rejected', reply: 'Nothing to undo — only a member you added from WhatsApp in the last 30 minutes can be reversed here. Edit older ones in GymBook.' };
  }
  const member = get('SELECT * FROM members WHERE id = ?', [row.member_id]);
  if (!member) {
    run("UPDATE voice_admin_log SET undone_at = datetime('now') WHERE id = ?", [row.id]);
    return { outcome: 'rejected', reply: 'That member has already been deleted in GymBook — nothing to undo.' };
  }
  const since = get(
    `SELECT (SELECT COUNT(*) FROM attendance WHERE member_id = ?) AS visits,
            (SELECT COUNT(*) FROM payments WHERE member_id = ? AND id != COALESCE(?, -1)) AS payments,
            (SELECT COUNT(*) FROM subscriptions WHERE member_id = ? AND id != COALESCE(?, -1)) AS subscriptions`,
    [member.id, member.id, row.payment_id, member.id, row.subscription_id],
  );
  if (since.visits || since.payments || since.subscriptions) {
    return {
      outcome: 'rejected',
      reply: `⚠️ *${fullName(member)}* (${member.code}) already has a check-in or another payment since, so I have not touched them. Edit or delete them in GymBook.`,
    };
  }
  const sub = get('SELECT p.name AS plan_name FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.id = ?', [row.subscription_id]);
  const payment = row.payment_id ? get('SELECT amount, method FROM payments WHERE id = ?', [row.payment_id]) : null;

  tx(() => {
    if (row.payment_id) run('DELETE FROM payments WHERE id = ?', [row.payment_id]);
    if (row.subscription_id) run('DELETE FROM subscriptions WHERE id = ?', [row.subscription_id]);
    run('DELETE FROM members WHERE id = ?', [member.id]);
    if (row.lead_id) {
      run("UPDATE gym_leads SET status = ?, member_id = NULL, converted_on = NULL, updated_at = datetime('now') WHERE id = ? AND status = 'converted'", [
        row.lead_prev_status || 'new',
        row.lead_id,
      ]);
    }
    run("UPDATE voice_admin_log SET undone_at = datetime('now') WHERE id = ?", [row.id]);
  });

  const what = [sub ? `the ${sub.plan_name} membership` : null, payment ? `the ${money(payment.amount, tenant.currency)} ${METHOD_LABELS[payment.method] || payment.method} payment` : null]
    .filter(Boolean)
    .join(' and ');
  return {
    outcome: 'undo',
    reply: `↩️ Undone: *${fullName(member)}* (${member.code}) is deleted${what ? `, with ${what}` : ''}. The welcome message they already got cannot be recalled.`,
  };
}
