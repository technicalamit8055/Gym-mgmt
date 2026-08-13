import crypto from 'node:crypto';
import { Router } from 'express';
import { MANAGES_BILLING, requireAuth, requireRole } from '../auth.js';
import { config, DEFAULT_TENANT_SLUG } from '../config.js';
import { all, get, run, tenantStorage } from '../db.js';
import { badRequest, notFound, unauthorized } from '../errors.js';
import { DOCUMENT_MIMES, MAX_DOCUMENT_BYTES, parseUploadDataUrl } from '../photo.js';
import { parse } from '../validate.js';
import { requireModule } from '../verticals.js';

/**
 * ID proof on file — Aadhaar front, Aadhaar back, a college ID, whatever a
 * hall asks for. Own primary key rather than a member_id PK like
 * member_photos: three documents for one student is normal here.
 *
 * Two routers, the classes.js precedent: authed CRUD in this file, and a
 * second, unauthenticated one below for the file bytes themselves — a signed
 * URL is how an `<img>`/`<a>` tag can fetch something the API otherwise
 * requires a Bearer token for.
 */
export const memberDocumentRoutes = Router();
memberDocumentRoutes.use(requireAuth, requireModule('documents'));

const DOCUMENT_KINDS = ['aadhaar_front', 'aadhaar_back', 'college_id', 'photo_id', 'other'];

/**
 * Short-lived on purpose — much shorter than a member photo's 12 hours. An
 * Aadhaar scan sitting in browser history under a URL valid all day is a
 * bigger leak than a stale avatar.
 */
const DOC_URL_TTL_SECONDS = 15 * 60;

function docSignature(slug, docId, expiry) {
  return crypto.createHmac('sha256', config.secret).update(`doc:${slug}:${docId}:${expiry}`).digest('base64url');
}

function documentFileUrl(docId) {
  const store = tenantStorage.getStore();
  const slug = store?.slug ?? DEFAULT_TENANT_SLUG;
  const prefix = store?.pathPrefix ?? '';
  const expiry = Math.floor(Date.now() / 1000) + DOC_URL_TTL_SECONDS;
  const sig = docSignature(slug, docId, expiry);
  return `${prefix}/api/document-files/${docId}?e=${expiry}&s=${sig}`;
}

const DOC_SELECT = `
  SELECT id, member_id, kind, label, number, mime, verified, uploaded_by, created_at
  FROM member_documents
`;

function withFileUrl(row) {
  if (!row) return row;
  return { ...row, file_url: documentFileUrl(row.id) };
}

memberDocumentRoutes.get('/', (req, res) => {
  const where = req.query.member_id ? 'WHERE member_id = ?' : '';
  const params = req.query.member_id ? [Number(req.query.member_id)] : [];
  res.json({ items: all(`${DOC_SELECT} ${where} ORDER BY created_at`, params).map(withFileUrl) });
});

memberDocumentRoutes.post('/', requireRole(...MANAGES_BILLING), (req, res) => {
  const body = parse(req.body, {
    member_id: { type: 'int', required: true, min: 1 },
    kind: { type: 'enum', values: DOCUMENT_KINDS, required: true },
    label: { type: 'string', max: 80 },
    number: { type: 'string', max: 80 },
    file: { type: 'string', required: true },
  });

  if (!get('SELECT id FROM members WHERE id = ?', [body.member_id])) throw notFound('Member not found');

  const parsed = parseUploadDataUrl(body.file, { allowed: DOCUMENT_MIMES, maxBytes: MAX_DOCUMENT_BYTES, field: 'file' });
  if (!parsed) throw badRequest('A document file is required', { file: 'is required' });

  const info = run(
    'INSERT INTO member_documents (member_id, kind, label, number, mime, bytes, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [body.member_id, body.kind, body.label ?? null, body.number ?? null, parsed.mime, parsed.bytes, req.user.id],
  );
  res.status(201).json(withFileUrl(get(`${DOC_SELECT} WHERE id = ?`, [info.lastInsertRowid])));
});

memberDocumentRoutes.post('/:id/verify', requireRole(...MANAGES_BILLING), (req, res) => {
  const id = Number(req.params.id);
  const info = run('UPDATE member_documents SET verified = 1 WHERE id = ?', [id]);
  if (!info.changes) throw notFound('Document not found');
  res.json(withFileUrl(get(`${DOC_SELECT} WHERE id = ?`, [id])));
});

memberDocumentRoutes.delete('/:id', requireRole(...MANAGES_BILLING), (req, res) => {
  const info = run('DELETE FROM member_documents WHERE id = ?', [Number(req.params.id)]);
  if (!info.changes) throw notFound('Document not found');
  res.json({ ok: true });
});

/**
 * The file itself. No requireAuth — the URL authenticates itself, same idea
 * as an S3 presigned URL and the same scheme member photos use — but private,
 * no-store: unlike an avatar, this is not something any cache should keep a
 * copy of.
 */
export const documentFileRoutes = Router();
documentFileRoutes.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  const expiry = Number(req.query.e);
  const sig = req.query.s;
  if (!Number.isInteger(expiry) || typeof sig !== 'string') throw unauthorized('This link is not valid');
  if (expiry < Math.floor(Date.now() / 1000)) throw unauthorized('This link has expired');

  const slug = tenantStorage.getStore()?.slug ?? DEFAULT_TENANT_SLUG;
  const expected = docSignature(slug, id, expiry);
  if (expected.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) {
    throw unauthorized('This link is not valid');
  }

  const doc = get('SELECT mime, bytes FROM member_documents WHERE id = ?', [id]);
  if (!doc) throw notFound('Document not found');

  res.setHeader('Content-Type', doc.mime);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(Buffer.from(doc.bytes));
});
