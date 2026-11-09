import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { COACHING_MIGRATIONS } from './coaching/schema.js';
import { config } from './config.js';
import { backfillFoodFiberSugar, seedFitnessLibraries } from './fitnessSeed.js';
import { migrateMuscleGroups } from './muscles.js';

/**
 * Two kinds of time live in here and they are not interchangeable:
 *
 * - **Instants** (`created_at`, `updated_at`, `check_in`, `check_out`,
 *   `qr_issued_at`) are UTC, which is what `datetime('now')` produces. Correct
 *   as a column DEFAULT, and anything reading them for display or for an
 *   hour/day bucket must convert through src/clock.js first.
 * - **Calendar dates** (`joined_on`, `paid_on`, `start_date`, `end_date`,
 *   `frozen_on`, `class_date`, `seat_allocations.start_date`/`end_date`,
 *   `locker_allocations.start_date`/`end_date`, `released_on`,
 *   `expenses.spent_on`) are the *gym's* local date, because "the day Rahul
 *   paid" is a wall-clock fact about the gym. SQLite cannot know the
 *   tenant's timezone, so the `date('now')` DEFAULTs below are UTC and
 *   therefore only a last-resort fallback: every route inserts these
 *   explicitly from validate.js's today(). Adding a date column here means
 *   adding it to a route's insert too.
 */
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

CREATE TABLE IF NOT EXISTS password_resets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id);

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

CREATE TABLE IF NOT EXISTS whatsapp_settings (
  id                      INTEGER PRIMARY KEY CHECK (id = 1),
  auto_receipt            INTEGER NOT NULL DEFAULT 1,
  send_pdf_receipt        INTEGER NOT NULL DEFAULT 1,
  auto_reminder           INTEGER NOT NULL DEFAULT 1,
  reminder_days_before    INTEGER NOT NULL DEFAULT 3,
  auto_freeze             INTEGER NOT NULL DEFAULT 1,
  receipt_template        TEXT NOT NULL DEFAULT 'Hi {{first_name}}, thank you for your payment of {{amount}} for {{plan_name}}. Your membership is valid until {{end_date}}. - {{gym_name}}',
  reminder_template       TEXT NOT NULL DEFAULT 'Hi {{first_name}}, your membership ({{plan_name}}) expires on {{end_date}}. Please renew to continue your workouts! - {{gym_name}}',
  welcome_template        TEXT NOT NULL DEFAULT 'Welcome to {{gym_name}}, {{first_name}}! We are thrilled to have you on board.',
  freeze_template         TEXT NOT NULL DEFAULT 'Hi {{first_name}}, your membership ({{plan_name}}) has been frozen. It will resume once you or the gym reactivates it. - {{gym_name}}',
  auto_birthday           INTEGER NOT NULL DEFAULT 1,
  birthday_template       TEXT NOT NULL DEFAULT 'Happy birthday, {{first_name}}! 🎉 Wishing you a great year ahead from all of us at {{gym_name}}.',
  updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS whatsapp_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  phone       TEXT NOT NULL,
  member_id   INTEGER REFERENCES members(id) ON DELETE SET NULL,
  type        TEXT NOT NULL CHECK (type IN ('receipt', 'reminder', 'welcome', 'freeze', 'birthday', 'custom')),
  message     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'failed')),
  error       TEXT,
  sent_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_wa_logs_sent ON whatsapp_logs(sent_at);
