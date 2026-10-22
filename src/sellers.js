import crypto from 'node:crypto';
import { hashPassword, issueSellerToken, verifyPassword } from './auth.js';
import { DEFAULT_TENANT_SLUG } from './config.js';
import { badRequest, conflict, forbidden, notFound, unauthorized } from './errors.js';
import {
  deleteStoreProduct,
  monetizationSettings,
  shopRates,
  STORE_VERTICALS,
  storeRegistry,
  storeVerticalOf,
  storeVerticalOfType,
} from './monetization.js';
import { findTenantBySlug, listTenants } from './tenants.js';
import { parse } from './validate.js';

/**
 * Partner shops: local supplement stores that sell to the members of the gyms
 * around them, each through its own Shop panel (#/seller) instead of the
 * operator console.
 *
 * The operator adds a shop, sets the platform's fee on its sales and assigns
 * it the gyms of its area. From then on those gyms' members see that shop's
 * shelf (monetization.js → catalogFor) and every order they place lands in
 * the shop's panel to pack and ship. The platform still takes the payment;
 * the gym still gets its commission; the shop is owed the rest, less the fee,
 * once the order is delivered.
 *
 * A shop sees only its own products, its own orders and its own money — never
 * another shop's, never a gym's members, never the console.
 *
 * A shop sells in one store (`vertical`): a supplement shop serves gyms, a
 * bookshop serves coaching institutes. Its products land in that store, and
 * it can only be given tenants that shop there.
 */

const { one, many, exec, tx } = storeRegistry;
const round2 = (n) => Math.round(Number(n) * 100) / 100;

const SELLER_FIELDS = {
  name: { type: 'string', min: 2, max: 80 },
  owner_name: { type: 'string', min: 2, max: 80 },
  email: { type: 'email' },
  phone: { type: 'string', min: 10, max: 20 },
  city: { type: 'string', min: 2, max: 60 },
  area: { type: 'string', max: 80 },
  address: { type: 'string', max: 300 },
  gstin: { type: 'string', max: 20 },
  platform_fee_pct: { type: 'number', min: 0, max: 60 },
  // Null (or left out) follows the platform-wide gym rate; 0 turns it off.
  gym_commission_pct: { type: 'number', min: 0, max: 50 },
  owned: { type: 'boolean' },
  active: { type: 'boolean' },
  vertical: { type: 'enum', values: STORE_VERTICALS },
};
// What a shop may change about itself. Its name, login, city and fee are the
// operator's — they decide what members see and what the shop is paid.
const PROFILE_FIELDS = {
  phone: SELLER_FIELDS.phone,
  address: SELLER_FIELDS.address,
  gstin: SELLER_FIELDS.gstin,
  delivery_eta: { type: 'string', max: 60 },
  pickup_eta: { type: 'string', max: 60 },
};
const OPTIONAL = ['area', 'address', 'gstin', 'delivery_eta', 'pickup_eta', 'gym_commission_pct'];

/** Easy to read out over the phone: no 0/O, 1/l/I. */
const PASSWORD_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
function temporaryPassword() {
  const bytes = crypto.randomBytes(10);
  const chars = [...bytes].map((b) => PASSWORD_ALPHABET[b % PASSWORD_ALPHABET.length]).join('');
  return `${chars.slice(0, 5)}-${chars.slice(5)}`;
}

function assertPhone(phone) {
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 12) throw badRequest('Enter a valid 10-digit phone number', { phone: 'must be a 10-digit number' });
}

function gymLabel(slug) {
  const tenant = slug === DEFAULT_TENANT_SLUG ? null : findTenantBySlug(slug);
  return { slug, gym_name: tenant?.gym_name || tenant?.display_name || slug, city: tenant?.city ?? null };
}

