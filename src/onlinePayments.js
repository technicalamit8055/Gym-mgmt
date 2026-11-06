import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { collectPayment, getPlan } from './coaching/fees.js';
import { all, get, getBusinessType, run, tenantStorage, tx } from './db.js';
import { badRequest, conflict, notFound } from './errors.js';
import { membershipPrice, sellMembership } from './memberships.js';
import { notifyMember } from './notifications.js';
import { DEFAULT_TENANT_SLUG } from './config.js';
import { tenantPublicUrl, tenantUrl } from './tenant.js';
import { today } from './validate.js';
import { getWhatsAppStatus, sendWhatsAppMessage } from './whatsapp.js';

/**
 * Members paying online, to the gym's (or institute's) own UPI ID.
 *
 * A member asks to pay one thing — a membership plan, the dues on a
 * membership, or a CoachBook fee installment. The server fixes the amount and
 * gives the request a short reference (GB7K4Q2M) that rides along in the UPI
 * note. The member pays in their UPI app, comes back and says so ("claimed"),
 * optionally with the 12-digit UTR their app shows. The desk then confirms it
 * against the gym's bank or UPI app, and only that creates the real
 * membership / payment — so tapping "I've paid" grants nothing by itself.
 *
 * A plain UPI ID has no callback to tell us the money arrived; that is what
 * gateway 'razorpay_route' (later) adds. Every function here runs against the
 * current tenant's database, like the rest of src/.
 */

export const REQUEST_KINDS = ['membership', 'dues', 'fee_installment'];
const OPEN_STATUSES = ['pending', 'claimed'];
/** An unpaid request stops being payable after this long; a claimed one waits for the desk. */
const REQUEST_TTL_HOURS = 48;
const EPSILON = 0.005;
const REF_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
/** name@handle — what every UPI app accepts as a payee address. */
const VPA_RE = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z][a-zA-Z0-9.\-]{1,63}$/;
const UTR_RE = /^\d{12}$/;

/* ── Settings ────────────────────────────────────────────────────────── */

export function getPaymentSettings() {
  return get('SELECT * FROM payment_settings WHERE id = 1') ?? { id: 1, enabled: 0, gateway: 'upi', pay_link_in_reminders: 1 };
}

/** Whether members can pay right now: switched on and a UPI ID to pay. */
export function onlinePaymentsLive(settings = getPaymentSettings()) {
  return Boolean(settings.enabled && settings.gateway === 'upi' && settings.upi_vpa);
}

export function savePaymentSettings(patch) {
  const current = getPaymentSettings();
  const next = { ...current };
  if (patch.upi_vpa !== undefined) {
    const vpa = String(patch.upi_vpa ?? '').trim();
    if (vpa && !VPA_RE.test(vpa)) {
      throw badRequest('That does not look like a UPI ID — it should look like yourgym@okaxis', { upi_vpa: 'invalid UPI ID' });
    }
    next.upi_vpa = vpa || null;
  }
  if (patch.payee_name !== undefined) next.payee_name = String(patch.payee_name ?? '').trim().slice(0, 60) || null;
  if (patch.alert_phone !== undefined) next.alert_phone = String(patch.alert_phone ?? '').trim().slice(0, 20) || null;
  if (patch.pay_link_in_reminders !== undefined) next.pay_link_in_reminders = patch.pay_link_in_reminders ? 1 : 0;
  if (patch.enabled !== undefined) next.enabled = patch.enabled ? 1 : 0;
  if (next.enabled && !next.upi_vpa) {
    throw badRequest('Enter the UPI ID members should pay before switching online payments on', { upi_vpa: 'is required' });
  }
  run(
    `UPDATE payment_settings SET enabled = ?, upi_vpa = ?, payee_name = ?, alert_phone = ?, pay_link_in_reminders = ?,
       updated_at = datetime('now') WHERE id = 1`,
    [next.enabled, next.upi_vpa ?? null, next.payee_name ?? null, next.alert_phone ?? null, next.pay_link_in_reminders],
  );
  return getPaymentSettings();
}

/* ── The UPI link ────────────────────────────────────────────────────── */

/**
 * upi://pay?… — the intent every Indian UPI app answers (NPCI's deep-link
 * spec). Opened on Android it offers the member's UPI apps with the payee,
 * amount and note already filled in; drawn as a QR, any UPI app scans it.
 */