CREATE INDEX IF NOT EXISTS idx_wa_logs_member ON whatsapp_logs(member_id);
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
  // Member photos move out of members.photo_url (where they sat as base64 data
  // URLs, riding along in every roster response) into their own table, served
  // over a cacheable URL instead. See src/photo.js.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS member_photos (
        member_id  INTEGER PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
        mime       TEXT NOT NULL,
        bytes      BLOB NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  },
  // Added to SCHEMA above, so only databases created before it need this.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS password_resets (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id)');
  },
  // Bumped on every photo change, so a photo URL can be cached indefinitely:
  // a new photo is a new URL rather than a stale one to invalidate.
  (db) => ensureColumn(db, 'members', 'photo_version', 'INTEGER NOT NULL DEFAULT 0'),
  // Carry across whatever is already in photo_url. Guarded on the column still
  // existing so this is a no-op on a database created after the drop below.
  (db) => {
    const cols = db.prepare('PRAGMA table_info(members)').all().map((c) => c.name);
    if (!cols.includes('photo_url')) return;

    const rows = db
      .prepare("SELECT id, photo_url FROM members WHERE photo_url IS NOT NULL AND photo_url != ''")
      .all();
    const insert = db.prepare(
      'INSERT OR REPLACE INTO member_photos (member_id, mime, bytes) VALUES (?, ?, ?)',
    );
    const bump = db.prepare('UPDATE members SET photo_version = 1 WHERE id = ?');

    for (const row of rows) {
      // Anything that isn't a base64 data URL (an http link a hand-written API
      // call could have set) has no bytes to move and is simply dropped.
      const match = /^data:([a-z]+\/[a-z0-9+.-]+);base64,(.+)$/is.exec(row.photo_url);
      if (!match) continue;
      insert.run(row.id, match[1].toLowerCase(), Buffer.from(match[2], 'base64'));
      bump.run(row.id);
    }

    // SQLite has had DROP COLUMN since 3.35, but a build without it must not
    // leave the database unopenable — the column is unread from here on either
    // way, and blanking it reclaims the space.
    db.exec("UPDATE members SET photo_url = NULL WHERE photo_url IS NOT NULL");
    try {
      db.exec('ALTER TABLE members DROP COLUMN photo_url');
    } catch {
      // Left in place, always NULL, and never selected again.
    }
  },
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS whatsapp_settings (
        id                      INTEGER PRIMARY KEY CHECK (id = 1),
        auto_receipt            INTEGER NOT NULL DEFAULT 1,
        send_pdf_receipt        INTEGER NOT NULL DEFAULT 1,
        auto_reminder           INTEGER NOT NULL DEFAULT 1,
        reminder_days_before    INTEGER NOT NULL DEFAULT 3,
        receipt_template        TEXT NOT NULL DEFAULT 'Hi {{first_name}}, thank you for your payment of {{amount}} for {{plan_name}}. Your membership is valid until {{end_date}}. - {{gym_name}}',
        reminder_template       TEXT NOT NULL DEFAULT 'Hi {{first_name}}, your membership ({{plan_name}}) expires on {{end_date}}. Please renew to continue your workouts! - {{gym_name}}',
        welcome_template        TEXT NOT NULL DEFAULT 'Welcome to {{gym_name}}, {{first_name}}! We are thrilled to have you on board.',
        updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    ensureColumn(db, 'whatsapp_settings', 'send_pdf_receipt', 'INTEGER NOT NULL DEFAULT 1');
    db.prepare('INSERT OR IGNORE INTO whatsapp_settings (id) VALUES (1)').run();
  },
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS whatsapp_logs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        phone       TEXT NOT NULL,
        member_id   INTEGER REFERENCES members(id) ON DELETE SET NULL,
        type        TEXT NOT NULL CHECK (type IN ('receipt', 'reminder', 'welcome', 'custom')),
        message     TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'failed')),
        error       TEXT,
        sent_at     TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_wa_logs_sent ON whatsapp_logs(sent_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_wa_logs_member ON whatsapp_logs(member_id)');
  },
  (db) => ensureColumn(db, 'whatsapp_settings', 'auto_freeze', 'INTEGER NOT NULL DEFAULT 1'),
  (db) =>
    ensureColumn(
      db,
      'whatsapp_settings',
      'freeze_template',
      "TEXT NOT NULL DEFAULT 'Hi {{first_name}}, your membership ({{plan_name}}) has been frozen. It will resume once you or the gym reactivates it. - {{gym_name}}'",
    ),
  // SQLite has no ALTER TABLE ... ADD CONSTRAINT, so widening the `type` CHECK
  // to allow 'freeze' means rebuilding the table — guarded so it only runs
  // once, against databases created before 'freeze' existed.
  (db) => {
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'whatsapp_logs'")
      .get();
    if (!row || row.sql.includes("'freeze'")) return;

    db.exec(`
      CREATE TABLE whatsapp_logs_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        phone       TEXT NOT NULL,
        member_id   INTEGER REFERENCES members(id) ON DELETE SET NULL,
        type        TEXT NOT NULL CHECK (type IN ('receipt', 'reminder', 'welcome', 'freeze', 'custom')),
        message     TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'failed')),
        error       TEXT,
        sent_at     TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec('INSERT INTO whatsapp_logs_new SELECT * FROM whatsapp_logs');
    db.exec('DROP TABLE whatsapp_logs');
    db.exec('ALTER TABLE whatsapp_logs_new RENAME TO whatsapp_logs');
    db.exec('CREATE INDEX IF NOT EXISTS idx_wa_logs_sent ON whatsapp_logs(sent_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_wa_logs_member ON whatsapp_logs(member_id)');
  },
  (db) =>
    ensureColumn(
      db,
      'whatsapp_settings',
      'birthday_template',
      "TEXT NOT NULL DEFAULT 'Happy birthday, {{first_name}}! 🎉 Wishing you a great year ahead from all of us at {{gym_name}}.'",
    ),
  (db) => ensureColumn(db, 'whatsapp_settings', 'auto_birthday', 'INTEGER NOT NULL DEFAULT 1'),
  // Widening the `type` CHECK again, this time to allow 'birthday' — same
  // rebuild-the-table dance as the 'freeze' migration above.
  (db) => {
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'whatsapp_logs'")
      .get();
    if (!row || row.sql.includes("'birthday'")) return;

    db.exec(`
      CREATE TABLE whatsapp_logs_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        phone       TEXT NOT NULL,
        member_id   INTEGER REFERENCES members(id) ON DELETE SET NULL,
        type        TEXT NOT NULL CHECK (type IN ('receipt', 'reminder', 'welcome', 'freeze', 'birthday', 'custom')),
        message     TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'failed')),
        error       TEXT,
        sent_at     TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec('INSERT INTO whatsapp_logs_new SELECT * FROM whatsapp_logs');
    db.exec('DROP TABLE whatsapp_logs');
    db.exec('ALTER TABLE whatsapp_logs_new RENAME TO whatsapp_logs');
    db.exec('CREATE INDEX IF NOT EXISTS idx_wa_logs_sent ON whatsapp_logs(sent_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_wa_logs_member ON whatsapp_logs(member_id)');
  },

  /* ---------------------------------------------------------- SeatBook --- */
  // Every tenant's database carries these tables regardless of vertical (see
  // verticals.js's header comment) — a gym simply never writes to them.

  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS seat_zones (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL UNIQUE,
        sort_order INTEGER NOT NULL DEFAULT 0,
        active     INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  },
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS seats (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        code       TEXT NOT NULL UNIQUE,
        zone_id    INTEGER REFERENCES seat_zones(id) ON DELETE SET NULL,
        row_label  TEXT,
        col_index  INTEGER,
        seat_type  TEXT NOT NULL DEFAULT 'standard'
                   CHECK (seat_type IN ('standard', 'cabin', 'ac', 'premium', 'window')),
        has_power  INTEGER NOT NULL DEFAULT 0,
        status     TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'maintenance', 'retired')),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_seats_zone ON seats(zone_id)');
  },
  // The core invariant: one live allocation per (seat, shift). Renewal
  // extends this row rather than inserting a second one, so the seat map
  // stays a single-row-per-cell read — see allocateOrExtend in seats.js.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS seat_allocations (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        seat_id         INTEGER NOT NULL REFERENCES seats(id) ON DELETE CASCADE,
        session_id      INTEGER NOT NULL REFERENCES sessions(id),
        member_id       INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        subscription_id INTEGER REFERENCES subscriptions(id) ON DELETE SET NULL,
        start_date      TEXT NOT NULL,
        end_date        TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released')),
        released_on     TEXT,
        released_reason TEXT,
        note            TEXT,
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    // Double-booking is structurally impossible, not merely checked: a
    // transactional read-then-write race can still land two allocate calls in
    // the same tick, and only a constraint the database itself enforces
    // survives that.
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_seat_alloc_live ON seat_allocations(seat_id, session_id) WHERE status = 'active'",
    );
    // One student cannot hold two desks in the same shift.
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_seat_alloc_member_shift ON seat_allocations(member_id, session_id) WHERE status = 'active'",
    );
    db.exec('CREATE INDEX IF NOT EXISTS idx_seat_alloc_sub ON seat_allocations(subscription_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_seat_alloc_end ON seat_allocations(end_date)');
  },
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS seat_waitlist (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id  INTEGER REFERENCES members(id) ON DELETE CASCADE,
        name       TEXT,
        phone      TEXT,
        session_id INTEGER REFERENCES sessions(id),
        seat_type  TEXT,
        status     TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'offered', 'converted', 'dropped')),
        note       TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_waitlist_status ON seat_waitlist(status)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_waitlist_session ON seat_waitlist(session_id)');
  },
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS lockers (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        code        TEXT NOT NULL UNIQUE,
        zone_id     INTEGER REFERENCES seat_zones(id) ON DELETE SET NULL,
        monthly_fee REAL NOT NULL DEFAULT 0 CHECK (monthly_fee >= 0),
        status      TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'maintenance', 'retired')),
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  },
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS locker_allocations (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        locker_id       INTEGER NOT NULL REFERENCES lockers(id) ON DELETE CASCADE,
        member_id       INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        subscription_id INTEGER REFERENCES subscriptions(id) ON DELETE SET NULL,
        start_date      TEXT NOT NULL,
        end_date        TEXT NOT NULL,
        fee             REAL NOT NULL DEFAULT 0 CHECK (fee >= 0),
        deposit         REAL NOT NULL DEFAULT 0 CHECK (deposit >= 0),
        key_issued      INTEGER NOT NULL DEFAULT 0,
        status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released')),
        released_on     TEXT,
        released_reason TEXT,
        note            TEXT,
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_locker_alloc_live ON locker_allocations(locker_id) WHERE status = 'active'",
    );
    db.exec('CREATE INDEX IF NOT EXISTS idx_locker_alloc_sub ON locker_allocations(subscription_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_locker_alloc_end ON locker_allocations(end_date)');
  },
  (db) => {
    // category is free text with a suggested list on the client, not a CHECK —
    // widening a CHECK means rebuilding the table (see the whatsapp_logs
    // rebuild above), and an expense category list is exactly the kind of
    // thing a hall owner wants to extend without a migration.
    db.exec(`
      CREATE TABLE IF NOT EXISTS expenses (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        category   TEXT NOT NULL,
        amount     REAL NOT NULL CHECK (amount > 0),
        spent_on   TEXT NOT NULL,
        method     TEXT NOT NULL DEFAULT 'cash' CHECK (method IN ('cash', 'card', 'upi', 'bank', 'online')),
        vendor     TEXT,
        note       TEXT,
        recurring  INTEGER NOT NULL DEFAULT 0,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(spent_on)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(category)');
  },
  (db) => {
    // Own primary key, not member_id PK like member_photos: Aadhaar front,
    // Aadhaar back and a college ID is three rows for one student.
    db.exec(`
      CREATE TABLE IF NOT EXISTS member_documents (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id   INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        kind        TEXT NOT NULL,
        label       TEXT,
        number      TEXT,
        mime        TEXT NOT NULL,
        bytes       BLOB NOT NULL,
        verified    INTEGER NOT NULL DEFAULT 0,
        uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_member_documents_member ON member_documents(member_id)');
  },
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS library_settings (
        id                   INTEGER PRIMARY KEY CHECK (id = 1),
        seat_hold_days       INTEGER NOT NULL DEFAULT 3,
        enforce_shift_window INTEGER NOT NULL DEFAULT 0,
        allow_seat_change    INTEGER NOT NULL DEFAULT 1,
        require_id_proof     INTEGER NOT NULL DEFAULT 0,
        updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.prepare('INSERT OR IGNORE INTO library_settings (id) VALUES (1)').run();
  },

  // sessions -> real shifts. price is a surcharge on top of the plan price,
  // not a replacement for it; capacity is nullable (unlimited).
  (db) => {
    ensureColumn(db, 'sessions', 'price', 'REAL NOT NULL DEFAULT 0');
    ensureColumn(db, 'sessions', 'capacity', 'INTEGER');
    ensureColumn(db, 'sessions', 'code', 'TEXT');
    ensureColumn(db, 'sessions', 'sort_order', 'INTEGER NOT NULL DEFAULT 0');
    // A shift that runs past midnight (e.g. 22:00-06:00) needs to know it: see
    // the auto-checkout fix in maintenance.js that this column exists for.
    ensureColumn(db, 'sessions', 'overnight', 'INTEGER NOT NULL DEFAULT 0');
  },
  // An optional lock + prefill on the plan; subscriptions.session_id (below)
  // is the actual source of truth — see the shift-binding note in
  // subscriptions.js.
  (db) => ensureColumn(db, 'plans', 'session_id', 'INTEGER REFERENCES sessions(id)'),
  (db) => {
    ensureColumn(db, 'subscriptions', 'session_id', 'INTEGER REFERENCES sessions(id)');
    // A billed figure (locker fee), not a stored due — dues stay computed,
    // never stored, same as every other balance in this database.
    ensureColumn(db, 'subscriptions', 'addon_total', 'REAL NOT NULL DEFAULT 0');
  },
  (db) => {
    ensureColumn(db, 'attendance', 'seat_id', 'INTEGER REFERENCES seats(id)');
    ensureColumn(db, 'attendance', 'session_id', 'INTEGER REFERENCES sessions(id)');
  },
  // UPSC/NEET/JEE — the category's top filter on a student roster.
  (db) => ensureColumn(db, 'members', 'exam_target', 'TEXT'),
  // Off by default: a gym batch's end time used to auto-checkout anyone still
  // inside the instant it passed (see autoCloseFinishedVisits() in
  // maintenance.js), which surprised staff when a member was simply running
  // late leaving. Existing tenants keep today's behaviour off; front desk now
  // checks people out by hand from "in the gym now".
  (db) => ensureColumn(db, 'library_settings', 'auto_close_shift_visits', 'INTEGER NOT NULL DEFAULT 0'),

  /* ------------------------------------------------------- Member portal --- */
  // The member-app PIN, since replaced by a password: the migration that adds
  // portal_password_hash (at the end of this list) moves any PIN across and
  // clears this column. Kept so older databases still migrate in order.
  (db) => ensureColumn(db, 'members', 'portal_pin_hash', 'TEXT'),
  (db) => ensureColumn(db, 'members', 'last_portal_login', 'TEXT'),

  /* ------------------------------------------- Diet & workout tracking --- */
  // The paid Fitness feature: trainer-authored workout and diet plans, the
  // member's own set-by-set and meal-by-meal logs against them, and the monthly
  // add-on that unlocks the whole thing in the member portal. Carried by every
  // tenant's database regardless of vertical, same as the SeatBook tables
  // above — a study hall simply never writes to them.
  //
  // Weights are stored in kilograms throughout, always. Pounds are a display
  // unit the client converts at the edge: a member who switches units mid-log
  // must not silently rewrite their own history, and a PR has to be comparable
  // across a unit change.

  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS workout_plans (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        name          TEXT NOT NULL,
        description   TEXT,
        goal          TEXT NOT NULL DEFAULT 'general_fitness'
                      CHECK (goal IN ('muscle_gain', 'fat_loss', 'strength', 'endurance', 'general_fitness')),
        level         TEXT NOT NULL DEFAULT 'intermediate'
                      CHECK (level IN ('beginner', 'intermediate', 'advanced')),
        days_per_week INTEGER NOT NULL DEFAULT 4 CHECK (days_per_week BETWEEN 1 AND 7),
        is_template   INTEGER NOT NULL DEFAULT 1,
        member_id     INTEGER REFERENCES members(id) ON DELETE CASCADE,
        created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    // Customised copies are read by member, templates by "is it a template" —
    // one partial index serves the first without bloating on the second.
    db.exec('CREATE INDEX IF NOT EXISTS idx_workout_plans_member ON workout_plans(member_id) WHERE member_id IS NOT NULL');
  },
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS workout_plan_days (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        plan_id    INTEGER NOT NULL REFERENCES workout_plans(id) ON DELETE CASCADE,
        day_number INTEGER NOT NULL CHECK (day_number BETWEEN 1 AND 7),
        day_name   TEXT NOT NULL,
        notes      TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_workout_days_plan ON workout_plan_days(plan_id)');
  },
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS workout_plan_exercises (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        day_id        INTEGER NOT NULL REFERENCES workout_plan_days(id) ON DELETE CASCADE,
        exercise_name TEXT NOT NULL,
        muscle_group  TEXT NOT NULL,
        target_sets   INTEGER NOT NULL DEFAULT 3 CHECK (target_sets > 0),
        target_reps   TEXT NOT NULL DEFAULT '8-12',
        target_rpe    REAL,
        rest_seconds  INTEGER NOT NULL DEFAULT 90 CHECK (rest_seconds >= 0),
        notes         TEXT,
        sort_order    INTEGER NOT NULL DEFAULT 0
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_workout_exercises_day ON workout_plan_exercises(day_id)');
  },
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS member_workout_assignments (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id   INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        plan_id     INTEGER NOT NULL REFERENCES workout_plans(id) ON DELETE CASCADE,
        assigned_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        start_date  TEXT NOT NULL DEFAULT (date('now')),
        end_date    TEXT,
        status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'archived')),
        notes       TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    // One live routine per member, enforced by the database rather than merely
    // checked: the portal reads "the" current plan, and two would make that
    // read arbitrary. Re-assigning archives the incumbent first — see
    // assignPlan in routes/workouts.js.
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_member_workout_live ON member_workout_assignments(member_id) WHERE status = 'active'",
    );
  },
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS exercise_library (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        name         TEXT NOT NULL UNIQUE,
        muscle_group TEXT NOT NULL,
        equipment    TEXT NOT NULL DEFAULT 'barbell',
        instructions TEXT,
        is_custom    INTEGER NOT NULL DEFAULT 0
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_exercise_library_group ON exercise_library(muscle_group)');
  },
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS workout_logs (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id        INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        plan_id          INTEGER REFERENCES workout_plans(id) ON DELETE SET NULL,
        day_id           INTEGER REFERENCES workout_plan_days(id) ON DELETE SET NULL,
        workout_name     TEXT NOT NULL,
        log_date         TEXT NOT NULL DEFAULT (date('now')),
        started_at       TEXT NOT NULL DEFAULT (datetime('now')),
        ended_at         TEXT,
        duration_seconds INTEGER NOT NULL DEFAULT 0 CHECK (duration_seconds >= 0),
        total_volume_kg  REAL NOT NULL DEFAULT 0,
        total_sets       INTEGER NOT NULL DEFAULT 0,
        total_reps       INTEGER NOT NULL DEFAULT 0,
        notes            TEXT,
        created_at       TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    // log_date is the gym's local calendar date the session belongs to, unlike
    // started_at, which is a UTC instant — see the header of this file. The
    // portal's history calendar and streaks read the date; the timer reads the
    // instant.
    db.exec('CREATE INDEX IF NOT EXISTS idx_workout_logs_member ON workout_logs(member_id, log_date)');
  },
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS workout_log_sets (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        log_id        INTEGER NOT NULL REFERENCES workout_logs(id) ON DELETE CASCADE,
        exercise_name TEXT NOT NULL,
        muscle_group  TEXT NOT NULL DEFAULT 'full_body',
        set_number    INTEGER NOT NULL,
        set_type      TEXT NOT NULL DEFAULT 'normal'
                      CHECK (set_type IN ('normal', 'warmup', 'drop', 'failure')),
        weight_kg     REAL NOT NULL DEFAULT 0 CHECK (weight_kg >= 0),
        reps          INTEGER NOT NULL DEFAULT 0 CHECK (reps >= 0),
        rpe           REAL,
        est_1rm_kg    REAL NOT NULL DEFAULT 0,
        is_pr         INTEGER NOT NULL DEFAULT 0,
        completed     INTEGER NOT NULL DEFAULT 1,
        notes         TEXT,
        sort_order    INTEGER NOT NULL DEFAULT 0
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_workout_sets_log ON workout_log_sets(log_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_workout_sets_exercise ON workout_log_sets(exercise_name)');
  },
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS exercise_prs (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id     INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        exercise_name TEXT NOT NULL,
        max_weight_kg REAL NOT NULL DEFAULT 0,
        max_reps      INTEGER NOT NULL DEFAULT 0,
        est_1rm_kg    REAL NOT NULL DEFAULT 0,
        achieved_at   TEXT NOT NULL DEFAULT (datetime('now')),
        log_set_id    INTEGER REFERENCES workout_log_sets(id) ON DELETE SET NULL,
        UNIQUE (member_id, exercise_name)
      )
    `);
  },

  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS diet_plans (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        name             TEXT NOT NULL,
        description      TEXT,
        goal             TEXT NOT NULL DEFAULT 'maintenance'
                         CHECK (goal IN ('fat_loss', 'muscle_gain', 'maintenance', 'keto', 'high_protein')),
        target_calories  INTEGER NOT NULL CHECK (target_calories > 0),
        target_protein_g INTEGER NOT NULL DEFAULT 0,
        target_carbs_g   INTEGER NOT NULL DEFAULT 0,
        target_fats_g    INTEGER NOT NULL DEFAULT 0,
        target_water_ml  INTEGER NOT NULL DEFAULT 3000,
        is_template      INTEGER NOT NULL DEFAULT 1,
        member_id        INTEGER REFERENCES members(id) ON DELETE CASCADE,
        created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_diet_plans_member ON diet_plans(member_id) WHERE member_id IS NOT NULL');
  },
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS diet_plan_meals (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        plan_id         INTEGER NOT NULL REFERENCES diet_plans(id) ON DELETE CASCADE,
        meal_name       TEXT NOT NULL,
        meal_time       TEXT,
        target_calories INTEGER NOT NULL DEFAULT 0,
        notes           TEXT,
        sort_order      INTEGER NOT NULL DEFAULT 0
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_diet_meals_plan ON diet_plan_meals(plan_id)');
  },
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS diet_plan_items (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        meal_id      INTEGER NOT NULL REFERENCES diet_plan_meals(id) ON DELETE CASCADE,
        food_name    TEXT NOT NULL,
        portion_size TEXT NOT NULL DEFAULT '100g',
        calories     INTEGER NOT NULL DEFAULT 0,
        protein_g    REAL NOT NULL DEFAULT 0,
        carbs_g      REAL NOT NULL DEFAULT 0,
        fats_g       REAL NOT NULL DEFAULT 0,
        notes        TEXT,
        sort_order   INTEGER NOT NULL DEFAULT 0
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_diet_items_meal ON diet_plan_items(meal_id)');
  },
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS member_diet_assignments (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id   INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        plan_id     INTEGER NOT NULL REFERENCES diet_plans(id) ON DELETE CASCADE,
        assigned_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        start_date  TEXT NOT NULL DEFAULT (date('now')),
        end_date    TEXT,
        status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'archived')),
        notes       TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    // One live diet per member, for the same reason as the workout index above.
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_member_diet_live ON member_diet_assignments(member_id) WHERE status = 'active'",
    );
  },
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS food_library (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        name         TEXT NOT NULL UNIQUE,
        category     TEXT NOT NULL DEFAULT 'general',
        serving_unit TEXT NOT NULL DEFAULT '100g',
        calories     INTEGER NOT NULL DEFAULT 0,
        protein_g    REAL NOT NULL DEFAULT 0,
        carbs_g      REAL NOT NULL DEFAULT 0,
        fats_g       REAL NOT NULL DEFAULT 0,
        is_custom    INTEGER NOT NULL DEFAULT 0
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_food_library_category ON food_library(category)');
  },
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS diet_logs (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id  INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        log_date   TEXT NOT NULL,
        water_ml   INTEGER NOT NULL DEFAULT 0 CHECK (water_ml >= 0),
        notes      TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (member_id, log_date)
      )
    `);
  },
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS diet_log_entries (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        diet_log_id  INTEGER NOT NULL REFERENCES diet_logs(id) ON DELETE CASCADE,
        meal_type    TEXT NOT NULL
                     CHECK (meal_type IN ('breakfast', 'lunch', 'dinner', 'snack', 'pre_workout', 'post_workout')),
        food_name    TEXT NOT NULL,
        quantity     REAL NOT NULL DEFAULT 1 CHECK (quantity > 0),
        serving_unit TEXT NOT NULL DEFAULT '100g',
        calories     INTEGER NOT NULL DEFAULT 0,
        protein_g    REAL NOT NULL DEFAULT 0,
        carbs_g      REAL NOT NULL DEFAULT 0,
        fats_g       REAL NOT NULL DEFAULT 0,
        logged_at    TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_diet_entries_log ON diet_log_entries(diet_log_id)');
  },

  (db) => {
    // `enabled` is "charge for this", not "does the feature exist": with it off
    // every member gets the tracker for free, which is the switch a gym that
    // bundles coaching into its membership actually wants. Turning it on is
    // what raises the paywall — see fitnessAccessFor() in routes/portal.js.
    db.exec(`
      CREATE TABLE IF NOT EXISTS fitness_addon_settings (
        id            INTEGER PRIMARY KEY CHECK (id = 1),
        enabled       INTEGER NOT NULL DEFAULT 1,
        monthly_price REAL NOT NULL DEFAULT 499 CHECK (monthly_price >= 0),
        trial_days    INTEGER NOT NULL DEFAULT 0 CHECK (trial_days >= 0),
        description   TEXT NOT NULL DEFAULT 'Unlock personalised Diet & Workout tracking with trainer guidance.',
        updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.prepare('INSERT OR IGNORE INTO fitness_addon_settings (id) VALUES (1)').run();
  },
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS member_fitness_addons (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id   INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        start_date  TEXT NOT NULL,
        end_date    TEXT NOT NULL,
        price       REAL NOT NULL DEFAULT 0 CHECK (price >= 0),
        status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'cancelled')),
        payment_id  INTEGER REFERENCES payments(id) ON DELETE SET NULL,
        assigned_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        notes       TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    // One live add-on per member: a renewal extends the row it finds rather
    // than stacking a second one, so "is this member entitled" stays a
    // single-row read (the same shape as seat_allocations).
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_fitness_addon_live ON member_fitness_addons(member_id) WHERE status = 'active'",
    );
    db.exec('CREATE INDEX IF NOT EXISTS idx_fitness_addon_end ON member_fitness_addons(end_date)');
  },
  // Lets a gym bundle the tracker into a premium membership ("VIP / Personal
  // Training") instead of billing it as a separate line — a member on such a
  // plan is entitled for as long as that membership is active, with no add-on
  // row of their own.
  (db) => ensureColumn(db, 'plans', 'includes_fitness_addon', 'INTEGER NOT NULL DEFAULT 0'),
  // Eight coarse muscle groups (back, legs, arms, core…) become Hevy's twenty
  // (lats, quadriceps, biceps, abdominals…). The tables above no longer carry
  // a CHECK on muscle_group — a list that grows should not mean rebuilding
  // tables again — so this rebuilds older databases without it and re-files
  // their rows (see src/muscles.js). It sits here, out of append order, because
  // the seed below re-runs on any open that finds a library empty, and writes
  // the new groups: the old CHECK has to be gone by then.
  (db) => migrateMuscleGroups(db),
  (db) => seedFitnessLibraries(db),

  // Web Push (src/notifications.js). A subscription is one browser on one
  // device; `endpoint` is unique because the same phone signing in as a second
  // member (a shared family tablet) must move to that member, not notify both.
  // `path_prefix` is how that device addressed this gym (/g/acme or ''), which
  // a background sweep has no request to read it from — it is what makes a
  // tapped notification open the right gym.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id       INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        endpoint        TEXT NOT NULL UNIQUE,
        p256dh          TEXT NOT NULL,
        auth            TEXT NOT NULL,
        platform        TEXT NOT NULL DEFAULT 'other' CHECK (platform IN ('ios', 'android', 'desktop', 'other')),
        user_agent      TEXT,
        path_prefix     TEXT NOT NULL DEFAULT '',
        failure_count   INTEGER NOT NULL DEFAULT 0,
        last_success_at TEXT,
        last_error      TEXT,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_push_subs_member ON push_subscriptions(member_id)');
  },
  // Defaults are "on": a member only gets here by tapping Enable, and asking
  // them to then switch each category on as well would be a second opt-in.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS notification_preferences (
        member_id     INTEGER PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
        water         INTEGER NOT NULL DEFAULT 1,
        nutrition     INTEGER NOT NULL DEFAULT 1,
        workout       INTEGER NOT NULL DEFAULT 1,
        announcements INTEGER NOT NULL DEFAULT 1,
        membership    INTEGER NOT NULL DEFAULT 1,
        sound         INTEGER NOT NULL DEFAULT 1,
        vibrate       INTEGER NOT NULL DEFAULT 1,
        updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  },
  // The member's notification center. `dedupe_key` is what makes the sweeps
  // safe to re-run every few minutes: "water:2026-10-10:11:00" can only be
  // inserted once per member, the same idea as whatsapp_logs' sent-today join.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS member_notifications (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id       INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        category        TEXT NOT NULL
                        CHECK (category IN ('water', 'nutrition', 'workout', 'announcement', 'membership', 'test')),
        title           TEXT NOT NULL,
        body            TEXT NOT NULL,
        screen          TEXT,
        announcement_id INTEGER REFERENCES push_announcements(id) ON DELETE CASCADE,
        dedupe_key      TEXT,
        pushed          INTEGER NOT NULL DEFAULT 0,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        read_at         TEXT
      )
    `);
    db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_member_notif_dedupe ON member_notifications(member_id, dedupe_key) WHERE dedupe_key IS NOT NULL',
    );
    db.exec('CREATE INDEX IF NOT EXISTS idx_member_notif_inbox ON member_notifications(member_id, created_at)');
  },
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS push_announcements (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        title        TEXT NOT NULL,
        body         TEXT NOT NULL,
        kind         TEXT NOT NULL DEFAULT 'general'
                     CHECK (kind IN ('general', 'closure', 'maintenance', 'holiday', 'event')),
        urgent       INTEGER NOT NULL DEFAULT 0,
        created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
        recipients   INTEGER NOT NULL DEFAULT 0,
        devices      INTEGER NOT NULL DEFAULT 0,
        delivered    INTEGER NOT NULL DEFAULT 0,
        failed       INTEGER NOT NULL DEFAULT 0,
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  },
  // A workout in progress lives in the member's browser (see activeSession in
  // portal.js); this is the server's only view of it, reported by the portal
  // when a session starts and cleared when it is saved or discarded. It is
  // what lets the keep-alive nudge reach a phone that is locked in a pocket.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS active_workouts (
        member_id    INTEGER PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
        workout_name TEXT NOT NULL,
        started_at   TEXT NOT NULL,
        nudged_at    TEXT,
        updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  },
  // Gym-wide schedule for the automated nudges. Times are the gym's own wall
  // clock ("11:00"), comma-separated where there can be several.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS push_settings (
        id                     INTEGER PRIMARY KEY CHECK (id = 1),
        water_enabled          INTEGER NOT NULL DEFAULT 1,
        water_times            TEXT NOT NULL DEFAULT '11:00,15:00,19:00',
        nutrition_enabled      INTEGER NOT NULL DEFAULT 1,
        lunch_time             TEXT NOT NULL DEFAULT '14:00',
        dinner_time            TEXT NOT NULL DEFAULT '21:00',
        workout_enabled        INTEGER NOT NULL DEFAULT 1,
        workout_nudge_minutes  INTEGER NOT NULL DEFAULT 120 CHECK (workout_nudge_minutes BETWEEN 30 AND 600),
        membership_enabled     INTEGER NOT NULL DEFAULT 1,
        membership_days_before INTEGER NOT NULL DEFAULT 3 CHECK (membership_days_before BETWEEN 0 AND 60),
        updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.prepare('INSERT OR IGNORE INTO push_settings (id) VALUES (1)').run();
  },
  // An optional picture on an announcement — Android shows it expanded under
  // the text. Served from a URL carrying `image_token` rather than behind
  // auth, because the phone's notification system fetches it with no session.
  (db) => ensureColumn(db, 'push_announcements', 'image_mime', 'TEXT'),
  (db) => ensureColumn(db, 'push_announcements', 'image_bytes', 'BLOB'),
  (db) => ensureColumn(db, 'push_announcements', 'image_token', 'TEXT'),

  /* ------------------------------------------------ Member-built routines --- */
  // A plan the member wrote for themselves in the portal (Hevy's "Create
  // routine"). A trainer's customised clone also carries member_id, so
  // ownership alone cannot tell the two apart — and only the member's own are
  // theirs to edit or delete.
  (db) => ensureColumn(db, 'workout_plans', 'member_created', 'INTEGER NOT NULL DEFAULT 0'),
  // Which of their own plans the member has switched to; NULL follows the
  // trainer. A pointer rather than an assignment row on purpose: the trainer's
  // assignment stays live underneath, so a member can never archive their
  // trainer's programming, and switching back is one tap.
  (db) => ensureColumn(db, 'members', 'own_workout_plan_id', 'INTEGER REFERENCES workout_plans(id) ON DELETE SET NULL'),

  /* ------------------------------------------- Own nutrition targets --- */
  // A member's own calorie budget and the body stats the calculator suggests
  // it from (see src/nutrition.js). Targets stay NULL until the member sets
  // them; `use_own_targets` is their switch away from a trainer's plan, which
  // stays assigned underneath — the same pointer-not-assignment idea as
  // own_workout_plan_id above.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS member_nutrition_profiles (
        member_id            INTEGER PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
        use_own_targets      INTEGER NOT NULL DEFAULT 0,
        target_calories      INTEGER,
        target_protein_g     INTEGER,
        target_carbs_g       INTEGER,
        target_fats_g        INTEGER,
        target_fiber_g       INTEGER,
        target_sugar_g       INTEGER,
        target_water_ml      INTEGER,
        exercise_addback_pct INTEGER NOT NULL DEFAULT 0 CHECK (exercise_addback_pct IN (0, 50, 100)),
        height_cm            REAL,
        sex                  TEXT CHECK (sex IN ('male', 'female', 'other') OR sex IS NULL),
        birth_date           TEXT,
        activity_level       TEXT NOT NULL DEFAULT 'light'
                             CHECK (activity_level IN ('sedentary', 'light', 'moderate', 'very_active')),
        training_days        INTEGER NOT NULL DEFAULT 4 CHECK (training_days BETWEEN 0 AND 7),
        training_intensity   TEXT NOT NULL DEFAULT 'moderate'
                             CHECK (training_intensity IN ('light', 'moderate', 'hard')),
        goal                 TEXT NOT NULL DEFAULT 'maintain' CHECK (goal IN ('lose', 'maintain', 'gain')),
        goal_rate_kg         REAL NOT NULL DEFAULT 0.5 CHECK (goal_rate_kg BETWEEN 0 AND 1),
        goal_weight_kg       REAL,
        updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
  },
  // One weigh-in per gym-local day: weighing twice replaces the morning's
  // number rather than putting two dots on the trend for one day.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS body_weight_logs (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id  INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        log_date   TEXT NOT NULL,
        weight_kg  REAL NOT NULL CHECK (weight_kg > 0),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (member_id, log_date)
      )
    `);
  },
  // Exercise outside the workout logger — a run, a match, a yoga class.
  // `calories` is stored, not recomputed: the member may have typed their
  // watch's number over the estimate, and that is the one they trust.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS activity_logs (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id        INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        log_date         TEXT NOT NULL,
        activity         TEXT NOT NULL,
        name             TEXT NOT NULL,
        duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0),
        calories         INTEGER NOT NULL DEFAULT 0 CHECK (calories >= 0),
        created_at       TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_activity_logs_member ON activity_logs(member_id, log_date)');
  },
  // Costed when the session is saved, at that day's body weight, so a later
  // weigh-in cannot rewrite what an old workout earned. NULL on sessions from
  // before this existed — those are estimated on read.
  (db) => ensureColumn(db, 'workout_logs', 'calories_burned', 'INTEGER'),
  (db) => ensureColumn(db, 'food_library', 'fiber_g', 'REAL NOT NULL DEFAULT 0'),
  (db) => ensureColumn(db, 'food_library', 'sugar_g', 'REAL NOT NULL DEFAULT 0'),
  (db) => ensureColumn(db, 'diet_log_entries', 'fiber_g', 'REAL NOT NULL DEFAULT 0'),
  (db) => ensureColumn(db, 'diet_log_entries', 'sugar_g', 'REAL NOT NULL DEFAULT 0'),
  (db) => backfillFoodFiberSugar(db),

  /* ---------------------------------------------------- Barcode foods --- */
  // Packaged foods found by barcode (src/foodBarcode.js). `source` says who
  // vouches for the numbers: 'openfoodfacts', or 'member' (typed off the label
  // by someone at the gym); NULL for everything that predates scanning.
  // Nutrition stays per serving_unit (100g / 100ml for these); serving_size_g
  // is the pack's own serving, offered as a shortcut.
  (db) => ensureColumn(db, 'food_library', 'barcode', 'TEXT'),
  (db) => ensureColumn(db, 'food_library', 'brand', 'TEXT'),
  (db) => ensureColumn(db, 'food_library', 'serving_size_g', 'REAL'),
  (db) => ensureColumn(db, 'food_library', 'serving_label', 'TEXT'),
  (db) => ensureColumn(db, 'food_library', 'source', 'TEXT'),
  (db) => db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_food_library_barcode ON food_library(barcode) WHERE barcode IS NOT NULL'),

  /* ------------------------------------------- Recent & favourite foods --- */
  // Which library food an entry came from, so "Recent" can reopen the real
  // food with its portion choices. NULL for hand-typed entries and for
  // everything logged before this existed; no FK, because staff deleting a
  // library food must not touch a member's history.
  (db) => ensureColumn(db, 'diet_log_entries', 'food_id', 'INTEGER'),
  // A member's starred foods. Either a library food (food_id, macros read live
  // from the library) or a hand-typed one kept as a snapshot: food_name,
  // serving_unit and the macros for one of that serving.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS member_food_favorites (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id    INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        food_id      INTEGER REFERENCES food_library(id) ON DELETE CASCADE,
        food_name    TEXT NOT NULL,
        serving_unit TEXT NOT NULL DEFAULT 'serving',
        calories     INTEGER NOT NULL DEFAULT 0,
        protein_g    REAL NOT NULL DEFAULT 0,
        carbs_g      REAL NOT NULL DEFAULT 0,
        fats_g       REAL NOT NULL DEFAULT 0,
        fiber_g      REAL NOT NULL DEFAULT 0,
        sugar_g      REAL NOT NULL DEFAULT 0,
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_food_fav_library ON member_food_favorites(member_id, food_id) WHERE food_id IS NOT NULL',
    );
    db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_food_fav_custom ON member_food_favorites(member_id, food_name COLLATE NOCASE) WHERE food_id IS NULL',
    );
  },

  /* ------------------------------------------------ Platform food catalogue --- */
  // Foods copied in from the operator's catalogue (src/foodCatalog.js), by its
  // id, so a rename or a corrected number there reaches this row; `verified`
  // is the operator's blue tick, set by that sync — or by food search, for a
  // food picked from USDA's lab-analysed data or a fully-labelled pack.
  (db) => ensureColumn(db, 'food_library', 'catalog_id', 'INTEGER'),
  (db) => ensureColumn(db, 'food_library', 'verified', 'INTEGER NOT NULL DEFAULT 0'),
  (db) => db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_food_library_catalog ON food_library(catalog_id) WHERE catalog_id IS NOT NULL'),

  /* ------------------------------------------- Per-member add-on trial cut --- */
  // Set when staff end a member's free tracker trial early. NULL means the
  // gym-wide trial applies as usual (see fitnessAccessFor() in src/fitness.js).
  (db) => ensureColumn(db, 'members', 'fitness_trial_cancelled_at', 'TEXT'),

  /* ------------------------------------------------ Shared member plans --- */
  // One member offering one of their own plans to another at the same gym. The
  // share points at the live plan rather than a snapshot, so a fix the sender
  // makes before it is accepted still arrives; accepting copies it into the
  // recipient's own plans, after which the two are independent. Deleting the
  // plan withdraws any share still pending (CASCADE).
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS workout_plan_shares (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        plan_id      INTEGER NOT NULL REFERENCES workout_plans(id) ON DELETE CASCADE,
        sender_id    INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        recipient_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        responded_at TEXT
      )
    `);
    // Sharing the same plan with the same person twice is one share, not two.
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_share_pending ON workout_plan_shares(plan_id, recipient_id) WHERE status = 'pending'",
    );
    db.exec('CREATE INDEX IF NOT EXISTS idx_plan_share_inbox ON workout_plan_shares(recipient_id, status)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_plan_share_sender ON workout_plan_shares(sender_id, created_at)');
  },

  /* ------------------------------------------------- Online food search --- */
  // Foods picked from an online database in food search (src/foodSearch.js):
  // `source` is 'usda' or 'openfoodfacts' and this is that database's own id
  // (an FDC id, a product code), so picking the same food twice reuses the row.
  (db) => ensureColumn(db, 'food_library', 'external_id', 'TEXT'),
  (db) =>
    db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_food_library_external ON food_library(source, external_id) WHERE external_id IS NOT NULL',
    ),

  /* ------------------------------------------- Timed and cardio sets --- */
  // Not every set is weight × reps: a plank is a time, a treadmill run a
  // distance and a time. Both stay 0 on a lifting set, as weight_kg does on
  // these, so the existing volume and 1RM sums need no special case.
  (db) => ensureColumn(db, 'workout_log_sets', 'duration_seconds', 'INTEGER NOT NULL DEFAULT 0'),
  (db) => ensureColumn(db, 'workout_log_sets', 'distance_km', 'REAL NOT NULL DEFAULT 0'),
  // How an add-on was paid for: 'desk' (sold by staff, the only way before
  // in-app payments) or 'online' (the member paid the platform through
  // Razorpay, and the gym's cut is a commission in the platform ledger).
  (db) => ensureColumn(db, 'member_fitness_addons', 'channel', "TEXT NOT NULL DEFAULT 'desk'"),
  // The gym's own shelf: tees, shakers, bars and drinks it stocks and sells
  // at the desk. Entirely the gym's money, so it lives in the gym's own file —
  // the platform catalogue and its orders live in the registry instead (see
  // src/monetization.js).
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS gym_products (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        name           TEXT NOT NULL,
        category       TEXT NOT NULL DEFAULT 'other',
        description    TEXT,
        sku            TEXT,
        price          REAL NOT NULL CHECK (price >= 0),
        cost_price     REAL CHECK (cost_price IS NULL OR cost_price >= 0),
        stock_quantity INTEGER NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0),
        low_stock_at   INTEGER NOT NULL DEFAULT 5 CHECK (low_stock_at >= 0),
        active         INTEGER NOT NULL DEFAULT 1,
        created_at     TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    // Price and name are copied onto each sale, so a later price change or a
    // retired product never rewrites what was actually charged.
    db.exec(`
      CREATE TABLE IF NOT EXISTS gym_product_sales (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id   INTEGER REFERENCES gym_products(id) ON DELETE SET NULL,
        product_name TEXT NOT NULL,
        member_id    INTEGER REFERENCES members(id) ON DELETE SET NULL,
        quantity     INTEGER NOT NULL CHECK (quantity > 0),
        unit_price   REAL NOT NULL CHECK (unit_price >= 0),
        total        REAL NOT NULL CHECK (total >= 0),
        method       TEXT NOT NULL DEFAULT 'cash' CHECK (method IN ('cash', 'card', 'upi', 'bank', 'online')),
        sold_on      TEXT NOT NULL,
        sold_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
        note         TEXT,
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_gym_product_sales_date ON gym_product_sales(sold_on)');
  },
  // What the member app keeps on the phone for speed — the store cart, a
  // workout in progress, own exercises — mirrored here so signing in on
  // another phone picks it up (see public/js/memberSync.js). `value` is the
  // app's own JSON; a cleared value stays as 'null' so another device can tell
  // "emptied" from "never synced".
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS member_app_state (
        member_id  INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        key        TEXT NOT NULL,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (member_id, key)
      )
    `);
  },
  // One row per member-app sign-in: the token carries `sid`, and a token whose
  // row is gone stops working before its own expiry. This is what the Profile's
  // Devices screen lists and signs out (see requireMemberAuth in auth.js).
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS member_sessions (
        id           TEXT PRIMARY KEY,
        member_id    INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        user_agent   TEXT,
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at   TEXT NOT NULL
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_member_sessions_member ON member_sessions(member_id)');
  },
  // The sign-in that registered a phone for push, so signing that device out
  // from another one also stops its reminders. Not a foreign key: a session
  // that merely expires leaves the phone's reminders running, as before.
  (db) => ensureColumn(db, 'push_subscriptions', 'session_id', 'TEXT'),
  // Member-app passwords, replacing the 4-6 digit PIN (portal_pin_hash above)
  // and its last-4-of-phone bootstrap. `portal_password_temp` = 1 means the
  // member has to choose their own before going further: set when the front
  // desk issues one, and for every PIN carried over here — a member who set a
  // PIN can still sign in with it once, rather than being locked out.
  (db) => {
    ensureColumn(db, 'members', 'portal_password_hash', 'TEXT');
    ensureColumn(db, 'members', 'portal_password_temp', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn(db, 'members', 'portal_password_set_at', 'TEXT');
    db.exec(`
      UPDATE members
      SET portal_password_hash = portal_pin_hash, portal_password_temp = 1, portal_pin_hash = NULL
      WHERE portal_pin_hash IS NOT NULL AND portal_password_hash IS NULL
    `);
    // The "email me a code" setup: at most one live code per member, digested
    // (see memberPasswords.js), with a wrong-guess counter.
    db.exec(`
      CREATE TABLE IF NOT EXISTS member_password_codes (
        member_id  INTEGER PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
        code_hash  TEXT NOT NULL,
        attempts   INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL
      )
    `);
  },
  // "Forgot password? Get it on WhatsApp": a temporary password sent from the
  // gym's linked WhatsApp, held beside the member's real one rather than
  // replacing it — anyone who knows a member ID can ask, so asking must not
  // lock the real member out. Signing in with it is what swaps it in; it has
  // no expiry of its own.
  // `portal_reset_sent_at` enforces one self-service send a day.
  (db) => {
    ensureColumn(db, 'members', 'portal_reset_hash', 'TEXT');
    ensureColumn(db, 'members', 'portal_reset_sent_at', 'TEXT');
  },
  // Ask Coach (src/aiCoach.js): every question a member asked and the answer,
  // with the tokens it cost. Today's rows are the daily cap and the chat's
  // short memory; the token counts are what the Vertex bill is made of.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ai_coach_messages (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id     INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        screen        TEXT NOT NULL CHECK (screen IN ('workout', 'diet')),
        question      TEXT NOT NULL,
        answer        TEXT NOT NULL,
        input_tokens  INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_ai_coach_member_day ON ai_coach_messages(member_id, created_at)');
    // The gym's own off switch, beside the add-on it rides on.
    ensureColumn(db, 'fitness_addon_settings', 'ai_coach_enabled', 'INTEGER NOT NULL DEFAULT 1');
  },
  // The AI workout generator (generatePlan in src/aiCoach.js): what the member
  // asked for and the draft that came back, which they then edit and save as
  // an ordinary plan. Today's rows are its daily cap; the tokens are its cost.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ai_plan_generations (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id     INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        request       TEXT NOT NULL,
        plan          TEXT NOT NULL,
        input_tokens  INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_ai_plan_member_day ON ai_plan_generations(member_id, created_at)');
  },
  // Ensure screen column exists on member_notifications for existing tenant databases
  (db) => ensureColumn(db, 'member_notifications', 'screen', 'TEXT'),
  // Meal plans from Ask Coach: the plan a reply carried (JSON), so the next
  // question can change it, and the plans a member saved to log again later.
  // A saved plan is a snapshot, not a link to the chat — it outlives the
  // day-old messages.
  (db) => {
    ensureColumn(db, 'ai_coach_messages', 'meal_plan', 'TEXT');
    db.exec(`
      CREATE TABLE IF NOT EXISTS member_meal_plans (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id  INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        name       TEXT NOT NULL,
        plan       TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_member_meal_plans_member ON member_meal_plans(member_id)');
  },
  // Voice questions (transcribeVoice in src/aiCoach.js): one row per clip
  // written down — never the audio or the words, only its size and the
  // tokens it cost. Today's rows are its daily cap; the tokens join the
  // questions' and plans' on the Vertex bill.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ai_voice_transcriptions (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id     INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        screen        TEXT NOT NULL CHECK (screen IN ('workout', 'diet')),
        mime_type     TEXT NOT NULL,
        audio_bytes   INTEGER NOT NULL,
        heard         INTEGER NOT NULL CHECK (heard IN (0, 1)),
        input_tokens  INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_ai_voice_member_day ON ai_voice_transcriptions(member_id, created_at)');
  },
  // The server address an Android app device registered through (src/fcm.js):
  // FCM needs an absolute URL for a notification's picture, and unlike a
  // browser the phone has no page address to resolve a relative one against.
  (db) => ensureColumn(db, 'push_subscriptions', 'origin', 'TEXT'),
  // The coach in the plan builder (reviewPlan in src/aiCoach.js): each
  // question asked about a plan being edited, by a member or by a staff user
  // writing a template — exactly one of the two. Today's rows are the daily
  // cap; the tokens join the rest of the Vertex bill.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ai_plan_reviews (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id     INTEGER REFERENCES members(id) ON DELETE CASCADE,
        user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
        mode          TEXT NOT NULL CHECK (mode IN ('ask', 'rate')),
        question      TEXT NOT NULL,
        reply         TEXT NOT NULL,
        input_tokens  INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK ((member_id IS NULL) <> (user_id IS NULL))
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_ai_plan_reviews_member_day ON ai_plan_reviews(member_id, created_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_ai_plan_reviews_user_day ON ai_plan_reviews(user_id, created_at)');
  },

  /* --------------------------------------------------------- CoachBook --- */
  // Courses, batches, admissions, installment fees, lecture attendance, the
  // timetable, tests and study material — see src/coaching/schema.js. Carried
  // by every tenant's database, like the SeatBook tables above.
  ...COACHING_MIGRATIONS,

  // The barcode printed on a gym product, so the desk can scan a pack to find
  // it (restock, sell) or to add a new one with its details filled in — see
  // src/productBarcode.js.
  (db) => {
    ensureColumn(db, 'gym_products', 'barcode', 'TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS idx_gym_products_barcode ON gym_products(barcode)');
  },

  // Wearables — see src/wearables.js. A connection is a member's link to one
  // source; `credentials` stays NULL for Health Connect, which the phone
  // reads itself, and is for a cloud provider's (encrypted) tokens. Daily
  // totals are one row per member, day and source, replaced on every sync;
  // NULL means the source does not share that metric, 0 means it counted none.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS member_wearable_connections (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id        INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        provider         TEXT NOT NULL,
        external_user_id TEXT,
        credentials      TEXT,
        connected_at     TEXT NOT NULL DEFAULT (datetime('now')),
        last_synced_at   TEXT,
        UNIQUE (member_id, provider)
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS member_daily_activity (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id       INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        log_date        TEXT NOT NULL,
        provider        TEXT NOT NULL,
        steps           INTEGER CHECK (steps >= 0),
        active_calories INTEGER CHECK (active_calories >= 0),
        distance_m      INTEGER CHECK (distance_m >= 0),
        active_minutes  INTEGER CHECK (active_minutes >= 0),
        synced_at       TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (member_id, log_date, provider)
      )
    `);
  },
  // When the day's water was last changed: the end of the hydration record
  // the app writes to Health Connect. NULL on rows from before it was kept.
  (db) => ensureColumn(db, 'diet_logs', 'water_updated_at', 'TEXT'),

  /* ------------------------- GymBook's WhatsApp receptionist & trials --- */
  // Leads, free trial passes and the desk's trial visits — see
  // src/trialPasses.js — and the front-desk assistant that answers on
  // WhatsApp and books them (src/gymReceptionist.js). The assistant is off
  // by default; trial passes work without it, issued by the desk.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS gym_receptionist_settings (
        id                  INTEGER PRIMARY KEY CHECK (id = 1),
        ai_receptionist     INTEGER NOT NULL DEFAULT 0,
        -- Shown to the contact as the assistant's name; NULL means "the front desk".
        ai_persona_name     TEXT,
        -- The owner's own words the assistant may repeat: facilities, offers,
        -- trainers' credentials. Its only source of claims beyond the tables.
        ai_persona_notes    TEXT,
        -- "Mon–Sat 5:30 AM – 10:30 PM, Sun 7 AM – 12 PM", as the owner writes it.
        opening_hours       TEXT,
        ai_reply_mode       TEXT NOT NULL DEFAULT 'always' CHECK (ai_reply_mode IN ('always', 'after_hours')),
        -- When the desk is staffed, for 'after_hours'.
        office_open         TEXT NOT NULL DEFAULT '09:00',
        office_close        TEXT NOT NULL DEFAULT '21:00',
        office_days         TEXT NOT NULL DEFAULT '1,2,3,4,5,6',
        ai_pause_minutes    INTEGER NOT NULL DEFAULT 720,
        gym_phone           TEXT,
        gym_address         TEXT,
        landmark_directions TEXT,
        latitude            REAL,
        longitude           REAL,
        maps_url            TEXT,
        -- The owner's own phone, for the "hot lead" alert when a trial is booked.
        owner_phone         TEXT,
        hot_lead_alerts     INTEGER NOT NULL DEFAULT 1,
        -- Whether the assistant may offer and book free trials. The desk can
        -- always issue one by hand.
        trial_enabled       INTEGER NOT NULL DEFAULT 1,
        trial_days          INTEGER NOT NULL DEFAULT 3 CHECK (trial_days BETWEEN 1 AND 30),
        trial_visits        INTEGER NOT NULL DEFAULT 3 CHECK (trial_visits BETWEEN 1 AND 30),
        -- One trial per phone number in this many days.
        trial_cooldown_days INTEGER NOT NULL DEFAULT 180 CHECK (trial_cooldown_days BETWEEN 0 AND 3650),
        -- Most trial passes starting on one day; 0 = no limit.
        trial_daily_cap     INTEGER NOT NULL DEFAULT 0 CHECK (trial_daily_cap BETWEEN 0 AND 500),
        -- How far ahead a trial may be booked to start.
        trial_booking_days  INTEGER NOT NULL DEFAULT 7 CHECK (trial_booking_days BETWEEN 0 AND 30),
        trial_followups     INTEGER NOT NULL DEFAULT 1,
        noshow_template     TEXT NOT NULL DEFAULT 'Hi {{first_name}}, your free trial pass at {{gym_name}} is waiting for you — it is valid until {{valid_until}}. Just show the QR at the front desk when you come in. See you soon! 💪',
        visited_template    TEXT NOT NULL DEFAULT 'Hi {{first_name}}, thanks for training with us at {{gym_name}}! How did you find the workout? Reply here if you have any questions about joining — we are happy to help you pick a plan.',
        expiry_template     TEXT NOT NULL DEFAULT 'Hi {{first_name}}, your free trial at {{gym_name}} ends on {{valid_until}}. Join now to keep your momentum going — reply here and we will help you get started.',
        updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec('INSERT OR IGNORE INTO gym_receptionist_settings (id) VALUES (1)');

    // Someone who might join: from a WhatsApp chat, a walk-in, a call. `name`
    // stays NULL until they share it. `member_id` is set on conversion.
    db.exec(`
      CREATE TABLE IF NOT EXISTS gym_leads (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        name           TEXT,
        phone          TEXT NOT NULL,
        goal           TEXT,
        preferred_time TEXT,
        plan_id        INTEGER REFERENCES plans(id) ON DELETE SET NULL,
        status         TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'trial', 'converted', 'lost')),
        source         TEXT NOT NULL DEFAULT 'whatsapp'
                       CHECK (source IN ('whatsapp', 'walk_in', 'phone', 'referral', 'social', 'other')),
        ai_captured    INTEGER NOT NULL DEFAULT 0,
        follow_up_on   TEXT,
        notes          TEXT,
        member_id      INTEGER REFERENCES members(id) ON DELETE SET NULL,
        converted_on   TEXT,
        created_at     TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_gym_leads_phone ON gym_leads(phone)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_gym_leads_status ON gym_leads(status)');

    // A free trial pass. `code` is the random secret both printed in the QR
    // (GBT1:<code>) and typed at the desk; `phone_key` (the number's last ten
    // digits) is what the one-trial-per-number rule counts. valid_from and
    // valid_until are the gym's calendar days, inclusive. Used and expired
    // are derived from the visits and the date, never stored.
    db.exec(`
      CREATE TABLE IF NOT EXISTS trial_passes (
        id                     INTEGER PRIMARY KEY AUTOINCREMENT,
        lead_id                INTEGER NOT NULL REFERENCES gym_leads(id) ON DELETE CASCADE,
        code                   TEXT NOT NULL UNIQUE,
        phone_key              TEXT NOT NULL,
        valid_from             TEXT NOT NULL,
        valid_until            TEXT NOT NULL,
        visits_allowed         INTEGER NOT NULL CHECK (visits_allowed > 0),
        arrival_time           TEXT,
        status                 TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
        issued_by              TEXT NOT NULL DEFAULT 'staff' CHECK (issued_by IN ('ai', 'staff')),
        issued_by_user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
        sent_at                TEXT,
        noshow_sent_at         TEXT,
        visited_sent_at        TEXT,
        expiry_sent_at         TEXT,
        created_at             TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_trial_passes_lead ON trial_passes(lead_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_trial_passes_phone ON trial_passes(phone_key, created_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_trial_passes_from ON trial_passes(valid_from)');

    // One row per day a pass was used. The unique pair is what makes a second
    // scan the same day a no-op rather than a second visit used up.
    db.exec(`
      CREATE TABLE IF NOT EXISTS trial_visits (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        pass_id    INTEGER NOT NULL REFERENCES trial_passes(id) ON DELETE CASCADE,
        visit_date TEXT NOT NULL,
        check_in   TEXT NOT NULL DEFAULT (datetime('now')),
        source     TEXT NOT NULL DEFAULT 'desk',
        UNIQUE (pass_id, visit_date)
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_trial_visits_date ON trial_visits(visit_date)');

    // The chat behind a gym lead, as inquiry_id is for a CoachBook one.
    ensureColumn(db, 'wa_conversations', 'lead_id', 'INTEGER REFERENCES gym_leads(id) ON DELETE SET NULL');
    db.exec('CREATE INDEX IF NOT EXISTS idx_wa_conv_lead ON wa_conversations(lead_id)');
  },
  (db) => {
    // Members paying online (src/onlinePayments.js). One row: where the money
    // goes. 'upi' pays the gym's own UPI ID and the desk confirms it;
    // 'razorpay_route' (later) settles to the gym's linked Razorpay account.
    db.exec(`
      CREATE TABLE IF NOT EXISTS payment_settings (
        id                     INTEGER PRIMARY KEY CHECK (id = 1),
        enabled                INTEGER NOT NULL DEFAULT 0,
        gateway                TEXT NOT NULL DEFAULT 'upi' CHECK (gateway IN ('upi', 'razorpay_route')),
        upi_vpa                TEXT,
        payee_name             TEXT,
        pay_link_in_reminders  INTEGER NOT NULL DEFAULT 1,
        alert_phone            TEXT,
        route_account_id       TEXT,
        updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec('INSERT OR IGNORE INTO payment_settings (id) VALUES (1)');

    // A member's intent to pay one thing: a membership (plan), the dues on a
    // membership, or a CoachBook fee installment. The amount is fixed by the
    // server when the request is made. Nothing is granted until the desk
    // confirms it, which is what creates the real subscription / payment row.
    db.exec(`
      CREATE TABLE IF NOT EXISTS payment_requests (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        token            TEXT NOT NULL UNIQUE,
        ref_code         TEXT NOT NULL UNIQUE,
        member_id        INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        kind             TEXT NOT NULL CHECK (kind IN ('membership', 'dues', 'fee_installment')),
        plan_id          INTEGER REFERENCES plans(id) ON DELETE SET NULL,
        subscription_id  INTEGER REFERENCES subscriptions(id) ON DELETE SET NULL,
        fee_plan_id      INTEGER,
        installment_id   INTEGER,
        amount           REAL NOT NULL CHECK (amount > 0),
        status           TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'claimed', 'confirmed', 'rejected', 'expired')),
        utr              TEXT,
        claimed_at       TEXT,
        decided_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
        decided_at       TEXT,
        reject_reason    TEXT,
        payment_id       INTEGER REFERENCES payments(id) ON DELETE SET NULL,
        expires_at       TEXT NOT NULL,
        created_at       TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    // A UTR identifies one bank transfer: the same one cannot pay twice.
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_payreq_utr ON payment_requests(utr) WHERE utr IS NOT NULL AND status IN ('claimed', 'confirmed')",
    );
    db.exec('CREATE INDEX IF NOT EXISTS idx_payreq_status ON payment_requests(status, created_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_payreq_member ON payment_requests(member_id)');
  },
  (db) => {
    // The owner's WhatsApp voice commands (src/voiceAdmin.js): "Add Rahul
    // Verma, 98112 23344, 3-month plan, took 4000 cash". Off until the owner
    // turns it on — it writes members and money from a chat.
    ensureColumn(db, 'gym_receptionist_settings', 'voice_admin', 'INTEGER NOT NULL DEFAULT 0');
    // One row per command heard. `wa_id` drops WhatsApp's redeliveries; a
    // 'clarify' row is the question a follow-up answers; an 'added' row is
    // what "undo" reverses. Ids, not foreign keys, for what undo deletes.
    db.exec(`
      CREATE TABLE IF NOT EXISTS voice_admin_log (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        wa_id            TEXT UNIQUE,
        sender_phone     TEXT NOT NULL,
        sender_name      TEXT,
        source           TEXT NOT NULL CHECK (source IN ('voice', 'text')),
        transcript       TEXT,
        outcome          TEXT NOT NULL DEFAULT 'pending'
                         CHECK (outcome IN ('pending', 'added', 'clarify', 'ignored', 'rejected', 'failed', 'undo')),
        member_id        INTEGER,
        subscription_id  INTEGER,
        payment_id       INTEGER,
        lead_id          INTEGER,
        lead_prev_status TEXT,
        reply            TEXT,
        error            TEXT,
        tokens           INTEGER NOT NULL DEFAULT 0,
        undone_at        TEXT,
        created_at       TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_voice_admin_sender ON voice_admin_log(sender_phone, created_at)');
  },
  (db) => {
    // Staff alerts (src/staffAlerts.js): the bell in the staff app. One row per
    // person per alert — "₹1,500 to confirm from Rahul", "4 memberships
    // expired yesterday". `dedupe_key` makes the morning digests safe to run
    // every few minutes, the same idea as member_notifications'.
    db.exec(`
      CREATE TABLE IF NOT EXISTS staff_notifications (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind       TEXT NOT NULL,
        title      TEXT NOT NULL,
        body       TEXT NOT NULL DEFAULT '',
        link       TEXT,
        dedupe_key TEXT,
        pushed     INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        read_at    TEXT
      )
    `);
    db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_notif_dedupe ON staff_notifications(user_id, dedupe_key) WHERE dedupe_key IS NOT NULL',
    );
    db.exec('CREATE INDEX IF NOT EXISTS idx_staff_notif_inbox ON staff_notifications(user_id, created_at)');
    // Which alerts a person switched off: a row only for a choice made, so a
    // new alert type reaches everyone it is meant for without a backfill.
    db.exec(`
      CREATE TABLE IF NOT EXISTS staff_notification_prefs (
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind       TEXT NOT NULL,
        enabled    INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (user_id, kind)
      )
    `);
    // Staff devices for Web Push — push_subscriptions' columns, keyed to a
    // users row instead of a member. Kept apart so a member signing in on the
    // desk browser can never be handed the desk's alerts, or the reverse.
    db.exec(`
      CREATE TABLE IF NOT EXISTS staff_push_subscriptions (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        endpoint        TEXT NOT NULL UNIQUE,
        p256dh          TEXT NOT NULL,
        auth            TEXT NOT NULL,
        platform        TEXT NOT NULL DEFAULT 'other' CHECK (platform IN ('ios', 'android', 'desktop', 'other')),
        user_agent      TEXT,
        path_prefix     TEXT NOT NULL DEFAULT '',
        origin          TEXT,
        failure_count   INTEGER NOT NULL DEFAULT 0,
        last_success_at TEXT,
        last_error      TEXT,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_staff_push_user ON staff_push_subscriptions(user_id)');
  },
  // The owner's print templates — receipt, ID card, OMR sheet (src/printTemplates.js).
  // One JSON row per kind; defaults live in code, so an absent row means "as shipped".
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS print_templates (
        kind       TEXT PRIMARY KEY,
        data       TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
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

/**
 * Which product this tenant runs: 'gym', 'library' or 'coaching'.
 *
 * Lives in the store rather than on `req` because bootstrap.js, maintenance.js,
 * server.js's reminder sweep and platformAdmin.js all need it and none of them
 * has a request. 'gym' is the fallback for the dev/single-tenant database and
 * for every tenant provisioned before verticals existed.
 */
export function getBusinessType() {
  return tenantStorage.getStore()?.businessType ?? 'gym';
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

/** How deep each handle is in tx() calls — so a tx() inside another (selling
 * a membership from inside confirming an online payment) becomes a savepoint
 * rather than a second BEGIN, which SQLite refuses. */
const txDepth = new WeakMap();

export function tx(fn) {
  const handle = getDb();
  const depth = txDepth.get(handle) ?? 0;
  if (depth > 0) {
    const savepoint = `tx_${depth}`;
    handle.exec(`SAVEPOINT ${savepoint}`);
    txDepth.set(handle, depth + 1);
    try {
      const result = fn();
      handle.exec(`RELEASE ${savepoint}`);
      return result;
    } catch (err) {
      handle.exec(`ROLLBACK TO ${savepoint}`);
      handle.exec(`RELEASE ${savepoint}`);
      throw err;
    } finally {
      txDepth.set(handle, depth);
    }
  }
  return outerTx(handle, fn);
}

function outerTx(handle, fn) {
  txDepth.set(handle, 1);
  try {
    return runOuterTx(handle, fn);
  } finally {
    txDepth.set(handle, 0);
  }
}

function runOuterTx(handle, fn) {
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