/** Money and workload for one shop, or for every shop at once. */
function statsFor(sellerId) {
  const where = sellerId === undefined ? '' : 'AND seller_id = ?';
  const params = sellerId === undefined ? [] : [sellerId];
  return many(
    `SELECT seller_id,
            COUNT(*) AS orders,
            COUNT(CASE WHEN fulfillment_status IN ('placed', 'packed') THEN 1 END) AS to_ship,
            COUNT(CASE WHEN fulfillment_status IN ('shipped', 'ready') THEN 1 END) AS in_transit,
            COALESCE(SUM(CASE WHEN fulfillment_status != 'cancelled' THEN total_amount END), 0) AS gmv,
            COALESCE(SUM(CASE WHEN fulfillment_status NOT IN ('delivered', 'cancelled') THEN seller_amount END), 0) AS pending,
            COALESCE(SUM(CASE WHEN fulfillment_status = 'delivered' AND seller_paid_at IS NULL THEN seller_amount END), 0) AS payable,
            COALESCE(SUM(CASE WHEN seller_paid_at IS NOT NULL THEN seller_amount END), 0) AS paid
     FROM store_orders WHERE seller_id IS NOT NULL AND payment_status = 'paid' ${where}
     GROUP BY seller_id`,
    ...params,
  );
}

const EMPTY_STATS = { orders: 0, to_ship: 0, in_transit: 0, gmv: 0, pending: 0, payable: 0, paid: 0 };

function present(row, stats, settings = monetizationSettings()) {
  if (!row) return row;
  const { password_hash: _hash, ...seller } = row;
  const products = one(
    'SELECT COUNT(*) AS total, COUNT(CASE WHEN active = 1 THEN 1 END) AS active FROM store_products WHERE seller_id = ?',
    row.id,
  );
  const s = stats ?? statsFor(row.id)[0] ?? EMPTY_STATS;
  return {
    ...seller,
    active: Boolean(seller.active),
    owned: Boolean(seller.owned),
    // The rates its next order will carry, after its store's defaults.
    rates: shopRates(row, settings, row.vertical),
    must_change_password: Boolean(seller.must_change_password),
    gyms: many('SELECT tenant_slug FROM store_seller_gyms WHERE seller_id = ? ORDER BY tenant_slug', row.id).map((g) => gymLabel(g.tenant_slug)),
    products,
    stats: Object.fromEntries(Object.entries({ ...EMPTY_STATS, ...s }).filter(([k]) => k !== 'seller_id').map(([k, v]) => [k, round2(v)])),
  };
}

function sellerRow(id) {
  const row = one('SELECT * FROM store_sellers WHERE id = ?', id);
  if (!row) throw notFound('Shop not found');
  return row;
}

/* ── Operator: shop accounts ──────────────────────────────────────────── */

export function listSellers() {
  const stats = new Map(statsFor().map((s) => [s.seller_id, s]));
  const settings = monetizationSettings();
  return many('SELECT * FROM store_sellers ORDER BY owned DESC, active DESC, name COLLATE NOCASE').map((row) =>
    present(row, stats.get(row.id) ?? EMPTY_STATS, settings),
  );
}

export function getSeller(id) {
  return present(sellerRow(id));
}

/**
 * Every gym on the platform with the shop that serves it, if any — the
 * operator's picker for a shop's area.
 */
export function sellerGymOptions() {
  const served = new Map(
    many('SELECT g.tenant_slug, s.id, s.name FROM store_seller_gyms g JOIN store_sellers s ON s.id = g.seller_id').map((r) => [
      r.tenant_slug,
      { id: r.id, name: r.name },
    ]),
  );
  return listTenants()
    .filter((t) => t.status !== 'cancelled')
    .map((t) => ({
      slug: t.slug,
      gym_name: t.gym_name || t.display_name || t.slug,
      city: t.city ?? null,
      pincode: t.pincode ?? null,
      business_type: t.business_type ?? 'gym',
      vertical: storeVerticalOfType(t.business_type),
      seller: served.get(t.slug) ?? null,
    }));
}

/**
 * Replaces the set of gyms a shop serves. A gym another shop was serving
 * moves to this one — a gym has one shelf — and the response says which, so
 * the console can tell the operator. Every one must shop in the shop's own
 * store: a bookshop cannot be handed a gym, nor a supplement shop an institute.
 */
