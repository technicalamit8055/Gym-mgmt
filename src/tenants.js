import crypto from 'node:crypto';
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

-- A gym's own hostname (app.theirgym.com). See src/customDomains.js.
CREATE TABLE IF NOT EXISTS custom_domains (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_slug        TEXT NOT NULL,
  hostname           TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active')),
  verification_token TEXT NOT NULL,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  verified_at        TEXT,
  last_checked_at    TEXT,
  last_check         TEXT,
  UNIQUE (tenant_slug, hostname)
);
-- Unique among *active* rows only. Several gyms may hold a pending claim on
-- the same hostname; the one whose verification token appears in its DNS wins,
-- so typing someone else's domain in first cannot lock its real owner out.
CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_domains_active ON custom_domains(hostname) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_custom_domains_tenant ON custom_domains(tenant_slug);
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
  // SQLite accepts a column-level CHECK on ADD COLUMN. Widening it later does
  // need one — see widenBusinessTypeCheck() at the end of this list.
  (db) => ensureColumn(
    db,
    'tenants',
    'business_type',
    "TEXT NOT NULL DEFAULT 'gym' CHECK (business_type IN ('gym', 'library'))",
  ),
  (db) => db.exec('CREATE INDEX IF NOT EXISTS idx_tenants_business_type ON tenants(business_type)'),
  // The colour palette the owner picked in settings, applied on every device
  // that opens this gym — staff app and member portal alike. NULL means the
  // vertical's default palette (see `themes` in verticals.js).
  (db) => ensureColumn(db, 'tenants', 'theme', 'TEXT'),
  // A short motto under the gym's name on the member-app desk poster.
  // NULL or empty means none.
  (db) => ensureColumn(db, 'tenants', 'tagline', 'TEXT'),
  // How a member finds this gym in the store-listed member app, which serves
  // every gym: by a short code typed off the desk poster, or by name/city in
  // the directory (see routes/directory.js). The code is not a secret — it
  // only finds the gym; signing in still takes the member's own password.
  (db) => ensureColumn(db, 'tenants', 'gym_code', 'TEXT'),
  (db) => db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_gym_code ON tenants(gym_code)'),
  (db) => ensureColumn(db, 'tenants', 'address_line', 'TEXT'),
  (db) => ensureColumn(db, 'tenants', 'city', 'TEXT'),
  (db) => ensureColumn(db, 'tenants', 'state', 'TEXT'),
  (db) => ensureColumn(db, 'tenants', 'pincode', 'TEXT'),
  // Whether a name search finds this gym. Off only hides it from search — the
  // code and the desk QR still work, so a members-only gym stays reachable.
  (db) => ensureColumn(db, 'tenants', 'listed_in_app', 'INTEGER NOT NULL DEFAULT 1'),
  // Every gym created before codes existed gets one. Runs on each open but
  // only ever touches rows still without a code.
  (db) => {
    const missing = db.prepare('SELECT slug, gym_name, display_name FROM tenants WHERE gym_code IS NULL').all();
    const assign = db.prepare('UPDATE tenants SET gym_code = ? WHERE slug = ?');
    for (const row of missing) assign.run(newGymCode(db, row.gym_name || row.display_name), row.slug);
  },
  // CoachBook: widens business_type's CHECK to admit 'coaching'. SQLite cannot
  // alter a CHECK in place, so the table is rebuilt from its own stored DDL —
  // every column added by the ALTERs above is already in that text, so nothing
  // is lost and no column list has to be kept in step here. The indexes are
  // read back first, because DROP TABLE takes them with it.
  (db) => widenBusinessTypeCheck(db),
  // Whether this gym's members keep their member app (workouts, diet, store,
  // add-on) while the gym itself is suspended for a lapsed trial or payment.
  // An operator call made gym by gym — usually for a gym whose members still
  // buy from the store or pay for the add-on — so off unless switched on, which
  // is also how every gym behaved before this column. Staff stay locked out
  // either way; see requireActiveSubscription in tenant.js.
  (db) => ensureColumn(db, 'tenants', 'member_app_after_lapse', 'INTEGER NOT NULL DEFAULT 0'),
];

const BUSINESS_TYPE_CHECK = "CHECK (business_type IN ('gym', 'library', 'coaching'))";

