import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'staff'
                CHECK (role IN ('admin', 'manager', 'trainer', 'staff')),
  phone         TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS members (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  code              TEXT NOT NULL UNIQUE,
  first_name        TEXT NOT NULL,
  last_name         TEXT NOT NULL DEFAULT '',
  email             TEXT,
  phone             TEXT,
  gender            TEXT CHECK (gender IN ('male', 'female', 'other', '') OR gender IS NULL),
  date_of_birth     TEXT,
  address           TEXT,
  emergency_contact TEXT,
  emergency_phone   TEXT,
  health_notes      TEXT,
  photo_url         TEXT,
  joined_on         TEXT NOT NULL DEFAULT (date('now')),
  status            TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'inactive', 'frozen')),
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_members_status ON members(status);
CREATE INDEX IF NOT EXISTS idx_members_name ON members(last_name, first_name);

CREATE TABLE IF NOT EXISTS plans (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL UNIQUE,
  description   TEXT,
  price         REAL NOT NULL CHECK (price >= 0),
  duration_days INTEGER NOT NULL CHECK (duration_days > 0),
  sessions      INTEGER,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id      INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  plan_id        INTEGER NOT NULL REFERENCES plans(id),
  start_date     TEXT NOT NULL,
  end_date       TEXT NOT NULL,
  price          REAL NOT NULL CHECK (price >= 0),
  discount       REAL NOT NULL DEFAULT 0 CHECK (discount >= 0),
  sessions_total INTEGER,
  sessions_used  INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'expired', 'cancelled', 'frozen')),
  frozen_on      TEXT,
  note           TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_subs_member ON subscriptions(member_id);
CREATE INDEX IF NOT EXISTS idx_subs_end ON subscriptions(end_date);

CREATE TABLE IF NOT EXISTS payments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id       INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  subscription_id INTEGER REFERENCES subscriptions(id) ON DELETE SET NULL,
  amount          REAL NOT NULL CHECK (amount > 0),
  method          TEXT NOT NULL DEFAULT 'cash'
                  CHECK (method IN ('cash', 'card', 'upi', 'bank', 'online')),
  paid_on         TEXT NOT NULL DEFAULT (date('now')),
  reference       TEXT,
  note            TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_payments_member ON payments(member_id);
CREATE INDEX IF NOT EXISTS idx_payments_date ON payments(paid_on);

CREATE TABLE IF NOT EXISTS attendance (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id  INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  check_in   TEXT NOT NULL DEFAULT (datetime('now')),
  check_out  TEXT,
  source     TEXT NOT NULL DEFAULT 'desk'
);
CREATE INDEX IF NOT EXISTS idx_attendance_member ON attendance(member_id);
CREATE INDEX IF NOT EXISTS idx_attendance_in ON attendance(check_in);

CREATE TABLE IF NOT EXISTS classes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  description  TEXT,
  trainer_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  weekday      INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time   TEXT NOT NULL,
  duration_min INTEGER NOT NULL DEFAULT 60 CHECK (duration_min > 0),
  capacity     INTEGER NOT NULL DEFAULT 20 CHECK (capacity > 0),
  room         TEXT,
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bookings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id   INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  member_id  INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  class_date TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'booked'
             CHECK (status IN ('booked', 'attended', 'cancelled', 'no_show')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (class_id, member_id, class_date)
);
CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(class_date);

