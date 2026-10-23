import { config, DEFAULT_TENANT_SLUG } from '../config.js';
import { badRequest, conflict, HttpError, notFound, paymentRequired } from '../errors.js';
import { createOrder, isRazorpayOrdersConfigured, verifyPaymentSignature } from '../razorpay.js';
import { findTenantBySlug, getRegistryDb, listTenants } from '../tenants.js';
import { addDays, addMonths, parse } from '../validate.js';

/**
 * What an institute pays the platform for the WhatsApp admissions assistant
 * (src/coaching/receptionist.js) — the platform's own product, sold to the
 * institute rather than to its students.
 *
 * Prepaid passes, not a recurring mandate: the owner pays for 1, 3, 6 or 12
 * months through Razorpay Checkout (UPI first) and the assistant answers
 * until the last day paid. That needs only the Razorpay key pair — no plan in
 * the Razorpay dashboard — so the operator's price is live the moment it is
 * saved. Every institute gets one free trial, started by switching the
 * assistant on. The operator can also record a UPI or cash payment made
 * outside the app, give months free, set one institute its own price, extend
 * a trial, or end access, all from the console.
 *
 * Everything lives in the registry (platform.db), not the institute's own
 * file: the price and the entitlement are the platform's to decide, and an
 * institute's admin must not be able to edit what they have paid for.
 *
 * Dates are calendar days (YYYY-MM-DD). `paid_until` and `trial_ends_on` are
 * the last day covered, inclusive. Callers inside a tenant pass the
 * institute's own today(); without one, todayIn() works it out from the
 * institute's timezone, so the console and the institute agree on the day.
 */

export const PLAN_MONTHS = [1, 3, 6, 12];
export const PAYMENT_CHANNELS = ['online', 'manual', 'comp'];

const round = (n) => Math.round(Number(n) || 0);
/** Today where the institute is — the same day its own screens call today —
 * for the console, which runs outside any institute's request. */
function todayIn(slug) {
  const timeZone = findTenantBySlug(slug)?.timezone || undefined;
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
  } catch {
    return new Intl.DateTimeFormat('en-CA').format(new Date());
  }
}

/* ── Storage ─────────────────────────────────────────────────────────── */

const initialised = new WeakSet();

function db() {
  const handle = getRegistryDb();
  if (initialised.has(handle)) return handle;
  handle.exec(`
    CREATE TABLE IF NOT EXISTS receptionist_billing_settings (
      id            INTEGER PRIMARY KEY CHECK (id = 1),
      price_monthly REAL NOT NULL DEFAULT 1999 CHECK (price_monthly >= 1),
      trial_days    INTEGER NOT NULL DEFAULT 7 CHECK (trial_days BETWEEN 0 AND 90),
      discount_3m   REAL NOT NULL DEFAULT 5 CHECK (discount_3m BETWEEN 0 AND 90),
      discount_6m   REAL NOT NULL DEFAULT 10 CHECK (discount_6m BETWEEN 0 AND 90),
      discount_12m  REAL NOT NULL DEFAULT 15 CHECK (discount_12m BETWEEN 0 AND 90),
      sales_open    INTEGER NOT NULL DEFAULT 1,
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT OR IGNORE INTO receptionist_billing_settings (id) VALUES (1);

    -- One row per institute that has ever had the assistant: its trial, how
    -- far it has paid, and the operator's own price for it if any.
    CREATE TABLE IF NOT EXISTS receptionist_subscriptions (
      tenant_slug    TEXT PRIMARY KEY,
      price_monthly  REAL CHECK (price_monthly IS NULL OR price_monthly >= 1),
      trial_ends_on  TEXT,
      paid_until     TEXT,
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Every payment, online or recorded by the operator. An online order is
    -- written 'created' when Checkout opens and claimed once, by whichever of
    -- the owner's verify call and Razorpay's webhook lands first.
    CREATE TABLE IF NOT EXISTS receptionist_payments (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_slug         TEXT NOT NULL,
      months              INTEGER NOT NULL CHECK (months > 0),
      amount              REAL NOT NULL CHECK (amount >= 0),
      channel             TEXT NOT NULL CHECK (channel IN ('online', 'manual', 'comp')),
      status              TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'paid')),
      razorpay_order_id   TEXT UNIQUE,
      razorpay_payment_id TEXT,
      period_start        TEXT,
      period_end          TEXT,
      note                TEXT,
      recorded_by         TEXT,
      created_at          TEXT NOT NULL DEFAULT (datetime('now')),
      paid_at             TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_receptionist_payments_tenant ON receptionist_payments(tenant_slug, status);
  `);
  initialised.add(handle);
  return handle;
}

