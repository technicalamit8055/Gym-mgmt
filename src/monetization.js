import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config, DEFAULT_TENANT_SLUG } from './config.js';
import { tenantStorage } from './db.js';
import { badRequest, conflict, HttpError, notFound } from './errors.js';
import { sniffMedia } from './exerciseCatalog.js';
import { activateFitnessAddon } from './fitness.js';
import { barcodeVariants, normaliseBarcode } from './foodBarcode.js';
import { emailEnabled, sendEmail } from './mailer.js';
import { notifyMember } from './notifications.js';
import { createOrder, isRazorpayOrdersConfigured } from './razorpay.js';
import { findTenantBySlug, getRegistryDb, tenantDbPath } from './tenants.js';
import { parse, today } from './validate.js';

/**
 * How the platform earns while the software stays free for gyms: members buy
 * the Diet & Workout add-on in the app, and buy supplements and gear from one
 * platform-wide, dropshipped store. The gym whose members bought gets a cut of
 * both, as a commission.
 *
 * Everything here lives in the registry (tenants.db), not in any gym's file:
 * the operator's switches and catalogue are one set for every gym, the money
 * is taken by the platform, and the commission ledger is what the platform
 * owes each gym — none of it is the gym's own to edit. The one gym-local write
 * is the add-on entitlement itself (member_fitness_addons), which every
 * existing access check already reads from the gym's database.
 *
 * The gym's own shelf (tees, shakers it stocks itself) is the opposite case
 * and lives in the gym's file — see routes/storeHub.js.
 */

export const STORE_STATUSES = ['coming_soon', 'live', 'disabled'];
export const COLLECTION_MODES = ['online', 'desk', 'both'];
export const STORE_CATEGORIES = ['protein', 'creatine', 'preworkout', 'bcaa', 'vitamins', 'snacks', 'gear', 'other'];
// 'ready' is pickup-only: the parcel reached the gym and waits at the desk.
// For a pickup order 'shipped' means "on its way to the gym" and 'delivered'
// means the member collected it.
export const FULFILLMENT_STATUSES = ['placed', 'packed', 'shipped', 'ready', 'delivered', 'cancelled'];
export const FULFILLMENT_METHODS = ['delivery', 'pickup'];
export const BANNER_LINKS = ['none', 'category', 'product'];

/** The add-on's three in-app tiers, keyed the way the portal sends them. */
const TIERS = [
  { key: '1m', months: 1, column: 'addon_price_1m' },
  { key: '3m', months: 3, column: 'addon_price_3m' },
  { key: '6m', months: 6, column: 'addon_price_6m' },
];

const round2 = (n) => Math.round(Number(n) * 100) / 100;

/* ── Storage ──────────────────────────────────────────────────────────── */

/**
 * Member orders. Member and shipping details are copied in: the member row
 * lives in another file, and a courier label must not change because the
 * member later edited their profile. A pickup order has no address — it goes
 * to the member's gym — so the address columns are nullable.
 */
const STORE_ORDERS_TABLE = `CREATE TABLE IF NOT EXISTS store_orders (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      order_code          TEXT NOT NULL UNIQUE,
      tenant_slug         TEXT NOT NULL,
      member_id           INTEGER NOT NULL,
      member_name         TEXT,
      subtotal            REAL NOT NULL,
      mrp_total           REAL NOT NULL,
      total_amount        REAL NOT NULL,
      commission_pct      REAL NOT NULL,
      commission_amount   REAL NOT NULL,
      payment_status      TEXT NOT NULL DEFAULT 'pending'
                          CHECK (payment_status IN ('pending', 'paid', 'failed', 'refunded')),
      razorpay_order_id   TEXT UNIQUE,
      razorpay_payment_id TEXT,
      fulfillment_method  TEXT NOT NULL DEFAULT 'delivery' CHECK (fulfillment_method IN ('delivery', 'pickup')),
      shipping_name       TEXT NOT NULL,
      shipping_phone      TEXT NOT NULL,
      shipping_address    TEXT,
      shipping_city       TEXT,
      shipping_state      TEXT,
      shipping_pincode    TEXT,
      fulfillment_status  TEXT NOT NULL DEFAULT 'placed'
                          CHECK (fulfillment_status IN ('placed', 'packed', 'shipped', 'ready', 'delivered', 'cancelled')),
      courier_name        TEXT,
      tracking_id         TEXT,
      tracking_url        TEXT,
      created_at          TEXT NOT NULL DEFAULT (datetime('now')),
      paid_at             TEXT,
      updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
      seller_id           INTEGER,
      seller_fee_pct      REAL,
      seller_fee_amount   REAL,
      seller_amount       REAL,
      seller_payout_ref   TEXT,
      seller_paid_at      TEXT
    );`;

const ORDER_COLUMNS_V1 = [
  'id', 'order_code', 'tenant_slug', 'member_id', 'member_name', 'subtotal', 'mrp_total', 'total_amount',
  'commission_pct', 'commission_amount', 'payment_status', 'razorpay_order_id', 'razorpay_payment_id',
  'shipping_name', 'shipping_phone', 'shipping_address', 'shipping_city', 'shipping_state', 'shipping_pincode',
  'fulfillment_status', 'courier_name', 'tracking_id', 'tracking_url', 'created_at', 'paid_at', 'updated_at',
].join(', ');

/**
 * Brings a registry created before pickup orders up to date. SQLite cannot
 * alter a CHECK or drop a NOT NULL in place, so the orders table is rebuilt
 * once — recognised by the missing fulfillment_method column — and every
 * existing order is copied across as a delivery.
 */
function migrate(handle) {
  const columns = (table) => handle.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  const ensure = (table, column, type) => {
    if (!columns(table).includes(column)) handle.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  };

  ensure('platform_monetization_settings', 'delivery_eta', "TEXT NOT NULL DEFAULT 'Delivery in 2–4 days'");
  ensure('platform_monetization_settings', 'pickup_enabled', 'INTEGER NOT NULL DEFAULT 1');
  ensure('platform_monetization_settings', 'pickup_eta', "TEXT NOT NULL DEFAULT 'Ready at your gym in 3–5 days'");

  if (!columns('store_orders').includes('fulfillment_method')) {
    handle.exec('BEGIN');
    try {
      handle.exec('ALTER TABLE store_orders RENAME TO store_orders_v1');
      handle.exec(STORE_ORDERS_TABLE);
      handle.exec(`INSERT INTO store_orders (${ORDER_COLUMNS_V1}) SELECT ${ORDER_COLUMNS_V1} FROM store_orders_v1`);
      handle.exec('DROP TABLE store_orders_v1');
      handle.exec('CREATE INDEX IF NOT EXISTS idx_store_orders_member ON store_orders(tenant_slug, member_id)');
      handle.exec('COMMIT');
    } catch (err) {
      handle.exec('ROLLBACK');
      throw err;
    }
  }

  // Partner shops (see src/sellers.js): who sells a product, who fulfils an
  // order, and the shop's side of the money on it. NULL is the platform's own.
  ensure('store_products', 'seller_id', 'INTEGER');
  // A pack's printed barcode: the product's own, and each flavour × size's
  // (a 1 kg chocolate and a 2 kg vanilla tub carry different codes).
  ensure('store_products', 'barcode', 'TEXT');
  ensure('store_product_variants', 'barcode', 'TEXT');
  ensure('store_sellers', 'owned', 'INTEGER NOT NULL DEFAULT 0');
  ensure('store_sellers', 'gym_commission_pct', 'REAL');
  for (const [column, type] of [
    ['seller_id', 'INTEGER'],
    ['seller_fee_pct', 'REAL'],
    ['seller_fee_amount', 'REAL'],
    ['seller_amount', 'REAL'],
    ['seller_payout_ref', 'TEXT'],
    ['seller_paid_at', 'TEXT'],
  ]) {
    ensure('store_orders', column, type);
  }
  handle.exec(`
    CREATE INDEX IF NOT EXISTS idx_store_products_seller ON store_products(seller_id);
    CREATE INDEX IF NOT EXISTS idx_store_products_barcode ON store_products(barcode);
    CREATE INDEX IF NOT EXISTS idx_store_variants_barcode ON store_product_variants(barcode);
    CREATE INDEX IF NOT EXISTS idx_store_orders_seller ON store_orders(seller_id);
  `);
}

const initialised = new WeakSet();

