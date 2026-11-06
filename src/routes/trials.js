import { Router } from 'express';
import { coachConfigured } from '../aiCoach.js';
import { MANAGES_BILLING, requireAuth, requireRole } from '../auth.js';
import { createReceptionistCheckout, ensureEntitledOrStartTrial, planState, verifyReceptionistPayment } from '../coaching/receptionistBilling.js';
import { config, DEFAULT_TENANT_SLUG } from '../config.js';
import { all, get, run, tenantStorage, tx } from '../db.js';
import { badRequest, conflict, HttpError, notFound, paymentRequired } from '../errors.js';
import { leadTranscript, setLeadAssistantPaused, staffReplyToLead } from '../gymReceptionist.js';
import {
  appendNote,
  deskSettings,
  issueTrialPass,
  latestPassFor,
  LEAD_SOURCES,
  loadLead,
  memberWithPhone,
  openLeadForPhone,
  passView,
  revokeTrialPass,
  sendTrialPass,
  trialQrSvg,
} from '../trialPasses.js';
import { parse, today } from '../validate.js';
import { requireModule } from '../verticals.js';
import { hasTrustedNumber } from '../voiceAdmin.js';
import { formatPhoneNumber, whatsappReady } from '../whatsapp.js';
import { coordinatesFromMapsUrl } from './coaching/admissions.js';
import { idParam, optional, weekdaysValue } from './coaching/shared.js';
import { nextMemberCode } from './members.js';

/**
 * The gym's trials desk: leads (from the WhatsApp assistant, walk-ins and
 * calls), their free trial passes, the chat behind each one, and turning a
 * lead into a member. Also the assistant's own settings and paying for it.
 *
 * The rules a pass follows are src/trialPasses.js's; the assistant is
 * src/gymReceptionist.js. A trial visitor is checked in at the ordinary
 * desk (routes/qr.js and routes/attendance.js recognise a pass's code).
 */
export const trialRoutes = Router();
trialRoutes.use(requireAuth, requireModule('trials'));

/** Front desk and managers work leads; a trainer can see them. */
const DESK_WRITERS = ['admin', 'manager', 'staff'];

const gymNameOf = (req) => req.tenant?.gym_name || req.tenant?.display_name || config.gymName || 'GymBook';
const currentSlug = () => tenantStorage.getStore()?.slug ?? DEFAULT_TENANT_SLUG;

/* ── Leads ───────────────────────────────────────────────────────────── */

// The chat columns are subqueries rather than a join: a lead can (rarely)
// have two chats, and a join would list it twice.
const LEAD_SELECT = `
  SELECT l.*, p.name AS plan_name, m.code AS member_code,
         (SELECT MAX(wc.last_message_at) FROM wa_conversations wc WHERE wc.lead_id = l.id) AS wa_last_message_at,
         (SELECT MAX(wc.needs_staff) FROM wa_conversations wc WHERE wc.lead_id = l.id) AS wa_needs_staff,
         (SELECT MAX(wc.bot_paused_until > datetime('now')) FROM wa_conversations wc WHERE wc.lead_id = l.id) AS wa_paused
  FROM gym_leads l
  LEFT JOIN plans p ON p.id = l.plan_id
  LEFT JOIN members m ON m.id = l.member_id
`;

/** Where a lead is in the funnel, for the desk's tabs: a 'new' lead, a
 * trial 'booked' (not yet come), 'visited' (came at least once), a
 * 'no_show' (pass lapsed unused), then 'converted' or 'lost'. */
export const STAGES = ['lead', 'booked', 'visited', 'no_show', 'converted', 'lost'];

function stageOf(lead, pass) {
  if (lead.status === 'converted' || lead.status === 'lost') return lead.status;
  if (lead.status === 'new' || !pass) return 'lead';
  if (pass.visits_used > 0) return 'visited';
  return pass.state === 'expired' ? 'no_show' : 'booked';
}

function leadView(row) {
  const pass = latestPassFor(row.id);
  const view = pass ? passView(pass) : null;
  return { ...row, wa_needs_staff: Boolean(row.wa_needs_staff), wa_paused: Boolean(row.wa_paused), pass: view, stage: stageOf(row, view) };
}

const leadById = (id) => {
  const row = get(`${LEAD_SELECT} WHERE l.id = ?`, [id]);
  if (!row) throw notFound('Lead not found');
  return leadView(row);
};