const one = (sql, ...params) => {
  const row = db().prepare(sql).get(...params);
  return row === undefined ? undefined : { ...row };
};
const many = (sql, ...params) => db().prepare(sql).all(...params).map((row) => ({ ...row }));
const exec = (sql, ...params) => db().prepare(sql).run(...params);

/* ── Prices ──────────────────────────────────────────────────────────── */

export const billingSettings = () => one('SELECT * FROM receptionist_billing_settings WHERE id = 1');

const SETTINGS_FIELDS = {
  price_monthly: { type: 'number', min: 1, max: 1000000 },
  trial_days: { type: 'int', min: 0, max: 90 },
  discount_3m: { type: 'number', min: 0, max: 90 },
  discount_6m: { type: 'number', min: 0, max: 90 },
  discount_12m: { type: 'number', min: 0, max: 90 },
  sales_open: { type: 'boolean' },
};

export function updateBillingSettings(payload) {
  const body = parse(payload, SETTINGS_FIELDS);
  const columns = Object.keys(body).filter((c) => body[c] !== null);
  if (!columns.length) throw badRequest('Nothing to update');
  exec(
    `UPDATE receptionist_billing_settings SET ${columns.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = 1`,
    ...columns.map((c) => (c === 'price_monthly' ? round(body[c]) : body[c])),
  );
  return billingSettings();
}

const subscriptionOf = (slug) => one('SELECT * FROM receptionist_subscriptions WHERE tenant_slug = ?', slug);

/** This institute's monthly price: its own if the operator set one. */
export function monthlyPriceFor(slug, settings = billingSettings()) {
  return subscriptionOf(slug)?.price_monthly ?? settings.price_monthly;
}

/** What each prepaid period costs this institute, whole rupees. */
export function offersFor(slug, settings = billingSettings()) {
  const monthly = monthlyPriceFor(slug, settings);
  return PLAN_MONTHS.map((months) => {
    const discount = months === 1 ? 0 : settings[`discount_${months}m`] ?? 0;
    const full = monthly * months;
    const price = round(full * (1 - discount / 100));
    return { months, price, per_month: round(price / months), save_pct: full > price ? Math.round(((full - price) / full) * 100) : 0 };
  });
}

/* ── Entitlement ─────────────────────────────────────────────────────── */

/**
 * Where an institute stands: 'active' (paid through `paid_until`), 'trial',
 * 'expired' (had either, both past) or 'none' (never started).
 */
export function planState(slug, now = todayIn(slug)) {
  const settings = billingSettings();
  const sub = subscriptionOf(slug);
  const paid = sub?.paid_until && sub.paid_until >= now;
  const trial = !paid && sub?.trial_ends_on && sub.trial_ends_on >= now;
  const status = paid ? 'active' : trial ? 'trial' : sub?.paid_until || sub?.trial_ends_on ? 'expired' : 'none';
  const endsOn = paid ? sub.paid_until : trial ? sub.trial_ends_on : null;
  const daysLeft = endsOn ? Math.round((Date.parse(endsOn) - Date.parse(now)) / 86_400_000) + 1 : 0;
  return {
    status,
    ends_on: endsOn,
    days_left: daysLeft,
    trial_ends_on: sub?.trial_ends_on ?? null,
    paid_until: sub?.paid_until ?? null,
    trial_available: !sub?.trial_ends_on && settings.trial_days > 0 && Boolean(settings.sales_open),
    trial_days: settings.trial_days,
    price_monthly: monthlyPriceFor(slug, settings),
    custom_price: sub?.price_monthly != null,
    offers: offersFor(slug, settings),
    sales_open: Boolean(settings.sales_open),
    online_payments: isRazorpayOrdersConfigured(),
  };
}

