import express, { Router } from 'express';
import { all, get, run } from '../../db.js';
import { badRequest, notFound } from '../../errors.js';
import { parse, today } from '../../validate.js';
import { requireModule } from '../../verticals.js';
import { activeRoster } from '../../coaching/attendance.js';
import { idParam, idQuery, optional, updateSql } from './shared.js';

/**
 * Study material: chapter notes, DPP sheets, PYQs, assignments, solutions.
 *
 * A file is uploaded as the raw request body (no base64 — a 10 MB PDF of
 * notes costs 10 MB, not 13), metadata in the query string. Or the material
 * is just a link: plenty of institutes keep PYQs in a Drive folder already.
 * Bytes live in the tenant's own database like member documents, so backups
 * and the per-tenant isolation cover them with nothing extra.
 */
export const materialRoutes = Router();
materialRoutes.use('/materials', requireModule('materials'));

export const MATERIAL_KINDS = ['notes', 'dpp', 'pyq', 'assignment', 'syllabus', 'solution'];
export const MAX_MATERIAL_BYTES = 15 * 1024 * 1024;

const ALLOWED_MIMES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
]);

/** Never the bytes — just whether there is a file, and how big. */
export const MATERIAL_SELECT = `
  SELECT ma.id, ma.course_id, ma.batch_id, ma.subject_id, ma.title, ma.kind, ma.description, ma.file_url, ma.file_name,
         ma.mime, ma.file_size_bytes, ma.due_date, ma.uploaded_by, ma.created_at,
         (ma.bytes IS NOT NULL) AS has_file,
         c.name AS course_name, b.name AS batch_name, s.name AS subject_name, u.name AS uploaded_by_name
  FROM academic_materials ma
  LEFT JOIN academic_courses c ON c.id = COALESCE(ma.course_id, (SELECT course_id FROM academic_batches WHERE id = ma.batch_id))
  LEFT JOIN academic_batches b ON b.id = ma.batch_id
  LEFT JOIN academic_subjects s ON s.id = ma.subject_id
  LEFT JOIN users u ON u.id = ma.uploaded_by
`;

const META_FIELDS = {
  title: { type: 'string', required: true, min: 2, max: 150 },
  kind: { type: 'enum', values: MATERIAL_KINDS, default: 'notes' },
  description: { type: 'string', max: 1000 },
  course_id: { type: 'int', min: 1 },
  batch_id: { type: 'int', min: 1 },
  subject_id: { type: 'int', min: 1 },
  due_date: { type: 'date' },
};

/** Fills course_id from the batch, and checks the subject belongs to it. */
function checkScope(body) {
  if (body.batch_id) {
    const batch = get('SELECT course_id FROM academic_batches WHERE id = ?', [body.batch_id]);
    if (!batch) throw notFound('Batch not found');
    body.course_id = batch.course_id;
  } else if (body.course_id && !get('SELECT id FROM academic_courses WHERE id = ?', [body.course_id])) {
    throw notFound('Course not found');
  }
  if (body.subject_id) {
    const subject = get('SELECT course_id FROM academic_subjects WHERE id = ?', [body.subject_id]);
    if (!subject) throw notFound('Subject not found');
    if (body.course_id && subject.course_id !== body.course_id) throw badRequest('That subject belongs to a different course', { subject_id: 'mismatch' });
    body.course_id ??= subject.course_id;
  }
}

const withSubmissionCount = (row) =>
  row.kind === 'assignment'
    ? { ...row, submissions: get('SELECT COUNT(*) AS n FROM assignment_submissions WHERE material_id = ?', [row.id]).n }
    : row;

