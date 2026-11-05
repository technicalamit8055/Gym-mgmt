import { Router } from 'express';
import { MANAGES_BILLING, requireRole } from '../../auth.js';
import { utcTimestamp } from '../../clock.js';
import { all, get, run } from '../../db.js';
import { badRequest, notFound } from '../../errors.js';
import { parse } from '../../validate.js';
import { requireModule } from '../../verticals.js';
import { checkProcessing, checkRecording, deleteRecording, lectureChapters, playUrl, RECORDING_SELECT, signedSource, youtubeVideoId } from '../../coaching/recordings.js';
import { idParam, idQuery, optional, updateSql } from './shared.js';

/**
 * Recorded lectures, for staff: every batch's library of classes to rewatch
 * (src/coaching/recordings.js). Live classes file themselves; here a lecture
 * recorded elsewhere is added as a link, and any of them renamed, moved to
 * another subject or chapter, hidden from students, or deleted. Deleting one
 * here never touches the video on YouTube or Cloudflare.
 *
 * Anyone on the staff can look; managers and teachers can change them, as
 * they can run the classes they come from. The front desk cannot.
 */
export const recordingRoutes = Router();
recordingRoutes.use('/recordings', requireModule('live'));

const canEdit = requireRole(...MANAGES_BILLING, 'trainer');

const FIELDS = {
  batch_id: { type: 'int', required: true, min: 1 },
  subject_id: { type: 'int', required: true, min: 1 },
  title: { type: 'string', required: true, min: 2, max: 150 },
  chapter: { type: 'string', max: 100 },
  published: { type: 'boolean', default: 1 },
};

/** The subject has to be taught in the batch's course. */
function checkSubject(batchId, subjectId) {
  const batch = get('SELECT course_id FROM academic_batches WHERE id = ?', [batchId]);
  if (!batch) throw notFound('Batch not found');
  if (!get('SELECT id FROM academic_subjects WHERE id = ? AND course_id = ?', [subjectId, batch.course_id])) {
    throw badRequest('That subject is not part of this batch’s course', { subject_id: 'mismatch' });
  }
}

/** A lecture link students can open: YouTube is filed by its video id. */
function linkSource(value) {
  let url = null;
  try {
    url = new URL(value);
  } catch {
    // falls through to the 400 below
  }
  if (!url || !['https:', 'http:'].includes(url.protocol)) {
    throw badRequest('The lecture link has to be a web address', { url: 'must be an http(s) URL' });
  }
  const youtube = youtubeVideoId(url.href);
  return youtube ? { source: 'youtube', ref: youtube } : { source: 'link', ref: url.href };
}

const withViews = (r) => ({
  ...r,
  ...get('SELECT COUNT(*) AS viewers, COALESCE(SUM(completed), 0) AS completed FROM recording_progress WHERE recording_id = ?', [r.id]),
});

recordingRoutes.get('/recordings', (req, res) => {
  const where = [];
  const params = [];
  const batchId = idQuery(req, 'batch_id');
  const subjectId = idQuery(req, 'subject_id');
  if (batchId) {
    where.push('r.batch_id = ?');
    params.push(batchId);
  }
  if (subjectId) {
    where.push('r.subject_id = ?');
    params.push(subjectId);
  }
  if (['processing', 'ready', 'failed'].includes(req.query.status)) {
    where.push('r.status = ?');
    params.push(req.query.status);
  }
  checkProcessing(batchId ? [batchId] : null);
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  res.json({ items: all(`${RECORDING_SELECT} ${clause} ORDER BY r.recorded_at DESC, r.id DESC LIMIT 500`, params).map(withViews) });
});

/** A lecture recorded somewhere else, added by its link. */
recordingRoutes.post('/recordings', canEdit, (req, res) => {
  const body = parse(req.body, {
    ...FIELDS,
    url: { type: 'string', required: true, min: 8, max: 1000 },
    recorded_on: { type: 'date' },
    duration_min: { type: 'int', min: 1, max: 600 },
  });
  checkSubject(body.batch_id, body.subject_id);
  const { source, ref } = linkSource(body.url);
  const info = run(
    `INSERT INTO class_recordings (batch_id, subject_id, faculty_id, title, chapter, source, video_ref, status, duration_sec, recorded_at, published, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?)`,
    [
      body.batch_id, body.subject_id, req.user.role === 'trainer' ? req.user.id : null, body.title, body.chapter || null, source, ref,
      body.duration_min ? body.duration_min * 60 : null,
      // Noon on the day, so the date reads the same wherever the institute is.
      body.recorded_on ? `${body.recorded_on} 12:00:00` : utcTimestamp(),
      body.published, req.user.id,
    ],
  );
  res.status(201).json(withViews(get(`${RECORDING_SELECT} WHERE r.id = ?`, [info.lastInsertRowid])));
});

recordingRoutes.patch('/recordings/:id', canEdit, (req, res) => {
  const id = idParam(req);
  const current = get('SELECT batch_id, subject_id FROM class_recordings WHERE id = ?', [id]);
  if (!current) throw notFound('Recording not found');
  const { batch_id: _batch, ...editable } = FIELDS;
  const body = parse(req.body, optional(editable));
  if ('title' in body && !body.title) throw badRequest('Give the lecture a title', { title: 'is required' });
  if ('subject_id' in body) {
    if (!body.subject_id) throw badRequest('Choose the subject', { subject_id: 'is required' });
    checkSubject(current.batch_id, body.subject_id);
  }
  if ('chapter' in body) body.chapter = body.chapter || null;
  const { sql, params } = updateSql('class_recordings', body, id);
  run(sql, params);
  res.json(withViews(get(`${RECORDING_SELECT} WHERE r.id = ?`, [id])));
});

recordingRoutes.delete('/recordings/:id', canEdit, (req, res) => {
  // A recording this server holds goes from its disk too.
  if (!deleteRecording(idParam(req))) throw notFound('Recording not found');
  res.json({ ok: true });
});

/** What a member of staff plays to check a recording. */
recordingRoutes.get('/recordings/:id/play', (req, res) => {
  const id = idParam(req);
  const recording = get(`${RECORDING_SELECT} WHERE r.id = ?`, [id]);
  if (!recording) throw notFound('Recording not found');
  const base = `${req.protocol}://${req.get('host')}${req.tenantPathPrefix || ''}/api/recording-hls`;
  res.json({
    ...recording, play_url: playUrl(id, { viewerId: 0, base }), private_stream: signedSource(recording.source), chapters: lectureChapters(recording.live_session_id),
  });
});

/** Asks Cloudflare again, now, about a recording still processing. */
recordingRoutes.post('/recordings/:id/check', canEdit, async (req, res) => {
  const id = idParam(req);
  if (!get('SELECT id FROM class_recordings WHERE id = ?', [id])) throw notFound('Recording not found');
  await checkRecording(id);
  res.json(withViews(get(`${RECORDING_SELECT} WHERE r.id = ?`, [id])));
});