function db() {
  const handle = getRegistryDb();
  if (initialised.has(handle)) return handle;

  handle.exec(`
    CREATE TABLE IF NOT EXISTS platform_monetization_settings (
      id                            INTEGER PRIMARY KEY CHECK (id = 1),
      store_status                  TEXT NOT NULL DEFAULT 'coming_soon'
                                    CHECK (store_status IN ('coming_soon', 'live', 'disabled')),
      fitness_addon_collection_mode TEXT NOT NULL DEFAULT 'desk'
                                    CHECK (fitness_addon_collection_mode IN ('online', 'desk', 'both')),
      addon_commission_pct          REAL NOT NULL DEFAULT 25 CHECK (addon_commission_pct BETWEEN 0 AND 100),
      store_commission_pct          REAL NOT NULL DEFAULT 7.5 CHECK (store_commission_pct BETWEEN 0 AND 100),
      addon_price_1m                REAL NOT NULL DEFAULT 79 CHECK (addon_price_1m >= 1),
      addon_price_3m                REAL NOT NULL DEFAULT 199 CHECK (addon_price_3m >= 1),
      addon_price_6m                REAL NOT NULL DEFAULT 349 CHECK (addon_price_6m >= 1),
      updated_at                    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT OR IGNORE INTO platform_monetization_settings (id) VALUES (1);

    CREATE TABLE IF NOT EXISTS store_products (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      title           TEXT NOT NULL,
      brand           TEXT NOT NULL,
      category        TEXT NOT NULL DEFAULT 'other',
      description     TEXT,
      image_url       TEXT,
      nutrition_facts TEXT,
      lab_report_url  TEXT,
      mrp             REAL NOT NULL CHECK (mrp >= 0),
      price           REAL NOT NULL CHECK (price >= 0),
      featured        INTEGER NOT NULL DEFAULT 0,
      active          INTEGER NOT NULL DEFAULT 1,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- A flavour x size combination. NULL mrp/price means "the product's own".
    CREATE TABLE IF NOT EXISTS store_product_variants (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      flavor     TEXT,
      weight     TEXT,
      sku        TEXT,
      mrp        REAL CHECK (mrp IS NULL OR mrp >= 0),
      price      REAL CHECK (price IS NULL OR price >= 0),
      in_stock   INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_store_variants_product ON store_product_variants(product_id);

    ${STORE_ORDERS_TABLE}
    CREATE INDEX IF NOT EXISTS idx_store_orders_member ON store_orders(tenant_slug, member_id);
    CREATE TABLE IF NOT EXISTS store_order_items (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id      INTEGER NOT NULL,
      product_id    INTEGER NOT NULL,
      variant_id    INTEGER,
      title         TEXT NOT NULL,
      brand         TEXT,
      variant_label TEXT,
      image_url     TEXT,
      quantity      INTEGER NOT NULL CHECK (quantity > 0),
      unit_price    REAL NOT NULL,
      unit_mrp      REAL NOT NULL,
      line_total    REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_store_order_items_order ON store_order_items(order_id);

    -- An in-app add-on purchase between "Checkout opened" and "paid". The
    -- entitlement itself is written into the gym's own file once it is paid.
    CREATE TABLE IF NOT EXISTS addon_payments (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_slug         TEXT NOT NULL,
      member_id           INTEGER NOT NULL,
      tier                TEXT NOT NULL,
      months              INTEGER NOT NULL,
      amount              REAL NOT NULL,
      commission_pct      REAL NOT NULL,
      razorpay_order_id   TEXT NOT NULL UNIQUE,
      razorpay_payment_id TEXT,
      status              TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'paid', 'failed')),
      created_at          TEXT NOT NULL DEFAULT (datetime('now')),
      paid_at             TEXT
    );

    -- What the platform owes each gym. One row per paid sale, so a replayed
    -- webhook or a double-tapped verify can never credit a gym twice.
    -- store orders start 'pending' (they can still be cancelled) and become
    -- 'approved' on delivery; add-on sales are final and start 'approved'.
    CREATE TABLE IF NOT EXISTS gym_commissions (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_slug    TEXT NOT NULL,
      source_type    TEXT NOT NULL CHECK (source_type IN ('fitness_addon', 'store_order')),
      source_id      INTEGER NOT NULL,
      member_id      INTEGER,
      description    TEXT,
      gross_amount   REAL NOT NULL,
      commission_pct REAL NOT NULL,
      amount         REAL NOT NULL,
      status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'paid', 'void')),
      earned_on      TEXT NOT NULL,
      payout_ref     TEXT,
      paid_at        TEXT,
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (source_type, source_id)
    );
    CREATE INDEX IF NOT EXISTS idx_gym_commissions_tenant ON gym_commissions(tenant_slug, earned_on);
    -- Product photos, uploaded from the console. The first by sort_order is
    -- the one cards show; the rest make the product page's gallery.
    CREATE TABLE IF NOT EXISTS store_product_images (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      file       TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_store_images_product ON store_product_images(product_id, sort_order);

    -- The swipeable promo strip on the store's home screen.
    CREATE TABLE IF NOT EXISTS store_banners (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      title      TEXT NOT NULL,
      subtitle   TEXT,
      cta_label  TEXT,
      image_file TEXT,
      bg_color   TEXT NOT NULL DEFAULT '#0c831f',
      link_type  TEXT NOT NULL DEFAULT 'none' CHECK (link_type IN ('none', 'category', 'product')),
      link_value TEXT,
      active     INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Quality marks (Trustified, Informed Choice, Lab tested…): uploaded once
    -- from the console, then pinned to any number of products.
    CREATE TABLE IF NOT EXISTS store_badges (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      image_file TEXT,
      active     INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS store_product_badges (
      product_id INTEGER NOT NULL,
      badge_id   INTEGER NOT NULL,
      PRIMARY KEY (product_id, badge_id)
    );
    CREATE INDEX IF NOT EXISTS idx_store_product_badges_badge ON store_product_badges(badge_id);

    -- Partner supplement shops, each signing in to its own panel. A gym is
    -- served by at most one shop: its members see that shop's shelf, and the
    -- shop fulfils their orders. See src/sellers.js.
    CREATE TABLE IF NOT EXISTS store_sellers (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      name                 TEXT NOT NULL,
      owner_name           TEXT NOT NULL,
      email                TEXT NOT NULL UNIQUE COLLATE NOCASE,
      phone                TEXT NOT NULL,
      city                 TEXT NOT NULL,
      area                 TEXT,
      address              TEXT,
      gstin                TEXT,
      password_hash        TEXT NOT NULL,
      session_version      INTEGER NOT NULL DEFAULT 1,
      must_change_password INTEGER NOT NULL DEFAULT 1,
      platform_fee_pct     REAL NOT NULL DEFAULT 10 CHECK (platform_fee_pct BETWEEN 0 AND 100),
      -- 1 = the operator's own store (a dark store): no platform fee, and its
      -- takings are the operator's already, so there is nothing to pay out.
      owned                INTEGER NOT NULL DEFAULT 0,
      -- The gym's cut on this shop's orders. NULL follows the platform-wide
      -- rate; 0 switches gym commission off for this shop.
      gym_commission_pct   REAL CHECK (gym_commission_pct IS NULL OR gym_commission_pct BETWEEN 0 AND 100),
      delivery_eta         TEXT,
      pickup_eta           TEXT,
      active               INTEGER NOT NULL DEFAULT 1,
      last_login_at        TEXT,
      created_at           TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS store_seller_gyms (
      tenant_slug TEXT PRIMARY KEY,
      seller_id   INTEGER NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_store_seller_gyms_seller ON store_seller_gyms(seller_id);
  `);
  migrate(handle);

  initialised.add(handle);
  return handle;
}

const one = (sql, ...params) => {
  const row = db().prepare(sql).get(...params);
  return row === undefined ? undefined : { ...row };
};
const many = (sql, ...params) => db().prepare(sql).all(...params).map((row) => ({ ...row }));
const exec = (sql, ...params) => db().prepare(sql).run(...params);

/** The store's registry handles, for src/sellers.js — the same tables, opened
 * (and migrated) the same way. */
export const storeRegistry = { one, many, exec, tx: (fn) => registryTx(fn) };

function registryTx(fn) {
  const handle = db();
  handle.exec('BEGIN');
  try {
    const result = fn();
    handle.exec('COMMIT');
    return result;
  } catch (err) {
    handle.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Runs `fn` against one gym's own database, from a context that has none — a
 * Razorpay webhook arrives on a fixed URL with no gym in its address.
 */
function withTenantDb(slug, fn) {
  if (slug === DEFAULT_TENANT_SLUG) {
    return tenantStorage.run({ slug, dbFile: undefined, businessType: 'gym' }, fn);
  }
  const tenant = findTenantBySlug(slug);
  if (!tenant) throw notFound(`No gym found for "${slug}"`);
  return tenantStorage.run(
    {
      slug,
      dbFile: tenantDbPath(slug),
      timezone: tenant.timezone || undefined,
      businessType: tenant.business_type || 'gym',
    },
    fn,
  );
}

/* ── Settings ─────────────────────────────────────────────────────────── */

export function monetizationSettings() {
  return one('SELECT * FROM platform_monetization_settings WHERE id = 1');
}

const SETTINGS_FIELDS = {
  store_status: { type: 'enum', values: STORE_STATUSES },
  fitness_addon_collection_mode: { type: 'enum', values: COLLECTION_MODES },
  addon_commission_pct: { type: 'number', min: 0, max: 100 },
  store_commission_pct: { type: 'number', min: 0, max: 100 },
  addon_price_1m: { type: 'number', min: 1, max: 100000 },
  addon_price_3m: { type: 'number', min: 1, max: 100000 },
  addon_price_6m: { type: 'number', min: 1, max: 100000 },
  delivery_eta: { type: 'string', min: 3, max: 60 },
  pickup_enabled: { type: 'boolean' },
  pickup_eta: { type: 'string', min: 3, max: 60 },
};

export function updateMonetizationSettings(payload) {
  const body = parse(payload, SETTINGS_FIELDS);
  const columns = Object.keys(body).filter((c) => body[c] !== null);
  if (!columns.length) throw badRequest('Nothing to update');

  // Opening a shop with nothing on the shelves would show every member an
  // empty page where the "coming soon" screen used to be.
  if (body.store_status === 'live' && !one('SELECT 1 AS ok FROM store_products WHERE active = 1')) {
    throw badRequest('Add at least one active product before taking the store live', {
      store_status: 'needs at least one active product',
    });
  }

  exec(
    `UPDATE platform_monetization_settings SET ${columns.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now')
     WHERE id = 1`,
    ...columns.map((c) => body[c]),
  );
  return monetizationSettings();
}

export function addonTiers(settings = monetizationSettings()) {
  const monthly = settings.addon_price_1m;
  return TIERS.map(({ key, months, column }) => {
    const price = settings[column];
    const full = monthly * months;
    return {
      key,
      months,
      price,
      per_month: round2(price / months),
      save_pct: months > 1 && full > price ? Math.round(((full - price) / full) * 100) : 0,
    };
  });
}

/**
 * What the member app needs to decide which Store screen and which paywall to
 * draw. The store follows the operator's switch exactly — "live" in the
 * console is live in the app — and `online_payments` tells the cart whether
 * checkout can open yet. The add-on paywall, which has nothing to show but a
 * pay button, falls back to the desk instead when Razorpay keys are missing.
 */
export function portalMonetization() {
  const settings = monetizationSettings();
  const online = isRazorpayOrdersConfigured();
  return {
    store_status: settings.store_status,
    online_payments: online,
    addon_collection_mode: online ? settings.fitness_addon_collection_mode : 'desk',
    addon_tiers: addonTiers(settings),
  };
}

/* ── Central catalogue ────────────────────────────────────────────────── */

const NUTRITION_KEYS = ['calories', 'protein_g', 'carbs_g', 'fat_g', 'sugar_g', 'bcaa_g', 'creatine_g', 'caffeine_mg'];

/** Nutrition facts per serving, kept as a small fixed-shape JSON object so the
 * portal can lay it out as a table without knowing every brand's label. */
function cleanNutrition(raw) {
  if (raw === undefined) return undefined;
  if (raw === null || raw === '') return null;
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      throw badRequest('Nutrition facts must be valid JSON', { nutrition_facts: 'is not valid JSON' });
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest('Nutrition facts must be an object', { nutrition_facts: 'must be an object' });
  }
  const out = {};
  if (value.serving_size) out.serving_size = String(value.serving_size).trim().slice(0, 40);
  if (value.servings !== undefined && value.servings !== '') {
    const n = Number(value.servings);
    if (Number.isFinite(n) && n > 0) out.servings = Math.round(n);
  }
  for (const key of NUTRITION_KEYS) {
    if (value[key] === undefined || value[key] === null || value[key] === '') continue;
    const n = Number(value[key]);
    if (!Number.isFinite(n) || n < 0) throw badRequest(`${key} must be a positive number`, { nutrition_facts: `${key} is invalid` });
    out[key] = round2(n);
  }
  return Object.keys(out).length ? JSON.stringify(out) : null;
}

/** Only links a browser can safely open: http(s), or a path on this site. */
function cleanUrl(raw, field) {
  if (raw === undefined) return undefined;
  if (raw === null || String(raw).trim() === '') return null;
  const value = String(raw).trim();
  if (value.length > 1000) throw badRequest(`${field} is too long`, { [field]: 'is too long' });
  if (value.startsWith('/') && !value.startsWith('//')) return value;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' || url.protocol === 'http:') return url.toString();
  } catch {
    // Fall through to the error below.
  }
  throw badRequest(`${field} must be an http(s) link`, { [field]: 'must be an http(s) link' });
}

