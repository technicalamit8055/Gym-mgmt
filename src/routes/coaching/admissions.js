import { Router } from 'express';
import { coachConfigured } from '../../aiCoach.js';
import { MANAGES_BILLING, requireRole } from '../../auth.js';
import { inquiryTranscript, setAssistantPaused, staffReply } from '../../coaching/receptionist.js';
import { listDemoSlots } from '../../coaching/receptionistData.js';
import { all, get, run, tx } from '../../db.js';
import { badRequest, conflict, notFound } from '../../errors.js';
import { parse, today } from '../../validate.js';
import { requireModule } from '../../verticals.js';
import { formatPhoneNumber, whatsappReady } from '../../whatsapp.js';
import { nextMemberCode } from '../members.js';
import { enrollWithFee, parseFeeInput } from './students.js';
import { idParam, insertSql, optional, updateSql, weekdaysValue } from './shared.js';

/**
 * The admissions pipeline: a walk-in or a call becomes an inquiry, maybe a
 * demo class, a follow-up, and then either an admission or a decline.
 * Admitting turns the lead into a student (a members row, with the next
 * CB code), enrolls them, and can open their fee plan — one step at the desk.
 *
 * Leads also arrive on their own: the WhatsApp admissions assistant
 * (src/coaching/receptionist.js) files them with `ai_captured` set, and the
 * chat behind each one is readable — and answerable — from here.
 */
export const admissionRoutes = Router();
admissionRoutes.use(['/inquiries', '/admissions'], requireModule('admissions'));

export const INQUIRY_STATUSES = ['inquiry', 'demo_scheduled', 'demo_attended', 'follow_up', 'admitted', 'declined'];
export const INQUIRY_SOURCES = ['walk_in', 'phone', 'whatsapp', 'referral', 'banner', 'social', 'website', 'school', 'other'];

const INQUIRY_FIELDS = {
  student_name: { type: 'string', required: true, min: 2, max: 100 },
  guardian_name: { type: 'string', max: 100 },
  phone: { type: 'string', required: true, min: 6, max: 30 },
  email: { type: 'email' },
  course_id: { type: 'int', min: 1 },
  target_class: { type: 'string', max: 40 },
  school_name: { type: 'string', max: 120 },
  status: { type: 'enum', values: INQUIRY_STATUSES, default: 'inquiry' },
  demo_on: { type: 'date' },
  demo_time: { type: 'time' },
  follow_up_on: { type: 'date' },
  notes: { type: 'string', max: 2000 },
  source: { type: 'enum', values: INQUIRY_SOURCES, default: 'walk_in' },
  assigned_to: { type: 'int', min: 1 },
};

// The WhatsApp chat columns are subqueries rather than a join: an inquiry
// can (rarely) have two chats, and a join would list it twice.
const INQUIRY_SELECT = `
  SELECT i.*, c.name AS course_name, u.name AS assigned_name, m.code AS member_code,
         (SELECT MAX(wc.last_message_at) FROM wa_conversations wc WHERE wc.inquiry_id = i.id) AS wa_last_message_at,
         (SELECT MAX(wc.needs_staff) FROM wa_conversations wc WHERE wc.inquiry_id = i.id) AS wa_needs_staff,
         (SELECT MAX(wc.bot_paused_until > datetime('now')) FROM wa_conversations wc WHERE wc.inquiry_id = i.id) AS wa_paused
  FROM student_inquiries i
  LEFT JOIN academic_courses c ON c.id = i.course_id
  LEFT JOIN users u ON u.id = i.assigned_to
  LEFT JOIN members m ON m.id = i.member_id
`;

function checkRefs(body) {
  if (body.course_id && !get('SELECT id FROM academic_courses WHERE id = ?', [body.course_id])) throw notFound('Course not found');
  if (body.assigned_to && !get('SELECT id FROM users WHERE id = ?', [body.assigned_to])) throw notFound('Staff member not found');
  if (body.status === 'admitted') {
    throw badRequest('Use "Admit" to admit a student — it creates their profile and enrollment', { status: 'use admit' });
  }
}