/** Whether the assistant may answer for this institute today. */
export function receptionistEntitled(slug, now) {
  if (!slug || slug === DEFAULT_TENANT_SLUG) return false;
  return ['active', 'trial'].includes(planState(slug, now ?? todayIn(slug)).status);
}

function upsertSubscription(slug, changes) {
  exec('INSERT OR IGNORE INTO receptionist_subscriptions (tenant_slug) VALUES (?)', slug);
  const columns = Object.keys(changes);
  exec(
    `UPDATE receptionist_subscriptions SET ${columns.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE tenant_slug = ?`,
    ...columns.map((c) => changes[c]),
    slug,
  );
}

/**
 * Called when the owner switches the assistant on: fine if they are covered,
 * starts the one free trial if they never had it, and otherwise refuses with
 * a 402 saying what to do.
 */
export function ensureEntitledOrStartTrial(slug, now = todayIn(slug)) {
  const state = planState(slug, now);
  if (['active', 'trial'].includes(state.status)) return { state, trial_started: false };
  if (state.trial_available) {
    upsertSubscription(slug, { trial_ends_on: addDays(now, state.trial_days - 1) });
    return { state: planState(slug, now), trial_started: true };
  }
  if (state.status === 'expired') {
    throw paymentRequired('Your AI receptionist plan has ended. Renew it to switch the assistant back on.', { code: 'receptionist_plan_ended' });
  }
  throw paymentRequired('Subscribe to the AI receptionist to switch it on.', { code: 'receptionist_plan_required' });
}

/** Adds `months` after whichever is latest of today, the paid-through day
 * and the end of a running trial — paying on day 3 of a trial does not throw
 * the other four days away — and returns the period it covers. */
function extendPaid(slug, months, now) {
  const sub = subscriptionOf(slug);
  const covered = [sub?.paid_until, sub?.trial_ends_on].filter((d) => d && d >= now).sort().at(-1);
  const start = covered ? addDays(covered, 1) : now;
  const end = addDays(addMonths(start, months), -1);
  upsertSubscription(slug, { paid_until: end });
  return { start, end };
}

/* ── Paying online ───────────────────────────────────────────────────── */

const requireCoaching = (slug) => {
  const tenant = slug && slug !== DEFAULT_TENANT_SLUG ? findTenantBySlug(slug) : null;
  if (!tenant || tenant.business_type !== 'coaching') throw notFound('The AI receptionist is part of CoachBook accounts');
  return tenant;
};

/**
 * Opens a Razorpay order for one prepaid period. The amount comes from the
 * operator's price, never the request — the owner only picks the months.
 */