const PRODUCT_FIELDS = {
  title: { type: 'string', min: 2, max: 120 },
  brand: { type: 'string', min: 1, max: 80 },
  category: { type: 'enum', values: STORE_CATEGORIES },
  description: { type: 'string', max: 2000 },
  mrp: { type: 'number', min: 0, max: 1000000 },
  price: { type: 'number', min: 0, max: 1000000 },
  featured: { type: 'boolean' },
  active: { type: 'boolean' },
};

/** A printed barcode, or null to clear it; undefined leaves it as it is. */
function cleanBarcode(raw) {
  if (raw === undefined) return undefined;
  if (raw === null || String(raw).trim() === '') return null;
  return normaliseBarcode(raw);
}

/**
 * The product on `sellerId`'s shelf (null: the central catalogue) that
 * carries `code`, on itself or on one of its variants — skipping
 * `exceptProductId`, the product being saved.
 */
export function shelfProductByBarcode(code, sellerId, exceptProductId = null) {
  const codes = barcodeVariants(code);
  const marks = codes.map(() => '?').join(',');
  return one(
    `SELECT p.id, p.title, v.id AS variant_id FROM store_products p
     LEFT JOIN store_product_variants v ON v.product_id = p.id AND v.barcode IN (${marks})
     WHERE p.seller_id IS ? AND p.id IS NOT ? AND (p.barcode IN (${marks}) OR v.id IS NOT NULL)
     ORDER BY p.active DESC, p.id DESC LIMIT 1`,
    ...codes,
    sellerId,
    exceptProductId,
    ...codes,
  );
}

/** One shelf lists a pack once: a scan should find one product, not two. */
function assertBarcodesFree(sellerId, productId, productBarcode, variants) {
  const codes = [productBarcode, ...(variants ?? []).map((v) => v.barcode)].filter(Boolean);
  const seen = new Set();
  for (const code of codes) {
    const key = barcodeVariants(code).sort()[0];
    if (seen.has(key)) throw badRequest(`Barcode ${code} is used twice on this product`, { barcode: 'is used twice' });
    seen.add(key);
    const taken = shelfProductByBarcode(code, sellerId, productId);
    if (taken) throw conflict(`Barcode ${code} is already on this shelf, on “${taken.title}”`);
  }
}

function cleanVariants(raw) {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw badRequest('Variants must be a list', { variants: 'must be a list' });
  if (raw.length > 40) throw badRequest('At most 40 variants per product', { variants: 'at most 40' });
  return raw.map((variant, i) => {
    const v = parse(variant, {
      id: { type: 'int', min: 1 },
      flavor: { type: 'string', max: 60 },
      weight: { type: 'string', max: 40 },
      sku: { type: 'string', max: 60 },
      barcode: { type: 'string', max: 20 },
      mrp: { type: 'number', min: 0, max: 1000000 },
      price: { type: 'number', min: 0, max: 1000000 },
      in_stock: { type: 'boolean', default: 1 },
    });
    if (!v.flavor && !v.weight) {
      throw badRequest(`Variant ${i + 1} needs a flavour or a size`, { variants: `row ${i + 1} is empty` });
    }
    return { ...v, barcode: cleanBarcode(v.barcode) ?? null, sort_order: i };
  });
}

/* ── Uploaded photos ──────────────────────────────────────────────────── */

export const MAX_STORE_IMAGE_BYTES = 4 * 1024 * 1024;
// p = product photo, b = banner, q = quality badge, nb<tab> = a member-app
// menu badge (src/navBadges.js), which shares this folder and serving route.
const STORE_FILE_RE = /^(?:p\d+|b\d+|q\d+|nb[a-z]+)-[a-f0-9]{10}\.(?:png|jpg|webp)$/;

/** Where an uploaded store photo lives on disk, or null for a name that is not
 * one of ours — the serving route's only defence against path tricks. */
export function storeMediaPath(file) {
  if (!STORE_FILE_RE.test(String(file))) return null;
  return path.join(config.storeMediaDir, file);
}

/** A URL an <img> can load, keeping the /g/<slug> prefix the page came in on. */
export function storeMediaUrl(file) {
  if (!file) return null;
  const prefix = tenantStorage.getStore()?.pathPrefix ?? '';
  return `${prefix}/api/store-media/${file}`;
}

/** Saves one uploaded photo under a content-addressed name. Only still
 * images: the bytes decide the format, never the declared Content-Type. */
export function writeStoreImage(prefix, bytes) {
  if (!bytes?.length) throw badRequest('That file is empty');
  if (bytes.length > MAX_STORE_IMAGE_BYTES) throw badRequest('That image is too large', { file: 'must be under 4 MB' });
  const format = sniffMedia(bytes);
  if (!format || !['png', 'jpg', 'webp'].includes(format.ext)) {
    throw badRequest('Use a PNG, JPG or WebP image', { file: 'unsupported format' });
  }
  const hash = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 10);
  const file = `${prefix}-${hash}.${format.ext}`;
  fs.mkdirSync(config.storeMediaDir, { recursive: true });
  fs.writeFileSync(path.join(config.storeMediaDir, file), bytes);
  return file;
}

function removeStoreImage(file) {
  const target = storeMediaPath(file);
  if (!target) return;
  // Content-addressed, so two rows can share a file: keep it while any does.
  const stillUsed =
    one('SELECT 1 AS ok FROM store_product_images WHERE file = ?', file) ||
    one('SELECT 1 AS ok FROM store_banners WHERE image_file = ?', file) ||
    one('SELECT 1 AS ok FROM store_badges WHERE image_file = ?', file);
  if (stillUsed) return;
  try {
    fs.unlinkSync(target);
  } catch {
    // Already gone.
  }
}

/**
 * The product, when the caller may touch it. `sellerId` undefined is the
 * operator (any product); a number is one partner shop, which only ever sees
 * its own shelf — anyone else's product is "not found", not "forbidden".
 */
function productFor(id, sellerId) {
  const row = one('SELECT * FROM store_products WHERE id = ?', id);
  if (!row || (sellerId !== undefined && (row.seller_id ?? null) !== sellerId)) throw notFound('Product not found');
  return row;
}

export function addProductImage(productId, bytes, { sellerId } = {}) {
  productFor(productId, sellerId);
  const count = one('SELECT COUNT(*) AS n FROM store_product_images WHERE product_id = ?', productId).n;
  if (count >= 8) throw badRequest('A product can have at most 8 photos');
  const file = writeStoreImage(`p${productId}`, bytes);
  const next = one('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM store_product_images WHERE product_id = ?', productId).n;
  exec('INSERT INTO store_product_images (product_id, file, sort_order) VALUES (?, ?, ?)', productId, file, next);
  return getStoreProduct(productId);
}

export function deleteProductImage(productId, imageId, { sellerId } = {}) {
  productFor(productId, sellerId);
  const image = one('SELECT * FROM store_product_images WHERE id = ? AND product_id = ?', imageId, productId);
  if (!image) throw notFound('Photo not found');
  exec('DELETE FROM store_product_images WHERE id = ?', image.id);
  removeStoreImage(image.file);
  return getStoreProduct(productId);
}

/** Moves one photo to the front — the one product cards show. */
export function makeProductImagePrimary(productId, imageId, { sellerId } = {}) {
  productFor(productId, sellerId);
  const image = one('SELECT * FROM store_product_images WHERE id = ? AND product_id = ?', imageId, productId);
  if (!image) throw notFound('Photo not found');
  const min = one('SELECT MIN(sort_order) AS n FROM store_product_images WHERE product_id = ?', productId).n;
  exec('UPDATE store_product_images SET sort_order = ? WHERE id = ?', min - 1, image.id);
  return getStoreProduct(productId);
}

function imagesFor(productIds) {
  const byProduct = new Map();
  if (!productIds.length) return byProduct;
  for (const img of many(
    `SELECT * FROM store_product_images WHERE product_id IN (${productIds.map(() => '?').join(',')})
     ORDER BY sort_order, id`,
    ...productIds,
  )) {
    if (!byProduct.has(img.product_id)) byProduct.set(img.product_id, []);
    byProduct.get(img.product_id).push({ id: img.id, url: storeMediaUrl(img.file) });
  }
  return byProduct;
}

/** Each product's quality badges in the library's order. Members only see
 * badges the operator has left switched on. */
function badgesFor(productIds, { activeOnly = false } = {}) {
  const byProduct = new Map();
  if (!productIds.length) return byProduct;
  for (const row of many(
    `SELECT pb.product_id, b.* FROM store_product_badges pb JOIN store_badges b ON b.id = pb.badge_id
     WHERE pb.product_id IN (${productIds.map(() => '?').join(',')}) ${activeOnly ? 'AND b.active = 1' : ''}
     ORDER BY b.id`,
    ...productIds,
  )) {
    const { product_id: productId, ...badge } = row;
    if (!byProduct.has(productId)) byProduct.set(productId, []);
    byProduct.get(productId).push(presentBadge(badge));
  }
  return byProduct;
}