export function upiUri(request, settings, payeeFallback = '') {
  const params = new URLSearchParams({
    pa: settings.upi_vpa,
    pn: (settings.payee_name || payeeFallback || 'Gym').slice(0, 50),
    am: Number(request.amount).toFixed(2),
    cu: 'INR',
    tn: `${request.ref_code} ${request.title || ''}`.trim().slice(0, 50),
    tr: request.ref_code,
  });
  // URLSearchParams writes spaces as "+", which some UPI apps show literally,
  // and "@" as %40, which some fail to decode in the payee address.
  return `upi://pay?${params.toString().replace(/\+/g, '%20').replace(/%40/g, '@')}`;
}

export function upiQrDataUrl(uri) {
  return QRCode.toDataURL(uri, { errorCorrectionLevel: 'M', margin: 1, width: 360 });
}

/** The pay page's address, for a WhatsApp message — null when the server
 * cannot know its own public address (no ROOT_DOMAIN in development). */
export function payLinkFor(request, baseUrl = tenantPublicUrl(tenantStorage.getStore()?.slug)) {
  if (!baseUrl || !request) return null;
  return `${baseUrl.replace(/\/$/, '')}/#/pay?token=${request.token}`;
}

/** The gym's address as this request reached it — for links sent from a staff action. */
export function baseUrlFor(req) {
  const slug = req.tenant?.slug;
  if (!slug || slug === DEFAULT_TENANT_SLUG) return `${req.protocol}://${req.get('host')}`;
  return tenantUrl(req, slug);
}

/**
 * The pay link a reminder carries, or null (online payments off, the link
 * switched off for reminders, nothing payable, no known public address).
 */
export function reminderPayLink({ memberId, planId = null, installmentId = null, baseUrl } = {}) {
  const request = reminderRequest({ memberId, planId, installmentId });
  return request ? payLinkFor(request, baseUrl === undefined ? tenantPublicUrl(tenantStorage.getStore()?.slug) : baseUrl) : null;
}

/**
 * Puts the pay link into a reminder: where the template asks for it with
 * {{pay_link}}, or as a last line when the template predates the
 * placeholder. Without a link the placeholder simply disappears.
 */
export function withPayLink(message, payLink) {
  const text = String(message ?? '');
  const hasPlaceholder = /\{\{\s*pay_link\s*\}\}/.test(text);
  if (hasPlaceholder) return text.replace(/\{\{\s*pay_link\s*\}\}/g, payLink || '').replace(/[ \t]+\n/g, '\n').trimEnd();
  return payLink ? `${text}\n\nPay online: ${payLink}` : text;
}

/* ── Requests ────────────────────────────────────────────────────────── */

function newRefCode() {
  for (;;) {
    let code = 'GB';
    for (let i = 0; i < 6; i++) code += REF_ALPHABET[crypto.randomInt(REF_ALPHABET.length)];
    if (!get('SELECT 1 FROM payment_requests WHERE ref_code = ?', [code])) return code;
  }
}

const REQUEST_SELECT = `
  SELECT r.*, m.code AS member_code, m.first_name, m.last_name, m.phone,
         p.name AS plan_name, u.name AS decided_by_name
  FROM payment_requests r
  JOIN members m ON m.id = r.member_id
  LEFT JOIN plans p ON p.id = r.plan_id
  LEFT JOIN users u ON u.id = r.decided_by
`;

/** A request as the apps show it, with a human title for what it pays. */
function present(row) {
  if (!row) return row;
  const expired = row.status === 'pending' && row.expires_at < utcNow();
  const status = expired ? 'expired' : row.status;
  return { ...row, status, title: titleFor(row) };
}

function titleFor(row) {
  if (row.kind === 'membership') return `${row.plan_name || 'Membership'} renewal`;
  if (row.kind === 'dues') return `Dues${row.plan_name ? ` on ${row.plan_name}` : ''}`;
  const inst = row.installment_id ? get('SELECT installment_number FROM student_fee_installments WHERE id = ?', [row.installment_id]) : null;
  return inst ? `Fee installment ${inst.installment_number}` : 'Fee installment';
}

const utcNow = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const hoursFromNow = (h) => new Date(Date.now() + h * 3600_000).toISOString().replace('T', ' ').slice(0, 19);