export async function createReceptionistCheckout({ slug, months, user }) {
  const tenant = requireCoaching(slug);
  if (!isRazorpayOrdersConfigured()) throw new HttpError(503, 'Online payments are not set up yet. Contact support to pay by UPI or bank transfer.');
  const settings = billingSettings();
  if (!settings.sales_open) throw badRequest('The AI receptionist is not open for purchase right now. Contact support.');
  const offer = offersFor(slug, settings).find((o) => o.months === Number(months));
  if (!offer) throw badRequest('Pick a plan', { months: `must be one of: ${PLAN_MONTHS.join(', ')}` });

  const order = await createOrder({
    amount: offer.price,
    receipt: `ai-rcpt-${slug}-${Date.now()}`,
    notes: { kind: 'ai_receptionist', tenant_slug: slug, months: String(offer.months) },
  });
  exec(
    "INSERT INTO receptionist_payments (tenant_slug, months, amount, channel, razorpay_order_id, recorded_by) VALUES (?, ?, ?, 'online', ?, ?)",
    slug,
    offer.months,
    offer.price,
    order.id,
    user?.email || null,
  );
  return {
    offer,
    checkout: {
      key_id: config.razorpay.keyId,
      order_id: order.id,
      amount: order.amount,
      currency: order.currency || 'INR',
      name: 'CoachBook',
      description: `AI admissions receptionist · ${offer.months} month${offer.months === 1 ? '' : 's'} · ${tenant.gym_name || slug}`,
      prefill: { name: user?.name || undefined, email: user?.email || undefined },
    },
  };
}

export const findReceptionistPayment = (razorpayOrderId) => one('SELECT * FROM receptionist_payments WHERE razorpay_order_id = ?', razorpayOrderId);

/**
 * Turns a paid order into paid-through days. Idempotent: the claim is one
 * conditional UPDATE, so the verify call and the webhook can both arrive and
 * only one extends the plan. Synchronous throughout, so nothing interleaves.
 */
export function settleReceptionistPayment({ razorpayOrderId, paymentId, now }) {
  const payment = findReceptionistPayment(razorpayOrderId);
  if (!payment) throw notFound('No AI receptionist purchase matches that payment');
  if (payment.status === 'paid') return { payment, settled: false };
  const claimed = exec(
    "UPDATE receptionist_payments SET status = 'paid', razorpay_payment_id = ?, paid_at = datetime('now') WHERE id = ? AND status != 'paid'",
    paymentId,
    payment.id,
  ).changes;
  if (!claimed) return { payment: one('SELECT * FROM receptionist_payments WHERE id = ?', payment.id), settled: false };
  const period = extendPaid(payment.tenant_slug, payment.months, now ?? todayIn(payment.tenant_slug));
  exec('UPDATE receptionist_payments SET period_start = ?, period_end = ? WHERE id = ?', period.start, period.end, payment.id);
  return { payment: one('SELECT * FROM receptionist_payments WHERE id = ?', payment.id), settled: true };
}

/** What the owner's browser reports after Checkout, checked before anything
 * is extended: the signature, and that the order is this institute's own. */
export function verifyReceptionistPayment({ slug, body, now }) {
  const input = parse(body, {
    razorpay_order_id: { type: 'string', required: true, max: 64 },
    razorpay_payment_id: { type: 'string', required: true, max: 64 },
    razorpay_signature: { type: 'string', required: true, max: 256 },
  });
  const payment = findReceptionistPayment(input.razorpay_order_id);
  if (!payment || payment.tenant_slug !== slug) throw notFound('No AI receptionist purchase matches that payment');
  const ok = verifyPaymentSignature({ orderId: input.razorpay_order_id, paymentId: input.razorpay_payment_id, signature: input.razorpay_signature });
  if (!ok) throw badRequest('That payment could not be verified. If money left your account, contact support with the payment ID.');
  return settleReceptionistPayment({ razorpayOrderId: input.razorpay_order_id, paymentId: input.razorpay_payment_id, now });
}

/* ── The operator ────────────────────────────────────────────────────── */

/** A payment made outside the app (UPI to the operator, cash, bank
 * transfer), or months given free ('comp', amount 0). */