function writeSellerGyms(sellerId, raw, vertical) {
  if (!Array.isArray(raw)) throw badRequest('Gyms must be a list', { gyms: 'must be a list' });
  const slugs = [...new Set(raw.map((s) => String(s).trim().toLowerCase()).filter(Boolean))];
  if (slugs.length > 500) throw badRequest('At most 500 gyms per shop', { gyms: 'at most 500' });
  for (const slug of slugs) {
    if (slug !== DEFAULT_TENANT_SLUG && !findTenantBySlug(slug)) throw badRequest(`No gym found for "${slug}"`, { gyms: `unknown gym ${slug}` });
    if (storeVerticalOf(slug) !== vertical) {
      const { gym_name: name } = gymLabel(slug);
      throw badRequest(
        vertical === 'coaching' ? `${name} is not a coaching institute — a bookshop serves institutes only` : `${name} is a coaching institute — it shops in the coaching store`,
        { gyms: `${slug} is in the other store` },
      );
    }
  }
  const moved = slugs
    .map((slug) => ({ slug, from: one('SELECT seller_id FROM store_seller_gyms WHERE tenant_slug = ? AND seller_id != ?', slug, sellerId) }))
    .filter((m) => m.from)
    .map((m) => ({ ...gymLabel(m.slug), from_seller_id: m.from.seller_id }));
  exec('DELETE FROM store_seller_gyms WHERE seller_id = ?', sellerId);
  for (const slug of slugs) {
    exec(
      `INSERT INTO store_seller_gyms (tenant_slug, seller_id) VALUES (?, ?)
       ON CONFLICT (tenant_slug) DO UPDATE SET seller_id = excluded.seller_id, created_at = datetime('now')`,
      slug,
      sellerId,
    );
  }
  return moved;
}

/** Creates the shop and its login. The temporary password is returned once,
 * for the operator to hand over; only its hash is kept. */
