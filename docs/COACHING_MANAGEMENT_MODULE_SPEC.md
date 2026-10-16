# CoachBook: Coaching Centers & Educational Institutes Management System

## 1. Executive Summary & Market Reality

### 1.1 The Coaching Institute Industry
In India and emerging education markets, private coaching centers and test-preparation institutes are a massive, high-volume industry spanning:
- **School & Board Preparation**: Classes 9th, 10th, 11th, and 12th (CBSE, ICSE, State Boards) for Science, Commerce, and Arts.
- **Competitive Entrance Exams**: Engineering (JEE Main/Advanced), Medical (NEET-UG), Common University Entrance (CUET), Law (CLAT), Design (NIFT/NID), Foundation (Olympiads/NTSE).
- **Government & Job Recruitment Exams**: UPSC Civil Services, SSC (CGL, CHSL), Banking (IBPS, SBI PO/Clerk), Railways (RRB), State PSCs, Defence (NDA, CDS).
- **Specialized Subject Tuitions & Academies**: Mathematics, Physics, Chemistry, Biology, Accounts, Economics, Coding.

Unlike a gym (where individual adults pay a recurring membership) or a study hall (where students pay for a quiet desk seat), **a Coaching Institute operates around three interconnected stakeholders**:
1. **The Institute Director / Admin**: Demands total control over batch capacities, fee collections, installment due dates, faculty payroll, and academic reputation.
2. **The Teachers / Faculty**: Deliver lectures, track syllabus completion, take attendance, and conduct assessments.
3. **The Parents / Guardians**: The economic buyers who pay substantial course fees (₹15,000 to ₹1,50,000+) and demand daily visibility into attendance and test performance.
4. **The Students**: Follow timetables, attend lectures, submit assignments, sit for periodic tests, and check their ranks.

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                               THE COACHING INSTITUTE ECOSYSTEM                                         │
│                                                                                                        │
│   ┌───────────────────────────────┐                  ┌─────────────────────────────────────────────┐   │
│   │     INSTITUTE MANAGEMENT      │                  │              ACADEMIC ENGINE                │   │
│   │  • Courses, Streams & Batches │                  │  • Timetable & Classroom Allocation         │   │
│   │  • Student Inquiries & Admits │ ───────────────► │  • Faculty Allocation & Timetable           │   │
│   │  • Fee Installment Management │                  │  • Syllabus Tracking & Lecture Notes        │   │
│   │  • WhatsApp Fee Reminders     │                  │  • Test Series, Marks & Rank Generation     │   │
│   └───────────────────────────────┘                  └─────────────────────────────────────────────┘   │
│                  │                                                          │                          │
│                  ▼                                                          ▼                          │
│   ┌───────────────────────────────┐                  ┌─────────────────────────────────────────────┐   │
│   │      PARENT ENGAGEMENT        │                  │           STUDENT EXPERIENCE                │   │
│   │  • Instant Absentee Alerts    │                  │  • Daily Timetable & Room Numbers           │   │
│   │  • Fee Receipts & Due Dates   │                  │  • Digital Student ID Card (QR)             │   │
│   │  • Digital Report Cards       │                  │  • Test Performance & Batch Ranks           │   │
│   │  • Direct WhatsApp Updates    │                  │  • Notes, DPPs & Homework Download          │   │
│   └───────────────────────────────┘                  └─────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Core Operational Pain Points Solved

Coaching institutes suffer from severe operational friction when managed through spreadsheets, paper registers, or generic ERPs:

1. **Installment Fee Defaulting & Leakage**:
   - Course fees are paid in 2 to 4 installments over 6–12 months.
   - Without automated installment tracking and WhatsApp reminders to parents, institutes report **15% to 25% uncollected fee leakage**.
2. **Unauthorized Bunking & Parent Anxiety**:
   - Students leave home for coaching but skip classes.
   - When parents discover this after exam results, they blame the institute.
   - **Real-time Absentee WhatsApp alert** sent to parents within 15 minutes of class start is the single highest-value feature in coaching SaaS.
