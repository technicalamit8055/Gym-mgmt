import { Router } from 'express';
import { getSiteImage, siteEnabled, sitePayload } from '../coaching/site.js';
import { get, run } from '../db.js';
import { badRequest, notFound, tooManyRequests } from '../errors.js';
import { createLimiter } from '../rateLimit.js';
import { alertWebsiteEnquiry } from '../staffAlerts.js';
import { parse } from '../validate.js';
import { moduleEnabled } from '../verticals.js';

/**
 * The institute website's public API, mounted at /api/site.
 *
 * No sign-in anywhere here: this is what a parent's browser calls when they
 * open the institute's domain. It sits behind the subscription gate in app.js
 * like every gym route, so a lapsed account's site goes dark along with its
 * app — the page then falls back to the plain sign-in screen.
 */
export const siteRoutes = Router();

/** Answers exactly like a site that does not exist, so nothing leaks about a draft. */
function requirePublished(_req, _res, next) {
  if (siteEnabled()) return next();
  return next(Object.assign(notFound('This institute has not published a website'), { details: { code: 'site_disabled' } }));
}

siteRoutes.get('/', requirePublished, (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.json(sitePayload(req.tenant));
});

/**
 * A picture on the site. Each upload is a new id, so it can be cached for good.
 * Served whether or not the site is live: the editor previews them before it is.
 */
siteRoutes.get('/images/:id', (req, res) => {
  const image = getSiteImage(Number(req.params.id));
  if (!image) throw notFound('No such picture');
  res.set('Content-Type', image.mime);
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(Buffer.from(image.bytes));
});

/* ── The enquiry form ──────────────────────────────────────────────────── */

// Per institute *and* address: one noisy visitor must not lock the form for a
// whole city behind a carrier NAT, nor for every other institute.
const enquiryLimiter = createLimiter({ maxAttempts: 5, windowMs: 10 * 60 * 1000, lockoutMs: 30 * 60 * 1000 });

const ENQUIRY_FIELDS = {
  student_name: { type: 'string', required: true, min: 2, max: 100 },
  guardian_name: { type: 'string', max: 100 },
  phone: { type: 'string', required: true, min: 6, max: 20 },
  email: { type: 'email' },
  course_id: { type: 'int', min: 1 },
  target_class: { type: 'string', max: 40 },
  message: { type: 'string', max: 1000 },
};

const digits = (value) => String(value || '').replace(/\D/g, '');

/**
 * Files the form as an admissions inquiry (source "website"), where the desk
 * already works its leads, and rings the staff bell.
 *
 * A parent who sends the form twice — the usual reaction to no instant reply —
 * is one lead, not two: an open inquiry with the same number gets the new
 * message added to its notes instead.
 */
siteRoutes.post('/enquiry', requirePublished, (req, res) => {
  if (!moduleEnabled('admissions')) throw notFound('This institute is not taking enquiries online');

  const key = `${req.tenant?.slug}:${req.ip}`;
  const gate = enquiryLimiter.check(key);
  if (gate.locked) {
    res.set('Retry-After', String(gate.retryAfterSeconds));
    throw tooManyRequests('Too many enquiries from this device. Please call the institute instead.');
  }
  enquiryLimiter.recordAttempt(key);

  // A field no person can see. Bots fill every input they find; answering
  // them with the same success a person gets gives them nothing to tune on.
  if (req.body?.company) return res.status(201).json({ ok: true });

  const body = parse(req.body, ENQUIRY_FIELDS);
  const phone = digits(body.phone);
  if (phone.length < 10 || phone.length > 13) throw badRequest('Some fields need attention', { phone: 'Enter a 10-digit mobile number' });

  const { content, courses } = sitePayload(req.tenant);
  if (!content.sections.enquiry) throw notFound('This institute is not taking enquiries online');
  // Only a course the site actually shows — never an archived or hidden one.
  const course = body.course_id ? courses.find((c) => c.id === body.course_id) : null;
  if (body.course_id && !course) throw badRequest('Some fields need attention', { course_id: 'Choose a course from the list' });

  const stamp = new Date().toISOString().slice(0, 10);
  const note = [`Website enquiry (${stamp})`, body.message].filter(Boolean).join(': ');

  const existing = get(
    `SELECT id, notes FROM student_inquiries
      WHERE status NOT IN ('admitted', 'declined')
        AND REPLACE(REPLACE(REPLACE(REPLACE(phone, ' ', ''), '-', ''), '+', ''), '(', '') LIKE ?
      ORDER BY id DESC LIMIT 1`,
    [`%${phone.slice(-10)}`],
  );

  let id;
  if (existing) {
    id = existing.id;
    run(
      `UPDATE student_inquiries
          SET notes = ?, course_id = COALESCE(?, course_id), updated_at = datetime('now')
        WHERE id = ?`,
      [[existing.notes, note].filter(Boolean).join('\n'), course?.id ?? null, id],
    );
  } else {
    const info = run(
      `INSERT INTO student_inquiries (student_name, guardian_name, phone, email, course_id, target_class, notes, source, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'website', 'inquiry')`,
      [body.student_name, body.guardian_name || null, body.phone, body.email || null, course?.id ?? null, body.target_class || null, note],
    );
    id = Number(info.lastInsertRowid);
  }

  alertWebsiteEnquiry({ id, name: body.student_name, course: course?.name, repeat: Boolean(existing) });
  res.status(201).json({ ok: true });
});