export function getRequest(id) {
  return present(get(`${REQUEST_SELECT} WHERE r.id = ?`, [id]));
}

export function getRequestByToken(token) {
  if (!token || typeof token !== 'string' || token.length > 80) return null;
  return present(get(`${REQUEST_SELECT} WHERE r.token = ?`, [token]));
}

export function listRequests({ status = 'claimed', memberId = null, limit = 100 } = {}) {
  const where = [];
  const params = [];
  if (status && status !== 'all') {
    where.push('r.status = ?');
    params.push(status);
  }
  if (memberId) {
    where.push('r.member_id = ?');
    params.push(memberId);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return all(`${REQUEST_SELECT} ${clause} ORDER BY COALESCE(r.claimed_at, r.created_at) DESC, r.id DESC LIMIT ?`, [...params, limit]).map(present);
}

export function claimedCount() {
  return get("SELECT COUNT(*) AS n FROM payment_requests WHERE status = 'claimed'")?.n ?? 0;
}

/** What a gym membership still owes: billed (price - discount + add-ons) minus paid. */
function subscriptionDue(subscriptionId) {
  const row = get(
    `SELECT s.*, (s.price - s.discount + s.addon_total) - COALESCE((SELECT SUM(amount) FROM payments WHERE subscription_id = s.id), 0) AS due
     FROM subscriptions s WHERE s.id = ?`,
    [subscriptionId],
  );
  return row;
}

/** Every membership of this member with money still owed on it, oldest first. */
export function duesFor(memberId) {
  return all(
    `SELECT s.id AS subscription_id, s.plan_id, p.name AS plan_name, s.start_date, s.end_date,
            ROUND((s.price - s.discount + s.addon_total) - COALESCE((SELECT SUM(amount) FROM payments WHERE subscription_id = s.id), 0), 2) AS due
     FROM subscriptions s JOIN plans p ON p.id = s.plan_id
     WHERE s.member_id = ? AND s.status != 'cancelled'
       AND (s.price - s.discount + s.addon_total) - COALESCE((SELECT SUM(amount) FROM payments WHERE subscription_id = s.id), 0) > ?
     ORDER BY s.start_date, s.id`,
    [memberId, EPSILON],
  );
}

/**
 * Starts (or re-opens) a payment. The amount always comes from the server's
 * own data — whatever the app sends is ignored. Asking to pay the same thing
 * again while a request is still open returns that request, so a member
 * double-tapping "Pay" cannot end up with two.
 */
export function createRequest({ memberId, kind, planId = null, subscriptionId = null, installmentId = null }) {
  const settings = getPaymentSettings();
  if (!onlinePaymentsLive(settings)) throw badRequest('Online payments are not switched on here — please pay at the front desk');
  if (!REQUEST_KINDS.includes(kind)) throw badRequest('Unknown payment type', { kind: 'invalid' });
  const member = get('SELECT * FROM members WHERE id = ?', [memberId]);
  if (!member) throw notFound('Member not found');

  let amount;
  const target = { plan_id: null, subscription_id: null, fee_plan_id: null, installment_id: null };

  if (kind === 'membership') {
    if (getBusinessType() === 'coaching') throw badRequest('Pay your fee installments from the Fees tab');
    const plan = planId ? get('SELECT * FROM plans WHERE id = ?', [planId]) : null;
    if (!plan || !plan.active) throw notFound('That plan is not on sale');
    const session = plan.session_id != null ? get('SELECT * FROM sessions WHERE id = ?', [plan.session_id]) : null;
    amount = membershipPrice(plan, session);
    target.plan_id = plan.id;
  } else if (kind === 'dues') {
    const sub = subscriptionId ? subscriptionDue(subscriptionId) : null;
    if (!sub || sub.member_id !== memberId || sub.status === 'cancelled') throw notFound('Membership not found');
    if (!(sub.due > EPSILON)) throw badRequest('Nothing is owed on this membership');
    amount = sub.due;
    target.subscription_id = sub.id;
    target.plan_id = sub.plan_id;
  } else {
    const inst = installmentId ? get('SELECT * FROM student_fee_installments WHERE id = ?', [installmentId]) : null;
    const plan = inst ? getPlan(inst.plan_id) : null;
    if (!plan || plan.member_id !== memberId) throw notFound('Installment not found');
    if (plan.status === 'cancelled') throw badRequest('This fee plan is cancelled');
    const row = plan.installments.find((i) => i.id === inst.id);
    if (!row || !(row.balance > EPSILON)) throw badRequest('That installment is already paid');
    amount = row.balance;
    target.fee_plan_id = plan.id;
    target.installment_id = inst.id;
  }
  amount = Math.round(amount * 100) / 100;
  if (!(amount > 0)) throw badRequest('There is nothing to pay');

  const open = get(
    `SELECT id FROM payment_requests
     WHERE member_id = ? AND kind = ? AND plan_id IS ? AND subscription_id IS ? AND installment_id IS ?
       AND (status = 'claimed' OR (status = 'pending' AND expires_at > ?)) AND amount = ?
     ORDER BY id DESC LIMIT 1`,
    [memberId, kind, target.plan_id, target.subscription_id, target.installment_id, utcNow(), amount],
  );
  if (open) return getRequest(open.id);

  const info = run(
    `INSERT INTO payment_requests (token, ref_code, member_id, kind, plan_id, subscription_id, fee_plan_id, installment_id, amount, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      crypto.randomBytes(24).toString('base64url'),
      newRefCode(),
      memberId,
      kind,
      target.plan_id,
      target.subscription_id,
      target.fee_plan_id,
      target.installment_id,
      amount,
      hoursFromNow(REQUEST_TTL_HOURS),
    ],
  );
  return getRequest(Number(info.lastInsertRowid));
}

/** The member says they paid. The UTR is optional but, given, must be one transfer's. */
export function claimRequest(id, { utr = null } = {}) {
  const request = getRequest(id);
  if (!request) throw notFound('Payment not found');
  if (request.status === 'claimed' || request.status === 'confirmed') return request;
  if (request.status !== 'pending') throw conflict(`This payment is ${request.status} — start a new one`);
  const clean = utr ? String(utr).replace(/\s+/g, '') : null;
  if (clean && !UTR_RE.test(clean)) {
    throw badRequest('The UPI reference (UTR) is the 12-digit number in your UPI app', { utr: 'must be 12 digits' });
  }
  if (clean && get("SELECT 1 FROM payment_requests WHERE utr = ? AND status IN ('claimed', 'confirmed') AND id != ?", [clean, id])) {
    throw conflict('That UPI reference has already been used for another payment', { utr: 'already used' });
  }
  run("UPDATE payment_requests SET status = 'claimed', utr = ?, claimed_at = datetime('now') WHERE id = ? AND status = 'pending'", [clean, id]);
  const claimed = getRequest(id);
  alertDesk(claimed).catch((err) => console.error('[payments] desk alert failed:', err.message));
  return claimed;
}

/**
 * The desk saw the money arrive. Creates what was paid for — the membership,
 * the payment on the dues, or the fee payment split across installments —
 * and links it to the request, all in one transaction. Confirming twice is
 * harmless: the second call finds the request already confirmed.
 */
export function confirmRequest(id, { userId = null } = {}) {
  const request = getRequest(id);
  if (!request) throw notFound('Payment not found');
  if (request.status === 'confirmed') return { request, paymentId: request.payment_id, already: true };
  if (!OPEN_STATUSES.includes(request.status) && request.status !== 'expired') {
    throw conflict(`This payment was ${request.status} and cannot be confirmed`);
  }
  const reference = request.utr ? `UPI ${request.utr}` : `UPI ${request.ref_code}`;
  const note = `Paid online · ref ${request.ref_code}`;

  const paymentId = tx(() => {
    let pid;
    if (request.kind === 'membership') {
      ({ paymentId: pid } = sellMembership({
        memberId: request.member_id,
        planId: request.plan_id,
        payment: { amount: request.amount, method: 'upi', reference, note },
      }));
    } else if (request.kind === 'dues') {
      const sub = subscriptionDue(request.subscription_id);
      if (!sub) throw notFound('That membership no longer exists');
      const info = run('INSERT INTO payments (member_id, subscription_id, amount, method, paid_on, reference, note) VALUES (?, ?, ?, ?, ?, ?, ?)', [
        request.member_id,
        sub.id,
        request.amount,
        'upi',
        today(),
        reference,
        note,
      ]);
      pid = Number(info.lastInsertRowid);
    } else {
      ({ payment_id: pid } = collectPayment(request.fee_plan_id, {
        amount: request.amount,
        method: 'upi',
        reference,
        note,
        installment_id: request.installment_id,
      }));
    }
    run("UPDATE payment_requests SET status = 'confirmed', decided_by = ?, decided_at = datetime('now'), payment_id = ? WHERE id = ?", [userId, pid, id]);
    return pid;
  });

  const confirmed = getRequest(id);
  notifyMember(request.member_id, {
    category: 'membership',
    title: 'Payment received ✅',
    body: `Your ${money(request.amount)} payment for ${confirmed.title.toLowerCase()} is confirmed. Thank you!`,
    screen: 'pay',
    dedupeKey: `payreq-${id}-confirmed`,
  }).catch(() => {});
  return { request: confirmed, paymentId, already: false };
}

export function rejectRequest(id, { userId = null, reason = '' } = {}) {
  const request = getRequest(id);
  if (!request) throw notFound('Payment not found');
  if (request.status === 'rejected') return request;
  if (request.status === 'confirmed') throw conflict('This payment is already confirmed — delete the payment from billing instead');
  const why = String(reason || '').trim().slice(0, 200) || null;
  run("UPDATE payment_requests SET status = 'rejected', decided_by = ?, decided_at = datetime('now'), reject_reason = ? WHERE id = ?", [userId, why, id]);
  notifyMember(request.member_id, {
    category: 'membership',
    title: 'Payment not found',
    body: `We couldn't find your ${money(request.amount)} payment (ref ${request.ref_code}).${why ? ` ${why}` : ''} Please contact the front desk.`,
    screen: 'pay',
    dedupeKey: `payreq-${id}-rejected`,
  }).catch(() => {});
  return getRequest(id);
}

