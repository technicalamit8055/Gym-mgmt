import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tenants (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  slug             TEXT NOT NULL UNIQUE,
  display_name     TEXT NOT NULL,
  gym_name         TEXT,
  currency         TEXT NOT NULL DEFAULT 'INR',
  status           TEXT NOT NULL DEFAULT 'trial'
                   CHECK (status IN ('trial', 'active', 'suspended', 'cancelled')),
  db_file          TEXT NOT NULL,
  plan_code        TEXT,
  trial_ends_on    TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  suspended_at     TEXT,
  suspended_reason TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_slug ON tenants(slug);

CREATE TABLE IF NOT EXISTS biometric_devices (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  serial_number TEXT NOT NULL UNIQUE,
  tenant_slug   TEXT NOT NULL,
  label         TEXT,
  last_seen_at  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_serial ON biometric_devices(serial_number);
`;

/** Append-only: CREATE TABLE IF NOT EXISTS never retrofits columns onto an
 * already-created table, so each future registry column change becomes one
 * more guarded ALTER TABLE here. */
function ensureColumn(db, table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

const MIGRATIONS = [
  (db) => ensureColumn(db, 'tenants', 'razorpay_customer_id', 'TEXT'),
  (db) => ensureColumn(db, 'tenants', 'razorpay_subscription_id', 'TEXT'),
  (db) => ensureColumn(db, 'tenants', 'razorpay_checkout_url', 'TEXT'),
  (db) => ensureColumn(db, 'tenants', 'razorpay_last_event_at', 'INTEGER'),
  (db) => db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_razorpay_subscription ON tenants(razorpay_subscription_id)',
  ),
  // IANA name ("Asia/Kolkata"), not an offset — offsets change twice a year
  // under DST and a gym's opening hours don't. NULL means "use the server's
  // own timezone", which is what every gym created before this column did.
  (db) => ensureColumn(db, 'tenants', 'timezone', 'TEXT'),
  (db) => ensureColumn(db, 'tenants', 'logo_mime', 'TEXT'),
  (db) => ensureColumn(db, 'tenants', 'logo_bytes', 'BLOB'),
  (db) => ensureColumn(db, 'tenants', 'logo_version', 'INTEGER DEFAULT 0'),
  // The same logo, redrawn at 512px on its own background with the padding an
  // Android launcher crops into. Stored rather than derived on request: the
  // server has no image decoder, so this is made in the browser at upload time
  // (see makeAppIcon in public/js/photo.js). Shares logo_version — the two
  // always change together.
  (db) => ensureColumn(db, 'tenants', 'icon_mime', 'TEXT'),
  (db) => ensureColumn(db, 'tenants', 'icon_bytes', 'BLOB'),
  // Which product this tenant signed up for. 'gym' is the only thing that
  // existed before this column, so it is both the right ALTER default and the
  // correct value for every already-provisioned tenant — no backfill needed.
  // Unlike most CHECKs added after the fact this one needs no table rebuild:
  // SQLite accepts a column-level CHECK on ADD COLUMN.
  (db) => ensureColumn(
    db,
    'tenants',
    'business_type',
    "TEXT NOT NULL DEFAULT 'gym' CHECK (business_type IN ('gym', 'library'))",
  ),
  (db) => db.exec('CREATE INDEX IF NOT EXISTS idx_tenants_business_type ON tenants(business_type)'),
];

let registryDb;

function getRegistryDb() {
  if (registryDb) return registryDb;
  fs.mkdirSync(path.dirname(path.resolve(config.platformDbFile)), { recursive: true });
  registryDb = new DatabaseSync(config.platformDbFile);
  registryDb.exec('PRAGMA journal_mode = WAL');
  registryDb.exec(SCHEMA);
  for (const migrate of MIGRATIONS) migrate(registryDb);
  return registryDb;
}

function plain(row) {
  return row === undefined ? undefined : { ...row };
}

export const RESERVED_SLUGS = new Set([
  'www', 'api', 'app', 'admin', 'static', 'assets', 'mail', 'ns1', 'ns2', 'localhost', 'default',
]);
const SLUG_RE = /^[a-z][a-z0-9-]{2,39}$/;

export function isValidSlug(slug) {
  return typeof slug === 'string' && SLUG_RE.test(slug) && !RESERVED_SLUGS.has(slug);
}

export function tenantDbPath(slug) {
  if (!isValidSlug(slug)) throw new Error(`Refusing to build a path for invalid slug "${slug}"`);
  return path.join(config.tenantsDir, `${slug}.db`);
}

export function findTenantBySlug(slug) {
  return plain(getRegistryDb().prepare('SELECT * FROM tenants WHERE slug = ?').get(slug));
}

/**
 * A registry row with its image BLOBs dropped, safe to serialise into JSON.
 *
 * `SELECT *` carries logo_bytes and icon_bytes, which are binary, potentially
 * large, and useless to any API client — each is served from its own endpoint.
 * Booleans stand in so callers can still tell whether one is set.
 */
export function withoutLogoBytes(tenant) {
  if (!tenant) return tenant;
  const { logo_bytes: logoBytes, icon_bytes: iconBytes, ...rest } = tenant;
  return {
    ...rest,
    has_logo: Boolean(logoBytes && tenant.logo_mime),
    has_app_icon: Boolean(iconBytes && tenant.icon_mime),
  };
}

export function listTenants() {
  return getRegistryDb().prepare('SELECT * FROM tenants ORDER BY created_at').all().map(plain);
}

export function createTenant({
  slug,
  displayName,
  gymName,
  currency = 'INR',
  timezone,
  trialEndsOn,
  businessType = 'gym',
} = {}) {
  if (!isValidSlug(slug)) throw new Error(`Invalid tenant slug "${slug}"`);
  const dbFile = `tenants/${slug}.db`;
  getRegistryDb()
    .prepare(
      `INSERT INTO tenants (slug, display_name, gym_name, currency, timezone, db_file, trial_ends_on, business_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      slug,
      displayName,
      gymName ?? displayName,
      currency,
      timezone ?? null,
      dbFile,
      trialEndsOn ?? null,
      businessType,
    );
  return findTenantBySlug(slug);
}

/**
 * Moves an existing tenant to another product. Deliberately not reachable from
 * updateTenantProfile() below: an owner flipping their own vertical mid-life is
 * not a supported operation — the nav, seeded catalogue and member-code prefix
 * are all decided at signup. This exists for the operator console, to fix a
 * type mis-selected during signup.
 */
export function setTenantBusinessType(slug, businessType) {
  getRegistryDb()
    .prepare('UPDATE tenants SET business_type = ? WHERE slug = ?')
    .run(businessType, slug);
  return findTenantBySlug(slug);
}

/**
 * Edits the gym's own identity — the settings its owner controls. Billing
 * status is deliberately not reachable from here: it is owned by the Razorpay
 * webhook and the operator console, never by the gym itself.
 *
 * COALESCE on every column so a partial update leaves the rest alone.
 */
export function updateTenantProfile(
  slug,
  { gymName, currency, timezone, logoMime, logoBytes, iconMime, iconBytes, clearLogo } = {},
) {
  const sets = [
    'gym_name     = COALESCE(?, gym_name)',
    'display_name = COALESCE(?, display_name)',
    'currency     = COALESCE(?, currency)',
    'timezone     = COALESCE(?, timezone)',
  ];
  const params = [gymName ?? null, gymName ?? null, currency ?? null, timezone ?? null];

  // The logo and the app icon drawn from it are one fact, written and cleared
  // together: leaving a stale icon behind would keep installing the old brand.
  if (clearLogo) {
    sets.push(
      'logo_mime = NULL',
      'logo_bytes = NULL',
      'icon_mime = NULL',
      'icon_bytes = NULL',
      'logo_version = COALESCE(logo_version, 0) + 1',
    );
  } else if (logoMime && logoBytes) {
    sets.push(
      'logo_mime = ?',
      'logo_bytes = ?',
      // Null when an older client uploads a logo without an icon — better no
      // icon (the app falls back to its own) than the previous gym logo's one.
      'icon_mime = ?',
      'icon_bytes = ?',
      'logo_version = COALESCE(logo_version, 0) + 1',
    );
    params.push(logoMime, logoBytes, iconMime ?? null, iconBytes ?? null);
  }

  params.push(slug);
  getRegistryDb()
    .prepare(`UPDATE tenants SET ${sets.join(', ')} WHERE slug = ?`)
    .run(...params);
  return findTenantBySlug(slug);
}

export function countTenants() {
  return getRegistryDb().prepare('SELECT COUNT(*) AS n FROM tenants').get().n;
}

/**
 * Removes a gym from the registry, along with any biometric devices pointed at
 * it — an orphaned device row would otherwise keep routing scans to a gym that
 * no longer exists.
 *
 * Deliberately does *not* touch the gym's SQLite file: closing the open handle
 * first is the caller's job, and on Windows an unlink against an open file
 * fails outright. See the operator console's delete route.
 */
export function deleteTenant(slug) {
  const db = getRegistryDb();
  db.prepare('DELETE FROM biometric_devices WHERE tenant_slug = ?').run(slug);
  return db.prepare('DELETE FROM tenants WHERE slug = ?').run(slug).changes;
}

export function setTenantStatus(slug, status, reason) {
  getRegistryDb()
    .prepare(
      `UPDATE tenants SET status = ?,
         suspended_at = CASE WHEN ? = 'suspended' THEN datetime('now') ELSE suspended_at END,
         suspended_reason = ?
       WHERE slug = ?`,
    )
    .run(status, status, reason ?? null, slug);
}

/** Moves a trial's end date — the operator console's way of granting an
 * extension without touching Razorpay. */
export function setTenantTrialEnd(slug, trialEndsOn) {
  getRegistryDb().prepare('UPDATE tenants SET trial_ends_on = ? WHERE slug = ?').run(trialEndsOn ?? null, slug);
  return findTenantBySlug(slug);
}

export function findTenantBySubscriptionId(subscriptionId) {
  return plain(
    getRegistryDb().prepare('SELECT * FROM tenants WHERE razorpay_subscription_id = ?').get(subscriptionId),
  );
}

export function setTenantBilling(slug, { customerId, subscriptionId, checkoutUrl } = {}) {
  getRegistryDb()
    .prepare(
      `UPDATE tenants
         SET razorpay_customer_id     = COALESCE(?, razorpay_customer_id),
             razorpay_subscription_id = COALESCE(?, razorpay_subscription_id),
             razorpay_checkout_url    = COALESCE(?, razorpay_checkout_url)
       WHERE slug = ?`,
    )
    .run(customerId ?? null, subscriptionId ?? null, checkoutUrl ?? null, slug);
  return findTenantBySlug(slug);
}

/**
 * Lazily flips lapsed trials to 'suspended', mirroring maintenance.js's
 * lazy-expiry pattern — no scheduler, just a cheap UPDATE before any read
 * that cares about tenant status.
 *
 * The one place `date('now')` is deliberately left as UTC. This runs from
 * resolveTenant *before* a tenant is resolved, so there is no gym timezone to
 * use, and a trial ending is a platform-side fact rather than a gym-clock one.
 * The trial end is also written in the same UTC terms at signup, so the two
 * agree; the worst case is a trial ending a few hours off a gym's local
 * midnight, which nobody can perceive on a seven-day trial.
 */
export function expireOverdueTrials() {
  return getRegistryDb()
    .prepare(
      `UPDATE tenants SET status = 'suspended', suspended_at = datetime('now'), suspended_reason = 'trial expired'
       WHERE status = 'trial' AND trial_ends_on IS NOT NULL AND trial_ends_on < date('now')`,
    )
    .run().changes;
}

/**
 * Applies a webhook-reported status change atomically, guarded against
 * out-of-order redelivery via the event's own timestamp — a single UPDATE,
 * no read-then-write gap, so concurrent/duplicate/out-of-order webhooks
 * can't corrupt status.
 */
export function applyWebhookStatus(subscriptionId, { status, reason, eventCreatedAt }) {
  return (
    getRegistryDb()
      .prepare(
        `UPDATE tenants
           SET status = ?,
               suspended_at = CASE WHEN ? = 'suspended' THEN datetime('now') ELSE suspended_at END,
               suspended_reason = ?,
               razorpay_last_event_at = ?
         WHERE razorpay_subscription_id = ?
           AND (razorpay_last_event_at IS NULL OR razorpay_last_event_at <= ?)`,
      )
      .run(status, status, reason ?? null, eventCreatedAt, subscriptionId, eventCreatedAt).changes > 0
  );
}

export function findTenantSlugByDeviceSerial(serial) {
  const row = getRegistryDb()
    .prepare('SELECT tenant_slug FROM biometric_devices WHERE serial_number = ?')
    .get(serial);
  return row?.tenant_slug;
}

export function registerDevice(tenantSlug, { serial, label } = {}) {
  getRegistryDb()
    .prepare('INSERT INTO biometric_devices (serial_number, tenant_slug, label) VALUES (?, ?, ?)')
    .run(serial, tenantSlug, label ?? null);
}

export function touchDeviceLastSeen(serial) {
  getRegistryDb()
    .prepare("UPDATE biometric_devices SET last_seen_at = datetime('now') WHERE serial_number = ?")
    .run(serial);
}

export function listDevicesForTenant(slug) {
  return getRegistryDb()
    .prepare('SELECT * FROM biometric_devices WHERE tenant_slug = ? ORDER BY created_at')
    .all(slug)
    .map(plain);
}

export function removeDevice(tenantSlug, serial) {
  return getRegistryDb()
    .prepare('DELETE FROM biometric_devices WHERE tenant_slug = ? AND serial_number = ?')
    .run(tenantSlug, serial).changes;
}

export function closeRegistryDb() {
  if (registryDb) {
    registryDb.close();
    registryDb = undefined;
  }
}
