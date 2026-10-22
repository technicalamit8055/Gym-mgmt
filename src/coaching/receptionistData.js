import { all, get, run, tx } from '../db.js';
import { gymNowTime } from '../clock.js';
import { addDays, today } from '../validate.js';
import { buildSchedule } from './fees.js';
import { coachingSettings } from './notify.js';

/**
 * What the WhatsApp admissions assistant knows and may change, read live
 * from the institute's own tables on every reply (see receptionist.js).
 *
 * Everything the model is allowed to say about the institute comes out of
 * here — courses, batch timings and seats, fee plans and their installment
 * split, teachers' qualifications, demo slots and the address — so a fee the
 * desk edits at 8 PM is the fee a parent hears at 9 PM. The mutations
 * (saveLead, bookDemo, handoff) write the same student_inquiries rows the
 * admissions desk works from.
 */

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 0 (Sunday) – 6 for a YYYY-MM-DD calendar date. */
export const weekdayOf = (iso) => new Date(`${iso}T00:00:00Z`).getUTCDay();

/** "4:00 PM" from "16:00". */
export function timeLabel(hhmm) {
  if (!hhmm) return '';
  const [h, m] = String(hhmm).split(':').map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m || 0).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** "Wed, 22 Oct" from "2026-10-22". */
export function dateLabel(iso) {
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00Z`);
  return `${DAY_NAMES[d.getUTCDay()].slice(0, 3)}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

const daysLabel = (weekdays) =>
  String(weekdays || '')
    .split(',')
    .filter((d) => d !== '')
    .map((d) => DAY_NAMES[Number(d)]?.slice(0, 3))
    .filter(Boolean)
    .join(', ');

const minutesOf = (hhmm) => {
  const [h, m] = String(hhmm || '0:0').split(':').map(Number);
  return h * 60 + (m || 0);
};

/** The last ten digits — how an Indian number typed any way at the desk
 * ("098765 43210", "+91 98765-43210") compares to WhatsApp's 919876543210. */
export const phoneKey = (phone) => {
  const digits = String(phone ?? '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : digits || null;
};

const parseComponents = (json) => {
  try {
    const list = JSON.parse(json || '[]');
    return Array.isArray(list) ? list.filter((c) => c && c.label && Number(c.amount) > 0).map((c) => ({ label: String(c.label), amount: Number(c.amount) })) : [];
  } catch {
    return [];
  }
};

const facultyName = (u) => u.name;

/* ── Reads ───────────────────────────────────────────────────────────── */

/** The institute itself: name, contact, address and the owner's own notes. */
export function instituteProfile({ instituteName }) {
  const s = coachingSettings();
  return {
    name: instituteName,
    phone: s.institute_phone || null,
    address: s.institute_address || null,
    landmark_directions: s.landmark_directions || null,
    has_map_pin: s.latitude != null && s.longitude != null,
    office_hours: s.office_open && s.office_close ? `${daysLabel(s.office_days)} ${timeLabel(s.office_open)} – ${timeLabel(s.office_close)}` : null,
    owner_notes: s.ai_persona_notes || null,
  };
}

/**
 * Every course open for admission, with its batches (days, timing, start
 * date, seats left), the teachers allocated to it with their qualifications,
 * and the headline fee of each plan. Compact on purpose: it rides on every
 * reply. The installment split is a tool call (feeBreakdown) because most
 * questions never need it.
 */
export function courseCatalog() {
  const now = today();
  const courses = all('SELECT id, name, code, target_exam, academic_year, description FROM academic_courses WHERE active = 1 ORDER BY name');
  return courses.map((c) => {
    const batches = all(
      `SELECT b.id, b.name, b.weekdays, b.start_time, b.end_time, b.start_date, b.capacity,
              (SELECT COUNT(*) FROM batch_enrollments e WHERE e.batch_id = b.id AND e.status = 'active') AS enrolled
       FROM academic_batches b
       WHERE b.course_id = ? AND b.active = 1 AND (b.end_date IS NULL OR b.end_date >= ?)
       ORDER BY b.start_time, b.name`,
      [c.id, now],
    ).map((b) => ({
      batch_id: b.id,
      name: b.name,
      days: daysLabel(b.weekdays) || null,
      timing: b.start_time && b.end_time ? `${timeLabel(b.start_time)} – ${timeLabel(b.end_time)}` : null,
      starts_on: b.start_date > now ? dateLabel(b.start_date) : 'running',
      seats_left: Math.max(0, b.capacity - b.enrolled),
    }));
    const faculty = all(
      `SELECT DISTINCT u.id, u.name, u.qualification, u.specialization, s.name AS subject
       FROM faculty_allocations fa
       JOIN users u ON u.id = fa.faculty_id AND u.active = 1
       JOIN academic_subjects s ON s.id = fa.subject_id
       JOIN academic_batches b ON b.id = fa.batch_id AND b.active = 1
       WHERE b.course_id = ?
       ORDER BY s.sort_order, u.name`,
      [c.id],
    ).map((u) => ({
      name: facultyName(u),
      subject: u.subject,
      qualification: u.qualification || null,
      specialization: u.specialization || null,
    }));
    const fees = all('SELECT id, name, total_fee, installments FROM fee_structures WHERE course_id = ? AND active = 1 ORDER BY total_fee', [c.id]).map((f) => ({
      fee_plan_id: f.id,
      name: f.name,
      total_fee: f.total_fee,
      installments: f.installments,
    }));
    const subjects = all('SELECT name FROM academic_subjects WHERE course_id = ? ORDER BY sort_order, name', [c.id]).map((s) => s.name);
    return {
      course_id: c.id,
      name: c.name,
      target_exam: c.target_exam || null,
      academic_year: c.academic_year,
      description: c.description ? c.description.slice(0, 300) : null,
      subjects,
      batches,
      faculty,
      fee_plans: fees,
    };
  });
}

/**
 * One course's fee plans in full: the total, each installment as the desk
 * would split it at admission (the same buildSchedule the enrollment form
 * uses), and the components (tuition, registration, material).
 */
export function feeBreakdown(courseId) {
  const course = get('SELECT id, name FROM academic_courses WHERE id = ? AND active = 1', [courseId]);
  if (!course) return { ok: false, error: 'No such course is open for admission.' };
  const plans = all('SELECT * FROM fee_structures WHERE course_id = ? AND active = 1 ORDER BY total_fee', [courseId]).map((f) => {
    const schedule = buildSchedule({ total: f.total_fee, installments: f.installments, startDate: today(), intervalDays: f.interval_days });
    return {
      fee_plan_id: f.id,
      name: f.name,
      total_fee: f.total_fee,
      installments: schedule.map((i, n) => ({
        label: i.label,
        amount: i.amount_due,
        when: n === 0 ? 'at admission' : `${n * f.interval_days} days after admission`,
      })),
      components: parseComponents(f.components),
    };
  });
  if (!plans.length) return { ok: true, course: course.name, fee_plans: [], note: 'No fee plan is published for this course yet — the team shares fees in person.' };
  return { ok: true, course: course.name, currency: 'INR', fee_plans: plans };
}

/** The slot rows behind demo availability, with their teacher and course. */
const SLOT_SELECT = `
  SELECT s.*, u.name AS faculty_name, u.qualification AS faculty_qualification, c.name AS course_name
  FROM admission_demo_slots s
  LEFT JOIN users u ON u.id = s.faculty_id
  LEFT JOIN academic_courses c ON c.id = s.course_id
`;

/** Bookings that hold a demo seat: scheduled, or already attended that day. */
const seatsTaken = (slotId, date) =>
  get(
    "SELECT COUNT(*) AS n FROM student_inquiries WHERE demo_slot_id = ? AND demo_on = ? AND status IN ('demo_scheduled', 'demo_attended')",
    [slotId, date],
  ).n;

/** A slot on `date` is bookable until half an hour before it starts. */
const LAST_CALL_MIN = 30;
const BOOKING_HORIZON_DAYS = 21;

function slotOpenOn(slot, date) {
  const now = today();
  if (date < now || date > addDays(now, BOOKING_HORIZON_DAYS)) return false;
  if (weekdayOf(date) !== slot.weekday) return false;
  if (date === now && minutesOf(slot.start_time) - minutesOf(gymNowTime()) < LAST_CALL_MIN) return false;
  return true;
}

const slotView = (slot, date, taken) => ({
  slot_id: slot.id,
  date,
  day: dateLabel(date),
  time: timeLabel(slot.start_time),
  duration_min: slot.duration_min,
  teacher: slot.faculty_name || null,
  teacher_qualification: slot.faculty_qualification || null,
  course: slot.course_name || 'any course',
  room: slot.room || null,
  seats_left: Math.max(0, slot.capacity - taken),
});

/**
 * The open demo classes over the next `days`, soonest first: each slot's
 * date, time, teacher and seats left. A slot tied to a course is offered only
 * for that course; an untied one for any.
 */
export function demoAvailability({ courseId = null, days = 10, limit = 8 } = {}) {
  const slots = all(`${SLOT_SELECT} WHERE s.active = 1 ${courseId ? 'AND (s.course_id IS NULL OR s.course_id = ?)' : ''} ORDER BY s.start_time`, courseId ? [courseId] : []);
  if (!slots.length) return { ok: true, slots: [], note: 'No demo classes are scheduled. Offer to have the team call back to arrange one.' };
  const open = [];
  let full = 0;
  const start = today();
  for (let i = 0; i <= days && open.length < limit; i++) {
    const date = addDays(start, i);
    for (const slot of slots) {
      if (!slotOpenOn(slot, date)) continue;
      const taken = seatsTaken(slot.id, date);
      if (taken >= slot.capacity) {
        full += 1;
        continue;
      }
      open.push(slotView(slot, date, taken));
      if (open.length >= limit) break;
    }
  }
  return { ok: true, slots: open, full_slots_skipped: full || undefined };
}

/** Whether this number belongs to a current student's family — the bot then
 * knows not to sell them a course they are already in. */
export function knownFamily(phone) {
  const key = phoneKey(phone);
  if (!key || key.length < 10) return null;
  const rows = all(
    "SELECT first_name, phone, emergency_phone FROM members WHERE status = 'active' AND (phone LIKE ? OR emergency_phone LIKE ?) LIMIT 10",
    [`%${key.slice(-4)}`, `%${key.slice(-4)}`],
  ).filter((m) => phoneKey(m.phone) === key || phoneKey(m.emergency_phone) === key);
  return rows.length ? rows.map((m) => m.first_name) : null;
}

/** Whether a number belongs to the institute's own people (the director,
 * staff): their chats with the institute number are not leads. */
export function isInsiderPhone(phone) {
  const key = phoneKey(phone);
  if (!key || key.length < 10) return false;
  const s = coachingSettings();
  if (phoneKey(s.director_phone) === key) return true;
  return all("SELECT phone FROM users WHERE active = 1 AND phone IS NOT NULL AND phone LIKE ?", [`%${key.slice(-4)}`]).some((u) => phoneKey(u.phone) === key);
}

/* ── The lead ────────────────────────────────────────────────────────── */

const PLACEHOLDER_NAME = 'Name not shared yet';
const OPEN_STATUSES = ['inquiry', 'demo_scheduled', 'demo_attended', 'follow_up', 'declined'];

/** The inquiry a conversation is about: the one it is linked to, else the
 * newest open one under the same number. An admitted inquiry is never
 * reused — that family writing again is about a new child, or is a student. */
export function inquiryForConversation(conversation) {
  if (conversation.inquiry_id) {
    const linked = get('SELECT * FROM student_inquiries WHERE id = ?', [conversation.inquiry_id]);
    if (linked && linked.status !== 'admitted') return linked;
  }
  const key = phoneKey(conversation.phone);
  if (!key || key.length < 10) return null;
  return (
    all(
      `SELECT * FROM student_inquiries WHERE status IN (${OPEN_STATUSES.map(() => '?').join(', ')}) AND phone LIKE ?
       ORDER BY updated_at DESC LIMIT 10`,
      [...OPEN_STATUSES, `%${key.slice(-4)}`],
    ).find((i) => phoneKey(i.phone) === key) ?? null
  );
}

/** What the desk already knows about this family, for the model's context. */
export function leadSummary(inquiry) {
  if (!inquiry) return null;
  const course = inquiry.course_id ? get('SELECT name FROM academic_courses WHERE id = ?', [inquiry.course_id])?.name : null;
  return {
    student_name: inquiry.student_name === PLACEHOLDER_NAME ? null : inquiry.student_name,
    guardian_name: inquiry.guardian_name || null,
    target_class: inquiry.target_class || null,
    school: inquiry.school_name || null,
    course_id: inquiry.course_id || null,
    course,
    stage: inquiry.status,
    demo_booked: inquiry.status === 'demo_scheduled' && inquiry.demo_on ? `${dateLabel(inquiry.demo_on)}${inquiry.demo_time ? `, ${timeLabel(inquiry.demo_time)}` : ''}` : null,
  };
}

const NOTES_MAX = 2000;

/** Appends a dated line to the inquiry's notes, dropping the oldest lines
 * when it would outgrow what the desk's own form accepts. */
function appendNote(existing, line) {
  if (!line) return existing ?? null;
  const [y, m, d] = today().split('-');
  let notes = `${existing ? `${existing}\n` : ''}[WhatsApp AI ${d}/${m}/${y.slice(2)}] ${String(line).trim().slice(0, 400)}`;
  while (notes.length > NOTES_MAX && notes.includes('\n')) notes = notes.slice(notes.indexOf('\n') + 1);
  return notes.slice(-NOTES_MAX);
}

const cleanText = (v, max) => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
};

const validCourseId = (id) => {
  const n = Number(id);
  return Number.isInteger(n) && n > 0 && get('SELECT id FROM academic_courses WHERE id = ?', [n]) ? n : null;
};

/** The phone an inquiry is filed under: the WhatsApp number when known. */
const leadPhone = (conversation) => (conversation.phone ? `+${conversation.phone}` : `WhatsApp ${String(conversation.jid).split('@')[0]}`.slice(0, 30));

/**
 * Creates or updates the conversation's inquiry from what the parent has
 * said, and links the two. `changes` only ever fills in or refines; the
 * stage moves only through bookDemo/handoff.
 */
export const upsertLead = (conversation, changes = {}) => tx(() => writeLead(conversation, changes));

/** upsertLead's body, for callers already inside a transaction. */
function writeLead(conversation, changes) {
  const fields = {
    student_name: cleanText(changes.student_name, 100),
    guardian_name: cleanText(changes.guardian_name, 100),
    target_class: cleanText(changes.target_class, 40),
    school_name: cleanText(changes.school_name, 120),
    course_id: changes.course_id ? validCourseId(changes.course_id) : null,
  };
  const existing = inquiryForConversation(conversation);
  let id;
  if (existing) {
    const notes = appendNote(existing.notes, changes.note);
    run(
      `UPDATE student_inquiries SET
         student_name = CASE WHEN ? IS NOT NULL THEN ? ELSE student_name END,
         guardian_name = COALESCE(?, guardian_name),
         target_class = COALESCE(?, target_class),
         school_name = COALESCE(?, school_name),
         course_id = COALESCE(?, course_id),
         status = CASE WHEN status = 'declined' THEN 'inquiry' ELSE status END,
         follow_up_on = COALESCE(?, follow_up_on),
         notes = ?, updated_at = datetime('now')
       WHERE id = ?`,
      [fields.student_name, fields.student_name, fields.guardian_name, fields.target_class, fields.school_name, fields.course_id, changes.follow_up_on ?? null, notes, existing.id],
    );
    id = existing.id;
  } else {
    const info = run(
      `INSERT INTO student_inquiries (student_name, guardian_name, phone, course_id, target_class, school_name, status, follow_up_on, notes, source, ai_captured)
       VALUES (?, ?, ?, ?, ?, ?, 'inquiry', ?, ?, 'whatsapp', 1)`,
      [
        fields.student_name || PLACEHOLDER_NAME,
        fields.guardian_name || cleanText(conversation.contact_name, 100),
        leadPhone(conversation),
        fields.course_id,
        fields.target_class,
        fields.school_name,
        changes.follow_up_on ?? null,
        appendNote(null, changes.note),
      ],
    );
    id = Number(info.lastInsertRowid);
  }
  if (conversation.inquiry_id !== id) {
    run("UPDATE wa_conversations SET inquiry_id = ?, updated_at = datetime('now') WHERE id = ?", [id, conversation.id]);
    conversation.inquiry_id = id;
  }
  return { id, created: !existing };
}

/**
 * Books the family into one demo slot on one date: validated against the
 * slot's weekday, the booking window and the seats left at this moment,
 * then written onto the inquiry as `demo_scheduled`. Booking the same slot
 * and date again is a no-op (`already_booked`), so a parent re-confirming
 * never takes a second seat or fires a second alert.
 */
export function bookDemo(conversation, args = {}) {
  const slotId = Number(args.slot_id);
  const date = String(args.date || '');
  const studentName = cleanText(args.student_name, 100);
  if (!studentName || studentName.length < 2) return { ok: false, error: "The student's name is needed to book. Ask for it." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: 'date must be YYYY-MM-DD, copied from get_demo_slots.' };
  const slot = Number.isInteger(slotId) ? get(`${SLOT_SELECT} WHERE s.id = ? AND s.active = 1`, [slotId]) : null;
  if (!slot) return { ok: false, error: 'That demo slot does not exist. Call get_demo_slots and use a slot_id from it.' };
  if (!slotOpenOn(slot, date)) return { ok: false, error: `That slot is not open on ${date}. Call get_demo_slots for the open dates.` };
  const courseId = slot.course_id || (args.course_id ? validCourseId(args.course_id) : null);

  return tx(() => {
    const current = inquiryForConversation(conversation);
    if (current && current.demo_slot_id === slot.id && current.demo_on === date && current.status === 'demo_scheduled') {
      return { ok: true, already_booked: true, inquiry_id: current.id, booking: slotView(slot, date, seatsTaken(slot.id, date)) };
    }
    const taken = seatsTaken(slot.id, date);
    if (taken >= slot.capacity) return { ok: false, error: 'That demo is now full. Offer the next open slot from get_demo_slots.' };

    const { id } = writeLead(conversation, {
      student_name: studentName,
      guardian_name: args.guardian_name,
      target_class: args.target_class,
      school_name: args.school_name,
      course_id: courseId,
      note: `Demo booked for ${dateLabel(date)} ${timeLabel(slot.start_time)}.${args.notes ? ` ${args.notes}` : ''}`,
    });
    run(
      `UPDATE student_inquiries SET status = 'demo_scheduled', demo_on = ?, demo_time = ?, demo_slot_id = ?,
              course_id = COALESCE(?, course_id), follow_up_on = ?, updated_at = datetime('now')
       WHERE id = ?`,
      [date, slot.start_time, slot.id, courseId, date, id],
    );
    return { ok: true, inquiry_id: id, booking: slotView(slot, date, taken + 1) };
  });
}

/** Flags the chat for a person and puts the lead on today's follow-up list. */
export function handoff(conversation, reason) {
  const why = cleanText(reason, 300) || 'Parent needs a reply from the team';
  return tx(() => {
    run("UPDATE wa_conversations SET needs_staff = 1, handoff_reason = ?, updated_at = datetime('now') WHERE id = ?", [why, conversation.id]);
    const { id } = writeLead(conversation, { note: `Needs the team: ${why}`, follow_up_on: today() });
    return { ok: true, inquiry_id: id };
  });
}

/* ── Demo slots (the desk's settings) ────────────────────────────────── */

export const listDemoSlots = () =>
  all(`${SLOT_SELECT} ORDER BY s.active DESC, s.weekday, s.start_time`).map((s) => ({
    ...s,
    day: DAY_NAMES[s.weekday],
    upcoming: (() => {
      // The next date this slot runs, and how full it is.
      for (let i = 0; i < 7; i++) {
        const date = addDays(today(), i);
        if (weekdayOf(date) === s.weekday) return { date, booked: seatsTaken(s.id, date) };
      }
      return null;
    })(),
  }));