3. **Complex Batch & Faculty Timetables**:
   - Teachers juggling multiple batches across different rooms leads to faculty double-booking or room clashes.
4. **Test Evaluation & Rank Cards**:
   - Teachers spend hours manually preparing rank lists and score sheets.
   - Parents rarely see transparent performance trends until it is too late.

---

## 3. Platform Positioning: The 3rd Vertical ("CoachBook")

The repository currently supports two business verticals in [`src/verticals.js`](file:///c:/Users/abhin/OneDrive/Desktop/Projects/Gymbook&Seatbook/src/verticals.js):
- `gym`: **GymBook** (Gym Management)
- `library`: **SeatBook** (Study Hall & Library Management)

Introducing **CoachBook** as the 3rd vertical completes the education-and-fitness ecosystem:

| Attribute | GymBook (`gym`) | SeatBook (`library`) | CoachBook (`coaching`) |
| :--- | :--- | :--- | :--- |
| **Brand Name** | GymBook | SeatBook | **CoachBook** |
| **Tagline** | Gym Management | Study Hall Management | **Coaching & Institute Management** |
| **Code Prefix** | `GM` (GM1001) | `ST` (ST1001) | **`CB`** or **`IN`** (CB1001) |
| **Primary Noun** | Member | Student | **Student** |
| **Primary Product** | Membership Pass | Seat / Shift Pass | **Course / Batch Enrollment** |
| **Pricing Model** | 30/90/365 Days | Monthly Shift Pass | **Course Fee with 1–4 Installments** |
| **Core Activity** | Workout / Visit | Sitting / Study Shift | **Lecture Attendance & Test Series** |
| **Key Hardware** | QR / Biometric gate | Biometric / QR desk | **Biometric / QR Punch + Parent WhatsApp** |

---

## 4. The 8 Core Pillars of CoachBook

### Pillar 1: Academic Structure (Courses, Subjects & Batches)
- **Courses / Programs**:
  - e.g., "Class 10th CBSE All Subjects", "Class 12th Board + NEET 2027", "JEE 1-Year Dropper", "UPSC GS Foundation".
  - Academic year / session (e.g., `2026-2027`).
- **Subjects**:
  - Physics, Chemistry, Mathematics, Biology, English, Accounts, Economics, History, Polity, Reasoning, etc.
- **Batches**:
  - Name: "Morning Batch A (12th Board)", "Weekend JEE Advanced", "NEET Super-30".
  - Start & End Date.
  - Days of week & timing (e.g., Mon/Wed/Fri 04:00 PM – 07:30 PM).
  - Maximum seat capacity (e.g., 45 students).
  - Assigned Room / Hall.

### Pillar 2: Student CRM (Inquiries, Admissions & Enrollment)
- **Inquiry Pipeline**:
  - Lead capture: Student name, target class/exam, school, parent phone, source (Walk-in, Banner, Referral, Social).
  - Status stages: `Inquiry` $\rightarrow$ `Demo Class` $\rightarrow$ `Follow-Up` $\rightarrow$ `Admitted` $\rightarrow$ `Declined`.
- **Student Profile**:
  - Unique Student Roll Number / ID (`CB26001`).
  - Personal info, school/college, target exam, category/medium.
  - **Guardian Details**: Father/Mother name, primary WhatsApp phone, occupation, address.
  - Emergency contact details.
- **Batch Enrollment**:
  - Enroll student into one or multiple batches/subjects.
  - Optional seat allocation (if the institute has fixed assigned desk numbers).

### Pillar 3: Faculty & Teacher Management
- **Teacher Profile**:
  - Subject specializations, qualifications, phone, email, bio.
- **Faculty Allocation**:
  - Mapping: Teacher $\leftrightarrow$ Subject $\leftrightarrow$ Batch (e.g. "Prof. Sharma teaches Organic Chemistry to 12th Board Batch A").
- **Faculty Timetable & Workload**:
  - Weekly lecture schedule per teacher to eliminate double-booking.
  - Lecture completion tracker (Topic taught, date, duration).
- **Faculty Compensation**:
  - Fixed monthly salary or per-lecture/hourly rate.

### Pillar 4: Fee & Installment Management (The Financial Backbone)
- **Course Fee Structuring**:
  - Total Fee (e.g., ₹45,000).
  - Component breakdown: Tuition Fee, Registration Fee, Study Material, Test Series, GST/Taxes.
- **Installment Schedules (Milestone Billing)**:
  - Supports 1 to 6 custom installments.
  - Example for ₹45,000:
    - *At Admission*: ₹15,000 (Immediate).
    - *Installment 2*: ₹15,000 (Due after 60 days).
    - *Installment 3*: ₹15,000 (Due after 120 days).
- **Concessions & Scholarships**:
  - Sibling discount, merit concession, early bird discount, custom scholarship %.
- **Payments & Receipts**:
  - Record payments: Cash, UPI, Card, Bank Transfer, Cheque (with cheque number & clearance tracking).
  - Automated PDF Fee Receipts generated with institute logo, GSTIN, fee breakdown, and payment mode.
- **Automated WhatsApp Due Reminders**:
  - 3 days before due date: *"Dear Parent, the 2nd installment of ₹15,000 for [Student Name]'s Class 12th batch is due on [Date]. Please pay to avoid late fees."*
  - Overdue alerts sent to defaulters.

### Pillar 5: Daily Batch Attendance & Instant Parent WhatsApp Alerts
- **Taking Attendance**:
  - Method A: Teacher/Admin 1-tap batch attendance sheet on mobile/tablet (Present / Absent / Late / Excused).
  - Method B: Student scans QR ID Card or biometric fingerprint at the entrance terminal (`/iclock`).
- **Instant Absentee Alert to Parents**:
  - Triggers automated WhatsApp message to the Guardian phone:
    > *"Dear Parent, your ward [Student Name] was marked ABSENT today for the Class 12 Physics class (04:00 PM – 05:30 PM). If not informed, please contact Apex Institute at +91-9876543210."*
- **Monthly Attendance Report**:
  - Percentage attendance calculation (e.g., 91% attendance).
  - Low-attendance alerts (< 75% triggers warning to parents).

### Pillar 6: Timetable & Classroom Allocation
- **Weekly Master Schedule**:
  - Visual timetable grid showing: Time Slot $\times$ Classroom $\times$ Batch $\times$ Teacher.
  - Smart collision detection:
    - Alerts if a Teacher is scheduled in two places simultaneously.
    - Alerts if a Classroom exceeds its student desk capacity.
- **Lecture Syllabus Logs**:
  - Teacher marks what topic was completed today (e.g. "Kinematics: Projectile Motion Derivations completed; DPP #3 assigned").

### Pillar 7: Test Series, Marks & Digital Report Cards
- **Test Management**:
  - Test types: Weekly Unit Test, Monthly Assessment, Full Mock Exam, DPP Quiz.
  - Parameters: Subject, Total Marks, Negative Marking, Passing Marks.
- **Marks & Ranks Processing**:
  - Fast batch marks entry table.
  - Automatic calculation of:
    - Total Marks Obtained & Percentage.
    - Highest Marks in Batch.
    - Batch Average.
    - Batch Rank & Percentile.
- **Digital Report Cards & Parent Dispatch**:
  - Automated WhatsApp message to parents with score summary:
    > *"Dear Parent, [Student Name] scored 88/100 (Rank 3 out of 42) in Sunday's Physics Mock Test (Electrostatics) at Apex Institute. Highest: 94, Batch Avg: 62."*
  - Printable / PDF comprehensive quarterly performance card.

### Pillar 8: Study Material, Assignments & DPPs
- Digital repository for study material:
  - Chapter-wise notes (PDFs).
  - Daily Practice Problems (DPP) question sheets.
  - Previous Year Questions (PYQs).
- Assignment tracking:
  - Homework assigned date, submission deadline, status (Submitted / Pending).

---

## 5. Dual-Surface Experience: Web Console & Student/Parent App

### 5.1 Staff / Admin / Teacher Web Console
- **Sidebar Navigation**:
  - *Daily*: Dashboard, Attendance Desk, Students.
  - *Academic*: Batches, Timetable, Test Series & Marks, Study Material.
  - *Business*: Fee Management & Installments, Inquiries / Leads, Reports, WhatsApp Logs.
  - *Operations*: Faculty & Staff, Classrooms, Institute Settings.

### 5.2 Student & Parent Portal (PWA & Android Capacitor)
The existing member portal in `public/js/views/portal.js` seamlessly adapts to the student experience:
- **Home Tab**:
  - Digital Student ID Card with dynamic QR.
  - Today's Classes & Classroom numbers (e.g. "04:30 PM - Chemistry (Room 204)").
  - Recent test score badge.
  - Pending fee installment banner (if due).
- **Schedule Tab**:
  - Full weekly timetable and upcoming test dates.
- **Attendance Tab**:
  - Monthly calendar showing green/red dots for Present/Absent days with overall percentage.
- **Academics & Tests Tab**:
  - Detailed test history, ranks, subject-wise scores, and performance graph.
  - Downloadable PDFs of class notes and DPPs.
- **Fees Tab**:
  - Total course fee, installments paid, upcoming installments, and 1-tap download of tax receipts.

---

## 6. Database Schema Design (SQLite Migrations)

Following GymBook & SeatBook's clean migration pattern in [`src/db.js`](file:///c:/Users/abhin/OneDrive/Desktop/Projects/Gymbook&Seatbook/src/db.js):

```sql
-- 1. Courses / Programs
CREATE TABLE IF NOT EXISTS academic_courses (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,            -- e.g. "Class 12th CBSE Science"
  code            TEXT,                     -- e.g. "12-SCI"
  target_exam     TEXT,                     -- e.g. "Board + JEE"
  academic_year   TEXT NOT NULL,            -- e.g. "2026-2027"
  description     TEXT,
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 2. Subjects within Courses
CREATE TABLE IF NOT EXISTS academic_subjects (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id       INTEGER NOT NULL REFERENCES academic_courses(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,            -- e.g. "Physics"
  code            TEXT,                     -- e.g. "PHY"
  sort_order      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_subjects_course ON academic_subjects(course_id);

-- 3. Batches (Class sections)
CREATE TABLE IF NOT EXISTS academic_batches (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id       INTEGER NOT NULL REFERENCES academic_courses(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,            -- e.g. "Batch 12-A (Morning)"
  code            TEXT NOT NULL UNIQUE,     -- e.g. "B12A"
  capacity        INTEGER NOT NULL DEFAULT 40 CHECK (capacity > 0),
  room            TEXT,                     -- e.g. "Room 101"
  start_date      TEXT NOT NULL,
  end_date        TEXT,
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_batches_course ON academic_batches(course_id);

-- 4. Faculty-Subject-Batch Assignment
CREATE TABLE IF NOT EXISTS faculty_allocations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  faculty_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  batch_id        INTEGER NOT NULL REFERENCES academic_batches(id) ON DELETE CASCADE,
  subject_id      INTEGER NOT NULL REFERENCES academic_subjects(id) ON DELETE CASCADE,
  hourly_rate     REAL NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (faculty_id, batch_id, subject_id)
);

-- 5. Student Inquiries / Leads (Admissions CRM)
CREATE TABLE IF NOT EXISTS student_inquiries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  student_name    TEXT NOT NULL,
  guardian_name   TEXT,
  phone           TEXT NOT NULL,
  email           TEXT,
  course_id       INTEGER REFERENCES academic_courses(id) ON DELETE SET NULL,
  school_name     TEXT,
  status          TEXT NOT NULL DEFAULT 'inquiry'
                  CHECK (status IN ('inquiry', 'demo_scheduled', 'demo_attended', 'admitted', 'closed')),
  notes           TEXT,
  source          TEXT DEFAULT 'walk_in',
  assigned_to     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_inquiries_status ON student_inquiries(status);

-- 6. Student Enrollments into Batches
CREATE TABLE IF NOT EXISTS batch_enrollments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id       INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE, -- maps to student
  batch_id        INTEGER NOT NULL REFERENCES academic_batches(id) ON DELETE CASCADE,
  roll_number     TEXT,                     -- Institute roll no e.g. "12A-01"
  enrolled_on     TEXT NOT NULL DEFAULT (date('now')),
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'dropped')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (member_id, batch_id)
);
CREATE INDEX IF NOT EXISTS idx_enrollment_batch ON batch_enrollments(batch_id);
CREATE INDEX IF NOT EXISTS idx_enrollment_student ON batch_enrollments(member_id);

-- 7. Fee Structures & Installments (Financial Engine)
CREATE TABLE IF NOT EXISTS fee_structures (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id       INTEGER NOT NULL REFERENCES academic_courses(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,            -- e.g. "Annual Lumpsum" or "3 Installments Plan"
  total_fee       REAL NOT NULL CHECK (total_fee >= 0),
  installments    INTEGER NOT NULL DEFAULT 1 CHECK (installments BETWEEN 1 AND 12),
  active          INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS student_fee_plans (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id       INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  course_id       INTEGER NOT NULL REFERENCES academic_courses(id),
  total_amount    REAL NOT NULL CHECK (total_amount >= 0),
  discount_amount REAL NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  final_amount    REAL NOT NULL CHECK (final_amount >= 0),
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paid', 'defaulted')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS student_fee_installments (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id             INTEGER NOT NULL REFERENCES student_fee_plans(id) ON DELETE CASCADE,
  installment_number  INTEGER NOT NULL CHECK (installment_number > 0),
  amount_due          REAL NOT NULL CHECK (amount_due > 0),
  amount_paid         REAL NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
  due_date            TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'partially_paid', 'paid', 'overdue')),
  paid_on             TEXT,
  payment_id          INTEGER REFERENCES payments(id) ON DELETE SET NULL,
  reminder_sent_at    TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_installments_due ON student_fee_installments(due_date, status);

-- 8. Daily Batch Attendance
CREATE TABLE IF NOT EXISTS batch_attendance (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id        INTEGER NOT NULL REFERENCES academic_batches(id) ON DELETE CASCADE,
  subject_id      INTEGER REFERENCES academic_subjects(id) ON DELETE SET NULL,
  member_id       INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  attendance_date TEXT NOT NULL,            -- Gym/Institute local date (YYYY-MM-DD)
  status          TEXT NOT NULL DEFAULT 'present' CHECK (status IN ('present', 'absent', 'late', 'excused')),
  marked_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  whatsapp_sent   INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (batch_id, member_id, attendance_date, subject_id)
);
CREATE INDEX IF NOT EXISTS idx_batch_att_date ON batch_attendance(attendance_date, batch_id);

-- 9. Timetable / Lecture Schedule
CREATE TABLE IF NOT EXISTS academic_timetable (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id        INTEGER NOT NULL REFERENCES academic_batches(id) ON DELETE CASCADE,
  subject_id      INTEGER NOT NULL REFERENCES academic_subjects(id) ON DELETE CASCADE,
  faculty_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  weekday         INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time      TEXT NOT NULL,            -- e.g. "16:00"
  end_time        TEXT NOT NULL,            -- e.g. "17:30"
  room            TEXT,
  active          INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_timetable_batch ON academic_timetable(batch_id, weekday);

-- 10. Tests, Examinations & Performance
CREATE TABLE IF NOT EXISTS academic_tests (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id        INTEGER NOT NULL REFERENCES academic_batches(id) ON DELETE CASCADE,
  subject_id      INTEGER REFERENCES academic_subjects(id) ON DELETE SET NULL,
  title           TEXT NOT NULL,            -- e.g. "Weekly Test 3: Thermodynamics"
  test_date       TEXT NOT NULL,
  max_marks       REAL NOT NULL CHECK (max_marks > 0),
  passing_marks   REAL DEFAULT 0,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS academic_test_marks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  test_id         INTEGER NOT NULL REFERENCES academic_tests(id) ON DELETE CASCADE,
  member_id       INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  marks_obtained  REAL NOT NULL DEFAULT 0 CHECK (marks_obtained >= 0),
  rank            INTEGER,
  percentile      REAL,
  is_absent       INTEGER NOT NULL DEFAULT 0,
  whatsapp_sent   INTEGER NOT NULL DEFAULT 0,
  remarks         TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (test_id, member_id)
);
CREATE INDEX IF NOT EXISTS idx_test_marks ON academic_test_marks(test_id);

-- 11. Study Material & Assignments (DPP)
CREATE TABLE IF NOT EXISTS academic_materials (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id        INTEGER REFERENCES academic_batches(id) ON DELETE CASCADE,
  subject_id      INTEGER REFERENCES academic_subjects(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  kind            TEXT NOT NULL DEFAULT 'notes' CHECK (kind IN ('notes', 'dpp', 'assignment', 'syllabus', 'solution')),
  file_url        TEXT NOT NULL,
  file_name       TEXT NOT NULL,
  file_size_bytes INTEGER DEFAULT 0,
  due_date        TEXT,
  uploaded_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
```

---

## 7. Automated WhatsApp Integration (The Conversion Engine)

GymBook already integrates a production WhatsApp Baileys engine ([`src/whatsapp.js`](file:///c:/Users/abhin/OneDrive/Desktop/Projects/Gymbook&Seatbook/src/whatsapp.js)). CoachBook leverages this for 4 high-impact automated triggers:

1. **Daily Absentee Alert** (Instant upon attendance submission):
   > *"Dear Parent, your ward {{student_name}} was marked ABSENT today ({{date}}) in {{subject_name}} ({{batch_name}}). Please contact {{institute_name}} at {{phone}} if this was not anticipated."*
2. **Fee Installment Due Reminder** (3 days before due date):
   > *"Dear Parent, installment {{installment_no}} of {{amount}} for {{student_name}} at {{institute_name}} is due on {{due_date}}. Please pay to keep enrollment active. Thank you."*
3. **Fee Payment Receipt** (Immediate on payment):
   > *"Dear Parent, received {{amount}} towards {{student_name}}'s fees at {{institute_name}}. Receipt #{{receipt_no}} is attached. Balance: {{balance_amount}}."*
4. **Test Score Card** (Immediate on marks publish):
   > *"Dear Parent, {{student_name}} scored {{marks_obtained}}/{{max_marks}} (Rank: {{rank}} of {{total_students}}) in {{test_title}} at {{institute_name}}."*

---

## 8. Implementation Phases

### Phase 1: Academic Core & Installment Fees (Week 1–2)
- Register `coaching` in [`src/verticals.js`](file:///c:/Users/abhin/OneDrive/Desktop/Projects/Gymbook&Seatbook/src/verticals.js) with brand **CoachBook**.
- Add SQLite tables for Courses, Batches, Inquiries, Enrollments, and Installment Fee Plans.
- Build Admin Views: Courses & Batches setup, Student enrollment with installment plan scheduler, Fee collection & PDF receipts.

### Phase 2: Attendance, Timetable & WhatsApp Absentee Triggers (Week 3)
- Daily batch attendance grid with 1-tap bulk mark.
- WhatsApp automation for absent students.
- Weekly timetable collision-checker.

### Phase 3: Tests, Marks, Report Cards & Student App Portal (Week 4)
- Test creation, bulk marks entry, auto-rank generation.
- Automated score broadcast to parents via WhatsApp.
- Student/Parent mobile portal view (Timetable, Attendance calendar, Test results, PDF notes).