trialRoutes.get('/', (req, res) => {
  const where = [];
  const params = [];
  const q = String(req.query.q || '').trim();
  if (q) {
    where.push('(l.name LIKE ? OR l.phone LIKE ? OR l.goal LIKE ?)');
    params.push(`%${q}%`, `%${q.replace(/\D/g, '') || q}%`, `%${q}%`);
  }
  const rows = all(
    `${LEAD_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY CASE WHEN l.status IN ('converted', 'lost') THEN 1 ELSE 0 END, l.updated_at DESC
     LIMIT 500`,
    params,
  ).map(leadView);

  const counts = Object.fromEntries(STAGES.map((s) => [s, 0]));
  for (const row of rows) counts[row.stage] += 1;
  const needsReply = rows.filter((r) => r.wa_needs_staff && !['converted', 'lost'].includes(r.status)).length;

  let items = rows;
  if (req.query.stage === 'needs_reply') items = rows.filter((r) => r.wa_needs_staff);
  else if (STAGES.includes(req.query.stage)) items = rows.filter((r) => r.stage === req.query.stage);
  else if (req.query.stage === 'open') items = rows.filter((r) => !['converted', 'lost'].includes(r.stage));

  const month = `${today().slice(0, 7)}-01`;
  const settings = deskSettings();
  res.json({
    items,
    counts: { ...counts, needs_reply: needsReply },
    month: {
      leads: get('SELECT COUNT(*) AS n FROM gym_leads WHERE created_at >= ?', [month]).n,
      trials: get("SELECT COUNT(*) AS n FROM trial_passes WHERE status = 'active' AND valid_from >= ?", [month]).n,
      visited: get(
        "SELECT COUNT(DISTINCT p.id) AS n FROM trial_passes p JOIN trial_visits v ON v.pass_id = p.id WHERE p.status = 'active' AND p.valid_from >= ?",
        [month],
      ).n,
      converted: get('SELECT COUNT(*) AS n FROM gym_leads WHERE converted_on >= ?', [month]).n,
    },
    in_today: get('SELECT COUNT(*) AS n FROM trial_visits WHERE visit_date = ?', [today()]).n,
    ai: {
      on: Boolean(settings.ai_receptionist),
      plan: currentPlan(),
      captured_this_month: get('SELECT COUNT(*) AS n FROM gym_leads WHERE ai_captured = 1 AND created_at >= ?', [month]).n,
      configured: coachConfigured(),
    },
    whatsapp_connected: whatsappReady(),
    trial: { days: settings.trial_days, visits: Math.min(settings.trial_visits, settings.trial_days), booking_days: settings.trial_booking_days },
  });
});

const LEAD_FIELDS = {
  name: { type: 'string', required: true, min: 2, max: 100 },
  phone: { type: 'string', required: true, min: 6, max: 30 },
  goal: { type: 'string', max: 120 },
  preferred_time: { type: 'string', max: 60 },
  plan_id: { type: 'int', min: 1 },
  source: { type: 'enum', values: LEAD_SOURCES, default: 'walk_in' },
  follow_up_on: { type: 'date' },
  notes: { type: 'string', max: 2000 },
};

function checkLead(body) {
  if (body.plan_id && !get('SELECT id FROM plans WHERE id = ?', [body.plan_id])) throw notFound('Plan not found');
  if (body.phone && String(body.phone).replace(/\D/g, '').length < 10) throw badRequest('Enter a 10-digit mobile number', { phone: 'invalid' });
}

trialRoutes.get('/leads/:id', (req, res) => {
  res.json(leadById(idParam(req)));
});

trialRoutes.post('/leads', requireRole(...DESK_WRITERS), (req, res) => {
  const body = parse(req.body, LEAD_FIELDS);
  checkLead(body);
  const columns = Object.keys(body).filter((c) => body[c] !== undefined);
  const info = run(`INSERT INTO gym_leads (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`, columns.map((c) => body[c]));
  res.status(201).json(leadById(Number(info.lastInsertRowid)));
});

trialRoutes.patch('/leads/:id', requireRole(...DESK_WRITERS), (req, res) => {
  const id = idParam(req);
  const lead = loadLead(id);
  const body = parse(req.body, { ...optional(LEAD_FIELDS), status: { type: 'enum', values: ['new', 'lost'] } });
  checkLead(body);
  if (lead.status === 'converted' && body.status) throw conflict('This lead is already a member');
  // Back from lost: a lead holding a usable pass is still on trial.
  if (body.status === 'new' && latestPassFor(id)) body.status = 'trial';
  const columns = Object.keys(body);
  if (!columns.length) throw badRequest('Nothing to update');
  run(`UPDATE gym_leads SET ${columns.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`, [...columns.map((c) => body[c]), id]);
  res.json(leadById(id));
});