materialRoutes.get('/materials', (req, res) => {
  const where = [];
  const params = [];
  const batchId = idQuery(req, 'batch_id');
  const courseId = idQuery(req, 'course_id');
  if (batchId) {
    where.push('(ma.batch_id = ? OR (ma.batch_id IS NULL AND ma.course_id = (SELECT course_id FROM academic_batches WHERE id = ?)) OR (ma.batch_id IS NULL AND ma.course_id IS NULL))');
    params.push(batchId, batchId);
  } else if (courseId) {
    where.push('ma.course_id = ?');
    params.push(courseId);
  }
  if (req.query.kind && MATERIAL_KINDS.includes(req.query.kind)) {
    where.push('ma.kind = ?');
    params.push(req.query.kind);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  res.json({ items: all(`${MATERIAL_SELECT} ${clause} ORDER BY ma.created_at DESC, ma.id DESC LIMIT 500`, params).map(withSubmissionCount) });
});

/** A link-type material (no file). */
materialRoutes.post('/materials', (req, res) => {
  const body = parse(req.body, { ...META_FIELDS, file_url: { type: 'string', required: true, min: 8, max: 1000 } });
  if (!/^https?:\/\//i.test(body.file_url)) throw badRequest('The link must start with http:// or https://', { file_url: 'invalid link' });
  checkScope(body);
  const info = run(
    `INSERT INTO academic_materials (course_id, batch_id, subject_id, title, kind, description, file_url, due_date, uploaded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [body.course_id ?? null, body.batch_id ?? null, body.subject_id ?? null, body.title, body.kind, body.description ?? null, body.file_url, body.due_date ?? null, req.user?.id ?? null],
  );
  res.status(201).json(get(`${MATERIAL_SELECT} WHERE ma.id = ?`, [info.lastInsertRowid]));
});

/** A file upload: bytes as the body, everything else in the query string. */
materialRoutes.post(
  '/materials/upload',
  express.raw({ type: () => true, limit: MAX_MATERIAL_BYTES }),
  (req, res) => {
    const body = parse(req.query, { ...META_FIELDS, file_name: { type: 'string', required: true, min: 1, max: 200 } });
    const bytes = Buffer.isBuffer(req.body) ? req.body : null;
    if (!bytes?.length) throw badRequest('Choose a file to upload', { file: 'is required' });
    const mime = String(req.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!ALLOWED_MIMES.has(mime)) throw badRequest('Upload a PDF, an image, or a Word/PowerPoint/Excel file', { file: 'unsupported type' });
    checkScope(body);
    const info = run(
      `INSERT INTO academic_materials (course_id, batch_id, subject_id, title, kind, description, file_name, mime, bytes, file_size_bytes, due_date, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        body.course_id ?? null, body.batch_id ?? null, body.subject_id ?? null, body.title, body.kind, body.description ?? null,
        body.file_name.replace(/[\\/:*?"<>|]+/g, '_'), mime, bytes, bytes.length, body.due_date ?? null, req.user?.id ?? null,
      ],
    );
    res.status(201).json(get(`${MATERIAL_SELECT} WHERE ma.id = ?`, [info.lastInsertRowid]));
  },
);

/** Streams an uploaded file. Shared with the student portal's download. */
export function sendMaterialFile(res, id) {
  const file = get('SELECT file_name, mime, bytes FROM academic_materials WHERE id = ? AND bytes IS NOT NULL', [id]);
  if (!file) throw notFound('File not found');
  res.set('Content-Type', file.mime || 'application/octet-stream');
  res.set('Content-Disposition', `attachment; filename="${encodeURIComponent(file.file_name || `material-${id}`)}"`);
  res.set('Cache-Control', 'private, no-store');
  res.send(Buffer.from(file.bytes));
}

materialRoutes.get('/materials/:id/file', (req, res) => {
  sendMaterialFile(res, idParam(req));
});

materialRoutes.patch('/materials/:id', (req, res) => {
  const id = idParam(req);
  const current = get('SELECT course_id, batch_id, subject_id FROM academic_materials WHERE id = ?', [id]);
  if (!current) throw notFound('Material not found');
  const body = parse(req.body, optional(META_FIELDS));
  if ('batch_id' in body || 'course_id' in body || 'subject_id' in body) {
    const scope = { ...current, ...body };
    checkScope(scope);
    body.course_id = scope.course_id ?? null;
  }
  const { sql, params } = updateSql('academic_materials', body, id);
  run(sql, params);
  res.json(get(`${MATERIAL_SELECT} WHERE ma.id = ?`, [id]));
});

materialRoutes.delete('/materials/:id', (req, res) => {
  const info = run('DELETE FROM academic_materials WHERE id = ?', [idParam(req)]);
  if (!info.changes) throw notFound('Material not found');
  res.json({ ok: true });
});

/* ── Assignment tracking ─────────────────────────────────────────────── */

/** Every student the assignment is for, with whether they have turned it in. */
materialRoutes.get('/materials/:id/submissions', (req, res) => {
  const id = idParam(req);
  const material = get('SELECT * FROM academic_materials WHERE id = ?', [id]);
  if (!material) throw notFound('Material not found');
  const batchIds = material.batch_id
    ? [material.batch_id]
    : all('SELECT id FROM academic_batches WHERE active = 1 AND (? IS NULL OR course_id = ?)', [material.course_id, material.course_id]).map((b) => b.id);
  const students = new Map();
  for (const batchId of batchIds) for (const s of activeRoster(batchId)) students.set(s.member_id, s);
  const submitted = new Map(all('SELECT * FROM assignment_submissions WHERE material_id = ?', [id]).map((s) => [s.member_id, s]));
  const items = [...students.values()].map((s) => ({
    member_id: s.member_id,
    member_code: s.member_code,
    roll_number: s.roll_number,
    first_name: s.first_name,
    last_name: s.last_name,
    status: submitted.get(s.member_id)?.status ?? 'pending',
    submitted_on: submitted.get(s.member_id)?.submitted_on ?? null,
    remarks: submitted.get(s.member_id)?.remarks ?? null,
  }));
  res.json({ material: { id: material.id, title: material.title, due_date: material.due_date }, items, submitted: submitted.size, total: items.length });
});

materialRoutes.put('/materials/:id/submissions', (req, res) => {
  const id = idParam(req);
  const material = get('SELECT id, due_date FROM academic_materials WHERE id = ?', [id]);
  if (!material) throw notFound('Material not found');
  const body = parse(req.body, {
    member_id: { type: 'int', required: true, min: 1 },
    submitted: { type: 'boolean', default: 1 },
    submitted_on: { type: 'date' },
    remarks: { type: 'string', max: 200 },
  });
  if (!body.submitted) {
    run('DELETE FROM assignment_submissions WHERE material_id = ? AND member_id = ?', [id, body.member_id]);
    return res.json({ ok: true, status: 'pending' });
  }
  const on = body.submitted_on || today();
  const status = material.due_date && on > material.due_date ? 'late' : 'submitted';
  run(
    `INSERT INTO assignment_submissions (material_id, member_id, status, submitted_on, remarks) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (material_id, member_id) DO UPDATE SET status = excluded.status, submitted_on = excluded.submitted_on, remarks = excluded.remarks`,
    [id, body.member_id, status, on, body.remarks ?? null],
  );
  return res.json({ ok: true, status });
});