function widenBusinessTypeCheck(db) {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tenants'").get();
  if (!table || table.sql.includes("'coaching'")) return;

  const ddl = table.sql
    .replace(/CHECK\s*\(\s*business_type\s+IN\s*\([^)]*\)\s*\)/i, BUSINESS_TYPE_CHECK)
    .replace(/^CREATE TABLE\s+"?tenants"?/i, 'CREATE TABLE tenants_rebuilt');
  if (!ddl.includes("'coaching'") || !ddl.startsWith('CREATE TABLE tenants_rebuilt')) {
    throw new Error('Could not widen tenants.business_type: unexpected table definition');
  }
  const indexes = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tenants' AND sql IS NOT NULL")
    .all();

  db.exec('BEGIN');
  try {
    db.exec(ddl);
    db.exec('INSERT INTO tenants_rebuilt SELECT * FROM tenants');
    db.exec('DROP TABLE tenants');
    db.exec('ALTER TABLE tenants_rebuilt RENAME TO tenants');
    for (const index of indexes) db.exec(index.sql);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Gym codes are read off a poster and typed on a phone, so the alphabet drops
 * the characters people confuse — 0/O, 1/I/L — and is upper-case only.
 */
const CODE_LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_DIGITS = '23456789';
const CODE_ALPHABET = CODE_LETTERS + CODE_DIGITS;
export const GYM_CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{6}$`);

/** What a member typed, as a code to look up: case, spaces and dashes don't
 * matter ("amt 482", "AMT-482"). Null when it cannot be a code at all. */
export function normalizeGymCode(input) {
  const code = String(input ?? '').toUpperCase().replace(/[\s-]+/g, '');
  return GYM_CODE_RE.test(code) ? code : null;
}

const randomFrom = (chars, n) => Array.from({ length: n }, () => chars[crypto.randomInt(chars.length)]).join('');

/**
 * A free code that reads like the gym: three letters from its name and three
 * digits ("Iron House" → IRN482). Only 512 codes per prefix, so a busy prefix
 * falls back to six random characters, which never realistically collide.
 */
function newGymCode(db, name) {
  const taken = db.prepare('SELECT 1 FROM tenants WHERE gym_code = ?');
  const letters = String(name ?? '').toUpperCase().split('').filter((c) => CODE_LETTERS.includes(c));
  const prefix = (letters.join('') + randomFrom(CODE_LETTERS, 3)).slice(0, 3);
  for (let i = 0; i < 20; i += 1) {
    const code = prefix + randomFrom(CODE_DIGITS, 3);
    if (!taken.get(code)) return code;
  }
  for (;;) {
    const code = randomFrom(CODE_ALPHABET, 6);
    if (!taken.get(code)) return code;
  }
}

let registryDb;

export function getRegistryDb() {
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

/** What a push notification needs to look like it came from this gym — its
 * name and whether it has an icon/logo — without reading either image BLOB. */
export function tenantBranding(slug) {
  return plain(
    getRegistryDb()
      .prepare(
        `SELECT slug, gym_name, display_name, logo_version,
                (icon_bytes IS NOT NULL AND icon_mime IS NOT NULL) AS has_icon,
                (logo_bytes IS NOT NULL AND logo_mime IS NOT NULL) AS has_logo
         FROM tenants WHERE slug = ?`,
      )
      .get(slug),
  );
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

export function findTenantByGymCode(code) {
  const normalized = normalizeGymCode(code);
  if (!normalized) return undefined;
  return plain(getRegistryDb().prepare('SELECT * FROM tenants WHERE gym_code = ?').get(normalized));
}

/** Escapes LIKE's own wildcards, so a search for "50%" is not a match-all. */
const likeTerm = (text) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * The member app's "find your gym" search: listed gyms that are open for
 * business, matched on name, city or pincode. Names that start with the query
 * rank first — someone typing "iron" means Iron House before Pumping Iron.
 */
export function searchDirectory(query, { businessType, limit = 20 } = {}) {
  const term = String(query ?? '').trim();
  const params = [likeTerm(term), likeTerm(term), term];
  let where = `status IN ('trial', 'active') AND listed_in_app = 1
    AND (COALESCE(gym_name, display_name) LIKE ? ESCAPE '\\' OR city LIKE ? ESCAPE '\\' OR pincode = ?)`;
  if (businessType) {
    where += ' AND business_type = ?';
    params.push(businessType);
  }
  return getRegistryDb()
    .prepare(
      `SELECT * FROM tenants WHERE ${where}
       ORDER BY (COALESCE(gym_name, display_name) LIKE ? ESCAPE '\\') DESC, COALESCE(gym_name, display_name) COLLATE NOCASE
       LIMIT ?`,
    )
    .all(...params, `${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, limit)
    .map(plain);
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
  const db = getRegistryDb();
  db
    .prepare(
      `INSERT INTO tenants (slug, display_name, gym_name, currency, timezone, db_file, trial_ends_on, business_type, gym_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      newGymCode(db, gymName ?? displayName),
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
  {
    gymName,
    currency,
    timezone,
    theme,
    tagline,
    addressLine,
    city,
    state,
    pincode,
    listedInApp,
    logoMime,
    logoBytes,
    iconMime,
    iconBytes,
    clearLogo,
  } = {},
) {
  const sets = [
    'gym_name      = COALESCE(?, gym_name)',
    'display_name  = COALESCE(?, display_name)',
    'currency      = COALESCE(?, currency)',
    'timezone      = COALESCE(?, timezone)',
    'theme         = COALESCE(?, theme)',
    'tagline       = COALESCE(?, tagline)',
    'address_line  = COALESCE(?, address_line)',
    'city          = COALESCE(?, city)',
    'state         = COALESCE(?, state)',
    'pincode       = COALESCE(?, pincode)',
    'listed_in_app = COALESCE(?, listed_in_app)',
  ];
  const params = [
    gymName ?? null,
    gymName ?? null,
    currency ?? null,
    timezone ?? null,
    theme ?? null,
    tagline ?? null,
    addressLine ?? null,
    city ?? null,
    state ?? null,
    pincode ?? null,
    listedInApp == null ? null : listedInApp ? 1 : 0,
  ];

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
 * Removes a gym from the registry, along with any biometric devices and custom
 * domains pointed at it — an orphaned row would otherwise keep routing scans
 * or visitors to a gym that no longer exists, and keep its hostname claimed.
 *
 * Deliberately does *not* touch the gym's SQLite file: closing the open handle
 * first is the caller's job, and on Windows an unlink against an open file
 * fails outright. See the operator console's delete route.
 */
export function deleteTenant(slug) {
  const db = getRegistryDb();
  db.prepare('DELETE FROM biometric_devices WHERE tenant_slug = ?').run(slug);
  db.prepare('DELETE FROM custom_domains WHERE tenant_slug = ?').run(slug);
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

/** Keeps (or stops keeping) a gym's member app open while the gym is
 * suspended. Set from the operator console only — never the gym's own. */
export function setTenantMemberAppAfterLapse(slug, allowed) {
  getRegistryDb().prepare('UPDATE tenants SET member_app_after_lapse = ? WHERE slug = ?').run(allowed ? 1 : 0, slug);
  return findTenantBySlug(slug);
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
