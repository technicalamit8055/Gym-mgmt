import { DEFAULT_TEMPLATES, sqlLiteral } from './templates.js';

/**
 * CoachBook's tables, appended to db.js's MIGRATIONS. Like the SeatBook tables,
 * every tenant's database carries them regardless of vertical — a gym simply
 * never writes to them — which keeps migrations linear and lets the operator
 * console re-type a mis-selected account without re-provisioning it.
 *
 * Append-only, same rule as db.js: each later change is one more guarded step
 * at the end of this list, never an edit to a step that has already run on
 * someone's database.
 *
 * Money follows the rest of the schema: what was billed and what was paid are
 * stored, and every balance is computed from them. An installment has a due
 * amount; how much of it is paid is the sum of the fee_payment_items pointing
 * at it, so deleting a payment (or bouncing a cheque) can never leave a stale
 * "paid" flag behind. See src/coaching/fees.js.
 *
 * Calendar dates (start_date, enrolled_on, due_date, attendance_date,
 * test_date, lecture_date) are the institute's local date, inserted
 * explicitly from validate.js's today() — the date('now') defaults are UTC
 * and only a last resort, as db.js's header explains.
 */

function ensureColumn(db, table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

/** Every type the delivery log has to admit once CoachBook sends its own. */
const WHATSAPP_LOG_TYPES = [
  'receipt', 'reminder', 'welcome', 'freeze', 'birthday', 'custom',
  'absence', 'fee_due', 'fee_receipt', 'scorecard', 'attendance_low',
];

export const COACHING_MIGRATIONS = [
  /* ---------------------------------------------- Academic structure --- */
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS academic_courses (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        name          TEXT NOT NULL,
        code          TEXT,
        target_exam   TEXT,
        academic_year TEXT NOT NULL,
        description   TEXT,
        active        INTEGER NOT NULL DEFAULT 1,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS academic_subjects (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        course_id  INTEGER NOT NULL REFERENCES academic_courses(id) ON DELETE CASCADE,
        name       TEXT NOT NULL,
        code       TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_subjects_course ON academic_subjects(course_id)');
    // weekdays/start_time/end_time are the batch's headline timing ("Mon/Wed/Fri
    // 4–7 PM") for rosters and the student card; the lecture-by-lecture plan
    // lives in academic_timetable.
    db.exec(`
      CREATE TABLE IF NOT EXISTS academic_batches (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        course_id  INTEGER NOT NULL REFERENCES academic_courses(id) ON DELETE CASCADE,
        name       TEXT NOT NULL,
        code       TEXT NOT NULL UNIQUE,
        capacity   INTEGER NOT NULL DEFAULT 40 CHECK (capacity > 0),
        room       TEXT,
        weekdays   TEXT,
        start_time TEXT,
        end_time   TEXT,
        start_date TEXT NOT NULL,
        end_date   TEXT,
        active     INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_batches_course ON academic_batches(course_id)');
    db.exec(`
      CREATE TABLE IF NOT EXISTS faculty_allocations (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        faculty_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        batch_id    INTEGER NOT NULL REFERENCES academic_batches(id) ON DELETE CASCADE,
        subject_id  INTEGER NOT NULL REFERENCES academic_subjects(id) ON DELETE CASCADE,
        hourly_rate REAL NOT NULL DEFAULT 0 CHECK (hourly_rate >= 0),
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (faculty_id, batch_id, subject_id)
      )
    `);
  },
  // A teacher is a staff user (role 'trainer', called "Faculty" here). Pay is
  // either a fixed monthly salary or a rate per lecture/hour, which the
  // workload report multiplies against the lecture log.
  (db) => {
    ensureColumn(db, 'users', 'qualification', 'TEXT');
    ensureColumn(db, 'users', 'specialization', 'TEXT');
    ensureColumn(db, 'users', 'bio', 'TEXT');
    ensureColumn(db, 'users', 'pay_type', "TEXT CHECK (pay_type IN ('salary', 'per_lecture', 'hourly') OR pay_type IS NULL)");
    ensureColumn(db, 'users', 'pay_rate', 'REAL');
  },
  // The student-side fields a coaching admission form asks for. Guardian name
  // and WhatsApp number are the existing emergency_contact/emergency_phone
  // (the vertical calls them "Guardian"), so they need no column of their own.
  (db) => {
    ensureColumn(db, 'members', 'school_name', 'TEXT');
    ensureColumn(db, 'members', 'current_class', 'TEXT');
    ensureColumn(db, 'members', 'guardian_relation', 'TEXT');
    ensureColumn(db, 'members', 'guardian_occupation', 'TEXT');
  },

  /* --------------------------------------------------- Admissions CRM --- */
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS student_inquiries (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        student_name  TEXT NOT NULL,
        guardian_name TEXT,
        phone         TEXT NOT NULL,
        email         TEXT,
        course_id     INTEGER REFERENCES academic_courses(id) ON DELETE SET NULL,
        target_class  TEXT,
        school_name   TEXT,
        status        TEXT NOT NULL DEFAULT 'inquiry'
                      CHECK (status IN ('inquiry', 'demo_scheduled', 'demo_attended', 'follow_up', 'admitted', 'declined')),
        demo_on       TEXT,
        follow_up_on  TEXT,
        notes         TEXT,
        source        TEXT DEFAULT 'walk_in',
        assigned_to   INTEGER REFERENCES users(id) ON DELETE SET NULL,
        member_id     INTEGER REFERENCES members(id) ON DELETE SET NULL,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_inquiries_status ON student_inquiries(status)');
    db.exec(`
      CREATE TABLE IF NOT EXISTS batch_enrollments (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id   INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        batch_id    INTEGER NOT NULL REFERENCES academic_batches(id) ON DELETE CASCADE,
        roll_number TEXT,
        seat_no     TEXT,
        enrolled_on TEXT NOT NULL DEFAULT (date('now')),
        status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'dropped')),
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (member_id, batch_id)
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_enrollment_batch ON batch_enrollments(batch_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_enrollment_student ON batch_enrollments(member_id)');
    // A roll number names one student within one batch, so two can't share it.
    db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_enrollment_roll ON batch_enrollments(batch_id, roll_number) WHERE roll_number IS NOT NULL',
    );
  },

  /* ------------------------------------------- Fees & installments --- */
  (db) => {
    // A template: what a course costs and how it is usually split. A student's
    // own plan (below) is copied from it at enrollment and then edited freely —
    // changing the template later never rewrites what a family agreed to.
    // `components` is a JSON list of { label, amount } (tuition, registration,
    // material, test series, GST) printed on the receipt.
    db.exec(`
      CREATE TABLE IF NOT EXISTS fee_structures (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        course_id     INTEGER NOT NULL REFERENCES academic_courses(id) ON DELETE CASCADE,
        name          TEXT NOT NULL,
        total_fee     REAL NOT NULL CHECK (total_fee >= 0),
        installments  INTEGER NOT NULL DEFAULT 1 CHECK (installments BETWEEN 1 AND 12),
        interval_days INTEGER NOT NULL DEFAULT 30 CHECK (interval_days >= 0),
        components    TEXT,
        active        INTEGER NOT NULL DEFAULT 1,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    // No ON DELETE on course_id: a course somebody owes money against cannot
    // be deleted out from under the ledger (the route archives it instead).
    db.exec(`
      CREATE TABLE IF NOT EXISTS student_fee_plans (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        member_id        INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        course_id        INTEGER NOT NULL REFERENCES academic_courses(id),
        batch_id         INTEGER REFERENCES academic_batches(id) ON DELETE SET NULL,
        fee_structure_id INTEGER REFERENCES fee_structures(id) ON DELETE SET NULL,
        total_amount     REAL NOT NULL CHECK (total_amount >= 0),
        discount_amount  REAL NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
        discount_reason  TEXT,
        final_amount     REAL NOT NULL CHECK (final_amount >= 0),
        components       TEXT,
        status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paid', 'defaulted', 'cancelled')),
        note             TEXT,
        created_at       TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_fee_plans_member ON student_fee_plans(member_id)');
    db.exec(`
      CREATE TABLE IF NOT EXISTS student_fee_installments (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        plan_id            INTEGER NOT NULL REFERENCES student_fee_plans(id) ON DELETE CASCADE,
        installment_number INTEGER NOT NULL CHECK (installment_number > 0),
        label              TEXT,
        amount_due         REAL NOT NULL CHECK (amount_due > 0),
        due_date           TEXT NOT NULL,
        reminder_sent_at   TEXT,
        created_at         TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (plan_id, installment_number)
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_installments_due ON student_fee_installments(due_date)');
    // How one payment was split across installments — a ₹20,000 payment can
    // close installment 1 and part-pay installment 2.
    db.exec(`
      CREATE TABLE IF NOT EXISTS fee_payment_items (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        payment_id     INTEGER NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
        installment_id INTEGER NOT NULL REFERENCES student_fee_installments(id) ON DELETE CASCADE,
        amount         REAL NOT NULL CHECK (amount > 0)
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_fee_items_payment ON fee_payment_items(payment_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_fee_items_installment ON fee_payment_items(installment_id)');
    // A fee payment is an ordinary payments row, so the dashboard, reports and
    // the member's balance already count it. These say which course it was
    // for, and track a cheque until it clears (payments.method stays 'bank').
    ensureColumn(db, 'payments', 'fee_plan_id', 'INTEGER REFERENCES student_fee_plans(id) ON DELETE SET NULL');
    ensureColumn(db, 'payments', 'cheque_no', 'TEXT');
    ensureColumn(db, 'payments', 'cheque_status', "TEXT CHECK (cheque_status IN ('pending', 'cleared') OR cheque_status IS NULL)");
  },

  /* ----------------------------------------- Timetable & attendance --- */
  (db) => {
    // Rooms stay free text on a batch or a lecture (most institutes just say
    // "Room 101"); a row here only adds a desk count, matched by name, which
    // is what the timetable's over-capacity warning checks a batch against.
    db.exec(`
      CREATE TABLE IF NOT EXISTS classrooms (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
        capacity   INTEGER NOT NULL CHECK (capacity > 0),
        notes      TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS academic_timetable (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_id   INTEGER NOT NULL REFERENCES academic_batches(id) ON DELETE CASCADE,
        subject_id INTEGER NOT NULL REFERENCES academic_subjects(id) ON DELETE CASCADE,
        faculty_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        weekday    INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
        start_time TEXT NOT NULL,
        end_time   TEXT NOT NULL,
        room       TEXT,
        active     INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK (end_time > start_time)
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_timetable_batch ON academic_timetable(batch_id, weekday)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_timetable_faculty ON academic_timetable(faculty_id, weekday)');
    // One mark per student per batch per day per subject. subject_id is NULL
    // for a whole-day mark (the gate scan), and SQLite treats NULLs as
    // distinct in a plain UNIQUE — hence the COALESCE in an expression index
    // rather than a table constraint.
    db.exec(`
      CREATE TABLE IF NOT EXISTS batch_attendance (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_id        INTEGER NOT NULL REFERENCES academic_batches(id) ON DELETE CASCADE,
        subject_id      INTEGER REFERENCES academic_subjects(id) ON DELETE CASCADE,
        member_id       INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        attendance_date TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'present' CHECK (status IN ('present', 'absent', 'late', 'excused')),
        source          TEXT NOT NULL DEFAULT 'sheet' CHECK (source IN ('sheet', 'scan')),
        marked_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
        whatsapp_sent   INTEGER NOT NULL DEFAULT 0,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_batch_att_once ON batch_attendance(batch_id, member_id, attendance_date, COALESCE(subject_id, 0))',
    );
    db.exec('CREATE INDEX IF NOT EXISTS idx_batch_att_date ON batch_attendance(attendance_date, batch_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_batch_att_member ON batch_attendance(member_id, attendance_date)');
    // "Kinematics: projectile motion derivations done; DPP #3 assigned" — the
    // syllabus tracker, and the count a per-lecture teacher is paid against.
    db.exec(`
      CREATE TABLE IF NOT EXISTS lecture_logs (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_id     INTEGER NOT NULL REFERENCES academic_batches(id) ON DELETE CASCADE,
        subject_id   INTEGER REFERENCES academic_subjects(id) ON DELETE SET NULL,
        faculty_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
        lecture_date TEXT NOT NULL,
        topic        TEXT NOT NULL,
        notes        TEXT,
        duration_min INTEGER CHECK (duration_min IS NULL OR duration_min > 0),
        created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_lecture_logs_batch ON lecture_logs(batch_id, lecture_date)');
  },

  /* --------------------------------------------------- Tests & marks --- */
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS academic_tests (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_id         INTEGER NOT NULL REFERENCES academic_batches(id) ON DELETE CASCADE,
        subject_id       INTEGER REFERENCES academic_subjects(id) ON DELETE SET NULL,
        title            TEXT NOT NULL,
        test_type        TEXT NOT NULL DEFAULT 'weekly' CHECK (test_type IN ('weekly', 'monthly', 'mock', 'dpp', 'other')),
        test_date        TEXT NOT NULL,
        max_marks        REAL NOT NULL CHECK (max_marks > 0),
        passing_marks    REAL DEFAULT 0,
        negative_marking REAL NOT NULL DEFAULT 0 CHECK (negative_marking >= 0),
        syllabus         TEXT,
        published_at     TEXT,
        created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at       TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_tests_batch ON academic_tests(batch_id, test_date)');
    // No lower bound on marks_obtained: with negative marking a JEE-style
    // paper can genuinely score below zero. The route bounds it by max_marks.
    db.exec(`
      CREATE TABLE IF NOT EXISTS academic_test_marks (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        test_id        INTEGER NOT NULL REFERENCES academic_tests(id) ON DELETE CASCADE,
        member_id      INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        marks_obtained REAL NOT NULL DEFAULT 0,
        rank           INTEGER,
        percentile     REAL,
        is_absent      INTEGER NOT NULL DEFAULT 0,
        whatsapp_sent  INTEGER NOT NULL DEFAULT 0,
        remarks        TEXT,
        created_at     TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (test_id, member_id)
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_test_marks ON academic_test_marks(test_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_test_marks_member ON academic_test_marks(member_id)');
  },

  /* --------------------------------------- Study material & DPPs --- */
  (db) => {
    // Either an uploaded file (bytes) or a link (file_url) — a Drive folder of
    // PYQs is as much study material as a PDF. batch_id NULL with a course_id
    // means every batch of that course; both NULL means the whole institute.
    db.exec(`
      CREATE TABLE IF NOT EXISTS academic_materials (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        course_id       INTEGER REFERENCES academic_courses(id) ON DELETE CASCADE,
        batch_id        INTEGER REFERENCES academic_batches(id) ON DELETE CASCADE,
        subject_id      INTEGER REFERENCES academic_subjects(id) ON DELETE SET NULL,
        title           TEXT NOT NULL,
        kind            TEXT NOT NULL DEFAULT 'notes' CHECK (kind IN ('notes', 'dpp', 'pyq', 'assignment', 'syllabus', 'solution')),
        description     TEXT,
        file_url        TEXT,
        file_name       TEXT,
        mime            TEXT,
        bytes           BLOB,
        file_size_bytes INTEGER NOT NULL DEFAULT 0,
        due_date        TEXT,
        uploaded_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK (file_url IS NOT NULL OR bytes IS NOT NULL)
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_materials_batch ON academic_materials(batch_id)');
    db.exec(`
      CREATE TABLE IF NOT EXISTS assignment_submissions (
        material_id  INTEGER NOT NULL REFERENCES academic_materials(id) ON DELETE CASCADE,
        member_id    INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        status       TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'late')),
        submitted_on TEXT NOT NULL,
        remarks      TEXT,
        PRIMARY KEY (material_id, member_id)
      )
    `);
  },

  /* ------------------------------------------- Parent alert settings --- */
  // A table of its own rather than more whatsapp_settings columns: it is
  // created after the coaching copy exists, so the column defaults *are* the
  // CoachBook wording and no seeding step has to rewrite them.
  (db) => {
    const t = DEFAULT_TEMPLATES;
    db.exec(`
      CREATE TABLE IF NOT EXISTS coaching_settings (
        id                        INTEGER PRIMARY KEY CHECK (id = 1),
        absence_alerts            INTEGER NOT NULL DEFAULT 1,
        late_alerts               INTEGER NOT NULL DEFAULT 0,
        absence_template          TEXT NOT NULL DEFAULT ${sqlLiteral(t.absence_template)},
        late_template             TEXT NOT NULL DEFAULT ${sqlLiteral(t.late_template)},
        fee_reminders             INTEGER NOT NULL DEFAULT 1,
        fee_reminder_days_before  INTEGER NOT NULL DEFAULT 3,
        overdue_reminder_days     INTEGER NOT NULL DEFAULT 7,
        fee_due_template          TEXT NOT NULL DEFAULT ${sqlLiteral(t.fee_due_template)},
        fee_overdue_template      TEXT NOT NULL DEFAULT ${sqlLiteral(t.fee_overdue_template)},
        fee_receipts              INTEGER NOT NULL DEFAULT 1,
        fee_receipt_template      TEXT NOT NULL DEFAULT ${sqlLiteral(t.fee_receipt_template)},
        scorecard_template        TEXT NOT NULL DEFAULT ${sqlLiteral(t.scorecard_template)},
        low_attendance_threshold  INTEGER NOT NULL DEFAULT 75,
        low_attendance_template   TEXT NOT NULL DEFAULT ${sqlLiteral(t.low_attendance_template)},
        institute_phone           TEXT,
        gstin                     TEXT,
        updated_at                TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.prepare('INSERT OR IGNORE INTO coaching_settings (id) VALUES (1)').run();
  },

  // The delivery log's `type` CHECK, widened for CoachBook's own sends — the
  // same rebuild-the-table dance db.js does for 'freeze' and 'birthday'.
  (db) => {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'whatsapp_logs'").get();
    if (!row || row.sql.includes("'scorecard'")) return;
    const types = WHATSAPP_LOG_TYPES.map((type) => `'${type}'`).join(', ');
    db.exec(`
      CREATE TABLE whatsapp_logs_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        phone       TEXT NOT NULL,
        member_id   INTEGER REFERENCES members(id) ON DELETE SET NULL,
        type        TEXT NOT NULL CHECK (type IN (${types})),
        message     TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'failed')),
        error       TEXT,
        sent_at     TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec(`
      INSERT INTO whatsapp_logs_new (id, phone, member_id, type, message, status, error, sent_at)
      SELECT id, phone, member_id, type, message, status, error, sent_at FROM whatsapp_logs
    `);
    db.exec('DROP TABLE whatsapp_logs');
    db.exec('ALTER TABLE whatsapp_logs_new RENAME TO whatsapp_logs');
    db.exec('CREATE INDEX IF NOT EXISTS idx_wa_logs_sent ON whatsapp_logs(sent_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_wa_logs_member ON whatsapp_logs(member_id)');
  },
];
