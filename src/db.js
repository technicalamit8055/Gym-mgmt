import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { seedFitnessLibraries } from './fitnessSeed.js';

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
  // A member's own PIN for the self-service portal, scrypt-hashed the same as
  // a staff password (see hashPassword in auth.js). NULL means the member has
  // never set one — the portal login route accepts the last 4 digits of their
  // phone (or member code) as a one-time bootstrap PIN in that case, and
  // prompts them to set a real one, which is what actually populates this.
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
        muscle_group  TEXT NOT NULL
                      CHECK (muscle_group IN ('chest', 'back', 'legs', 'shoulders', 'arms', 'core', 'cardio', 'full_body')),
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
        muscle_group TEXT NOT NULL
                     CHECK (muscle_group IN ('chest', 'back', 'legs', 'shoulders', 'arms', 'core', 'cardio', 'full_body')),
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
  (db) => seedFitnessLibraries(db),
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
 * Which product this tenant runs: 'gym' or 'library'.
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