trialRoutes.delete('/leads/:id', requireRole(...MANAGES_BILLING), (req, res) => {
  const id = idParam(req);
  loadLead(id);
  run('DELETE FROM gym_leads WHERE id = ?', [id]);
  res.status(204).end();
});

/**
 * Turns a lead into a member: a new members row with the next member code
 * (or, with `member_id`, an existing member they turned out to be), and the
 * lead marked converted. Selling the plan is the member page's usual step.
 */
trialRoutes.post('/leads/:id/convert', requireRole(...DESK_WRITERS), (req, res) => {
  const id = idParam(req);
  const lead = loadLead(id);
  if (lead.status === 'converted' && lead.member_id) throw conflict('This lead is already a member');
  const body = parse(req.body, {
    member_id: { type: 'int', min: 1 },
    first_name: { type: 'string', max: 60 },
    last_name: { type: 'string', max: 60 },
    phone: { type: 'string', max: 30 },
    email: { type: 'email' },
    gender: { type: 'enum', values: ['male', 'female', 'other'] },
  });

  const memberId = tx(() => {
    let mid = body.member_id ?? null;
    if (mid) {
      if (!get('SELECT id FROM members WHERE id = ?', [mid])) throw notFound('Member not found');
    } else {
      // The lead's one name field, split, unless the desk typed the parts.
      const [first, ...rest] = String(lead.name || '').trim().split(/\s+/);
      const firstName = body.first_name || first;
      if (!firstName) throw badRequest("Enter the new member's first name", { first_name: 'required' });
      if (body.email && get('SELECT id FROM members WHERE email = ?', [body.email])) throw conflict('A member with that email already exists', { email: 'taken' });
      const phone = body.phone ?? (lead.phone.startsWith('WhatsApp') ? null : lead.phone);
      mid = Number(
        run('INSERT INTO members (code, first_name, last_name, phone, email, gender, joined_on) VALUES (?, ?, ?, ?, ?, ?, ?)', [
          nextMemberCode(),
          firstName,
          body.last_name ?? (body.first_name ? '' : rest.join(' ')),
          phone,
          body.email ?? null,
          body.gender ?? null,
          today(),
        ]).lastInsertRowid,
      );
    }
    run(
      `UPDATE gym_leads SET status = 'converted', member_id = ?, converted_on = ?, follow_up_on = NULL, notes = ?, updated_at = datetime('now') WHERE id = ?`,
      [mid, today(), appendNote(lead.notes, `Joined as a member${req.user?.name ? ` (by ${req.user.name})` : ''}.`, { by: 'Desk' }), id],
    );
    return mid;
  });
  res.status(201).json({ lead: leadById(id), member_id: memberId });
});

/* ── Trial passes ────────────────────────────────────────────────────── */

/** A pass's details and QR, for the desk to show, print or resend. */
async function passPayload(passId) {
  const pass = get('SELECT * FROM trial_passes WHERE id = ?', [passId]);
  if (!pass) throw notFound('Trial pass not found');
  return { ...passView(pass), svg: await trialQrSvg(pass.code), lead: leadById(pass.lead_id) };
}

/**
 * Issues a pass to a lead and, unless `send` is off, sends it on WhatsApp.
 * A refusal under the rules is a 409 carrying the rule's `code` and reason;
 * the desk can repeat the request with `override` to issue it anyway where
 * trialPasses.js allows that.
 */
trialRoutes.post('/leads/:id/pass', requireRole(...DESK_WRITERS), async (req, res, next) => {
  try {
    const lead = loadLead(idParam(req));
    const body = parse(req.body, {
      start_on: { type: 'date' },
      arrival_time: { type: 'time' },
      send: { type: 'boolean', default: 1 },
      override: { type: 'boolean', default: 0 },
    });
    const result = issueTrialPass(lead, {
      startOn: body.start_on || today(),
      arrivalTime: body.arrival_time || null,
      issuedBy: 'staff',
      userId: req.user?.id ?? null,
      override: Boolean(body.override),
    });
    if (!result.ok) throw conflict(result.reason, { code: result.code, eligible_from: result.eligible_from });
    let sent = null;
    if (body.send) {
      try {
        sent = await sendTrialPass(result.pass.id, { gymName: gymNameOf(req), userName: req.user?.name });
      } catch (err) {
        // The pass is issued either way; the desk can show or resend it.
        sent = false;
        if (!(err instanceof HttpError)) throw err;
      }
    }
    res.status(result.created ? 201 : 200).json({ ...(await passPayload(result.pass.id)), already_issued: Boolean(result.already_issued), sent });
  } catch (err) {
    next(err);
  }
});