admissionRoutes.get('/inquiries', (req, res) => {
  const where = [];
  const params = [];
  if (req.query.status) {
    where.push('i.status = ?');
    params.push(String(req.query.status));
  }
  if (req.query.course_id) {
    where.push('i.course_id = ?');
    params.push(Number(req.query.course_id));
  }
  if (req.query.ai === '1') where.push('i.ai_captured = 1');
  if (req.query.needs_reply === '1') {
    where.push('EXISTS (SELECT 1 FROM wa_conversations wc WHERE wc.inquiry_id = i.id AND wc.needs_staff = 1)');
  }
  const q = String(req.query.q || '').trim();
  if (q) {
    where.push('(i.student_name LIKE ? OR i.guardian_name LIKE ? OR i.phone LIKE ? OR i.school_name LIKE ?)');
    params.push(...Array(4).fill(`%${q}%`));
  }
  if (req.query.due === '1') {
    where.push("i.status NOT IN ('admitted', 'declined') AND (i.follow_up_on <= ? OR i.demo_on <= ?)");
    params.push(today(), today());
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const items = all(
    `${INQUIRY_SELECT} ${clause}
     ORDER BY CASE WHEN i.status IN ('admitted', 'declined') THEN 1 ELSE 0 END,
              COALESCE(i.follow_up_on, i.demo_on, '9999-12-31'), i.created_at DESC
     LIMIT 500`,
    params,
  );
  const counts = Object.fromEntries(INQUIRY_STATUSES.map((s) => [s, 0]));
  for (const row of all('SELECT status, COUNT(*) AS n FROM student_inquiries GROUP BY status')) counts[row.status] = row.n;
  const thisMonth = get(
    `SELECT COUNT(*) AS leads, SUM(CASE WHEN status = 'admitted' THEN 1 ELSE 0 END) AS admitted
     FROM student_inquiries WHERE created_at >= ?`,
    [`${today().slice(0, 7)}-01`],
  );
  res.json({
    items,
    counts,
    ai: {
      on: Boolean(get('SELECT ai_receptionist FROM coaching_settings WHERE id = 1')?.ai_receptionist),
      captured_this_month: get('SELECT COUNT(*) AS n FROM student_inquiries WHERE ai_captured = 1 AND created_at >= ?', [`${today().slice(0, 7)}-01`]).n,
      needs_reply: get(
        `SELECT COUNT(*) AS n FROM student_inquiries i
         WHERE EXISTS (SELECT 1 FROM wa_conversations wc WHERE wc.inquiry_id = i.id AND wc.needs_staff = 1)`,
      ).n,
    },
    month: { leads: thisMonth.leads, admitted: thisMonth.admitted ?? 0 },
    follow_ups_due: get(
      "SELECT COUNT(*) AS n FROM student_inquiries WHERE status NOT IN ('admitted', 'declined') AND (follow_up_on <= ? OR demo_on <= ?)",
      [today(), today()],
    ).n,
  });
});

admissionRoutes.post('/inquiries', (req, res) => {
  const body = parse(req.body, INQUIRY_FIELDS);
  checkRefs(body);
  const { sql, params } = insertSql('student_inquiries', body);
  const info = run(sql, params);
  res.status(201).json(get(`${INQUIRY_SELECT} WHERE i.id = ?`, [info.lastInsertRowid]));
});

admissionRoutes.patch('/inquiries/:id', (req, res) => {
  const id = idParam(req);
  const current = get('SELECT status FROM student_inquiries WHERE id = ?', [id]);
  if (!current) throw notFound('Inquiry not found');
  const body = parse(req.body, optional(INQUIRY_FIELDS));
  if (current.status === 'admitted' && body.status && body.status !== 'admitted') {
    throw conflict('This inquiry is already admitted; edit the student instead');
  }
  checkRefs(body);
  const { sql, params } = updateSql('student_inquiries', { ...body, updated_at: new Date().toISOString().slice(0, 19).replace('T', ' ') }, id);
  run(sql, params);
  res.json(get(`${INQUIRY_SELECT} WHERE i.id = ?`, [id]));
});

admissionRoutes.delete('/inquiries/:id', (req, res) => {
  const info = run('DELETE FROM student_inquiries WHERE id = ?', [idParam(req)]);
  if (!info.changes) throw notFound('Inquiry not found');
  res.json({ ok: true });
});

/**
 * Admits a lead: creates the student (or links an existing one by
 * `member_id`), enrolls them into `batch_id`, and opens their fee plan when
 * `fee` is sent. The name on the inquiry is split into first/last the way the
 * desk would type it; everything else carries over.
 */
admissionRoutes.post('/inquiries/:id/admit', (req, res) => {
  const id = idParam(req);
  const inquiry = get('SELECT * FROM student_inquiries WHERE id = ?', [id]);
  if (!inquiry) throw notFound('Inquiry not found');
  if (inquiry.status === 'admitted' && inquiry.member_id) throw conflict('This inquiry has already been admitted');

  const body = parse(req.body, {
    member_id: { type: 'int', min: 1 },
    batch_id: { type: 'int', required: true, min: 1 },
    first_name: { type: 'string', max: 60 },
    last_name: { type: 'string', max: 60 },
    phone: { type: 'string', max: 30 },
    email: { type: 'email' },
    roll_number: { type: 'string', max: 20 },
    allow_over_capacity: { type: 'boolean', default: 0 },
  });
  const fee = req.body?.fee ? parseFeeInput(req.body.fee) : null;
  if (!get('SELECT id FROM academic_batches WHERE id = ?', [body.batch_id])) throw notFound('Batch not found');

  let memberId = body.member_id ?? null;
  let created = false;
  if (memberId) {
    if (!get('SELECT id FROM members WHERE id = ?', [memberId])) throw notFound('Student not found');
  } else {
    const [first, ...rest] = inquiry.student_name.trim().split(/\s+/);
    const email = body.email ?? inquiry.email ?? null;
    if (email && get('SELECT id FROM members WHERE email = ?', [email])) {
      throw conflict('A student with that email already exists — admit them as that student instead', { email: 'taken' });
    }
    memberId = tx(() => {
      const info = run(
        `INSERT INTO members (code, first_name, last_name, phone, email, joined_on, emergency_contact, emergency_phone,
                              school_name, current_class, exam_target)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          nextMemberCode(),
          body.first_name || first,
          body.last_name ?? rest.join(' '),
          body.phone ?? inquiry.phone,
          email,
          today(),
          inquiry.guardian_name,
          // The inquiry's number is almost always the parent's — it is who
          // called — so it becomes the guardian WhatsApp number too.
          inquiry.phone,
          inquiry.school_name,
          inquiry.target_class,
          inquiry.course_id ? get('SELECT target_exam FROM academic_courses WHERE id = ?', [inquiry.course_id])?.target_exam ?? null : null,
        ],
      );
      return Number(info.lastInsertRowid);
    });
    created = true;
  }

  let result;
  try {
    result = enrollWithFee({ memberId, body, fee, user: req.user });
  } catch (err) {
    if (created) run('DELETE FROM members WHERE id = ?', [memberId]);
    throw err;
  }
  run("UPDATE student_inquiries SET status = 'admitted', member_id = ?, updated_at = datetime('now') WHERE id = ?", [memberId, id]);
  res.status(201).json({
    ...result,
    member: get('SELECT id, code, first_name, last_name, phone FROM members WHERE id = ?', [memberId]),
    inquiry: get(`${INQUIRY_SELECT} WHERE i.id = ?`, [id]),
  });
});

/* ── The WhatsApp chat behind an inquiry ─────────────────────────────── */

// Replies go out under the institute's own number, so faculty (role
// 'trainer') read the chat but do not write into it — like the WhatsApp page.
const DESK_WRITERS = ['admin', 'manager', 'staff'];

admissionRoutes.get('/inquiries/:id/whatsapp', (req, res) => {
  const after = Number(req.query.after);
  res.json(inquiryTranscript(idParam(req), { after: Number.isInteger(after) && after > 0 ? after : 0 }));
});

admissionRoutes.post('/inquiries/:id/whatsapp/reply', requireRole(...DESK_WRITERS), async (req, res, next) => {
  try {
    res.status(201).json(await staffReply(idParam(req), { text: req.body?.text, userName: req.user?.name }));
  } catch (err) {
    next(err);
  }
});

admissionRoutes.post('/inquiries/:id/whatsapp/assistant', requireRole(...DESK_WRITERS), (req, res) => {
  const body = parse(req.body, { paused: { type: 'boolean', required: true } });
  res.json(setAssistantPaused(idParam(req), Boolean(body.paused)));
});

/* ── The assistant's settings and demo slots ─────────────────────────── */

const ASSISTANT_FIELDS = {
  ai_receptionist: { type: 'boolean' },
  ai_persona_name: { type: 'string', max: 40 },
  ai_persona_notes: { type: 'string', max: 2000 },
  ai_reply_mode: { type: 'enum', values: ['always', 'after_hours'] },
  office_open: { type: 'time' },
  office_close: { type: 'time' },
  office_days: { type: 'string', max: 20 },
  ai_pause_minutes: { type: 'int', min: 5, max: 10080 },
  institute_phone: { type: 'string', max: 30 },
  institute_address: { type: 'string', max: 300 },
  landmark_directions: { type: 'string', max: 300 },
  latitude: { type: 'number', min: -90, max: 90 },
  longitude: { type: 'number', min: -180, max: 180 },
  maps_url: { type: 'string', max: 500 },
  director_phone: { type: 'string', max: 30 },
  hot_lead_alerts: { type: 'boolean' },
};
const ASSISTANT_COLUMNS = Object.keys(ASSISTANT_FIELDS);
/** Fields an owner may clear back to empty. */
const CLEARABLE = new Set([
  'ai_persona_name', 'ai_persona_notes', 'institute_phone', 'institute_address', 'landmark_directions', 'maps_url', 'director_phone', 'latitude', 'longitude',
]);

/**
 * The coordinates in a pasted Google Maps link — "…/@28.6129,77.2295,17z",
 * "…?q=28.6129,77.2295", "…!3d28.6129!4d77.2295" — or null. A short
 * maps.app.goo.gl link carries none; the owner types them in then.
 */
export function coordinatesFromMapsUrl(url) {
  let text = String(url || '');
  try {
    text = decodeURIComponent(text);
  } catch {
    // A stray % — read it as typed.
  }
  const patterns = [
    /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/,
    /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/,
    /[?&](?:q|query|ll|destination)=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (!m) continue;
    const latitude = Number(m[1]);
    const longitude = Number(m[2]);
    if (Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 && (latitude || longitude)) return { latitude, longitude };
  }
  return null;
}

function assistantPayload() {
  return {
    settings: get(`SELECT ${ASSISTANT_COLUMNS.join(', ')} FROM coaching_settings WHERE id = 1`),
    slots: listDemoSlots(),
    faculty: all("SELECT id, name, qualification FROM users WHERE active = 1 AND role IN ('trainer', 'manager', 'admin') ORDER BY role = 'trainer' DESC, name"),
    courses: all('SELECT id, name FROM academic_courses WHERE active = 1 ORDER BY name'),
    ai_configured: coachConfigured(),
    whatsapp_connected: whatsappReady(),
  };
}

admissionRoutes.get('/admissions/assistant', (_req, res) => {
  res.json(assistantPayload());
});

admissionRoutes.patch('/admissions/assistant', requireRole(...MANAGES_BILLING), (req, res) => {
  const body = parse(req.body, ASSISTANT_FIELDS);
  if (body.office_days !== undefined) body.office_days = weekdaysValue(body.office_days) ?? '';
  // A pasted map link fills in the pin, unless the owner typed one too.
  if (body.maps_url && body.latitude == null && body.longitude == null) {
    Object.assign(body, coordinatesFromMapsUrl(body.maps_url) ?? {});
  }
  if (('latitude' in body || 'longitude' in body) && (body.latitude == null) !== (body.longitude == null)) {
    throw badRequest('Give both latitude and longitude, or neither', { latitude: 'pair', longitude: 'pair' });
  }
  if (body.director_phone && !formatPhoneNumber(body.director_phone)) {
    throw badRequest('That is not a phone number WhatsApp can reach', { director_phone: 'invalid' });
  }
  const hours = { ...get('SELECT office_open, office_close FROM coaching_settings WHERE id = 1'), ...body };
  if (hours.office_open && hours.office_close && hours.office_open >= hours.office_close) {
    throw badRequest('Office hours must close after they open', { office_close: 'before open' });
  }
  const columns = Object.keys(body).filter((c) => body[c] !== null || CLEARABLE.has(c));
  if (!columns.length) throw badRequest('Nothing to update');
  run(
    `UPDATE coaching_settings SET ${columns.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = 1`,
    columns.map((c) => (body[c] === '' && CLEARABLE.has(c) ? null : body[c])),
  );
  res.json(assistantPayload());
});

const SLOT_FIELDS = {
  weekday: { type: 'int', required: true, min: 0, max: 6 },
  start_time: { type: 'time', required: true },
  duration_min: { type: 'int', min: 15, max: 480, default: 60 },
  capacity: { type: 'int', min: 1, max: 200, default: 5 },
  course_id: { type: 'int', min: 1 },
  faculty_id: { type: 'int', min: 1 },
  room: { type: 'string', max: 40 },
  active: { type: 'boolean', default: 1 },
};

function checkSlotRefs(body) {
  if (body.course_id && !get('SELECT id FROM academic_courses WHERE id = ?', [body.course_id])) throw notFound('Course not found');
  if (body.faculty_id && !get('SELECT id FROM users WHERE id = ? AND active = 1', [body.faculty_id])) throw notFound('Teacher not found');
}

admissionRoutes.post('/admissions/demo-slots', requireRole(...MANAGES_BILLING), (req, res) => {
  const body = parse(req.body, SLOT_FIELDS);
  checkSlotRefs(body);
  const { sql, params } = insertSql('admission_demo_slots', body);
  run(sql, params);
  res.status(201).json(assistantPayload());
});

admissionRoutes.patch('/admissions/demo-slots/:id', requireRole(...MANAGES_BILLING), (req, res) => {
  const id = idParam(req);
  if (!get('SELECT id FROM admission_demo_slots WHERE id = ?', [id])) throw notFound('Demo slot not found');
  const body = parse(req.body, optional(SLOT_FIELDS));
  checkSlotRefs(body);
  const { sql, params } = updateSql('admission_demo_slots', body, id);
  run(sql, params);
  res.json(assistantPayload());
});

/** A slot with bookings is archived rather than deleted, so the leads booked
 * into it keep their demo time. */
admissionRoutes.delete('/admissions/demo-slots/:id', requireRole(...MANAGES_BILLING), (req, res) => {
  const id = idParam(req);
  if (!get('SELECT id FROM admission_demo_slots WHERE id = ?', [id])) throw notFound('Demo slot not found');
  if (get('SELECT 1 FROM student_inquiries WHERE demo_slot_id = ? LIMIT 1', [id])) run('UPDATE admission_demo_slots SET active = 0 WHERE id = ?', [id]);
  else run('DELETE FROM admission_demo_slots WHERE id = ?', [id]);
  res.json(assistantPayload());
});