CREATE TABLE IF NOT EXISTS equipment (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,
  category       TEXT,
  serial_no      TEXT,
  quantity       INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  purchased_on   TEXT,
  cost           REAL,
  status         TEXT NOT NULL DEFAULT 'operational'
                 CHECK (status IN ('operational', 'maintenance', 'retired')),
  last_service_on TEXT,
  next_service_on TEXT,
  notes          TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time   TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS biometric_credentials (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id     INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,
  public_key    TEXT NOT NULL,
  sign_count    INTEGER NOT NULL DEFAULT 0,
  device_type   TEXT NOT NULL DEFAULT 'singleDevice',
  backed_up     INTEGER NOT NULL DEFAULT 0,
  device_name   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_biometric_member ON biometric_credentials(member_id);
CREATE INDEX IF NOT EXISTS idx_biometric_cred ON biometric_credentials(credential_id);
`;

/** Append-only: CREATE TABLE IF NOT EXISTS never retrofits columns onto an
 * already-created tenant file, so each future schema change becomes one more
 * guarded ALTER TABLE here — mirrors tenants.js's own migration list. */
function ensureColumn(db, table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

const MIGRATIONS = [
  (db) => ensureColumn(db, 'members', 'device_pin', 'INTEGER'),
  (db) => db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_members_device_pin ON members(device_pin)'),
  // Secret printed on the member's QR ID card. Deliberately not derived from
  // the member code (which is sequential and guessable) so a card cannot be
  // forged, and rotatable so a lost card can be revoked on its own.
  (db) => ensureColumn(db, 'members', 'qr_token', 'TEXT'),
  (db) => db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_members_qr_token ON members(qr_token)'),
  (db) => ensureColumn(db, 'members', 'qr_issued_at', 'TEXT'),
  // Which daily gym shift a member is expected to attend (e.g. a 5am-10am
  // morning batch vs a 4pm-9pm evening batch) — drives auto-checkout once
  // that shift's end time has passed. NULL means "no assigned shift", which
  // opts a member out of auto-checkout entirely (manual checkout only).
  (db) => ensureColumn(db, 'members', 'session_id', 'INTEGER REFERENCES sessions(id)'),
  // Seeded once so auto-checkout works out of the box; gyms can rename,
  // retime or delete these like any other session afterwards.
  (db) => {
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM sessions').get();
    if (n === 0) {
      db.prepare("INSERT INTO sessions (name, start_time, end_time) VALUES ('Morning', '05:00', '10:00')").run();
      db.prepare("INSERT INTO sessions (name, start_time, end_time) VALUES ('Evening', '16:00', '21:00')").run();
    }
  },
];

// Carries the current request's tenant DB file through the async call chain,
// so getDb() below can pick the right one without every caller threading a
// tenant argument through. Set by src/tenant.js's resolveTenant middleware.
export const tenantStorage = new AsyncLocalStorage();

/** Absolute path -> open handle. Keyed by file, not tenant slug, so the
 * dev/default DB and any tenant pointed at the same file share one handle. */
const handles = new Map();

function openHandle(file) {
  const resolved = path.resolve(file);
  let handle = handles.get(resolved);
  if (handle) return handle;

  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  handle = new DatabaseSync(resolved);
  handle.exec('PRAGMA journal_mode = WAL');
  handle.exec('PRAGMA foreign_keys = ON');
  handle.exec(SCHEMA);
  for (const migrate of MIGRATIONS) migrate(handle);
  handles.set(resolved, handle);
  return handle;
}

export function getDb() {
  const file = tenantStorage.getStore()?.dbFile ?? config.dbFile;
  return openHandle(file);
}

/** The current gym's IANA timezone, or undefined to mean "the server's own" —
 * which is the only sensible answer in single-tenant/dev mode, and stays the
 * behaviour for any gym that hasn't set one. */
export function getTenantTimezone() {
  return tenantStorage.getStore()?.timezone;
}

/** Closes one tenant's handle (by file path), or every open handle when called
 * with no argument — the shape server.js and tests already rely on. */
export function closeDb(file) {
  if (file) {
    const resolved = path.resolve(file);
    handles.get(resolved)?.close();
    handles.delete(resolved);
    return;
  }
  for (const handle of handles.values()) handle.close();
  handles.clear();
}

/** Rows come back with a null prototype; make them ordinary objects. */
function plain(row) {
  return row === undefined ? undefined : { ...row };
}

export function all(sql, params = []) {
  return getDb().prepare(sql).all(...params).map(plain);
}

export function get(sql, params = []) {
  return plain(getDb().prepare(sql).get(...params));
}

export function run(sql, params = []) {
  return getDb().prepare(sql).run(...params);
}

export function tx(fn) {
  const handle = getDb();
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