export function createSeller(payload) {
  const body = parse(payload, {
    ...SELLER_FIELDS,
    name: { ...SELLER_FIELDS.name, required: true },
    owner_name: { ...SELLER_FIELDS.owner_name, required: true },
    email: { ...SELLER_FIELDS.email, required: true },
    phone: { ...SELLER_FIELDS.phone, required: true },
    city: { ...SELLER_FIELDS.city, required: true },
    platform_fee_pct: { ...SELLER_FIELDS.platform_fee_pct, default: 10 },
    owned: { ...SELLER_FIELDS.owned, default: 0 },
    vertical: { ...SELLER_FIELDS.vertical, default: 'gym' },
  });
  // Your own dark store starts with nothing taken off its orders: no platform
  // fee (see shopRates), and no gym cut unless one is set explicitly.
  const explicitGymPct = payload && Object.hasOwn(payload, 'gym_commission_pct');
  const gymPct = explicitGymPct ? body.gym_commission_pct : body.owned ? 0 : null;
  assertPhone(body.phone);
  if (one('SELECT id FROM store_sellers WHERE email = ?', body.email)) {
    throw conflict('A shop already signs in with that email');
  }
  const password = temporaryPassword();
  return tx(() => {
    const info = exec(
      `INSERT INTO store_sellers (name, owner_name, email, phone, city, area, address, gstin, platform_fee_pct, owned,
                                  gym_commission_pct, password_hash, vertical)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      body.name,
      body.owner_name,
      body.email,
      body.phone,
      body.city,
      body.area || null,
      body.address || null,
      body.gstin || null,
      body.platform_fee_pct,
      body.owned,
      gymPct ?? null,
      hashPassword(password),
      body.vertical,
    );
    const id = Number(info.lastInsertRowid);
    const moved = payload?.gyms !== undefined ? writeSellerGyms(id, payload.gyms, body.vertical) : [];
    return { seller: getSeller(id), password, moved };
  });
}

export function updateSeller(id, payload) {
  const current = sellerRow(id);
  const body = parse(payload, SELLER_FIELDS);
  const sets = {};
  for (const [key, value] of Object.entries(body)) {
    if (value === null || value === '') {
      if (OPTIONAL.includes(key)) sets[key] = null;
      continue;
    }
    sets[key] = value;
  }
  if (sets.phone) assertPhone(sets.phone);
  // A partner shop that is still owed money cannot become your own store —
  // own stores have no payouts, so those orders would never be settled.
  if (sets.owned === 1 && !current.owned && hasUnsettledOrders(id)) {
    throw conflict('This shop still has orders it has not been paid for — record its payout first, then make it your own store');
  }
  if (sets.email && sets.email !== current.email.toLowerCase() && one('SELECT id FROM store_sellers WHERE email = ? AND id != ?', sets.email, id)) {
    throw conflict('A shop already signs in with that email');
  }
  // Its products and orders belong to the store it sells in, so it can only
  // move to the other one while it has neither.
  const vertical = sets.vertical ?? current.vertical;
  if (vertical !== current.vertical) {
    if (one('SELECT 1 AS ok FROM store_products WHERE seller_id = ? UNION ALL SELECT 1 FROM store_orders WHERE seller_id = ? LIMIT 1', id, id)) {
      throw conflict('This shop already has products or orders in its store — it cannot switch stores');
    }
    if (payload?.gyms === undefined && one('SELECT 1 AS ok FROM store_seller_gyms WHERE seller_id = ?', id)) {
      throw conflict('Choose its new gyms or institutes when switching stores');
    }
  }
  return tx(() => {
    const columns = Object.keys(sets);
    if (columns.length) {
      // Pausing a shop, or moving its login, signs out every device it had.
      const revoke = sets.active === 0 || (sets.email && sets.email !== current.email.toLowerCase());
      exec(
        `UPDATE store_sellers SET ${columns.map((c) => `${c} = ?`).join(', ')}${revoke ? ', session_version = session_version + 1' : ''},
                updated_at = datetime('now') WHERE id = ?`,
        ...columns.map((c) => sets[c]),
        id,
      );
    }
    const moved = payload?.gyms !== undefined ? writeSellerGyms(id, payload.gyms, vertical) : [];
    return { seller: getSeller(id), moved };
  });
}

function hasUnsettledOrders(sellerId) {
  return Boolean(
    one(
      `SELECT 1 AS ok FROM store_orders WHERE seller_id = ? AND payment_status = 'paid'
         AND fulfillment_status != 'cancelled' AND seller_paid_at IS NULL LIMIT 1`,
      sellerId,
    ),
  );
}

/** A fresh temporary password, and every existing session signed out. */
export function resetSellerPassword(id) {
  sellerRow(id);
  const password = temporaryPassword();
  exec(
    `UPDATE store_sellers SET password_hash = ?, must_change_password = 1, session_version = session_version + 1,
            updated_at = datetime('now') WHERE id = ?`,
    hashPassword(password),
    id,
  );
  return { seller: getSeller(id), password };
}

/** Only a shop that never sold anything can be deleted outright; one with
 * orders is paused instead, so the order history keeps its seller. */
export function deleteSeller(id) {
  sellerRow(id);
  if (one('SELECT 1 AS ok FROM store_orders WHERE seller_id = ? LIMIT 1', id)) {
    throw conflict('This shop has orders — pause it instead, so their history stays intact');
  }
  for (const { id: productId } of many('SELECT id FROM store_products WHERE seller_id = ?', id)) {
    deleteStoreProduct(productId);
  }
  tx(() => {
    exec('DELETE FROM store_seller_gyms WHERE seller_id = ?', id);
    exec('DELETE FROM store_sellers WHERE id = ?', id);
  });
  return { deleted: true };
}

/** Marks every delivered, unpaid order of the shop paid under one bank
 * transfer reference. Orders still on their way wait for delivery. */
export function recordSellerPayout(id, payload) {
  if (sellerRow(id).owned) throw badRequest('This is your own store — its sales are already yours, so there is nothing to pay out');
  const body = parse(payload, { payout_ref: { type: 'string', required: true, min: 3, max: 80 } });
  return tx(() => {
    const due = one(
      `SELECT COUNT(*) AS n, COALESCE(SUM(seller_amount), 0) AS total FROM store_orders
       WHERE seller_id = ? AND payment_status = 'paid' AND fulfillment_status = 'delivered' AND seller_paid_at IS NULL`,
      id,
    );
    if (!due.n) throw badRequest('Nothing is payable to this shop right now');
    exec(
      `UPDATE store_orders SET seller_payout_ref = ?, seller_paid_at = datetime('now'), updated_at = datetime('now')
       WHERE seller_id = ? AND payment_status = 'paid' AND fulfillment_status = 'delivered' AND seller_paid_at IS NULL`,
      body.payout_ref,
      id,
    );
    return { seller_id: id, count: due.n, total: round2(due.total), payout_ref: body.payout_ref };
  });
}

/* ── The shop's own sign-in ───────────────────────────────────────────── */

// A real scrypt hash to verify against when the email is unknown, so "is this
// a shop's address?" costs the same to ask either way.
let decoyHash = null;

export function sellerLogin(payload) {
  const body = parse(payload, {
    email: { type: 'email', required: true },
    password: { type: 'string', required: true, max: 200 },
  });
  const row = one('SELECT * FROM store_sellers WHERE email = ?', body.email);
  decoyHash ??= hashPassword(crypto.randomBytes(12).toString('hex'));
  const ok = verifyPassword(body.password, row?.password_hash ?? decoyHash);
  if (!row || !ok) throw unauthorized('That email and password did not match');
  if (!row.active) throw forbidden('This shop’s access is paused — contact the platform team');
  exec("UPDATE store_sellers SET last_login_at = datetime('now') WHERE id = ?", row.id);
  return { token: issueSellerToken(row), seller: getSeller(row.id) };
}

/** The shop behind a verified seller token, or why it no longer counts. */
export function sellerFromClaims(claims) {
  const row = one('SELECT * FROM store_sellers WHERE id = ?', claims.sub);
  if (!row || row.session_version !== claims.ver) return { error: unauthorized('You were signed out — please sign in again') };
  if (!row.active) return { error: forbidden('This shop’s access is paused — contact the platform team') };
  return { seller: row };
}

/** Changing the password signs out every other device; this one gets a new
 * token straight back so it stays signed in. */
export function changeSellerPassword(sellerId, payload) {
  const body = parse(payload, {
    current_password: { type: 'string', required: true, max: 200 },
    new_password: { type: 'string', required: true, min: 8, max: 200 },
  });
  const row = sellerRow(sellerId);
  if (!verifyPassword(body.current_password, row.password_hash)) {
    throw badRequest('Your current password is not right', { current_password: 'is incorrect' });
  }
  if (body.current_password === body.new_password) throw badRequest('Pick a password different from the current one', { new_password: 'is unchanged' });
  exec(
    `UPDATE store_sellers SET password_hash = ?, must_change_password = 0, session_version = session_version + 1,
            updated_at = datetime('now') WHERE id = ?`,
    hashPassword(body.new_password),
    sellerId,
  );
  return { token: issueSellerToken(sellerRow(sellerId)), seller: getSeller(sellerId) };
}

export function updateSellerProfile(sellerId, payload) {
  const body = parse(payload, PROFILE_FIELDS);
  const sets = {};
  for (const [key, value] of Object.entries(body)) {
    if (value === null || value === '') {
      if (OPTIONAL.includes(key)) sets[key] = null;
      continue;
    }
    sets[key] = value;
  }
  if (sets.phone) assertPhone(sets.phone);
  for (const key of ['delivery_eta', 'pickup_eta']) {
    if (sets[key] && sets[key].length < 3) throw badRequest('Write the promise out, like “Delivery today”', { [key]: 'is too short' });
  }
  const columns = Object.keys(sets);
  if (!columns.length) throw badRequest('Nothing to update');
  exec(
    `UPDATE store_sellers SET ${columns.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`,
    ...columns.map((c) => sets[c]),
    sellerId,
  );
  return getSeller(sellerId);
}

/** The recent payouts a shop can match against its bank statement. */
export function sellerPayoutHistory(sellerId) {
  return many(
    `SELECT seller_payout_ref AS payout_ref, MAX(seller_paid_at) AS paid_at, COUNT(*) AS orders,
            COALESCE(SUM(seller_amount), 0) AS total
     FROM store_orders WHERE seller_id = ? AND seller_paid_at IS NOT NULL
     GROUP BY seller_payout_ref ORDER BY paid_at DESC LIMIT 24`,
    sellerId,
  ).map((r) => ({ ...r, total: round2(r.total) }));
}