export function recordManualPayment(slug, payload, { by }) {
  requireCoaching(slug);
  const body = parse(payload, {
    months: { type: 'int', required: true, min: 1, max: 36 },
    amount: { type: 'number', min: 0, max: 10000000 },
    channel: { type: 'enum', values: ['manual', 'comp'], default: 'manual' },
    note: { type: 'string', max: 300 },
  });
  if (body.channel === 'manual' && !(body.amount > 0)) throw badRequest('Enter the amount received, or record it as free months', { amount: 'required' });
  const now = todayIn(slug);
  const period = extendPaid(slug, body.months, now);
  exec(
    `INSERT INTO receptionist_payments (tenant_slug, months, amount, channel, status, period_start, period_end, note, recorded_by, paid_at)
     VALUES (?, ?, ?, ?, 'paid', ?, ?, ?, ?, datetime('now'))`,
    slug,
    body.months,
    body.channel === 'comp' ? 0 : round(body.amount),
    body.channel,
    period.start,
    period.end,
    body.note ?? null,
    by,
  );
  return planState(slug, now);
}

/** The operator's per-institute levers: its own price (null for the
 * default), more trial days, or ending access today. */
export function adjustSubscription(slug, payload) {
  requireCoaching(slug);
  const body = parse(payload, {
    price_monthly: { type: 'number', min: 1, max: 1000000 },
    extend_trial_days: { type: 'int', min: 1, max: 90 },
    end_access: { type: 'boolean' },
  });
  const now = todayIn(slug);
  if ('price_monthly' in (payload || {})) upsertSubscription(slug, { price_monthly: body.price_monthly == null ? null : round(body.price_monthly) });
  if (body.extend_trial_days) {
    const sub = subscriptionOf(slug);
    const from = sub?.trial_ends_on && sub.trial_ends_on >= now ? sub.trial_ends_on : addDays(now, -1);
    upsertSubscription(slug, { trial_ends_on: addDays(from, body.extend_trial_days) });
  }
  if (body.end_access) {
    const yesterday = addDays(now, -1);
    const sub = subscriptionOf(slug);
    if (!sub) throw conflict('This institute has never had the AI receptionist');
    upsertSubscription(slug, {
      paid_until: sub.paid_until && sub.paid_until > yesterday ? yesterday : sub.paid_until,
      trial_ends_on: sub.trial_ends_on && sub.trial_ends_on > yesterday ? yesterday : sub.trial_ends_on,
    });
  }
  return planState(slug, now);
}

/** Every CoachBook institute with where its plan stands and what it paid. */
export function listReceptionistAccounts() {
  const revenue = new Map(
    many("SELECT tenant_slug, SUM(amount) AS total, MAX(paid_at) AS last_paid_at FROM receptionist_payments WHERE status = 'paid' GROUP BY tenant_slug").map((r) => [
      r.tenant_slug,
      r,
    ]),
  );
  return listTenants()
    .filter((t) => t.business_type === 'coaching' && t.status !== 'cancelled')
    .map((t) => ({
      slug: t.slug,
      name: t.gym_name || t.display_name || t.slug,
      account_status: t.status,
      plan: planState(t.slug),
      revenue: revenue.get(t.slug)?.total ?? 0,
      last_paid_at: revenue.get(t.slug)?.last_paid_at ?? null,
    }));
}

export function receptionistSummary() {
  const accounts = listReceptionistAccounts();
  const now = new Intl.DateTimeFormat('en-CA').format(new Date());
  const month = `${now.slice(0, 7)}-01`;
  const paidIn = (from) =>
    one("SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS n FROM receptionist_payments WHERE status = 'paid' AND paid_at >= ?", from);
  return {
    paying: accounts.filter((a) => a.plan.status === 'active').length,
    on_trial: accounts.filter((a) => a.plan.status === 'trial').length,
    expired: accounts.filter((a) => a.plan.status === 'expired').length,
    // What the paying institutes are worth a month at their current prices.
    monthly_run_rate: accounts.filter((a) => a.plan.status === 'active').reduce((sum, a) => sum + a.plan.price_monthly, 0),
    revenue_month: paidIn(month).total,
    revenue_total: paidIn('0000-01-01').total,
  };
}

export const recentReceptionistPayments = (limit = 50) =>
  many("SELECT * FROM receptionist_payments WHERE status = 'paid' ORDER BY paid_at DESC, id DESC LIMIT ?", limit);