function hydrateProduct(row, variantsByProduct, imagesByProduct = new Map(), badgesByProduct = new Map()) {
  if (!row) return row;
  let nutrition = null;
  try {
    nutrition = row.nutrition_facts ? JSON.parse(row.nutrition_facts) : null;
  } catch {
    nutrition = null;
  }
  const variants = (variantsByProduct.get(row.id) ?? []).map((v) => ({
    ...v,
    label: [v.flavor, v.weight].filter(Boolean).join(' · '),
    effective_price: v.price ?? row.price,
    effective_mrp: v.mrp ?? row.mrp,
  }));
  const priced = variants.length ? variants.map((v) => v.effective_price) : [row.price];
  const uploaded = imagesByProduct.get(row.id) ?? [];
  return {
    ...row,
    // Uploaded photos win; a pasted link is the fallback for older listings.
    image_url: uploaded[0]?.url ?? row.image_url,
    image_link: row.image_url,
    images: uploaded.length ? uploaded : row.image_url ? [{ id: null, url: row.image_url }] : [],
    nutrition_facts: nutrition,
    badges: badgesByProduct.get(row.id) ?? [],
    variants,
    from_price: Math.min(...priced),
    flavors: [...new Set(variants.map((v) => v.flavor).filter(Boolean))],
    weights: [...new Set(variants.map((v) => v.weight).filter(Boolean))],
  };
}

/** `sellerId`: undefined lists every product, null the platform's own
 * catalogue, a number one partner shop's shelf. */
