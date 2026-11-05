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

  /* ------------------------------------- AI WhatsApp receptionist --- */
  // See src/coaching/receptionist.js. Off by default: it answers parents from
  // the institute's own number, so switching it on is the owner's decision.
  (db) => {
    ensureColumn(db, 'coaching_settings', 'ai_receptionist', 'INTEGER NOT NULL DEFAULT 0');
    // Shown to parents as the assistant's name; NULL means "the admissions desk".
    ensureColumn(db, 'coaching_settings', 'ai_persona_name', 'TEXT');
    // Free text from the owner: tone, and facts the assistant may repeat
    // (results, scholarships, a sibling discount). The only source of claims
    // beyond the academic tables, so it is the owner's words, not the model's.
    ensureColumn(db, 'coaching_settings', 'ai_persona_notes', 'TEXT');
    // 'always', or 'after_hours' to leave office hours to the desk.
    ensureColumn(db, 'coaching_settings', 'ai_reply_mode', "TEXT NOT NULL DEFAULT 'always'");
    ensureColumn(db, 'coaching_settings', 'office_open', "TEXT NOT NULL DEFAULT '09:00'");
    ensureColumn(db, 'coaching_settings', 'office_close', "TEXT NOT NULL DEFAULT '19:00'");
    ensureColumn(db, 'coaching_settings', 'office_days', "TEXT NOT NULL DEFAULT '1,2,3,4,5,6'");
    // How long the bot stays quiet in a chat after a staff member replies by hand.
    ensureColumn(db, 'coaching_settings', 'ai_pause_minutes', 'INTEGER NOT NULL DEFAULT 720');
    ensureColumn(db, 'coaching_settings', 'institute_address', 'TEXT');
    ensureColumn(db, 'coaching_settings', 'landmark_directions', 'TEXT');
    ensureColumn(db, 'coaching_settings', 'latitude', 'REAL');
    ensureColumn(db, 'coaching_settings', 'longitude', 'REAL');
    ensureColumn(db, 'coaching_settings', 'maps_url', 'TEXT');
    // The director's own phone, for the "hot lead" alert when a demo is booked.
    ensureColumn(db, 'coaching_settings', 'director_phone', 'TEXT');
    ensureColumn(db, 'coaching_settings', 'hot_lead_alerts', 'INTEGER NOT NULL DEFAULT 1');

    // A recurring free demo class: "Wednesdays 4 PM, 6 seats, Er. Verma".
    // Seats left on a date are the capacity minus the inquiries booked into
    // it for that date — counted, never stored, like every other balance.
    db.exec(`
      CREATE TABLE IF NOT EXISTS admission_demo_slots (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        weekday      INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
        start_time   TEXT NOT NULL,
        duration_min INTEGER NOT NULL DEFAULT 60 CHECK (duration_min > 0),
        capacity     INTEGER NOT NULL DEFAULT 5 CHECK (capacity > 0),
        course_id    INTEGER REFERENCES academic_courses(id) ON DELETE CASCADE,
        faculty_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
        room         TEXT,
        active       INTEGER NOT NULL DEFAULT 1,
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    ensureColumn(db, 'student_inquiries', 'demo_time', 'TEXT');
    ensureColumn(db, 'student_inquiries', 'demo_slot_id', 'INTEGER REFERENCES admission_demo_slots(id) ON DELETE SET NULL');
    // Set when the lead was first written by the WhatsApp assistant.
    ensureColumn(db, 'student_inquiries', 'ai_captured', 'INTEGER NOT NULL DEFAULT 0');
    db.exec('CREATE INDEX IF NOT EXISTS idx_inquiries_demo_slot ON student_inquiries(demo_slot_id, demo_on)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_inquiries_phone ON student_inquiries(phone)');

    // One row per WhatsApp chat the institute's number has had with a contact.
    // `jid` is the chat as WhatsApp addresses it (a phone JID, or a privacy
    // @lid one); `phone` is the number when WhatsApp tells us it.
    db.exec(`
      CREATE TABLE IF NOT EXISTS wa_conversations (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        jid              TEXT NOT NULL UNIQUE,
        phone            TEXT,
        contact_name     TEXT,
        inquiry_id       INTEGER REFERENCES student_inquiries(id) ON DELETE SET NULL,
        bot_paused_until TEXT,
        paused_by        TEXT,
        needs_staff      INTEGER NOT NULL DEFAULT 0,
        handoff_reason   TEXT,
        last_message_at  TEXT,
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_wa_conv_inquiry ON wa_conversations(inquiry_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_wa_conv_phone ON wa_conversations(phone)');
    // The transcript. `wa_id` is WhatsApp's own message id, unique per chat,
    // which is what makes a redelivered message (a reconnect replays the
    // offline queue) a no-op instead of a second reply.
    db.exec(`
      CREATE TABLE IF NOT EXISTS wa_messages (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL REFERENCES wa_conversations(id) ON DELETE CASCADE,
        direction       TEXT NOT NULL CHECK (direction IN ('in', 'out')),
        author          TEXT NOT NULL CHECK (author IN ('parent', 'ai', 'staff', 'system')),
        kind            TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'location', 'media', 'note')),
        body            TEXT NOT NULL,
        wa_id           TEXT,
        status          TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('received', 'sent', 'failed')),
        error           TEXT,
        meta            TEXT,
        created_at      TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_msg_once ON wa_messages(conversation_id, wa_id) WHERE wa_id IS NOT NULL');
    db.exec('CREATE INDEX IF NOT EXISTS idx_wa_msg_conv ON wa_messages(conversation_id, id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_wa_msg_author ON wa_messages(author, created_at)');
  },

  // The delivery log admits the director's hot-lead alert. Same rebuild as
  // the step above; WHATSAPP_LOG_TYPES stays as it was so that step still
  // builds exactly what it always has on a fresh database.
  (db) => {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'whatsapp_logs'").get();
    if (!row || row.sql.includes("'lead_alert'")) return;
    const types = [...WHATSAPP_LOG_TYPES, 'lead_alert'].map((type) => `'${type}'`).join(', ');
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

  /* ---------------------------------------------- Live classes --- */
  // A lecture streamed to one batch: the teacher goes live, the batch's
  // student app shows it, and polls and doubts hang off the session. See
  // src/routes/coaching/live.js. The started/ended instants are UTC
  // `YYYY-MM-DD HH:MM:SS`, the same shape as datetime('now').
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS live_sessions (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_id     INTEGER NOT NULL REFERENCES academic_batches(id) ON DELETE CASCADE,
        subject_id   INTEGER REFERENCES academic_subjects(id) ON DELETE SET NULL,
        faculty_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
        title        TEXT,
        status       TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'live', 'ended')),
        stream_url   TEXT,
        scheduled_at TEXT,
        started_at   TEXT,
        ended_at     TEXT,
        created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK (status <> 'live' OR started_at IS NOT NULL),
        CHECK (status <> 'ended' OR ended_at IS NOT NULL)
      )
    `);
    // One class on air per batch and per teacher, held by the database rather
    // than a check-then-insert, so two taps on "Go live" cannot both win.
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_live_one_per_batch ON live_sessions(batch_id) WHERE status = 'live'");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_live_one_per_faculty ON live_sessions(faculty_id) WHERE status = 'live'");
    db.exec('CREATE INDEX IF NOT EXISTS idx_live_batch ON live_sessions(batch_id, status)');

    // "Which option?" with A–D on the board: the question and option texts are
    // optional because the teacher usually just says them. option_count is how
    // many of A–D are in play, and the correct answer has to be one of them
    // (NULL for an opinion poll). duration_sec is the countdown.
    db.exec(`
      CREATE TABLE IF NOT EXISTS live_polls (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id     INTEGER NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
        question       TEXT,
        option_count   INTEGER NOT NULL DEFAULT 4 CHECK (option_count BETWEEN 2 AND 4),
        option_a       TEXT,
        option_b       TEXT,
        option_c       TEXT,
        option_d       TEXT,
        correct_option TEXT CHECK (correct_option IS NULL OR (correct_option IN ('A', 'B', 'C', 'D') AND instr('ABCD', correct_option) <= option_count)),
        duration_sec   INTEGER NOT NULL DEFAULT 30 CHECK (duration_sec BETWEEN 5 AND 600),
        status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'closed')),
        opened_at      TEXT,
        closes_at      TEXT,
        closed_at      TEXT,
        created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at     TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_live_polls_session ON live_polls(session_id, id)');
    // One answer per student per poll. response_ms is the time from the poll
    // opening to the answer — the leaderboard's tie-break. Whether it was right
    // is choice = correct_option, worked out when read, never stored, so
    // fixing a mis-keyed answer re-marks every vote.
    db.exec(`
      CREATE TABLE IF NOT EXISTS live_poll_votes (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        poll_id     INTEGER NOT NULL REFERENCES live_polls(id) ON DELETE CASCADE,
        member_id   INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        choice      TEXT NOT NULL CHECK (choice IN ('A', 'B', 'C', 'D')),
        response_ms INTEGER NOT NULL CHECK (response_ms >= 0),
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (poll_id, member_id)
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_live_votes_member ON live_poll_votes(member_id)');
    db.exec(`
      CREATE TABLE IF NOT EXISTS live_doubts (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id  INTEGER NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
        member_id   INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        body        TEXT NOT NULL CHECK (length(body) > 0),
        pinned      INTEGER NOT NULL DEFAULT 0,
        pinned_at   TEXT,
        resolved    INTEGER NOT NULL DEFAULT 0,
        resolved_at TEXT,
        resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_live_doubts_session ON live_doubts(session_id, pinned, resolved)');
  },

  // The notes a smartboard publishes when a live class ends point back at the
  // class. One notes file per class: a retried or corrected export replaces
  // the file instead of listing the same lecture twice.
  (db) => {
    ensureColumn(db, 'academic_materials', 'live_session_id', 'INTEGER REFERENCES live_sessions(id) ON DELETE SET NULL');
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_materials_live_notes ON academic_materials(live_session_id) WHERE live_session_id IS NOT NULL AND kind = 'notes'",
    );
  },

  // One doubt pinned on the class's screens at a time; pinning another
  // unpins the first in the same transaction (src/coaching/liveDoubts.js).
  // pinned_at is when it was last pinned, kept after it comes down.
  (db) => {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_live_doubts_one_pinned ON live_doubts(session_id) WHERE pinned = 1');
  },

  /* ------------------------------------------- Smartboard studios --- */
  // A classroom smartboard running CoachBook Studio (the studio/ app). It is
  // paired to a classroom, not a person: a manager registers it and gets a
  // one-time pairing code, the board trades the code for its device token,
  // and from then on it runs the classes timetabled in its room. Both secrets
  // are stored only as SHA-256 hashes — they are long random strings, so a
  // fast hash is enough; nothing here can be guessed the way a password can.
  // See src/coaching/studio.js.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS studio_devices (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        name               TEXT NOT NULL,
        classroom_id       INTEGER NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
        token_hash         TEXT UNIQUE,
        pairing_code_hash  TEXT UNIQUE,
        pairing_expires_at TEXT,
        paired_at          TEXT,
        last_seen_at       TEXT,
        created_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at         TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    // Which board ran a class, so it can keep controlling the class it
    // started even past the end of the timetable slot.
    ensureColumn(db, 'live_sessions', 'studio_device_id', 'INTEGER REFERENCES studio_devices(id) ON DELETE SET NULL');
  },

  /* --------------------------------------------- Unlisted YouTube --- */
  // The institute's YouTube channel, signed in to once by a manager, so each
  // class a board streams becomes its own unlisted broadcast. One row at most.
  // The refresh token is sealed (src/sealed.js); `broken_at` is set when
  // Google stops accepting it, so the Smartboards page can ask for a
  // reconnect instead of every class failing quietly. See src/coaching/youtube.js.
  //
  // A board's YouTube stream (its ingest key) is created once and reused for
  // every class, sealed too; `youtube_stream_channel` says which channel it
  // belongs to, so connecting a different channel makes a new one.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS youtube_connection (
        id                   INTEGER PRIMARY KEY CHECK (id = 1),
        channel_id           TEXT NOT NULL,
        channel_title        TEXT,
        refresh_token_sealed TEXT NOT NULL,
        connected_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
        connected_at         TEXT NOT NULL DEFAULT (datetime('now')),
        broken_at            TEXT,
        broken_reason        TEXT
      )
    `);
    // A sign-in in progress: the hash of the one-time state sent to Google,
    // who started it, and where to send them back.
    db.exec(`
      CREATE TABLE IF NOT EXISTS youtube_oauth_states (
        state_hash  TEXT PRIMARY KEY,
        user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
        return_url  TEXT NOT NULL,
        expires_at  TEXT NOT NULL
      )
    `);
    ensureColumn(db, 'studio_devices', 'youtube_stream_id', 'TEXT');
    ensureColumn(db, 'studio_devices', 'youtube_stream_channel', 'TEXT');
    ensureColumn(db, 'studio_devices', 'youtube_ingest_sealed', 'TEXT');
    ensureColumn(db, 'live_sessions', 'youtube_broadcast_id', 'TEXT');
  },

  /* ---------------------------------------------- Private streaming --- */
  // Where an institute's boards stream: 'youtube' (as before) or 'private',
  // Cloudflare Stream played in CoachBook's own player. A board's Cloudflare
  // live input is made once and reused, its ingest key sealed like the
  // YouTube one; a class records which input carries it, and each student is
  // signed their own link to it. See src/coaching/privateStream.js.
  (db) => {
    ensureColumn(db, 'coaching_settings', 'stream_provider', "TEXT NOT NULL DEFAULT 'youtube' CHECK (stream_provider IN ('youtube', 'private'))");
    ensureColumn(db, 'studio_devices', 'cf_live_input_id', 'TEXT');
    ensureColumn(db, 'studio_devices', 'cf_ingest_sealed', 'TEXT');
    ensureColumn(db, 'live_sessions', 'cf_live_input_id', 'TEXT');
  },

  /* ---------------------------------------------- Recorded lectures --- */
  // A batch's lecture library, by subject: what students rewatch after class.
  // A live class adds its own row when it ends (src/coaching/recordings.js);
  // staff can add a lecture recorded elsewhere as a link. `video_ref` is the
  // YouTube video id, the Cloudflare video uid, or the link itself. A
  // Cloudflare recording is 'processing' until Cloudflare has the video —
  // `checked_at` is when we last asked. `chapter` is free text that groups a
  // subject's lectures in the app ("Electrostatics").
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS class_recordings (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_id        INTEGER NOT NULL REFERENCES academic_batches(id) ON DELETE CASCADE,
        subject_id      INTEGER REFERENCES academic_subjects(id) ON DELETE SET NULL,
        faculty_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
        live_session_id INTEGER REFERENCES live_sessions(id) ON DELETE SET NULL,
        title           TEXT NOT NULL,
        chapter         TEXT,
        source          TEXT NOT NULL CHECK (source IN ('youtube', 'cloudflare', 'server', 'link')),
        video_ref       TEXT,
        status          TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('processing', 'ready', 'failed')),
        duration_sec    INTEGER CHECK (duration_sec IS NULL OR duration_sec >= 0),
        recorded_at     TEXT NOT NULL,
        published       INTEGER NOT NULL DEFAULT 1,
        checked_at      TEXT,
        created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK (status <> 'ready' OR video_ref IS NOT NULL)
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_recordings_batch ON class_recordings(batch_id, subject_id, recorded_at)');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_recordings_session ON class_recordings(live_session_id) WHERE live_session_id IS NOT NULL');
    // Where each student got to in a lecture, for "Continue watching" and the
    // ticks on a subject's list. Completed once they reach 90% of it.
    db.exec(`
      CREATE TABLE IF NOT EXISTS recording_progress (
        recording_id INTEGER NOT NULL REFERENCES class_recordings(id) ON DELETE CASCADE,
        member_id    INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        position_sec INTEGER NOT NULL DEFAULT 0 CHECK (position_sec >= 0),
        completed    INTEGER NOT NULL DEFAULT 0,
        updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (recording_id, member_id)
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_recording_progress_member ON recording_progress(member_id, updated_at)');
  },

  /* ---------------------------------- Recording self-hosted classes --- */
  // A private class this server carries can be recorded to its disk
  // (src/coaching/serverRecording.js) and filed as source 'server'. Off by
  // default — it is the largest thing the server stores — and deleted after
  // `recording_keep_days`.
  //
  // Databases made before 'server' was a source get class_recordings
  // rebuilt to allow it. recording_progress points at the table with ON
  // DELETE CASCADE, so foreign keys are off for the rebuild — dropping the
  // old table would otherwise take every student's progress with it — and
  // checked before they go back on, as SQLite's own procedure does it.
  (db) => {
    ensureColumn(db, 'coaching_settings', 'record_classes', 'INTEGER NOT NULL DEFAULT 0');
    ensureColumn(db, 'coaching_settings', 'recording_keep_days', 'INTEGER NOT NULL DEFAULT 30');
    const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'class_recordings'").get();
    if (table && !table.sql.includes("'server'")) rebuildRecordingsForServer(db);
    // How much of the server's disk a recording takes (src/recordingStorage.js) —
    // after the rebuild, which copies only the columns it names.
    if (table) ensureColumn(db, 'class_recordings', 'size_bytes', 'INTEGER');
  },

  /* ---------------------------------------------- Chapter markers --- */
  // "Next topic" on the board, mid-class: a label and where it falls in the
  // class's recording, in seconds from its first frame — the board counts
  // its own time on air, so a late or restarted stream does not throw the
  // markers out. They hang off the class, so the recording it files, and
  // only that, shows them as chapters on its seek bar.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS live_markers (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
        offset_sec INTEGER NOT NULL CHECK (offset_sec >= 0),
        label      TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_live_markers_session ON live_markers(session_id, offset_sec)');
  },
];

/** Widens class_recordings.source to allow 'server' — see the migration above. */
function rebuildRecordingsForServer(db) {
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN');
    db.exec(`
      CREATE TABLE class_recordings_new (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_id        INTEGER NOT NULL REFERENCES academic_batches(id) ON DELETE CASCADE,
        subject_id      INTEGER REFERENCES academic_subjects(id) ON DELETE SET NULL,
        faculty_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
        live_session_id INTEGER REFERENCES live_sessions(id) ON DELETE SET NULL,
        title           TEXT NOT NULL,
        chapter         TEXT,
        source          TEXT NOT NULL CHECK (source IN ('youtube', 'cloudflare', 'server', 'link')),
        video_ref       TEXT,
        status          TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('processing', 'ready', 'failed')),
        duration_sec    INTEGER CHECK (duration_sec IS NULL OR duration_sec >= 0),
        recorded_at     TEXT NOT NULL,
        published       INTEGER NOT NULL DEFAULT 1,
        checked_at      TEXT,
        created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK (status <> 'ready' OR video_ref IS NOT NULL)
      )
    `);
    db.exec(`
      INSERT INTO class_recordings_new (id, batch_id, subject_id, faculty_id, live_session_id, title, chapter, source, video_ref,
                                        status, duration_sec, recorded_at, published, checked_at, created_by, created_at)
      SELECT id, batch_id, subject_id, faculty_id, live_session_id, title, chapter, source, video_ref,
             status, duration_sec, recorded_at, published, checked_at, created_by, created_at FROM class_recordings
    `);
    db.exec('DROP TABLE class_recordings');
    db.exec('ALTER TABLE class_recordings_new RENAME TO class_recordings');
    db.exec('CREATE INDEX IF NOT EXISTS idx_recordings_batch ON class_recordings(batch_id, subject_id, recorded_at)');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_recordings_session ON class_recordings(live_session_id) WHERE live_session_id IS NOT NULL');
    const broken = db.prepare('PRAGMA foreign_key_check').all();
    if (broken.length) throw new Error(`class_recordings rebuild left ${broken.length} broken references`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}