trialRoutes.get('/passes/:id', async (req, res, next) => {
  try {
    res.json(await passPayload(idParam(req)));
  } catch (err) {
    next(err);
  }
});

trialRoutes.post('/passes/:id/send', requireRole(...DESK_WRITERS), async (req, res, next) => {
  try {
    const id = idParam(req);
    const sent = await sendTrialPass(id, { gymName: gymNameOf(req), userName: req.user?.name });
    if (!sent) throw badRequest('WhatsApp did not take the pass. Check that WhatsApp is linked, then try again.');
    res.json({ ...(await passPayload(id)), sent });
  } catch (err) {
    next(err);
  }
});

trialRoutes.post('/passes/:id/revoke', requireRole(...DESK_WRITERS), async (req, res, next) => {
  try {
    const id = idParam(req);
    revokeTrialPass(id);
    res.json(await passPayload(id));
  } catch (err) {
    next(err);
  }
});

/* ── The chat behind a lead ──────────────────────────────────────────── */

trialRoutes.get('/leads/:id/whatsapp', (req, res) => {
  const after = Number(req.query.after);
  res.json(leadTranscript(idParam(req), { after: Number.isInteger(after) && after > 0 ? after : 0 }));
});

trialRoutes.post('/leads/:id/whatsapp/reply', requireRole(...DESK_WRITERS), async (req, res, next) => {
  try {
    res.status(201).json(await staffReplyToLead(idParam(req), { text: req.body?.text, userName: req.user?.name }));
  } catch (err) {
    next(err);
  }
});

trialRoutes.post('/leads/:id/whatsapp/assistant', requireRole(...DESK_WRITERS), (req, res) => {
  const body = parse(req.body, { paused: { type: 'boolean', required: true } });
  res.json(setLeadAssistantPaused(idParam(req), Boolean(body.paused)));
});

/* ── The assistant's and the trials' settings ────────────────────────── */

const TEMPLATE = { type: 'string', min: 10, max: 1000 };
const SETTINGS_FIELDS = {
  ai_receptionist: { type: 'boolean' },
  ai_persona_name: { type: 'string', max: 40 },
  ai_persona_notes: { type: 'string', max: 2000 },
  opening_hours: { type: 'string', max: 200 },
  ai_reply_mode: { type: 'enum', values: ['always', 'after_hours'] },
  office_open: { type: 'time' },
  office_close: { type: 'time' },
  office_days: { type: 'string', max: 20 },
  ai_pause_minutes: { type: 'int', min: 5, max: 10080 },
  gym_phone: { type: 'string', max: 30 },
  gym_address: { type: 'string', max: 300 },
  landmark_directions: { type: 'string', max: 300 },
  latitude: { type: 'number', min: -90, max: 90 },
  longitude: { type: 'number', min: -180, max: 180 },
  maps_url: { type: 'string', max: 500 },
  owner_phone: { type: 'string', max: 30 },
  hot_lead_alerts: { type: 'boolean' },
  voice_admin: { type: 'boolean' },
  trial_enabled: { type: 'boolean' },
  trial_days: { type: 'int', min: 1, max: 30 },
  trial_visits: { type: 'int', min: 1, max: 30 },
  trial_cooldown_days: { type: 'int', min: 0, max: 3650 },
  trial_daily_cap: { type: 'int', min: 0, max: 500 },
  trial_booking_days: { type: 'int', min: 0, max: 30 },
  trial_followups: { type: 'boolean' },
  noshow_template: TEMPLATE,
  visited_template: TEMPLATE,
  expiry_template: TEMPLATE,
};
const SETTINGS_COLUMNS = Object.keys(SETTINGS_FIELDS);
/** Fields an owner may clear back to empty. */
const CLEARABLE = new Set(['ai_persona_name', 'ai_persona_notes', 'opening_hours', 'gym_phone', 'gym_address', 'landmark_directions', 'maps_url', 'owner_phone', 'latitude', 'longitude']);