export function listStoreProducts({ activeOnly = false, q, category, sellerId } = {}) {
  const where = [];
  const params = [];
  if (activeOnly) where.push('active = 1');
  if (sellerId !== undefined) {
    where.push('seller_id IS ?');
    params.push(sellerId);
  }
  if (category && STORE_CATEGORIES.includes(category)) {
    where.push('category = ?');
    params.push(category);
  }
  if (q) {
    where.push('(title LIKE ? OR brand LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }
  const rows = many(
    `SELECT * FROM store_products ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY featured DESC, title COLLATE NOCASE`,
    ...params,
  );
  const variantsByProduct = new Map();
  if (rows.length) {
    const ids = rows.map((r) => r.id);
    for (const v of many(
      `SELECT * FROM store_product_variants WHERE product_id IN (${ids.map(() => '?').join(',')})
       ORDER BY sort_order, id`,
      ...ids,
    )) {
      if (!variantsByProduct.has(v.product_id)) variantsByProduct.set(v.product_id, []);
      variantsByProduct.get(v.product_id).push(v);
    }
  }
  const ids = rows.map((r) => r.id);
  const imagesByProduct = imagesFor(ids);
  const badgesByProduct = badgesFor(ids, { activeOnly });
  return rows.map((row) => hydrateProduct(row, variantsByProduct, imagesByProduct, badgesByProduct));
}

export function getStoreProduct(id) {
  const row = one('SELECT * FROM store_products WHERE id = ?', id);
  if (!row) throw notFound('Product not found');
  const variants = many('SELECT * FROM store_product_variants WHERE product_id = ? ORDER BY sort_order, id', id);
  return hydrateProduct(row, new Map([[row.id, variants]]), imagesFor([row.id]), badgesFor([row.id]));
}

/** The badge ids a product should carry, checked against the library.
 * Undefined means "leave them as they are". */
function cleanBadgeIds(raw) {
  if (raw === undefined) return undefined;
  if (raw === null) return [];
  if (!Array.isArray(raw)) throw badRequest('Badges must be a list', { badge_ids: 'must be a list' });
  const ids = [...new Set(raw.map(Number))];
  if (ids.some((id) => !Number.isInteger(id) || id < 1)) throw badRequest('Unknown badge', { badge_ids: 'unknown badge' });
  if (ids.length > 12) throw badRequest('At most 12 badges per product', { badge_ids: 'at most 12' });
  if (ids.length) {
    const known = many(`SELECT id FROM store_badges WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids);
    if (known.length !== ids.length) throw badRequest('Unknown badge', { badge_ids: 'unknown badge' });
  }
  return ids;
}

function writeProductBadges(productId, ids) {
  exec('DELETE FROM store_product_badges WHERE product_id = ?', productId);
  for (const id of ids) exec('INSERT INTO store_product_badges (product_id, badge_id) VALUES (?, ?)', productId, id);
}

/** Upserts the product's variants by id; any existing variant not in the list
 * is removed. Past orders are unaffected — their items carry their own copy. */
function writeVariants(productId, variants) {
  const keep = new Set();
  for (const v of variants) {
    const existing = v.id
      ? one('SELECT id FROM store_product_variants WHERE id = ? AND product_id = ?', v.id, productId)
      : null;
    if (existing) {
      exec(
        `UPDATE store_product_variants SET flavor = ?, weight = ?, sku = ?, barcode = ?, mrp = ?, price = ?, in_stock = ?, sort_order = ?
         WHERE id = ?`,
        v.flavor ?? null, v.weight ?? null, v.sku ?? null, v.barcode ?? null, v.mrp ?? null, v.price ?? null, v.in_stock, v.sort_order, existing.id,
      );
      keep.add(existing.id);
    } else {
      const info = exec(
        `INSERT INTO store_product_variants (product_id, flavor, weight, sku, barcode, mrp, price, in_stock, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        productId, v.flavor ?? null, v.weight ?? null, v.sku ?? null, v.barcode ?? null, v.mrp ?? null, v.price ?? null, v.in_stock, v.sort_order,
      );
      keep.add(Number(info.lastInsertRowid));
    }
  }
  for (const { id } of many('SELECT id FROM store_product_variants WHERE product_id = ?', productId)) {
    if (!keep.has(id)) exec('DELETE FROM store_product_variants WHERE id = ?', id);
  }
}

function assertPricing(mrp, price) {
  if (price > mrp) throw badRequest('The selling price cannot be above the MRP', { price: 'must not exceed MRP' });
}

/** A partner shop's products carry its `sellerId`. Quality badges are the
 * operator's to vouch for, so a shop's own listing never sets them. */
export function createStoreProduct(payload, { sellerId = null } = {}) {
  const body = parse(payload, {
    ...PRODUCT_FIELDS,
    title: { ...PRODUCT_FIELDS.title, required: true },
    brand: { ...PRODUCT_FIELDS.brand, required: true },
    mrp: { ...PRODUCT_FIELDS.mrp, required: true },
    price: { ...PRODUCT_FIELDS.price, required: true },
    category: { ...PRODUCT_FIELDS.category, default: 'other' },
  });
  assertPricing(body.mrp, body.price);
  const variants = cleanVariants(payload?.variants) ?? [];
  for (const v of variants) assertPricing(v.mrp ?? body.mrp, v.price ?? body.price);
  const badgeIds = sellerId === null ? (cleanBadgeIds(payload?.badge_ids) ?? []) : [];
  const barcode = cleanBarcode(payload?.barcode) ?? null;
  assertBarcodesFree(sellerId, null, barcode, variants);

  return registryTx(() => {
    const info = exec(
      `INSERT INTO store_products (title, brand, category, description, image_url, nutrition_facts, lab_report_url,
                                   mrp, price, featured, active, seller_id, barcode)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      body.title,
      body.brand,
      body.category,
      body.description ?? null,
      cleanUrl(payload?.image_url, 'image_url') ?? null,
      cleanNutrition(payload?.nutrition_facts) ?? null,
      cleanUrl(payload?.lab_report_url, 'lab_report_url') ?? null,
      body.mrp,
      body.price,
      body.featured ?? 0,
      body.active ?? 1,
      sellerId,
      barcode,
    );
    const id = Number(info.lastInsertRowid);
    writeVariants(id, variants);
    writeProductBadges(id, badgeIds);
    return getStoreProduct(id);
  });
}

export function updateStoreProduct(id, payload, { sellerId } = {}) {
  const current = productFor(id, sellerId);
  const byShop = current.seller_id !== null && current.seller_id !== undefined;
  const body = parse(payload, PRODUCT_FIELDS);
  const sets = {};
  for (const [key, value] of Object.entries(body)) {
    if (value === null && ['title', 'brand', 'category', 'mrp', 'price', 'featured', 'active'].includes(key)) continue;
    sets[key] = value;
  }
  const image = cleanUrl(payload?.image_url, 'image_url');
  if (image !== undefined) sets.image_url = image;
  const lab = cleanUrl(payload?.lab_report_url, 'lab_report_url');
  if (lab !== undefined) sets.lab_report_url = lab;
  const nutrition = cleanNutrition(payload?.nutrition_facts);
  if (nutrition !== undefined) sets.nutrition_facts = nutrition;
  const barcode = cleanBarcode(payload?.barcode);
  if (barcode !== undefined) sets.barcode = barcode;

  const mrp = sets.mrp ?? current.mrp;
  const price = sets.price ?? current.price;
  assertPricing(mrp, price);
  const variants = cleanVariants(payload?.variants);
  for (const v of variants ?? []) assertPricing(v.mrp ?? mrp, v.price ?? price);
  const badgeIds = sellerId === undefined ? cleanBadgeIds(payload?.badge_ids) : undefined;
  if (barcode !== undefined || variants) {
    const currentVariants = variants ?? many('SELECT barcode FROM store_product_variants WHERE product_id = ?', id);
    assertBarcodesFree(current.seller_id ?? null, id, barcode === undefined ? current.barcode : barcode, currentVariants);
  }

  return registryTx(() => {
    const columns = Object.keys(sets);
    if (columns.length) {
      exec(
        `UPDATE store_products SET ${columns.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`,
        ...columns.map((c) => sets[c]),
        id,
      );
    }
    if (variants) writeVariants(id, variants);
    if (badgeIds) writeProductBadges(id, badgeIds);
    // The last active product going away would leave a live store empty. A
    // shop's gyms fall back to the central catalogue instead (catalogFor).
    if (sets.active === 0 && !byShop) guardLiveStoreHasStock();
    return getStoreProduct(id);
  });
}

function guardLiveStoreHasStock() {
  if (monetizationSettings().store_status !== 'live') return;
  if (one('SELECT 1 AS ok FROM store_products WHERE active = 1')) return;
  throw conflict('The store is live — keep at least one product active, or switch the store back to "Coming soon" first');
}

/** A product that was ever ordered is retired rather than deleted, so order
 * history keeps pointing at something real. */
export function deleteStoreProduct(id, { sellerId } = {}) {
  const product = productFor(id, sellerId);
  const byShop = product.seller_id !== null && product.seller_id !== undefined;
  return registryTx(() => {
    if (one('SELECT 1 AS ok FROM store_order_items WHERE product_id = ? LIMIT 1', id)) {
      exec("UPDATE store_products SET active = 0, updated_at = datetime('now') WHERE id = ?", id);
      if (!byShop) guardLiveStoreHasStock();
      return { retired: true };
    }
    const files = many('SELECT file FROM store_product_images WHERE product_id = ?', id).map((r) => r.file);
    exec('DELETE FROM store_product_variants WHERE product_id = ?', id);
    exec('DELETE FROM store_product_images WHERE product_id = ?', id);
    exec('DELETE FROM store_product_badges WHERE product_id = ?', id);
    exec('DELETE FROM store_products WHERE id = ?', id);
    if (!byShop) guardLiveStoreHasStock();
    for (const file of files) removeStoreImage(file);
    return { deleted: true };
  });
}

/* ── Which shelf a gym shops from ─────────────────────────────────────── */

/**
 * The partner shop the operator assigned to this gym, while it is active and
 * has something on its shelf — otherwise the platform's central catalogue.
 * One shelf per gym, so a cart never mixes two sellers and every order has
 * exactly one shop to fulfil it. Storefront and checkout both ask here, so a
 * member can never buy from a shelf their gym does not show.
 */
export function catalogFor(tenantSlug) {
  const seller = one(
    `SELECT s.* FROM store_seller_gyms g JOIN store_sellers s ON s.id = g.seller_id
     WHERE g.tenant_slug = ? AND s.active = 1`,
    tenantSlug,
  );
  if (seller && one('SELECT 1 AS ok FROM store_products WHERE seller_id = ? AND active = 1', seller.id)) {
    return { seller, sellerId: seller.id };
  }
  return { seller: null, sellerId: null };
}

/**
 * The cuts on an order from `seller`'s shelf (null: the central catalogue).
 * The gym's share follows the shop's own setting when it has one — a custom
 * rate, or 0 for none — and the platform-wide rate otherwise. The operator's
 * own store pays no platform fee: its takings are the operator's already.
 */
export function shopRates(seller, settings = monetizationSettings()) {
  const gymPct = seller?.gym_commission_pct ?? settings.store_commission_pct;
  return {
    gym_commission_pct: gymPct,
    gym_commission_custom: seller ? seller.gym_commission_pct !== null && seller.gym_commission_pct !== undefined : false,
    platform_fee_pct: seller ? (seller.owned ? 0 : seller.platform_fee_pct) : null,
  };
}

/* ── Checkout ─────────────────────────────────────────────────────────── */

function requireOnlinePayments() {
  if (!isRazorpayOrdersConfigured()) {
    throw new HttpError(503, 'Online payments are not set up on this deployment yet');
  }
}

/** The gym's name for the Checkout header — the member is paying inside their
 * gym's app, even though the platform takes the money. */
function checkoutName(tenantSlug) {
  if (tenantSlug === DEFAULT_TENANT_SLUG) return 'GymBook';
  const tenant = findTenantBySlug(tenantSlug);
  return tenant?.gym_name || tenant?.display_name || 'GymBook';
}

function checkoutPayload(order, { tenantSlug, member, description }) {
  return {
    key_id: config.razorpay.keyId,
    order_id: order.id,
    amount: order.amount,
    currency: order.currency || 'INR',
    name: checkoutName(tenantSlug),
    description,
    prefill: {
      name: [member.first_name, member.last_name].filter(Boolean).join(' '),
      email: member.email || undefined,
      contact: member.phone || undefined,
    },
  };
}

/**
 * Opens a Razorpay order for one add-on tier. The price comes from the
 * operator's settings, never the request: the portal only names the tier.
 */
export async function createAddonCheckout({ tenantSlug, member, tier }) {
  const settings = monetizationSettings();
  if (!['online', 'both'].includes(settings.fitness_addon_collection_mode)) {
    throw badRequest('This gym activates the add-on at the front desk');
  }
  requireOnlinePayments();
  const plan = addonTiers(settings).find((t) => t.key === tier);
  if (!plan) throw badRequest('Pick a plan', { tier: `must be one of: ${TIERS.map((t) => t.key).join(', ')}` });

  const order = await createOrder({
    amount: plan.price,
    receipt: `addon-${tenantSlug}-${member.id}-${Date.now()}`,
    notes: { kind: 'fitness_addon', tenant_slug: tenantSlug, member_id: String(member.id), tier: plan.key },
  });
  exec(
    `INSERT INTO addon_payments (tenant_slug, member_id, tier, months, amount, commission_pct, razorpay_order_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    tenantSlug, member.id, plan.key, plan.months, plan.price, settings.addon_commission_pct, order.id,
  );
  return {
    tier: plan,
    checkout: checkoutPayload(order, {
      tenantSlug,
      member,
      description: `Diet & Workout · ${plan.months} month${plan.months === 1 ? '' : 's'}`,
    }),
  };
}

/**
 * Turns a paid add-on order into an entitlement and the gym's commission.
 *
 * Idempotent: the claim is a single conditional UPDATE, so whichever of the
 * member's verify call and Razorpay's webhook arrives second finds nothing to
 * do. Everything here is synchronous — node:sqlite has no await points — so
 * no other request can interleave between the claim and the writes.
 */
export function settleAddonPayment({ razorpayOrderId, paymentId }) {
  const payment = one('SELECT * FROM addon_payments WHERE razorpay_order_id = ?', razorpayOrderId);
  if (!payment) throw notFound('No add-on purchase matches that payment');
  if (payment.status === 'paid') return { payment, settled: false };

  const claimed = exec(
    `UPDATE addon_payments SET status = 'paid', razorpay_payment_id = ?, paid_at = datetime('now')
     WHERE id = ? AND status != 'paid'`,
    paymentId, payment.id,
  ).changes;
  if (!claimed) return { payment: one('SELECT * FROM addon_payments WHERE id = ?', payment.id), settled: false };

  try {
    const earnedOn = withTenantDb(payment.tenant_slug, () => {
      activateFitnessAddon({
        memberId: payment.member_id,
        months: payment.months,
        price: payment.amount,
        channel: 'online',
        note: `Paid in the app · Razorpay ${paymentId}`,
      });
      return today();
    });
    exec(
      `INSERT OR IGNORE INTO gym_commissions
         (tenant_slug, source_type, source_id, member_id, description, gross_amount, commission_pct, amount, status, earned_on)
       VALUES (?, 'fitness_addon', ?, ?, ?, ?, ?, ?, 'approved', ?)`,
      payment.tenant_slug,
      payment.id,
      payment.member_id,
      `Diet & Workout add-on · ${payment.months} month${payment.months === 1 ? '' : 's'}`,
      payment.amount,
      payment.commission_pct,
      round2((payment.amount * payment.commission_pct) / 100),
      earnedOn,
    );
  } catch (err) {
    // Hand the claim back so the webhook's retry (or the member's next tap)
    // can finish the job instead of leaving a paid member locked out.
    exec("UPDATE addon_payments SET status = 'created', paid_at = NULL WHERE id = ?", payment.id);
    throw err;
  }
  return { payment: one('SELECT * FROM addon_payments WHERE id = ?', payment.id), settled: true };
}

export function findAddonPayment(razorpayOrderId) {
  return one('SELECT * FROM addon_payments WHERE razorpay_order_id = ?', razorpayOrderId);
}

const CONTACT_FIELDS = {
  name: { type: 'string', required: true, min: 2, max: 80 },
  phone: { type: 'string', required: true, max: 20 },
};
const SHIPPING_FIELDS = {
  ...CONTACT_FIELDS,
  address: { type: 'string', required: true, min: 6, max: 300 },
  city: { type: 'string', required: true, min: 2, max: 60 },
  state: { type: 'string', max: 60 },
  pincode: { type: 'string', required: true, max: 10 },
};

function orderCode() {
  const stamp = today().slice(0, 7).replace('-', '');
  return `GB-${stamp}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

/**
 * Prices a cart from the catalogue — the client sends ids and quantities
 * only — and opens a Razorpay order for it. The gym's commission percentage is
 * fixed onto the order now, so changing the rate later never rewrites what
 * was promised on a sale already made.
 */
export async function createStoreCheckout({ tenantSlug, member, items, shipping, method = 'delivery' }) {
  const settings = monetizationSettings();
  if (settings.store_status !== 'live') throw badRequest('The store is not open yet');
  if (!FULFILLMENT_METHODS.includes(method)) throw badRequest('Choose delivery or pickup', { method: 'is invalid' });
  if (method === 'pickup' && !settings.pickup_enabled) throw badRequest('Pickup at the gym is not available right now');
  requireOnlinePayments();

  if (!Array.isArray(items) || !items.length) throw badRequest('Your cart is empty', { items: 'is required' });
  if (items.length > 20) throw badRequest('At most 20 different items per order', { items: 'at most 20' });
  // A pickup goes to the member's own gym, so it needs only who collects it.
  const ship = parse(shipping, method === 'pickup' ? CONTACT_FIELDS : SHIPPING_FIELDS);
  const phoneDigits = ship.phone.replace(/\D/g, '');
  if (phoneDigits.length < 10 || phoneDigits.length > 12) {
    throw badRequest('Enter a valid 10-digit phone number', { phone: 'must be a 10-digit number' });
  }
  if (method === 'delivery' && !/^\d{6}$/.test(ship.pincode)) {
    throw badRequest('Enter a 6-digit PIN code', { pincode: 'must be 6 digits' });
  }

  const { seller, sellerId } = catalogFor(tenantSlug);
  const lines = items.map((raw, i) => {
    const item = parse(raw, {
      product_id: { type: 'int', required: true, min: 1 },
      variant_id: { type: 'int', min: 1 },
      quantity: { type: 'int', required: true, min: 1, max: 10 },
    });
    const product = one('SELECT * FROM store_products WHERE id = ? AND active = 1 AND seller_id IS ?', item.product_id, sellerId);
    if (!product) throw badRequest(`Item ${i + 1} is no longer available`, { items: `row ${i + 1} unavailable` });
    const variants = many('SELECT * FROM store_product_variants WHERE product_id = ?', product.id);
    let variant = null;
    if (variants.length) {
      variant = variants.find((v) => v.id === item.variant_id);
      if (!variant) throw badRequest(`Pick a flavour or size for ${product.title}`, { items: `row ${i + 1} needs a variant` });
      if (!variant.in_stock) throw badRequest(`${product.title} (${[variant.flavor, variant.weight].filter(Boolean).join(' · ')}) is out of stock`);
    }
    const unitPrice = variant?.price ?? product.price;
    const unitMrp = variant?.mrp ?? product.mrp;
    return {
      product_id: product.id,
      variant_id: variant?.id ?? null,
      title: product.title,
      brand: product.brand,
      variant_label: variant ? [variant.flavor, variant.weight].filter(Boolean).join(' · ') : null,
      image_url: getStoreProduct(product.id).image_url,
      quantity: item.quantity,
      unit_price: unitPrice,
      unit_mrp: unitMrp,
      line_total: round2(unitPrice * item.quantity),
    };
  });

  const subtotal = round2(lines.reduce((sum, l) => sum + l.line_total, 0));
  const mrpTotal = round2(lines.reduce((sum, l) => sum + l.unit_mrp * l.quantity, 0));
  if (subtotal < 1) throw badRequest('The order total must be at least ₹1');
  const rates = shopRates(seller, settings);
  const commissionPct = rates.gym_commission_pct;
  const commission = round2((subtotal * commissionPct) / 100);
  // A partner shop's side, fixed now like the gym's: the platform's fee, and
  // what is left for the shop once the gym's cut and the fee are taken.
  const sellerFeePct = rates.platform_fee_pct;
  const sellerFee = seller ? round2((subtotal * sellerFeePct) / 100) : null;
  const sellerAmount = seller ? Math.max(0, round2(subtotal - commission - sellerFee)) : null;
  const code = orderCode();

  const order = await createOrder({
    amount: subtotal,
    receipt: code,
    notes: { kind: 'store_order', tenant_slug: tenantSlug, member_id: String(member.id), order_code: code },
  });

  const id = registryTx(() => {
    const info = exec(
      `INSERT INTO store_orders
         (order_code, tenant_slug, member_id, member_name, subtotal, mrp_total, total_amount, commission_pct,
          commission_amount, razorpay_order_id, fulfillment_method, shipping_name, shipping_phone, shipping_address,
          shipping_city, shipping_state, shipping_pincode, seller_id, seller_fee_pct, seller_fee_amount, seller_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      code,
      tenantSlug,
      member.id,
      [member.first_name, member.last_name].filter(Boolean).join(' '),
      subtotal,
      mrpTotal,
      subtotal,
      commissionPct,
      commission,
      order.id,
      method,
      ship.name,
      ship.phone,
      ship.address ?? null,
      ship.city ?? null,
      ship.state ?? null,
      ship.pincode ?? null,
      sellerId,
      sellerFeePct,
      sellerFee,
      sellerAmount,
    );
    const orderId = Number(info.lastInsertRowid);
    for (const l of lines) {
      exec(
        `INSERT INTO store_order_items
           (order_id, product_id, variant_id, title, brand, variant_label, image_url, quantity, unit_price, unit_mrp, line_total)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        orderId, l.product_id, l.variant_id, l.title, l.brand, l.variant_label, l.image_url, l.quantity, l.unit_price, l.unit_mrp, l.line_total,
      );
    }
    return orderId;
  });

  return {
    order: storeOrder(id),
    checkout: checkoutPayload(order, { tenantSlug, member, description: `Order ${code}` }),
  };
}

export function storeOrder(id) {
  const order = one('SELECT * FROM store_orders WHERE id = ?', id);
  if (!order) return null;
  return { ...order, items: many('SELECT * FROM store_order_items WHERE order_id = ? ORDER BY id', id) };
}

export function findStoreOrderByRazorpayId(razorpayOrderId) {
  return one('SELECT * FROM store_orders WHERE razorpay_order_id = ?', razorpayOrderId);
}

/** Marks a store order paid and credits the gym — idempotent, as above. */
export function settleStorePayment({ razorpayOrderId, paymentId }) {
  const order = findStoreOrderByRazorpayId(razorpayOrderId);
  if (!order) throw notFound('No store order matches that payment');
  if (order.payment_status === 'paid') return { order: storeOrder(order.id), settled: false };

  const result = registryTx(() => {
    const claimed = exec(
      `UPDATE store_orders SET payment_status = 'paid', razorpay_payment_id = ?, paid_at = datetime('now'),
              updated_at = datetime('now')
       WHERE id = ? AND payment_status = 'pending'`,
      paymentId, order.id,
    ).changes;
    if (!claimed) return { order: storeOrder(order.id), settled: false };

    // A shop with gym commission switched off earns the gym nothing, and a
    // ₹0 line in the gym's statement would only be noise.
    if (!(order.commission_amount > 0)) return { order: storeOrder(order.id), settled: true };
    const earnedOn = withTenantDb(order.tenant_slug, () => today());
    exec(
      `INSERT OR IGNORE INTO gym_commissions
         (tenant_slug, source_type, source_id, member_id, description, gross_amount, commission_pct, amount, status, earned_on)
       VALUES (?, 'store_order', ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      order.tenant_slug,
      order.id,
      order.member_id,
      `Store order ${order.order_code}`,
      order.subtotal,
      order.commission_pct,
      order.commission_amount,
      earnedOn,
    );
    return { order: storeOrder(order.id), settled: true };
  });
  if (result.settled && result.order.seller_id) notifySellerNewOrder(result.order);
  return result;
}

/**
 * An email to the partner shop the moment one of its orders is paid, so a
 * shop that is not watching its panel still packs it the same day. Best
 * effort: no mail server, or a failed send, never touches the payment.
 */
function notifySellerNewOrder(order) {
  const seller = one('SELECT name, email FROM store_sellers WHERE id = ?', order.seller_id);
  if (!seller || !emailEnabled()) return;
  const gym = order.tenant_slug === DEFAULT_TENANT_SLUG ? null : findTenantBySlug(order.tenant_slug);
  const gymName = gym?.gym_name || gym?.display_name || order.tenant_slug;
  const lines = order.items.map((i) => `  ${i.quantity} × ${i.brand ? `${i.brand} ` : ''}${i.title}${i.variant_label ? ` (${i.variant_label})` : ''}`);
  const where =
    order.fulfillment_method === 'pickup'
      ? `Pickup at ${gymName} — take it to the gym's front desk.`
      : `Deliver to ${order.shipping_name}, ${[order.shipping_address, order.shipping_city, order.shipping_pincode].filter(Boolean).join(', ')}`;
  sendEmail({
    to: seller.email,
    subject: `New order ${order.order_code} · ₹${order.total_amount}`,
    text: [
      `Hi ${seller.name},`,
      '',
      `${order.member_name || 'A member'} of ${gymName} just paid for order ${order.order_code}:`,
      ...lines,
      '',
      where,
      `Phone: ${order.shipping_phone}`,
      '',
      `You receive ₹${order.seller_amount} once it is delivered. Open your shop panel to pack it and add tracking.`,
    ].join('\n'),
  }).catch((err) => console.error('[store] seller order email failed:', err.message));
}

/**
 * The webhook's entry point: one Razorpay order id, whichever kind of sale it
 * was. Returns null for an order this module never opened (a gym's SaaS
 * subscription, say), so the caller can ignore it.
 */
export function settleRazorpayOrder(razorpayOrderId, paymentId) {
  if (findAddonPayment(razorpayOrderId)) return settleAddonPayment({ razorpayOrderId, paymentId });
  if (findStoreOrderByRazorpayId(razorpayOrderId)) return settleStorePayment({ razorpayOrderId, paymentId });
  return null;
}

export function listMemberOrders(tenantSlug, memberId) {
  const orders = many(
    `SELECT * FROM store_orders WHERE tenant_slug = ? AND member_id = ? AND payment_status != 'pending'
     ORDER BY created_at DESC, id DESC LIMIT 50`,
    tenantSlug, memberId,
  );
  return orders.map((o) => ({ ...o, items: many('SELECT * FROM store_order_items WHERE order_id = ? ORDER BY id', o.id) }));
}

/* ── Operator: orders, commissions, payouts ───────────────────────────── */

/** `sellerId` as in listStoreProducts: undefined every order, a number one
 * partner shop's. Each row names its shop and its gym for the lists. */
export function listStoreOrders({ status, tenantSlug, sellerId, limit = 200 } = {}) {
  const where = ["o.payment_status != 'pending'"];
  const params = [];
  if (status && FULFILLMENT_STATUSES.includes(status)) {
    where.push('o.fulfillment_status = ?');
    params.push(status);
  }
  if (tenantSlug) {
    where.push('o.tenant_slug = ?');
    params.push(tenantSlug);
  }
  if (sellerId !== undefined) {
    where.push('o.seller_id IS ?');
    params.push(sellerId);
  }
  const orders = many(
    `SELECT o.*, s.name AS seller_name FROM store_orders o LEFT JOIN store_sellers s ON s.id = o.seller_id
     WHERE ${where.join(' AND ')} ORDER BY o.created_at DESC, o.id DESC LIMIT ?`,
    ...params,
    Math.min(Number(limit) || 200, 500),
  );
  const gymNames = new Map();
  const gymName = (slug) => {
    if (!gymNames.has(slug)) {
      const tenant = slug === DEFAULT_TENANT_SLUG ? null : findTenantBySlug(slug);
      gymNames.set(slug, tenant?.gym_name || tenant?.display_name || slug);
    }
    return gymNames.get(slug);
  };
  return orders.map((o) => ({
    ...o,
    gym_name: gymName(o.tenant_slug),
    items: many('SELECT * FROM store_order_items WHERE order_id = ? ORDER BY id', o.id),
  }));
}

/** The steps a partner shop takes itself. "Ready at the gym" and a pickup's
 * "collected" belong to the gym's desk, which actually has the parcel. */
function assertShopMayMove(order, next) {
  if (next === 'ready') throw badRequest('The gym’s front desk marks a pickup as received', { fulfillment_status: 'gym desk only' });
  if (next === 'delivered' && order.fulfillment_method === 'pickup') {
    throw badRequest('The gym’s front desk marks a pickup as collected', { fulfillment_status: 'gym desk only' });
  }
}

/**
 * Moves a paid order along the delivery pipeline. The commission follows it:
 * delivered makes the gym's cut final ('approved'), a cancellation voids it —
 * unless the operator has already paid it out, which is then theirs to settle
 * by hand rather than something to silently claw back.
 */
export function updateStoreOrder(id, payload, { sellerId } = {}) {
  const order = one('SELECT * FROM store_orders WHERE id = ?', id);
  if (!order || (sellerId !== undefined && order.seller_id !== sellerId)) throw notFound('Order not found');
  if (order.payment_status === 'pending') throw badRequest('That order was never paid for');
  const body = parse(payload, {
    fulfillment_status: { type: 'enum', values: FULFILLMENT_STATUSES },
    courier_name: { type: 'string', max: 60 },
    tracking_id: { type: 'string', max: 80 },
    tracking_url: { type: 'string', max: 1000 },
  });
  if (body.tracking_url) body.tracking_url = cleanUrl(body.tracking_url, 'tracking_url');
  const columns = Object.keys(body);
  if (!columns.length) throw badRequest('Nothing to update');
  if (order.fulfillment_status === 'cancelled' && body.fulfillment_status && body.fulfillment_status !== 'cancelled') {
    throw conflict('A cancelled order cannot be reopened');
  }
  if (body.fulfillment_status === 'ready' && order.fulfillment_method !== 'pickup') {
    throw badRequest('"Ready at the gym" is only for pickup orders', { fulfillment_status: 'pickup only' });
  }
  if (sellerId !== undefined && body.fulfillment_status && body.fulfillment_status !== order.fulfillment_status) {
    assertShopMayMove(order, body.fulfillment_status);
  }
  if (order.fulfillment_status === 'delivered' && body.fulfillment_status === 'cancelled' && order.seller_paid_at) {
    throw conflict('The shop has already been paid for this order — settle the refund with them by hand');
  }

  const updated = registryTx(() => {
    exec(
      `UPDATE store_orders SET ${columns.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`,
      ...columns.map((c) => body[c]),
      id,
    );
    if (body.fulfillment_status === 'delivered') {
      exec(
        "UPDATE gym_commissions SET status = 'approved' WHERE source_type = 'store_order' AND source_id = ? AND status = 'pending'",
        id,
      );
    } else if (body.fulfillment_status === 'cancelled') {
      exec(
        "UPDATE gym_commissions SET status = 'void' WHERE source_type = 'store_order' AND source_id = ? AND status IN ('pending', 'approved')",
        id,
      );
    }
    return storeOrder(id);
  });
  if (body.fulfillment_status && body.fulfillment_status !== order.fulfillment_status) notifyOrderUpdate(updated);
  return updated;
}

/* ── Telling the member ───────────────────────────────────────────────── */

/**
 * A push (and notification-centre entry) when an order moves. Runs in the
 * member's own gym database — that is where their devices are registered —
 * and never fails the status change that triggered it.
 */
function notifyOrderUpdate(order) {
  const pickup = order.fulfillment_method === 'pickup';
  const gym = order.tenant_slug === DEFAULT_TENANT_SLUG ? null : findTenantBySlug(order.tenant_slug);
  const gymName = gym?.gym_name || gym?.display_name || 'your gym';
  const messages = {
    shipped: pickup
      ? ['Your order is on its way', `${order.order_code} has shipped to ${gymName}. We'll tell you when it reaches the desk.`]
      : ['Your order is on its way', `${order.order_code} has shipped${order.courier_name ? ` with ${order.courier_name}` : ''}.`],
    ready: ['Ready to collect', `${order.order_code} is waiting at ${gymName}'s front desk.`],
    delivered: pickup ? null : ['Delivered', `${order.order_code} has been delivered. Enjoy!`],
    cancelled: ['Order cancelled', `${order.order_code} was cancelled. Any payment goes back to your UPI account.`],
  };
  const message = messages[order.fulfillment_status];
  if (!message) return;
  try {
    withTenantDb(order.tenant_slug, () =>
      notifyMember(order.member_id, {
        category: 'membership',
        title: message[0],
        body: message[1],
        screen: 'store',
        dedupeKey: `store-order-${order.id}-${order.fulfillment_status}`,
      }),
    )?.catch?.((err) => console.error('[store] order notification failed:', err.message));
  } catch (err) {
    console.error('[store] order notification failed:', err.message);
  }
}

/* ── Gym desk: pickup orders ──────────────────────────────────────────── */

/** This gym's pickup orders that still need the desk, plus the last few
 * collected — what the front desk works from. */
export function listTenantPickups(tenantSlug) {
  const rows = many(
    `SELECT * FROM store_orders
     WHERE tenant_slug = ? AND fulfillment_method = 'pickup' AND payment_status = 'paid'
       AND (fulfillment_status NOT IN ('delivered', 'cancelled') OR updated_at >= datetime('now', '-14 days'))
     ORDER BY CASE fulfillment_status WHEN 'ready' THEN 0 WHEN 'shipped' THEN 1 WHEN 'packed' THEN 2
                                      WHEN 'placed' THEN 3 ELSE 4 END, created_at DESC
     LIMIT 100`,
    tenantSlug,
  );
  return rows.map((o) => ({ ...o, items: many('SELECT * FROM store_order_items WHERE order_id = ? ORDER BY id', o.id) }));
}

function tenantPickupOr404(tenantSlug, id) {
  const order = one('SELECT * FROM store_orders WHERE id = ? AND tenant_slug = ?', id, tenantSlug);
  if (!order || order.fulfillment_method !== 'pickup' || order.payment_status !== 'paid') throw notFound('Pickup order not found');
  return order;
}

/** The parcel reached the gym: it now waits at the desk for the member. */
export function markPickupReceived(tenantSlug, id) {
  const order = tenantPickupOr404(tenantSlug, id);
  if (!['placed', 'packed', 'shipped'].includes(order.fulfillment_status)) {
    throw conflict(`That order is already ${order.fulfillment_status === 'ready' ? 'waiting at the desk' : order.fulfillment_status}`);
  }
  exec("UPDATE store_orders SET fulfillment_status = 'ready', updated_at = datetime('now') WHERE id = ?", order.id);
  const updated = storeOrder(order.id);
  notifyOrderUpdate(updated);
  return updated;
}

/** Handed over at the desk — the pickup equivalent of "delivered", so it
 * makes the gym's commission final too. */
export function markPickupCollected(tenantSlug, id) {
  const order = tenantPickupOr404(tenantSlug, id);
  if (order.fulfillment_status !== 'ready') throw conflict('Mark the parcel as received at the gym first');
  return registryTx(() => {
    exec("UPDATE store_orders SET fulfillment_status = 'delivered', updated_at = datetime('now') WHERE id = ?", order.id);
    exec(
      "UPDATE gym_commissions SET status = 'approved' WHERE source_type = 'store_order' AND source_id = ? AND status = 'pending'",
      order.id,
    );
    return storeOrder(order.id);
  });
}

/* ── Banners ──────────────────────────────────────────────────────────── */

const HEX_RE = /^#[0-9a-f]{6}$/i;

function presentBanner(row) {
  const { image_file: file, ...rest } = row;
  return { ...rest, image_url: storeMediaUrl(file) };
}

export function listBanners({ activeOnly = false } = {}) {
  return many(
    `SELECT * FROM store_banners ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY sort_order, id`,
  ).map(presentBanner);
}

function parseBanner(payload, { creating }) {
  const body = parse(payload, {
    title: { type: 'string', min: 2, max: 60, required: creating },
    subtitle: { type: 'string', max: 120 },
    cta_label: { type: 'string', max: 24 },
    bg_color: { type: 'string', max: 7 },
    link_type: { type: 'enum', values: BANNER_LINKS },
    link_value: { type: 'string', max: 40 },
    active: { type: 'boolean' },
    sort_order: { type: 'int', min: 0, max: 1000 },
  });
  if (body.bg_color && !HEX_RE.test(body.bg_color)) throw badRequest('Pick a colour like #0c831f', { bg_color: 'must be a hex colour' });
  if (body.link_type === 'category' && !STORE_CATEGORIES.includes(body.link_value)) {
    throw badRequest('Pick a category to link to', { link_value: 'unknown category' });
  }
  if (body.link_type === 'product' && !one('SELECT id FROM store_products WHERE id = ?', Number(body.link_value))) {
    throw badRequest('Pick a product to link to', { link_value: 'unknown product' });
  }
  return body;
}

export function createBanner(payload) {
  const body = parseBanner(payload, { creating: true });
  const next = one('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM store_banners').n;
  const info = exec(
    `INSERT INTO store_banners (title, subtitle, cta_label, bg_color, link_type, link_value, active, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    body.title,
    body.subtitle ?? null,
    body.cta_label ?? null,
    body.bg_color ?? '#0c831f',
    body.link_type ?? 'none',
    body.link_type && body.link_type !== 'none' ? body.link_value : null,
    body.active ?? 1,
    body.sort_order ?? next,
  );
  return presentBanner(one('SELECT * FROM store_banners WHERE id = ?', Number(info.lastInsertRowid)));
}

export function updateBanner(id, payload) {
  if (!one('SELECT id FROM store_banners WHERE id = ?', id)) throw notFound('Banner not found');
  const body = parseBanner(payload, { creating: false });
  if (body.link_type === 'none') body.link_value = null;
  const columns = Object.keys(body).filter((k) => body[k] !== null || ['subtitle', 'cta_label', 'link_value'].includes(k));
  if (!columns.length) throw badRequest('Nothing to update');
  exec(
    `UPDATE store_banners SET ${columns.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
    ...columns.map((k) => body[k]),
    id,
  );
  return presentBanner(one('SELECT * FROM store_banners WHERE id = ?', id));
}

export function setBannerImage(id, bytes) {
  const banner = one('SELECT * FROM store_banners WHERE id = ?', id);
  if (!banner) throw notFound('Banner not found');
  const file = writeStoreImage(`b${id}`, bytes);
  exec('UPDATE store_banners SET image_file = ? WHERE id = ?', file, id);
  if (banner.image_file && banner.image_file !== file) removeStoreImage(banner.image_file);
  return presentBanner(one('SELECT * FROM store_banners WHERE id = ?', id));
}

export function clearBannerImage(id) {
  const banner = one('SELECT * FROM store_banners WHERE id = ?', id);
  if (!banner) throw notFound('Banner not found');
  exec('UPDATE store_banners SET image_file = NULL WHERE id = ?', id);
  removeStoreImage(banner.image_file);
  return presentBanner(one('SELECT * FROM store_banners WHERE id = ?', id));
}

export function deleteBanner(id) {
  const banner = one('SELECT * FROM store_banners WHERE id = ?', id);
  if (!banner) throw notFound('Banner not found');
  exec('DELETE FROM store_banners WHERE id = ?', id);
  removeStoreImage(banner.image_file);
  return { deleted: true };
}

/* ── Quality badges ───────────────────────────────────────────────────── */

function presentBadge(row) {
  const { image_file: file, ...rest } = row;
  return { ...rest, image_url: storeMediaUrl(file) };
}

const badgeRow = (id) => one('SELECT * FROM store_badges WHERE id = ?', id);

/** The library, each with how many products carry it. */
export function listBadges() {
  return many(
    `SELECT b.*, (SELECT COUNT(*) FROM store_product_badges pb WHERE pb.badge_id = b.id) AS product_count
     FROM store_badges b ORDER BY b.id`,
  ).map(presentBadge);
}

function parseBadge(payload, { creating }) {
  return parse(payload, {
    name: { type: 'string', min: 2, max: 30, required: creating },
    active: { type: 'boolean' },
  });
}

export function createBadge(payload) {
  const body = parseBadge(payload, { creating: true });
  const info = exec('INSERT INTO store_badges (name, active) VALUES (?, ?)', body.name, body.active ?? 1);
  return presentBadge(badgeRow(Number(info.lastInsertRowid)));
}

export function updateBadge(id, payload) {
  if (!badgeRow(id)) throw notFound('Badge not found');
  const body = parseBadge(payload, { creating: false });
  const columns = Object.keys(body).filter((k) => body[k] !== null);
  if (!columns.length) throw badRequest('Nothing to update');
  exec(`UPDATE store_badges SET ${columns.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...columns.map((k) => body[k]), id);
  return presentBadge(badgeRow(id));
}

export function setBadgeImage(id, bytes) {
  const badge = badgeRow(id);
  if (!badge) throw notFound('Badge not found');
  const file = writeStoreImage(`q${id}`, bytes);
  exec('UPDATE store_badges SET image_file = ? WHERE id = ?', file, id);
  if (badge.image_file && badge.image_file !== file) removeStoreImage(badge.image_file);
  return presentBadge(badgeRow(id));
}

/** Takes the badge off every product that carried it. */
export function deleteBadge(id) {
  const badge = badgeRow(id);
  if (!badge) throw notFound('Badge not found');
  registryTx(() => {
    exec('DELETE FROM store_product_badges WHERE badge_id = ?', id);
    exec('DELETE FROM store_badges WHERE id = ?', id);
  });
  removeStoreImage(badge.image_file);
  return { deleted: true };
}

/* ── Storefront ───────────────────────────────────────────────────────── */

/** Everything the member's store screen draws from, in one read. */
export function storefront(tenantSlug) {
  const settings = monetizationSettings();
  const live = settings.store_status === 'live';
  const tenant = tenantSlug === DEFAULT_TENANT_SLUG ? null : findTenantBySlug(tenantSlug);
  const { seller, sellerId } = catalogFor(tenantSlug);
  const products = live ? listStoreProducts({ activeOnly: true, sellerId }) : [];
  // A banner pointing at a product this gym's shelf does not carry would open
  // nothing, so it is left out; category and plain banners show everywhere.
  const onShelf = new Set(products.map((p) => String(p.id)));
  return {
    status: settings.store_status,
    payments_ready: isRazorpayOrdersConfigured(),
    delivery: {
      eta: seller?.delivery_eta || settings.delivery_eta,
      pickup_enabled: Boolean(settings.pickup_enabled),
      pickup_eta: seller?.pickup_eta || settings.pickup_eta,
      gym_name: tenant?.gym_name || tenant?.display_name || 'your gym',
    },
    seller: seller ? { name: seller.name, city: seller.city, area: seller.area } : null,
    banners: live
      ? listBanners({ activeOnly: true }).filter((b) => b.link_type !== 'product' || onShelf.has(String(b.link_value)))
      : [],
    products,
  };
}

/** Per-gym balances: what is earned but not final, owed now, and paid out. */
export function commissionBalances() {
  return many(
    `SELECT tenant_slug,
            COALESCE(SUM(CASE WHEN status = 'pending' THEN amount END), 0) AS pending,
            COALESCE(SUM(CASE WHEN status = 'approved' THEN amount END), 0) AS payable,
            COALESCE(SUM(CASE WHEN status = 'paid' THEN amount END), 0) AS paid,
            COUNT(CASE WHEN status != 'void' THEN 1 END) AS sales
     FROM gym_commissions GROUP BY tenant_slug ORDER BY payable DESC, tenant_slug`,
  ).map((row) => {
    const tenant = row.tenant_slug === DEFAULT_TENANT_SLUG ? null : findTenantBySlug(row.tenant_slug);
    return { ...row, gym_name: tenant?.gym_name ?? tenant?.display_name ?? row.tenant_slug };
  });
}

/** Marks everything currently payable to one gym as paid under one reference
 * (the bank transfer's UTR). Pending store commissions wait for delivery. */
export function recordPayout(tenantSlug, payload) {
  const body = parse(payload, { payout_ref: { type: 'string', required: true, min: 3, max: 80 } });
  return registryTx(() => {
    const due = one(
      "SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total FROM gym_commissions WHERE tenant_slug = ? AND status = 'approved'",
      tenantSlug,
    );
    if (!due.n) throw badRequest('Nothing is payable to this gym right now');
    exec(
      `UPDATE gym_commissions SET status = 'paid', payout_ref = ?, paid_at = datetime('now')
       WHERE tenant_slug = ? AND status = 'approved'`,
      body.payout_ref, tenantSlug,
    );
    return { tenant_slug: tenantSlug, count: due.n, total: round2(due.total), payout_ref: body.payout_ref };
  });
}

/** Platform-wide totals for the console header. */
export function monetizationSummary() {
  return {
    store: one(
      `SELECT COUNT(*) AS orders, COALESCE(SUM(total_amount), 0) AS gmv,
              COUNT(CASE WHEN fulfillment_status IN ('placed', 'packed') THEN 1 END) AS to_ship
       FROM store_orders WHERE payment_status = 'paid' AND fulfillment_status != 'cancelled'`,
    ),
    addon: one("SELECT COUNT(*) AS sales, COALESCE(SUM(amount), 0) AS revenue FROM addon_payments WHERE status = 'paid'"),
    commissions: one(
      `SELECT COALESCE(SUM(CASE WHEN status IN ('pending', 'approved') THEN amount END), 0) AS owed,
              COALESCE(SUM(CASE WHEN status = 'paid' THEN amount END), 0) AS paid
       FROM gym_commissions`,
    ),
    products: one('SELECT COUNT(*) AS total, COUNT(CASE WHEN active = 1 THEN 1 END) AS active FROM store_products'),
  };
}

/* ── Gym owner: earnings from the platform ────────────────────────────── */

/** One gym's commission totals since `from` (a gym-local YYYY-MM-DD). */
export function tenantCommissionSummary(tenantSlug, from) {
  const row = one(
    `SELECT
       COALESCE(SUM(CASE WHEN earned_on >= ? AND status != 'void' THEN amount END), 0) AS month_total,
       COALESCE(SUM(CASE WHEN earned_on >= ? AND status != 'void' AND source_type = 'store_order' THEN amount END), 0) AS month_store,
       COALESCE(SUM(CASE WHEN earned_on >= ? AND status != 'void' AND source_type = 'fitness_addon' THEN amount END), 0) AS month_addon,
       COALESCE(SUM(CASE WHEN status = 'pending' THEN amount END), 0) AS pending,
       COALESCE(SUM(CASE WHEN status = 'approved' THEN amount END), 0) AS payable,
       COALESCE(SUM(CASE WHEN status = 'paid' THEN amount END), 0) AS paid,
       COALESCE(SUM(CASE WHEN earned_on >= ? AND status != 'void' AND source_type = 'store_order' THEN gross_amount END), 0) AS gmv_month,
       COUNT(CASE WHEN earned_on >= ? AND status != 'void' AND source_type = 'store_order' THEN 1 END) AS orders_month,
       COUNT(CASE WHEN earned_on >= ? AND status != 'void' AND source_type = 'fitness_addon' THEN 1 END) AS addon_sales_month
     FROM gym_commissions WHERE tenant_slug = ?`,
    from, from, from, from, from, from, tenantSlug,
  );
  const settings = monetizationSettings();
  return {
    ...Object.fromEntries(Object.entries(row).map(([k, v]) => [k, round2(v)])),
    // What this gym actually earns on its shelf — a shop serving it may carry
    // its own rate, or none.
    store_commission_pct: shopRates(catalogFor(tenantSlug).seller, settings).gym_commission_pct,
    addon_commission_pct: settings.addon_commission_pct,
    store_status: settings.store_status,
  };
}

/** The gym's commission statement: every credited sale, newest first, with the
 * store order behind it where there is one. */
export function tenantCommissionLedger(tenantSlug, { limit = 200 } = {}) {
  return many(
    `SELECT c.*, o.order_code, o.member_name, o.fulfillment_status, o.total_amount AS order_value,
            (SELECT COUNT(*) FROM store_order_items i WHERE i.order_id = o.id) AS item_count
     FROM gym_commissions c
     LEFT JOIN store_orders o ON c.source_type = 'store_order' AND o.id = c.source_id
     WHERE c.tenant_slug = ?
     ORDER BY c.created_at DESC, c.id DESC LIMIT ?`,
    tenantSlug,
    Math.min(Number(limit) || 200, 500),
  );
}