/** Unpaid requests past their time stop being payable. Claimed ones wait for the desk. */
export function expireStaleRequests() {
  return run("UPDATE payment_requests SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?", [utcNow()]).changes;
}

/**
 * The open request a reminder should link to — reused when there is one, so
 * a reminder every day does not leave a trail of requests behind. Null when
 * online payments are off, or the reminder should not carry a link.
 */
export function reminderRequest({ memberId, planId = null, installmentId = null }) {
  const settings = getPaymentSettings();
  if (!onlinePaymentsLive(settings) || !settings.pay_link_in_reminders) return null;
  try {
    return installmentId
      ? createRequest({ memberId, kind: 'fee_installment', installmentId })
      : createRequest({ memberId, kind: 'membership', planId });
  } catch {
    // An archived plan, a fully paid installment: no link, the reminder still goes.
    return null;
  }
}

/* ── Telling the desk ────────────────────────────────────────────────── */

const money = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

async function alertDesk(request) {
  const settings = getPaymentSettings();
  if (!settings.alert_phone || !getWhatsAppStatus().connected) return;
  const name = [request.first_name, request.last_name].filter(Boolean).join(' ');
  const message = [
    `💸 *Payment to confirm:* ${money(request.amount)} from *${name}* (${request.member_code}) for ${request.title.toLowerCase()}.`,
    `Ref: ${request.ref_code}${request.utr ? ` · UTR: ${request.utr}` : ''}`,
    'Check your UPI app, then confirm it in Billing → To confirm.',
  ].join('\n');
  await sendWhatsAppMessage({ phone: settings.alert_phone, message, type: 'custom' });
}

/** The pieces a pay sheet draws: link, QR, payee. */
export async function paySheet(request, { gymName = '' } = {}) {
  const settings = getPaymentSettings();
  const payable = request.status === 'pending' && onlinePaymentsLive(settings);
  const uri = payable ? upiUri(request, settings, gymName) : null;
  return {
    id: request.id,
    ref_code: request.ref_code,
    kind: request.kind,
    title: request.title,
    amount: request.amount,
    status: request.status,
    utr: request.utr,
    reject_reason: request.reject_reason,
    created_at: request.created_at,
    claimed_at: request.claimed_at,
    expires_at: request.expires_at,
    payee_name: settings.payee_name || gymName,
    upi_vpa: payable ? settings.upi_vpa : null,
    upi_uri: uri,
    qr: uri ? await upiQrDataUrl(uri) : null,
  };
}