/** The gym's AI receptionist plan (receptionistBilling.js), or null on a
 * single-gym install, which has no registry to bill from. */
const currentPlan = () => (currentSlug() === DEFAULT_TENANT_SLUG ? null : planState(currentSlug(), today()));

function settingsPayload(extra = {}) {
  return {
    ...extra,
    plan: currentPlan(),
    settings: get(`SELECT ${SETTINGS_COLUMNS.join(', ')} FROM gym_receptionist_settings WHERE id = 1`),
    ai_configured: coachConfigured(),
    whatsapp_connected: whatsappReady(),
  };
}

trialRoutes.get('/settings', (_req, res) => {
  res.json(settingsPayload());
});

trialRoutes.patch('/settings', requireRole(...MANAGES_BILLING), (req, res) => {
  const body = parse(req.body, SETTINGS_FIELDS);
  if (body.office_days !== undefined) body.office_days = weekdaysValue(body.office_days) ?? '';
  // A pasted map link fills in the pin, unless the owner typed one too.
  if (body.maps_url && body.latitude == null && body.longitude == null) Object.assign(body, coordinatesFromMapsUrl(body.maps_url) ?? {});
  if (('latitude' in body || 'longitude' in body) && (body.latitude == null) !== (body.longitude == null)) {
    throw badRequest('Give both latitude and longitude, or neither', { latitude: 'pair', longitude: 'pair' });
  }
  if (body.owner_phone && !formatPhoneNumber(body.owner_phone)) throw badRequest('That is not a phone number WhatsApp can reach', { owner_phone: 'invalid' });
  const merged = { ...get('SELECT office_open, office_close, trial_days, trial_visits FROM gym_receptionist_settings WHERE id = 1'), ...body };
  if (merged.office_open >= merged.office_close) throw badRequest('Desk hours must close after they open', { office_close: 'before open' });
  if (merged.trial_visits > merged.trial_days) throw badRequest('A trial cannot have more visits than days — one visit a day', { trial_visits: 'more than days' });
  const columns = Object.keys(body).filter((c) => body[c] !== null || CLEARABLE.has(c));
  if (!columns.length) throw badRequest('Nothing to update');
  // Commands are trusted by the sender's number; with none to trust, the
  // switch would be on and nothing would ever answer.
  const ownerPhone = 'owner_phone' in body ? body.owner_phone : get('SELECT owner_phone FROM gym_receptionist_settings WHERE id = 1')?.owner_phone;
  if (body.voice_admin === 1 && !hasTrustedNumber(ownerPhone)) {
    throw badRequest("Add the owner's WhatsApp number first — voice commands are only taken from it", { owner_phone: 'required for voice commands' });
  }
  // Switching the assistant on needs a plan: the first time, that starts
  // the free trial; after a lapse it is a 402 telling the owner to renew.
  let trialStarted = false;
  if (body.ai_receptionist === 1) {
    if (currentSlug() === DEFAULT_TENANT_SLUG) throw paymentRequired('The AI receptionist needs a GymBook account');
    trialStarted = ensureEntitledOrStartTrial(currentSlug(), today()).trial_started;
  }
  run(
    `UPDATE gym_receptionist_settings SET ${columns.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = 1`,
    columns.map((c) => (body[c] === '' && CLEARABLE.has(c) ? null : body[c])),
  );
  res.json(settingsPayload({ trial_started: trialStarted }));
});

/** Opens Razorpay Checkout for 1, 3, 6 or 12 months at the operator's price. */
trialRoutes.post('/settings/checkout', requireRole(...MANAGES_BILLING), async (req, res, next) => {
  try {
    const body = parse(req.body, { months: { type: 'int', required: true, min: 1, max: 12 } });
    res.status(201).json(await createReceptionistCheckout({ slug: currentSlug(), months: body.months, user: req.user }));
  } catch (err) {
    next(err);
  }
});

/** Checkout's answer, verified before any day is added. */
trialRoutes.post('/settings/verify', requireRole(...MANAGES_BILLING), (req, res) => {
  const { settled } = verifyReceptionistPayment({ slug: currentSlug(), body: req.body, now: today() });
  res.json(settingsPayload({ settled }));
});

/** Who a phone number already is, before the desk files a walk-in: an
 * existing member, or an open lead to reuse. */
trialRoutes.get('/lookup', (req, res) => {
  const lead = openLeadForPhone(req.query.phone);
  res.json({ member: memberWithPhone(req.query.phone), lead: lead ? leadById(lead.id) : null });
});
